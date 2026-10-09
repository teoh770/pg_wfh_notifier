# pg_wfh_notifier

Telegram bot that sends a nightly **Work From Home / Work From Office** notice based on the haze (Air Pollution Index) reading from the Malaysian DOE APIMS portal for **Minden, Pulau Pinang** (station `CA08P`).

## How it works

- Every hour (default: 5 minutes past), the bot polls the DOE API and stores all hourly readings in a local SQLite database (`data.sqlite`).
- At the configured check time (default **21:00** Malaysia time), it takes today's 21:00 API reading. If the 21:00 reading is unavailable, it uses the 20:00 reading. If neither is available yet, it retries every `retryIntervalMinutes` for up to `retryMinutes`.
- **If API >= threshold (default 200)** → tomorrow is **WORK FROM HOME**.
- **If API < threshold** → tomorrow is work from office as usual.
- If tomorrow is a weekend (Sat/Sun), **no message is sent**.
- The notice is sent to **everyone who subscribed via the bot**. Only users allowlisted by Telegram id (`telegram.allowedUserIds`) or username (`telegram.allowedUsernames`) can use the bot at all (others get a rejection with their id/username). People who blocked the bot are removed automatically after failed sends.
- One notice per day is recorded in the database, so restarts or re-runs never send duplicates. On startup, if the check time has already passed and today's notice hasn't been sent, a catch-up check runs.

## Requirements

- Node.js >= 23.4 (uses the built-in `node:sqlite` module; on Node 22.5–23.3 you must pass `--experimental-sqlite`)

## Bot commands

Only allowlisted users (by numeric id or username) can use the bot; everyone else gets a rejection reply containing their id and username.

| Command | Effect |
| --- | --- |
| `/start` or `/subscribe` | Subscribe to the nightly notice (sends the welcome message) |
| `/stop` or `/unsubscribe` | Stop receiving notices |
| `/status` | Latest stored reading + next check time |
| `/trend` | Last 6 hourly readings with per-hour change and rising/falling/stable verdict |

**Admin-only** (ids in `telegram.adminUserIds`; admins can use all commands even if not allowlisted):

| Command | Effect |
| --- | --- |
| `/allow <id or @username>` | Add to the runtime allowlist (stored in SQLite) |
| `/disallow <id or @username>` | Remove a runtime entry (entries from config.json are flagged, not removed) |
| `/allowlist` | Full allowlist/subscriber review |
| `/users` | Subscribers in a monospace table (name, username, user id, since) |

**New-user approval flow:** when someone not on the allowlist messages the bot, all admins get a notification with the user's name/username/id and inline **✅ Approve / ❌ Deny** buttons. Approve = user is allowlisted (by id), auto-subscribed, and receives a confirmation; Deny = request dropped. One notification per user until it's handled.

## Setup

1. Install dependencies:

   ```
   npm install
   ```

2. Create a bot: message [@BotFather](https://t.me/BotFather) on Telegram, send `/newbot`, and copy the token.

3. Edit `config.json`: set `telegram.botToken`. Leave `allowedUserIds` empty for now.

4. Start the bot (`npm start`) and send any message to it from Telegram — it will reply with your Telegram user id (non-allowlisted `/subscribe` replies include it). Paste that id into `telegram.allowedUserIds` and restart. Add the user ids of anyone else who should be allowed to subscribe.

5. Send `/subscribe` to the bot. Verify with:

   ```
   npm run subs
   ```

6. Test one full poll + check cycle:

   ```
   npm run once
   ```

7. Run the notifier permanently:

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
| `telegram.allowedUserIds` | `[]` | Telegram user ids allowed to use the bot and `/subscribe` (empty = nobody) |
| `telegram.allowedUsernames` | `[]` | Telegram usernames allowed to use the bot (`@` optional, case-insensitive; note usernames can change — ids are permanent) |
| `telegram.adminUserIds` | `[]` | Ids that may use `/allow`, `/disallow`, `/allowlist`; admins always pass the gate |
| `telegram.welcomeMessage` | built-in text | Welcome text sent on `/subscribe`; supports `{name}` placeholder |
| `database.path` | `data.sqlite` | SQLite database file |

## Deployment

Run the notifier permanently on a Linux VPS with systemd — see **[DEPLOY.md](DEPLOY.md)** for the full guide. Quick version:

```
./deploy.sh root@YOUR_SERVER_IP
```

## Database

- `readings` — every hourly API reading ever polled (upserted by station + timestamp)
- `notifications` — one row per sent notice (decision date, reading used, WFH flag, message text)
- `subscribers` — chats subscribed via the bot (chat id, user id, name)

## Commands

| Command | Purpose |
| --- | --- |
| `npm start` | Run the notifier (long-running) |
| `npm run once` | Single poll + check cycle, then exit |
| `npm run subs` | List current subscribers |
| `npm run allowlist` | Review the allowlists, cross-checked against subscribers (flags subscribed-but-not-allowlisted and allowlisted-but-not-subscribed) |
| `npm run msg:wfh` … `msg:wfo` / `msg:welcome` / `msg:status` / `msg:trend` | Send that message as a test (🧪 TEST banner) to all subscribers; prints it instead if there are none |
| `npm test` | Run the test suite |
