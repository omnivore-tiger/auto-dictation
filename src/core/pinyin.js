/**
 * 拼音标注：把中文词语转成带声调的拼音（课本样式：wū yā）。
 * 底层用 pinyin-pro（体积小、准确率高、支持多音字）。
 */
import { pinyin as pinyinPro } from 'pinyin-pro';
import { extractHan, normalizeSpaces } from './text.js';

/**
 * 给一个中文词标拼音。
 * @param {string} zh
 * @returns {string} 例如 "wū yā"；无法处理时返回空串
 */
export function annotate(zh) {
  const han = extractHan(zh ?? '');
  if (!han) return '';
  try {
    const result = pinyinPro(han, {
      toneType: 'symbol',
      type: 'array',
      // 多音字按常见读音处理即可，用户可以手动改
      nonZh: 'consecutive'
    });
    return normalizeSpaces((Array.isArray(result) ? result : [result]).join(' '));
  } catch (error) {
    console.warn('拼音标注失败：', error);
    return '';
  }
}

/**
 * 批量标注：只给还没有拼音的词条补上。
 * @template {{ zh: string, pinyin: string }} T
 * @param {T[]} items
 * @returns {number} 本次补了多少条
 */
export function annotateMissing(items) {
  let filled = 0;
  for (const item of items ?? []) {
    if (!item || !item.zh || item.pinyin) continue;
    const py = annotate(item.zh);
    if (py) {
      item.pinyin = py;
      filled += 1;
    }
  }
  return filled;
}

/**
 * 逐字拼音（用于界面上把拼音对齐显示在汉字上方）。
 * @param {string} zh
 * @returns {{ char: string, pinyin: string }[]}
 */
export function annotatePerChar(zh) {
  const chars = Array.from(extractHan(zh ?? ''));
  return chars.map((char) => ({ char, pinyin: annotate(char) }));
}
