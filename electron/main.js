'use strict';
const {
  app,
  BrowserWindow,
  ipcMain,
  Tray,
  Menu,
  screen,
  nativeImage,
  powerMonitor,
  Notification,
  safeStorage,
  shell,
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const { Store } = require('./store');
const { BehaviorEngine, LINES, pick } = require('./behavior');
const { ReminderScheduler, inQuietHours } = require('./scheduler');
const providers = require('./providers');

const ROOT = path.join(__dirname, '..');
const ASSETS = path.join(ROOT, 'assets');
const isDev = !app.isPackaged;
const BASE_W = 320;
const BASE_H = 380;

// 允许测试时指定独立的数据目录，避免污染真实配置
if (process.env.DESKPET_USER_DATA) {
  try {
    app.setPath('userData', process.env.DESKPET_USER_DATA);
  } catch (err) {
    console.error('[userData]', err);
  }
}

const runtimeErrors = [];

/** 收集渲染进程错误，冒烟测试据此判定失败 */
function attachDiagnostics(win, tag) {
  win.webContents.on('console-message', (...args) => {
    const [, b, c] = args;
    const isObj = b && typeof b === 'object';
    const level = isObj ? b.level : b;
    const message = isObj ? b.message : c;
    const bad = level === 3 || level === '3' || level === 'error';
    if (bad) runtimeErrors.push(`[${tag}] ${message}`);
    if (isDev) console.log(`[${tag}] ${message}`);
  });
  win.webContents.on('did-fail-load', (_e, code, desc) => runtimeErrors.push(`[${tag}] 加载失败 ${code} ${desc}`));
  win.webContents.on('render-process-gone', (_e, d) => runtimeErrors.push(`[${tag}] 渲染进程异常 ${d.reason}`));
}

let store = null;
let engine = null;
let scheduler = null;
let petWin = null;
let settingsWin = null;
let tray = null;

let movingTimer = null;
let walkState = null;
let dragState = null;
let dragTimer = null;
let persistTimer = null;
let chatHistory = [];

/* ------------------------------ 路径工具 ------------------------------ */

const userDataDir = () => app.getPath('userData');
const charactersDir = () => {
  const d = path.join(userDataDir(), 'characters');
  fs.mkdirSync(d, { recursive: true });
  return d;
};
const propsDir = () => {
  const d = path.join(userDataDir(), 'props');
  fs.mkdirSync(d, { recursive: true });
  return d;
};
const toFileUrl = (p) => (p ? pathToFileURL(p).href : null);

function assetUrl(rel) {
  return toFileUrl(path.join(ASSETS, rel));
}

/* ------------------------------ 窗口 ------------------------------ */

function petSize() {
  const s = Number(store.get('settings.scale', 1)) || 1;
  return { width: Math.round(BASE_W * s), height: Math.round(BASE_H * s) };
}

function createPetWindow() {
  const { width, height } = petSize();
  const { workArea } = screen.getPrimaryDisplay();
  const x = workArea.x + workArea.width - width - 40;
  const y = workArea.y + workArea.height - height - 8;

  petWin = new BrowserWindow({
    width,
    height,
    x,
    y,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: true,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    focusable: true,
    alwaysOnTop: true,
    show: false,
    title: 'DeskPet',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });

  petWin.setAlwaysOnTop(true, 'screen-saver');
  if (process.platform !== 'win32') petWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // 默认穿透，避免启动瞬间挡住用户点击；渲染层采样到角色像素后再关闭穿透
  petWin.setIgnoreMouseEvents(true, { forward: true });

  petWin.loadFile(path.join(ROOT, 'renderer', 'pet', 'index.html'));
  attachDiagnostics(petWin, 'pet');
  petWin.once('ready-to-show', () => {
    petWin.showInactive();
    sendToPet('pet:init', buildPetPayload());
  });
  // 点了桌面/别的地方 → 窗口失焦 → 关掉右键菜单（穿透状态下点击事件收不到，只能靠失焦）
  petWin.on('blur', () => {
    if (petWin && !petWin.isDestroyed()) petWin.webContents.send('pet:menu-close');
  });

  petWin.on('closed', () => {
    petWin = null;
  });
  // 禁止内部跳转
  petWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

function createSettingsWindow() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    return settingsWin;
  }
  settingsWin = new BrowserWindow({
    width: 980,
    height: 720,
    minWidth: 880,
    minHeight: 620,
    show: false,
    backgroundColor: '#faf8f5',
    title: 'DeskPet 设置',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#faf8f5', symbolColor: '#4a4a4a', height: 44 },
    icon: path.join(ASSETS, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  settingsWin.loadFile(path.join(ROOT, 'renderer', 'settings', 'index.html'));
  attachDiagnostics(settingsWin, 'settings');
  settingsWin.once('ready-to-show', () => {
    settingsWin.show();
    if (isDev) settingsWin.webContents.openDevTools({ mode: 'detach' });
  });
  settingsWin.on('closed', () => {
    settingsWin = null;
  });
  settingsWin.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  return settingsWin;
}

function sendToPet(channel, payload) {
  if (petWin && !petWin.isDestroyed()) petWin.webContents.send(channel, payload);
}

function broadcastState() {
  const payload = buildStatePayload();
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('state:update', payload);
  if (petWin && !petWin.isDestroyed()) petWin.webContents.send('state:update', payload);
}

function activeCharacter() {
  const c = store.get('character', {});
  const props = enabledProps();
  if (c.file && fs.existsSync(c.file)) {
    return { id: c.id, name: c.name || '小家伙', kind: 'custom', idle: toFileUrl(c.file), blink: null, props };
  }
  const builtin = c.builtin || 'momo';
  return {
    id: builtin,
    name: c.name || '小家伙',
    kind: 'builtin',
    idle: assetUrl(`builtin/${builtin}.svg`),
    blink: assetUrl(`builtin/${builtin}-blink.svg`),
    props,
  };
}

/* ------------------------------ 道具 / 贴图 ------------------------------ */

const BUILTIN_PROPS = [
  { id: 'cup', name: '水杯', anchor: 'hand' },
  { id: 'coffee', name: '咖啡', anchor: 'hand' },
  { id: 'book', name: '书', anchor: 'hand' },
  { id: 'mic', name: '麦克风', anchor: 'hand' },
  { id: 'heart', name: '爱心', anchor: 'float' },
  { id: 'star', name: '星星', anchor: 'head' },
];

const propsIndexPath = () => path.join(propsDir(), 'index.json');

function readPropsIndex() {
  try {
    const raw = fs.readFileSync(propsIndexPath(), 'utf8');
    const j = JSON.parse(raw);
    return { enabled: Array.isArray(j.enabled) ? j.enabled : [], custom: Array.isArray(j.custom) ? j.custom : [] };
  } catch {
    return { enabled: [], custom: [] };
  }
}

function writePropsIndex(idx) {
  fs.writeFileSync(propsIndexPath(), JSON.stringify(idx, null, 2), 'utf8');
}

function listProps() {
  const idx = readPropsIndex();
  const builtin = BUILTIN_PROPS.map((p) => ({
    ...p,
    url: assetUrl(`builtin/props/${p.id}.svg`),
    builtin: true,
    enabled: idx.enabled.includes(p.id),
  }));
  const custom = idx.custom
    .filter((c) => c.file && fs.existsSync(c.file))
    .map((c) => ({
      id: c.id,
      name: c.name || '自定义道具',
      anchor: c.anchor || 'hand',
      url: toFileUrl(c.file),
      builtin: false,
      enabled: idx.enabled.includes(c.id),
    }));
  return [...builtin, ...custom];
}

function enabledProps() {
  return listProps()
    .filter((p) => p.enabled)
    .map((p) => ({ id: p.id, url: p.url, anchor: p.anchor }));
}

function pushPropsToPet() {
  sendToPet('pet:props', enabledProps());
}

function buildPetPayload() {
  return {
    character: activeCharacter(),
    settings: store.get('settings'),
    pet: engine ? engine.snapshot() : null,
    chime: assetUrl('chime.wav'),
  };
}

function buildStatePayload() {
  return {
    version: app.getVersion(),
    onboarded: store.get('onboarded', false),
    character: activeCharacter(),
    characters: listCharacters(),
    props: listProps(),
    settings: store.sanitize().settings,
    pet: engine ? engine.snapshot() : null,
    stats: store.get('stats'),
    presets: providers.PRESETS,
    styles: providers.STYLES,
    platforms: process.platform,
    appVersion: app.getVersion(),
  };
}

function listCharacters() {
  const out = [];
  const dir = charactersDir();
  for (const name of fs.readdirSync(dir)) {
    const metaFile = path.join(dir, name, 'meta.json');
    if (!fs.existsSync(metaFile)) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
      out.push({ id: name, ...meta, url: toFileUrl(path.join(dir, name, 'sprite.png')), builtin: false });
    } catch {
      /* 忽略坏数据 */
    }
  }
  const builtinMeta = [
    { id: 'momo', name: '默默', desc: '桃气小团子' },
    { id: 'lulu', name: '露露', desc: '薄荷小可爱' },
    { id: 'doudou', name: '豆豆', desc: '奶油小跟班' },
  ];
  for (const b of builtinMeta) {
    out.push({ ...b, builtin: true, url: assetUrl(`builtin/${b.id}.svg`) });
  }
  return out;
}

/* ------------------------------ 互动 ------------------------------ */

function say(text, opts = {}) {
  if (!text) return;
  sendToPet('pet:say', { text, kind: opts.kind || 'talk', sticky: !!opts.sticky, duration: opts.duration });
}

function act(name, payload = {}) {
  sendToPet('pet:act', { name, ...payload });
}

function safeWalkTarget() {
  if (!petWin) return null;
  const b = petWin.getBounds();
  const display = screen.getDisplayNearestPoint({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
  const wa = display.workArea;
  const minX = wa.x + 16;
  const maxX = wa.x + wa.width - b.width - 16;
  if (maxX <= minX) return b.x;
  // 随机挑一个离当前位置至少 120px 的落点，太近就走到对侧
  for (let i = 0; i < 6; i++) {
    const x = Math.round(minX + Math.random() * (maxX - minX));
    if (Math.abs(x - b.x) > 120) return x;
  }
  return b.x < wa.x + wa.width / 2 ? maxX : minX;
}

function startWalk(targetX) {
  if (!petWin || targetX === null) return;
  const b = petWin.getBounds();
  const dir = targetX >= b.x ? 1 : -1;
  if (Math.abs(targetX - b.x) < 24) return;
  walkState = { targetX, dir, speed: 62 };
  act('walk', { dir });
  if (movingTimer) clearInterval(movingTimer);
  movingTimer = setInterval(() => {
    if (!petWin || petWin.isDestroyed() || !walkState) return stopWalk();
    const cur = petWin.getBounds();
    let nx = cur.x + walkState.dir * walkState.speed * 0.033;
    if ((walkState.dir > 0 && nx >= walkState.targetX) || (walkState.dir < 0 && nx <= walkState.targetX)) {
      nx = walkState.targetX;
      petWin.setBounds({ x: Math.round(nx), y: cur.y, width: cur.width, height: cur.height });
      return stopWalk();
    }
    petWin.setBounds({ x: Math.round(nx), y: cur.y, width: cur.width, height: cur.height });
  }, 33);
}

function stopWalk() {
  if (movingTimer) clearInterval(movingTimer);
  movingTimer = null;
  walkState = null;
  act('idle');
}

function applyDecision(d) {
  if (!d) return;
  switch (d.act) {
    case 'wander':
      startWalk(safeWalkTarget());
      break;
    case 'play':
      act('play');
      if (d.text) say(d.text, { duration: 4200 });
      break;
    case 'askPetting':
      act('ask');
      if (d.text) say(d.text, { kind: 'ask', sticky: true });
      break;
    case 'sulk':
      act('sulk');
      if (d.text) say(d.text, { duration: 3600 });
      break;
    case 'sleep':
      act('sleep');
      if (d.text) say(d.text, { duration: 3000 });
      break;
    case 'wake':
      act('wake');
      if (d.text) say(d.text, { duration: 3200 });
      break;
    default:
      break;
  }
}

function earnExp(interactionKind, sayText) {
  const res = engine.interact(interactionKind);
  if (!res.ok) return;
  const stats = store.get('stats');
  stats.totalInteractions = (stats.totalInteractions || 0) + 1;
  stats.interactionsToday = (stats.interactionsToday || 0) + 1;
  store.patch({ stats, pet: { exp: engine.exp, level: engine.level, lastInteractionAt: Date.now() } });
  say(sayText || res.text);
  act('react', { kind: interactionKind });
  broadcastState();
  return res;
}

function todayStr(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function rolloverDay() {
  const today = todayStr();
  const stats = store.get('stats');
  if (stats.day !== today) {
    stats.day = today;
    stats.remindersToday = 0;
    stats.interactionsToday = 0;
    store.patch({ stats });
  }
}

function dndState() {
  const quiet = inQuietHours(store.get('settings.quietHours'), new Date());
  const manual = !!store.get('settings.dndManual', false);
  return { quiet, dnd: manual, manual };
}

function fireReminder(kind) {
  const stats = store.get('stats');
  const text = pick(Math.random, LINES[kind] || LINES.idle);
  stats.remindersToday = (stats.remindersToday || 0) + 1;
  store.patch({ stats });
  act('hop');
  say(text, { kind: 'reminder', sticky: true, duration: 9000 });

  if (store.get('settings.sound', true)) sendToPet('pet:sound', {});
  if (store.get('settings.systemNotify', false) && Notification.isSupported()) {
    const titleMap = { water: '该喝水啦', meal: '饭点到了', stretch: '起来活动一下' };
    new Notification({ title: titleMap[kind] || 'DeskPet', body: text, icon: path.join(ASSETS, 'icon.png') }).show();
  }
  broadcastState();
}

/* ------------------------------ 主循环 ------------------------------ */

function behaviorTick() {
  if (!engine) return;
  try {
    rolloverDay();
    const now = Date.now();
    const idleSec = powerMonitor.getSystemIdleTime();
    const { quiet, dnd } = dndState();
    const ctx = {
      idleSec,
      quiet,
      dnd,
      nowMs: now,
      proactive: store.get('settings.proactive', true) !== false,
      quotaLeft: Math.max(0, store.get('settings.maxRemindersPerDay', 10) - (store.get('stats').remindersToday || 0)),
    };

    const decision = engine.tick(1, ctx);
    if (!dragState && decision) applyDecision(decision);

    const fired = scheduler.poll(now, ctx);
    for (const kind of fired) fireReminder(kind);
  } catch (err) {
    console.error('[behavior] tick error', err);
  }
}

/* ------------------------------ 托盘 ------------------------------ */

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: `DeskPet ${app.getVersion()}`, enabled: false },
    { type: 'separator' },
    {
      label: '显示 / 隐藏',
      click: () => {
        if (!petWin) return;
        if (petWin.isVisible()) petWin.hide();
        else petWin.showInactive();
      },
    },
    { label: '喂点东西', click: () => earnExp('feed') },
    { label: '喝口水', click: () => earnExp('water') },
    { label: '陪它玩', click: () => earnExp('play') },
    { type: 'separator' },
    {
      label: '勿扰模式',
      type: 'checkbox',
      checked: !!store.get('settings.dndManual', false),
      click: (item) => {
        store.set('settings.dndManual', item.checked);
        broadcastState();
      },
    },
    {
      label: '开机自启',
      type: 'checkbox',
      checked: !!store.get('settings.autostart', false),
      click: (item) => {
        store.set('settings.autostart', item.checked);
        applyAutostart(item.checked);
        broadcastState();
      },
    },
    { label: '设置…', click: () => createSettingsWindow() },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]);
}

function refreshTray() {
  if (!tray) return;
  tray.setContextMenu(buildTrayMenu());
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(ASSETS, 'tray.png'));
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon.resize({ width: 16, height: 16 }));
  tray.setToolTip('DeskPet 桌宠');
  refreshTray();
  tray.on('click', () => {
    if (settingsWin && settingsWin.isVisible()) settingsWin.focus();
    else if (petWin) (petWin.isVisible() ? petWin.hide() : petWin.showInactive());
  });
}

