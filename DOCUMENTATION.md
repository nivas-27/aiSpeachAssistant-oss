# Fluently — AI Speech Practice
## Complete technical documentation

Generated 2026-09-09 from the source tree.

---

## 1. What the product is

Fluently is a speech-to-speech English practice application. A signed-in learner joins a
20-minute voice room, speaks to an AI partner that answers out loud, and afterwards reads a
report computed from their own transcripts.

The pipeline is **speech → text → text → speech**:

| Stage | Provider | Model | Module |
|---|---|---|---|
| Transcription (STT) | OpenAI | `gpt-4o-mini-transcribe` | `backend/app/services/whisper_openAi_service.py` |
| Conversation (LLM) | Google Gemini | `gemini-2.5-flash-lite` → `gemini-flash-lite-latest` → `gemini-2.5-flash` | `backend/app/services/gemini_chat_service.py` |
| Speech (TTS) | OpenAI | `gpt-4o-mini-tts`, voice `coral` | `backend/app/services/openAi_TTS_service.py` |

The assistant's reply is streamed from Gemini and synthesised **sentence by sentence**, so
audio begins playing before the full answer exists.

Persistence is **MongoDB** through the synchronous `pymongo` driver.

---

## 2. Repository layout

```
aiSpeachAssistant/
├── README.md                     Setup and operating guide
├── DOCUMENTATION.md              This file
│
├── backend\                      FastAPI service (Python 3.12)
│   ├── .env                      Secrets and configuration (not committed)
│   ├── requirements.txt
│   ├── test.py                   Stray CUDA probe, unused by the app
│   ├── uploads\                  Incoming .webm recordings (created at import time)
│   ├── tts-outputs\              Generated .mp3 segments served by /audio
│   ├── scripts\                  One-off, idempotent migrations
│   │   ├── backfill_streaks.py
│   │   ├── migrate_embed_turns.py
│   │   └── migrate_soft_delete.py
│   └── app\
│       ├── main.py               App factory, lifespan, CORS, router wiring
│       ├── core\                 config, database, deps, security, soft_delete
│       ├── models\               Document builders and Pydantic schemas
│       ├── routes\               auth, sessions, transcribe, audio, analytics
│       ├── services\             STT, LLM, TTS, OTP, mail, memory, analytics, telemetry
│       └── utils\file_utils.py   Upload and output file helpers
│
└── frontend\   React 19 + Vite 8 SPA
    ├── .env                      VITE_BACKEND_URL
    ├── index.html
    ├── vite.config.js            React plugin + React Compiler babel preset
    ├── dist\                     Built output
    └── src\
        ├── main.jsx              Root render, BrowserRouter, global CSS
        ├── App.jsx               Route table and auth guards
        ├── apiCalls\             fetch client, endpoint wrappers, NDJSON reader
        ├── context\              AuthProvider and useAuth
        ├── components\           AppShell, RouteGuards, MeetingRoom, OtpInput,
        │                         MethodologyPanel, charts\Charts.jsx
        ├── pages\                Landing, AuthPage, ForgotPassword, Home,
        │                         Practice, Reports
        └── styles\theme.css      Design tokens shared by every page
```

Dead code still present: `backend/app/services/whisper_service.py` (fully commented out),
`edge_tts_service.py`, `elvenlabs_service.py`, `openAdapter_chat_service.py`,
`backend/test.py`, `src/pages/recorder.jsx` and `src/components/audioRecorder.jsx`. None of
these are reachable from the running application.

---

## 3. Backend

### 3.1 Application entry point

`app/main.py` builds the FastAPI app with `title` from settings and version `1.1.0`.

The lifespan handler:

1. Calls `init_db()` and prints the result. A failed connection **does not crash the app** —
   the API boots so the failure is visible on `/health` rather than as a refused connection.
2. Warns when `JWT_SECRET` is unset, because a generated secret invalidates every login on
   each restart.
3. Notes when SMTP is unconfigured, meaning verification codes go to the console.
4. On shutdown, closes the Mongo client.

CORS is wide open (`allow_origins=["*"]`) with a comment marking it for restriction.

Two unrouted endpoints:

- `GET /` — name and version.
- `GET /health` — `{"status": "ok" | "degraded", "database": <message>}`.

### 3.2 Configuration — `app/core/config.py`

A plain `Settings` class reading `os.getenv` at import time. `load_dotenv()` runs first, both
here and in `main.py`.

| Setting | Default | Purpose |
|---|---|---|
| `APP_NAME` | `Fluently - AI Speech Practice` | FastAPI title |
| `JWT_SECRET` | random `token_urlsafe(48)` | Token signing |
| `JWT_ALGORITHM` | `HS256` | Fixed, not configurable |
| `ACCESS_TOKEN_EXPIRE_DAYS` | `7` | Token lifetime |
| `MONGODB_URI` | `mongodb://localhost:27017` | Connection string |
| `MONGODB_DB` | `fluently` | Database name |
| `MONGODB_TIMEOUT_MS` | `4000` | Server-selection timeout, fails fast |
| `SESSION_DURATION_SECONDS` | `1200` | 20-minute session cap |
| `OTP_LENGTH` | `6` | Passcode digits |
| `OTP_TTL_MINUTES` | `10` | Code lifetime |
| `OTP_MAX_ATTEMPTS` | `5` | Wrong codes before the record is retired |
| `OTP_RESEND_SECONDS` | `60` | Resend throttle |
| `SMTP_HOST/PORT/USER/PASSWORD/FROM/STARTTLS` | none / 587 / … / true | Mail delivery |
| `ALERT_EMAIL_TO` | falls back to `SMTP_USER` | Operator alerts |
| `LLM_ALERT_COOLDOWN_MINUTES` | `180` | Alert throttle |

