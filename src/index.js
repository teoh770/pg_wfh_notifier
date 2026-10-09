import { loadConfig } from './config.js';
import { openDatabase } from './db.js';
import { fetchHourly } from './doeApi.js';
import { createTelegram, showChatIds } from './telegram.js';
import { createChecker } from './checker.js';
import { startJobs } from './scheduler.js';
import { logger } from './log.js';
import { localTimeInTz, minutesOfDay } from './tz.js';

const args = process.argv.slice(2);

async function main() {
  const config = loadConfig();

  if (args.includes('--chat-id')) {
    await showChatIds(config.telegram.botToken);
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

  const telegram = createTelegram(config.telegram);
  if (!telegram) logger.warn('Telegram not configured (botToken/chatId missing) — running in log-only mode.');
  const checker = createChecker({ config, db, fetchAndStore: pollOnce, telegram, logger });

  if (args.includes('--once')) {
    logger.info('--once mode: running a single poll + check cycle now.');
    await pollOnce();
    const result = await checker.runCheck();
    db.close();
    process.exit(result.status === 'no-data' || result.status === 'send-failed' ? 1 : 0);
  }

  logger.info(
    `WFH notifier started (${config.wfh.timezone}): poll cron "${config.api.pollCron}", daily check ${config.wfh.checkTime} ` +
      `(fallback ${config.wfh.fallbackTime}), threshold ${config.wfh.threshold}.`
  );
  await pollOnce();

  const nowMinutes = minutesOfDay(localTimeInTz(new Date(), config.wfh.timezone));
  if (nowMinutes >= minutesOfDay(config.wfh.checkTime)) {
    logger.info('Already past check time — running catch-up check.');
    await checker.runCheck();
  }

  const jobs = startJobs({ config, onPoll: pollOnce, onCheck: () => checker.runCheck() });
  const shutdown = (sig) => {
    logger.info(`Received ${sig}, shutting down.`);
    jobs.stopAll();
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
