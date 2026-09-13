/**
 * 第 2 步：核对 / 修改词语。
 * 这是"识别不准也没关系"的关键——所有内容都可以在这里改到满意为止。
 */
import { createItem, isItemSpeakable } from '../core/model.js';
import { annotate } from '../core/pinyin.js';
import { parsePastedList } from '../core/parser.js';
import { extractHan } from '../core/text.js';
import { go, persist, state, touch } from './state.js';
import { clear, confirmAction, el, toast } from './utils.js';
import { requestSeek } from './play.js';

/** 搜索关键词（仅界面状态） */
let filterText = '';
let onlyEnabled = false;

export function renderWords(root) {
  clear(root);

  const items = state.project.items ?? [];
  root.append(buildHeader(items));
  if (items.length === 0) {
    root.append(buildEmpty());
    return;
  }
  root.append(buildBatchAdd());
  root.append(buildList(items));
}

function buildHeader(items) {
  const speakable = items.filter((item) => isItemSpeakable(item, state.project.settings)).length;

  const searchInput = el('input', {
    type: 'search',
    class: 'input',
    placeholder: '搜索词语…',
    value: filterText,
    oninput: (event) => {
      filterText = event.target.value;
      renderWords(document.querySelector('[data-screen="words"]'));
    }
  });

  const onlyEnabledInput = el('input', {
    type: 'checkbox',
    checked: onlyEnabled,
    onchange: (event) => {
      onlyEnabled = event.target.checked;
      renderWords(document.querySelector('[data-screen="words"]'));
    }
  });

  return el('div.card.card--flat', {}, [
    el('div.row.row--between.row--wrap', {}, [
      el('div', {}, [
        el('h2.card__title', { text: `共 ${items.length} 个词条，可播报 ${speakable} 个` }),
        el('p.card__hint', { text: '所有内容都可以直接改：中文、拼音、英文、例句。改完自动保存。' })
      ]),
      el('div.row', {}, [
        el('button', {
          type: 'button',
          class: 'btn btn--outline',
          text: '全部标注拼音',
          onclick: () => {
            let filled = 0;
            for (const item of state.project.items) {
              if (item.zh && !item.pinyin) {
                const py = annotate(item.zh);
                if (py) {
                  item.pinyin = py;
                  filled += 1;
                }
              }
            }
            persist();
            toast(filled > 0 ? `已为 ${filled} 个词条补上拼音` : '没有需要补拼音的词条', filled > 0 ? 'success' : 'info');
            touch();
          }
        }),
        el('button', {
          type: 'button',
          class: 'btn btn--primary',
          text: '下一步：开始听写',
          onclick: () => go('play')
        })
      ])
    ]),
    el('div.row.row--wrap.words-toolbar', {}, [
      el('label.field.field--grow', {}, [el('span.field__label', { text: '查找' }), searchInput]),
      el('label.checkbox', {}, [onlyEnabledInput, el('span', { text: '只看本次会播报的' })])
    ])
  ]);
}

function buildEmpty() {
  return el('div.card.empty-state', {}, [
    el('div.empty-state__icon', { text: '📝' }),
    el('h3', { text: '还没有词语' }),
    el('p.muted', { text: '可以回到第 1 步拍照识别，也可以直接在下面手动添加。' }),
    el('div.row', {}, [
      el('button', { type: 'button', class: 'btn btn--primary', text: '去拍照识别', onclick: () => go('photos') }),
      el('button', {
        type: 'button',
        class: 'btn btn--outline',
        text: '手动添加一个词',
        onclick: () => {
          state.project.items.push(createItem({ zh: '新词语' }));
          persist();
          touch();
        }
      })
    ]),
    buildBatchAdd()
  ]);
}

function buildBatchAdd() {
  const textarea = el('textarea', {
    class: 'textarea',
    rows: 3,
    placeholder: '批量添加：每行一个词语，例如「乌鸦 pú táo」「friend 朋友」'
  });

  return el('details.card.card--flat.batch-add', {}, [
    el('summary', { text: '批量添加 / 粘贴词语' }),
    textarea,
    el('div.row.row--end', {}, [
      el('button', {
        type: 'button',
        class: 'btn btn--primary btn--sm',
        text: '添加到列表',
        onclick: () => {
          const parsed = parsePastedList(textarea.value);
          if (parsed.length === 0) {
            toast('没有解析出词语', 'warn');
            return;
          }
          for (const item of parsed) {
            if (!item.pinyin && item.zh) item.pinyin = annotate(item.zh);
            state.project.items.push(createItem(item));
          }
          persist();
          textarea.value = '';
          toast(`已添加 ${parsed.length} 个词语`, 'success');
          touch();
        }
      })
    ])
  ]);
}

/**
 * @param {import('../core/model.js').DictationItem[]} items
 */
