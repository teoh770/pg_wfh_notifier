import { logger } from './log.js';

const HELP_TEXT = [
  'WFH Haze Notifier — commands:',
  '/subscribe — receive the nightly WFH/WFO notice',
  '/stop — stop receiving notices',
  '/status — latest API reading and next check time',
  '/trend — API level over the last 6 hours (rising/falling/stable)',
  'Admin: /allow <id|@username> · /disallow <id|@username> · /allowlist · /users',
].join('\n');

function parseCommand(text) {
  const m = /^\/([a-zA-Z]+)(?:@\w+)?\s*([\s\S]*)$/.exec(String(text ?? '').trim());
  if (!m) return { cmd: null, arg: '' };
  return { cmd: m[1].toLowerCase(), arg: m[2].trim() };
}

const DEFAULT_WELCOME = `👋 Welcome to the Penang Branch WFH Notification Bot!

This bot provides daily updates on whether tomorrow will be a Work From Home (WFH) day due to poor air quality.

📋 How It Works

* 🕘 Daily Update: A notification will be sent at 9:00 PM to inform you of the WFH arrangement for the following day.
* 🌫️ WFH Threshold: If the official Air Pollutant Index (API) exceeds 200 at 6:00 PM or later, the following day may be designated as a WFH day.
* 🇲🇾 Official Data Source: We refer exclusively to Malaysia’s Department of Environment APIMS website: https://eqms.doe.gov.my/APIMS/main
* 🚫 No Third-Party Sources: IQAir and other third-party air quality platforms will not be used to determine the WFH arrangement.

⚠️ Important Notes

* This arrangement applies to the Penang branch only.
* The WFH arrangement is subject to management’s final decision. Management reserves the right to amend or revise the arrangement when necessary.
* Please continue to monitor notifications for the latest updates.

💚 Stay Safe
Please take care of your health, wear a mask when necessary, and minimise outdoor activities when air quality is poor.

Thank you, and stay safe!`;

export function welcomeText(config, name) {
  const template =
    typeof config.telegram.welcomeMessage === 'string' && config.telegram.welcomeMessage.trim() !== ''
      ? config.telegram.welcomeMessage
      : DEFAULT_WELCOME;
  return template.replaceAll('{name}', name || 'there');
}

function hourSpan(latest, oldest) {
  return Math.round((Date.parse(`${latest}Z`) - Date.parse(`${oldest}Z`)) / 3_600_000);
}

export function buildTrendText(db) {
  const rows = db.getRecentReadings(7);
  if (!rows.length) return 'No readings stored yet.';
  const latest = rows[0];
  const display = rows.slice(0, 6);
  const lines = [`📈 API trend — ${latest.station_location ?? latest.station_id ?? 'Unknown'}`, ''];
  for (let i = 0; i < display.length; i++) {
    const r = display[i];
    const prev = display[i + 1];
    const head = `${r.datetime_local.slice(11, 16)} ${r.api_value}`;
    if (!prev) {
      lines.push(`${head} —`);
    } else {
      const d = r.api_value - prev.api_value;
      const arrow = d > 0 ? '↑' : d < 0 ? '↓' : '→';
      lines.push(`${head} ${arrow} ${d > 0 ? '+' : ''}${d}`);
    }
  }
  if (rows.length >= 2) {
    const oldest = rows[rows.length - 1];
    const change = latest.api_value - oldest.api_value;
    const verdict = change >= 5 ? 'rising 📈' : change <= -5 ? 'falling 📉' : 'stable (|change| < 5)';
    lines.push('', `${hourSpan(latest.datetime_local, oldest.datetime_local)}h change: ${change > 0 ? '+' : ''}${change} — ${verdict}`);
  }
  return lines.join('\n');
}

export function buildStatusText(config, db, subscribed) {
  const latest = db.getLatestReading();
  const lines = ['WFH Haze Notifier — status'];
  if (latest) {
    lines.push(
      `Station: ${latest.station_location ?? latest.station_id}`,
      `Latest reading: API ${latest.api_value ?? 'n/a'} at ${latest.datetime_local.slice(11, 16)} on ${latest.datetime_local.slice(0, 10)}`
    );
  } else {
    lines.push('No readings stored yet.');
  }
  lines.push(`Next check: ${config.wfh.checkTime} ${config.wfh.timezone}`, `You are ${subscribed ? 'subscribed' : 'NOT subscribed'}.`);
  return lines.join('\n');
}

