/**
 * 验证"看原图"功能：上传一张图后，缩略图可点开大图，也能用"看原图"按钮打开，Esc 可关闭。
 * 用法: node scripts/test-lightbox.mjs [url]
 */
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const URL = process.argv[2] || 'http://localhost:4180/';
const PORT = 9247;
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const IMAGE = path.resolve(import.meta.dirname, '..', 'public', 'icons', 'icon-512.png');
const shotDir = path.resolve(import.meta.dirname, '..', 'verification', 'lightbox');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(ws){ this.ws=ws; this.id=0; this.pending=new Map(); this.handlers=new Map();
    ws.addEventListener('message',(e)=>{const m=JSON.parse(e.data); if(m.id&&this.pending.has(m.id)){const {resolve,reject}=this.pending.get(m.id);this.pending.delete(m.id);m.error?reject(new Error(JSON.stringify(m.error))):resolve(m.result);} else if(m.method){for(const h of this.handlers.get(m.method)||[])h(m.params);}});}
  static async connect(url){ const ws=new WebSocket(url); await new Promise((res,rej)=>{ws.addEventListener('open',res,{once:true});ws.addEventListener('error',()=>rej(new Error('ws fail')),{once:true});}); return new Cdp(ws); }
  on(m,h){ if(!this.handlers.has(m))this.handlers.set(m,[]); this.handlers.get(m).push(h); }
  send(method,params={}){ this.id+=1; const id=this.id; return new Promise((res,rej)=>{ this.pending.set(id,{resolve:res,reject:rej}); this.ws.send(JSON.stringify({id,method,params})); setTimeout(()=>{if(this.pending.has(id)){this.pending.delete(id);rej(new Error('timeout '+method));}},90000);}); }
  async eval(expr){ const r=await this.send('Runtime.evaluate',{expression:expr,awaitPromise:true,returnByValue:true}); if(r.exceptionDetails) throw new Error('eval: '+(r.exceptionDetails.exception?.description||r.exceptionDetails.text)); return r.result?.value; }
  async shot(f){ const {data}=await this.send('Page.captureScreenshot',{format:'png'}); await writeFile(f,Buffer.from(data,'base64')); }
}

const problems = [];
const profile = path.join(os.tmpdir(), 'lightbox-' + Date.now());
const child = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--disable-gpu', '--window-size=430,900', 'about:blank'], { stdio: 'ignore' });
let info = null;
for (let i = 0; i < 40; i++) { info = await fetch(`http://127.0.0.1:${PORT}/json/version`).then(r => r.json()).catch(() => null); if (info) break; await sleep(250); }
if (!info) { console.log('Chrome 启动失败'); process.exit(1); }
await mkdir(shotDir, { recursive: true });

