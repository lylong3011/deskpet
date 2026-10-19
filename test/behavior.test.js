'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { BehaviorEngine, clamp } = require('../electron/behavior');

const rng = () => 0.5; // 固定随机源，保证可重复
const makeEngine = (drives, cfg) => new BehaviorEngine({ drives, rng, cfg });
const ctx = (over = {}) => ({ idleSec: 0, quiet: false, dnd: false, nowMs: 1_000_000, quotaLeft: 10, ...over });

test('驱动值随时间变化：口渴/饥饿上升，好感下降', () => {
  const e = makeEngine({ thirst: 20, hunger: 20, energy: 90, boredom: 20, affection: 80 });
  e.tick(600, ctx()); // 10 分钟
  assert.ok(e.drives.thirst > 20, '口渴应上升');
  assert.ok(e.drives.hunger > 20, '饥饿应上升');
  assert.ok(e.drives.affection < 80, '好感应下降');
  assert.ok(e.drives.energy < 90, '精力应下降');
});

test('驱动值始终被限制在 0-100', () => {
  const e = makeEngine({ thirst: 99, hunger: 99, energy: 99, boredom: 99, affection: 1 });
  for (let i = 0; i < 200; i++) e.tick(60, ctx());
  for (const v of Object.values(e.drives)) {
    assert.ok(v >= 0 && v <= 100, `越界: ${v}`);
  }
});

test('精力过低必定进入睡眠', () => {
  const e = makeEngine({ energy: 10, thirst: 10, hunger: 10, boredom: 10, affection: 80 });
  const d = e.tick(1, ctx());
  assert.strictEqual(d.act, 'sleep');
  assert.strictEqual(e.state, 'sleep');
});

test('睡眠会恢复精力并自动醒来', () => {
  const e = makeEngine({ energy: 8, thirst: 10, hunger: 10, boredom: 10, affection: 80 });
  e.tick(1, ctx());
  assert.strictEqual(e.state, 'sleep');
  let woke = false;
  for (let i = 0; i < 40; i++) {
    const d = e.tick(120, ctx({ nowMs: 1_000_000 + i * 120_000 }));
    if (d.act === 'wake') {
      woke = true;
      break;
    }
  }
  assert.ok(woke, '应自动醒来');
  assert.ok(e.drives.energy > 60, '精力应显著恢复');
});

test('静音时段不主动讨要情绪价值', () => {
  const e = makeEngine({ affection: 0, boredom: 5, energy: 90, thirst: 10, hunger: 10 }, { askPettingWarmupSec: 0 });
  const d = e.tick(1, ctx({ quiet: true }));
  assert.notStrictEqual(d.act, 'askPetting');
});

test('非静音且好感很低时会讨要陪伴', () => {
  const e = makeEngine({ affection: 0, boredom: 5, energy: 90, thirst: 10, hunger: 10 }, { askPettingWarmupSec: 0 });
  const d = e.tick(1, ctx());
  assert.strictEqual(d.act, 'askPetting');
});

test('刚启动的暖场期内不讨要陪伴', () => {
  const e = makeEngine({ affection: 0, boredom: 5, energy: 90, thirst: 10, hunger: 10 });
  const d = e.tick(1, ctx());
  assert.notStrictEqual(d.act, 'askPetting', '一上线就要抱抱会显得很吵');
});

test('暖场期结束后才允许讨要陪伴', () => {
  const e = makeEngine({ affection: 0, boredom: 5, energy: 90, thirst: 10, hunger: 10 });
  const acts = [];
  for (let i = 0; i < 40; i++) {
    acts.push(e.tick(5, ctx({ nowMs: 1_000_000 + i * 5000 })).act);
  }
  assert.ok(acts.includes('askPetting'), `40 次 tick 内应至少请求一次陪伴，实际: ${acts.join(',')}`);
});

test('好感高时不主动索要陪伴', () => {
  const e = makeEngine({ affection: 80, boredom: 5, energy: 90, thirst: 10, hunger: 10 }, { askPettingWarmupSec: 0 });
  const d = e.tick(1, ctx());
  assert.notStrictEqual(d.act, 'askPetting');
});

