/**
 * 单篇笔记 / 单个笔记本的隐私锁。
 *
 * 和全局密码锁的关系：使用独立的隐私密码（lib/privacyAuth.ts），不需要先开启应用密码锁。
 * 加锁后默认就是锁住的；解锁只在当前笔记 / 页面内有效，切走会自动重新上锁。
 *
 * 边界要说清：这仍然只是界面遮挡，不是加密。笔记文件在磁盘和 Git 仓库里依然是明文，
 * 拿到文件的人不输密码也能读。它解决的是「别人顺手打开电脑翻两下」。
 *
 * 锁记录会随仓库里的 .glimnote/privacy.json 同步（lib/privacySync.ts），
 * 密码也只同步盐和哈希，好让多台设备用同一个隐私密码。
 */
import type { Note } from './markdown';

const STORE_KEY = 'glimnote.privacy.v1';
export const NOTE_PREFIX = 'note:';
export const FOLDER_PREFIX = 'folder:';
/** 本机隐私锁发生改动：同步组件监听它，把改动写进仓库并标记待同步 */
export const PRIVACY_CHANGED_EVENT = 'glimnote:privacy-changed';

/** 一把锁最后一次变动的记录；updatedAt / at 都是 ISO 时间，用来做跨设备合并 */
export interface LockEntry {
  locked: boolean;
  at: string;
}

export interface PrivacyData {
  noteIds: string[];
  folders: string[];
}

export interface PrivacySnapshot extends PrivacyData {
  /** key 是 `note:<id>` 或 `folder:<路径>`，包含已解除的墓碑记录 */
  entries: Record<string, LockEntry>;
  /** 隐私密码最后一次设置 / 修改 / 删除的时间；空字符串表示从未记录 */
  passwordAt: string;
}

interface PrivacyRecordV2 {
  v: 2;
  noteIds: string[];
  folders: string[];
  entries: Record<string, LockEntry>;
  passwordAt?: string;
  updatedAt: string;
}

const EMPTY: PrivacySnapshot = { noteIds: [], folders: [], entries: {}, passwordAt: '' };

export function noteKey(id: string) {
  return `${NOTE_PREFIX}${id}`;
}

export function folderKey(path: string) {
  return `${FOLDER_PREFIX}${path}`;
}

function isEntry(value: unknown): value is LockEntry {
  const e = value as LockEntry | null;
  return Boolean(e && typeof e.locked === 'boolean' && typeof e.at === 'string');
}

function readRecord(): Record<string, unknown> | null {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return null;
    const rec = JSON.parse(raw) as Record<string, unknown>;
    if (!rec || (rec.v !== 1 && rec.v !== 2)) return null;
    return rec;
  } catch {
    return null;
  }
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/** 读取本机完整的锁状态：当前生效的锁、墓碑记录、密码时间 */
export function readPrivacySnapshot(): PrivacySnapshot {
  const rec = readRecord();
  if (!rec) return EMPTY;

  const updatedAt = typeof rec.updatedAt === 'string' ? rec.updatedAt : new Date(0).toISOString();
  const entries: Record<string, LockEntry> = {};

  if (rec.v === 2 && rec.entries && typeof rec.entries === 'object') {
    for (const [key, value] of Object.entries(rec.entries as Record<string, unknown>)) {
      if (isEntry(value)) entries[key] = { locked: value.locked, at: value.at };
    }
  }

  // 旧版本（v1）只有两个数组：把这些锁视为在 updatedAt 那一刻加上的
  const noteIds = strings(rec.noteIds);
  const folders = strings(rec.folders);
  for (const id of noteIds) {
    const key = noteKey(id);
    if (!entries[key]) entries[key] = { locked: true, at: updatedAt };
  }
  for (const path of folders) {
    const key = folderKey(path);
    if (!entries[key]) entries[key] = { locked: true, at: updatedAt };
  }

  // 数组和 entries 打架时以 entries 为准，避免把已经解除的锁又戴回去
  const liveNotes = noteIds.filter((id) => entries[noteKey(id)]?.locked !== false);
  const liveFolders = folders.filter((path) => entries[folderKey(path)]?.locked !== false);

  return {
    noteIds: [...new Set(liveNotes)],
    folders: [...new Set(liveFolders)],
    entries,
    passwordAt: typeof rec.passwordAt === 'string' ? rec.passwordAt : '',
  };
}

