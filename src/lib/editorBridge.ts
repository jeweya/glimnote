import type { EditorView } from '@codemirror/view';
import { ROOT, writeBinary } from './storage';
import { t } from './i18n';

let active: EditorView | null = null;

/** 图片压缩：长边超过这个值就等比缩小；大图即使尺寸不大也重新编码一遍 */
const IMAGE_MAX_EDGE = 2000;
const IMAGE_COMPRESS_ABOVE = 1.5 * 1024 * 1024;
const IMAGE_QUALITY = 0.85;

/** 单个附件（含图片）的大小上限，设置页可改，默认 5MB */
const ATTACH_LIMIT_KEY = 'glimnote.attachLimitMb';
export const ATTACH_LIMIT_DEFAULT = 5;
export const ATTACH_LIMIT_MIN = 1;
export const ATTACH_LIMIT_MAX = 200;

export function attachLimitMb() {
  const n = Number(localStorage.getItem(ATTACH_LIMIT_KEY));
  if (!Number.isFinite(n) || n <= 0) return ATTACH_LIMIT_DEFAULT;
  return Math.min(ATTACH_LIMIT_MAX, Math.max(ATTACH_LIMIT_MIN, Math.round(n)));
}

export function setAttachLimitMb(mb: number) {
  const value = Math.min(ATTACH_LIMIT_MAX, Math.max(ATTACH_LIMIT_MIN, Math.round(mb)));
  localStorage.setItem(ATTACH_LIMIT_KEY, String(value));
  return value;
}

/**
 * 平台自己的单文件上限：Gitee 免费仓库 50MB，GitHub / GitCode 约 100MB。
 * 留一点余量给提交对象和网络开销，避免刚好卡在边界上被服务端拒绝。
 */
export function platformFileLimitMb() {
  try {
    const raw = localStorage.getItem('glimnote.git.config');
    const provider = raw ? String(JSON.parse(raw)?.provider || '') : '';
    if (provider === 'github' || provider === 'gitcode') return 95;
    if (provider === 'gitee') return 45;
  } catch {
    /* 没配置仓库时按最严格的 Gitee 处理 */
  }
  return 45;
}

/** 用户设置值与平台上限取小，才是真正能传上去的大小 */
export function effectiveAttachLimitMb() {
  return Math.min(attachLimitMb(), platformFileLimitMb());
}

export function setActiveView(view: EditorView | null) {
  active = view;
}

export function getActiveView() {
  return active;
}

export function insertAtCursor(view: EditorView, text: string) {
  const { from, to } = view.state.selection.main;
  view.dispatch({
    changes: { from, to, insert: text },
    selection: { anchor: from + text.length },
  });
  view.focus();
}

export function wrapSelection(view: EditorView, before: string, after = before, placeholder = '文字') {
  const { from, to } = view.state.selection.main;
  const selected = view.state.sliceDoc(from, to) || placeholder;
  const insert = `${before}${selected}${after}`;
  view.dispatch({
    changes: { from, to, insert },
    selection: { anchor: from + before.length, head: from + before.length + selected.length },
  });
  view.focus();
}

export function toggleLinePrefix(
  view: EditorView,
  prefix: string,
  matcher = /^(\s*)([-*+]\s\[[ x]\]\s|[-*+]\s|\d+[.)]\s|>\s|#{1,6}\s)?/,
) {
  const { from } = view.state.selection.main;
  const line = view.state.doc.lineAt(from);
  const m = line.text.match(matcher);
  const current = m?.[2] || '';
  const start = line.from + (m?.[1].length || 0);
  const next = current === prefix ? '' : prefix;
  // 光标原本在行首时也要落到新前缀之后，否则接着输入的文字会跑到前缀前面
  const offset = Math.max(0, from - (start + current.length));
  view.dispatch({
    changes: { from: start, to: start + current.length, insert: next },
    selection: { anchor: start + next.length + offset },
  });
  view.focus();
}

/** 把一张本地图片存进仓库，并在光标处插入 Markdown 图片引用 */
export async function insertImageFile(
  view: EditorView,
  file: File,
  notePath: string,
  onNotice?: (text: string) => void,
) {
  const asset = await prepareImageAsset(file, notePath, onNotice);
  if (!asset) return;
  const line = view.state.doc.lineAt(view.state.selection.main.from).text;
  const lead = line.trim() ? '\n\n' : '';
  insertAtCursor(view, `${lead}![${asset.alt}](${asset.rel})\n`);
  onNotice?.(asset.notice);
}

/** 存图片到仓库，返回可直接写进 Markdown 的相对路径（源码编辑器与富文本编辑器共用） */
export async function prepareImageAsset(
  file: File,
  notePath: string,
  onNotice?: (text: string) => void,
): Promise<{ rel: string; alt: string; notice: string } | null> {
  if (!file.type.startsWith('image/')) return null;
  const limit = effectiveAttachLimitMb();
  // 先压缩再判断上限：一张 12MB 的截图压完完全能放进 Gitee 的单文件限制，
  // 没必要因为原图过大直接拒掉。
  const prepared = await compressImage(file);
  if (prepared.file.size > limit * 1024 * 1024) {
    onNotice?.(t('图片超过 {n}MB 上限（平台单文件限制），已跳过', { n: limit }));
    return null;
  }
  try {
    const { dir, name } = await storeImage(prepared.file);
    const rel = relativeAssetPath(notePath, dir, name);
    const alt = file.name.replace(/\.[^.]+$/, '') || t('图片');
    return {
      rel,
      alt,
      notice: prepared.compressed
        ? `已插入图片 · ${fileSize(file.size)} → ${fileSize(prepared.file.size)}（自动压缩）`
        : `已插入图片 · ${fileSize(file.size)}`,
    };
  } catch {
    onNotice?.('图片保存失败');
    return null;
  }
}

