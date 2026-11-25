/**
 * 资源登记表：assets/ 下每个文件的元数据（大小、是否上传过、云端地址、引用情况）。
 *
 * 存在 .glimnote/assets-index.json —— 这个目录会跟着 Git 同步，换一台设备登录
 * 同一个仓库也能看到哪些图片传过七牛云、各被哪几篇笔记引用。只有「本机现在还有
 * 没有这个文件」不写进表里：它按当前目录当场判断，换设备不会误报。
 *
 * 引用信息按「笔记 id → 链接次数」记在每条资源下面，由 assetRefs.ts 增量维护：
 * 正文里删掉图片链接后，这里对应的记录也会跟着消失，存储管理不必每次重扫全文。
 *
 * 两台设备同时改表时由 mergeAssetsIndexJson 按条目合并，避免为一张 JSON 生成
 * 冲突副本；合并结果里的引用计数可能暂时重复，各设备启动后会全量校对一次。
 */
import { ROOT, listFiles, pathSize, readText, removePath, writeText } from './storage';

export const INDEX_ASSETS_DIR = `${ROOT}/assets`;
const INDEX_PATH = `${ROOT}/.glimnote/assets-index.json`;
/** 老版本把表放在本机目录里，第一次读到时搬进同步区 */
const LEGACY_INDEX_PATH = `${ROOT}/.glimnote/local/assets-index.json`;
const INDEX_VERSION = 2;
/** 更老版本把「已上传」记录存在 localStorage，读到后搬进表里 */
const LEGACY_UPLOADED_KEY = 'glimnote.assets.uploaded';
/** 两次全量对账之间的最短间隔：应用内的增删会直接改表，这里只兜底外部改动 */
const RECONCILE_TTL = 5 * 60 * 1000;
/** 被「从列表移除」的云端记录保留一段时间，方便合并时压掉另一台设备的旧副本 */
const FORGOTTEN_TTL = 30 * 24 * 60 * 60 * 1000;

export type AssetRefs = Record<string, number>;

export interface AssetEntry {
  /** 相对仓库根：assets/年/月/哈希-名.png */
  rel: string;
  /** 字节；本机副本已删除但云端还在时保留上传时的大小 */
  size: number;
  /** 本机仓库里现在是否还有这个文件（false 表示只在七牛云上） */
  local: boolean;
  uploaded?: string;
  uploadedAt?: string;
  /** 笔记 id → 这篇笔记里指向本资源的链接数；空对象表示没人引用 */
  refs: AssetRefs;
}

interface StoredEntry {
  size?: number;
  uploaded?: string;
  uploadedAt?: string;
  /** 用户点过「从列表移除」的时间：比上传时间新就不再显示云端地址 */
  forgottenAt?: string;
  refs?: AssetRefs;
}

interface IndexFile {
  v: number;
  updatedAt: string;
  assets: Record<string, StoredEntry>;
}

let cache: Map<string, AssetEntry> | null = null;
let lastReconcile = 0;
/** 读到的还是本机旧表：写新表成功后把它删掉 */
let legacySource = false;
/** 所有写表操作串成一条链，避免两个操作同时读改写同一个 JSON */
let writeChain: Promise<void> = Promise.resolve();

function toEntry(rel: string, stored: StoredEntry, local: boolean): AssetEntry {
  const refs: AssetRefs = {};
  for (const [noteId, count] of Object.entries(stored.refs || {})) {
    if (typeof count === 'number' && count > 0) refs[noteId] = count;
  }
  return {
    rel,
    size: typeof stored.size === 'number' && stored.size > 0 ? stored.size : 0,
    local,
    ...(stored.uploaded ? { uploaded: stored.uploaded } : {}),
    ...(stored.uploadedAt ? { uploadedAt: stored.uploadedAt } : {}),
    refs,
  };
}

