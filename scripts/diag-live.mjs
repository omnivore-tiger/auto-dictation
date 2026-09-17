import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const URL = process.argv[2] || 'https://omnivore-tiger.github.io/auto-dictation/';
const PORT = 9236;
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const shotDir = path.join(process.cwd(), 'verification', 'live-diag');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(ws){ this.ws=ws; this.id=0; this.pending=new Map(); this.handlers=new Map();
    ws.addEventListener('message',(e)=>{const m=JSON.parse(e.data); if(m.id&&this.pending.has(m.id)){const {resolve,reject}=this.pending.get(m.id);this.pending.delete(m.id);m.error?reject(new Error(JSON.stringify(m.error))):resolve(m.result);} else if(m.method){for(const h of this.handlers.get(m.method)||[])h(m.params);}});}
  static async connect(url){ const ws=new WebSocket(url); await new Promise((res,rej)=>{ws.addEventListener('open',res,{once:true});ws.addEventListener('error',()=>rej(new Error('ws fail')),{once:true});}); return new Cdp(ws); }
  on(m,h){ if(!this.handlers.has(m))this.handlers.set(m,[]); this.handlers.get(m).push(h); }
  send(method,params={}){ this.id+=1; const id=this.id; return new Promise((res,rej)=>{ this.pending.set(id,{resolve:res,reject:rej}); this.ws.send(JSON.stringify({id,method,params})); setTimeout(()=>{if(this.pending.has(id)){this.pending.delete(id);rej(new Error('CDP timeout '+method));}},60000);}); }
  async eval(expr){ const r=await this.send('Runtime.evaluate',{expression:expr,awaitPromise:true,returnByValue:true}); if(r.exceptionDetails) throw new Error('eval: '+r.exceptionDetails.exception?.description); return r.result?.value; }
  async shot(file){ const {data}=await this.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false}); await writeFile(file,Buffer.from(data,'base64')); }
}

await mkdir(shotDir,{recursive:true});
const profile=path.join(os.tmpdir(),'live-diag-'+Date.now());
const child=spawn(CHROME,['--headless=new',`--remote-debugging-port=${PORT}`,`--user-data-dir=${profile}`,'--no-first-run','--no-default-browser-check','--disable-gpu','--disable-extensions','--window-size=390,844','about:blank'],{stdio:'ignore'});
let chromeInfo=null;
for(let i=0;i<40;i++){ chromeInfo=await fetch(`http://127.0.0.1:${PORT}/json/version`).then(r=>r.json()).catch(()=>null); if(chromeInfo)break; await sleep(250); }
if(!chromeInfo){ console.log('chorme 未能启动'); process.exit(1); }
console.log('浏览器',chromeInfo.Browser);

let page=null;
for(let a=0;a<5;a++){ try{ const list=await fetch(`http://127.0.0.1:${PORT}/json/list`).then(r=>r.json()); page=(Array.isArray(list)?list:[]).find(t=>t.type==='page'); if(!page) page=await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`,{method:'PUT'}).then(r=>r.json()); break; }catch(e){ await sleep(400); } }
const c=await Cdp.connect(page.webSocketDebuggerUrl);
await c.send('Runtime.enable'); await c.send('Log.enable'); await c.send('Page.enable');
await c.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:2,mobile:true});

const errors=[];
c.on('Runtime.consoleAPICalled',p=>{ if(p.type==='error') errors.push('console.error: '+p.args.map(a=>a.value??a.description??'').join(' ')); });
c.on('Runtime.exceptionThrown',p=>{ errors.push('exception: '+(p.exceptionDetails?.exception?.description??(p.exceptionDetails?.text??''))); });
c.on('Log.entryAdded',p=>{ if(p.entry?.level==='error') errors.push('log: '+p.entry.text); });

await sleep(500);
try{ await c.send('Page.navigate',{url:URL}); }catch(e){ console.log('navigate retry', e.message); await c.send('Page.navigate',{url:URL}); }

// 等 3 秒看初始状态
await sleep(3000);
const snap = await c.eval(`(()=>{
  const busy=document.getElementById('busy-overlay');
  const vis=document.querySelector('#screens .screen:not([hidden])')?.dataset.screen??null;
  const screens=[...document.querySelectorAll('#screens .screen')];
  return {
    title: document.title,
    screen: vis,
    busyHidden: busy?busy.hidden:null,
    busyComputedDisplay: busy?getComputedStyle(busy).display:null,
    screensWithVisibleStyle: screens.filter(s=>getComputedStyle(s).display!=='none').map(s=>s.dataset.screen),
    busyText: document.getElementById('busy-text')?.textContent||null,
    hasMain: !!window.__dictationApp,
    orderSelect: [...document.querySelectorAll('.options-row select')].map(s=>s.options[s.selectedIndex]?.text)||[],
    bodyText: document.body.innerText.slice(0,600)
  };
})()`);
console.log('3秒后:', JSON.stringify(snap,null,2));
await c.shot(path.join(shotDir,'live-3s.png'));

// 再等 5 秒看是否还卡
await sleep(5000);
const snap2 = await c.eval(`(()=>{
  const busy=document.getElementById('busy-overlay');
  return {
    screen: document.querySelector('#screens .screen:not([hidden])')?.dataset.screen??null,
    busyHidden: busy?busy.hidden:null,
    busyText: document.getElementById('busy-text')?.textContent||null,
    beyondBusy: document.body.innerText.replace(/\\s+/g,' ').slice(0,180)
  };
})()`);
console.log('8秒后:', JSON.stringify(snap2,null,2));
await c.shot(path.join(shotDir,'live-8s.png'));

console.log('\n捕获到的错误:');
if(errors.length===0) console.log('  (无)');
for(const e of errors) console.log(' -', e);
console.log('\n截图目录:', shotDir);
child.kill(); process.exit(0);