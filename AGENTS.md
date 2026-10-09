# AGENTS.md

## Project

Telegram bot that sends a nightly Work From Home / Work From Office notice based on the Malaysian DOE APIMS haze (Air Pollution Index) reading for station `CA08P` (Minden, Pulau Pinang). Readings are archived in local SQLite; at the configurable check time (default 21:00 MYT) the 21:00 reading is used (20:00 fallback, retried up to `retryMinutes`); API >= threshold (default 200) means WFH. No notice is sent when tomorrow is a weekend. Notices fan out to all subscribers (allowlisted users who sent `/subscribe` to the bot).

## Requirements

- Node.js >= 23.4 (built-in `node:sqlite` — no native deps). The `ExperimentalWarning: SQLite is an experimental feature` on startup is expected on Node 23; do not "fix" it.

## Commands

| Command | Purpose |
| --- | --- |
| `npm test` | Run test suite (`node --test`; no lint/typecheck configured — tests are the verification gate) |
| `npm start` | Run the notifier (long-running) |
| `npm run once` | Single poll + check cycle, then exit |
| `npm run subs` | List subscribers (helper for setup) |
| `npm run allowlist` | Review allowlists cross-checked against subscribers (via `bot.js buildAllowlistReview`) |
| `npm run msg:<type>` | Send a test message (`wfh`/`wfo`/`welcome`/`status`/`trend`) with a TEST banner to all subscribers |

Only dependency is `node-cron` (timezone-aware scheduling). HTTP uses native `fetch`.

## Architecture (src/)

- `index.js` — entry point; wires everything, CLI flags (`--once`, `--subs`), catch-up check on startup if past check time, SIGINT/SIGTERM shutdown
- `config.js` — loads/validates `config.json`, deep-merges defaults, normalizes HH:MM times (any change to config keys must update validation + `config.example.json` + README table)
- `db.js` — `node:sqlite` wrapper; `readings` (UNIQUE station_id + datetime_local, upserted), `notifications` (UNIQUE decision_date = the *tomorrow* being decided; drives idempotency), `subscribers` (chat_id PK, upserted, with username column auto-added by migration), and `allowlist` (value PK, kind id|username — runtime entries managed via `/allow`)
- `doeApi.js` — fetches/parses the APIMS hourly table; `API` field coerced via `Number`, non-finite/empty -> null
- `checker.js` — the core decision logic, dependency-injected (`db`, `fetchAndStore`, `telegram`, `logger`, `now`, `sleep`) so tests run fully in-memory with fixtures
- `scheduler.js` — node-cron jobs: hourly poll + daily check (cron built from `wfh.checkTime`)
- `bot.js` — `handleUpdate` command routing (`/subscribe`, `/stop`, `/status`, `/trend`; admin-only `/allow` `/disallow` `/allowlist` `/users` (HTML `<pre>` table via `buildUsersTable`)). The gate = `telegram.adminUserIds` OR effective allowlist (config `allowedUserIds`/`allowedUsernames` UNION `allowlist` table via `effectiveAllowlist`); non-allowlisted senders get a rejection reply including their user id and username, and `notifyAdminsOfRequest` stores a `pending_requests` row and pings all admins with inline Approve/Deny buttons (one pending row per user — dedupes repeated /start). `handleCallback` processes `allowreq:`/`denyreq:` callbacks (admin-only; approve = allowlist by id + auto-subscribe + welcome DM + edit admin message; deny = drop request). Welcome text from `telegram.welcomeMessage` with `{name}` substitution, built-in default otherwise. `/trend` = last 6 non-null readings from `db.getRecentReadings` with ±5 deadband verdict. Plus `startBotPolling` long-poll getUpdates loop (messages + callback_query) with abort-based shutdown
- `telegram.js` — Bot API `sendMessage(chatId, text, {parseMode, replyMarkup})` with 3 retries, returns `{ ok, permanent }` (permanent = 403 / chat-not-found -> caller prunes subscriber); `answerCallbackQuery` + `editMessageText` for the approval flow; `getUpdates` (messages + callback_query) for the polling loop; `createTelegram` returns `null` when unconfigured (log-only mode)
- `tz.js` — pure date helpers (all timezone math via `Intl` with the configured IANA timezone; calendar dates as `YYYY-MM-DD` strings)

## Domain rules (do not break)

- Reading selection: prefer `${today}T${checkTime}:00`, fall back to `${today}T${fallbackTime}:00`; a row whose `api_value` is NULL counts as unavailable. Per attempt: try primary, then fallback; retry the whole fetch only when both are missing.
- Weekend skip happens **before** any fetch or idempotency read; skipped days must not create `notifications` rows.
- A notification row is recorded **only after at least one subscriber send succeeded** (send failure to all -> no row; zero subscribers -> no row).
- Subscription is gated by `telegram.allowedUserIds` (sender's Telegram user id, not chat id), `telegram.allowedUsernames` (normalized username), or the runtime `allowlist` table (config ∪ table). Admins (`telegram.adminUserIds`) always pass; `/disallow` never removes config.json-managed entries.
- API `DATETIME` values are naive Malaysia-local strings (`2026-10-09T21:00:00`) — match by exact string against the configured timezone's local date, never parse them into `Date`.

## Conventions

- Plain ESM JavaScript, no TypeScript, no build step.
- No comments in source unless asked.
- Tests use `node:test` + `node:assert/strict` in `tests/`, in-memory SQLite (`:memory:`), fake fetch/telegram/logger, injected clock. Cover checker decisions, fallback, weekend skip, idempotency, retry, subscriber fan-out/pruning, bot command handling, config validation, and tz/db helpers.
- `config.json`, `data.sqlite*`, `node_modules/` are gitignored — never commit them; keep `config.example.json` in sync instead.
- Logs go through `src/log.js` (`logger.info/warn/error` with timestamps).