Three derived properties:

- `smtp_configured` — true when `SMTP_HOST` is set.
- `expose_otp_in_response` — returns the passcode in the API response **only** when SMTP is
  unconfigured. Configuring mail turns it off automatically; `OTP_DEV_ECHO` can disable it too.
- `jwt_secret_is_ephemeral` — true when `JWT_SECRET` came from the random fallback.

Unused keys present in `.env`: `ELEVEN_LABS_API_KEY`, `DEEPGRAM_API_KEY`,
`OPENADAPTER_OPENAI_API_KEY`.

### 3.3 Database — `app/core/database.py`

A single module-level `MongoClient`, created lazily and `tz_aware=True`. Collection accessors:
`users()`, `practice_sessions()`, `pending_signups()`, `password_resets()`, `llm_events()`.

`ping()` returns `(ok, message)` and distinguishes an unreachable server from any other
PyMongo error. `init_db()` pings, then creates indexes idempotently:

| Collection | Index | Type |
|---|---|---|
| `users` | `email` | unique, partial on `{deleted: false}`, name `uniq_live_email` |
| `practice_sessions` | `user_id ASC, started_at DESC` | name `user_recent` |
| `pending_signups` | `email` | unique, partial on live |
| `password_resets` | `email` | unique, partial on live |
| `llm_events` | `created_at DESC` | name `recent` |
| `llm_events` | `provider, kind, created_at DESC` | name `provider_kind_recent` |
| `llm_events` | `session_id` | name `by_session` |

**No TTL indexes exist by design.** A TTL index physically removes documents, which would
defeat soft delete. Expiry is enforced in application code and an expired record is retired,
not erased.

### 3.4 Soft delete — `app/core/soft_delete.py`

The rule for every collection: nothing is ever physically removed. A record is retired with
`deleted: true` plus a `deleted_at` timestamp, and every read filters it out.

Two invariants make this work:

1. Every document is created with `deleted: False` written **explicitly**, so partial indexes
   can key on it. MongoDB rejects `$ne` inside a `partialFilterExpression`, which is exactly
   why the field cannot simply be absent.
2. Every read goes through `live(query)`, which appends `{"deleted": {"$ne": True}}`. The `$ne`
   form tolerates documents written before the convention existed.

Helpers: `live()`, `new_fields()`, `deletion_update()`, `soft_delete_one()`,
`soft_delete_many()`. Constants: `NOT_DELETED` for reads, `LIVE_INDEX_FILTER` for indexes.

### 3.5 Security — `app/core/security.py`

- `hash_password` / `verify_password` — bcrypt with a generated salt. `verify_password`
  swallows `ValueError` and `TypeError` and returns `False`.
- bcrypt silently truncates past 72 bytes, so `MAX_PASSWORD_BYTES = 72` is documented here and
  enforced in the Pydantic validators.
- `create_access_token(user_id, email)` — HS256 JWT carrying `sub`, `email`, `iat`, `exp`.
- `decode_access_token` — returns the payload or `None` on any `PyJWTError`.

### 3.6 Auth dependency — `app/core/deps.py`

`get_current_user` reads the `Authorization` header directly (no OAuth2 scheme object),
requires the `Bearer ` prefix case-insensitively, decodes the token, converts `sub` to an
`ObjectId`, and loads a live user. Every failure raises the same 401 with a
`WWW-Authenticate: Bearer` header, so nothing leaks about which step failed.

### 3.7 Document shapes — `app/models/db_models.py`

Helpers: `utcnow()`, `as_utc()` (Mongo can return naive datetimes), `to_object_id()`.

**`new_user`** — `email`, `full_name`, `password_hash`, `email_verified: True` (only verified
signups reach this collection), `created_at`, `last_login_at`, a `practice` sub-document
holding `{last_practice_date, current_streak, longest_streak}`, plus the soft-delete fields.

**`new_session`** — `_id` is the caller-supplied hex session id (not an ObjectId), `user_id`,
`started_at`, `ended_at`, `duration_seconds`, `status` (`active` | `completed`), and an
embedded `turns: []`. Turns live inside the session because they are only ever read with it,
and the 20-minute cap bounds the array well below the 16 MB document limit.

**`new_turn`** — `role`, `content`, `word_count`, `created_at`, and the per-stage timings
`stt_ms`, `llm_ms`, `tts_ms`.

