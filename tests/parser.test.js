import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseOcrText, parseLine, parsePastedList, segmentLine, splitEnglishWords } from '../src/core/parser.js';

test('纯中文一行会切成一个字词', () => {
  const { items } = parseOcrText('乌鸦');
  assert.equal(items.length, 1);
  assert.equal(items[0].zh, '乌鸦');
});

test('拼音是天然的分隔符，一行里的多个「中文+拼音」会各自成词', () => {
  const { items } = parseOcrText('乌鸦 wū yā 葡萄 pú táo 朋友 péng yǒu');
  assert.deepEqual(
    items.map((item) => [item.zh, item.pinyin]),
    [
      ['乌鸦', 'wū yā'],
      ['葡萄', 'pú táo'],
      ['朋友', 'péng yǒu']
    ]
  );
});

test('行首编号会被去掉', () => {
  const { items } = parseOcrText('1. 乌鸦\n2、葡萄\n(3) 朋友');
  assert.deepEqual(
    items.map((item) => item.zh),
    ['乌鸦', '葡萄', '朋友']
  );
});

test('中文后面的拼音会被识别为该词的拼音', () => {
  const { items } = parseOcrText('乌鸦 wū yā\n葡萄 pú táo');
  assert.equal(items.length, 2);
  assert.equal(items[0].zh, '乌鸦');
  assert.equal(items[0].pinyin, 'wū yā');
  assert.equal(items[1].pinyin, 'pú táo');
});

test('拼音在上一行时（注音在上）会挂到下一行的中文上', () => {
  const { items } = parseOcrText('wū yā\n乌鸦\npú táo\n葡萄');
  assert.deepEqual(
    items.map((item) => [item.zh, item.pinyin]),
    [
      ['乌鸦', 'wū yā'],
      ['葡萄', 'pú táo']
    ]
  );
});

test('拼音在下一行时（注音在下）也会挂到上一个中文上', () => {
  const { items } = parseOcrText('乌鸦\nwū yā');
  assert.equal(items[0].pinyin, 'wū yā');
});

test('同一行的英文会作为对照', () => {
  const { items } = parseOcrText('乌鸦 wū yā crow');
  assert.equal(items[0].zh, '乌鸦');
  assert.equal(items[0].pinyin, 'wū yā');
  assert.equal(items[0].en, 'crow');
});

test('英文一行接在中文下一行时合并为一个词条', () => {
  const { items } = parseOcrText('苹果\napple');
  assert.equal(items.length, 1);
  assert.equal(items[0].zh, '苹果');
  assert.equal(items[0].en, 'apple');
});

test('英文在前、中文在后也能合并', () => {
  const { items } = parseOcrText('apple\n苹果');
  assert.equal(items.length, 1);
  assert.equal(items[0].zh, '苹果');
  assert.equal(items[0].en, 'apple');
});

test('中文后面的多个英文会并到该词上', () => {
  const { items } = parseOcrText('苹果 apple banana');
  assert.equal(items.length, 1);
  assert.equal(items[0].zh, '苹果');
  assert.equal(items[0].en, 'apple banana');
});

test('中英交替、英文在中文后面时各自配对', () => {
  const { items } = parseOcrText('苹果 apple 香蕉 banana');
  assert.deepEqual(
    items.map((item) => [item.zh, item.en]),
    [
      ['苹果', 'apple'],
      ['香蕉', 'banana']
    ]
  );
});

test('行首的英文会并到后面第一个中文词上', () => {
  const { items } = parseOcrText('apple 苹果');
  assert.equal(items.length, 1);
  assert.equal(items[0].zh, '苹果');
  assert.equal(items[0].en, 'apple');
});

test('纯英文行会切成多个英文词', () => {
  const { items } = parseOcrText('apple, banana; orange');
  assert.deepEqual(
    items.map((item) => item.en),
    ['apple', 'banana', 'orange']
  );
});

test('连续汉字视为一个词条（交给用户手动拆开）', () => {
  const { items } = parseOcrText('乌鸦葡萄朋友');
  assert.deepEqual(
    items.map((item) => item.zh),
    ['乌鸦葡萄朋友']
  );
});

test('汉字之间的空格不会切断词条', () => {
  const { items } = parseOcrText('乌 鸦 葡 萄');
  assert.deepEqual(
    items.map((item) => item.zh),
    ['乌鸦葡萄']
  );
});

