import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mock } from 'node:test'
import session from 'express-session'
import { ObjectId } from 'mongodb'
import bcrypt from 'bcryptjs'
import { io } from 'socket.io-client'

const get = (object, path) => path.split('.').reduce((value, part) => value?.[part], object)
const set = (object, path, value) => {
  const parts = path.split('.')
  const last = parts.pop()
  const parent = parts.reduce((value, part) => value[part] ??= {}, object)
  parent[last] = value
}
const unset = (object, path) => {
  const parts = path.split('.')
  const last = parts.pop()
  const parent = parts.reduce((value, part) => value?.[part], object)
  if (parent) delete parent[last]
}
const matches = (object, query) => Object.entries(query).every(([key, expected]) => {
  if (key === '$or') return expected.some((part) => matches(object, part))
  if (key === '$and') return expected.every((part) => matches(object, part))
  const actual = get(object, key)
  if (expected instanceof ObjectId) return actual?.toString() === expected.toString()
  if (expected && typeof expected === 'object' && !(expected instanceof Date)) {
    return Object.entries(expected).every(([operator, value]) => {
      if (operator === '$exists') return (actual !== undefined) === value
      if (operator === '$lte') return actual !== undefined && actual <= value
      if (operator === '$gte') return actual !== undefined && actual >= value
      if (operator === '$lt') return actual !== undefined && actual < value
      if (operator === '$gt') return actual !== undefined && actual > value
      if (operator === '$ne') return Array.isArray(actual) ? !actual.includes(value) : actual !== value
      if (operator === '$in') return Array.isArray(actual) ? actual.some((item) => value.includes(item))
        : actual instanceof ObjectId ? value.some((item) => item instanceof ObjectId && item.toString() === actual.toString())
        : value.includes(actual)
      throw new Error(`Unknown operator ${operator}`)
    })
  }
  if (expected instanceof Date) return actual instanceof Date && actual.getTime() === expected.getTime()
  if (Array.isArray(expected)) return Array.isArray(actual) && JSON.stringify(actual) === JSON.stringify(expected)
  return Array.isArray(actual) ? actual.includes(expected) : actual === expected
})
const records = {
  users: [], progress: [], relationships: [], sharedWords: [],
  companionConversations: [], companionMessages: [], companionReports: [],
  practiceSessions: [],
  groups: [], groupMembers: [], groupMessages: [], groupReports: [], chatTyping: [],
}
const applyUpdate = (record, update) => {
  for (const [path, value] of Object.entries(update.$set ?? {})) set(record, path, value)
  for (const [path, value] of Object.entries(update.$inc ?? {})) set(record, path, (get(record, path) ?? 0) + value)
  for (const [path, value] of Object.entries(update.$max ?? {})) {
    if (get(record, path) === undefined || get(record, path) < value) set(record, path, value)
  }
  for (const [path, value] of Object.entries(update.$addToSet ?? {})) {
    const current = get(record, path) ?? []
    if (!current.includes(value)) set(record, path, [...current, value])
  }
  for (const [path, value] of Object.entries(update.$push ?? {})) {
    set(record, path, [...value.$each, ...(get(record, path) ?? [])].slice(0, value.$slice))
  }
  for (const path of Object.keys(update.$unset ?? {})) unset(record, path)
}
const collection = (name) => ({
  async createIndex() {},
  async countDocuments(query) {
    return records[name].filter((item) => matches(item, query)).length
  },
  find(query, options = {}) {
    let result = records[name].filter((item) => matches(item, query)).map((item) => ({ ...item }))
    if (options.sort) {
      const entries = Object.entries(options.sort)
      result.sort((left, right) => {
        for (const [field, direction] of entries) {
          const a = get(left, field)
          const b = get(right, field)
          const difference = a instanceof ObjectId && b instanceof ObjectId
            ? a.toString().localeCompare(b.toString())
            : a - b
          if (difference) return direction * difference
        }
        return 0
      })
    }
    if (options.limit) result = result.slice(0, options.limit)
    return { async toArray() { return result } }
  },
  async findOne(query, options = {}) {
    let matchesQuery = records[name].filter((item) => matches(item, query))
    if (options.sort) {
      const entries = Object.entries(options.sort)
      matchesQuery = matchesQuery.sort((left, right) => {
        for (const [field, direction] of entries) {
          const a = get(left, field)
          const b = get(right, field)
          const difference = a instanceof ObjectId && b instanceof ObjectId
            ? a.toString().localeCompare(b.toString())
            : a - b
          if (difference) return direction * difference
        }
        return 0
      })
    }
    const record = matchesQuery[0]
    return record ? { ...record, otp: record.otp ? structuredClone(record.otp) : undefined } : null
  },
  async insertOne(value) {
    if (records[name].some((item) => (value._id && item._id.toString() === value._id.toString())
      || (value.emailKey && item.emailKey === value.emailKey)
      || (value.nameKey && item.nameKey === value.nameKey)
      || (name === 'groups' && item.ownerId === value.ownerId && item.ownerSlot === value.ownerSlot)
      || (name === 'groupMembers' && item.groupId === value.groupId && item.userId === value.userId)
      || (value.usernameKey && item.usernameKey === value.usernameKey)
      || (value.pairKey && item.pairKey === value.pairKey
        && (name !== 'companionConversations' || item.connectionId === value.connectionId))
      || (value.reporterId && item.reporterId === value.reporterId && item.messageId === value.messageId))) {
      throw Object.assign(new Error('duplicate'), { code: 11000 })
    }
    const _id = value._id ?? new ObjectId()
    records[name].push({ ...value, _id })
    return { insertedId: _id }
  },
  async updateOne(query, update, options = {}) {
    const record = records[name].find((item) => matches(item, query))
    if (!record) {
      if (!options.upsert) return { matchedCount: 0, modifiedCount: 0 }
      const inserted = { ...query, _id: new ObjectId() }
      applyUpdate(inserted, update)
      records[name].push(inserted)
      return { matchedCount: 0, modifiedCount: 0, upsertedId: inserted._id }
    }
    if (name === 'groups' && update.$set?.nameKey
      && records.groups.some((item) => item !== record && item.nameKey === update.$set.nameKey)) {
      throw Object.assign(new Error('duplicate'), { code: 11000 })
    }
    applyUpdate(record, update)
    return { matchedCount: 1, modifiedCount: 1 }
  },
  async deleteOne(query) {
    const index = records[name].findIndex((item) => matches(item, query))
    if (index >= 0) records[name].splice(index, 1)
    return { deletedCount: index >= 0 ? 1 : 0 }
  },
  async deleteMany(query) {
    const before = records[name].length
    records[name] = records[name].filter((item) => !matches(item, query))
    return { deletedCount: before - records[name].length }
  },
  async updateMany(query, update) {
    const found = records[name].filter((item) => matches(item, query))
    for (const record of found) applyUpdate(record, update)
    return { matchedCount: found.length, modifiedCount: found.length }
  },
})
class FakeMongoClient {
  async connect() {}
  db() { return { collection, admin: () => ({ command: async () => ({ ok: 1 }) }) } }
}
mock.module('mongodb', { namedExports: { MongoClient: FakeMongoClient, ObjectId } })
mock.module('connect-mongo', { defaultExport: { create: () => new session.MemoryStore() } })
mock.module('dotenv', { defaultExport: { config: () => ({ parsed: {} }) } })

process.env.MONGODB_URI = 'mongodb://test:test@localhost:27017/deutsch'
process.env.SESSION_SECRET = 'test-secret-with-at-least-thirty-two-characters'
process.env.GROUP_MIN_ACCOUNT_AGE_HOURS = '24'
process.env.MAILJET_API_KEY = 'test-key'
process.env.MAILJET_SECRET_KEY = 'test-secret'
process.env.SENDER_EMAIL = 'sender@example.test'
process.env.PORT = '0'
process.env.TRUST_PROXY = '1'
process.env.MODERATOR_USER_IDS = 'aaaaaaaaaaaaaaaaaaaaaaaa'
const deliveries = []
let failCompanionDelivery = false
const nativeFetch = globalThis.fetch
globalThis.fetch = async (url, options) => {
  if (url === 'https://api.mailjet.com/v3.1/send') {
    const message = JSON.parse(options.body).Messages[0]
    assert.equal(message.InlinedAttachments[0].ContentType, 'image/png')
    assert.equal(message.InlinedAttachments[0].ContentID, 'avatar')
    if (failCompanionDelivery && message.Subject.includes('companion request')) {
      return new Response('', { status: 500 })
    }
    deliveries.push(message)
    return new Response(JSON.stringify({ Messages: [{ Status: 'success' }] }), { status: 200 })
  }
  return nativeFetch(url, options)
}

const { server } = await import('../../server/index.js')
if (!server.listening) await once(server, 'listening')
const base = `http://127.0.0.1:${server.address().port}`
const sockets = []
const connectSocket = async (cookie) => {
  const socket = io(base, { transports: ['websocket'], extraHeaders: { cookie }, reconnection: false, timeout: 3000 })
  sockets.push(socket)
  await Promise.race([once(socket, 'connect'), once(socket, 'connect_error').then(([error]) => Promise.reject(error))])
  return socket
}
const currentPracticeBody = (path, body) => {
  const id = path.match(/\/practice\/([a-f0-9]{24})\/(?:answer|decision)$/)?.[1]
  if (!id || !body || Object.hasOwn(body, 'revision')) return body
  const session = records.practiceSessions.find((item) => item._id.toString() === id)
  return { ...body, revision: session?.revision ?? 0 }
}
const socketCall = (socket, event, data) => socket.timeout(3000).emitWithAck(event,
  event === 'command' ? { ...data, body: currentPracticeBody(data.path, data.body) } : data)
  .catch((error) => { throw new Error(`Socket ${event} ${data.path ?? ''}: ${error.message}`) })
