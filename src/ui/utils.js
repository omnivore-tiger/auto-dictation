/** 轻量 DOM 工具与提示条，避免为了一个页面引入框架。 */

/**
 * 创建元素。
 * @param {string} tag 形如 'div.card' 或 'button#go.primary'
 * @param {Record<string, any>|null} [attrs]
 * @param {(Node|string|null|undefined|false)[]} [children]
 * @returns {HTMLElement}
 */
export function el(tag, attrs = null, children = []) {
  const [namePart, ...classParts] = String(tag).split('.');
  const [tagName, id] = namePart.split('#');
  const node = document.createElement(tagName || 'div');
  if (id) node.id = id;
  if (classParts.length) node.className = classParts.join(' ');

  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') {
        node.className = `${node.className} ${value}`.trim();
      } else if (key === 'text') {
        node.textContent = String(value);
      } else if (key === 'html') {
        node.innerHTML = String(value);
      } else if (key === 'dataset') {
        Object.assign(node.dataset, value);
      } else if (key === 'style' && typeof value === 'object') {
        Object.assign(node.style, value);
      } else if (key.startsWith('on') && typeof value === 'function') {
        node.addEventListener(key.slice(2).toLowerCase(), value);
      } else if (key in node && key !== 'list') {
        // @ts-ignore
        node[key] = value;
      } else {
        node.setAttribute(key, String(value));
      }
    }
  }

  appendChildren(node, children);
  return node;
}

/**
 * @param {HTMLElement} node
 * @param {(Node|string|null|undefined|false)[]|Node|string} children
 */
export function appendChildren(node, children) {
  const list = Array.isArray(children) ? children : [children];
  for (const child of list) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/** @param {string} selector @param {ParentNode} [root] */
export function qs(selector, root = document) {
  const found = root.querySelector(selector);
  if (!found) throw new Error(`找不到元素：${selector}`);
  return /** @type {HTMLElement} */ (found);
}

/** 清空元素 */
export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

let toastTimer = 0;

/** 顶部提示条 */
export function toast(message, tone = 'info', durationMs = 3200) {
  const host = document.getElementById('toast-host');
  if (!host) return;
  const node = el('div', { class: `toast toast--${tone}`, role: 'status' }, [message]);
  host.append(node);
  window.setTimeout(() => node.classList.add('toast--in'), 10);
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    node.classList.remove('toast--in');
    window.setTimeout(() => node.remove(), 250);
  }, durationMs);
  node.addEventListener('click', () => node.remove());
}

/** 简易确认框（用原生 confirm，够用且不挡手机操作） */
export function confirmAction(message) {
  return window.confirm(message);
}

/** 关闭所有弹窗（切换屏幕时调用，避免弹窗一直盖在上面） */
export function closeModals() {
  const root = document.getElementById('modal-root');
  if (root) clear(root);
}

/** 把毫秒转成"3.5 秒 / 1 分 20 秒" */
export function humanMs(ms) {
  const seconds = (Number(ms) || 0) / 1000;
  if (seconds < 60) return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes} 分 ${rest} 秒`;
}

/**
 * 全屏查看一张图片：点缩略图或"看原图"时调用。
 * 点图片以外的区域、点"关闭"、或按 Esc 都能关掉。
 * @param {string} src 图片地址（dataURL 也可以）
 * @param {string} [title]
 */
export function openImagePreview(src, title = '') {
  const root = document.getElementById('modal-root');
  if (!root) return;
  clear(root);

  const onKey = (event) => {
    if (event.key === 'Escape') close();
  };
  const close = () => {
    window.removeEventListener('keydown', onKey);
    document.body.style.overflow = '';
    clear(root);
  };

  // 打开时锁住背景滚动，关掉再恢复
  document.body.style.overflow = 'hidden';

  const overlay = el(
    'div.image-viewer',
    {
      role: 'dialog',
      'aria-label': title || '查看图片',
      onclick: (event) => {
        // 只有点到图片外面才关闭，避免误触
        if (event.target === overlay) close();
      }
    },
    [
      el('div.image-viewer__bar', {}, [
        el('span.image-viewer__title', { text: title || '查看图片' }),
        el('button', { type: 'button', class: 'btn btn--ghost btn--sm image-viewer__close', text: '关闭', onclick: close })
      ]),
      el('img.image-viewer__img', { src, alt: title || '照片预览' })
    ]
  );

  root.append(overlay);
  window.addEventListener('keydown', onKey);
}
