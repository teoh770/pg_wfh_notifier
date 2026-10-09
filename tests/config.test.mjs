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

test('allowedUserIds are coerced to strings', () => {
  withTempConfig({ telegram: { allowedUserIds: [123, '456'] } }, (path) => {
    const cfg = loadConfig(path);
    assert.deepEqual(cfg.telegram.allowedUserIds, ['123', '456']);
  });
});

test('allowedUserIds must be an array', () => {
  withTempConfig({ telegram: { allowedUserIds: 'nope' } }, (path) => {
    assert.throws(() => loadConfig(path), /allowedUserIds/);
  });
});

test('allowedUsernames are normalized (@ stripped, lowercased, empties dropped)', () => {
  withTempConfig({ telegram: { allowedUsernames: ['@Teo', 'Colleague', '  ', 42] } }, (path) => {
    const cfg = loadConfig(path);
    assert.deepEqual(cfg.telegram.allowedUsernames, ['teo', 'colleague', '42']);
  });
});

test('allowedUsernames must be an array', () => {
  withTempConfig({ telegram: { allowedUsernames: 'nope' } }, (path) => {
    assert.throws(() => loadConfig(path), /allowedUsernames/);
  });
});

test('adminUserIds are coerced to strings and must be an array', () => {
  withTempConfig({ telegram: { adminUserIds: [123] } }, (path) => {
    assert.deepEqual(loadConfig(path).telegram.adminUserIds, ['123']);
  });
  withTempConfig({ telegram: { adminUserIds: 'nope' } }, (path) => {
    assert.throws(() => loadConfig(path), /adminUserIds/);
  });
});

test('welcomeMessage must be a string when present', () => {
  withTempConfig({ telegram: { welcomeMessage: 123 } }, (path) => {
    assert.throws(() => loadConfig(path), /welcomeMessage/);
  });
});

test('welcomeMessage defaults to empty string', () => {
  withTempConfig({}, (path) => {
    const cfg = loadConfig(path);
    assert.equal(cfg.telegram.welcomeMessage, '');
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
