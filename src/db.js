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
  `);

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
    close() {
      db.close();
    },
  };
}
