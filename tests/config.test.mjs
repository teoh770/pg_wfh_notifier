import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';

function withTempConfig(obj, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'wfh-cfg-'));
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify(obj));
  try {
    return fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('defaults are applied when config is minimal', () => {
  withTempConfig({}, (path) => {
    const cfg = loadConfig(path);
    assert.equal(cfg.wfh.checkTime, '21:00');
    assert.equal(cfg.wfh.fallbackTime, '20:00');
    assert.equal(cfg.wfh.threshold, 200);
    assert.equal(cfg.wfh.timezone, 'Asia/Kuala_Lumpur');
    assert.deepEqual(cfg.wfh.weekendDays, [0, 6]);
    assert.ok(/^https?:\/\//.test(cfg.api.url));
  });
});

test('times are normalized to zero-padded HH:MM', () => {
  withTempConfig({ wfh: { checkTime: '9:05', fallbackTime: '8:00' } }, (path) => {
    const cfg = loadConfig(path);
    assert.equal(cfg.wfh.checkTime, '09:05');
    assert.equal(cfg.wfh.fallbackTime, '08:00');
  });
});

test('partial telegram config is kept (needed by --chat-id), not wiped', () => {
  withTempConfig({ telegram: { botToken: 'abc' } }, (path) => {
    const cfg = loadConfig(path);
    assert.equal(cfg.telegram.botToken, 'abc');
    assert.equal(cfg.telegram.chatId, '');
  });
});

test('invalid values are rejected with all errors listed', () => {
  withTempConfig({ wfh: { checkTime: '25:99', fallbackTime: '22:00', threshold: -1, weekendDays: [] } }, (path) => {
    assert.throws(() => loadConfig(path), /checkTime|threshold|weekendDays/);
  });
});

test('checkTime must be later than fallbackTime', () => {
  withTempConfig({ wfh: { checkTime: '20:00', fallbackTime: '21:00' } }, (path) => {
    assert.throws(() => loadConfig(path), /later than/);
  });
});
