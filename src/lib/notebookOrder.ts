import type { NotebookNode } from './repo';

/**
 * 笔记本的手动顺序。
 *
 * 存成「父级路径 → 子笔记本名称数组」：拖动排序 / 拖进别的文件夹时只改这里，
 * 不改笔记文件。没排过的层级仍然按中文名称排，新出现的文件夹也会自动落到列表末尾，
 * 不需要每次整理完再补一条记录。
 */
export type NotebookOrder = Record<string, string[]>;

const KEY = 'glimnote.notebookOrder';

export function parentOf(path: string) {
  return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
}

export function nameOf(path: string) {
  return path.split('/').pop() || path;
}

export function loadNotebookOrder(): NotebookOrder {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '{}') as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out: NotebookOrder = {};
    for (const [parent, list] of Object.entries(raw as Record<string, unknown>)) {
      if (!Array.isArray(list)) continue;
      const names = list.filter((v): v is string => typeof v === 'string' && v.length > 0);
      if (names.length) out[parent] = names;
    }
    return out;
  } catch {
    return {};
  }
}

export function saveNotebookOrder(order: NotebookOrder) {
  localStorage.setItem(KEY, JSON.stringify(order));
}

/** 手动排过的先按记录顺序，其余按中文名称；新文件夹默认追加在后面 */
export function sortNotebookTree(nodes: NotebookNode[], order: NotebookOrder) {
  if (!nodes.length) return;
  const parent = parentOf(nodes[0].path);
  const rank = new Map((order[parent] || []).map((name, i) => [name, i]));
  nodes.sort((a, b) => {
    const ra = rank.get(a.name);
    const rb = rank.get(b.name);
    if (ra !== undefined && rb !== undefined) return ra - rb;
    if (ra !== undefined) return -1;
    if (rb !== undefined) return 1;
    return a.name.localeCompare(b.name, 'zh-Hans-CN');
  });
  nodes.forEach((n) => sortNotebookTree(n.children, order));
}

/** 改名：把父级列表里的旧名字换掉，并搬走以旧路径为前缀的子树顺序 */
export function orderAfterRename(order: NotebookOrder, oldPath: string, newPath: string): NotebookOrder {
  const oldParent = parentOf(oldPath);
  const oldName = nameOf(oldPath);
  const newName = nameOf(newPath);
  const next: NotebookOrder = {};
  for (const [key, list] of Object.entries(order)) {
    const nextKey = key === oldPath || key.startsWith(`${oldPath}/`) ? newPath + key.slice(oldPath.length) : key;
    next[nextKey] = key === oldParent ? list.map((n) => (n === oldName ? newName : n)) : [...list];
  }
  return next;
}

/**
 * 移动：旧父级里移除自己，目标父级按拖放位置插入，子树顺序整体跟着换前缀。
 * targetSiblings 是目标父级当前的兄弟名称（不含被拖动的那一个），index 是插入位置。
 */
export function orderAfterMove(
  order: NotebookOrder,
  oldPath: string,
  newPath: string,
  targetParent: string,
  targetSiblings: string[],
  index: number,
  finalName: string,
): NotebookOrder {
  const oldParent = parentOf(oldPath);
  const oldName = nameOf(oldPath);
  const next: NotebookOrder = {};
  for (const [key, list] of Object.entries(order)) {
    if (key === oldParent) {
      const rest = list.filter((n) => n !== oldName);
      if (rest.length) next[key] = rest;
    } else if (key === oldPath || key.startsWith(`${oldPath}/`)) {
      next[newPath + key.slice(oldPath.length)] = [...list];
    } else {
      next[key] = [...list];
    }
  }
  const list = targetSiblings.filter((n) => n !== finalName);
  const at = Math.max(0, Math.min(index, list.length));
  list.splice(at, 0, finalName);
  next[targetParent] = list;
  return next;
}

/** 删除文件夹：清掉它自己和子树的顺序，并从父级列表里移除 */
export function orderAfterRemove(order: NotebookOrder, path: string): NotebookOrder {
  const parent = parentOf(path);
  const name = nameOf(path);
  const next: NotebookOrder = {};
  for (const [key, list] of Object.entries(order)) {
    if (key === path || key.startsWith(`${path}/`)) continue;
    const mapped = key === parent ? list.filter((n) => n !== name) : [...list];
    if (mapped.length) next[key] = mapped;
  }
  return next;
}

/** 不能把文件夹拖进它自己或它的子文件夹 */
export function canDropFolder(dragged: string, targetParent: string) {
  if (!dragged) return false;
  return targetParent !== dragged && !targetParent.startsWith(`${dragged}/`);
}
