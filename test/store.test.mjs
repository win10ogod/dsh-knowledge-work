import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {KnowledgeStore} from '../lib/store.js'
const actor={workspace:process.cwd(),sessionId:'owner-session',turn:1}
function fixture(t){const root=mkdtempSync(join(tmpdir(),'dsh-knowledge-'));const file=join(root,'work.sqlite'),store=new KnowledgeStore(file);t.after(()=>{try{store.close()}catch{}rmSync(root,{recursive:true,force:true})});return {store,file}}
function start(store,mode='research'){
 let task=store.create(actor,{title:'Cache configuration',objective:'Determine the documented default cache period.',mode,requirements:['What is the default cache period?']})
 task=store.plan(actor,{taskId:task.id,steps:[{id:'read',title:'Read the primary specification',kind:'research'},{id:'check',title:'Check the conclusion',kind:'verification',dependsOn:['read']}]})
 task=store.capture(actor,{taskId:task.id,title:'Specification',locator:'https://example.test/spec',scope:'version 2'},{origin:'tool',reference:'read-1',tool:'web_fetch',text:'The default cache period is 60 seconds.',observedAt:'2026-09-30T00:00:00.000Z'})
 return task
}
function finishWork(store,task){
 task=store.claim(actor,{taskId:task.id,kind:'fact',statement:'The documented default cache period is 60 seconds.',requirementIds:['r1'],evidence:[{sourceId:task.sources[0].id,quote:'default cache period is 60 seconds.'}]})
 task=store.step(actor,{taskId:task.id,stepId:'read',status:'done',note:'Read the version 2 specification.',sourceIds:[task.sources[0].id]})
 task=store.step(actor,{taskId:task.id,stepId:'check',status:'done',note:'Checked the exact period and version.',claimIds:[task.claims[0].id]})
 return task
}
test('workflow persists source receipts, citation evidence, review and immutable reports',t=>{
 const {store,file}=fixture(t);let task=finishWork(store,start(store));task=store.review(actor,{taskId:task.id,note:'Compared the claim to the version 2 passage.'});assert.equal(task.review.ready,true)
 const result=store.deliver(actor,{taskId:task.id});assert.equal(result.task.status,'completed');assert.match(result.markdown,/\[S1\]/);assert.match(result.markdown,/https:\/\/example.test\/spec/)
 const second=new KnowledgeStore(file);try{assert.equal(second.read(task.id,actor.workspace).status,'completed');assert.equal(second.readReport(task.id,result.report.revision).markdown,result.markdown)}finally{second.close()}
 assert.throws(()=>store.read(task.id,join(actor.workspace,'different-workspace')),/另一個工作區/)
 assert.throws(()=>store.step(actor,{taskId:task.id,stepId:'read',status:'pending'}),/resume/)
})
test('fabricated quotations and stale revisions roll back without losing existing work',t=>{
 const {store}=fixture(t);let task=start(store),revision=task.revision
 assert.throws(()=>store.claim(actor,{taskId:task.id,kind:'fact',statement:'Unsupported number',evidence:[{sourceId:task.sources[0].id,quote:'120 seconds'}]}),/引用片段/)
 assert.equal(store.read(task.id).revision,revision)
 assert.throws(()=>store.plan(actor,{taskId:task.id,steps:[{title:'Reset everything'}]}),/expectedRevision/)
 assert.throws(()=>store.step(actor,{taskId:task.id,stepId:'read',status:'done',note:'read',sourceIds:[task.sources[0].id],expectedRevision:revision-1}),/已變更/)
 assert.equal(store.read(task.id).revision,revision)
 assert.throws(()=>store.step(actor,{taskId:task.id,stepId:'check',status:'done',note:'Premature'}),/相依/)
})
test('updated sources invalidate old conclusions and a new review is required',t=>{
 const {store}=fixture(t);let task=finishWork(store,start(store));task=store.review(actor,{taskId:task.id,note:'Checked old version.'})
 task=store.capture(actor,{taskId:task.id,title:'New specification',locator:'https://example.test/spec',replacesSourceId:task.sources[0].id},{origin:'tool',reference:'read-2',tool:'web_fetch',text:'The default cache period is 90 seconds.'})
 assert.equal(task.review,null)
 assert.throws(()=>store.deliver(actor,{taskId:task.id}),/先核查/)
 task=store.review(actor,{taskId:task.id,note:'Found that the previous source was replaced.'});assert.ok(task.review.errors.some(e=>e.includes('更新')))
 assert.throws(()=>store.deliver(actor,{taskId:task.id}),/完整交付/)
 task=store.claim(actor,{taskId:task.id,id:task.claims[0].id,kind:'fact',statement:'The current default is 90 seconds.',requirementIds:['r1'],evidence:[{sourceId:task.sources.at(-1).id,quote:'default cache period is 90 seconds.'}]})
 task=store.review(actor,{taskId:task.id,note:'Checked new version and replaced the old citation.'});assert.equal(task.review.ready,true)
 assert.match(store.deliver(actor,{taskId:task.id}).markdown,/90 seconds/)
})
test('unknowns can be delivered as explicit partial work and resumed in a new session',t=>{
 const {store}=fixture(t);let task=start(store)
 task=store.claim(actor,{taskId:task.id,kind:'unknown',statement:'The new release value is not published.',reasoning:'Only the old version is available.',requirementIds:['r1']})
 task=store.review(actor,{taskId:task.id,note:'The new specification is unavailable.'});assert.equal(task.review.ready,false)
 assert.throws(()=>store.deliver(actor,{taskId:task.id,partial:true}),/限制/)
 const result=store.deliver(actor,{taskId:task.id,partial:true,limitations:['Awaiting the release specification.']})
 assert.equal(result.task.status,'blocked');assert.match(result.markdown,/部分成果/);assert.match(result.markdown,/工作尚未完成/)
 const next={...actor,sessionId:'resumed-session',turn:4};task=store.lifecycle(next,{action:'resume',taskId:task.id});assert.equal(task.status,'active');assert.equal(store.bound(next).id,task.id);assert.equal(task.engagement.turn,4)
})
test('decision matrices require comparable coverage and preserve counterevidence',t=>{
 const {store}=fixture(t);let task=finishWork(store,start(store,'decision'))
 task=store.review(actor,{taskId:task.id,note:'Check completeness.'});assert.ok(task.review.errors.some(e=>e.includes('比較表')))
 assert.throws(()=>store.compare(actor,{taskId:task.id,options:['A','B'],criteria:['cache'],assessments:[{option:'A',criterion:'cache',claimIds:[task.claims[0].id]}]}),/涵蓋每個/)
 task=store.compare(actor,{taskId:task.id,options:['A','B'],criteria:['cache'],assessments:['A','B'].map(option=>({option,criterion:'cache',claimIds:[task.claims[0].id]}))})
 task=store.claim(actor,{taskId:task.id,id:task.claims[0].id,kind:'inference',statement:'The same specification applies to both options.',reasoning:'Both options use the same version 2 cache module.',requirementIds:['r1'],evidence:[{sourceId:task.sources[0].id,quote:'60 seconds.',relation:'supports'},{sourceId:task.sources[0].id,quote:'default',relation:'contradicts'}]})
 task=store.review(actor,{taskId:task.id,note:'Contradiction needs a scope explanation.'});assert.ok(task.review.errors.some(e=>e.includes('相反證據')))
})
test('circular plans and missing requirements cannot pass review',t=>{
 const {store}=fixture(t);const task=store.create(actor,{title:'Research',objective:'Answer two questions',requirements:['one','two']})
 assert.throws(()=>store.plan(actor,{taskId:task.id,steps:[{id:'a',title:'A',dependsOn:['b']},{id:'b',title:'B',dependsOn:['a']}]}),/循環/)
 const reviewed=store.review(actor,{taskId:task.id,note:'No evidence yet.'});assert.equal(reviewed.review.ready,false);assert.ok(reviewed.review.errors.filter(e=>e.includes('未涵蓋')).length===2)
})