function buildList(items) {
  const keyword = filterText.trim().toLowerCase();
  const visible = items.filter((item) => {
    if (onlyEnabled && !isItemSpeakable(item, state.project.settings)) return false;
    if (!keyword) return true;
    return [item.zh, item.pinyin, item.en, item.example].join(' ').toLowerCase().includes(keyword);
  });

  const list = el('div.word-list');
  if (visible.length === 0) {
    list.append(el('p.muted', { text: '没有符合条件的词条。' }));
    return list;
  }

  visible.forEach((item) => {
    const index = items.indexOf(item);
    list.append(buildRow(item, index, items));
  });

  list.append(
    el('div.row.row--between.row--wrap.list-footer', {}, [
      el('button', {
        type: 'button',
        class: 'btn btn--ghost',
        text: '打乱顺序',
        onclick: () => {
          const shuffled = items.slice().sort(() => Math.random() - 0.5);
          state.project.items = shuffled;
          persist();
          toast('已打乱词条顺序', 'success');
          touch();
        }
      }),
      el('button', {
        type: 'button',
        class: 'btn btn--danger-ghost',
        text: '删除所有空词条',
        onclick: () => {
          state.project.items = items.filter((item) => item.zh || item.en);
          persist();
          touch();
        }
      }),
      el('button', {
        type: 'button',
        class: 'btn btn--danger-ghost',
        text: '清空全部词语',
        onclick: () => {
          if (!confirmAction('确定要删除所有词语吗？此操作无法撤销。')) return;
          state.project.items = [];
          persist();
          touch();
        }
      })
    ])
  );

  return list;
}

/**
 * 一行词条。
 * @param {import('../core/model.js').DictationItem} item
 * @param {number} index
 * @param {import('../core/model.js').DictationItem[]} items
 */
function buildRow(item, index, items) {
  const enabledInput = el('input', {
    type: 'checkbox',
    checked: item.enabled !== false,
    title: '是否纳入本次听写',
    onchange: (event) => {
      item.enabled = event.target.checked;
      persist();
      touch();
    }
  });

  return el('div.card.word-row', { dataset: { index: String(index) } }, [
    el('div.word-row__head', {}, [
      el('span.word-row__no', { text: String(index + 1) }),
      el('label.checkbox.checkbox--compact', { title: '勾选后会播报' }, [enabledInput]),
      el('div.word-row__main', {}, [
        el('input', {
          class: 'input input--zh',
          value: item.zh,
          placeholder: '中文词语',
          'aria-label': '中文词语',
          onchange: (event) => {
            item.zh = event.target.value.trim();
            if (item.zh && !item.pinyin) item.pinyin = annotate(item.zh);
            persist();
            touch();
          }
        }),
        el('input', {
          class: 'input input--pinyin',
          value: item.pinyin,
          placeholder: '拼音（可自动生成）',
          'aria-label': '拼音',
          onchange: (event) => {
            item.pinyin = event.target.value.trim();
            persist();
          }
        })
      ]),
      el('div.word-row__tools', {}, [
        el('button', {
          type: 'button',
          class: 'btn btn--ghost btn--sm',
          text: '标拼音',
          title: '根据中文重新生成拼音',
          onclick: () => {
            const py = annotate(item.zh);
            if (!py) {
              toast('这个词语没有可标注的中文', 'warn');
              return;
            }
            item.pinyin = py;
            persist();
            touch();
          }
        }),
        el('button', {
          type: 'button',
          class: 'btn btn--ghost btn--sm',
          text: '拆开',
          title: '把每个汉字拆成单独的词条',
          onclick: () => {
            const chars = Array.from(extractHan(item.zh));
            if (chars.length < 2) {
              toast('只有一个汉字，不需要拆分', 'info');
              return;
            }
            const parts = chars.map((char) => createItem({ zh: char, pinyin: annotate(char), example: '' }));
            state.project.items.splice(index, 1, ...parts);
            persist();
            toast(`已拆成 ${parts.length} 个词条`, 'success');
            touch();
          }
        }),
        el('button', {
          type: 'button',
          class: 'btn btn--ghost btn--sm',
          text: '删除',
          onclick: () => {
            state.project.items.splice(index, 1);
            persist();
            touch();
          }
        })
      ])
    ]),
    el('div.word-row__extra', {}, [
      el('label.field', {}, [
        el('span.field__label', { text: '英文 / 对照' }),
        el('input', {
          class: 'input input--sm',
          value: item.en,
          placeholder: '英文单词（可选）',
          onchange: (event) => {
            item.en = event.target.value.trim();
            persist();
          }
        })
      ]),
      el('label.field', {}, [
        el('span.field__label', { text: '例句 / 组词（可选）' }),
        el('input', {
          class: 'input input--sm',
          value: item.example,
          placeholder: '例如：乌鸦喝水',
          onchange: (event) => {
            item.example = event.target.value.trim();
            persist();
          }
        })
      ]),
      el('label.field.field--narrow', {}, [
        el('span.field__label', { text: '这个词念几遍' }),
        el('input', {
          class: 'input input--sm',
          type: 'number',
          min: '0',
          max: '10',
          value: item.zhRepeatOverride ?? '',
          placeholder: '用全局',
          onchange: (event) => {
            const value = event.target.value;
            item.zhRepeatOverride = value === '' ? null : Math.max(0, Math.min(10, Number(value)));
            persist();
            touch();
          }
        })
      ])
    ]),
    el('div.row.row--end', {}, [
      el('button', {
        type: 'button',
        class: 'btn btn--outline btn--sm',
        text: '从这里开始播',
        onclick: () => {
          requestSeek(index);
          go('play');
        }
      }),
      index > 0
        ? el('button', {
            type: 'button',
            class: 'btn btn--ghost btn--sm',
            text: '与上一个合并',
            onclick: () => {
              const prev = state.project.items[index - 1];
              if (!prev) return;
              prev.zh = `${prev.zh}${item.zh}`;
              prev.pinyin = annotate(prev.zh);
              prev.en = [prev.en, item.en].filter(Boolean).join(' ');
              prev.example = [prev.example, item.example].filter(Boolean).join('；');
              state.project.items.splice(index, 1);
              persist();
              touch();
            }
          })
        : null
    ])
  ]);
}
