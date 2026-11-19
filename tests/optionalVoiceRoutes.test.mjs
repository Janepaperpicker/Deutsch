import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { once } from 'node:events'
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { createOptionalVoiceRouter } from '../server/optionalVoice.js'
const bytes = Buffer.from('public model fixture')
const release = { schema: 1, id: 'thorsten-medium', version: 'test-1', enabled: true, assets: [{ role: 'model', path: '/optional-voice/releases/test-1/model.onnx', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }] }
async function fixture(action, { remote = false, fetchAsset } = {}) {
 const directory = await mkdtemp(join(tmpdir(), 'deutsch-voice-route-test-'))
 await writeFile(join(directory,'release.json'),JSON.stringify(release))
 await writeFile(join(directory,'model.onnx'),bytes)
 const app = express()
 app.use('/optional-voice',createOptionalVoiceRouter({componentDirectory:directory, assetDirectory:remote?undefined:directory, cacheDirectory:join(directory,'cache'),fetchAsset}))
 const server=app.listen(0);await once(server,'listening');const origin=`http://127.0.0.1:${server.address().port}`
 try { await action({directory,origin}) }
 finally { await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true}) }
}
test('voice routes expose only listed release assets and honor disabled releases',async()=>fixture(async({directory,origin})=>{
 const metadata=await fetch(origin+'/optional-voice/release.json');assert.equal(metadata.headers.get('cache-control'),'no-store');assert.equal((await metadata.json()).id,'thorsten-medium')
 const response=await fetch(origin+release.assets[0].path);assert.equal(response.status,200);assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes);assert.match(response.headers.get('content-security-policy'),/wasm-unsafe-eval/)
 assert.equal((await fetch(origin+'/optional-voice/releases/test-1/private.env')).status,404)
 assert.equal((await fetch(origin+'/optional-voice/releases/other/model.onnx')).status,404)
 await writeFile(join(directory,'release.json'),JSON.stringify({...release,enabled:false}))
 assert.equal((await fetch(origin+release.assets[0].path)).status,404)
}))
test('a concurrent fixed upstream download is verified and cached once',async()=>{
 let requests=0
 await fixture(async({directory,origin})=>{
  const responses=await Promise.all([fetch(origin+release.assets[0].path),fetch(origin+release.assets[0].path)])
  assert.deepEqual(await Promise.all(responses.map(async response=>{assert.equal(response.status,200);return await response.text()})),[bytes.toString(),bytes.toString()])
  assert.equal(requests,1)
  assert.deepEqual(await readFile(join(directory,'cache/test-1/model.onnx')),bytes)
  await writeFile(join(directory,'cache/test-1/model.onnx'),Buffer.alloc(bytes.length))
  const repaired=await fetch(origin+release.assets[0].path)
  assert.equal(repaired.status,200)
  assert.equal(await repaired.text(),bytes.toString())
  assert.equal(requests,2)
 },{remote:true,fetchAsset:async url=>{requests++;assert.equal(url,'https://github.com/saintheraldfaust/Deutsch/releases/download/deutsch-voice-test-1/model.onnx');return new Response(bytes)}})
})
test('bad upstream bytes fail closed and a later retry can succeed',async()=>{
 let bad=true
 await fixture(async({origin})=>{
  assert.equal((await fetch(origin+release.assets[0].path)).status,503)
  bad=false;const response=await fetch(origin+release.assets[0].path);assert.equal(response.status,200);assert.equal(await response.text(),bytes.toString())
 },{remote:true,fetchAsset:async()=>new Response(bad?Buffer.alloc(bytes.length):bytes)})
})
