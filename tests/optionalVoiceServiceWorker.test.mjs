import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'

const code = await readFile(new URL('../optional/german-voice/sw.js', import.meta.url), 'utf8')
const origin = 'https://deutsch.example'
const path = '/optional-voice/releases/v1/index.html'
function dispatch(pathname, { complete = true, cacheMode = 'default' } = {}) {
  let handler, response, network = 0
  vm.runInNewContext(code, {
    URL,
    self: { location: { origin }, addEventListener: (name, callback) => { if (name === 'fetch') handler = callback } },
    caches: {
      keys: async () => ['deutsch-shell-v4', 'deutsch-optional-voice-thorsten-medium-v1'],
      open: async () => ({ match: async (key) => {
        if (String(key) === `${origin}/optional-voice/installation-complete`) return complete ? new Response('complete') : undefined
        if (String(key) === `${origin}${path}`) return new Response('installed page')
      } }),
    },
    fetch: async () => { network += 1; throw new Error('Offline') },
  })
  handler({ request: { method: 'GET', url: `${origin}${pathname}`, cache: cacheMode }, respondWith: (value) => { response = value } })
  return { result: response, network: () => network }
}

test('a fresh offline preview navigation uses the installed page without HTTP cache', async () => {
  const request = dispatch(`${path}?preview=1`)
  assert.equal(await (await request.result).text(), 'installed page')
  assert.equal(request.network(), 0)
})
test('incomplete installations are not served, and explicit downloads bypass the voice worker', async () => {
  await assert.rejects(dispatch(path, { complete: false }).result, /Offline/)
  assert.equal(dispatch(path, { cacheMode: 'no-store' }).result, undefined)
  assert.equal(dispatch('/api/companions').result, undefined)
})
