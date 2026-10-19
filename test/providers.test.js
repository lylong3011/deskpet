'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  PRESETS,
  STYLES,
  buildPrompt,
  dataUrlToBuffer,
  ApiError,
  normalizeKey,
  normalizeBase,
  sniffMime,
  friendlyApiMessage,
  validateKeyForProvider,
  generateCharacter,
  chat,
  listModels,
  generateAsset,
} = require('../electron/providers');

test('平台预设齐全，必填字段完整', () => {
  for (const id of ['ark', 'openai', 'dashscope', 'gemini', 'custom']) {
    const p = PRESETS[id];
    assert.ok(p, `缺少预设 ${id}`);
    assert.ok(p.label, `${id} 缺少 label`);
    assert.ok(p.kind, `${id} 缺少 kind`);
    assert.ok(typeof p.supportsReference === 'boolean', `${id} 缺少 supportsReference`);
  }
});

test('画风预设包含 4 种风格', () => {
  assert.deepStrictEqual(Object.keys(STYLES).sort(), ['anime', 'line', 'pixel', 'soft3d']);
  for (const s of Object.values(STYLES)) assert.ok(s.label && s.prompt);
});

test('生成提示词强制要求纯白背景与全身', () => {
  const p = buildPrompt('anime');
  assert.match(p, /#FFFFFF/);
  assert.match(p, /pure solid white/i);
  assert.match(p, /full body/i);
  assert.match(p, /chibi/i);
});

test('未知画风回退到默认风格，不抛错', () => {
  const p = buildPrompt('不存在的风格');
  assert.match(p, /chibi/i);
});

test('额外描述被拼接且长度受控', () => {
  const p = buildPrompt('anime', '戴圆框眼镜');
  assert.match(p, /戴圆框眼镜/);
  const long = buildPrompt('anime', 'x'.repeat(1000));
  assert.ok(long.length < 1200, '超长描述应被截断');
});

test('dataUrl 解析成功与失败', () => {
  const png = 'data:image/png;base64,' + Buffer.from('hello').toString('base64');
  const r = dataUrlToBuffer(png);
  assert.strictEqual(r.mime, 'image/png');
  assert.strictEqual(r.buffer.toString(), 'hello');
  assert.throws(() => dataUrlToBuffer('not-a-data-url'), ApiError);
  assert.throws(() => dataUrlToBuffer(''), ApiError);
});

test('ApiError 携带可读信息', () => {
  const e = new ApiError('测试错误');
  assert.strictEqual(e.name, 'ApiError');
  assert.strictEqual(e.message, '测试错误');
  assert.ok(e instanceof Error);
});

/* ---------------- Key / Base URL 归一化 ---------------- */

test('Key 清洗：空白、引号、Bearer 前缀、零宽字符、换行', () => {
  assert.strictEqual(normalizeKey('  sk-abc123  '), 'sk-abc123');
  assert.strictEqual(normalizeKey('"sk-abc123"'), 'sk-abc123');
  assert.strictEqual(normalizeKey('Bearer sk-abc123'), 'sk-abc123');
  assert.strictEqual(normalizeKey('bearer   sk-abc123'), 'sk-abc123');
  assert.strictEqual(normalizeKey('sk-abc\n123'), 'sk-abc123');
  assert.strictEqual(normalizeKey('sk-abc\u200b123'), 'sk-abc123');
  assert.strictEqual(normalizeKey('sk abc 123'), 'skabc123');
  assert.strictEqual(normalizeKey(null), '');
  assert.strictEqual(normalizeKey(undefined), '');
});

test('Base URL 归一化：裸域名自动补 /v1', () => {
  assert.strictEqual(normalizeBase('https://relay.example.com/'), 'https://relay.example.com/v1');
  assert.strictEqual(normalizeBase('https://relay.example.com'), 'https://relay.example.com/v1');
  assert.strictEqual(normalizeBase('https://relay.example.com/v1'), 'https://relay.example.com/v1');
  assert.strictEqual(normalizeBase('https://relay.example.com/v1/'), 'https://relay.example.com/v1');
  assert.strictEqual(normalizeBase('https://api.openai.com/v1'), 'https://api.openai.com/v1');
  assert.strictEqual(normalizeBase('https://ark.cn-beijing.volces.com/api/v3'), 'https://ark.cn-beijing.volces.com/api/v3');
  assert.strictEqual(normalizeBase('https://generativelanguage.googleapis.com/v1beta'), 'https://generativelanguage.googleapis.com/v1beta');
  assert.strictEqual(normalizeBase(''), '');
});

test('图片类型嗅探：JPEG 不会被当成 PNG', () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]);
  assert.strictEqual(sniffMime(jpeg), 'image/jpeg');
  assert.strictEqual(sniffMime(png), 'image/png');
  assert.strictEqual(sniffMime(webp), 'image/webp');
  assert.strictEqual(sniffMime(Buffer.alloc(0)), 'image/png');
});

