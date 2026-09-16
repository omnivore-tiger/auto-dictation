/**
 * 把「多张照片的文字」整理成听写词条。
 *
 * 这里是「多图互不串味」的关键：
 * 解析器 parseOcrText 内部有跨行状态（上一行的中文会把
 * 下一行的拼音 / 英文自动配对上来）。如果把多张照片的文字
 * 拼成一整段去解析，第二张图开头的拼音或英文就会被挂到第一张图
 * 最后一个词上，两张图的内容就混在一起了。
 *
 * 所以这里**逐张单独解析**，并且只替换「来自同一张照片」的旧词条。
 */
import { createItem } from './model.js';
import { parseOcrText } from './parser.js';

/**
 * @typedef {object} PhotoLike
 * @property {string} id
 * @property {string} text
 * @property {string} [parsedText] 上次成功解析用的文字（内部用，避免重复解析覆盖手改结果）
 */

/**
 * @param {PhotoLike[]} photos
 * @param {import('./model.js').DictationItem[]} existingItems
 * @param {{ autoPinyin?: (zh: string) => string }} [options]
 * @returns {{ items: import('./model.js').DictationItem[], created: number, notes: string[] }}
 */
export function assembleItemsFromPhotos(photos, existingItems, options = {}) {
  let items = Array.isArray(existingItems) ? [...existingItems] : [];
  /** @type {string[]} */
  const notes = [];
  let created = 0;

  for (const photo of photos ?? []) {
    if (!photo) continue;
    const text = String(photo.text ?? '').trim();
    if (!text) continue;

    // 文字和上次整理时一样：保持原样，绝不覆盖用户已经手改过的词条
    if (photo.parsedText === text) continue;

    const parsed = parseOcrText(text, { autoPinyin: options.autoPinyin });

    // 这次啥也没解析出来，但之前这张图是有词条的 —— 别把人家抹掉
    const fromThisPhoto = items.filter((item) => item.sourcePhotoId === photo.id);
    if (parsed.items.length === 0 && fromThisPhoto.length > 0) continue;

    const fresh = parsed.items
      .filter((item) => item.zh || item.en)
      .map((item) => createItem({ ...item, sourcePhotoId: photo.id }));

    // 只清掉「来自这张图」的旧词条；其它照片的、手动添加的一律保留
    const kept = items.filter((item) => item.sourcePhotoId !== photo.id);
    const seen = new Set(kept.map((item) => `${item.zh}||${item.en.toLowerCase()}`));
    const merged = [...kept];
    for (const item of fresh) {
      const key = `${item.zh}||${item.en.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(item);
      created += 1;
    }

    items = merged;
    photo.parsedText = text;
    notes.push(...parsed.notes);
  }

  return { items, created, notes };
}
