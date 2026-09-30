import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import vm from 'node:vm'
test('client exposes a dedicated native slot without replacing existing surfaces',async()=>{
 let definition
 vm.runInNewContext(await readFile(new URL('../lib/client.js',import.meta.url),'utf8'),{window:{__ModuleLoader__:{load:value=>{definition=value}}}})
 assert.equal(definition.id,'dsh-knowledge-work')
 const client=definition.factory(name=>{assert.equal(name,'react');return {createElement(){}}}),slots=[]
 client.apply({effect:fn=>fn(),slots:{inject:(_name,fn)=>fn(),register:meta=>{slots.push(meta);return()=>{}}}})
 assert.equal(slots.length,2);assert.equal(slots[0].label,'知識工作');assert.equal(slots[1].key,'knowledge-work')
})
