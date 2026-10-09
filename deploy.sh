#!/usr/bin/env bash
# One-command deploy from your Mac:  ./deploy.sh root@YOUR_SERVER_IP
# Works for both first deploy and updates. See DEPLOY.md for the full guide.
set -euo pipefail

HOST="${1:?Usage: ./deploy.sh user@host  (e.g. root@203.0.113.10)}"
APP_DIR="$(cd "$(dirname "$0")" && pwd)"
TARBALL="/tmp/wfh-notifier.tar.gz"

echo "==> Packaging app (excluding node_modules, data.sqlite*, config.json, .git)"
tar -czf "$TARBALL" \
  --exclude node_modules \
  --exclude 'data.sqlite*' \
  --exclude config.json \
  --exclude .git \
  --exclude backups \
  -C "$APP_DIR" .

echo "==> Uploading to $HOST"
scp "$TARBALL" "$HOST":/tmp/wfh-notifier.tar.gz
scp "$APP_DIR/config.json" "$HOST":/tmp/wfh-config.json

echo "==> Installing on server"
ssh "$HOST" 'bash -s' <<'EOF'
set -euo pipefail

command -v node >/dev/null 2>&1 || { echo "ERROR: Node.js is not installed on the server (need >= 23.4). See DEPLOY.md step 2."; exit 1; }
command -v systemctl >/dev/null 2>&1 || { echo "ERROR: systemctl not found — this script targets a systemd Linux VPS."; exit 1; }

mkdir -p /opt/wfh-notifier
tar -xzf /tmp/wfh-notifier.tar.gz -C /opt/wfh-notifier
cp /tmp/wfh-config.json /opt/wfh-notifier/config.json
chmod 600 /opt/wfh-notifier/config.json

id wfh >/dev/null 2>&1 || useradd --system --home-dir /opt/wfh-notifier --shell /usr/sbin/nologin wfh

cd /opt/wfh-notifier
npm install --omit=dev --no-fund --no-audit
chown -R wfh:wfh /opt/wfh-notifier

if [ -f /etc/systemd/system/wfh-notifier.service ]; then
  systemctl restart wfh-notifier
else
  cp /opt/wfh-notifier/deploy/wfh-notifier.service /etc/systemd/system/
  systemctl daemon-reload
  systemctl enable --now wfh-notifier
fi

sleep 2
systemctl --no-pager --lines 5 status wfh-notifier
echo ""
echo "Deployed. Watch logs with:  journalctl -u wfh-notifier -f"
EOF

rm -f "$TARBALL"
echo "==> Done"
