/**
 * OCR 引擎：把课本照片变成文字。
 *
 * 默认使用浏览器内运行的 Tesseract.js（中文简体 + 英文模型都已放在本地
 * public/tessdata 与 public/tesseract，首次使用无需联网）。
 * 另外留了"云端识别"的接口：如果用户在设置里填了自己的接口地址，就走云端。
 *
 * 识别前会先做一次图像预处理（缩放、灰度、对比度拉伸、可选二值化），
 * 这对课本照片（纸张发黄、光照不均、印刷体偏小）的提升很明显。
 */
import { createWorker } from 'tesseract.js';
import { makeId } from './text.js';

/** @typedef {{ id: string, name: string, dataUrl: string, text: string, notes: string[], createdAt: number }} PhotoResult */

const MAX_EDGE = 1800;
const MIN_EDGE = 900;

/**
 * 读取文件为 dataURL。
 * @param {File|Blob} file
 * @returns {Promise<string>}
 */
export function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error ?? new Error('读取图片失败'));
    reader.readAsDataURL(file);
  });
}

/**
 * 载入图片元素。
 * @param {string} dataUrl
 * @returns {Promise<HTMLImageElement>}
 */
export function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('图片解码失败'));
    image.src = dataUrl;
  });
}

/**
 * Otsu 阈值：自动找一个"把文字和纸张分开"的灰度阈值。
 * @param {Uint8ClampedArray} gray
 */
export function otsuThreshold(gray) {
  /** @type {number[]} */
  const histogram = new Array(256).fill(0);
  for (let i = 0; i < gray.length; i += 1) histogram[gray[i]] += 1;
  const total = gray.length;
  let sum = 0;
  for (let i = 0; i < 256; i += 1) sum += i * histogram[i];
  let sumB = 0;
  let weightB = 0;
  let maxVariance = 0;
  let threshold = 128;
  for (let t = 0; t < 256; t += 1) {
    weightB += histogram[t];
    if (weightB === 0) continue;
    const weightF = total - weightB;
    if (weightF === 0) break;
    sumB += t * histogram[t];
    const meanB = sumB / weightB;
    const meanF = (sum - sumB) / weightF;
    const variance = weightB * weightF * (meanB - meanF) * (meanB - meanF);
    if (variance > maxVariance) {
      maxVariance = variance;
      threshold = t;
    }
  }
  return threshold;
}

/**
 * 图片预处理：缩放到合适大小 + 灰度 + 对比度拉伸 +（可选）二值化。
 *
 * @param {string} dataUrl
 * @param {{ binarize?: boolean, maxEdge?: number }} [options]
 * @returns {Promise<{ dataUrl: string, width: number, height: number, threshold: number }>}
 */
