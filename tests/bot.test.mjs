import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.js';
import { handleUpdate, handleCallback, welcomeText, buildStatusText, buildAllowlistReview, buildUsersTable } from '../src/bot.js';

function setup({ text = '/start', userId = '42', username = null, allowed = ['42'], allowedUsernames = [], admin = [], chatId = 100, welcome = undefined } = {}) {
  const db = openDatabase(':memory:');
  const config = {
    telegram: {
      allowedUserIds: allowed,
      allowedUsernames,
      adminUserIds: admin,
      ...(welcome !== undefined ? { welcomeMessage: welcome } : {}),
    },
    wfh: { checkTime: '21:00', fallbackTime: '20:00', threshold: 200, timezone: 'Asia/Kuala_Lumpur' },
  };
  const update = {
    update_id: 1,
    message: {
      text,
      chat: { id: chatId, type: 'private', first_name: 'Teo' },
      from: { id: Number(userId), first_name: 'Teo', ...(username ? { username } : {}) },
    },
  };
  return { db, config, update };
}

function makeTrendRows(date, values) {
  const startHour = 13 - (values.length - 1);
  return values.map((v, i) => ({
    stationId: 'CA08P',
    datetimeLocal: `${date}T${String(startHour + i).padStart(2, '0')}:00:00`,
    apiValue: v,
    paramSymbol: '**',
    stationLocation: 'Minden, PULAU PINANG',
  }));
}

test('/start from allowlisted user subscribes and sends default welcome', async () => {
  const { db, config, update } = setup();
  const reply = await handleUpdate(update, { config, db });
  assert.match(reply.text, /Penang Branch WFH Notification Bot/);
  assert.match(reply.text, /9:00 PM/);
  assert.equal(db.countSubscribers(), 1);
  const sub = db.getSubscriber('100');
  assert.equal(sub.user_id, '42');
  assert.equal(sub.type, 'private');
});

test('/subscribe with @BotName suffix works', async () => {
  const { db, config, update } = setup({ text: '/subscribe@MyWfhBot' });
  const reply = await handleUpdate(update, { config, db });
  assert.match(reply.text, /Penang Branch WFH Notification Bot/);
  assert.equal(db.countSubscribers(), 1);
});

test('re-subscribing updates the existing row instead of duplicating', async () => {
  const { db, config, update } = setup();
  await handleUpdate(update, { config, db });
  await handleUpdate(update, { config, db });
  assert.equal(db.countSubscribers(), 1);
});

test('custom welcomeMessage replaces {name}', async () => {
  const { db, config, update } = setup({ welcome: 'Welcome {name}! Stay safe from the haze.' });
  const reply = await handleUpdate(update, { config, db });
  assert.equal(reply.text, 'Welcome Teo! Stay safe from the haze.');
});

test('welcome falls back to "there" when user has no name', async () => {
  const { db, config, update } = setup({ welcome: 'Hello {name}' });
  const anon = { ...update, message: { ...update.message, from: { id: 42 } } };
  const reply = await handleUpdate(anon, { config, db });
  assert.equal(reply.text, 'Hello there');
});

test('non-allowlisted users are rejected for every command', async () => {
  for (const text of ['/start', '/subscribe', '/stop', '/status', '/trend', '/help', 'hello there']) {
    const { db, config, update } = setup({ text, userId: '999' });
    const reply = await handleUpdate(update, { config, db });
    assert.match(reply.text, /not allowed/);
    assert.match(reply.text, /999/);
    assert.equal(db.countSubscribers(), 0);
  }
});

test('empty allowlist rejects everyone', async () => {
  const { db, config, update } = setup({ allowed: [] });
  const reply = await handleUpdate(update, { config, db });
  assert.match(reply.text, /not allowed/);
  assert.equal(db.countSubscribers(), 0);
});

test('allowlisted username grants access (case-insensitive, @ optional)', async () => {
  for (const entry of ['Teo', '@teo', 'TEO']) {
    const { db, config, update } = setup({ allowed: [], allowedUsernames: [entry], username: 'Teo' });
    const reply = await handleUpdate(update, { config, db });
    assert.match(reply.text, /Penang Branch WFH Notification Bot/);
    assert.equal(db.countSubscribers(), 1);
  }
});

