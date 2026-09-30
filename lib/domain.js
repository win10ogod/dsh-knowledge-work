import {randomUUID} from 'node:crypto'
export const MODES = ['research','decision','maintenance']
export const STEP_STATES = ['pending','running','done','blocked']
export const CLAIM_KINDS = ['fact','inference','unknown']
export const taskId = () => 'kw-'+randomUUID()
export function required(value, name) {
 if(typeof value!=='string'||!value.trim())throw new Error(name+' 必須是非空文字')
 return value.trim()
}
export function strings(value,name){
 if(!Array.isArray(value)||value.some(x=>typeof x!=='string'||!x.trim()))throw new Error(name+' 必須是非空文字的陣列')
 return value.map(x=>x.trim())
}
export function newTask(input, workspace, now=Date.now()) {
 const mode=input.mode||'research';if(!MODES.includes(mode))throw new Error('未知工作模式')
 const requirements=strings(input.requirements,'requirements');if(!requirements.length)throw new Error('至少需要一項需要回答的問題或交付條件')
 return {version:1,id:taskId(),workspace,title:required(input.title,'title'),objective:required(input.objective,'objective'),mode,
  scope:String(input.scope||''),requirements:requirements.map((text,i)=>({id:'r'+(i+1),text})),status:'active',reason:'',
  revision:0,contentRevision:0,createdAt:now,updatedAt:now,steps:[],sources:[],claims:[],comparison:null,review:null,deliveries:[],engagement:null}
}
export function normalizePlan(input) {
 if(!Array.isArray(input)||!input.length)throw new Error('工作計畫至少需要一個步驟')
 const steps=input.map((s,i)=>({id:s.id||'s'+(i+1),title:required(s.title,'step.title'),kind:s.kind||'research',dependsOn:s.dependsOn||[],status:'pending',note:'',sourceIds:[],claimIds:[]}))
 const ids=new Set(steps.map(s=>s.id));if(ids.size!==steps.length)throw new Error('步驟 ID 不可重複')
 for(const s of steps){
  if(!/^[A-Za-z0-9_-]+$/.test(s.id)||!['research','analysis','writing','verification'].includes(s.kind))throw new Error('無效的步驟 ID 或種類')
  if(!Array.isArray(s.dependsOn)||s.dependsOn.some(id=>!ids.has(id)||id===s.id))throw new Error('步驟依賴必須指向其他已定義的步驟')
 }
 const visiting=new Set(),visited=new Set(),byId=new Map(steps.map(s=>[s.id,s]))
 function visit(id){if(visiting.has(id))throw new Error('工作步驟不可形成循環依賴');if(visited.has(id))return;visiting.add(id);for(const dep of byId.get(id).dependsOn)visit(dep);visiting.delete(id);visited.add(id)}
 for(const s of steps)visit(s.id)
 return steps
}
export function changeStep(task,input) {
 const step=task.steps.find(s=>s.id===input.stepId);if(!step)throw new Error('找不到工作步驟')
 if(!STEP_STATES.includes(input.status))throw new Error('未知步驟狀態')
 if(['running','done'].includes(input.status)&&step.dependsOn.some(id=>task.steps.find(s=>s.id===id)?.status!=='done'))throw new Error('請先完成相依步驟')
 const sourceIds=input.sourceIds??step.sourceIds,claimIds=input.claimIds??step.claimIds
 if(!Array.isArray(sourceIds)||sourceIds.some(id=>!task.sources.some(s=>s.id===id)))throw new Error('步驟引用了不存在的來源')
 if(!Array.isArray(claimIds)||claimIds.some(id=>!task.claims.some(c=>c.id===id)))throw new Error('步驟引用了不存在的論點')
 const note=String(input.note??step.note)
 if(['done','blocked'].includes(input.status))required(note,'完成結果或阻礙說明')
 if(input.status==='done'&&step.kind==='research'&&!sourceIds.length)throw new Error('研究步驟需要引用已擷取的來源')
 Object.assign(step,{status:input.status,note,sourceIds,claimIds})
}
export function claimRecord(task,input,sourceText) {
 const existing=input.id?task.claims.find(c=>c.id===input.id):undefined
 if(input.id&&!/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/.test(input.id))throw new Error('論點 ID 只接受字母、數字、點、底線與連字號')
 const kind=input.kind??existing?.kind??'fact';if(!CLAIM_KINDS.includes(kind))throw new Error('未知論點種類')
 const requirements=input.requirementIds??existing?.requirementIds??[]
 if(!Array.isArray(requirements)||requirements.some(id=>!task.requirements.some(r=>r.id===id)))throw new Error('論點引用了不存在的交付條件')
 const refs=input.evidence??existing?.evidence??[];if(!Array.isArray(refs))throw new Error('evidence 必須是陣列')
 const evidence=refs.map(ref=>{
  const source=task.sources.find(s=>s.id===ref.sourceId);if(!source)throw new Error('找不到證據來源')
  required(ref.quote,'引用原文');const quote=ref.quote;if(!sourceText(ref.sourceId).includes(quote))throw new Error('引用片段不在已擷取內容中；請先用 knowledge_read 讀取來源原文')
  const relation=ref.relation||'supports';if(!['supports','contradicts','context'].includes(relation))throw new Error('未知證據關係')
  return {sourceId:source.id,quote,relation,location:String(ref.location||'')}
 })
 const reasoning=String(input.reasoning??existing?.reasoning??'')
 if(kind==='inference'||kind==='unknown')required(reasoning,kind==='inference'?'推論依據與假設':'尚未確認的原因')
 return {id:input.id||'claim-'+randomUUID(),statement:required(input.statement??existing?.statement,'新建論點的 statement'),kind,requirementIds:requirements,evidence,reasoning,resolution:String(input.resolution??existing?.resolution??'')}
}
export function validateTask(task,sourceText) {
 const errors=[],warnings=[]
 if(!task.steps.length)errors.push('尚未建立工作計畫')
 for(const step of task.steps)if(step.status!=='done')errors.push('步驟未完成：'+step.id+' '+step.title)
 if(!task.claims.length)errors.push('尚無可交付的論點')
 if(task.mode==='decision'&&!task.comparison)errors.push('尚未建立方案與評估條件的比較表')
 for(const claim of task.claims){
  const supports=claim.evidence.filter(e=>e.relation==='supports')
  if(claim.kind!=='unknown'&&!supports.length)errors.push(claim.id+' 缺少支持證據')
  if(claim.kind==='unknown')warnings.push(claim.id+' 尚未確認：'+claim.reasoning)
  if(claim.evidence.some(e=>e.relation==='contradicts')&&!claim.resolution.trim())errors.push(claim.id+' 的相反證據尚未處理')
  for(const ref of claim.evidence){
   const source=task.sources.find(s=>s.id===ref.sourceId)
   if(!source||!sourceText(ref.sourceId).includes(ref.quote))errors.push(claim.id+' 的引用無法核對')
   if(source?.supersededBy)errors.push(claim.id+' 仍引用已被更新的來源 '+source.id)
   if(source?.isError&&ref.relation==='supports'&&claim.kind!=='unknown')errors.push(claim.id+' 不可將失敗的工具結果當作已讀來源的支持證據')
  }
 }
 for(const requirement of task.requirements){
  const claims=task.claims.filter(c=>c.requirementIds.includes(requirement.id))
  if(!claims.length)errors.push('交付條件未涵蓋：'+requirement.id+' '+requirement.text)
  else if(claims.every(c=>c.kind==='unknown'))errors.push('交付條件仍未確認：'+requirement.id)
 }
 return {errors,warnings,ready:errors.length===0}
}
export function summary(task) {
 const done=new Set(task.steps.filter(s=>s.status==='done').map(s=>s.id))
 const next=task.steps.filter(s=>['pending','running'].includes(s.status)&&s.dependsOn.every(id=>done.has(id)))
 const stage=task.status!=='active'?task.status:!task.steps.length?'plan':task.review?.contentRevision===task.contentRevision&&task.review.ready?'deliver':task.steps.every(s=>s.status==='done')?'review':next[0]?.kind||'blocked'
 return {id:task.id,title:task.title,workspace:task.workspace,mode:task.mode,status:task.status,stage,objective:task.objective,requirements:task.requirements,
  progress:{completed:done.size,total:task.steps.length},sources:task.sources.length,claims:task.claims.length,
  nextSteps:next.map(s=>({id:s.id,title:s.title,kind:s.kind})),blockedSteps:task.steps.filter(s=>s.status==='blocked').map(s=>({id:s.id,reason:s.note})),
  unknownClaims:task.claims.filter(c=>c.kind==='unknown').map(c=>({id:c.id,statement:c.statement})),reason:task.reason,revision:task.revision,contentRevision:task.contentRevision,updatedAt:task.updatedAt}
}
const line=value=>String(value??'').replace(/\r?\n/g,' ')
export function renderReport(task,{partial=false,limitations=[]}={}) {
 const sourceLabel=new Map(task.sources.map((s,i)=>[s.id,'S'+(i+1)]))
 const out=['# '+line(task.title),'',partial?'狀態：部分成果，工作尚未完成。':'狀態：交付條件與證據連結已檢查。','',task.objective]
 if(task.scope)out.push('','適用範圍：'+task.scope)
 out.push('','## 問題與結論')
 for(const r of task.requirements){out.push('','### '+line(r.text));const claims=task.claims.filter(c=>c.requirementIds.includes(r.id));if(!claims.length)out.push('尚未完成。');for(const c of claims)out.push(...renderClaim(c,sourceLabel,task.sources))}
 const extra=task.claims.filter(c=>!c.requirementIds.length);if(extra.length){out.push('','## 補充發現');for(const c of extra)out.push(...renderClaim(c,sourceLabel,task.sources))}
 if(task.comparison){out.push('','## 方案比較');for(const option of task.comparison.options){out.push('','### '+line(option));for(const criterion of task.comparison.criteria){const cell=task.comparison.assessments.find(a=>a.option===option&&a.criterion===criterion);out.push('', '**'+line(criterion)+'**');for(const id of cell.claimIds){const claim=task.claims.find(c=>c.id===id);if(claim)out.push(...renderClaim(claim,sourceLabel,task.sources))}}}}
 out.push('','## 來源與原文依據')
 for(const source of task.sources){
  out.push('',`### ${sourceLabel.get(source.id)} · ${line(source.title)}`,`位置：${line(source.locator)}`,`擷取時間：${source.capturedAt}`,`工具／訊息時間：${source.observedAt||'未提供'}`,`適用範圍／版本：${line(source.scope||'未標註')}`)
  if(source.publishedAt)out.push('來源日期標註：'+line(source.publishedAt))
  if(source.supersededBy)out.push('已被較新來源取代。')
  for(const claim of task.claims)for(const ref of claim.evidence.filter(e=>e.sourceId===source.id))out.push('',`關係：${ref.relation}；位置：${line(ref.location||'工具所回傳片段')}`,...ref.quote.split(/\r?\n/).map(l=>'> '+l))
 }
 if(limitations.length||task.review?.warnings?.length){out.push('','## 限制與待確認事項');for(const note of [...limitations,...(task.review?.warnings||[])])out.push('- '+note)}
 out.push('','## 工作紀錄',...task.steps.map(s=>`- [${s.status==='done'?'x':' '}] ${line(s.title)}：${line(s.note||s.status)}`),'','證據連結檢查不等於來源內容必然正確；推論、未知與相反證據已分別標註。','')
 return out.join('\n')
}
function renderClaim(c,labels,sources){
 let kind={fact:'陳述',inference:'推論',unknown:'尚未確認'}[c.kind]
 if(c.kind!=='unknown'&&!c.evidence.some(e=>e.relation==='supports'&&sources.some(s=>s.id===e.sourceId&&!s.supersededBy&&!s.isError)))kind+='（證據不足）'
 if(c.evidence.some(e=>e.relation==='contradicts')&&!c.resolution.trim())kind+='（衝突未解）'
 const refs=[...new Set(c.evidence.map(e=>labels.get(e.sourceId)))].filter(Boolean).map(x=>'['+x+']').join(' ')
 return ['',`**${kind}**：${c.statement} ${refs}`,...(c.reasoning?['依據／假設：'+c.reasoning]:[]),...(c.resolution?['相反證據的處理：'+c.resolution]:[])]
}

