/**
 * 浏览器端冒烟验证（不需要额外依赖）。
 *
 * 做三件事：
 *   1. 起一个本地静态服务器，托管 dist/；
 *   2. 用 headless Chrome 的 CDP 协议打开页面，收集 console 错误与页面异常；
 *   3. 预置一组词条，走一遍「核对词语 → 开始听写 → 播报」，并截图留证。
 *
 * 运行：node scripts/verify.mjs
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const dist = path.join(root, 'dist');
const shots = path.join(root, 'verification');

const PORT = Number(process.env.VERIFY_PORT || 4399);
const DEBUG_PORT = Number(process.env.VERIFY_DEBUG_PORT || 9223);

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
];

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

/* ------------------------------------------------------------------ 1. 静态服务器 */

async function startServer() {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
      let filePath = path.join(dist, decodeURIComponent(url.pathname));
      if (url.pathname === '/' || url.pathname === '') filePath = path.join(dist, 'index.html');
      let info = await stat(filePath).catch(() => null);
      if (info?.isDirectory()) {
        filePath = path.join(filePath, 'index.html');
        info = await stat(filePath).catch(() => null);
      }
      if (!info) {
        // SPA 回退
        filePath = path.join(dist, 'index.html');
        info = await stat(filePath).catch(() => null);
        if (!info) {
          res.writeHead(404).end('not found');
          return;
        }
      }
      const body = await readFile(filePath);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] ?? 'application/octet-stream' });
      res.end(body);
    } catch (error) {
      res.writeHead(500).end(String(error));
    }
  });
  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
  return server;
}

/* ------------------------------------------------------------------ 2. CDP 客户端 */

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(JSON.stringify(message.error)));
        else resolve(message.result);
        return;
      }
      if (message.method) {
        for (const handler of this.handlers.get(message.method) ?? []) handler(message.params);
      }
    });
  }

  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('WebSocket 连接失败')), { once: true });
    });
    return new Cdp(ws);
  }

  on(method, handler) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(handler);
  }

  send(method, params = {}) {
    this.id += 1;
    const id = this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时：${method}`));
        }
      }, 90000);
    });
  }

  /** 在页面里执行表达式并取回 JSON 结果 */
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    });
    if (result.exceptionDetails) {
      throw new Error(`页面执行出错：${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
    }
    return result.result?.value;
  }

  async screenshot(file) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await writeFile(file, Buffer.from(data, 'base64'));
  }
}

async function fetchJson(url, attempts = 40) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
    } catch {
      /* 还没起来，继续等 */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`无法连接 ${url}`);
}

/* ------------------------------------------------------------------ 3. 主流程 */

/** 收集到的问题，最后统一汇报 */
const problems = [];

