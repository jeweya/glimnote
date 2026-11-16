import { ROOT, readBinary } from './storage';

/** 把笔记里的相对图片路径解析为仓库内的绝对路径 */
export function resolveAsset(notePath: string, src: string): string | null {
  if (!src || /^(https?:|data:|blob:|file:)/i.test(src)) return null;
  if (src.startsWith('/')) return `${ROOT}${src}`;
  const base = notePath.split('/').slice(0, -1);
  const parts = [...base, ...src.split('/')];
  const out: string[] = [];
  for (const part of parts) {
    if (part === '..') out.pop();
    else if (part && part !== '.') out.push(part);
  }
  return `${ROOT}/${out.join('/')}`;
}

/**
 * 图片宽度写在 alt 末尾，形如 ![示意图|360](assets/…)：
 * 仍是标准 Markdown，其它编辑器只是多看到一段 alt 文字，不会破坏文件。
 * 只接受 40–4000 之间的整数，避免把名字里带 `|` 的真实 alt 误判。
 */
export function parseImageAlt(alt: string): { alt: string; width?: number } {
  const m = /^(.*?)\|\s*(\d{2,4})(?:\s*x\s*\d{2,4})?\s*$/.exec(alt);
  if (!m) return { alt };
  const width = Number(m[2]);
  if (!Number.isFinite(width) || width < 40 || width > 4000) return { alt };
  return { alt: m[1].trim(), width };
}

/** 把宽度写回 alt；不传宽度则去掉尺寸后缀 */
export function withImageWidth(alt: string, width?: number | null): string {
  const base = parseImageAlt(alt).alt;
  return width ? `${base}|${Math.round(width)}` : base;
}

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  avif: 'image/avif',
  pdf: 'application/pdf',
  txt: 'text/plain;charset=utf-8',
  md: 'text/markdown;charset=utf-8',
  csv: 'text/csv;charset=utf-8',
  json: 'application/json',
  zip: 'application/zip',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

/** 按扩展名推断 MIME，附件下载时用 */
export function mimeOf(path: string) {
  const ext = path.split('.').pop()?.toLowerCase() || '';
  return MIME[ext] || 'application/octet-stream';
}

function toBase64(bytes: Uint8Array) {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

/** 读取仓库内的附件并转为 data URL，用于导出自包含的 HTML */
export async function assetDataUrl(notePath: string, src: string): Promise<string | null> {
  const abs = resolveAsset(notePath, src);
  if (!abs) return null;
  const data = await readBinary(abs);
  return `data:${mimeOf(abs)};base64,${toBase64(data)}`;
}