/** 老版本存在 localStorage 里的上传记录：搬进登记表后就地删掉 */
function takeLegacyUploaded(): Record<string, { url: string; at?: string; size?: number }> {
  try {
    const raw = localStorage.getItem(LEGACY_UPLOADED_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, { url: string; at?: string; size?: number }> = {};
    for (const [rel, value] of Object.entries(parsed || {})) {
      const item = value as { url?: unknown; at?: unknown; size?: unknown } | null;
      if (!item || typeof item.url !== 'string' || !item.url) continue;
      out[rel] = {
        url: item.url,
        ...(typeof item.at === 'string' ? { at: item.at } : {}),
        ...(typeof item.size === 'number' && item.size > 0 ? { size: item.size } : {}),
      };
    }
    return out;
  } catch {
    return {};
  }
}

async function parseIndex(text: string): Promise<Record<string, StoredEntry> | null> {
  try {
    const parsed = JSON.parse(text) as Partial<IndexFile> | null;
    if (parsed && typeof parsed === 'object' && parsed.assets && typeof parsed.assets === 'object') {
      return parsed.assets;
    }
  } catch {
    /* 表不存在或坏掉：交给调用方从空白开始 */
  }
  return null;
}

async function readIndex(): Promise<IndexFile> {
  let assets: Record<string, StoredEntry> | null = null;
  try {
    assets = await parseIndex(await readText(INDEX_PATH));
  } catch {
    /* 没有这张表 */
  }
  if (!assets) {
    try {
      assets = await parseIndex(await readText(LEGACY_INDEX_PATH));
      if (assets) legacySource = true;
    } catch {
      /* 也没有旧表 */
    }
  }
  const index: IndexFile = { v: INDEX_VERSION, updatedAt: '', assets: assets || {} };

  const legacy = takeLegacyUploaded();
  for (const [rel, value] of Object.entries(legacy)) {
    const entry = index.assets[rel] || {};
    if (!entry.uploaded) {
      entry.uploaded = value.url;
      entry.uploadedAt = value.at || '';
    }
    if (!entry.size && value.size) entry.size = value.size;
    index.assets[rel] = entry;
  }
  return index;
}

function writeIndex(index: IndexFile): Promise<void> {
  index.v = INDEX_VERSION;
  index.updatedAt = new Date().toISOString();
  const body = JSON.stringify(index);
  writeChain = writeChain
    .catch(() => {
      /* 上一次写失败不能堵住后面的写入 */
    })
    .then(() => writeText(INDEX_PATH, body))
    .then(async () => {
      // 老记录已经落进表里，这时候才删旧数据，避免写盘失败丢东西
      try {
        localStorage.removeItem(LEGACY_UPLOADED_KEY);
      } catch {
        /* 隐私模式下 localStorage 可能不可用 */
      }
      if (legacySource) {
        legacySource = false;
        await removePath(LEGACY_INDEX_PATH).catch(() => {});
      }
    });
  return writeChain;
}

/** 所有「读表 → 改表 → 写表」排进同一条链：上传、删除、对账、引用更新可能同时发生 */
let opChain: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const next = opChain.then(task, task);
  opChain = next.catch(() => {
    /* 上一次失败不能堵住后面的操作 */
  });
  return next;
}

async function runMutate(
  fn: (assets: Record<string, StoredEntry>) => string[] | null,
  localHint?: boolean,
): Promise<void> {
  const index = await readIndex();
  const touched = fn(index.assets);
  if (!touched) return;
  await writeIndex(index);
  if (!cache) return;
  for (const rel of touched) {
    const stored = index.assets[rel];
    if (!stored) {
      cache.delete(rel);
      continue;
    }
    const prev = cache.get(rel);
    cache.set(rel, toEntry(rel, stored, localHint === undefined ? Boolean(prev?.local) : localHint));
  }
}

/** 读改写一条记录；fn 返回 null 表示没变化，不落盘 */
function mutate(
  fn: (assets: Record<string, StoredEntry>) => string[] | null,
  localHint?: boolean,
): Promise<void> {
  return enqueue(() => runMutate(fn, localHint));
}

function entriesOf(index: IndexFile, present: Set<string>): AssetEntry[] {
  return Object.entries(index.assets).map(([rel, stored]) => toEntry(rel, stored, present.has(rel)));
}

/** 引用记录是否完全一致（避免每次启动都无谓重写表） */
function sameRefs(a: AssetRefs, b: AssetRefs) {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((key) => a[key] === b[key]);
}

