import { createOptionalVoiceRouter } from './optionalVoice.js'
import bcrypt from 'bcryptjs'
import MongoStore from 'connect-mongo'
import dotenv from 'dotenv'
import express from 'express'
import { createServer } from 'node:http'
import { createChatSocket } from './chatSocket.js'
import { rateLimit } from 'express-rate-limit'
import helmet from 'helmet'
import { MongoClient, ObjectId } from 'mongodb'
import session from 'express-session'
import { z } from 'zod'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildMongoConnectionString } from './mongoConfig.js'
import { createAccountMailer } from './accountMail.js'
import { accountAvatarPng } from './accountAvatar.js'
import { createAccountSecurity } from './accountSecurity.js'
import { createCompanionRouter } from './companions.js'
import { createChatReplay } from './chatReplay.js'
import { createChatLiveHub } from './chatLive.js'
import {
  createGroupsRouter, createModerationRouter, createModeratorCheck, groupRetention,
} from './groups.js'

const isLocalDevelopment = process.argv.includes('--local')
const envFile = dotenv.config()
const configuration = isLocalDevelopment ? envFile.parsed ?? {} : process.env
const mongoConnectionString = buildMongoConnectionString(configuration)

const app = express()
export const server = createServer(app)
let sessionMiddleware
const port = Number(process.env.PORT ?? configuration.PORT ?? 3001)
const databaseName = 'deutsch'
const sessionCookieName = 'deutsch.sid'
const sessionLifetimeMs = 30 * 24 * 60 * 60 * 1000
const secureCookies = process.env.NODE_ENV === 'production' && !isLocalDevelopment
const rootPath = resolve(dirname(fileURLToPath(import.meta.url)), '..')

app.disable('x-powered-by')
app.set('trust proxy', process.env.TRUST_PROXY === '1' ? 1 : false)
app.use(helmet({ contentSecurityPolicy: false }))
app.use(express.json({ limit: '20mb' }))

const isoDate = z.string().refine((value) => Number.isFinite(Date.parse(value)))
const activityDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
})
const reviewSchema = z.object({
  at: isoDate,
  rating: z.enum(['again', 'hard', 'good', 'easy']),
  intervalDays: z.number().finite(),
  easeFactor: z.number().finite(),
  mode: z.enum(['recall', 'choice', 'production']).optional(),
  answerCorrect: z.boolean().optional(),
  struggledWith: z.array(z.enum(['article', 'plural', 'meaning', 'context'])).optional(),
}).passthrough()

const cardSchema = z.object({
  id: z.string().min(1).max(200),
  prompt: z.string().max(500),
  article: z.string().max(50).optional(),
  meaning: z.string().max(1000),
  plural: z.string().max(500).optional(),
  pluralUpdatedAt: isoDate.optional(),
  acceptedAnswers: z.array(z.string().trim().min(1).max(200)).max(10).optional(),
  acceptedAnswersUpdatedAt: isoDate.optional(),
  example: z.string().max(2000),
  translation: z.string().max(2000).optional(),
  category: z.string().min(1).max(50),
  tags: z.array(z.string().max(100)).max(100),
  status: z.enum(['active', 'archived']),
  dueAt: isoDate,
  intervalDays: z.number().finite(),
  repetitions: z.number().finite(),
  easeFactor: z.number().finite(),
  lapses: z.number().finite(),
  lastReviewedAt: isoDate.nullable(),
  lastRating: z.enum(['again', 'hard', 'good', 'easy']).nullable(),
  correctCount: z.number().finite(),
  incorrectCount: z.number().finite(),
  reviewHistory: z.array(reviewSchema).max(10000),
  activity: z.object({ added: z.array(activityDay).max(10000), reviewed: z.array(activityDay).max(10000) }).optional(),
  reviewResetAt: isoDate.optional(),
  firstReviewScheduledAt: isoDate.optional(),
  learning: z.object({ saved: z.boolean(), updatedAt: isoDate }).optional(),
  sharedFrom: z.object({
    shareId: z.string().max(64),
    username: z.string().max(20),
    sharedAt: isoDate,
    note: z.string().max(240).optional(),
  }).optional(),
  createdAt: isoDate,
  updatedAt: isoDate,
}).passthrough().superRefine((card, ctx) => {
  if (card.category === 'noun' && card.acceptedAnswers?.some((answer) => !/^(der|die|das)\s+\S/i.test(answer))) {
    ctx.addIssue({ code: 'custom', path: ['acceptedAnswers'], message: 'Noun alternatives require an article.' })
  }
})