test('服务端错误翻译成人话', () => {
  const m1 = friendlyApiMessage('The API key format is incorrect. Request id: 0217923', 401);
  assert.match(m1, /选错了家|格式不对/);
  const m2 = friendlyApiMessage('invalid api key', 401);
  assert.match(m2, /无效|禁用/);
  const m3 = friendlyApiMessage('', 404);
  assert.match(m3, /Base URL|\/v1/);
  const m4 = friendlyApiMessage('model not found', 400);
  assert.match(m4, /模型名/);
});

test('Key 与平台不匹配时提前拦截', () => {
  const arkWithSk = validateKeyForProvider('ark', 'sk-demo-PLACEHOLDER-0001');
  assert.strictEqual(arkWithSk.ok, false);
  assert.match(arkWithSk.message, /自定义|中转站/);

  const custom = validateKeyForProvider('custom', 'sk-demo-PLACEHOLDER-0001');
  assert.strictEqual(custom.ok, true);

  const openaiOk = validateKeyForProvider('openai', 'sk-proj-xxxx');
  assert.strictEqual(openaiOk.ok, true);

  const geminiWarn = validateKeyForProvider('gemini', 'sk-wrong');
  assert.strictEqual(geminiWarn.ok, true);
  assert.strictEqual(geminiWarn.level, 'warn');

  const empty = validateKeyForProvider('ark', '   ');
  assert.strictEqual(empty.ok, false);
});

test('模型名为空时提前给出明确错误，不发请求', async () => {
  await assert.rejects(
    () => generateCharacter({ providerId: 'custom', key: 'sk-test', baseUrl: 'https://x.example.com', model: '' }),
    (err) => {
      assert.ok(err instanceof ApiError);
      assert.match(err.message, /图像模型名/);
      return true;
    }
  );
  await assert.rejects(
    () => chat({ providerId: 'custom', key: 'sk-test', baseUrl: 'https://x.example.com', model: '', messages: [] }),
    (err) => {
      assert.match(err.message, /对话模型名/);
      return true;
    }
  );
});

test('listModels：自动补 /v1 并解析模型清单', async () => {
  const orig = global.fetch;
  let seenUrl = '';
  let seenAuth = '';
  global.fetch = async (url, init) => {
    seenUrl = String(url);
    seenAuth = (init && init.headers && init.headers.Authorization) || '';
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({ data: [{ id: 'm-a' }, { id: 'm-b' }] }),
      text: async () => JSON.stringify({ data: [{ id: 'm-a' }, { id: 'm-b' }] }),
    };
  };
  try {
    const list = await listModels({ providerId: 'custom', key: 'sk-x', baseUrl: 'https://relay.test/' });
    assert.deepStrictEqual(list, ['m-a', 'm-b']);
    assert.strictEqual(seenUrl, 'https://relay.test/v1/models');
    assert.strictEqual(seenAuth, 'Bearer sk-x');
  } finally {
    global.fetch = orig;
  }
});

test('listModels：接口不可用时返回 null 而不是抛错', async () => {
  const orig = global.fetch;
  global.fetch = async () => ({ ok: false, status: 404, headers: { get: () => '' }, text: async () => '', json: async () => ({}) });
  try {
    assert.strictEqual(await listModels({ providerId: 'ark', key: 'k', baseUrl: '' }), null);
  } finally {
    global.fetch = orig;
  }
});

test('generateAsset：缺描述或缺模型时给出明确错误且不发请求', async () => {
  const orig = global.fetch;
  let called = 0;
  global.fetch = async () => {
    called++;
    return { ok: true, status: 200, headers: { get: () => '' }, text: async () => '{}', json: async () => ({}) };
  };
  try {
    await assert.rejects(
      () => generateAsset({ providerId: 'custom', key: 'sk-test', baseUrl: 'https://x.test', model: 'm', prompt: '   ' }),
      (err) => {
        assert.match(err.message, /描述道具/);
        return true;
      }
    );
    await assert.rejects(
      () => generateAsset({ providerId: 'custom', key: 'sk-test', baseUrl: 'https://x.test', model: '', prompt: '一杯奶茶' }),
      (err) => {
        assert.match(err.message, /图像模型名/);
        return true;
      }
    );
    assert.strictEqual(called, 0, '参数不全时不应该发请求');
  } finally {
    global.fetch = orig;
  }
});
