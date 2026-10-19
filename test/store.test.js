'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store, mergeDeep, getIn, setIn } = require('../electron/store');

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpet-test-'));
  return path.join(dir, 'state.json');
}

const fakeSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(`enc:${s}`, 'utf8'),
  decryptString: (b) => b.toString('utf8').replace(/^enc:/, ''),
};

test('mergeDeep 深度合并并保留默认值', () => {
  const merged = mergeDeep({ a: 1, b: { c: 2, d: 3 } }, { b: { c: 9 } });
  assert.strictEqual(merged.a, 1);
  assert.strictEqual(merged.b.c, 9);
  assert.strictEqual(merged.b.d, 3, '未覆盖的字段应保留');
});

test('getIn / setIn 点路径', () => {
  const o = { a: { b: { c: 1 } } };
  assert.strictEqual(getIn(o, 'a.b.c'), 1);
  assert.strictEqual(getIn(o, 'a.x.y'), undefined);
  setIn(o, 'a.b.d', 2);
  assert.strictEqual(o.a.b.d, 2);
  setIn(o, 'x.y.z', 5);
  assert.strictEqual(o.x.y.z, 5);
});

test('默认值可用，缺文件不报错', () => {
  const s = new Store(tmpFile(), {});
  assert.strictEqual(s.get('settings.maxRemindersPerDay'), 10);
  assert.strictEqual(s.get('character.builtin'), 'momo');
  assert.strictEqual(s.get('不存在的键', 'fallback'), 'fallback');
});

test('写入后重新加载能持久化', () => {
  const file = tmpFile();
  const s1 = new Store(file, {});
  s1.set('settings.scale', 1.3);
  s1.patch({ pet: { level: 4 } });
  const s2 = new Store(file, {});
  assert.strictEqual(s2.get('settings.scale'), 1.3);
  assert.strictEqual(s2.get('pet.level'), 4);
});

test('损坏的 JSON 自动回退默认值，不崩溃', () => {
  const file = tmpFile();
  fs.writeFileSync(file, '{ this is not json', 'utf8');
  const s = new Store(file, {});
  assert.strictEqual(s.get('settings.maxRemindersPerDay'), 10);
});

test('API Key 使用 safeStorage 加密存储', () => {
  const file = tmpFile();
  const s = new Store(file, { safeStorage: fakeSafeStorage });
  s.setApiKey('sk-test-123456');
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(!raw.includes('sk-test-123456'), '明文不应落盘');
  assert.strictEqual(s.getApiKey(), 'sk-test-123456');
  assert.strictEqual(s.hasApiKey(), true);
});

test('无加密能力时降级为明文并可读回', () => {
  const file = tmpFile();
  const s = new Store(file, { safeStorage: { isEncryptionAvailable: () => false } });
  s.setApiKey('sk-plain-999');
  assert.strictEqual(s.getApiKey(), 'sk-plain-999');
});

test('设置空 Key 会清空配置', () => {
  const s = new Store(tmpFile(), { safeStorage: fakeSafeStorage });
  s.setApiKey('sk-abc');
  s.setApiKey('');
  assert.strictEqual(s.hasApiKey(), false);
  assert.strictEqual(s.getApiKey(), '');
});

test('sanitize 不泄露密钥，只给尾号和是否已配置', () => {
  const s = new Store(tmpFile(), { safeStorage: fakeSafeStorage });
  s.setApiKey('sk-secret-abcd');
  const safe = s.sanitize();
  const json = JSON.stringify(safe);
  assert.ok(!json.includes('sk-secret-abcd'), 'sanitize 结果不得含明文');
  assert.ok(!json.includes('enc:'), 'sanitize 结果不得含密文');
  assert.strictEqual(safe.settings.provider.hasApiKey, true);
  assert.strictEqual(safe.settings.provider.apiKeyTail, 'abcd');
});

test('sanitize 返回的是副本，改动不影响原数据', () => {
  const s = new Store(tmpFile(), {});
  const safe = s.sanitize();
  safe.settings.scale = 99;
  assert.notStrictEqual(s.get('settings.scale'), 99);
});

test('提醒配置的区间可正常读写', () => {
  const s = new Store(tmpFile(), {});
  s.patch({ settings: { reminders: { water: { min: 20, max: 30 } } } });
  assert.strictEqual(s.get('settings.reminders.water.min'), 20);
  assert.strictEqual(s.get('settings.reminders.water.max'), 30);
  assert.strictEqual(s.get('settings.reminders.water.enabled'), true, '未指定字段应保留默认');
});