export function loadPrivacy(): PrivacyData {
  const { noteIds, folders } = readPrivacySnapshot();
  return { noteIds, folders };
}

export interface SavePrivacyOptions {
  /** 直接写入合并后的完整条目（从仓库拉取时用），不再按 diff 生成时间戳 */
  entries?: Record<string, LockEntry>;
  /** 隐私密码时间；不传就沿用原值 */
  passwordAt?: string;
  /**
   * 是否是用户在本机的改动。默认 true：为新增 / 移除的锁补上时间戳，
   * 并通知同步组件；从仓库应用合并结果时传 false，避免把远端记录又当成新改动。
   */
  touch?: boolean;
}

export function savePrivacy(data: PrivacyData, opts: SavePrivacyOptions = {}) {
  const prev = readPrivacySnapshot();
  const now = new Date().toISOString();
  const noteIds = [...new Set(data.noteIds)];
  const folders = [...new Set(data.folders)];

  let entries: Record<string, LockEntry>;
  if (opts.entries) {
    entries = { ...opts.entries };
  } else {
    entries = { ...prev.entries };
    if (opts.touch !== false) {
      const want = new Set([...noteIds.map(noteKey), ...folders.map(folderKey)]);
      for (const key of want) {
        if (!entries[key]?.locked) entries[key] = { locked: true, at: now };
      }
      for (const [key, entry] of Object.entries(entries)) {
        if (entry.locked && !want.has(key)) entries[key] = { locked: false, at: now };
      }
    }
  }

  const rec: PrivacyRecordV2 = {
    v: 2,
    noteIds,
    folders,
    entries,
    passwordAt: opts.passwordAt ?? prev.passwordAt,
    updatedAt: now,
  };
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(rec));
  } catch {
    /* 存储满了也不影响当前会话，下次启动会少一把锁，但不能因此打断写作 */
  }
  if (opts.touch !== false) emitPrivacyChanged();
}

/** 隐私密码设置 / 修改 / 删除后调用：把时间戳写进锁记录，同步时用来判断哪边更新 */
export function markPrivacyPasswordTouched(at = new Date().toISOString()) {
  const prev = readPrivacySnapshot();
  const rec: PrivacyRecordV2 = {
    v: 2,
    noteIds: prev.noteIds,
    folders: prev.folders,
    entries: prev.entries,
    passwordAt: at,
    updatedAt: at,
  };
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(rec));
  } catch {
    /* 同 savePrivacy：写不进去也不打断当前操作 */
  }
  emitPrivacyChanged();
}

function emitPrivacyChanged() {
  try {
    if (typeof window !== 'undefined') window.dispatchEvent(new Event(PRIVACY_CHANGED_EVENT));
  } catch {
    /* 非浏览器环境（脚本 / 测试）里没有事件，忽略 */
  }
}

/** 这个笔记本本身或任一祖先被锁 */
export function folderHasLock(path: string, data: PrivacyData): string | null {
  if (!path) return null;
  // 取层级最深的那一把：万一数据里父子都加了锁，具体到子目录的锁优先
  let best: string | null = null;
  for (const f of data.folders) {
    if (path === f || path.startsWith(`${f}/`)) {
      if (!best || f.length > best.length) best = f;
    }
  }
  return best;
}

/** 直接锁在这个笔记本上的记录（不含祖先） */
export function folderLockAt(path: string, data: PrivacyData): boolean {
  return data.folders.includes(path);
}

export function folderUnlocked(path: string, unlocked: string[]): boolean {
  return unlocked.includes(folderKey(path));
}

/**
 * 这篇笔记现在是否还需要密码：
 * - 单独加的锁，除了本次会话里单独解锁过，否则要密码；
 * - 所在笔记本（含祖先）有锁，除了本次会话解锁过该笔记本，否则要密码；
 * - 单独解锁一篇笔记，可以越过笔记本锁，但不能越过它自己的锁。
 */
export function noteNeedsPassword(note: Pick<Note, 'id' | 'notebook'>, data: PrivacyData, unlocked: string[]): boolean {
  const directLocked = data.noteIds.includes(note.id);
  const noteUnlocked = unlocked.includes(noteKey(note.id));
  if (directLocked && !noteUnlocked) return true;
  const folder = folderHasLock(note.notebook || '', data);
  if (!folder) return false;
  return !noteUnlocked && !folderUnlocked(folder, unlocked);
}
