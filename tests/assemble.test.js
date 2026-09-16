import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assembleItemsFromPhotos } from '../src/core/assemble.js';
import { parseOcrText } from '../src/core/parser.js';

test('两张照片的词语不会互相串味（回归测试）', () => {
  // 第一张：一个没有拼音的中文词
  // 第二张：拼音在上、中文在下（注音在上方的排版）
  // 如果把两张图拼成一段解析，第二张的拼音会被挂到第一张的「乌鸦」上。
  const combined = parseOcrText('乌鸦\npéng yǒu\n朋友');
  assert.deepEqual(
    combined.items.map((item) => [item.zh, item.pinyin]),
    [
      ['乌鸦', 'péng yǒu'],
      ['朋友', '']
    ],
    '拼接解析确实会串味（这是我们要避免的行为）'
  );

  // 逐张解析则各归各位
  const { items } = assembleItemsFromPhotos(
    [
      { id: 'p1', text: '乌鸦' },
      { id: 'p2', text: 'péng yǒu\n朋友' }
    ],
    []
  );
  assert.deepEqual(
    items.map((item) => [item.zh, item.pinyin]),
    [
      ['乌鸦', ''],
      ['朋友', 'péng yǒu']
    ]
  );
  // 每张图的词条都记得自己从哪来
  assert.deepEqual(
    items.map((item) => item.sourcePhotoId),
    ['p1', 'p2']
  );
});

test('重新解析某张图，只替换这张图的词条，不动别的图', () => {
  const photos = [
    { id: 'p1', text: '乌鸦' },
    { id: 'p2', text: '葡萄' }
  ];
  const first = assembleItemsFromPhotos(photos, []);
  assert.deepEqual(first.items.map((item) => item.zh), ['乌鸦', '葡萄']);

  // 第一张图改了文字后重新整理
  photos[0].text = '朋友';
  const second = assembleItemsFromPhotos(photos, first.items);
  assert.deepEqual(second.items.map((item) => item.zh), ['葡萄', '朋友']);
  assert.equal(second.created, 1, '只新增了 1 条（朋友）');
  // 「葡萄」仍然属于第二张图，没被动过
  const putao = second.items.find((item) => item.zh === '葡萄');
  assert.equal(putao.sourcePhotoId, 'p2');
});

test('照片文字没变时不会重复解析，用户手改的结果得以保留', () => {
  const photos = [{ id: 'p1', text: '乌鸦' }];
  const first = assembleItemsFromPhotos(photos, []);
  assert.equal(first.created, 1);

  // 模拟用户在第 2 步把拼音改成了别的
  first.items[0].pinyin = 'wū yā（我手改的）';

  const second = assembleItemsFromPhotos(photos, first.items);
  assert.equal(second.created, 0, '文字没变，不该重复新增');
  assert.equal(second.items.length, 1);
  assert.equal(second.items[0].pinyin, 'wū yā（我手改的）', '手改的拼音必须保留');
});

test('手动添加的词条（无来源照片）不会被照片解析覆盖', () => {
  const manual = [{ id: 'm1', zh: '手动词', pinyin: 'shǒu dòng cí', en: '', example: '', zhRepeatOverride: null, enRepeatOverride: null, enabled: true, sourcePhotoId: '' }];
  const { items } = assembleItemsFromPhotos([{ id: 'p1', text: '乌鸦' }], manual);
  assert.deepEqual(items.map((item) => item.zh), ['手动词', '乌鸦']);
});

test('删掉照片后，它已经整理出来的词条会保留', () => {
  const photos = [
    { id: 'p1', text: '乌鸦' },
    { id: 'p2', text: '葡萄' }
  ];
  const first = assembleItemsFromPhotos(photos, []);
  // 用户删除了第一张照片（state.photos 里只剩 p2）
  const { items } = assembleItemsFromPhotos([photos[1]], first.items);
  assert.deepEqual(items.map((item) => item.zh), ['乌鸦', '葡萄']);
});

test('解析不出内容时不会把这张图原有的词条抹掉', () => {
  const photos = [{ id: 'p1', text: '乌鸦' }];
  const first = assembleItemsFromPhotos(photos, []);
  assert.equal(first.items.length, 1);

  photos[0].text = '((('; // 改成解析不出词条的文字
  const second = assembleItemsFromPhotos(photos, first.items);
  assert.equal(second.items.length, 1, '原有词条应保留');
  assert.equal(second.items[0].zh, '乌鸦');
});
