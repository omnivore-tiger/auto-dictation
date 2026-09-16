/**
 * 第 1 步：拍照 / 上传 → 本地 OCR 识别 → 解析成词条。
 */
import { recognizeImage } from '../core/ocr.js';
import { fileToDataUrl } from '../core/ocr.js';
import { assembleItemsFromPhotos } from '../core/assemble.js';
import { createItem } from '../core/model.js';
import { annotate } from '../core/pinyin.js';
import { parsePastedList } from '../core/parser.js';
import { makeId } from '../core/text.js';
import { deletePhoto, listPhotos, savePhoto } from '../core/storage.js';
import { go, persist, state, touch } from './state.js';
import { clear, confirmAction, el, humanMs, toast } from './utils.js';

/** 界面上的识别选项（不参与保存，属于本机偏好） */
const ocrOptions = {
  lang: 'chi_sim+eng',
  autoRun: true,
  remoteEndpoint: '',
  remoteApiKey: ''
};

/** @type {File[]} */
let pendingQueue = [];

export function renderPhotos(root) {
  clear(root);
  root.append(buildIntro());
  root.append(buildDropzone());
  root.append(buildOptions());
  root.append(buildProgress());
  root.append(buildList());

  if (pendingQueue.length > 0) {
    const queue = pendingQueue;
    pendingQueue = [];
    void handleFiles(queue);
  }
}

function buildIntro() {
  return el('div.card.card--flat', {}, [
    el('h2.card__title', { text: '第 1 步：把书本上的词语拍下来' }),
    el('p.card__hint', {
      text:
        '可以直接拍照，也可以选择相册里已有的照片，一次可以传多张（例如一课的生字表）。' +
        '文字识别在这台设备上完成，图片不会上传到任何服务器。'
    })
  ]);
}

