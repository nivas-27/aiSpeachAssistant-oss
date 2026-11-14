# Fluently — AI Speech Practice

A speech-to-speech English practice product. You join a 20-minute voice room, speak to an
AI partner that replies out loud, and afterwards read a report built from your own
transcripts.

The pipeline is **speech → text → text → speech**:

| Stage | Service | Model |
|---|---|---|
| Transcription (STT) | OpenAI | `gpt-4o-mini-transcribe` |
| Conversation | Google Gemini | `gemini-2.5-flash-lite`, falling back to `gemini-flash-lite-latest`, then `gemini-2.5-flash` |
| Speech (TTS) | OpenAI | `gpt-4o-mini-tts`, voice `coral` |

The assistant's reply is streamed and synthesised **sentence by sentence**, so audio starts
playing before the full answer exists.

Data lives in **MongoDB**.

---

## Running it locally

You need Python 3.12+, Node 20+ and MongoDB reachable at the URI in `backend/.env` (`mongodb://localhost:27017` by
default). The API still boots without it and reports the problem on `/health`, but every
request that touches data will fail until Mongo is up.

Then two terminals. The backend must be on port **8110** — the frontend's `.env` points there.

**Backend**

```bash
cd backend
python -m venv venv
# Windows: .\venv\Scripts\Activate.ps1      macOS/Linux: source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env        # then fill in your keys
python -m uvicorn app.main:app --host 127.0.0.1 --port 8110 --reload
```

**Frontend**

```bash
cd frontend
npm install
cp .env.example .env
npm run dev
```

Then open **http://localhost:5173**.

Check the database connection at any time:

```bash
curl http://localhost:8110/health
```

### Things that will bite you

- **Use `localhost`, not the LAN IP.** `npm run dev` also prints a `192.168.x.x` address.
  The microphone will not work there — `getUserMedia` requires a secure context, and only
  `localhost` is exempt from the HTTPS rule. The same applies to any deployment: it needs a
  real domain and a TLS certificate, or recording is dead on arrival.
- **Run uvicorn from `backend/`, not from `backend/app/`.** `uploads/` and `tts-outputs/`
  are relative paths, and the `app.routes...` imports need `backend/` as the working
  directory.
- **Verification codes are printed to the backend console** until you configure SMTP.

---

## Signing up

Signup is two steps, so an address has to be real before an account exists:

1. `POST /auth/signup` stores the details in a `pending_signups` document and emails a
   6-digit code. **No user account is created yet**, and the code is stored only as a
   bcrypt hash.
2. `POST /auth/signup/verify` with the correct code promotes that pending record into a
   real user and returns a token.

Codes expire after 10 minutes, allow 5 attempts, and can be resent once every 60 seconds.
Expired pending records are removed automatically by a MongoDB TTL index.

**Forgot password** works the same way: `POST /auth/forgot-password` issues a code, and
`POST /auth/reset-password` swaps in the new password. The forgot endpoint returns the same
response whether or not the account exists, so it cannot be used to discover which emails
are registered.

### Email delivery

Set these in `backend/.env` to send real email:

```
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=you@gmail.com
SMTP_PASSWORD=your-app-password
SMTP_FROM=Fluently <you@gmail.com>
```

With `SMTP_HOST` unset, codes are printed to the backend console **and** returned in the
API response as `dev_code`, which the UI shows on screen so local testing works. Setting
`SMTP_HOST` turns that off automatically — the code never appears in a response again.

---

## Product surface

| Route | Page | Auth |
|---|---|---|
| `/` | Landing | public |
| `/login`, `/signup` | Sign in / two-step signup | public |
| `/forgot-password` | Reset via emailed code | public |
| `/app` | Home dashboard — KPIs, streak, recent sessions | required |
| `/app/practice` | The 20-minute voice room | required |
| `/app/reports` | Reports, methodology, per-session transcripts | required |

The practice page **keeps the app navigation while you are in the lobby and on the summary
screen**, and hides it only while a session is actually live, so the mic controls have the
screen to themselves. The page tree is identical in both states — only a flag changes —
because swapping the wrapper would unmount the room mid-session and lose the session id.

---

## Backend API

### Auth
| Method | Path | Notes |
|---|---|---|
| `POST` | `/auth/signup` | Issues a code. Returns 202, creates no account |
| `POST` | `/auth/signup/verify` | Code + email → account + token |
| `POST` | `/auth/signup/resend` | New code, rate-limited |
| `POST` | `/auth/login` | Returns a JWT |
| `POST` | `/auth/forgot-password` | Issues a reset code |
| `POST` | `/auth/reset-password` | Code + new password |
| `GET` | `/auth/me` | Current user |

### Sessions
| Method | Path |
|---|---|
| `POST` | `/sessions` — start a practice session |
| `POST` | `/sessions/{id}/end` — close it, returns the summary |
| `GET` | `/sessions` — recent sessions |
| `POST` | `/transcribe` — multipart `file` + `session_id`, streams NDJSON |
| `GET` | `/audio/{filename}` — a generated MP3 segment |

### Analytics
| Method | Path |
|---|---|
| `GET` | `/analytics/report` — everything the reports page needs, one round trip |
| `GET` | `/analytics/overview`, `/activity`, `/progress`, `/vocabulary` |
| `GET` | `/analytics/methodology` — how each figure is derived (public) |
| `GET` | `/analytics/sessions/{id}` — summary plus full transcript |

Every session and analytics route is scoped to the authenticated user; another user's
session id returns 404, not their data.

---

## How the session report is calculated