/**
 * 拿到登记表；必要时和真实目录对一次账。
 *
 * force = true 时忽略缓存（「重新扫描」按钮）；平时一个会话只对账一次，
 * 其余时间只读表，打开存储管理不再逐个 stat 文件。
 */
export async function ensureAssetIndex(force = false): Promise<AssetEntry[]> {
  const stale = Date.now() - lastReconcile > RECONCILE_TTL;
  if (!force && cache && !stale) return [...cache.values()];

  return enqueue(() => reconcile());
}

async function reconcile(): Promise<AssetEntry[]> {
  const index = await readIndex();
  const files = await listFiles(INDEX_ASSETS_DIR);
  const present = new Set<string>();
  let changed = false;

  for (const abs of files) {
    const rel = abs.slice(ROOT.length + 1);
    present.add(rel);
    const entry = index.assets[rel];
    if (entry) {
      // 已有记录只在大小时才需要 stat；平时沿用表里的值
      if (!entry.size) {
        try {
          entry.size = (await pathSize(abs)).bytes;
          changed = true;
        } catch {
          /* 读不到大小就先记 0 */
        }
      }
      continue;
    }
    try {
      index.assets[rel] = { size: (await pathSize(abs)).bytes };
      changed = true;
    } catch {
      /* 刚被删掉的文件跳过 */
    }
  }

  for (const rel of Object.keys(index.assets)) {
    if (present.has(rel)) continue;
    const entry = index.assets[rel];
    // 本机副本没了、云端还有：保留记录，「云端文件」页签要用
    if (entry.uploaded) continue;
    // 「从列表移除」留下的墓碑只保留一段时间，之后随对账清掉
    const forgottenAt = Date.parse(entry.forgottenAt || '');
    if (entry.forgottenAt && Number.isFinite(forgottenAt) && Date.now() - forgottenAt < FORGOTTEN_TTL) {
      continue;
    }
    delete index.assets[rel];
    changed = true;
  }

  if (changed || !index.updatedAt) {
    try {
      await writeIndex(index);
    } catch {
      /* 写不进去也不影响本次展示，下次再补 */
    }
  }
  const entries = entriesOf(index, present);
  cache = new Map(entries.map((entry) => [entry.rel, entry]));
  lastReconcile = Date.now();
  return entries;
}

/** 新文件落盘后登记；已存在的同名文件只更新大小 */
export async function upsertAssetEntry(rel: string, size: number) {
  await mutate((assets) => {
    const entry = assets[rel] || {};
    entry.size = size;
    assets[rel] = entry;
    return [rel];
  }, true);
}

/** 上传成功后记下云端地址；size 只在表里还没有大小时才用 */
export async function markUploadedEntry(rel: string, url: string, size?: number) {
  await mutate((assets) => {
    const entry = assets[rel] || {};
    entry.uploaded = url;
    entry.uploadedAt = new Date().toISOString();
    delete entry.forgottenAt;
    if (size && size > 0) entry.size = size;
    assets[rel] = entry;
    return [rel];
  });
}

/** 不再认这条上传记录：本地还在就只清云端地址，本地也没了就连记录一起删 */
export async function forgetUploadedEntry(rel: string) {
  await mutate((assets) => {
    const entry = assets[rel];
    if (!entry || !entry.uploaded) return null;
    delete entry.uploaded;
    delete entry.uploadedAt;
    entry.forgottenAt = new Date().toISOString();
    assets[rel] = entry;
    return [rel];
  });
}

/** 本机文件删除后同步登记表；上传过的记录保留，转到「云端文件」 */
export async function removeAssetEntries(rels: string[]) {
  await mutate((assets) => {
    const touched: string[] = [];
    for (const rel of rels) {
      const entry = assets[rel];
      if (!entry) continue;
      if (entry.uploaded) {
        // 有云端副本：记录留着，界面里会把它转到「仅在七牛云」
        touched.push(rel);
        continue;
      }
      delete assets[rel];
      touched.push(rel);
    }
    return touched.length ? touched : null;
  });
  if (!cache) return;
  for (const rel of rels) {
    const entry = cache.get(rel);
    if (entry) cache.set(rel, { ...entry, local: false });
  }
}

