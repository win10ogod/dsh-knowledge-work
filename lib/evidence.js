function messages(session){
 if(typeof session?.snapshotEvents!=='function')throw new Error('Host 未提供原始會話事件讀取介面')
 return session.snapshotEvents()
}
function textOf(message){return (message?.content||[]).filter(b=>b.type==='text'&&typeof b.text==='string').map(b=>b.text).join('\n')}
function readable(text){
 const values=[]
 function walk(v){if(typeof v==='string')values.push(v);else if(Array.isArray(v))v.forEach(walk);else if(v&&typeof v==='object')Object.values(v).forEach(walk)}
 try{walk(JSON.parse(text))}catch{}
 return values.length?text+'\n\nDecoded text fields:\n'+values.join('\n'):text
}
export function captureReceipt(session,input){
 const events=messages(session)
 if(input.origin==='user'){
  const reference=input.userMessageId==='latest'?undefined:input.userMessageId
  const event=[...events].reverse().find(e=>e.type==='user/message'&&e.data?.source?.kind==='user'&&(!reference||e.data.id===reference))
  if(!event)throw new Error('找不到指定的使用者訊息 ID。省略 userMessageId 即可擷取最新使用者輸入；不要把正文填入 ID。也可用 knowledge_read receipts 查詢可用 ID。')
  return {origin:'user',reference:event.data.id,locator:'session:'+session.id+'#'+event.seq,text:textOf(event.data),observedAt:Number.isFinite(event.time)?new Date(event.time).toISOString():null}
 }
 if(input.origin!=='tool')throw new Error('origin 必須是 tool 或 user')
 const reference=input.toolCallId==='latest'?undefined:input.toolCallId
 const calls=new Map(events.filter(e=>e.type==='tool/call').map(e=>[e.data.callId,e]))
 const event=[...events].reverse().find(e=>e.type==='tool/result'&&(!reference||e.data.message?.toolCallId===reference)&&calls.has(e.data.message?.toolCallId)&&!calls.get(e.data.message.toolCallId).data.name.startsWith('knowledge_')&&(!input.toolName||calls.get(e.data.message.toolCallId).data.name===input.toolName))
 const id=event?.data.message.toolCallId,call=calls.get(id)
 const original=events.find(e=>e.type==='tool/result'&&e.data.message?.toolCallId===id)
 if(!call||!event)throw new Error('找不到本會話已提交的工具結果')
 if(call.data.name.startsWith('knowledge_'))throw new Error('請使用原始讀取工具的結果，不能把工作案自己的記錄當作外部證據')
 let args={};try{args=typeof call.data.arguments==='string'?JSON.parse(call.data.arguments):call.data.arguments||{}}catch{}
 const message=original.data.message
 return {origin:'tool',reference:id,tool:call.data.name,locator:args.url||args.path||args.file_path||'session:'+session.id+'#tool:'+id,text:readable(textOf(message)),observedAt:Number.isFinite(original.time)?new Date(original.time).toISOString():null,isError:message.isError===true}
}

export function listReceipts(session){
 const events=messages(session),calls=new Map(events.filter(e=>e.type==='tool/call').map(e=>[e.data.callId,e.data.name]))
 const unique=new Map()
 for(const e of events)if(e.type==='tool/result'&&calls.has(e.data.message.toolCallId)&&!calls.get(e.data.message.toolCallId).startsWith('knowledge_'))if(!unique.has(e.data.message.toolCallId))unique.set(e.data.message.toolCallId,{origin:'tool',toolCallId:e.data.message.toolCallId,tool:calls.get(e.data.message.toolCallId),isError:e.data.message.isError===true,characters:textOf(e.data.message).length,observedAt:Number.isFinite(e.time)?new Date(e.time).toISOString():null})
 const users=events.filter(e=>e.type==='user/message'&&e.data?.source?.kind==='user').map(e=>({origin:'user',userMessageId:e.data.id,characters:textOf(e.data).length,observedAt:Number.isFinite(e.time)?new Date(e.time).toISOString():null}))
 return [...users,...unique.values()]
}
