import { uuid, dateKey } from './utils';
import { t } from './i18n';

export interface NoteMeta {
  id: string;
  title: string;
  notebook: string;
  path: string;
  tags: string[];
  created: string;
  updated: string;
  pinned: boolean;
  deletedAt?: string;
  size: number;
  excerpt: string;
}

export interface Note extends NoteMeta {
  content: string;
}

const FM_RE = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

function parseValue(raw: string): string | string[] | boolean {
  const v = raw.trim();
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v.startsWith('[') && v.endsWith(']')) {
    return v
      .slice(1, -1)
      .split(',')
      .map((s) => s.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean);
  }
  return v.replace(/^["']|["']$/g, '');
}

export function stripFrontmatter(text: string) {
  const m = text.match(FM_RE);
  return m ? text.slice(m[0].length) : text;
}

export function parseFrontmatter(text: string): Record<string, string | string[] | boolean> {
  const m = text.match(FM_RE);
  if (!m) return {};
  const out: Record<string, string | string[] | boolean> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1);
    if (!key) continue;
    out[key] = parseValue(val);
  }
  return out;
}

export function excerptOf(body: string, len = 90) {
  // 列表和摘要给普通用户看，先把 Markdown 记号去掉，只留读得懂的正文
  const plain = body
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<\/?[a-zA-Z][^>]*>/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/^\s{0,3}([-*+]|\d+[.)])\s+/gm, '')
    .replace(/^\s*\[[ xX]\]\s+/gm, '')
    // 表格：对齐行整行丢掉，其余行把竖线换成空格，列表摘要里就不会出现一堆 |
    .replace(/^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/gm, ' ')
    .replace(/^\s*\|(.*)\|\s*$/gm, (_line, cells: string) => ` ${cells.replace(/\|/g, ' ')} `)
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s*([-*_])\1{2,}\s*$/gm, ' ')
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.length > len ? plain.slice(0, len) + '…' : plain;
}

export function wordCount(body: string) {
  const text = stripFrontmatter(body)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<\/?[a-zA-Z][^>]*>/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/[#>*_`~]/g, '');
  const cjk = (text.match(/[一-龥]/g) || []).length;
  const words = (text.replace(/[一-龥]/g, ' ').match(/[A-Za-z0-9]+/g) || []).length;
  return cjk + words;
}

export function parseNote(path: string, raw: string): Note {
  const fm = parseFrontmatter(raw);
  const content = stripFrontmatter(raw);
  let notebook = path
    .replace(/^notes\//, '')
    .split('/')
    .slice(0, -1)
    .join('/');
  if (path.startsWith('.trash/') && typeof fm.notebook === 'string' && fm.notebook) {
    notebook = fm.notebook;
  }
  const fileName = path.split('/').pop() || '';
  const titleFromFile = fileName.replace(/\.md$/, '');
  const created = typeof fm.created === 'string' ? fm.created : new Date().toISOString();
  const updated = typeof fm.updated === 'string' ? fm.updated : created;
  return {
    id: typeof fm.id === 'string' && fm.id ? fm.id : uuid(),
    title: typeof fm.title === 'string' && fm.title ? fm.title : titleFromFile,
    notebook,
    path,
    tags: Array.isArray(fm.tags) ? fm.tags : [],
    created,
    updated,
    pinned: fm.pinned === true,
    deletedAt: typeof fm.deletedAt === 'string' ? fm.deletedAt : undefined,
    size: raw.length,
    excerpt: excerptOf(content),
    content,
  };
}

export function buildFile(note: Note) {
  const meta: string[] = [
    '---',
    `id: ${note.id}`,
    `title: ${note.title.replace(/\n/g, ' ')}`,
    `created: ${note.created}`,
    `updated: ${note.updated}`,
  ];
  if (note.tags.length) meta.push(`tags: [${note.tags.join(', ')}]`);
  if (note.pinned) meta.push('pinned: true');
  if (note.deletedAt) {
    meta.push(`notebook: ${note.notebook}`);
    meta.push(`deletedAt: ${note.deletedAt}`);
  }
  meta.push('---', '');
  return meta.join('\n') + note.content.replace(/^\n+/, '');
}

export function newNote(notebook: string, title = t('未命名笔记')): Note {
  const now = new Date().toISOString();
  return {
    id: uuid(),
    title,
    notebook,
    path: '',
    tags: [],
    created: now,
    updated: now,
    pinned: false,
    size: 0,
    excerpt: '',
    content: '',
  };
}

export function safeFileName(title: string) {
  const cleaned = title
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
  return (cleaned || t('未命名-{date}', { date: dateKey() })).slice(0, 80);
}

export function extractLinks(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)) {
    const t = m[1].trim();
    if (t) out.push(t);
  }
  return [...new Set(out)];
}
