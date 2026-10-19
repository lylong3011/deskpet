'use strict';
/**
 * 图像 / 对话能力适配层。
 * 支持：火山方舟 Seedream、OpenAI gpt-image、阿里云百炼通义万相、Google Gemini、任意 OpenAI 兼容自定义接口。
 */

const PRESETS = {
  ark: {
    label: '火山方舟 · Seedream',
    kind: 'ark',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    model: 'doubao-seedream-4-0-250828',
    chatModel: 'doubao-seed-1-6-250615',
    keyHint: '在火山方舟控制台创建 API Key',
    supportsReference: true,
  },
  openai: {
    label: 'OpenAI · gpt-image-1',
    kind: 'openai-images',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-image-1',
    chatModel: 'gpt-4o-mini',
    keyHint: 'platform.openai.com 的 sk- 开头的 Key',
    supportsReference: true,
  },
  dashscope: {
    label: '阿里云百炼 · 通义万相',
    kind: 'dashscope',
    baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
    model: 'wanx2.1-t2i-turbo',
    chatModel: 'qwen-plus',
    keyHint: '百炼控制台的 sk- 开头 Key',
    supportsReference: false,
  },
  gemini: {
    label: 'Google · Gemini 图像',
    kind: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    model: 'gemini-2.5-flash-image-preview',
    chatModel: 'gemini-2.5-flash',
    keyHint: 'AI Studio 获取的 API Key',
    supportsReference: true,
  },
  custom: {
    label: '自定义（OpenAI 兼容）',
    kind: 'openai-images',
    baseUrl: '',
    model: '',
    chatModel: '',
    keyHint: '填写中转站或自建服务的 Base URL 与模型名',
    supportsReference: true,
  },
};

const STYLES = {
  anime: {
    label: '日系 Q 版',
    prompt:
      'Japanese anime chibi style, 2.5-head proportion, big head and small body, soft cel shading, clean thin outlines, sparkly eyes, pastel colors',
  },
  soft3d: {
    label: '软萌 3D',
    prompt:
      'soft 3D render, cute mascot, rounded shapes, pastel clay material, subsurface scattering, soft studio lighting, Pixar-like',
  },
  pixel: {
    label: '像素风',
    prompt: '16-bit pixel art sprite, crisp pixel edges, limited palette, retro game sticker, clean silhouette',
  },
  line: {
    label: '简笔贴纸',
    prompt: 'minimal flat vector illustration, thick clean outlines, flat pastel fills, memoji sticker style',
  },
};

function buildPrompt(styleKey, extra) {
  const s = STYLES[styleKey] || STYLES.anime;
  return [
    'Convert the person in the reference photo into a cute chibi cartoon character.',
    s.prompt + '.',
    'Preserve recognizable traits: hairstyle, hair color, glasses, accessories, clothing color.',
    'Front view, standing, full body including feet, centered composition, friendly cheerful expression.',
    'The background MUST be pure solid white #FFFFFF, no shadow, no gradient, no text, no watermark, no border, no frame.',
    'Exactly one character, high quality, sticker style.',
    extra ? String(extra).slice(0, 300) : '',
  ]
    .filter(Boolean)
    .join(' ');
}

class ApiError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'ApiError';
    this.detail = detail;
  }
}

