import { readFileSync } from 'node:fs';
import cron from 'node-cron';

const DEFAULTS = {
  api: {
    url: 'https://eqms.doe.gov.my/api3/publicportalapims/apitablehourly?stateid=7&stationid=CA08P',
    pollCron: '0 5 * * * *',
    timeoutMs: 15000,
  },
  wfh: {
    checkTime: '21:00',
    fallbackTime: '20:00',
    retryMinutes: 30,
    retryIntervalMinutes: 10,
    threshold: 200,
    timezone: 'Asia/Kuala_Lumpur',
    weekendDays: [0, 6],
  },
  telegram: { botToken: '', chatId: '' },
  database: { path: 'data.sqlite' },
};

function deepMerge(base, override) {
  const out = { ...base };
  for (const [key, value] of Object.entries(override ?? {})) {
    out[key] =
      value && typeof value === 'object' && !Array.isArray(value)
        ? deepMerge(base?.[key] ?? {}, value)
        : value;
  }
  return out;
}

function normalizeTime(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim());
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h > 23 || m > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function loadConfig(path = process.env.CONFIG_PATH || 'config.json') {
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') {
      throw new Error(`Config file not found: ${path}. Copy config.example.json to config.json and edit it.`);
    }
    throw new Error(`Could not parse ${path}: ${e.message}`);
  }

  const cfg = deepMerge(DEFAULTS, raw);
  const errors = [];

  if (!/^https?:\/\//.test(cfg.api.url)) errors.push('api.url must be an http(s) URL');
  if (!cron.validate(cfg.api.pollCron)) errors.push(`api.pollCron "${cfg.api.pollCron}" is not a valid cron expression`);
  if (!Number.isInteger(cfg.api.timeoutMs) || cfg.api.timeoutMs <= 0) errors.push('api.timeoutMs must be a positive integer');

  const checkTime = normalizeTime(cfg.wfh.checkTime);
  const fallbackTime = normalizeTime(cfg.wfh.fallbackTime);
  if (!checkTime) errors.push('wfh.checkTime must be a 24h time like "21:00"');
  if (!fallbackTime) errors.push('wfh.fallbackTime must be a 24h time like "20:00"');
  if (checkTime && fallbackTime && checkTime <= fallbackTime) errors.push('wfh.checkTime must be later than wfh.fallbackTime');
  if (checkTime) cfg.wfh.checkTime = checkTime;
  if (fallbackTime) cfg.wfh.fallbackTime = fallbackTime;

  if (!Number.isFinite(cfg.wfh.threshold) || cfg.wfh.threshold <= 0) errors.push('wfh.threshold must be a number > 0');
  try {
    new Intl.DateTimeFormat('en', { timeZone: cfg.wfh.timezone });
  } catch {
    errors.push(`wfh.timezone "${cfg.wfh.timezone}" is not a valid IANA timezone`);
  }
  if (
    !Array.isArray(cfg.wfh.weekendDays) ||
    cfg.wfh.weekendDays.length === 0 ||
    cfg.wfh.weekendDays.some((d) => !Number.isInteger(d) || d < 0 || d > 6)
  ) {
    errors.push('wfh.weekendDays must be a non-empty array of integers 0-6 (0 = Sunday, 6 = Saturday)');
  }
  if (!Number.isInteger(cfg.wfh.retryMinutes) || cfg.wfh.retryMinutes < 0) errors.push('wfh.retryMinutes must be an integer >= 0');
  if (!Number.isInteger(cfg.wfh.retryIntervalMinutes) || cfg.wfh.retryIntervalMinutes < 1) {
    errors.push('wfh.retryIntervalMinutes must be an integer >= 1');
  }
  if (!cfg.database.path || typeof cfg.database.path !== 'string') errors.push('database.path must be a file path');

  if (errors.length) throw new Error(`Invalid configuration:\n  - ${errors.join('\n  - ')}`);

  cfg.telegram.botToken = String(cfg.telegram.botToken ?? '').trim();
  cfg.telegram.chatId = String(cfg.telegram.chatId ?? '').trim();
  if ((cfg.telegram.botToken === '') !== (cfg.telegram.chatId === '')) {
    console.warn('[WARN] Only one of telegram.botToken / telegram.chatId is set — Telegram notices disabled until both are set.');
    cfg.telegram.botToken = '';
    cfg.telegram.chatId = '';
  }
  return cfg;
}
