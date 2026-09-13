/**
 * 应用入口：装配各个屏幕、订阅状态、处理全局交互。
 */
import { disposeOcr, recognizeImage, recognizeLocal } from './core/ocr.js';
import { renderLibrary } from './ui/library.js';
import { disposePlayer, initPlay, renderPlay } from './ui/play.js';
import { renderPhotos } from './ui/photos.js';
import { openSettings } from './ui/settings.js';
import { go, persist, restore, state, subscribe, touch } from './ui/state.js';
import { closeModals, qs, toast } from './ui/utils.js';
import { renderWords } from './ui/words.js';

/* 引入样式（Vite 会打包成一个 css 文件） */
import './styles.css';

const screens = {
  library: renderLibrary,
  photos: renderPhotos,
  words: renderWords,
  play: renderPlay
};

/** 上一次渲染时的关键指纹，用来避免"输入框打字时被重渲染打断" */
let lastFingerprint = '';

function render() {
  // 顶部
  const nameNode = document.getElementById('project-name');
  const metaNode = document.getElementById('project-meta');
  if (nameNode) nameNode.textContent = state.project.name || '自动听写';
  if (metaNode) {
    const count = state.project.items?.length ?? 0;
    const speakable = (state.project.items ?? []).filter((item) => item.enabled !== false).length;
    metaNode.textContent = count > 0 ? `${count} 个词条 · 可播报 ${speakable} 个` : '拍照 → 出词 → 念给孩子听写';
  }

  // 标签页高亮
  document.querySelectorAll('#tabs .tab').forEach((tab) => {
    const target = tab.getAttribute('data-screen');
    const active = target === state.screen || (state.screen === 'library' && target === null);
    tab.classList.toggle('tab--active', active);
    tab.setAttribute('aria-current', active ? 'step' : 'false');
  });

  // 屏幕切换
  document.querySelectorAll('#screens .screen').forEach((section) => {
    const target = section.getAttribute('data-screen');
    section.hidden = target !== state.screen;
  });

  // 渲染当前屏幕
  const section = document.querySelector(`#screens .screen[data-screen="${state.screen}"]`);
  if (section) {
    const fingerprint = `${state.screen}`;
    const renderer = screens[state.screen];
    // 每次状态变化都重渲染；输入类组件只在失焦/回车时提交，不会被打断
    renderer(/** @type {HTMLElement} */ (section));
    lastFingerprint = fingerprint;
  }

  // 忙碌遮罩
  const overlay = document.getElementById('busy-overlay');
  const busyText = document.getElementById('busy-text');
  const busyFill = document.getElementById('busy-fill');
  if (overlay) overlay.hidden = !state.busy;
  if (busyText) busyText.textContent = state.busyText || '处理中…';
  if (busyFill) busyFill.style.width = `${Math.round((state.busyProgress || 0) * 100)}%`;
}

function bindChrome() {
  for (const tab of document.querySelectorAll('#tabs .tab')) {
    tab.addEventListener('click', () => {
      const target = tab.getAttribute('data-screen');
      if (!target) return;
      // 离开播放页时暂停播报，避免"看不见还在念"
      if (state.screen === 'play') disposePlayer();
      closeModals();
      go(/** @type {any} */ (target));
    });
  }

  qs('#btn-library').addEventListener('click', () => {
    if (state.screen === 'play') disposePlayer();
    closeModals();
    go('library');
  });

  qs('#btn-settings').addEventListener('click', () => {
    void openSettings();
  });

  document.getElementById('project-name')?.addEventListener('dblclick', () => {
    const name = window.prompt('给这次听写起个名字', state.project.name);
    if (name === null) return;
    state.project.name = name.trim() || state.project.name;
    persist();
    touch();
  });

  // 键盘快捷键：空格 播放/暂停，→ 下一个词，← 重听
  window.addEventListener('keydown', (event) => {
    if (state.screen !== 'play') return;
    const target = /** @type {HTMLElement} */ (event.target);
    if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
    const clickAction = (action) => {
      const node = document.querySelector(`.controls [data-action="${action}"]`);
      if (node instanceof HTMLElement) node.click();
    };
    if (event.code === 'Space') {
      event.preventDefault();
      const playButton = document.querySelector('.controls .btn--xl.btn--primary, .controls .btn--xl.btn--warn');
      if (playButton instanceof HTMLElement) playButton.click();
    } else if (event.code === 'ArrowRight') {
      event.preventDefault();
      clickAction('skip');
    } else if (event.code === 'ArrowLeft') {
      event.preventDefault();
      clickAction('replay');
    }
  });

  // 页面隐藏时释放 OCR worker，省内存（手机上很关键）
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && state.screen !== 'photos') {
      void disposeOcr();
    }
  });

  window.addEventListener('beforeunload', () => {
    disposePlayer();
  });
}

async function boot() {
  restore();
  closeModals();
  subscribe(render);
  bindChrome();
  render();

  // 暴露 OCR 供浏览器控制台/测试脚本调用（与 __dictationPlayer 同类调试钩子）
  window.__dictationOcr = { recognizeImage, recognizeLocal };
  void initPlay().then(() => {
    // 语音列表异步就绪后，如果用户正停在设置/播放页，刷新一下可用音色
    touch();
  });

  // 首次访问给一点引导
  if ((state.project.items?.length ?? 0) === 0) {
    go('photos');
    toast('先拍一张课本照片，或者点"手动输入词语"', 'info', 4200);
  }
}

void boot();
