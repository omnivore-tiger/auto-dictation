/**
 * 第 3 步：听写播报。
 * 界面本身很"大按钮"，因为家长往往是一边做家务一边用；
 * 同时提供"看答案"开关和倒计时，方便陪读。
 */
import { isItemSpeakable } from '../core/model.js';
import { buildQueue } from '../core/scheduler.js';
import { SpeechPlayer, isSpeechSupported, loadVoices } from '../core/speech.js';
import { go, persist, state, touch } from './state.js';
import { clear, el, humanMs, toast } from './utils.js';
import { openSettings } from './settings.js';

const player = new SpeechPlayer();

/** 队列（乱序后再生成，需要保存下来给列表渲染用） */
let queue = null;
/** 等待界面跳转时暂存"从第几个词开始播" */
let pendingSeekIndex = -1;
/** 是否显示答案（默认隐藏，避免孩子直接看到） */
let showAnswer = false;
/** 播放界面里的实时数据 */
const view = {
  root: null,
  timerNode: null,
  statusNode: null,
  subtitleNode: null,
  answerNode: null,
  progressNode: null,
  listNode: null,
  labelNode: null,
  playBtn: null,
  rafId: 0,
  waitDeadline: 0,
  activeItemIndex: -1
};

/** 供其它屏调用：跳到某个词开始播 */
export function requestSeek(itemIndex) {
  pendingSeekIndex = itemIndex;
}

export function disposePlayer() {
  window.cancelAnimationFrame(view.rafId);
  player.stop();
}

export function renderPlay(root) {
  clear(root);
  view.root = root;
  view.listNode = null;

  const speakable = (state.project.items ?? []).filter((item) => isItemSpeakable(item, state.project.settings));
  if (speakable.length === 0) {
    root.append(
      el('div.card.empty-state', {}, [
        el('div.empty-state__icon', { text: '🔊' }),
        el('h3', { text: '还没有可以播报的词条' }),
        el('p.muted', { text: '先去第 1 步拍照识别，或者在第 2 步添加词语；也可以在设置里打开"念中文 / 念英文"。' }),
        el('div.row', {}, [
          el('button', { type: 'button', class: 'btn btn--primary', text: '去核对词语', onclick: () => go('words') }),
          el('button', { type: 'button', class: 'btn btn--outline', text: '打开设置', onclick: () => openSettings() })
        ])
      ])
    );
    return;
  }

  if (!isSpeechSupported()) {
    root.append(
      el('div.card.card--warn', {}, [
        el('h2.card__title', { text: '这台设备没有可用的语音引擎' }),
        el('p', {
          text:
            '已自动切换到「无声练习」：仍然会按你设置的次数和间隔走完流程，屏幕上大字显示当前该写哪个词，' +
            '家长照着念即可。想听机器朗读，请改用 Chrome / Edge / Safari，或在系统里安装中文语音包。'
        })
      ])
    );
  }

  // 先编译队列：列表渲染要用到它，顺序不能颠倒
  rebuildQueue();

  root.append(buildStage());
  root.append(buildControls());
  root.append(buildSummary());
  root.append(buildWordList());

  if (pendingSeekIndex >= 0) {
    const index = pendingSeekIndex;
    pendingSeekIndex = -1;
    player.seekToItem(index);
  }
}

/* ------------------------------------------------------------------ 界面块 */

function buildStage() {
  view.statusNode = el('div.stage__status', { text: '准备就绪' });
  view.subtitleNode = el('div.stage__subtitle', { text: '点下面的"开始听写"' });
  view.timerNode = el('div.stage__timer', { text: '' });
  view.answerNode = el('div.stage__answer', { text: '' });
  view.progressNode = el('div.busy__fill', { style: { width: '0%' } });

  return el('div.card.stage', {}, [
    el('div.row.row--between', {}, [
      view.statusNode,
      el('label.checkbox', {}, [
        el('input', {
          type: 'checkbox',
          checked: showAnswer,
          onchange: (event) => {
            showAnswer = event.target.checked;
            updateStage();
          }
        }),
        el('span', { text: '看答案（家长模式）' })
      ])
    ]),
    view.subtitleNode,
    view.timerNode,
    view.answerNode,
    el('div.stage__progress', {}, [view.progressNode])
  ]);
}

function buildControls() {
  view.playBtn = el('button', {
    type: 'button',
    class: 'btn btn--primary btn--xl',
    text: '开始听写',
    onclick: () => void togglePlay()
  });

  return el('div.card.controls', {}, [
    el('div.controls__main', {}, [
      view.playBtn,
      el('button', {
        type: 'button',
        class: 'btn btn--outline btn--xl',
        dataset: { action: 'replay' },
        text: '重听这个词',
        onclick: () => player.replayCurrent()
      }),
      el('button', {
        type: 'button',
        class: 'btn btn--outline btn--xl',
        dataset: { action: 'skip' },
        text: '下一个词',
        onclick: () => player.skipToNext()
      }),
      el('button', {
        type: 'button',
        class: 'btn btn--ghost btn--xl',
        dataset: { action: 'restart' },
        text: '重新开始',
        onclick: () => {
          player.stop();
          rebuildQueue();
          player.load(queue.steps, state.project.settings, state.voices);
          void player.play();
        }
      })
    ])
  ]);
}