function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function buildUsersTable(db) {
  const subs = db.listSubscribers();
  if (!subs.length) return { text: '👥 Subscribers\n\nNo subscribers yet.', parseMode: 'HTML' };
  const w = { name: 14, username: 16, userId: 12, since: 12 };
  const headerLine = ['NAME'.padEnd(w.name), 'USERNAME'.padEnd(w.username), 'USER_ID'.padEnd(w.userId), 'SINCE'.padEnd(w.since)].join('');
  const sep = '-'.repeat(headerLine.length);
  const lines = subs.map((s) => {
    const cells = [
      String(s.name ?? ''),
      s.username ? `@${s.username}` : '—',
      String(s.user_id ?? ''),
      String(s.subscribed_at ?? '').slice(5, 10) + ' ' + String(s.subscribed_at ?? '').slice(11, 16),
    ];
    return cells.map((c, i) => c.slice(0, [w.name, w.username, w.userId, w.since][i] - 1).padEnd([w.name, w.username, w.userId, w.since][i])).join('');
  });
  const table = [headerLine, sep, ...lines].join('\n');
  return { text: `👥 Subscribers (${subs.length})\n\n<pre>${escapeHtml(table)}</pre>`, parseMode: 'HTML' };
}

export async function handleUpdate(update, { config, db, telegram }) {
  const msg = update?.message;
  if (!msg?.chat || !msg.from) return null;
  const chat = msg.chat;
  const chatId = String(chat.id);
  const userId = String(msg.from.id ?? '');

  const username = normalizeUsername(msg.from.username ?? '');
  const eff = effectiveAllowlist(config, db);
  const isAdmin = (config.telegram.adminUserIds ?? []).includes(userId);
  if (!isAdmin && !eff.ids.includes(userId) && !eff.usernames.includes(username)) {
    const nameLine = username ? `Your username: @${username}` : 'You have no Telegram username set.';
    await notifyAdminsOfRequest({ config, db, telegram, chat, msg, userId, username });
    return {
      chatId,
      text: `⛔ You are not allowed to use this bot yet.\nYour request has been sent for approval.\nYour Telegram user id: ${userId}\n${nameLine}`,
    };
  }

  const subscribed = db.getSubscriber(chatId) != null;
  const name = msg.from.first_name ?? chat.title ?? msg.from.username ?? '';
  const { cmd, arg } = parseCommand(msg.text);

  let text;
  let parseMode;
  switch (cmd) {
    case 'start':
    case 'subscribe': {
      db.upsertSubscriber({
        chatId,
        userId,
        type: chat.type ?? 'private',
        name: chat.title ?? msg.from.first_name ?? msg.from.username ?? '',
        username: msg.from.username ?? null,
        subscribedAt: new Date().toISOString(),
      });
      text = welcomeText(config, name);
      break;
    }
    case 'stop':
    case 'unsubscribe': {
      const removed = db.removeSubscriber(chatId);
      text = removed ? 'You will no longer receive WFH notices. Send /subscribe to re-subscribe.' : 'You were not subscribed.';
      break;
    }
    case 'status': {
      text = buildStatusText(config, db, subscribed);
      break;
    }
    case 'trend': {
      text = buildTrendText(db);
      break;
    }
    case 'allow': {
      if (!isAdmin) {
        text = '⛔ This command is admin-only.';
        break;
      }
      const parsed = parseAllowArg(arg);
      if (!parsed.kind) {
        text = 'Usage: /allow <user id | @username>\nExample: /allow 123456789 or /allow @teo';
        break;
      }
      db.addToAllowlist({ value: parsed.value, kind: parsed.kind, addedBy: userId, addedAt: new Date().toISOString() });
      text = `✅ Added ${parsed.kind === 'id' ? parsed.value : `@${parsed.value}`} to the allowlist.`;
      break;
    }
    case 'disallow': {
      if (!isAdmin) {
        text = '⛔ This command is admin-only.';
        break;
      }
      const parsed = parseAllowArg(arg);
      if (!parsed.kind) {
        text = 'Usage: /disallow <user id | @username>';
        break;
      }
      const label = parsed.kind === 'id' ? parsed.value : `@${parsed.value}`;
      const inConfig =
        parsed.kind === 'id'
          ? (config.telegram.allowedUserIds ?? []).map(String).includes(parsed.value)
          : (config.telegram.allowedUsernames ?? []).map(normalizeUsername).includes(parsed.value);
      if (inConfig) {
        text = `⚠️ ${label} is allowlisted in config.json — remove it there.`;
        break;
      }
      const removed = db.removeFromAllowlist(parsed.value);
      text = removed ? `🗑️ Removed ${label} from the allowlist.` : `${label} was not in the Telegram-managed allowlist.`;
      break;
    }
    case 'allowlist': {
      if (!isAdmin) {
        text = '⛔ This command is admin-only.';
        break;
      }
      text = buildAllowlistReview(config, db, db.listSubscribers());
      break;
    }
    case 'users': {
      if (!isAdmin) {
        text = '⛔ This command is admin-only.';
        break;
      }
      ({ text, parseMode } = buildUsersTable(db));
      break;
    }
    case 'help':
    default:
      text = HELP_TEXT;
      break;
  }
  return { chatId, text, parseMode };
}