test('paused work can be reviewed and delivered explicitly as a partial result',t=>{
 const {store}=fixture(t);let task=start(store);store.lifecycle(actor,{action:'pause',taskId:task.id,reason:'Source access is unavailable.'})
 task=store.review(actor,{taskId:task.id,note:'Recorded the evidence gap.'});assert.equal(task.status,'blocked')
 assert.equal(store.deliver(actor,{taskId:task.id,partial:true,limitations:['Source access is unavailable.']}).task.status,'blocked')
})

test('citations preserve significant whitespace in captured code or data',t=>{
 const {store}=fixture(t);let task=store.create(actor,{title:'Code quotation',objective:'Preserve indentation.',requirements:['Quote the indentation.']})
 task=store.capture(actor,{taskId:task.id,title:'Code',locator:'fixture://code'},{origin:'tool',reference:'code',tool:'read',text:'if ready:\n    run()\n'})
 task=store.claim(actor,{taskId:task.id,kind:'fact',statement:'The call is indented.',requirementIds:['r1'],evidence:[{sourceId:task.sources[0].id,quote:'    run()\n'}]})
 assert.equal(task.claims[0].evidence[0].quote,'    run()\n')
})

test('named claims support creation and partial updates without dropping their evidence',t=>{
 const {store}=fixture(t);let task=start(store)
 task=store.claim(actor,{taskId:task.id,id:'c1',statement:'The cache lifetime is 60 seconds.',kind:'fact',evidence:[{sourceId:task.sources[0].id,quote:'60 seconds.'}]})
 const before=task.claims[0]
 task=store.claim(actor,{taskId:task.id,id:'c1',requirementIds:['r1']})
 assert.equal(task.claims.length,1);assert.equal(task.claims[0].statement,before.statement);assert.deepEqual(task.claims[0].evidence,before.evidence);assert.deepEqual(task.claims[0].requirementIds,['r1'])
 assert.throws(()=>store.claim(actor,{taskId:task.id,id:'new-without-content'}),/statement/)
})

test('identical content updates do not manufacture progress or invalidate a completed review',t=>{
 const {store}=fixture(t);let task=finishWork(store,start(store));task=store.review(actor,{taskId:task.id,note:'Checked the current evidence.'})
 const revision=task.revision,contentRevision=task.contentRevision,review=task.review
 for(let i=0;i<4;i++){
  task=store.claim(actor,{taskId:task.id,id:task.claims[0].id,statement:task.claims[0].statement,expectedRevision:revision})
  assert.equal(task.changed,false);assert.equal(task.revision,revision);assert.equal(task.contentRevision,contentRevision);assert.deepEqual(task.review,review)
 }
 assert.equal(store.deliver(actor,{taskId:task.id}).task.status,'completed')
})
