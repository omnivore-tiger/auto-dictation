/**
 * 听写本：本地保存过的所有听写项目。
 * 数据只存在这台设备上，不会有账号、不会上传。
 */
import { deleteProject, listProjects } from '../core/storage.js';
import { go, newProject, persist, setProject, state, touch } from './state.js';
import { clear, confirmAction, el, toast } from './utils.js';

export function renderLibrary(root) {
  clear(root);

  const projects = listProjects();
  root.append(buildHeader(projects.length));
  root.append(buildList(projects));
  root.append(buildTips());
}

function buildHeader(count) {
  return el('div.card.card--flat', {}, [
    el('div.row.row--between.row--wrap', {}, [
      el('div', {}, [
        el('h2.card__title', { text: `我的听写本（${count}）` }),
        el('p.card__hint', { text: '所有内容都保存在这台设备上，拍照识别也在本机完成，不会上传到服务器。' })
      ]),
      el('button', {
        type: 'button',
        class: 'btn btn--primary',
        text: '新建听写',
        onclick: () => {
          newProject();
          toast('已新建一个听写，去拍张照片吧', 'success');
          go('photos');
        }
      })
    ])
  ]);
}

/**
 * @param {import('../core/model.js').Project[]} projects
 */
function buildList(projects) {
  const list = el('div.project-list');
  if (projects.length === 0) {
    list.append(
      el('div.card.empty-state', {}, [
        el('div.empty-state__icon', { text: '📚' }),
        el('h3', { text: '还没有保存过听写' }),
        el('p.muted', { text: '点"新建听写"，拍照或上传课本图片就能开始。' })
      ])
    );
    return list;
  }

  const currentId = state.project.id;

  for (const project of projects) {
    const isCurrent = project.id === currentId;
    const preview = project.items
      .slice(0, 8)
      .map((item) => item.zh || item.en)
      .filter(Boolean)
      .join(' · ');

    list.append(
      el('div.card.project-card' + (isCurrent ? '.project-card--current' : ''), {}, [
        el('div.row.row--between.row--wrap', {}, [
          el('div.project-card__main', {}, [
            el('div.project-card__name', {}, [
              project.name,
              isCurrent ? el('span.badge.badge--accent', { text: '当前' }) : null
            ]),
            el('div.project-card__meta', {
              text: `${project.items.length} 个词条 · 更新于 ${new Date(project.updatedAt).toLocaleString('zh-CN')}`
            }),
            preview ? el('div.project-card__preview', { text: preview }) : null
          ]),
          el('div.project-card__actions', {}, [
            el('button', {
              type: 'button',
              class: 'btn btn--outline btn--sm',
              text: '打开',
              onclick: () => {
                setProject(project);
                go('words');
                toast(`已打开「${project.name}」`, 'success');
              }
            }),
            el('button', {
              type: 'button',
              class: 'btn btn--ghost btn--sm',
              text: '改名',
              onclick: () => {
                const name = window.prompt('给这个听写起个名字', project.name);
                if (name === null) return;
                project.name = name.trim() || project.name;
                setProject(project);
                persist();
                touch();
              }
            }),
            el('button', {
              type: 'button',
              class: 'btn btn--danger-ghost btn--sm',
              text: '删除',
              onclick: () => {
                if (!confirmAction(`确定删除「${project.name}」吗？`)) return;
                deleteProject(project.id);
                if (project.id === currentId) {
                  state.project.items = [];
                  state.project.name = '未命名听写';
                }
                toast('已删除', 'success');
                touch();
              }
            })
          ])
        ])
      ])
    );
  }

  return list;
}

function buildTips() {
  return el('details.card.card--flat', {}, [
    el('summary', { text: '使用小贴士' }),
    el('ul.tips', {}, [
      el('li', { text: '拍课本时把手机放平、离书本 20~30 厘米，光线均匀，识别率会明显提高。' }),
      el('li', { text: '识别不准很正常，第 2 步里每个字都能直接改；改完点"标拼音"即可生成拼音。' }),
      el('li', { text: '在手机上可以把这个网页"添加到主屏幕"，之后像 App 一样打开，断网也能用。' }),
      el('li', { text: '设置里的"词与词之间"就是留给孩子写字的时间，写得慢就调大。' })
    ])
  ]);
}
