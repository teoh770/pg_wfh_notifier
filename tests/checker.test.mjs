import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.js';
import { createChecker } from '../src/checker.js';
import { addDays, formatDisplayDate, localDateInTz, weekdayOfLocalDate } from '../src/tz.js';

const TZ = 'Asia/Kuala_Lumpur';

function nowWhereTomorrowIs(dows) {
  const base = localDateInTz(new Date(), TZ);
  for (let i = 0; i < 7; i++) {
    const d = addDays(base, i);
    if (dows.includes(weekdayOfLocalDate(addDays(d, 1)))) {
      return new Date(`${d}T12:00:00+08:00`);
    }
  }
  throw new Error('unreachable');
}
const weekdayNow = () => nowWhereTomorrowIs([1, 2, 3, 4, 5]);
const fridayNow = () => nowWhereTomorrowIs([6]);

function makeRows(date, hours) {
  return Object.entries(hours).map(([h, v]) => ({
    stationId: 'CA08P',
    datetimeLocal: `${date}T${h}:00`,
    apiValue: v,
    paramSymbol: '**',
    stationLocation: 'Minden, PULAU PINANG',
  }));
}

function setup({ rowsFor, now = weekdayNow(), telegram = 'real', wfh = {}, fetchSequence = null } = {}) {
  const db = openDatabase(':memory:');
  const date = localDateInTz(now, TZ);
  const fetches = fetchSequence ?? [rowsFor ? rowsFor(date) : []];
  let call = 0;
  const fetchAndStore = async () => {
    const entry = fetches[Math.min(call, fetches.length - 1)];
    call++;
    const rows = typeof entry === 'function' ? entry(date) : entry;
    db.upsertReadings(rows, new Date().toISOString());
  };
  const sent = [];
  const logs = [];
  const logger = { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) };
  const tg = telegram === 'none' ? null : { sendMessage: async (t) => { sent.push(t); return true; } };
  const config = {
    wfh: {
      checkTime: '21:00',
      fallbackTime: '20:00',
      retryMinutes: 0,
      retryIntervalMinutes: 1,
      threshold: 200,
      timezone: TZ,
      weekendDays: [0, 6],
      ...wfh,
    },
  };
  const checker = createChecker({ config, db, fetchAndStore, telegram: tg, logger, now: () => now, sleep: async () => {} });
  return { checker, db, sent, logs, date };
}

test('sends WFH notice when check-time reading >= threshold', async () => {
  const { checker, db, sent, date } = setup({ rowsFor: (d) => makeRows(d, { '21:00': 210 }) });
  const result = await checker.runCheck();
  assert.equal(result.status, 'sent');
  assert.equal(result.wfh, true);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /WORK FROM HOME/);
  assert.match(sent[0], /21:00: 210/);
  assert.match(sent[0], /Minden, PULAU PINANG/);
  assert.ok(db.getNotification(addDays(date, 1)));
});

test('sends work-from-office notice when reading < threshold', async () => {
  const { checker, sent } = setup({ rowsFor: (d) => makeRows(d, { '21:00': 155 }) });
  const result = await checker.runCheck();
  assert.equal(result.status, 'sent');
  assert.equal(result.wfh, false);
  assert.match(sent[0], /work from office/);
});

test('threshold is inclusive: API == 200 means WFH', async () => {
  const { checker } = setup({ rowsFor: (d) => makeRows(d, { '21:00': 200 }) });
  const result = await checker.runCheck();
  assert.equal(result.wfh, true);
});

test('falls back to fallback time when check-time reading is missing', async () => {
  const { checker, sent } = setup({ rowsFor: (d) => makeRows(d, { '20:00': 250 }) });
  const result = await checker.runCheck();
  assert.equal(result.status, 'sent');
  assert.equal(result.usedFallback, true);
  assert.equal(result.wfh, true);
  assert.match(sent[0], /20:00 \(fallback\): 250/);
});

test('falls back when check-time reading exists but value is null', async () => {
  const { checker } = setup({ rowsFor: (d) => makeRows(d, { '21:00': null, '20:00': 210 }) });
  const result = await checker.runCheck();
  assert.equal(result.status, 'sent');
  assert.equal(result.usedFallback, true);
});

test('no usable data -> no-data status, nothing sent or recorded', async () => {
  const { checker, db, sent, date } = setup({ rowsFor: () => [] });
  const result = await checker.runCheck();
  assert.equal(result.status, 'no-data');
  assert.equal(sent.length, 0);
  assert.equal(db.getNotification(addDays(date, 1)), null);
});

test('skips sending when tomorrow is a weekend', async () => {
  const { checker, sent, logs } = setup({ rowsFor: (d) => makeRows(d, { '21:00': 300 }), now: fridayNow() });
  const result = await checker.runCheck();
  assert.equal(result.status, 'skipped-weekend');
  assert.equal(sent.length, 0);
  assert.ok(logs.some((l) => /weekend/.test(l)));
});

test('idempotent: second run same evening does not resend', async () => {
  const { checker, sent } = setup({ rowsFor: (d) => makeRows(d, { '21:00': 220 }) });
  const first = await checker.runCheck();
  const second = await checker.runCheck();
  assert.equal(first.status, 'sent');
  assert.equal(second.status, 'already-sent');
  assert.equal(sent.length, 1);
});

test('log-only mode when telegram is not configured', async () => {
  const { checker, db, sent, date } = setup({ rowsFor: (d) => makeRows(d, { '21:00': 230 }), telegram: 'none' });
  const result = await checker.runCheck();
  assert.equal(result.status, 'log-only');
  assert.equal(sent.length, 0);
  assert.equal(db.getNotification(addDays(date, 1)), null);
});

test('retries fetch until data appears', async () => {
  const { checker, sent } = setup({
    rowsFor: null,
    wfh: { retryMinutes: 20, retryIntervalMinutes: 10 },
    fetchSequence: [[], (d) => makeRows(d, { '21:00': 190 })],
  });
  const result = await checker.runCheck();
  assert.equal(result.status, 'sent');
  assert.equal(result.wfh, false);
  assert.equal(sent.length, 1);
});

test('db upsert: same station+datetime updates instead of duplicating', () => {
  const db = openDatabase(':memory:');
  const row = (v) => [{ stationId: 'CA08P', datetimeLocal: '2026-10-09T21:00:00', apiValue: v, paramSymbol: '**', stationLocation: 'X', }];
  db.upsertReadings(row(150), '2026-10-09T21:00:01Z');
  db.upsertReadings(row(180), '2026-10-09T21:05:00Z');
  assert.equal(db.countReadings(), 1);
  assert.equal(db.getReading('2026-10-09T21:00:00').api_value, 180);
});

test('tz utils: date math and weekdays', () => {
  assert.equal(addDays('2026-10-09', 1), '2026-10-10');
  assert.equal(addDays('2026-10-31', 1), '2026-11-01');
  assert.equal(addDays('2026-01-01', -1), '2025-12-31');
  assert.equal(weekdayOfLocalDate('2026-10-09'), 5); // Friday
  assert.equal(weekdayOfLocalDate('2026-10-10'), 6); // Saturday
  assert.equal(weekdayOfLocalDate('2026-10-11'), 0); // Sunday
  assert.equal(localDateInTz(new Date('2026-10-09T23:30:00Z'), TZ), '2026-10-10'); // 07:30 next day MYT
  assert.match(formatDisplayDate('2026-10-12'), /12 Oct 2026/);
});