function buildDropzone() {
  const cameraInput = el('input', {
    type: 'file',
    accept: 'image/*',
    capture: 'environment',
    multiple: true,
    hidden: true,
    id: 'input-camera'
  });
  const galleryInput = el('input', {
    type: 'file',
    accept: 'image/*',
    multiple: true,
    hidden: true,
    id: 'input-gallery'
  });

  const zone = el('div', { class: 'dropzone', id: 'dropzone', tabindex: '0' }, [
    el('div.dropzone__icon', { text: '📷' }),
    el('p.dropzone__title', { text: '点这里拍照，或把图片拖进来' }),
    el('p.dropzone__hint', { text: '也支持直接粘贴截图（Ctrl / ⌘ + V）' }),
    el('div.dropzone__actions', {}, [
      el('button', { type: 'button', class: 'btn btn--primary btn--lg', text: '拍照', onclick: () => cameraInput.click() }),
      el('button', { type: 'button', class: 'btn btn--outline btn--lg', text: '从相册选择', onclick: () => galleryInput.click() })
    ]),
    cameraInput,
    galleryInput
  ]);

  for (const input of [cameraInput, galleryInput]) {
    input.addEventListener('change', () => {
      const files = Array.from(input.files ?? []);
      input.value = '';
      void handleFiles(files);
    });
  }

  zone.addEventListener('dragover', (event) => {
    event.preventDefault();
    zone.classList.add('dropzone--over');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('dropzone--over'));
  zone.addEventListener('drop', (event) => {
    event.preventDefault();
    zone.classList.remove('dropzone--over');
    const files = Array.from(event.dataTransfer?.files ?? []).filter((f) => f.type.startsWith('image/'));
    void handleFiles(files);
  });

  // 粘贴截图
  if (!window.__dictationPasteBound) {
    window.__dictationPasteBound = true;
    window.addEventListener('paste', (event) => {
      if (state.screen !== 'photos') return;
      const items = Array.from(event.clipboardData?.items ?? []);
      const files = items
        .filter((item) => item.type.startsWith('image/'))
        .map((item) => item.getAsFile())
        .filter(/** @returns {f is File} */ (f) => Boolean(f));
      if (files.length) void handleFiles(files);
    });
  }

  return zone;
}

function buildOptions() {
  const langSelect = el('select', {
    class: 'select',
    onchange: (event) => {
      ocrOptions.lang = event.target.value;
    }
  }, [
    el('option', { value: 'chi_sim+eng', text: '中文 + 英文（推荐）', selected: ocrOptions.lang === 'chi_sim+eng' }),
    el('option', { value: 'chi_sim', text: '只识别中文', selected: ocrOptions.lang === 'chi_sim' }),
    el('option', { value: 'eng', text: '只识别英文', selected: ocrOptions.lang === 'eng' })
  ]);

  const autoCheck = el('input', {
    type: 'checkbox',
    checked: ocrOptions.autoRun,
    id: 'auto-ocr',
    onchange: (event) => {
      ocrOptions.autoRun = event.target.checked;
    }
  });

  return el('div.card.card--flat options-row', {}, [
    el('label.field', {}, [el('span.field__label', { text: '识别语言' }), langSelect]),
    el('label.checkbox', {}, [autoCheck, el('span', { text: '上传后自动开始识别' })]),
    el('div.field', {}, [
      el('span.field__label', { text: '已有内容' }),
      el('button', {
        type: 'button',
        class: 'btn btn--ghost',
        text: '手动输入词语',
        onclick: () => openManualInput()
      })
    ])
  ]);
}

function buildProgress() {
  return el('div', { id: 'ocr-progress', class: 'ocr-progress', hidden: true }, [
    el('div.ocr-progress__text', { id: 'ocr-progress-text', text: '' }),
    el('div.busy__bar', {}, [el('div.busy__fill', { id: 'ocr-progress-fill' })])
  ]);
}

function buildList() {
  const wrap = el('div', { class: 'photo-list', id: 'photo-list' });
  if (state.photos.length === 0) {
    wrap.append(el('p.muted', { text: '还没有照片。识别成功的词语会出现在第 2 步里，可以逐条修改。' }));
    return wrap;
  }

  state.photos.forEach((photo, index) => {
    wrap.append(buildPhotoCard(photo, index));
  });

  wrap.append(
    el('div.row.row--end', {}, [
      el('button', {
        type: 'button',
        class: 'btn btn--ghost',
        text: '清空全部照片',
        onclick: async () => {
          if (!confirmAction('确定要清空所有照片和识别结果吗？（已整理的词语不会被删除）')) return;
          state.photos = [];
          const saved = await listPhotos(state.project.id);
          for (const item of saved) {
            await deletePhoto(item.id);
          }
          touch();
        }
      })
    ])
  );

  return wrap;
}

/**
 * @param {import('../core/ocr.js').PhotoResult} photo
 * @param {number} index
 */
function buildPhotoCard(photo, index) {
  const textarea = el('textarea', {
    class: 'textarea textarea--code',
    rows: 4,
    placeholder: '这里显示识别出来的文字，可以直接修改',
    value: photo.text ?? '',
    oninput: (event) => {
      photo.text = event.target.value;
    }
  });

  const status = el('span', { class: 'badge', text: photo.text ? `已识别 ${photo.text.replace(/\s/g, '').length} 字` : '待识别' });

  return el('div.card.photo-card', {}, [
    el('div.photo-card__head', {}, [
      el('img.photo-card__thumb', { src: photo.dataUrl, alt: `第 ${index + 1} 张照片`, loading: 'lazy' }),
      el('div.photo-card__info', {}, [
        el('div.photo-card__name', { text: photo.name || `照片 ${index + 1}` }),
        el('div.photo-card__badges', {}, [status])
      ]),
      el('div.photo-card__actions', {}, [
        el('button', {
          type: 'button',
          class: 'btn btn--outline btn--sm',
          text: '重新识别',
          onclick: () => void runRecognition([photo])
        }),
        el('button', {
          type: 'button',
          class: 'btn btn--ghost btn--sm',
          text: '删除',
          onclick: async () => {
            state.photos = state.photos.filter((p) => p.id !== photo.id);
            await deletePhoto(photo.id);
            touch();
          }
        })
      ])
    ]),
    textarea,
    el('div.row.row--between', {}, [
      el('span.muted.small', { text: '改完文字后点右边按钮，把这张的文字重新整理成词条。' }),
      el('button', {
        type: 'button',
        class: 'btn btn--primary btn--sm',
        text: '整理成词条',
        onclick: () => {
          applyItemsToProject();
          toast('已按当前文字重新整理词条', 'success');
          go('words');
        }
      })
    ])
  ]);
}

/**
 * 处理新上传的文件。
 * @param {File[]} files
 */
async function handleFiles(files) {
  const images = (files ?? []).filter((file) => file.type.startsWith('image/'));
  if (images.length === 0) {
    toast('没有检测到图片文件', 'warn');
    return;
  }

  for (const file of images) {
    try {
      const dataUrl = await fileToDataUrl(file);
      const photo = {
        id: makeId('photo'),
        name: file.name || '照片',
        dataUrl,
        text: '',
        notes: [],
        createdAt: Date.now()
      };
      state.photos.push(photo);
      void savePhoto({ id: photo.id, projectId: state.project.id, dataUrl, name: photo.name });
    } catch (error) {
      console.error(error);
      toast('读取图片失败，请换一张试试', 'error');
    }
  }
  touch();

  if (ocrOptions.autoRun) {
    await runRecognition(state.photos.filter((p) => !p.text));
  }
}

/**
 * 对指定照片跑识别。
 * @param {import('../core/ocr.js').PhotoResult[]} targets
 */
async function runRecognition(targets) {
  const list = targets.filter(Boolean);
  if (list.length === 0) {
    toast('没有需要识别的照片', 'warn');
    return;
  }

  const progressBox = document.getElementById('ocr-progress');
  const progressText = document.getElementById('ocr-progress-text');
  const progressFill = document.getElementById('ocr-progress-fill');
  if (progressBox) progressBox.hidden = false;

  const total = list.length;
  for (let i = 0; i < total; i += 1) {
    const photo = list[i];
    try {
      const { text } = await recognizeImage(photo.dataUrl, {
        mode: 'local',
        lang: ocrOptions.lang,
        onProgress: (info) => {
          const overall = (i + Math.min(1, Math.max(0, info.progress))) / total;
          if (progressText) progressText.textContent = `第 ${i + 1}/${total} 张：${info.stage}`;
          if (progressFill) progressFill.style.width = `${Math.round(overall * 100)}%`;
        }
      });
      photo.text = text;
      photo.notes = [];
    } catch (error) {
      console.error(error);
      photo.notes = [error instanceof Error ? error.message : String(error)];
      toast('识别失败：' + photo.notes[0], 'error');
    }
  }

  if (progressBox) progressBox.hidden = true;
  if (progressFill) progressFill.style.width = '0%';

  const applied = applyItemsToProject();
  if (applied.created > 0) {
    toast(`识别出 ${applied.created} 个词语，去第 2 步核对一下吧`, 'success');
  } else if (list.some((p) => p.text.trim())) {
    toast('识别完成，请检查文字是否准确', 'info');
  }
  go('words');
}

/**
 * 把照片文字整理成词条。
 *
 * 具体规则（含"多张图不串味"）都在 core/assemble.js 里，且有单元测试覆盖。
 * 这里只负责把结果写回项目和提示用户。
 */
function applyItemsToProject() {
  const { items, created, notes } = assembleItemsFromPhotos(state.photos ?? [], state.project.items ?? [], {
    autoPinyin: annotate
  });
  state.project.items = items;

  if (created > 0 || notes.length > 0) persist();
  for (const note of notes) {
    if (/没有识别出词条/.test(note)) continue;
    toast(note, 'info');
  }
  return { created };
}

/** 手动输入：直接粘贴一串词语 */
function openManualInput() {
  const modalRoot = document.getElementById('modal-root');
  if (!modalRoot) return;
  clear(modalRoot);

  const textarea = el('textarea', {
    class: 'textarea',
    rows: 8,
    placeholder: '每行一个词语，例如：\n乌鸦\n葡萄 pú táo\nfriend'
  });

  const close = () => clear(modalRoot);
  const overlay = el('div.modal-overlay', { onclick: (event) => event.target === overlay && close() }, [
    el('div.modal', {}, [
      el('h3.modal__title', { text: '手动输入词语' }),
      el('p.card__hint', { text: '支持「中文 拼音」「中文 英文」混着写，一行一个或用逗号分开都可以。' }),
      textarea,
      el('div.modal__actions', {}, [
        el('button', { type: 'button', class: 'btn btn--ghost', text: '取消', onclick: close }),
        el('button', {
          type: 'button',
          class: 'btn btn--primary',
          text: '添加',
          onclick: () => {
            const items = parsePastedList(textarea.value);
            if (items.length === 0) {
              toast('没有解析出词语', 'warn');
              return;
            }
            for (const item of items) {
              if (!item.pinyin && item.zh) item.pinyin = annotate(item.zh);
              state.project.items.push(createItem(item));
            }
            persist();
            close();
            toast(`已添加 ${items.length} 个词语`, 'success');
            go('words');
          }
        })
      ])
    ])
  ]);

  modalRoot.append(overlay);
}

export { handleFiles as addPhotosFromFiles, humanMs };