async function main() {
  await mkdir(shots, { recursive: true });

  const server = await startServer();
  console.log(`静态服务器已启动：http://127.0.0.1:${PORT}`);

  const chromePath = CHROME_CANDIDATES.find((p) => p);

  /**
   * 启动 headless Chrome 并等它把调试端口开起来。
   * 注意：如果复用了被别人占用的 profile，Chrome 会把命令转发给已有实例然后自己退出（code 21），
   * 所以这里每次都用带随机后缀的临时 profile，并在启动后确认进程还活着。
   */
  async function launchChrome(attempt) {
    const profile = path.join(os.tmpdir(), `dsh-verify-${Date.now().toString(36)}-${attempt}`);
    await rm(profile, { recursive: true, force: true });
    const child = spawn(
      chromePath,
      [
        '--headless=new',
        `--remote-debugging-port=${DEBUG_PORT}`,
        `--user-data-dir=${profile}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-gpu',
        '--disable-extensions',
        '--disable-background-networking',
        '--window-size=430,900',
        '--hide-scrollbars',
        'about:blank'
      ],
      { stdio: 'ignore' }
    );
    let exited = null;
    child.on('exit', (code) => {
      exited = code;
    });

    let version = null;
    for (let i = 0; i < 60 && !version; i += 1) {
      if (exited !== null) break;
      version = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)
        .then((r) => r.json())
        .catch(() => null);
      if (!version) await sleep(250);
    }
    return { child, version, exited, profile };
  }

  let chrome = null;
  let chromeInfo = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    chromeInfo = await launchChrome(attempt);
    if (chromeInfo.version) {
      chrome = chromeInfo.child;
      break;
    }
    console.warn(`第 ${attempt} 次启动 Chrome 失败（exit=${chromeInfo.exited}），重试…`);
    chromeInfo.child.kill();
    await sleep(700);
  }
  if (!chromeInfo?.version) throw new Error('Chrome 未能启动');

  let cdp;
  try {
    const version = chromeInfo.version;
    console.log('浏览器：', version.Browser);

    // 稳健地建立一个"页面" target：优先复用已有 page，没有再新建。
    // 偶发情况下 /json/new 返回的目标 WebSocket 会静默失效，所以这里带重试。
    let target = null;
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      try {
        const list = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`).then((r) => r.json());
        target = (Array.isArray(list) ? list : []).find((t) => t.type === 'page') ?? null;
        if (!target) {
          target = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new?about:blank`, { method: 'PUT' }).then((r) => r.json());
        }
        cdp = await Cdp.connect(target.webSocketDebuggerUrl);
        await cdp.send('Runtime.enable');
        break;
      } catch (error) {
        console.warn(`建立调试连接第 ${attempt} 次失败：${error.message}，重试…`);
        cdp?.ws?.close();
        await sleep(500);
      }
    }
    if (!cdp) throw new Error('无法连接到 Chrome 调试端口');

    cdp.on('Runtime.consoleAPICalled', (params) => {
      if (params.type === 'error') {
        const text = (params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ');
        problems.push(`console.error: ${text}`);
      }
    });
    cdp.on('Runtime.exceptionThrown', (params) => {
      problems.push(`未捕获异常: ${params.exceptionDetails?.exception?.description ?? params.exceptionDetails?.text}`);
    });
    cdp.on('Log.entryAdded', (params) => {
      if (params.entry?.level === 'error') problems.push(`浏览器日志: ${params.entry.text}`);
    });

    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Page.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 430,
      height: 900,
      deviceScaleFactor: 2,
      mobile: true
    });

    // --- 首次打开 ---
    // 稍等一下，headless 刚起来时立刻导航偶发会超时
    await sleep(500);
    try {
      await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html` });
    } catch (error) {
      console.warn('首次导航超时，重试一次：', error.message);
      await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html` });
    }
    await waitFor(cdp, 'document.querySelector("#screens .screen:not([hidden])") !== null');
    await sleep(600);

    const firstScreen = await cdp.evaluate(`document.querySelector('#screens .screen:not([hidden])')?.dataset.screen`);
    console.log('首屏：', firstScreen);
    if (firstScreen !== 'photos') problems.push(`首屏应为 photos，实际为 ${firstScreen}`);

    // 关键回归检查：hidden 属性必须真的把元素藏起来（作者样式里的 display 会覆盖 UA 的 [hidden]）
    const visual = await cdp.evaluate(`
      (() => {
        const busy = document.getElementById('busy-overlay');
        const visibleScreens = [...document.querySelectorAll('#screens .screen')]
          .filter((s) => getComputedStyle(s).display !== 'none')
          .map((s) => s.dataset.screen);
        return {
          busyDisplay: busy ? getComputedStyle(busy).display : null,
          busyVisible: busy ? getComputedStyle(busy).display !== 'none' : false,
          visibleScreens
        };
      })()
    `);
    console.log('可见性检查：', JSON.stringify(visual));
    if (visual.busyVisible) problems.push('忙碌遮罩(busy-overlay)一直显示，遮盖了界面');
    if (visual.visibleScreens.length !== 1) {
      problems.push(`同时显示了 ${visual.visibleScreens.length} 个屏幕：[${visual.visibleScreens}]，应只有 1 个`);
    }
    if (visual.visibleScreens[0] !== 'photos') {
      problems.push(`实际可见的屏幕应为 photos，实际为 ${visual.visibleScreens[0]}`);
    }
    await cdp.screenshot(path.join(shots, '1-拍照识别.png'));

    // --- 预置词条，检查解析 + 拼音 + 界面 ---
    await cdp.evaluate(`
      localStorage.setItem('dictation.projects.v1', JSON.stringify([{
        id: 'proj_demo',
        name: '第一课 demo',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        items: [
          { id: 'i1', zh: '乌鸦', pinyin: 'wū yā', en: 'crow', example: '乌鸦喝水', zhRepeatOverride: null, enRepeatOverride: null, enabled: true },
          { id: 'i2', zh: '葡萄', pinyin: 'pú táo', en: 'grape', example: '', zhRepeatOverride: null, enRepeatOverride: null, enabled: true },
          { id: 'i3', zh: '朋友', pinyin: 'péng yǒu', en: 'friend', example: '', zhRepeatOverride: null, enRepeatOverride: null, enabled: true }
        ],
        settings: { zhRepeat: 2, enRepeat: 1, withinWordGapMs: 1200, betweenWordGapMs: 3000, leadInMs: 500, speakZh: true, speakEn: true, speakPinyin: false, speakExample: false, rate: 0.9, playDoneChime: true, shuffle: false, announceIndex: false, zhVoiceURI: '', enVoiceURI: '' }
      }]));
      localStorage.setItem('dictation.currentProjectId.v1', JSON.stringify('proj_demo'));
      'ok'
    `);
    await cdp.send('Page.reload');
    await waitFor(cdp, 'document.querySelectorAll(".tab").length === 3');
    await sleep(400);

    // 切到「核对词语」
    await cdp.evaluate(`document.querySelector('.tab[data-screen="words"]').click(); 'ok'`);
    await waitFor(cdp, 'document.querySelectorAll(".word-row").length > 0');
    const wordRows = await cdp.evaluate(`document.querySelectorAll('.word-row').length`);
    const firstZh = await cdp.evaluate(`document.querySelector('.input--zh')?.value`);
    const firstPinyin = await cdp.evaluate(`document.querySelector('.input--pinyin')?.value`);
    console.log(`词语页：${wordRows} 行，第一个词「${firstZh}」拼音「${firstPinyin}」`);
    if (wordRows !== 3) problems.push(`词语页应有 3 行，实际 ${wordRows}`);
    if (firstZh !== '乌鸦') problems.push(`第一个词应为「乌鸦」，实际「${firstZh}」`);
    await cdp.screenshot(path.join(shots, '2-核对词语.png'));

    // 改一个词，验证自动保存
    await cdp.evaluate(`
      (() => {
        const input = document.querySelectorAll('.word-row .input--zh')[2];
        input.value = '朋友们';
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return 'ok';
      })()
    `);
    await sleep(300);
    const savedName = await cdp.evaluate(`JSON.parse(localStorage.getItem('dictation.projects.v1'))[0].items[2].zh`);
    console.log('修改后已保存为：', savedName);
    if (savedName !== '朋友们') problems.push(`修改未保存，实际 ${savedName}`);

    // 改回原名，避免影响后面的列表断言
    await cdp.evaluate(`
      (() => {
        const input = document.querySelectorAll('.word-row .input--zh')[2];
        input.value = '朋友';
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return 'ok';
      })()
    `);
    await sleep(200);

    // --- 播报页 ---
    await cdp.evaluate(`document.querySelector('.tab[data-screen="play"]').click(); 'ok'`);
    await sleep(500);
    const playDiagnostics = await cdp.evaluate(`
      (() => {
        const screen = document.querySelector('#screens .screen[data-screen="play"]');
        return {
          hidden: screen?.hidden ?? null,
          visibleScreen: document.querySelector('#screens .screen:not([hidden])')?.dataset.screen ?? null,
          cards: [...(screen?.querySelectorAll(':scope > .card') ?? [])].map(n => n.className),
          playItems: screen?.querySelectorAll('.play-item').length ?? -1,
          firstText: screen?.innerText.slice(0, 120) ?? ''
        };
      })()
    `);
    console.log('播报页诊断：', JSON.stringify(playDiagnostics));
    const domProbe = await cdp.evaluate(`
      (() => {
        const screen = document.querySelector('#screens .screen[data-screen="play"]');
        return {
          children: [...(screen?.children ?? [])].map(n => n.className + '#' + (n.id || '-')),
          playList: Boolean(document.getElementById('play-list')),
          html: (screen?.innerHTML ?? '').length
        };
      })()
    `);
    console.log('播报页 DOM：', JSON.stringify(domProbe));
    await waitFor(cdp, 'document.querySelectorAll(".play-item").length > 0').catch(() => {});
    const playItems = await cdp.evaluate(`document.querySelectorAll('.play-item').length`);
    const summary = await cdp.evaluate(`document.querySelector('.summary')?.innerText.replace(/\\s+/g,' ')`);
    const mutedNotice = await cdp.evaluate(
      `Boolean(document.querySelector('.card--warn')) ? '（本机无语音引擎，已降级为无声练习）' : ''`
    );
    console.log(`播报页：${playItems} 个词；${summary} ${mutedNotice}`);
    if (playItems !== 3) problems.push(`播报页应有 3 个词，实际 ${playItems}`);
    await cdp.screenshot(path.join(shots, '3-开始听写.png'));

    // 点开始（无头浏览器没有语音引擎，走无声练习，验证状态机不崩）
    await cdp.evaluate(`document.querySelector('.controls .btn--primary').click(); 'ok'`);
    // 等第一个词真正进入播报（先经历短暂准备倒计时）
    await waitFor(cdp, 'document.querySelectorAll(".play-item--active").length === 1', 10000);
    const playState = await cdp.evaluate(`document.querySelector('.stage__status')?.innerText`);
    const stageText = await cdp.evaluate(`document.querySelector('.stage__subtitle')?.innerText`);
    const activeItems = await cdp.evaluate(`document.querySelectorAll('.play-item--active').length`);
    const playerState = await cdp.evaluate(`
      (() => {
        const p = window.__dictationPlayer;
        if (!p) return null;
        return {
          state: p.state, index: p.index, steps: p.steps.length, muted: p.muted,
          itemIndex: p.currentItemIndex, spoken: p.spokenCount,
          stepKind: p.steps[p.index]?.kind, stepReason: p.steps[p.index]?.reason
        };
      })()
    `);
    console.log(`点击开始后：状态「${playState}」，当前词「${stageText}」，高亮行 ${activeItems}`);
    console.log('播放器内部状态：', JSON.stringify(playerState));
    if (activeItems !== 1) problems.push(`播报中应有 1 个高亮词条，实际 ${activeItems}`);
    if (!/第 [1-3] \/ 3 个/.test(String(playState))) problems.push(`状态文案不符：${playState}`);
    await cdp.screenshot(path.join(shots, '4-播报中.png'));

    // 暂停
    await cdp.evaluate(`document.querySelector('.controls .btn--primary').click(); 'ok'`);
    await sleep(400);
    const pausedState = await cdp.evaluate(`document.querySelector('.stage__status')?.innerText`);
    console.log('暂停后状态：', pausedState);
    if (pausedState !== '已暂停') problems.push(`暂停状态文案不符：${pausedState}`);

    // 继续 + 跳过 + 重听
    await cdp.evaluate(`document.querySelector('.controls .btn--primary').click(); 'ok'`);
    await sleep(600);
    await cdp.evaluate(`document.querySelector('.controls [data-action="skip"]').click(); 'ok'`);
    await sleep(600);
    const afterSkip = await cdp.evaluate(`document.querySelectorAll('.play-item--active')[0]?.innerText`);
    console.log('跳过后的高亮词：', afterSkip);
    await cdp.evaluate(`document.querySelector('.controls [data-action="replay"]').click(); 'ok'`);
    await sleep(400);
    await cdp.evaluate(`document.querySelector('.controls .btn--primary').click(); 'ok'`); // 暂停，避免干扰后续截图

    // 设置面板
    await cdp.evaluate(`document.querySelector('#btn-settings').click(); 'ok'`);
    await waitFor(cdp, 'document.querySelector(".modal") !== null');
    const settingsTitle = await cdp.evaluate(`document.querySelector('.modal__title')?.innerText`);
    const estimate = await cdp.evaluate(`document.querySelector('#settings-summary')?.innerText`);
    console.log('设置面板：', settingsTitle, '|', estimate);
    await cdp.screenshot(path.join(shots, '5-播报设置.png'));
    await cdp.evaluate(`document.querySelector('[data-action="close-settings"]').click(); 'ok'`);
    await sleep(250);
    const modalClosed = await cdp.evaluate(`document.querySelector('.modal') === null`);
    if (!modalClosed) problems.push('关闭设置后弹窗仍然存在');
    // 播报设置里改一个值，验证会同步到设置对象
    await cdp.evaluate(`document.querySelector('#btn-settings').click(); 'ok'`);
    await waitFor(cdp, 'document.querySelector(".modal") !== null');
    await cdp.evaluate(`
      (() => {
        const range = [...document.querySelectorAll('.settings-section .range')][0];
        range.value = '4000';
        range.dispatchEvent(new Event('input', { bubbles: true }));
        return 'ok';
      })()
    `);
    await sleep(150);
    const newEstimate = await cdp.evaluate(`document.querySelector('#settings-summary')?.innerText`);
    console.log('调整间隔后的估算：', newEstimate);
    await cdp.evaluate(`document.querySelector('.modal__footer .btn--primary').click(); 'ok'`);
    await sleep(250);
    const savedGap = await cdp.evaluate(`JSON.parse(localStorage.getItem('dictation.projects.v1'))[0].settings.withinWordGapMs`);
    console.log('保存后的词内间隔(ms)：', savedGap);
    if (savedGap !== 4000) problems.push(`设置未保存，实际 withinWordGapMs=${savedGap}`);

    // 听写本
    await cdp.evaluate(`document.querySelector('#btn-library').click(); 'ok'`);
    await waitFor(cdp, 'document.querySelector(".project-list") !== null');
    const projects = await cdp.evaluate(`document.querySelectorAll('.project-card').length`);
    console.log('听写本里的项目数：', projects);
    await cdp.screenshot(path.join(shots, '6-听写本.png'));

    // Service Worker / 离线资源
    const swState = await cdp.evaluate(`
      navigator.serviceWorker.getRegistration().then(r => r ? (r.active ? 'active' : 'registered') : 'none')
    `);
    console.log('Service Worker：', swState);
    if (swState === 'none') problems.push('Service Worker 未注册，离线能力不可用');

    const tessdataOk = await cdp.evaluate(`
      fetch('./tessdata/chi_sim.traineddata.gz', { method: 'HEAD' }).then(r => r.status)
    `);
    const coreOk = await cdp.evaluate(`
      fetch('./tesseract/tesseract-core-simd-lstm.wasm', { method: 'HEAD' }).then(r => r.status)
    `);
    console.log('本地识别模型：', tessdataOk, '核心 wasm：', coreOk);
    if (tessdataOk !== 200) problems.push('中文语言模型不可访问');
    if (coreOk !== 200) problems.push('Tesseract wasm 核心不可访问');

    // --- 端到端 OCR：用 canvas 画一张含英文的图，真的让 Tesseract 识别 ---
    const ocrText = await cdp.evaluate(`
      (async () => {
        const canvas = document.createElement('canvas');
        canvas.width = 900;
        canvas.height = 260;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, 900, 260);
        ctx.fillStyle = '#000000';
        ctx.font = 'bold 54px Arial, sans-serif';
        ctx.textBaseline = 'middle';
        ctx.fillText('crow apple banana grape', 30, 130);
        const dataUrl = canvas.toDataURL('image/png');
        if (!window.__dictationOcr) return 'NO_HOOK';
        const result = await window.__dictationOcr.recognizeImage(dataUrl, {
          mode: 'local', lang: 'eng'
        });
        return result.text;
      })()
    `);
    const normalized = String(ocrText || '').toLowerCase().replace(/[\s,.;:]+/g, ' ');
    console.log('端到端 OCR 识别结果：', JSON.stringify(normalized));
    const known = ['crow', 'apple', 'banana', 'grape'].filter((word) => normalized.includes(word));
    if (ocrText === 'NO_HOOK') {
      problems.push('OCR 调试钩子未挂载');
    } else if (known.length < 2) {
      problems.push(`端到端 OCR 未识别出足够英文词（识别到 ${known.length}/4）：${normalized}`);
    } else {
      console.log(`OCR 端到端识别通过，识别到：${known.join('、')}`);
    }

    console.log('\n截图已保存到 verification/');
  } finally {
    try {
      cdp?.ws.close();
    } catch {
      /* 忽略 */
    }
    chrome.kill();
    server.close();
  }

  if (problems.length > 0) {
    console.log('\n发现的问题：');
    for (const problem of problems) console.log(' -', problem);
    process.exitCode = 1;
  } else {
    console.log('\n✅ 冒烟验证全部通过，没有 console 错误。');
  }
}

async function waitFor(cdp, expression, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cdp.evaluate(`Boolean(${expression})`)) return true;
    await sleep(120);
  }
  throw new Error(`等待超时：${expression}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

await main();
