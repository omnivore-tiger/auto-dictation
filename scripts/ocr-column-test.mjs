/**
 * 端到端验证「左栏英文 + 右栏中文」的对照表：
 * 真的渲染一张两栏图 → 真跑 OCR → 用解析器配对 → 检查中英文是否一一对应。
 *
 * 用法: node scripts/ocr-column-test.mjs [url]
 */
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { parseOcrText } from '../src/core/parser.js';

const URL = process.argv[2] || 'http://localhost:4180/';
const PORT = 9253;
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(ws){ this.ws=ws; this.id=0; this.pending=new Map();
    ws.addEventListener('message',(e)=>{const m=JSON.parse(e.data); if(m.id&&this.pending.has(m.id)){const {resolve,reject}=this.pending.get(m.id);this.pending.delete(m.id);m.error?reject(new Error(JSON.stringify(m.error))):resolve(m.result);}});}
  static async connect(url){ const ws=new WebSocket(url); await new Promise((res,rej)=>{ws.addEventListener('open',res,{once:true});ws.addEventListener('error',()=>rej(new Error('ws fail')),{once:true});}); return new Cdp(ws); }
  send(method,params={}){ this.id+=1; const id=this.id; return new Promise((res,rej)=>{ this.pending.set(id,{resolve:res,reject:rej}); this.ws.send(JSON.stringify({id,method,params})); setTimeout(()=>{if(this.pending.has(id)){this.pending.delete(id);rej(new Error('timeout '+method));}},120000);}); }
  async eval(expr){ const r=await this.send('Runtime.evaluate',{expression:expr,awaitPromise:true,returnByValue:true}); if(r.exceptionDetails) throw new Error('eval: '+(r.exceptionDetails.exception?.description||r.exceptionDetails.text)); return r.result?.value; }
}

const profile = path.join(os.tmpdir(), 'col-' + Date.now());
const child = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
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

// 左栏英文、右栏中文的对照表
const PAIRS = [
  ['apple', '苹果'],
  ['banana', '香蕉'],
  ['crow', '乌鸦'],
  ['grape', '葡萄'],
  ['orange', '橙子']
];

const makeImage = `
(() => {
  const cv = document.createElement('canvas');
  cv.width = 1100; cv.height = 640;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#fbf7ee'; ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.fillStyle = '#1f1f1f';
  ctx.textBaseline = 'middle';
  const pairs = ${JSON.stringify(PAIRS)};
  pairs.forEach(([en, zh], i) => {
    const y = 90 + i * 105;
    ctx.font = '40px "Segoe UI",Arial,sans-serif';
    ctx.fillText(en, 80, y);
    ctx.font = 'bold 46px "Microsoft YaHei","SimSun",sans-serif';
    ctx.fillText(zh, 560, y);
  });
  return cv.toDataURL('image/png');
})()
`;

const dataUrl = await c.eval(makeImage);

// 再造一张 2 倍分辨率的同款图：字号更大，等于给了 OCR 更多像素
const makeImage2x = makeImage.replace('cv.width = 1100; cv.height = 640;', 'cv.width = 2200; cv.height = 1280;')
  .replace("const y = 90 + i * 105;", "const y = 180 + i * 210;")
  .replace("'40px \"Segoe UI\",Arial,sans-serif'", "'80px \"Segoe UI\",Arial,sans-serif'")
  .replace("'bold 46px \"Microsoft YaHei\",\"SimSun\",sans-serif'", "'bold 92px \"Microsoft YaHei\",\"SimSun\",sans-serif'")
  .replace('ctx.fillText(en, 80, y);', 'ctx.fillText(en, 160, y);')
  .replace('ctx.fillText(zh, 560, y);', 'ctx.fillText(zh, 1120, y);');
const dataUrl2x = await c.eval(makeImage2x);

const CONFIGS = [
  { label: 'PSM 6  1倍分辨率(当前默认)', psm: '6', binarize: false, img: dataUrl },
  { label: 'PSM 6  2倍分辨率          ', psm: '6', binarize: false, img: dataUrl2x },
  { label: 'PSM 4  2倍分辨率          ', psm: '4', binarize: false, img: dataUrl2x },
  { label: 'PSM 3  2倍分辨率          ', psm: '3', binarize: false, img: dataUrl2x }
];

let best = null;
for (const cfg of CONFIGS) {
  const raw = await c.eval(`
    (async () => {
      const r = await window.__dictationOcr.recognizeImage(${JSON.stringify(cfg.img)}, {
        mode: 'local', lang: 'chi_sim+eng', psm: ${JSON.stringify(cfg.psm)}, binarize: ${cfg.binarize}
      });
      return r.text;
    })()
  `);
  const { items } = parseOcrText(raw || '');
  const got = items.filter((it) => it.zh || it.en).map((it) => [it.zh, it.en]);
  const zhHit = PAIRS.filter(([, zh]) => got.some(([gzh]) => gzh === zh)).length;
  const pairOk = PAIRS.filter(([en, zh]) => got.some(([gzh, gen]) => gzh === zh && gen === en)).length;

  console.log(`\n【${cfg.label}】`);
  console.log('  原始:', JSON.stringify(String(raw || '').replace(/\s+/g, ' ').trim()));
  console.log(`  中文命中 ${zhHit}/5，配对正确 ${pairOk}/5`);
  if (!best || pairOk > best.pairOk) best = { label: cfg.label, pairOk, zhHit };
}

console.log(`\n===== 最佳：${best.label}（配对 ${best.pairOk}/5，中文 ${best.zhHit}/5）=====`);
const allOk = best.pairOk === PAIRS.length;
console.log(allOk ? '✅ 中英文一一对应正确' : '⚠️ 仍有识别错误（属 OCR 精度问题）');

child.kill();
process.exit(0);