/** 清洗 Key：去首尾空白/引号、去 Bearer 前缀、去零宽字符与中间换行 */
function normalizeKey(raw) {
  let k = String(raw ?? '');
  k = k.replace(/[\u200b-\u200f\ufeff]/g, '');
  k = k.replace(/[\r\n\t]/g, '').trim();
  k = k.replace(/^["'`]+/, '').replace(/["'`]+$/, '').trim();
  k = k.replace(/^Bearer\s+/i, '').trim();
  return k.replace(/\s+/g, '');
}

/**
 * 归一化 Base URL：只填域名时自动补 /v1；已带版本段（/v1、/v1beta、/api/v3）则原样使用
 */
function normalizeBase(base) {
  let b = String(base || '').trim();
  if (!b) return '';
  b = b.replace(/\/+$/, '');
  if (/\/(v\d+[a-z0-9]*|api\/v\d+)$/i.test(b)) return b;
  if (/\/(v\d+[a-z0-9]*)\//i.test(b)) return b;
  return `${b}/v1`;
}

/** 按文件头判断图片类型，避免把 JPEG 当 PNG */
function sniffMime(buf) {
  if (!buf || buf.length < 12) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (buf.slice(0, 3).toString('ascii') === 'GIF') return 'image/gif';
  return 'image/png';
}

/** 服务端错误 → 可执行的中文提示 */
function friendlyApiMessage(raw, status) {
  const s = String(raw || '');
  if (/api.?key\s*format\s*is\s*incorrect/i.test(s)) {
    return '平台认为 API Key 格式不对：八成是「形象生成平台」选错了家。火山方舟的 Key 不能用在中转站上，中转站的 sk- Key 也不能填在方舟里。请到设置里确认平台与 Key 是同一家';
  }
  if (/invalid.?api.?key|incorrect.?api.?key|unauthorized|auth.*fail/i.test(s)) {
    return 'API Key 无效或已被禁用，请回平台后台重新复制（注意不要漏字符）';
  }
  if (/insufficient|quota|balance|欠费/i.test(s)) return '账户额度不足或已欠费，请到平台充值';
  if (/model.*(not\s*found|not\s*exist|unsupported|invalid)/i.test(s)) {
    return '模型名不可用：请核对「图像模型 / 对话模型」是否与平台模型列表完全一致';
  }
  if (status === 401) return 'API Key 未通过鉴权（401），请检查 Key 与平台是否匹配';
  if (status === 404) return '接口地址不存在（404）：Base URL 一般要包含 /v1，例如 https://your-host/v1';
  return s.slice(0, 300) || `HTTP ${status}`;
}

/**
 * 发送前的 Key 形态检查：只拦「明显填错家」的情况，其余给出提醒
 * @returns {{ok:boolean, level?:'error'|'warn', message?:string}}
 */
function validateKeyForProvider(providerId, key) {
  const k = normalizeKey(key);
  if (!k) return { ok: false, level: 'error', message: '还没有填写 API Key' };
  if (providerId === 'ark' && /^sk-/.test(k)) {
    return {
      ok: false,
      level: 'error',
      message:
        '这把 Key 以 sk- 开头，是 OpenAI 兼容中转站的 Key，但当前平台选的是「火山方舟」。请把平台切换为「自定义（OpenAI 兼容）」并填写 Base URL，或改用方舟控制台自己的 Key',
    };
  }
  if ((providerId === 'openai' || providerId === 'dashscope') && !/^sk-/.test(k)) {
    return { ok: true, level: 'warn', message: '这类平台的 Key 通常以 sk- 开头，请确认没有填错。' };
  }
  if (providerId === 'gemini' && !/^(AIza|AQ\.)/.test(k)) {
    return { ok: true, level: 'warn', message: 'Gemini 的 Key 通常以 AIza 开头，请确认。' };
  }
  return { ok: true };
}

function dataUrlToBuffer(dataUrl) {
  const m = /^data:([^;]+);base64,(.*)$/.exec(String(dataUrl || ''));
  if (!m) throw new ApiError('参考图格式不正确，请重新上传');
  return { mime: m[1], buffer: Buffer.from(m[2], 'base64') };
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 120000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } catch (err) {
    if (err.name === 'AbortError') throw new ApiError('请求超时，请检查网络或稍后重试');
    throw new ApiError(`网络请求失败：${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

async function readJson(res) {
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { _raw: text };
  }
  if (!res.ok) {
    const msg =
      (data.error && (data.error.message || data.error.code)) ||
      data.message ||
      data._raw ||
      `HTTP ${res.status}`;
    const friendly = friendlyApiMessage(msg, res.status);
    throw new ApiError(`服务返回错误（${res.status}）：${friendly}`, { raw: String(msg).slice(0, 500) });
  }
  return data;
}

async function downloadAsDataUrl(url) {
  const res = await fetchWithTimeout(url, {}, 60000);
  if (!res.ok) throw new ApiError(`下载生成结果失败（${res.status}）`);
  const buf = Buffer.from(await res.arrayBuffer());
  const mime = res.headers.get('content-type') || 'image/png';
  return `data:${mime};base64,${buf.toString('base64')}`;
}

async function extractImages(data) {
  const list = (data && (data.data || data.images || data.output?.results)) || [];
  const out = [];
  for (const item of list) {
    if (typeof item === 'string') {
      out.push(item.startsWith('data:') ? item : await downloadAsDataUrl(item));
      continue;
    }
    if (item && item.b64_json) {
      const buf = Buffer.from(item.b64_json, 'base64');
      out.push(`data:${sniffMime(buf)};base64,${item.b64_json}`);
      continue;
    }
    if (item && item.url) {
      out.push(await downloadAsDataUrl(item.url));
    }
  }
  if (!out.length) throw new ApiError('接口未返回图像，请检查模型名是否支持图像生成');
  return out;
}

/* ------------------------- 各平台实现 ------------------------- */

async function openaiImages({ key, baseUrl, model, prompt, photo, size }) {
  const base = normalizeBase(baseUrl);
  if (!base) throw new ApiError('请先填写 Base URL');
  if (!model) throw new ApiError('请先填写模型名');

  if (photo) {
    const { buffer } = dataUrlToBuffer(photo);
    const form = new FormData();
    form.append('model', model);
    form.append('prompt', prompt);
    form.append('n', '1');
    form.append('size', size || '1024x1024');
    form.append('image', new Blob([buffer], { type: 'image/png' }), 'reference.png');
    const res = await fetchWithTimeout(`${base}/images/edits`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: form,
    });
    return extractImages(await readJson(res));
  }

  const res = await fetchWithTimeout(`${base}/images/generations`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt, n: 1, size: size || '1024x1024' }),
  });
  return extractImages(await readJson(res));
}

async function arkImages({ key, baseUrl, model, prompt, photo, size }) {
  const base = normalizeBase(baseUrl || PRESETS.ark.baseUrl);
  const body = {
    model: model || PRESETS.ark.model,
    prompt,
    size: size || '1024x1024',
    response_format: 'b64_json',
    watermark: false,
  };
  if (photo) body.image = [photo];
  const res = await fetchWithTimeout(
    `${base}/images/generations`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    150000
  );
  return extractImages(await readJson(res));
}

async function dashscopeImages({ key, baseUrl, model, prompt, photo, size }) {
  const base = normalizeBase(baseUrl || PRESETS.dashscope.baseUrl);
  const sz = String(size || '1024*1024').replace('x', '*');
  const submit = await fetchWithTimeout(`${base}/services/aigc/text2image/image-synthesis`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      'X-DashScope-Async': 'enable',
    },
    body: JSON.stringify({
      model: model || PRESETS.dashscope.model,
      input: { prompt: photo ? prompt : prompt },
      parameters: { size: sz, n: 1 },
    }),
  });
  const submitted = await readJson(submit);
  const taskId = submitted.output && submitted.output.task_id;
  if (!taskId) throw new ApiError('提交任务失败，未获得 task_id');

  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2500));
    const res = await fetchWithTimeout(`${base}/tasks/${taskId}`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    const data = await readJson(res);
    const status = data.output && data.output.task_status;
    if (status === 'SUCCEEDED') {
      const results = (data.output.results || []).map((r) => r.url).filter(Boolean);
      if (!results.length) throw new ApiError('任务成功但没有返回图片');
      const out = [];
      for (const u of results) out.push(await downloadAsDataUrl(u));
      return out;
    }
    if (status === 'FAILED' || status === 'CANCELED') {
      throw new ApiError(`生成失败：${data.output?.message || status}`);
    }
  }
  throw new ApiError('生成超时（180 秒），请稍后在设置页重试');
}

async function geminiImages({ key, baseUrl, model, prompt, photo }) {
  const base = normalizeBase(baseUrl || PRESETS.gemini.baseUrl);
  const m = model || PRESETS.gemini.model;
  const parts = [{ text: prompt }];
  if (photo) {
    const { mime, buffer } = dataUrlToBuffer(photo);
    parts.push({ inline_data: { mime_type: mime, data: buffer.toString('base64') } });
  }
  const res = await fetchWithTimeout(
    `${base}/models/${encodeURIComponent(m)}:generateContent?key=${encodeURIComponent(key)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts }],
        generationConfig: { responseModalities: ['IMAGE', 'TEXT'] },
      }),
    },
    150000
  );
  const data = await readJson(res);
  const cands = data.candidates || [];
  const out = [];
  for (const c of cands) {
    for (const p of c.content?.parts || []) {
      const inline = p.inlineData || p.inline_data;
      if (inline && inline.data) {
        out.push(`data:${inline.mimeType || inline.mime_type || 'image/png'};base64,${inline.data}`);
      }
    }
  }
  if (!out.length) {
    const txt = cands[0]?.content?.parts?.map((p) => p.text).filter(Boolean).join(' ') || '';
    throw new ApiError(`未返回图像${txt ? `：${txt.slice(0, 160)}` : ''}`);
  }
  return out;
}

