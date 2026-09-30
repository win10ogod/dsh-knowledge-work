import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {setTimeout as delay} from 'node:timers/promises'
import {Context} from '@deepseek-ai/cordis'
import * as core from '../lib/index.js'

test('workflow storage activates during installation without waiting for a web connection',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'knowledge-core-')),ctx=new Context(),routes=[]
 try{
  await ctx.plugin(core,{dataDir:directory,autoContinue:true})
  assert.ok(ctx.get('knowledgeWork'))
  ctx.provide('connection',{fetch:{register(route){routes.push(route);return()=>{}}}})
  for(let i=0;i<20&&!routes.length;i++)await delay(5)
  assert.equal(routes.length,1)
  const response=await routes[0].fetch(new Request('http://localhost/api/knowledge-work'))
  assert.deepEqual(await response.json(),{ok:true,tasks:[]})
 }finally{await ctx.fiber.dispose();rmSync(directory,{recursive:true,force:true})}
})
