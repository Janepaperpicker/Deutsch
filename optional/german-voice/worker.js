// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Deutsch Daily Deck contributors
let session, phonemizer, config, outputLines = []
const urls = []
let busy = false
const blobUrl = (bytes, type) => { const url = URL.createObjectURL(new Blob([bytes], {type})); urls.push(url); return url }
// Inference has no network fallback. All executable/data bytes come from the verified installer.
const fetchBlob = self.fetch.bind(self)
self.fetch = (input, init) => String(input).startsWith('blob:') ? fetchBlob(input, init) : Promise.reject(new Error('Network disabled for offline speech.'))
self.onmessage = async ({data}) => {
 if (busy) { self.postMessage({id:data.id,error:'Speech is busy.'}); return }
 busy = true
 try {
  if (data.type === 'init') {
   if (session) throw new Error('Voice is already initialized.')
   importScripts(blobUrl(data.assets.runtime,'text/javascript'))
   ort.env.wasm.numThreads=1
   ort.env.wasm.simd=true
   ort.env.wasm.proxy=false
   ort.env.wasm.wasmPaths={'ort-wasm-simd.wasm':blobUrl(data.assets['runtime-wasm'],'application/wasm')}
   importScripts(blobUrl(data.assets.phonemizer,'text/javascript'))
   phonemizer=await createPiperPhonemize({wasmBinary:data.assets['phonemizer-wasm'],getPreloadedPackage:()=>data.assets['phonemizer-data'],print:line=>{outputLines.push(line)},printErr:()=>{}})
   config=JSON.parse(new TextDecoder().decode(data.assets.config))
   if (config.espeak?.voice !== 'de' || config.audio?.sample_rate !== 22050) throw new Error('Unsupported voice configuration.')
   session=await ort.InferenceSession.create(data.assets.model,{executionProviders:['wasm']})
   self.postMessage({id:data.id,ready:true})
  } else if (data.type === 'speak') {
   if (!session || typeof data.text !== 'string' || !data.text.trim() || data.text.length > 500) throw new Error('Choose a word or a short phrase.')
   outputLines=[]
   phonemizer.callMain(['-l','de','--input',JSON.stringify([{text:data.text.trim()}]),'--espeak_data','/espeak-ng-data'])
   const ids=outputLines.flatMap(line=>JSON.parse(line).phoneme_ids)
   if (!ids.length || ids.length > 4096) throw new Error('Could not pronounce this text.')
   const result=await session.run({input:new ort.Tensor('int64',BigInt64Array.from(ids,BigInt),[1,ids.length]),input_lengths:new ort.Tensor('int64',BigInt64Array.of(BigInt(ids.length)),[1]),scales:new ort.Tensor('float32',Float32Array.of(config.inference.noise_scale,config.inference.length_scale,config.inference.noise_w),[3])})
   const samples=result.output.data
   if (!(samples instanceof Float32Array) || samples.length > config.audio.sample_rate * 120 || !samples.every(Number.isFinite)) throw new Error('Speech generation failed.')
   self.postMessage({id:data.id,samples:samples.buffer,sampleRate:config.audio.sample_rate},[samples.buffer])
  } else if(data.type==='dispose') {
   await session?.release();session=null;urls.forEach(url=>URL.revokeObjectURL(url));self.close()
  } else throw new Error('Unknown speech request.')
 } catch { self.postMessage({id:data.id,error:'Offline speech could not start. Try again.'}) }
 finally {busy=false}
}
