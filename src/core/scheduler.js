/**
 * 播报排程：把「词条 + 设置」编译成一条"念什么 / 停多久"的步骤队列。
 *
 * 这里刻意做成纯函数（不碰 speechSynthesis、不碰定时器），好处：
 *   - 可以用 node --test 直接验证"念几遍、隔多久"是否符合预期；
 *   - 界面可以先算出总时长给用户看，再开始播报。
 */
import { DEFAULT_SETTINGS, isItemSpeakable, normalizeSettings } from './model.js';

/** 中文语速估算：每秒大约 4.5 个字（rate=1 时，儿童听写场景偏慢） */
const ZH_CHARS_PER_SEC = 4.5;
/** 英文语速估算：每秒大约 2.4 个单词 */
const EN_WORDS_PER_SEC = 2.4;

/**
 * @typedef {object} SpeechStep
 * @property {'speak'} kind
 * @property {string} id
 * @property {number} itemIndex
 * @property {string} text
 * @property {'zh'|'en'|'pinyin'|'example'|'index'} role
 * @property {number} estimatedMs
 */

/**
 * @typedef {object} WaitStep
 * @property {'wait'} kind
 * @property {string} id
 * @property {number} itemIndex
 * @property {'within'|'between'|'leadin'} reason
 * @property {number} ms
 */

/** @typedef {SpeechStep|WaitStep} Step */

/**
 * 估算一句话要念多久（毫秒）。
 * @param {string} text
 * @param {'zh'|'en'|'pinyin'|'example'|'index'} role
 * @param {number} rate
 */
export function estimateSpeechMs(text, role, rate) {
  const value = String(text ?? '').trim();
  if (!value) return 0;
  const safeRate = rate > 0 ? rate : 1;
  const isChineseLike = role !== 'en';
  const unitCount = isChineseLike
    ? Array.from(value.replace(/\s+/g, '')).length
    : value.split(/\s+/).filter(Boolean).length;
  const perSec = isChineseLike ? ZH_CHARS_PER_SEC : EN_WORDS_PER_SEC;
  // 加 350ms 的起播开销（浏览器 TTS 有固定延迟）
  return Math.round((unitCount / (perSec * safeRate)) * 1000) + 350;
}

/**
 * 取出要念的"内容块"列表。顺序固定为：序号 → 中文 → 拼音 → 英文 → 例句。
 * @param {import('./model.js').DictationItem} item
 * @param {import('./model.js').Settings} settings
 * @param {number} zhRepeat
 * @param {number} enRepeat
 * @param {number} itemIndex
 */
function buildUtterances(item, settings, zhRepeat, enRepeat, itemIndex) {
  /** @type {{ text: string, role: SpeechStep['role'], repeat: number }[]} */
  const groups = [];

  if (settings.announceIndex) {
    groups.push({ text: `第 ${itemIndex + 1} 个`, role: 'index', repeat: 1 });
  }
  if (settings.speakZh && item.zh) {
    groups.push({ text: item.zh, role: 'zh', repeat: zhRepeat });
  }
  if (settings.speakPinyin && item.pinyin) {
    groups.push({ text: item.pinyin, role: 'pinyin', repeat: zhRepeat || 1 });
  }
  if (settings.speakEn && item.en) {
    groups.push({ text: item.en, role: 'en', repeat: enRepeat });
  }
  if (settings.speakExample && item.example) {
    groups.push({ text: item.example, role: 'example', repeat: 1 });
  }

  return groups.flatMap((group) =>
    Array.from({ length: Math.max(0, group.repeat) }, () => ({ text: group.text, role: group.role }))
  );
}

/**
 * 编译播报队列。
 *
 * @param {import('./model.js').DictationItem[]} items
 * @param {Partial<import('./model.js').Settings>} [settingsInput]
 * @param {{ shuffleFn?: () => number }} [options] 便于测试时传入固定随机数
 * @returns {{ steps: Step[], totalMs: number, speakCount: number, spokenCount: number, order: number[], items: import('./model.js').DictationItem[] }}
 */
export function buildQueue(items, settingsInput, options = {}) {
  const settings = normalizeSettings(settingsInput);
  const selected = (Array.isArray(items) ? items : []).filter((item) => isItemSpeakable(item, settings));

  /** @type {number[]} */
  let order = selected.map((_, index) => index);
  if (settings.shuffle) {
    const random = options.shuffleFn ?? Math.random;
    order = order
      .map((value) => ({ value, sort: random() }))
      .sort((a, b) => a.sort - b.sort)
      .map((entry) => entry.value);
  }
  /** 实际播报顺序下的词条列表（界面直接用它渲染） */
  const list = order.map((index) => selected[index]);

  /** @type {Step[]} */
  const steps = [];
  let totalMs = 0;

  const push = (step) => {
    steps.push(step);
    if (step.kind === 'wait') totalMs += step.ms;
    else totalMs += step.estimatedMs;
  };

  if (settings.leadInMs > 0) {
    push({ kind: 'wait', id: 'leadin', itemIndex: -1, reason: 'leadin', ms: settings.leadInMs });
  }

  let speakCount = 0;

  order.forEach((originalIndex, position) => {
    const item = list[originalIndex];
    if (!item) return;
    const zhRepeat = item.zhRepeatOverride ?? settings.zhRepeat;
    const enRepeat = item.enRepeatOverride ?? settings.enRepeat;
    const utterances = buildUtterances(item, settings, zhRepeat, enRepeat, position);

    utterances.forEach((utterance, utteranceIndex) => {
      speakCount += 1;
      push({
        kind: 'speak',
        id: `${item.id}:${utteranceIndex}`,
        itemIndex: position,
        text: utterance.text,
        role: utterance.role,
        estimatedMs: estimateSpeechMs(utterance.text, utterance.role, settings.rate)
      });

      const isLastOfItem = utteranceIndex === utterances.length - 1;
      if (!isLastOfItem && settings.withinWordGapMs > 0) {
        push({
          kind: 'wait',
          id: `${item.id}:w${utteranceIndex}`,
          itemIndex: position,
          reason: 'within',
          ms: settings.withinWordGapMs
        });
      }
    });

    const isLastItem = position === order.length - 1;
    if (!isLastItem && settings.betweenWordGapMs > 0) {
      push({
        kind: 'wait',
        id: `${item.id}:b`,
        itemIndex: position,
        reason: 'between',
        ms: settings.betweenWordGapMs
      });
    }
  });

  return {
    steps,
    totalMs,
    speakCount,
    spokenCount: 0,
    /** 实际播报顺序（下标指向 selected 数组） */
    order,
    /** 实际会播报的词条，顺序与播报一致 */
    items: list
  };
}

/** 把队列按"第几个词"归组，界面上用来渲染进度条 */
export function groupStepsByItem(steps) {
  /** @type {Map<number, Step[]>} */
  const map = new Map();
  for (const step of steps) {
    if (step.itemIndex < 0) continue;
    const bucket = map.get(step.itemIndex);
    if (bucket) bucket.push(step);
    else map.set(step.itemIndex, [step]);
  }
  return map;
}

export { DEFAULT_SETTINGS };
