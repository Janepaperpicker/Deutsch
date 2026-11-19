import { useEffect, useRef, useState } from 'react'
import { AudioLines } from 'lucide-react'
import type { Card } from './deckImport'
import { getRecording, loadPronunciations, type Recording } from './pronunciation'
import { selectGermanVoice } from './germanVoices'
import { useOfflineVoice } from './offlineVoiceContext'

export function WordAudio({ card }: { card: Card }) {
  const [message, setMessage] = useState<string | null>(null)
  const [catalogue, setCatalogue] = useState<Record<string, Recording>>()
  const [voice, setVoice] = useState<SpeechSynthesisVoice>()
  const [voicesReady, setVoicesReady] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [playbackSource, setPlaybackSource] = useState<'recording' | 'device' | 'downloaded' | null>(null)
  const offlineVoice = useOfflineVoice()
  const stopOfflineVoice = offlineVoice?.stop
  const recordingRef = useRef<HTMLAudioElement | null>(null)
  const operation = useRef(0)
  const recording = getRecording(card, catalogue)

  useEffect(() => {
    let current = true
    loadPronunciations().then((data) => { if (current) setCatalogue(data) }).catch(() => {})
    return () => { current = false }
  }, [])

  useEffect(() => {
    if (!('speechSynthesis' in window)) return
    const update = () => {
      const voices = window.speechSynthesis.getVoices()
      setVoice(selectGermanVoice(voices))
      if (voices.length) setVoicesReady(true)
    }
    queueMicrotask(update)
    window.speechSynthesis.addEventListener('voiceschanged', update)
    const timeout = window.setTimeout(() => setVoicesReady(true), 1500)
    return () => { window.clearTimeout(timeout); window.speechSynthesis.removeEventListener('voiceschanged', update) }
  }, [])

  useEffect(() => {
    const ticket = ++operation.current
    queueMicrotask(() => { if (ticket === operation.current) { setPlaying(false); setMessage(null); setPlaybackSource(null) } })
    return () => {
      operation.current += 1
      recordingRef.current?.pause()
      recordingRef.current = null
      stopOfflineVoice?.()
      if ('speechSynthesis' in window) window.speechSynthesis.cancel()
    }
  }, [card.id, card.prompt, stopOfflineVoice])

  const stop = () => {
    operation.current += 1
    recordingRef.current?.pause()
    stopOfflineVoice?.()
    if ('speechSynthesis' in window) window.speechSynthesis.cancel()
    setPlaying(false)
    setMessage(null)
  }

  const speak = (online = false) => {
    const selected = selectGermanVoice(window.speechSynthesis?.getVoices() ?? [])
    if (!selected || typeof SpeechSynthesisUtterance === 'undefined') {
      setMessage(voicesReady ? 'No German voice is available on this device.' : 'German voices are still loading. Try Listen again.')
      return
    }
    if (!selected.localService && !online) {
      setMessage('An online browser voice is available. It receives the word when you choose Use online voice.')
      return
    }
    setVoice(selected)
    setPlaybackSource('device')
    const ticket = ++operation.current
    window.speechSynthesis.cancel()
    const utterance = new SpeechSynthesisUtterance(card.prompt)
    utterance.lang = selected.lang
    utterance.voice = selected
    utterance.onstart = () => { if (ticket === operation.current) setPlaying(true) }
    utterance.onend = () => { if (ticket === operation.current) { setPlaying(false); setMessage(null) } }
    utterance.onerror = (event) => {
      if (ticket === operation.current) { setPlaying(false); if (event.error !== 'interrupted' && event.error !== 'canceled') setMessage('Pronunciation could not play. Try again.') }
    }
    setMessage(selected.localService ? 'Local German voice.' : 'Online browser voice.')
    window.speechSynthesis.speak(utterance)
  }

  const play = async () => {
    if (playing) { stop(); return }
    const ticket = ++operation.current
    stopOfflineVoice?.()
    let selected = recording
    if (!selected && !catalogue) {
      setMessage('Loading pronunciation…')
      try { const data = await loadPronunciations(); if (ticket !== operation.current) return; setCatalogue(data); selected = getRecording(card, data) } catch { /* Local speech remains available. */ }
    }
    if (ticket !== operation.current) return
    if (!selected) { speak(); return }
    recordingRef.current?.pause()
    if ('speechSynthesis' in window) window.speechSynthesis.cancel()
    const audio = new Audio(selected.url)
    audio.preload = 'none'
    recordingRef.current = audio
    let failed = false
    const fallback = () => {
      if (ticket !== operation.current || failed) return
      failed = true
      setPlaying(false)
      const local = selectGermanVoice(window.speechSynthesis?.getVoices() ?? [])
      if (local?.localService) speak()
      else setMessage('The recording could not play. Try again or use an available German voice.')
    }
    audio.onerror = fallback
    audio.onplaying = () => { if (ticket === operation.current) { setPlaybackSource('recording'); setPlaying(true); setMessage(null) } }
    audio.onended = () => { if (ticket === operation.current) setPlaying(false) }
    audio.play().catch(fallback)
  }

  const playOffline = async () => {
    if (!offlineVoice) return
    stop()
    if (!offlineVoice.installed) { offlineVoice.open(card.prompt); return }
    const ticket = ++operation.current
    setPlaybackSource('downloaded')
    setPlaying(true)
    setMessage('Preparing offline voice…')
    try {
      await offlineVoice.speak(card.prompt, () => { if (ticket === operation.current) setMessage(null) })
      if (ticket === operation.current) { setPlaying(false); setMessage(null) }
    } catch (error) {
      if (ticket === operation.current) {
        setPlaying(false)
        setMessage(error instanceof Error && error.name !== 'AbortError' ? error.message : null)
      }
    }
  }

  return (
    <div className="pronunciation">
      <div className="pronunciation-controls">
      <button type="button" className="quiet-button pronunciation-button" onClick={() => void play()} aria-label={playing ? 'Stop pronunciation' : `Hear ${card.prompt}`} title="Open recordings load from Wikimedia Commons; local German speech is used when available."><AudioLines size={16} aria-hidden="true" /> {playing ? 'Stop' : 'Listen'}</button>
      {offlineVoice && <button type="button" className="quiet-button pronunciation-button" onClick={() => void playOffline()}>{offlineVoice.installed ? 'Listen offline' : 'Offline voice'}</button>}
      </div>
      {recording && playbackSource !== 'device' && playbackSource !== 'downloaded' && <p className="pronunciation-credit">Word audio: <a href={recording.source} target="_blank" rel="noreferrer">{recording.author} / Wikimedia Commons</a> · <a href={recording.licenseUrl ?? 'https://creativecommons.org/licenses/by-sa/3.0/'} target="_blank" rel="noreferrer">{recording.license ?? 'CC BY-SA 3.0'}</a> · {recording.url.endsWith('.mp3') ? 'MP3 conversion' : 'unchanged'}</p>}
      {playbackSource === 'downloaded' && <p className="pronunciation-credit">Synthesized voice: Thorsten · <button type="button" className="pronunciation-source" onClick={() => offlineVoice?.open(card.prompt)}>Source and setup</button></p>}
      {message && <p className="pronunciation-message" role="status">{message}</p>}
      {message && voice && !voice.localService && <button type="button" className="quiet-button" onClick={() => speak(true)}>Use online voice</button>}
    </div>
  )
}
