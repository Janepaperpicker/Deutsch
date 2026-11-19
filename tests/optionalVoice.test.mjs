import { test } from 'node:test'
import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createVoiceInstallation, validateRelease, checkDevice, requiredRoles, downloadAssets } from '../optional/german-voice/installation.mjs'

const origin = 'https://deutsch.example'
const roles = requiredRoles
const body = new TextEncoder().encode('fixture only')
const hash = Buffer.from(await webcrypto.subtle.digest('SHA-256', body)).toString('hex')
const manifest = () => ({ schema: 1, id: 'thorsten-medium', version: 'test-1', enabled: true,
  review: { correspondingSource: true, licenses: true, coldStartOffline: true, ios: true, android: true },
  assets: roles.map((role) => ({ role, path: `/optional-voice/releases/test-1/${role}`, bytes: body.length, sha256: hash })),
})
function fixture(release = manifest()) {
  const storage = new Map()
  const calls = []
  let lock = Promise.resolve()
  const environment = {
    isSecureContext: true, crypto: webcrypto, WebAssembly, AbortSignal, Worker: class {}, AudioContext: class {},
    navigator: {
      serviceWorker: { register: () => {} },
      storage: { estimate: async () => ({ quota: 1e9, usage: 0 }) },
      locks: { request: (_name, options, action) => {
        const next = lock.then(() => { options.signal?.throwIfAborted(); return action() })
        lock = next.catch(() => {})
        return next
      } },
    },
    fetch: async (url, options) => { calls.push({ url, options }); return new Response(body) },
    caches: {
      has: async (name) => storage.has(name), keys: async () => [...storage.keys()], delete: async (name) => storage.delete(name),
      open: async (name) => {
        if (!storage.has(name)) storage.set(name, new Map())
        const cache = storage.get(name)
        return { keys: async () => [...cache.keys()].map((url) => ({ url })), match: async (key) => cache.get(key)?.clone(), put: async (key, value) => cache.set(key, value.clone()) }
      },
    },
  }
  return { environment, calls, storage, installer: createVoiceInstallation({ release, origin, environment }) }
}
test('checked-in preview cannot install as stable or bypass missing device review', async () => {
  const release = JSON.parse(await readFile(new URL('../optional/german-voice/release.json', import.meta.url)))
  const { installer, calls } = fixture(release)
  await assert.rejects(installer.install({ consent: true }), /not ready/)
  assert.equal(calls.length, 0)
  assert.equal(release.channel, 'preview')
  assert.equal(release.review.ios, false)
  assert.equal(release.review.android, false)
  assert.ok(validateRelease(release, origin, { allowPreview: true }).bytes > 0)
  for (const key of Object.keys(manifest().review)) {
    const release = manifest(); release.review[key] = false
    assert.throws(() => validateRelease(release, origin), /not ready/)
  }
})
test('release rejects off-origin, mutable paths, missing source and invalid integrity metadata', () => {
  for (const change of [
    (r) => { r.assets[0].path = 'https://elsewhere.example/model' },
    (r) => { r.assets[0].path = '/optional-voice/releases/main/model' },
    (r) => { r.assets[0].sha256 = 'unverified' },
    (r) => { r.assets[0].bytes = 250 * 1024 * 1024 },
    (r) => { r.assets.pop() },
    (r) => { r.assets[0].role = 'source' },
  ]) { const release = manifest(); change(release); assert.throws(() => validateRelease(release, origin)) }
})
test('installation is explicit, complete and readable offline without another fetch', async () => {
  const { installer, calls, environment } = fixture()
  assert.equal(await installer.status(), 'absent')
  await assert.rejects(installer.install(), /Confirm/)
  assert.equal(calls.length, 0)
  const progress = []
  await installer.install({ consent: true, onProgress: (value) => progress.push(value) })
  assert.equal(await installer.status(), 'installed')
  assert.equal(calls.length, downloadAssets(manifest()).length)
  assert.ok(calls.every(({ url }) => !url.endsWith('/source') && !url.endsWith('/build-recipe')))
  assert.equal(progress.at(-1).received, progress.at(-1).total)
  assert.ok(calls.every(({ options }) => options.credentials === 'omit' && options.redirect === 'error'))
  environment.fetch = () => { throw new Error('offline') }
  assert.deepEqual(new Uint8Array(await installer.readAsset('model')), body)
  await installer.install({ consent: true })
})
test('partial, corrupt and oversized downloads roll back and can retry', async () => {
  for (const invalidBody of ['wrong digest', 'too long for this manifest fixture', 'short']) {
    const { environment, installer } = fixture()
    environment.fetch = async () => new Response(invalidBody)
    await assert.rejects(installer.install({ consent: true }))
    assert.equal(await installer.status(), 'absent')
    environment.fetch = async () => new Response(body)
    await installer.install({ consent: true })
    assert.equal(await installer.status(), 'installed')
  }
})
test('cancellation and insufficient space do not leave a voice installed', async () => {
  const { environment, installer, calls } = fixture()
  environment.navigator.storage.estimate = async () => ({ quota: 1, usage: 0 })
  await assert.rejects(installer.install({ consent: true }), /storage/)
  assert.equal(calls.length, 0)
  environment.navigator.storage.estimate = async () => ({ quota: 1e9, usage: 0 })
  const abort = new AbortController()
  await assert.rejects(installer.install({ consent: true, signal: abort.signal, onProgress: () => abort.abort() }))
  assert.equal(await installer.status(), 'absent')
})
test('eviction and corruption are detected; removal leaves unrelated app caches alone', async () => {
  const { installer, storage } = fixture()
  storage.set('deutsch-app', new Map())
  await installer.install({ consent: true })
  const installed = [...storage].find(([key]) => key.startsWith('deutsch-optional-voice-'))[1]
  const model = `${origin}/optional-voice/releases/test-1/model`
  installed.set(model, new Response('corrupt'))
  await assert.rejects(installer.readAsset('model'), /integrity/)
  installed.delete(model)
  assert.equal(await installer.status(), 'incomplete')
  await assert.rejects(installer.readAsset('model'), /again/)
  await installer.remove()
  assert.equal(await installer.status(), 'absent')
  assert.ok(storage.has('deutsch-app'))
  assert.equal(checkDevice({}).supported, false)
})
test('different installer instances serialize downloads instead of deleting each other', async () => {
  const { installer, environment, calls } = fixture()
  const other = createVoiceInstallation({ release: manifest(), origin, environment })
  await Promise.all([installer.install({ consent: true }), other.install({ consent: true })])
  assert.equal(calls.length, downloadAssets(manifest()).length)
  assert.equal(await other.status(), 'installed')
})