const studyPlanSchema = z.object({
  currentLevel: z.enum(['unknown', 'A0', 'A1', 'A2', 'B1']),
  targetLevel: z.enum(['A1', 'A2', 'B1', 'B2']),
  targetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
    const [year, month, day] = value.split('-').map(Number)
    const date = new Date(Date.UTC(year, month - 1, day))
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  }),
  intensity: z.enum(['steady', 'focused', 'intensive']),
})

const progressSchema = z.object({
  cards: z.array(cardSchema).max(10000),
  studyPlan: studyPlanSchema,
  studyPlanUpdatedAt: isoDate.optional(),
  expectedRevision: z.number().int().nonnegative(),
})

const credentialsSchema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(10).max(128),
})

const usernameSchema = z.string().trim()
  .min(3, 'Username must be at least 3 characters.')
  .max(20, 'Username must be no more than 20 characters.')
  .regex(/^[A-Za-z0-9_-]+$/, 'Username can use only letters, numbers, underscores, or hyphens; it cannot be an email address.')

const registrationSchema = credentialsSchema.extend({
  username: usernameSchema,
  avatarSeed: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/).optional(),
})

const profileSchema = z.object({
  username: usernameSchema,
  avatarSeed: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/),
})

const emailSchema = z.object({ email: credentialsSchema.shape.email })
const codeSchema = emailSchema.extend({ code: z.string().regex(/^\d{6}$/) })
const resetSchema = codeSchema.extend({ password: credentialsSchema.shape.password })
const changePasswordSchema = z.object({
  currentPassword: credentialsSchema.shape.password,
  password: credentialsSchema.shape.password,
})

const publicUser = (user) => ({
  id: user._id.toString(),
  username: user.username,
  email: user.email,
  avatarSeed: user.avatarSeed,
  emailVerified: Boolean(user.emailVerifiedAt),
})

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many sign-in attempts. Please wait a few minutes and try again.' },
})
const codeRequestLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many code requests. Please wait a few minutes and try again.' },
})
const codeAttemptLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please wait a few minutes and try again.' },
})

let client
let users
let progress
let relationships
let sharedWords
let conversations
let companionMessages
let companionReports
let practiceSessions
let groups
let groupMembers
let groupMessages
let groupReports
let chatTyping
let chatLive
let chatReplay
let accountSecurity
const accountMailer = createAccountMailer(configuration)

const requireDatabase = (_req, res, next) => {
  if (!users || !progress) {
    return res.status(503).json({ error: 'Account storage is not configured. Set the MongoDB settings in .env.' })
  }
  next()
}

const regenerateSession = (req) =>
  new Promise((resolvePromise, rejectPromise) => {
    req.session.regenerate((error) => error ? rejectPromise(error) : resolvePromise())
  })

const saveSession = (req) =>
  new Promise((resolvePromise, rejectPromise) => {
    req.session.save((error) => error ? rejectPromise(error) : resolvePromise())
  })

const requireUser = async (req, res, next) => {
  if (!ObjectId.isValid(req.session?.userId ?? '')) {
    return res.status(401).json({ error: 'Sign in to continue.' })
  }

  const user = await users.findOne(
    { _id: new ObjectId(req.session.userId) },
    { projection: { email: 1, username: 1, avatarSeed: 1, emailVerifiedAt: 1, sessionVersion: 1 } },
  )
  if (!user || (user.sessionVersion ?? 0) !== (req.session.sessionVersion ?? 0)) {
    req.session.destroy(() => {})
    return res.status(401).json({ error: 'Your session has expired. Please sign in again.' })
  }

  req.accountUser = user
  next()
}

const sendValidationError = (res, result) =>
  res.status(400).json({ error: result.error.issues[0]?.message ?? 'Check the submitted details.' })

