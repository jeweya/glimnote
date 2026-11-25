/**
 * 仓库里的图片 / 附件资源：盘点、补传七牛云、替换引用、删除本地文件。
 *
 * 文件元数据、「已上传」记录与引用情况统一存在登记表里（见 assetIndex.ts），
 * 表跟着 Git 同步，换一台设备也能看到同样的资源管理；引用记录由 assetRefs.ts
 * 跟着笔记增量维护，打开存储管理时不用每次递归 stat 文件、也不用重扫全部正文。
 */
import { ROOT, readBinary, removePath, writeNote } from './storage';
import { mimeOf } from './assets';
import { assetLinksOf, countAssetLinks, refPathOf, rewriteAssetLinks } from './assetLinks';
import { ensureAssetRefsReady, rebuildAssetRefs } from './assetRefs';
import { isQiniuEnabled, readQiniuConfig, uploadQiniuFile } from './qiniu';
import {
  ensureAssetIndex,
  forgetUploadedEntry,
  markUploadedEntry,
  removeAssetEntries,
} from './assetIndex';
import { t } from './i18n';
import type { Note } from './markdown';
import { useApp } from '../store/app';

export const ASSETS_DIR = `${ROOT}/assets`;
/** 资源列表需要重读时广播（上传、删除之后） */
export const ASSETS_CHANGED_EVENT = 'glimnote:assets-changed';
/**
 * 请求正在打开的编辑器把某个本地资源地址换成云端链接。
 * 详情：{ abs: 仓库绝对路径, url: 公网链接 }
 */
export const ASSET_URL_EVENT = 'glimnote:asset-url-replaced';

export interface UploadedAsset {
  url: string;
  /** ISO 时间，方便排查是哪一次传的 */
  at: string;
  /** 上传时的文件大小；老记录没有这一项，列表里显示为 — */
  size?: number;
}

export interface LocalAsset {
  /** 仓库内绝对路径 /repo/assets/... */
  abs: string;
  /** 相对仓库根的路径 assets/...，也是七牛里的 key */
  rel: string;
  /** 去掉内容哈希后的展示名 */
  name: string;
  ext: string;
  size: number;
  image: boolean;
  /** 正文（含回收站）里仍指向这个本地文件的链接数；0 表示已经没人用了 */
  refs: number;
  /** 本机记录过的云端地址；有值说明传过 */
  uploaded?: string;
  /** 本机副本已经删掉，只剩七牛云上的副本（列表里单独一组） */
  remoteOnly?: boolean;
  /** 从日记正文的云端链接里扫出来的，本机没有对应的上传记录 */
  derived?: boolean;
}

export async function loadUploadedAssets() {
  const entries = await ensureAssetIndex();
  const out: Record<string, UploadedAsset> = {};
  for (const entry of entries) {
    if (!entry.uploaded) continue;
    out[entry.rel] = {
      url: entry.uploaded,
      at: entry.uploadedAt || '',
      ...(entry.size ? { size: entry.size } : {}),
    };
  }
  return out;
}

export function markAssetUploaded(rel: string, url: string, size?: number) {
  return markUploadedEntry(rel, url, size);
}

export function forgetAssetUploaded(rel: string) {
  return forgetUploadedEntry(rel);
}

const IMAGE_EXT = /^(png|jpe?g|gif|webp|svg|bmp|avif|ico)$/i;

/**
 * 早期粘贴进来的图片一律叫 image.png（浏览器剪贴板给的就是这个名字），
 * 去掉哈希后列表里全长得一样。这类名字改用「截图 + 年月」展示；
 * 同一组里仍然重名时，由存储管理界面补上短哈希区分。
 */
const GENERIC_ASSET_STEM =
  /^(image|img|blob|clipboard|screenshot|scrnshot|untitled|paste|截图|图片|粘贴图片)([-_\s（(]?\d*[)）]?)?$/i;

