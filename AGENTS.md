# AGENTS.md

## Project

Telegram bot that sends a nightly Work From Home / Work From Office notice based on the Malaysian DOE APIMS haze (Air Pollution Index) reading for station `CA08P` (Minden, Pulau Pinang). Readings are archived in local SQLite; at the configurable check time (default 21:00 MYT) the 21:00 reading is used (20:00 fallback, retried up to `retryMinutes`); API >= threshold (default 200) means WFH. No notice is sent when tomorrow is a weekend.

## Requirements

- Node.js >= 23.4 (built-in `node:sqlite` — no native deps). The `ExperimentalWarning: SQLite is an experimental feature` on startup is expected on Node 23; do not "fix" it.

## Commands

| Command | Purpose |
| --- | --- |
| `npm test` | Run test suite (`node --test`; no lint/typecheck configured — tests are the verification gate) |
| `npm start` | Run the notifier (long-running) |
| `npm run once` | Single poll + check cycle, then exit |
| `npm run chat-id` | Print chat ids the bot has seen (helper for setup) |

Only dependency is `node-cron` (timezone-aware scheduling). HTTP uses native `fetch`.

## Architecture (src/)

- `index.js` — entry point; wires everything, CLI flags (`--once`, `--chat-id`), catch-up check on startup if past check time, SIGINT/SIGTERM shutdown
- `config.js` — loads/validates `config.json`, deep-merges defaults, normalizes HH:MM times (any change to config keys must update validation + `config.example.json` + README table)
- `db.js` — `node:sqlite` wrapper; `readings` (UNIQUE station_id + datetime_local, upserted) and `notifications` (UNIQUE decision_date = the *tomorrow* being decided; drives idempotency)
- `doeApi.js` — fetches/parses the APIMS hourly table; `API` field coerced via `Number`, non-finite/empty -> null
- `checker.js` — the core decision logic, dependency-injected (`db`, `fetchAndStore`, `telegram`, `logger`, `now`, `sleep`) so tests run fully in-memory with fixtures
- `scheduler.js` — node-cron jobs: hourly poll + daily check (cron built from `wfh.checkTime`)
- `telegram.js` — Bot API `sendMessage` with 3 retries; `createTelegram` returns `null` when unconfigured (log-only mode)
- `tz.js` — pure date helpers (all timezone math via `Intl` with the configured IANA timezone; calendar dates as `YYYY-MM-DD` strings)

## Domain rules (do not break)

- Reading selection: prefer `${today}T${checkTime}:00`, fall back to `${today}T${fallbackTime}:00`; a row whose `api_value` is NULL counts as unavailable. Per attempt: try primary, then fallback; retry the whole fetch only when both are missing.
- Weekend skip happens **before** any fetch or idempotency read; skipped days must not create `notifications` rows.
- A notification row is recorded **only after** a successful Telegram send.
- API `DATETIME` values are naive Malaysia-local strings (`2026-10-09T21:00:00`) — match by exact string against the configured timezone's local date, never parse them into `Date`.

## Conventions

- Plain ESM JavaScript, no TypeScript, no build step.
- No comments in source unless asked.
- Tests use `node:test` + `node:assert/strict` in `tests/`, in-memory SQLite (`:memory:`), fake fetch/telegram/logger, injected clock. Cover checker decisions, fallback, weekend skip, idempotency, retry, and tz/db helpers.
- `config.json`, `data.sqlite*`, `node_modules/` are gitignored — never commit them; keep `config.example.json` in sync instead.
- Logs go through `src/log.js` (`logger.info/warn/error` with timestamps).