test('a preview needs explicit opt-in and never bypasses source/license/offline checks', () => {
 const release={...manifest(),channel:'preview',review:{...manifest().review,ios:false,android:false}}
 assert.throws(()=>validateRelease(release,origin),/not ready/)
 assert.ok(validateRelease(release,origin,{allowPreview:true}).bytes>0)
 for(const key of ['correspondingSource','licenses','coldStartOffline']) assert.throws(()=>validateRelease({...release,review:{...release.review,[key]:false}},origin,{allowPreview:true}),/not ready/)
 assert.throws(()=>validateRelease({...release,enabled:false},origin,{allowPreview:true}),/not ready/)
})
test('cached code preserves its MIME/CSP headers without stale transfer encoding', async () => {
 const {installer,environment,storage}=fixture()
 environment.fetch=async()=>new Response(body,{headers:{'content-type':'text/javascript','content-security-policy':"default-src 'self'",'content-encoding':'gzip'}})
 await installer.install({consent:true})
 const saved=[...storage.values()][0].get(`${origin}/optional-voice/releases/test-1/runtime`)
 assert.equal(saved.headers.get('content-type'),'text/javascript')
 assert.equal(saved.headers.get('content-security-policy'),"default-src 'self'")
 assert.equal(saved.headers.get('content-encoding'),null)
})