test('自动拼音回调只给缺拼音的词条补上', () => {
  const { items, notes } = parseOcrText('乌鸦\n葡萄 pú táo', {
    autoPinyin: (zh) => (zh === '乌鸦' ? 'wū yā' : '')
  });
  assert.equal(items[0].pinyin, 'wū yā');
  assert.equal(items[1].pinyin, 'pú táo');
  assert.equal(notes.length, 1);
});

test('空文本会给出提示而不是抛错', () => {
  const { items, notes } = parseOcrText('   \n  \n');
  assert.equal(items.length, 0);
  assert.equal(notes.length, 1);
});

test('segmentLine 能把汉字、拼音、英文分开', () => {
  const segments = segmentLine('乌鸦 wū yā crow');
  const types = segments.filter((s) => s.type !== 'sep').map((s) => s.type);
  assert.ok(types.includes('han'));
  assert.ok(types.includes('pinyin'));
  assert.ok(types.includes('latin'));
});

test('parseLine 对纯英文行返回 englishOnly', () => {
  const parsed = parseLine('apple banana');
  assert.equal(parsed.englishOnly, 'apple，banana');
  assert.equal(parsed.items.length, 0);
});

test('parseLine 对纯拼音行返回 pinyinOnly', () => {
  const parsed = parseLine('wū yā');
  assert.equal(parsed.pinyinOnly, 'wū yā');
});

test('splitEnglishWords 过滤掉拼音和单字母', () => {
  assert.deepEqual(splitEnglishWords('a apple wū crow'), ['apple', 'crow']);
});

test('parsePastedList 支持「中文 拼音」和「英文」混写', () => {
  const items = parsePastedList('乌鸦 pú táo\nfriend\n朋友');
  assert.deepEqual(
    items.map((item) => [item.zh ?? '', item.en ?? '']),
    [
      ['乌鸦', ''],
      ['', 'friend'],
      ['朋友', '']
    ]
  );
});

/* ---------------------------------------------------------------- 两栏对照表 */

test('左栏英文 + 右栏中文：OCR 先读完英文栏时，中英文要按顺序一一对应', () => {
  // 这是最容易被搞岔的排版：一列英文、一列中文，OCR 按栏输出
  const { items } = parseOcrText('apple\nbanana\ncrow\n苹果\n香蕉\n乌鸦');
  assert.deepEqual(
    items.map((item) => [item.zh, item.en]),
    [
      ['苹果', 'apple'],
      ['香蕉', 'banana'],
      ['乌鸦', 'crow']
    ]
  );
});

test('左栏中文 + 右栏英文：OCR 先读完中文栏时也要一一对应', () => {
  const { items } = parseOcrText('苹果\n香蕉\n乌鸦\napple\nbanana\ncrow');
  assert.deepEqual(
    items.map((item) => [item.zh, item.en]),
    [
      ['苹果', 'apple'],
      ['香蕉', 'banana'],
      ['乌鸦', 'crow']
    ]
  );
});

test('一行里用宽空格分成两栏（英文在前）也能对应', () => {
  const { items } = parseOcrText('apple     banana    crow\n苹果       香蕉      乌鸦');
  assert.deepEqual(
    items.map((item) => [item.zh, item.en]),
    [
      ['苹果', 'apple'],
      ['香蕉', 'banana'],
      ['乌鸦', 'crow']
    ]
  );
});

test('中文一行里用宽空格分成多个词时，会各自成条（窄空格仍不切分）', () => {
  const wide = parseOcrText('苹果    香蕉    乌鸦');
  assert.deepEqual(wide.items.map((item) => item.zh), ['苹果', '香蕉', '乌鸦']);

  const narrow = parseOcrText('苹 果 香 蕉');
  assert.deepEqual(narrow.items.map((item) => item.zh), ['苹果香蕉']);
});

test('中英一行对照的中英数量不一致时，也不会把英文挂错到别的中文上', () => {
  // 英文 1 条、中文 3 条：英文应只挂到相邻的那一条，其余中文保持空
  const { items } = parseOcrText('苹果\n香蕉\n乌鸦\napple');
  const pairs = items.map((item) => [item.zh, item.en]);
  assert.deepEqual(pairs[2], ['乌鸦', 'apple']);
  assert.equal(items.filter((item) => item.en).length, 1, '只有一条应该拿到英文');
});
