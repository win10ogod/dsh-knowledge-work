import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {Context} from '@deepseek-ai/cordis'
import Llm,{LlmAdapter,createUserMessage,ToolCallId} from '@deepseek-ai/dsh-llm'
import Agents from '@deepseek-ai/dsh-agent'
import Sessions from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import Prompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import Loop from '@deepseek-ai/dsh-agent-loop'
import {KnowledgeStore} from '../lib/store.js'
import * as knowledge from '../lib/agent.js'
const text=value=>({type:'text',text:value})
const call=(name,args,id)=>({type:'tool-call',id:ToolCallId(id),name,arguments:JSON.stringify(args)})
function returned(request,id){const message=request.messages.findLast(m=>m.role==='tool'&&m.toolCallId===id);assert.ok(message,'Missing result '+id);assert.notEqual(message.isError,true,message.content[0]?.text);return JSON.parse(message.content.filter(b=>b.type==='text').map(b=>b.text).join(''))}
async function fixture(t,script,{autoContinue=true,expectedError=false}={}){
 const directory=mkdtempSync(join(tmpdir(),'knowledge-agent-')),store=new KnowledgeStore(join(directory,'work.sqlite'));store.autoContinue=autoContinue
 const ctx=new Context();for(const plugin of [Sessions,Projections,Agents,Llm,Prompt,Tools])await ctx.plugin(plugin)
 await ctx.plugin(Loop,{});ctx.provide('knowledgeWork',store);await ctx.plugin(knowledge)
 const requests=[],events=[];ctx.on('session/event',(_session,e)=>events.push(e))
 let handle
 ctx.llm.registerAdapter(['fixture'],new class extends LlmAdapter{
  async *stream(request){const i=requests.push(request)-1;assert.equal(request.maxTokens,123456);if(i>=script.length)throw Error('Unexpected continuation');const block=await script[i](request,handle.agent);if(block)yield {type:'block-end',index:0,block};yield {type:'finish',reason:{kind:block?.type==='tool-call'?'tool-calls':'stop'}}}
 }())
 ctx.tools.register({name:'fixture_read',description:'Read a controlled specification',parameters:{type:'object',properties:{}},output:{schema:{type:'string'},render:(_,value)=>[text(value)]},execute:()=> 'The cache lifetime is 60 seconds.'})
 handle=await ctx.agents.create({sessionId:randomUUID(),meta:{cwd:directory},agentOptions:{provider:'fixture',model:'mock',maxTokens:123456}})
 t.after(async()=>{await handle.dispose();await ctx.fiber.dispose();store.close();rmSync(directory,{recursive:true,force:true})})
 handle.agent.followup(createUserMessage({source:{kind:'user'},content:[text('Research the cache default and retain literal {{template}} notation.')]}));await handle.agent.whenIdle()
 const failure=events.findLast(e=>e.type==='turn/end')?.data.reason;if(!expectedError)assert.notEqual(failure?.kind,'error',JSON.stringify(failure));return {ctx,store,handle,requests,events,directory}
}
const start=()=>call('knowledge_task',{action:'start',title:'Cache {{template}}',objective:'Read the actual cache specification.',requirements:['What is the cache lifetime?']},'start')
test('real Agent workflow captures tool evidence, continues unfinished work and delivers in one turn',async t=>{
 let id,source,claim
 const f=await fixture(t,[
  start,
  request=>{id=returned(request,'start').task.id;return call('knowledge_plan',{taskId:id,steps:[{id:'read',title:'Read evidence',kind:'research'},{id:'verify',title:'Verify facts',kind:'verification',dependsOn:['read']}]},'plan')},
  ()=>call('fixture_read',{},'reading'),
  ()=>call('knowledge_capture',{taskId:id,origin:'tool',toolName:'fixture_read',title:'Controlled specification',locator:'fixture://spec'},'capture'),
  request=>{source=returned(request,'capture').source.id;return call('knowledge_claim',{taskId:id,kind:'fact',statement:'The cache lifetime is 60 seconds.',requirementIds:['r1'],evidence:[{sourceId:source,quote:'cache lifetime is 60 seconds.'}]},'claim')},
  request=>{claim=returned(request,'claim').claim.id;return call('knowledge_step',{taskId:id,stepId:'read',status:'done',sourceIds:[source],note:'Read the controlled specification.'},'read-done')},
  ()=>call('knowledge_step',{taskId:id,stepId:'verify',status:'done',claimIds:[claim],note:'Verified the stated number and scope.'},'verify-done'),
  ()=>text('I will prepare the report next.'),
  request=>{assert.ok(request.messages.some(m=>m.source?.kind==='knowledge-work'));return call('knowledge_review',{taskId:id,note:'Checked the actual quote and requirement coverage.'},'review')},
  request=>{assert.equal(returned(request,'review').review.ready,true);return call('knowledge_deliver',{taskId:id},'deliver')},
  request=>{assert.equal(returned(request,'deliver').task.status,'completed');return text('The evidence-backed report is ready.')}
 ])
 assert.equal(f.requests.length,11);assert.equal(f.events.filter(e=>e.type==='turn/start').length,1);assert.equal(f.store.read(id).status,'completed')
 assert.ok(f.requests.some(r=>JSON.stringify(r.messages).includes('{{template}}')))
 assert.equal(f.events.findLast(e=>e.type==='turn/end').data.reason.kind,'completed')
})
test('explicit blockers stop continuation and retain work for recovery',async t=>{
 let id
 const f=await fixture(t,[start,request=>{id=returned(request,'start').task.id;return call('knowledge_task',{action:'pause',taskId:id,reason:'The required private document has not been provided.'},'pause')},()=>text('Waiting for the required document.')])
 assert.equal(f.requests.length,3);assert.equal(f.store.read(id).status,'blocked')
})
test('automatic continuation can be disabled without changing model limits',async t=>{
 const f=await fixture(t,[start,()=>text('Partial progress.')],{autoContinue:false})
 assert.equal(f.requests.length,2);assert.equal(f.store.bound({sessionId:f.handle.agent.session.id,workspace:f.directory}).status,'active')
})
test('a user cancellation is respected even with an active workflow',async t=>{
 const f=await fixture(t,[start,(_request,agent)=>{agent.cancel({kind:'user'});return text('Stopped.')}])
 assert.equal(f.requests.length,2);assert.equal(f.events.findLast(e=>e.type==='turn/end').data.reason.kind,'aborted');assert.equal(f.store.bound({sessionId:f.handle.agent.session.id,workspace:f.directory}).status,'blocked')
})

test('provider errors do not trigger workflow retries',async t=>{
 const f=await fixture(t,[start,()=>{throw Error('Controlled provider failure')}],{expectedError:true})
 assert.equal(f.requests.length,2);assert.equal(f.events.findLast(e=>e.type==='turn/end').data.reason.kind,'error')
})
