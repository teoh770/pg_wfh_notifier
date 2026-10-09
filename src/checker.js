import { addDays, formatDisplayDate, localDateInTz, weekdayOfLocalDate } from './tz.js';

export function buildMessage({ tomorrow, reading, wfh }) {
  const hour = reading.datetime_local.slice(11, 16);
  return [
    `${wfh ? '🌫️' : '🌤️'} WFH Notice — Tomorrow (${formatDisplayDate(tomorrow)})`,
    '',
    `Station: ${reading.station_location ?? 'Unknown'}`,
    `API reading at ${hour}: ${reading.api_value}`,
    '',
    wfh
      ? 'Air pollution has reached the unhealthy threshold. Tomorrow is WORK FROM HOME. 😷'
      : 'Air quality is below the threshold. Tomorrow is work from office as usual.',
  ].join('\n');
}

export function createChecker({
  config,
  db,
  fetchAndStore,
  telegram,
  logger,
  now = () => new Date(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  const { checkTime, fallbackTime, threshold, timezone, weekendDays, retryMinutes, retryIntervalMinutes } = config.wfh;

  async function runCheck() {
    const today = localDateInTz(now(), timezone);
    const tomorrow = addDays(today, 1);

    if (weekendDays.includes(weekdayOfLocalDate(tomorrow))) {
      logger.info(`Check skipped: tomorrow (${tomorrow}) is a weekend — no notice sent.`);
      return { status: 'skipped-weekend' };
    }
    if (db.getNotification(tomorrow)) {
      logger.info(`Notice for ${tomorrow} was already sent. Skipping.`);
      return { status: 'already-sent' };
    }

    const targetDatetime = `${today}T${checkTime}:00`;
    const fallbackDatetime = `${today}T${fallbackTime}:00`;
    const maxAttempts = Math.max(1, Math.floor(retryMinutes / retryIntervalMinutes) + 1);

    let reading = null;
    let usedFallback = false;
    for (let attempt = 1; attempt <= maxAttempts && !reading; attempt++) {
      try {
        await fetchAndStore();
      } catch (e) {
        logger.error(`Fetch attempt ${attempt}/${maxAttempts} failed: ${e.message}`);
      }
      const primary = db.getReading(targetDatetime);
      if (primary && primary.api_value != null) reading = primary;
      if (!reading) {
        const fb = db.getReading(fallbackDatetime);
        if (fb && fb.api_value != null) {
          reading = fb;
          usedFallback = true;
        }
      }
      if (!reading && attempt < maxAttempts) {
        logger.info(
          `No usable reading yet for ${checkTime} (fallback ${fallbackTime}). Retrying in ${retryIntervalMinutes} min...`
        );
        await sleep(retryIntervalMinutes * 60_000);
      }
    }

    if (!reading) {
      logger.error(
        `No API reading available for ${targetDatetime} or ${fallbackDatetime} after ${maxAttempts} attempt(s). No notice sent.`
      );
      return { status: 'no-data' };
    }

    const wfh = reading.api_value >= threshold;
    const message = buildMessage({ tomorrow, reading, wfh });

    if (!telegram) {
      logger.info(`Telegram not configured — notice NOT sent, only logged:\n${message}`);
      return { status: 'log-only', wfh, apiValue: reading.api_value, readingDatetime: reading.datetime_local, usedFallback };
    }

    const subscribers = db.listSubscribers();
    if (subscribers.length === 0) {
      logger.warn(`No subscribers yet — notice for ${tomorrow} NOT sent (not recorded):\n${message}`);
      return { status: 'no-subscribers', wfh, apiValue: reading.api_value, readingDatetime: reading.datetime_local, usedFallback };
    }

    let sentCount = 0;
    const removed = [];
    for (const s of subscribers) {
      const r = await telegram.sendMessage(s.chat_id, message);
      if (r.ok) sentCount++;
      else if (r.permanent) removed.push(s.chat_id);
    }
    for (const chatId of removed) db.removeSubscriber(chatId);

    if (sentCount === 0) {
      logger.error('Telegram send failed for all subscribers. Notice NOT recorded; re-run the check to retry.');
      return { status: 'send-failed', wfh, apiValue: reading.api_value, readingDatetime: reading.datetime_local, usedFallback };
    }

    db.recordNotification({
      decisionDate: tomorrow,
      readingDatetime: reading.datetime_local,
      apiValue: reading.api_value,
      wfh: wfh ? 1 : 0,
      sentAt: new Date().toISOString(),
      messageText: message,
    });
    logger.info(
      `Notice for ${tomorrow} sent to ${sentCount}/${subscribers.length} subscriber(s)` +
        `${removed.length ? `; removed ${removed.length} unreachable: ${removed.join(', ')}` : ''} ` +
        `(WFH: ${wfh}, API ${reading.api_value} at ${reading.datetime_local.slice(11, 16)}${usedFallback ? ' fallback' : ''}).`
    );
    return {
      status: 'sent',
      wfh,
      apiValue: reading.api_value,
      readingDatetime: reading.datetime_local,
      usedFallback,
      sentCount,
    };
  }

  return { runCheck };
}