app.get('/api/health', (_req, res) => {
  res.json({ accountStorageConfigured: Boolean(users && progress) })
})

app.use('/api', requireDatabase)

if (mongoConnectionString) {
  if (!configuration.SESSION_SECRET || configuration.SESSION_SECRET.length < 32) {
    throw new Error('SESSION_SECRET must contain at least 32 characters when MongoDB is configured.')
  }

  client = new MongoClient(mongoConnectionString)
  try {
    await client.connect()
  } catch {
    throw new Error('MongoDB connection failed. Check the MongoDB settings and Atlas network access.')
  }

  const db = client.db(databaseName)
  users = db.collection('users')
  progress = db.collection('progress')
  relationships = db.collection('relationships')
  sharedWords = db.collection('sharedWords')
  conversations = db.collection('companionConversations')
  companionMessages = db.collection('companionMessages')
  companionReports = db.collection('companionReports')
  practiceSessions = db.collection('practiceSessions')
  groups = db.collection('groups')
  groupMembers = db.collection('groupMembers')
  groupMessages = db.collection('groupMessages')
  groupReports = db.collection('groupReports')
  chatTyping = db.collection('chatTyping')
  chatLive = createChatLiveHub(db)
  const topology = await db.admin().command({ hello: 1 })
  chatReplay = topology.setName || topology.msg === 'isdbgrid'
    ? createChatReplay(db, configuration.SESSION_SECRET) : null
  const existingGroups = await groups.find({}).toArray()
  const slotsByOwner = new Map()
  for (const group of existingGroups) {
    const slots = slotsByOwner.get(group.ownerId) ?? new Set()
    if (Number.isInteger(group.ownerSlot) && group.ownerSlot >= 0 && group.ownerSlot < 3) {
      if (slots.has(group.ownerSlot)) throw new Error('Duplicate group ownership slot; resolve group data before starting.')
      slots.add(group.ownerSlot)
    }
    slotsByOwner.set(group.ownerId, slots)
  }
  for (const group of existingGroups) {
    if (Number.isInteger(group.ownerSlot) && group.ownerSlot >= 0 && group.ownerSlot < 3) continue
    const slots = slotsByOwner.get(group.ownerId)
    const slot = [0, 1, 2].find((candidate) => !slots.has(candidate))
    if (slot === undefined) throw new Error('An account owns more than three groups; resolve group data before starting.')
    await groups.updateOne({ _id: group._id }, { $set: { ownerSlot: slot } })
    slots.add(slot)
  }
  accountSecurity = createAccountSecurity({
    users,
    secret: configuration.SESSION_SECRET,
    mailer: accountMailer,
    renderAvatar: accountAvatarPng,
  })
  await Promise.all([
    users.createIndex({ emailKey: 1 }, { unique: true }),
    users.createIndex({ usernameKey: 1 }, { unique: true }),
    progress.createIndex({ userId: 1 }, { unique: true }),
    relationships.createIndex({ pairKey: 1 }, { unique: true }),
    relationships.createIndex({ participants: 1 }),
    sharedWords.createIndex({ recipientId: 1, state: 1, createdAt: -1 }),
    sharedWords.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    conversations.createIndex({ pairKey: 1, connectionId: 1 }, { unique: true }),
    conversations.createIndex({ participants: 1, updatedAt: -1 }),
    companionMessages.createIndex({ conversationId: 1, createdAt: 1, _id: 1 }),
    companionReports.createIndex({ reporterId: 1, messageId: 1 }, { unique: true }),
    companionReports.createIndex({ createdAt: -1 }),
    companionReports.createIndex({ deleteAfter: 1 }, { expireAfterSeconds: 0 }),
    practiceSessions.createIndex({ conversationId: 1, status: 1, updatedAt: -1 }),
    practiceSessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    groups.createIndex({ nameKey: 1 }, { unique: true }),
    groups.createIndex({ ownerId: 1 }),
    groups.createIndex({ ownerId: 1, ownerSlot: 1 }, { unique: true }),
    groups.createIndex({ lastActivityAt: -1 }),
    groupMembers.createIndex({ groupId: 1, userId: 1 }, { unique: true }),
    groupMembers.createIndex({ userId: 1, state: 1 }),
    groupMessages.createIndex({ groupId: 1, createdAt: 1, _id: 1 }),
    groupMessages.createIndex({ groupId: 1, mentionUserIds: 1, createdAt: -1, _id: -1 }),
    groupMessages.createIndex({ createdAt: 1 }, { expireAfterSeconds: groupRetention.groupMessageRetention / 1000 }),
    groupReports.createIndex({ reporterId: 1, messageId: 1 }, { unique: true }),
    groupReports.createIndex({ createdAt: -1 }),
    groupReports.createIndex({ deleteAfter: 1 }, { expireAfterSeconds: 0 }),
    chatTyping.createIndex({ kind: 1, chatId: 1, userId: 1 }, { unique: true }),
    chatTyping.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
  ])

  sessionMiddleware = session({
    name: sessionCookieName,
    secret: configuration.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({
      client,
      dbName: databaseName,
      collectionName: 'sessions',
      ttl: sessionLifetimeMs / 1000,
    }),
    cookie: {
      httpOnly: true,
      secure: secureCookies,
      sameSite: 'lax',
      maxAge: sessionLifetimeMs,
      path: '/',
    },
  })
  app.use(sessionMiddleware)
} else {
  console.warn('MongoDB settings are empty; account endpoints will return a configuration error.')
}