test('mixed allowlist: id and username entries both work independently', async () => {
  const byId = setup({ allowed: ['42'], allowedUsernames: ['someoneelse'] });
  assert.match((await handleUpdate(byId.update, { config: byId.config, db: byId.db })).text, /Penang Branch/);
  const byName = setup({ allowed: [], allowedUsernames: ['someoneelse'], userId: '999', username: 'SomeoneElse' });
  assert.match((await handleUpdate(byName.update, { config: byName.config, db: byName.db })).text, /Penang Branch/);
});

test('user without username is rejected when only usernames are allowlisted', async () => {
  const { db, config, update } = setup({ allowed: [], allowedUsernames: ['teo'], username: null });
  const reply = await handleUpdate(update, { config, db });
  assert.match(reply.text, /not allowed/);
  assert.match(reply.text, /no Telegram username/);
  assert.equal(db.countSubscribers(), 0);
});

test('rejection message includes username when present', async () => {
  const { db, config, update } = setup({ userId: '999', username: 'stranger' });
  const reply = await handleUpdate(update, { config, db });
  assert.match(reply.text, /999/);
  assert.match(reply.text, /@stranger/);
});

test('/stop removes the subscription', async () => {
  const { db, config, update } = setup();
  await handleUpdate(update, { config, db });
  const reply = await handleUpdate({ ...update, message: { ...update.message, text: '/stop' } }, { config, db });
  assert.match(reply.text, /no longer/);
  assert.equal(db.countSubscribers(), 0);
});

test('/stop when not subscribed says so', async () => {
  const { db, config, update } = setup({ text: '/stop' });
  const reply = await handleUpdate(update, { config, db });
  assert.match(reply.text, /not subscribed/);
});

test('/status shows latest reading and next check', async () => {
  const { db, config, update } = setup({ text: '/status' });
  db.upsertReadings(
    [{ stationId: 'CA08P', datetimeLocal: '2026-10-09T12:00:00', apiValue: 155, paramSymbol: '**', stationLocation: 'Minden, PULAU PINANG' }],
    '2026-10-09T12:05:00Z'
  );
  const reply = await handleUpdate(update, { config, db });
  assert.match(reply.text, /API 155/);
  assert.match(reply.text, /21:00/);
  assert.match(reply.text, /NOT subscribed/);
});

test('/status without readings says so', async () => {
  const { db, config, update } = setup({ text: '/status' });
  const reply = await handleUpdate(update, { config, db });
  assert.match(reply.text, /No readings stored yet/);
});

test('/trend shows hourly readings and rising verdict', async () => {
  const { db, config, update } = setup({ text: '/trend' });
  db.upsertReadings(makeTrendRows('2026-10-09', [150, 153, 153, 153, 154, 154, 155]), '2026-10-09T13:05:00Z');
  const reply = await handleUpdate(update, { config, db });
  assert.match(reply.text, /API trend — Minden, PULAU PINANG/);
  assert.match(reply.text, /13:00 155 ↑ \+1/);
  assert.match(reply.text, /08:00 153 —/);
  assert.match(reply.text, /6h change: \+5 — rising/);
});

test('/trend falling verdict with downward arrows', async () => {
  const { db, config, update } = setup({ text: '/trend' });
  db.upsertReadings(makeTrendRows('2026-10-09', [160, 158, 157, 155, 152, 150, 148]), '2026-10-09T13:05:00Z');
  const reply = await handleUpdate(update, { config, db });
  assert.match(reply.text, /↓/);
  assert.match(reply.text, /6h change: -12 — falling/);
});

test('/trend stable when change is within deadband', async () => {
  const { db, config, update } = setup({ text: '/trend' });
  db.upsertReadings(makeTrendRows('2026-10-09', [153, 154, 153, 154, 153, 154, 155]), '2026-10-09T13:05:00Z');
  const reply = await handleUpdate(update, { config, db });
  assert.match(reply.text, /6h change: \+2 — stable/);
});

