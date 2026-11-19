// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Deutsch Daily Deck contributors
export function createOfflineSynthesizer(installation) {
  let worker, workerUrl, preparing, sequence = 0, generation = 0
  const pending = new Map()
  const stop = () => {
    generation += 1
    worker?.terminate()
    worker = null
    preparing = null
    if (workerUrl) URL.revokeObjectURL(workerUrl)
    workerUrl = null
    for (const request of pending.values()) {
      clearTimeout(request.timeout)
      request.reject(new DOMException('Speech stopped.', 'AbortError'))
    }
    pending.clear()
  }
  const request = (payload, transfer = [], timeoutMs = 45_000) => new Promise((resolve, reject) => {
    const id = ++sequence
    const timeout = setTimeout(() => { reject(new Error('Offline speech took too long. Try again.')); stop() }, timeoutMs)
    pending.set(id, { resolve, reject, timeout })
    try { worker.postMessage({ ...payload, id }, transfer) }
    catch (error) { clearTimeout(timeout); pending.delete(id); reject(error) }
  })
  const prepare = () => {
    if (preparing) return preparing
    const ticket = generation
    preparing = (async () => {
      const source = await installation.readAsset('worker')
      if (ticket !== generation) throw new DOMException('Speech stopped.', 'AbortError')
      workerUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
      worker = new Worker(workerUrl)
      worker.onmessage = ({ data }) => {
        const waiting = pending.get(data.id)
        if (!waiting) return
        pending.delete(data.id)
        clearTimeout(waiting.timeout)
        if (data.error) waiting.reject(new Error(data.error))
        else waiting.resolve(data)
      }
      worker.onerror = () => {
        if (ticket !== generation) return
        for (const waiting of pending.values()) waiting.reject(new Error('Offline speech could not start. Try again.'))
        stop()
      }
      const assets = {}
      for (const role of ['runtime', 'runtime-wasm', 'phonemizer', 'phonemizer-wasm', 'phonemizer-data', 'config', 'model']) {
        assets[role] = await installation.readAsset(role)
        if (ticket !== generation) throw new DOMException('Speech stopped.', 'AbortError')
      }
      await request({ type: 'init', assets }, Object.values(assets))
    })().catch((error) => { if (ticket === generation) stop(); throw error })
    return preparing
  }
  return {
    async synthesize(text) {
      if (typeof text !== 'string' || !text.trim() || text.length > 500) throw new Error('Choose a word or a short phrase.')
      const ticket = generation
      await prepare()
      if (ticket !== generation) throw new DOMException('Speech stopped.', 'AbortError')
      return request({ type: 'speak', text }, [], 30_000)
    },
    stop,
  }
}