/** 资源文件展示名：assets/年/月/8位哈希-原名.png → 原名.png */
export function assetDisplayName(rel: string) {
  const base = rel.split('/').pop() || rel;
  const stripped = base.replace(/^[0-9a-f]{8}-/i, '') || base;
  const dot = stripped.lastIndexOf('.');
  const stem = dot > 0 ? stripped.slice(0, dot) : stripped;
  const ext = dot > 0 ? stripped.slice(dot) : '';
  if (!GENERIC_ASSET_STEM.test(stem)) return stripped;
  const month = /^assets\/(\d{4})\/(\d{2})\//.exec(rel);
  const stamp = month ? ` ${month[1]}-${month[2]}` : '';
  return `${t('截图')}${stamp}${ext}`;
}

/** 文件在 assets/ 里的内容哈希（8 位）；没有哈希的旧文件返回空串 */
export function assetHashOf(rel: string) {
  return /^([0-9a-f]{8})-/i.exec(rel.split('/').pop() || '')?.[1].toLowerCase() || '';
}

/** 同名文件太多时，在展示名后补上短哈希，避免一屏全是「截图」 */
export function disambiguateAssetNames<T extends { rel: string; name: string }>(list: T[]): T[] {
  const counts = new Map<string, number>();
  for (const item of list) counts.set(item.name, (counts.get(item.name) || 0) + 1);
  return list.map((item) => {
    if ((counts.get(item.name) || 0) < 2) return item;
    const hash = assetHashOf(item.rel);
    if (!hash) return item;
    const dot = item.name.lastIndexOf('.');
    const name =
      dot > 0
        ? `${item.name.slice(0, dot)} · ${hash.slice(0, 4)}${item.name.slice(dot)}`
        : `${item.name} · ${hash.slice(0, 4)}`;
    return { ...item, name };
  });
}

export function isImageAsset(path: string) {
  return IMAGE_EXT.test(path.split('.').pop() || '');
}

export function formatAssetSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/**
 * 盘点 assets/ 下真实存在的文件。
 *
 * 文件清单与大小来自登记表，不再每次递归 stat 整个目录；
 * force = true（「重新扫描」按钮）时强制和真实目录对一次账。
 * 引用次数总是按当前正文现算，保证「未引用」不会被旧表误导。
 */
export async function scanLocalAssets(force = false): Promise<LocalAsset[]> {
  // 先把登记表补齐：刚存进来的文件要先进表，引用记录才有地方落
  await ensureAssetIndex(force);
  // 引用次数来自登记表：本次会话首次打开做一次全量校对，平时按增量维护
  if (force) await rebuildAssetRefs();
  else await ensureAssetRefsReady();
  const entries = await ensureAssetIndex();
  const totalRefs = (refs: Record<string, number> | undefined) =>
    refs ? Object.values(refs).reduce((sum, n) => sum + (Number(n) || 0), 0) : 0;
  const rows: LocalAsset[] = [];
  for (const entry of entries) {
    if (!entry.local) continue;
    rows.push({
      abs: `${ROOT}/${entry.rel}`,
      rel: entry.rel,
      name: assetDisplayName(entry.rel),
      ext: (entry.rel.split('.').pop() || '').toLowerCase(),
      size: entry.size,
      image: isImageAsset(entry.rel),
      refs: totalRefs(entry.refs),
      uploaded: entry.uploaded,
    });
  }
  return rows.sort((a, b) => b.size - a.size);
}

/**
 * 只存在七牛云上的文件，分两类：
 * 1. 本机传过、后来删了本地副本（登记表里 local=false 的记录）；
 * 2. 日记正文里直接用着七牛云链接、但本机没有记录（例如在别的设备上传的）。
 * 都只做展示，不会去动云端文件。
 */
