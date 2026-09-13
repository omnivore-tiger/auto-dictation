import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanItems, createItem, createProject, isItemSpeakable, normalizeSettings } from '../src/core/model.js';
import { annotate } from '../src/core/pinyin.js';
import { buildQueue, estimateSpeechMs } from '../src/core/scheduler.js';

const baseSettings = normalizeSettings({
  speakZh: true,
  speakEn: true,
  speakPinyin: false,
  speakExample: false,
  // 默认设置里有 3 秒准备时间，会让"停顿条数"的断言变复杂，测试里默认关掉
  leadInMs: 0
});

test('normalizeSettings 会给越界和缺失的值兜底', () => {
  const settings = normalizeSettings({ zhRepeat: 999, rate: 100, withinWordGapMs: -5, speakZh: 'yes' });
  assert.equal(settings.zhRepeat, 10);
  assert.equal(settings.rate, 2);
  assert.equal(settings.withinWordGapMs, 0);
  assert.equal(settings.speakZh, true); // 非布尔值回落到默认
});

test('createItem 会清理空白并默认启用', () => {
  const item = createItem({ zh: '  乌鸦  ', en: ' crow ' });
  assert.equal(item.zh, '乌鸦');
  assert.equal(item.en, 'crow');
  assert.equal(item.enabled, true);
  assert.ok(item.id);
});

test('cleanItems 会去掉空词条并按中英组合去重', () => {
  const items = cleanItems([
    { zh: '乌鸦', en: '' },
    { zh: '乌鸦', en: '' },
    { zh: '', en: '' },
    { zh: '葡萄', en: 'grape' }
  ]);
  assert.equal(items.length, 2);
});

test('isItemSpeakable 尊重开关与 enabled', () => {
  const item = createItem({ zh: '乌鸦' });
  assert.equal(isItemSpeakable(item, baseSettings), true);
  assert.equal(isItemSpeakable(item, normalizeSettings({ speakZh: false })), false);
  assert.equal(isItemSpeakable(createItem({ zh: '乌鸦', enabled: false }), baseSettings), false);
});

test('拼音标注基本正确', () => {
  assert.equal(annotate('乌鸦'), 'wū yā');
  assert.equal(annotate('葡萄'), 'pú táo');
  assert.equal(annotate(''), '');
});

test('中文念 2 遍、英文念 1 遍时，一个词会有 3 次朗读', () => {
  const items = [createItem({ zh: '乌鸦', en: 'crow' })];
  const queue = buildQueue(items, { ...baseSettings, zhRepeat: 2, enRepeat: 1, withinWordGapMs: 100, betweenWordGapMs: 200 });
  const speaks = queue.steps.filter((s) => s.kind === 'speak');
  assert.equal(speaks.length, 3);
  assert.deepEqual(
    speaks.map((s) => s.text),
    ['乌鸦', '乌鸦', 'crow']
  );
});

test('同一个词两次朗读之间会插入设定好的间隔', () => {
  const items = [createItem({ zh: '乌鸦' })];
  const queue = buildQueue(items, { ...baseSettings, zhRepeat: 3, withinWordGapMs: 1500, betweenWordGapMs: 0 });
  const waits = queue.steps.filter((s) => s.kind === 'wait');
  assert.equal(waits.length, 2);
  assert.ok(waits.every((w) => w.reason === 'within' && w.ms === 1500));
});

test('词与词之间会插入"留给孩子写"的停顿，最后一个词后面没有', () => {
  const items = [createItem({ zh: '乌鸦' }), createItem({ zh: '葡萄' }), createItem({ zh: '朋友' })];
  const queue = buildQueue(items, { ...baseSettings, zhRepeat: 1, enRepeat: 0, withinWordGapMs: 0, betweenWordGapMs: 8000 });
  const waits = queue.steps.filter((s) => s.kind === 'wait');
  assert.equal(waits.length, 2);
  assert.ok(waits.every((w) => w.reason === 'between' && w.ms === 8000));
  // 最后一个步骤一定是朗读，而不是停顿
  assert.equal(queue.steps[queue.steps.length - 1].kind, 'speak');
});

test('准备倒计时会作为第一步', () => {
  const items = [createItem({ zh: '乌鸦' })];
  const queue = buildQueue(items, { ...baseSettings, leadInMs: 3000 });
  assert.equal(queue.steps[0].kind, 'wait');
  assert.equal(queue.steps[0].reason, 'leadin');
  assert.equal(queue.steps[0].ms, 3000);
});

test('词条单独设置遍数会覆盖全局设置', () => {
  const items = [createItem({ zh: '乌鸦', zhRepeatOverride: 5 })];
  const queue = buildQueue(items, { ...baseSettings, zhRepeat: 1, enRepeat: 0, withinWordGapMs: 0, betweenWordGapMs: 0 });
  assert.equal(queue.steps.filter((s) => s.kind === 'speak').length, 5);
});

test('没有内容可念的词条被排除，队列里不含它', () => {
  const items = [createItem({ zh: '乌鸦' }), createItem({ zh: '', en: '' }), createItem({ zh: '葡萄', enabled: false })];
  const queue = buildQueue(items, baseSettings);
  assert.equal(queue.items.length, 1);
  assert.equal(queue.items[0].zh, '乌鸦');
});

test('打乱顺序时用固定随机数也能得到确定的顺序', () => {
  const items = [createItem({ zh: '甲' }), createItem({ zh: '乙' }), createItem({ zh: '丙' })];
  let seed = 0.9;
  const queue = buildQueue(
    items,
    { ...baseSettings, shuffle: true, zhRepeat: 1, enRepeat: 0 },
    { shuffleFn: () => (seed = (seed * 7) % 1) }
  );
  assert.equal(queue.items.length, 3);
  assert.equal(new Set(queue.items.map((i) => i.zh)).size, 3);
});

test('总时长包含朗读估算与所有停顿', () => {
  const items = [createItem({ zh: '乌鸦' })];
  const queue = buildQueue(items, { ...baseSettings, zhRepeat: 2, enRepeat: 0, withinWordGapMs: 1000, betweenWordGapMs: 0, leadInMs: 0 });
  const speakMs = queue.steps.filter((s) => s.kind === 'speak').reduce((sum, s) => sum + s.estimatedMs, 0);
  assert.equal(queue.totalMs, speakMs + 1000);
});

test('estimateSpeechMs 会随语速变化', () => {
  const slow = estimateSpeechMs('乌鸦喝水', 'zh', 0.5);
  const fast = estimateSpeechMs('乌鸦喝水', 'zh', 2);
  assert.ok(slow > fast);
  assert.ok(fast > 0);
});

test('项目会带上默认设置与清洗后的词条', () => {
  const project = createProject({ name: '第一课', items: [{ zh: '乌鸦' }, { zh: '' }] });
  assert.equal(project.name, '第一课');
  assert.equal(project.items.length, 1);
  assert.equal(project.settings.zhRepeat, 2);
});
