import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { OfflineVoiceContext } from './offlineVoiceContext'
import { useConfirm } from './confirmContext'
import './OfflineVoice.css'

type Availability = { url: string; installed: boolean; preview: boolean }
type Waiting = { resolve: (result: { samples: ArrayBuffer; sampleRate: number }) => void; reject: (error: Error) => void; timer: number }
const setupUrl = (preview: boolean) => `/optional-voice/index.html${preview ? '?preview=1' : ''}`
async function availability(): Promise<Availability | null> {
  if (!globalThis.isSecureContext) return null
  let installed: Availability | null = null
  try {
    for (const name of (await caches.keys()).filter((key) => key.startsWith('deutsch-optional-voice-')).sort().reverse()) {
      const cache = await caches.open(name)
      const marker = await cache.match(new URL('/optional-voice/installation-complete', location.origin).href)
      if (!marker) continue
      const release = await marker.json()
      const entry = release.assets?.find((asset: { role?: string }) => asset.role === 'entry')?.path
      if (release.id !== 'thorsten-medium' || release.enabled !== true || typeof entry !== 'string' || !/^\/optional-voice\/releases\/[a-z0-9.-]+\/index\.html$/.test(entry)) continue
      if (!await cache.match(new URL(entry, location.origin).href)) continue
      installed = { url: `${entry}${release.channel === 'preview' ? '?preview=1' : ''}`, installed: true, preview: release.channel === 'preview' }
      break
    }
  } catch { /* Download metadata must never block study. */ }
  if (installed) return installed
  try {
    const response = await fetch('/optional-voice/release.json', { cache: 'no-store', signal: AbortSignal.timeout(5000) })
    const release = await response.json()
    if (response.ok && release.id === 'thorsten-medium' && release.enabled === true) return { url: setupUrl(release.channel === 'preview'), installed: false, preview: release.channel === 'preview' }
  } catch { /* An installed voice can still be used offline. */ }
  return null
}