let page = null;
for (let a = 0; a < 5; a++) { try { const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json()); page = (Array.isArray(list) ? list : []).find(t => t.type === 'page'); if (!page) page = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' }).then(r => r.json()); break; } catch { await sleep(400); } }
const c = await Cdp.connect(page.webSocketDebuggerUrl);
await c.send('Runtime.enable'); await c.send('Page.enable'); await c.send('DOM.enable');
await c.on && c.on('Runtime.exceptionThrown', (p) => problems.push('异常: ' + (p.exceptionDetails?.exception?.description || p.exceptionDetails?.text)));

await sleep(400);
await c.send('Page.navigate', { url: URL });
await sleep(2500);

// 关掉自动识别，避免在这里跑 OCR（本测试只验证看原图）
await c.eval(`(() => { const cb = document.getElementById('auto-ocr'); if (cb && cb.checked) cb.click(); return true; })()`);

// 通过真实的 file input 上传一张图
const { root } = await c.send('DOM.getDocument');
const { nodeId } = await c.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#input-gallery' });
if (!nodeId) { console.log('找不到 #input-gallery'); child.kill(); process.exit(1); }
await c.send('DOM.setFileInputFiles', { files: [IMAGE], nodeId });

// 等照片卡片出现
let cardOk = false;
for (let i = 0; i < 40; i++) { if (await c.eval(`Boolean(document.querySelector('.photo-card'))`)) { cardOk = true; break; } await sleep(200); }
console.log('照片卡片出现:', cardOk);
if (!cardOk) problems.push('上传后没有出现照片卡片');

const thumbInfo = await c.eval(`(() => {
  const img = document.querySelector('.photo-card__thumb');
  return { hasThumb: Boolean(img), isData: img ? img.src.startsWith('data:image') : false, cursor: img ? getComputedStyle(img).cursor : null };
})()`);
console.log('缩略图:', JSON.stringify(thumbInfo));
if (!thumbInfo.hasThumb) problems.push('卡片里没有缩略图');
if (thumbInfo.cursor !== 'zoom-in') problems.push(`缩略图未呈现可点击样式，cursor=${thumbInfo.cursor}`);

// 点缩略图 → 应该打开大图
await c.eval(`document.querySelector('.photo-card__thumb').click(); true`);
await sleep(500);
const opened = await c.eval(`(() => {
  const v = document.querySelector('.image-viewer');
  const img = document.querySelector('.image-viewer__img');
  const thumb = document.querySelector('.photo-card__thumb');
  return { viewer: Boolean(v), sameSrc: Boolean(img && thumb && img.src === thumb.src), title: document.querySelector('.image-viewer__title')?.textContent || '' };
})()`);
console.log('点缩略图后:', JSON.stringify(opened));
if (!opened.viewer) problems.push('点缩略图没有打开大图');
if (!opened.sameSrc) problems.push('大图显示的不是这张照片');

// 大图必须盖住整页（含顶部栏），不能被顶栏压住
const cover = await c.eval(`(() => {
  const v = document.querySelector('.image-viewer');
  const r = v.getBoundingClientRect();
  const topEl = document.elementFromPoint(window.innerWidth / 2, 24);
  return {
    rect: { x: r.x, y: r.y, w: Math.round(r.width), h: Math.round(r.height) },
    win: { w: document.documentElement.clientWidth, h: window.innerHeight },
    bg: getComputedStyle(v).backgroundColor,
    topElementIsViewer: topEl ? topEl.closest('.image-viewer') !== null : false,
    topElementClass: topEl ? topEl.className : null
  };
})()`);
console.log('覆盖检查:', JSON.stringify(cover));
if (!cover.topElementIsViewer) problems.push(`顶部被其它元素压住：${cover.topElementClass}`);
if (cover.rect.w < cover.win.w || cover.rect.h < cover.win.h) problems.push('大图没有铺满整屏');
await c.shot(path.join(shotDir, 'lightbox-open.png'));

// Esc 关闭
await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
await sleep(400);
const afterEsc = await c.eval(`Boolean(document.querySelector('.image-viewer'))`);
console.log('Esc 后还存在大图:', afterEsc);
if (afterEsc) problems.push('按 Esc 无法关闭大图');

// 用"看原图"按钮再打开一次
const btnClicked = await c.eval(`(() => {
  const btn = [...document.querySelectorAll('.photo-card__actions .btn')].find((b) => b.textContent.trim() === '看原图');
  if (!btn) return false;
  btn.click();
  return true;
})()`);
await sleep(400);
const reopened = await c.eval(`Boolean(document.querySelector('.image-viewer'))`);
console.log('「看原图」按钮可打开:', btnClicked && reopened);
if (!btnClicked) problems.push('找不到「看原图」按钮');
else if (!reopened) problems.push('「看原图」按钮没能打开大图');
await c.shot(path.join(shotDir, 'lightbox-button.png'));

console.log('\n结果:');
if (problems.length === 0) console.log('✅ 看原图功能正常');
else { for (const p of problems) console.log(' - ' + p); process.exitCode = 1; }
console.log('截图:', shotDir);
child.kill();
process.exit(problems.length ? 1 : 0);
