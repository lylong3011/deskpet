'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { ReminderScheduler, inQuietHours, parseHHMM } = require('../electron/scheduler');

const at = (h, m) => new Date(2026, 9, 19, h, m, 0);

test('parseHHMM 正常与异常输入', () => {
  assert.strictEqual(parseHHMM('09:30'), 570);
  assert.strictEqual(parseHHMM('23:59'), 1439);
  assert.strictEqual(parseHHMM('24:00'), null);
  assert.strictEqual(parseHHMM('9:30'), 570);
  assert.strictEqual(parseHHMM('abc'), null);
  assert.strictEqual(parseHHMM(''), null);
  assert.strictEqual(parseHHMM('12:70'), null);
});

test('静音时段：跨零点', () => {
  const range = { enabled: true, start: '23:00', end: '08:00' };
  assert.strictEqual(inQuietHours(range, at(23, 30)), true);
  assert.strictEqual(inQuietHours(range, at(2, 0)), true);
  assert.strictEqual(inQuietHours(range, at(7, 59)), true);
  assert.strictEqual(inQuietHours(range, at(8, 0)), false);
  assert.strictEqual(inQuietHours(range, at(12, 0)), false);
});

test('静音时段：同一天内', () => {
  const range = { enabled: true, start: '12:00', end: '14:00' };
  assert.strictEqual(inQuietHours(range, at(12, 0)), true);
  assert.strictEqual(inQuietHours(range, at(13, 59)), true);
  assert.strictEqual(inQuietHours(range, at(14, 0)), false);
  assert.strictEqual(inQuietHours(range, at(9, 0)), false);
});

test('静音时段：关闭时永远不生效', () => {
  const range = { enabled: false, start: '23:00', end: '08:00' };
  assert.strictEqual(inQuietHours(range, at(2, 0)), false);
});

test('静音时段：起止相同视为不启用', () => {
  const range = { enabled: true, start: '10:00', end: '10:00' };
  assert.strictEqual(inQuietHours(range, at(10, 0)), false);
});

test('首次调度落在配置区间内', () => {
  const s = new ReminderScheduler({
    rng: () => 0,
    nowMs: 0,
    reminders: { water: { enabled: true, min: 40, max: 70 }, meal: { enabled: false }, stretch: { enabled: false } },
  });
  const next = s.peek(0);
  assert.strictEqual(next.water, 40 * 60 * 1000, 'rng=0 时应取下界');
  assert.strictEqual(next.meal, Infinity, '禁用项不排期');
});

test('rng=0.999 时接近上界', () => {
  const s = new ReminderScheduler({
    rng: () => 0.999,
    nowMs: 0,
    reminders: { water: { enabled: true, min: 40, max: 70 }, meal: { enabled: false }, stretch: { enabled: false } },
  });
  const ms = s.peek(0).water;
  assert.ok(ms > 69 * 60 * 1000 && ms <= 70 * 60 * 1000, `实际 ${ms}`);
});

test('到期触发一次并重新排期', () => {
  const s = new ReminderScheduler({
    rng: () => 0,
    nowMs: 0,
    reminders: { water: { enabled: true, min: 40, max: 40 }, meal: { enabled: false }, stretch: { enabled: false } },
  });
  const due = 40 * 60 * 1000;
  assert.deepStrictEqual(s.poll(due - 1, {}), []);
  assert.deepStrictEqual(s.poll(due, {}), ['water']);
  assert.deepStrictEqual(s.poll(due + 1000, {}), [], '触发后不应重复连发');
  assert.deepStrictEqual(s.poll(due * 2, {}), ['water'], '下一轮应再次触发');
});

test('静音/勿扰/配额用尽时不触发，但仍然重排（不补偿轰炸）', () => {
  const s = new ReminderScheduler({
    rng: () => 0,
    nowMs: 0,
    reminders: { water: { enabled: true, min: 40, max: 40 }, meal: { enabled: false }, stretch: { enabled: false } },
  });
  const due = 40 * 60 * 1000;
  assert.deepStrictEqual(s.poll(due, { quiet: true }), []);
  assert.deepStrictEqual(s.poll(due + 60_000, { quiet: true }), [], '不应在静音解除前累积');
  assert.deepStrictEqual(s.poll(due + 120_000, { quotaLeft: 0 }), []);
  assert.deepStrictEqual(s.poll(due + 180_000, { paused: true }), []);
});

test('禁用某一类提醒后不再触发', () => {
  const s = new ReminderScheduler({
    rng: () => 0,
    nowMs: 0,
    reminders: { water: { enabled: true, min: 40, max: 40 }, meal: { enabled: false }, stretch: { enabled: false } },
  });
  s.updateConfig({
    water: { enabled: false, min: 40, max: 70 },
    meal: { enabled: false, min: 210, max: 300 },
    stretch: { enabled: false, min: 55, max: 105 },
  });
  assert.deepStrictEqual(s.poll(10 * 60 * 60 * 1000, {}), []);
});

test('max < min 时自动修正，不产生负数间隔', () => {
  const s = new ReminderScheduler({
    rng: () => 0.5,
    nowMs: 0,
    reminders: { water: { enabled: true, min: 90, max: 10 }, meal: { enabled: false }, stretch: { enabled: false } },
  });
  const ms = s.peek(0).water;
  assert.ok(ms > 0);
});

test('triggerNow 立即重置下一次时间', () => {
  const s = new ReminderScheduler({
    rng: () => 0.5,
    nowMs: 0,
    reminders: { water: { enabled: true, min: 60, max: 60 }, meal: { enabled: false }, stretch: { enabled: false } },
  });
  s.triggerNow('water', 1_000);
  assert.strictEqual(s.peek(1_000).water, 60 * 60 * 1000);
});
