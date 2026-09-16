/**
 * 本机静态服务器（带访问日志），用于排查"页面转圈/处理中"到底卡在哪。
 * 用法: node scripts/local-server.mjs [port]
 */
import { createServer } from 'node:http';
import { appendFile, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const dist = path.join(root, 'dist');
const logFile = path.join(root, 'verification', 'access.log');
const PORT = Number(process.argv[2] || 4180);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.gz': 'application/gzip',
  '.wasm': 'application/wasm',
  '.traineddata': 'application/octet-stream',
  '.ico': 'image/x-icon'
};

const server = createServer(async (req, res) => {
  const started = Date.now();
  const ua = req.headers['user-agent'] || '';
  const ip = req.socket.remoteAddress || '';
  let filePath = path.join(dist, decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname));
  if (req.url === '/' || req.url === '') filePath = path.join(dist, 'index.html');
  let info = await stat(filePath).catch(() => null);
  if (info?.isDirectory()) {
    filePath = path.join(filePath, 'index.html');
    info = await stat(filePath).catch(() => null);
  }
  if (!info) filePath = path.join(dist, 'index.html');

  let status = 200;
  try {
    const body = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
      'Service-Worker-Allowed': '/'
    });
    res.end(body);
  } catch {
    status = 404;
    res.writeHead(404).end('not found');
  }
  const line = `${new Date().toISOString()} | ${ip} | ${status} | ${Date.now() - started}ms | ${req.method} ${req.url} | UA=${ua.slice(0, 90)}\n`;
  process.stdout.write(line);
  await appendFile(logFile, line).catch(() => {});
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`本地服务器(带日志)已启动: http://localhost:${PORT}/`);
  console.log(`访问日志: verification/access.log`);
});