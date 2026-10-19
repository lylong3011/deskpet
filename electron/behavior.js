'use strict';
/**
 * 行为引擎：驱动值 + 效用函数 + 冷却闸门。
 * 纯逻辑，无 Electron 依赖，便于单元测试。
 */

const clamp = (v, a = 0, b = 100) => Math.max(a, Math.min(b, v));

const CONFIG = {
  // 每分钟变化量（静态均值，实际叠加随机抖动）
  decayPerMin: {
    thirst: 1.05,
    hunger: 0.5,
    energy: 0.42,
    boredom: 0.95,
    affection: 0.16,
  },
  jitter: 0.35, // ±35% 抖动，让提醒间隔看起来随机
  threshold: {
    sleep: 18,
    sleepy: 34,
    bored: 50,
    veryBored: 72,
    lonelyStartSec: 480, // 8 分钟无输入开始孤单
  },
  cooldownMs: {
    wander: 50 * 1000,
    play: 200 * 1000,
    askPetting: 210 * 1000,
    sleep: 60 * 1000,
  },
  idleGuardSec: 75, // 用户正在操作时不主动溜达
  askPettingWarmupSec: 120, // 启动后先安静两分钟，别一上线就要抱抱
  askPettingMaxAffection: 45, // 好感还够高时不主动索取
  minScore: 26,
};

/** 台词库：按场景分池，避免复读 */
const LINES = {
  greet: ['我来啦～今天也一起加油吧！', '你好呀，我叫{tame}，请多指教！', '诶嘿，终于见到你了。'],
  water: ['该喝水啦，杯子已经空很久了哦。', '喂——喝口水吧，你的嘴唇都干了。', '补水时间到！我先干为敬（假装）'],
  meal: ['饭点到了，别又拿零食糊弄自己。', '我闻到饭香了…你也该吃了吧？', '吃饭！吃饭！吃饭！（敲碗）'],
  stretch: ['起来走两步吧，你已经坐很久了。', '伸个懒腰～肩膀是不是僵了？', '站起来晃一晃，我陪你。'],
  askPetting: ['陪我一会儿嘛…就一小会儿。', '你在忙什么呀，都不看我一眼。', '摸摸头好不好？我今天很乖。'],
  pet: ['嘿嘿…再来一次。', '唔…好舒服。', '你手好暖。'],
  feed: ['好吃！你也别饿着。', '谢谢投喂，我会长胖的啦。', '这个味道…满分！'],
  drink: ['咕咚咕咚——爽！', '你也喝一口嘛。', '水是最好的饮料，真的。'],
  play: ['来玩球！接住！', '哇——好玩！', '再玩一次好不好？'],
  lonely: ['……', '人呢？', '（望着屏幕发呆）', '算了，我自己玩会儿。'],
  sulk: ['哼，不理你了。', '……（背过身）', '我要生气了哦。'],
  sleep: ['困了…先眯一会儿。', 'Zzz…'],
  wake: ['唔…我醒了。', '睡得好好…你还在啊。'],
  idle: ['今天天气怎么样？', '（小声哼歌）', '戳我干嘛～', '我在看着你哦。'],
  chatFallback: ['嗯嗯，我在听。', '这个我不太懂，但你继续说。', '有你在真好。'],
  levelUp: ['我升级啦！感觉力气变大了！', '又长大一点点～'],
};

function pick(rng, arr) {
  if (!arr || arr.length === 0) return '';
  return arr[Math.floor(rng() * arr.length)];
}

class BehaviorEngine {
  constructor(opts = {}) {
    this.rng = opts.rng || Math.random;
    this.cfg = { ...CONFIG, ...(opts.cfg || {}) };
    this.drives = { thirst: 24, hunger: 30, energy: 82, boredom: 16, affection: 55, ...(opts.drives || {}) };
    this.state = 'awake'; // awake | sleep
    this.sleepElapsed = 0;
    this.sleepTarget = 0;
    this.awakeSec = 0;
    this.lonelySince = 0;
    this.cooldown = {};
    this.level = opts.level || 1;
    this.exp = opts.exp || 0;
  }

  get cooldownCfg() {
    return this.cfg.cooldownMs;
  }

  _jitter(base) {
    return base * (1 + (this.rng() * 2 - 1) * this.cfg.jitter);
  }

  _decay(dtSec, ctx) {
    const d = this.cfg.decayPerMin;
    const minutes = dtSec / 60;
    const active = ctx.idleSec < 60;

    this.drives.thirst = clamp(this.drives.thirst + this._jitter(d.thirst) * minutes);
    this.drives.hunger = clamp(this.drives.hunger + this._jitter(d.hunger) * minutes);
    this.drives.boredom = clamp(
      this.drives.boredom + this._jitter(d.boredom) * minutes * (active ? 0.7 : 1.25)
    );
    this.drives.affection = clamp(this.drives.affection - this._jitter(d.affection) * minutes);

    if (this.state === 'sleep') {
      this.drives.energy = clamp(this.drives.energy + 4.0 * minutes);
      this.drives.boredom = clamp(this.drives.boredom - 0.4 * minutes);
    } else {
      this.drives.energy = clamp(this.drives.energy - this._jitter(d.energy) * minutes * (active ? 1.2 : 0.7));
    }
  }

  _ready(act, nowMs) {
    const until = this.cooldown[act] || 0;
    return nowMs >= until;
  }

  _mark(act, nowMs) {
    const cd = this.cfg.cooldownMs[act] || 0;
    this.cooldown[act] = nowMs + cd;
  }