function applyAutostart(enabled) {
  if (!app.isPackaged) return; // 开发模式不写注册表
  try {
    app.setLoginItemSettings({ openAtLogin: !!enabled, path: process.execPath, args: [] });
  } catch (err) {
    console.error('[autostart]', err);
  }
}

/* ------------------------------ IPC ------------------------------ */

function registerIpc() {
  ipcMain.handle('state:get', () => buildStatePayload());

  ipcMain.on('pet:click-through', (_e, through) => {
    if (!petWin || petWin.isDestroyed()) return;
    petWin.setIgnoreMouseEvents(!!through, { forward: true });
  });

  ipcMain.on('pet:drag-start', () => {
    if (!petWin) return;
    stopWalk(); // 拖拽优先，避免移动定时器与拖拽抢窗口位置
    const p = screen.getCursorScreenPoint();
    const b = petWin.getBounds();
    dragState = { offsetX: p.x - b.x, offsetY: p.y - b.y, width: b.width, height: b.height };
    petWin.setIgnoreMouseEvents(false);
    if (dragTimer) clearInterval(dragTimer);
    dragTimer = setInterval(() => {
      if (!petWin || petWin.isDestroyed() || !dragState) return endDrag();
      const cur = screen.getCursorScreenPoint();
      petWin.setBounds({
        x: cur.x - dragState.offsetX,
        y: cur.y - dragState.offsetY,
        width: dragState.width,
        height: dragState.height,
      });
    }, 16);
  });

  ipcMain.on('pet:drag-end', () => endDrag());

  ipcMain.on('pet:interact', (_e, kind) => {
    if (!['pet', 'feed', 'water', 'play'].includes(kind)) return;
    earnExp(kind);
  });

  ipcMain.handle('pet:chat', async (_e, text) => {
    const msg = String(text || '').slice(0, 500).trim();
    if (!msg) return { ok: false, error: '说点什么吧' };
    if (!store.get('settings.aiChat', false)) return { ok: false, error: 'AI 对话未开启' };

    const s = store.sanitize().settings;
    const character = activeCharacter();
    const persona = String(store.get('settings.persona', '') || '').trim();
    chatHistory.push({ role: 'user', content: msg });
    chatHistory = chatHistory.slice(-12);
    try {
      const reply = await providers.chat({
        providerId: s.provider.id,
        key: store.getApiKey(),
        baseUrl: s.provider.baseUrl,
        model: store.get('settings.chatModel', ''),
        messages: chatHistory,
        systemPrompt: `你是桌面宠物「${character.name}」，一个可爱的 Q 版小伙伴。用简短、口语化、有温度的中文回应（1-2 句，最多 50 字）。你的等级 Lv.${engine.level}，当前心情 ${engine.mood()}。不要自称 AI，不要输出 markdown。${persona ? `性格设定：${persona}` : ''}`,
      });
      chatHistory.push({ role: 'assistant', content: reply });
      chatHistory = chatHistory.slice(-12);
      const st = store.get('stats');
      st.totalInteractions = (st.totalInteractions || 0) + 1;
      store.patch({ stats: st });
      return { ok: true, reply };
    } catch (err) {
      return { ok: false, error: err.message || '对话失败' };
    }
  });

  ipcMain.on('app:open-settings', () => createSettingsWindow());
  ipcMain.on('app:quit', () => app.quit());

  let menuWatch = null;
  const stopMenuWatch = () => {
    if (menuWatch) clearInterval(menuWatch);
    menuWatch = null;
  };
  const startMenuWatch = () => {
    stopMenuWatch();
    let outside = 0;
    menuWatch = setInterval(() => {
      if (!petWin || petWin.isDestroyed()) return stopMenuWatch();
      const b = petWin.getBounds();
      const p = screen.getCursorScreenPoint();
      const inside = p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height;
      outside = inside ? 0 : outside + 1;
      if (outside >= 2) {
        stopMenuWatch();
        sendToPet('pet:menu-close');
      }
    }, 150);
  };
  ipcMain.on('pet:menu-open', () => startMenuWatch());
  ipcMain.on('pet:menu-closed', () => stopMenuWatch());

  ipcMain.on('pet:focus', () => {
    if (petWin && !petWin.isDestroyed()) petWin.focus();
  });
  ipcMain.handle('app:open-external', (_e, url) => {
    if (/^https?:/.test(String(url))) shell.openExternal(String(url));
  });

  ipcMain.handle('settings:patch', (_e, patch) => {
    if (!patch || typeof patch !== 'object') return buildStatePayload();
    const before = store.get('settings');
    store.patch({ settings: patch });

    const after = store.get('settings');
    if (before.scale !== after.scale && petWin) {
      const { width, height } = petSize();
      const b = petWin.getBounds();
      petWin.setBounds({ x: b.x, y: b.y, width, height });
    }
    if (before.reminders !== after.reminders) scheduler.updateConfig(after.reminders);
    if (before.autostart !== after.autostart) applyAutostart(after.autostart);
    if (before.scale !== after.scale || before.alwaysOnTop !== after.alwaysOnTop) {
      if (petWin) petWin.setAlwaysOnTop(!!after.alwaysOnTop, 'screen-saver');
    }
    broadcastState();
    refreshTray();
    return buildStatePayload();
  });

  ipcMain.handle('settings:set-api-key', (_e, key) => {
    const clean = providers.normalizeKey(key);
    store.setApiKey(clean);
    const providerId = store.get('settings.provider.id', 'ark');
    const check = providers.validateKeyForProvider(providerId, clean);
    broadcastState();
    return {
      hasApiKey: store.hasApiKey(),
      tail: store.getApiKey().slice(-4),
      length: clean.length,
      warning: check.ok ? (check.level === 'warn' ? check.message : '') : check.message,
    };
  });

  ipcMain.handle('settings:test-provider', async () => {
    const s = store.sanitize().settings;
    const pid = s.provider.id;
    const preset = providers.PRESETS[pid] || providers.PRESETS.custom;
    const key = store.getApiKey();
    const baseUrl = s.provider.baseUrl;
    const imageModel = s.provider.model || preset.model;
    // 对话模型存在 settings.chatModel（顶层），兼容旧的 provider.chatModel
    const chatModel = s.chatModel || s.provider.chatModel || preset.chatModel;
    const parts = [];
    try {
      const shape = providers.validateKeyForProvider(pid, key);
      if (!shape.ok) return { ok: false, message: shape.message };

      // 1) 先用免费的模型清单验证「地址 + Key」，顺带核对图像模型是否存在
      const models = await providers.listModels({ providerId: pid, key, baseUrl });
      if (models) {
        parts.push(`接口与 Key 正常（${models.length} 个模型）`);
        if (!imageModel) {
          parts.push('⚠ 未填写图像模型');
        } else if (models.some((m) => m === imageModel)) {
          parts.push(`图像模型 ${imageModel} ✓`);
        } else {
          parts.push(`⚠ 模型清单里没有 ${imageModel}`);
        }
      } else {
        parts.push('该平台不开放模型清单');
      }

      // 2) 有对话模型才真发一句话验证，没有不影响生成形象
      if (chatModel) {
        const reply = await providers.chat({
          providerId: pid,
          key,
          baseUrl,
          model: chatModel,
          messages: [{ role: 'user', content: '你好' }],
          systemPrompt: '只回复两个字：你好',
        });
        parts.push(`对话模型 ${chatModel} ✓（${String(reply).slice(0, 12)}）`);
      } else if (models) {
        parts.push('对话模型未填（不影响生成形象，AI 对话不可用）');
      } else {
        return {
          ok: false,
          message: '无法自动校验：该平台不开放模型清单，且没填对话模型。请直接试生成一张图来确认配置',
        };
      }

      const ok = !parts.some((p) => p.startsWith('⚠'));
      return { ok, message: parts.join(' · ') };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  });

  ipcMain.handle('character:generate', async (_e, { photo, style, extraPrompt }) => {
    const s = store.sanitize().settings;
    const started = Date.now();
    try {
      const res = await providers.generateCharacter({
        providerId: s.provider.id,
        key: store.getApiKey(),
        baseUrl: s.provider.baseUrl,
        model: s.provider.model,
        style,
        extraPrompt,
        photo,
        size: s.provider.imageSize,
      });
      return { ok: true, images: res.images, elapsed: Date.now() - started, provider: s.provider.id };
    } catch (err) {
      return { ok: false, error: err.message || '生成失败' };
    }
  });

  ipcMain.handle('props:list', () => listProps());

  ipcMain.handle('props:toggle', (_e, { id, on }) => {
    if (!id) return { ok: false, error: '缺少道具 id' };
    const idx = readPropsIndex();
    const set = new Set(idx.enabled);
    if (on) set.add(id);
    else set.delete(id);
    idx.enabled = [...set];
    writePropsIndex(idx);
    pushPropsToPet();
    broadcastState();
    return { ok: true, props: listProps() };
  });

  ipcMain.handle('props:add', (_e, { name, dataUrl, anchor: a }) => {
    try {
      const m = /^data:image\/(png|jpeg|webp);base64,(.+)$/.exec(String(dataUrl || ''));
      if (!m) return { ok: false, error: '图像数据无效' };
      const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
      const id = `prop_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
      const file = path.join(propsDir(), `${id}.${ext}`);
      fs.writeFileSync(file, Buffer.from(m[2], 'base64'));
      const idx = readPropsIndex();
      idx.custom.push({ id, name: String(name || '自定义道具').slice(0, 16), anchor: a || 'hand', file });
      idx.enabled.push(id);
      writePropsIndex(idx);
      pushPropsToPet();
      broadcastState();
      return { ok: true, props: listProps() };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('props:delete', (_e, { id }) => {
    const idx = readPropsIndex();
    const item = idx.custom.find((c) => c.id === id);
    if (!item) return { ok: false, error: '只能删除自己生成的道具' };
    try {
      if (item.file && fs.existsSync(item.file)) fs.unlinkSync(item.file);
    } catch {
      /* 文件删不掉也不影响索引更新 */
    }
    idx.custom = idx.custom.filter((c) => c.id !== id);
    idx.enabled = idx.enabled.filter((x) => x !== id);
    writePropsIndex(idx);
    pushPropsToPet();
    broadcastState();
    return { ok: true, props: listProps() };
  });

  ipcMain.handle('props:generate', async (_e, { prompt }) => {
    const s = store.sanitize().settings;
    try {
      const res = await providers.generateAsset({
        providerId: s.provider.id,
        key: store.getApiKey(),
        baseUrl: s.provider.baseUrl,
        model: s.provider.model,
        prompt,
        size: s.provider.imageSize,
      });
      return { ok: true, images: res.images };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('character:save', (_e, { dataUrl, name, builtin }) => {
    try {
      if (builtin) {
        store.patch({
          character: { id: builtin, name: name || '小家伙', file: null, builtin },
          onboarded: true,
        });
        sendToPet('pet:init', { ...buildPetPayload() });
        broadcastState();
        return { ok: true, character: activeCharacter() };
      }
      const m = /^data:image\/png;base64,(.+)$/.exec(String(dataUrl || ''));
      if (!m) return { ok: false, error: '图像数据无效' };
      const id = `char_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
      const dir = path.join(charactersDir(), id);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'sprite.png');
      fs.writeFileSync(file, Buffer.from(m[1], 'base64'));
      fs.writeFileSync(
        path.join(dir, 'meta.json'),
        JSON.stringify({ name: name || '小家伙', createdAt: Date.now(), source: 'ai' }, null, 2),
        'utf8'
      );
      store.patch({ character: { id, name: name || '小家伙', file, builtin: null }, onboarded: true });
      sendToPet('pet:init', { ...buildPetPayload() });
      broadcastState();
      return { ok: true, character: activeCharacter() };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('character:delete', (_e, id) => {
    if (!id || String(id).startsWith('..')) return { ok: false };
    const dir = path.join(charactersDir(), String(id));
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    // 删掉的正好是当前形象 → 回退到内置形象
    if (store.get('character.id') === String(id)) {
      store.patch({ character: { id: 'momo', name: '默默', file: null, builtin: 'momo' } });
      sendToPet('pet:init', buildPetPayload());
    }
    broadcastState();
    return { ok: true };
  });

  ipcMain.handle('character:set-active', (_e, id) => {
    if (!id || String(id).startsWith('..')) return { ok: false };
    const dir = path.join(charactersDir(), String(id));
    const metaFile = path.join(dir, 'meta.json');
    if (!fs.existsSync(metaFile)) return { ok: false, error: '形象不存在' };
    try {
      const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
      store.patch({
        character: { id: String(id), name: meta.name || '小家伙', file: path.join(dir, 'sprite.png'), builtin: null },
        onboarded: true,
      });
      sendToPet('pet:init', buildPetPayload());
      broadcastState();
      return { ok: true, character: activeCharacter() };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('character:rename', (_e, name) => {
    const clean = String(name || '').trim().slice(0, 12);
    if (!clean) return { ok: false, error: '名字不能为空' };
    const cur = store.get('character');
    store.set('character.name', clean);
    // 自定义形象同步写回 meta，换设备/重载后名字不丢
    if (cur.file) {
      const metaFile = path.join(path.dirname(cur.file), 'meta.json');
      if (fs.existsSync(metaFile)) {
        try {
          const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
          meta.name = clean;
          fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2), 'utf8');
        } catch {
          /* 忽略 */
        }
      }
    }
    sendToPet('pet:init', buildPetPayload());
    broadcastState();
    return { ok: true };
  });

  ipcMain.handle('pet:poke', () => {
    act('hop');
    say(pick(Math.random, LINES.idle));
    return { ok: true };
  });

  ipcMain.handle('app:open-data-dir', () => shell.openPath(userDataDir()));

  ipcMain.handle('reminder:test', (_e, kind) => {
    fireReminder(['water', 'meal', 'stretch'].includes(kind) ? kind : 'water');
    return { ok: true };
  });
}

function endDrag() {
  if (dragTimer) clearInterval(dragTimer);
  dragTimer = null;
  dragState = null;
  if (!petWin || petWin.isDestroyed()) return;
  const b = petWin.getBounds();
  const display = screen.getDisplayNearestPoint({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
  const wa = display.workArea;
  const x = Math.max(wa.x - 20, Math.min(wa.x + wa.width - b.width + 20, b.x));
  const y = Math.max(wa.y - 20, Math.min(wa.y + wa.height - b.height + 20, b.y));
  petWin.setBounds({ x: Math.round(x), y: Math.round(y), width: b.width, height: b.height });
  act('land');
  petWin.setIgnoreMouseEvents(true, { forward: true });
}

/* ------------------------------ 冒烟自检 ------------------------------ */

async function runSmoke() {
  const result = { pet: null, settings: null, ipc: null, errors: [] };
  try {
    if (petWin && !petWin.isDestroyed()) {
      result.pet = await petWin.webContents.executeJavaScript('window.__petDebug ? window.__petDebug() : null');
    }
    if (settingsWin && !settingsWin.isDestroyed()) {
      result.settings = await settingsWin.webContents.executeJavaScript(`(() => ({
        navItems: document.querySelectorAll('.nav-item').length,
        cards: document.querySelectorAll('.card').length,
        wizardVisible: !document.getElementById('wizard').classList.contains('hidden'),
        builtinCards: document.querySelectorAll('.bcard').length,
        providers: document.querySelectorAll('.provider').length,
        gallery: document.querySelectorAll('.gitem').length,
        title: document.getElementById('page-title').textContent
      }))()`);
      result.ipc = await settingsWin.webContents.executeJavaScript(
        `window.api.getState().then(s => ({ ok: !!s && !!s.settings, onboarded: s.onboarded, chars: (s.characters||[]).length, presets: Object.keys(s.presets||{}) }))`
      );
    }
  } catch (err) {
    runtimeErrors.push(`smoke: ${err.message}`);
  }
  result.errors = runtimeErrors;
  const ok =
    !!result.pet &&
    result.pet.loaded === true &&
    !!result.settings &&
    result.settings.cards >= 3 &&
    result.settings.providers === 5 &&
    !!result.ipc &&
    result.ipc.ok === true &&
    result.ipc.chars >= 3 &&
    result.errors.length === 0;
  console.log(`SMOKE_RESULT ${JSON.stringify({ ok, ...result })}`);
  setTimeout(() => app.exit(ok ? 0 : 1), 300);
}

/* ------------------------------ 端到端自检 ------------------------------ */

async function runE2E() {
  const results = [];
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const evalIn = (win, code) => win.webContents.executeJavaScript(code);

  async function step(name, fn) {
    try {
      const detail = await fn();
      results.push({ name, ok: true, detail });
    } catch (err) {
      results.push({ name, ok: false, error: err.message || String(err) });
    }
  }
  function expect(cond, msg) {
    if (!cond) throw new Error(msg);
  }

  const settingsJs = 'window.api';

  await step('设置补丁：缩放 1.2 后窗口变宽', async () => {
    await evalIn(settingsWin, `${settingsJs}.patchSettings({ scale: 1.2 })`);
    await wait(300);
    const b = petWin.getBounds();
    expect(b.width === Math.round(BASE_W * 1.2), `实际宽度 ${b.width}`);
    return { width: b.width, height: b.height };
  });

  await step('切换内置形象 lulu 并校验渲染层', async () => {
    const r = await evalIn(settingsWin, `${settingsJs}.saveCharacter({ builtin: 'lulu', name: '露露' })`);
    expect(r.ok, '切换失败');
    await wait(400);
    const d = await evalIn(petWin, 'window.__petDebug()');
    expect(d.imageSrc.includes('lulu'), `渲染层仍是 ${d.imageSrc}`);
    expect(d.loaded === true, '形象未加载完成');
    return { imageSrc: d.imageSrc, name: r.character.name };
  });

  await step('重命名形象', async () => {
    const r = await evalIn(settingsWin, `${settingsJs}.renameCharacter('测试小名')`);
    expect(r.ok, '重命名失败');
    const st = await evalIn(settingsWin, `${settingsJs}.getState()`);
    expect(st.character.name === '测试小名', `实际 ${st.character.name}`);
    await evalIn(settingsWin, `${settingsJs}.renameCharacter('露露')`);
    return st.character.name;
  });

  await step('提醒试发：气泡出现且文字非空', async () => {
    await evalIn(settingsWin, `${settingsJs}.testReminder('water')`);
    await wait(500);
    const d = await evalIn(petWin, 'window.__petDebug()');
    expect(d.bubble && d.bubble.length > 0, '气泡没有出现');
    return d.bubble;
  });

  await step('互动加成：喂食后饥饿值下降、经验增加', async () => {
    const before = await evalIn(settingsWin, `${settingsJs}.getState()`);
    await evalIn(settingsWin, `${settingsJs}.interact ? ${settingsJs}.interact('feed') : null`);
    await wait(200);
    const after = await evalIn(settingsWin, `${settingsJs}.getState()`);
    expect(after.pet.drives.hunger <= before.pet.drives.hunger, '饥饿值未下降');
    expect(after.pet.exp >= before.pet.exp, '经验未增加');
    return { before: before.pet.drives.hunger, after: after.pet.drives.hunger, exp: after.pet.exp };
  });

  await step('AI 关闭时对话被拒绝', async () => {
    const r = await evalIn(settingsWin, `${settingsJs}.chat('你好')`);
    expect(r.ok === false, '未开启 AI 却返回成功');
    return r.error;
  });

  await step('未配 Key 时生成给出明确错误', async () => {
    const r = await evalIn(settingsWin, `${settingsJs}.generateCharacter({ photo: 'data:image/png;base64,AA==', style: 'anime' })`);
    expect(r.ok === false, '无 Key 却生成成功');
    expect(/API Key/.test(r.error), `错误信息不可读: ${r.error}`);
    return r.error;
  });

  await step('API Key 加密落盘（无明文）', async () => {
    await evalIn(settingsWin, `${settingsJs}.setApiKey('sk-e2e-secret-7788')`);
    const raw = fs.readFileSync(path.join(userDataDir(), 'state.json'), 'utf8');
    expect(!raw.includes('sk-e2e-secret-7788'), '磁盘出现明文 Key');
    const enc = /"keyEncrypted":\s*true/.test(raw);
    await evalIn(settingsWin, `${settingsJs}.setApiKey('')`);
    return { encrypted: enc };
  });

  await step('保存配置：状态广播不会清空已填的 URL / 模型', async () => {
    const r = await settingsWin.webContents.executeJavaScript(`(async () => {
      const $ = (s) => document.querySelector(s);
      $('#base-url').value = 'https://relay.example.com';
      $('#image-model').value = 'grok-imagine-image-2.0';
      $('#chat-model').value = 'deepseek-v4.1-flash';
      $('#api-key').value = 'sk-e2e-race-0011';
      $('#btn-save-provider').click();
      await new Promise((res) => setTimeout(res, 900));
      return {
        baseUrl: $('#base-url').value,
        model: $('#image-model').value,
        chatModel: $('#chat-model').value,
      };
    })()`);
    expect(r.baseUrl === 'https://relay.example.com', `Base URL 被清空：${JSON.stringify(r.baseUrl)}`);
    expect(r.model === 'grok-imagine-image-2.0', `图像模型被清空：${JSON.stringify(r.model)}`);
    expect(r.chatModel === 'deepseek-v4.1-flash', `对话模型被清空：${JSON.stringify(r.chatModel)}`);
    const s = store.get('settings');
    expect(s.provider.baseUrl === 'https://relay.example.com', 'Base URL 未落盘');
    expect(s.provider.model === 'grok-imagine-image-2.0', '图像模型未落盘');
    expect(s.chatModel === 'deepseek-v4.1-flash', '对话模型未落盘');
    return r;
  });

  await step('行走：窗口横向位移生效', async () => {
    const before = petWin.getBounds();
    startWalk(before.x > screen.getPrimaryDisplay().workArea.x + 200 ? before.x - 160 : before.x + 160);
    await wait(900);
    const after = petWin.getBounds();
    stopWalk();
    expect(after.x !== before.x, '窗口未移动');
    return { from: before.x, to: after.x };
  });

  await step('动作库：≥20 个动作且能切换播放', async () => {
    const dbg = await evalIn(petWin, 'window.__petDebug()');
    expect(dbg.clips >= 20, `动作数量不足：${dbg.clips}`);
    const ok = await evalIn(petWin, `window.__petPlay('dance')`);
    await wait(120);
    const after = await evalIn(petWin, 'window.__petDebug()');
    expect(ok === true, '动作播放失败');
    expect(after.clip === 'dance', `动作未生效：${after.clip}`);
    await evalIn(petWin, `window.__petPlay('idle')`);
    return { clips: dbg.clips };
  });

  await step('碰撞箱：身体中下部（脖子以下）可命中', async () => {
    const r = await evalIn(
      petWin,
      `(() => {
        const d = window.__petDebug();
        const cx = d.w / 2;
        const pts = {
          head: [cx, d.h * 0.22],
          neck: [cx, d.h * 0.42],
          body: [cx, d.h * 0.62],
          leg: [cx, d.h * 0.80],
        };
        const out = {};
        for (const [k, [x, y]] of Object.entries(pts)) out[k] = window.__petHit(x, y);
        out.far = window.__petHit(4, 4);
        return out;
      })()`
    );
    expect(r.body === true, '身体中部无法命中');
    expect(r.leg === true, '腿部无法命中');
    expect(r.far === false, '窗口角落不应命中');
    return r;
  });

  await step('右键菜单包含退出项且可关闭', async () => {
    const html = await evalIn(petWin, `document.getElementById('menu').innerHTML`);
    const r = { hasQuit: /退出桌宠/.test(html), hasSettings: /设置/.test(html) };
    expect(r.hasQuit, '右键菜单缺少退出项');
    expect(r.hasSettings, '右键菜单缺少设置项');
    return r;
  });

  await step('对话输入框可关闭', async () => {
    const r = await evalIn(
      petWin,
      `(async () => {
        const bar = document.getElementById('chatbar');
        const close = document.getElementById('chat-close');
        bar.classList.add('show');
        bar.classList.remove('hidden');
        const before = bar.classList.contains('show');
        close.click();
        await new Promise((r) => setTimeout(r, 120));
        return { before, after: bar.classList.contains('show'), hasClose: !!close };
      })()`
    );
    expect(r.hasClose, '缺少关闭按钮');
    expect(r.before === true, '输入框未打开');
    expect(r.after === false, '点击关闭后输入框仍显示');
    return r;
  });

  await step('随身道具：内置 6 个且切换后同步到桌宠', async () => {
    const list = await evalIn(settingsWin, `window.api.listProps()`);
    expect(Array.isArray(list) && list.length >= 6, `内置道具不足：${list && list.length}`);
    const r = await evalIn(settingsWin, `window.api.toggleProp('cup', true)`);
    expect(r.ok, '切换道具失败');
    await wait(250);
    const dbg = await evalIn(petWin, 'window.__petDebug()');
    expect(dbg.props.includes('cup'), `道具未同步：${JSON.stringify(dbg.props)}`);
    await evalIn(settingsWin, `window.api.toggleProp('cup', false)`);
    await wait(200);
    const after = await evalIn(petWin, 'window.__petDebug()');
    expect(!after.props.includes('cup'), '取下后道具仍在');
    return { total: list.length, on: dbg.props };
  });

  await step('右键菜单：光标离开窗口后自动关闭', async () => {
    // 把窗口挪到离真实光标最远的角落，确保光标一定在窗口外
    const before = petWin.getBounds();
    const wa = screen.getPrimaryDisplay().workArea;
    const cur = screen.getCursorScreenPoint();
    const leftX = wa.x + 4;
    const rightX = wa.x + wa.width - before.width - 4;
    const topY = wa.y + 4;
    const bottomY = wa.y + wa.height - before.height - 4;
    const x = Math.abs(cur.x - leftX) > Math.abs(cur.x - rightX) ? leftX : rightX;
    const y = Math.abs(cur.y - topY) > Math.abs(cur.y - bottomY) ? topY : bottomY;
    petWin.setBounds({ x, y, width: before.width, height: before.height });
    await wait(200);
    await evalIn(
      petWin,
      `(() => {
        const m = document.getElementById('menu');
        m.classList.remove('hidden');
        m.classList.add('show');
        window.api.menuOpened();
        return true;
      })()`
    );
    const opened = await evalIn(petWin, `document.getElementById('menu').classList.contains('show')`);
    expect(opened === true, '菜单未打开');
    await wait(900);
    const open = await evalIn(petWin, `document.getElementById('menu').classList.contains('show')`);
    petWin.setBounds(before);
    expect(open === false, '光标离开后菜单仍未关闭');
    return { opened, closed: !open };
  });

  await step('渲染进程无控制台错误', async () => {
    expect(runtimeErrors.length === 0, runtimeErrors.join(' | '));
    return runtimeErrors.length;
  });

  const ok = results.every((r) => r.ok);
  console.log(`E2E_RESULT ${JSON.stringify({ ok, passed: results.filter((r) => r.ok).length, total: results.length, results })}`);
  setTimeout(() => app.exit(ok ? 0 : 1), 300);
}

/* ------------------------------ 启动 ------------------------------ */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (petWin) petWin.showInactive();
    createSettingsWindow();
  });

  app.whenReady().then(() => {
    app.setAppUserModelId('com.deskpet.app');
    store = new Store(path.join(userDataDir(), 'state.json'), { safeStorage });

    const saved = store.get('pet.drives');
    engine = new BehaviorEngine({
      drives: saved,
      level: store.get('pet.level', 1),
      exp: store.get('pet.exp', 0),
    });
    scheduler = new ReminderScheduler({ reminders: store.get('settings.reminders') });

    registerIpc();
    createPetWindow();
    createTray();
    rolloverDay();

    setInterval(behaviorTick, 1000);
    persistTimer = setInterval(() => {
      if (engine) {
        store.patch({ pet: { drives: engine.drives, exp: engine.exp, level: engine.level } });
      }
    }, 60000);

    applyAutostart(store.get('settings.autostart', false));

    // 首次启动直接打开引导
    if (!store.get('onboarded', false)) createSettingsWindow();

    if (process.env.DESKPET_SMOKE === '1') setTimeout(runSmoke, 7000);
    if (process.env.DESKPET_E2E === '1') setTimeout(runE2E, 5000);
  });

  app.on('window-all-closed', () => {
    // 桌宠常驻托盘：窗口关闭不退出进程（订阅此事件即接管默认退出行为）
  });

  app.on('before-quit', () => {
    if (engine) store.patch({ pet: { drives: engine.drives, exp: engine.exp, level: engine.level } });
    if (movingTimer) clearInterval(movingTimer);
    if (dragTimer) clearInterval(dragTimer);
    if (persistTimer) clearInterval(persistTimer);
  });

  app.on('activate', () => {
    if (!petWin) createPetWindow();
  });
}
