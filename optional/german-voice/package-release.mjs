// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Deutsch Daily Deck contributors
import { readFile, writeFile, cp, mkdir, mkdtemp, rm, readdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
const component = dirname(fileURLToPath(import.meta.url))
const [buildArgument, outputArgument] = process.argv.slice(2)
if (!buildArgument || !outputArgument) throw new Error('Usage: node package-release.mjs /pinned/build-directory /release-directory')
const build = resolve(buildArgument), output = resolve(outputArgument), version = '2026.11.19-preview.1'
const pins = {
 espeak: '0f65aa301e0d6bae5e172cc74197d32a6182200f',
 piper: 'cfff8e52ebaea37c7e953ae2d06b174acb827ac4',
 emsdk: '708dcbcc9ee23bc7d2dad44fc90db377e38b771c', emscripten: '3.1.47',
 onnxruntime: '1.18.0', modelRepository: 'diffusionstudio/piper-voices', modelRevision: (await readFile(join(build,'model-revision.txt'),'utf8')).trim(),
}
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
await mkdir(output, { recursive: true })
const scratch = await mkdtemp(join(tmpdir(), 'deutsch-voice-source-'))
try {
 const sourceRoot = join(scratch, 'deutsch-voice-source')
 const sourceComponent = join(sourceRoot, 'optional/german-voice')
 await mkdir(sourceComponent, { recursive: true })
 for (const name of await readdir(component)) if (name !== 'release.json') await cp(join(component,name),join(sourceComponent,name),{recursive:true})
 await writeFile(join(sourceComponent,'release.json'),JSON.stringify({schema:1,id:'thorsten-medium',version:'unreleased',enabled:false,review:{correspondingSource:false,licenses:false,coldStartOffline:false,ios:false,android:false},assets:[]},null,2)+'\n')
 for (const [name, revision] of [['espeak-ng', pins.espeak], ['piper-phonemize',pins.piper]]) {
  const repo=join(build,name)
  if(execFileSync('git',['-C',repo,'rev-parse','HEAD'],{encoding:'utf8'}).trim()!==revision)throw new Error(`Unexpected ${name} source`)
  const destination=join(sourceRoot,'sources',name);await mkdir(destination,{recursive:true})
  const archive=execFileSync('git',['-C',repo,'archive','--format=tar','HEAD'],{maxBuffer:256*1024*1024})
  execFileSync('tar',['-xf','-','-C',destination],{input:archive})
 }
 const actualPatch=execFileSync('git',['-C',join(build,'espeak-ng'),'diff','--','src/include/compat/wctype.h'],{encoding:'utf8'})
 if(actualPatch!==await readFile(join(component,'patches/emscripten-wctype.patch'),'utf8'))throw new Error('Source patch does not match the compiled build')
 await cp(join(build,'espeak-ng/src/include/compat/wctype.h'),join(sourceRoot,'sources/espeak-ng/src/include/compat/wctype.h'))
 await writeFile(join(sourceRoot,'SOURCE-PINS.json'),JSON.stringify(pins,null,2)+'\n')
 execFileSync('tar',['-czf',join(output,'source.tar.gz'),'-C',scratch,'deutsch-voice-source'])
 const copies={model:'de_DE-thorsten-medium.onnx',config:'de_DE-thorsten-medium.onnx.json',runtime:'runtime.js','runtime-wasm':'runtime.wasm',phonemizer:'phonemizer.js','phonemizer-wasm':'phonemizer.wasm','phonemizer-data':'phonemizer.data','model-card':'MODEL_CARD'}
 const filenames={model:'model.onnx',config:'model.json',runtime:'runtime.js','runtime-wasm':'runtime.wasm',phonemizer:'phonemizer.js','phonemizer-wasm':'phonemizer.wasm','phonemizer-data':'phonemizer.data','model-card':'MODEL_CARD',source:'source.tar.gz',notices:'NOTICES.txt','build-recipe':'rebuild.sh',worker:'worker.js',entry:'index.html',page:'page.mjs',style:'style.css',installer:'installation.mjs','runtime-client':'runtime.mjs','service-worker':'sw.js'}
 for(const[role,file]of Object.entries(copies))await cp(join(build,'artifacts',file),join(output,filenames[role]))
 for(const[role,file]of Object.entries({worker:'worker.js',entry:'index.html',page:'page.mjs',style:'style.css',installer:'installation.mjs','runtime-client':'runtime.mjs','service-worker':'sw.js','build-recipe':'rebuild.sh'}))await cp(join(component,file),join(output,filenames[role]))
 const notices=[await readFile(join(component,'NOTICE'),'utf8'),await readFile(join(component,'LICENSE'),'utf8')]
 for(const file of ['ORT-LICENSE','ORT-ThirdPartyNotices.txt'])notices.push(await readFile(join(build,'artifacts',file),'utf8'))
 notices.push('Model repository README at the pinned revision:\n'+await readFile(join(build,'artifacts/MODEL-REPOSITORY-README'),'utf8'))
 for(const file of ['LICENSE','system/lib/libcxx/LICENSE.TXT','system/lib/libcxxabi/LICENSE.TXT','system/lib/libunwind/LICENSE.TXT','system/lib/compiler-rt/LICENSE.TXT','system/lib/libc/musl/COPYRIGHT'])notices.push(`Emscripten ${file}\n`+await readFile(join(build,'emsdk/upstream/emscripten',file),'utf8'))
 for(const file of ['COPYING','COPYING.UCD','COPYING.BSD2','COPYING.APACHE'])notices.push(await readFile(join(build,'espeak-ng',file),'utf8'))
 notices.push(await readFile(join(build,'piper-phonemize/LICENSE.md'),'utf8'),await readFile(join(build,'piper-phonemize/licenses/uni-algo/LICENSE.md'),'utf8'))
 notices.push('Exact source pins:\n'+JSON.stringify(pins,null,2)+'\nGerman and English eSpeak dictionaries retained; other dictionaries omitted.\nThe Thorsten model card and original recording project describe CC0 data. Preserve the model repository terms and the supplied model card; no human Wikimedia recordings are included.')
 await writeFile(join(output,'NOTICES.txt'),notices.join('\n\n----------\n\n'))
 const assets=[]
 for(const[role,file]of Object.entries(filenames)){const bytes=await readFile(join(output,file));assets.push({role,path:`/optional-voice/releases/${version}/${file}`,bytes:bytes.length,sha256:sha(bytes)})}
 const release={schema:1,id:'thorsten-medium',version,channel:'preview',enabled:false,review:{correspondingSource:true,licenses:true,coldStartOffline:false,ios:false,android:false},assets}
 await writeFile(join(output,'release.json'),JSON.stringify(release,null,2)+'\n')
 await writeFile(join(output,'SOURCE-PINS.json'),JSON.stringify(pins,null,2)+'\n')
 console.log(JSON.stringify({version,bytes:assets.reduce((sum,asset)=>sum+asset.bytes,0),assets:assets.length,enabled:false}))
}finally{await rm(scratch,{recursive:true,force:true})}
