/**
 * 设置面板：播报内容、次数、间隔、语速、音色。
 * 这是用户说的"按自己的需求设置播报几次、间隔多久"的落点。
 */
import { normalizeSettings } from '../core/model.js';
import { buildQueue } from '../core/scheduler.js';
import { groupVoices, loadVoices } from '../core/speech.js';
import { saveLastSettings } from '../core/storage.js';
import { persist, state, touch } from './state.js';
import { clear, el, humanMs, toast } from './utils.js';

/** @type {import('../core/storage.js') | null} */
const persistHolder = null;

/** @type {Partial<import('../core/model.js').Settings>} */
let draft = {};

/**
 * 打开设置。
 * @param {() => void} [onSaved]
 */
export async function openSettings(onSaved) {
  const modalRoot = document.getElementById('modal-root');
  if (!modalRoot) return;

  draft = { ...normalizeSettings(state.project.settings) };
  const voices = state.voices.length ? state.voices : await loadVoices();
  state.voices = voices;
  const grouped = groupVoices(voices);

  const close = () => clear(modalRoot);
  const save = () => {
    state.project.settings = normalizeSettings(draft);
    saveLastSettings(state.project.settings);
    persist();
    close();
    toast('设置已保存', 'success');
    if (onSaved) onSaved();
    else touch();
  };

  const body = el('div.modal__body', {}, [
    buildContentSection(),
    buildRepeatSection(),
    buildGapSection(),
    buildVoiceSection(grouped),
    buildExtraSection()
  ]);

  const modal = el('div.modal.modal--wide', {}, [
    el('div.modal__head', {}, [
      el('h3.modal__title', { text: '播报设置' }),
      el('button', {
        type: 'button',
        class: 'btn btn--ghost btn--sm',
        dataset: { action: 'close-settings' },
        text: '关闭',
        onclick: close
      })
    ]),
    body,
    el('div.modal__footer', {}, [
      el('div.summary-line', { id: 'settings-summary', text: estimateText() }),
      el('div.row', {}, [
        el('button', {
          type: 'button',
          class: 'btn btn--ghost',
          text: '恢复默认',
          onclick: () => {
            draft = { ...normalizeSettings({}) };
            close();
            void openSettings(onSaved);
          }
        }),
        el('button', { type: 'button', class: 'btn btn--primary', text: '保存', onclick: save })
      ])
    ])
  ]);

  const overlay = el('div.modal-overlay', { onclick: (event) => event.target === overlay && close() }, [modal]);
  clear(modalRoot);
  modalRoot.append(overlay);
}

function estimateText() {
  const queue = buildQueue(state.project.items ?? [], draft);
  return `按当前设置，${queue.items.length} 个词、共 ${queue.speakCount} 次朗读，预计约 ${humanMs(queue.totalMs)}`;
}

function refreshEstimate() {
  const node = document.getElementById('settings-summary');
  if (node) node.textContent = estimateText();
}

/* ------------------------------------------------------------------ 分区 */

function buildContentSection() {
  const toggle = (key, label, hint) => {
    const input = el('input', {
      type: 'checkbox',
      checked: Boolean(draft[key]),
      onchange: (event) => {
        draft[key] = event.target.checked;
        refreshEstimate();
      }
    });
    return el('label.checkbox-card', {}, [
      input,
      el('div', {}, [el('div.checkbox-card__title', { text: label }), hint ? el('div.checkbox-card__hint', { text: hint }) : null])
    ]);
  };

  return section('念什么内容', [
    el('div.grid.grid--2', {}, [
      toggle('speakZh', '念中文词语', '例如念「乌鸦」'),
      toggle('speakPinyin', '念拼音', '例如念「wū yā」（一般留给孩子自己看拼音）'),
      toggle('speakEn', '念英文单词', '词条里有英文时才会念'),
      toggle('speakExample', '念例句 / 组词', '词条里有例句时才会念')
    ])
  ]);
}

function buildRepeatSection() {
  return section('每个词念几遍', [
    el('div.grid.grid--2', {}, [
      numberField('zhRepeat', '中文念几遍', 0, 10, 1),
      numberField('enRepeat', '英文念几遍', 0, 10, 1)
    ]),
    el('p.field__hint', { text: '也可以在「核对词语」里给单个词单独设置遍数。' })
  ]);
}

