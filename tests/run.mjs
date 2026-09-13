/**
 * 测试入口。
 *
 * 说明：这里没有用 `node --test tests/`，因为那种方式会为每个测试文件派生一个子进程
 * 并通过管道抓取输出；在某些受限环境（沙箱禁止命名管道）下会直接 EPERM。
 * 改成在当前进程里 import 所有测试文件，用的是同一套 node:test 断言与报告器。
 *
 * 运行：npm test
 */
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = path.resolve(import.meta.dirname);
const files = (await readdir(dir))
  .filter((name) => name.endsWith('.test.js'))
  .sort();

if (files.length === 0) {
  console.error('没有找到测试文件');
  process.exit(1);
}

for (const file of files) {
  // Windows 下必须转成 file:// URL，ESM loader 不接受裸的盘符路径
  await import(pathToFileURL(path.join(dir, file)).href);
}