export async function preprocessImage(dataUrl, options = {}) {
  const binarize = options.binarize !== false;
  const maxEdge = options.maxEdge ?? MAX_EDGE;
  const image = await loadImage(dataUrl);
  const naturalWidth = image.naturalWidth || image.width;
  const naturalHeight = image.naturalHeight || image.height;
  const longest = Math.max(naturalWidth, naturalHeight);

  // 太小就放大（课本照片里的小字放大后识别率更高），太大就缩小
  let scale = 1;
  if (longest > maxEdge) scale = maxEdge / longest;
  else if (longest < MIN_EDGE) scale = Math.min(2, MIN_EDGE / longest);

  const width = Math.max(1, Math.round(naturalWidth * scale));
  const height = Math.max(1, Math.round(naturalHeight * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('浏览器不支持 Canvas，无法预处理图片');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(image, 0, 0, width, height);

  const imageData = ctx.getImageData(0, 0, width, height);
  const data = imageData.data;
  const pixelCount = width * height;
  const gray = new Uint8ClampedArray(pixelCount);

  let min = 255;
  let max = 0;
  for (let i = 0; i < pixelCount; i += 1) {
    const offset = i * 4;
    // 亮度加权（人眼对绿色更敏感）
    const value = Math.round(0.299 * data[offset] + 0.587 * data[offset + 1] + 0.114 * data[offset + 2]);
    gray[i] = value;
    if (value < min) min = value;
    if (value > max) max = value;
  }

  const range = Math.max(1, max - min);
  const threshold = binarize ? otsuThreshold(gray) : 0;

  for (let i = 0; i < pixelCount; i += 1) {
    let value = ((gray[i] - min) / range) * 255;
    if (binarize) {
      // 二值化 + 轻微"加粗"：偏暗的像素直接压黑，边缘更清晰
      value = value < ((threshold - min) / range) * 255 ? 0 : 255;
    }
    const offset = i * 4;
    data[offset] = value;
    data[offset + 1] = value;
    data[offset + 2] = value;
    data[offset + 3] = 255;
  }
  ctx.putImageData(imageData, 0, 0);

  return { dataUrl: canvas.toDataURL('image/png'), width, height, threshold };
}

/* ------------------------------------------------------------------ 本地 Tesseract */

/** @type {import('tesseract.js').Worker|null} */
let worker = null;
let workerLang = '';

function assetBase() {
  // 用相对路径，配合 vite 的 base:'./'，放到子目录也能用
  return new URL('.', window.location.href);
}

/**
 * 取得（并按需重建）worker。
 * @param {string} lang
 * @param {(progress: { status: string, progress: number }) => void} [onProgress]
 */
async function getWorker(lang, onProgress) {
  if (worker && workerLang === lang) return worker;
  if (worker) {
    try {
      await worker.terminate();
    } catch {
      /* 忽略 */
    }
    worker = null;
  }

  const base = assetBase();
  const workerPath = new URL('tesseract/worker.min.js', base).href;
  const corePath = new URL('tesseract/', base).href;
  const langPath = new URL('tessdata', base).href.replace(/\/$/, '');

  worker = await createWorkerWithProgress(lang, { workerPath, corePath, langPath }, onProgress);
  workerLang = lang;
  return worker;
}

/**
 * 包一层 createWorker，兼容不同小版本的 API（v5 支持直接传 options）。
 */
async function createWorkerWithProgress(lang, options, onProgress) {
  return createWorker(lang, 1, {
    workerPath: options.workerPath,
    corePath: options.corePath,
    langPath: options.langPath,
    cacheMethod: 'none',
    logger: (message) => {
      if (onProgress && typeof message?.progress === 'number') {
        onProgress({ status: String(message.status || ''), progress: message.progress });
      }
    },
    errorHandler: (error) => console.warn('Tesseract 内部错误：', error)
  });
}

/**
 * 用本地 Tesseract 识别一张图片。
 *
 * @param {string} dataUrl
 * @param {{ lang?: string, onProgress?: (info: { status: string, progress: number, stage: string }) => void }} [options]
 * @returns {Promise<string>}
 */
export async function recognizeLocal(dataUrl, options = {}) {
  const lang = options.lang ?? 'chi_sim+eng';
  options.onProgress?.({ status: 'preprocess', progress: 0, stage: '预处理图片…' });
  const preprocessed = await preprocessImage(dataUrl, {});
  options.onProgress?.({ status: 'loading tesseract', progress: 0.02, stage: '准备识别引擎…' });
  const instance = await getWorker(lang, (message) => {
    options.onProgress?.({ status: message.status, progress: 0.05 + message.progress * 0.15, stage: describeStatus(message.status) });
  });
  const result = await instance.recognize(preprocessed.dataUrl);
  options.onProgress?.({ status: 'done', progress: 1, stage: '识别完成' });
  return String(result?.data?.text ?? '');
}

/** 把 Tesseract 的英文状态翻成给家长看的中文 */
function describeStatus(status) {
  const map = {
    'loading tesseract core': '加载识别核心…',
    'initializing tesseract': '初始化识别核心…',
    'loading language traineddata': '加载中英文模型…',
    'initializing api': '初始化语言模型…',
    'recognizing text': '正在识别文字…'
  };
  return map[status] ?? '正在识别文字…';
}

/** 释放 worker（例如页面隐藏太久时） */
export async function disposeOcr() {
  if (worker) {
    try {
      await worker.terminate();
    } catch {
      /* 忽略 */
    }
    worker = null;
    workerLang = '';
  }
}

/* ------------------------------------------------------------------ 可选：云端识别 */

/**
 * 云端识别占位实现：用户在设置里填了自定义接口时启用。
 * 约定接口：POST { image: dataURL }（JSON），返回 { text: string } 或 { words: [...] }。
 *
 * @param {string} dataUrl
 * @param {string} endpoint
 * @param {string} [apiKey]
 */
export async function recognizeRemote(dataUrl, endpoint, apiKey) {
  if (!endpoint) throw new Error('未配置云端识别接口');
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
    },
    body: JSON.stringify({ image: dataUrl })
  });
  if (!response.ok) throw new Error(`云端识别失败：HTTP ${response.status}`);
  const payload = await response.json();
  if (typeof payload?.text === 'string') return payload.text;
  if (Array.isArray(payload?.words)) return payload.words.join('\n');
  throw new Error('云端识别返回格式无法识别（需要 { text } 或 { words }）');
}

