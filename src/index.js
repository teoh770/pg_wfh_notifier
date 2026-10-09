import { loadConfig } from './config.js';
import { openDatabase } from './db.js';
import { fetchHourly } from './doeApi.js';
import { createTelegram } from './telegram.js';
import { buildMessage, createChecker } from './checker.js';
import { startJobs } from './scheduler.js';
import { startBotPolling, welcomeText, buildStatusText, buildTrendText, buildAllowlistReview } from './bot.js';
import { logger } from './log.js';
import { addDays, localDateInTz, localTimeInTz, minutesOfDay } from './tz.js';

const args = process.argv.slice(2);

async function main() {
  const config = loadConfig();

  if (args.includes('--allowlist')) {
    const db = openDatabase(config.database.path);
    console.log(buildAllowlistReview(config, db, db.listSubscribers()));
    db.close();
    return;
  }

  if (args.includes('--subs')) {
    const db = openDatabase(config.database.path);
    const subs = db.listSubscribers();
    if (!subs.length) {
      console.log('No subscribers yet. Allowlisted users can /subscribe via the bot.');
    } else {
      console.log(`Subscribers (${subs.length}):`);
      for (const s of subs) {
        console.log(`  chat_id: ${s.chat_id}  (${s.type}${s.name ? `, ${s.name}` : ''}, user ${s.user_id ?? '?'}, since ${s.subscribed_at})`);
      }
    }
    db.close();
    return;
  }

  const db = openDatabase(config.database.path);

  async function pollOnce() {
    try {
      const rows = await fetchHourly(config.api.url, config.api.timeoutMs);
      if (!rows.length) {
        logger.error('API returned no rows — nothing stored.');
        return;
      }
      db.upsertReadings(rows, new Date().toISOString());
      logger.info(`Poll OK: ${rows.length} readings stored/updated (latest ${rows[0].datetimeLocal}).`);
    } catch (e) {
      logger.error(`Poll failed: ${e.message}`);
    }
  }

  const telegram = createTelegram({ botToken: config.telegram.botToken });
  if (!telegram) logger.warn('Telegram not configured (botToken missing) — running in log-only mode.');
  const checker = createChecker({ config, db, fetchAndStore: pollOnce, telegram, logger });

  if (args.includes('--send-test')) {
    const type = args[args.indexOf('--send-test') + 1];
    const types = ['wfh', 'wfo', 'welcome', 'status', 'trend'];
    if (!types.includes(type)) {
      logger.error(`Unknown message type "${type ?? ''}". Use one of: ${types.join(', ')}`);
      db.close();
      process.exit(1);
    }
    if (!telegram) {
      logger.error('Telegram not configured (botToken missing) — cannot send test message.');
      db.close();
      process.exit(1);
    }
    await pollOnce();
    let text;
    if (type === 'wfh' || type === 'wfo') {
      const reading = db.getRecentReadings(1)[0];
      if (!reading) {
        logger.error('No readings available to build a notice.');
        db.close();
        process.exit(1);
      }
      const tomorrow = addDays(localDateInTz(new Date(), config.wfh.timezone), 1);
      text = buildMessage({ tomorrow, reading, wfh: type === 'wfh' });
    } else if (type === 'welcome') {
      text = welcomeText(config, 'Test');
    } else if (type === 'status') {
      text = buildStatusText(config, db, true);
    } else {
      text = buildTrendText(db);
    }
    const full = `🧪 TEST MESSAGE — please ignore\n\n${text}`;
    const subscribers = db.listSubscribers();
    if (!subscribers.length) {
      logger.warn(`No subscribers — printing the "${type}" message instead of sending:\n${full}`);
      db.close();
      return;
    }
    let ok = 0;
    for (const s of subscribers) {
      const r = await telegram.sendMessage(s.chat_id, full);
      if (r.ok) ok++;
    }
    logger.info(`Test "${type}" message sent to ${ok}/${subscribers.length} subscriber(s).`);
    db.close();
    process.exit(ok > 0 ? 0 : 1);
  }

  if (args.includes('--once')) {
    logger.info('--once mode: running a single poll + check cycle now.');
    await pollOnce();
    const result = await checker.runCheck();
    db.close();
    process.exit(result.status === 'no-data' || result.status === 'send-failed' ? 1 : 0);
  }

  logger.info(
    `WFH notifier started (${config.wfh.timezone}): poll cron "${config.api.pollCron}", daily check ${config.wfh.checkTime} ` +
      `(fallback ${config.wfh.fallbackTime}), threshold ${config.wfh.threshold}, ${db.countSubscribers()} subscriber(s).`
  );
  await pollOnce();

  const nowMinutes = minutesOfDay(localTimeInTz(new Date(), config.wfh.timezone));
  if (nowMinutes >= minutesOfDay(config.wfh.checkTime)) {
    logger.info('Already past check time — running catch-up check.');
    await checker.runCheck();
  }

  const bot = telegram ? startBotPolling({ telegram, db, config }) : null;
  const jobs = startJobs({ config, onPoll: pollOnce, onCheck: () => checker.runCheck() });
  const shutdown = (sig) => {
    logger.info(`Received ${sig}, shutting down.`);
    jobs.stopAll();
    bot?.stop();
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((e) => {
  logger.error(`Fatal: ${e.message}`);
  process.exit(1);
});