app.post('/api/auth/register', authLimiter, async (req, res) => {
  const result = registrationSchema.safeParse(req.body)
  if (!result.success) return sendValidationError(res, result)

  if (Buffer.byteLength(result.data.password, 'utf8') > 72) {
    return res.status(400).json({ error: 'Password must be 72 bytes or less.' })
  }
  if (!accountMailer.configured) return res.status(503).json({ error: 'Account email is not configured. Please try again later.' })

  const email = result.data.email.toLowerCase()
  const username = result.data.username
  const timestamp = new Date()
  const user = {
    email,
    emailKey: email,
    username,
    usernameKey: username.toLowerCase(),
    passwordHash: await bcrypt.hash(result.data.password, 12),
    avatarSeed: result.data.avatarSeed ?? username,
    createdAt: timestamp,
    updatedAt: timestamp,
    verificationRequired: true,
  }

  try {
    const inserted = await users.insertOne(user)
    try {
      await accountSecurity.sendCode({ ...user, _id: inserted.insertedId }, 'verify')
    } catch {
      console.error('Account verification email could not be sent.')
      return res.status(503).json({ error: 'Account created, but the code could not be sent. Please request another code.', verificationRequired: true })
    }
    res.status(201).json({ verificationRequired: true })
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(409).json({ error: 'That email or username is already in use.' })
    }
    throw error
  }
})

app.post('/api/auth/login', authLimiter, async (req, res) => {
  const result = credentialsSchema.safeParse(req.body)
  if (!result.success) return sendValidationError(res, result)
  if (Buffer.byteLength(result.data.password, 'utf8') > 72) {
    return res.status(400).json({ error: 'Email or password is incorrect.' })
  }

  const user = await users.findOne({ emailKey: result.data.email.toLowerCase() })
  if (!user || !(await bcrypt.compare(result.data.password, user.passwordHash))) {
    return res.status(401).json({ error: 'Email or password is incorrect.' })
  }
  if (user.verificationRequired && !user.emailVerifiedAt) {
    return res.status(403).json({ error: 'Verify your email before signing in.', verificationRequired: true })
  }

  await regenerateSession(req)
  req.session.userId = user._id.toString()
  req.session.sessionVersion = user.sessionVersion ?? 0
  await saveSession(req)
  res.json({ user: publicUser(user) })
})

app.get('/api/auth/me', async (req, res) => {
  if (!ObjectId.isValid(req.session?.userId ?? '')) return res.status(401).json({ error: 'Not signed in.' })
  const user = await users.findOne(
    { _id: new ObjectId(req.session.userId) },
    { projection: { email: 1, username: 1, avatarSeed: 1, emailVerifiedAt: 1, sessionVersion: 1 } },
  )
  if (!user || (user.sessionVersion ?? 0) !== (req.session.sessionVersion ?? 0)) return res.status(401).json({ error: 'Not signed in.' })
  res.json({ user: publicUser(user) })
})