function buildSummary() {
  const settings = state.project.settings;
  const content = [
    settings.speakZh ? '中文词语' : '',
    settings.speakPinyin ? '拼音' : '',
    settings.speakEn ? '英文' : '',
    settings.speakExample ? '例句' : ''
  ].filter(Boolean);
  const langText =
    `每个词念中文 ${settings.zhRepeat} 遍 / 英文 ${settings.enRepeat} 遍；` +
    `同一词两次之间停 ${humanMs(settings.withinWordGapMs)}，词与词之间停 ${humanMs(settings.betweenWordGapMs)}；` +
    `语速 ${settings.rate}×；内容：${content.join('、') || '（未选择）'}`;

  return el('div.card.card--flat.summary', {}, [
    el('div.row.row--between.row--wrap', {}, [
      el('div', {}, [el('strong', { text: '当前播报设置：' }), el('span', { text: langText })]),
      el('button', { type: 'button', class: 'btn btn--outline', text: '调整设置', onclick: () => openSettings(onSettingsChanged) })
    ])
  ]);
}

function buildWordList() {
  const list = el('div', { class: 'play-list', id: 'play-list' });
  view.listNode = list;
  renderWordList();
  return list;
}

function renderWordList() {
  const list = view.listNode;
  if (!list) return;
  clear(list);

  const items = queue?.items ?? [];
  items.forEach((item, position) => {
    const row = el(
      'button',
      {
        type: 'button',
        class: `play-item${position === view.activeItemIndex ? ' play-item--active' : ''}`,
        dataset: { position: String(position) },
        onclick: () => player.seekToItem(position)
      },
      [
        el('span.play-item__no', { text: String(position + 1) }),
        el('span.play-item__text', { text: showAnswer ? describeItem(item) : '•••' }),
        position === view.activeItemIndex ? el('span.play-item__flag', { text: '正在念' }) : null
      ]
    );
    list.append(row);
  });
}

function describeItem(item) {
  const parts = [item.zh, item.pinyin, item.en, item.example].filter(Boolean);
  return parts.join(' / ') || '（空）';
}

/* ------------------------------------------------------------------ 播放逻辑 */

function rebuildQueue() {
  queue = buildQueue(state.project.items, state.project.settings);
  // 把"原始下标"映射进来，供列表点击定位
  return queue;
}

function onSettingsChanged() {
  persist();
  player.stop();
  rebuildQueue();
  renderPlay(view.root);
  toast('设置已更新，队列重新生成', 'success');
}

async function togglePlay() {
  // 暂停中：直接继续，保留当前进度
  if (player.state === 'paused') {
    void player.play();
    return;
  }
  if (player.state === 'playing') {
    player.pause();
    return;
  }

  // 播完了或者还没生成过队列，就重新来一轮
  const finished = player.steps.length > 0 && player.index >= player.steps.length;
  if (!queue || finished) rebuildQueue();

  const voices = state.voices.length ? state.voices : await loadVoices();
  state.voices = voices;
  if (voices.length === 0) {
    toast('这台设备还没有可用的语音，先去系统里安装中文语音包', 'warn');
  }

  // 队列换了（或首次开始）才需要重新载入
  if (player.steps !== queue.steps || player.steps.length === 0) {
    player.load(queue.steps, state.project.settings, voices);
  } else {
    player.settings = state.project.settings;
  }
  void player.play();
}

/* ------------------------------------------------------------------ 事件绑定 */

let bound = false;
function bindPlayer() {
  if (bound) return;
  bound = true;

  player.on(({ type, detail }) => {
    if (state.screen !== 'play') return;
    switch (type) {
      case 'item': {
        view.activeItemIndex = detail.itemIndex;
        renderWordList();
        scrollActiveIntoView();
        updateStage();
        break;
      }
      case 'index': {
        updateProgress();
        updateStage();
        break;
      }
      case 'spoken': {
        updateProgress();
        break;
      }
      case 'state': {
        updatePlayButton();
        updateStage();
        break;
      }
      case 'done': {
        view.activeItemIndex = -1;
        renderWordList();
        updateProgress();
        if (state.project.settings.playDoneChime) playChime();
        toast('全部念完啦，检查一下有没有漏写的～', 'success', 5000);
        break;
      }
      case 'error': {
        toast(detail?.message ?? '播报出错', 'error');
        break;
      }
      case 'muted': {
        toast('没有可用的语音引擎，已切换为无声练习模式', 'warn');
        updateStage();
        break;
      }
      default:
        break;
    }
  });
}

