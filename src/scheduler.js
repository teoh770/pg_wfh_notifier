import cron from 'node-cron';
import { logger } from './log.js';

export function startJobs({ config, onPoll, onCheck }) {
  const { timezone } = config.wfh;
  const [hour, minute] = config.wfh.checkTime.split(':').map(Number);

  const tasks = [
    cron.schedule(config.api.pollCron, () => {
      onPoll();
    }, { timezone }),
    cron.schedule(`${minute} ${hour} * * *`, () => {
      onCheck().catch((e) => logger.error(`Check job failed: ${e.message}`));
    }, { timezone }),
  ];

  logger.info(
    `Scheduler started (${timezone}): poll "${config.api.pollCron}", daily check at ${config.wfh.checkTime}.`
  );

  return { stopAll: () => tasks.forEach((t) => t.stop()) };
}
