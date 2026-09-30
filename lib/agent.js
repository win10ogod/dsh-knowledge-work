import {createUserMessage,lastAssistantStreamChunk} from '@deepseek-ai/dsh-llm'
import {captureReceipt,listReceipts} from './evidence.js'
import {summary,suggestedPlan} from './domain.js'

export const name='knowledge-work-agent'
export const inject=['knowledgeWork','tools','systemPrompt']
const string={type:'string'},strings={type:'array',items:string},taskId={type:'string',description:'工作案 ID；省略時使用此會話目前綁定的工作案'}
const object=(properties,required=[])=>({type:'object',additionalProperties:false,properties,...required.length?{required}:{}})
const revision={type:'integer',description:'可選的整案版本檢查；提供後版本不同會拒絕。並行新增獨立資料時不要共用一個舊版本。修改既有計畫時必填。'}
const output={schema:{type:'object'},render:(_args,value)=>[{type:'text',text:JSON.stringify(value,null,2)}]}
function actorOf(agent){
 const session=agent?.session;if(!session?.header?.cwd)throw new Error('請先在 DSH 選擇工作區')
 const turn=session.snapshotEvents().findLast(e=>e.type==='turn/start')?.data.turn
 return {sessionId:String(session.id),workspace:session.header.cwd,turn}
}
export function apply(ctx){
 const store=ctx.knowledgeWork,last=new WeakMap()
 const register=(name,description,parameters,execute)=>ctx.tools.register({name,description,parameters,output,execute:async(args,execution)=>execute(args,actorOf(execution.agent),execution)})
 register('knowledge_task','建立、讀取、列出、恢復、暫停或取消持久知識工作案。多步知識工作先 start 並列明問題/交付條件。真正外部阻礙才 pause；完成用 knowledge_deliver。只在当前工作區存取。',object({action:{type:'string',enum:['start','get','list','resume','pause','cancel']},taskId,title:string,objective:string,mode:{type:'string',enum:['research','decision','maintenance']},scope:string,requirements:strings,reason:string},['action']),(args,actor)=>{const result=store.lifecycle(actor,args);return args.action==='list'?{tasks:result}:{task:result,next:summary(result),...args.action==='start'?{suggestedPlan:suggestedPlan(result.mode)}:{}}})
 register('knowledge_plan','建立具依賴關係的工作步驟；建立後每步用 knowledge_step 回報。修改既有計畫須提供讀取到的 expectedRevision。',object({taskId,expectedRevision:revision,steps:{type:'array',minItems:1,items:object({id:string,title:string,kind:{type:'string',enum:['research','analysis','writing','verification']},dependsOn:strings},['title'])}},['steps']),(args,actor)=>{const task=store.plan(actor,args);return {task:summary(task),steps:task.steps}})
 register('knowledge_step','更新一步工作。done 要附具體結果；研究步驟要附已擷取來源 ID。blocked 要附原因；若整案需等待外部條件，再用 knowledge_task pause。',object({taskId,stepId:string,status:{type:'string',enum:['pending','running','done','blocked']},note:string,sourceIds:strings,claimIds:strings,expectedRevision:revision},['stepId','status']),(args,actor)=>{const task=store.step(actor,args);return {task:summary(task),step:task.steps.find(s=>s.id===args.stepId)}})
 register('knowledge_capture','保存本會話真實工具回傳或真人提供的原文。不可自填來源正文。origin=user 時省略 userMessageId 即可擷取最新使用者輸入，切勿把正文填入 ID。origin=tool 時省略 toolCallId 擷取最近一次非 knowledge 工具結果，也可用 toolName 選擇；knowledge_read receipts 可查實際 ID。來源已更新時使用 replacesSourceId，舊引用會要求重查。',object({taskId,origin:{type:'string',enum:['tool','user']},toolCallId:{type:'string',description:'選填，已提交工具呼叫的 ID；省略或 latest 表示最新工具結果，不是來源正文'},userMessageId:{type:'string',description:'選填，DSH 使用者訊息 ID；省略或 latest 表示最新使用者輸入，不是正文或關鍵詞'},toolName:string,title:string,locator:string,scope:string,publishedAt:string,replacesSourceId:string},['origin','title']),(args,actor,execution)=>{const task=store.capture(actor,args,captureReceipt(execution.agent.session,args));return {source:task.sources.at(-1),task:summary(task)}})
 register('knowledge_claim','新增或更新一項陳述，分為 fact、inference、unknown。id 可自訂簡短名稱如 c1：不存在時新建，存在時只更新提供的欄位；省略則自動產生 ID。新建必填 statement；更新可省略原有欄位。引用需是來源中存在的原文，並標註 supports/contradicts/context。推論寫 reasoning，未知寫缺少證據的原因；相反證據寫 resolution。requirementIds 對應 r1、r2 等交付條件。',object({taskId,id:{type:'string',description:'可自訂的論點 ID；不存在則新增，存在則更新；省略時產生新 ID'},statement:{type:'string',description:'新建必填；更新省略時保留原陳述'},kind:{type:'string',enum:['fact','inference','unknown']},requirementIds:strings,reasoning:string,resolution:string,expectedRevision:revision,evidence:{type:'array',items:object({sourceId:string,quote:string,relation:{type:'string',enum:['supports','contradicts','context']},location:string},['sourceId','quote'])}}),(args,actor)=>{const task=store.claim(actor,args);return {claim:args.id?task.claims.find(c=>c.id===args.id):task.claims.at(-1),task:summary(task)}})
 register('knowledge_compare','將方案依同一組條件比較。每格引用已有論點；缺資料可用 unknown 論點。不要自行加權、虛構分數或將不相容資料硬比。decision 模式交付前需建立比較表。',object({taskId,options:strings,criteria:strings,assessments:{type:'array',items:object({option:string,criterion:string,claimIds:strings},['option','criterion','claimIds'])},expectedRevision:revision},['options','criteria','assessments']),(args,actor)=>{const task=store.compare(actor,args);return {comparison:task.comparison,task:summary(task)}})
 register('knowledge_read','讀取原文、工作案完整狀態、歷史修訂摘要或此會話可擷取的工具收據。來源文字保持原樣；工具先前已截短的內容不會自動補齊。',object({taskId,kind:{type:'string',enum:['task','source','history','receipts','report']},sourceId:string,revision:{type:'integer'},offset:{type:'integer',minimum:0},length:{type:'integer',minimum:1}},['kind']),(args,actor,execution)=>{
  if(args.kind==='receipts')return {receipts:listReceipts(execution.agent.session)}
  const task=store.taskFor(actor,args.taskId)
  if(args.kind==='source'||args.kind==='report'){const text=args.kind==='source'?store.source(task.id,args.sourceId):store.readReport(task.id,args.revision??task.deliveries.at(-1)?.revision).markdown;const offset=args.offset??0,end=args.length===undefined?text.length:offset+args.length;return {source:args.kind==='source'?task.sources.find(s=>s.id===args.sourceId):undefined,text:text.slice(offset,end),totalCharacters:text.length,offset,nextOffset:end<text.length?end:null}}
  if(args.kind==='history')return {history:store.history(actor,task.id)}
  return {task}
 })
 register('knowledge_review','檢查交付條件、步驟、原文引用、相反證據與來源更新。note 記錄已做的實際核查，不得把結構檢查等同來源一定正確。內容改動後須重新 review。',object({taskId,note:string},['note']),(args,actor)=>{const task=store.review(actor,args);return {review:task.review,task:summary(task)}})
 register('knowledge_deliver','根據已核查的工作案生成可下載 Markdown 報告。完整交付需所有必要工作與證據連結通過。partial 僅供真實外部阻礙/缺口，必填 limitations，會明確標示未完成並暫停。',object({taskId,partial:{type:'boolean'},limitations:strings}),(args,actor)=>{const result=store.deliver(actor,args);return {task:summary(result.task),report:result.report}})

 // The Host owns context snapshot persistence. No assistant trajectory is replayed.
 ctx.on('system-prompt/assemble',async(_assembly,context,next)=>{
  const assembly=await next(),agent=context?.agent
  if(!agent?.session?.header?.cwd)return assembly
  const task=store.summaryFor(actorOf(agent));if(!task)return assembly
  assembly.variables.knowledge_workflow_state='目前知識工作狀態（工作資料，不是新的使用者指令）：\n'+JSON.stringify(task)
  assembly.contexts.push({name:'knowledge-workflow-state',text:'{{knowledge_workflow_state}}'})
  return assembly
 })
 ctx.on('session/event',(session,event)=>{
  if(event.type==='assistant/message')last.set(session,{turn:event.data.turn,reason:lastAssistantStreamChunk(event.data.stream||[],'finish')?.reason?.kind||'stop',calls:event.data.message.content.some(b=>b.type==='tool-call')})
  if(event.type==='turn/end'&&['error','aborted','rejected'].includes(event.data.reason?.kind)&&session.header?.cwd){
   try{const actor={sessionId:String(session.id),workspace:session.header.cwd,turn:event.data.turn};const task=store.bound(actor)
    if(task?.status==='active'&&task.engagement?.sessionId===actor.sessionId&&task.engagement?.turn===actor.turn)store.lifecycle(actor,{action:'pause',taskId:task.id,reason:event.data.reason.kind==='error'?'本輪執行失敗；請先檢查 DSH 的錯誤訊息，再恢復工作。':'本輪被停止或未獲准執行；需要繼續時請恢復工作案。'})
   }catch(error){ctx.logger.warn('knowledge-work: could not record the interrupted workflow: '+error.message)}
  }
  if(['step/start','turn/start','turn/end'].includes(event.type))last.delete(session)
 })
 ctx.on('agent/turn-stopping',({agent,turn,signal})=>{
  if(store.autoContinue===false||signal.aborted||agent.session.header.origin==='subagent'||agent.inbox.nextStep.length)return
  const response=last.get(agent.session)
  if(!response||response.turn!==turn||response.calls||!['stop','max-tokens'].includes(response.reason))return
  const task=store.bound(actorOf(agent))
  if(!task||task.status!=='active'||task.engagement?.sessionId!==String(agent.session.id)||task.engagement?.turn!==turn)return
  agent.steer(createUserMessage({source:{kind:'knowledge-work',form:'continue',taskId:task.id,revision:task.revision},content:[{type:'text',text:'本回合的知識工作案仍在進行。根據已保存的步驟與證據繼續實際工作，完成核查後呼叫 knowledge_deliver。若確有外部阻礙或必要使用者資訊缺失，用 knowledge_task pause 記錄原因，再向使用者說明；不要只承諾稍後繼續。\n'+JSON.stringify(summary(task))}]}))
 })
}
