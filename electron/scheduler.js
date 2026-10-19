'use strict';
/**
 * 提醒调度：随机区间 + 静音时段 + 每日配额。纯逻辑，可注入时间与随机源。
 */

function parseHHMM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

/** 判断当前是否处于静音时段，支持跨零点（如 23:00 - 08:00） */
function inQuietHours(range, date = new Date()) {
  if (!range || !range.enabled) return false;
  const start = parseHHMM(range.start);
  const end = parseHHMM(range.end);
  if (start === null || end === null) return false;
  if (start === end) return false;
  const now = date.getHours() * 60 + date.getMinutes();
  return start < end ? now >= start && now < end : now >= start || now < end;
}

const KINDS = ['water', 'meal', 'stretch'];

class ReminderScheduler {
  constructor(opts = {}) {
    this.rng = opts.rng || Math.random;
    this.reminders = opts.reminders || {
      water: { enabled: true, min: 40, max: 70 },
      meal: { enabled: true, min: 210, max: 300 },
      stretch: { enabled: true, min: 55, max: 105 },
    };
    this.nextAt = {};
    const now = opts.nowMs ?? Date.now();
    for (const kind of KINDS) this._schedule(kind, now);
  }

  _range(kind) {
    const cfg = this.reminders[kind] || {};
    let min = Number(cfg.min);
    let max = Number(cfg.max);
    if (!Number.isFinite(min) || min <= 0) min = 45;
    if (!Number.isFinite(max) || max < min) max = min + 10;
    return [min, max];
  }

  _schedule(kind, nowMs) {
    const cfg = this.reminders[kind] || {};
    if (!cfg.enabled) {
      this.nextAt[kind] = Infinity;
      return;
    }
    const [min, max] = this._range(kind);
    const minutes = min + this.rng() * (max - min);
    this.nextAt[kind] = nowMs + Math.round(minutes * 60 * 1000);
  }

  updateConfig(reminders, nowMs = Date.now()) {
    this.reminders = reminders || this.reminders;
    for (const kind of KINDS) this._schedule(kind, nowMs);
  }

  /** 距离下一次提醒的毫秒数（用于调试/展示） */
  peek(nowMs = Date.now()) {
    const out = {};
    for (const kind of KINDS) out[kind] = Math.max(0, (this.nextAt[kind] || Infinity) - nowMs);
    return out;
  }

  /**
   * @param {number} nowMs
   * @param {{quiet:boolean, dnd:boolean, quotaLeft:number, paused:boolean}} ctx
   * @returns {string[]} 本次触发的提醒类型
   */
  poll(nowMs, ctx = {}) {
    const fired = [];
    for (const kind of KINDS) {
      const due = this.nextAt[kind];
      if (!Number.isFinite(due) || nowMs < due) continue;
      const blocked = ctx.paused || ctx.quiet || ctx.dnd || (ctx.quotaLeft ?? 1) <= 0;
      this._schedule(kind, nowMs); // 无论是否发出都重排，避免解除静音时连环轰炸
      if (!blocked) fired.push(kind);
    }
    return fired;
  }

  /** 手动立刻触发一次（设置页“试一下”按钮） */
  triggerNow(kind, nowMs = Date.now()) {
    this._schedule(kind, nowMs);
    return kind;
  }
}

module.exports = { ReminderScheduler, inQuietHours, parseHHMM, KINDS };