**`new_llm_event`** — `provider`, `operation` (`stt`|`chat`|`tts`|`alert`), `model`, `ok`,
`kind`, `message`, `usage`, `latency_ms`, `session_id`, `user_id`, `extra`, `created_at`.

**Streaks** are counters on the user, not a scan of history:

- `advance_streak(user, today)` runs once at session start, O(1). Same day keeps the count,
  yesterday increments it, anything else resets to 1. `longest_streak` is the running max.
- `read_streak(user, today)` applies lapse at read time: a gap of more than one day reports a
  current streak of 0 while preserving the stored longest.

Days are UTC, matching how session timestamps are stored.

### 3.8 Pydantic schemas — `app/models/auth_models.py`

`_validate_password` rejects anything over 72 UTF-8 bytes, without a letter, or without a
digit. Length bounds are 8 to 72.

| Schema | Fields |
|---|---|
| `SignupRequest` | `full_name` (2–120, stripped), `email`, `password` |
| `VerifyOtpRequest` | `email`, `code` (4–10) |
| `ResendOtpRequest` | `email` |
| `ForgotPasswordRequest` | `email` |
| `ResetPasswordRequest` | `email`, `code`, `password` |
| `LoginRequest` | `email`, `password` |
| `UserPublic` | `id`, `full_name`, `email`, `created_at` |
| `AuthResponse` | `access_token`, `token_type`, `user` |
| `OtpChallengeResponse` | `status`, `email`, `expires_in_minutes`, `resend_in_seconds`, `delivered_by_email`, `message`, `dev_code` |
| `SimpleMessage` | `status`, `message` |

`app/models/conversation_models.py` holds `MessageTurn` and `ConversationSession` for in-memory
chat context. `chat_models.ChatReply` wraps a single `reply` string.
`transcribe_models.py` defines `TranscribeResponse`, `SessionResponse` and `ErrorResponse`;
only `SessionResponse` is used by the live code path.

---

## 4. HTTP API

Every route below is authenticated with `Authorization: Bearer <jwt>` unless marked public.
Session and analytics routes are scoped to the caller: another user's session id returns 404,
never their data.

### 4.1 Auth — `/auth`

| Method | Path | Auth | Success | Notes |
|---|---|---|---|---|
| POST | `/auth/signup` | public | 202 | Step 1. Stores a pending record. No account created |
| POST | `/auth/signup/verify` | public | 201 | Step 2. Promotes the pending record, returns a token |
| POST | `/auth/signup/resend` | public | 200 | New code, rate-limited |
| POST | `/auth/login` | public | 200 | Returns a JWT |
| POST | `/auth/forgot-password` | public | 200 | Always reports success |
| POST | `/auth/reset-password` | public | 200 | Code plus new password |
| GET | `/auth/me` | required | 200 | Current user |

**Signup, step 1.** Emails are lowercased and stripped. An existing live account returns 409.
The resend guard runs against any live pending record. A code is generated, bcrypt-hashed, and
upserted into `pending_signups` together with the full name and the already-hashed password.
The plaintext code is never stored.

**Signup, step 2.** Missing pending record → 404. Expired → the record is retired and 410 is
returned. Attempts at or over the limit → retired, 429. A wrong code increments `attempts` and
returns 400 with the remaining count. On success the user document is inserted; a
`DuplicateKeyError` here means someone completed signup between the two steps and returns 409.
The pending record is retired either way.

**Login.** Unknown email and wrong password return the identical 401 message, so the endpoint
cannot be used to discover which addresses exist. `last_login_at` is stamped on success.

**Forgot password.** Returns the same generic challenge response whether or not the account
exists. Only when it exists is a code written to `password_resets`.

**Reset password.** Mirrors the verify flow: 404, 410, 429 and 400 in the same shapes. On
success the password hash is replaced, `password_changed_at` is stamped, and the reset record
is retired.

### 4.2 Sessions — `/sessions`

| Method | Path | Description |
|---|---|---|
| POST | `/sessions` | Start a session. 201 |
| POST | `/sessions/{id}/end?spoken=<bool>` | Close it, return the summary |
| GET | `/sessions` | The 20 most recent sessions |

`POST /sessions` generates `uuid4().hex` as the session id, inserts the document, advances the
user's streak counters in the same request, primes in-process conversation memory, and returns
`{session_id, started_at, duration_limit_seconds}`. The client mirrors that duration rather
than hard-coding it.

`POST /sessions/{id}/end` is idempotent: a session already `completed` is not re-stamped.
Otherwise `ended_at` is set, elapsed seconds are computed and **clamped to
`SESSION_DURATION_SECONDS`**, and status becomes `completed`. With `spoken=true` the response
also carries a `farewell` object — a short spoken sign-off naming the minutes talked and the
number of exchanges, synthesised through TTS. A TTS failure there is logged and leaves
`audio_file` null rather than failing the request.

### 4.3 Transcribe and audio

| Method | Path | Description |
|---|---|---|
| GET | `/session` | Legacy anonymous session id. Kept for the old MVP client |
| POST | `/transcribe` | multipart `file` + `session_id`. Streams NDJSON |
| GET | `/audio/{filename}` | Serves an MP3 from `tts-outputs/` |

