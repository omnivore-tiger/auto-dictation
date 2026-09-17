/**
 * 课本图片 OCR 结果解析。
 *
 * 目标：把 Tesseract 吐出来的"一坨文本"尽可能还原成一条条听写词条。
 * 课本排版千奇百怪，所以这里坚持两个原则：
 *   1. 只做"高置信度"的自动拆分，拿不准就原样保留，交给用户在界面上手动改；
 *   2. 解析结果一定是可编辑的数组，不做任何不可逆的丢弃。
 */
import { createItem } from './model.js';
import { extractHan, hasHan, hasLatin, hasToneMark, normalizeSpaces } from './text.js';

/** 汉字、数字圈号等与字母之间插入空格，便于后续切片 */
const SEPARATOR_RE = /[\s,，、;；:：.。!！?？/\\|()[\]{}<>《》「」『』""''"'"'\-—–~·…*#@&+=%$^_]+/u;
const HAN_RUN_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/u;
const HAN_SPLIT_RE = /([\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+)/u;
const PINYIN_TOKEN_RE = /^[A-Za-z\u00c0-\u024f'’]{2,}\d?$/u;
const TONE_TOKEN_RE = /^[A-Za-z\u00c0-\u024f'’]*[āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜü][A-Za-z\u00c0-\u024f'’]*\d?$/u;
/** 行首编号： "1." "2、" "(3)" "①" 等 */
const LEADING_INDEX_RE = /^\s*(?:[(（[【]?\d{1,3}[)）\]】]?\s*[.、,，:：)）]?\s*|[①-⑳]\s*)/u;

const NBSP = /\u00a0/g;

/**
 * @typedef {object} Segment
 * @property {'han'|'pinyin'|'latin'|'sep'} type
 * @property {string} raw
 * @property {string} normalized
 */

/**
 * 把一行切成"汉字 / 拼音 / 英文 / 分隔符"四类片段。
 * @param {string} line
 * @returns {Segment[]}
 */
export function segmentLine(line) {
  const text = String(line ?? '').replace(NBSP, ' ');
  /** @type {Segment[]} */
  const segments = [];
  let buffer = '';
  /** @type {Segment['type']|null} */
  let bufferType = null;

  const flush = () => {
    if (!buffer) return;
    const raw = buffer;
    const normalized = normalizeSpaces(raw.replace(/\s+/g, ' '));
    if (normalized) segments.push({ type: /** @type {Segment['type']} */ (bufferType), raw, normalized });
    buffer = '';
    bufferType = null;
  };

  for (const char of text) {
    /** @type {Segment['type']} */
    let type;
    if (/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u.test(char)) type = 'han';
    else if (SEPARATOR_RE.test(char)) type = 'sep';
    else if (/[A-Za-z\u00c0-\u024f'’\d]/u.test(char)) type = 'latin';
    else type = 'sep';

    if (bufferType !== null && type !== bufferType) flush();
    if (type === 'sep') {
      flush();
      segments.push({ type: 'sep', raw: char, normalized: '' });
      continue;
    }
    bufferType = type;
    buffer += char;
  }
  flush();

  // 把 latin 片段进一步区分为 pinyin / latin
  return segments.map((seg) => {
    if (seg.type !== 'latin') return seg;
    const tokens = seg.normalized.split(/\s+/).filter(Boolean);
    const pinyinTokens = tokens.filter(isPinyinToken);
    if (pinyinTokens.length === 0) return seg;
    if (pinyinTokens.length === tokens.length) return { ...seg, type: 'pinyin' };
    // 混合片段（例如 "apple ma"）：按 token 再切开
    return seg;
  });
}

/** 单个 token 是否像拼音：带声调字母，或"看起来像拼音音节"且在常见音节表里 */
export function isPinyinToken(token) {
  const t = String(token ?? '').trim();
  if (!t) return false;
  if (hasToneMark(t)) return true;
  if (!PINYIN_TOKEN_RE.test(t)) return false;
  // 无音调时靠"是否像汉语音节"判断，避免把 apple/crow 当拼音
  return looksLikePinyinSyllable(t);
}

/**
 * 无音调拼音音节的启发式判断，覆盖课本里常见的写法。
 * @param {string} token
 */
export function looksLikePinyinSyllable(token) {
  const t = token.toLowerCase().replace(/[1-5]$/, '');
  if (t.length < 1 || t.length > 6) return false;
  if (COMMON_PINYIN.has(t)) return true;
  if (PINYIN_PREFIXES.has(t)) return true;
  if (PINYIN_SUFFIXES.has(t)) return true;
  return false;
}

/** 汉语拼音的 400 多个基础音节（无声调），用于无音调拼音的识别 */
const COMMON_PINYIN = new Set(
  (
    'a ai an ang ao e ei en eng er o ou ' +
    'ba bai ban bang bao bei ben beng bi bian biao bie bin bing bo bu ' +
    'pa pai pan pang pao pei pen peng pi pian piao pie pin ping po pou pu ' +
    'ma mai man mang mao me mei men meng mi mian miao mie min ming miu mo mou mu ' +
    'fa fan fang fei fen feng fo fou fu ' +
    'da dai dan dang dao de dei den deng di dia dian diao die ding diu dong dou du duan dui dun duo ' +
    'ta tai tan tang tao te teng ti tian tiao tie ting tong tou tu tuan tui tun tuo ' +
    'na nai nan nang nao ne nei nen neng ni nian niang niao nie nin ning niu nong nou nu nuan nue nuo nv ' +
    'la lai lan lang lao le lei leng li lia lian liang liao lie lin ling liu lo long lou lu luan lue lun luo lv ' +
    'ga gai gan gang gao ge gei gen geng gong gou gu gua guai guan guang gui gun guo ' +
    'ka kai kan kang kao ke ken keng kong kou ku kua kuai kuan kuang kui kun kuo ' +
    'ha hai han hang hao he hei hen heng hong hou hu hua huai huan huang hui hun huo ' +
    'ji jia jian jiang jiao jie jin jing jiong jiu ju juan jue jun ' +
    'qi qia qian qiang qiao qie qin qing qiong qiu qu quan que qun ' +
    'xi xia xian xiang xiao xie xin xing xiong xiu xu xuan xue xun ' +
    'zha zhai zhan zhang zhao zhe zhei zhen zheng zhi zhong zhou zhu zhua zhuai zhuan zhuang zhui zhun zhuo ' +
    'cha chai chan chang chao che chen cheng chi chong chou chu chua chuai chuan chuang chui chun chuo ' +
    'sha shai shan shang shao she shei shen sheng shi shou shu shua shuai shuan shuang shui shun shuo ' +
    'ran rang rao re ren reng ri rong rou ru rua ruan rui run ruo ' +
    'za zai zan zang zao ze zei zen zeng zi zong zou zu zuan zui zun zuo ' +
    'ca cai can cang cao ce cen ceng ci cong cou cu cuan cui cun cuo ' +
    'sa sai san sang sao se sen seng si song sou su suan sui sun suo ' +
    'ya yan yang yao ye yi yin ying yo yong you yu yuan yue yun ' +
    'wa wai wan wang wei wen weng wo wu'
  ).split(/\s+/),
);

/** 拼音首字母/尾字母组合，用于兜底识别（例如书本上的轻声 "de"、"le"） */
const PINYIN_PREFIXES = new Set(['zh', 'ch', 'sh', 'ng', 'hm', 'hng']);
const PINYIN_SUFFIXES = new Set(['r', 'n', 'ng']);

/**
 * 把一行的片段切成若干"词条组"。
 *
 * 规则来自课本的真实排版：
 *   - 「乌鸦」                → 一块，就是一个词
 *   - 「乌鸦 wū yā 葡萄 pú táo」→ 拼音是天然的分隔符，得到两个词，拼音各自跟在后面的词上
 *   - 「apple 苹果 banana 香蕉」→ 英文和中文交替，各自配对
 *   - 「小猫在睡觉」          → 一整块（用户想拆可以点「拆开」或「拆成单字」）
 *
 * 之所以不做"无空格中文分词"，是因为那需要 15MB+ 的词典，对要离线运行的 PWA 不划算；
 * 界面上提供了拆开 / 合并来兜底。
 *
 * @param {Segment[]} segments
 * @returns {{ zh: string, pinyin: string, en: string }[]}
 */
function groupIntoSenses(segments) {
  /** @type {{ zh: string, pinyin: string, en: string }[]} */
  const groups = [];
  /** @type {{ zh: string, pinyin: string, en: string }|null} */
  let current = null;
  /** 当前组是否已经吸收了拼音/英文（用来决定下一个汉字块是否另起一组） */
  let absorbed = false;

  const startGroup = () => {
    current = { zh: '', pinyin: '', en: '' };
    absorbed = false;
    groups.push(current);
    return current;
  };

  for (const seg of segments) {
    if (seg.type === 'sep') continue;

    if (seg.type === 'han') {
      // 连续汉字（中间只有空格）并入同一组；被拼音/英文打断后另起一组
      const group = current && !absorbed ? /** @type {any} */ (current) : startGroup();
      group.zh += seg.normalized;
      continue;
    }

    // 拼音 / 英文挂在当前组上
    const group = current ?? startGroup();
    for (const token of seg.normalized.split(/\s+/)) {
      if (!token) continue;
      if (isPinyinToken(token)) {
        group.pinyin = group.pinyin ? `${group.pinyin} ${token}` : token;
        absorbed = true;
      } else {
        const word = token.replace(/[^A-Za-z'’-]/g, '');
        if (word.length >= 2) {
          group.en = group.en ? `${group.en} ${word}` : word;
          absorbed = true;
        }
      }
    }
  }

  // 没有汉字的"孤儿"内容（例如行首就是英文）统一并到第一个中文词条上，
  // 因为这多半是 OCR 把同一行的中英对照读反了顺序。
  const out = groups.filter((group) => group.zh);
  const orphans = groups.filter((group) => !group.zh && (group.pinyin || group.en));
  if (out.length > 0 && orphans.length > 0) {
    const first = out[0];
    for (const orphan of orphans) {
      if (orphan.pinyin) first.pinyin = [first.pinyin, orphan.pinyin].filter(Boolean).join(' ');
      if (orphan.en) first.en = [first.en, orphan.en].filter(Boolean).join(' ');
    }
  }
  // 整行都没有汉字时，把攒下来的内容原样返回，交给上层当英文处理
  if (out.length === 0 && orphans.length > 0) out.push(...orphans);

  return out;
}

/**
 * 一行文本 → 若干词条。
 * @param {string} line
 * @returns {{ items: ReturnType<typeof createItem>[], pinyinOnly: string, englishOnly: string }}
 */
export function parseLine(line) {
  const raw = normalizeSpaces(String(line ?? '').replace(NBSP, ' '));
  const empty = { items: [], pinyinOnly: '', englishOnly: '' };
  if (!raw) return empty;

  const withoutIndex = raw.replace(LEADING_INDEX_RE, '');
  const hasHanChar = hasHan(withoutIndex);
  const hanOnly = !hasHanChar && hasLatin(withoutIndex);

  // 纯拼音行
  if (hanOnly && isPinyinOnlyText(withoutIndex)) {
    return { items: [], pinyinOnly: withoutIndex.trim(), englishOnly: '' };
  }

  // 纯英文行（可能是一串用逗号/空格分隔的单词）
  if (hanOnly) {
    const words = splitEnglishWords(withoutIndex);
    return { items: [], pinyinOnly: '', englishOnly: words.join('，') };
  }

  const groups = groupIntoSenses(segmentLine(withoutIndex));
  const withHan = groups.filter((group) => group.zh);

  if (withHan.length > 0) {
    return {
      items: withHan.map((group) => createItem({ zh: group.zh, pinyin: group.pinyin, en: group.en })),
      pinyinOnly: '',
      englishOnly: ''
    };
  }

  // 没有汉字：整行按拼音或英文处理
  const joined = groups.map((group) => group.pinyin || group.en).filter(Boolean).join(' ');
  if (joined && isPinyinOnlyText(joined)) return { items: [], pinyinOnly: joined, englishOnly: '' };

  const fallback = raw.replace(LEADING_INDEX_RE, '').trim();
  return { items: [], pinyinOnly: '', englishOnly: fallback };
}

/** 整行是否"只有拼音" */
function isPinyinOnlyText(text) {
  const tokens = normalizeSpaces(text)
    .split(/[\s,，、;；/]+/)
    .filter(Boolean);
  if (tokens.length === 0) return false;
  return tokens.every((t) => isPinyinToken(t) || /^\d+$/.test(t));
}

/**
 * 纯英文行按分隔符切成多个单词。
 * @param {string} text
 */
export function splitEnglishWords(text) {
  return normalizeSpaces(text)
    .split(/[\s,，、;；/|]+/)
    .map((w) => w.replace(/^[^A-Za-z]+|[^A-Za-z'’-]+$/g, ''))
    .filter((w) => w.length >= 2 && !isPinyinToken(w));
}

/**
 * 把 OCR 出来的整段文本解析成词条数组。
 *
 * 支持两种最常见的课本排版：
 *   1. 行内对照： 「apple 苹果」「乌鸦 wū yā crow」
 *   2. 分栏对照： 左栏英文、右栏中文。OCR 有可能一行一行读（每行中英各一个），
 *      也有可能先把一整栏读完再读另一栏。
 *
 * 第 2 种最容易出错：如果只是简单地"下一行英文挂到上一个中文"，
 * 一整栏英文会全部挤到同一个词上，中英文就对岔了。
 * 所以这里先把文本整理成一"段"一"段"（连续的中文行算一段、连续的英文行算一段），
 * 再让英文段/拼音段去找**数量相等**的那一段中文，逐条按顺序对上。
 *
 * @param {string} text OCR 原始文本
 * @param {{ autoPinyin?: (zh: string) => string }} [options]
 * @returns {{ items: ReturnType<typeof createItem>[], notes: string[] }}
 */
export function parseOcrText(text, options = {}) {
  /** @type {{ kind: 'zh'|'en'|'pinyin', items: any[], words: string[], start?: number, end?: number }[]} */
  const runs = [];

  const pushRun = (kind, list) => {
    const last = runs[runs.length - 1];
    if (last && last.kind === kind) {
      if (kind === 'zh') last.items.push(...list);
      else last.words.push(...list);
      return;
    }
    runs.push({
      kind,
      items: kind === 'zh' ? [...list] : [],
      words: kind === 'zh' ? [] : [...list]
    });
  };

  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const raw = String(rawLine ?? '').replace(NBSP, ' ');
    if (!normalizeSpaces(raw)) continue;

    /** @type {ReturnType<typeof createItem>[]} */
    const zhItems = [];
    /** @type {string[]} */
    const enWords = [];
    /** @type {string[]} */
    const pyParts = [];

    // 一行里可能被"宽空格"分成好几栏（表格排版）
    for (const cell of splitCells(raw)) {
      const parsed = parseLine(cell);
      if (parsed.items.length > 0) zhItems.push(...parsed.items);
      else if (parsed.pinyinOnly) pyParts.push(parsed.pinyinOnly);
      else if (parsed.englishOnly) enWords.push(...splitEnglishWords(parsed.englishOnly));
    }

    if (zhItems.length > 0) {
      // 同一行里被分栏成「中文 | 英文」时，就地逐条配对
      attachByIndex(zhItems, pyParts, 'pinyin');
      attachByIndex(zhItems, enWords, 'en');
      pushRun('zh', zhItems);
      continue;
    }
    if (enWords.length > 0) {
      pushRun('en', enWords);
      continue;
    }
    if (pyParts.length > 0) pushRun('pinyin', pyParts);
  }

  // 先把所有中文段按顺序展开，并记下每条在 items 里的下标区间
  /** @type {ReturnType<typeof createItem>[]} */
  const items = [];
  for (const run of runs) {
    if (run.kind !== 'zh') continue;
    run.start = items.length;
    items.push(...run.items);
    run.end = items.length - 1;
  }

  // 再让每个英文/拼音段找到对应的中文段。
  // 一段中文可以被"拼音"和"英文"各占用一次（例如拼音在上、英文在下），
  // 但同一种内容不会重复占用同一段，否则交替排版（拼音/中文/拼音/中文）会配错。
  /** @type {Map<number, Set<string>>} */
  const usedBy = new Map();
  const isFree = (idx, kind) => {
    if (idx < 0 || idx >= runs.length || runs[idx].kind !== 'zh') return false;
    const set = usedBy.get(idx);
    return !set || !set.has(kind);
  };
  const markUsed = (idx, kind) => {
    if (!usedBy.has(idx)) usedBy.set(idx, new Set());
    /** @type {Set<string>} */ (usedBy.get(idx)).add(kind);
  };

  for (let i = 0; i < runs.length; i += 1) {
    const run = runs[i];
    if (run.kind === 'zh') continue;

    const kind = run.kind;
    const prevIdx = isFree(i - 1, kind) ? i - 1 : -1;
    const nextIdx = isFree(i + 1, kind) ? i + 1 : -1;
    const size = run.words.length;
    const prevRun = prevIdx >= 0 ? runs[prevIdx] : null;
    const nextRun = nextIdx >= 0 ? runs[nextIdx] : null;
    const prevSize = prevRun ? (prevRun.end ?? 0) - (prevRun.start ?? 0) + 1 : 0;
    const nextSize = nextRun ? (nextRun.end ?? 0) - (nextRun.start ?? 0) + 1 : 0;

    // 优先配给"数量正好相等"的那一段；前面配不上再看后面
    let chosenIdx = -1;
    if (prevIdx >= 0 && prevSize === size) chosenIdx = prevIdx;
    else if (nextIdx >= 0 && nextSize === size) chosenIdx = nextIdx;
    else if (prevIdx >= 0) chosenIdx = prevIdx;
    else if (nextIdx >= 0) chosenIdx = nextIdx;

    /** @type {number[]} */
    let targets = [];
    if (chosenIdx >= 0) {
      const chosen = /** @type {any} */ (runs[chosenIdx]);
      if (chosen.end - chosen.start + 1 === size) {
        targets = indexRange(chosen.start, chosen.end);
      } else if (chosenIdx === prevIdx) {
        targets = indexRange(Math.max(chosen.start, chosen.end - size + 1), chosen.end);
      } else {
        targets = indexRange(chosen.start, Math.min(chosen.end, chosen.start + size - 1));
      }
      markUsed(chosenIdx, kind);
    }

    run.words.forEach((value, k) => {
      const item = items[targets[k]];
      if (!item) {
        // 没配上中文的英文词单独成条（例如整张图只有英文）
        if (kind === 'en') items.push(createItem({ en: value }));
        return;
      }
      if (kind === 'pinyin') {
        if (!item.pinyin) item.pinyin = value;
      } else if (!item.en) {
        item.en = value;
      }
    });
  }

  // 自动补拼音
  const autoPinyin = options.autoPinyin;
  /** @type {string[]} */
  const notes = [];
  if (typeof autoPinyin === 'function') {
    let filled = 0;
    for (const item of items) {
      if (item.zh && !item.pinyin) {
        const py = autoPinyin(item.zh);
        if (py) {
          item.pinyin = py;
          filled += 1;
        }
      }
    }
    if (filled > 0) notes.push(`已自动为 ${filled} 个词语标注拼音，可在词条里手动修改。`);
  }

  if (items.length === 0) {
    notes.push('没有识别出词条，可以换一张更清晰的照片，或直接在下方手动添加词语。');
  }

  return { items, notes };
}

/** 一行里用连续 2 个及以上空格（或制表符）当作"分栏" */
const COLUMN_GAP_RE = /[ \t\u3000]{2,}/u;

/**
 * 按"宽空格"把一行切成若干栏。
 * 注意：单个空格不切分，因为 OCR 常把「乌鸦」读成「乌 鸦」。
 * @param {string} raw
 */
export function splitCells(raw) {
  return String(raw ?? '')
    .split(COLUMN_GAP_RE)
    .map((cell) => cell.trim())
    .filter(Boolean);
}

/**
 * 把一组值按顺序挂到一组词条上。
 * @param {{ pinyin: string, en: string }[]} targetItems
 * @param {string[]} values
 * @param {'pinyin'|'en'} field
 */
function attachByIndex(targetItems, values, field) {
  values.forEach((value, k) => {
    const item = targetItems[k];
    if (!item) return;
    if (field === 'pinyin') {
      if (!item.pinyin) item.pinyin = value;
    } else if (!item.en) {
      item.en = value;
    }
  });
}

/** 生成 [from, to] 的下标数组 */
function indexRange(from, to) {
  /** @type {number[]} */
  const out = [];
  for (let i = from; i <= to; i += 1) out.push(i);
  return out;
}

/**
 * 给界面上的"手动修正"用：把一大段粘贴文本切成词条。
 * 比 OCR 解析更宽松——每一行/每个分隔符都当作一个词。
 * @param {string} text
 */
export function parsePastedList(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  /** @type {ReturnType<typeof createItem>[]} */
  const items = [];
  for (const line of lines) {
    const parsed = parseLine(line);
    if (parsed.items.length) items.push(...parsed.items);
    else if (parsed.englishOnly) {
      for (const w of splitEnglishWords(parsed.englishOnly)) items.push(createItem({ en: w }));
    }
  }
  return items;
}

export { extractHan, hasHan, hasLatin };
