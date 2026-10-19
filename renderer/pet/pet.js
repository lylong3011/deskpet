'use strict';
/* 桌宠渲染层
 * 单张主图 + 参数化动作库（20+ 动作），所有动作由变换曲线生成，不依赖逐帧美术
 * 动作分两类：loop（idle/walk/run/sleep/play）与 once（跳跃/转圈/伸懒腰/害羞…）
 */
(() => {
  const api = window.api || {};
  const canvas = document.getElementById('pet');
  const ctx = canvas.getContext('2d', { alpha: true });
  const bubbleEl = document.getElementById('bubble');
  const bubbleText = document.getElementById('bubble-text');
  const chatbar = document.getElementById('chatbar');
  const chatInput = document.getElementById('chat-input');
  const chatSend = document.getElementById('chat-send');
  const chatClose = document.getElementById('chat-close');
  const menuEl = document.getElementById('menu');
  const stage = document.getElementById('stage');

  const S = {
    DPR: Math.max(1, Math.min(3, window.devicePixelRatio || 1)),
    W: 0,
    H: 0,
    t: 0,
    clip: 'idle',
    clipT: 0,
    clipDur: 0,
    loop: true,
    mode: 'idle', // 与主进程行为引擎对齐的语义模式
    facing: 1,
    hopY: 0,
    hopV: 0,
    squash: 0,
    nextBlink: 2,
    blinking: false,
    blinkUntil: 0,
    particles: [],
    imgIdle: null,
    imgBlink: null,
    loaded: false,
    pointer: { x: -1, y: -1 },
    through: true,
    lastHitCheck: 0,
    chatOpen: false,
    aiChat: false,
    zTimer: 0,
    nextAmbient: 5,
    lastPose: null,
    fxDone: 0,
    props: [],
  };

  /* ------------------------------ 尺寸 ------------------------------ */
  function resize() {
    S.W = window.innerWidth;
    S.H = window.innerHeight;
    canvas.width = Math.round(S.W * S.DPR);
    canvas.height = Math.round(S.H * S.DPR);
    canvas.style.width = `${S.W}px`;
    canvas.style.height = `${S.H}px`;
    ctx.setTransform(S.DPR, 0, 0, S.DPR, 0, 0);
  }
  window.addEventListener('resize', resize);
  resize();

  /* ------------------------------ 资源 ------------------------------ */
  function loadCharacter(c) {
    if (!c) return;
    S.loaded = false;
    const idle = new Image();
    idle.onload = () => {
      S.loaded = true;
    };
    idle.onerror = () => {
      S.loaded = false;
      showBubble('形象加载失败了…', { duration: 3000 });
    };
    idle.src = c.idle;
    S.imgIdle = idle;
    if (c.blink) {
      const b = new Image();
      b.src = c.blink;
      S.imgBlink = b;
    } else {
      S.imgBlink = null;
    }
  }

  /* ------------------------------ 道具 / 贴图 ------------------------------ */
  function setProps(list) {
    S.props = (Array.isArray(list) ? list : [])
      .map((p, i) => {
        if (!p || !p.url) return null;
        const img = new Image();
        img.src = p.url;
        return { id: p.id, anchor: p.anchor || 'hand', img, phase: i * 1.37 };
      })
      .filter(Boolean);
  }

  function propOffset(anchor, w, h) {
    if (anchor === 'head') return { x: w * 0.3, y: -h * 0.9 };
    if (anchor === 'float') return { x: -w * 0.42, y: -h * 0.52 };
    return { x: w * 0.34, y: -h * 0.36 }; // hand
  }

  /* ------------------------------ 气泡 ------------------------------ */
  let bubbleTimer = null;
  function showBubble(text, opts = {}) {
    if (!text) return;
    const kind = opts.kind || 'talk';
    bubbleText.textContent = text; // textContent 防 XSS
    bubbleEl.className = `bubble show ${kind}`;
    clearTimeout(bubbleTimer);
    const dur = opts.duration || (opts.sticky ? 8500 : 3800 + Math.min(4000, text.length * 80));
    bubbleTimer = setTimeout(hideBubble, dur);
  }
  function hideBubble() {
    bubbleEl.classList.remove('show');
  }
  bubbleEl.addEventListener('click', hideBubble);

  /* ------------------------------ 粒子 ------------------------------ */
  function spawnEmoji(ch, x, y, opts = {}) {
    S.particles.push({
      ch,
      x,
      y,
      vx: opts.vx ?? (Math.random() - 0.5) * 22,
      vy: opts.vy ?? -34 - Math.random() * 22,
      life: opts.life ?? 1.6,
      age: 0,
      size: opts.size ?? 14 + Math.random() * 6,
      color: opts.color || '#ff6b81',
    });
  }

  function charBox() {
    const small = S.clip === 'sleep' ? 0.96 : 1;
    const h = Math.min(S.H * 0.78, S.W * 1.05) * small;
    const ratio = S.imgIdle && S.imgIdle.naturalWidth ? S.imgIdle.naturalWidth / S.imgIdle.naturalHeight : 200 / 220;
    const w = h * ratio;
    return { cx: S.W / 2, top: S.H - h - 6, w, h, bottom: S.H - 6 };
  }

  function burstAt(ch, count, color, spread = 0.5) {
    const b = charBox();
    for (let i = 0; i < count; i++) {
      spawnEmoji(ch, b.cx + (Math.random() - 0.5) * b.w * spread, b.top + b.h * 0.2, { color, life: 1.4 + Math.random() * 0.6 });
    }
  }
  const burstHearts = () => burstAt('❤', 5, '#ff5c8a', 0.5);

  /* ------------------------------ 动作库 ------------------------------ */
  const TAU = Math.PI * 2;
  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  const easeOut = (p) => 1 - Math.pow(1 - p, 3);
  const easeInOut = (p) => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2);
  const hump = (p) => Math.sin(clamp01(p) * Math.PI); // 0→1→0

  /** 动作定义为 pose(p, ctx) → 变换参数；p 为 0..1 进度 */
  const CLIPS = {
    /* ---- 循环动作 ---- */
    idle: {
      dur: Infinity,
      loop: true,
      pose: (p, c) => {
        const phase = Math.sin(c.t * TAU * 0.26);
        const sway = Math.sin(c.t * TAU * 0.11);
        // 轻微朝向鼠标倾斜，像在看你
        let lean = 0;
        if (S.pointer.x >= 0) lean = ((S.pointer.x / S.W) - 0.5) * 0.06;
        return {
          sx: 1 - 0.016 * 0.6 * phase,
          sy: 1 + 0.016 * phase,
          rot: 0.019 * sway + lean,
          dy: 0,
        };
      },
    },
    walk: {
      dur: Infinity,
      loop: true,
      pose: (p, c) => {
        const w = Math.sin(c.t * TAU * 1.9);
        return { sy: 1 + 0.02 * w, sx: 1 - 0.012 * w, rot: 0.05 * w * S.facing, dy: -Math.abs(w) * 4.5, dx: 1.2 * w };
      },
    },
    run: {
      dur: Infinity,
      loop: true,
      pose: (p, c) => {
        const w = Math.sin(c.t * TAU * 3.2);
        return { sy: 1 + 0.03 * w, sx: 1 - 0.02 * w, rot: 0.1 * w * S.facing, dy: -Math.abs(w) * 9, dx: 2.6 * w };
      },
    },
    sleep: {
      dur: Infinity,
      loop: true,
      pose: (p, c) => {
        const phase = Math.sin(c.t * TAU * 0.17);
        return { sy: 1 + 0.012 * phase, sx: 1 - 0.008 * phase, rot: 0.02 + 0.012 * Math.sin(c.t * TAU * 0.09), dy: 2 };
      },
    },
    play: {
      dur: Infinity,
      loop: true,
      pose: (p, c) => {
        const w = Math.sin(c.t * TAU * 1.4);
        return { sy: 1 + 0.03 * Math.abs(w), rot: 0.06 * w, dy: -Math.abs(w) * 12 };
      },
    },

    /* ---- 一次性动作 ---- */
    hop: {
      dur: 0.55,
      pose: (p) => {
        const y = -Math.sin(clamp01(p) * Math.PI) * 72;
        const land = p > 0.82 ? (p - 0.82) / 0.18 : 0;
        return { dy: y, sy: 1 - land * 0.16, sx: 1 + land * 0.14 };
      },
    },
    hopTwice: {
      dur: 0.95,
      pose: (p) => {
        const seg = p < 0.5 ? p / 0.5 : (p - 0.5) / 0.5;
        return { dy: -Math.sin(seg * Math.PI) * (p < 0.5 ? 56 : 78) };
      },
    },
    jumpSpin: {
      dur: 0.95,
      pose: (p) => {
        const e = clamp01(p);
        return { dy: -Math.sin(e * Math.PI) * 96, rot: e * TAU };
      },
    },
    spin: {
      dur: 0.8,
      pose: (p) => ({ rot: easeInOut(clamp01(p)) * TAU, dy: -Math.sin(clamp01(p) * Math.PI) * 10 }),
    },
    tilt: {
      dur: 1.3,
      pose: (p) => ({ rot: hump(p) * 0.2 * S.facing, dx: hump(p) * 6 * S.facing }),
    },
    nod: {
      dur: 0.8,
      pose: (p) => ({ dy: Math.abs(Math.sin(clamp01(p) * Math.PI * 2)) * -8, sy: 1 + 0.03 * Math.sin(clamp01(p) * Math.PI * 2) }),
    },
    shakeHead: {
      dur: 0.9,
      pose: (p) => ({ rot: Math.sin(clamp01(p) * Math.PI * 6) * 0.1 * (1 - p) }),
    },
    stretch: {
      dur: 1.5,
      pose: (p) => {
        const e = Math.sin(clamp01(p) * Math.PI);
        return { sy: 1 + 0.16 * e, sx: 1 - 0.08 * e, dy: -18 * e };
      },
    },
    squat: {
      dur: 0.95,
      pose: (p) => {
        const e = Math.sin(clamp01(p) * Math.PI);
        return { sy: 1 - 0.16 * e, sx: 1 + 0.12 * e, dy: 10 * e };
      },
    },
    dance: {
      dur: 2.6,
      pose: (p, c) => {
        const w = Math.sin(c.t * TAU * 1.6);
        return { rot: 0.12 * w, dx: 8 * w, dy: -Math.abs(Math.sin(c.t * TAU * 0.8)) * 12, sy: 1 + 0.03 * w };
      },
      fx: [
        { at: 0.15, ch: '♪', color: '#7fc4b8' },
        { at: 0.42, ch: '♫', color: '#8fb8f0' },
        { at: 0.7, ch: '♪', color: '#f0a6c0' },
      ],
    },
    angry: {
      dur: 1.5,
      pose: (p, c) => ({ rot: Math.sin(c.t * 40) * 0.03, dy: -2, tint: '#ff4d4f', tintAlpha: 0.16 }),
      fx: [{ at: 0.1, ch: '💢', color: '#e74c3c' }],
    },
    shy: {
      dur: 1.7,
      pose: (p, c) => ({ sx: 1 - 0.06, sy: 1 - 0.04, rot: 0.06 * Math.sin(c.t * 3), tint: '#ff8fb1', tintAlpha: 0.14 }),
      fx: [{ at: 0.2, ch: '💗', color: '#ff7ba8' }],
    },
    surprise: {
      dur: 0.75,
      pose: (p) => ({ dy: -Math.sin(clamp01(p) * Math.PI) * 46, sy: 1 + 0.05 * hump(p) }),
      fx: [{ at: 0.05, ch: '！', color: '#f0a020' }],
    },
    sad: {
      dur: 1.9,
      pose: (p, c) => ({ sy: 1 - 0.05, rot: -0.05, dy: 4 + Math.sin(c.t * 2) * 1.2, tint: '#5b7fb0', tintAlpha: 0.1 }),
      fx: [{ at: 0.3, ch: '💧', color: '#7fb2e5' }],
    },
    float: {
      dur: 2.4,
      pose: (p, c) => ({ dy: -40 - Math.sin(c.t * 2.2) * 8, sy: 1.01 }),
    },
    peek: {
      dur: 1.8,
      pose: (p) => ({ dx: hump(p) * 26 * S.facing, rot: hump(p) * 0.14 * S.facing }),
      fx: [{ at: 0.35, ch: '？', color: '#8a7fd0' }],
    },
    flip: {
      dur: 0.9,
      pose: (p) => ({ scaleX: Math.cos(clamp01(p) * Math.PI * 2), rot: Math.sin(clamp01(p) * Math.PI) * 0.1 }),
    },
    pulse: {
      dur: 1.3,
      pose: (p, c) => ({ sx: 1 + 0.05 * Math.sin(c.t * 12), sy: 1 + 0.05 * Math.sin(c.t * 12), tint: '#ff6b81', tintAlpha: 0.08 }),
    },
    sneeze: {
      dur: 1.05,
      pose: (p, c) => {
        const e = i => Math.sin(clamp01(i) * Math.PI);
        return { rot: Math.sin(c.t * 22) * 0.05 * (1 - p), sy: 1 - 0.05 * e(p * 1.4), dx: 3 * e(p) };
      },
      fx: [{ at: 0.55, ch: '💨', color: '#9fb3c8' }],
    },
    yawn: {
      dur: 2.1,
      pose: (p) => {
        const e = hump(p);
        return { sy: 1 + 0.12 * e, sx: 1 - 0.06 * e, dy: -8 * e };
      },
      fx: [
        { at: 0.3, ch: 'Z', color: '#9db7cf' },
        { at: 0.55, ch: 'Z', color: '#9db7cf' },
      ],
    },
    lieDown: {
      dur: 0.9,
      pose: (p) => {
        const e = easeInOut(clamp01(p));
        return { rot: e * (Math.PI / 2) * -S.facing, dy: e * 10, sy: 1 - 0.02 * e };
      },
    },
    wake: {
      dur: 1.1,
      pose: (p) => {
        const e = easeOut(clamp01(p));
        return { rot: (1 - e) * (Math.PI / 2) * -S.facing, dy: (1 - e) * 10, sy: 1 + 0.04 * Math.sin(clamp01(p) * Math.PI) };
      },
    },
    faint: {
      dur: 1.1,
      pose: (p) => {
        const e = easeInOut(clamp01(p));
        return { rot: e * (Math.PI / 2), dy: e * 14 };
      },
      fx: [{ at: 0.6, ch: '💫', color: '#f0c24a' }],
    },
  };

  // 主进程 act 名称 → 动作名
  const ACT_MAP = {
    pet: 'shy',
    feed: 'pulse',
    water: 'nod',
    play: 'dance',
    ask: 'peek',
    sulk: 'sad',
    react: 'hop',
    ok: 'nod',
    love: 'pulse',
  };

  const AMBIENT = ['tilt', 'nod', 'stretch', 'squat', 'peek', 'hop', 'hopTwice', 'spin', 'yawn', 'flip', 'sneeze'];

  function playClip(name, opts = {}) {
    const clip = CLIPS[name];
    if (!clip) return false;
    S.clip = name;
    S.clipT = 0;
    S.clipDur = clip.dur === Infinity ? Infinity : clip.dur;
    S.loop = !!clip.loop;
    S.fxDone = 0;
    if (opts.dir) S.facing = opts.dir > 0 ? 1 : -1;
    if (name === 'sleep') {
      S.mode = 'sleep';
      S.nextBlink = Infinity;
    } else if (clip.loop) {
      S.mode = name === 'walk' || name === 'run' ? 'walk' : name === 'play' ? 'play' : 'idle';
    } else {
      S.mode = name === 'faint' ? 'sleep' : S.mode;
    }
    return true;
  }

  function backToIdle() {
    S.clip = 'idle';
    S.clipT = 0;
    S.clipDur = Infinity;
    S.loop = true;
    S.mode = 'idle';
    S.nextBlink = S.t + 2;
  }

  /* ------------------------------ 更新 ------------------------------ */
  function update(dt) {
    S.t += dt;
    S.clipT += dt;

    // 眨眼
    if (S.imgBlink && S.clip !== 'sleep') {
      if (!S.blinking && S.t >= S.nextBlink) {
        S.blinking = true;
        S.blinkUntil = S.t + 0.13;
      } else if (S.blinking && S.t >= S.blinkUntil) {
        S.blinking = false;
        S.nextBlink = S.t + 2.4 + Math.random() * 5;
      }
    } else if (S.clip === 'sleep') {
      S.blinking = false;
    }

    // 一次性动作结束回到 idle
    if (!S.loop && S.clipDur !== Infinity && S.clipT >= S.clipDur) backToIdle();

    // 待机时随机自发小动作（与「主动互动」开关无关，属于卖萌动效）
    if (S.loop && S.clip === 'idle') {
      if (S.t >= S.nextAmbient) {
        S.nextAmbient = S.t + 6 + Math.random() * 9;
        if (S.particles.length < 24) playClip(AMBIENT[Math.floor(Math.random() * AMBIENT.length)]);
      }
    } else {
      S.nextAmbient = Math.max(S.nextAmbient, S.t + 2);
    }

    // 跳跃物理（外部 hop 复用人造重力，用于落地挤压）
    if (S.hopV !== 0 || S.hopY !== 0) {
      S.hopV += 1500 * dt;
      S.hopY += S.hopV * dt;
      if (S.hopY > 0) {
        S.hopY = 0;
        S.hopV = 0;
        S.squash = 1;
      }
    }
    if (S.squash > 0) S.squash = Math.max(0, S.squash - dt * 4.2);

    // 睡觉/玩耍的氛围粒子
    if (S.clip === 'sleep' || S.clip === 'play') {
      S.zTimer += dt;
      const gap = S.clip === 'sleep' ? 1.4 : 0.9;
      if (S.zTimer > gap) {
        S.zTimer = 0;
        const b = charBox();
        if (S.clip === 'sleep') {
          spawnEmoji('Z', b.cx + b.w * 0.22, b.top + b.h * 0.28, { color: '#9db7cf', vy: -20, vx: 6, life: 2.6, size: 13 });
        } else {
          spawnEmoji('♪', b.cx + (Math.random() - 0.5) * b.w * 0.5, b.top + b.h * 0.2, { color: '#7fc4b8', vy: -30, life: 1.4 });
        }
      }
    }

    const clip = CLIPS[S.clip];
    if (clip && clip.fx) {
      const prog = S.loop ? 0 : clamp01(S.clipT / (clip.dur || 1));
      while (S.fxDone < clip.fx.length && prog >= clip.fx[S.fxDone].at) {
        const f = clip.fx[S.fxDone++];
        const b = charBox();
        spawnEmoji(f.ch, b.cx + (Math.random() - 0.5) * b.w * 0.4, b.top + b.h * 0.18, { color: f.color, life: 1.6, size: 18 });
      }
    }

    for (const p of S.particles) {
      p.age += dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += 12 * dt;
    }
    S.particles = S.particles.filter((p) => p.age < p.life);
  }

  /* ------------------------------ 绘制 ------------------------------ */
  function draw() {
    ctx.clearRect(0, 0, S.W, S.H);

    if (S.loaded && S.imgIdle) {
      const b = charBox();
      const clip = CLIPS[S.clip] || CLIPS.idle;
      const p = S.loop ? 0 : clamp01(S.clipT / (clip.dur || 1));
      const pose = clip.pose(p, { t: S.clipT }) || {};

      const sx = (pose.sx ?? 1) * (pose.scaleX ?? 1) * S.facing;
      const sy = pose.sy ?? 1;
      const rot = pose.rot ?? 0;
      const dx = pose.dx ?? 0;
      const dy = (pose.dy ?? 0) + S.hopY;

      S.lastPose = { sx, sy, rot, dx, dy, cx: b.cx, bottom: b.bottom, w: b.w, h: b.h };

      // 影子：离地越高越小越淡
      const lift = Math.min(1, Math.abs(dy) / 90);
      const shadowScale = 1 - 0.45 * lift;
      ctx.save();
      ctx.globalAlpha = 0.13 * shadowScale;
      ctx.fillStyle = '#3a2b26';
      ctx.beginPath();
      ctx.ellipse(b.cx + dx * 0.4, S.H - 7, b.w * 0.3 * shadowScale, 5 * shadowScale, 0, 0, TAU);
      ctx.fill();
      ctx.restore();

      const sq = S.squash * 0.16;
      const finalSy = sy * (1 - sq);
      const finalSx = sx * (1 + sq);

      ctx.save();
      ctx.translate(b.cx + dx, b.bottom + dy);
      ctx.rotate(rot);
      ctx.scale(finalSx, finalSy);
      ctx.drawImage(S.blinking && S.imgBlink ? S.imgBlink : S.imgIdle, -b.w / 2, -b.h, b.w, b.h);
      if (pose.tint && pose.tintAlpha) {
        ctx.globalCompositeOperation = 'source-atop';
        ctx.globalAlpha = pose.tintAlpha;
        ctx.fillStyle = pose.tint;
        ctx.fillRect(-b.w / 2, -b.h, b.w, b.h);
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1;
      }

      // 道具层：跟随身体一起平移/旋转/缩放，手持物会随转身镜像
      for (const pr of S.props) {
        if (!pr.img || !pr.img.complete || !pr.img.naturalWidth) continue;
        const size = b.h * (pr.anchor === 'head' ? 0.2 : 0.26);
        const off = propOffset(pr.anchor, b.w, b.h);
        const bob = Math.sin(S.t * 2 + pr.phase) * 2.2;
        ctx.drawImage(pr.img, off.x - size / 2, off.y - size / 2 + bob, size, size);
      }
      ctx.restore();
    }

    for (const p of S.particles) {
      const alpha = Math.max(0, 1 - p.age / p.life);
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = p.color;
      ctx.font = `600 ${p.size}px "Segoe UI Emoji", "Segoe UI Symbol", system-ui`;
      ctx.textAlign = 'center';
      ctx.fillText(p.ch, p.x, p.y);
      ctx.restore();
    }
  }

  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    update(dt);
    draw();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  /* ------------------------------ 命中与穿透 ------------------------------ */
  function overUI(x, y) {
    for (const el of [bubbleEl, chatbar, menuEl]) {
      if (!el || el.classList.contains('hidden') || !el.classList.contains('show')) continue;
      const r = el.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return true;
    }
    return false;
  }

  /**
   * 命中测试：取 15×15 邻域的最大 alpha，等价于把判定范围外扩约 7px
   * 解决抠图留洞、细脖子、半透明边缘点不到的问题
   */
  function isOpaque(x, y) {
    if (!S.loaded) return false;
    if (x < 0 || y < 0 || x >= S.W || y >= S.H) return false;
    const R = 7;
    const px = Math.round(x * S.DPR);
    const py = Math.round(y * S.DPR);
    const rr = Math.round(R * S.DPR);
    const sx = Math.max(0, px - rr);
    const sy = Math.max(0, py - rr);
    const ex = Math.min(canvas.width, px + rr);
    const ey = Math.min(canvas.height, py + rr);
    const w = ex - sx;
    const h = ey - sy;
    if (w <= 0 || h <= 0) return false;
    try {
      const d = ctx.getImageData(sx, sy, w, h).data;
      for (let i = 3; i < d.length; i += 4) {
        if (d[i] > 8) return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  function setThrough(next) {
    if (next === S.through) return;
    S.through = next;
    api.setClickThrough?.(next);
    document.body.style.cursor = next ? 'default' : 'grab';
  }

  function refreshHit(force = false) {
    const now = performance.now();
    if (!force && now - S.lastHitCheck < 45) return;
    S.lastHitCheck = now;
    const { x, y } = S.pointer;
    if (x < 0) return;
    if (menuEl.classList.contains('show')) {
      setThrough(false); // 菜单打开时保持可点，否则菜单本身点不到
      return;
    }
    if (S.chatOpen && overUI(x, y)) {
      setThrough(false);
      return;
    }
    setThrough(!(overUI(x, y) || isOpaque(x, y)));
  }

  window.addEventListener('mousemove', (e) => {
    S.pointer = { x: e.clientX, y: e.clientY };
    refreshHit();
  });

  /* ------------------------------ 交互 ------------------------------ */
  let downAt = 0;
  let pressing = false;

  canvas.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    S.pointer = { x: e.clientX, y: e.clientY };
    if (!isOpaque(e.clientX, e.clientY)) return;
    pressing = true;
    downAt = Date.now();
    setThrough(false);
    api.dragStart?.();
  });

  window.addEventListener('mouseup', (e) => {
    if (!pressing) return;
    pressing = false;
    api.dragEnd?.();
    const quick = Date.now() - downAt < 220;
    if (quick) {
      api.interact?.('pet');
      burstHearts();
    }
    refreshHit(true);
  });

  canvas.addEventListener('dblclick', (e) => {
    if (!S.aiChat) return;
    if (!isOpaque(e.clientX, e.clientY)) return;
    toggleChat(true);
  });

  function hideMenu() {
    if (menuEl.classList.contains('show')) api.menuClosed?.();
    menuEl.classList.remove('show');
    setTimeout(() => menuEl.classList.add('hidden'), 150);
  }

  window.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (!isOpaque(e.clientX, e.clientY)) return;
    const mw = 138;
    const mh = 268;
    const x = Math.min(e.clientX, S.W - mw - 6);
    const y = Math.min(e.clientY, S.H - mh - 6);
    menuEl.classList.remove('hidden');
    menuEl.style.left = `${Math.max(4, x)}px`;
    menuEl.style.top = `${Math.max(4, y)}px`;
    requestAnimationFrame(() => menuEl.classList.add('show'));
    setThrough(false);
    api.menuOpened?.(); // 主进程开始盯着光标，离开窗口就把菜单关掉
  });

  // 鼠标离开窗口区域也关菜单（兜底：某些情况下窗口拿不到焦点，收不到 blur）
  document.addEventListener('mouseleave', () => {
    if (menuEl.classList.contains('show')) hideMenu();
  });

  document.addEventListener('mousedown', (e) => {
    if (!menuEl.classList.contains('hidden') && !menuEl.contains(e.target)) hideMenu();
    // 点击对话条之外关闭输入框
    if (S.chatOpen && !chatbar.contains(e.target) && !canvas.contains(e.target)) toggleChat(false);
  });

  menuEl.addEventListener('click', (e) => {
    const act = e.target?.dataset?.act;
    if (!act) return;
    hideMenu();
    if (act === 'settings') return api.openSettings?.();
    if (act === 'chat') return toggleChat(true);
    if (act === 'quit') return api.quit?.();
    api.interact?.(act);
    playClip(ACT_MAP[act] || 'nod');
    if (act === 'pet') burstHearts();
  });

  /* ------------------------------ 对话 ------------------------------ */
  function toggleChat(open) {
    if (open && !S.aiChat) {
      showBubble('AI 对话还没开启，去设置里打开吧～', { duration: 4000 });
      return;
    }
    S.chatOpen = open;
    chatbar.classList.toggle('show', open);
    chatbar.classList.toggle('hidden', !open);
    stage.classList.toggle('chat-open', open);
    if (open) chatInput.focus();
    else chatInput.blur();
    setTimeout(() => refreshHit(true), 60);
  }

  async function sendChat() {
    const text = chatInput.value.trim();
    if (!text) return;
    chatInput.value = '';
    showBubble('…', { duration: 30000 });
    const res = await api.chat?.(text);
    if (res && res.ok) {
      showBubble(res.reply, { duration: 7000 });
      playClip('nod');
    } else {
      showBubble((res && res.error) || '我有点听不懂…', { duration: 4000 });
      playClip('sad');
    }
  }

  chatSend.addEventListener('click', sendChat);
  chatClose.addEventListener('click', () => toggleChat(false));
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendChat();
    if (e.key === 'Escape') toggleChat(false);
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && S.chatOpen) toggleChat(false);
    if (e.key === 'Escape' && menuEl.classList.contains('show')) hideMenu();
  });

  /* ------------------------------ 音效 ------------------------------ */
  let audio = null;
  function playChime(url) {
    if (!url) return;
    try {
      if (!audio) {
        audio = new Audio(url);
        audio.volume = 0.45;
      }
      audio.currentTime = 0;
      audio.play().catch(() => {});
    } catch {
      /* 忽略音频错误 */
    }
  }

  /* ------------------------------ 主进程指令 ------------------------------ */
  api.onInit?.((payload) => {
    if (!payload) return;
    S.characterId = payload.character?.id || '';
    loadCharacter(payload.character);
    setProps(payload.character?.props);
    S.aiChat = !!(payload.settings && payload.settings.aiChat);
    if (payload.chime) S.chime = payload.chime;
    if (!payload.settings?.aiChat) toggleChat(false);
  });

  api.onSay?.((payload) => {
    if (!payload) return;
    showBubble(payload.text, payload);
  });

  api.onAct?.((payload) => {
    if (!payload || !payload.name) return;
    const name = payload.name;
    if (name === 'walk') {
      playClip('walk', { dir: payload.dir });
      return;
    }
    if (name === 'run') {
      playClip('run', { dir: payload.dir });
      return;
    }
    if (name === 'sleep') {
      playClip('lieDown');
      setTimeout(() => {
        if (S.clip === 'idle' || S.clip === 'lieDown') playClip('sleep');
      }, 900);
      return;
    }
    if (name === 'idle') {
      backToIdle();
      return;
    }
    if (name === 'wake') {
      playClip('wake');
      return;
    }
    if (name === 'hop') {
      playClip('hop');
      return;
    }
    if (name === 'react') {
      playClip('hop');
      if (payload.kind === 'feed' || payload.kind === 'water') {
        const b = charBox();
        spawnEmoji(payload.kind === 'feed' ? '🍙' : '💧', b.cx, b.top + b.h * 0.2, { life: 1.6, size: 18 });
      }
      return;
    }
    if (name === 'land') {
      S.squash = 1;
      return;
    }
    if (playClip(name)) return;
    // 未知动作名：映射一次可用的情绪动作
    playClip(ACT_MAP[name] || 'nod');
  });

  api.onState?.((payload) => {
    if (!payload) return;
    if (payload.character && payload.character.id !== (S.characterId || '')) {
      S.characterId = payload.character.id;
      loadCharacter(payload.character);
    }
    if (payload.character && Array.isArray(payload.character.props)) setProps(payload.character.props);
    S.aiChat = !!(payload.settings && payload.settings.aiChat);
    if (!S.aiChat && S.chatOpen) toggleChat(false);
  });

  api.onSound?.(() => playChime(S.chime));
  api.onMenuClose?.(() => hideMenu());
  api.onProps?.((list) => setProps(list));

  // 供主进程冒烟自检读取运行状态
  window.__petHit = (x, y) => isOpaque(x, y); // 命中测试探针，便于自检碰撞箱
  window.__petPlay = (name) => playClip(name);
  window.__petDebug = () => ({
    loaded: S.loaded,
    mode: S.mode,
    clip: S.clip,
    clips: Object.keys(CLIPS).length,
    props: S.props.map((p) => p.id),
    w: S.W,
    h: S.H,
    hasImage: !!S.imgIdle && S.imgIdle.naturalWidth > 0,
    imageSrc: S.imgIdle ? decodeURIComponent(S.imgIdle.src.split('/').pop() || '') : '',
    bubble: bubbleEl.classList.contains('show') ? bubbleText.textContent : '',
    menuOpen: menuEl.classList.contains('show'),
    chatOpen: S.chatOpen,
    through: S.through,
    aiChat: S.aiChat,
  });
})();
