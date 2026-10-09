import { DatabaseSync } from 'node:sqlite';

export function openDatabase(path) {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS readings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      station_id TEXT NOT NULL,
      datetime_local TEXT NOT NULL,
      api_value INTEGER,
      param_symbol TEXT,
      station_location TEXT,
      fetched_at TEXT NOT NULL,
      UNIQUE (station_id, datetime_local)
    );
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      decision_date TEXT NOT NULL UNIQUE,
      reading_datetime TEXT NOT NULL,
      api_value INTEGER NOT NULL,
      wfh INTEGER NOT NULL,
      sent_at TEXT NOT NULL,
      message_text TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS subscribers (
      chat_id TEXT PRIMARY KEY,
      user_id TEXT,
      type TEXT,
      name TEXT,
      subscribed_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS allowlist (
      value TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      added_by TEXT,
      added_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pending_requests (
      user_id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      username TEXT,
      name TEXT,
      requested_at TEXT NOT NULL
    );
  `);
  const subscriberCols = db.prepare('PRAGMA table_info(subscribers)').all().map((c) => c.name);
  if (!subscriberCols.includes('username')) {
    db.exec('ALTER TABLE subscribers ADD COLUMN username TEXT');
  }

  const upsertStmt = db.prepare(`
    INSERT INTO readings (station_id, datetime_local, api_value, param_symbol, station_location, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (station_id, datetime_local) DO UPDATE SET
      api_value = excluded.api_value,
      param_symbol = excluded.param_symbol,
      station_location = excluded.station_location,
      fetched_at = excluded.fetched_at
  `);
  const getReadingStmt = db.prepare(
    'SELECT station_id, datetime_local, api_value, param_symbol, station_location, fetched_at FROM readings WHERE datetime_local = ?'
  );
  const getNotificationStmt = db.prepare('SELECT * FROM notifications WHERE decision_date = ?');
  const insertNotificationStmt = db.prepare(
    'INSERT INTO notifications (decision_date, reading_datetime, api_value, wfh, sent_at, message_text) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const countReadingsStmt = db.prepare('SELECT COUNT(*) AS n FROM readings');
  const upsertSubscriberStmt = db.prepare(`
    INSERT INTO subscribers (chat_id, user_id, type, name, username, subscribed_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (chat_id) DO UPDATE SET
      user_id = excluded.user_id,
      type = excluded.type,
      name = excluded.name,
      username = excluded.username,
      subscribed_at = excluded.subscribed_at
  `);
  const removeSubscriberStmt = db.prepare('DELETE FROM subscribers WHERE chat_id = ?');
  const getSubscriberStmt = db.prepare('SELECT * FROM subscribers WHERE chat_id = ?');
  const listSubscribersStmt = db.prepare('SELECT * FROM subscribers ORDER BY subscribed_at');
  const countSubscribersStmt = db.prepare('SELECT COUNT(*) AS n FROM subscribers');
  const addToAllowlistStmt = db.prepare(`
    INSERT INTO allowlist (value, kind, added_by, added_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT (value) DO UPDATE SET
      kind = excluded.kind,
      added_by = excluded.added_by,
      added_at = excluded.added_at
  `);
  const removeFromAllowlistStmt = db.prepare('DELETE FROM allowlist WHERE value = ?');
  const listAllowlistStmt = db.prepare('SELECT value, kind, added_by, added_at FROM allowlist ORDER BY added_at');
  const upsertPendingRequestStmt = db.prepare(
    'INSERT OR IGNORE INTO pending_requests (user_id, chat_id, username, name, requested_at) VALUES (?, ?, ?, ?, ?)'
  );
  const getPendingRequestStmt = db.prepare('SELECT * FROM pending_requests WHERE user_id = ?');
  const deletePendingRequestStmt = db.prepare('DELETE FROM pending_requests WHERE user_id = ?');
  const getLatestReadingStmt = db.prepare(
    'SELECT station_id, datetime_local, api_value, station_location FROM readings ORDER BY datetime_local DESC LIMIT 1'
  );
  const getRecentReadingsStmt = db.prepare(
    'SELECT station_id, datetime_local, api_value, station_location FROM readings WHERE api_value IS NOT NULL ORDER BY datetime_local DESC LIMIT ?'
  );

  return {
    upsertReadings(rows, fetchedAtIso) {
      db.exec('BEGIN');
      try {
        for (const r of rows) {
          upsertStmt.run(r.stationId, r.datetimeLocal, r.apiValue, r.paramSymbol, r.stationLocation, fetchedAtIso);
        }
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
    getReading(datetimeLocal) {
      return getReadingStmt.get(datetimeLocal) ?? null;
    },
    getNotification(decisionDate) {
      return getNotificationStmt.get(decisionDate) ?? null;
    },
    recordNotification(n) {
      insertNotificationStmt.run(n.decisionDate, n.readingDatetime, n.apiValue, n.wfh, n.sentAt, n.messageText);
    },
    countReadings() {
      return countReadingsStmt.get().n;
    },
    upsertSubscriber({ chatId, userId, type, name, username = null, subscribedAt }) {
      upsertSubscriberStmt.run(chatId, userId, type, name, username, subscribedAt);
    },
    removeSubscriber(chatId) {
      return removeSubscriberStmt.run(chatId).changes > 0;
    },
    getSubscriber(chatId) {
      return getSubscriberStmt.get(chatId) ?? null;
    },
    listSubscribers() {
      return listSubscribersStmt.all();
    },
    countSubscribers() {
      return countSubscribersStmt.get().n;
    },
    addToAllowlist({ value, kind, addedBy = null, addedAt }) {
      addToAllowlistStmt.run(value, kind, addedBy, addedAt);
    },
    removeFromAllowlist(value) {
      return removeFromAllowlistStmt.run(value).changes > 0;
    },
    listAllowlist() {
      return listAllowlistStmt.all();
    },
    upsertPendingRequest({ userId, chatId, username, name, requestedAt }) {
      upsertPendingRequestStmt.run(userId, chatId, username, name, requestedAt);
    },
    getPendingRequest(userId) {
      return getPendingRequestStmt.get(userId) ?? null;
    },
    deletePendingRequest(userId) {
      return deletePendingRequestStmt.run(userId).changes > 0;
    },
    getLatestReading() {
      return getLatestReadingStmt.get() ?? null;
    },
    getRecentReadings(limit) {
      return getRecentReadingsStmt.all(limit);
    },
    close() {
      db.close();
    },
  };
}