app.post('/api/auth/code', codeRequestLimiter, async (req, res) => {
  const result = emailSchema.extend({ purpose: z.enum(['verify', 'reset']) }).safeParse(req.body)
  if (!result.success) return sendValidationError(res, result)
  if (!accountMailer.configured) return res.status(503).json({ error: 'Account email is not configured. Please try again later.' })
  const user = await users.findOne({ emailKey: result.data.email.toLowerCase() })
  if (user && (result.data.purpose === 'reset' || !user.emailVerifiedAt)) {
    accountSecurity.sendCode(user, result.data.purpose).catch(() => {
      console.error('Account email could not be sent.')
    })
  }
  res.status(202).json({ ok: true })
})

app.post('/api/auth/verify', codeAttemptLimiter, async (req, res) => {
  const result = codeSchema.safeParse(req.body)
  if (!result.success) return sendValidationError(res, result)
  const user = await users.findOne({ emailKey: result.data.email.toLowerCase() })
  if (!user || !await accountSecurity.consumeCode(user, 'verify', result.data.code, {
    set: { emailVerifiedAt: new Date(), verificationRequired: false },
  })) return res.status(400).json({ error: 'This code is invalid or expired. Request a new code and try again.' })
  res.json({ ok: true })
})

app.post('/api/auth/reset-password', codeAttemptLimiter, async (req, res) => {
  const result = resetSchema.safeParse(req.body)
  if (!result.success) return sendValidationError(res, result)
  if (Buffer.byteLength(result.data.password, 'utf8') > 72) return res.status(400).json({ error: 'Password must be 72 bytes or less.' })
  const passwordHash = await bcrypt.hash(result.data.password, 12)
  const user = await users.findOne({ emailKey: result.data.email.toLowerCase() })
  if (!user || !await accountSecurity.consumeCode(user, 'reset', result.data.code, {
    set: { passwordHash },
    inc: { sessionVersion: 1 },
  })) return res.status(400).json({ error: 'This code is invalid or expired. Request a new code and try again.' })
  res.json({ ok: true })
})

app.post('/api/auth/change-password', requireUser, codeAttemptLimiter, async (req, res) => {
  const result = changePasswordSchema.safeParse(req.body)
  if (!result.success) return sendValidationError(res, result)
  if (Buffer.byteLength(result.data.password, 'utf8') > 72 || Buffer.byteLength(result.data.currentPassword, 'utf8') > 72) {
    return res.status(400).json({ error: 'Passwords must be 72 bytes or less.' })
  }
  const user = await users.findOne({ _id: req.accountUser._id })
  if (!user || !await bcrypt.compare(result.data.currentPassword, user.passwordHash)) {
    return res.status(400).json({ error: 'Your current password is incorrect.' })
  }
  const updated = await users.updateOne({ _id: user._id, passwordHash: user.passwordHash }, {
    $set: { passwordHash: await bcrypt.hash(result.data.password, 12), updatedAt: new Date() },
    $inc: { sessionVersion: 1 },
    $unset: { 'otp.reset': '' },
  })
  if (!updated.modifiedCount) return res.status(409).json({ error: 'Your account changed. Please sign in again.' })
  req.session.sessionVersion = (user.sessionVersion ?? 0) + 1
  await saveSession(req)
  res.json({ ok: true })
})

app.post('/api/auth/logout', async (req, res) => {
  if (req.session) {
    await new Promise((resolvePromise, rejectPromise) => {
      req.session.destroy((error) => error ? rejectPromise(error) : resolvePromise())
    })
  }
  res.clearCookie(sessionCookieName, {
    httpOnly: true,
    secure: secureCookies,
    sameSite: 'lax',
    path: '/',
  })
  res.json({ ok: true })
})