test('勿扰模式下不会乱跑或玩耍', () => {
  const e = makeEngine({ boredom: 95, affection: 40, energy: 90, thirst: 10, hunger: 10 });
  const d = e.tick(1, ctx({ idleSec: 2000, dnd: true }));
  assert.notStrictEqual(d.act, 'wander');
  assert.notStrictEqual(d.act, 'play');
});

test('用户正在操作时不溜达', () => {
  const e = makeEngine({ boredom: 95, affection: 40, energy: 90, thirst: 10, hunger: 10 });
  const d = e.tick(1, ctx({ idleSec: 10 }));
  assert.notStrictEqual(d.act, 'wander');
});

test('长时间无人时会自己找乐子', () => {
  const e = makeEngine({ boredom: 95, affection: 20, energy: 90, thirst: 10, hunger: 10 });
  const d = e.tick(1, ctx({ idleSec: 1200 }));
  assert.ok(['play', 'wander', 'sulk'].includes(d.act), `实际动作: ${d.act}`);
});

test('同类动作有冷却，不会连续重复', () => {
  const e = makeEngine({ boredom: 95, affection: 20, energy: 90, thirst: 10, hunger: 10 });
  const first = e.tick(1, ctx({ idleSec: 1200, nowMs: 5_000_000 }));
  const second = e.tick(1, ctx({ idleSec: 1200, nowMs: 5_001_000 }));
  assert.ok(first.act);
  assert.notStrictEqual(second.act, first.act, '短时间内不应重复同一动作');
});

test('互动加经验并升级', () => {
  const e = makeEngine({ affection: 40, boredom: 60, energy: 60, thirst: 60, hunger: 60 });
  const r1 = e.interact('play');
  assert.strictEqual(r1.ok, true);
  assert.ok(r1.gainedExp > 0);
  assert.ok(e.drives.boredom < 60, '玩耍应降低无聊');
  let leveled = false;
  for (let i = 0; i < 10; i++) {
    const r = e.interact('play');
    if (r.leveledUp) leveled = true;
  }
  assert.ok(leveled, '累计经验后应升级');
  assert.ok(e.level > 1);
});

test('未知互动类型被忽略', () => {
  const e = makeEngine({});
  const r = e.interact('dance');
  assert.strictEqual(r.ok, false);
});

test('心情随驱动值变化', () => {
  const sleepy = makeEngine({ energy: 10 });
  assert.strictEqual(sleepy.mood(), 'sleepy');
  const sad = makeEngine({ energy: 80, affection: 10 });
  assert.strictEqual(sad.mood(), 'sad');
  const happy = makeEngine({ energy: 80, affection: 90, boredom: 10 });
  assert.strictEqual(happy.mood(), 'happy');
});

test('clamp 边界', () => {
  assert.strictEqual(clamp(-5), 0);
  assert.strictEqual(clamp(150), 100);
  assert.strictEqual(clamp(50), 50);
});

test('关闭主动互动后不再主动讨陪伴或闹脾气', () => {
  // 好感低 + 长时间没人理：这是最容易触发 askPetting / sulk 的条件
  const e = makeEngine({ affection: 10, boredom: 90, energy: 80, thirst: 10, hunger: 10 });
  const offline = { proactive: false };
  for (let i = 0; i < 40; i++) e.awakeSec += 10;
  for (let i = 0; i < 60; i++) {
    const d = e.tick(10, ctx({ idleSec: 3600, ...offline }));
    assert.notStrictEqual(d.act, 'askPetting', '关闭主动后不应主动讨陪伴');
    assert.notStrictEqual(d.act, 'sulk', '关闭主动后不应闹脾气');
  }
});

test('开启主动互动时仍会主动讨陪伴', () => {
  const e = makeEngine({ affection: 5, boredom: 80, energy: 80, thirst: 10, hunger: 10 });
  e.awakeSec = 9999;
  let asked = false;
  for (let i = 0; i < 80 && !asked; i++) {
    const d = e.tick(10, ctx({ idleSec: 3600, proactive: true }));
    if (d.act === 'askPetting') asked = true;
  }
  assert.ok(asked, '开启主动后应能主动讨陪伴');
});