function updatePlayButton() {
  if (!view.playBtn) return;
  const label = player.state === 'playing' ? '暂停' : player.state === 'paused' ? '继续' : '开始听写';
  view.playBtn.textContent = label;
  view.playBtn.classList.toggle('btn--warn', player.state === 'playing');
}

function updateProgress() {
  if (!view.progressNode || !queue) return;
  const total = queue.speakCount || 1;
  const done = Math.min(total, player.spokenCount);
  view.progressNode.style.width = `${Math.round((done / total) * 100)}%`;
}

function updateStage() {
  if (!view.statusNode) return;
  const items = queue?.items ?? [];
  const active = view.activeItemIndex >= 0 ? items[view.activeItemIndex] : null;

  if (player.state === 'playing') {
    if (view.activeItemIndex < 0) {
      // 还在准备倒计时，还没到第一个词
      view.statusNode.textContent = `准备听写（共 ${items.length} 个词）…`;
    } else {
      view.statusNode.textContent = `正在听写：第 ${view.activeItemIndex + 1} / ${items.length} 个`;
    }
    view.subtitleNode.textContent = active ? subtitleFor(active) : '请小朋友准备好纸和笔～';
  } else if (player.state === 'paused') {
    view.statusNode.textContent = '已暂停';
    view.subtitleNode.textContent = '点"继续"接着念';
  } else if (player.index >= player.steps.length && player.steps.length > 0) {
    view.statusNode.textContent = '本次听写已结束';
    view.subtitleNode.textContent = '可以点"重新开始"，或去核对词语。';
  } else {
    view.statusNode.textContent = '准备就绪';
    view.subtitleNode.textContent = '点下面的"开始听写"';
  }

  view.answerNode.textContent = showAnswer && active ? describeItem(active) : '';
  view.timerNode.textContent = '';
  startTimerLoop();
}

/** 根据当前设置，给这个词写一句提示 */
function subtitleFor(item) {
  const settings = state.project.settings;
  const bits = [];
  if (settings.speakZh && item.zh) bits.push(`中文念 ${item.zhRepeatOverride ?? settings.zhRepeat} 遍`);
  if (settings.speakEn && item.en) bits.push(`英文念 ${item.enRepeatOverride ?? settings.enRepeat} 遍`);
  return bits.join('，') || '按你的设置播报';
}

/**
 * 用一个 requestAnimationFrame 循环显示"还要等多久"。
 * 用 rAF 而不是 setInterval，是为了在手机息屏/切后台时自动降频，省电。
 */
function startTimerLoop() {
  if (view.rafId) return;
  const tick = () => {
    view.rafId = window.requestAnimationFrame(tick);
    if (state.screen !== 'play' || !view.timerNode) return;

    const step = player.steps[player.index];
    if (player.state === 'playing' && step && step.kind === 'wait') {
      const deadline = player.waitDeadline ?? Date.now();
      const left = Math.max(0, deadline - Date.now());
      const reasonText = step.reason === 'within' ? '同一个词再念一遍' : step.reason === 'between' ? '下一个词' : '准备开始';
      view.timerNode.textContent = `${Math.ceil(left / 1000)} 秒后念${reasonText}`;
    } else if (player.state === 'paused') {
      view.timerNode.textContent = '⏸ 已暂停';
    } else if (player.state === 'idle' && player.index >= player.steps.length) {
      view.timerNode.textContent = '✅ 全部完成';
    } else {
      view.timerNode.textContent = '';
    }
  };
  view.rafId = window.requestAnimationFrame(tick);
}

function scrollActiveIntoView() {
  const list = view.listNode;
  if (!list) return;
  const active = list.querySelector('.play-item--active');
  if (active instanceof HTMLElement) {
    active.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

/** 结束提示音：不用外部音频文件，直接合成一个柔和的三音 */
function playChime() {
  try {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    const notes = [660, 880, 1046.5];
    notes.forEach((frequency, index) => {
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.value = frequency;
      const start = ctx.currentTime + index * 0.18;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.22, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.16);
      oscillator.connect(gain).connect(ctx.destination);
      oscillator.start(start);
      oscillator.stop(start + 0.18);
    });
    window.setTimeout(() => void ctx.close(), 1200);
  } catch (error) {
    console.warn('提示音播放失败：', error);
  }
}

/** 初始化时调用一次：绑定事件、预加载语音列表 */
export async function initPlay() {
  bindPlayer();
  state.voices = await loadVoices();
  // 方便在浏览器控制台里排查播报问题
  window.__dictationPlayer = player;
}

export { player };
