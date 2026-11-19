import { useOfflineVoice } from './offlineVoiceContext'
import { commitDeckChanges, mergeStoredAccountDeck, replaceStoredDeck, DeckConflictError, DeckLimitError } from './deckStorage'
import { NounPlural } from './NounPlural'
import { WordLookupProvider } from './WordLookupProvider'
import { Component, lazy, Suspense, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ErrorInfo, type ReactNode } from 'react'
import { ArrowRight, ArrowUpRight, Check, Clock3, MessagesSquare } from 'lucide-react'
import {
  detectWeakPattern,
  getCardsIntroducedToday,
  getInitialStudyMode,
  getReviewDueAt,
  getLocalDayKey,
  getNewCardQuotaRemaining,
  getSessionCardIds,
  isDueForReview,
  isUnintroduced,
  resetReviewProgress,
  scheduleReview,
  type RecallField,
  type Rating,
  type ReviewMode,
} from './scheduler'
import {
  cardContentKey,
  isDeckCard,
  parseDeckFile,
  type Card,
} from './deckImport'
import { getStudySetChoiceOptions } from './choiceQuiz'
import {
  createDefaultStudyPlan,
  estimateGoalPace,
  INTENSITY_SETTINGS,
  isStudyPlan,
  type StudyIntensity,
  type StudyPlan,
} from './studyPlan'
import { findProductionAlternative, isProductionAnswerCorrect, productionMismatch, validAcceptedAnswers } from './productionQuiz'
import { AccountMenu, type AccountUser } from './AccountMenu'
import type { SharedWordPreview } from './CompanionPanel'
import { useConfirm } from './confirmContext'
import type { WordEntry } from './wordLookup'
import { mergeAccountProgress, type AccountProgress } from './accountSync'
import LearnMode from './LearnMode'
import { MenuSelect, type MenuSelectOption } from './MenuSelect'
import { useFormValidation } from './formValidation'
import { FloatingPopover } from './FloatingPopover'
import { containsFloatingTarget } from './floatingTarget'
import { Toast, type ToastMessage } from './Toast'
import { CopyText } from './CopyText'
import { InteractiveExample } from './InteractiveExample'
import { WordAudio } from './WordAudio'
import { reviewLearningCard, saveForLearning, scheduleFirstReview } from './learning'
import { activityForCard, mergeWordActivity, recordWordActivity, summarizeActivity, type DayActivity } from './activity'
import { ActivityPanel, ActivityPreview } from './ActivityCalendar'
import {
  defaultPauseState, finishPause, isPauseState, recordPauseWord, restorePause,
  startPendingPause, updatePauseSettings, type PauseActivity, type PauseSettings, type PauseState,
} from './studyPause'
import {
  getCardsForStudySet,
  getReviewedWords,
  getStudySetNewCardLimit,
  getStudySetProgress,
  getStudySetTags,
} from './studySets'
import { useUnreadMessages } from './useUnreadMessages'
import { useMessageSound } from './useMessageSound'
import { useChatOutbox } from './useChatOutbox'
import { chatCacheClearedKey, clearChatCache } from './chatPersistentCache'
import { clearCommunityDirectoryCache, setCommunityCacheOwner } from './communityDirectoryCache'
import { isChatOverlayEntry, withoutChatOverlay } from './conversationHistory'
import { leaveChatHistory } from './chatHistoryNavigation'
import { cardFromStarterEntry, createSeedDeck, loadStarterPack, makeCard, type LoadedDeck, type StarterEntry, type StarterPack } from './starterDeck'
import './App.css'

const CompanionPanel = lazy(() => import('./CompanionPanel').then((module) => ({ default: module.CompanionPanel })))
let panelHistorySequence = 0

class CompanionLoadBoundary extends Component<{ children: ReactNode; onBack: () => void }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() { return { failed: true } }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Could not open the companion workspace.', error, info)
  }

  render() {
    if (this.state.failed) return <div className="companion-workspace-view" role="alert">
      <p>Could not open your community. Check your connection and reload the app to try again.</p>
      <button type="button" onClick={this.props.onBack}>Back to deck</button>
    </div>
    return this.props.children
  }
}

type NewCardInput = {
  acceptedAnswers: string[]
  word: string
  category: string
  article: string
  meaning: string
  plural: string
  example: string
  translation: string
  level: string
  tags: string
}

type ChoiceFeedback = {
  cardId: string
  selectedId: string
  correct: boolean
}

type ProductionFeedback = {
  cardId: string
  answer: string
  correct: boolean
}

const STUDY_PLAN_STORAGE_KEY = 'deutsch-study-plan-v1'
const LOCAL_PROGRESS_UPDATED_AT_KEY = 'deutsch-progress-updated-at-v1'
const LOCAL_STUDY_PLAN_UPDATED_AT_KEY = 'deutsch-study-plan-updated-at-v1'
const INTRODUCTION_STORAGE_KEY = 'deutsch-introduction-seen-v1'
const PAUSE_STORAGE_KEY = 'deutsch-pause-v1'
const INITIAL_NOW = Date.now()
const DECK_FILE_VERSION = 1

const nowIso = () => new Date().toISOString()

const loadPauseState = (): { state: PauseState; warning: string | null; resumeActivity?: PauseActivity } => {
  try {
    const raw = localStorage.getItem(PAUSE_STORAGE_KEY)
    if (!raw) return { state: defaultPauseState(), warning: null }
    const parsed: unknown = JSON.parse(raw)
    if (!isPauseState(parsed)) return { state: defaultPauseState(), warning: 'Pause settings could not be read; defaults are in use.' }
    const state = restorePause(parsed, Date.now())
    const resumeActivity = parsed.pending || parsed.until !== null ? parsed.activity : undefined
    try {
      if (state !== parsed) localStorage.setItem(PAUSE_STORAGE_KEY, JSON.stringify(state))
      return { state, warning: null, resumeActivity }
    } catch {
      return { state, warning: 'Pause progress could not be saved on this device.', resumeActivity }
    }
  } catch {
    return { state: defaultPauseState(), warning: 'Pause settings could not be read or saved; defaults are in use.' }
  }
}

type LoadedStudyPlan = {
  plan: StudyPlan
  warning: string | null
}

const loadStudyPlan = (): LoadedStudyPlan => {
  try {
    const raw = localStorage.getItem(STUDY_PLAN_STORAGE_KEY)
    if (!raw) return { plan: createDefaultStudyPlan(), warning: null }
    const parsed: unknown = JSON.parse(raw)
    if (!isStudyPlan(parsed)) {
      return {
        plan: createDefaultStudyPlan(),
        warning: 'Saved goal settings are invalid. Your saved settings have not been overwritten.',
      }
    }
    return { plan: parsed, warning: null }
  } catch {
    return {
      plan: createDefaultStudyPlan(),
      warning: 'Goal settings could not be read. Your saved settings have not been overwritten.',
    }
  }
}

const localDateString = (date: Date) => {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

const formatHours = (hours: number) => {
  if (hours < 1) return `${Math.round(hours * 60)} min`
  return `${hours.toFixed(1)} hr`
}

const relativeReviewTime = (dueAt: string, now: number) => {
  const minutes = Math.max(1, Math.ceil((new Date(dueAt).getTime() - now) / 60_000))
  if (minutes < 60) return `A card will be ready for review in ${minutes} min.`
  const hours = Math.ceil(minutes / 60)
  if (hours < 24) return `Your next review is in about ${hours} hr.`
  const days = Math.ceil(hours / 24)
  return `Your next review is in ${days} day${days === 1 ? '' : 's'}.`
}

const intervalLabel = (card: Card, rating: Rating, now: Date) => {
  const preview = scheduleReview(card, rating, now)
  if (rating === 'again') return '10 min'
  return `${preview.intervalDays} ${preview.intervalDays === 1 ? 'day' : 'days'}`
}

const readApiResponse = async (response: Response): Promise<unknown> => {
  let body: unknown
  try {
    body = await response.json()
  } catch {
    if (response.status >= 500) {
      throw new Error('Could not reach the account service. Restart the app with npm run dev and configure the MongoDB settings in .env.')
    }
    throw new Error('The account server returned an invalid response.')
  }
  if (!response.ok) {
    const message = body && typeof body === 'object' && 'error' in body &&
      typeof body.error === 'string'
      ? body.error
      : 'The account request could not be completed.'
    throw new Error(message)
  }
  return body
}

const isAccountProgress = (value: unknown): value is AccountProgress =>
  Boolean(
    value &&
      typeof value === 'object' &&
      'cards' in value &&
      Array.isArray(value.cards) &&
      value.cards.every(isDeckCard) &&
      'studyPlan' in value &&
      isStudyPlan(value.studyPlan),
  )

type CloudProgress = AccountProgress & {
  updatedAt: string
  studyPlanUpdatedAt?: string
}

const isCloudProgress = (value: unknown): value is CloudProgress =>
  Boolean(
    isAccountProgress(value) &&
      'updatedAt' in value &&
      typeof value.updatedAt === 'string' &&
      (!('studyPlanUpdatedAt' in value) || typeof value.studyPlanUpdatedAt === 'string'),
  )

function usePanelDismiss(
  panelRef: React.RefObject<HTMLElement | null>,
  onClose: (restoreFocus?: boolean) => void,
  hasChanges: () => boolean,
) {
  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && panelRef.current?.contains(document.activeElement)) onClose(true)
    }
    const handlePointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || containsFloatingTarget(panelRef.current, event.target)) return
      if (!hasChanges()) onClose()
    }
    window.addEventListener('keydown', handleEscape)
    document.addEventListener('pointerdown', handlePointerDown)
    return () => {
      window.removeEventListener('keydown', handleEscape)
      document.removeEventListener('pointerdown', handlePointerDown)
    }
  }, [panelRef, onClose, hasChanges])
}

function AboutContent({ onDone, introduction = false }: { onDone: () => void; introduction?: boolean }) {
  return (
    <div className="about-content">
      {introduction && <h1>Welcome to Deutsch Deck</h1>}
      <section>
        <h2>What Deutsch Deck is</h2>
        <p>A German vocabulary trainer for words you want to use. Organize them by lesson, learn them in context, and practise recalling them over time. Study on your own or alongside your course.</p>
      </section>
      <section>
        <h2>Learning with others</h2>
        <p>Invite a companion to review words together, share vocabulary, and offer kind sentence feedback. In groups, use shared words in your own sentences, get optional feedback, and revise your attempts. You choose what to save to your deck.</p>
        <p>Private chats stay between companions. Group posts are visible to members. Messages are never sent to AI or translation services.</p>
      </section>
      <section>
        <h2>What Deutsch Deck isn’t</h2>
        <p>A complete German course, an official vhs-Lernportal product, a guarantee of proficiency, or a place with streak pressure and rankings.</p>
      </section>
      <button type="button" className="primary-button" onClick={onDone}>{introduction ? 'Start learning' : 'Done'}</button>
    </div>
  )
}

function AboutPanel({ onClose }: { onClose: (restoreFocus?: boolean) => void }) {
  const panelRef = useRef<HTMLElement>(null)
  useEffect(() => { panelRef.current?.focus() }, [])
  usePanelDismiss(panelRef, onClose, () => false)

  return (
    <section ref={panelRef} tabIndex={-1} className="add-dialog anchored-panel about-panel" role="dialog" aria-labelledby="about-title">
      <h2 id="about-title" className="menu-panel-title">About Deutsch Deck</h2>
      <AboutContent onDone={() => onClose(true)} />
    </section>
  )
}

function AppSettingsPanel({ settings, onChange, onClose, messageSound, signedIn }: {
  settings: PauseSettings
  onChange: (settings: PauseSettings) => void
  onClose: (restoreFocus?: boolean) => void
  messageSound: ReturnType<typeof useMessageSound>
  signedIn: boolean
}) {
  const offlineVoice = useOfflineVoice()
  const panelRef = useRef<HTMLElement>(null)
  useEffect(() => { panelRef.current?.focus() }, [])
  usePanelDismiss(panelRef, onClose, () => false)

  return (
    <section ref={panelRef} tabIndex={-1} className="add-dialog anchored-panel app-settings-panel" role="dialog" aria-labelledby="app-settings-title">
      <div className="dialog-heading">
        <h2 id="app-settings-title" className="menu-panel-title">App settings</h2>
        <button type="button" className="quiet-button" onClick={() => onClose(true)}>Done</button>
      </div>
      <h3>Study pauses</h3>
      <div className="pause-setting-toggle">
        <span>Suggest a short pause</span>
        <button className="app-toggle" type="button" role="switch" aria-label="Suggest a short pause" aria-checked={settings.enabled}
          onClick={() => onChange({ ...settings, enabled: !settings.enabled })}>
          <span aria-hidden="true" />
        </button>
      </div>
      <p>Count distinct words added to reviews or reviewed. Pauses can always be skipped.</p>
      <div className="pause-setting-row">
        <span>Pause after</span>
        <MenuSelect ariaLabel="Pause after" value={String(settings.every)}
          options={[{ value: '3', label: '3 words' }, { value: '5', label: '5 words' }, { value: '10', label: '10 words' }]}
          onChange={(value) => onChange({ ...settings, every: value === '3' ? 3 : value === '5' ? 5 : 10 })} />
      </div>
      <div className="pause-setting-row">
        <span>Pause length</span>
        <MenuSelect ariaLabel="Pause length" value={String(settings.seconds)}
          options={[{ value: '30', label: '30 seconds' }, { value: '60', label: '60 seconds' }, { value: '120', label: '2 minutes' }]}
          onChange={(value) => onChange({ ...settings, seconds: value === '30' ? 30 : value === '60' ? 60 : 120 })} />
      </div>
      <p>Changing these settings resets the current word count. Settings stay on this device.</p>
      <h3>Messages</h3>
      <div className="pause-setting-toggle">
        <span>Sound for new messages</span>
        <button className="app-toggle" type="button" role="switch" aria-label="Sound for new messages" aria-checked={messageSound.enabled}
          onClick={() => messageSound.setEnabled(!messageSound.enabled)}>
          <span aria-hidden="true" />
        </button>
      </div>
      <p>Play a quiet hum for new private and group messages while the app is open. On a phone, tap Test sound once to enable it. This setting stays on this device.</p>
      <button type="button" className="sound-test-button" onClick={messageSound.test} disabled={!messageSound.enabled}>Test sound</button>
      {messageSound.error && <p role="alert">{messageSound.error}</p>}
      {signedIn && messageSound.enabled && messageSound.connection === 'offline' && <p role="status">Live message sounds are unavailable. Check your connection.</p>}
      {offlineVoice && <button type="button" className="sound-test-button" onClick={() => offlineVoice.open()}>Offline German voice{offlineVoice.preview ? ' preview' : ''}</button>}
    </section>
  )
}

function ActivityDialog({ days, today, onClose }: { days: Map<string, DayActivity>; today: Date; onClose: (restoreFocus?: boolean) => void }) {
  const panelRef = useRef<HTMLElement>(null)
  useEffect(() => { panelRef.current?.focus() }, [])
  usePanelDismiss(panelRef, onClose, () => false)
  return (
    <section ref={panelRef} tabIndex={-1} className="add-dialog anchored-panel activity-panel" role="dialog" aria-labelledby="activity-title">
      <div className="dialog-heading">
        <h2 id="activity-title" className="menu-panel-title">Your activity</h2>
        <button type="button" className="quiet-button" onClick={() => onClose(true)}>Done</button>
      </div>
      <ActivityPanel days={days} today={today} />
    </section>
  )
}

function PauseScreen({ remainingMs, duration, onSkip }: { remainingMs: number; duration: number; onSkip: () => void }) {
  const skipRef = useRef<HTMLButtonElement>(null)
  const remaining = Math.min(1, Math.max(0, remainingMs / (duration * 1000)))
  const seconds = Math.max(0, Math.ceil(remainingMs / 1000))
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    skipRef.current?.focus()
    return () => {
      requestAnimationFrame(() => {
        if (previous?.isConnected && !previous.matches(':disabled')) previous.focus()
        else document.querySelector<HTMLElement>('.app-shell button')?.focus()
      })
    }
  }, [])
  return (
    <div className="pause-screen">
      <section className="empty-state pause-card" role="dialog" aria-modal="true" aria-labelledby="pause-title" aria-describedby="pause-description">
        <span className="complete-mark"><Clock3 size={21} aria-hidden="true" /></span>
        <h1 id="pause-title">A little space to breathe.</h1>
        <p id="pause-description" className="session-note">Take a short pause. Your place is right here.</p>
        <div className="pause-progress" role="progressbar" aria-label="Time remaining"
          aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(remaining * 100)}
          aria-valuetext={`${seconds} ${seconds === 1 ? 'second' : 'seconds'} remaining`}>
          <div className="pause-progress-fill" style={{ transform: `scaleX(${remaining})` }} />
        </div>
        <button ref={skipRef} type="button" className="quiet-button" onClick={onSkip}>Skip pause</button>
      </section>
    </div>
  )
}