const IMAGE_IMPL = {
  'openai-images': openaiImages,
  ark: arkImages,
  dashscope: dashscopeImages,
  gemini: geminiImages,
};

/**
 * 生成角色图
 * @returns {Promise<{images: string[], preset: object}>}
 */
async function generateCharacter({ providerId = 'ark', key, baseUrl, model, style = 'anime', extraPrompt = '', photo, size }) {
  const preset = PRESETS[providerId] || PRESETS.custom;
  const apiKey = normalizeKey(key);
  const check = validateKeyForProvider(providerId, apiKey);
  if (!check.ok) throw new ApiError(check.message);
  const impl = IMAGE_IMPL[preset.kind];
  if (!impl) throw new ApiError(`暂不支持该平台：${providerId}`);
  if (!preset.supportsReference && photo) {
    // 通义万相纯文生图：只能按文字描述生成，给出提示但不阻断
    // eslint-disable-next-line no-console
    console.warn('[provider] 当前平台不支持参考图，将仅按文字描述生成');
  }
  const prompt = buildPrompt(style, extraPrompt);
  const imageModel = model || preset.model;
  if (!imageModel) {
    throw new ApiError('还没有填写图像模型名：请在设置里选好平台，或手动填写模型名（例如 grok-imagine-image-2.0）');
  }
  let images;
  try {
    images = await impl({
      key: apiKey,
      baseUrl: baseUrl || preset.baseUrl,
      model: imageModel,
      prompt,
      photo,
      size,
    });
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(`生成失败：${err.message}`);
  }
  return { images, preset: { ...preset, id: providerId } };
}