export function normalizeUsername(u) {
  return String(u ?? '').trim().replace(/^@/, '').toLowerCase();
}

function parseAllowArg(arg) {
  const raw = String(arg ?? '').trim();
  if (/^\d{1,15}$/.test(raw)) return { kind: 'id', value: raw };
  const username = normalizeUsername(raw);
  if (/^[a-z0-9_]{4,32}$/.test(username)) return { kind: 'username', value: username };
  return {};
}

export function effectiveAllowlist(config, db) {
  const ids = new Set((config.telegram.allowedUserIds ?? []).map(String));
  const usernames = new Set((config.telegram.allowedUsernames ?? []).map(normalizeUsername));
  for (const row of db.listAllowlist()) {
    if (row.kind === 'id') ids.add(String(row.value));
    else usernames.add(normalizeUsername(row.value));
  }
  return { ids: [...ids], usernames: [...usernames] };
}

export function buildAllowlistReview(config, db, subscribers) {
  const eff = effectiveAllowlist(config, db);
  const managed = db.listAllowlist();
  const lines = [
    `Allowed user ids (${eff.ids.length}): ${eff.ids.length ? eff.ids.join(', ') : 'none'}`,
    `Allowed usernames (${eff.usernames.length}): ${eff.usernames.length ? eff.usernames.map((n) => `@${n}`).join(', ') : 'none'}`,
  ];
  if (managed.length) {
    lines.push(`Managed via /allow (${managed.length}): ${managed.map((m) => (m.kind === 'id' ? m.value : `@${m.value}`)).join(', ')}`);
  }
  lines.push(`Subscribers (${subscribers.length}):`);
  const allowlistedIds = new Set(eff.ids.map(String));
  const allowlistedNames = new Set(eff.usernames);
  const matchedIds = new Set();
  const matchedNames = new Set();
  if (!subscribers.length) lines.push('  none');
  for (const s of subscribers) {
    const byId = allowlistedIds.has(String(s.user_id ?? ''));
    const username = normalizeUsername(s.username);
    const byName = username !== '' && allowlistedNames.has(username);
    if (byId) matchedIds.add(String(s.user_id));
    if (byName) matchedNames.add(username);
    const how = byId && byName ? 'allowlisted by id+username' : byId ? 'allowlisted by id' : byName ? 'allowlisted by username' : 'NOT ALLOWLISTED (commands blocked, notices still sent)';
    lines.push(`  ${s.chat_id}  ${s.type}${s.name ? `, ${s.name}` : ''}  user ${s.user_id ?? '?'}${username ? ` @${username}` : ''} — ${how}`);
  }
  const missing = [
    ...[...allowlistedIds].filter((id) => !matchedIds.has(id)),
    ...[...allowlistedNames].filter((n) => !matchedNames.has(n)).map((n) => `@${n}`),
  ];
  if (missing.length) lines.push(`Allowlisted but not subscribed (${missing.length}): ${missing.join(', ')}`);
  return lines.join('\n');
}

