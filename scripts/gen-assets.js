// 生成图标 PNG 与提示音 WAV（零依赖）。用法: node scripts/gen-assets.js
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const OUT_ASSETS = path.join(__dirname, '..', 'assets');
const OUT_BUILD = path.join(__dirname, '..', 'build');
fs.mkdirSync(OUT_ASSETS, { recursive: true });
fs.mkdirSync(OUT_BUILD, { recursive: true });

/* ---------------- PNG ---------------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePNG(w, h, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/** 4x 超采样绘制一个圆脸小宠物图标 */
function drawIcon(size) {
  const SS = 4;
  const W = size * SS;
  const buf = new Float32Array(W * W * 4); // premultiplied-ish accum

  const cx = W / 2;
  const cy = W / 2;
  const rHead = W * 0.40;

  function put(x, y, r, g, b, a) {
    if (x < 0 || y < 0 || x >= W || y >= W) return;
    const i = (y * W + x) * 4;
    const sa = a;
    const da = buf[i + 3];
    const oa = sa + da * (1 - sa);
    if (oa <= 0) return;
    buf[i] = (r * sa + buf[i] * da * (1 - sa)) / oa;
    buf[i + 1] = (g * sa + buf[i + 1] * da * (1 - sa)) / oa;
    buf[i + 2] = (b * sa + buf[i + 2] * da * (1 - sa)) / oa;
    buf[i + 3] = oa;
  }

  function circle(mx, my, rad, col) {
    const [r, g, b] = col;
    const x0 = Math.floor(mx - rad), x1 = Math.ceil(mx + rad);
    const y0 = Math.floor(my - rad), y1 = Math.ceil(my + rad);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const d = Math.hypot(x + 0.5 - mx, y + 0.5 - my);
        const a = Math.max(0, Math.min(1, rad - d + 0.5));
        if (a > 0) put(x, y, r, g, b, a);
      }
    }
  }

  // 身体（圆角胶囊）
  circle(cx, cy + rHead * 0.75, rHead * 0.62, [255, 236, 220]);
  // 头部
  circle(cx, cy - rHead * 0.12, rHead, [255, 245, 235]);
  // 耳朵
  circle(cx - rHead * 0.72, cy - rHead * 0.78, rHead * 0.26, [255, 226, 206]);
  circle(cx + rHead * 0.72, cy - rHead * 0.78, rHead * 0.26, [255, 226, 206]);
  // 眼睛
  circle(cx - rHead * 0.36, cy - rHead * 0.02, rHead * 0.115, [58, 48, 46]);
  circle(cx + rHead * 0.36, cy - rHead * 0.02, rHead * 0.115, [58, 48, 46]);
  // 高光
  circle(cx - rHead * 0.32, cy - rHead * 0.09, rHead * 0.042, [255, 255, 255]);
  circle(cx + rHead * 0.40, cy - rHead * 0.09, rHead * 0.042, [255, 255, 255]);
  // 腮红
  circle(cx - rHead * 0.60, cy + rHead * 0.24, rHead * 0.14, [255, 178, 166]);
  circle(cx + rHead * 0.60, cy + rHead * 0.24, rHead * 0.14, [255, 178, 166]);
  // 嘴
  circle(cx, cy + rHead * 0.24, rHead * 0.058, [214, 120, 110]);

  // 下采样
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const i = ((y * SS + sy) * W + (x * SS + sx)) * 4;
          r += buf[i]; g += buf[i + 1]; b += buf[i + 2]; a += buf[i + 3];
        }
      }
      const n = SS * SS;
      const o = (y * size + x) * 4;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = Math.round((a / n) * 255);
    }
  }
  return encodePNG(size, size, out);
}

fs.writeFileSync(path.join(OUT_ASSETS, 'tray.png'), drawIcon(32));
fs.writeFileSync(path.join(OUT_BUILD, 'icon.png'), drawIcon(256));
fs.copyFileSync(path.join(OUT_BUILD, 'icon.png'), path.join(OUT_ASSETS, 'icon.png'));

/* ---------------- WAV ---------------- */
function makeChime() {
  const rate = 22050;
  const dur = 0.55;
  const n = Math.floor(rate * dur);
  const pcm = Buffer.alloc(n * 2);
  const notes = [
    { f: 880, t0: 0.0, len: 0.18, amp: 0.26 },
    { f: 1174.7, t0: 0.13, len: 0.24, amp: 0.22 },
    { f: 1568, t0: 0.28, len: 0.26, amp: 0.14 },
  ];
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    let s = 0;
    for (const note of notes) {
      const lt = t - note.t0;
      if (lt < 0 || lt > note.len) continue;
      const env = Math.exp(-lt * 9) * (1 - Math.exp(-lt * 220));
      s += Math.sin(2 * Math.PI * note.f * lt) * env * note.amp;
    }
    const v = Math.max(-1, Math.min(1, s));
    pcm.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

fs.writeFileSync(path.join(OUT_ASSETS, 'chime.wav'), makeChime());
console.log('assets generated:', fs.readdirSync(OUT_ASSETS).join(', '), '| build:', fs.readdirSync(OUT_BUILD).join(', '));
