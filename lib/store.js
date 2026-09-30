import {DatabaseSync} from 'node:sqlite'
import {mkdirSync} from 'node:fs'
import {dirname,resolve} from 'node:path'
import {randomUUID} from 'node:crypto'
import {isDeepStrictEqual} from 'node:util'
import {newTask,required,normalizePlan,changeStep,claimRecord,validateTask,renderReport,summary,strings,comparisonRecord} from './domain.js'

function workspaceKey(value){const path=resolve(required(value,'工作區'));return process.platform==='win32'?path.toLowerCase():path}
const json=value=>JSON.stringify(value)
export class KnowledgeStore {
 constructor(filename){
  mkdirSync(dirname(filename),{recursive:true});this.db=new DatabaseSync(filename)
  this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
   CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, workspace TEXT NOT NULL, state TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS tasks_workspace ON tasks(workspace);
   CREATE TABLE IF NOT EXISTS bindings (session TEXT PRIMARY KEY, workspace TEXT NOT NULL, task TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS sources (task TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(task,id));
   CREATE TABLE IF NOT EXISTS history (task TEXT NOT NULL, revision INTEGER NOT NULL, action TEXT NOT NULL, actor TEXT NOT NULL, at TEXT NOT NULL, state TEXT NOT NULL, PRIMARY KEY(task,revision));
   CREATE TABLE IF NOT EXISTS reports (task TEXT NOT NULL, revision INTEGER NOT NULL, body TEXT NOT NULL, partial INTEGER NOT NULL, PRIMARY KEY(task,revision));`)
 }
 close(){this.db.close()}
 transaction(fn){this.db.exec('BEGIN IMMEDIATE');try{const value=fn();this.db.exec('COMMIT');return value}catch(error){this.db.exec('ROLLBACK');throw error}}
 read(id,workspace){const row=this.db.prepare('SELECT workspace,state FROM tasks WHERE id=?').get(required(id,'taskId'));if(!row)throw new Error('工作案不存在');if(workspace!==undefined&&row.workspace!==workspaceKey(workspace))throw new Error('此工作案屬於另一個工作區');return JSON.parse(row.state)}
 bound(actor){const row=this.db.prepare('SELECT task FROM bindings WHERE session=? AND workspace=?').get(actor.sessionId,workspaceKey(actor.workspace));return row?this.read(row.task,actor.workspace):null}
 taskFor(actor,id){const task=id?this.read(id,actor.workspace):this.bound(actor);if(!task)throw new Error('請先用 knowledge_task 建立或恢復工作案');return task}
 list(workspace){const rows=workspace===undefined?this.db.prepare('SELECT state FROM tasks').all():this.db.prepare('SELECT state FROM tasks WHERE workspace=?').all(workspaceKey(workspace));return rows.map(r=>summary(JSON.parse(r.state))).sort((a,b)=>b.updatedAt-a.updatedAt)}
 bind(task,actor){this.db.prepare('INSERT INTO bindings(session,workspace,task) VALUES(?,?,?) ON CONFLICT(session) DO UPDATE SET workspace=excluded.workspace,task=excluded.task').run(actor.sessionId,workspaceKey(actor.workspace),task.id)}
 save(task,actor,action,{content=false,engage=true}={}){
  task.revision++;task.updatedAt=Date.now();if(content){task.contentRevision++;task.review=null}
  if(engage&&Number.isSafeInteger(actor.turn))task.engagement={sessionId:actor.sessionId,turn:actor.turn}
  this.db.prepare('INSERT INTO tasks(id,workspace,state) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state').run(task.id,workspaceKey(task.workspace),json(task))
  this.db.prepare('INSERT INTO history(task,revision,action,actor,at,state) VALUES(?,?,?,?,?,?)').run(task.id,task.revision,action,actor.sessionId,new Date().toISOString(),json(task))
  this.bind(task,actor);return structuredClone(task)
 }
 create(actor,input){return this.transaction(()=>this.save(newTask(input,resolve(actor.workspace)),actor,'create',{content:true}))}
 mutate(actor,id,action,fn,{content=true,active=true,expectedRevision}={}){
  return this.transaction(()=>{const task=this.taskFor(actor,id);if(active&&task.status!=='active')throw new Error('此工作案已暫停或完成；需要繼續時請明確 resume');if(expectedRevision!==undefined&&task.revision!==expectedRevision)throw new Error('工作案已變更，請重新讀取');const before=structuredClone(task);fn(task);if(content&&isDeepStrictEqual(before,task))return {...task,changed:false};return {...this.save(task,actor,action,{content}),changed:true}})
 }
 lifecycle(actor,input){
  if(input.action==='start')return this.create(actor,input)
  if(input.action==='list')return this.list(actor.workspace)
  if(input.action==='get')return this.taskFor(actor,input.taskId)
  if(input.action==='resume')return this.mutate(actor,input.taskId,'resume',task=>{task.status='active';task.reason=''}, {active:false,content:false})
  if(['pause','cancel'].includes(input.action))return this.mutate(actor,input.taskId,input.action,task=>{task.status=input.action==='pause'?'blocked':'cancelled';task.reason=required(input.reason,'暫停或取消原因')},{active:false,content:false})
  throw new Error('未知工作案操作')
 }
 plan(actor,input){return this.mutate(actor,input.taskId,'plan',task=>{if(task.steps.length&&input.expectedRevision===undefined)throw new Error('修改既有計畫前請先讀取並提供 expectedRevision');task.steps=normalizePlan(input.steps)},{expectedRevision:input.expectedRevision})}
 step(actor,input){return this.mutate(actor,input.taskId,'step',task=>changeStep(task,input),{expectedRevision:input.expectedRevision})}
 capture(actor,input,receipt){
  return this.mutate(actor,input.taskId,'capture-source',task=>{
   const replacement=input.replacesSourceId&&task.sources.find(s=>s.id===input.replacesSourceId)
   if(input.replacesSourceId&&!replacement)throw new Error('要替換的來源不存在')
   const source={id:'src-'+randomUUID(),title:required(input.title,'來源標題'),locator:required(input.locator||receipt.locator,'來源位置'),
    scope:String(input.scope||''),publishedAt:String(input.publishedAt||''),observedAt:receipt.observedAt??null,capturedAt:new Date().toISOString(),
    origin:receipt.origin,receipt:receipt.reference,sessionId:actor.sessionId,tool:receipt.tool||null,isError:receipt.isError===true,characters:receipt.text.length}
   if(!receipt.text.trim())throw new Error('該訊息沒有可擷取的文字')
   task.sources.push(source);if(replacement)replacement.supersededBy=source.id
   this.db.prepare('INSERT INTO sources(task,id,body) VALUES(?,?,?)').run(task.id,source.id,receipt.text)
  })
 }
 source(task,id){const row=this.db.prepare('SELECT body FROM sources WHERE task=? AND id=?').get(task,id);if(!row)throw new Error('找不到來源內容');return row.body}
 claim(actor,input){return this.mutate(actor,input.taskId,'claim',task=>{const value=claimRecord(task,input,id=>this.source(task.id,id));const index=task.claims.findIndex(c=>c.id===value.id);if(index<0)task.claims.push(value);else task.claims[index]=value},{expectedRevision:input.expectedRevision})}
 compare(actor,input){return this.mutate(actor,input.taskId,'compare',task=>{task.comparison=comparisonRecord(task,input)},{expectedRevision:input.expectedRevision})}
 review(actor,input){return this.mutate(actor,input.taskId,'review',task=>{const check=validateTask(task,id=>this.source(task.id,id));task.review={...check,contentRevision:task.contentRevision,note:required(input.note,'核查說明'),at:new Date().toISOString(),reviewerSessionId:actor.sessionId}},{content:false,active:false})}
 deliver(actor,input){
  return this.transaction(()=>{
   const task=this.taskFor(actor,input.taskId),partial=input.partial===true
   if(task.status==='cancelled')throw new Error('已取消的工作案不可交付')
   const check=validateTask(task,id=>this.source(task.id,id))
   if(!task.review||task.review.contentRevision!==task.contentRevision)throw new Error('請先核查目前版本；來源、論點或計畫改動後需重新核查')
   if(!partial&&!check.ready)throw new Error('尚未達到完整交付條件：'+check.errors.join('；'))
   const limitations=strings(input.limitations||[],'limitations')
   if(partial&&!limitations.length)throw new Error('部分交付必須明確記錄限制或外部阻礙')
   const revision=task.revision+1,body=renderReport(task,{partial,limitations:[...limitations,...(partial?check.errors:[])]})
   const report={revision,partial,createdAt:new Date().toISOString(),url:'/api/knowledge-work?report='+encodeURIComponent(task.id)+'&revision='+revision}
   this.db.prepare('INSERT INTO reports(task,revision,body,partial) VALUES(?,?,?,?)').run(task.id,revision,body,partial?1:0)
   task.deliveries.push(report);task.status=partial?'blocked':'completed';task.reason=partial?limitations.join('；'):''
   return {task:this.save(task,actor,partial?'deliver-partial':'deliver'),report,markdown:body}
  })
 }
 readReport(task,revision){const row=this.db.prepare('SELECT body,partial FROM reports WHERE task=? AND revision=?').get(task,revision);if(!row)throw new Error('報告不存在');return {markdown:row.body,partial:row.partial===1}}
 history(actor,id){const task=this.taskFor(actor,id);return this.db.prepare('SELECT revision,action,actor,at FROM history WHERE task=? ORDER BY revision').all(task.id)}
 summaryFor(actor){const task=this.bound(actor);return task?summary(task):null}
}