function AddCardDialog({
  defaultTag,
  onClose,
  onSave,
  isFront,
  onActivate,
}: {
  defaultTag: string
  onClose: (restoreFocus?: boolean) => void
  onSave: (input: NewCardInput) => void
  isFront: boolean
  onActivate: () => void
}) {
  const [category, setCategory] = useState('noun')
  const [article, setArticle] = useState('')
  const [articleError, setArticleError] = useState(false)
  const [answersError, setAnswersError] = useState(false)
  const [level, setLevel] = useState('A1')
  const { errors, validate, handleInput } = useFormValidation()
  const panelRef = useRef<HTMLElement>(null)
  const formRef = useRef<HTMLFormElement>(null)

  usePanelDismiss(panelRef, onClose, () =>
    [...(formRef.current?.querySelectorAll('input') ?? [])]
      .some((input) => input.value !== input.defaultValue) ||
    category !== 'noun' || article !== '' || level !== 'A1',
  )

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const acceptedAnswers = String(new FormData(event.currentTarget).get('acceptedAnswers') ?? '').split('|').map((answer) => answer.trim()).filter(Boolean)
    const answersValid = validAcceptedAnswers(acceptedAnswers, category)
    setAnswersError(!answersValid)
    const valid = validate(event.currentTarget)
    const missingArticle = category === 'noun' && !article
    setArticleError(missingArticle)
    if (!valid || missingArticle || !answersValid) {
      if (valid && missingArticle) {
        requestAnimationFrame(() => panelRef.current?.querySelector<HTMLButtonElement>('[aria-label="Article"]')?.focus())
      }
      if (!answersValid) panelRef.current?.querySelector<HTMLInputElement>('[name="acceptedAnswers"]')?.focus()
      return
    }
    const formData = new FormData(event.currentTarget)
    onSave({
      acceptedAnswers,
      word: String(formData.get('word') ?? '').trim(),
      category,
      article,
      meaning: String(formData.get('meaning') ?? '').trim(),
      plural: String(formData.get('plural') ?? '').trim(),
      example: String(formData.get('example') ?? '').trim(),
      translation: String(formData.get('translation') ?? '').trim(),
      level,
      tags: String(formData.get('tags') ?? '').trim(),
    })
  }

  return (
      <section
        ref={panelRef}
        className="add-dialog anchored-panel"
        data-front={isFront}
        onPointerDownCapture={onActivate}
        onFocusCapture={onActivate}
        role="dialog"
        aria-labelledby="add-card-title"
      >
        <div className="dialog-heading">
          <div>
            <h2 id="add-card-title" className="menu-panel-title">Add a word</h2>
          </div>
        </div>

        <form ref={formRef} noValidate onInput={handleInput} onSubmit={handleSubmit}>
          <div className="form-row">
            <label>
              {category === 'noun' ? 'Noun without article' : 'German word or phrase'}
              <input
                name="word"
                aria-label={category === 'noun' ? 'Noun without article' : 'German word or phrase'}
                aria-invalid={Boolean(errors.word) || undefined}
                aria-describedby={errors.word ? 'add-word-error' : undefined}
                autoFocus
                required
                maxLength={100}
                placeholder={category === 'noun' ? 'Wohnung' : 'gehen'}
              />
              {errors.word && <span className="field-error" id="add-word-error">{errors.word}</span>}
            </label>
            <div className="custom-select-field">
              <span>Type</span>
              <MenuSelect
                ariaLabel="Type"
                value={category}
                onChange={(value) => {
                  setCategory(value)
                  setArticleError(false)
                }}
                options={[
                  { value: 'noun', label: 'Noun' },
                  { value: 'verb', label: 'Verb' },
                  { value: 'adjective', label: 'Adjective' },
                  { value: 'adverb', label: 'Adverb' },
                  { value: 'numeral', label: 'Number' },
                  { value: 'phrase', label: 'Phrase' },
                ]}
              />
            </div>
          </div>

          {category === 'noun' && (
            <div className="form-row">
              <div className="custom-select-field">
                <span>Article</span>
                <MenuSelect
                  ariaLabel="Article"
                  value={article}
                  invalid={articleError}
                  describedBy={articleError ? 'article-error' : undefined}
                  onChange={(value) => {
                    setArticle(value)
                    if (value) setArticleError(false)
                  }}
                  options={[
                    { value: '', label: 'Choose article' },
                    { value: 'der', label: 'der' },
                    { value: 'die', label: 'die' },
                    { value: 'das', label: 'das' },
                  ]}
                />
                {articleError && (
                  <span className="custom-select-error" id="article-error" role="alert">
                    Choose an article for this noun.
                  </span>
                )}
              </div>
              <label>
                Plural
                <input name="plural" maxLength={100} placeholder="die Wohnungen" />
              </label>
            </div>
          )}

          <div className="form-row">
            <label>
              Meaning
              <input name="meaning" aria-label="Meaning" required maxLength={160} placeholder="apartment" aria-invalid={Boolean(errors.meaning) || undefined} aria-describedby={errors.meaning ? 'add-meaning-error' : undefined} />
              {errors.meaning && <span className="field-error" id="add-meaning-error">{errors.meaning}</span>}
            </label>
            <div className="custom-select-field">
              <span>Level</span>
              <MenuSelect
                ariaLabel="Level"
                value={level}
                onChange={setLevel}
                options={[
                  { value: 'A1', label: 'A1' },
                  { value: 'A2', label: 'A2' },
                ]}
              />
            </div>
          </div>

          <label>
            Example in German
            <input name="example" aria-label="Example in German" required maxLength={240} placeholder="Die Wohnung ist sehr schön." aria-invalid={Boolean(errors.example) || undefined} aria-describedby={errors.example ? 'add-example-error' : undefined} />
            {errors.example && <span className="field-error" id="add-example-error">{errors.example}</span>}
          </label>
          <label>
            Example translation
            <input name="translation" aria-label="Example translation" required maxLength={240} placeholder="The apartment is very beautiful." aria-invalid={Boolean(errors.translation) || undefined} aria-describedby={errors.translation ? 'add-translation-error' : undefined} />
            {errors.translation && <span className="field-error" id="add-translation-error">{errors.translation}</span>}
          </label>
          <label>
            Other accepted German answers <small>Optional, separated by |</small>
            <input name="acceptedAnswers" maxLength={2010} onChange={() => setAnswersError(false)} aria-invalid={answersError || undefined} aria-describedby={answersError ? 'add-answers-error' : undefined} />
            {answersError && <span className="field-error" id="add-answers-error">Use up to 10 answers of 200 characters each. Include articles for nouns.</span>}
          </label>
          <label>
            Course or unit tags <small>Separate tags with |</small>
            <input
              name="tags"
              maxLength={120}
              defaultValue={defaultTag}
              placeholder="vhs-Lernportal|Lektion 1"
            />
          </label>

          <div className="dialog-actions">
            <button type="button" className="quiet-button" onClick={() => onClose(true)}>Cancel</button>
            <button type="submit" className="primary-button">Add to deck</button>
          </div>
        </form>
      </section>
  )
}

function parseLocalDate(value: string) {
  const [year, month, day] = value.split('-').map(Number)
  return new Date(year, month - 1, day)
}

