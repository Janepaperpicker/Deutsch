import test from 'node:test'
import assert from 'node:assert/strict'
import { createOfflineSynthesizer } from '../optional/german-voice/runtime.mjs'
const bytes=()=>new Uint8Array([1,2,3]).buffer
const turn=()=>new Promise(resolve=>setImmediate(resolve))
class FakeWorker {
 static all=[]
 constructor(){this.terminated=false;FakeWorker.all.push(this)}
 postMessage(data){if(FakeWorker.hold&&data.type==='speak')return;queueMicrotask(()=>this.onmessage?.({data:data.type==='init'?{id:data.id,ready:true}:{id:data.id,samples:new Float32Array([.1,-.1]).buffer,sampleRate:22050}}))}
 terminate(){this.terminated=true}
}
async function fixture(action){const original=globalThis.Worker;globalThis.Worker=FakeWorker;FakeWorker.all=[];FakeWorker.hold=false;try{await action()}finally{if(original)globalThis.Worker=original;else delete globalThis.Worker}}
test('offline runtime reuses a worker, cancels requests and can restart',async()=>fixture(async()=>{
 const speaker=createOfflineSynthesizer({readAsset:async()=>bytes()})
 try{
  assert.equal((await speaker.synthesize('Haus')).sampleRate,22050)
  await speaker.synthesize('Buch');assert.equal(FakeWorker.all.length,1)
  FakeWorker.hold=true
  const pending=speaker.synthesize('Wohnung');await turn();speaker.stop();await assert.rejects(pending,{name:'AbortError'})
  assert.equal(FakeWorker.all[0].terminated,true)
  FakeWorker.hold=false;await speaker.synthesize('lernen');assert.equal(FakeWorker.all.length,2)
  await assert.rejects(speaker.synthesize('x'.repeat(501)),/short phrase/)
 }finally{speaker.stop()}
}))
test('a cancelled old initialization cannot terminate a newer worker',async()=>fixture(async()=>{
 let first=true,release
 const speaker=createOfflineSynthesizer({readAsset:async(role)=>{if(role==='worker'&&first){first=false;return new Promise(resolve=>{release=resolve})}return bytes()}})
 try{
  const old=speaker.synthesize('alt');await turn();speaker.stop()
  const rejection=assert.rejects(old,{name:'AbortError'})
  await speaker.synthesize('neu');release(bytes());await rejection
  assert.equal(FakeWorker.all.at(-1).terminated,false)
  await speaker.synthesize('noch einmal')
 }finally{speaker.stop()}
}))
