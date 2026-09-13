/**
 * 数据模型：词条（DictationItem）、设置（Settings）、听写项目（Project）。
 * 所有"兜底值/校验/序列化"都集中在这里，方便存历史记录与做单元测试。
 */
import { clampNumber, makeId, normalizeSpaces } from './text.js';

/** 默认播报设置 */
export const DEFAULT_SETTINGS = Object.freeze({
  /** 每个词的中文念几遍 */
  zhRepeat: 2,
  /** 每个词的英文念几遍 */
  enRepeat: 1,
  /** 同一个词两次朗读之间的间隔（毫秒） */
  withinWordGapMs: 2500,
  /** 一个词播完到下一个词开始之间的停顿（毫秒），给孩子书写时间 */
  betweenWordGapMs: 8000,
  /** 开始前的准备倒计时（毫秒） */
  leadInMs: 3000,
  /** 全部播完后的"结束"提示音 */
  playDoneChime: true,
  /** 语速 0.5 - 2 */
  rate: 0.9,
  /** 中文音高/英文音高 */
  zhPitch: 1,
  enPitch: 1,
  /** 是否朗读中文词语 */
  speakZh: true,
  /** 是否朗读英文单词 */
  speakEn: true,
  /** 是否朗读拼音（默认关：拼音是提示，念出来会给孩子"看字形"以外的干扰） */
  speakPinyin: false,
  /** 是否朗读例句/组词 */
  speakExample: false,
  /** 是否随机打乱词序 */
  shuffle: false,
  /** 是否在播报前先报序号（"第 3 个"） */
  announceIndex: false,
  /** 无声练习模式：不发声，只按"念几遍、停多久"的节奏走（适合家长自己念） */
  muted: false,
  /** 中文语音名（留空则自动挑选） */
  zhVoiceURI: '',
  /** 英文语音名（留空则自动挑选） */
  enVoiceURI: ''
});

const NUMBER_FIELDS = {
  zhRepeat: [0, 10, 2],
  enRepeat: [0, 10, 1],
  withinWordGapMs: [0, 60000, 2500],
  betweenWordGapMs: [0, 120000, 8000],
  leadInMs: [0, 60000, 3000]
};

const RATE_FIELDS = {
  rate: [0.5, 2, 0.9],
  zhPitch: [0.5, 2, 1],
  enPitch: [0.5, 2, 1]
};

/** 把任意（可能来自旧版本 localStorage 的）对象整理成合法设置 */
export function normalizeSettings(input) {
  const raw = input && typeof input === 'object' ? input : {};
  /** @type {Record<string, any>} */
  const out = { ...DEFAULT_SETTINGS };
  for (const [key, [min, max, fallback]] of Object.entries({ ...NUMBER_FIELDS, ...RATE_FIELDS })) {
    out[key] = clampNumber(raw[key], min, max, fallback);
  }
  for (const key of ['speakZh', 'speakEn', 'speakPinyin', 'speakExample', 'shuffle', 'announceIndex', 'playDoneChime', 'muted']) {
    out[key] = typeof raw[key] === 'boolean' ? raw[key] : DEFAULT_SETTINGS[key];
  }
  out.zhVoiceURI = typeof raw.zhVoiceURI === 'string' ? raw.zhVoiceURI : '';
  out.enVoiceURI = typeof raw.enVoiceURI === 'string' ? raw.enVoiceURI : '';
  return out;
}

/**
 * 创建一个词条。
 * @param {Partial<DictationItem>} [patch]
 * @returns {DictationItem}
 */
export function createItem(patch = {}) {
  return {
    id: patch.id || makeId('item'),
    /** 中文词语，例如 "乌鸦" */
    zh: normalizeSpaces(patch.zh ?? ''),
    /** 拼音，例如 "wū yā" */
    pinyin: normalizeSpaces(patch.pinyin ?? ''),
    /** 英文单词/短语，例如 "crow" */
    en: normalizeSpaces(patch.en ?? ''),
    /** 例句或组词，例如 "乌鸦喝水" */
    example: normalizeSpaces(patch.example ?? ''),
    /** 单条覆盖：这一条念几遍（null = 用全局设置） */
    zhRepeatOverride: typeof patch.zhRepeatOverride === 'number' ? patch.zhRepeatOverride : null,
    enRepeatOverride: typeof patch.enRepeatOverride === 'number' ? patch.enRepeatOverride : null,
    /** 是否纳入听写（可以临时跳过某个词） */
    enabled: patch.enabled !== false
  };
}

/** 词条是否"有内容可念" */
export function isItemSpeakable(item, settings) {
  if (!item || item.enabled === false) return false;
  const s = normalizeSettings(settings);
  if (s.speakZh && item.zh) return true;
  if (s.speakEn && item.en) return true;
  if (s.speakPinyin && item.pinyin) return true;
  if (s.speakExample && item.example) return true;
  return false;
}

/** 剔除空词条、去重（按 中文+英文 判断重复） */
export function cleanItems(items) {
  /** @type {DictationItem[]} */
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(items) ? items : []) {
    const item = createItem(raw);
    if (!item.zh && !item.en) continue;
    const key = `${item.zh}||${item.en.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/** 新建项目 */
export function createProject(patch = {}) {
  const now = Date.now();
  return {
    id: patch.id || makeId('proj'),
    name: normalizeSpaces(patch.name ?? '') || '未命名听写',
    createdAt: patch.createdAt ?? now,
    updatedAt: patch.updatedAt ?? now,
    items: cleanItems(patch.items ?? []),
    settings: normalizeSettings(patch.settings)
  };
}

/** 读取时做一次"防损坏"整理（历史项目可能来自旧版本） */
export function reviveProject(input) {
  if (!input || typeof input !== 'object') return null;
  const proj = createProject(/** @type {any} */ (input));
  proj.items = cleanItems(/** @type {any} */ (input).items ?? []);
  return proj;
}

/**
 * @typedef {object} DictationItem
 * @property {string} id
 * @property {string} zh
 * @property {string} pinyin
 * @property {string} en
 * @property {string} example
 * @property {number|null} zhRepeatOverride
 * @property {number|null} enRepeatOverride
 * @property {boolean} enabled
 */

/**
 * @typedef {object} Settings
 * @property {number} zhRepeat
 * @property {number} enRepeat
 * @property {number} withinWordGapMs
 * @property {number} betweenWordGapMs
 * @property {number} leadInMs
 * @property {boolean} playDoneChime
 * @property {number} rate
 * @property {number} zhPitch
 * @property {number} enPitch
 * @property {boolean} speakZh
 * @property {boolean} speakEn
 * @property {boolean} speakPinyin
 * @property {boolean} speakExample
 * @property {boolean} shuffle
 * @property {boolean} announceIndex
 * @property {string} zhVoiceURI
 * @property {string} enVoiceURI
 */

/**
 * @typedef {object} Project
 * @property {string} id
 * @property {string} name
 * @property {number} createdAt
 * @property {number} updatedAt
 * @property {DictationItem[]} items
 * @property {Settings} settings
 */