test('/trend ignores readings with null API value', async () => {
  const { db, config, update } = setup({ text: '/trend' });
  const rows = [
    ...makeTrendRows('2026-10-09', [153, 153, 153, 153, 153, 153, 153]),
    { stationId: 'CA08P', datetimeLocal: '2026-10-09T14:00:00', apiValue: null, paramSymbol: '**', stationLocation: 'Minden, PULAU PINANG' },
  ];
  db.upsertReadings(rows, '2026-10-09T14:05:00Z');
  const reply = await handleUpdate(update, { config, db });
  assert.match(reply.text, /13:00 153/);
  assert.doesNotMatch(reply.text, /null/);
});

test('/trend without readings says so', async () => {
  const { db, config, update } = setup({ text: '/trend' });
  const reply = await handleUpdate(update, { config, db });
  assert.match(reply.text, /No readings stored yet/);
});

test('welcomeText substitutes {name} in custom template', () => {
  const config = { telegram: { welcomeMessage: 'Hi {name}, you are in.' }, wfh: { checkTime: '21:00', timezone: 'Asia/Kuala_Lumpur' } };
  assert.equal(welcomeText(config, 'Bob'), 'Hi Bob, you are in.');
});

test('subscribing stores the Telegram username', async () => {
  const { db, config, update } = setup({ username: 'teo' });
  await handleUpdate(update, { config, db });
  assert.equal(db.getSubscriber('100').username, 'teo');
});

test('buildStatusText works with empty database', () => {
  const db = openDatabase(':memory:');
  const config = { wfh: { checkTime: '21:00', timezone: 'Asia/Kuala_Lumpur' } };
  const text = buildStatusText(config, db, false);
  assert.match(text, /No readings stored yet/);
  assert.match(text, /NOT subscribed/);
});

test('buildAllowlistReview matches subscribers by id and username, flags anomalies', () => {
  const db = openDatabase(':memory:');
  const config = { telegram: { allowedUserIds: ['1', '77'], allowedUsernames: ['@Teo', 'ghost'] } };
  const subscribers = [
    { chat_id: '10', user_id: '1', type: 'private', name: 'A', username: null },
    { chat_id: '20', user_id: '2', type: 'private', name: 'T', username: 'Teo' },
    { chat_id: '30', user_id: '3', type: 'private', name: 'B', username: null },
  ];
  const text = buildAllowlistReview(config, db, subscribers);
  assert.match(text, /Allowed user ids \(2\): 1, 77/);
  assert.match(text, /Allowed usernames \(2\): @teo, @ghost/);
  assert.match(text, /user 1[^—]*— allowlisted by id/);
  assert.match(text, /@teo — allowlisted by username/);
  assert.match(text, /user 3[^—]*— NOT ALLOWLISTED \(commands blocked, notices still sent\)/);
  assert.match(text, /Allowlisted but not subscribed \(2\): 77, @ghost/);
});

test('admin passes the gate even with empty allowlists', async () => {
  const { db, config, update } = setup({ allowed: [], allowedUsernames: [], admin: ['42'], text: '/status' });
  const reply = await handleUpdate(update, { config, db });
  assert.match(reply.text, /status/);
  assert.doesNotMatch(reply.text, /not allowed/);
});

test('admin commands are rejected for non-admin users', async () => {
  for (const text of ['/allow @x', '/disallow @x', '/allowlist']) {
    const { db, config, update } = setup({ text });
    const reply = await handleUpdate(update, { config, db });
    assert.match(reply.text, /admin-only/);
    assert.equal(db.listAllowlist().length, 0);
  }
});

test('admin /allow adds username and user id entries', async () => {
  const { db, config, update } = setup({ admin: ['42'], text: '/allow @NewGuy' });
  let reply = await handleUpdate(update, { config, db });
  assert.match(reply.text, /✅ Added @newguy/);
  reply = await handleUpdate({ ...update, message: { ...update.message, text: '/allow 123456789' } }, { config, db });
  assert.match(reply.text, /✅ Added 123456789/);
  const entries = db.listAllowlist();
  assert.deepEqual(entries.map((e) => [e.value, e.kind]).sort(), [['123456789', 'id'], ['newguy', 'username']]);
});