The reports page has a **"How this report is calculated"** panel that expands to show the
formula behind every figure. It is served by `GET /analytics/methodology`, which lives
beside the code that computes the numbers, so the explanation cannot drift from the
implementation.

Only **your** turns are ever measured — nothing the assistant says is counted.

| Metric | Formula |
|---|---|
| Words spoken | sum of the word count of every turn you spoke |
| Words per turn | words spoken ÷ number of your turns |
| Vocabulary diversity | unique words ÷ total words (type–token ratio) |
| Filler rate | fillers ÷ words spoken × 100 |
| Fluency score | 40% turn length + 35% diversity + 25% filler restraint |
| Practice time | sum of session durations, capped at the session limit |
| Streak | consecutive calendar days with at least one session |
| Reply latency | mean of the measured per-turn STT / LLM / TTS timings |

Details worth knowing:

- Turn length scores 0 at 4 words and full marks at 25+. Diversity scores full marks at a
  55% unique-word ratio. Filler restraint scores full marks at 0 fillers and 0 at 12 per
  100 words.
- **With no recorded speech the fluency score is 0, not a default** — without that guard
  the filler term would score full marks for having said nothing.
- Fillers counted: `um, uh, erm, hmm, like, actually, basically, literally, yeah`, plus the
  phrases `you know, i mean, sort of, kind of`. Phrases are matched first so "you know" is
  not also counted as "know".

Implementation: `backend/app/services/analytics_service.py`.

---

## Architecture

```
backend/
  app/
    core/         config, Mongo client + indexes, JWT + bcrypt, auth dependency
    models/       document builders (users, practice_sessions, turns) + Pydantic schemas
    routes/       auth, sessions, transcribe, audio, analytics
    services/     STT, Gemini chat, TTS, OTP, conversation memory, analytics

frontend/
  src/
    apiCalls/     fetch client with bearer auth, endpoint wrappers
    context/      AuthProvider + useAuth
    components/   AppShell, RouteGuards, MeetingRoom, OtpInput, MethodologyPanel, charts/
    pages/        Landing, AuthPage, ForgotPassword, Home, Practice, Reports
    styles/       theme.css — the design tokens every page shares
```

### MongoDB collections

| Collection | Holds | Indexes |
|---|---|---|
| `users` | accounts | unique `email` |
| `practice_sessions` | one document per session, `_id` is the session id | `user_id + started_at` |
| `turns` | one document per spoken turn, with word count and latencies | `session_id + created_at`, `user_id` |
| `pending_signups` | signups awaiting a code | unique `email`, TTL on `expires_at` |
| `password_resets` | live reset codes | unique `email`, TTL on `expires_at` |

Turns for a page of sessions are fetched in **one** query and grouped in memory, so the
cost does not grow with the number of sessions.

The driver is synchronous `pymongo`. Writes here are small and local; if the app ever
becomes write-heavy under load, `motor` would be the async swap.

**Conversation memory** lives in process for LLM context but is rehydrated from the
database when missing, so restarting the server mid-session does not lose the thread.

**Charts** are hand-rolled SVG — no charting dependency. Series colours
(`--series-1/2/3` in `theme.css`) were validated for the dark surface: OKLCH lightness
inside the 0.48–0.67 band, and colour-vision-deficiency separation ΔE ≥ 15 across all
pairs. Every chart also offers a table view or is backed by the session history table.

---

## Configuration

`backend/.env`:

| Variable | Purpose |
|---|---|
| `MONGODB_URI` | Connection string. Defaults to `mongodb://localhost:27017` |
| `MONGODB_DB` | Database name. Defaults to `fluently` |
| `OPENAI_API_SECRET` | STT + TTS. **Required.** |
| `GEMINI_API_KEY` | Conversation. **Required.** |
| `JWT_SECRET` | Signs auth tokens. If unset, a random one is generated at startup and every restart logs everyone out. |
| `ACCESS_TOKEN_EXPIRE_DAYS` | Token lifetime (default 7) |
| `SESSION_DURATION_SECONDS` | Session length cap (default 1200 = 20 min) |
| `OTP_TTL_MINUTES`, `OTP_RESEND_SECONDS`, `OTP_MAX_ATTEMPTS` | Passcode rules |
| `SMTP_*` | Email delivery; see above |
| `ALLOWED_LOGIN_EMAILS` | Optional comma-separated allowlist. When set, only these emails can log in; others can sign up but stay locked. Empty = open to everyone. |
| `ADMIN_NOTIFY_EMAIL` | Emailed when someone signs up and is locked out (defaults to `ALERT_EMAIL_TO`) |

`ELEVEN_LABS_API_KEY`, `DEEPGRAM_API_KEY` and `OPENADAPTER_OPENAI_API_KEY` are present but
**not used** by the active pipeline.

### Known limitation

The Gemini key is on the **free tier**: 10 requests per minute *and* **20 requests per day**
per model, project-wide. Each spoken turn is one request, so roughly 20 turns a day across
all users before replies fall back to a canned message. Enabling billing on the Google
Cloud project lifts it; no code change is needed.


---

## Repository layout

This is a monorepo: `backend/` (FastAPI) and `frontend/` (React + Vite). Both were merged
from their original repositories with full commit history preserved.

## Security notes

- Never commit `.env` files; `.env.example` lists every variable with placeholders.
- CORS is open (`*`) by default. Restrict `allow_origins` in `backend/app/main.py` before deploying.
- `GET /audio/{filename}` is unauthenticated (browsers cannot send a bearer token from an `<audio>` tag); filenames are random UUIDs.
- Report vulnerabilities privately to the maintainer rather than in a public issue.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Licensed under the [MIT License](LICENSE).