const request = async (path, body, cookie) => {
  body = currentPracticeBody(path, body)
  const response = await nativeFetch(`${base}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] }
}
const waitForDelivery = async (count) => {
  for (let i = 0; i < 100 && deliveries.length < count; i++) await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(deliveries.length, count)
  return deliveries.at(-1).TextPart.match(/\b\d{6}\b/)[0]
}

try {
  const email = 'learner@example.test'
  const password = 'correct-password-123'
  const invalidUsername = await request('/api/auth/register', { email, password, username: 'name@example.com', avatarSeed: 'pixel-lime' })
  assert.equal(invalidUsername.status, 400)
  assert.equal(invalidUsername.body.error, 'Username can use only letters, numbers, underscores, or hyphens; it cannot be an email address.')
  assert.equal(deliveries.length, 0)
  const registration = await request('/api/auth/register', { email, password, username: 'learner', avatarSeed: 'pixel-lime' })
  assert.equal(registration.status, 201)
  assert.equal(registration.body.verificationRequired, true)
  const code = await waitForDelivery(1)
  assert.equal((await request('/api/auth/login', { email, password })).status, 403)
  assert.equal((await request('/api/auth/verify', { email, code })).status, 200)
  assert.equal((await request('/api/auth/verify', { email, code })).status, 400)
  const login = await request('/api/auth/login', { email, password })
  assert.equal(login.status, 200)
  assert.equal(login.body.user.emailVerified, true)
  assert.match(login.body.user.id, /^[a-f0-9]{24}$/)
  const secondLogin = await request('/api/auth/login', { email, password })
  assert.equal(secondLogin.status, 200)
  assert.equal((await request('/api/auth/change-password', { currentPassword: password, password: 'new-password-123' }, login.cookie)).status, 200)
  const me = await request('/api/auth/me', null, login.cookie)
  assert.equal(me.status, 200)
  assert.equal(me.body.user.id, login.body.user.id)
  assert.equal((await request('/api/auth/me', null, secondLogin.cookie)).status, 401)
  const absent = await request('/api/auth/code', { email: 'absent@example.test', purpose: 'reset' })
  const requested = await request('/api/auth/code', { email, purpose: 'reset' })
  assert.equal(absent.status, 202)
  assert.equal(requested.status, 202)
  assert.deepEqual(absent.body, requested.body)
  const resetCode = await waitForDelivery(2)
  assert.equal((await request('/api/auth/reset-password', { email, code: resetCode, password: 'reset-password-123' })).status, 200)
  assert.equal((await request('/api/auth/me', null, login.cookie)).status, 401)
  assert.equal((await request('/api/auth/login', { email, password: 'reset-password-123' })).status, 200)
  const legacy = { _id: new ObjectId(), email: 'legacy@example.test', emailKey: 'legacy@example.test', username: 'legacy', usernameKey: 'legacy', emailVerifiedAt: null, avatarSeed: 'pixel-red', passwordHash: await bcrypt.hash(password, 4) }
  records.users.push(legacy)
  const legacyLogin = await request('/api/auth/login', { email: legacy.email, password })
  assert.equal(legacyLogin.status, 200)
  assert.equal(legacyLogin.body.user.emailVerified, false)
  assert.equal((await request('/api/companions/', null, legacyLogin.cookie)).status, 403)

  const companion = {
    _id: new ObjectId(), email: 'companion@example.test', emailKey: 'companion@example.test',
    username: 'Companion', usernameKey: 'companion', avatarSeed: 'pixel-red',
    emailVerifiedAt: new Date(), passwordHash: await bcrypt.hash(password, 4),
  }
  records.users.push(companion)
  const learner = await request('/api/auth/login', { email, password: 'reset-password-123' })
  const other = await request('/api/auth/login', { email: companion.email, password })
  for (let index = 0; index < 301; index++) {
    assert.equal((await request('/api/companions/chats', null, learner.cookie)).status, 200)
  }
  const learnerId = records.users.find((item) => item.email === email)._id.toString()
  const otherId = companion._id.toString()
  const voiceMetadata = await request('/optional-voice/release.json', null, null)
  assert.equal(voiceMetadata.status, 200)
  assert.equal(voiceMetadata.body.id, 'thorsten-medium')
  assert.equal(typeof voiceMetadata.body.enabled, 'boolean')
  // Accepted answer keys survive sync but malformed keys cannot enter progress.
  const aliasCard = {
    id:'alias-check',prompt:'die Wohnung',article:'die',meaning:'apartment',category:'noun',
    pluralUpdatedAt:'2026-01-01T12:00:00.000Z',acceptedAnswers:['das Appartement'],acceptedAnswersUpdatedAt:'2026-01-01T12:00:00.000Z',example:'Die Wohnung ist schön.',translation:'The apartment is nice.',
    tags:['A1'],status:'active',dueAt:'2026-01-01T12:00:00.000Z',intervalDays:0,repetitions:0,easeFactor:2.5,lapses:0,
    lastReviewedAt:null,lastRating:null,correctCount:0,incorrectCount:0,reviewHistory:[],
    createdAt:'2026-01-01T12:00:00.000Z',updatedAt:'2026-01-01T12:00:00.000Z',
  }
  const aliasPayload = {cards:[aliasCard],expectedRevision:0,studyPlan:{currentLevel:'unknown',targetLevel:'B1',targetDate:'2027-01-01',intensity:'steady'}}
  const putAliases = async payload => {
    const response=await nativeFetch(`${base}/api/progress`,{method:'PUT',headers:{cookie:learner.cookie,'content-type':'application/json'},body:JSON.stringify(payload)})
    return response.status
  }
  for (const answers of [['Appartement'],Array(11).fill('das Haus'),['das '+ 'x'.repeat(201)],'das Haus']) {
    assert.equal(await putAliases({...aliasPayload,cards:[{...aliasCard,acceptedAnswers:answers}]}),400)
  }
  assert.equal(await putAliases({...aliasPayload,cards:[{...aliasCard,pluralUpdatedAt:'invalid'}]}),400)
  assert.equal(await putAliases({...aliasPayload,cards:[{...aliasCard,acceptedAnswersUpdatedAt:'invalid'}]}),400)
  assert.equal(await putAliases(aliasPayload),200)
  const savedAliases=(await request('/api/progress',null,learner.cookie)).body.progress.cards[0]
  assert.equal(savedAliases.pluralUpdatedAt,aliasCard.pluralUpdatedAt)
  assert.equal(savedAliases.acceptedAnswersUpdatedAt,aliasCard.acceptedAnswersUpdatedAt)
  assert.deepEqual(savedAliases.acceptedAnswers,['das Appartement'])
  assert.equal(savedAliases.reviewHistory.length,0)
  records.progress=records.progress.filter(item=>item.userId!==learnerId)
  assert.equal((await request('/api/companions/', null, null)).status, 401)
  assert.equal((await request('/api/companions/search', { username: 'legacy' }, learner.cookie)).status, 404)
  assert.equal((await request('/api/companions/request', { id: legacy._id.toString() }, learner.cookie)).status, 404)
  const found = await request('/api/companions/search', { username: 'COMPANION' }, learner.cookie)
  assert.deepEqual(found.body.user, { id: otherId, username: 'Companion', avatarSeed: 'pixel-red' })
  assert.equal((await request('/api/companions/search', { username: 'comp' }, learner.cookie)).status, 404)
  assert.equal((await request('/api/companions/request', { id: otherId }, learner.cookie)).status, 201)
  assert.equal(deliveries.length, 3)
  assert.match(deliveries[2].TextPart, /learner would like/)
  assert.equal((await request('/api/companions/request', { id: otherId }, learner.cookie)).status, 409)
  assert.equal((await request('/api/companions/action', { id: otherId, action: 'accept' }, learner.cookie)).status, 409)
  assert.equal((await request('/api/companions/chats/open', { id: otherId }, learner.cookie)).status, 404)
  assert.equal((await request('/api/companions/', null, other.cookie)).body.companions[0].status, 'incoming')
  assert.equal((await request('/api/companions/action', { id: learnerId, action: 'accept' }, other.cookie)).status, 200)
  assert.equal((await request('/api/companions/', null, learner.cookie)).body.companions[0].status, 'connected')
  const shared = await request('/api/companions/share', {
    recipientId: otherId,
    card: { prompt: 'der Sprachkurs', article: 'der', plural: 'Sprachkurse', meaning: 'language course', example: 'Der Sprachkurs beginnt heute.', translation: 'The language course begins today.', category: 'noun' },
    note: '<A useful word>',
  }, learner.cookie)
  assert.equal(shared.status, 201)
  assert.equal(deliveries.length, 4)
  assert.match(deliveries[3].Subject, /German word/)
  assert.doesNotMatch(deliveries[3].TextPart, /Sprachkurs|useful word/)
  const inbox = await request('/api/companions/', null, other.cookie)
  assert.equal(inbox.body.sharedWords.length, 1)
  assert.equal(inbox.body.sharedWords[0].sender.username, 'learner')
  assert.equal(inbox.body.sharedWords[0].note, '<A useful word>')
  assert.deepEqual(Object.keys(inbox.body.sharedWords[0].card).sort(), ['article', 'category', 'example', 'meaning', 'plural', 'prompt', 'translation'])
  assert.equal((await request(`/api/companions/shares/${shared.body.id}/add`, {}, other.cookie)).status, 200)
  assert.equal((await request('/api/companions/', null, other.cookie)).body.sharedWords.length, 0)
  assert.equal((await request(`/api/companions/shares/${shared.body.id}/add`, {}, other.cookie)).status, 404)
  assert.equal((await request('/api/companions/share', {
    recipientId: otherId,
    card: { prompt: 'lernen', meaning: 'to learn', example: 'Wir lernen Deutsch.', category: 'verb' },
    note: 'x'.repeat(241),
  }, learner.cookie)).status, 400)
  assert.equal((await request('/api/companions/settings', { emailsEnabled: false }, other.cookie)).status, 200)
  const quietShare = await request('/api/companions/share', {
    recipientId: otherId,
    card: { prompt: 'lernen', meaning: 'to learn', example: 'Wir lernen Deutsch.', category: 'verb' },
  }, learner.cookie)
  assert.equal(quietShare.status, 201)
  assert.equal(deliveries.length, 4)
  assert.equal((await request('/api/companions/', null, other.cookie)).body.sharedWords.length, 1)
  assert.equal((await request(`/api/companions/shares/${quietShare.body.id}/dismiss`, {}, other.cookie)).status, 200)
  assert.equal((await request('/api/companions/', null, other.cookie)).body.sharedWords.length, 0)
  assert.equal((await request('/api/companions/settings', { emailsEnabled: true }, other.cookie)).status, 200)
  assert.equal((await request('/api/companions/nudge', { id: otherId }, learner.cookie)).status, 201)
  assert.equal(deliveries.length, 5)
  assert.match(deliveries[4].TextPart, /cheering you on/)
  assert.equal((await request('/api/companions/nudge', { id: otherId }, learner.cookie)).status, 429)
  assert.ok((await request('/api/companions/', null, other.cookie)).body.companions[0].nudgeAt)
  assert.equal((await request('/api/companions/nudge/read', { id: learnerId }, other.cookie)).status, 200)
  assert.equal((await request('/api/companions/', null, other.cookie)).body.companions[0].nudgeAt, undefined)
  const openedChat = await request('/api/companions/chats/open', { id: otherId }, learner.cookie)
  assert.equal(openedChat.status, 200)
  assert.equal((await request('/api/companions/chats/open', { id: learnerId }, other.cookie)).body.id, openedChat.body.id)
  const typingPath = `/api/companions/chats/${openedChat.body.id}/typing`
  const privateMessagesPath = `/api/companions/chats/${openedChat.body.id}/messages`
  const privateLivePath = `/api/companions/chats/${openedChat.body.id}/live`
  assert.equal((await request(privateLivePath, null, learner.cookie)).status, 503)
  assert.equal((await request(privateLivePath)).status, 401)
  assert.equal((await request('/api/companions/chats/000000000000000000000000/live', null, learner.cookie)).status, 404)
  assert.equal((await request(typingPath, { typing: 'yes' }, learner.cookie)).status, 400)
  assert.equal((await request(typingPath, { typing: true }, learner.cookie)).status, 200)
  assert.equal((await request(privateMessagesPath, null, other.cookie)).body.typing, true)
  assert.equal((await request(privateMessagesPath, null, learner.cookie)).body.typing, false)
  records.chatTyping.find((item) => item.kind === 'private').expiresAt = new Date(0)
  assert.equal((await request(privateMessagesPath, null, other.cookie)).body.typing, false)
  assert.equal((await request(typingPath, { typing: true }, learner.cookie)).status, 200)
  assert.equal((await request(typingPath, { typing: false }, learner.cookie)).status, 200)
  assert.equal((await request(privateMessagesPath, null, other.cookie)).body.typing, false)
  assert.equal((await request(`/api/companions/chats/${openedChat.body.id}/messages`, { text: '   ' }, learner.cookie)).status, 400)
  const privateClientId = new ObjectId().toString()
  const sentMessage = await request(privateMessagesPath, { text: '  Viel Erfolg beim Lernen!  ', clientId: privateClientId }, learner.cookie)
  assert.equal(sentMessage.status, 201)
  assert.equal(sentMessage.body.message.id, privateClientId)
  assert.equal(sentMessage.body.message.text, 'Viel Erfolg beim Lernen!')
  assert.equal(sentMessage.body.message.receipt, 'sent')
  const retriedPrivate = await request(privateMessagesPath, { text: 'Viel Erfolg beim Lernen!', clientId: privateClientId }, learner.cookie)
  assert.equal(retriedPrivate.status, 200)
  assert.equal(retriedPrivate.body.message.id, privateClientId)
  assert.equal((await request(privateMessagesPath, { text: 'Different content', clientId: privateClientId }, learner.cookie)).status, 409)
  assert.equal((await request(privateMessagesPath, { text: 'Viel Erfolg beim Lernen!', clientId: privateClientId }, other.cookie)).status, 409)
  assert.equal(records.companionMessages.filter((message) => message._id.toString() === privateClientId).length, 1)
  assert.equal((await request(`/api/companions/chats/${openedChat.body.id}/messages`, { text: 'x'.repeat(2001) }, learner.cookie)).status, 400)
  records.users.find((item) => item.email === email).companionMessageHistory = Array.from({ length: 60 }, () => new Date())
  assert.equal((await request(`/api/companions/chats/${openedChat.body.id}/messages`, { text: 'Rate limit check.' }, learner.cookie)).status, 429)
  records.users.find((item) => item.email === email).companionMessageHistory = []
  const receivedMessages = await request(`/api/companions/chats/${openedChat.body.id}/messages`, null, other.cookie)
  assert.equal(receivedMessages.body.messages.length, 1)
  assert.equal(receivedMessages.body.messages[0].isMine, false)
  assert.equal(receivedMessages.body.messages[0].receipt, undefined)
  const privateDelivered = `/api/companions/chats/${openedChat.body.id}/delivered`
  assert.equal((await request(privateDelivered, { id: privateClientId, ids: Array(51).fill(privateClientId) }, other.cookie)).status, 400)
  assert.equal((await request(privateDelivered, { id: privateClientId }, learner.cookie)).status, 404)
  assert.equal((await request(privateDelivered, { id: privateClientId }, other.cookie)).status, 200)
  assert.equal((await request(`${privateMessagesPath}?read=0`, null, learner.cookie)).body.messages[0].receipt, 'delivered')
  assert.equal((await request(`/api/companions/chats/${openedChat.body.id}/read`, { id: privateClientId }, other.cookie)).status, 200)
  assert.equal((await request(`${privateMessagesPath}?read=0`, null, learner.cookie)).body.messages[0].receipt, 'read')
  assert.equal((await request(privateDelivered, { id: privateClientId }, other.cookie)).status, 200)
  assert.equal((await request(`${privateMessagesPath}?read=0`, null, learner.cookie)).body.messages[0].receipt, 'read')
  const unreadChat = (await request('/api/companions/chats', null, learner.cookie)).body.chats[0]
  assert.equal(unreadChat.lastMessage.text, 'Viel Erfolg beim Lernen!')
  assert.equal(unreadChat.unread, false)
  const report = await request(`/api/companions/messages/${sentMessage.body.message.id}/report`, {
    reason: 'other', details: 'This is a test report.',
  }, other.cookie)
  assert.equal(report.status, 201)
  assert.equal((await request(`/api/companions/messages/${sentMessage.body.message.id}/report`, { reason: 'spam' }, other.cookie)).status, 409)
  assert.equal((await request(`/api/companions/messages/${sentMessage.body.message.id}/report`, { reason: 'spam' }, learner.cookie)).status, 404)
  assert.equal(records.companionReports[0].reportedUserId, learnerId)
  const reply = await request(`/api/companions/chats/${openedChat.body.id}/messages`, { text: 'Danke!' }, other.cookie)
  assert.equal(reply.status, 201)
  assert.equal((await request('/api/companions/chats', null, learner.cookie)).body.chats[0].unread, true)
  assert.equal((await request('/api/companions/chats', null, learner.cookie)).body.chats[0].unreadCount, 1)
  assert.equal((await request('/api/companions/unread', null, learner.cookie)).body.count, 1)
  assert.equal((await request('/api/companions/unread', null, other.cookie)).body.count, 0)
  const messagesPath = `/api/companions/chats/${openedChat.body.id}/messages`
  const readPath = `/api/companions/chats/${openedChat.body.id}/read`
  const privateReadRecord = records.companionConversations.find((item) => item._id.toString() === openedChat.body.id)
  const originalRead = privateReadRecord.readAt[learnerId]
  const originalReadThrough = privateReadRecord.readThrough[learnerId]
  assert.equal((await request(`${messagesPath}?read=0`, null, learner.cookie)).status, 200)
  assert.equal((await request('/api/companions/unread', null, learner.cookie)).body.count, 1)
  assert.equal((await request(readPath, { id: 'invalid' }, learner.cookie)).status, 400)
  assert.equal((await request(readPath, { id: new ObjectId().toString() }, learner.cookie)).status, 404)
  assert.equal((await request(readPath, { id: reply.body.message.id }, learner.cookie)).status, 200)
  assert.equal((await request('/api/companions/unread', null, learner.cookie)).body.count, 0)
  const latestRead = privateReadRecord.readAt[learnerId]
  const latestReadThrough = privateReadRecord.readThrough[learnerId]
  await request(readPath, { id: sentMessage.body.message.id }, learner.cookie)
  assert.equal(privateReadRecord.readAt[learnerId].getTime(), latestRead.getTime())
  assert.equal(privateReadRecord.readThrough[learnerId], latestReadThrough)
  privateReadRecord.readAt[learnerId] = new Date(Date.parse(reply.body.message.createdAt) + 1000)
  privateReadRecord.readThrough[learnerId] = `${sentMessage.body.message.createdAt}/${sentMessage.body.message.id}`
  assert.equal((await request('/api/companions/unread', null, learner.cookie)).body.count, 0)
  privateReadRecord.readAt[learnerId] = originalRead
  privateReadRecord.readThrough[learnerId] = originalReadThrough
  const wordCard = { prompt: 'die Lektion', article: 'die', meaning: 'lesson', example: 'Die Lektion ist kurz.', category: 'noun' }
  const wordMessage = await request(messagesPath, { card: wordCard }, learner.cookie)
  assert.equal(wordMessage.status, 201)
  assert.equal(wordMessage.body.message.kind, 'word')
  assert.equal(wordMessage.body.message.text, 'Shared a word: die Lektion')
  assert.deepEqual(wordMessage.body.message.card, wordCard)
  assert.equal((await request(messagesPath, { card: wordCard, text: 'Both' }, learner.cookie)).status, 400)
  assert.equal((await request(messagesPath, { card: { ...wordCard, article: undefined } }, learner.cookie)).status, 400)
  assert.equal((await request('/api/companions/chats', null, other.cookie)).body.chats[0].lastMessage.text, 'Shared a word: die Lektion')
  const threaded = await request(messagesPath, { text: 'Gern!', replyToId: reply.body.message.id }, learner.cookie)
  assert.equal(threaded.status, 201)
  assert.deepEqual(threaded.body.message.replyTo, { id: reply.body.message.id, isMine: false, text: 'Danke!' })
  assert.equal((await request(messagesPath, { text: 'Lost', replyToId: new ObjectId().toString() }, learner.cookie)).status, 400)
  const reactionPath = `/api/companions/messages/${threaded.body.message.id}/reaction`
  assert.equal((await request(reactionPath, { emoji: '😈' }, other.cookie)).status, 400)
  assert.deepEqual((await request(reactionPath, { emoji: '🎉' }, other.cookie)).body.reactions, [{ emoji: '🎉', count: 1, mine: true }])
  assert.deepEqual((await request(reactionPath, { emoji: '💡' }, other.cookie)).body.reactions, [{ emoji: '💡', count: 1, mine: true }])
  assert.deepEqual((await request(reactionPath, { emoji: '💡' }, learner.cookie)).body.reactions, [{ emoji: '💡', count: 2, mine: true }])
  const reacted = (await request(messagesPath, null, learner.cookie)).body.messages.find((item) => item.id === threaded.body.message.id)
  assert.deepEqual(reacted.reactions, [{ emoji: '💡', count: 2, mine: true }])
  assert.deepEqual((await request(reactionPath, { emoji: null }, other.cookie)).body.reactions, [{ emoji: '💡', count: 1, mine: false }])
  assert.equal((await request(`/api/companions/messages/${new ObjectId().toString()}/reaction`, { emoji: '👍' }, other.cookie)).status, 404)
  const correctionPath = `/api/companions/messages/${reply.body.message.id}/correction`
  assert.equal((await request(correctionPath, { text: '   ' }, learner.cookie)).status, 400)
  assert.equal((await request(correctionPath, { text: 'Danke!' }, learner.cookie)).status, 400)
  assert.equal((await request(correctionPath, { text: 'Danke schön!' }, other.cookie)).status, 404)
  assert.equal((await request(`/api/companions/messages/${wordMessage.body.message.id}/correction`, { text: 'Die Lektionen' }, other.cookie)).status, 404)
  const suggested = await request(correctionPath, { text: 'Danke schön!', note: 'A friendlier closing.' }, learner.cookie)
  assert.equal(suggested.status, 201)
  assert.deepEqual(
    { text: suggested.body.message.correction.text, note: suggested.body.message.correction.note, byMe: suggested.body.message.correction.byMe },
    { text: 'Danke schön!', note: 'A friendlier closing.', byMe: true },
  )
  assert.equal((await request(correctionPath, { text: 'Vielen Dank!' }, learner.cookie)).status, 409)
  const authorView = (await request(messagesPath, null, other.cookie)).body.messages.find((item) => item.id === reply.body.message.id)
  assert.equal(authorView.text, 'Danke!')
  assert.equal(authorView.correction.byMe, false)
  assert.equal(authorView.correction.response, undefined)
  const respondPath = `${correctionPath}/respond`
  assert.equal((await request(respondPath, { response: 'thanks' }, learner.cookie)).status, 404)
  assert.equal((await request(respondPath, { response: 'maybe' }, other.cookie)).status, 400)
  assert.equal((await request(respondPath, { response: 'thanks' }, other.cookie)).body.message.correction.response, 'thanks')
  assert.equal((await request(respondPath, { response: 'saved' }, other.cookie)).body.message.correction.response, 'saved')
  assert.equal((await request(respondPath, { response: 'thanks' }, other.cookie)).body.message.correction.response, 'saved')
  const correctorView = (await request(messagesPath, null, learner.cookie)).body.messages.find((item) => item.id === reply.body.message.id)
  assert.equal(correctorView.correction.response, 'saved')
  const cheer = await request(messagesPath, { text: 'Super!' }, other.cookie)
  const cheerPath = `/api/companions/messages/${cheer.body.message.id}/correction`
  assert.equal((await request(cheerPath, { approve: true, text: 'Super!!' }, learner.cookie)).status, 400)
  assert.equal((await request(cheerPath, { approve: true, note: 'Nice' }, learner.cookie)).status, 400)
  assert.equal((await request(cheerPath, { approve: true }, other.cookie)).status, 404)
  const approved = await request(cheerPath, { approve: true }, learner.cookie)
  assert.equal(approved.status, 201)
  assert.deepEqual(
    { approved: approved.body.message.correction.approved, text: approved.body.message.correction.text, byMe: approved.body.message.correction.byMe },
    { approved: true, text: undefined, byMe: true },
  )
  assert.equal((await request(cheerPath, { approve: true }, learner.cookie)).status, 409)
  assert.equal((await request(`${cheerPath}/respond`, { response: 'saved' }, other.cookie)).status, 400)
  assert.equal((await request(`${cheerPath}/respond`, { response: 'thanks' }, other.cookie)).body.message.correction.response, 'thanks')
  assert.equal((await request(`/api/companions/messages/${cheer.body.message.id}/edit`, { text: 'Toll!' }, other.cookie)).status, 409)
  const grammar = await request(messagesPath, { text: 'Ich habe gestern gegangen' }, other.cookie)
  const grammarPath = `/api/companions/messages/${grammar.body.message.id}/correction`
  assert.equal((await request(grammarPath, { text: 'Ich bin gestern gegangen', tags: ['grammar'] }, learner.cookie)).status, 400)
  assert.equal((await request(grammarPath, { text: 'Ich bin gestern gegangen', tags: ['article', 'case', 'tense', 'spelling'] }, learner.cookie)).status, 400)
  const tagged = await request(grammarPath, { text: 'Ich bin gestern gegangen', tags: ['verb-form', 'tense', 'verb-form'], note: 'Bewegung: sein' }, learner.cookie)
  assert.equal(tagged.status, 201)
  assert.deepEqual(tagged.body.message.correction.tags, ['verb-form', 'tense'])
  assert.equal((await request(messagesPath, null, other.cookie)).body.messages.find((item) => item.id === grammar.body.message.id).correction.text, 'Ich bin gestern gegangen')
  assert.equal((await request(`/api/companions/messages/${reply.body.message.id}/edit`, { text: 'Danke sehr!' }, other.cookie)).status, 409)
  const editPath = `/api/companions/messages/${threaded.body.message.id}/edit`
  assert.equal((await request(editPath, { text: 'Gern geschehen!' }, other.cookie)).status, 404)
  assert.equal((await request(`/api/companions/messages/${wordMessage.body.message.id}/edit`, { text: 'Changed' }, learner.cookie)).status, 404)
  assert.equal((await request(editPath, { text: '  ' }, learner.cookie)).status, 400)
  const edited = await request(editPath, { text: '  Gern geschehen!  ' }, learner.cookie)
  assert.equal(edited.status, 200)
  assert.equal(edited.body.message.text, 'Gern geschehen!')
  assert.ok(edited.body.message.editedAt)
  assert.equal((await request(messagesPath, null, other.cookie)).body.messages.find((item) => item.id === threaded.body.message.id).editableUntil, undefined)
  records.companionMessages.find((item) => item._id.toString() === threaded.body.message.id).createdAt = new Date(Date.now() - 11 * 60 * 1000)
  assert.equal((await request(editPath, { text: 'Too late' }, learner.cookie)).status, 403)
  assert.equal((await request(`/api/companions/messages/${threaded.body.message.id}/unsend`, {}, learner.cookie)).status, 403)
  const oops = await request(messagesPath, { text: 'Oops, wrong chat' }, learner.cookie)
  const answered = await request(messagesPath, { text: 'Verstanden', replyToId: oops.body.message.id }, other.cookie)
  assert.equal(answered.body.message.replyTo.text, 'Oops, wrong chat')
  const unsendPath = `/api/companions/messages/${oops.body.message.id}/unsend`
  assert.equal((await request(unsendPath, {}, other.cookie)).status, 404)
  const unsent = await request(unsendPath, {}, learner.cookie)
  assert.equal(unsent.status, 200)
  assert.equal(unsent.body.message.kind, 'unsent')
  assert.equal(unsent.body.message.text, 'Message unsent')
  const afterUnsend = (await request(messagesPath, null, other.cookie)).body.messages
  assert.equal(afterUnsend.find((item) => item.id === oops.body.message.id).kind, 'unsent')
  assert.equal(afterUnsend.find((item) => item.id === answered.body.message.id).replyTo.text, 'Message unsent')
  assert.equal(records.companionMessages.find((item) => item._id.toString() === oops.body.message.id).text, '')
  assert.equal((await request(unsendPath, {}, learner.cookie)).status, 404)
  assert.equal((await request(`/api/companions/messages/${oops.body.message.id}/reaction`, { emoji: '👍' }, other.cookie)).status, 404)
  assert.equal((await request(`/api/companions/messages/${oops.body.message.id}/report`, { reason: 'spam' }, other.cookie)).status, 404)
  assert.equal((await request(messagesPath, { text: 'Reply', replyToId: oops.body.message.id }, other.cookie)).status, 400)
  const searchPath = (term) => `/api/companions/chats/${openedChat.body.id}/search?q=${encodeURIComponent(term)}`
  assert.equal((await request(searchPath('x'), null, other.cookie)).status, 400)
  assert.equal((await request(searchPath('x'.repeat(101)), null, other.cookie)).status, 400)
  assert.deepEqual((await request(searchPath('SCHON'), null, learner.cookie)).body.messages.map((item) => item.id), [reply.body.message.id])
  assert.deepEqual((await request(searchPath('danke'), null, learner.cookie)).body.messages.map((item) => item.id), [reply.body.message.id])
  assert.deepEqual((await request(searchPath('lektion'), null, other.cookie)).body.messages.map((item) => item.kind), ['word'])
  assert.equal((await request(searchPath('shared'), null, other.cookie)).body.messages.length, 0)
  assert.equal((await request(searchPath('oops'), null, other.cookie)).body.messages.length, 0)
  assert.equal((await request(`/api/companions/chats/${new ObjectId().toString()}/search?q=danke`, null, other.cookie)).status, 404)
  const privateTieTime = new Date(Date.now() + 1000)
  const privateTied = Array.from({ length: 60 }, (_, index) => ({
    _id: new ObjectId(), conversationId: openedChat.body.id, senderId: otherId,
    text: `Tied ${index}`, createdAt: privateTieTime,
  }))
  const privateConversation = records.companionConversations.find((item) => item._id.toString() === openedChat.body.id)
  const previousReadAt = privateConversation.readAt[learnerId]
  const previousReadThrough = privateConversation.readThrough[learnerId]
  records.companionMessages.push(...privateTied)
  const privateTiePage = (await request(messagesPath, null, learner.cookie)).body
  const privateOldest = privateTiePage.messages[0]
  const privateNextPage = (await request(`${messagesPath}?before=${encodeURIComponent(privateOldest.createdAt)}&beforeId=${privateOldest.id}`, null, learner.cookie)).body
  const privateIds = [...privateTiePage.messages, ...privateNextPage.messages].map((message) => message.id)
  assert.equal(new Set(privateIds).size, privateIds.length)
  assert.ok(privateTied.every((message) => privateIds.includes(message._id.toString())))
  assert.equal((await request(`${messagesPath}?beforeId=bad`, null, learner.cookie)).status, 400)
  const sameTimeNewMessage = {
    _id: new ObjectId(), conversationId: openedChat.body.id, senderId: otherId,
    text: 'New at the same time', createdAt: privateTieTime,
  }
  records.companionMessages.push(sameTimeNewMessage)
  assert.equal((await request('/api/companions/unread', null, learner.cookie)).body.count, 1)
  assert.equal((await request('/api/companions/chats', null, learner.cookie)).body.chats[0].unread, true)
  assert.equal((await request(readPath, { id: sameTimeNewMessage._id.toString() }, learner.cookie)).status, 200)
  assert.equal((await request('/api/companions/unread', null, learner.cookie)).body.count, 0)
  records.companionMessages = records.companionMessages.filter((message) => !privateTied.includes(message))
  records.companionMessages = records.companionMessages.filter((message) => message !== sameTimeNewMessage)
  privateConversation.readAt[learnerId] = previousReadAt
  privateConversation.readThrough[learnerId] = previousReadThrough
  const practicePath = `/api/companions/chats/${openedChat.body.id}/practice`
  const practiceCards = Array.from({ length: 5 }, (_, index) => ({
    id: `practice-${index}`, prompt: index === 0 ? 'Tisch' : `lernen ${index}`,
    ...(index === 0 ? { article: 'der', plural: 'Tische' } : {}),
    meaning: index === 0 ? 'table' : `to learn ${index}`,
    example: index === 0 ? 'Der Tisch ist groß.' : `Wir lernen ${index}.`,
    translation: index === 0 ? 'The table is big.' : `We learn ${index}.`,
    category: index === 0 ? 'noun' : 'verb', status: 'active', tags: ['Lektion 4'],
    reviewHistory: [{ at: '2026-11-01T12:00:00.000Z' }], lastReviewedAt: '2026-11-01T12:00:00.000Z',
  }))
  assert.equal((await request(practicePath, null, learner.cookie)).body.practice, null)
  assert.equal((await request(practicePath, { tag: '' }, learner.cookie)).status, 400)
  assert.equal((await request(practicePath, {}, learner.cookie)).status, 409)
  records.progress.push({ userId: learnerId, cards: practiceCards })
  const startedPractice = await request(practicePath, { tag: 'Lektion 4' }, learner.cookie)
  assert.equal(startedPractice.status, 201)
  assert.equal(startedPractice.body.practice.role, 'learner')
  assert.equal(startedPractice.body.practice.status, 'pending')
  assert.equal((await request(practicePath, { tag: 'Lektion 4' }, learner.cookie)).status, 409)
  const helperPractice = await request(practicePath, null, other.cookie)
  const learnerSocket = await connectSocket(learner.cookie)
  const unauthenticatedSocket = io(base, { transports: ['websocket'], reconnection: false, timeout: 3000 })
  sockets.push(unauthenticatedSocket)
  assert.match((await once(unauthenticatedSocket, 'connect_error'))[0].message, /Sign in|Session/)
  unauthenticatedSocket.disconnect()
  const helperSocket = await connectSocket(other.cookie)
  assert.deepEqual(await socketCall(learnerSocket, 'subscribe', { kind: 'private', id: openedChat.body.id }), { ok: true })
  const pendingSnapshot = once(helperSocket, 'practice')
  assert.deepEqual(await socketCall(helperSocket, 'subscribe', { kind: 'private', id: openedChat.body.id }), { ok: true })
  assert.equal((await pendingSnapshot)[0].practice.card, undefined)
  const typingEvent = once(helperSocket, 'typing')
  learnerSocket.emit('typing', true)
  assert.equal((await typingEvent)[0].user.id, learnerId)
  assert.equal(records.chatTyping.some((entry) => entry.chatId === openedChat.body.id && entry.expiresAt > new Date()), false)
  assert.equal(helperPractice.body.practice.role, 'helper')
  assert.equal(helperPractice.body.practice.total, 5)
  const practiceDecision = `${practicePath}/${startedPractice.body.practice.id}/decision`
  const practiceAnswer = `${practicePath}/${startedPractice.body.practice.id}/answer`
  assert.equal((await request(practiceDecision, { decision: 'request-reveal' }, learner.cookie)).status, 409)
  assert.equal((await request(practiceDecision, { decision: 'accept' }, learner.cookie)).status, 409)
  const acceptedSocketPractice = await socketCall(helperSocket, 'command', { path: practiceDecision.replace('/api/companions', ''), body: { decision: 'accept' } })
  const acceptedPractice = { status: acceptedSocketPractice.status, body: acceptedSocketPractice.data }
  assert.equal(acceptedPractice.status, 200)
  assert.equal(typeof acceptedPractice.body.practice.card.meaning, 'string')
  const learnerPractice = await request(practicePath, null, learner.cookie)
  assert.equal(learnerPractice.body.practice.card.meaning, undefined)
  assert.equal((await request(practiceAnswer, { answer: 'table' }, other.cookie)).status, 404)
  const receivedAnswer = new Promise((resolve) => {
    const handler = (value) => { if (value.practice?.answer === 'table') { helperSocket.off('practice', handler); resolve(value) } }
    helperSocket.on('practice', handler)
  })
  let historyFramesDuringAnswer = 0
  const countHistoryFrames = () => { historyFramesDuringAnswer++ }
  helperSocket.on('snapshot', countHistoryFrames)
  assert.equal((await socketCall(learnerSocket, 'command', { path: practiceAnswer.replace('/api/companions', ''), body: { answer: 'table' } })).status, 200)
  assert.equal((await receivedAnswer).practice.answer, 'table')
  assert.equal(historyFramesDuringAnswer, 0)
  helperSocket.off('snapshot', countHistoryFrames)
  learnerSocket.disconnect()
  helperSocket.disconnect()
  const reconnectedHelper = await connectSocket(other.cookie)
  const recoveredReview = once(reconnectedHelper, 'practice')
  assert.deepEqual(await socketCall(reconnectedHelper, 'subscribe', { kind: 'private', id: openedChat.body.id }), { ok: true })
  assert.equal((await recoveredReview)[0].practice.answer, 'table')
  reconnectedHelper.disconnect()
  assert.equal((await request(practiceDecision, { decision: 'try-again' }, other.cookie)).status, 200)
  assert.equal((await request(practiceDecision, { decision: 'retry' }, learner.cookie)).body.practice.answer, undefined)
  for (let attempt = 0; attempt < 4; attempt++) {
    assert.equal((await request(practiceAnswer, { answer: `desk ${attempt}` }, learner.cookie)).status, 200)
    assert.equal((await request(practiceDecision, { decision: 'try-again' }, other.cookie)).status, 200)
    assert.equal((await request(practiceDecision, { decision: 'retry' }, learner.cookie)).status, 200)
  }
  assert.equal((await request(practiceAnswer, { answer: 'one more attempt' }, learner.cookie)).status, 400)
  assert.equal((await request(practiceDecision, { decision: 'request-reveal' }, other.cookie)).status, 409)
  const revealRequest = await request(practiceDecision, { decision: 'request-reveal' }, learner.cookie)
  assert.equal(revealRequest.body.practice.revealRequested, true)
  assert.equal(revealRequest.body.practice.card.meaning, undefined)
  assert.equal((await request(practiceDecision, { decision: 'request-reveal' }, learner.cookie)).status, 200)
  assert.equal((await request(practiceDecision, { decision: 'reveal' }, learner.cookie)).status, 409)
  assert.equal((await request(practiceDecision, { decision: 'reveal' }, other.cookie)).status, 200)
  assert.equal((await request(practiceDecision, { decision: 'reveal' }, other.cookie)).status, 409)
  assert.equal(typeof (await request(practicePath, null, learner.cookie)).body.practice.card.example, 'string')
  assert.equal((await request(practiceDecision, { decision: 'end' }, other.cookie)).body.practice.status, 'ended')
  const firstSummary = records.companionMessages.find((item) => item._id.toString() === startedPractice.body.practice.id)
  assert.match(firstSummary.text, /Review session ended/)
  assert.match(firstSummary.text, /0 recalled · 0 after retry · 1 revealed/)
  for (const participant of [learner, other]) {
    const history = await request(messagesPath, null, participant.cookie)
    assert.equal(history.body.messages.find((item) => item.id === firstSummary._id.toString()).kind, 'practice')
  }
  assert.equal((await request(`/api/companions/messages/${firstSummary._id}/edit`, { text: 'All recalled!' }, learner.cookie)).status, 404)
  assert.equal((await request(`/api/companions/messages/${firstSummary._id}/correction`, { approve: true }, other.cookie)).status, 404)
  const ordinaryReviewMessage = await request(messagesPath, { text: firstSummary.text, kind: 'practice' }, learner.cookie)
  assert.equal(ordinaryReviewMessage.status, 201)
  assert.equal(ordinaryReviewMessage.body.message.kind, 'text')
  const secondPractice = await request(practicePath, {}, learner.cookie)
  const secondDecision = `${practicePath}/${secondPractice.body.practice.id}/decision`
  const secondAnswer = `${practicePath}/${secondPractice.body.practice.id}/answer`
  assert.equal((await request(secondDecision, { decision: 'accept' }, other.cookie)).status, 200)
  assert.equal((await request(secondAnswer, { answer: 'desk' }, learner.cookie)).status, 200)
  assert.equal((await request(secondDecision, { decision: 'correct' }, other.cookie)).body.practice.feedback, 'correct')
  const learnerRevealedPractice = (await request(practicePath, null, learner.cookie)).body.practice
  const revealedCard = practiceCards.find((card) => card.prompt === learnerRevealedPractice.card.prompt)
  assert.equal(learnerRevealedPractice.card.meaning, revealedCard.meaning)
  assert.equal(learnerRevealedPractice.card.example, revealedCard.example)
  assert.equal(learnerRevealedPractice.card.translation, revealedCard.translation)
  assert.equal(learnerRevealedPractice.card.article, revealedCard.article)
  assert.equal(learnerRevealedPractice.card.plural, revealedCard.plural)
  assert.equal((await request(secondDecision, { decision: 'next' }, learner.cookie)).body.practice.position, 2)
  assert.equal((await request(secondDecision, { decision: 'end' }, other.cookie)).body.practice.status, 'ended')
  const secondSummary = records.companionMessages.find((item) => item._id.toString() === secondPractice.body.practice.id)
  assert.match(secondSummary.text, /1 recalled · 0 after retry · 0 revealed/)
  await request(secondDecision, { decision: 'end' }, learner.cookie)
  assert.equal(records.companionMessages.filter((item) => item._id.toString() === secondPractice.body.practice.id).length, 1)
  const progressBeforePractice = JSON.stringify(records.progress)
  const fullPractice = await request(practicePath, {}, learner.cookie)
  const fullDecision = `${practicePath}/${fullPractice.body.practice.id}/decision`
  const fullAnswer = `${practicePath}/${fullPractice.body.practice.id}/answer`
  assert.equal((await request(fullDecision, { decision: 'accept' }, other.cookie)).status, 200)
  const revisionTestSocket = await connectSocket(other.cookie)
  await socketCall(revisionTestSocket, 'subscribe', { kind: 'private', id: openedChat.body.id })
  const firstRoundRevision = records.practiceSessions.find((item) => item._id.toString() === fullPractice.body.practice.id).revision
  for (let index = 0; index < 5; index++) {
    if (index === 1) {
      const before = JSON.stringify(records.practiceSessions)
      assert.equal((await request(fullAnswer, { answer: 'late card-zero answer', revision: firstRoundRevision }, learner.cookie)).status, 409)
      assert.equal((await socketCall(revisionTestSocket, 'command', { path: fullDecision.replace('/api/companions', ''), body: { decision: 'correct', revision: firstRoundRevision } })).status, 409)
      assert.equal((await request(fullDecision, { decision: 'request-reveal', revision: null }, learner.cookie)).status, 400)
      assert.equal(JSON.stringify(records.practiceSessions), before)
    }
    if (index === 3) {
      assert.equal((await request(fullDecision, { decision: 'request-reveal' }, learner.cookie)).body.practice.revealRequested, true)
      assert.equal((await request(fullAnswer, { answer: 'an answer' }, learner.cookie)).status, 409)
      const beforeAnswerReveal = await request(fullDecision, { decision: 'reveal' }, other.cookie)
      assert.equal(beforeAnswerReveal.status, 200)
      const learnerView = (await request(practicePath, null, learner.cookie)).body.practice
      assert.equal(learnerView.feedback, 'reveal')
      assert.ok(learnerView.card.meaning)
      assert.equal(learnerView.answer, undefined)
      assert.equal((await request(fullDecision, { decision: 'next' }, learner.cookie)).status, 200)
      continue
    }
    if (index === 0) {
      const concurrent = await Promise.all([0, 1].map(() => request(fullAnswer, { answer: 'an answer', revision: firstRoundRevision }, learner.cookie)))
      assert.deepEqual(concurrent.map((item) => item.status).sort(), [200, 409])
      assert.equal(concurrent.find((item) => item.status === 200).body.practice.revision, firstRoundRevision + 1)
    } else assert.equal((await request(fullAnswer, { answer: 'an answer' }, learner.cookie)).status, 200)
    if (index === 2) {
      assert.equal((await request(fullDecision, { decision: 'try-again' }, other.cookie)).status, 200)
      assert.equal((await request(fullDecision, { decision: 'request-reveal' }, learner.cookie)).body.practice.revealRequested, true)
      assert.equal((await request(fullDecision, { decision: 'retry' }, learner.cookie)).status, 409)
      assert.equal((await request(fullAnswer, { answer: 'another answer' }, learner.cookie)).status, 409)
    }
    if (index === 1) {
      assert.equal((await request(fullDecision, { decision: 'try-again' }, other.cookie)).status, 200)
      assert.equal((await request(fullDecision, { decision: 'retry' }, learner.cookie)).status, 200)
      assert.equal((await request(fullAnswer, { answer: 'another answer' }, learner.cookie)).status, 200)
    }
    assert.equal((await request(fullDecision, { decision: index === 2 ? 'reveal' : 'correct' }, other.cookie)).status, 200)
    assert.equal((await request(fullDecision, { decision: 'next' }, learner.cookie)).status, 200)
  }
  revisionTestSocket.disconnect()
  const fullSummary = records.companionMessages.find((item) => item._id.toString() === fullPractice.body.practice.id)
  assert.match(fullSummary.text, /5\/5 reviewed · 2 recalled · 1 after retry · 2 revealed/)
  assert.equal(JSON.stringify(records.progress), progressBeforePractice)
  assert.equal((await request(practicePath, null, learner.cookie)).body.practice, null)
  assert.equal((await request(`/api/companions/chats/${openedChat.body.id}/delete`, {}, learner.cookie)).status, 200)
  assert.equal((await request('/api/companions/chats', null, learner.cookie)).body.chats.length, 0)
  assert.equal((await request('/api/companions/chats', null, other.cookie)).body.chats.length, 1)
  assert.deepEqual((await request(`/api/companions/chats/${openedChat.body.id}/messages`, null, learner.cookie)).body.messages, [])
  assert.equal((await request(`/api/companions/chats/${openedChat.body.id}/messages`, { text: 'A new message after deletion.' }, other.cookie)).status, 201)
  const afterDeleteMessage = await request(`/api/companions/chats/${openedChat.body.id}/messages`, null, learner.cookie)
  assert.deepEqual(afterDeleteMessage.body.messages.map((item) => item.text), ['A new message after deletion.'])
  assert.equal((await request(searchPath('danke'), null, learner.cookie)).body.messages.length, 0)
  assert.equal((await request(searchPath('Deletion'), null, learner.cookie)).body.messages.length, 1)
  assert.equal((await request(searchPath('danke'), null, other.cookie)).body.messages.length, 1)
  const blockedSocket = await connectSocket(other.cookie)
  assert.deepEqual(await socketCall(blockedSocket, 'subscribe', { kind: 'private', id: openedChat.body.id }), { ok: true })
  assert.equal((await request('/api/companions/action', { id: otherId, action: 'block' }, learner.cookie)).status, 200)
  assert.equal((await socketCall(blockedSocket, 'command', { path: `/chats/${openedChat.body.id}/messages`, body: { text: 'Not allowed' } })).status, 403)
  assert.deepEqual(await socketCall(blockedSocket, 'subscribe', { kind: 'private', id: openedChat.body.id }), { ok: false })
  blockedSocket.disconnect()
  assert.equal((await request(`/api/companions/chats/${openedChat.body.id}/messages`, null, other.cookie)).status, 404)
  assert.equal((await request('/api/companions/search', { username: 'learner' }, other.cookie)).status, 404)
  assert.deepEqual((await request('/api/companions/', null, other.cookie)).body.companions, [])
  assert.equal((await request('/api/companions/request', { id: learnerId }, other.cookie)).status, 404)
  assert.equal((await request('/api/companions/', null, learner.cookie)).body.companions[0].status, 'blocked')
  assert.equal((await request('/api/companions/action', { id: otherId, action: 'unblock' }, learner.cookie)).status, 200)
  assert.equal((await request('/api/companions/settings', { emailsEnabled: false }, other.cookie)).status, 200)
  assert.equal((await request('/api/companions/', null, other.cookie)).body.emailsEnabled, false)
  assert.equal((await request('/api/companions/request', { id: otherId }, learner.cookie)).status, 201)
  assert.equal(deliveries.length, 5)
  assert.equal((await request('/api/companions/action', { id: learnerId, action: 'decline' }, other.cookie)).status, 200)
  assert.deepEqual((await request('/api/companions/', null, learner.cookie)).body.companions, [])
  const concurrent = await Promise.all([
    request('/api/companions/request', { id: otherId }, learner.cookie),
    request('/api/companions/request', { id: otherId }, learner.cookie),
  ])
  assert.deepEqual(concurrent.map((item) => item.status).sort(), [201, 409])
  assert.equal((await request('/api/companions/action', { id: otherId, action: 'cancel' }, learner.cookie)).status, 200)
  assert.equal((await request('/api/companions/settings', { emailsEnabled: true }, other.cookie)).status, 200)
  companion.companionEmailHistory = Array.from({ length: 5 }, () => new Date())
  assert.equal((await request('/api/companions/request', { id: otherId }, learner.cookie)).status, 201)
  assert.equal(deliveries.length, 5)
  assert.equal((await request('/api/companions/action', { id: otherId, action: 'cancel' }, learner.cookie)).status, 200)
  records.users.find((item) => item.email === email).companionRequestHistory = Array.from({ length: 10 }, () => new Date())
  assert.equal((await request('/api/companions/request', { id: otherId }, learner.cookie)).status, 429)
  records.users.find((item) => item.email === email).companionRequestHistory = []
  companion.companionEmailHistory = []
  failCompanionDelivery = true
  assert.equal((await request('/api/companions/request', { id: otherId }, learner.cookie)).status, 201)
  assert.equal((await request('/api/companions/', null, other.cookie)).body.companions[0].status, 'incoming')
  assert.equal(deliveries.length, 5)

  // Groups and moderation
  const makeUser = async (username) => {
    const record = {
      _id: username === 'Moderator' ? new ObjectId('aaaaaaaaaaaaaaaaaaaaaaaa') : new ObjectId(), email: `${username.toLowerCase()}@example.test`, emailKey: `${username.toLowerCase()}@example.test`,
      username, usernameKey: username.toLowerCase(), avatarSeed: 'pixel-blue',
      emailVerifiedAt: new Date(), passwordHash: await bcrypt.hash(password, 4),
    }
    records.users.push(record)
    const signedIn = await nativeFetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': `198.51.100.${records.users.length}` },
      body: JSON.stringify({ email: record.email, password }),
    })
    assert.equal(signedIn.status, 200)
    return { record, id: record._id.toString(), cookie: signedIn.headers.get('set-cookie').split(';')[0] }
  }
  const third = await makeUser('Third')
  const fourth = await makeUser('Fourth')
  const moderator = await makeUser('Moderator')
  third.record.username = 'Moderator'
  assert.equal((await request('/api/moderation/reports', null, third.cookie)).status, 404)
  third.record.username = 'Third'
  const learnerRecord = records.users.find((item) => item.email === email)
  const learnerUser = { record: learnerRecord, cookie: learner.cookie }
  const otherUser = { record: companion, cookie: other.cookie }
  const groupPost = async (groupId, who, text, extra = {}) => {
    delete who.record.lastGroupPostAt
    return request(`/api/groups/${groupId}/messages`, { text, ...extra }, who.cookie)
  }
  const directory = await request('/api/groups', null, learner.cookie)
  assert.equal(directory.status, 200)
  assert.equal(directory.body.rulesAccepted, false)
  assert.equal(directory.body.canModerate, false)
  assert.equal((await request('/api/groups', null, moderator.cookie)).body.canModerate, true)
  assert.equal((await request('/api/groups', { name: 'Anfänger' }, learner.cookie)).status, 403)
  assert.equal((await request('/api/groups', { name: 'Anfänger' }, learner.cookie)).body.code, 'rules')
  assert.equal((await request('/api/groups/rules', {}, learner.cookie)).status, 200)
  learnerRecord.createdAt = new Date()
  const created = await request('/api/groups', { name: 'Anfänger  Treff', description: 'A1 and A2 questions' }, learner.cookie)
  assert.equal(created.status, 201)
  assert.equal(created.body.group.name, 'Anfänger Treff')
  assert.equal(created.body.group.isOwner, true)
  const groupId = created.body.group.id
  assert.equal((await request('/api/groups', { name: 'anfänger treff' }, learner.cookie)).status, 409)
  assert.equal((await request('/api/groups', { name: 'Zweite Gruppe' }, learner.cookie)).status, 201)
  const thirdGroup = await request('/api/groups', { name: 'Dritte Gruppe' }, learner.cookie)
  assert.equal(thirdGroup.status, 201)
  const overLimit = await request('/api/groups', { name: 'Vierte Gruppe' }, learner.cookie)
  assert.equal(overLimit.status, 409)
  assert.match(overLimit.body.error, /up to 3 groups/)
  assert.equal((await request('/api/groups', null, learner.cookie)).body.ownedCount, 3)

  assert.equal((await request(`/api/groups/${groupId}/join`, {}, other.cookie)).body.code, 'rules')
  await request('/api/groups/rules', {}, other.cookie)
  companion.createdAt = new Date()
  assert.equal((await request(`/api/groups/${groupId}/join`, {}, other.cookie)).status, 200)
  assert.equal((await request(`/api/groups/${groupId}/join`, {}, other.cookie)).status, 200)
  await request('/api/groups/rules', {}, third.cookie)
  await request('/api/groups/rules', {}, fourth.cookie)
  assert.equal((await request(`/api/groups/${groupId}/state`, { state: 'closed' }, other.cookie)).status, 404)
  assert.equal((await request(`/api/groups/${groupId}/state`, { state: 'closed' }, learner.cookie)).status, 200)
  const closedJoin = await request(`/api/groups/${groupId}/join`, {}, third.cookie)
  assert.equal(closedJoin.status, 409)
  assert.match(closedJoin.body.error, /closed/)
  assert.equal((await request(`/api/groups/${groupId}/state`, { state: 'open' }, learner.cookie)).status, 200)
  for (const who of [third, fourth]) assert.equal((await request(`/api/groups/${groupId}/join`, {}, who.cookie)).status, 200)
  const listed = (await request('/api/groups', null, other.cookie)).body.groups.find((item) => item.id === groupId)
  assert.equal(listed.memberCount, 4)
  assert.equal(listed.joined, true)
  assert.equal(listed.owner.username, 'learner')
  const browseGroups = Array.from({ length: 101 }, (_, index) => ({
    _id: new ObjectId(), name: `Browse ${index}`, ownerId: moderator.id, ownerSlot: index,
    state: 'open', memberCount: 1, createdAt: new Date(), lastActivityAt: new Date(Date.now() + 60_000),
  }))
  records.groups.push(...browseGroups)
  assert.ok((await request('/api/groups', null, other.cookie)).body.groups.some((item) => item.id === groupId))
  records.groups = records.groups.filter((item) => !browseGroups.includes(item))

  const outsider = await makeUser('Outsider')
  assert.equal((await request(typingPath, { typing: true }, outsider.cookie)).status, 404)
  await request('/api/groups/rules', {}, outsider.cookie)
  const visibilityPath = `/api/groups/${groupId}/visibility`
  assert.equal((await request(visibilityPath, { visibility: 'unlisted' }, other.cookie)).status, 404)
  assert.equal((await request(visibilityPath, { visibility: 'unlisted' }, learner.cookie)).status, 200)
  assert.equal((await request('/api/groups', null, outsider.cookie)).body.groups.some((group) => group.id === groupId), false)
  assert.equal((await request('/api/groups', null, other.cookie)).body.groups.find((group) => group.id === groupId).visibility, 'unlisted')
  assert.equal((await request(`/api/groups/${groupId}/invitation`, null, outsider.cookie)).status, 404)
  const inviteToken = (await request(`/api/groups/${groupId}/invitation`, null, other.cookie)).body.inviteToken
  assert.equal((await request(`/api/groups/${groupId}/join`, {}, outsider.cookie)).status, 404)
  assert.equal((await request('/api/groups/invitation/resolve', { inviteToken }, outsider.cookie)).body.group.id, groupId)
  assert.equal((await request(`/api/groups/${groupId}/state`, { state: 'closed' }, learner.cookie)).status, 200)
  assert.equal((await request(`/api/groups/${groupId}/join`, { inviteToken }, outsider.cookie)).status, 409)
  assert.equal((await request(`/api/groups/${groupId}/state`, { state: 'open' }, learner.cookie)).status, 200)
  assert.equal((await request(`/api/groups/${groupId}/join`, { inviteToken }, outsider.cookie)).status, 200)
  assert.equal((await request(`/api/groups/${groupId}/leave`, {}, outsider.cookie)).status, 200)
  assert.equal((await request(visibilityPath, { visibility: 'listed' }, learner.cookie)).status, 200)
  assert.equal((await request('/api/groups/invitation/resolve', { inviteToken }, outsider.cookie)).status, 404)
  assert.equal((await request(visibilityPath, { visibility: 'unlisted' }, learner.cookie)).status, 200)
  const rotatedToken = (await request(`/api/groups/${groupId}/invitation`, null, learner.cookie)).body.inviteToken
  assert.notEqual(rotatedToken, inviteToken)
  assert.equal((await request(`/api/groups/${groupId}/join`, { inviteToken }, outsider.cookie)).status, 404)
  assert.equal((await request('/api/groups/invitation/resolve', { inviteToken: rotatedToken }, outsider.cookie)).status, 200)
  assert.equal((await request(visibilityPath, { visibility: 'listed' }, learner.cookie)).status, 200)
  assert.equal((await request(`/api/groups/${groupId}/messages`, null, outsider.cookie)).status, 404)
  assert.equal((await request(`/api/groups/${groupId}/live`, null, outsider.cookie)).status, 404)
  assert.equal((await request(`/api/groups/${groupId}/live`, null, learner.cookie)).status, 503)
  const groupTypingPath = `/api/groups/${groupId}/typing`
  assert.equal((await request(groupTypingPath, { typing: true }, outsider.cookie)).status, 404)
  assert.equal((await request(groupTypingPath, { typing: true }, third.cookie)).status, 200)
  assert.deepEqual((await request(`/api/groups/${groupId}/messages?read=0`, null, learner.cookie)).body.typing.map((item) => item.username), ['Third'])
  assert.deepEqual((await request(`/api/groups/${groupId}/messages?read=0`, null, third.cookie)).body.typing, [])
  assert.equal((await request(groupTypingPath, { typing: false }, third.cookie)).status, 200)
  assert.deepEqual((await request(`/api/groups/${groupId}/messages?read=0`, null, learner.cookie)).body.typing, [])
  const beforeJoin = { _id: new ObjectId(), groupId, senderId: learnerRecord._id.toString(), text: 'Old message', createdAt: new Date(0) }
  records.groupMessages.push(beforeJoin)
  assert.equal((await request('/api/groups', null, third.cookie)).body.groups.find((item) => item.id === groupId).unreadCount, 0)
  records.groupMessages = records.groupMessages.filter((message) => message !== beforeJoin)
  assert.equal((await groupPost(groupId, learnerUser, 'Hallo zusammen!')).status, 201)
  const groupClientId = new ObjectId().toString()
  const groupSender = await connectSocket(other.cookie)
  const groupRecipient = await connectSocket(learner.cookie)
  assert.deepEqual(await socketCall(groupSender, 'subscribe', { kind: 'group', id: groupId }), { ok: true })
  assert.deepEqual(await socketCall(groupRecipient, 'subscribe', { kind: 'group', id: groupId }), { ok: true })
  const groupOutsider = await connectSocket(outsider.cookie)
  assert.deepEqual(await socketCall(groupOutsider, 'subscribe', { kind: 'group', id: groupId }), { ok: false })
  groupOutsider.disconnect()
  assert.equal((await socketCall(groupSender, 'command', { path: `/${groupId}/messages`, body: { text: '' } })).status, 400)
  const incomingGroup = new Promise((resolve) => {
    const handler = (value) => { const message = value.page.messages.find((item) => item.id === groupClientId); if (message) { assert.equal(value.page.messages.length, 1); groupRecipient.off('snapshot', handler); resolve(message) } }
    groupRecipient.on('snapshot', handler)
  })
  const firstSocket = await socketCall(groupSender, 'command', { path: `/${groupId}/messages`, body: { text: 'Wie sagt man "thanks"?', clientId: groupClientId } })
  const first = { status: firstSocket.status, body: firstSocket.data }
  assert.equal((await incomingGroup).isMine, false)
  assert.equal((await socketCall(groupSender, 'command', { path: `/${groupId}/messages`, body: { text: 'Wie sagt man "thanks"?', clientId: groupClientId } })).data.message.id, groupClientId)
  groupSender.disconnect()
  groupRecipient.disconnect()
  assert.equal(first.status, 201)
  assert.equal(first.body.message.id, groupClientId)
  assert.equal(first.body.message.receipt, 'sent')
  const retriedGroup = await request(`/api/groups/${groupId}/messages`, { text: 'Wie sagt man "thanks"?', clientId: groupClientId }, other.cookie)
  assert.equal(retriedGroup.status, 200)
  assert.equal(retriedGroup.body.message.id, groupClientId)
  assert.equal((await request(`/api/groups/${groupId}/messages`, { text: 'Different content', clientId: groupClientId }, other.cookie)).status, 409)
  assert.equal((await request(`/api/groups/${groupId}/messages`, { text: 'Wie sagt man "thanks"?', clientId: groupClientId }, learner.cookie)).status, 409)
  assert.equal(records.groupMessages.filter((message) => message._id.toString() === groupClientId).length, 1)
  assert.equal(first.body.message.sender.username, 'Companion')
  assert.equal((await request(`/api/groups/${groupId}/search?q=thanks`, null, outsider.cookie)).status, 404)
  assert.equal((await request(`/api/groups/${groupId}/search?q=x`, null, learner.cookie)).status, 400)
  assert.equal((await request(`/api/groups/${groupId}/search?q=${'x'.repeat(101)}`, null, learner.cookie)).status, 400)
  assert.equal((await request(`/api/groups/${groupId}/messages`, { text: 'Too fast' }, other.cookie)).status, 429)
  assert.equal((await groupPost(groupId, otherUser, 'Wie sagt man "thanks"?')).status, 429)
  assert.equal((await groupPost(groupId, otherUser, 'a http://a.example http://b.example http://c.example')).status, 400)
  const groupDelivered = `/api/groups/${groupId}/delivered`
  assert.equal((await request(groupDelivered, { id: groupClientId }, outsider.cookie)).status, 404)
  assert.equal((await request(groupDelivered, { id: groupClientId }, other.cookie)).status, 404)
  assert.equal((await request(groupDelivered, { id: groupClientId }, third.cookie)).status, 200)
  const ownFirst = async () => (await request(`/api/groups/${groupId}/messages?read=0`, null, other.cookie)).body.messages.find((message) => message.id === groupClientId)
  assert.equal((await ownFirst()).receipt, 'delivered')
  const answer = await groupPost(groupId, learnerUser, 'Danke!', { replyToId: first.body.message.id })
  assert.equal(answer.status, 201)
  assert.equal(answer.body.message.replyTo.text, 'Wie sagt man "thanks"?')
  const firstPath = `/api/groups/${groupId}/messages/${first.body.message.id}`
  assert.equal((await request(`${firstPath}/reaction`, { emoji: '👍' }, outsider.cookie)).status, 404)
  assert.equal((await request(`${firstPath}/reaction`, { emoji: '🤔' }, learner.cookie)).status, 400)
  assert.deepEqual((await request(`${firstPath}/reaction`, { emoji: '👍' }, learner.cookie)).body.reactions, [{ emoji: '👍', count: 1, mine: true }])
  assert.deepEqual((await request(`${firstPath}/reaction`, { emoji: '👍' }, third.cookie)).body.reactions, [{ emoji: '👍', count: 2, mine: true }])
  assert.deepEqual((await request(`${firstPath}/reaction`, { emoji: null }, learner.cookie)).body.reactions, [{ emoji: '👍', count: 1, mine: false }])
  assert.equal((await request(`${firstPath}/edit`, { text: 'Change' }, learner.cookie)).status, 404)
  assert.equal((await request(`${firstPath}/edit`, { text: 'http://a.example http://b.example http://c.example' }, other.cookie)).status, 400)
  const editedGroupMessage = await request(`${firstPath}/edit`, { text: 'Wie sagt man thanks?' }, other.cookie)
  assert.equal(editedGroupMessage.status, 200)
  assert.ok(editedGroupMessage.body.message.editedAt)
  assert.equal(records.groupMessages.find((item) => item._id.toString() === answer.body.message.id).replyTo.text, 'Wie sagt man thanks?')
  const firstStored = records.groupMessages.find((item) => item._id.toString() === first.body.message.id)
  const originalCreatedAt = firstStored.createdAt
  firstStored.createdAt = new Date(Date.now() - 11 * 60 * 1000)
  assert.equal((await request(`${firstPath}/edit`, { text: 'Too late' }, other.cookie)).status, 403)
  firstStored.createdAt = originalCreatedAt
  const groupEntry = async (cookie) => (await request('/api/groups', null, cookie)).body.groups.find((item) => item.id === groupId)
  const outsiderEntry = await groupEntry(outsider.cookie)
  assert.equal(outsiderEntry.lastMessage, undefined)
  assert.equal(outsiderEntry.unreadCount, undefined)
  const thirdEntry = await groupEntry(third.cookie)
  assert.equal(thirdEntry.unreadCount, 3)
  assert.equal(thirdEntry.lastMessage.text, 'Danke!')
  assert.equal(thirdEntry.lastMessage.sender, 'learner')
  assert.equal((await groupEntry(learner.cookie)).unreadCount, 1)
  const groupReadPath = `/api/groups/${groupId}/read`
  assert.equal((await request(`/api/groups/${groupId}/messages?read=0`, null, third.cookie)).status, 200)
  assert.equal((await groupEntry(third.cookie)).unreadCount, 3)
  assert.equal((await request(groupReadPath, { id: 'invalid' }, third.cookie)).status, 400)
  assert.equal((await request(groupReadPath, { id: answer.body.message.id }, outsider.cookie)).status, 404)
  assert.equal((await request(groupReadPath, { id: answer.body.message.id, ids: [first.body.message.id, answer.body.message.id] }, third.cookie)).status, 200)
  assert.equal((await ownFirst()).receipt, 'read')
  assert.equal((await groupEntry(third.cookie)).unreadCount, 0)
  const thirdMembership = records.groupMembers.find((item) => item.groupId === groupId && item.userId === third.id)
  const readThrough = thirdMembership.readThrough
  await request(groupReadPath, { id: first.body.message.id }, third.cookie)
  assert.equal(thirdMembership.readThrough, readThrough)
  const history = await request(`/api/groups/${groupId}/messages`, null, third.cookie)
  assert.equal(history.body.messages.length, 3)
  assert.equal(history.body.messages[0].canHide, false)
  assert.equal((await groupEntry(third.cookie)).unreadCount, 0)
  assert.equal((await request(`/api/groups/${groupId}/messages`, null, learner.cookie)).body.messages[0].canHide, true)

  const mention = await groupPost(groupId, learnerUser, 'Hello @Third @fourth @Outsider and email x@Companion.example @learner')
  assert.equal(mention.status, 201)
  const mentionId = mention.body.message.id
  const storedMention = records.groupMessages.find((item) => item._id.toString() === mentionId)
  assert.deepEqual(new Set(storedMention.mentionUserIds), new Set([third.id, fourth.id]))
  const mentionsPath = `/api/groups/${groupId}/mentions`
  assert.equal((await groupEntry(third.cookie)).mentionCount, 1)
  assert.equal((await request(mentionsPath, null, outsider.cookie)).status, 404)
  assert.equal((await request(mentionsPath, null, third.cookie)).body.messages[0].id, mentionId)
  assert.equal((await request(`${mentionsPath}/${mentionId}/clear`, {}, outsider.cookie)).status, 404)
  assert.equal((await request(`${mentionsPath}/${mentionId}/clear`, {}, third.cookie)).status, 200)
  assert.equal((await groupEntry(third.cookie)).mentionCount, 0)
  assert.equal((await groupEntry(fourth.cookie)).mentionCount, 1)
  assert.equal((await request(`/api/groups/${groupId}/messages/${mentionId}/edit`, { text: 'Hello @Third only' }, learner.cookie)).status, 200)
  assert.equal((await groupEntry(fourth.cookie)).mentionCount, 0)
  assert.equal((await groupEntry(third.cookie)).mentionCount, 0)
  assert.equal((await request(`/api/groups/${groupId}/messages/${mentionId}/edit`, { text: 'Hello @Third and @Fourth' }, learner.cookie)).status, 200)
  assert.equal((await groupEntry(fourth.cookie)).mentionCount, 1)
  assert.equal((await request(`/api/groups/${groupId}/messages/${mentionId}/unsend`, {}, learner.cookie)).status, 200)
  assert.equal((await groupEntry(fourth.cookie)).mentionCount, 0)
  records.groupMessages = records.groupMessages.filter((message) => message._id.toString() !== mentionId)
  const mentionTime = new Date(Date.now() + 2000)
  const mentionBurst = Array.from({ length: 51 }, (_, index) => ({
    _id: new ObjectId(), groupId, senderId: learnerRecord._id.toString(), text: `@Third ${index}`,
    mentionUserIds: [third.id], createdAt: mentionTime,
  }))
  records.groupMessages.push(...mentionBurst)
  const mentionPage = (await request(mentionsPath, null, third.cookie)).body
  assert.equal(mentionPage.messages.length, 50)
  assert.equal(mentionPage.hasMore, true)
  const lastMention = mentionPage.messages.at(-1)
  const mentionNext = (await request(`${mentionsPath}?before=${encodeURIComponent(lastMention.createdAt)}&beforeId=${lastMention.id}`, null, third.cookie)).body
  assert.equal(mentionNext.messages.length, 1)
  assert.equal(mentionNext.hasMore, false)
  assert.equal((await request(`${mentionsPath}?before=invalid&beforeId=${lastMention.id}`, null, third.cookie)).status, 400)
  mentionBurst[0].hiddenAt = new Date()
  assert.equal((await groupEntry(third.cookie)).mentionCount, 50)
  records.groupMessages = records.groupMessages.filter((message) => !mentionBurst.includes(message))

  const sameTime = new Date(Date.now() + 1000)
  const firstAtSameTime = { _id: new ObjectId(), groupId, senderId: learnerRecord._id.toString(), text: 'First at this time', createdAt: sameTime }
  records.groupMessages.push(firstAtSameTime)
  await request(`/api/groups/${groupId}/messages`, null, fourth.cookie)
  const secondAtSameTime = { _id: new ObjectId(), groupId, senderId: learnerRecord._id.toString(), text: 'Second at this time', createdAt: sameTime }
  records.groupMessages.push(secondAtSameTime)
  assert.equal((await groupEntry(fourth.cookie)).unreadCount, 1)
  assert.equal((await groupEntry(fourth.cookie)).lastMessage.text, 'Second at this time')
  await request(`/api/groups/${groupId}/messages?before=${encodeURIComponent(sameTime.toISOString())}`, null, fourth.cookie)
  assert.equal((await groupEntry(fourth.cookie)).unreadCount, 1)
  await request(`/api/groups/${groupId}/messages`, null, fourth.cookie)
  assert.equal((await groupEntry(fourth.cookie)).unreadCount, 0)
  const burst = Array.from({ length: 101 }, (_, index) => ({
    _id: new ObjectId(), groupId, senderId: learnerRecord._id.toString(), text: `Burst ${index}`,
    createdAt: new Date(sameTime.getTime() + index + 1),
  }))
  records.groupMessages.push(...burst)
  assert.equal((await groupEntry(fourth.cookie)).unreadCount, 100)
  records.groupMessages = records.groupMessages.filter((message) => !burst.includes(message))
  records.groupMessages = records.groupMessages.filter((message) => message !== firstAtSameTime && message !== secondAtSameTime)
  delete records.groupMembers.find((member) => member.groupId === groupId && member.userId === fourth.id).readThrough

  const mine = await groupPost(groupId, third, 'Ich bin neu hier.')
  assert.equal((await request(`/api/groups/${groupId}/messages/${mine.body.message.id}/unsend`, {}, other.cookie)).status, 404)
  assert.equal((await request(`/api/groups/${groupId}/messages/${mine.body.message.id}/unsend`, {}, third.cookie)).status, 200)
  assert.equal((await request(`/api/groups/${groupId}/messages`, null, other.cookie)).body.messages.at(-1).kind, 'unsent')
  assert.equal((await groupEntry(fourth.cookie)).lastMessage.text, 'Danke!')

  const spam = await groupPost(groupId, otherUser, 'Buy cheap followers')
  const spamId = spam.body.message.id
  assert.equal((await groupEntry(learner.cookie)).unreadCount, 1)
  const reportPath = `/api/groups/${groupId}/messages/${spamId}/report`
  assert.equal((await request(reportPath, { reason: 'spam' }, other.cookie)).status, 404)
  assert.equal((await request(reportPath, { reason: 'spam' }, learner.cookie)).status, 201)
  assert.equal((await request(reportPath, { reason: 'spam' }, learner.cookie)).status, 409)
  assert.equal((await request(reportPath, { reason: 'spam' }, third.cookie)).status, 201)
  assert.equal((await request(`/api/groups/${groupId}/messages`, null, fourth.cookie)).body.messages.at(-1).kind, 'text')
  assert.equal((await request(reportPath, { reason: 'harassment', details: 'Repeated' }, fourth.cookie)).status, 201)
  assert.equal((await request(`/api/groups/${groupId}/messages`, null, fourth.cookie)).body.messages.at(-1).kind, 'hidden')
  assert.equal((await groupEntry(fourth.cookie)).lastMessage.text, 'Danke!')
  assert.equal((await groupEntry(learner.cookie)).unreadCount, 0)
  assert.equal((await request(`/api/groups/${groupId}/search?q=followers`, null, learner.cookie)).body.messages.length, 0)
  assert.equal((await request(`/api/groups/${groupId}/search?q=neu`, null, learner.cookie)).body.messages.length, 0)
  assert.equal((await request(`/api/groups/${groupId}/messages/${spamId}`, null, outsider.cookie)).status, 404)
  assert.equal((await request(`/api/groups/${groupId}/messages/${spamId}`, null, learner.cookie)).body.message.kind, 'hidden')

  const card = { prompt: 'der Baum', article: 'der', meaning: 'tree', example: 'Der Baum ist groß.', category: 'noun' }
  delete learnerRecord.lastGroupPostAt
  const sharedGroupWord = await request(`/api/groups/${groupId}/messages`, { card }, learner.cookie)
  assert.equal(sharedGroupWord.status, 201)
  assert.equal(sharedGroupWord.body.message.kind, 'word')
  const practiceProgress = JSON.stringify(records.progress)
  const groupWordId = sharedGroupWord.body.message.id
  const attemptBody = { wordPractice: true, replyToId: groupWordId }
  assert.equal((await groupPost(groupId, otherUser, 'Ein Satz.', { wordPractice: true })).status, 400)
  assert.equal((await groupPost(groupId, otherUser, 'x'.repeat(501), attemptBody)).status, 400)
  assert.equal((await request(`/api/groups/${groupId}/messages`, { text: 'Ein Satz.', ...attemptBody }, outsider.cookie)).status, 404)
  const attemptClientId = new ObjectId().toString()
  const attempt = await groupPost(groupId, otherUser, 'Der Baum sind groß.', { ...attemptBody, clientId: attemptClientId })
  assert.equal(attempt.status, 201)
  assert.equal(attempt.body.message.wordPractice, true)
  assert.equal((await request(`/api/groups/${groupId}/messages/${attempt.body.message.id}/edit`, { text: 'x'.repeat(501) }, other.cookie)).status, 400)
  assert.equal(attempt.body.message.replyTo.id, groupWordId)
  assert.equal((await groupPost(groupId, otherUser, 'Der Baum sind groß.', { ...attemptBody, clientId: attemptClientId })).status, 200)
  assert.equal(records.groupMessages.filter((message) => message._id.toString() === attemptClientId).length, 1)
  assert.equal((await groupPost(groupId, otherUser, 'Der Baum sind groß.', { replyToId: groupWordId, clientId: attemptClientId })).status, 409)
  assert.equal((await request(`/api/groups/${groupId}/messages/${attempt.body.message.id}/reviews`, { text: 'Der Baum ist groß.' }, learner.cookie)).status, 201)
  const revised = await groupPost(groupId, otherUser, 'Der Baum ist groß.', { wordPractice: true, replyToId: attempt.body.message.id })
  assert.equal(revised.status, 201)
  assert.equal(revised.body.message.wordPractice, true)
  assert.equal(revised.body.message.replyTo.id, attempt.body.message.id)
  assert.equal((await groupPost(groupId, learnerUser, 'Ein anderer Baum.', { wordPractice: true, replyToId: attempt.body.message.id })).status, 400)
  assert.equal((await groupPost(groupId, otherUser, 'Keine Wortkarte.', { wordPractice: true, replyToId: first.body.message.id })).status, 400)
  assert.equal(JSON.stringify(records.progress), practiceProgress)
  assert.equal((await request(`/api/groups/${groupId}/messages/${revised.body.message.id}/unsend`, {}, other.cookie)).status, 200)
  const removedAttempt = (await request(`/api/groups/${groupId}/messages/${revised.body.message.id}`, null, learner.cookie)).body.message
  assert.equal(removedAttempt.kind, 'unsent')
  assert.equal(removedAttempt.wordPractice, undefined)
  records.groupMessages = records.groupMessages.filter((item) => ![attempt.body.message.id, revised.body.message.id].includes(item._id.toString()))
  assert.equal((await request(`/api/groups/${groupId}/search?q=tree`, null, other.cookie)).body.messages[0].card.prompt, 'der Baum')
  assert.equal((await request(`/api/groups/${groupId}/messages/${sharedGroupWord.body.message.id}/edit`, { text: 'Change' }, learner.cookie)).status, 404)
  assert.equal((await request(`/api/groups/${groupId}/messages/${sharedGroupWord.body.message.id}/report`, { reason: 'other' }, other.cookie)).status, 201)
  assert.match(records.groupReports.find((item) => item.messageId === sharedGroupWord.body.message.id).messageText, /tree/)
  records.groupReports = records.groupReports.filter((item) => item.messageId !== sharedGroupWord.body.message.id)
  records.groupMessages = records.groupMessages.filter((item) => item._id.toString() !== sharedGroupWord.body.message.id)

  const reviewsPath = `${firstPath}/reviews`
  assert.equal((await request(reviewsPath, { approve: true }, outsider.cookie)).status, 404)
  assert.equal((await request(reviewsPath, { approve: true }, other.cookie)).status, 404)
  assert.equal((await request(reviewsPath, { text: 'Überprüfung', note: 'Test' }, learner.cookie)).status, 201)
  assert.equal((await request(reviewsPath, { approve: true }, third.cookie)).status, 201)
  assert.equal((await request(reviewsPath, { approve: true }, learner.cookie)).status, 409)
  assert.equal((await request(`${firstPath}/edit`, { text: 'Changed after review' }, other.cookie)).status, 409)
  const reviewResult = await request(`/api/groups/${groupId}/search?q=uberprufung`, null, fourth.cookie)
  assert.equal(reviewResult.body.messages[0].corrections.length, 2)
  assert.equal((await request(`${reviewsPath}/${learnerRecord._id}/respond`, { response: 'thanks' }, third.cookie)).status, 404)
  assert.equal((await request(`${reviewsPath}/${learnerRecord._id}/respond`, { response: 'thanks' }, other.cookie)).status, 200)
  const reviewReportPath = `${reviewsPath}/${learnerRecord._id}/report`
  assert.equal((await request(reviewReportPath, { reason: 'harassment' }, learner.cookie)).status, 404)
  assert.equal((await request(reviewReportPath, { reason: 'harassment' }, other.cookie)).status, 201)
  assert.equal((await request(reviewReportPath, { reason: 'harassment' }, other.cookie)).status, 409)
  assert.equal((await request(reviewReportPath, { reason: 'harassment' }, third.cookie)).status, 201)
  assert.equal((await request(reviewReportPath, { reason: 'harassment' }, fourth.cookie)).body.hidden, true)
  assert.equal((await request(`/api/groups/${groupId}/search?q=uberprufung`, null, fourth.cookie)).body.messages.length, 0)
  const reviewReports = records.groupReports.filter((item) => item.parentMessageId === first.body.message.id)
  assert.equal(reviewReports[0].reportedUserId, learnerRecord._id.toString())
  assert.equal((await request(`/api/moderation/reports/group/${reviewReports[0]._id}/resolve`, { action: 'hide' }, moderator.cookie)).status, 200)
  assert.equal(firstStored.hiddenAt, undefined)
  assert.ok(firstStored.corrections[learnerRecord._id.toString()].hiddenAt)
  records.groupReports = records.groupReports.filter((item) => !reviewReports.includes(item))

  const searchTime = Date.now() + 3000
  const searchable = Array.from({ length: 1032 }, (_, index) => ({
    _id: new ObjectId(), groupId, senderId: learnerRecord._id.toString(),
    text: index === 0 ? 'oldneedle' : index >= 1001 ? 'Überraschung' : 'different',
    createdAt: new Date(searchTime + index),
  }))
  records.groupMessages.push(...searchable)
  const searchMembership = records.groupMembers.find((member) => member.groupId === groupId && member.userId === otherUser.record._id.toString())
  const cursorBeforeSearch = searchMembership.readThrough
  const groupSearch = await request(`/api/groups/${groupId}/search?q=uberraschung`, null, other.cookie)
  assert.equal(groupSearch.status, 200)
  assert.equal(groupSearch.body.messages.length, 30)
  assert.equal(groupSearch.body.hasMore, true)
  assert.equal(groupSearch.body.messages[0].text, 'Überraschung')
  assert.equal(searchMembership.readThrough, cursorBeforeSearch)
  assert.equal((await request(`/api/groups/${groupId}/search?q=oldneedle`, null, learner.cookie)).body.messages.length, 0)
  records.groupMessages = records.groupMessages.filter((message) => !searchable.includes(message))

  const tieTime = new Date(Date.now() + 6000)
  const groupRecord = records.groups.find((item) => item._id.toString() === groupId)
  const oldNotices = groupRecord.nameChanges
  const tied = Array.from({ length: 60 }, (_, index) => ({
    _id: new ObjectId(), groupId, senderId: learnerRecord._id.toString(), text: `Tied ${index}`, createdAt: tieTime,
  }))
  records.groupMessages.push(...tied)
  groupRecord.nameChanges = Array.from({ length: 30 }, () => ({
    id: new ObjectId().toString(), actor: 'learner', name: 'Group', createdAt: tieTime,
  }))
  const noticesOnly = Array.from({ length: 50 }, () => ({
    id: new ObjectId().toString(), actor: 'learner', name: 'Group', createdAt: new Date(tieTime.getTime() + 1),
  }))
  groupRecord.nameChanges.push(...noticesOnly)
  const membership = records.groupMembers.find((member) => member.groupId === groupId && member.userId === fourth.id)
  const cursorBeforeNotices = membership.readThrough
  const noticePage = await request(`/api/groups/${groupId}/messages`, null, fourth.cookie)
  assert.ok(noticePage.body.messages.every((message) => message.kind === 'system'))
  assert.equal(membership.readThrough, cursorBeforeNotices)
  groupRecord.nameChanges = groupRecord.nameChanges.filter((notice) => !noticesOnly.includes(notice))
  const tiePage = (await request(`/api/groups/${groupId}/messages`, null, learner.cookie)).body
  const tieOldest = tiePage.messages[0]
  const nextTiePage = (await request(`/api/groups/${groupId}/messages?before=${encodeURIComponent(tieOldest.createdAt)}&beforeId=${tieOldest.id}`, null, learner.cookie)).body
  const ids = [...tiePage.messages, ...nextTiePage.messages].map((message) => message.id)
  assert.equal(new Set(ids).size, ids.length)
  assert.ok(tied.every((message) => ids.includes(message._id.toString())))
  assert.equal((await request(`/api/groups/${groupId}/messages?beforeId=bad`, null, learner.cookie)).status, 400)
  records.groupMessages = records.groupMessages.filter((message) => !tied.includes(message))
  groupRecord.nameChanges = oldNotices

  assert.equal((await request('/api/moderation/reports', null, learner.cookie)).status, 404)
  const safetyPath = `/api/groups/${groupId}/messages`
  const linked = await groupPost(groupId, learnerUser, 'https://example.com/learning')
  assert.equal(linked.status, 201)
  assert.equal(linked.body.message.kind, 'text')
  assert.equal(linked.body.message.hasLinks, true)
  const safetyClientId = new ObjectId().toString()
  const held = await groupPost(groupId, learnerUser, 'You asshole @Companion', { clientId: safetyClientId })
  assert.equal(held.status, 201)
  assert.equal(held.body.message.kind, 'hidden')
  assert.match(held.body.message.text, /Hidden pending review/)
  assert.doesNotMatch(JSON.stringify(held.body), /asshole|@Companion/)
  assert.equal((await groupPost(groupId, learnerUser, 'You asshole @Companion', { clientId: safetyClientId })).status, 200)
  records.groupReports = records.groupReports.filter((item) => item.messageId !== held.body.message.id)
  assert.equal((await request(`${safetyPath}/${held.body.message.id}`, null, other.cookie)).body.message.kind, 'hidden')
  const safetyReport = records.groupReports.find((item) => item.messageId === held.body.message.id && item.automatic)
  assert.ok(safetyReport)
  assert.equal(records.groupReports.filter((item) => item.messageId === held.body.message.id && item.automatic).length, 1)
  assert.doesNotMatch(JSON.stringify((await request(`${safetyPath}/${held.body.message.id}`, null, other.cookie)).body), /asshole/)
  assert.equal((await request(`/api/groups/${groupId}/search?q=asshole`, null, other.cookie)).body.messages.length, 0)
  assert.doesNotMatch(JSON.stringify((await request('/api/groups', null, other.cookie)).body), /asshole/)
  const safetyResolve = `/api/moderation/reports/group/${safetyReport._id}/resolve`
  assert.equal((await request(safetyResolve, { action: 'approve', expectedAt: safetyReport.createdAt.toISOString() }, learner.cookie)).status, 404)
  assert.equal((await request(safetyResolve, { action: 'approve', expectedAt: 'stale' }, moderator.cookie)).status, 409)
  assert.equal((await request(safetyResolve, { action: 'dismiss' }, moderator.cookie)).status, 400)
  const safetySocket = await connectSocket(other.cookie)
  assert.deepEqual(await socketCall(safetySocket, 'subscribe', { kind: 'group', id: groupId }), { ok: true })
  const restoredLive = new Promise((resolve, reject) => {
    const handler = (snapshot) => {
      const restored = snapshot.page?.messages.find((item) => item.id === held.body.message.id && item.kind === 'text')
      if (restored) { clearTimeout(timer); safetySocket.off('snapshot', handler); resolve(restored) }
    }
    const timer = setTimeout(() => { safetySocket.off('snapshot', handler); reject(new Error('Restored group content was not delivered live')) }, 3000)
    safetySocket.on('snapshot', handler)
  })
  assert.equal((await request(safetyResolve, { action: 'approve', expectedAt: safetyReport.createdAt.toISOString() }, moderator.cookie)).status, 200)
  assert.equal((await restoredLive).text, 'You asshole @Companion')
  safetySocket.disconnect()
  assert.equal((await request(`${safetyPath}/${held.body.message.id}`, null, other.cookie)).body.message.text, 'You asshole @Companion')
  const languageReportPath = `${safetyPath}/${held.body.message.id}/report`
  assert.equal((await request(languageReportPath, { reason: 'inappropriate' }, other.cookie)).status, 201)
  assert.equal((await request(languageReportPath, { reason: 'inappropriate' }, third.cookie)).status, 201)
  assert.equal((await request(`${safetyPath}/${held.body.message.id}`, null, learner.cookie)).body.message.kind, 'text')
  assert.equal((await request(languageReportPath, { reason: 'inappropriate' }, fourth.cookie)).status, 201)
  assert.equal((await request(`${safetyPath}/${held.body.message.id}`, null, learner.cookie)).body.message.kind, 'hidden')
  const humanReport = records.groupReports.find((item) => item.messageId === held.body.message.id && !item.automatic)
  assert.equal((await request(`/api/moderation/reports/group/${humanReport._id}/resolve`, { action: 'hide' }, moderator.cookie)).status, 200)
  const editable = await groupPost(groupId, learnerUser, 'Eine Frage zur Wortwahl.')
  const quoted = await groupPost(groupId, otherUser, 'Welche Frage?', { replyToId: editable.body.message.id })
  const changed = await request(`${safetyPath}/${editable.body.message.id}/edit`, { text: 'Ein Arschloch.' }, learner.cookie)
  assert.equal(changed.body.message.kind, 'hidden')
  assert.doesNotMatch((await request(`${safetyPath}/${quoted.body.message.id}`, null, other.cookie)).body.message.replyTo.text, /Arschloch/)
  const editReport = records.groupReports.find((item) => item.messageId === editable.body.message.id && item.automatic)
  assert.equal((await request(`/api/moderation/reports/group/${editReport._id}/resolve`, { action: 'hide' }, moderator.cookie)).status, 200)
  delete learnerRecord.lastGroupPostAt
  const heldCard = await request(safetyPath, { card: { prompt: 'Baum', category: 'noun', article: 'der', meaning: 'tree', example: 'You asshole.' } }, learner.cookie)
  assert.equal(heldCard.body.message.kind, 'hidden')
  assert.equal(heldCard.body.message.card, undefined)
  const cardReport = records.groupReports.find((item) => item.messageId === heldCard.body.message.id && item.automatic)
  assert.equal((await request(`/api/moderation/reports/group/${cardReport._id}/resolve`, { action: 'hide' }, moderator.cookie)).status, 200)
  const suggestionTarget = await groupPost(groupId, otherUser, 'Der Baum sind groß.')
  const heldSuggestion = await request(`${safetyPath}/${suggestionTarget.body.message.id}/reviews`, { text: 'Der Baum ist groß.', note: 'You asshole.' }, learner.cookie)
  assert.equal(heldSuggestion.status, 201)
  assert.equal(heldSuggestion.body.message.heldReview, true)
  assert.equal(heldSuggestion.body.message.corrections.length, 0)
  assert.doesNotMatch(JSON.stringify(heldSuggestion.body), /asshole/)
  const reviewSafetyReport = records.groupReports.find((item) => item.parentMessageId === suggestionTarget.body.message.id && item.automatic)
  assert.equal((await request(`/api/moderation/reports/group/${reviewSafetyReport._id}/resolve`, { action: 'approve', expectedAt: reviewSafetyReport.createdAt.toISOString() }, moderator.cookie)).status, 200)
  assert.equal((await request(`${safetyPath}/${suggestionTarget.body.message.id}`, null, other.cookie)).body.message.corrections.length, 1)
  const withdrawn = await groupPost(groupId, learnerUser, 'Was bedeutet asshole?')
  const withdrawnReport = records.groupReports.find((item) => item.messageId === withdrawn.body.message.id && item.automatic)
  assert.equal((await request(`${safetyPath}/${withdrawn.body.message.id}/unsend`, {}, learner.cookie)).status, 200)
  assert.equal((await request(`/api/moderation/reports/group/${withdrawnReport._id}/resolve`, { action: 'approve', expectedAt: withdrawnReport.createdAt.toISOString() }, moderator.cookie)).status, 409)
  assert.equal((await request(`/api/moderation/reports/group/${withdrawnReport._id}/resolve`, { action: 'hide' }, moderator.cookie)).status, 200)
  for (const id of [linked, held, editable, quoted, heldCard, suggestionTarget, withdrawn].map((item) => item.body.message.id)) {
    records.groupMessages = records.groupMessages.filter((item) => item._id.toString() !== id)
  }
  const queue = await request('/api/moderation/reports', null, moderator.cookie)
  assert.equal(queue.status, 200)
  const groupReport = queue.body.reports.find((item) => item.kind === 'group')
  assert.equal(groupReport.group, 'Anfänger Treff')
  assert.equal(groupReport.reported.username, 'Companion')
  assert.equal(groupReport.messageText, 'Buy cheap followers')
  const privateReport = queue.body.reports.find((item) => item.kind === 'private')
  assert.ok(privateReport)
  assert.equal((await request(`/api/moderation/reports/private/${privateReport.id}/resolve`, { action: 'hide' }, moderator.cookie)).status, 400)
  assert.equal((await request(`/api/moderation/reports/private/${privateReport.id}/resolve`, { action: 'dismiss' }, moderator.cookie)).status, 200)
  assert.equal((await request(`/api/moderation/reports/group/${groupReport.id}/resolve`, { action: 'suspend' }, moderator.cookie)).status, 400)
  assert.equal((await request(`/api/moderation/reports/group/${groupReport.id}/resolve`, { action: 'suspend', days: 3 }, learner.cookie)).status, 404)
  const longerSuspension = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
  companion.groupsSuspendedUntil = longerSuspension
  assert.equal((await request(`/api/moderation/reports/group/${groupReport.id}/resolve`, { action: 'suspend', days: 3 }, moderator.cookie)).status, 200)
  assert.equal(companion.groupsSuspendedUntil.getTime(), longerSuspension.getTime())
  assert.equal((await request(`/api/moderation/reports/group/${groupReport.id}/resolve`, { action: 'dismiss' }, moderator.cookie)).status, 404)
  assert.equal((await request('/api/moderation/reports', null, moderator.cookie)).body.reports.length, 0)
  assert.ok(records.groupReports.every((item) => item.status === 'resolved' && item.deleteAfter > new Date()))
  const suspended = await groupPost(groupId, otherUser, 'Noch einmal')
  assert.equal(suspended.status, 403)
  assert.equal(suspended.body.code, 'suspended')
  assert.ok((await request('/api/groups', null, other.cookie)).body.suspendedUntil)
  assert.equal((await request(`/api/groups/${groupId}/messages`, null, other.cookie)).status, 200)

  assert.equal((await request(`/api/groups/${groupId}/members/remove`, { id: third.id }, other.cookie)).status, 404)
  assert.equal((await request(`/api/groups/${groupId}/members/remove`, { id: learnerRecord._id.toString() }, learner.cookie)).status, 409)
  assert.equal((await request(`/api/groups/${groupId}/members/remove`, { id: third.id }, learner.cookie)).status, 200)
  assert.equal((await request(`/api/groups/${groupId}/messages`, null, third.cookie)).status, 404)
  assert.equal((await request(`/api/groups/${groupId}/join`, {}, third.cookie)).status, 403)
  assert.equal((await request(visibilityPath, { visibility: 'unlisted' }, learner.cookie)).status, 200)
  const removedInvite = (await request(`/api/groups/${groupId}/invitation`, null, learner.cookie)).body.inviteToken
  assert.equal((await request('/api/groups/invitation/resolve', { inviteToken: removedInvite }, third.cookie)).status, 404)
  assert.equal((await request(`/api/groups/${groupId}/join`, { inviteToken: removedInvite }, third.cookie)).status, 403)
  assert.equal((await request(visibilityPath, { visibility: 'listed' }, learner.cookie)).status, 200)
  const members = await request(`/api/groups/${groupId}/members`, null, learner.cookie)
  assert.deepEqual(members.body.members.map((item) => item.username), ['learner', 'Companion', 'Fourth'])
  assert.equal(members.body.canRemove, true)
  assert.equal((await request(`/api/groups/${groupId}/leave`, {}, learner.cookie)).status, 409)
  assert.equal((await request(`/api/groups/${groupId}/leave`, {}, fourth.cookie)).status, 200)
  assert.equal((await request('/api/groups', null, learner.cookie)).body.groups.find((item) => item.id === groupId).memberCount, 2)

  const renamePath = `/api/groups/${groupId}/name`
  const detailsPath = `/api/groups/${groupId}/details`
  assert.equal((await request(`/api/groups/${groupId}/info`, null, outsider.cookie)).status, 404)
  const info = await request(`/api/groups/${groupId}/info`, null, other.cookie)
  assert.equal(info.body.messageCount, records.groupMessages.filter((item) =>
    item.groupId === groupId && !item.unsentAt && !item.hiddenAt).length)
  assert.equal((await request(detailsPath, { name: 'Anfänger Treff', description: 'No' }, other.cookie)).status, 404)
  assert.equal((await request(detailsPath, { name: 'Anfänger Treff', description: 'x'.repeat(201) }, learner.cookie)).status, 400)
  assert.equal((await request(detailsPath, { name: 'Anfänger Treff', description: '  Study together  ' }, learner.cookie)).status, 200)
  assert.equal((await request('/api/groups', null, other.cookie)).body.groups.find((item) => item.id === groupId).description, 'Study together')
  assert.equal((await request(`/api/groups/${groupId}/messages`, null, learner.cookie)).body.messages.filter((item) => item.kind === 'system').length, 0)
  assert.equal((await request(detailsPath, { name: 'Anfänger Treff', description: '' }, learner.cookie)).status, 200)
  assert.equal((await request('/api/groups', null, other.cookie)).body.groups.find((item) => item.id === groupId).description, '')
  assert.equal((await request(renamePath, { name: 'New name' }, other.cookie)).status, 404)
  assert.equal((await request(renamePath, { name: 'ab' }, learner.cookie)).status, 400)
  assert.equal((await request(renamePath, { name: 'zweite gruppe' }, learner.cookie)).status, 409)
  assert.equal((await request(renamePath, { name: 'Anfänger Treff' }, learner.cookie)).status, 200)
  assert.equal((await request(`/api/groups/${groupId}/messages`, null, learner.cookie)).body.messages.filter((item) => item.kind === 'system').length, 0)
  assert.equal((await request(detailsPath, { name: '  Deutsch   zusammen  ', description: 'Learning together' }, learner.cookie)).status, 200)
  const updatedGroup = (await request('/api/groups', null, other.cookie)).body.groups.find((item) => item.id === groupId)
  assert.equal(updatedGroup.name, 'Deutsch zusammen')
  assert.equal(updatedGroup.description, 'Learning together')
  const notice = (await request(`/api/groups/${groupId}/messages`, null, other.cookie)).body.messages.find((item) => item.kind === 'system')
  assert.equal(notice.text, 'learner changed the group name to Deutsch zusammen.')
  assert.equal((await request(`/api/groups/${groupId}/messages/${notice.id}/unsend`, {}, learner.cookie)).status, 404)
  assert.equal((await request(detailsPath, { name: 'Deutsch zusammen', description: 'Practice' }, moderator.cookie)).status, 200)
  assert.equal((await request('/api/groups', null, other.cookie)).body.groups.find((item) => item.id === groupId).description, 'Practice')
  for (let index = 0; index < 55; index++) {
    records.groupMessages.push({
      _id: new ObjectId(), groupId, senderId: otherId, text: `Later message ${index}`,
      createdAt: new Date(Date.now() + (index + 1) * 1000),
    })
  }
  const recentPage = (await request(`/api/groups/${groupId}/messages`, null, other.cookie)).body
  assert.equal(recentPage.hasMore, true)
  assert.equal(recentPage.messages.length, 50)
  const earlierPage = (await request(`/api/groups/${groupId}/messages?before=${encodeURIComponent(recentPage.messages[0].createdAt)}`, null, other.cookie)).body
  assert.ok(earlierPage.messages.some((item) => item.id === notice.id && item.kind === 'system'))

  assert.equal((await request(`/api/groups/${groupId}/delete`, {}, other.cookie)).status, 404)
  assert.equal((await request(`/api/groups/${groupId}/delete`, {}, learner.cookie)).status, 200)
  assert.equal((await request(`/api/groups/${groupId}/messages`, null, learner.cookie)).status, 404)
  assert.equal(records.groupMessages.filter((item) => item.groupId === groupId).length, 0)
  assert.equal((await request('/api/groups', { name: 'Neue Gruppe' }, learner.cookie)).status, 201)
  assert.equal((await request(`/api/groups/${thirdGroup.body.group.id}/delete`, {}, moderator.cookie)).status, 200)
  const concurrentCreates = await Promise.all(Array.from({ length: 5 }, (_, index) =>
    request('/api/groups', { name: `Concurrent ${index}` }, fourth.cookie)))
  assert.equal(concurrentCreates.filter((result) => result.status === 201).length, 3)
  assert.equal(records.groups.filter((item) => item.ownerId === fourth.id).length, 3)

  console.log('Account API integration passed')
} finally {
  for (const socket of sockets) socket.disconnect()
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  mock.reset()
}