/**
 * 大图入库前先瘦身：长边压到 2000px，JPEG/WebP 用 0.85 质量重编码。
 * GIF（可能是动图）和 SVG（矢量）不动；PNG 仍输出 PNG，避免透明背景变黑。
 * 压缩后反而更大时保留原图，绝不做负优化。
 */
async function compressImage(file: File): Promise<{ file: File; compressed: boolean }> {
  const type = file.type;
  if (!/^image\/(jpeg|png|webp)$/i.test(type)) return { file, compressed: false };
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') {
    return { file, compressed: false };
  }

  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(file);
    const longEdge = Math.max(bitmap.width, bitmap.height);
    const needResize = longEdge > IMAGE_MAX_EDGE;
    const needReencode = file.size > IMAGE_COMPRESS_ABOVE;
    if (!needResize && !needReencode) return { file, compressed: false };

    const scale = needResize ? IMAGE_MAX_EDGE / longEdge : 1;
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return { file, compressed: false };
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, width, height);

    const outType = type === 'image/png' ? 'image/png' : type === 'image/webp' ? 'image/webp' : 'image/jpeg';
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, outType, outType === 'image/png' ? undefined : IMAGE_QUALITY);
    });
    if (!blob) return { file, compressed: false };
    // 只是重编码没缩小，或者缩了尺寸反而更大：保持原图
    if (blob.size >= file.size) return { file, compressed: false };

    const ext = outType === 'image/png' ? 'png' : outType === 'image/webp' ? 'webp' : 'jpg';
    const name = `${file.name.replace(/\.[^.]+$/, '') || 'image'}.${ext}`;
    return {
      file: new File([blob], name, { type: outType, lastModified: file.lastModified }),
      compressed: true,
    };
  } catch {
    return { file, compressed: false };
  } finally {
    bitmap?.close();
  }
}

/** 把任意本地文件存进仓库的 assets/年/月，内容哈希去重 */
export async function storeFile(file: File, fallbackExt = 'bin') {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hash = [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 8);
  const now = new Date();
  const dir = `assets/${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}`;
  const fromName = /\.([A-Za-z0-9]{1,12})$/.exec(file.name)?.[1];
  const fromType = file.type.split('/')[1];
  const ext = (fromName || fromType || fallbackExt)
    .toLowerCase()
    .replace('jpeg', 'jpg')
    .replace('svg+xml', 'svg')
    .replace(/[^a-z0-9]/g, '');
  const base =
    file.name
      .replace(/\.[^.]+$/, '')
      .replace(/[\\/:*?"<>|\s]+/g, '-')
      .slice(0, 40) || 'file';
  const name = `${hash}-${base}.${ext}`;
  await writeBinary(`${ROOT}/${dir}/${name}`, bytes);
  return { dir, name };
}

export function storeImage(file: File) {
  return storeFile(file, 'png');
}

function fileSize(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10240 ? 1 : 0)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

/** 存任意附件到仓库，返回链接信息（源码编辑器与富文本编辑器共用） */
export async function prepareAttachmentAsset(
  file: File,
  notePath: string,
  onNotice?: (text: string) => void,
): Promise<{ rel: string; label: string; notice: string } | null> {
  const userLimit = attachLimitMb();
  const limit = effectiveAttachLimitMb();
  if (file.size > limit * 1024 * 1024) {
    onNotice?.(
      limit < userLimit
        ? `文件超过 ${limit}MB（平台单文件上限），已跳过`
        : `文件超过 ${limit}MB 上限，已跳过；可在设置 → 常规里调整`,
    );
    return null;
  }
  try {
    const { dir, name } = await storeFile(file);
    const rel = relativeAssetPath(notePath, dir, name);
    return { rel, label: file.name || name, notice: `已插入附件 · ${fileSize(file.size)}` };
  } catch {
    onNotice?.('附件保存失败');
    return null;
  }
}

/** 把任意附件存进仓库，并在光标处插入指向它的链接 */
export async function insertAttachmentFile(
  view: EditorView,
  file: File,
  notePath: string,
  onNotice?: (text: string) => void,
) {
  const asset = await prepareAttachmentAsset(file, notePath, onNotice);
  if (!asset) return;
  // 和前面的文字之间留个空格，避免链接和正文粘在一起
  const line = view.state.doc.lineAt(view.state.selection.main.from).text;
  const lead = line.trim() ? ' ' : '';
  insertAtCursor(view, `${lead}[${asset.label}](${asset.rel}) `);
  onNotice?.(asset.notice);
}

export function relativeAssetPath(notePath: string, dir: string, name: string) {
  // 笔记路径形如 notes/笔记本/标题.md：目录层数 = 段数 - 1
  const depth = Math.max(0, notePath.split('/').length - 1);
  return `${'../'.repeat(depth)}${dir}/${name}`;
}
