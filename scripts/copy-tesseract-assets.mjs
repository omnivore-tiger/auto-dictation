/**
 * 把 tesseract.js 的 worker / wasm 核心从 node_modules 复制到 public/tesseract，
 * 这样应用在完全离线（无 CDN）的情况下也能做 OCR。
 * 语言模型（chi_sim / eng traineddata）已经放在 public/tessdata。
 *
 * 运行：node scripts/copy-tesseract-assets.mjs
 */
import { copyFile, mkdir, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '..');
const outDir = path.join(root, 'public', 'tesseract');

const files = [
  [path.join(path.dirname(require.resolve('tesseract.js')), '..', 'dist', 'worker.min.js'), 'worker.min.js'],
  [path.join(path.dirname(require.resolve('tesseract.js-core')), 'tesseract-core-simd-lstm.wasm.js'), 'tesseract-core-simd-lstm.wasm.js'],
  [path.join(path.dirname(require.resolve('tesseract.js-core')), 'tesseract-core-simd-lstm.wasm'), 'tesseract-core-simd-lstm.wasm'],
  [path.join(path.dirname(require.resolve('tesseract.js-core')), 'tesseract-core-lstm.wasm.js'), 'tesseract-core-lstm.wasm.js'],
  [path.join(path.dirname(require.resolve('tesseract.js-core')), 'tesseract-core-lstm.wasm'), 'tesseract-core-lstm.wasm'],
  [path.join(path.dirname(require.resolve('tesseract.js-core')), 'tesseract-core-simd.wasm.js'), 'tesseract-core-simd.wasm.js'],
  [path.join(path.dirname(require.resolve('tesseract.js-core')), 'tesseract-core-simd.wasm'), 'tesseract-core-simd.wasm'],
  [path.join(path.dirname(require.resolve('tesseract.js-core')), 'tesseract-core.wasm.js'), 'tesseract-core.wasm.js'],
  [path.join(path.dirname(require.resolve('tesseract.js-core')), 'tesseract-core.wasm'), 'tesseract-core.wasm']
];

await mkdir(outDir, { recursive: true });

let copied = 0;
for (const [src, name] of files) {
  try {
    await stat(src);
  } catch {
    console.warn(`跳过（不存在）：${name}`);
    continue;
  }
  await copyFile(src, path.join(outDir, name));
  copied += 1;
  console.log(`已复制 ${name}`);
}
console.log(`\n完成，共 ${copied} 个文件 -> public/tesseract`);
