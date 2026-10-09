# Deploying the WFH Notifier to a Linux VPS

The bot is a single long-running Node.js process: it polls the DOE API hourly, runs the 21:00 (MYT) check, and long-polls Telegram for commands. It makes **outbound connections only** — no inbound ports, no domain, no reverse proxy needed. All timezone math is internal (`Asia/Kuala_Lumpur`), so the server timezone does not matter.

**Requirements:** a small Ubuntu 22.04/24.04 VPS (512 MB+ RAM is plenty), SSH access from your Mac, and your `config.json` (contains the bot token).

## 0. Create the server (if you don't have one)

Any provider works — Hetzner (CX22), DigitalOcean, Vultr, etc. Choose **Ubuntu 24.04**, the smallest size, and add your SSH key. Note the server IP.

## 1. First login and basic hardening

```bash
ssh root@YOUR_SERVER_IP

apt update && apt upgrade -y
apt install -y ufw sqlite3
ufw allow OpenSSH
ufw enable
timedatectl set-timezone Asia/Kuala_Lumpur   # optional: readable logs
```

## 2. Install Node.js 24 LTS

The app needs Node >= 23.4 (built-in `node:sqlite`). Node 24 LTS satisfies this and has SQLite fully supported.

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt install -y nodejs
node -v   # must be v24.x
```

## 3. Deploy from your Mac

From the project directory:

```bash
./deploy.sh root@YOUR_SERVER_IP
```

The script packages the app (excluding `node_modules`, the SQLite DB, and secrets), uploads it together with `config.json`, then on the server it:

1. Extracts to `/opt/wfh-notifier`, `chmod 600` the config
2. Creates a no-login system user `wfh`
3. Runs `npm install --omit=dev`
4. Installs the systemd unit (`deploy/wfh-notifier.service`) if missing, then (re)starts the service

Re-running `./deploy.sh` later updates the code and restarts — safe at any time (the bot is idempotent: one notice per day, catch-up check on startup, subscribers kept in SQLite).

## 4. Verify

```bash
# on the server
systemctl status wfh-notifier
journalctl -u wfh-notifier -f
```

You should see within seconds:

```
WFH notifier started (Asia/Kuala_Lumpur): poll cron "0 5 * * * *" ...
Poll OK: 24 readings stored/updated (latest ...)
Bot command polling started (long poll, 25s).
Scheduler started ...
```

Then from Telegram (as admin): `/status`, `/users`, `/allowlist` — all should reply. Finally test resilience: `systemctl restart wfh-notifier` — the process must come back and not re-send today's notice (idempotency + catch-up guard).

## 5. Day-to-day operations

| Task | Command |
| --- | --- |
| Watch logs | `journalctl -u wfh-notifier -f` |
| Restart | `systemctl restart wfh-notifier` |
| Stop / start | `systemctl stop wfh-notifier` / `start` |
| Boot status | `systemctl is-enabled wfh-notifier` (should be `enabled`) |
| Deploy an update | `./deploy.sh root@YOUR_SERVER_IP` (from your Mac) |
| Edit settings | Change `config.json` on the server (`nano /opt/wfh-notifier/config.json`), then restart |

## 6. Backups (recommended)

`data.sqlite` holds subscribers, the runtime allowlist, and notification history. Nightly backup via cron (as root, `crontab -e`):

```
0 6 * * * sqlite3 /opt/wfh-notifier/data.sqlite ".backup /opt/wfh-notifier/backups/data-$(date +\%F).sqlite" && find /opt/wfh-notifier/backups -mtime +30 -delete
```

```bash
mkdir -p /opt/wfh-notifier/backups && chown wfh:wfh /opt/wfh-notifier/backups
```

To restore: stop the service, replace `data.sqlite`, start again. Occasionally copy backups off-server (`scp root@YOUR_SERVER_IP:/opt/wfh-notifier/backups/* ~/wfh-backups/`).

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Service fails to start | `journalctl -u wfh-notifier -n 50`; common cause: Node < 23.4 or bad `config.json` (validation errors are logged at startup) |
| `node:sqlite` warning on Node 23 | Harmless; gone on Node 24 |
| Bot not answering Telegram | `journalctl -u wfh-notifier -f` → look for "Bot polling error"; check server outbound internet (`curl -s https://api.telegram.org`) |
| No nightly notice sent | Check it's not a weekend (skipped by design); `sqlite3 /opt/wfh-notifier/data.sqlite 'SELECT * FROM notifications ORDER BY id DESC LIMIT 5;'`; check the 21:00/20:00 reading existed in `readings` |
| Wrong Node used by systemd | Unit runs `/usr/bin/node`; verify with `ls -l $(which node)` |
