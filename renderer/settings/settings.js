'use strict';
/* 设置窗口逻辑：表单绑定 / 新手向导 / 裁剪 / 生成 / 抠白底 */
(() => {
  const api = window.api;
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));

  let ST = null;
  let providerId = 'ark';
  // 表单有未保存改动时，禁止状态广播触发的重渲染覆盖用户输入
  let providerDirty = false;
  let styleKey = 'anime';
  let step = 1;
  let generated = [];
  let chosen = null;
  let crop = { img: null, zoom: 1.4, ox: 0, oy: 0, dragging: false, lastX: 0, lastY: 0 };

  /* ------------------------------ 工具 ------------------------------ */
  const getPath = (obj, p) => p.split('.').reduce((a, k) => (a == null ? a : a[k]), obj);

  function nest(p, v) {
    const parts = p.split('.');
    const out = {};
    let cur = out;
    parts.forEach((k, i) => {
      if (i === parts.length - 1) cur[k] = v;
      else cur = cur[k] = {};
    });
    return out;
  }

  let toastTimer = null;
  function toast(msg, isErr = false) {
    const el = $('#toast');
    el.textContent = msg;
    el.className = `toast show${isErr ? ' err' : ''}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
  }

  async function save(patch) {
    ST = await api.patchSettings(patch);
    renderSide();
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('图片加载失败'));
      img.src = src;
    });
  }

  /* ------------------------------ 渲染 ------------------------------ */
  function renderSide() {
    if (!ST) return;
    const c = ST.character;
    $('#side-avatar').src = c.idle || '';
    $('#side-name').textContent = c.name || '小家伙';
    $('#side-level').textContent = `Lv.${ST.pet?.level ?? 1} · ${ST.pet?.exp ?? 0} 经验`;
    $('#current-img').src = c.idle || '';
    $('#char-source').textContent =
      c.kind === 'builtin' ? '当前使用内置形象，上传照片可以生成专属形象。' : '当前使用 AI 生成的专属形象。';
    renderDrives($('#side-drives'), [
      ['口渴', ST.pet?.drives?.thirst, ''],
      ['饥饿', ST.pet?.drives?.hunger, ''],
      ['精力', ST.pet?.drives?.energy, 'energy'],
      ['好感', ST.pet?.drives?.affection, 'affection'],
    ]);
    renderDrives($('#drives-big'), [
      ['口渴度', ST.pet?.drives?.thirst, ''],
      ['饥饿度', ST.pet?.drives?.hunger, ''],
      ['精力', ST.pet?.drives?.energy, 'energy'],
      ['无聊', ST.pet?.drives?.boredom, 'boredom'],
      ['好感度', ST.pet?.drives?.affection, 'affection'],
    ]);
  }

  function renderDrives(host, rows) {
    if (!host) return;
    host.innerHTML = '';
    for (const [label, val, cls] of rows) {
      const row = document.createElement('div');
      row.className = 'drive';
      const l = document.createElement('span');
      l.textContent = label;
      const bar = document.createElement('div');
      bar.className = `bar ${cls}`;
      const fill = document.createElement('i');
      fill.style.width = `${Math.max(0, Math.min(100, Number(val) || 0))}%`;
      bar.appendChild(fill);
      row.append(l, bar);
      host.appendChild(row);
    }
  }

  function renderGallery() {
    const host = $('#gallery');
    host.innerHTML = '';
    const list = (ST?.characters || []).slice().sort((a, b) => (a.builtin === b.builtin ? 0 : a.builtin ? 1 : -1));
    for (const item of list) {
      const el = document.createElement('div');
      el.className = `gitem${item.id === ST.character.id ? ' on' : ''}`;
      const img = document.createElement('img');
      img.src = item.url;
      img.alt = item.name || '';
      const name = document.createElement('span');
      name.textContent = item.name || '未命名';
      el.append(img, name);

      el.addEventListener('click', async () => {
        if (item.id === ST.character.id) return;
        if (item.builtin) {
          const r = await api.saveCharacter({ builtin: item.id, name: item.name });
          if (r.ok) toast(`已切换到「${item.name}」`);
        } else {
          const r = await api.setActiveCharacter(item.id);
          if (r.ok) toast(`已切换到「${item.name}」`);
          else toast('切换失败', true);
        }
        ST = await api.getState();
        renderAll();
      });

      if (!item.builtin) {
        const del = document.createElement('button');
        del.className = 'del';
        del.textContent = '×';
        del.title = '删除这个形象';
        del.addEventListener('click', async (e) => {
          e.stopPropagation();
          const r = await api.deleteCharacter(item.id);
          if (r.ok) {
            toast('已删除');
            ST = await api.getState();
            renderAll();
          }
        });
        el.appendChild(del);
      }
      host.appendChild(el);
    }
  }

  function renderProviders() {
    const host = $('#providers');
    host.innerHTML = '';
    for (const [id, p] of Object.entries(ST.presets)) {
      const btn = document.createElement('button');
      btn.className = `provider${id === providerId ? ' on' : ''}`;
      const b = document.createElement('b');
      b.textContent = p.label;
      const s = document.createElement('span');
      s.textContent = p.keyHint;
      btn.append(b, s);
      btn.addEventListener('click', () => {
        providerId = id;
        providerDirty = false;
        renderProviders();
        fillProviderFields(true);
      });
      host.appendChild(btn);
    }
  }

  function fillProviderFields(usePresetDefaults = false) {
    const preset = ST.presets[providerId] || ST.presets.custom;
    const prov = ST.settings.provider;
    $('#base-url').placeholder = preset.baseUrl || 'https://your-endpoint/v1';
    $('#image-model').placeholder = preset.model || '模型名';
    $('#chat-model').placeholder = preset.chatModel || '模型名';
    $('#base-url').value = usePresetDefaults ? '' : prov.baseUrl || '';
    $('#image-model').value = usePresetDefaults ? '' : prov.model || '';
    $('#chat-model').value = ST.settings.chatModel || '';
    $('#api-key').value = '';
    $('#api-key').placeholder = prov.hasApiKey ? `已保存（尾号 ${prov.apiKeyTail}），留空则不修改` : '粘贴你的 API Key';
    const tag = $('#key-status');
    tag.textContent = prov.hasApiKey ? '已配置' : '未配置';
    tag.className = `tag${prov.hasApiKey ? ' ok' : ''}`;
    renderProviderDiag();
  }

  /** 把当前平台 / 实际调用域名 / Key 状态摊开，出错时能自己定位 */
  function renderProviderDiag() {
    const preset = ST.presets[providerId] || ST.presets.custom;
    const prov = ST.settings.provider;
    const raw = ($('#base-url').value || '').trim() || preset.baseUrl || '';
    let host = '';
    try {
      let b = raw.replace(/\/+$/, '');
      if (b && !/\/(v\d+[a-z0-9]*|api\/v\d+)$/i.test(b)) b += '/v1';
      host = new URL(b).host + new URL(b).pathname.replace(/\/$/, '');
    } catch {
      host = raw ? '地址无法解析' : '地址未填写';
    }
    const keyState = prov.hasApiKey ? `Key 尾号 ${prov.apiKeyTail}${prov.keyEncrypted ? '（已加密）' : '（明文）'}` : 'Key 未填写';
    $('#provider-diag').textContent = `当前：${preset.label} · 接口 ${host} · ${keyState}`;
  }

  function showProviderWarning(msg) {
    const el = $('#provider-warn');
    if (!msg) {
      el.classList.add('hidden');
      el.textContent = '';
      return;
    }
    el.textContent = `⚠ ${msg}`;
    el.classList.remove('hidden');
  }

  function renderForms() {
    const s = ST.settings;
    providerId = s.provider.id || 'ark';
    renderProviders();
    fillProviderFields();

    $('#pet-name').value = ST.character.name || '';
    $('#remind-enabled').checked =
      !!s.reminders?.water?.enabled || !!s.reminders?.meal?.enabled || !!s.reminders?.stretch?.enabled;
    $$('[data-r]').forEach((el) => {
      const v = getPath(s, `reminders.${el.dataset.r}`);
      if (el.type === 'checkbox') el.checked = !!v;
      else el.value = v ?? '';
    });
    $('#max-reminders').value = s.maxRemindersPerDay ?? 10;
    $('#opt-sound').checked = !!s.sound;
    $('#opt-notify').checked = !!s.systemNotify;
    $('#quiet-enabled').checked = !!s.quietHours?.enabled;
    $('#quiet-start').value = s.quietHours?.start || '23:00';
    $('#quiet-end').value = s.quietHours?.end || '08:00';
    $('#opt-dnd').checked = !!s.dndManual;
    $('#opt-ai').checked = !!s.aiChat;
    $('#opt-top').checked = !!s.alwaysOnTop;
    $('#opt-autostart').checked = !!s.autostart;
    $('#opt-proactive').checked = s.proactive !== false;
    $('#opt-scale').value = Math.round((s.scale || 1) * 100);
    $('#scale-val').textContent = `${Math.round((s.scale || 1) * 100)}%`;
    $('#pet-persona').value = s.persona || '';
    $('#ver').textContent = `v${ST.version}`;
  }

  function renderAll() {
    renderSide();
    renderGallery();
    renderProps();
    renderForms();
  }

  /* ------------------------------ 随身道具 ------------------------------ */
  function propCards() {
    return Array.isArray(ST && ST.props) ? ST.props : [];
  }

  function renderProps() {
    const host = $('#props-grid');
    if (!host) return;
    host.innerHTML = '';
    const list = propCards();
    if (!list.length) {
      const tip = document.createElement('p');
      tip.className = 'hint';
      tip.textContent = '还没有道具，先在下面生成一个吧。';
      host.appendChild(tip);
      return;
    }
    for (const p of list) {
      const b = document.createElement('button');
      b.className = `prop-card${p.enabled ? ' on' : ''}`;
      b.title = p.enabled ? '点击取下' : '点击携带';
      const img = document.createElement('img');
      img.src = p.url;
      img.alt = p.name;
      const name = document.createElement('b');
      name.textContent = p.name;
      b.append(img, name);
      if (!p.builtin) {
        const del = document.createElement('span');
        del.className = 'prop-del';
        del.textContent = '×';
        del.title = '删除这个道具';
        del.addEventListener('click', async (ev) => {
          ev.stopPropagation();
          const r = await api.deleteProp(p.id);
          if (!r.ok) return toast(r.error || '删除失败', true);
          ST.props = r.props;
          renderProps();
          toast('已删除');
        });
        b.appendChild(del);
      }
      b.addEventListener('click', async () => {
        const r = await api.toggleProp(p.id, !p.enabled);
        if (!r.ok) return toast(r.error || '切换失败', true);
        ST.props = r.props;
        renderProps();
        renderSide();
      });
      host.appendChild(b);
    }
  }

  $('#btn-gen-prop').addEventListener('click', async () => {
    const prompt = $('#prop-prompt').value.trim();
    const msg = $('#prop-msg');
    if (!prompt) return toast('先描述一下想要的道具', true);
    if (!ST.settings.provider.hasApiKey) return toast('先去「形象」页配好 API Key', true);
    const btn = $('#btn-gen-prop');
    btn.disabled = true;
    msg.textContent = '正在生成…通常 10–30 秒';
    try {
      const res = await api.generateProp(prompt);
      if (!res.ok) {
        msg.textContent = res.error || '生成失败';
        return;
      }
      const processed = await processCharacter(res.images[0]);
      const add = await api.addProp({ name: prompt.slice(0, 12), dataUrl: processed, anchor: 'hand' });
      if (!add.ok) {
        msg.textContent = add.error || '保存失败';
        return;
      }
      ST.props = add.props;
      renderProps();
      msg.textContent = '已生成并戴上啦';
      $('#prop-prompt').value = '';
    } catch (err) {
      msg.textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });

  /* ------------------------------ 导航 ------------------------------ */
  const TAB_TITLES = { look: '形象与外观', remind: '提醒', smart: '智能对话', general: '通用', about: '关于' };

  $$('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      $$('.nav-item').forEach((b) => b.classList.toggle('active', b === btn));
      const tab = btn.dataset.tab;
      $$('.panel').forEach((p) => p.classList.toggle('active', p.dataset.panel === tab));
      $('#page-title').textContent = TAB_TITLES[tab] || '';
      $('.content').scrollTop = 0;
    });
  });

  /* ------------------------------ 基础表单 ------------------------------ */
  function bindCheck(sel, path) {
    const el = $(sel);
    el.addEventListener('change', () => save(nest(path, el.checked)));
  }

  function bindInput(sel, path, transform = (v) => v, event = 'change') {
    const el = $(sel);
    el.addEventListener(event, () => save(nest(path, transform(el.value))));
  }

  bindCheck('#opt-sound', 'sound');
  bindCheck('#opt-notify', 'systemNotify');
  bindCheck('#opt-ai', 'aiChat');
  bindCheck('#opt-top', 'alwaysOnTop');
  bindCheck('#opt-autostart', 'autostart');
  bindCheck('#opt-proactive', 'proactive');
  bindCheck('#opt-dnd', 'dndManual');
  bindCheck('#quiet-enabled', 'quietHours.enabled');
  bindInput('#quiet-start', 'quietHours.start');
  bindInput('#quiet-end', 'quietHours.end');
  bindInput('#max-reminders', 'maxRemindersPerDay', (v) => Math.max(1, Math.min(40, Number(v) || 10)));

  $('#opt-scale').addEventListener('input', (e) => {
    $('#scale-val').textContent = `${e.target.value}%`;
  });  $('#opt-scale').addEventListener('change', (e) => save(nest('scale', Number(e.target.value) / 100)));

  $$('[data-r]').forEach((el) => {
    const path = `reminders.${el.dataset.r}`;
    el.addEventListener('change', () => {
      const val = el.type === 'checkbox' ? el.checked : Math.max(1, Number(el.value) || 1);
      save(nest(path, val));
    });
  });

  // 总开关：一键启停三类提醒
  $('#remind-enabled').addEventListener('change', (e) => {
    const on = e.target.checked;
    $$('[data-r$=".enabled"]').forEach((el) => {
      el.checked = on;
    });
    save({ reminders: { water: { enabled: on }, meal: { enabled: on }, stretch: { enabled: on } } });
  });

  $$('[data-test]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await api.testReminder(btn.dataset.test);
      toast('已让它提醒你一次');
    });
  });

  $('#btn-say').addEventListener('click', async () => {
    await api.pokePet();
    toast('看看屏幕右下角');
  });

  $('#btn-save-name').addEventListener('click', async () => {
    const name = $('#pet-name').value.trim();
    if (!name) return toast('名字不能为空', true);
    const r = await api.renameCharacter(name);
    if (r.ok) {
      ST = await api.getState();
      renderAll();
      toast('名字已保存');
    }
  });

  $('#btn-save-provider').addEventListener('click', async () => {
    // 先把表单值全部取下来：下面任何 await 都可能触发状态广播并重渲染表单
    const form = {
      key: $('#api-key').value.trim(),
      baseUrl: $('#base-url').value.trim(),
      model: $('#image-model').value.trim(),
      chatModel: $('#chat-model').value.trim(),
    };
    let warning = '';
    if (form.key) {
      const r = await api.setApiKey(form.key);
      warning = (r && r.warning) || '';
    }
    await save(
      nest('provider', {
        id: providerId,
        baseUrl: form.baseUrl,
        model: form.model,
      })
    );
    await save(nest('chatModel', form.chatModel));
    ST = await api.getState();
    providerDirty = false;
    renderForms();
    // 兜底：确保输入框显示的就是刚存下的值，不被任何重渲染抹掉
    $('#base-url').value = form.baseUrl;
    $('#image-model').value = form.model;
    $('#chat-model').value = form.chatModel;
    showProviderWarning(warning);
    toast(warning ? '已保存，但配置可能不匹配' : '配置已保存');
  });

  $('#btn-test-provider').addEventListener('click', async () => {
    const msgEl = $('#provider-msg');
    msgEl.textContent = '测试中…';
    msgEl.style.color = 'var(--muted)';
    const r = await api.testProvider();
    msgEl.textContent = r.message;
    msgEl.style.color = r.ok ? 'var(--ok)' : '#d9502f';
    if (!r.ok) showProviderWarning('连接失败，看下面这行的接口地址和 Key 尾号是否与平台一致');
  });

  $('#base-url').addEventListener('input', () => renderProviderDiag());
  ['#base-url', '#image-model', '#chat-model', '#api-key'].forEach((sel) => {
    $(sel).addEventListener('input', () => {
      providerDirty = true;
    });
  });
  $('#api-key').addEventListener('change', () => {
    const v = $('#api-key').value.trim();
    if (!v) return;
    const preset = ST.presets[providerId] || ST.presets.custom;
    if (providerId === 'ark' && /^sk-/.test(v)) {
      showProviderWarning('这把 Key 以 sk- 开头，是中转站/OpenAI 的 Key，不该填在火山方舟里。请切到「自定义（OpenAI 兼容）」。');
    } else if (preset.kind === 'openai-images' && providerId !== 'custom' && !/^sk-/.test(v)) {
      showProviderWarning(`${preset.label} 的 Key 一般以 sk- 开头，请确认没粘错。`);
    } else {
      showProviderWarning('');
    }
  });

  $('#btn-save-persona').addEventListener('click', async () => {
    await save(nest('persona', $('#pet-persona').value.trim()));
    toast('性格设定已保存');
  });

  $('#btn-data-dir').addEventListener('click', () => api.openDataDir());  $('#btn-reset-wizard').addEventListener('click', () => openWizard());
  $('#btn-quit').addEventListener('click', () => api.quit());
  $('#btn-open-wizard').addEventListener('click', () => openWizard());

  /* ------------------------------ 向导 ------------------------------ */
  function renderWzProviders() {
    const host = $('#wz-providers');
    if (!host) return;
    host.innerHTML = '';
    for (const [id, p] of Object.entries(ST.presets)) {
      const b = document.createElement('button');
      b.className = `provider${id === providerId ? ' on' : ''}`;
      const t = document.createElement('b');
      t.textContent = p.label;
      const h = document.createElement('span');
      h.textContent = p.keyHint;
      b.append(t, h);
      b.addEventListener('click', () => {
        providerId = id;
        providerDirty = false;
        renderWzProviders();
        fillWzFields();
      });
      host.appendChild(b);
    }
  }

  function fillWzFields() {
    const preset = ST.presets[providerId] || ST.presets.custom;
    const prov = ST.settings.provider;
    const mine = prov.id === providerId;
    $('#wz-base-url').value = mine ? prov.baseUrl || '' : '';
    $('#wz-base-url').placeholder = preset.baseUrl || 'https://your-host/v1';
    $('#wz-image-model').value = mine ? prov.model || '' : '';
    $('#wz-image-model').placeholder = preset.model ? `例如 ${preset.model}` : '平台模型列表里的 id';
    $('#wz-chat-model').value = ST.settings.chatModel || '';
    $('#wz-chat-model').placeholder = preset.chatModel ? `例如 ${preset.chatModel}` : '可留空，只影响 AI 对话';
    $('#wz-api-key').value = '';
    $('#wz-api-key').placeholder = prov.hasApiKey ? `已保存（尾号 ${prov.apiKeyTail}），留空则不修改` : '粘贴你的 API Key';
    $('#wz-test-msg').textContent = '';
  }

  function readWzConfig() {
    return {
      key: $('#wz-api-key').value.trim(),
      baseUrl: $('#wz-base-url').value.trim(),
      model: $('#wz-image-model').value.trim(),
      chatModel: $('#wz-chat-model').value.trim(),
    };
  }

  async function saveWzConfig(cfg) {
    let warning = '';
    if (cfg.key) {
      const r = await api.setApiKey(cfg.key);
      warning = (r && r.warning) || '';
    }
    await save(nest('provider', { id: providerId, baseUrl: cfg.baseUrl, model: cfg.model }));
    if (cfg.chatModel) await save(nest('chatModel', cfg.chatModel));
    ST = await api.getState();
    return warning;
  }

  $('#wz-test').addEventListener('click', async () => {
    const cfg = readWzConfig();
    const msg = $('#wz-test-msg');
    if (!cfg.key && !ST.settings.provider.hasApiKey) return toast('先粘贴 API Key', true);
    if (!cfg.model) return toast('先填图像模型名', true);
    msg.textContent = '测试中…';
    await saveWzConfig(cfg);
    const r = await api.testProvider();
    msg.textContent = r.message;
    msg.style.color = r.ok ? 'var(--ok)' : '#d9502f';
  });

  function openWizard() {
    $('#wizard').classList.remove('hidden');
    providerId = ST.settings.provider.id || providerId;
    renderWzProviders();
    fillWzFields();
    setStep(1);
  }
  function closeWizard() {
    $('#wizard').classList.add('hidden');
  }

  $('#wz-close').addEventListener('click', () => {
    if (!ST.onboarded && !ST.character) return toast('先把接口和形象配好，它才能动起来～', true);
    closeWizard();
  });

  function setStep(n) {
    step = n;
    $$('.step').forEach((el) => el.classList.toggle('active', Number(el.dataset.step) === n));
    $$('#wz-dots i').forEach((el, i) => el.classList.toggle('on', i < n));
    $('#wz-back').style.visibility = n === 1 ? 'hidden' : 'visible';
    $('#wz-next').textContent = n === 4 ? '用它' : n === 5 ? '完成' : '下一步';
    $('#wz-next').disabled = false;
    $('#wz-tip').textContent = '';
    if (n === 4 && !generated.length) $('#wz-next').disabled = true;
  }

  $('#wz-back').addEventListener('click', () => {
    if (step > 1) setStep(step - 1);
    if (step === 3) drawCrop();
  });

  $('#wz-next').addEventListener('click', async () => {
    if (step === 1) {
      const cfg = readWzConfig();
      if (!cfg.key && !ST.settings.provider.hasApiKey) return toast('先粘贴 API Key', true);
      if (!cfg.model) return toast('先填图像模型名（平台模型列表里的 id）', true);
      const warning = await saveWzConfig(cfg);
      if (warning) toast(warning, true);
      setStep(2);
      return;
    }
    if (step === 2) {
      if (!crop.img) return toast('请先选择一张照片', true);
      setStep(3);
      drawCrop();
      return;
    }
    if (step === 3) {
      await generate();
      return;
    }
    if (step === 4) {
      if (!chosen) return toast('先生成一个形象', true);
      setStep(5);
      $('#final-img').src = chosen;
      return;
    }
    if (step === 5) {
      const name = $('#final-name').value.trim() || '小家伙';
      const r = await api.saveCharacter({ dataUrl: chosen, name });
      if (!r.ok) return toast(r.error || '保存失败', true);
      ST = await api.getState();
      renderAll();
      closeWizard();
      toast('形象已就位，去桌面看看吧');
    }
  });

  /* ------------------------------ 选照片 ------------------------------ */
  $('#dropzone').addEventListener('click', () => $('#file-input').click());

  $('#file-input').addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) loadPhoto(file);
  });

  const dz = $('#dropzone');
  dz.addEventListener('dragover', (e) => {
    e.preventDefault();
    dz.classList.add('over');
  });
  dz.addEventListener('dragleave', () => dz.classList.remove('over'));
  dz.addEventListener('drop', (e) => {
    e.preventDefault();
    dz.classList.remove('over');
    const file = e.dataTransfer.files?.[0];
    if (file) loadPhoto(file);
  });

  async function loadPhoto(file) {
    if (!file.type.startsWith('image/')) return toast('请选择图片文件', true);
    if (file.size > 12 * 1024 * 1024) return toast('图片太大了（>12MB）', true);
    const url = URL.createObjectURL(file);
    try {
      const img = await loadImage(url);
      if (img.width < 200 || img.height < 200) return toast('图片分辨率太低了', true);
      crop.img = img;
      crop.zoom = 1.4;
      crop.ox = 0;
      crop.oy = 0;
      setStep(3);
      drawCrop();
    } catch (err) {
      toast(err.message, true);
    } finally {
      URL.revokeObjectURL(url);
    }
  }


  /* ------------------------------ 裁剪 ------------------------------ */
  function drawCrop() {
    const cv = $('#crop-canvas');
    const c = cv.getContext('2d');
    const size = 300;
    c.clearRect(0, 0, size, size);
    c.fillStyle = '#efe8e2';
    c.fillRect(0, 0, size, size);
    if (!crop.img) {
      c.fillStyle = '#b9aca4';
      c.font = '13px "Microsoft YaHei UI", sans-serif';
      c.textAlign = 'center';
      c.fillText('还没有选择照片', size / 2, size / 2);
      return;
    }
    const base = Math.max(size / crop.img.width, size / crop.img.height);
    const s = base * crop.zoom;
    const w = crop.img.width * s;
    const h = crop.img.height * s;
    c.drawImage(crop.img, size / 2 - w / 2 + crop.ox, size / 2 - h / 2 + crop.oy, w, h);

    // 圆形取景提示
    c.save();
    c.fillStyle = 'rgba(20, 15, 12, 0.36)';
    c.beginPath();
    c.rect(0, 0, size, size);
    c.arc(size / 2, size / 2, 118, 0, Math.PI * 2, true);
    c.fill('evenodd');
    c.strokeStyle = 'rgba(255, 122, 89, 0.95)';
    c.lineWidth = 2;
    c.beginPath();
    c.arc(size / 2, size / 2, 118, 0, Math.PI * 2);
    c.stroke();
    c.restore();
  }

  const cv = $('#crop-canvas');
  cv.addEventListener('pointerdown', (e) => {
    if (!crop.img) return;
    crop.dragging = true;
    crop.lastX = e.clientX;
    crop.lastY = e.clientY;
    cv.setPointerCapture(e.pointerId);
  });
  cv.addEventListener('pointermove', (e) => {
    if (!crop.dragging) return;
    crop.ox += e.clientX - crop.lastX;
    crop.oy += e.clientY - crop.lastY;
    crop.lastX = e.clientX;
    crop.lastY = e.clientY;
    drawCrop();
  });
  cv.addEventListener('pointerup', () => (crop.dragging = false));
  cv.addEventListener('wheel', (e) => {
    if (!crop.img) return;
    e.preventDefault();
    crop.zoom = Math.max(1, Math.min(3.2, crop.zoom * (e.deltaY > 0 ? 0.94 : 1.06)));
    $('#crop-zoom').value = Math.round(crop.zoom * 100);
    drawCrop();
  }, { passive: false });

  $('#crop-zoom').addEventListener('input', (e) => {
    crop.zoom = Number(e.target.value) / 100;
    drawCrop();
  });

  function exportCrop(size = 1024) {
    const out = document.createElement('canvas');
    out.width = size;
    out.height = size;
    const c = out.getContext('2d');
    c.fillStyle = '#ffffff';
    c.fillRect(0, 0, size, size);
    const k = size / 300;
    const base = Math.max(size / crop.img.width, size / crop.img.height);
    const s = base * crop.zoom;
    const w = crop.img.width * s;
    const h = crop.img.height * s;
    c.drawImage(crop.img, size / 2 - w / 2 + crop.ox * k, size / 2 - h / 2 + crop.oy * k, w, h);
    return out.toDataURL('image/png');
  }

  /* ------------------------------ 画风 ------------------------------ */
  function renderStyles() {
    const host = $('#style-chips');
    host.innerHTML = '';
    for (const [key, s] of Object.entries(ST.styles)) {
      const btn = document.createElement('button');
      btn.className = `chip${key === styleKey ? ' on' : ''}`;
      btn.textContent = s.label;
      btn.addEventListener('click', () => {
        styleKey = key;
        renderStyles();
      });
      host.appendChild(btn);
    }
  }

  /* ------------------------------ 生成 ------------------------------ */
  async function generate() {
    if (!crop.img) return toast('请先选择照片', true);
    setStep(4);
    $('#gen-spinner').classList.remove('hidden');
    $('#result-grid').innerHTML = '';
    $('#gen-status').textContent = '正在请求图像模型，通常 10–40 秒…';
    $('#wz-next').disabled = true;
    generated = [];
    chosen = null;

    const photo = exportCrop(1024);
    const res = await api.generateCharacter({ photo, style: styleKey, extraPrompt: $('#extra-prompt').value.trim() });

    if (!res.ok) {
      $('#gen-spinner').classList.add('hidden');
      $('#gen-status').textContent = `生成失败：${res.error}`;
      $('#wz-tip').textContent = '可返回上一步检查平台配置';
      return;
    }

    $('#gen-status').textContent = '正在处理透明背景…';
    for (const raw of res.images) {
      try {
        const processed = await processCharacter(raw);
        generated.push(processed);
      } catch (err) {
        console.warn('处理失败', err);
      }
    }
    $('#gen-spinner').classList.add('hidden');
    if (!generated.length) {
      $('#gen-status').textContent = '图片处理失败，可重试一次';
      return;
    }
    $('#gen-status').textContent = `生成完成（${(res.elapsed / 1000).toFixed(1)} 秒），挑一个喜欢的`;
    renderResults();
    selectResult(0);
    $('#wz-next').disabled = false;
  }

  function renderResults() {
    const host = $('#result-grid');
    host.innerHTML = '';
    generated.forEach((url, i) => {
      const item = document.createElement('div');
      item.className = 'ritem';
      const img = document.createElement('img');
      img.src = url;
      item.appendChild(img);
      item.addEventListener('click', () => selectResult(i));
      host.appendChild(item);
    });
  }

  function selectResult(i) {
    chosen = generated[i];
    $$('#result-grid .ritem').forEach((el, idx) => el.classList.toggle('on', idx === i));
  }

  /* ------------------------------ 抠白底 + 裁边 ------------------------------ */
  function isBgPixel(d, i) {
    const r = d[i];
    const g = d[i + 1];
    const b = d[i + 2];
    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    return mn > 226 && mx - mn < 26;
  }

  async function processCharacter(dataUrl) {
    const img = await loadImage(dataUrl);
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    const cv2 = document.createElement('canvas');
    cv2.width = w;
    cv2.height = h;
    const c2 = cv2.getContext('2d', { willReadFrequently: true });
    c2.drawImage(img, 0, 0);

    const id = c2.getImageData(0, 0, w, h);
    const d = id.data;
    const total = w * h;
    const seen = new Uint8Array(total);
    const stack = [];

    for (let x = 0; x < w; x++) {
      stack.push(x, (h - 1) * w + x);
    }
    for (let y = 0; y < h; y++) {
      stack.push(y * w, y * w + w - 1);
    }

    // 从边缘洪水填充去除纯白背景
    while (stack.length) {
      const idx = stack.pop();
      if (idx < 0 || idx >= total || seen[idx]) continue;
      const i = idx * 4;
      if (!isBgPixel(d, i)) continue;
      seen[idx] = 1;
      d[i + 3] = 0;
      const x = idx % w;
      const y = (idx - x) / w;
      if (x > 0) stack.push(idx - 1);
      if (x < w - 1) stack.push(idx + 1);
      if (y > 0) stack.push(idx - w);
      if (y < h - 1) stack.push(idx + w);
    }

    // 边缘羽化：贴着透明区的浅色像素半透明，减轻锯齿
    for (let idx = 0; idx < total; idx++) {
      const i = idx * 4;
      if (d[i + 3] === 0) continue;
      const x = idx % w;
      const y = (idx - x) / w;
      let near = false;
      if (x > 0 && d[(idx - 1) * 4 + 3] === 0) near = true;
      else if (x < w - 1 && d[(idx + 1) * 4 + 3] === 0) near = true;
      else if (y > 0 && d[(idx - w) * 4 + 3] === 0) near = true;
      else if (y < h - 1 && d[(idx + w) * 4 + 3] === 0) near = true;
      if (near && isBgPixel(d, i)) d[i + 3] = 90;
    }

    c2.putImageData(id, 0, 0);

    // 裁掉四周空白
    let minX = w;
    let minY = h;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (d[(y * w + x) * 4 + 3] > 12) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < minX || maxY < minY) return dataUrl; // 没抠出主体，保留原图

    const pad = Math.round(Math.max(maxX - minX, maxY - minY) * 0.045);
    const sx = Math.max(0, minX - pad);
    const sy = Math.max(0, minY - pad);
    const sw = Math.min(w - sx, maxX - minX + 1 + pad * 2);
    const sh = Math.min(h - sy, maxY - minY + 1 + pad * 2);

    const out = document.createElement('canvas');
    out.width = sw;
    out.height = sh;
    const oc = out.getContext('2d');
    oc.drawImage(cv2, sx, sy, sw, sh, 0, 0, sw, sh);
    return out.toDataURL('image/png');
  }

  /* ------------------------------ 启动 ------------------------------ */
  async function boot() {
    ST = await api.getState();
    renderAll();
    renderStyles();
    if (!ST.onboarded) openWizard();

    api.onState((payload) => {
      if (!payload) return;
      ST = { ...ST, ...payload };
      renderSide();
      renderGallery();
      renderProps();
      // 用户正在输入或表单有未保存改动时不要重置表单，避免打字被打断 / 已填内容被抹掉
      const el = document.activeElement;
      const typing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA');
      if ($('#wizard').classList.contains('hidden') && !typing && !providerDirty) renderForms();
    });
  }

  boot().catch((err) => {
    console.error(err);
    toast(`初始化失败：${err.message}`, true);
  });
})();
