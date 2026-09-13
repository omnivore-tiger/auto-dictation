/**
 * 生成 PWA 需要的 PNG 图标（192 / 512）。
 * 手写一个极简 PNG 编码器，避免为了两个图标引入依赖。
 * 运行：node scripts/make-icons.mjs
 */
import { deflateSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const outDir = path.join(root, 'public', 'icons');

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

/** @param {number} size @param {(x: number, y: number) => [number, number, number, number]} shader */
function renderPng(size, shader) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  let offset = 0;
  for (let y = 0; y < size; y += 1) {
    raw[offset] = 0; // filter: none
    offset += 1;
    for (let x = 0; x < size; x += 1) {
      const [r, g, b, a] = shader(x, y);
      raw[offset] = r;
      raw[offset + 1] = g;
      raw[offset + 2] = b;
      raw[offset + 3] = a;
      offset += 4;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
  return png;
}

/** 简单图形：圆角矩形蓝底 + 白色书页 + 中间声波竖条 */
function makeShader(size) {
  const s = size / 512; // 设计稿是 512
  const radius = 112 * s;
  const inRounded = (x, y) => {
    const cx = Math.min(Math.max(x, radius), size - radius);
    const cy = Math.min(Math.max(y, radius), size - radius);
    return Math.hypot(x - cx, y - cy) <= radius;
  };
  const inRect = (x, y, rx, ry, rw, rh) => x >= rx && x <= rx + rw && y >= ry && y <= ry + rh;
  const inCircle = (x, y, cx, cy, r) => Math.hypot(x - cx, y - cy) <= r;

  return (x, y) => {
    if (!inRounded(x, y)) return [0, 0, 0, 0];
    const t = (x + y) / (2 * size);
    // 渐变底
    let r = Math.round(0x3b + (0x7a - 0x3b) * t);
    let g = Math.round(0x6e + (0xa2 - 0x6e) * t);
    let b = Math.round(0xf5 + (0xff - 0xf5) * t);

    // 左右书页
    const white = [255, 255, 255];
    const leftPage = inRect(x, y, 120 * s, 131 * s, 122 * s, 220 * s) && inRounded(x, y);
    const rightPage = inRect(x, y, 270 * s, 131 * s, 122 * s, 220 * s) && inRounded(x, y);
    if (leftPage || rightPage) {
      const alpha = leftPage ? 0.95 : 0.8;
      r = Math.round(r * (1 - alpha) + white[0] * alpha);
      g = Math.round(g * (1 - alpha) + white[1] * alpha);
      b = Math.round(b * (1 - alpha) + white[2] * alpha);
    }

    // 声波竖条（画在书页之上，用蓝色）
    const bars = [
      [236, 236, 9, 60],
      [204, 248, 7, 36],
      [172, 254, 6, 24],
      [268, 248, 7, 36],
      [300, 254, 6, 24]
    ];
    for (const [cx, cy, halfW, halfH] of bars) {
      if (inRect(x, y, (cx - halfW) * s, (cy - halfH / 2) * s, halfW * 2 * s, halfH * s)) {
        return [0x2b, 0x55, 0xcc, 255];
      }
    }
    // 书脊
    if (inCircle(x, y, 256 * s, 300 * s, 8 * s)) return [0x2b, 0x55, 0xcc, 255];

    return [r, g, b, 255];
  };
}

await mkdir(outDir, { recursive: true });
for (const size of [192, 512]) {
  const png = renderPng(size, makeShader(size));
  const file = path.join(outDir, `icon-${size}.png`);
  await writeFile(file, png);
  console.log(`已生成 ${path.relative(root, file)} （${(png.length / 1024).toFixed(1)} KB）`);
}
