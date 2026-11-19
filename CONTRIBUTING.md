# Contributing to Deutsch Deck

Start with the product overview in [README.md](./README.md) and the learning and engineering rules in [AGENTS.md](./AGENTS.md). Keep community features tied to vocabulary recall, use and feedback. Keep the main study loop available without an account service.

Usage questions and product ideas are hosted in [Deutsch-community Discussions](https://github.com/Dustymaterial/Deutsch-community/discussions). Confirmed bugs, implementation issues and pull requests stay in this repository. Link a relevant discussion from an implementation issue when it supplies context; existing discussions here remain available.

## Local development

Requires Node.js 22.12 or newer.

```sh
npm install
npm run dev
```

This starts Vite and the account API. Local study works without a database. For accounts and sync, copy `.env.example` to `.env` and configure:

| Setting | Purpose |
| --- | --- |
| `MONGODB_URI` | Full MongoDB connection string with credentials and the `/deutsch` database path. URL-encode credential characters and use a database user restricted to `deutsch`. |
| `SESSION_SECRET` | A random secret of at least 32 characters, for example from `openssl rand -base64 32`. |
| `MAILJET_API_KEY`, `MAILJET_SECRET_KEY`, `SENDER_EMAIL` | Account codes and optional companion notifications. Verify the sender or domain in Mailjet. |
| `MODERATOR_USER_IDS` | Comma-separated trusted MongoDB account IDs for moderation access, rather than changeable usernames. |
| `PORT` | API port, default 3001. |

The API explicitly uses the `deutsch` database. Credentials stay on the server; never commit `.env` or expose secrets to Vite. Without email configuration, existing accounts can sign in, but registration and code requests are unavailable.

If port 3001 is occupied, run `PORT=3002 node server/index.js --local` and `DEUTSCH_API_PORT=3002 npx vite` separately. Vite reads `DEUTSCH_API_PORT` or `PORT` from the shell or `.env`.

## Checks and production

```sh
npm test
npm run lint
npm run build
```

The account API integration test uses an in-memory database stand-in. Extend it for route, privacy and limit changes. Replica-set tests additionally require `CHAT_LIVE_MONGO_URI` pointed at a dedicated test database; they skip without it. Restart the API after route changes; `npm run dev` watches for changes automatically.

For production, build and run `npm start` with `NODE_ENV=production`, database and session settings, and HTTPS. The repository's [Render Blueprint](./render.yaml) configures the build, start command, `/api/health` check and HTTPS proxy trust. Supply database and email settings through Render; it generates the session secret.

Use `npm run build` then `npm run preview` to try the production shell locally. The service worker requires HTTPS or localhost and cannot make previously undownloaded content available offline. The starter pack loads when needed; returning learners with a saved deck do not need to download it for startup.

## Review scheduling

The deterministic, SM-2-inspired heuristic lives in [src/scheduler.ts](./src/scheduler.ts). It uses previous interval, ease, repetitions, lapses and the submitted result. It does not estimate measured memory strength or guarantee retention.

New cards begin at interval 0, ease 2.5, zero repetitions and lapses. Adding to reviews sets the first review for 10 elapsed minutes later; only an answer or rating records a review. First-review and Again delays use timestamp arithmetic across clock changes. Day calculations round to whole days and use local calendar dates, so a one-day interval can span 23 or 25 hours.

| Rating | Next interval | State change |
| --- | --- | --- |
| Again | 10 minutes | Reset repetitions, increment lapses and incorrect count; ease falls by 0.2, minimum 1.3. |
| Hard (self-rated Recall) | First success: 1 day. Later: max(1, round(previous interval × 1.2)). | Increment repetitions and correct count; ease falls by 0.1, minimum 1.3. |
| Hard (correct Produce/Choose) | First success: 1 day. Later: max(previous interval + 1, round(previous interval × 1.2)). | Increment repetitions and correct count; preserve ease. |
| Good | First success: 1 day. Later: max(1, round(previous interval × previous ease)). | Increment repetitions and correct count; ease rises by 0.05, maximum 3. |
| Easy | First success: 3 days. Later: max(2, round(previous interval × previous ease × 1.4)). | Increment repetitions and correct count; ease rises by 0.1, maximum 3. |

Recall stores a self-rating. Produce and Choose store objective quiz results separately and map correct answers to Hard and misses to Again. Every scheduled review records time, rating, resulting interval/ease, mode and optional difficulty details.

Correct quiz answers explicitly require a choice/production mode and `answerCorrect: true` to receive the quiz-specific Hard transition. This avoids one/two-day rounding traps and does not infer self-reported difficulty from a correct answer. Both quiz modes currently share this conservative rule; it is not a validated equivalence between recognition, production and recall. Switching modes uses the same card schedule and ease with distinct history labels. Misses still lower ease through Again, and self-rated Recall keeps its existing rules. Missing legacy result metadata does not qualify as a confirmed quiz success. Changes apply only to new submitted reviews: do not rewrite saved due dates, restore historical ease or recalculate old events.

Sessions select due active cards first, oldest due time first, then more lapses and oldest review. Unseen cards follow within session and shared daily limits. Future reviews are not pulled forward to fill a session. Continuing beyond the target affects the current visit/day, not scheduling. Repeating today's words does not append history, change quiz scores or reschedule cards.

Save, Skip and gentle checks in Learn do not record reviews, schedule cards, count activity or consume the new-word allowance. Saved learning syncs independently; a later first review supersedes an older save. Previous/Next retrace a session-only path, including skipped and read-only scheduled cards. View/filter changes or leaving Learn reset that path.

Difficulty suggestions require at least five observations, three flags across two cards, and a flag rate of at least 35%. The highest rate wins. This is an optional notice, not automatic adaptation.

Pauses default to 60 seconds after three distinct added or reviewed words. Allowed frequencies are 3/5/10, durations 30/60/120 seconds. Quiz feedback precedes a pending pause; saved deadlines use wall-clock time across backgrounding and reload. Settings changes reset the count. These device-local settings are not backed up or synced. Keep the implementation, tests and README aligned when changing them.

Activity counts a word once per local day when added to reviews or reviewed; added/reviewed breakdowns can overlap. It survives resets, backups and merges. Legacy reconstruction may be incomplete. No activity count measures mastery.

## Goals, content and imports

Daily intensity defaults are Steady (5 new / 30 due, 15 planning minutes), Focused (10 / 50, 30 minutes), and Intensive (15 / 80, 50 minutes). These are ceilings and planning allowances, not required quotas. The editable example goal is B1 about 90 days away with an unknown starting level. Broad course-hour estimates cite [Goethe-Institut guidance](https://www.goethe.de/ins/gb/en/sta/lon/kur/faq.html); vocabulary cards cannot predict CEFR attainment.

The design emphasizes recall and spaced practice. Research includes [retrieval of foreign-language vocabulary](https://doi.org/10.1126/science.1152408) and a [second-language spacing meta-analysis](https://doi.org/10.1111/lang.12479). Neither validates this app's specific schedule or card quotas.

Use the downloadable [CSV](./public/deck-template.csv) and [JSON](./public/deck-template.json) templates. Required fields are word, category, meaning and a German example; nouns also require article. Optional fields include plural, translation, level and tags. Supported categories are noun, verb, adjective, adverb, numeral and phrase. CSV uses UTF-8 and `|`-separated tags; JSON uses a string array. Use a separate tag for each lesson or topic. Check meanings, examples and level labels before importing.

Imports are additive. Vocabulary files begin with fresh review state; backups preserve it for new cards and merge per-word activity for matching IDs. Existing cards and duplicate lexical entries are not overwritten. Invalid files are rejected. Added words appear in the next study set. Resetting progress needs confirmation, affects a word in every set that shares it, and must survive later sync with older history.

Keep data separately licensed and attributed as described in [DATA_SOURCES.md](./DATA_SOURCES.md). Rebuild with `npm run data:starter-pack` or `npm run data:dictionary`; these require internet access. The dictionary builder reuses a temporary download cache. Word-level example highlights are a manually verified prototype: match exact sentence pairs and do not infer other alignments.

## Live messaging

Private chats, group chats and Review together use authenticated Socket.IO WebSockets. Commands reuse the HTTP validation and rate limits. Check sessions and membership for both commands and deliveries, serialize for the recipient, and keep pending cards and unrevealed answers private. Typing sends a temporary indicator, not draft text, and does not write to the database.

Healthy delivery sends only changed messages. Review-only updates skip history. Reconnects reconcile with authoritative snapshots/replay, merging valid deltas into the bounded local cache. Invalid cursors replace the cached page. Unchanged data should not trigger network payloads or storage writes. When sockets fail, live event hints and five-second outage polling provide fallback. Failed action acknowledgements are not blindly resent; ordinary message retries reuse an identifier to avoid duplicates.

Saved pages also have a bounded account-scoped memory copy for immediate workspace reopening. Review summaries are valid cached messages. Disk hydration precedes a fetch decision, and temporary refresh failures retain history. Reset flags apply to one complete authoritative page, never subsequent deltas. A short socket connection grace period avoids opening a competing event stream on every healthy chat visit. Cache clearing invalidates both disk writes and warm memory.

Direct delivery works on one API instance with standalone MongoDB. Replica sets or Atlas additionally enable durable replay, message sound hints and cross-instance saved changes. Multiple API instances need a shared transient adapter for typing. Forward WebSocket upgrades for `/socket.io` and event streams under `/api`. Device latency and production load have not been measured.

Review together shares only five reviewed active cards, optionally scoped by a tag. It prefers words not reviewed in the previous ten minutes when enough are available. Invitations hide the selection until acceptance; active sessions expire after 24 hours. Declining or ending clears the selected card/answer data. Reveal requests persist across reconnects and require helper approval. Peer outcomes never create individual review history, activity or scheduling changes. Session summaries have an idempotent server identity, a distinct Review tag, and cannot be edited or sentence-corrected; existing reply, reaction, report and unsend rules apply.

## Privacy and service limits

- Decks, history and goals are stored locally and optionally synced to MongoDB. Corrupt storage must be reported without overwriting it. Keep backup/recovery explicit.
- Account codes are single-use, expire after 10 minutes, have attempt/resend limits and are stored as keyed digests. Password resets invalidate sessions. Signed-in password changes keep the current session and invalidate others. Existing unverified accounts can study; community requires verification.
- Mailjet receives recipient addresses and email content, including avatars, codes or a sender's username as applicable. Companion emails default on and can be disabled. They exclude chat text and shared-word content. At most five notification emails reach a recipient per hour. In-app activity remains available when email fails.
- Local chat caching defaults on: up to 50 messages for each of 20 private and 20 group conversations per account. Pages older than 24 hours are not displayed but may remain in browser storage until overwritten or cleared. Copies can be stale, including removed content or revoked access, until server validation. Cache errors are reported. Turning caching off, signing out or changing accounts clears account-scoped copies. They are not encrypted against another person using the same browser profile.
- Message receipt icons distinguish sending, server acceptance, another participant's delivery and viewing. A group acknowledgement from any other member is sufficient. Do not use receipts to pressure learners.
- Private texts allow 2,000 characters; group texts allow 1,000. Sender edits are limited to 10 minutes and stop after review. Private unsend also has a 10-minute window; group senders can unsend at any time. Report copies may remain after unsending. Sentence suggestions are optional; authors choose whether to save them.
- Account limits include 300 companion actions per 15 minutes, 60 messages/reviews per hour, ten connection requests and ten shares per hour, and one manual companion reminder per 24 hours. Read-only refreshes do not count as actions. Shares expire after 30 days and are never added automatically.
- Verified learners can create up to three groups, join up to 20, and each group holds up to 100 members. Group posting limits include two links, duplicate limits and a brief send interval. Rules are acknowledged before first create/join. Unlisted links work only while a group is open; changing listing invalidates the link. Removed members cannot rejoin.
- Group owners can manage their group and hide content. Members can separately report messages and sentence reviews. Three distinct reports hide the item automatically. Moderators can dismiss, hide or suspend group participation for 1 to 90 days. Resolved reports expire after 90 days; group messages after one year.
- No private chat, group content, deck or study history goes automatically to an AI or translation service. Browser lookup uses deck, starter and dictionary data; external links open only on request. Human pronunciation requests go directly to Wikimedia Commons only when Listen is selected and are not app-cached.
- Optional message sounds require the app to be open and browser audio permission from a user gesture. Use Test sound on mobile; volume, silent mode and background restrictions still apply. Missed sounds are not replayed.

Keep form errors beside their fields, reduced-motion support, mobile layout and keyboard access. Use the shared confirmation dialog for destructive or impactful actions; keep routine sends, ratings and reactions direct. Planning files and `memory.md` are local and ignored, never part of a contribution.

## Group safety checks

`server/groupSafety.js` contains a deliberately narrow English/German abuse list. NFKC normalization, case folding, zero-width removal and whole-word matching trigger a review hold, not a judgement about intent. The check covers new messages, edits, every shared-card field and suggestion text/notes. It is not contextual classification, does not catch all obfuscations or harmful language, and can hold a legitimate vocabulary question. It does not retrospectively scan history or filter private companion chats.

Held items use the existing hidden-content paths so member serializers, search, previews, mentions and sound hints withhold content. A neutral placeholder explains the hold. Automatic reports retain the text for authorized moderators and use the existing resolved-report retention; they are excluded from the three-human-report threshold. Show content requires the inspected report version and a matching pending hold; unsent and manually hidden content cannot be restored by a stale action. Keep hidden closes the report without exposing it. Pending holds repair missing automatic reports on subsequent reads, while duplicate reports are suppressed.

Moderation decisions publish a scoped live message update directly, so restoring or hiding content does not depend on a database change stream. The API integration test verifies restoration over a live socket with the in-memory database.

HTTP(S)/www links remain visible with a warning, including cached messages. No URL is fetched or certified safe; no message goes to an external classifier. Existing link, rate, duplicate and reporting limits remain, and suggestions also have the two-link cap. Expand these rules only with a documented moderation decision and tests for vocabulary false positives.

## Shared word lookup

`WordLookupProvider` supplies local vocabulary to card and community surfaces. `useWordLookup` lazily loads the dictionary and starter set, preserves personal example/translation fields, and offers an explicit retry after a failed download. `lookupResults.ts` preserves distinct senses and uses verified dictionary lemma mappings to resolve inflected words back to personal vocabulary. None of this data is sent to another learner or a remote translation service.

The dictionary builder includes source-backed words and form-of references needed by supplied examples beyond the normal frequency cut, including contractions. Its coverage metadata lists unresolved tokens; do not fabricate meanings to reach a percentage. Exact bilingual sentence alignment stays separate from context-free word lookup.

## Pronunciation catalogue

`npm run data:pronunciation` scans the pinned-source Wiktionary extract for starter headwords and plural forms, verifies Commons metadata in batches, and produces a separate lazy-loaded catalogue. Preserve per-file author, source and license. Prefer free source-listed alternatives to noncommercial or unattributed files; manual attribution corrections must point to an explicit Commons creator statement. Do not infer the creator from the uploader. Tests require coverage of the current starter set and valid attribution links. Catalogue matching is not a full linguistic review of every homograph.

`WordAudio` waits for voice-list updates, favours local German voices, and requires a separate user action for remote browser speech. A real user gesture initiates audio playback; failed playback remains retryable. No audio request happens merely by displaying a card.

The optional GPL offline voice stays outside the MIT bundle in a same-origin frame. See [its build and release guide](./optional/german-voice/README.md). Test installer integrity/rollback, worker cancellation, offline preview navigation and server asset verification with `node --test tests/optionalVoice*.test.mjs`. A local staged manifest can exercise the candidate with `DEUTSCH_VOICE_ASSETS_DIR`; never mark phone checks complete based on desktop emulation. The checked-in release enables an explicit preview for physical-device testing; source/license/desktop-offline checks pass, while phone checks remain false. Do not commit models or generated source archives.

## Quiz answer fairness

Choose deduplicates normalized displayed prompts before choosing three distractors and excludes known overlapping gloss alternatives or explicit accepted keys. Fewer than four safe choices keeps the existing unavailable/fallback behavior. This is conservative exclusion, not general semantic understanding.

Produce accepts the saved prompt plus at most ten explicitly defined `acceptedAnswers` (200 characters each). Noun alternatives include their own der/die/das. Authors can set keys in Add a word or vocabulary JSON; CSV uses an optional `acceptedAnswers` column with `|` separators. Keys survive backups and optional account sync. A typed answer matching another active personal card with overlapping meaning is held neutrally before grading; Save and accept explicitly adds its key and records one success. Trying the saved target records nothing until an answer is submitted. No dictionary synonym is silently accepted. Existing incorrect reviews are not rewritten.

## Noun form corrections

`nounForms.ts` keeps recorded learner forms authoritative and matches the curated supplement by exact lexical identity. Unknown means not recorded, not no plural. Suggested source forms and verified usual-number states appear in Learn and revealed review surfaces, including companion reveals, without exposing concealed answers. Use plural fills an empty personal field only; it never appends review history, counts a completion or changes the due date. `pluralUpdatedAt` preserves this explicit lexical edit independently from a later review on an older device. Validate this optional ISO timestamp in backup and account paths.

The outbox uses the existing chat-cache account generation and a separate outbox kind, bounded to 20 message records for 24 hours. Reload restores unconfirmed sends for explicit retry with their original client ID; it never automatically sends them. Cache preference, clearing and account transitions apply to these records too. Storage failure leaves sending available but reports that the local copy was not saved.

Study actions persist before state/feedback/activity transitions. Accepted-answer edits have their own timestamp, including empty edits, independently of review timestamps. Practice commands require the last seen revision and atomically compare both revision and card index. The service worker keeps a valid HTML shell, tolerates cache failures and excludes API/socket/optional-voice traffic.

Local deck commits serialize through Web Locks, with a read/write IndexedDB transaction as the fallback mutex. Commits reread storage, merge only the current action's changed cards and reject stale edits to the same card. Cloud merge and confirmed replacement share this boundary. The new-word allowance is checked within the commit, and asynchronous callbacks await success before navigation or feedback. Another tab's write never changes the selected mode by itself.
