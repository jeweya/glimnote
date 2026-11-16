/**
 * 隐私锁的 Git 同步。
 *
 * 写进仓库的 .glimnote/privacy.json，内容包括：
 * - locks：每把锁 / 每条解锁墓碑的最后变动时间（`note:<id>` / `folder:<路径>`）；
 * - password / passwordAt：隐私密码的盐和哈希，以及最后一次设置、修改或删除的时间。
 *
 * 合并规则是「每条记录以时间较新的为准」，这样在 A 设备解除的锁不会被 B 设备的
 * 旧记录又戴回去。密码也按 passwordAt 取较新的一份，多台设备因此共用同一个隐私密码。
 *
 * 注意：这里同步的只是「锁在哪里、密码哈希是什么」，笔记正文仍然是明文。
 */
import { META_DIR, readText, writeText } from './storage';
import {
  FOLDER_PREFIX,
  NOTE_PREFIX,
  readPrivacySnapshot,
  savePrivacy,
  type LockEntry,
  type PrivacySnapshot,
} from './privacy';
import { exportPrivacyPassword, importPrivacyPassword, type PrivacyPasswordRecord } from './privacyAuth';

export const PRIVACY_FILE = `${META_DIR}/privacy.json`;

interface RemotePrivacy {
  locks: Record<string, LockEntry>;
  password: PrivacyPasswordRecord | null;
  passwordAt: string;
}

function isEntry(value: unknown): value is LockEntry {
  const e = value as LockEntry | null;
  return Boolean(e && typeof e.locked === 'boolean' && typeof e.at === 'string');
}

function passwordOf(value: unknown): PrivacyPasswordRecord | null {
  const rec = value as PrivacyPasswordRecord | null;
  if (!rec || typeof rec !== 'object') return null;
  if (typeof rec.salt !== 'string' || typeof rec.hash !== 'string') return null;
  const iter = Number(rec.iter);
  if (!Number.isFinite(iter) || iter <= 0) return null;
  return {
    v: 1,
    salt: rec.salt,
    hash: rec.hash,
    iter,
    createdAt: typeof rec.createdAt === 'string' ? rec.createdAt : '',
  };
}

function parseRemote(raw: string): RemotePrivacy | null {
  try {
    const rec = JSON.parse(raw) as Record<string, unknown>;
    if (!rec || rec.v !== 1) return null;
    const locks: Record<string, LockEntry> = {};
    const rawLocks = rec.locks;
    if (rawLocks && typeof rawLocks === 'object') {
      for (const [key, value] of Object.entries(rawLocks as Record<string, unknown>)) {
        if (!key || !isEntry(value)) continue;
        if (!key.startsWith(NOTE_PREFIX) && !key.startsWith(FOLDER_PREFIX)) continue;
        locks[key] = { locked: value.locked, at: value.at };
      }
    }
    return {
      locks,
      password: passwordOf(rec.password),
      passwordAt: typeof rec.passwordAt === 'string' ? rec.passwordAt : '',
    };
  } catch {
    return null;
  }
}

async function readRemote(): Promise<RemotePrivacy | null> {
  try {
    return parseRemote(await readText(PRIVACY_FILE));
  } catch {
    // 文件还没写出来（或读失败）：按「仓库里没有锁记录」处理
    return null;
  }
}

/** 同一把锁两边都有记录时，取时间较新的；时间相同就用仓库里的值，保证各设备收敛 */
function newerLock(local: LockEntry | undefined, remote: LockEntry | undefined): LockEntry | undefined {
  if (!local) return remote;
  if (!remote) return local;
  if (local.at !== remote.at) return local.at > remote.at ? local : remote;
  return remote;
}

function mergeLocks(local: PrivacySnapshot, remote: RemotePrivacy | null): Record<string, LockEntry> {
  const out: Record<string, LockEntry> = { ...(remote?.locks || {}) };
  for (const [key, entry] of Object.entries(local.entries)) {
    out[key] = newerLock(entry, out[key]) as LockEntry;
  }
  return out;
}

interface ResolvedPassword {
  rec: PrivacyPasswordRecord | null;
  at: string;
  from: 'local' | 'remote';
}

function resolvePassword(local: PrivacySnapshot, remote: RemotePrivacy | null): ResolvedPassword {
  const localPw = exportPrivacyPassword();
  // 旧版本没有记录 passwordAt：用密码自身的创建时间补上，避免第一次同步就判成「远端更新」
  const localAt = local.passwordAt || localPw?.createdAt || '';
  const remoteAt = remote?.passwordAt || '';

  if (!remote || remoteAt < localAt) return { rec: localPw, at: localAt, from: 'local' };
  if (remoteAt > localAt) return { rec: remote.password, at: remoteAt, from: 'remote' };

  // 时间相同：都没有就都没有；只有一边有就用那一边
  if (!localPw) return { rec: remote.password, at: remoteAt, from: remote.password ? 'remote' : 'local' };
  if (!remote.password) return { rec: localPw, at: localAt, from: 'local' };
  if (localPw.hash === remote.password.hash) return { rec: localPw, at: localAt, from: 'local' };
  // 极端情况：时间一样但密码不同（手改文件 / 时钟抖动）。按哈希定一个稳定结果，避免来回覆盖
  return localPw.hash > remote.password.hash
    ? { rec: localPw, at: localAt, from: 'local' }
    : { rec: remote.password, at: remoteAt, from: 'remote' };
}