/**
 * 生成单个道具/贴图（无人物）。用于「手持水杯」这类可挂载的小物件。
 * 输出仍是纯白背景，调用方再做抠白底
 */
async function generateAsset({ providerId = 'custom', key, baseUrl, model, prompt, photo, size }) {
  const preset = PRESETS[providerId] || PRESETS.custom;
  const apiKey = normalizeKey(key);
  const check = validateKeyForProvider(providerId, apiKey);
  if (!check.ok) throw new ApiError(check.message);
  const impl = IMAGE_IMPL[preset.kind];
  if (!impl) throw new ApiError(`暂不支持该平台：${providerId}`);
  const imageModel = model || preset.model;
  if (!imageModel) throw new ApiError('还没有填写图像模型名：请在设置里配置后再生成道具');
  const text = String(prompt || '').trim().slice(0, 200);
  if (!text) throw new ApiError('请先描述道具长什么样');
  const full = [
    `A single cute chibi cartoon prop: ${text}.`,
    'Sticker style, thick clean outline, soft shading, pastel palette, front view, centered, filling most of the frame.',
    'NO human, NO hands, NO face, NO text, NO watermark, NO border, NO frame.',
    'The background MUST be pure solid white #FFFFFF, no shadow, no gradient.',
  ].join(' ');
  let images;
  try {
    images = await impl({ key: apiKey, baseUrl: baseUrl || preset.baseUrl, model: imageModel, prompt: full, photo, size });
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(`生成失败：${err.message}`);
  }
  return { images };
}