test('admin /allow with invalid argument shows usage', async () => {
  const { db, config, update } = setup({ admin: ['42'], text: '/allow not-valid!' });
  const reply = await handleUpdate(update, { config, db });
  assert.match(reply.text, /Usage: \/allow/);
  assert.equal(db.listAllowlist().length, 0);
});

test('user allowed via /allow can then use the bot', async () => {
  const admin = setup({ admin: ['42'], text: '/allow @newguy' });
  await handleUpdate(admin.update, { config: admin.config, db: admin.db });
  const newUser = setup({ allowed: [], allowedUsernames: [], userId: '999', username: 'NewGuy' });
  const reply = await handleUpdate(newUser.update, { config: newUser.config, db: admin.db });
  assert.match(reply.text, /Penang Branch WFH Notification Bot/);
  assert.equal(admin.db.countSubscribers(), 1);
});

test('admin /disallow removes a /allow entry and access is revoked', async () => {
  const { db, config, update } = setup({ admin: ['42'] });
  await handleUpdate({ ...update, message: { ...update.message, text: '/allow @tempguy' } }, { config, db });
  const reply = await handleUpdate({ ...update, message: { ...update.message, text: '/disallow @tempguy' } }, { config, db });
  assert.match(reply.text, /🗑️ Removed @tempguy/);
  assert.equal(db.listAllowlist().length, 0);
  const outsider = setup({ allowed: [], allowedUsernames: [], userId: '999', username: 'tempguy' });
  const rejected = await handleUpdate(outsider.update, { config: { ...config }, db });
  assert.match(rejected.text, /not allowed/);
});

test('admin /disallow refuses entries managed by config.json', async () => {
  const { db, config, update } = setup({ admin: ['42'], allowed: ['42'], allowedUsernames: ['teoteo'], text: '/disallow @teoteo' });
  const reply = await handleUpdate(update, { config, db });
  assert.match(reply.text, /allowlisted in config\.json/);
});

test('admin /allowlist shows the review', async () => {
  const { db, config, update } = setup({ admin: ['42'], text: '/allowlist' });
  const reply = await handleUpdate(update, { config, db });
  assert.match(reply.text, /Allowed user ids/);
  assert.match(reply.text, /Subscribers/);
});

test('unknown text gets help including /trend', async () => {
  const { db, config, update } = setup({ text: 'hello there' });
  const reply = await handleUpdate(update, { config, db });
  assert.match(reply.text, /\/subscribe/);
  assert.match(reply.text, /\/trend/);
  assert.equal(db.countSubscribers(), 0);
});

test('/users is admin-only', async () => {
  const { db, config, update } = setup({ text: '/users' });
  const reply = await handleUpdate(update, { config, db });
  assert.match(reply.text, /admin-only/);
});

test('buildUsersTable renders a padded, HTML-escaped table', () => {
  const db = openDatabase(':memory:');
  db.upsertSubscriber({ chatId: '10', userId: '111', type: 'private', name: 'Ali<tan>', username: 'alitan', subscribedAt: '2026-10-09T12:34:56.000Z' });
  db.upsertSubscriber({ chatId: '20', userId: '222', type: 'private', name: 'Bo', username: null, subscribedAt: '2026-10-08T09:00:00.000Z' });
  const t = buildUsersTable(db);
  assert.equal(t.parseMode, 'HTML');
  assert.match(t.text, /<pre>/);
  assert.match(t.text, /NAME\s+USERNAME\s+USER_ID\s+SINCE/);
  assert.match(t.text, /Ali&lt;tan&gt;/);
  assert.match(t.text, /@alitan/);
  assert.match(t.text, /222/);
  assert.doesNotMatch(t.text, /<tan>/);
});

test('/users returns the table for admin', async () => {
  const { db, config, update } = setup({ admin: ['42'], text: '/users' });
  db.upsertSubscriber({ chatId: '10', userId: '42', type: 'private', name: 'Teo', username: 'teo', subscribedAt: '2026-10-09T12:00:00.000Z' });
  const reply = await handleUpdate(update, { config, db });
  assert.equal(reply.parseMode, 'HTML');
  assert.match(reply.text, /Subscribers \(1\)/);
});

