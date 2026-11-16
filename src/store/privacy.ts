import { create } from 'zustand';
import type { View } from '../lib/view';
import {
  FOLDER_PREFIX,
  NOTE_PREFIX,
  folderHasLock,
  loadPrivacy,
  noteKey,
  folderKey,
  savePrivacy,
  type PrivacyData,
} from '../lib/privacy';

export type PrivacyMode = 'lock' | 'remove' | 'open';

export interface PrivacyRequest {
  kind: 'note' | 'folder';
  mode: PrivacyMode;
  /** 笔记 id 或笔记本路径 */
  target: string;
  /** 真正被锁住的根：单独锁的笔记 / 命中的笔记本锁 */
  lockRoot: string;
  /** 只用于「给笔记加锁」时给用户确认对象；解锁时不显示标题，避免泄露 */
  label: string;
  notebook?: string;
}

interface PrivacyState extends PrivacyData {
  /** 本次会话里已经解锁的 key；刷新或重启后清空 */
  unlocked: string[];
  request: PrivacyRequest | null;
  addNoteLock: (id: string) => void;
  removeNoteLock: (id: string) => void;
  addFolderLock: (path: string) => void;
  removeFolderLock: (path: string) => void;
  unlockKey: (key: string) => void;
  relockKey: (key: string) => void;
  relockAll: () => void;
  /** 当前选中项 / 页面变了，把已经离开视野的解锁状态收回去 */
  relockAway: (current: { id: string; notebook: string } | null, view: View) => void;
  /** 从 localStorage 重读锁列表：启动读仓库、同步后合并时用，不碰本次会话的解锁状态 */
  reloadFromStorage: () => void;
  clearAll: () => void;
  renameFolderLock: (from: string, to: string) => void;
  requestLockNote: (id: string, label: string) => void;
  requestRemoveNoteLock: (id: string) => void;
  requestOpenNote: (id: string, notebook: string) => void;
  requestLockFolder: (path: string) => void;
  requestRemoveFolderLock: (path: string) => void;
  requestOpenFolder: (path: string) => void;
  close: () => void;
}

const stored = loadPrivacy();

