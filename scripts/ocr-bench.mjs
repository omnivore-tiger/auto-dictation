/**
 * OCR 效果对比：模拟"纸张发黄、光照不均"的课本词表照片，
 * 比较「旧预处理(全局二值化)」与「新预处理(灰度+对比度拉伸)」的中文识别效果。
 *
 * 用法: node scripts/ocr-bench.mjs [url]
 */
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const URL = process.argv[2] || 'http://localhost:4180/';
const PORT = 9241;
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(ws){ this.ws=ws; this.id=0; this.pending=new Map();
    ws.addEventListener('message',(e)=>{const m=JSON.parse(e.data); if(m.id&&this.pending.has(m.id)){const {resolve,reject}=this.pending.get(m.id);this.pending.delete(m.id);m.error?reject(new Error(JSON.stringify(m.error))):resolve(m.result);}});}
  static async connect(url){ const ws=new WebSocket(url); await new Promise((res,rej)=>{ws.addEventListener('open',res,{once:true});ws.addEventListener('error',()=>rej(new Error('ws fail')),{once:true});}); return new Cdp(ws); }
  send(method,params={}){ this.id+=1; const id=this.id; return new Promise((res,rej)=>{ this.pending.set(id,{resolve:res,reject:rej}); this.ws.send(JSON.stringify({id,method,params})); setTimeout(()=>{if(this.pending.has(id)){this.pending.delete(id);rej(new Error('CDP timeout '+method));}},120000);}); }
  async eval(expr){ const r=await this.send('Runtime.evaluate',{expression:expr,awaitPromise:true,returnByValue:true}); if(r.exceptionDetails) throw new Error('eval: '+(r.exceptionDetails.exception?.description||r.exceptionDetails.text)); return r.result?.value; }
}

const profile = path.join(os.tmpdir(), 'ocr-bench-' + Date.now());
const child = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--disable-gpu', '--disable-extensions', 'about:blank'], { stdio: 'ignore' });
let info = null;
for (let i = 0; i < 40; i++) { info = await fetch(`http://127.0.0.1:${PORT}/json/version`).then(r => r.json()).catch(() => null); if (info) break; await sleep(250); }
if (!info) { console.log('Chrome 启动失败'); process.exit(1); }

let page = null;
for (let a = 0; a < 5; a++) { try { const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json()); page = (Array.isArray(list) ? list : []).find(t => t.type === 'page'); if (!page) page = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' }).then(r => r.json()); break; } catch { await sleep(400); } }
const c = await Cdp.connect(page.webSocketDebuggerUrl);
await c.send('Runtime.enable'); await c.send('Page.enable');
await sleep(400);
await c.send('Page.navigate', { url: URL });
await sleep(2500);

// 造一张"课本词表"照片：泛黄纸张 + 光照不均 + 字偏小 + 噪点模糊，尽量接近手机实拍
const makeImage = `
(() => {
  const cv = document.createElement('canvas');
  cv.width = 1000; cv.height = 700;
  const ctx = cv.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, cv.width, cv.height);
  g.addColorStop(0, '#f7efdc'); g.addColorStop(0.45, '#e6d9ba'); g.addColorStop(1, '#cdbb95');
  ctx.fillStyle = g; ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.fillStyle = '#4a4238';
  ctx.textBaseline = 'middle';
  const rows = [
    ['乌鸦', 'wū yā'], ['葡萄', 'pú táo'], ['朋友', 'péng yǒu'],
    ['老师', 'lǎo shī'], ['同学', 'tóng xué'], ['语文', 'yǔ wén']
  ];
  rows.forEach(([zh, py], i) => {
    const y = 90 + i * 92;
    ctx.font = '30px "Microsoft YaHei","SimSun",sans-serif';
    ctx.fillText(zh, 80, y);
    ctx.font = '20px "Times New Roman",serif';
    ctx.fillText(py, 210, y + 3);
  });
  // 噪点
  const img = ctx.getImageData(0, 0, cv.width, cv.height);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 34;
    img.data[i] = Math.max(0, Math.min(255, img.data[i] + n));
    img.data[i+1] = Math.max(0, Math.min(255, img.data[i+1] + n));
    img.data[i+2] = Math.max(0, Math.min(255, img.data[i+2] + n));
  }
  ctx.putImageData(img, 0, 0);
  // 轻微模糊+缩放的"拍虚"效果
  const out = document.createElement('canvas');
  out.width = cv.width; out.height = cv.height;
  const octx = out.getContext('2d');
  octx.filter = 'blur(0.6px)';
  octx.drawImage(cv, 0, 0);
  return out.toDataURL('image/jpeg', 0.72);
})()
`;

const dataUrl = await c.eval(makeImage);
const expected = ['乌鸦', '葡萄', '朋友', '老师', '同学', '语文'];

async function run(binarize, label) {
  const text = await c.eval(`
    (async () => {
      const r = await window.__dictationOcr.recognizeImage(${JSON.stringify(dataUrl)}, {
        mode: 'local', lang: 'chi_sim', binarize: ${binarize}
      });
      return r.text;
    })()
  `);
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  const hit = expected.filter((w) => clean.includes(w));
  console.log(`\n【${label}】`);
  console.log('  识别原文:', JSON.stringify(clean));
  console.log(`  命中中文词: ${hit.length}/${expected.length} → ${hit.join('、') || '(无)'}`);
  return { label, hit: hit.length, clean };
}

const a = await run(true, '旧预处理：全局二值化');
const b = await run(false, '新预处理：灰度+对比度拉伸（当前默认）');

console.log('\n===== 结论 =====');
console.log(`旧(二值化)  命中 ${a.hit}/6`);
console.log(`新(当前默认) 命中 ${b.hit}/6`);

child.kill();
process.exit(0);