/**
 * 一批笔记的引用变化：对每个资源先清掉这些笔记的旧记录，再写入新的。
 * 合在一次读改写里完成，连续编辑多篇笔记时不会出现互相覆盖的中间态。
 */
export async function applyNoteRefsBatch(items: [string, Map<string, number>][]) {
  if (!items.length) return;
  await mutate((assets) => {
    const touched: string[] = [];
    for (const [rel, entry] of Object.entries(assets)) {
      const refs = entry.refs || {};
      let changed = false;
      for (const [noteId, links] of items) {
        const prev = refs[noteId] || 0;
        const next = links.get(rel) || 0;
        if (prev === next) continue;
        if (next > 0) refs[noteId] = next;
        else delete refs[noteId];
        changed = true;
      }
      if (!changed) continue;
      if (Object.keys(refs).length) entry.refs = refs;
      else delete entry.refs;
      assets[rel] = entry;
      touched.push(rel);
    }
    return touched.length ? touched : null;
  });
}

/** 全量校对：用当前正文算出的引用表替换表里的旧值 */
export async function replaceAllRefs(computed: Map<string, AssetRefs>) {
  await mutate((assets) => {
    const touched: string[] = [];
    for (const [rel, entry] of Object.entries(assets)) {
      const next = computed.get(rel) || {};
      if (sameRefs(entry.refs || {}, next)) continue;
      if (Object.keys(next).length) entry.refs = next;
      else delete entry.refs;
      assets[rel] = entry;
      touched.push(rel);
    }
    return touched.length ? touched : null;
  });
}

/** 手动让下一次读取重新对账（同步完仓库、或用户要求刷新时） */
export function invalidateAssetIndex() {
  cache = null;
  lastReconcile = 0;
}

/**
 * 两台设备同时改表时的按条目合并（给 isomorphic-git 的 mergeDriver 用）。
 *
 * 文件记录取并集；上传 / 移除按时间取最新的一次操作，避免另一台设备把已经
 * 移除的记录又带回来。引用计数不做精细合并——各设备启动时的全量校对公司正。
 */
export function mergeAssetsIndexJson(ours: string, theirs: string): string | null {
  try {
    const a = JSON.parse(ours) as Partial<IndexFile> | null;
    const b = JSON.parse(theirs) as Partial<IndexFile> | null;
    if (!a?.assets || !b?.assets) return null;
    const assets: Record<string, StoredEntry> = {};
    for (const rel of new Set([...Object.keys(a.assets), ...Object.keys(b.assets)])) {
      const x = a.assets[rel] || {};
      const y = b.assets[rel] || {};
      const entry: StoredEntry = {};
      const size = Math.max(x.size || 0, y.size || 0);
      if (size) entry.size = size;

      const events: { at: number; url?: string; forgotten?: boolean }[] = [];
      if (x.uploadedAt) events.push({ at: Date.parse(x.uploadedAt) || 0, url: x.uploaded || undefined });
      if (y.uploadedAt) events.push({ at: Date.parse(y.uploadedAt) || 0, url: y.uploaded || undefined });
      if (x.forgottenAt) events.push({ at: Date.parse(x.forgottenAt) || 0, forgotten: true });
      if (y.forgottenAt) events.push({ at: Date.parse(y.forgottenAt) || 0, forgotten: true });
      events.sort((m, n) => m.at - n.at);
      const last = events[events.length - 1];
      if (last?.forgotten) {
        entry.forgottenAt = new Date(last.at || Date.now()).toISOString();
      } else if (last?.url) {
        entry.uploaded = last.url;
        entry.uploadedAt = new Date(last.at || Date.now()).toISOString();
      }

      const refs: AssetRefs = { ...(x.refs || {}), ...(y.refs || {}) };
      if (Object.keys(refs).length) entry.refs = refs;
      assets[rel] = entry;
    }
    const merged: IndexFile = { v: INDEX_VERSION, updatedAt: new Date().toISOString(), assets };
    return JSON.stringify(merged);
  } catch {
    return null;
  }
}