function DatePicker({
  value,
  min,
  onChange,
}: {
  value: string
  min: string
  onChange: (value: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [displayMonth, setDisplayMonth] = useState(() => {
    const date = parseLocalDate(value)
    return new Date(date.getFullYear(), date.getMonth(), 1)
  })
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const pickerId = useId()
  const selectedDate = parseLocalDate(value)
  const minimumDate = parseLocalDate(min)
  const minimumMonth = new Date(minimumDate.getFullYear(), minimumDate.getMonth(), 1)
  const monthLabel = displayMonth.toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
  })
  const formattedDate = selectedDate.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
  const firstWeekday = (new Date(
    displayMonth.getFullYear(),
    displayMonth.getMonth(),
    1,
  ).getDay() + 6) % 7
  const daysInMonth = new Date(
    displayMonth.getFullYear(),
    displayMonth.getMonth() + 1,
    0,
  ).getDate()
  const cellCount = Math.ceil((firstWeekday + daysInMonth) / 7) * 7
  const weeks = Array.from({ length: cellCount / 7 }, (_, weekIndex) =>
    Array.from({ length: 7 }, (_, weekdayIndex) => {
      const day = weekIndex * 7 + weekdayIndex - firstWeekday + 1
      return day > 0 && day <= daysInMonth
        ? new Date(displayMonth.getFullYear(), displayMonth.getMonth(), day)
        : null
    }),
  )

  useEffect(() => {
    if (!open) return
    const handlePointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target) && !popoverRef.current?.contains(event.target)) {
        setOpen(false)
      }
    }
    document.addEventListener('pointerdown', handlePointerDown)
    return () => document.removeEventListener('pointerdown', handlePointerDown)
  }, [open])

  const changeMonth = (amount: number) => {
    setDisplayMonth((current) =>
      new Date(current.getFullYear(), current.getMonth() + amount, 1),
    )
  }

  const chooseDate = (date: Date) => {
    const dateValue = localDateString(date)
    if (dateValue < min) return
    onChange(dateValue)
    setDisplayMonth(new Date(date.getFullYear(), date.getMonth(), 1))
    setOpen(false)
    triggerRef.current?.focus()
  }

  return (
    <div
      className="date-picker"
      ref={rootRef}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.preventDefault()
          event.stopPropagation()
          setOpen(false)
          triggerRef.current?.focus()
        }
      }}
      onBlur={(event) => {
        if (!(event.relatedTarget instanceof Node) || (!event.currentTarget.contains(event.relatedTarget) && !popoverRef.current?.contains(event.relatedTarget))) {
          setOpen(false)
        }
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className="date-picker-trigger"
        aria-label={`Target date: ${formattedDate}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={pickerId}
        onClick={() => {
          if (!open) setDisplayMonth(new Date(selectedDate.getFullYear(), selectedDate.getMonth(), 1))
          setOpen((current) => !current)
        }}
      >
        <span>{formattedDate}</span>
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <rect x="3.25" y="4.75" width="13.5" height="12" rx="2" />
          <path d="M6.5 3.25v3M13.5 3.25v3M3.5 8.25h13" />
        </svg>
      </button>
      {open && (
        <FloatingPopover anchorRef={triggerRef} popoverRef={popoverRef} owner={pickerId} preferredWidth={292}
          id={pickerId} className="date-picker-popover" role="dialog" aria-label="Choose target date"
          onBlur={(event) => {
            if (!(event.relatedTarget instanceof Node) || (!rootRef.current?.contains(event.relatedTarget) && !event.currentTarget.contains(event.relatedTarget))) setOpen(false)
          }}>
          <div className="date-picker-heading">
            <button
              type="button"
              aria-label="Previous month"
              disabled={displayMonth <= minimumMonth}
              onClick={() => changeMonth(-1)}
            >
              ‹
            </button>
            <strong>{monthLabel}</strong>
            <button type="button" aria-label="Next month" onClick={() => changeMonth(1)}>
              ›
            </button>
          </div>
          <div className="date-picker-grid" role="grid" aria-label={monthLabel}>
            <div className="date-picker-week" role="row">
              {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((day) => (
                <span key={day} role="columnheader">{day}</span>
              ))}
            </div>
            {weeks.map((week, weekIndex) => (
              <div className="date-picker-week" role="row" key={weekIndex}>
                {week.map((date, weekdayIndex) => {
                  if (!date) {
                    return <span className="date-picker-empty" role="gridcell" key={weekdayIndex} />
                  }
                  const dateValue = localDateString(date)
                  const isSelected = dateValue === value
                  const isToday = dateValue === min
                  return (
                    <span role="gridcell" key={weekdayIndex}>
                      <button
                        type="button"
                        className={[
                          'date-picker-day',
                          isSelected ? 'selected' : '',
                          isToday ? 'today' : '',
                        ].filter(Boolean).join(' ')}
                        aria-label={date.toLocaleDateString('en-US', {
                          month: 'long',
                          day: 'numeric',
                          year: 'numeric',
                        })}
                        aria-pressed={isSelected}
                        disabled={dateValue < min}
                        onClick={() => chooseDate(date)}
                      >
                        {date.getDate()}
                      </button>
                    </span>
                  )
                })}
              </div>
            ))}
          </div>
        </FloatingPopover>
      )}
    </div>
  )
}

function StudyPlanDialog({
  initialPlan,
  now,
  onClose,
  onSave,
  isFront,
  onActivate,
}: {
  initialPlan: StudyPlan
  now: Date
  onClose: (restoreFocus?: boolean) => void
  onSave: (plan: StudyPlan) => void
  isFront: boolean
  onActivate: () => void
}) {
  const [draft, setDraft] = useState(initialPlan)
  const originalPlan = useRef(initialPlan)
  const panelRef = useRef<HTMLElement>(null)
  useEffect(() => { panelRef.current?.focus() }, [])
  const today = localDateString(now)
  const estimate = estimateGoalPace(draft, now)
  const intensity = INTENSITY_SETTINGS[draft.intensity]
  const update = <K extends keyof StudyPlan,>(key: K, value: StudyPlan[K]) =>
    setDraft((current) => ({ ...current, [key]: value }))

  usePanelDismiss(panelRef, onClose, () =>
    draft.currentLevel !== originalPlan.current.currentLevel ||
    draft.targetLevel !== originalPlan.current.targetLevel ||
    draft.targetDate !== originalPlan.current.targetDate ||
    draft.intensity !== originalPlan.current.intensity,
  )

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (isStudyPlan(draft)) onSave(draft)
  }

  const dailyEstimate = estimate.guidedHoursPerDay
  const practiceNote = dailyEstimate && dailyEstimate.min * 60 > intensity.minutesPerDay
    ? `About ${intensity.minutesPerDay} minutes are set aside for vocabulary cards each day. Plan extra time for your course and the other language skills.`
    : null
  const estimateMessage = dailyEstimate
    ? dailyEstimate.max === 0
      ? 'Your current level meets or exceeds this goal.'
      : `Plan for about ${formatHours(dailyEstimate.min)}–${formatHours(dailyEstimate.max)} of guided study each day.`
    : estimate.daysRemaining === 0
      ? 'Choose a future target date to see an estimate.'
      : draft.currentLevel === 'unknown'
        ? 'Choose your starting level to see an estimate.'
        : 'An estimate is not available for this goal yet.'

  return (
      <section
        ref={panelRef}
        tabIndex={-1}
        className="add-dialog study-plan-dialog anchored-panel"
        data-front={isFront}
        onPointerDownCapture={onActivate}
        onFocusCapture={onActivate}
        role="dialog"
        aria-labelledby="study-plan-title"
      >
        <div className="dialog-heading">
          <div>
            <h2 id="study-plan-title" className="menu-panel-title">Goal &amp; study pace</h2>
          </div>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="form-row">
            <div className="custom-select-field">
              <span>Starting level</span>
              <MenuSelect
                ariaLabel="Starting level"
                value={draft.currentLevel}
                onChange={(value) => update('currentLevel', value)}
                options={[
                  { value: 'unknown', label: 'Not sure yet' },
                  { value: 'A0', label: 'New to German' },
                  { value: 'A1', label: 'A1' },
                  { value: 'A2', label: 'A2' },
                  { value: 'B1', label: 'B1' },
                ]}
              />
            </div>
            <div className="custom-select-field">
              <span>Goal level</span>
              <MenuSelect
                ariaLabel="Goal level"
                value={draft.targetLevel}
                onChange={(value) => update('targetLevel', value)}
                options={[
                  { value: 'A1', label: 'A1' },
                  { value: 'A2', label: 'A2' },
                  { value: 'B1', label: 'B1' },
                  { value: 'B2', label: 'B2' },
                ]}
              />
            </div>
          </div>
          <div className="custom-select-field">
            <span>Target date</span>
            <DatePicker
              value={draft.targetDate}
              min={today}
              onChange={(value) => update('targetDate', value)}
            />
          </div>
          <fieldset className="intensity-options">
            <legend>Your daily card pace</legend>
            {(Object.keys(INTENSITY_SETTINGS) as StudyIntensity[]).map((level) => {
              const settings = INTENSITY_SETTINGS[level]
              return (
                <label key={level} className={draft.intensity === level ? 'selected' : ''}>
                  <input
                    type="radio"
                    name="intensity"
                    value={level}
                    checked={draft.intensity === level}
                    onChange={() => update('intensity', level)}
                  />
                  <span className="intensity-copy">
                    <strong className="intensity-name">{settings.label}</strong>
                    <span className="intensity-summary">
                      Up to {settings.newCardsPerDay} new cards/day · max {settings.reviewLimit}
                      {' '}due reviews/set · ~{settings.minutesPerDay} min/day
                    </span>
                  </span>
                </label>
              )
            })}
          </fieldset>
          <div className="goal-estimate" role="status">
            <div className="goal-estimate-heading">
              <span>Time to target</span>
              <strong>{estimate.daysRemaining} days</strong>
            </div>
            <p className="goal-estimate-summary">{estimateMessage}</p>
            {practiceNote && <p className="goal-practice-note">{practiceNote}</p>}
            <details className="goal-estimate-details">
              <summary>About this estimate</summary>
              <p>
                This is a broad planning estimate based on Goethe-Institut guided-course hour
                ranges, not a promise. Reaching a CEFR level also takes practice in listening,
                reading, speaking, and writing; vocabulary cards support that work but cannot
                replace it.
              </p>
              <a href="https://www.goethe.de/ins/gb/en/sta/lon/kur/faq.html" target="_blank" rel="noreferrer">
                Goethe-Institut source
              </a>
            </details>
          </div>
          <div className="dialog-actions">
            <button type="button" className="quiet-button" onClick={() => onClose(true)}>Cancel</button>
            <button type="submit" className="primary-button">Save goal</button>
          </div>
        </form>
      </section>
  )
}

function StudySetSelect({
  cards,
  value,
  onChange,
}: {
  cards: Card[]
  value: string
  onChange: (tag: string) => void
}) {
  const tags = getStudySetTags(cards)
  const levels = (['A1', 'A2'] as const).filter((level) =>
    cards.some((card) => card.status === 'active' && card.tags.includes(level)),
  )
  const options: MenuSelectOption<string>[] = [
    { value: '', label: 'All words' },
    ...levels.map((level) => ({ value: level, label: level, group: 'CEFR level' })),
    ...tags.map((tag) => ({ value: tag, label: tag, group: 'Lessons and topics' })),
  ]

  return (
    <div className="study-set-filter">
      <span>Study set</span>
      <MenuSelect ariaLabel="Study set" options={options} value={value} onChange={onChange} />
    </div>
  )
}

function StudySetProgressSummary({
  cards,
  tag,
  compact = false,
}: {
  cards: Card[]
  tag: string
  compact?: boolean
}) {
  const progress = getStudySetProgress(cards)
  const hasReviews =
    progress.recall.total + progress.choice.answered + progress.production.answered > 0

  if (compact && !hasReviews) return null

  return (
    <section
      className={`study-set-progress${compact ? ' compact' : ''}`}
      aria-label={`Progress for ${tag || 'all words'}`}
    >
      <strong>{compact ? 'Progress' : tag ? `${tag} progress` : 'Overall progress'}</strong>
      {hasReviews ? (
        <ul>
          {progress.recall.total > 0 && (
            <li>
              <strong className="progress-mode">Recall</strong>
              <span>{progress.recall.remembered} remembered · {progress.recall.again} to revisit</span>
            </li>
          )}
          {progress.choice.answered > 0 && (
            <li>
              <strong className="progress-mode">Choose</strong>
              <span>{progress.choice.correct} of {progress.choice.answered} correct</span>
            </li>
          )}
          {progress.production.answered > 0 && (
            <li>
              <strong className="progress-mode">Produce</strong>
              <span>{progress.production.correct} of {progress.production.answered} correct</span>
            </li>
          )}
        </ul>
      ) : <span>No review history in this set yet.</span>}
    </section>
  )
}

function SessionSettingsDialog({
  cards,
  tag,
  goalSummary,
  now,
  onChange,
  onAdjustGoal,
  onReset,
  resetAvailable,
  onClose,
  isFront,
  onActivate,
}: {
  cards: Card[]
  tag: string
  goalSummary: string
  now: number
  onChange: (tag: string) => void
  onAdjustGoal: () => void
  onReset: (cardId?: string) => Promise<boolean>
  resetAvailable: boolean
  onClose: (restoreFocus?: boolean) => void
  isFront: boolean
  onActivate: () => void
}) {
  const scopedCards = getCardsForStudySet(cards, tag)
  const reviewedCards = scopedCards.filter((card) => card.lastReviewedAt !== null)
  const reviewedCount = reviewedCards.length
  const confirm = useConfirm()
  const resetWord = async (card: Card) => {
    const confirmed = await confirm({
      title: `Reset ${card.prompt}?`,
      message: 'Its history and schedule are cleared and it becomes a new word again in every set. This cannot be undone.',
      confirmLabel: 'Reset word',
      tone: 'danger',
    })
    if (confirmed && await onReset(card.id)) reviewedSearchRef.current?.focus()
  }
  const resetSet = async () => {
    const confirmed = await confirm({
      title: 'Reset review progress?',
      message: `Review history and schedules for ${reviewedCount.toLocaleString()} ${reviewedCount === 1 ? 'word' : 'words'} in ${tag || 'all words'} are cleared. These words become new again, including in other sets. This cannot be undone.`,
      confirmLabel: 'Reset progress',
      tone: 'danger',
    })
    if (confirmed && await onReset()) panelRef.current?.focus()
  }
  const [reviewedOpen, setReviewedOpen] = useState(false)
  const [reviewedQuery, setReviewedQuery] = useState('')
  const [reviewedLimit, setReviewedLimit] = useState(25)
  const panelRef = useRef<HTMLElement>(null)
  const reviewedSearchRef = useRef<HTMLInputElement>(null)
  const matchingCards = getReviewedWords(scopedCards, reviewedQuery)
  const formatReviewDate = (value: string) => {
    const date = new Date(value)
    return Number.isFinite(date.getTime())
      ? date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
      : 'Date unavailable'
  }
  useEffect(() => { panelRef.current?.focus() }, [])
  usePanelDismiss(panelRef, onClose, () => false)

  return (
      <section
        ref={panelRef}
        tabIndex={-1}
        className="add-dialog session-settings-dialog anchored-panel"
        data-front={isFront}
        onPointerDownCapture={onActivate}
        onFocusCapture={onActivate}
        role="dialog"
        aria-labelledby="session-settings-title"
      >
        <div className="dialog-heading">
          <div>
            <h2 id="session-settings-title" className="menu-panel-title">Tune your session</h2>
          </div>
        </div>
        <div className="session-setting-block">
          <StudySetSelect cards={cards} value={tag} onChange={(value) => {
            setReviewedQuery('')
            setReviewedLimit(25)
            onChange(value)
          }} />
          <p className="session-reviewed-count">
            <strong>{reviewedCount.toLocaleString()}</strong> of {scopedCards.length.toLocaleString()}{' '}
            {scopedCards.length === 1 ? 'word' : 'words'} reviewed
          </p>
          <button type="button" className="quiet-button reviewed-words-toggle" aria-expanded={reviewedOpen} onClick={() => {
            setReviewedOpen(!reviewedOpen)
          }}>{reviewedOpen ? 'Hide reviewed words' : 'View reviewed words'}</button>
          {reviewedOpen && (
            <section className="reviewed-words" aria-label="Reviewed words">
              <label>
                Find a reviewed word
                <input ref={reviewedSearchRef} type="search" value={reviewedQuery} placeholder="German or meaning" onChange={(event) => {
                  setReviewedQuery(event.target.value)
                  setReviewedLimit(25)
                }} />
              </label>
              {matchingCards.length ? (
                <>
                  <ul className="reviewed-words-list">
                    {matchingCards.slice(0, reviewedLimit).map((card) => (
                      <li key={card.id}>
                        <details>
                          <summary><strong lang="de">{card.prompt}</strong><span>{card.meaning}</span></summary>
                          <div className="reviewed-word-details">
                            <p>Last reviewed: {formatReviewDate(card.lastReviewedAt ?? '')}</p>
                            <p>Next review: {new Date(card.dueAt).getTime() <= now ? 'Due now' : formatReviewDate(card.dueAt)}</p>
                            {card.reviewHistory.length > 0 && (
                              <>
                                <strong>Recent reviews</strong>
                                <ul>
                                  {card.reviewHistory.slice(-5).reverse().map((review, index) => (
                                    <li key={index}>
                                      {formatReviewDate(review.at)} · {review.mode === 'choice' ? 'Choose' : review.mode === 'production' ? 'Produce' : 'Recall'} · {review.mode === 'choice' || review.mode === 'production'
                                        ? review.answerCorrect === undefined ? 'Result unavailable' : review.answerCorrect ? 'Correct' : 'Incorrect'
                                        : review.rating.charAt(0).toUpperCase() + review.rating.slice(1)}
                                    </li>
                                  ))}
                                </ul>
                              </>
                            )}
                            <button type="button" className="quiet-button reviewed-word-reset" disabled={!resetAvailable} onClick={() => void resetWord(card)}>Reset this word</button>
                          </div>
                        </details>
                      </li>
                    ))}
                  </ul>
                  {matchingCards.length > reviewedLimit && (
                    <button type="button" className="quiet-button reviewed-words-more" onClick={() => setReviewedLimit((limit) => limit + 25)}>Show more ({matchingCards.length - reviewedLimit} remaining)</button>
                  )}
                </>
              ) : <p>{reviewedCount ? 'No reviewed words match your search.' : 'No reviewed words in this set yet.'}</p>}
            </section>
          )}
          <button type="button" className="quiet-button reset-review-link" disabled={!reviewedCount || !resetAvailable} onClick={() => void resetSet()}>Reset review progress</button>
          {!resetAvailable && <p>Reset is unavailable until saved data and account sync are ready.</p>}
        </div>
        <StudySetProgressSummary cards={scopedCards} tag={tag} compact />
        <div className="session-goal">
          <div className="session-goal-details">
            <span>Daily goal &amp; pace</span>
            <p className="goal-summary">{goalSummary.replace(/^Goal:\s*/, '')}</p>
          </div>
          <button type="button" className="quiet-button goal-edit-button" onClick={onAdjustGoal}>
            Adjust goal
          </button>
        </div>
        <div className="dialog-actions">
          <button type="button" className="primary-button" onClick={() => onClose(true)}>Done</button>
        </div>
      </section>
  )
}

function AppFooter({ signedIn }: { signedIn: boolean }) {
  return (
    <footer className="app-footer">
      <div className="app-footer-inner">
        <p className="privacy-note">
          {signedIn ? 'Your progress is saved on this device and synced to your account.' : 'Your progress stays on this device.'}
        </p>
        <nav className="footer-links" aria-label="Project links">
          <a href="https://github.com/saintheraldfaust/Deutsch">GitHub</a>
          <a href="https://github.com/saintheraldfaust/Deutsch/blob/main/README.md">Docs</a>
        </nav>
      </div>
    </footer>
  )
}

function App({ initialDeck }: { initialDeck: LoadedDeck }) {
  const confirm = useConfirm()
  const clearOfflineVoice = useOfflineVoice()?.clear
  useLayoutEffect(() => {
    const state = window.history.state
    if (!state || typeof state !== 'object') return
    const keys = ['__deutschAccountMenu', '__deutschAccountMode', '__deutschCompanionWorkspace',
      '__deutschCompanionChat', '__deutschCompanionGroup', '__deutschChatOverlay',
      '__deutschCompanionView', '__deutschPanel', '__deutschStudyMode']
    if (!keys.some((key) => key in state)) return
    const cleaned = { ...state }
    keys.forEach((key) => { delete cleaned[key] })
    window.history.replaceState(cleaned, '', window.location.href)
  }, [])
  const [loaded] = useState(initialDeck)
  const [loadedStudyPlan] = useState(loadStudyPlan)
  const [introduction] = useState(() => {
    try {
      return { visible: localStorage.getItem(INTRODUCTION_STORAGE_KEY) !== 'seen', warning: null }
    } catch {
      return { visible: true, warning: 'Your browser could not check whether you have seen this introduction.' }
    }
  })
  const [showIntroduction, setShowIntroduction] = useState(introduction.visible)
  const [aboutOpen, setAboutOpen] = useState(false)
  const studyAreaRef = useRef<HTMLDivElement>(null)
  const restoreIntroductionFocus = useRef(false)
  const [cards, setCards] = useState<Card[]>(loaded.cards)
  const [studyPlan, setStudyPlan] = useState(loadedStudyPlan.plan)
  const [canSave, setCanSave] = useState(loaded.canSave)
  const [storageWarning, setStorageWarning] = useState(loaded.warning)
  const [studyPlanWarning, setStudyPlanWarning] = useState(loadedStudyPlan.warning)
  const [accountUser, setAccountUser] = useState<AccountUser | null>(null)
  const [accountMenuOpen, setAccountMenuOpen] = useState(false)
  const accountMenuEntry = useRef(false)
  const [companionWorkspaceOpen, setCompanionWorkspaceOpen] = useState(false)
  const [groupInvitation, setGroupInvitation] = useState(() => new URLSearchParams(window.location.hash.slice(1)).get('groupInvite'))
  const groupInvitationRef = useRef(groupInvitation)
  const companionWorkspaceEntry = useRef<string | null>(null)
  const unreadMessages = useUnreadMessages(Boolean(accountUser?.emailVerified), companionWorkspaceOpen)
  const messageSound = useMessageSound(accountUser?.emailVerified ? accountUser.id : null)
  const chatOutbox = useChatOutbox()
  const setChatOutboxOwner = chatOutbox.setOwner
  const accountEmail = accountUser?.email
  const [accountSyncReady, setAccountSyncReady] = useState(false)
  const [accountSyncStatus, setAccountSyncStatus] = useState<string | null>(null)
  const [accountSyncError, setAccountSyncError] = useState<string | null>(null)
  const accountRevision = useRef(0)
  const accountIdentity = useRef<string | null>(null)
  const cacheIdentityQueue = useRef<Promise<void>>(Promise.resolve())
  const deckWritePending = useRef(false)
  const localProgressRef = useRef({ cards, studyPlan, canSave, studyPlanWarning })
  const [revealed, setRevealed] = useState(false)
  const [now, setNow] = useState(INITIAL_NOW)
  const [sessionIds, setSessionIds] = useState(() =>
    getSessionCardIds(
      loaded.cards,
      new Date(INITIAL_NOW),
      getNewCardQuotaRemaining(
        loaded.cards,
        new Date(INITIAL_NOW),
        INTENSITY_SETTINGS[loadedStudyPlan.plan.intensity].newCardsPerDay,
      ),
      INTENSITY_SETTINGS[loadedStudyPlan.plan.intensity].reviewLimit,
    ),
  )
  const [newCardLimitOverrideDay, setNewCardLimitOverrideDay] = useState<string | null>(null)
  const [practiceLoopIds, setPracticeLoopIds] = useState<string[] | null>(null)
  const [practiceLoopIndex, setPracticeLoopIndex] = useState(0)
  const [practiceLoopDay, setPracticeLoopDay] = useState<string | null>(null)
  const [savingError, setSavingError] = useState<string | null>(null)
  const [addCardOpen, setAddCardOpen] = useState(false)
  const [sessionSettingsOpen, setSessionSettingsOpen] = useState(false)
  const [studyPlanOpen, setStudyPlanOpen] = useState(false)
  const [frontPanel, setFrontPanel] = useState<'add' | 'session' | 'goal'>('add')
  const [toasts, setToasts] = useState<ToastMessage[]>([])
  const toastId = useRef(0)
  const showToast = useCallback((message: string, kind: 'success' | 'error' = 'success') => {
    const toast = { id: ++toastId.current, message, kind }
    setToasts((current) => [...current.filter((item) => item.kind === 'error'), toast])
  }, [])
  const dismissToast = useCallback((id: number) => {
    setToasts((current) => current.filter((item) => item.id !== id))
  }, [])
  useEffect(() => {
    if (chatOutbox.storageError) showToast(chatOutbox.storageError, 'error')
  }, [chatOutbox.storageError, showToast])
  const [loadedPause] = useState(loadPauseState)
  const [pauseState, setPauseState] = useState(loadedPause.state)
  const pauseStateRef = useRef(loadedPause.state)
  const [pauseNow, setPauseNow] = useState(Date.now)
  const [appSettingsOpen, setAppSettingsOpen] = useState(false)
  const [activityOpen, setActivityOpen] = useState(false)
  const activityTrigger = useRef<HTMLElement | null>(null)
  const changePause = useCallback((update: (state: PauseState) => PauseState) => {
    const next = update(pauseStateRef.current)
    if (next === pauseStateRef.current) return
    pauseStateRef.current = next
    setPauseState(next)
    setPauseNow(Date.now())
    try {
      localStorage.setItem(PAUSE_STORAGE_KEY, JSON.stringify(next))
    } catch {
      showToast('Pause settings or progress could not be saved on this device.', 'error')
    }
  }, [showToast])
  useEffect(() => {
    if (pauseState.until === null) return
    const updateClock = () => {
      const current = Date.now()
      setPauseNow(current)
      if (pauseState.until !== null && current >= pauseState.until) changePause(finishPause)
    }
    const timer = window.setInterval(updateClock, 1000)
    document.addEventListener('visibilitychange', updateClock)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', updateClock)
    }
  }, [pauseState.until, changePause])
  const pauseVisible = pauseState.until !== null
  const copyText = async (text: string) => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable')
      await navigator.clipboard.writeText(text)
      showToast('Copied.')
    } catch {
      showToast('Could not copy. Check clipboard permissions and try again.', 'error')
    }
  }
  const finishIntroduction = () => {
    restoreIntroductionFocus.current = true
    setShowIntroduction(false)
    try {
      localStorage.setItem(INTRODUCTION_STORAGE_KEY, 'seen')
    } catch {
      showToast('The introduction could not be saved and may appear again on your next visit.', 'error')
    }
  }
  const [struggledWith, setStruggledWith] = useState<RecallField[]>([])
  const [studyMode, setStudyMode] = useState<ReviewMode>(
    loadedPause.resumeActivity && loadedPause.resumeActivity !== 'learn' ? loadedPause.resumeActivity : 'recall',
  )
  const [learnOpen, setLearnOpen] = useState(
    () => loadedPause.resumeActivity ? loadedPause.resumeActivity === 'learn'
      : getInitialStudyMode(loaded.cards, new Date(INITIAL_NOW)) === 'learn',
  )
  const [learnSettingsOpen, setLearnSettingsOpen] = useState(false)
  const [studyTag, setStudyTag] = useState('')
  const [choiceFeedback, setChoiceFeedback] = useState<ChoiceFeedback | null>(null)
  const [productionAnswer, setProductionAnswer] = useState('')
  const [productionAlternative, setProductionAlternative] = useState<{ cardId: string; answer: string } | null>(null)
  const [productionFeedback, setProductionFeedback] = useState<ProductionFeedback | null>(null)
  const recordCompletedWord = (id: string, activity: PauseActivity, defer = false) => {
    changePause((state) => recordPauseWord(state, id, Date.now(), defer, activity))
  }
  const importInput = useRef<HTMLInputElement>(null)
  const deckMenu = useRef<HTMLDetailsElement>(null)
  const [deckMenuOpen, setDeckMenuOpen] = useState(false)
  const panelHistoryEntry = useRef<string | null>(null)
  const studyModeHistory = useRef<{
    active: string | null
    base: { learn: boolean; mode: ReviewMode }
    entries: Map<string, { learn: boolean; mode: ReviewMode }>
  }>({ active: null, base: { learn: learnOpen, mode: studyMode }, entries: new Map() })
  const addCardButton = useRef<HTMLButtonElement>(null)
  const setAccountMenuVisible = useCallback((open: boolean) => {
    if (open && !accountMenuEntry.current) {
      const state = { ...window.history.state, __deutschAccountMenu: true }
      delete state.__deutschAccountMode
      if (deckMenu.current?.open && panelHistoryEntry.current === state.__deutschPanel) {
        panelHistoryEntry.current = null
        delete state.__deutschPanel
        window.history.replaceState(state, '', window.location.href)
      } else {
        window.history.pushState(state, '', window.location.href)
      }
      accountMenuEntry.current = true
    } else if (!open && accountMenuEntry.current) {
      accountMenuEntry.current = false
      if (window.history.state?.__deutschAccountMenu) {
        const state = { ...window.history.state }
        const nested = Boolean(state.__deutschAccountMode)
        if (nested) {
          delete state.__deutschAccountMode
          window.history.replaceState(state, '', window.location.href)
        }
        window.history.go(nested ? -2 : -1)
      }
    }
    setAccountMenuOpen(open)
  }, [])
  const openCompanionWorkspace = useCallback(() => {
    if (!companionWorkspaceEntry.current) {
      const token = `${Date.now()}-${Math.random()}`
      const state = { ...window.history.state, __deutschCompanionWorkspace: token }
      delete state.__deutschCompanionChat
      delete state.__deutschCompanionGroup
      delete state.__deutschChatOverlay
      delete state.__deutschAccountMode
      delete state.__deutschCompanionView
      if (accountMenuEntry.current && window.history.state?.__deutschAccountMenu) {
        accountMenuEntry.current = false
        delete state.__deutschAccountMenu
        window.history.replaceState(state, '', window.location.href)
      } else if (deckMenu.current?.open && panelHistoryEntry.current === state.__deutschPanel) {
        panelHistoryEntry.current = null
        delete state.__deutschPanel
        window.history.replaceState(state, '', window.location.href)
      } else {
        window.history.pushState(state, '', window.location.href)
      }
      companionWorkspaceEntry.current = token
      setAccountMenuOpen(false)
    } else {
      setAccountMenuVisible(false)
    }
    setCompanionWorkspaceOpen(true)
    if (deckMenu.current) deckMenu.current.open = false
  }, [setAccountMenuVisible])
  useEffect(() => {
    const handlePopState = (event: PopStateEvent) => {
      if (accountMenuEntry.current && !event.state?.__deutschAccountMenu) {
        accountMenuEntry.current = false
        setAccountMenuOpen(false)
      }
      if (companionWorkspaceEntry.current && event.state?.__deutschCompanionWorkspace !== companionWorkspaceEntry.current) {
        companionWorkspaceEntry.current = null
        setCompanionWorkspaceOpen(false)
      }
    }
    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [])
  const restoreAddCardFocus = useRef(false)
  const restoreSettingsFocus = useRef(false)
  useEffect(() => {
    if (!showIntroduction && restoreIntroductionFocus.current) {
      studyAreaRef.current?.querySelector('button')?.focus()
      restoreIntroductionFocus.current = false
    }
  }, [showIntroduction])
  const closeAddCard = useCallback((restoreFocus = false) => {
    restoreAddCardFocus.current = restoreFocus
    setAddCardOpen(false)
  }, [])
  useEffect(() => {
    if (!addCardOpen && restoreAddCardFocus.current) {
      addCardButton.current?.focus()
      restoreAddCardFocus.current = false
    }
  }, [addCardOpen])
  const closeSessionSettings = useCallback((restoreFocus = false) => {
    restoreSettingsFocus.current = restoreFocus
    setSessionSettingsOpen(false)
  }, [])
  const closeStudyPlan = useCallback((restoreFocus = false) => {
    restoreSettingsFocus.current = restoreFocus
    setStudyPlanOpen(false)
  }, [])
  const closeAppSettings = useCallback((restoreFocus = false) => {
    setAppSettingsOpen(false)
    if (restoreFocus) deckMenu.current?.querySelector('summary')?.focus()
  }, [])
  useEffect(() => {
    if (!sessionSettingsOpen && !studyPlanOpen && restoreSettingsFocus.current) {
      deckMenu.current?.querySelector('summary')?.focus()
      restoreSettingsFocus.current = false
    }
  }, [sessionSettingsOpen, studyPlanOpen])
  const handleAccountUserChange = useCallback((user: AccountUser | null) => {
    setChatOutboxOwner(user?.emailVerified ? user.id : null)
    setCommunityCacheOwner(user?.id ?? null)
    const nextIdentity = user?.email ?? null
    if (accountIdentity.current !== nextIdentity) {
      clearOfflineVoice?.()
      accountIdentity.current = nextIdentity
      setAccountSyncReady(false)
      setAccountSyncError(null)
      setAccountSyncStatus(user ? 'Loading saved progress…' : null)
      accountRevision.current = 0
    }
    setAccountUser(user)
    cacheIdentityQueue.current = cacheIdentityQueue.current.then(async () => {
      const key = 'deutsch-chat-cache-owner'
      const previous = localStorage.getItem(key)
      const next = user?.id ?? null
      if (previous && previous !== next) await clearChatCache(previous)
      if (next) localStorage.setItem(key, next)
      else localStorage.removeItem(key)
    }).catch((failure: unknown) => {
      showToast(failure instanceof Error ? `Could not update saved chat storage: ${failure.message}` : 'Could not update saved chat storage on this device.', 'error')
    })
    if (groupInvitationRef.current && user?.emailVerified && !companionWorkspaceEntry.current) openCompanionWorkspace()
  }, [openCompanionWorkspace, showToast, setChatOutboxOwner, clearOfflineVoice])
  useEffect(() => {
    if (!accountUser?.emailVerified) return
    let active = true
    const accountId = accountUser.id
    void Promise.all([import('./CompanionPanel'), import('./companionsApi')]).then(([, api]) => {
      if (active) return api.prefetchCommunity(accountId)
    }).catch((failure: unknown) => {
      console.warn('Could not prefetch the community workspace.', failure)
    })
    return () => { active = false }
  }, [accountUser?.id, accountUser?.emailVerified])
  useEffect(() => {
    const clear = (event: StorageEvent) => {
      if (event.key === chatCacheClearedKey && event.newValue
        && accountUser?.id && (event.newValue.startsWith(`${accountUser.id}:`) || event.newValue.startsWith('*:'))) {
        clearCommunityDirectoryCache()
      }
    }
    window.addEventListener('storage', clear)
    return () => window.removeEventListener('storage', clear)
  }, [accountUser?.id])
  const intensitySettings = INTENSITY_SETTINGS[studyPlan.intensity]
  const goalEstimate = estimateGoalPace(studyPlan, new Date(now))
  const scopedCards = useMemo(
    () => getCardsForStudySet(cards, studyTag),
    [cards, studyTag],
  )
  const studyProgress = useMemo(() => getStudySetProgress(scopedCards), [scopedCards])
  const activityDays = useMemo(() => summarizeActivity(cards), [cards])
  const accountSyncMessage =
    accountUser && accountSyncReady && (!canSave || studyPlanWarning)
      ? 'Progress sync is paused until saved data can be read.'
      : accountSyncError ?? accountSyncStatus

  const saveDeck = async (nextCards: Card[], failureMessage = 'Your browser could not save this review. Check available device storage.', validateLatest?: (cards: Card[]) => void) => {
    if (!canSave || deckWritePending.current) return false
    deckWritePending.current = true
    const identity = accountIdentity.current
    try {
      const committed = await commitDeckChanges(cards, nextCards, undefined, (latest) => {
        if (accountIdentity.current !== identity) throw new DOMException('Account changed.', 'AbortError')
        validateLatest?.(latest)
      })
      setCards(committed)
      try { localStorage.setItem(LOCAL_PROGRESS_UPDATED_AT_KEY, nowIso()) } catch { /* The deck itself is already saved. */ }
      setSavingError(null)
      return true
    } catch (error) {
      const message = error instanceof DeckConflictError || error instanceof DeckLimitError ? error.message : failureMessage
      setSavingError(message)
      if (companionWorkspaceOpen || addCardOpen || sessionSettingsOpen || deckMenuOpen) showToast(message, 'error')
      return false
    } finally { deckWritePending.current = false }
  }

  useEffect(() => {
    localProgressRef.current = { cards, studyPlan, canSave, studyPlanWarning }
  }, [cards, studyPlan, canSave, studyPlanWarning])

  useEffect(() => {
    if (!accountEmail) return

    let active = true

    const loadCloudProgress = async () => {
      const local = localProgressRef.current
      if (!local.canSave || local.studyPlanWarning) {
        throw new Error('Cloud sync is paused because saved data on this device could not be read safely.')
      }

      const response = await fetch('/api/progress')
      const body = await readApiResponse(response)
      if (
        !body ||
        typeof body !== 'object' ||
        !('progress' in body) ||
        !('revision' in body) ||
        typeof body.revision !== 'number' ||
        !Number.isInteger(body.revision) ||
        body.revision < 0
      ) {
        throw new Error('The account server returned invalid progress data.')
      }
      if (!active) return
      accountRevision.current = body.revision
      const remote = body.progress
      if (remote === null) return
      if (!isCloudProgress(remote)) {
        throw new Error('Cloud progress could not be validated. Your local deck was left unchanged.')
      }

      const localPlanUpdatedAt = localStorage.getItem(LOCAL_STUDY_PLAN_UPDATED_AT_KEY)
      const remotePlanUpdatedAt = remote.studyPlanUpdatedAt ?? remote.updatedAt
      const localPlanDate = Date.parse(localPlanUpdatedAt ?? '')
      const remotePlanDate = Date.parse(remotePlanUpdatedAt)
      const hasSavedLocalPlan = Boolean(localStorage.getItem(STUDY_PLAN_STORAGE_KEY))
      const preferLocalPlan = Number.isFinite(localPlanDate) && localPlanDate > remotePlanDate
        ? true
        : !Number.isFinite(localPlanDate) && !remote.studyPlanUpdatedAt && hasSavedLocalPlan
      const merged = mergeAccountProgress(
        { cards: local.cards, studyPlan: local.studyPlan },
        remote,
        preferLocalPlan,
      )
      const mergedPlanUpdatedAt = preferLocalPlan
        ? localPlanUpdatedAt ?? nowIso()
        : remotePlanUpdatedAt

      setStudyPlan(merged.studyPlan)
      setCanSave(true)
      setStorageWarning(null)
      setStudyPlanWarning(null)
      try {
        setCards(await mergeStoredAccountDeck(localProgressRef.current.cards, merged.cards, undefined, () => active && accountIdentity.current === accountEmail))
        localStorage.setItem(STUDY_PLAN_STORAGE_KEY, JSON.stringify(merged.studyPlan))
        localStorage.setItem(LOCAL_STUDY_PLAN_UPDATED_AT_KEY, mergedPlanUpdatedAt)
        localStorage.setItem(LOCAL_PROGRESS_UPDATED_AT_KEY, nowIso())
        setSavingError(null)
      } catch {
        setSavingError('Cloud progress loaded, but could not be saved to this device.')
      }
    }

    loadCloudProgress()
      .then(() => {
        if (active) {
          setAccountSyncReady(true)
          setAccountSyncStatus('Progress sync is ready.')
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setAccountSyncError(error instanceof Error ? error.message : 'Could not load cloud progress.')
          setAccountSyncStatus(null)
        }
      })

    return () => {
      active = false
    }
  }, [accountEmail])

  useEffect(() => {
    if (!accountEmail || !accountSyncReady || !canSave || studyPlanWarning) return

    const controller = new AbortController()
    const timeout = window.setTimeout(async () => {
      setAccountSyncStatus('Syncing progress…')
      setAccountSyncError(null)
      try {
        let studyPlanUpdatedAt = localStorage.getItem(LOCAL_STUDY_PLAN_UPDATED_AT_KEY)
        if (!studyPlanUpdatedAt) {
          studyPlanUpdatedAt = nowIso()
          localStorage.setItem(LOCAL_STUDY_PLAN_UPDATED_AT_KEY, studyPlanUpdatedAt)
        }
        const response = await fetch('/api/progress', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            cards,
            studyPlan,
            studyPlanUpdatedAt,
            expectedRevision: accountRevision.current,
          }),
          signal: controller.signal,
        })
        if (response.status === 409) {
          const latestResponse = await fetch('/api/progress', { signal: controller.signal })
          const latestBody = await readApiResponse(latestResponse)
          if (
            !latestBody ||
            typeof latestBody !== 'object' ||
            !('progress' in latestBody) ||
            !('revision' in latestBody) ||
            typeof latestBody.revision !== 'number' ||
            !Number.isInteger(latestBody.revision) ||
            !isCloudProgress(latestBody.progress)
          ) {
            throw new Error('The latest cloud progress could not be validated.')
          }

          const remote = latestBody.progress
          const localPlanUpdatedAt = localStorage.getItem(LOCAL_STUDY_PLAN_UPDATED_AT_KEY)
          const remotePlanUpdatedAt = remote.studyPlanUpdatedAt ?? remote.updatedAt
          const localPlanDate = Date.parse(localPlanUpdatedAt ?? '')
          const preferLocalPlan = Number.isFinite(localPlanDate)
            ? localPlanDate > Date.parse(remotePlanUpdatedAt)
            : false
          const merged = mergeAccountProgress(
            { cards, studyPlan },
            remote,
            preferLocalPlan,
          )
          const mergedPlanUpdatedAt = preferLocalPlan
            ? localPlanUpdatedAt ?? nowIso()
            : remotePlanUpdatedAt
          setStudyPlan(merged.studyPlan)
          accountRevision.current = latestBody.revision
          try {
            setCards(await mergeStoredAccountDeck(localProgressRef.current.cards, merged.cards, undefined, () => !controller.signal.aborted && accountIdentity.current === accountEmail))
            localStorage.setItem(STUDY_PLAN_STORAGE_KEY, JSON.stringify(merged.studyPlan))
            localStorage.setItem(LOCAL_STUDY_PLAN_UPDATED_AT_KEY, mergedPlanUpdatedAt)
            localStorage.setItem(LOCAL_PROGRESS_UPDATED_AT_KEY, nowIso())
          } catch {
            setSavingError('Cloud progress was merged, but could not be saved to this device.')
          }
          setAccountSyncStatus('Merged progress from another device.')
          return
        }

        const body = await readApiResponse(response)
        if (!body || typeof body !== 'object' || !('revision' in body) || typeof body.revision !== 'number') {
          throw new Error('The account server returned an invalid sync response.')
        }
        accountRevision.current = body.revision
        setAccountSyncStatus('Progress synced.')
      } catch (error) {
        if (controller.signal.aborted) return
        setAccountSyncError(error instanceof Error ? error.message : 'Could not sync progress.')
        setAccountSyncStatus(null)
      }
    }, 900)

    return () => {
      window.clearTimeout(timeout)
      controller.abort()
    }
  }, [accountEmail, accountSyncReady, canSave, cards, studyPlan, studyPlanWarning])

  const queue = useMemo(() => {
    const sessionSet = new Set(sessionIds)
    return cards
      .filter(
        (card) =>
          sessionSet.has(card.id) &&
          card.status === 'active' &&
          (isUnintroduced(card) || isDueForReview(card, new Date(now))),
      )
      .sort((a, b) => {
        const aNew = isUnintroduced(a)
        const bNew = isUnintroduced(b)
        if (aNew !== bNew) return aNew ? 1 : -1
        return Date.parse(getReviewDueAt(a)) - Date.parse(getReviewDueAt(b))
      })
  }, [cards, now, sessionIds])

  const includeDueFirstReviews = useCallback((at: Date) => {
    const due = scopedCards.filter((card) =>
      card.lastReviewedAt === null && card.firstReviewScheduledAt && isDueForReview(card, at),
    )
    setSessionIds((current) => {
      const available = Math.max(0, intensitySettings.reviewLimit - current.length)
      const additions = due.filter((card) => !current.includes(card.id)).slice(0, available)
      return additions.length ? [...current, ...additions.map((card) => card.id)] : current
    })
  }, [scopedCards, intensitySettings.reviewLimit])

  useEffect(() => {
    const timer = window.setInterval(() => {
      const currentNow = Date.now()
      setNow(currentNow)
      if ((learnOpen || queue.length === 0) && !choiceFeedback && !productionFeedback && !productionAlternative && !practiceLoopIds) {
        includeDueFirstReviews(new Date(currentNow))
      }
      if (practiceLoopIds && practiceLoopDay !== getLocalDayKey(new Date(currentNow))) {
        setPracticeLoopIds(null)
        setPracticeLoopIndex(0)
        setPracticeLoopDay(null)
      }
    }, 30_000)
    return () => window.clearInterval(timer)
  }, [practiceLoopDay, practiceLoopIds, learnOpen, queue.length, choiceFeedback, productionFeedback, productionAlternative, includeDueFirstReviews])

  const choiceScore = studyProgress.choice
  const productionScore = studyProgress.production
  const feedbackCardId = choiceFeedback?.cardId ?? productionFeedback?.cardId ?? productionAlternative?.cardId
  const feedbackCard = feedbackCardId
    ? cards.find((card) => card.id === feedbackCardId)
    : undefined
  const practiceLoopActive =
    practiceLoopIds !== null &&
    practiceLoopDay === getLocalDayKey(new Date(now))
  const practiceLoopCard = practiceLoopActive
    ? cards.find((card) => card.id === practiceLoopIds[practiceLoopIndex] && card.status === 'active')
    : undefined
  const activeCard = feedbackCard ?? practiceLoopCard ?? queue[0]
  const hasQuizFeedback = Boolean(choiceFeedback || productionFeedback)
  const visibleQueueCount = practiceLoopActive
    ? practiceLoopIds.length - practiceLoopIndex
    : queue.length + Number(hasQuizFeedback)
  const choiceQuestionIndex = practiceLoopActive
    ? practiceLoopIndex
    : Math.max(0, choiceScore.answered - Number(Boolean(choiceFeedback)))
  const choiceSelection = activeCard
    ? getStudySetChoiceOptions(activeCard, scopedCards, cards, choiceQuestionIndex)
    : { options: [], usedDeckFallback: false }
  const choiceOptions = choiceSelection.options
  const weakPattern = useMemo(() => detectWeakPattern(cards), [cards])
  const promptWord =
    activeCard?.article && activeCard.prompt.startsWith(`${activeCard.article} `)
      ? activeCard.prompt.slice(activeCard.article.length + 1)
      : activeCard?.prompt
  const promptHint = activeCard?.article
    ? 'Think of the article, plural, and meaning.'
    : 'Think of the meaning and how it works in a sentence.'
  const unseenCardsRemaining = scopedCards.filter(
    isUnintroduced,
  ).length
  const dailyNewCardsRemaining = getStudySetNewCardLimit(
    cards,
    scopedCards,
    new Date(now),
    intensitySettings.newCardsPerDay,
  )
  const newCardLimitOverrideActive =
    newCardLimitOverrideDay === getLocalDayKey(new Date(now))
  const newCardsRemaining = newCardLimitOverrideActive
    ? unseenCardsRemaining
    : dailyNewCardsRemaining
  const dailyLimitReached = unseenCardsRemaining > 0 && dailyNewCardsRemaining === 0
  const introducedTodayCards = getCardsIntroducedToday(scopedCards, new Date(now))
  const sessionIdSet = new Set(sessionIds)
  const dueReviewsRemaining = scopedCards.some(
    (card) =>
      card.status === 'active' &&
      isDueForReview(card, new Date(now)) &&
      !sessionIdSet.has(card.id),
  )
  const getNewCardLimitForSession = (scope: Card[], at: Date, dailyLimit: number) =>
    newCardLimitOverrideDay === getLocalDayKey(at)
      ? scope.filter(isUnintroduced).length
      : getStudySetNewCardLimit(cards, scope, at, dailyLimit)

  const handleRating = async (rating: Rating) => {
    if (!activeCard || !revealed || studyMode !== 'recall') return
    if (practiceLoopActive) {
      advancePracticeLoop()
      return
    }

    const reviewedAt = new Date(nowIso())
    const updatedCards = cards.map((card) =>
      card.id === activeCard.id
        ? reviewLearningCard(recordWordActivity(card, 'reviewed', reviewedAt), rating, reviewedAt, struggledWith)
        : card,
    )
    if (!await saveDeck(updatedCards)) return
    recordCompletedWord(activeCard.id, 'recall')
    setRevealed(false)
    includeDueFirstReviews(reviewedAt)
    setStruggledWith([])
  }

  const handleChoice = async (selectedId: string) => {
    if (!activeCard || choiceFeedback || choiceOptions.length !== 4) return
    const correct = selectedId === activeCard.id
    if (practiceLoopActive) {
      const updatedCards = cards.map((card) => card.id === activeCard.id ? recordWordActivity(card, 'reviewed', new Date(nowIso())) : card)
      if (!await saveDeck(updatedCards)) return
      recordCompletedWord(activeCard.id, 'choice', true)
      setChoiceFeedback({ cardId: activeCard.id, selectedId, correct })
      return
    }
    const reviewedAt = new Date(nowIso())
    const updatedCards = cards.map((card) =>
      card.id === activeCard.id
        ? reviewLearningCard(recordWordActivity(card, 'reviewed', reviewedAt), correct ? 'hard' : 'again', reviewedAt, [], 'choice', correct)
        : card,
    )
    if (!await saveDeck(updatedCards)) return
    recordCompletedWord(activeCard.id, 'choice', true)
    setChoiceFeedback({ cardId: activeCard.id, selectedId, correct })
    includeDueFirstReviews(reviewedAt)
  }

  const gradeProductionAnswer = async (answer: string, acceptAlternative = false) => {
    if (!activeCard || studyMode !== 'production' || productionFeedback || !answer.trim()) return
    const candidate = findProductionAlternative(answer, activeCard, cards)
    const acceptedAnswers = acceptAlternative
      ? [...new Set([...(activeCard.acceptedAnswers ?? []), answer.trim()])]
      : activeCard.acceptedAnswers ?? []
    if (acceptAlternative && (!candidate || !validAcceptedAnswers(acceptedAnswers, activeCard.category))) {
      showToast('This alternative could not be saved. Check the word and try again.', 'error')
      return
    }
    const correct = isProductionAnswerCorrect(answer, activeCard.prompt, acceptedAnswers)
    if (!correct && candidate) {
      setProductionAlternative({ cardId: activeCard.id, answer })
      return
    }
    const reviewedAt = new Date(nowIso())
    const updatedCards = cards.map((card) => {
      if (card.id !== activeCard.id) return card
      const withAnswers = acceptAlternative ? { ...card, acceptedAnswers, acceptedAnswersUpdatedAt: reviewedAt.toISOString(), updatedAt: reviewedAt.toISOString() } : card
      const active = recordWordActivity(withAnswers, 'reviewed', reviewedAt)
      return practiceLoopActive ? active : reviewLearningCard(active, correct ? 'hard' : 'again', reviewedAt, [], 'production', correct)
    })
    if (!await saveDeck(updatedCards)) return
    recordCompletedWord(activeCard.id, 'production', true)
    setProductionAlternative(null)
    setProductionFeedback({ cardId: activeCard.id, answer, correct })
    setProductionAnswer('')
    if (!practiceLoopActive) includeDueFirstReviews(reviewedAt)
  }

  const handleProductionSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    gradeProductionAnswer(productionAnswer.trim())
  }

  const continueQuiz = (resumeActivity?: PauseActivity) => {
    changePause((state) => {
      const next = startPendingPause(state, Date.now())
      return next !== state && resumeActivity ? { ...next, activity: resumeActivity } : next
    })
    setChoiceFeedback(null)
    setProductionFeedback(null)
    setProductionAlternative(null)
    setProductionAnswer('')
    setStruggledWith([])
  }

  const advancePracticeLoop = async () => {
    if (!practiceLoopIds?.length) return
    if (studyMode === 'recall' && activeCard) {
      const updatedCards = cards.map((card) => card.id === activeCard.id ? recordWordActivity(card, 'reviewed', new Date(nowIso())) : card)
      if (!await saveDeck(updatedCards)) return
      recordCompletedWord(activeCard.id, 'recall')
    }
    setPracticeLoopIndex((index) => (index + 1) % practiceLoopIds.length)
    setRevealed(false)
    continueQuiz()
  }

  const startTodayReviewLoop = () => {
    const ids = introducedTodayCards.map((card) => card.id)
    if (ids.length === 0) return
    setPracticeLoopIds(ids)
    setPracticeLoopIndex(0)
    setPracticeLoopDay(getLocalDayKey(new Date(nowIso())))
    setRevealed(false)
    continueQuiz()
    setNow(Date.now())
  }

  const stopTodayReviewLoop = () => {
    setPracticeLoopIds(null)
    setPracticeLoopIndex(0)
    setPracticeLoopDay(null)
    setRevealed(false)
    continueQuiz()
    if (deckMenu.current) deckMenu.current.open = false
    setNow(Date.now())
  }

  const toggleStruggle = (field: RecallField) => {
    setStruggledWith((current) =>
      current.includes(field)
        ? current.filter((value) => value !== field)
        : [...current, field],
    )
  }

  const handleAddCard = async (input: NewCardInput) => {
    const id = crypto.randomUUID()
    const prompt = input.article ? `${input.article} ${input.word}` : input.word
    const userTags = input.tags
      .split('|')
      .map((tag) => tag.trim())
      .filter(Boolean)
    const card = makeCard(
      id,
      prompt,
      input.meaning,
      input.example,
      input.translation,
      input.category,
      [...new Set([input.level, input.category, ...userTags])],
      input.category === 'noun'
        ? { article: input.article, plural: input.plural || undefined }
        : {},
    )
    if (input.acceptedAnswers.length) {
      card.acceptedAnswers = input.acceptedAnswers
      card.acceptedAnswersUpdatedAt = card.createdAt
    }
    const updatedCards = [...cards, card]
    if (!await saveDeck(updatedCards)) return
    closeAddCard(true)
  }

  const receiveSharedWord = async (share: SharedWordPreview) => {
    if (cards.some((card) => card.sharedFrom?.shareId === share.id)) return 'already-present' as const
    const sharedContentKey = [share.card.category, share.card.article ?? '', share.card.prompt, share.card.meaning]
      .join('|').trim().toLocaleLowerCase('de-DE')
    const duplicate = cards.some((card) => cardContentKey(card) === sharedContentKey)
    if (duplicate) {
      return 'already-present' as const
    }
    if (!canSave) {
      showToast('This word could not be saved because your deck has a storage issue.', 'error')
      return false
    }

    const card = makeCard(
      `shared-${share.id}`,
      share.card.prompt,
      share.card.meaning,
      share.card.example,
      share.card.translation ?? '',
      share.card.category,
      [...new Set([share.card.category, 'shared'])],
      { ...(share.card.article ? { article: share.card.article } : {}), ...(share.card.plural ? { plural: share.card.plural } : {}) },
    )
    card.sharedFrom = {
      shareId: share.id,
      username: share.sender.username,
      sharedAt: share.createdAt,
      ...(share.note ? { note: share.note } : {}),
    }
    const updatedCards = [...cards, card]
    if (!await saveDeck(updatedCards, 'The shared word could not be saved to this device. Check available device storage and try again.')) {
      return false
    }
    showToast(`${share.card.prompt} was added to your deck.`)
    return 'added' as const
  }

  const addStarterWord = async (entry: StarterEntry) => {
    const card = cardFromStarterEntry(entry)
    if (cards.some((item) => item.id === card.id || cardContentKey(item) === cardContentKey(card))) {
      return 'already-present' as const
    }
    if (!canSave) {
      showToast('This word could not be saved because your deck has a storage issue.', 'error')
      return false
    }
    const updatedCards = [...cards, card]
    if (!await saveDeck(updatedCards, 'The word could not be saved to this device. Check available device storage and try again.')) {
      return false
    }
    showToast(`${card.prompt} is ready for your next study set.`)
    return 'added' as const
  }

  const addDictionaryWord = async (entry: WordEntry) => {
    if (!entry.example?.trim()) return false
    const article = /^(der|die|das) /.test(entry.prompt) ? entry.prompt.split(' ')[0] : undefined
    const level = entry.level === 'A1' || entry.level === 'A2' ? [entry.level] : []
    const card = makeCard(
      `dictionary-${crypto.randomUUID()}`,
      entry.prompt,
      entry.meaning,
      entry.example ?? '',
      entry.translation ?? '',
      entry.category,
      [...new Set([entry.category, 'Dictionary', ...level])],
      article ? { article, ...(entry.plural ? { plural: entry.plural } : {}) } : {},
    )
    if (cards.some((item) => cardContentKey(item) === cardContentKey(card))) return 'already-present' as const
    if (!canSave) {
      showToast('This word could not be saved because your deck has a storage issue.', 'error')
      return false
    }
    const updatedCards = [...cards, card]
    if (!await saveDeck(updatedCards, 'The word could not be saved to this device. Check available device storage and try again.')) {
      return false
    }
    showToast(`${card.prompt} is ready for your next study set.`)
    return 'added' as const
  }

  const handleExportDeck = () => {
    const backup = {
      format: 'deutsch-daily-deck',
      version: DECK_FILE_VERSION,
      exportedAt: new Date(nowIso()).toISOString(),
      cards,
    }
    const file = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(file)
    const link = document.createElement('a')
    link.href = url
    link.download = `deutsch-deck-${new Date(nowIso()).toISOString().slice(0, 10)}.json`
    link.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 0)
    showToast('Backup download started.')
  }

  const mergeImportedCards = async (incoming: Card[], kind: 'backup' | 'vocabulary') => {
    const knownIds = new Set(cards.map((card) => card.id))
    const knownContent = new Set(cards.map(cardContentKey))
    const additions = incoming.filter((card) => {
      const contentKey = cardContentKey(card)
      if (knownIds.has(card.id) || knownContent.has(contentKey)) return false
      knownIds.add(card.id)
      knownContent.add(contentKey)
      return true
    })
    const incomingById = new Map(kind === 'backup' ? incoming.map((card) => [card.id, card]) : [])
    const merged = [...cards.map((card) => {
      const restored = incomingById.get(card.id)
      return restored ? { ...card, activity: mergeWordActivity(card, restored) } : card
    }), ...additions]
    if (!await saveDeck(merged)) return
    const itemLabel = kind === 'vocabulary'
      ? additions.length === 1 ? 'new word' : 'new words'
      : additions.length === 1 ? 'card' : 'cards'
    showToast(
      additions.length
        ? `Imported ${additions.length} ${itemLabel}. Existing cards were kept.`
        : kind === 'backup' ? 'Existing cards were kept and activity history was merged.' : 'No new cards found. Existing cards were kept.',
      'success',
    )
  }

  const addStarterPackToDeck = async (starterPack: StarterPack) => {
    try {
      const { cards: incoming, kind } = parseDeckFile(
        JSON.stringify(starterPack),
        'open-starter-pack.json',
      )
      await mergeImportedCards(incoming, kind)
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not add the starter vocabulary pack.', 'error')
    }
  }

  const handleImportDeck = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = ''
    if (!file) return

    try {
      const { cards: incoming, kind } = parseDeckFile(await file.text(), file.name)

      await mergeImportedCards(incoming, kind)
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not read that deck file.', 'error')
    }
  }

  const startNextSession = () => {
    const nextNow = new Date(nowIso())
    setSessionIds(
      getSessionCardIds(
        scopedCards,
        nextNow,
        getNewCardLimitForSession(scopedCards, nextNow, intensitySettings.newCardsPerDay),
        intensitySettings.reviewLimit,
      ),
    )
    setPracticeLoopIds(null)
    setPracticeLoopIndex(0)
    setPracticeLoopDay(null)
    setRevealed(false)
    continueQuiz()
    setNow(nextNow.getTime())
  }

  const continueBeyondDailyLimit = () => {
    const nextNow = new Date(nowIso())
    setNewCardLimitOverrideDay(getLocalDayKey(nextNow))
    setSessionIds(
      getSessionCardIds(
        scopedCards,
        nextNow,
        unseenCardsRemaining,
        intensitySettings.reviewLimit,
      ),
    )
    setRevealed(false)
    continueQuiz()
    setNow(nextNow.getTime())
  }

  const startWithStarterPack = async (starterPack: StarterPack) => {
    const fresh = createSeedDeck(starterPack)
    try { setCards(await replaceStoredDeck(cards, fresh)) }
    catch (error) {
      setSavingError(error instanceof DeckConflictError ? error.message : 'Your browser could not save the starter pack. Check available device storage.')
      return
    }
    setStudyTag('')
    setCanSave(true)
    setStorageWarning(null)
    setNewCardLimitOverrideDay(null)
    setPracticeLoopIds(null)
    setPracticeLoopIndex(0)
    setPracticeLoopDay(null)
    setSessionIds(
      getSessionCardIds(
        fresh,
        new Date(nowIso()),
        getStudySetNewCardLimit(
          fresh,
          fresh,
          new Date(nowIso()),
          intensitySettings.newCardsPerDay,
        ),
        intensitySettings.reviewLimit,
      ),
    )
    setRevealed(false)
    try { localStorage.setItem(LOCAL_PROGRESS_UPDATED_AT_KEY, nowIso()) }
    catch { /* The confirmed replacement is already saved. */ }
    setSavingError(null)
  }

  const requestStartWithStarterPack = async () => {
    let starterPack: StarterPack
    try { starterPack = await loadStarterPack() }
    catch {
      showToast('Could not load the starter vocabulary. Check your connection and reload the app.', 'error')
      return
    }
    const hasCards = cards.length > 0
    const confirmed = await confirm({
      title: hasCards ? 'Replace your deck?' : 'Start with the starter vocabulary?',
      message: hasCards
        ? `Your current deck and review progress on this device are replaced by ${starterPack.cards.length.toLocaleString()} open starter words. This cannot be undone.`
        : `${starterPack.cards.length.toLocaleString()} open starter words are added to your deck.`,
      confirmLabel: hasCards ? 'Replace deck' : 'Add starter words',
      tone: hasCards ? 'danger' : 'neutral',
    })
    if (confirmed) startWithStarterPack(starterPack)
  }

  const requestAddStarterPack = async () => {
    let starterPack: StarterPack
    try { starterPack = await loadStarterPack() }
    catch {
      showToast('Could not load the starter vocabulary. Check your connection and reload the app.', 'error')
      return
    }
    const confirmed = await confirm({
      title: `Add ${starterPack.cards.length.toLocaleString()} starter words?`,
      message: 'The open starter vocabulary is added alongside your cards. Existing cards and progress are kept.',
      confirmLabel: 'Add words',
    })
    if (confirmed) addStarterPackToDeck(starterPack)
  }

  const shortDueCard = scopedCards
    .filter(
      (card) =>
        card.status === 'active' &&
        (card.lastRating === 'again' || (card.lastReviewedAt === null && card.firstReviewScheduledAt)) &&
        Date.parse(getReviewDueAt(card)) > now,
    )
    .sort((a, b) => Date.parse(getReviewDueAt(a)) - Date.parse(getReviewDueAt(b)))[0]
  const nextDueCard = scopedCards
    .filter(
      (card) =>
        card.status === 'active' &&
        !isUnintroduced(card) &&
        Date.parse(getReviewDueAt(card)) > now,
    )
    .sort((a, b) => Date.parse(getReviewDueAt(a)) - Date.parse(getReviewDueAt(b)))[0]
  const setMode = (mode: ReviewMode) => {
    const at = new Date(nowIso())
    includeDueFirstReviews(at)
    setNow(at.getTime())
    setLearnOpen(false)
    setLearnSettingsOpen(false)
    setStudyMode(mode)
    continueQuiz(mode)
    setRevealed(false)
  }
  const switchStudyActivity = (next: { learn: boolean; mode: ReviewMode }) => {
    if (learnOpen === next.learn && (next.learn || studyMode === next.mode)) return
    const history = studyModeHistory.current
    if (!history.active) history.base = { learn: learnOpen, mode: studyMode }
    const token = crypto.randomUUID()
    history.entries.set(token, next)
    history.active = token
    window.history.pushState({ ...window.history.state, __deutschStudyMode: token }, '', window.location.href)
    if (next.learn) {
      if (pauseStateRef.current.pending) continueQuiz('learn')
      setLearnOpen(true)
    } else {
      setMode(next.mode)
    }
  }
  useEffect(() => {
    const handleBack = (event: PopStateEvent) => {
      const history = studyModeHistory.current
      const token = typeof event.state?.__deutschStudyMode === 'string' ? event.state.__deutschStudyMode : null
      if (token === history.active) return
      const activity = (token && history.entries.get(token)) || (history.active ? history.base : null)
      if (!activity) return
      history.active = token && history.entries.has(token) ? token : null
      setLearnOpen(activity.learn)
      setStudyMode(activity.mode)
      setLearnSettingsOpen(false)
      setChoiceFeedback(null)
      setProductionFeedback(null)
    setProductionAlternative(null)
      setStruggledWith([])
      setRevealed(false)
    }
    window.addEventListener('popstate', handleBack)
    return () => window.removeEventListener('popstate', handleBack)
  }, [])

  const handleStudyTagChange = (tag: string) => {
    const nextScope = getCardsForStudySet(cards, tag)
    const nextNow = new Date(nowIso())
    setStudyTag(tag)
    setSessionIds(
      getSessionCardIds(
        nextScope,
        nextNow,
        getNewCardLimitForSession(nextScope, nextNow, intensitySettings.newCardsPerDay),
        intensitySettings.reviewLimit,
      ),
    )
    setRevealed(false)
    setPracticeLoopIds(null)
    setPracticeLoopIndex(0)
    setPracticeLoopDay(null)
    continueQuiz()
    setNow(nextNow.getTime())
  }

  const handleResetStudyProgress = async (cardId?: string) => {
    if (!canSave || (accountEmail && !accountSyncReady)) return false
    const reviewedCards = scopedCards.filter((card) =>
      card.lastReviewedAt !== null && (cardId === undefined || card.id === cardId),
    )
    if (!reviewedCards.length) {
      showToast('No reviewed words are available to reset.', 'error')
      return false
    }
    const resetTime = reviewedCards.reduce((latest, card) => Math.max(
      latest,
      Date.parse(card.lastReviewedAt ?? '') + 1,
      card.reviewResetAt ? Date.parse(card.reviewResetAt) + 1 : 0,
    ), Date.parse(nowIso()))
    const resetAt = new Date(resetTime)
    const ids = new Set(reviewedCards.map((card) => card.id))
    const updatedCards = cards.map((card) => ids.has(card.id)
      ? resetReviewProgress({ ...card, activity: activityForCard(card) }, resetAt) : card)
    if (!await saveDeck(updatedCards, 'Review progress could not be reset. Check device storage and try again.')) {
      return false
    }
    if (cardId && activeCard?.id !== cardId) {
      setSessionIds((ids) => ids.filter((id) => id !== cardId))
      const loopIndex = practiceLoopIds?.indexOf(cardId) ?? -1
      if (practiceLoopIds && loopIndex !== -1) {
        setPracticeLoopIds(practiceLoopIds.filter((id) => id !== cardId))
        if (loopIndex < practiceLoopIndex) setPracticeLoopIndex(practiceLoopIndex - 1)
      }
      showToast('Review progress reset.')
      return true
    }
    const nextScope = getCardsForStudySet(updatedCards, studyTag)
    setSessionIds(getSessionCardIds(
      nextScope,
      resetAt,
      getStudySetNewCardLimit(updatedCards, nextScope, resetAt, intensitySettings.newCardsPerDay),
      intensitySettings.reviewLimit,
    ))
    setNewCardLimitOverrideDay(null)
    setPracticeLoopIds(null)
    setPracticeLoopIndex(0)
    setPracticeLoopDay(null)
    setRevealed(false)
    continueQuiz()
    setStruggledWith([])
    setNow(resetAt.getTime())
    showToast('Review progress reset.')
    return true
  }

  const handleSaveStudyPlan = (plan: StudyPlan) => {
    setStudyPlan(plan)
    closeStudyPlan(true)
    const nextNow = new Date(nowIso())
    setSessionIds(
      getSessionCardIds(
        scopedCards,
        nextNow,
        getNewCardLimitForSession(
          scopedCards,
          nextNow,
          INTENSITY_SETTINGS[plan.intensity].newCardsPerDay,
        ),
        INTENSITY_SETTINGS[plan.intensity].reviewLimit,
      ),
    )
    setRevealed(false)
    setChoiceFeedback(null)
    setStruggledWith([])
    const planUpdatedAt = nowIso()
    try {
      localStorage.setItem(STUDY_PLAN_STORAGE_KEY, JSON.stringify(plan))
      localStorage.setItem(LOCAL_STUDY_PLAN_UPDATED_AT_KEY, planUpdatedAt)
      localStorage.setItem(LOCAL_PROGRESS_UPDATED_AT_KEY, planUpdatedAt)
      setStudyPlanWarning(null)
      showToast('Goal and pace saved.')
    } catch {
      setStudyPlanWarning('Your goal was updated for this visit but could not be saved on this device.')
      showToast('Your goal was updated for this visit but could not be saved on this device.', 'error')
    }
  }

  const openStudyPlan = () => {
    setFrontPanel('goal')
    setStudyPlanOpen(true)
    if (deckMenu.current) deckMenu.current.open = false
  }
  const openSessionSettings = () => {
    setFrontPanel('session')
    setSessionSettingsOpen(true)
    if (deckMenu.current) deckMenu.current.open = false
  }
  const openAccountMenu = () => {
    setAccountMenuVisible(true)
    if (deckMenu.current) deckMenu.current.open = false
  }
  const openLearnSettings = () => {
    setLearnSettingsOpen(true)
    if (deckMenu.current) deckMenu.current.open = false
  }
  const openAbout = () => {
    setAboutOpen(true)
    if (deckMenu.current) deckMenu.current.open = false
  }
  const openAppSettings = () => {
    setAppSettingsOpen(true)
    if (deckMenu.current) deckMenu.current.open = false
  }
  const openActivity = () => {
    const focused = document.activeElement
    activityTrigger.current = focused instanceof HTMLElement && !deckMenu.current?.contains(focused)
      ? focused : deckMenu.current?.querySelector('summary') ?? null
    setActivityOpen(true)
    if (deckMenu.current) deckMenu.current.open = false
  }
  const closeActivity = useCallback((restoreFocus = false) => {
    setActivityOpen(false)
    if (restoreFocus) activityTrigger.current?.focus()
  }, [])
  const closeLearnSettings = useCallback((restoreFocus = false) => {
    setLearnSettingsOpen(false)
    if (restoreFocus) deckMenu.current?.querySelector('summary')?.focus()
  }, [])
  const closeAbout = useCallback((restoreFocus = false) => {
    setAboutOpen(false)
    if (restoreFocus) deckMenu.current?.querySelector('summary')?.focus()
  }, [])

  useEffect(() => {
    const open = addCardOpen || sessionSettingsOpen || studyPlanOpen || aboutOpen
      || activityOpen || appSettingsOpen || learnSettingsOpen || deckMenuOpen
    if (open && !panelHistoryEntry.current) {
      const token = `${Date.now()}-${++panelHistorySequence}`
      window.history.pushState({ ...window.history.state, __deutschPanel: token }, '', window.location.href)
      panelHistoryEntry.current = token
    } else if (!open && panelHistoryEntry.current) {
      const token = panelHistoryEntry.current
      panelHistoryEntry.current = null
      if (window.history.state?.__deutschPanel === token
        && !window.history.state?.__deutschAccountMenu
        && !window.history.state?.__deutschCompanionWorkspace) window.history.back()
    }
  }, [addCardOpen, sessionSettingsOpen, studyPlanOpen, aboutOpen, activityOpen, appSettingsOpen, learnSettingsOpen, deckMenuOpen])

  useEffect(() => {
    const handleBack = (event: PopStateEvent) => {
      const token = panelHistoryEntry.current
      if (!token || event.state?.__deutschPanel === token) return
      panelHistoryEntry.current = null
      if (deckMenu.current?.open) {
        deckMenu.current.open = false
        setDeckMenuOpen(false)
        deckMenu.current.querySelector('summary')?.focus()
      } else if (learnSettingsOpen) closeLearnSettings(true)
      else if (appSettingsOpen) closeAppSettings(true)
      else if (activityOpen) closeActivity(true)
      else if (aboutOpen) closeAbout(true)
      else if (frontPanel === 'add' && addCardOpen) closeAddCard(true)
      else if (frontPanel === 'session' && sessionSettingsOpen) closeSessionSettings(true)
      else if (frontPanel === 'goal' && studyPlanOpen) closeStudyPlan(true)
      else if (studyPlanOpen) closeStudyPlan(true)
      else if (sessionSettingsOpen) closeSessionSettings(true)
      else if (addCardOpen) closeAddCard(true)
    }
    window.addEventListener('popstate', handleBack)
    return () => window.removeEventListener('popstate', handleBack)
  }, [addCardOpen, sessionSettingsOpen, studyPlanOpen, aboutOpen, activityOpen, appSettingsOpen,
    learnSettingsOpen, frontPanel, closeAddCard, closeSessionSettings, closeStudyPlan, closeAbout,
    closeActivity, closeAppSettings, closeLearnSettings])

  const studyPlanSummary = `Goal: ${studyPlan.targetLevel} · ${goalEstimate.daysRemaining} days · ${intensitySettings.label} · up to ${intensitySettings.newCardsPerDay} new cards/day`
  const saveLearningCard = async (id: string) => {
    if (!canSave) return
    const at = new Date(nowIso())
    const updatedCards = cards.map((card) => card.id === id
      ? saveForLearning(card, at)
      : card)
    if (!await saveDeck(updatedCards, 'Your browser could not save your learning progress. Check available device storage and try again.')) return
  }
  const addToReviews = async (id: string, beyondLimit: boolean) => {
    const card = cards.find((item) => item.id === id && item.status === 'active' && isUnintroduced(item))
    if (!card || !canSave) return false
    const at = new Date(nowIso())
    if (!beyondLimit && getNewCardQuotaRemaining(cards, at, intensitySettings.newCardsPerDay) === 0) {
      showToast('Your daily new-word target is complete.', 'error')
      return false
    }
    const updatedCards = cards.map((item) => item.id === id
      ? scheduleFirstReview(recordWordActivity(item, 'added', at), at) : item)
    if (!await saveDeck(updatedCards, 'The review could not be scheduled. Check device storage and try again.', (latest) => {
      if (!beyondLimit && getNewCardQuotaRemaining(latest, at, intensitySettings.newCardsPerDay) === 0) throw new DeckLimitError('Your daily new-word target is complete. Choose Add anyway to continue.')
    })) {
      return false
    }
    setSessionIds((ids) => ids.filter((item) => item !== id))
    setNow(at.getTime())
    showToast('Added to reviews. Ready in 10 minutes.')
    recordCompletedWord(id, 'learn')
    return true
  }
  const saveNounPlural = async (id: string, plural: string) => {
    const card = cards.find((item) => item.id === id)
    if (!card || card.plural || card.category !== 'noun' || !canSave) return
    const updatedCards = cards.map((item) => item.id === id ? { ...item, plural, pluralUpdatedAt: new Date(nowIso()).toISOString(), updatedAt: new Date(nowIso()).toISOString() } : item)
    await saveDeck(updatedCards)
  }
  const learnContent = learnOpen && (
    <LearnMode
      cards={cards}
      initialTag={studyTag}
      dailyLimitReached={!newCardLimitOverrideActive && getNewCardQuotaRemaining(cards, new Date(now), intensitySettings.newCardsPerDay) === 0}
      canSave={canSave}
      savingError={savingError}
      settingsOpen={learnSettingsOpen}
      onCloseSettings={closeLearnSettings}
      onSave={saveLearningCard}
      onSchedule={addToReviews}
      onCopy={copyText}
    />
  )

  const closeCompanionWorkspace = (conversationEntry: boolean, viewDepth = 0) => {
    const state = window.history.state
    const conversation = state?.__deutschCompanionChat ?? state?.__deutschCompanionGroup
    const overlay = typeof conversation === 'string' && isChatOverlayEntry(state, conversation)
    if (overlay) window.history.replaceState(withoutChatOverlay(state), '', window.location.href)
    if (companionWorkspaceEntry.current) {
      companionWorkspaceEntry.current = null
      leaveChatHistory(1 + viewDepth + Number(conversationEntry) + Number(overlay))
    } else if (conversationEntry) {
      leaveChatHistory(overlay ? 2 : 1)
    }
    setCompanionWorkspaceOpen(false)
  }
  const handleInvitationHandled = useCallback(() => {
    groupInvitationRef.current = null
    setGroupInvitation(null)
    const url = new URL(window.location.href)
    const fragment = new URLSearchParams(url.hash.slice(1))
    fragment.delete('groupInvite')
    url.hash = fragment.toString()
    window.history.replaceState(window.history.state, '', url)
  }, [])
  const companionWorkspace = (
    <CompanionLoadBoundary onBack={() => closeCompanionWorkspace(
      Boolean(window.history.state?.__deutschCompanionChat || window.history.state?.__deutschCompanionGroup),
      Number.isSafeInteger(window.history.state?.__deutschCompanionView?.depth) ? window.history.state.__deutschCompanionView.depth : 0,
    )}>
    <Suspense fallback={<div className="companion-workspace-view" role="status">Opening your community…</div>}>
    <CompanionPanel
      key={accountUser?.id ?? 'signed-out'}
      cards={cards}
      accountId={accountUser?.id ?? null}
      outbox={chatOutbox}
      onReceiveWord={receiveSharedWord}
      onNotify={showToast}
      onBack={closeCompanionWorkspace}
      invitationToken={groupInvitation}
      onInvitationHandled={handleInvitationHandled}
    />
    </Suspense>
    </CompanionLoadBoundary>
  )

  const scheduledFirstReviews = cards.filter((card) => card.status === 'active' && card.lastReviewedAt === null && card.firstReviewScheduledAt)
  const nextFirstReview = Math.min(...scheduledFirstReviews.map((card) => Date.parse(card.firstReviewScheduledAt!) + 600_000))
  const dueFirstReviewCount = scheduledFirstReviews.filter((card) => Date.parse(card.firstReviewScheduledAt!) + 600_000 <= now).length
  const nextFirstReviewCount = scheduledFirstReviews.filter((card) => Date.parse(card.firstReviewScheduledAt!) + 600_000 === nextFirstReview).length
  const reviewReminder = scheduledFirstReviews.length > 0 && <details className="review-reminder">
    <summary>{dueFirstReviewCount ? 'Reviews ready' : `Review in ${Math.max(1, Math.ceil((nextFirstReview - now) / 60_000))} min`}</summary>
    <p>{dueFirstReviewCount ? `${dueFirstReviewCount} ${dueFirstReviewCount === 1 ? 'word is' : 'words are'} ready to review.` : `${nextFirstReviewCount} ${nextFirstReviewCount === 1 ? 'word is' : 'words are'} coming up for review.`}</p>
  </details>

  const appContent = !activeCard && !learnOpen ? (
      <main className="app-shell empty-state-shell">
        <header className="app-header">
          <a className="wordmark" href="/" aria-label="Deutsch Deck home">
            <span className="wordmark-mark">d</span>
            <span>deutsch deck</span>
          </a>
          <div className="header-actions">
            <button ref={addCardButton} type="button" className="add-card-button" aria-haspopup="dialog" aria-expanded={addCardOpen} onClick={() => { setFrontPanel('add'); setAddCardOpen(true) }}>
              <span aria-hidden="true">+</span> Add a word
            </button>
            <AccountMenu
              onUserChange={handleAccountUserChange}
              onNotify={showToast}
              onOpenCompanions={openCompanionWorkspace}
              onOpenChange={setAccountMenuVisible}
              open={accountMenuOpen}
              syncStatus={accountSyncMessage}
            />
            <details className="deck-menu" ref={deckMenu} onToggle={(event) => setDeckMenuOpen(event.currentTarget.open)}>
              <summary aria-label="Deck backup options">···</summary>
              <div className="deck-menu-popover">
                <button type="button" onClick={openAccountMenu}>
                  {accountUser ? 'Account settings' : 'Account'}
                </button>
                <button type="button" onClick={handleExportDeck}>Download backup</button>
                <button type="button" onClick={openSessionSettings}>Tune session</button>
                <button type="button" onClick={openStudyPlan}>Adjust goal and pace</button>
                <button type="button" onClick={openActivity}>Your activity</button>
                <button type="button" onClick={openAppSettings}>App settings</button>
                <button type="button" onClick={openAbout}>About Deutsch Deck</button>
                {practiceLoopIds && (
                  <button type="button" onClick={stopTodayReviewLoop}>Stop today’s review loop</button>
                )}
                <button type="button" onClick={() => void requestAddStarterPack()}>
                  Add open starter words
                </button>
                <button type="button" onClick={() => importInput.current?.click()}>
                  Import vocabulary or backup
                </button>
                <a href="/deck-template.csv" download>Get spreadsheet template</a>
                <a href="/deck-template.json" download>Get JSON template</a>
                <p>Vocabulary imports start fresh; backups keep review history. Existing words are skipped.</p>
              </div>
            </details>
          </div>
          <input
            ref={importInput}
            type="file"
            accept="application/json,.json,text/csv,.csv"
            aria-hidden="true"
            tabIndex={-1}
            hidden
            onChange={handleImportDeck}
          />
        </header>
        {groupInvitation && !accountUser?.emailVerified && <div className="storage-warning" role="status">Sign in and verify your email to open your group invitation. <button type="button" className="quiet-button" onClick={openAccountMenu}>Account</button></div>}
        {(storageWarning || savingError || studyPlanWarning || loadedPause.warning) && (
          <div className="storage-warning" role="status">
            <p>{storageWarning ?? savingError ?? studyPlanWarning ?? loadedPause.warning}</p>
            {storageWarning && (
              <button type="button" onClick={() => void requestStartWithStarterPack()}>Use the starter vocabulary pack</button>
            )}
          </div>
        )}
        {companionWorkspaceOpen ? companionWorkspace : showIntroduction ? (
          <div className="about-introduction">
            <AboutContent introduction onDone={finishIntroduction} />
            {introduction.warning && <p role="status">{introduction.warning}</p>}
          </div>
        ) : <div ref={studyAreaRef} className="empty-state">
          {reviewReminder}
          <span className="complete-mark" aria-hidden="true"><Check size={20} strokeWidth={1.8} /></span>
          <h1>That’s a good moment to pause.</h1>
          <p className="session-note">
            {nextDueCard
              ? relativeReviewTime(getReviewDueAt(nextDueCard), now)
              : dailyLimitReached
              ? 'Your daily new-card pace is complete. More new cards will be ready tomorrow.'
              : 'You’re all caught up for now.'}
          </p>
          <p className="goal-summary">{studyPlanSummary}</p>
          <button type="button" className="quiet-button goal-edit-button" onClick={openStudyPlan}>
            Adjust goal or daily pace
          </button>
          {choiceScore.answered > 0 && (
            <p className="choice-total">
              Recognition score: {choiceScore.correct}/{choiceScore.answered}
            </p>
          )}
          {productionScore.answered > 0 && (
            <p className="choice-total">
              Production score: {productionScore.correct}/{productionScore.answered}
            </p>
          )}
          {weakPattern && (
            <p className="pattern-note" role="status">
              You marked {weakPattern.field} as difficult in {weakPattern.flaggedReviews} of
              {' '}{weakPattern.observations} reviews, across {weakPattern.affectedCards}
              {' '}{weakPattern.affectedCards === 1 ? 'card' : 'cards'}. Keep an eye on it next time.
            </p>
          )}
          {dueReviewsRemaining || newCardsRemaining > 0 ? (
            <button type="button" className="primary-button" onClick={startNextSession}>
              {dueReviewsRemaining ? 'Continue due reviews' : 'Start next set'}
              <ArrowRight size={16} aria-hidden="true" />
              <small>
                {dueReviewsRemaining
                  ? `Up to ${intensitySettings.reviewLimit} reviews`
                  : `${newCardsRemaining} new cards`}
              </small>
            </button>
          ) : shortDueCard ? (
            <button type="button" className="quiet-button" onClick={() => {
              const at = new Date(nowIso())
              includeDueFirstReviews(at)
              setNow(at.getTime())
            }}>
              Check for reviews
            </button>
          ) : unseenCardsRemaining > 0 ? null : (
            <p className="session-note">Come back when your next cards are due.</p>
          )}
          {(dailyLimitReached || introducedTodayCards.length > 0) && (
            <section className="daily-options" aria-label="More practice options">
              {dailyLimitReached && (
                <>
                  <p>Your new-word target is complete. You can stop here or keep going at your own pace.</p>
                  <button type="button" className="primary-button" onClick={continueBeyondDailyLimit}>
                    Continue beyond today’s target
                    <small>{unseenCardsRemaining} unseen {unseenCardsRemaining === 1 ? 'word' : 'words'} available</small>
                  </button>
                </>
              )}
              {introducedTodayCards.length > 0 && (
                <button type="button" className="quiet-button" onClick={startTodayReviewLoop}>
                  Review today’s {introducedTodayCards.length} {introducedTodayCards.length === 1 ? 'word' : 'words'} again
                </button>
              )}
            </section>
          )}
          <ActivityPreview days={activityDays} today={new Date(now)} onOpen={openActivity} />
          {storageWarning && (
            <button type="button" className="quiet-button reset-button" onClick={() => void requestStartWithStarterPack()}>
              Start fresh with starter vocabulary
            </button>
          )}
        </div>}
        {!companionWorkspaceOpen && <AppFooter signedIn={Boolean(accountUser)} />}
      </main>
  ) : (
    <main className="app-shell">
      <header className="app-header">
        <a className="wordmark" href="/" aria-label="Deutsch Deck home">
          <span className="wordmark-mark">d</span>
          <span>deutsch deck</span>
        </a>
        <div className="header-actions">
          <button ref={addCardButton} type="button" className="add-card-button" aria-haspopup="dialog" aria-expanded={addCardOpen} onClick={() => { setFrontPanel('add'); setAddCardOpen(true) }}>
            <span aria-hidden="true">+</span> Add a word
          </button>
          <AccountMenu
            onUserChange={handleAccountUserChange}
            onNotify={showToast}
            onOpenCompanions={openCompanionWorkspace}
            onOpenChange={setAccountMenuVisible}
            open={accountMenuOpen}
            syncStatus={accountSyncMessage}
          />
          <details className="deck-menu" ref={deckMenu} onToggle={(event) => setDeckMenuOpen(event.currentTarget.open)}>
            <summary aria-label="Deck and study options">···</summary>
            <div className="deck-menu-popover">
              {learnOpen && (
                <button type="button" onClick={openLearnSettings}>Learn settings</button>
              )}
              <button type="button" onClick={openAccountMenu}>
                {accountUser ? 'Account settings' : 'Account'}
              </button>
              <button type="button" onClick={handleExportDeck}>Download backup</button>
              <button type="button" onClick={openSessionSettings}>Tune session</button>
              <button type="button" onClick={openStudyPlan}>Adjust goal and pace</button>
              <button type="button" onClick={openActivity}>Your activity</button>
              <button type="button" onClick={openAppSettings}>App settings</button>
              <button type="button" onClick={openAbout}>About Deutsch Deck</button>
              {practiceLoopIds && (
                <button type="button" onClick={stopTodayReviewLoop}>Stop today’s review loop</button>
              )}
              <button type="button" onClick={() => void requestAddStarterPack()}>
                Add open starter words
              </button>
              <button type="button" onClick={() => importInput.current?.click()}>
                Import vocabulary or backup
              </button>
              <a href="/deck-template.csv" download>Get spreadsheet template</a>
              <a href="/deck-template.json" download>Get JSON template</a>
              <p>Vocabulary imports start fresh; backups keep review history. Existing words are skipped.</p>
            </div>
          </details>
        </div>
        <input
          ref={importInput}
          type="file"
          accept="application/json,.json,text/csv,.csv"
          aria-hidden="true"
          tabIndex={-1}
          hidden
          onChange={handleImportDeck}
        />
      </header>
      {groupInvitation && !accountUser?.emailVerified && <div className="storage-warning" role="status">Sign in and verify your email to open your group invitation. <button type="button" className="quiet-button" onClick={openAccountMenu}>Account</button></div>}

      {(storageWarning || savingError || studyPlanWarning || loadedPause.warning) && (
        <div className="storage-warning" role="status">
          <p>{storageWarning ?? savingError ?? studyPlanWarning ?? loadedPause.warning}</p>
          {storageWarning && (
            <button type="button" onClick={() => void requestStartWithStarterPack()}>Use the starter vocabulary pack</button>
          )}
        </div>
      )}

      {companionWorkspaceOpen ? companionWorkspace : showIntroduction ? (
        <div className="about-introduction">
          <AboutContent introduction onDone={finishIntroduction} />
          {introduction.warning && <p role="status">{introduction.warning}</p>}
        </div>
      ) : <>
      {reviewReminder}
      <div ref={studyAreaRef} className="study-mode-toggle" role="group" aria-label="Study mode">
        <button type="button" className={learnOpen ? 'selected' : ''} aria-pressed={learnOpen} onClick={() => switchStudyActivity({ learn: true, mode: studyMode })}>Learn</button>
        <button
          type="button"
          className={!learnOpen && studyMode === 'recall' ? 'selected' : ''}
          aria-pressed={!learnOpen && studyMode === 'recall'}
          onClick={() => switchStudyActivity({ learn: false, mode: 'recall' })}
        >
          Recall
        </button>
        <button
          type="button"
          className={!learnOpen && studyMode === 'production' ? 'selected' : ''}
          aria-pressed={!learnOpen && studyMode === 'production'}
          onClick={() => switchStudyActivity({ learn: false, mode: 'production' })}
        >
          Produce
        </button>
        <button
          type="button"
          className={!learnOpen && studyMode === 'choice' ? 'selected' : ''}
          aria-pressed={!learnOpen && studyMode === 'choice'}
          onClick={() => switchStudyActivity({ learn: false, mode: 'choice' })}
        >
          Choose
        </button>
      </div>
      {learnOpen ? learnContent : activeCard && (
        <>

      <div className={`deck-shell${(studyMode === 'recall' && revealed) || hasQuizFeedback ? ' deck-shell-expanded' : ''}`}>
        <div className="card card-back card-back-3" aria-hidden="true" />
        <div className="card card-back card-back-2" aria-hidden="true" />
        <div
          key={activeCard.id}
          className={`flashcard ${revealed ? 'revealed' : ''}`}
        >
          <div className="card-header">
            <span className="tag">{activeCard.category}</span>
            <span className="progress">
              {practiceLoopActive
                ? `Loop ${practiceLoopIndex + 1}/${practiceLoopIds?.length ?? 0}`
                : `${visibleQueueCount} left`}
            </span>
          </div>

          {studyMode === 'recall' ? (
            <>
              {!revealed ? <button
                type="button"
                className="card-face"
                onClick={() => setRevealed((value) => !value)}
                aria-label={`Reveal answer for ${promptWord}`}
                aria-pressed={false}
              >
                  <div className="card-front">
                    <p className="prompt-label">German</p>
                    <h2 lang="de">{promptWord}</h2>
                    <span className="tap-hint">{promptHint}</span>
                    <span className="reveal-cue">
                      <span className="reveal-cue-icon"><ArrowUpRight size={23} strokeWidth={3} aria-hidden="true" /></span>
                      <span>Tap to reveal</span>
                    </span>
                  </div>
              </button> : (
                <div className="card-face recall-revealed">
                  <div className="card-back-content">
                    <p className="answer-word"><CopyText text={activeCard.prompt} label="Copy German word or phrase" onCopy={copyText} /></p>
                    <WordAudio card={activeCard} />
                    <div className="answer-meaning">
                      <span className="label">Meaning</span>
                      <strong>{activeCard.meaning}</strong>
                    </div>
                    {activeCard.article && (
                      <div className="fact-row">
                        <span className="label">Article</span>
                        <strong>{activeCard.article}</strong>
                      </div>
                    )}
                    <NounPlural card={activeCard} allowSave />
                    <InteractiveExample variant="recall" example={activeCard.example} translation={activeCard.translation ?? ''} onCopy={copyText} />
                    {activeCard.sharedFrom && <p className="shared-attribution">Shared by {activeCard.sharedFrom.username}{activeCard.sharedFrom.note ? `: ${activeCard.sharedFrom.note}` : ''}</p>}
                  </div>
                  <button type="button" className="quiet-button recall-hide" onClick={() => setRevealed(false)}>Hide answer</button>
                </div>
              )}
              {revealed && (
                <details className="recall-markers">
                  <summary>What felt tricky?</summary>
                  <div className="recall-options" role="group" aria-label="Details that were difficult">
                    {[
                      ...(activeCard.article ? [{ field: 'article' as const, label: 'Article' }] : []),
                      ...(activeCard.plural ? [{ field: 'plural' as const, label: 'Plural' }] : []),
                      { field: 'meaning' as const, label: 'Meaning' },
                      { field: 'context' as const, label: 'Example' },
                    ].map(({ field, label }) => (
                      <label
                        key={field}
                        className={struggledWith.includes(field) ? 'recall-option selected' : 'recall-option'}
                      >
                        <input
                          type="checkbox"
                          checked={struggledWith.includes(field)}
                          onChange={() => toggleStruggle(field)}
                        />
                        {label}
                      </label>
                    ))}
                  </div>
                </details>
              )}
            </>
          ) : studyMode === 'choice' && choiceFeedback ? (
            <div className="choice-result" aria-live="polite">
              <p className={choiceFeedback.correct ? 'choice-result-title correct' : 'choice-result-title incorrect'}>
                {choiceFeedback.correct
                  ? 'Correct.'
                  : 'Not quite. Take another look.'}
              </p>
              {!choiceFeedback.correct && (
                <p className="choice-your-answer">
                  Your choice: {choiceOptions.find((option) => option.cardId === choiceFeedback.selectedId)?.prompt}
                </p>
              )}
              <div className="choice-answer">
                <CopyText as="strong" text={activeCard.prompt} label="Copy German answer" onCopy={copyText} />
                <WordAudio card={activeCard} />
                <span className="choice-meaning">{activeCard.meaning}</span>
                <NounPlural card={activeCard} allowSave />
                <InteractiveExample variant="answer" example={activeCard.example} translation={activeCard.translation ?? ''} onCopy={copyText} />
                {activeCard.sharedFrom && <p className="shared-attribution">Shared by {activeCard.sharedFrom.username}{activeCard.sharedFrom.note ? `: ${activeCard.sharedFrom.note}` : ''}</p>}
              </div>
              <p className="choice-scheduling-note">
                {practiceLoopActive
                  ? 'This repeat loop does not change your schedule or score.'
                  : choiceFeedback.correct
                    ? 'Recognition is useful, but not the same as free recall. This is scheduled as Hard.'
                    : 'This missed item is scheduled for another look in about 10 minutes.'}
              </p>
              {!practiceLoopActive && <StudySetProgressSummary cards={scopedCards} tag={studyTag} />}
            </div>
          ) : studyMode === 'choice' ? (
            <div className="choice-question">
              <div className="choice-prompt">
                <p className="prompt-label">Choose the German word for</p>
                <h2>{activeCard.meaning}</h2>
              </div>
              {choiceOptions.length === 4 ? (
                <>
                  {choiceSelection.usedDeckFallback && (
                    <p className="choice-set-note">
                      This lesson has fewer than four distinct choices, so some options are from other study sets.
                    </p>
                  )}
                  <div className="choice-options" role="group" aria-label="German word choices">
                    {choiceOptions.map((option, index) => (
                      <button
                        type="button"
                        key={option.cardId}
                        className="choice-option"
                        onClick={() => handleChoice(option.cardId)}
                      >
                        <span className="choice-key">{String.fromCharCode(65 + index)}</span>
                        <span lang="de">{option.prompt}</span>
                      </button>
                    ))}
                  </div>
                </>
              ) : (
                <div className="choice-unavailable">
                  <p>
                    {choiceSelection.usedDeckFallback
                      ? 'Even the full deck does not have four distinct choices yet.'
                      : 'This set does not have enough distinct choices yet.'}
                    {' '}Add more vocabulary or return to Recall.
                  </p>
                  <button type="button" className="quiet-button" onClick={() => setMode('recall')}>
                    Return to recall
                  </button>
                </div>
              )}
            </div>
          ) : productionAlternative ? (
            <div className="choice-result production-result" role="status">
              <p className="choice-result-title">Another saved translation fits.</p>
              <p lang="de">{productionAlternative.answer}</p>
              <div className="production-alternative-actions">
                <button type="button" className="rating" disabled={!canSave || (activeCard.acceptedAnswers?.length ?? 0) >= 10} onClick={() => gradeProductionAnswer(productionAlternative.answer, true)}>Save and accept</button>
                <button type="button" className="quiet-button" onClick={() => { setProductionAlternative(null); setProductionAnswer('') }}>Try the saved word</button>
              </div>
            </div>
          ) : productionFeedback ? (
            <div className="choice-result production-result" aria-live="polite">
              <p className={`choice-result-title ${productionFeedback.correct ? 'correct' : 'incorrect'}`}>
                {productionFeedback.correct ? 'Correct.' : productionMismatch(productionFeedback.answer, activeCard.prompt)}
              </p>
              <p className="choice-your-answer">
                You typed: <span lang="de">{productionFeedback.answer}</span>
              </p>
              <div className="choice-answer">
                <CopyText as="strong" text={activeCard.prompt} label="Copy German answer" onCopy={copyText} />
                <WordAudio card={activeCard} />
                <span className="choice-meaning">{activeCard.meaning}</span>
                <NounPlural card={activeCard} allowSave />
                <InteractiveExample variant="answer" example={activeCard.example} translation={activeCard.translation ?? ''} onCopy={copyText} />
                {activeCard.sharedFrom && <p className="shared-attribution">Shared by {activeCard.sharedFrom.username}{activeCard.sharedFrom.note ? `: ${activeCard.sharedFrom.note}` : ''}</p>}
              </div>
              <p className="choice-scheduling-note">
                {practiceLoopActive
                  ? 'This repeat loop does not change your schedule or score.'
                  : productionFeedback.correct
                    ? 'Typed production is scheduled as Hard.'
                    : 'This missed item is scheduled for another look in about 10 minutes.'}
              </p>
            </div>
          ) : (
            <div className="choice-question production-question">
              <div className="choice-prompt">
                <p className="prompt-label">Recall your saved German word</p>
                <h2>{activeCard.meaning}</h2>
                {activeCard.translation && <p className="production-context">{activeCard.translation}</p>}
              </div>
              <form className="production-answer-form" onSubmit={handleProductionSubmit}>
                <label>
                  German word or phrase
                  <input
                    lang="de"
                    autoComplete="off"
                    autoCapitalize="off"
                    maxLength={200}
                    value={productionAnswer}
                    onChange={(event) => setProductionAnswer(event.target.value)}
                    placeholder={activeCard.article ? 'Include der / die / das' : 'Type your answer'}
                    autoFocus
                  />
                </label>
                <p>For nouns, include the article. Case and extra spaces do not matter.</p>
                <button type="submit" className="primary-button" disabled={!productionAnswer.trim()}>
                  Check answer
                </button>
              </form>
            </div>
          )}
        </div>
      </div>

      {studyMode === 'recall' ? (
        <>
          {practiceLoopActive ? (
            <button
              type="button"
              className="primary-button choice-next"
              onClick={advancePracticeLoop}
              disabled={!revealed}
            >
              Next word <ArrowRight size={16} aria-hidden="true" />
            </button>
          ) : (
            <>
              {revealed && (
                <p className="rating-prompt" aria-live="polite">How well did you remember it?</p>
              )}
              <div className="rating-toolbar" aria-label="Review rating controls">
                {(['again', 'hard', 'good', 'easy'] as const).map((rating) => (
                  <button
                    key={rating}
                    type="button"
                    className={`rating ${rating}`}
                    onClick={() => handleRating(rating)}
                    disabled={!revealed}
                  >
                    {rating[0].toUpperCase() + rating.slice(1)}
                    <small>{intervalLabel(activeCard, rating, new Date(now))}</small>
                  </button>
                ))}
              </div>
            </>
          )}
        </>
      ) : hasQuizFeedback ? (
        <button
          type="button"
          className="primary-button choice-next"
          onClick={() => {
            if (practiceLoopActive) advancePracticeLoop()
            else {
              const at = new Date(nowIso())
              includeDueFirstReviews(at)
              setNow(at.getTime())
              continueQuiz()
            }
          }}
        >
          {practiceLoopActive ? 'Next word' : 'Continue to next card'} <ArrowRight size={16} aria-hidden="true" />
        </button>
      ) : studyMode === 'choice' ? (
        <div className="choice-score" aria-live="polite">
          <strong>
            {practiceLoopActive
              ? `Review loop · ${practiceLoopIndex + 1}/${practiceLoopIds?.length ?? 0}`
              : `Recognition score: ${choiceScore.correct}/${choiceScore.answered}`}
          </strong>
          <span>
            {practiceLoopActive
              ? 'Answers in this loop do not change your schedule or score.'
              : 'Correct choices count as Hard; misses return sooner.'}
          </span>
        </div>
      ) : (
        <div className="choice-score" aria-live="polite">
          <strong>
            {practiceLoopActive
              ? `Review loop · ${practiceLoopIndex + 1}/${practiceLoopIds?.length ?? 0}`
              : `Production score: ${productionScore.correct}/${productionScore.answered}`}
          </strong>
          <span>
            {practiceLoopActive
              ? 'Answers in this loop do not change your schedule or score.'
              : 'Typed answers are case-insensitive; spelling and noun articles matter.'}
          </span>
        </div>
      )}
        </>
      )}
      </>}
      {!companionWorkspaceOpen && <AppFooter signedIn={Boolean(accountUser)} />}
    </main>
  )

  return (
    <WordLookupProvider cards={cards} onAdd={addDictionaryWord} onAddStarter={addStarterWord} onSavePlural={saveNounPlural}>
      <div inert={pauseVisible || undefined} aria-hidden={pauseVisible || undefined}>
      {appContent}
      {accountUser && !companionWorkspaceOpen && !showIntroduction && !pauseVisible && (
        <button className="companion-launcher" type="button" onClick={openCompanionWorkspace} aria-label={unreadMessages > 0 ? `Open companion community, ${unreadMessages > 99 ? 'more than 99' : unreadMessages} unread ${unreadMessages === 1 ? 'message' : 'messages'}` : 'Open companion community'} title="Open companion community">
          <MessagesSquare size={22} strokeWidth={1.8} aria-hidden="true" />
          {unreadMessages > 0 && <span className="companion-launcher-badge" aria-hidden="true">{unreadMessages > 99 ? '99+' : unreadMessages}</span>}
        </button>
      )}
      {addCardOpen && (
        <AddCardDialog
          defaultTag={studyTag}
          onClose={closeAddCard}
          onSave={handleAddCard}
          isFront={frontPanel === 'add'}
          onActivate={() => setFrontPanel('add')}
        />
      )}
      {sessionSettingsOpen && (
        <SessionSettingsDialog
          cards={cards}
          tag={studyTag}
          goalSummary={studyPlanSummary}
          now={now}
          onChange={handleStudyTagChange}
          onReset={handleResetStudyProgress}
          resetAvailable={canSave && (!accountEmail || accountSyncReady)}
          onAdjustGoal={() => {
            setSessionSettingsOpen(false)
            openStudyPlan()
          }}
          onClose={closeSessionSettings}
          isFront={frontPanel === 'session'}
          onActivate={() => setFrontPanel('session')}
        />
      )}
      {studyPlanOpen && (
        <StudyPlanDialog
          initialPlan={studyPlan}
          now={new Date(now)}
          onClose={closeStudyPlan}
          onSave={handleSaveStudyPlan}
          isFront={frontPanel === 'goal'}
          onActivate={() => setFrontPanel('goal')}
        />
      )}
      {aboutOpen && <AboutPanel onClose={closeAbout} />}
      {activityOpen && <ActivityDialog days={activityDays} today={new Date(now)} onClose={closeActivity} />}
      {appSettingsOpen && <AppSettingsPanel settings={pauseState.settings}
        onChange={(settings) => changePause((state) => updatePauseSettings(state, settings))}
        messageSound={messageSound} signedIn={Boolean(accountUser?.emailVerified)}
        onClose={closeAppSettings} />}
      <div className="toast-region">
        {toasts.map((toast) => <Toast key={toast.id} toast={toast} onDismiss={dismissToast} />)}
      </div>
      </div>
      {pauseVisible && pauseState.until !== null && (
        <PauseScreen remainingMs={pauseState.until - pauseNow} duration={pauseState.settings.seconds}
          onSkip={() => changePause(finishPause)} />
      )}
    </WordLookupProvider>
  )
}

export default App