/**
 * 拉取平台模型清单（免费、不消耗额度），用于「测试连接」时校验 Key 与模型名
 * 不支持或不开放该接口的平台返回 null
 */
async function listModels({ providerId = 'custom', key, baseUrl }) {
  const preset = PRESETS[providerId] || PRESETS.custom;
  if (preset.kind === 'gemini' || preset.kind === 'dashscope') return null;
  const base = normalizeBase(baseUrl || preset.baseUrl);
  if (!base) return null;
  try {
    const res = await fetchWithTimeout(
      `${base}/models`,
      { method: 'GET', headers: { Authorization: `Bearer ${normalizeKey(key)}` } },
      20000
    );
    if (!res.ok) return null;
    const data = await readJson(res);
    const arr = Array.isArray(data && data.data) ? data.data : Array.isArray(data) ? data : null;
    if (!arr) return null;
    return arr.map((m) => m.id || m.model || m.name).filter(Boolean);
  } catch {
    return null;
  }
}

/* ------------------------- 对话 ------------------------- */
const CHAT_BASE = {
  ark: (base) => `${base}/chat/completions`,
  dashscope: () => 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
  openai: (base) => `${base}/chat/completions`,
  custom: (base) => `${base}/chat/completions`,
};

async function chat({ providerId = 'ark', key, baseUrl, model, messages, systemPrompt }) {
  const preset = PRESETS[providerId] || PRESETS.custom;
  const apiKey = normalizeKey(key);
  const check = validateKeyForProvider(providerId, apiKey);
  if (!check.ok) throw new ApiError(check.message.replace('「形象」页', '设置里'));
  const m = model || preset.chatModel;
  if (!m) throw new ApiError('请先在设置中填写对话模型名');

  if (preset.kind === 'gemini') {
    const base = normalizeBase(baseUrl || preset.baseUrl);
    const res = await fetchWithTimeout(
      `${base}/models/${encodeURIComponent(m)}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: messages.map((x) => ({
            role: x.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: x.content }],
          })),
        }),
      },
      60000
    );
    const data = await readJson(res);
    const text = (data.candidates?.[0]?.content?.parts || [])
      .map((p) => p.text)
      .filter(Boolean)
      .join(' ');
    if (!text) throw new ApiError('模型没有返回内容');
    return text.trim();
  }

  const base = normalizeBase(baseUrl || preset.baseUrl);
  const makeUrl = CHAT_BASE[providerId] || CHAT_BASE.custom;
  const url = providerId === 'dashscope' ? CHAT_BASE.dashscope() : makeUrl(base);
  const res = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: m,
        messages: [{ role: 'system', content: systemPrompt }, ...messages],
        temperature: 0.9,
        max_tokens: 220,
      }),
    },
    60000
  );
  const data = await readJson(res);
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new ApiError('模型没有返回内容');
  return String(text).trim();
}

module.exports = {
  PRESETS,
  STYLES,
  ApiError,
  buildPrompt,
  generateCharacter,
  generateAsset,
  chat,
  dataUrlToBuffer,
  normalizeKey,
  normalizeBase,
  sniffMime,
  friendlyApiMessage,
  validateKeyForProvider,
  listModels,
};