`GET /audio/{filename}` has **no authentication and no path-traversal guard**; it joins the
filename onto `tts-outputs` and returns `{"error": "file not found"}` with a 200 when missing.

`POST /transcribe` is the core of the product. See section 5.

### 4.4 Analytics — `/analytics`

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/analytics/overview` | required | Totals, quality, streak, latency |
| GET | `/analytics/activity?days=30` | required | Per-day buckets, 7–180 |
| GET | `/analytics/progress?limit=12` | required | Per-session trend, 3–50 |
| GET | `/analytics/vocabulary` | required | Top words and top fillers |
| GET | `/analytics/methodology` | **public** | How each figure is derived |
| GET | `/analytics/report` | required | Everything the reports page needs, one round trip |
| GET | `/analytics/sessions/{id}` | required | Summary plus full transcript |

`/analytics/methodology` is served from the backend, beside the code that computes the numbers,
so the on-screen explanation cannot drift from the implementation.

---

## 5. The live turn — `POST /transcribe`

### 5.1 Request handling

1. A missing `session_id` returns 400. A session not owned by the caller returns 404. An
   already-completed session returns 409.
2. `_rehydrate_memory` rebuilds in-process chat context from the stored turns when it is
   missing, so restarting the server mid-session does not lose the thread.
3. The upload is read and written to `uploads/<uuid>.webm`.
4. Transcription runs through `asyncio.to_thread`, so the blocking OpenAI call does not stall
   the event loop for other users. The elapsed time becomes `stt_ms`.
5. An empty transcript returns 422 with a message about recording more clearly.
6. The learner's turn is persisted as a fire-and-forget task. It is awaited before the
   assistant turn is written, which keeps the embedded array in order without putting a Mongo
   round trip in front of the reply.

### 5.2 NDJSON event stream

The response is `application/x-ndjson`, one JSON object per line.

| `type` | Payload | Meaning |
|---|---|---|
| `transcription` | `transcription` | What the learner said |
| `reply_chunk` | `delta`, `reply` | Incremental model text |
| `reply_done` | `reply` | The complete reply text |
| `audio_segment` | `segment_index`, `segment_text`, `audio_file` | One synthesised fragment |
| `error` | `message` | Generation failed |
| `done` | `reply`, `segment_count` | End of turn |

### 5.3 Sentence segmentation and early flush

Nothing can be spoken until the first fragment returns from the synthesiser, so the opening
fragment is made as small as is natural.

- `_extract_complete_segments` splits the buffer at `.`, `!` and `?`, returning finished
  sentences and the remainder. With `flush_all=True` it also emits the trailing partial.
- `_take_early_clause` applies only before the first fragment exists. If no sentence terminator
  has arrived yet, it cuts at the first `, `, `; `, ` - ` or `: ` that sits at least
  `EARLY_FLUSH_MIN_CHARS` (22) into the buffer.
- `_split_first_segment` breaks a long opening sentence — over `FIRST_SEGMENT_SPLIT_ABOVE`
  (45 chars) — at its first natural pause, provided the head is at least 8 characters and the
  tail at least 18. Only segment index 0 is eligible; later sentences stay whole because
  synthesis is already running ahead of playback by then.

### 5.4 Concurrent synthesis, ordered emission

Each segment is synthesised as its own `asyncio` task and appended to `pending_audio`.
`emit_ready()` drains only the leading tasks that are already `done()`, so sentence 2 can be
synthesising while sentence 1 is still being spoken, yet the client always receives segments in
order. `emit_remaining()` awaits the rest at the end. A failed segment is logged and skipped
rather than aborting the turn.

### 5.5 Persistence and timing

After the stream ends, the learner's write is awaited and the assistant turn is pushed with
`llm_ms` (whole Gemini stream) and `tts_ms` (sum across segments). Both writes use `$push`,
which is atomic server-side, so concurrent writes cannot lose a turn the way a
read-modify-write of the array would. A persistence failure is logged and does not break the
turn.

---

## 6. Services

### 6.1 `whisper_openAi_service.transcribe_audio`

Synchronous OpenAI call with `gpt-4o-mini-transcribe`. A transcript of fewer than three words
is treated as noise: it is recorded as a `bad_response` and returns `None`, which the route
turns into a 422. Failures are recorded through telemetry and return `None`.

### 6.2 `openAi_TTS_service.generate_audio_openai`

Async client, `gpt-4o-mini-tts`, voice `coral`, with the instruction "Speak in a clear and
natural Indian English accent." Audio is streamed straight to disk under `tts-outputs/` rather
than buffered in memory. Telemetry records character count, not tokens, because TTS is billed
by characters. Failures are recorded and re-raised.

### 6.3 `gemini_chat_service`

A singleton `GeminiChatService` with a three-model fallback list. Both earlier fallbacks
(`gemini-2.0-flash`, `gemini-1.5-flash-latest`) were retired and returned 404, which made the
chain dead — any primary failure went straight to the canned reply. The current three are live.

Two system prompts:

- `SYSTEM_PROMPT` for the non-streaming path, demanding strict JSON `{"reply":"...?"}`.
- `STREAMING_SYSTEM_PROMPT` for the streaming path, demanding plain text.

Both require a reply of one or two sentences containing exactly one follow-up question ending
in a question mark. Config is `temperature: 0`, `max_output_tokens: 256`.

`stream_chat` tries each model in turn, yields `reply_chunk` events as text arrives, and
records usage from the final chunks. On total failure it falls back to the non-streaming call,
then to `FALLBACK_MESSAGE`. It always ends with `reply_done`.

`_ensure_follow_up_question` appends "Can you tell me more about that?" when no `?` is present,
and truncates at the first `?` when the model produced more than one question.

`_safe_parse` first tries a plain `json.loads`, then scans for the first decodable JSON object
inside noisy output. `_parse_with_retry` gives the model one more attempt before giving up.

`_build_contents` maps `assistant` to Gemini's `model` role and prepends a reinforcement
instruction as a user turn.

### 6.4 `conversation_memory_service`

An in-process dictionary of `ConversationSession` objects keyed by session id, holding the full
history. `get_recent_context` returns the last **6** turns, which is what is sent to Gemini.
State is lost on restart, which is why `_rehydrate_memory` exists in the transcribe route.

### 6.5 `otp_service` and `mailer`

Codes come from `secrets.randbelow`, zero-padded to `OTP_LENGTH`, and are stored only as bcrypt
hashes. `expiry()` returns now plus `OTP_TTL_MINUTES`. `seconds_until_resend` computes the
remaining throttle from `last_sent_at`, tolerating naive datetimes.

`send_code` renders a signup or reset email and delegates to `mailer.send_email`. When delivery
fails or SMTP is unconfigured, the code is printed to the backend console so local work and a
mail outage both stay unblocked.

`mailer.send_email` never raises. Without SMTP it prints the whole message to the console and
returns `False`. With SMTP it optionally does STARTTLS, optionally logs in, and returns `True`
only when the server accepted the message.

### 6.6 `llm_telemetry`

Three jobs: persist one `llm_events` row per model call, classify failures, and email the
operator once when a provider runs out of credit.

`classify_error` returns one of `auth_failed`, `rate_limited`, `quota_exhausted`, `timeout`,
`server_error`, `bad_response` or `unknown`. Order matters:

1. Auth first — a 401/403 or a rejected-key phrase is unambiguous.
2. **Transient phrases before quota phrases.** Gemini returns `RESOURCE_EXHAUSTED` with the
   identical sentence about checking your plan and billing for both a per-minute burst and a
   spent daily allowance. The only reliable discriminator is the quota id it names, so
   per-minute markers are tested first and win. Reversing this would email the operator on
   every free-tier burst.
3. A bare 429 with no phrase match falls through to `rate_limited`.

`extract_usage` reads token counts defensively from `usage_metadata` (Gemini), `usage`
(OpenAI) or a plain dict, mapping several field-name variants onto `prompt_tokens`,
`output_tokens`, `total_tokens` and `cached_tokens`, and derives the total when absent.

`record` writes one row and swallows every exception — telemetry must never break a session.
`record_failure` classifies, records, and for `quota_exhausted` or `auth_failed` calls
`alert_operator`.

`alert_operator` sends to `ALERT_EMAIL_TO`, suppressed by `_recently_alerted` within
`LLM_ALERT_COOLDOWN_MINUTES`. The attempt itself is recorded as an `alert` operation, which is
what throttles the next one. If the throttle check fails, no alert is sent — a missed alert
beats an unthrottled loop.

### 6.7 `analytics_service`

The single source of every figure on the dashboard and reports pages.

**Tokenisation.** `WORD_RE = [a-zA-Z']+` on lowercased text. A word is any run of letters,
apostrophes included.

**Fillers.** Single words: `um, uh, erm, hmm, like, actually, basically, literally, yeah`.
Phrases: `you know, i mean, sort of, kind of`. Phrases are counted first and blanked out of the
text, so "you know" is not also counted as "know".

**Stopwords.** A fixed list of common connectives, excluded from the top-words chart only.

**Loading.** `_load_sessions` is one `find` on `live({user_id})` sorted by `started_at`
descending. Because turns are embedded, the whole report reads from a single index scan — no
join, and the cost does not grow with the number of sessions.

**`_fluency_score(avg_words_per_turn, diversity, filler_rate, has_speech)`**

```
length_score    = clamp((avg_words_per_turn - 4) / 21, 0, 1)
diversity_score = clamp(diversity / 0.55, 0, 1)
filler_score    = clamp(1 - filler_rate / 12, 0, 1)
score           = round(100 * (0.40*length + 0.35*diversity + 0.25*filler))
```

With no recorded speech the score is **0, not a default**. Without that guard the filler term
would score a perfect 1.0 for having said nothing and hand a brand-new account 25/100.

**`session_summary(session)`** returns `id`, `started_at`, `ended_at`, `status`,
`duration_seconds`, `exchanges` (learner turns only), `words_spoken`, `unique_words`,
`avg_words_per_turn`, `filler_count`, `filler_rate`, `avg_reply_ms`.

**`build_overview(user)`** returns three groups plus streak and latency:

| Group | Fields |
|---|---|
| `totals` | sessions, completed_sessions, practice_seconds, practice_minutes, exchanges, words_spoken, vocabulary_size |
| `quality` | avg_words_per_turn, vocabulary_diversity, filler_count, filler_rate, fluency_score, avg_session_minutes |
| `streak` | current_days, longest_days (from the stored counters) |
| `latency` | avg_stt_ms, avg_llm_ms, avg_tts_ms |

**`build_activity(user_id, days)`** pre-creates a bucket for every day in the window, so empty
days are present in the series rather than missing.

**`build_progress(user_id, limit)`** reverses the newest-first list so trends read left to
right, labelling sessions `S1`, `S2` and so on.

**`build_vocabulary(user_id, limit=15)`** returns the top 15 content words and the top 8
fillers. Content words exclude stopwords, fillers, and anything three characters or shorter.

**Only the learner's turns are ever measured.** Nothing the assistant says is counted anywhere.

There is also a `_streaks(day_list)` function that derives streaks from a day list. The live
API path no longer uses it; `scripts/backfill_streaks.py` does.

---

## 7. Data model

Five collections, all following the soft-delete convention.

### `users`
```
_id, email, full_name, password_hash, email_verified,
created_at, last_login_at, password_changed_at?,
practice: { last_practice_date, current_streak, longest_streak },
deleted, deleted_at
```

### `practice_sessions`
```
_id (uuid4 hex string), user_id (ObjectId),
started_at, ended_at, duration_seconds, status,
turns: [ { role, content, word_count, created_at, stt_ms, llm_ms, tts_ms } ],
deleted, deleted_at
```

### `pending_signups`
```
email, full_name, password_hash, code_hash,
attempts, last_sent_at, created_at, expires_at,
deleted, deleted_at
```

### `password_resets`
```
email, code_hash, attempts, last_sent_at, expires_at, deleted, deleted_at
```

### `llm_events`
```
provider, operation, model, ok, kind, message,
usage: { prompt_tokens, output_tokens, total_tokens, cached_tokens },
latency_ms, session_id, user_id, extra, created_at, deleted, deleted_at
```

---

## 8. Frontend

### 8.1 Stack

React 19.2 with the React Compiler babel preset, `react-router-dom` 7.18, Vite 8. **No UI
library, no state library, no charting library.** Icons come from Material Symbols Outlined
class names. `npm run dev` runs `vite --host`.

### 8.2 Routing — `src/App.jsx`

| Route | Component | Guard |
|---|---|---|
| `/` | Landing | `RedirectIfAuthed` |
| `/login` | AuthPage mode=login | `RedirectIfAuthed` |
| `/signup` | AuthPage mode=signup | `RedirectIfAuthed` |
| `/forgot-password` | ForgotPassword | `RedirectIfAuthed` |
| `/app` | Home in `AppShell` | `RequireAuth` |
| `/app/reports` | Reports in `AppShell` | `RequireAuth` |
| `/app/practice` | Practice | `RequireAuth`, own shell |
| `/app/*` | redirect to `/app` | — |
| `*` | 404 | — |

`RequireAuth` shows a full-page loader while auth is resolving and otherwise redirects to
`/login`, carrying the attempted path in navigation state.

### 8.3 Auth state — `src/context/`

`AuthContext` is deliberately split from `AuthProvider` so React Fast Refresh can still
hot-reload the provider. The context module also exports `useAuth`, which throws outside a
provider.

`AuthProvider` holds `status` of `loading | anonymous | authenticated`. On mount, if a token
exists it calls `/auth/me`; a 401 clears the token so a dead session cannot strand the user on
a spinner. It exposes `login`, `completeSignup` (step 2 of signup, since step 1 creates no
session) and `logout`.

### 8.4 API layer — `src/apiCalls/`

`client.js` holds `BASE_URL` from `VITE_BACKEND_URL`, the `aiSpeech_token` localStorage key,
and `apiFetch`. Notable behaviour:

- Token reads and writes are wrapped in try/catch, so blocked storage degrades to an in-memory
  session rather than throwing.
- A network failure becomes `ApiError("Cannot reach the server. Is the backend running?", 0)`.
- `readApiError` collapses FastAPI's several error shapes into one sentence, including the
  Pydantic `[{loc, msg}]` list, stripping the `Value error,` prefix.

`endpoints.js` wraps every backend route as a named function.

`transcribe.jsx` posts the multipart form **without** a `Content-Type` header, so the browser
sets the multipart boundary. `streamTranscribe` reads the body with a `ReadableStream` reader,
splits on newlines, keeps the partial line in a buffer, and awaits the caller's handler for
each parsed event, including the trailing line after the stream ends.

### 8.5 `AppShell`

Top navigation on desktop, a bottom tab bar on mobile, and an account menu that closes on
outside click or Escape. A `bare` prop hides both bars while keeping the children subtree in
exactly the same position — toggling it never remounts the page.

### 8.6 `Practice` page

Holds a `phase` flag fed from `MeetingRoom` and passes `bare={phase === "meeting"}` to the
shell. The navigation therefore stays available in the lobby and on the summary screen, and
disappears only while a session is live. The element tree is identical in both states, because
swapping the wrapper would unmount `MeetingRoom` mid-session and throw away its session id.

### 8.7 `MeetingRoom` — the voice room

The largest component in the project, about 1,390 lines. Three phases: `lobby`, `meeting`,
`ended`.

**Voice activity detection.** The microphone opens once on join and stays open for the whole
session — there is no press-to-talk. An `AnalyserNode` computes RMS on the time-domain signal
every 50 ms and decides where each sentence starts and ends.

| Constant | Value | Purpose |
|---|---|---|
| `START_RMS` | 0.055 | Loud enough to be speech, not room tone |
| `STOP_RMS` | 0.032 | Quieter than this counts as silence |
| `SILENCE_MS` | 2400 | End-of-turn wait, wide enough to clear a breath |
| `SHORT_UTTERANCE_MS` | 2500 | Below this the turn counts as "just started" |
| `PATIENT_SILENCE_MS` | 3000 | The longer wait given to a short opening |
| `MIN_VOICED_MS` | 500 | Genuinely voiced audio required before sending |
| `MIN_BLOB_BYTES` | 3000 | Anything smaller holds no speech |
| `MAX_UTTERANCE_MS` | 45000 | Safety valve against an open mic in a noisy room |

Two thresholds rather than one give hysteresis, so a voice hovering near the cutoff does not
flicker on and off. Voiced time is counted **only** while above `START_RMS`, because room tone
and breathing sit above `STOP_RMS` and would otherwise keep a near-silent clip looking alive.

The detection loop runs on `setInterval`, not `requestAnimationFrame`. Browsers pause rAF
entirely in a hidden tab, which would freeze listening mid-sentence and leave a recording that
never ends.

**Recording.** `MediaRecorder` with `audio/webm;codecs=opus` at 32 kbps mono, falling back to
browser defaults on older engines. The browser default was encoding speech at near-music
quality, roughly 900 KB per turn; the voice codec lands near 60 KB. `getUserMedia` requests
echo cancellation, noise suppression, auto gain control and a single channel.

**Turn gating.** `canListen` is true only when the floor is genuinely the learner's: phase is
`meeting`, the mic is ready, not muted, and nothing is being transcribed, generated or spoken.
It is mirrored into `listenGateRef` so the interval loop never has to be torn down and rebuilt
because React state changed. Losing the floor mid-sentence discards the partial recording.

**Session id in a ref.** `MediaRecorder` callbacks are registered once and would capture a
stale copy of a state value. This was the actual cause of a live session reporting itself as
"no longer active". Nothing renders the id, so a ref is both correct and simpler.

**Autoplay unlock.** The join click is the only user gesture the room ever gets, since there is
no per-turn button. A muted play/pause on the hidden `<audio>` element during that click
unlocks playback for the rest of the session.

**Playback and text reveal.** Audio segments are queued and played in order. The assistant's
words are revealed **as each fragment is spoken**, not when the text arrives. Gemini delivers
its whole reply in one burst about 4.6 s in, and the first spoken fragment cannot exist until
roughly 1.5 s later, so printing on arrival dumped the full answer on screen well before the
voice caught up. Text now follows the voice.

A settle routine fills in any missing text after playback genuinely finishes — polling the
queue rather than using a fixed delay, which previously fired mid-playback and duplicated the
reply.

**Wind-down.** When the clock reaches zero the session is not cut off. `timeUp` is set, the
exchange in flight is allowed to finish, and once everything is idle a confirmation dialog
appears. That dialog counts itself down from 20 seconds and closes the session on its own, so a
session can never hang open unattended. The End button raises the same dialog with a "Keep
practising" escape.

**Closing.** `endPracticeSession(id, {spoken: true})` returns the summary and a farewell clip,
which is played to completion — with a 20-second guard against a stuck audio element — before
the summary screen replaces the room.

**Error handling.** A 422 is routine with an always-on mic (a cough, a chair) and resumes
listening silently. Anything else surfaces a dismissible banner.

**Ended screen.** Three distinct endings: a real session with speech, a real session with none,
and one where the summary could not be fetched. The last never claims the learner said nothing.
When speech exists it shows exchanges, words, words per turn and filler rate, plus one tip
chosen from the actual numbers.

**Visualizer.** In mic mode it draws real frequency bars from an `AnalyserNode` with an RMS
noise gate. In assistant mode it draws an animated sine wave instead — deliberately not wiring
an `AudioContext` to the `<audio>` element, which keeps autoplay unrestricted.

### 8.8 `Home`

Loads `/analytics/overview` and `/sessions` in parallel. Shows a time-of-day greeting, a streak
chip when the streak is non-zero, a start-session panel, four stat tiles, and the five most
recent sessions linking into the reports drawer.

### 8.9 `Reports`

One `/analytics/report` call fills the whole page: fluency gauge with a band label, the
methodology panel, four KPI tiles, a 30-day activity chart, two trend charts, two ranked-bar
charts, and a session history table.

Every chart has an accessible fallback. Activity and the fluency trend offer a table toggle
showing the same numbers; the others are backed by the session history table. Trend charts
require at least two sessions and otherwise render a purposeful empty state.

`SessionDrawer` opens from `?session=<id>` in the URL, so a session view is linkable and the
back button closes it. It is keyed on the session id, so a different session remounts with
fresh state rather than resetting inside an effect. Escape closes it.

### 8.10 `AuthPage`, `ForgotPassword`, `OtpInput`

`AuthPage` is one component for both modes with a `details | otp` step. `ForgotPassword` runs
`request | reset | done`. Both show a resend countdown and, in development, the `dev_code`
returned by the backend.

`OtpInput` renders six boxes that behave as one field: typing advances, backspace retreats,
arrows move, and a pasted code fills every box at once. The first box carries
`autocomplete="one-time-code"`.

### 8.11 `Charts.jsx`

Hand-rolled SVG. Exports `ChartFrame`, `EmptyChart`, `TimeBarChart`, `TrendLineChart`,
`RankedBars`, `StatTile` and `ScoreGauge`, with internal helpers for nice axis maxima, tick
generation and tooltips.

### 8.12 Design tokens — `styles/theme.css`

A dark-only palette. Primary `#c0fe71` on `--on-primary: #1d3400`; surfaces from `#0c0c0c`
through `#272726`; assistant accent `#a78bfa`. Series colours `--series-1: #6ea513`,
`--series-2: #8b5cf6`, `--series-3: #2fa3bd` were validated for the dark surface: OKLCH
lightness inside the 0.48–0.67 band, and colour-vision-deficiency separation ΔE ≥ 15 across all
pairs. Fonts are Manrope for body and Space Grotesk for display.

---

## 9. Running it locally

MongoDB must be reachable at `MONGODB_URI`. The API boots without it and reports the problem on
`/health`, but every data request will fail.

The backend must listen on port **8110**, which is what the frontend `.env` points at.

```bash
cd backend && python -m uvicorn app.main:app --host 127.0.0.1 --port 8110 --reload
```

```bash
cd frontend && npm run dev
```

Open **http://localhost:5173**.

Three things that will bite you:

- **Use `localhost`, not the LAN IP.** Vite also prints a `192.168.x.x` address. The microphone
  will not work there: `getUserMedia` requires a secure context, and only `localhost` is exempt
  from the HTTPS rule. Any deployment needs a real domain and a TLS certificate, or recording
  is dead on arrival.
- **Run uvicorn from `backend/`, not `backend/app/`.** `uploads/` and `tts-outputs/` are
  relative paths and the `app.routes...` imports need `backend/` as the working directory.
- **Verification codes print to the backend console** until SMTP is configured.

---

## 10. Migration scripts

All three are idempotent and run from `backend/`.

| Script | What it does |
|---|---|
| `migrate_embed_turns.py` | Folds the old standalone `turns` collection into `practice_sessions.turns`. Sessions that already carry an embedded array are skipped. `--drop` removes the legacy collection once counts line up |
| `migrate_soft_delete.py` | Backfills `deleted: false` on pre-convention documents, drops TTL indexes, and replaces plain unique indexes with partial ones covering only live records |
| `backfill_streaks.py` | Recomputes `users.practice` from session history. Doubles as the repair tool if a stored counter is suspected of drift |

---

## 11. Known limitations and rough edges

**Gemini free tier.** The key is on the free tier: 10 requests per minute *and* 20 requests per
day per model, project-wide. Each spoken turn is one request, so roughly 20 turns a day across
all users before replies fall back to the canned message. Enabling billing lifts it with no
code change.

**CORS is fully open.** `allow_origins=["*"]` with `allow_credentials=True`, marked in the
source for restriction before deployment.

**`/audio/{filename}` is unauthenticated** and does not validate the filename against path
traversal. Any generated MP3 is readable by anyone who knows or guesses its name.

**Generated audio is never cleaned up.** `tts-outputs/` and `uploads/` grow without bound; the
former already holds hundreds of files.

**Conversation memory is per-process.** A multi-worker deployment would split context across
workers. The rehydrate path limits the damage but does not remove the constraint.

**The legacy `GET /session` endpoint is anonymous** and creates memory state with no
persistence, kept only for the old MVP client.

**`ELEVEN_LABS_API_KEY`, `DEEPGRAM_API_KEY` and `OPENADAPTER_OPENAI_API_KEY`** sit in `.env` but
no active code path reads them.

**The driver is synchronous `pymongo`.** Writes are small and offloaded with
`asyncio.to_thread`; `motor` would be the async swap if the app ever became write-heavy.

**Data loss note carried in the log.** The `fluently` database was found empty on 2026-09-08.
The oplog showed the last real user removed at 16:28 UTC from outside the session, and the
`turns` collection dropped at 15:56 by a `--drop` run. No backup existed. Soft delete was
adopted immediately afterwards, which is the direct reason nothing is hard-deleted now.

