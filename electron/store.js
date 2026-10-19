'use strict';
/**
 * 极简 JSON 存储：支持点路径读写、原子落盘、API Key 加密（Electron safeStorage）。
 * 纯 Node 实现，可被单元测试直接加载。
 */
const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = {
  version: 1,
  onboarded: false,
  character: { id: null, name: '小八', file: null, builtin: 'momo' },
  settings: {
    scale: 1,
    alwaysOnTop: true,
    quietHours: { enabled: true, start: '23:00', end: '08:00' },
    reminders: {
      water: { enabled: true, min: 40, max: 70 },
      meal: { enabled: true, min: 210, max: 300 },
      stretch: { enabled: true, min: 55, max: 105 },
    },
    maxRemindersPerDay: 10,
    sound: true,
    systemNotify: false,
    dndManual: false,
    persona: '',
    autostart: false,
    aiChat: false,
    proactive: true,
    provider: {
      id: 'ark',
      apiKey: '',
      apiKeyEnc: '',
      keyEncrypted: false,
      baseUrl: '',
      model: '',
      imageSize: '1024x1024',
    },
    chatModel: '',
  },
  pet: {
    drives: { thirst: 24, hunger: 30, energy: 82, boredom: 16, affection: 55 },
    level: 1,
    exp: 0,
    lastInteractionAt: 0,
    lastWaterAt: 0,
    lastMealAt: 0,
  },
  stats: { day: '', remindersToday: 0, interactionsToday: 0, totalInteractions: 0 },
  chat: [],
};

function deepClone(o) {
  return JSON.parse(JSON.stringify(o));
}

function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function mergeDeep(base, patch) {
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch === undefined ? base : patch;
  const out = deepClone(base);
  for (const [k, v] of Object.entries(patch)) {
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? mergeDeep(out[k], v) : v;
  }
  return out;
}

function getIn(obj, keyPath) {
  if (!keyPath) return obj;
  return String(keyPath)
    .split('.')
    .reduce((acc, k) => (acc === undefined || acc === null ? undefined : acc[k]), obj);
}

function setIn(obj, keyPath, val) {
  const keys = String(keyPath).split('.');
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!isPlainObject(cur[keys[i]])) cur[keys[i]] = {};
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = val;
}

class Store {
  constructor(file, opts = {}) {
    this.file = file;
    this.safeStorage = opts.safeStorage || null;
    this.data = deepClone(DEFAULTS);
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data = mergeDeep(deepClone(DEFAULTS), raw);
    } catch {
      this.data = deepClone(DEFAULTS);
    }
    return this.data;
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
  }

  get(keyPath, fallback) {
    const v = getIn(this.data, keyPath);
    return v === undefined ? fallback : v;
  }

  set(keyPath, val) {
    setIn(this.data, keyPath, val);
    this.save();
    return val;
  }

  patch(obj) {
    this.data = mergeDeep(this.data, obj);
    this.save();
  }

  setApiKey(key) {
    const p = this.data.settings.provider;
    const value = String(key || '').trim();
    if (!value) {
      p.apiKey = '';
      p.apiKeyEnc = '';
      p.keyEncrypted = false;
      this.save();
      return;
    }
    if (this.safeStorage && this.safeStorage.isEncryptionAvailable()) {
      p.apiKeyEnc = this.safeStorage.encryptString(value).toString('base64');
      p.apiKey = '';
      p.keyEncrypted = true;
    } else {
      p.apiKey = value;
      p.apiKeyEnc = '';
      p.keyEncrypted = false;
    }
    this.save();
  }

  getApiKey() {
    const p = this.data.settings.provider;
    if (p.apiKeyEnc) {
      try {
        return this.safeStorage.decryptString(Buffer.from(p.apiKeyEnc, 'base64'));
      } catch {
        return '';
      }
    }
    return p.apiKey || '';
  }

  hasApiKey() {
    return this.getApiKey().length > 0;
  }

  /** 发给渲染进程的安全副本：不含密文与明文密钥 */
  sanitize() {
    const d = deepClone(this.data);
    const key = this.getApiKey();
    d.settings.provider.apiKey = '';
    delete d.settings.provider.apiKeyEnc;
    d.settings.provider.hasApiKey = key.length > 0;
    d.settings.provider.apiKeyTail = key ? key.slice(-4) : '';
    return d;
  }
}

module.exports = { Store, DEFAULTS, mergeDeep, getIn, setIn, deepClone };