/**
 * 统一入口：按设置选择本地或云端识别。
 *
 * @param {string} dataUrl
 * @param {{
 *   mode?: 'local'|'remote',
 *   lang?: string,
 *   remoteEndpoint?: string,
 *   remoteApiKey?: string,
 *   onProgress?: (info: { status: string, progress: number, stage: string }) => void
 * }} [options]
 * @returns {Promise<{ text: string, engine: 'local'|'remote' }>}
 */
export async function recognizeImage(dataUrl, options = {}) {
  const mode = options.mode ?? 'local';
  if (mode === 'remote' && options.remoteEndpoint) {
    options.onProgress?.({ status: 'remote', progress: 0.3, stage: '上传到云端识别…' });
    const text = await recognizeRemote(dataUrl, options.remoteEndpoint, options.remoteApiKey);
    options.onProgress?.({ status: 'done', progress: 1, stage: '识别完成' });
    return { text, engine: 'remote' };
  }
  const text = await recognizeLocal(dataUrl, { lang: options.lang, onProgress: options.onProgress });
  return { text, engine: 'local' };
}

/**
 * 批量识别多张照片。
 * @param {{ id?: string, name: string, dataUrl: string }[]} photos
 * @param {{ lang?: string, mode?: 'local'|'remote', remoteEndpoint?: string, remoteApiKey?: string,
 *   onProgress?: (info: { index: number, total: number, progress: number, stage: string }) => void }} [options]
 * @returns {Promise<PhotoResult[]>}
 */
export async function recognizePhotos(photos, options = {}) {
  /** @type {PhotoResult[]} */
  const results = [];
  const total = photos.length;
  for (let index = 0; index < total; index += 1) {
    const photo = photos[index];
    const onProgress = (info) => {
      const overall = (index + Math.min(1, Math.max(0, info.progress))) / total;
      options.onProgress?.({
        index,
        total,
        progress: overall,
        stage: `第 ${index + 1}/${total} 张：${info.stage}`
      });
    };
    try {
      const { text } = await recognizeImage(photo.dataUrl, { ...options, onProgress });
      results.push({
        id: photo.id ?? makeId('photo'),
        name: photo.name,
        dataUrl: photo.dataUrl,
        text,
        notes: [],
        createdAt: Date.now()
      });
    } catch (error) {
      console.warn('照片识别失败：', error);
      results.push({
        id: photo.id ?? makeId('photo'),
        name: photo.name,
        dataUrl: photo.dataUrl,
        text: '',
        notes: [`识别失败：${error instanceof Error ? error.message : String(error)}。可以手动输入这一页的词语。`],
        createdAt: Date.now()
      });
    }
  }
  return results;
}
