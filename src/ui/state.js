/**
 * 全局状态：一个很朴素的"单一数据源 + 订阅"。
 * 界面各屏都从这里读数据，改动后调用 touch() 触发重渲染。
 */
import { createProject, normalizeSettings } from '../core/model.js';
import { getCurrentProjectId, listProjects, loadLastSettings, loadProject, saveProject } from '../core/storage.js';

/** @typedef {'library'|'photos'|'words'|'play'} ScreenName */

/** @type {{
 *   project: import('../core/model.js').Project,
 *   screen: ScreenName,
 *   photos: import('../core/ocr.js').PhotoResult[],
 *   voices: SpeechSynthesisVoice[],
 *   busy: boolean,
 *   busyText: string,
 *   busyProgress: number,
 * }} */
export const state = {
  project: createProject({ settings: loadLastSettings() }),
  screen: 'library',
  photos: [],
  voices: [],
  busy: false,
  busyText: '',
  busyProgress: 0
};

/** @type {Set<() => void>} */
const listeners = new Set();

/** 订阅重渲染 */
export function subscribe(handler) {
  listeners.add(handler);
  return () => listeners.delete(handler);
}

/** 通知界面刷新 */
export function touch() {
  for (const handler of listeners) {
    try {
      handler();
    } catch (error) {
      console.error('渲染失败：', error);
    }
  }
}

/**
 * 切换项目。
 * @param {import('../core/model.js').Project} project
 */
export function setProject(project) {
  state.project = createProject({ ...project, settings: normalizeSettings(project.settings) });
  touch();
}

/** 新建一个空项目 */
export function newProject(name = '') {
  const project = createProject({ name: name || `听写 ${new Date().toLocaleDateString('zh-CN')}`, settings: state.project.settings });
  state.project = project;
  state.photos = [];
  touch();
  return project;
}

/** 保存当前项目到本地存储 */
export function persist() {
  state.project.updatedAt = Date.now();
  const saved = saveProject(state.project);
  state.project = saved;
  return saved;
}

/** 启动时恢复上次的项目 */
export function restore() {
  const currentId = getCurrentProjectId();
  const existing = currentId ? loadProject(currentId) : null;
  if (existing) {
    state.project = existing;
    return;
  }
  const all = listProjects();
  if (all.length > 0) {
    state.project = all[0];
  }
}

/** 切换屏幕 */
export function go(screen) {
  state.screen = screen;
  // 切屏时顺手关掉弹窗，避免遮罩留在页面上
  const modalRoot = typeof document === 'undefined' ? null : document.getElementById('modal-root');
  if (modalRoot) modalRoot.replaceChildren();
  touch();
}

/** 显示/隐藏全屏忙碌遮罩 */
export function setBusy(busy, text = '', progress = 0) {
  state.busy = busy;
  state.busyText = text;
  state.busyProgress = progress;
  touch();
}

export { saveProject, listProjects, loadProject };
