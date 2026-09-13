/**
 * 本地存储。
 *   - 项目、设置、历史记录：localStorage（小、同步、够用）
 *   - 拍摄的图片：IndexedDB（可能几 MB，localStorage 放不下）
 * 任何一步失败都不会让应用崩掉，只是退化（例如隐私模式下不保存图片）。
 */
import { createProject, normalizeSettings, reviveProject } from './model.js';

const LS_PROJECTS = 'dictation.projects.v1';
const LS_CURRENT = 'dictation.currentProjectId.v1';
const LS_SETTINGS = 'dictation.lastSettings.v1';
const DB_NAME = 'dictation-media';
const DB_STORE = 'photos';

/* ------------------------------------------------------------------ localStorage */

function readJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch (error) {
    console.warn(`读取 ${key} 失败：`, error);
    return fallback;
  }
}

function writeJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (error) {
    console.warn(`写入 ${key} 失败：`, error);
    return false;
  }
}

/**
 * 列出所有项目（不含图片数据，按更新时间倒序）。
 * @returns {import('./model.js').Project[]}
 */
export function listProjects() {
  const raw = readJSON(LS_PROJECTS, []);
  const projects = (Array.isArray(raw) ? raw : [])
    .map((item) => reviveProject(item))
    .filter(Boolean);
  projects.sort((a, b) => (b?.updatedAt ?? 0) - (a?.updatedAt ?? 0));
  return /** @type {import('./model.js').Project[]} */ (projects);
}

/**
 * 保存项目（新建或更新）。
 * @param {import('./model.js').Project} project
 */
export function saveProject(project) {
  const next = createProject({ ...project, updatedAt: Date.now() });
  const all = listProjects().filter((p) => p.id !== next.id);
  all.unshift(next);
  // 最多留 50 个历史项目，避免 localStorage 撑爆
  const trimmed = all.slice(0, 50);
  writeJSON(LS_PROJECTS, trimmed);
  writeJSON(LS_CURRENT, next.id);
  return next;
}

/**
 * 读取单个项目。
 * @param {string} id
 */
export function loadProject(id) {
  return listProjects().find((p) => p.id === id) ?? null;
}

/**
 * 删除项目。
 * @param {string} id
 */
export function deleteProject(id) {
  const all = listProjects().filter((p) => p.id !== id);
  writeJSON(LS_PROJECTS, all);
  if (readJSON(LS_CURRENT, '') === id) writeJSON(LS_CURRENT, all[0]?.id ?? '');
  void deletePhotosOfProject(id);
}

/** 记住"上次打开的项目"，下次进来直接续上 */
export function getCurrentProjectId() {
  const id = readJSON(LS_CURRENT, '');
  return typeof id === 'string' ? id : '';
}

/** @param {Partial<import('./model.js').Settings>} settings */
export function saveLastSettings(settings) {
  writeJSON(LS_SETTINGS, normalizeSettings(settings));
}

export function loadLastSettings() {
  return normalizeSettings(readJSON(LS_SETTINGS, {}));
}

/* ------------------------------------------------------------------ IndexedDB（图片） */

/** @type {Promise<IDBDatabase|null>|null} */
let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') return resolve(null);
    try {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(DB_STORE)) {
          const store = db.createObjectStore(DB_STORE, { keyPath: 'id' });
          store.createIndex('projectId', 'projectId', { unique: false });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        console.warn('IndexedDB 打开失败，图片将不会被保存。');
        resolve(null);
      };
    } catch (error) {
      console.warn('IndexedDB 不可用：', error);
      resolve(null);
    }
  });
  return dbPromise;
}

/**
 * 保存一张图片（dataURL）。
 * @param {{ id: string, projectId: string, dataUrl: string, createdAt?: number, name?: string }} photo
 */
export async function savePhoto(photo) {
  const db = await openDb();
  if (!db) return false;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).put({ createdAt: Date.now(), ...photo });
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    } catch (error) {
      console.warn('保存图片失败：', error);
      resolve(false);
    }
  });
}

/**
 * 读取某个项目的所有图片（按拍摄顺序）。
 * @param {string} projectId
 * @returns {Promise<{ id: string, dataUrl: string, createdAt: number, name?: string }[]>}
 */
export async function listPhotos(projectId) {
  const db = await openDb();
  if (!db) return [];
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(DB_STORE, 'readonly');
      const index = tx.objectStore(DB_STORE).index('projectId');
      const request = index.getAll(projectId);
      request.onsuccess = () => {
        const rows = Array.isArray(request.result) ? request.result : [];
        rows.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
        resolve(rows);
      };
      request.onerror = () => resolve([]);
    } catch (error) {
      console.warn('读取图片失败：', error);
      resolve([]);
    }
  });
}

/** @param {string} id */
export async function deletePhoto(id) {
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).delete(id);
  } catch (error) {
    console.warn('删除图片失败：', error);
  }
}

/** @param {string} projectId */
export async function deletePhotosOfProject(projectId) {
  const photos = await listPhotos(projectId);
  await Promise.all(photos.map((photo) => deletePhoto(photo.id)));
}
