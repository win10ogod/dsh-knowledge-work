import test from 'node:test'
import assert from 'node:assert/strict'
import {captureReceipt,listReceipts} from '../lib/evidence.js'
const result=(id,text)=>({type:'tool/result',seq:2,time:10,data:{message:{role:'tool',toolCallId:id,content:[{type:'text',text}]}}})
const session=events=>({id:'s',snapshotEvents:()=>events})
test('captures actual original tool results and decodes JSON text without inventing content',()=>{
 const s=session([{type:'tool/call',data:{callId:'a',name:'web_fetch',arguments:'{"url":"https://example.test"}'}},result('a','{"text":"first line\\nsecond line"}'),result('a','pruned')])
 const receipt=captureReceipt(s,{origin:'tool',toolName:'web_fetch'});assert.equal(receipt.reference,'a');assert.equal(receipt.locator,'https://example.test');assert.ok(receipt.text.includes('first line\nsecond line'));assert.notEqual(receipt.text,'pruned');assert.equal(listReceipts(s).length,1)
})
test('does not accept its own ledger output as independent evidence',()=>{
 const s=session([{type:'tool/call',data:{callId:'self',name:'knowledge_read',arguments:'{}'}},result('self','made-up claim')])
 assert.throws(()=>captureReceipt(s,{origin:'tool',toolCallId:'self'}),/找不到/)
})
test('user sources only admit actual human messages and preserve their timestamp',()=>{
 const s=session([{type:'user/message',seq:1,time:1234,data:{id:'human',source:{kind:'user'},content:[{type:'text',text:'Provided requirements.'}]}},{type:'user/message',seq:2,time:2345,data:{id:'injected',source:{kind:'fount-memory'},content:[{type:'text',text:'Not a human statement.'}]}}])
 assert.equal(captureReceipt(s,{origin:'user'}).text,'Provided requirements.');assert.equal(captureReceipt(s,{origin:'user'}).observedAt,new Date(1234).toISOString());assert.throws(()=>captureReceipt(s,{origin:'user',userMessageId:'injected'}),/使用者訊息 ID/)
})

test('latest user input requires no opaque ID, and receipt discovery exposes usable IDs',()=>{
 const s=session([{type:'user/message',seq:1,time:1234,data:{id:'human-id',source:{kind:'user'},content:[{type:'text',text:'Provided facts.'}]}}])
 assert.equal(captureReceipt(s,{origin:'user',userMessageId:'latest'}).text,'Provided facts.')
 assert.equal(listReceipts(s)[0].userMessageId,'human-id')
 assert.throws(()=>captureReceipt(s,{origin:'user',userMessageId:'Provided facts.'}),/省略 userMessageId/)
})
