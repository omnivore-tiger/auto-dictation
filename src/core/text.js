/**
 * 基础文本工具：字符判断、空白归一化、ID 生成等。
 * 这里刻意不依赖任何 DOM，方便直接用 node --test 做单元测试。
 */

/** 汉字（含扩展 A 区，覆盖课本用字） */
const HAN_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;
const HAN_RE_G = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/gu;
/** 拉丁字母（英文单词） */
const LATIN_RE = /[A-Za-z]/;
const LATIN_RE_G = /[A-Za-z]/g;
/** 带声调的拼音字母 */
const TONE_RE = /[āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜü]/u;
const TONE_RE_G = /[āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜü]/gu;

export function hasHan(text) {
  return HAN_RE.test(text);
}

export function extractHan(text) {
  return (text.match(HAN_RE_G) ?? []).join('');
}

export function hasLatin(text) {
  return LATIN_RE.test(text);
}

export function extractLatin(text) {
  return (text.match(LATIN_RE_G) ?? []).join('');
}

export function hasToneMark(text) {
  return TONE_RE.test(text);
}

/**
 * 把整段文字里的空白统一成单个空格，并去掉首尾空白。
 * OCR 结果里常见连续空格、制表符、不间断空格，这里一并处理。
 */
export function normalizeSpaces(text) {
  return String(text ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/[\t\u3000]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
}

/**
 * 切分成行：按换行拆开，去掉空行，每行做空白归一化。
 */
export function toLines(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((line) => normalizeSpaces(line))
    .filter((line) => line.length > 0);
}

/** 去掉所有空白，用于比较"这行和上一行是不是同一串内容" */
export function stripSpaces(text) {
  return String(text ?? '').replace(/\s+/g, '');
}

/**
 * 判断一段文本是不是"纯拼音行"，例如 "wū yā"、"xiǎo péng yǒu"、"wu ya"。
 * 规则：不含汉字；只由字母/声调字母/空格/撇号/连字符/数字声调组成；
 * 且至少有一个音节长度 >= 2（避免把单个字母当成拼音）。
 */
export function isPinyinLine(text) {
  const raw = normalizeSpaces(text);
  if (!raw) return false;
  if (hasHan(raw)) return false;
  if (!/^[A-Za-z\u00c0-\u024f\u0100-\u024f\u0300-\u036f'’\-\s\d]+$/u.test(raw)) return false;
  if (!hasLatin(raw)) return false;
  // 至少有一个"像拼音"的音节
  return raw
    .split(/\s+/)
    .some((token) => /^[A-Za-z\u00c0-\u024f'’\-]{2,}\d?$/u.test(token));
}

/**
 * 判断一段文本是不是"英文句子/短语"（不含汉字，含至少 2 个字母的单词）。
 */
export function isEnglishLine(text) {
  const raw = normalizeSpaces(text);
  if (!raw || hasHan(raw)) return false;
  if (!hasLatin(raw)) return false;
  if (isPinyinLine(raw)) return false;
  return /[A-Za-z]{2,}/.test(raw);
}

/** 生成短 ID（够用且无需依赖 crypto） */
export function makeId(prefix = 'id') {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}${rand}`;
}

/** 限制数值范围，用于设置项兜底 */
export function clampNumber(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

/** 把毫秒格式化成 "1:05" 这样的显示文本 */
export function formatDuration(ms) {
  const total = Math.max(0, Math.round(Number(ms) || 0) / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = Math.floor(total % 60);
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}