  _candidates(ctx) {
    const { energy, boredom, affection } = this.drives;
    const list = [];

    // 睡觉：精力极低必睡；略困则看情况
    if (energy <= this.cfg.threshold.sleep) list.push({ act: 'sleep', score: 100 });
    else if (energy <= this.cfg.threshold.sleepy) list.push({ act: 'sleep', score: 46 });

    if (boredom >= this.cfg.threshold.veryBored) list.push({ act: 'play', score: 68 + (boredom - this.cfg.threshold.veryBored) * 0.6 });
    if (boredom >= this.cfg.threshold.bored) list.push({ act: 'wander', score: 40 + (boredom - this.cfg.threshold.bored) * 0.5 });

    const lonely = ctx.idleSec >= this.cfg.threshold.lonelyStartSec;
    if (affection < this.cfg.askPettingMaxAffection) {
      list.push({ act: 'askPetting', score: (100 - affection) * 0.62 + (lonely ? 14 : 0) });
    }
    if (lonely && boredom >= this.cfg.threshold.bored) list.push({ act: 'sulk', score: 52 + (boredom - 40) * 0.3 });

    list.push({ act: 'idle', score: 24 });
    return list;
  }

  _allowed(c, ctx) {
    const { act } = c;
    if (!this._ready(act, ctx.nowMs)) return false;

    // 主动互动被关掉后，不再主动讨陪伴/闹脾气，只保留自我娱乐
    if (ctx.proactive === false && (act === 'askPetting' || act === 'sulk')) return false;
    // 陪伴请求：夜间静音时段与高打扰抑制时不打扰
    if (act === 'askPetting' && ctx.quiet) return false;
    if (act === 'askPetting' && ctx.dnd) return false;
    if (act === 'askPetting' && this.awakeSec < this.cfg.askPettingWarmupSec) return false;
    // 溜达/玩耍需要用户不在操作，且无 DND（游戏/会议中不要乱跑）
    if ((act === 'wander' || act === 'play') && ctx.dnd) return false;
    if ((act === 'wander' || act === 'play') && ctx.idleSec < this.cfg.idleGuardSec) return false;
    if (act === 'sleep' && ctx.quiet === false && this.drives.energy > this.cfg.threshold.sleepy) return false;
    return true;
  }

  /**
   * @param {number} dtSec 距上次 tick 的秒数
   * @param {{idleSec:number, quiet:boolean, dnd:boolean, nowMs:number, quotaLeft:number}} ctx
   * @returns {{act:string, score:number, text?:string}}
   */
  tick(dtSec, ctx) {
    const safeDt = Math.max(0, Math.min(dtSec, 120));
    this.awakeSec += safeDt;
    this._decay(safeDt, ctx);

    if (this.state === 'sleep') {
      this.sleepElapsed += safeDt;
      if (this.drives.energy >= 92 || this.sleepElapsed >= this.sleepTarget) {
        this.state = 'awake';
        this.sleepElapsed = 0;
        this._mark('sleep', ctx.nowMs);
        return { act: 'wake', score: 100, text: pick(this.rng, LINES.wake) };
      }
      return { act: 'sleeping', score: 100 };
    }

    const candidates = this._candidates(ctx).filter((c) => this._allowed(c, ctx));
    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0];

    if (!best || best.score < this.cfg.minScore) return { act: 'idle', score: 0 };

    this._mark(best.act, ctx.nowMs);

    if (best.act === 'sleep') {
      this.state = 'sleep';
      this.sleepElapsed = 0;
      this.sleepTarget = 600 + Math.floor(this.rng() * 900); // 10–25 分钟
      return { act: 'sleep', score: best.score, text: pick(this.rng, LINES.sleep) };
    }
    if (best.act === 'wander') return { act: 'wander', score: best.score };
    if (best.act === 'play') return { act: 'play', score: best.score, text: pick(this.rng, LINES.play) };
    if (best.act === 'askPetting') return { act: 'askPetting', score: best.score, text: pick(this.rng, LINES.askPetting) };
    if (best.act === 'sulk') return { act: 'sulk', score: best.score, text: pick(this.rng, LINES.sulk) };
    return { act: 'idle', score: best.score };
  }

  /** 用户交互：更新驱动值 / 经验，返回升级信息 */
  interact(kind, nowMs = Date.now()) {
    const map = {
      pet: { affection: 8, boredom: -10, exp: 6 },
      feed: { hunger: -45, affection: 6, exp: 12 },
      water: { thirst: -50, affection: 4, exp: 10 },
      play: { boredom: -40, energy: -8, affection: 5, exp: 15 },
      chat: { affection: 3, boredom: -6, exp: 3 },
    }[kind];
    if (!map) return { ok: false };

    let expGain = map.exp || 0;
    for (const [k, v] of Object.entries(map)) {
      if (k === 'exp') continue;
      this.drives[k] = clamp((this.drives[k] || 0) + v);
    }
    const before = this.level;
    this.exp += expGain;
    this.level = Math.min(10, Math.floor(this.exp / 100) + 1);
    const leveledUp = this.level > before;
    return {
      ok: true,
      gainedExp: expGain,
      level: this.level,
      exp: this.exp,
      leveledUp,
      text: leveledUp ? pick(this.rng, LINES.levelUp) : pick(this.rng, LINES[kind] || LINES.idle),
      drives: { ...this.drives },
      nowMs,
    };
  }

  mood() {
    if (this.state === 'sleep') return 'sleepy';
    if (this.drives.energy < 30) return 'sleepy';
    if (this.drives.affection < 30) return 'sad';
    if (this.drives.affection > 70 && this.drives.boredom < 40) return 'happy';
    return 'idle';
  }

  snapshot() {
    return {
      drives: { ...this.drives },
      state: this.state,
      level: this.level,
      exp: this.exp,
      mood: this.mood(),
    };
  }
}

module.exports = { BehaviorEngine, LINES, CONFIG, pick, clamp };