app.patch('/api/auth/profile', requireUser, async (req, res) => {
  const result = profileSchema.safeParse(req.body)
  if (!result.success) return sendValidationError(res, result)

  const username = result.data.username
  try {
    await users.updateOne(
      { _id: req.accountUser._id },
      {
        $set: {
          username,
          usernameKey: username.toLowerCase(),
          avatarSeed: result.data.avatarSeed,
          updatedAt: new Date(),
        },
      },
    )
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(409).json({ error: 'That username is already in use.' })
    }
    throw error
  }

  res.json({
    user: publicUser({ ...req.accountUser, ...result.data, username }),
  })
})

if (relationships) {
  const companionRouter = createCompanionRouter({
    users, progress, relationships, sharedWords, conversations, companionMessages, companionReports, practiceSessions,
    requireUser, mailer: accountMailer, renderAvatar: accountAvatarPng, chatTyping, chatLive, chatReplay, groups, groupMembers,
  })
  const isModerator = createModeratorCheck((configuration.MODERATOR_USER_IDS ?? '').split(','))
  const groupRouter = createGroupsRouter({
    users, groups, groupMembers, groupMessages, groupReports, requireUser, isModerator, chatTyping, chatLive, chatReplay,
  })
  const routers = { private: companionRouter, group: groupRouter }
  const realtime = createChatSocket({ server, sessionMiddleware, requireUser, routers,
    authorize: (kind, req, id) => routers[kind].chatAccess(req, id),
  })
  chatLive.setSocketPublisher?.(realtime.publish)
  app.use('/api/companions', realtime.middleware('private'), companionRouter)
  app.use('/api/groups', realtime.middleware('group'), groupRouter)
  app.use('/api/moderation', createModerationRouter({
    users, groupMessages, groupReports, companionReports, requireUser, isModerator, publish: realtime.publish,
  }))
}

app.get('/api/progress', requireUser, async (req, res) => {
  const saved = await progress.findOne({ userId: req.accountUser._id.toString() })
  res.json({
    revision: saved?.revision ?? 0,
    progress: saved
      ? {
          cards: saved.cards,
          studyPlan: saved.studyPlan,
          updatedAt: saved.updatedAt,
          studyPlanUpdatedAt: saved.studyPlanUpdatedAt,
        }
      : null,
  })
})

app.put('/api/progress', requireUser, async (req, res) => {
  const result = progressSchema.safeParse(req.body)
  if (!result.success) return sendValidationError(res, result)

  const updatedAt = new Date()
  const expectedRevision = result.data.expectedRevision
  const filter = {
    userId: req.accountUser._id.toString(),
    ...(expectedRevision === 0
      ? { $or: [{ revision: 0 }, { revision: { $exists: false } }] }
      : { revision: expectedRevision }),
  }
  try {
    const update = await progress.updateOne(
      filter,
      {
        $set: {
          cards: result.data.cards,
          studyPlan: result.data.studyPlan,
          studyPlanUpdatedAt: result.data.studyPlanUpdatedAt ?? updatedAt,
          updatedAt,
        },
        $setOnInsert: { createdAt: updatedAt },
        $inc: { revision: 1 },
      },
      { upsert: expectedRevision === 0 },
    )
    if (update.matchedCount === 0 && update.upsertedCount === 0) {
      return res.status(409).json({ error: 'Progress changed on another device. Merging the latest copy.' })
    }
    res.json({ revision: expectedRevision + 1, updatedAt: updatedAt.toISOString() })
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(409).json({ error: 'Progress changed on another device. Merging the latest copy.' })
    }
    throw error
  }
})

app.use((error, _req, res, _next) => {
  console.error('Request failed.')
  if (!res.headersSent) res.status(500).json({ error: 'The request could not be completed.' })
})

app.use('/optional-voice', createOptionalVoiceRouter({ componentDirectory: resolve(rootPath, 'optional/german-voice'), assetDirectory: process.env.DEUTSCH_VOICE_ASSETS_DIR || undefined }))
app.use(express.static(resolve(rootPath, 'dist')))
app.get(/^(?!\/api\/).*/, (_req, res, next) => {
  res.sendFile(resolve(rootPath, 'dist/index.html'), (error) => {
    if (error) next(error)
  })
})

server.listen(port, isLocalDevelopment ? '127.0.0.1' : '0.0.0.0', () => {
  console.log(`Deutsch account API listening on port ${port}`)
})