export function comparisonRecord(task,input){
 const options=strings(input.options,'options'),criteria=strings(input.criteria,'criteria')
 if(options.length<2||!criteria.length||new Set(options).size!==options.length||new Set(criteria).size!==criteria.length)throw new Error('方案比較需要至少兩個不重複方案與一個評估條件')
 if(!Array.isArray(input.assessments))throw new Error('assessments 必須是陣列')
 const seen=new Set(),assessments=input.assessments.map(cell=>{
  if(!options.includes(cell.option)||!criteria.includes(cell.criterion))throw new Error('比較格子引用了未定義的方案或條件')
  const key=JSON.stringify([cell.option,cell.criterion]);if(seen.has(key))throw new Error('比較格子不可重複');seen.add(key)
  const ids=strings(cell.claimIds,'claimIds');if(!ids.length||ids.some(id=>!task.claims.some(c=>c.id===id)))throw new Error('每個比較格子需要引用已整理的論點；未知也要明確記錄')
  return {option:cell.option,criterion:cell.criterion,claimIds:ids}
 })
 if(assessments.length!==options.length*criteria.length)throw new Error('請涵蓋每個方案與評估條件；缺少資料時以 unknown 論點標記')
 return {options,criteria,assessments}
}
export function suggestedPlan(mode){
 const titles=mode==='decision'?['確認決策條件與可選方案','蒐集各方案的對應證據','依相同條件比較並標記未知','檢查結論、分歧與適用範圍']:mode==='maintenance'?['盤點需要維護的結論與來源','重新讀取來源並記錄更新','修訂受影響的論點與引用','檢查更新後的交付條件']:['確認範圍與蒐集第一手資料','對照資料、形成論點並找相反證據','核對引用、覆蓋範圍與剩餘缺口']
 return titles.map((title,i)=>({id:'s'+(i+1),title,kind:i===titles.length-1?'verification':i===(mode==='research'?0:1)?'research':'analysis',dependsOn:i?['s'+i]:[]}))
}
