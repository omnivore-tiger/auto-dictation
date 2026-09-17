/**
 * 最小 OCR 单次运行（用于确认浏览器实际下载并使用了哪个语言模型）。
 * 用法: node scripts/ocr-once.mjs [url]
 */
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const URL = process.argv[2] || 'http://localhost:4180/';
const PORT = 9259;
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(ws){ this.ws=ws; this.id=0; this.pending=new Map();
    ws.addEventListener('message',(e)=>{const m=JSON.parse(e.data); if(m.id&&this.pending.has(m.id)){const {resolve,reject}=this.pending.get(m.id);this.pending.delete(m.id);m.error?reject(new Error(JSON.stringify(m.error))):resolve(m.result);}});}
  static async connect(url){ const ws=new WebSocket(url); await new Promise((res,rej)=>{ws.addEventListener('open',res,{once:true});ws.addEventListener('error',()=>rej(new Error('ws fail')),{once:true});}); return new Cdp(ws); }
  send(method,params={}){ this.id+=1; const id=this.id; return new Promise((res,rej)=>{ this.pending.set(id,{resolve:res,reject:rej}); this.ws.send(JSON.stringify({id,method,params})); setTimeout(()=>{if(this.pending.has(id)){this.pending.delete(id);rej(new Error('timeout '+method));}},180000);}); }
  async eval(expr){ const r=await this.send('Runtime.evaluate',{expression:expr,awaitPromise:true,returnByValue:true}); if(r.exceptionDetails) throw new Error('eval: '+(r.exceptionDetails.exception?.description||r.exceptionDetails.text)); return r.result?.value; }
}

const profile = path.join(os.tmpdir(), 'once-' + Date.now());
const child = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
let info = null;
for (let i = 0; i < 40; i++) { info = await fetch(`http://127.0.0.1:${PORT}/json/version`).then(r => r.json()).catch(() => null); if (info) break; await sleep(250); }
if (!info) { console.log('Chrome 启动失败'); process.exit(1); }
let page = null;
for (let a = 0; a < 5; a++) { try { const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json()); page = (Array.isArray(list) ? list : []).find(t => t.type === 'page'); break; } catch { await sleep(400); } }
const c = await Cdp.connect(page.webSocketDebuggerUrl);
await c.send('Runtime.enable'); await c.send('Page.enable');
await sleep(400);
await c.send('Page.navigate', { url: URL });
await sleep(2500);

const dataUrl = await c.eval(`
(() => {
  const cv = document.createElement('canvas');
  cv.width = 700; cv.height = 180;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, 700, 180);
  ctx.fillStyle = '#000000';
  ctx.font = 'bold 56px "Microsoft YaHei","SimSun",sans-serif';
  ctx.textBaseline = 'middle';
  ctx.fillText('香蕉 橙子 葡萄 乌鸦', 30, 90);
  return cv.toDataURL('image/png');
})()
`);

const raw = await c.eval(`
  (async () => {
    const r = await window.__dictationOcr.recognizeImage(${JSON.stringify(dataUrl)}, { mode: 'local', lang: 'chi_sim' });
    return r.text;
  })()
`);
console.log('识别结果:', JSON.stringify(String(raw || '').trim()));
child.kill();
process.exit(0);
