import {join} from 'node:path'
import {homedir} from 'node:os'
import z from '@deepseek-ai/schemastery'
import {KnowledgeStore} from './store.js'
export const name='knowledge-work'
export const Config=z.object({dataDir:z.string().default(''),autoContinue:z.boolean().default(true)})
export function apply(ctx,config={}){
 const directory=config.dataDir||join(process.env.DSH_HOME||join(homedir(),'.dsh'),'storages','knowledge-work')
 const store=new KnowledgeStore(join(directory,'work.sqlite'));store.autoContinue=config.autoContinue??true
 ctx.provide('knowledgeWork',store)
 ctx.effect(()=>()=>store.close())
 ctx.inject(['connection'],scope=>scope.effect(()=>scope.connection.fetch.register({path:'/api/knowledge-work',methods:['GET'],requestBody:'buffered',fetch:async request=>{
  const url=new URL(request.url)
  try{
   if(url.searchParams.has('report')){
    const id=url.searchParams.get('report'),revision=Number(url.searchParams.get('revision'))
    if(!Number.isSafeInteger(revision)||revision<1)throw new Error('無效報告版本')
    const report=store.readReport(id,revision)
    return new Response(report.markdown,{headers:{'Content-Type':'text/markdown; charset=utf-8','Content-Disposition':`attachment; filename="${encodeURIComponent(id)}-r${revision}.md"`,'Cache-Control':'no-store'}})
   }
   const id=url.searchParams.get('task'),source=url.searchParams.get('source')
   if(id){const task=store.read(id);return Response.json({ok:true,task,...source?{sourceText:store.source(id,source)}:{}},{headers:{'Cache-Control':'no-store'}})}
   return Response.json({ok:true,tasks:store.list()},{headers:{'Cache-Control':'no-store'}})
  }catch(error){return Response.json({ok:false,error:error.message},{status:400,headers:{'Cache-Control':'no-store'}})}
 }})))
}