export function OfflineVoiceProvider({ children }: { children: ReactNode }) {
  const confirm = useConfirm()
  const [available, setAvailable] = useState<Availability | null>(null)
  const [frameUrl, setFrameUrl] = useState<string | null>(null)
  const frame = useRef<HTMLIFrameElement>(null)
  const dialog = useRef<HTMLDialogElement>(null)
  const [bridge] = useState(() => globalThis.crypto?.randomUUID?.() ?? '')
  const ready = useRef(false)
  const childInstalled = useRef(false)
  const readyWaiters = useRef<Array<() => void>>([])
  const pending = useRef(new Map<string, Waiting>())
  const word = useRef('')
  const downloading = useRef(false)
  const closing = useRef(false)
  const audio = useRef<AudioContext | null>(null)
  const source = useRef<AudioBufferSourceNode | null>(null)
  const playbackEnded = useRef<(() => void) | null>(null)
  const playGeneration = useRef(0)
  const send = useCallback((message: object) => frame.current?.contentWindow?.postMessage({ ...message, bridge }, location.origin), [bridge])
  const refresh = useCallback(async () => setAvailable(await availability()), [])
  useEffect(() => { let active = true; void availability().then((value) => { if (active) setAvailable(value) }); return () => { active = false } }, [])
  const stop = useCallback(() => {
    playGeneration.current += 1
    send({ type: 'voice-stop' })
    try { if (source.current) { source.current.onended = null; source.current.stop() } } catch { /* Already stopped. */ }
    source.current = null
    playbackEnded.current?.()
    playbackEnded.current = null
    for (const request of pending.current.values()) { window.clearTimeout(request.timer); request.reject(new DOMException('Speech stopped.', 'AbortError')) }
    pending.current.clear()
  }, [send])
  const ensureFrame = useCallback(() => {
    if (frameUrl || !available) return
    ready.current = false
    setFrameUrl(`${available.url}#bridge=${bridge}`)
  }, [available, bridge, frameUrl])
  const open = useCallback((text = '') => {
    word.current = text
    ensureFrame()
    send({ type: 'voice-word', text })
    dialog.current?.showModal()
  }, [ensureFrame, send])
  const clear = useCallback(() => {
    stop()
    word.current = ''
    send({ type: 'voice-dispose' })
    send({ type: 'voice-word', text: '' })
    dialog.current?.close()
  }, [send, stop])
  const requestClose = useCallback(async () => {
    if (closing.current) return
    closing.current = true
    try {
      if (downloading.current && !await confirm({ title: 'Cancel voice download?', message: 'Files from this unfinished download will be removed.', confirmLabel: 'Cancel download', cancelLabel: 'Keep downloading', tone: 'danger' })) return
      if (downloading.current) send({ type: 'voice-cancel-download' })
      stop()
      dialog.current?.close()
    } finally { closing.current = false }
  }, [confirm, send, stop])
  useEffect(() => {
    const message = (event: MessageEvent) => {
      if (event.origin !== location.origin || event.source !== frame.current?.contentWindow || event.data?.bridge !== bridge) return
      const data = event.data
      if (data.type === 'voice-ready') {
        ready.current = true
        childInstalled.current = data.installed === true
        send({ type: 'voice-word', text: word.current })
        readyWaiters.current.splice(0).forEach((resolve) => resolve())
      } else if (data.type === 'voice-download') downloading.current = data.busy === true
      else if (data.type === 'voice-close') void requestClose()
      else if (data.type === 'voice-installed' || data.type === 'voice-removed') void refresh()
      else if (data.type === 'voice-result') {
        const request = pending.current.get(data.id)
        if (!request) return
        pending.current.delete(data.id)
        window.clearTimeout(request.timer)
        if (typeof data.error === 'string') request.reject(new Error(data.error))
        else if (data.samples instanceof ArrayBuffer && data.samples.byteLength > 0 && data.samples.byteLength <= 22050 * 120 * 4 && data.sampleRate === 22050) request.resolve(data)
        else request.reject(new Error('Offline speech returned invalid audio.'))
      }
    }
    window.addEventListener('message', message)
    return () => window.removeEventListener('message', message)
  }, [bridge, refresh, requestClose, send])
  const speak = useCallback(async (text: string, onPlaying?: () => void) => {
    if (!available?.installed) { open(text); return }
    stop()
    const generation = playGeneration.current
    audio.current ??= new AudioContext()
    await audio.current.resume()
    ensureFrame()
    if (!ready.current) await new Promise<void>((resolve, reject) => {
      const done = () => { window.clearTimeout(timer); resolve() }
      const timer = window.setTimeout(() => { readyWaiters.current = readyWaiters.current.filter((entry) => entry !== done); reject(new Error('Open voice setup online to repair the download.')) }, 15_000)
      readyWaiters.current.push(done)
    })
    if (generation !== playGeneration.current) throw new DOMException('Speech stopped.', 'AbortError')
    if (!childInstalled.current) { open(text); throw new Error('Finish the voice download before listening offline.') }
    const result = await new Promise<{ samples: ArrayBuffer; sampleRate: number }>((resolve, reject) => {
      const id = crypto.randomUUID()
      const timer = window.setTimeout(() => { pending.current.delete(id); send({ type: 'voice-stop' }); reject(new Error('Offline speech took too long. Try again.')) }, 60_000)
      pending.current.set(id, { resolve, reject, timer })
      send({ type: 'voice-synthesize', id, text })
    })
    if (generation !== playGeneration.current) throw new DOMException('Speech stopped.', 'AbortError')
    const samples = new Float32Array(result.samples)
    if (!samples.every(Number.isFinite)) throw new Error('Offline speech returned invalid audio.')
    const buffer = audio.current.createBuffer(1, samples.length, result.sampleRate)
    buffer.copyToChannel(samples, 0)
    const player = audio.current.createBufferSource(); player.buffer = buffer; player.connect(audio.current.destination); source.current = player
    await new Promise<void>((resolve) => { playbackEnded.current = resolve; player.onended = () => { source.current = null; playbackEnded.current = null; resolve() }; player.start(); onPlaying?.() })
  }, [available, ensureFrame, open, send, stop])
  useEffect(() => {
    const hidden = () => { if (document.hidden) stop() }
    document.addEventListener('visibilitychange', hidden)
    return () => { document.removeEventListener('visibilitychange', hidden); stop(); void audio.current?.close() }
  }, [stop])
  const value = useMemo(() => available ? { installed: available.installed, preview: available.preview, open, speak, stop, clear } : null, [available, open, speak, stop, clear])
  return <OfflineVoiceContext.Provider value={value}>
    {children}
    <dialog ref={dialog} className="offline-voice-dialog" aria-label="Offline German voice" onCancel={(event) => { event.preventDefault(); void requestClose() }} onClick={(event) => { if (event.target === event.currentTarget) void requestClose() }} onPointerDown={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
      <div className="offline-voice-toolbar"><button type="button" className="quiet-button" onClick={() => void requestClose()}>Done</button></div>
      {frameUrl && <iframe ref={frame} src={frameUrl} title="Offline German voice setup" />}
    </dialog>
  </OfflineVoiceContext.Provider>
}
