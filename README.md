# pg_wfh_notifier

Telegram bot that sends a nightly **Work From Home / Work From Office** notice based on the haze (Air Pollution Index) reading from the Malaysian DOE APIMS portal for **Minden, Pulau Pinang** (station `CA08P`).

## How it works

- Every hour (default: 5 minutes past), the bot polls the DOE API and stores all hourly readings in a local SQLite database (`data.sqlite`).
- At the configured check time (default **21:00** Malaysia time), it takes today's 21:00 API reading. If the 21:00 reading is unavailable, it uses the 20:00 reading. If neither is available yet, it retries every `retryIntervalMinutes` for up to `retryMinutes`.
- **If API >= threshold (default 200)** → tomorrow is **WORK FROM HOME**.
- **If API < threshold** → tomorrow is work from office as usual.
- If tomorrow is a weekend (Sat/Sun), **no message is sent**.
- One notice per day is recorded in the database, so restarts or re-runs never send duplicates. On startup, if the check time has already passed and today's notice hasn't been sent, a catch-up check runs.

## Requirements

- Node.js >= 23.4 (uses the built-in `node:sqlite` module; on Node 22.5–23.3 you must pass `--experimental-sqlite`)

## Setup

1. Install dependencies:

   ```
   npm install
   ```

2. Create a bot: message [@BotFather](https://t.me/BotFather) on Telegram, send `/newbot`, and copy the token.

3. Find your chat id: send any message to your new bot, then:

   ```
   npm run chat-id
   ```

   Copy the printed `chat_id`.

4. Edit `config.json` and fill in `telegram.botToken` and `telegram.chatId`.

5. Test one full poll + check cycle (logs the notice instead of sending if Telegram isn't configured yet):

   ```
   npm run once
   ```

6. Run the notifier permanently:

   ```
   npm start
   ```

   Keep it alive with `pm2 start src/index.js --name wfh-notifier`, `nohup npm start &`, or a launchd service.

## Configuration (`config.json`)

| Key | Default | Description |
| --- | --- | --- |
| `api.url` | DOE APIMS hourly table for `CA08P` | The API endpoint polled for readings |
| `api.pollCron` | `"0 5 * * * *"` | 6-field cron (sec min hour dom mon dow) for the hourly data poll |
| `api.timeoutMs` | `15000` | HTTP timeout for API calls |
| `wfh.checkTime` | `"21:00"` | The reading used for the decision (24h, Malaysia time) |
| `wfh.fallbackTime` | `"20:00"` | Used if the check-time reading is unavailable |
| `wfh.retryMinutes` | `30` | How long to keep retrying when no reading is available |
| `wfh.retryIntervalMinutes` | `10` | Wait between retries |
| `wfh.threshold` | `200` | API >= threshold means WFH |
| `wfh.timezone` | `Asia/Kuala_Lumpur` | IANA timezone for scheduling and date logic |
| `wfh.weekendDays` | `[0, 6]` | Weekday numbers where no notice is sent for the *next* day (0=Sun, 6=Sat) |
| `telegram.botToken` | — | Bot token from @BotFather |
| `telegram.chatId` | — | Chat/group id the notice is sent to |
| `database.path` | `data.sqlite` | SQLite database file |

## Database

- `readings` — every hourly API reading ever polled (upserted by station + timestamp)
- `notifications` — one row per sent notice (decision date, reading used, WFH flag, message text)

## Commands

| Command | Purpose |
| --- | --- |
| `npm start` | Run the notifier (long-running) |
| `npm run once` | Single poll + check cycle, then exit |
| `npm run chat-id` | Print chat ids your bot has seen |
| `npm test` | Run the test suite |