function buildGapSection() {
  return section('间隔时间', [
    sliderField('withinWordGapMs', '同一个词两次朗读之间', 0, 20000, 500, (value) => `${(value / 1000).toFixed(1)} 秒`),
    sliderField('betweenWordGapMs', '一个词念完到下一个词', 0, 60000, 1000, (value) => `${(value / 1000).toFixed(0)} 秒`),
    sliderField('leadInMs', '开始前的准备时间', 0, 30000, 1000, (value) => `${(value / 1000).toFixed(0)} 秒`),
    el('p.field__hint', { text: '词与词的间隔就是留给孩子书写的时间，写得慢可以调长一些。' })
  ]);
}

function buildVoiceSection(grouped) {
  const zhOptions = [
    el('option', { value: '', text: '自动选择（推荐）' }),
    ...grouped.zh.map((voice) =>
      el('option', { value: voice.uri, text: `${voice.name}（${voice.lang}）`, selected: draft.zhVoiceURI === voice.uri })
    )
  ];
  const enOptions = [
    el('option', { value: '', text: '自动选择（推荐）' }),
    ...grouped.en.map((voice) =>
      el('option', { value: voice.uri, text: `${voice.name}（${voice.lang}）`, selected: draft.enVoiceURI === voice.uri })
    )
  ];

  return section('语速和音色', [
    sliderField('rate', '语速', 0.5, 2, 0.05, (value) => `${value.toFixed(2)}×`),
    el('div.grid.grid--2', {}, [
      el('label.field', {}, [
        el('span.field__label', { text: '中文声音' }),
        el('select', { class: 'select', onchange: (event) => (draft.zhVoiceURI = event.target.value) }, zhOptions)
      ]),
      el('label.field', {}, [
        el('span.field__label', { text: '英文声音' }),
        el('select', { class: 'select', onchange: (event) => (draft.enVoiceURI = event.target.value) }, enOptions)
      ])
    ]),
    grouped.zh.length === 0
      ? el('p.field__warn', { text: '这台设备暂时没有找到中文语音。Windows 可在「设置 → 时间和语言 → 语音」里添加中文语音包；手机一般在系统语音设置里下载。' })
      : null
  ]);
}

function buildExtraSection() {
  const shuffleInput = el('input', {
    type: 'checkbox',
    checked: Boolean(draft.shuffle),
    onchange: (event) => {
      draft.shuffle = event.target.checked;
      refreshEstimate();
    }
  });
  const indexInput = el('input', {
    type: 'checkbox',
    checked: Boolean(draft.announceIndex),
    onchange: (event) => {
      draft.announceIndex = event.target.checked;
      refreshEstimate();
    }
  });
  const chimeInput = el('input', {
    type: 'checkbox',
    checked: Boolean(draft.playDoneChime),
    onchange: (event) => (draft.playDoneChime = event.target.checked)
  });
  const mutedInput = el('input', {
    type: 'checkbox',
    checked: Boolean(draft.muted),
    onchange: (event) => {
      draft.muted = event.target.checked;
      refreshEstimate();
    }
  });

  return section('其它', [
    el('div.grid.grid--3', {}, [
      el('label.checkbox', {}, [shuffleInput, el('span', { text: '打乱词语顺序' })]),
      el('label.checkbox', {}, [indexInput, el('span', { text: '念之前报序号' })]),
      el('label.checkbox', {}, [chimeInput, el('span', { text: '结束时响提示音' })])
    ]),
    el('div.grid', {}, [
      el('label.checkbox', {}, [mutedInput, el('span', { text: '无声练习模式（家长自己念，应用只负责倒计时和节奏）' })])
    ])
  ]);
}

/* ------------------------------------------------------------------ 小部件 */

function section(title, children) {
  return el('section.settings-section', {}, [el('h4.settings-section__title', { text: title }), ...children.filter(Boolean)]);
}

function sliderField(key, label, min, max, step, format) {
  const valueNode = el('span.field__value', { text: format(Number(draft[key])) });
  const input = el('input', {
    type: 'range',
    class: 'range',
    min: String(min),
    max: String(max),
    step: String(step),
    value: String(draft[key]),
    oninput: (event) => {
      draft[key] = Number(event.target.value);
      valueNode.textContent = format(Number(event.target.value));
      refreshEstimate();
    }
  });
  return el('label.field.field--slider', {}, [el('span.field__label', {}, [label, valueNode]), input]);
}

function numberField(key, label, min, max, step) {
  return el('label.field', {}, [
    el('span.field__label', { text: label }),
    el('input', {
      type: 'number',
      class: 'input',
      min: String(min),
      max: String(max),
      step: String(step),
      value: String(draft[key]),
      oninput: (event) => {
        draft[key] = Math.max(min, Math.min(max, Number(event.target.value) || 0));
        refreshEstimate();
      }
    })
  ]);
}