function callbackUpdate({ adminId = '42', data = 'allowreq:999', messageId = 55 } = {}) {
  return {
    update_id: 2,
    callback_query: {
      id: 'cbq1',
      from: { id: Number(adminId) },
      data,
      message: { message_id: messageId, chat: { id: 42, type: 'private' }, text: '🚨 New bot access request' },
    },
  };
}

test('rejected new user triggers one admin notification with approve/deny buttons', async () => {
  const db = openDatabase(':memory:');
  const config = { telegram: { allowedUserIds: [], allowedUsernames: [], adminUserIds: ['42'] }, wfh: {} };
  const sent = [];
  const telegram = { sendMessage: async (chatId, text, extra) => { sent.push({ chatId, text, extra }); return { ok: true }; } };
  const update = { message: { text: '/start', chat: { id: 999, type: 'private' }, from: { id: 999, first_name: 'Dan', username: 'dan88' } } };
  const reply1 = await handleUpdate(update, { config, db, telegram });
  assert.match(reply1.text, /sent for approval/);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chatId, '42');
  assert.match(sent[0].text, /New bot access request/);
  assert.match(sent[0].text, /@dan88/);
  assert.equal(sent[0].extra.replyMarkup.inline_keyboard.length, 2);
  assert.equal(sent[0].extra.replyMarkup.inline_keyboard[0].callback_data, 'allowreq:999');
  assert.ok(db.getPendingRequest('999'));
  await handleUpdate(update, { config, db, telegram });
  assert.equal(sent.length, 1, 'duplicate request must not re-notify');
});

test('approve callback allowlists, subscribes, and notifies the user', () => {
  const db = openDatabase(':memory:');
  const config = { telegram: { allowedUserIds: [], allowedUsernames: [], adminUserIds: ['42'] }, wfh: {} };
  db.upsertPendingRequest({ userId: '999', chatId: '999', username: 'dan88', name: 'Dan', requestedAt: new Date().toISOString() });
  const result = handleCallback(callbackUpdate({ data: 'allowreq:999' }), { config, db });
  assert.equal(result.callbackQueryId, 'cbq1');
  assert.match(result.answerText, /Approved/);
  assert.match(result.edit.text, /✅ Approved Dan \(@dan88\) — allowlisted and subscribed/);
  assert.equal(result.send[0].chatId, '999');
  assert.match(result.send[0].text, /approved/);
  assert.deepEqual(db.listAllowlist().map((e) => [e.value, e.kind]), [['999', 'id']]);
  assert.equal(db.countSubscribers(), 1);
  assert.equal(db.getPendingRequest('999'), null);
});

test('deny callback removes the pending request only', () => {
  const db = openDatabase(':memory:');
  const config = { telegram: { adminUserIds: ['42'] }, wfh: {} };
  db.upsertPendingRequest({ userId: '999', chatId: '999', username: null, name: 'Dan', requestedAt: new Date().toISOString() });
  const result = handleCallback(callbackUpdate({ data: 'denyreq:999' }), { config, db });
  assert.match(result.answerText, /Denied/);
  assert.match(result.edit.text, /❌ Denied Dan/);
  assert.equal(db.getPendingRequest('999'), null);
  assert.equal(db.countSubscribers(), 0);
  assert.equal(db.listAllowlist().length, 0);
});

test('callback from non-admin is rejected', () => {
  const db = openDatabase(':memory:');
  const config = { telegram: { adminUserIds: ['42'] }, wfh: {} };
  db.upsertPendingRequest({ userId: '999', chatId: '999', username: null, name: 'Dan', requestedAt: new Date().toISOString() });
  const result = handleCallback(callbackUpdate({ adminId: '1', data: 'allowreq:999' }), { config, db });
  assert.match(result.answerText, /Admin only/);
  assert.ok(db.getPendingRequest('999'), 'pending request must survive');
});

test('callback for stale request answers gracefully', () => {
  const db = openDatabase(':memory:');
  const config = { telegram: { adminUserIds: ['42'] }, wfh: {} };
  const result = handleCallback(callbackUpdate({ data: 'allowreq:123' }), { config, db });
  assert.match(result.answerText, /no longer pending/);
});