export async function scanCloudOnlyAssets(localRels: Iterable<string>): Promise<LocalAsset[]> {
  const present = new Set(localRels);
  const entries = await ensureAssetIndex();
  const notes = [...useApp.getState().notes, ...useApp.getState().trash];
  const rows: LocalAsset[] = [];
  const seenUrls = new Set<string>();

  // 一次遍历正文：顺手统计每个链接出现的次数，避免「每个云端文件都扫一遍全文」
  const urlCounts = new Map<string, number>();
  const derived: { rel: string; url: string }[] = [];
  // 补上正文里出现、但没有上传记录的七牛云链接（通常是别的设备传的）。
  // 开关关掉时仍然要能看见云端文件，所以这里读配置本身，不看开关。
  const cfg = readQiniuConfig();
  const domainHost = cfg ? cfg.domain.replace(/^https?:\/\//i, '').replace(/\/+$/, '') : '';
  const urlRe = /https?:\/\/[^\s)"'<>]+/g;
  for (const note of notes) {
    for (const match of note.content.matchAll(urlRe)) {
      const url = match[0];
      urlCounts.set(url, (urlCounts.get(url) || 0) + 1);
      if (!domainHost) continue;
      const at = url.indexOf(`${domainHost}/`);
      if (at < 0) continue;
      const path = url.slice(at + domainHost.length + 1).split(/[?#]/)[0];
      if (!path) continue;
      // 新上传的都在 glimnote/ 下；旧链接没有这一层，也一并识别
      const repoPath = path.startsWith('glimnote/') ? path.slice('glimnote/'.length) : path;
      let rel = repoPath;
      try {
        rel = decodeURIComponent(repoPath);
      } catch {
        /* 编码坏了就按原样展示 */
      }
      if (!rel.startsWith('assets/')) continue;
      derived.push({ rel, url });
    }
  }

  const pushRow = (rel: string, url: string, size: number, derivedRow: boolean) => {
    if (present.has(rel) || seenUrls.has(url)) return;
    seenUrls.add(url);
    rows.push({
      abs: `${ROOT}/${rel}`,
      rel,
      name: assetDisplayName(rel),
      ext: (rel.split('.').pop() || '').toLowerCase(),
      size,
      image: isImageAsset(rel),
      refs: urlCounts.get(url) || 0,
      uploaded: url,
      remoteOnly: true,
      ...(derivedRow ? { derived: true } : {}),
    });
  };

  for (const entry of entries) {
    if (present.has(entry.rel) || !entry.uploaded) continue;
    pushRow(entry.rel, entry.uploaded, entry.size, false);
  }
  for (const item of derived) pushRow(item.rel, item.url, 0, true);

  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

// 链接解析统一放在 assetLinks.ts：登记表的引用统计和这里的替换逻辑共用一套规则
export { countAssetLinks, rewriteAssetLinks };

/** 找出正文里引用了该资源的日记（回收站不算，回收站里的打不开） */
export interface AssetReference {
  note: Note;
  count: number;
}

export function findAssetReferences(abs: string, cloudUrl?: string): AssetReference[] {
  const state = useApp.getState();
  const refs: AssetReference[] = [];
  for (const note of state.notes) {
    let count = countAssetLinks(note.content, refPathOf(note), abs);
    // 已上传的图片正文里可能已经是云端链接，就不再指向本地路径了
    if (cloudUrl && /^https?:/i.test(cloudUrl)) {
      count += note.content.split(cloudUrl).length - 1;
    }
    if (count > 0) refs.push({ note, count });
  }
  return refs;
}

/** 整个仓库（含回收站）里仍有多少处引用 */
export function countAssetReferences(abs: string) {
  const state = useApp.getState();
  let n = 0;
  for (const note of [...state.notes, ...state.trash]) {
    n += countAssetLinks(note.content, refPathOf(note), abs);
  }
  return n;
}

/**
 * 一次遍历所有笔记（含回收站），统计 assets/ 下每个本地文件被引用的次数。
 *
 * 在日记里删掉一张图片只会删掉 Markdown 里的那一行，文件本身还在仓库里，
 * 所以扫描时要顺手算出「没人引用」的文件，存储管理里才能提示清理。
 */
export function countLocalAssetLinks(): Map<string, number> {
  const state = useApp.getState();
  const counts = new Map<string, number>();
  for (const note of [...state.notes, ...state.trash]) {
    for (const [rel, n] of assetLinksOf(note.content, refPathOf(note))) {
      const abs = `${ROOT}/${rel}`;
      counts.set(abs, (counts.get(abs) || 0) + n);
    }
  }
  return counts;
}

/** 批量删除本地文件（清理未被引用的资源）；返回删不掉的文件，最后只刷新一次列表 */
export async function deleteLocalAssets(absList: string[]) {
  const failed: string[] = [];
  const removed: string[] = [];
  for (const abs of absList) {
    try {
      // 删掉本机文件后「已上传」记录要保留：存储管理里还能看到七牛云上的这份
      await removePath(abs);
      removed.push(abs.slice(ROOT.length + 1));
    } catch {
      failed.push(abs);
    }
  }
  if (removed.length) await removeAssetEntries(removed);
  window.dispatchEvent(new Event(ASSETS_CHANGED_EVENT));
  return failed;
}

export interface ReplaceResult {
  /** 被改写的笔记篇数 */
  updated: number;
  /** 回收站里被改写的篇数 */
  trashUpdated: number;
  /** 改写完成后仓库里还剩多少处引用（正常应为 0） */
  remaining: number;
}

/**
 * 把全仓库里指向该资源的链接替换成云端地址。
 *
 * 正在编辑的笔记不直接改 store，而是让编辑器自己改（见 ASSET_URL_EVENT）：
 * 否则会和用户手里那份尚未保存的缓冲区打架，下一次输入就把改动覆盖回去了。
 */
export async function replaceAssetReferences(abs: string, url: string): Promise<ReplaceResult> {
  const state = useApp.getState();
  const currentId = state.current?.id;
  let updated = 0;
  let trashUpdated = 0;

  for (const note of state.notes) {
    const next = rewriteAssetLinks(note.content, refPathOf(note), abs, url);
    if (next === note.content) continue;
    updated += 1;
    if (note.id === currentId) {
      window.dispatchEvent(
        new CustomEvent(ASSET_URL_EVENT, {
          detail: { abs, rel: abs.slice(ROOT.length + 1), url },
        }),
      );
      const after = useApp.getState().notes.find((n) => n.id === note.id);
      // 编辑器没挂载（阅读预览 / 回收站等）或没接住事件时兜底
      if (!after || after.content === note.content) useApp.getState().updateContent(note.id, next);
    } else {
      useApp.getState().updateContent(note.id, next);
    }
  }

  const trash = useApp.getState().trash;
  if (trash.some((note) => rewriteAssetLinks(note.content, refPathOf(note), abs, url) !== note.content)) {
    const nextTrash = [];
    for (const note of trash) {
      const next = rewriteAssetLinks(note.content, refPathOf(note), abs, url);
      if (next === note.content) {
        nextTrash.push(note);
        continue;
      }
      trashUpdated += 1;
      const changed = { ...note, content: next };
      try {
        await writeNote(changed);
      } catch {
        /* 写不进去也先把内存里的内容换掉，至少恢复时链接是对的 */
      }
      nextTrash.push(changed);
    }
    useApp.setState({ trash: nextTrash });
  }

  const after = useApp.getState();
  let remaining = 0;
  for (const note of [...after.notes, ...after.trash]) {
    remaining += countAssetLinks(note.content, refPathOf(note), abs);
  }
  return { updated, trashUpdated, remaining };
}

/** 上传一个仓库里的资源；key 沿用仓库路径，方便和本地文件一一对应 */
export async function uploadLocalAsset(abs: string) {
  const cfg = readQiniuConfig();
  if (!cfg) throw new Error('还没有配置七牛云，请先到「存储 → 云存储设置」里填写');
  if (!isQiniuEnabled()) throw new Error('云存储开关是关着的，请先在「存储 → 云存储设置」里打开');
  const rel = abs.slice(ROOT.length + 1);
  const bytes = await readBinary(abs);
  const name = abs.split('/').pop() || 'file';
  const file = new File([bytes.slice().buffer as ArrayBuffer], name, {
    type: mimeOf(abs) || 'application/octet-stream',
  });
  const url = await uploadQiniuFile(file, cfg, rel);
  return { url, rel };
}

/**
 * 删除仓库里的本地文件；已经上传过的话保留「已上传」记录，
 * 存储管理里会把它转到「仅在七牛云」一组，方便复制链接或找引用。
 */
export async function deleteLocalAsset(abs: string) {
  await removePath(abs);
  // 删掉本机文件后「已上传」记录要保留：存储管理里会把它转到「仅在七牛云」
  await removeAssetEntries([abs.slice(ROOT.length + 1)]);
  window.dispatchEvent(new Event(ASSETS_CHANGED_EVENT));
}
