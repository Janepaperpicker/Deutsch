import { Router, static as serveStatic } from 'express'
import { rateLimit } from 'express-rate-limit'
import { readFile, stat, mkdir, rename, unlink } from 'node:fs/promises'
import { createReadStream, createWriteStream } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { resolve, join, basename } from 'node:path'
import { tmpdir } from 'node:os'

const types = { entry: 'text/html', page: 'text/javascript', installer: 'text/javascript', 'runtime-client': 'text/javascript', worker: 'text/javascript', 'service-worker': 'text/javascript', runtime: 'text/javascript', 'runtime-wasm': 'application/wasm', 'phonemizer-wasm': 'application/wasm', phonemizer: 'text/javascript', style: 'text/css', config: 'application/json', source: 'application/gzip', notices: 'text/plain', 'build-recipe': 'text/plain', 'model-card': 'text/plain' }
const componentPolicy = "default-src 'self'; script-src 'self' blob: 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self' blob:; style-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'"

export function createOptionalVoiceRouter({ componentDirectory, assetDirectory, cacheDirectory = join(tmpdir(), 'deutsch-voice-releases'), fetchAsset = fetch } = {}) {
 const router = Router(), downloads = new Map(), verified = new Map()
 const manifest = async () => JSON.parse(await readFile(join(assetDirectory ?? componentDirectory, 'release.json'), 'utf8'))
 router.use(rateLimit({ windowMs: 10 * 60 * 1000, limit: 180, standardHeaders: true, legacyHeaders: false }))
 router.use((_req, res, next) => { res.setHeader('Content-Security-Policy', componentPolicy); next() })
 router.get('/release.json', async (_req, res) => {
  try { res.setHeader('Cache-Control', 'no-store'); res.json(await manifest()) }
  catch { res.status(503).json({ error: 'Voice download is unavailable.' }) }
 })
 async function validFile(file, asset) {
  const info = await stat(file)
  if (info.size !== asset.bytes) return false
  const signature = `${info.size}:${info.mtimeMs}:${asset.sha256}`
  if (verified.get(file) === signature) return true
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  if (hash.digest('hex') !== asset.sha256) return false
  verified.set(file, signature)
  return true
 }
 async function ensureRemote(release, asset, filename) {
  const remote = `https://github.com/saintheraldfaust/Deutsch/releases/download/deutsch-voice-${release.version}/${filename}`
  const directory = join(cacheDirectory, release.version), target = join(directory, filename)
  try { if (await validFile(target, asset)) return target; await unlink(target) } catch { /* Download the fixed release artifact. */ }
  const key = `${release.version}/${filename}`
  if (!downloads.has(key)) downloads.set(key, (async () => {
   await mkdir(directory, { recursive: true })
   const temporary = `${target}.${randomUUID()}.part`
   try {
    const response = await fetchAsset(remote, { signal: AbortSignal.timeout(180_000) })
    if (!response.ok || !response.body) throw new Error('Release asset unavailable')
    const hash = createHash('sha256'); let bytes = 0
    const check = new Transform({ transform(chunk, _encoding, callback) {
     bytes += chunk.length
     if (bytes > asset.bytes) { callback(new Error('Release size mismatch')); return }
     hash.update(chunk); callback(null, chunk)
    } })
    await pipeline(Readable.fromWeb(response.body), check, createWriteStream(temporary, { flags: 'wx' }))
    if (bytes !== asset.bytes || hash.digest('hex') !== asset.sha256) throw new Error('Release integrity mismatch')
    await rename(temporary, target)
    return target
   } catch (error) { await unlink(temporary).catch(() => {}); throw error }
  })().finally(() => downloads.delete(key)))
  return downloads.get(key)
 }
 router.get('/releases/:version/:filename', async (req, res) => {
  try {
   const release = await manifest()
   if (!release.enabled || !/^[a-z0-9][a-z0-9.-]{0,63}$/.test(release.version) || req.params.version !== release.version || !/^[a-zA-Z0-9_.-]+$/.test(req.params.filename)) return res.status(404).end()
   const requested = `/optional-voice/releases/${release.version}/${req.params.filename}`
   const asset = release.assets.find((item) => item.path === requested)
   if (!asset || !Number.isSafeInteger(asset.bytes) || asset.bytes < 1 || asset.bytes > 200 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(asset.sha256)) return res.status(404).end()
   const filename = basename(asset.path)
   const file = assetDirectory ? resolve(assetDirectory, filename) : await ensureRemote(release, asset, filename)
   if (!await validFile(file, asset)) throw new Error('Release integrity mismatch')
   res.setHeader('Content-Type', types[asset.role] ?? 'application/octet-stream')
   res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
   res.sendFile(file, (error) => { if (error && !res.headersSent) res.status(503).end() })
  } catch { if (!res.headersSent) res.status(503).json({ error: 'Voice download failed. Try again.' }) }
 })
 router.use(serveStatic(componentDirectory, { setHeaders: (res, path) => {
  if (path.endsWith('/sw.js')) { res.setHeader('Cache-Control', 'no-cache'); res.setHeader('Service-Worker-Allowed', '/optional-voice/') }
 } }))
 router.use((_req, res) => res.status(404).end())
 return router
}