async function notifyAdminsOfRequest({ config, db, telegram, chat, msg, userId, username }) {
  const admins = config.telegram.adminUserIds ?? [];
  if (!telegram || admins.length === 0) return;
  if (db.getPendingRequest(userId)) return;
  const name = msg.from.first_name ?? chat.title ?? msg.from.username ?? 'Unknown';
  db.upsertPendingRequest({
    userId,
    chatId: String(chat.id),
    username: msg.from.username ?? null,
    name,
    requestedAt: new Date().toISOString(),
  });
  const keyboard = {
    inline_keyboard: [
      { text: '✅ Approve', callback_data: `allowreq:${userId}` },
      { text: '❌ Deny', callback_data: `denyreq:${userId}` },
    ],
  };
  const notifyText = [
    '🚨 New bot access request',
    `Name: ${name}`,
    `Username: ${username ? `@${username}` : '(none)'}`,
    `User id: ${userId}`,
  ].join('\n');
  for (const admin of admins) {
    await telegram.sendMessage(String(admin), notifyText, { replyMarkup: keyboard });
  }
}

export function handleCallback(update, { config, db }) {
  const cbq = update?.callback_query;
  if (!cbq) return null;
  const adminId = String(cbq.from?.id ?? '');
  if (!(config.telegram.adminUserIds ?? []).includes(adminId)) {
    return { callbackQueryId: cbq.id, answerText: '⛔ Admin only.' };
  }
  const m = /^(allowreq|denyreq):(\d{1,15})$/.exec(String(cbq?.data ?? ''));
  if (!m) return { callbackQueryId: cbq.id, answerText: 'Unknown action.' };
  const [, action, userId] = m;
  const msg = cbq.message;
  const edit = msg ? { chatId: String(msg.chat.id), messageId: msg.message_id } : null;
  const pending = db.getPendingRequest(userId);
  if (!pending) {
    return {
      callbackQueryId: cbq.id,
      answerText: 'Request no longer pending.',
      ...(edit ? { edit: { ...edit, text: msg.text ?? '(request expired)' } } : {}),
    };
  }
  const label = `${pending.name ?? 'User'}${pending.username ? ` (@${pending.username})` : ''}`;
  if (action === 'denyreq') {
    db.deletePendingRequest(userId);
    return {
      callbackQueryId: cbq.id,
      answerText: 'Denied.',
      ...(edit ? { edit: { ...edit, text: `❌ Denied ${label}.` } } : {}),
    };
  }
  const now = new Date().toISOString();
  db.addToAllowlist({ value: userId, kind: 'id', addedBy: adminId, addedAt: now });
  db.upsertSubscriber({
    chatId: pending.chat_id,
    userId,
    type: 'private',
    name: pending.name ?? '',
    username: pending.username ?? null,
    subscribedAt: now,
  });
  db.deletePendingRequest(userId);
  return {
    callbackQueryId: cbq.id,
    answerText: 'Approved & subscribed.',
    ...(edit ? { edit: { ...edit, text: `✅ Approved ${label} — allowlisted and subscribed.` } } : {}),
    send: [
      {
        chatId: pending.chat_id,
        text: '🎉 You have been approved! You will now receive the nightly WFH/WFO notices.\nSend /status for the latest reading, /trend for the recent trend.',
      },
    ],
  };
}

export function startBotPolling({ telegram, db, config }) {
  const controller = new AbortController();
  let stopped = false;
  let offset = 0;

  (async () => {
    logger.info('Bot command polling started (long poll, 25s).');
    while (!stopped) {
      try {
        const updates = await telegram.getUpdates(offset, 25, controller.signal);
        for (const u of updates) {
          offset = Math.max(offset, u.update_id + 1);
          if (u.callback_query) {
            const cb = handleCallback(u, { config, db });
            if (!cb) continue;
            await telegram.answerCallbackQuery(cb.callbackQueryId, cb.answerText);
            if (cb.edit) await telegram.editMessageText(cb.edit.chatId, cb.edit.messageId, cb.edit.text);
            for (const m of cb.send ?? []) await telegram.sendMessage(m.chatId, m.text);
            continue;
          }
          const reply = await handleUpdate(u, { config, db, telegram });
          if (!reply) continue;
          const r = await telegram.sendMessage(reply.chatId, reply.text, { parseMode: reply.parseMode });
          if (!r.ok && r.permanent) db.removeSubscriber(reply.chatId);
        }
      } catch (e) {
        if (stopped) break;
        logger.error(`Bot polling error: ${e.message}`);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
    logger.info('Bot command polling stopped.');
  })();

  return {
    stop() {
      stopped = true;
      controller.abort();
    },
  };
}