function sameRecord(a: PrivacyPasswordRecord | null, b: PrivacyPasswordRecord | null) {
  if (!a || !b) return a === b;
  return a.salt === b.salt && a.hash === b.hash && a.iter === b.iter;
}

function sameEntries(a: Record<string, LockEntry>, b: Record<string, LockEntry>) {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const key of ka) {
    const x = a[key];
    const y = b[key];
    if (!y || x.locked !== y.locked || x.at !== y.at) return false;
  }
  return true;
}

/** 锁的顺序没有意义，只比集合，避免两台设备因遍历顺序不同反复落盘 */
function sameList(a: string[], b: string[]) {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((item) => set.has(item));
}

async function run(): Promise<void> {
  const local = readPrivacySnapshot();
  const remote = await readRemote();
  const locks = mergeLocks(local, remote);
  const pw = resolvePassword(local, remote);

  // 仓库里的密码更新时，把盐和哈希装进本机 localStorage，同一个密码就能直接解锁
  const localPw = exportPrivacyPassword();
  if (pw.from === 'remote' && !sameRecord(pw.rec, localPw)) importPrivacyPassword(pw.rec);

  const noteIds = Object.entries(locks)
    .filter(([key, entry]) => entry.locked && key.startsWith(NOTE_PREFIX))
    .map(([key]) => key.slice(NOTE_PREFIX.length));
  const folders = Object.entries(locks)
    .filter(([key, entry]) => entry.locked && key.startsWith(FOLDER_PREFIX))
    .map(([key]) => key.slice(FOLDER_PREFIX.length));

  const localChanged =
    !sameEntries(local.entries, locks) ||
    !sameList(local.noteIds, noteIds) ||
    !sameList(local.folders, folders) ||
    local.passwordAt !== pw.at;

  if (localChanged) {
    // touch: false：这是合并结果，不是用户刚做的改动，不要再盖一层新时间戳
    savePrivacy({ noteIds, folders }, { entries: locks, passwordAt: pw.at, touch: false });
  }

  const nextBody = JSON.stringify({ locks, password: pw.rec, passwordAt: pw.at });
  const remoteBody = remote
    ? JSON.stringify({ locks: remote.locks, password: remote.password, passwordAt: remote.passwordAt })
    : '';
  const hasContent = Object.keys(locks).length > 0 || Boolean(pw.rec) || Boolean(pw.at);

  if (hasContent && remoteBody !== nextBody) {
    try {
      await writeText(
        PRIVACY_FILE,
        JSON.stringify(
          { v: 1, locks, password: pw.rec, passwordAt: pw.at, updatedAt: new Date().toISOString() },
          null,
          2,
        ),
      );
    } catch (e) {
      // 写不进去时保留本机记录，下一次同步再试；不要让一次磁盘错误打断加锁 / 解锁
      console.warn('write privacy sync file failed', e);
    }
  }
}

/**
 * 供 Git 合并驱动使用：两台设备同时改过 privacy.json 时，按时间戳合成一份，
 * 而不是生成「冲突副本」让用户手动处理。返回 null 表示内容不是本模块认识的格式。
 */
export function mergePrivacyJson(ours: string, theirs: string): string | null {
  const a = parseRemote(ours);
  const b = parseRemote(theirs);
  if (!a || !b) return null;

  const locks: Record<string, LockEntry> = { ...b.locks };
  for (const [key, entry] of Object.entries(a.locks)) {
    locks[key] = newerLock(entry, locks[key]) as LockEntry;
  }

  let password = a.password;
  let passwordAt = a.passwordAt;
  if (b.passwordAt > passwordAt) {
    password = b.password;
    passwordAt = b.passwordAt;
  } else if (a.password && b.password && a.passwordAt === b.passwordAt && a.password.hash !== b.password.hash) {
    // 同一时刻密码不同：按哈希取一个稳定结果，保证两台设备合并出同一份
    if (b.password.hash > a.password.hash) password = b.password;
  }

  return JSON.stringify({ v: 1, locks, password, passwordAt, updatedAt: new Date().toISOString() }, null, 2);
}

let running: Promise<void> | null = null;
let timer = 0;

/**
 * 立即合并一次仓库与本机的隐私锁，并把结果写回仓库。
 * 多次调用会复用同一次执行，避免启动和同步回调同时跑。
 */
export function syncPrivacyNow(): Promise<void> {
  if (running) return running;
  running = run().finally(() => {
    running = null;
  });
  return running;
}

/** 用户在本机加锁 / 解锁后延迟写入，避免连续操作时反复落盘 */
export function schedulePrivacySync(delay = 600) {
  if (typeof window === 'undefined') return;
  if (timer) window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    timer = 0;
    void syncPrivacyNow().catch((e) => console.warn('privacy sync failed', e));
  }, delay);
}

/** 提交前调用：把还没到点的写入立刻做掉，避免最后一次加锁没进这次提交 */
export async function flushPrivacySync(): Promise<void> {
  if (timer) {
    window.clearTimeout(timer);
    timer = 0;
  }
  await syncPrivacyNow();
}