export const usePrivacy = create<PrivacyState>((set, get) => ({
  noteIds: stored.noteIds,
  folders: stored.folders,
  unlocked: [],
  request: null,

  addNoteLock: (id) => {
    if (!get().noteIds.includes(id)) {
      const noteIds = [...get().noteIds, id];
      savePrivacy({ noteIds, folders: get().folders });
      set({ noteIds });
    }
    // 加锁即锁定：本次会话里之前解开的同一篇笔记不能继续留着明文
    set({ unlocked: get().unlocked.filter((k) => k !== noteKey(id)) });
  },
  removeNoteLock: (id) => {
    const noteIds = get().noteIds.filter((x) => x !== id);
    savePrivacy({ noteIds, folders: get().folders });
    set({ noteIds });
  },
  addFolderLock: (path) => {
    if (!path) return;
    if (!get().folders.includes(path)) {
      const folders = [...get().folders, path];
      savePrivacy({ noteIds: get().noteIds, folders });
      set({ folders });
    }
    // 笔记本默认锁住时，本次会话里单独解锁过的笔记也一起收回
    set({
      unlocked: get().unlocked.filter((k) => !k.startsWith(NOTE_PREFIX) && k !== folderKey(path)),
    });
  },
  removeFolderLock: (path) => {
    const folders = get().folders.filter((x) => x !== path);
    savePrivacy({ noteIds: get().noteIds, folders });
    set({ folders });
  },
  unlockKey: (key) => {
    if (get().unlocked.includes(key)) return;
    set({ unlocked: [...get().unlocked, key] });
  },
  /** 手动把某把锁重新戴上（只影响本次会话） */
  relockKey: (key) => {
    if (!get().unlocked.includes(key)) return;
    set({ unlocked: get().unlocked.filter((k) => k !== key) });
  },
  relockAll: () => {
    if (get().unlocked.length) set({ unlocked: [] });
  },
  relockAway: (current, view) => {
    const unlocked = get().unlocked;
    if (!unlocked.length) return;
    const keep = unlocked.filter((key) => {
      if (key.startsWith(NOTE_PREFIX)) {
        const id = key.slice(NOTE_PREFIX.length);
        if (!current || current.id !== id) return false;
        // 回收站里解锁的笔记，停留在回收站期间保持可见
        if (view.type === 'trash') return true;
        // 笔记只在它所属的笔记本视图里保持解锁；切到首页、搜索页、其他页面都重新上锁
        if (view.type !== 'notebook') return false;
        const nb = current.notebook || '';
        return nb === view.value || nb.startsWith(`${view.value}/`);
      }
      if (key.startsWith(FOLDER_PREFIX)) {
        const path = key.slice(FOLDER_PREFIX.length);
        // 笔记本解锁只在仍处于这个笔记本（或它的子笔记本）时有效
        return view.type === 'notebook' && (view.value === path || view.value.startsWith(`${path}/`));
      }
      return false;
    });
    if (keep.length !== unlocked.length) set({ unlocked: keep });
  },
  reloadFromStorage: () => {
    const data = loadPrivacy();
    const noteIds = get().noteIds;
    const folders = get().folders;
    const same =
      noteIds.length === data.noteIds.length &&
      folders.length === data.folders.length &&
      data.noteIds.every((id) => noteIds.includes(id)) &&
      data.folders.every((path) => folders.includes(path));
    if (same) return;
    set({ noteIds: data.noteIds, folders: data.folders });
  },
  /** 关闭应用密码锁时一并清掉所有隐私锁，避免留下一堆再也打不开的笔记 */
  clearAll: () => {
    savePrivacy({ noteIds: [], folders: [] });
    set({ noteIds: [], folders: [], unlocked: [], request: null });
  },
  /** 笔记本改名 / 移动时，把锁记录和本次会话的解锁状态一起搬过去 */
  renameFolderLock: (from, to) => {
    if (!from || !to || from === to) return;
    const moved = (path: string) =>
      path === from || path.startsWith(`${from}/`) ? to + path.slice(from.length) : path;
    const folders = get().folders.map(moved);
    const unlocked = get().unlocked.map((key) => {
      if (!key.startsWith(FOLDER_PREFIX)) return key;
      const path = key.slice(FOLDER_PREFIX.length);
      return path === from || path.startsWith(`${from}/`) ? `${FOLDER_PREFIX}${moved(path)}` : key;
    });
    if (folders.some((f, i) => f !== get().folders[i]) || unlocked.some((k, i) => k !== get().unlocked[i])) {
      savePrivacy({ noteIds: get().noteIds, folders });
      set({ folders, unlocked });
    }
  },

  requestLockNote: (id, label) => {
    set({ request: { kind: 'note', mode: 'lock', target: id, lockRoot: id, label } });
  },
  requestRemoveNoteLock: (id) => {
    set({ request: { kind: 'note', mode: 'remove', target: id, lockRoot: id, label: '' } });
  },
  requestOpenNote: (id, notebook) => {
    const root = noteKey(id);
    set({ request: { kind: 'note', mode: 'open', target: id, lockRoot: root, label: '', notebook } });
  },
  requestLockFolder: (path) => {
    set({ request: { kind: 'folder', mode: 'lock', target: path, lockRoot: path, label: path } });
  },
  requestRemoveFolderLock: (path) => {
    set({ request: { kind: 'folder', mode: 'remove', target: path, lockRoot: path, label: path } });
  },
  requestOpenFolder: (path) => {
    // 被祖先锁住时，解锁的是祖先那把锁
    const root = folderHasLock(path, get()) || path;
    set({ request: { kind: 'folder', mode: 'open', target: path, lockRoot: root, label: path } });
  },
  close: () => set({ request: null }),
}));

export function privacyKeyOf(request: PrivacyRequest): string {
  if (request.kind === 'note') return noteKey(request.target);
  return folderKey(request.lockRoot);
}

export { NOTE_PREFIX, FOLDER_PREFIX };
