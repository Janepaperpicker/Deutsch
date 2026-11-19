// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Deutsch Daily Deck contributors
import { createVoiceInstallation, checkDevice, validateRelease, downloadAssets } from './installation.mjs'
import { createOfflineSynthesizer } from './runtime.mjs'
const element = (id) => document.getElementById(id)
const status = (message) => { element('status').textContent = message }
const allowPreview = new URL(location.href).searchParams.get('preview') === '1'
const bridge = new URLSearchParams(location.hash.slice(1)).get('bridge')
const tellParent = (type, value = {}, transfer = []) => {
 if (bridge && parent !== self) parent.postMessage({ type, bridge, ...value }, location.origin, transfer)
}
let release, installation, speaker, abort, audio, source, busy = false, installing = false, installed = false, idleTimer
async function savedRelease() {
 const version = location.pathname.match(/\/releases\/([^/]+)\//)?.[1]
 for (const name of (await caches.keys()).filter((key) => key.startsWith('deutsch-optional-voice-')).sort().reverse()) {
  const marker = await (await caches.open(name)).match(new URL('/optional-voice/installation-complete', location.origin))
  if (!marker) continue
  try {
   const candidate = await marker.json()
   if (version && candidate.version !== version) continue
   validateRelease(candidate, location.origin, { allowPreview })
   return candidate
  } catch { /* Try another complete installation. */ }
 }
}
async function offlineStartupReady() {
 const registration = await navigator.serviceWorker?.getRegistration('/optional-voice/')
 return Boolean(registration?.active && new URL(registration.scope).pathname === '/optional-voice/')
}
async function ensureOfflineStartup() {
 const registration = await navigator.serviceWorker.register('/optional-voice/sw.js', { scope: '/optional-voice/' })
 if (registration.active) return
 await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Offline startup could not finish. Try again.')), 12_000)
  const worker = registration.installing ?? registration.waiting
  if (!worker) { clearTimeout(timer); reject(new Error('Offline startup could not finish.')); return }
  const changed = () => {
   if (worker.state === 'activated') { clearTimeout(timer); worker.removeEventListener('statechange', changed); resolve() }
   else if (worker.state === 'redundant') { clearTimeout(timer); worker.removeEventListener('statechange', changed); reject(new Error('Offline startup could not finish.')) }
  }
  worker.addEventListener('statechange', changed)
  changed()
 })
}
function buttons() {
 element('listen').disabled = !installed || busy || installing
 element('install').disabled = busy || installing
 element('stop').hidden = !busy || Boolean(abort)
 element('cancel').hidden = !abort
 element('remove').hidden = !installed || installing
}
function stop() {
 if (busy) speaker?.stop()
 try { if (source) { source.onended = null; source.stop() } } catch { /* Already stopped. */ }
 source = null
 busy = false
 buttons()
}
async function refresh() {
 const downloaded = await installation.status() === 'installed'
 installed = downloaded && await offlineStartupReady()
 element('install').hidden = installed
 element('install').textContent = downloaded ? 'Finish offline setup' : `Download${release.channel === 'preview' ? ' preview' : ''} (${Math.ceil(downloadAssets(release).reduce((sum, asset) => sum + asset.bytes, 0) / 1_000_000)} MB)`
 buttons()
 tellParent('voice-ready', { installed })
}
async function generate(text) {
 if (!installed) throw new Error('Download the German voice first.')
 if (busy || installing) throw new Error('Speech is already running.')
 clearTimeout(idleTimer)
 busy = true; buttons()
 try { return await speaker.synthesize(text) }
 catch (error) { if (error.name !== 'AbortError') status(error.message); throw error }
 finally { busy = false; idleTimer = setTimeout(() => { if (!busy) speaker.stop() }, 120_000); buttons() }
}
element('install').onclick = async () => {
 if (!installation || busy || installing) return
 installing = true; abort = new AbortController(); tellParent('voice-download', { busy: true }); buttons(); element('progress').hidden = false
 try {
  await installation.install({ consent: true, signal: abort.signal, onProgress: ({ received, total }) => {
   element('progress').value = received / total; status(`Downloading… ${Math.floor(received / total * 100)}%`)
  } })
  abort = null
  status('Finishing offline setup…')
  await ensureOfflineStartup()
  status('Ready offline.')
  await refresh()
  tellParent('voice-installed')
 } catch (error) { status(error.name === 'AbortError' ? 'Download cancelled.' : error.message) }
 finally { installing = false; abort = null; tellParent('voice-download', { busy: false }); element('progress').hidden = true; buttons() }
}
element('cancel').onclick = () => abort?.abort()
element('stop').onclick = () => { stop(); status('Stopped.') }
element('remove').onclick = async () => {
 stop()
 speaker?.stop()
 clearTimeout(idleTimer)
 try { await installation.remove(); await refresh(); status('Download removed.'); tellParent('voice-removed') }
 catch (error) { status(error.message) }
}
element('speech').onsubmit = async (event) => {
 event.preventDefault()
 const text = element('word').value.trim()
 if (!text || busy) return
 try {
  audio ??= new AudioContext()
  await audio.resume()
  status('Preparing voice…')
  const result = await generate(text)
  const samples = new Float32Array(result.samples)
  const buffer = audio.createBuffer(1, samples.length, result.sampleRate)
  buffer.copyToChannel(samples, 0)
  source = audio.createBufferSource(); source.buffer = buffer; source.connect(audio.destination)
  busy = true; buttons(); status('Playing…')
  source.onended = () => { busy = false; source = null; buttons(); status('Ready offline.') }
  source.start()
 } catch (error) { if (error.name !== 'AbortError') status(error.message) }
}
window.addEventListener('message', async ({ source: sender, origin, data }) => {
 if (sender !== parent || origin !== location.origin || !bridge || data?.bridge !== bridge) return
 if (data.type === 'voice-word' && typeof data.text === 'string') element('word').value = data.text.slice(0, 500)
 if (data.type === 'voice-stop') stop()
 if (data.type === 'voice-dispose') { stop(); speaker?.stop() }
 if (data.type === 'voice-cancel-download') abort?.abort()
 if (data.type === 'voice-synthesize') {
  try { const result = await generate(data.text); tellParent('voice-result', { id: data.id, samples: result.samples, sampleRate: result.sampleRate }, [result.samples]) }
  catch (error) { tellParent('voice-result', { id: data.id, error: error.name === 'AbortError' ? 'Speech stopped.' : error.message }) }
 }
})
window.addEventListener('pagehide', () => { stop(); speaker?.stop(); clearTimeout(idleTimer); void audio?.close() })
document.addEventListener('visibilitychange', () => { if (document.hidden) { stop(); speaker?.stop() } })
try {
 release = await savedRelease()
 if (!release) {
  const response = await fetch('/optional-voice/release.json', { cache: 'no-store' })
  if (!response.ok) throw new Error('Voice download is not available yet.')
  release = await response.json()
 }
 validateRelease(release, location.origin, { allowPreview })
 if (!checkDevice().supported) throw new Error('Offline voice is not supported in this browser.')
 element('preview').hidden = release.channel !== 'preview'
 element('preview-note').hidden = release.channel !== 'preview' || (release.review.ios && release.review.android)
 element('source').href = release.assets.find((asset) => asset.role === 'notices').path
 element('source-code').href = release.assets.find((asset) => asset.role === 'source').path
 installation = createVoiceInstallation({ release, origin: location.origin, allowPreview })
 speaker = createOfflineSynthesizer(installation)
 await refresh()
 status(installed ? 'Ready offline.' : '')
} catch { element('install').disabled = true; element('install').textContent = 'Download unavailable'; status(checkDevice().supported ? 'Voice download is not available yet.' : 'Offline voice is not supported in this browser.'); tellParent('voice-ready', { installed: false }) }

document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && bridge) { event.preventDefault(); tellParent('voice-close') } })
