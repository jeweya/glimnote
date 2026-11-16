/**
 * Markdown 解析与序列化：与 src/lib/markdown.ts、src/lib/tasks.ts 保持同一套规则。
 * 这里只依赖 Node 内置能力，不引入任何第三方包。
 */

const FM_RE = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function stripFrontmatter(text) {
  const m = text.match(FM_RE);
  return m ? text.slice(m[0].length) : text;
}

function parseValue(raw) {
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

export function parseFrontmatter(text) {
  const m = text.match(FM_RE);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    if (!key) continue;
    out[key] = parseValue(line.slice(idx + 1));
  }
  return out;
}

export function pad(n) {
  return n < 10 ? `0${n}` : String(n);
}

export function dateKey(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function parseDateKey(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || '').trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return dateKey(d) === m[0] ? d : null;
}

export function newId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(bytes);
  else for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function safeFileName(title, fallback = `未命名-${dateKey()}`) {
  const cleaned = String(title || '')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
  return (cleaned || fallback).slice(0, 80);
}

export function cleanTitle(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 分类名：与桌面端 cleanCategoryName 保持一致（16 字上限、去掉方括号与换行） */
export function cleanCategory(value) {
  return String(value || '')
    .replace(/[\[\]\n\r]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 16);
}

export function excerptOf(body, len = 90) {
  const plain = String(body || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<\/?[a-zA-Z][^>]*>/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/^\s{0,3}([-*+]|\d+[.)])\s+/gm, '')
    .replace(/^\s*\[[ xX]\]\s+/gm, '')
    .replace(/^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/gm, ' ')
    .replace(/^\s*\|(.*)\|\s*$/gm, (_line, cells) => ` ${String(cells).replace(/\|/g, ' ')} `)
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s*([-*_])\1{2,}\s*$/gm, ' ')
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.length > len ? `${plain.slice(0, len)}…` : plain;
}

/** 与桌面端 wordCount 同一套规则：中文按字、英文数字按词 */
export function countWords(body) {
  const text = stripFrontmatter(String(body || ''))
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<\/?[a-zA-Z][^>]*>/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/[#>*_`~]/g, '');
  const cjk = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
  const words = (text.replace(/[\u4e00-\u9fa5]/g, ' ').match(/[A-Za-z0-9]+/g) || []).length;
  return cjk + words;
}

/* ---------------- 笔记 ---------------- */

export function parseNote(relPath, raw) {
  const fm = parseFrontmatter(raw);
  const content = stripFrontmatter(raw);
  const path = relPath.replace(/\\/g, '/');
  let notebook = path
    .replace(/^notes\//, '')
    .split('/')
    .slice(0, -1)
    .join('/');
  if (path.startsWith('.trash/') && typeof fm.notebook === 'string' && fm.notebook) notebook = fm.notebook;
  const fileName = path.split('/').pop() || '';
  const titleFromFile = fileName.replace(/\.md$/, '');
  const created = typeof fm.created === 'string' ? fm.created : new Date().toISOString();
  const updated = typeof fm.updated === 'string' ? fm.updated : created;
  return {
    id: typeof fm.id === 'string' && fm.id ? fm.id : newId(),
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

export function buildNoteFile(note) {
  const meta = [
    '---',
    `id: ${note.id}`,
    `title: ${String(note.title).replace(/\n/g, ' ')}`,
    `created: ${note.created}`,
    `updated: ${note.updated}`,
  ];
  if (note.tags && note.tags.length) meta.push(`tags: [${note.tags.join(', ')}]`);
  if (note.pinned) meta.push('pinned: true');
  if (note.deletedAt) {
    meta.push(`notebook: ${note.notebook}`);
    meta.push(`deletedAt: ${note.deletedAt}`);
  }
  meta.push('---', '');
  return `${meta.join('\n')}${String(note.content || '').replace(/^\n+/, '')}`;
}

export function newNote(notebook, title, content = '') {
  const now = new Date().toISOString();
  return {
    id: newId(),
    title,
    notebook,
    path: '',
    tags: [],
    created: now,
    updated: now,
    pinned: false,
    deletedAt: undefined,
    size: 0,
    excerpt: '',
    content,
  };
}

/* ---------------- 灵感（docs/14） ---------------- */

/** 单条灵感的上限：记的是念头，不是文章 */
export const IDEA_MAX = 2000;

/** 12 位 base36：前 8 位时间前缀 + 4 位随机，与待办同一套规则 */
export function newIdeaId() {
  return newTaskId();
}

export function ideaDirOf(created) {
  const d = new Date(created);
  const date = Number.isNaN(d.getTime()) ? new Date() : d;
  return `ideas/${date.getFullYear()}/${pad(date.getMonth() + 1)}`;
}

export function ideaPathOf(created, id) {
  return `${ideaDirOf(created)}/${id}.md`;
}

/** 去掉首尾空行与行尾空格；最多 2000 字，换行原样保留 */
export function cleanIdeaText(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/^\n+/, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()
    .slice(0, IDEA_MAX);
}

/** 第一行有效文字（去掉 Markdown 记号），用来当笔记 / 待办的标题 */
export function ideaFirstLine(text) {
  const line = String(text || '')
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean);
  if (!line) return '';
  return line
    .replace(/^#{1,6}\s+/, '')
    .replace(/^[-*+]\s+(\[[ xX]\]\s+)?/, '')
    .replace(/^>\s?/, '')
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function ideaTitle(text, len = 40) {
  const line = ideaFirstLine(text);
  if (!line) return '';
  return line.length > len ? `${line.slice(0, len)}…` : line;
}

/** 合并笔记里用的短时间戳：今天只写时分，跨天补月日 */
export function ideaStamp(iso, now = new Date()) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.toDateString() === now.toDateString()) return time;
  return `${d.getMonth() + 1}/${d.getDate()} ${time}`;
}

export function parseIdea(relPath, raw, fallbackTime = new Date().toISOString()) {
  const fm = parseFrontmatter(raw);
  const body = cleanIdeaText(stripFrontmatter(raw));
  const path = relPath.replace(/\\/g, '/');
  const fileName = (path.split('/').pop() || '').replace(/\.md$/, '');
  const created = typeof fm.created === 'string' && fm.created ? fm.created : fallbackTime;
  const updated = typeof fm.updated === 'string' && fm.updated ? fm.updated : created;
  const kind = fm.convertedType === 'note' || fm.convertedType === 'task' ? fm.convertedType : undefined;
  return {
    id: typeof fm.id === 'string' && fm.id.trim() ? fm.id.trim() : fileName,
    text: body,
    created,
    updated,
    convertedType: kind,
    convertedId: kind && typeof fm.convertedId === 'string' && fm.convertedId ? fm.convertedId : undefined,
    convertedTitle: kind && typeof fm.convertedTitle === 'string' && fm.convertedTitle ? fm.convertedTitle : undefined,
    convertedAt: kind && typeof fm.convertedAt === 'string' && fm.convertedAt ? fm.convertedAt : undefined,
    path,
    size: raw.length,
  };
}

export function buildIdeaFile(idea) {
  const meta = ['---', `id: ${idea.id}`, `created: ${idea.created}`, `updated: ${idea.updated}`];
  if (idea.convertedType) {
    meta.push(`convertedType: ${idea.convertedType}`);
    if (idea.convertedId) meta.push(`convertedId: ${idea.convertedId}`);
    if (idea.convertedTitle) meta.push(`convertedTitle: ${cleanIdeaText(idea.convertedTitle).replace(/\n/g, ' ')}`);
    if (idea.convertedAt) meta.push(`convertedAt: ${idea.convertedAt}`);
  }
  meta.push('---', '');
  return meta.join('\n') + cleanIdeaText(idea.text);
}

export function newIdea(text, created = new Date().toISOString()) {
  const id = newIdeaId();
  return {
    id,
    text: cleanIdeaText(text),
    created,
    updated: created,
    path: ideaPathOf(created, id),
    size: 0,
  };
}

/* ---------------- 日记 ---------------- */

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** `2026-10-30` → `10月30日 周五`；与界面侧 dailyTitleOf 一致 */
export function dailyTitleOf(key) {
  const d = parseDateKey(key);
  if (!d) return String(key || '');
  return `${d.getMonth() + 1}月${d.getDate()}日 ${WEEKDAYS[d.getDay()]}`;
}

/* ---------------- 待办 ---------------- */

export const OPEN_STATUSES = ['inbox', 'todo', 'doing'];
export const TASK_STATUSES = ['inbox', 'todo', 'doing', 'done'];
export const PRIORITIES = ['high', 'normal', 'low'];
export const STATUS_LABEL = { inbox: '待整理', todo: '待办', doing: '跟进中', done: '已完成' };
export const PRIORITY_LABEL = { high: '高', normal: '普通', low: '低' };

export function normalizeStatus(status, due) {
  if (status === 'done') return 'done';
  if (status === 'inbox') return due ? 'todo' : 'inbox';
  return status;
}

const ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

export function newTaskId() {
  const time = Date.now().toString(36).padStart(8, '0').slice(-8);
  let rand = '';
  for (let i = 0; i < 4; i += 1) rand += ID_ALPHABET[Math.floor(Math.random() * 36)];
  return `${time}${rand}`;
}

export function taskDirOf(created) {
  const d = new Date(created);
  const date = Number.isNaN(d.getTime()) ? new Date() : d;
  return `tasks/${date.getFullYear()}/${pad(date.getMonth() + 1)}`;
}

export function taskPathOf(created, id) {
  return `${taskDirOf(created)}/${id}.md`;
}

function titleFromBody(body) {
  const line = String(body || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find(Boolean);
  if (!line) return '';
  return cleanTitle(line.replace(/^#{1,6}\s+/, '').replace(/^[-*+]\s+(\[[ xX]\]\s+)?/, ''));
}

export function parseTask(relPath, raw, fallbackTime = new Date().toISOString()) {
  const fm = parseFrontmatter(raw);
  const body = stripFrontmatter(raw);
  const path = relPath.replace(/\\/g, '/');
  const fileName = (path.split('/').pop() || '').replace(/\.md$/, '');
  const id = typeof fm.id === 'string' && fm.id.trim() ? fm.id.trim() : fileName;
  const rawTitle = typeof fm.title === 'string' ? cleanTitle(fm.title) : '';
  const created = typeof fm.created === 'string' && fm.created ? fm.created : fallbackTime;
  const updated = typeof fm.updated === 'string' && fm.updated ? fm.updated : created;
  const due = typeof fm.due === 'string' && parseDateKey(fm.due) ? fm.due.slice(0, 10) : undefined;
  const rawTime = typeof fm.dueTime === 'string' ? fm.dueTime.trim() : '';
  const dueTime = due && /^([01]\d|2[0-3]):[0-5]\d$/.test(rawTime) ? rawTime : undefined;
  const priority = PRIORITIES.includes(fm.priority) ? fm.priority : 'normal';
  const category = cleanCategory(fm.category) || undefined;
  const rawStatus = TASK_STATUSES.includes(fm.status) ? fm.status : 'todo';
  const prevStatus = OPEN_STATUSES.includes(fm.prevStatus) ? fm.prevStatus : undefined;
  return {
    id,
    title: rawTitle || titleFromBody(body),
    status: normalizeStatus(rawStatus, due),
    due,
    dueTime,
    priority,
    category,
    tags: Array.isArray(fm.tags) ? fm.tags.map((t) => String(t).trim()).filter(Boolean) : [],
    noteId: typeof fm.noteId === 'string' && fm.noteId ? fm.noteId : undefined,
    noteTitle: typeof fm.noteTitle === 'string' && fm.noteTitle ? fm.noteTitle : undefined,
    created,
    updated,
    doneAt: typeof fm.doneAt === 'string' && fm.doneAt ? fm.doneAt : undefined,
    prevStatus,
    deletedAt: typeof fm.deletedAt === 'string' && fm.deletedAt ? fm.deletedAt : undefined,
    deletedFrom: typeof fm.deletedFrom === 'string' && fm.deletedFrom ? fm.deletedFrom : undefined,
    notes: body.replace(/^\n+/, ''),
    path,
    size: raw.length,
  };
}

export function buildTaskFile(task) {
  const meta = [
    '---',
    `id: ${task.id}`,
    `title: ${cleanTitle(task.title).replace(/\n/g, ' ')}`,
    `status: ${task.status}`,
  ];
  if (task.due) meta.push(`due: ${task.due}`);
  if (task.due && task.dueTime) meta.push(`dueTime: ${task.dueTime}`);
  meta.push(`priority: ${task.priority}`);
  const category = cleanCategory(task.category);
  if (category) meta.push(`category: ${category}`);
  if (task.tags && task.tags.length)
    meta.push(`tags: [${task.tags.map((t) => String(t).replace(/[,\]]/g, ' ')).join(', ')}]`);
  if (task.noteId) meta.push(`noteId: ${task.noteId}`);
  if (task.noteTitle) meta.push(`noteTitle: ${cleanTitle(task.noteTitle).replace(/\n/g, ' ')}`);
  meta.push(`created: ${task.created}`, `updated: ${task.updated}`);
  if (task.doneAt) meta.push(`doneAt: ${task.doneAt}`);
  if (task.status === 'done' && task.prevStatus) meta.push(`prevStatus: ${task.prevStatus}`);
  if (task.deletedAt) meta.push(`deletedAt: ${task.deletedAt}`);
  if (task.deletedFrom) meta.push(`deletedFrom: ${task.deletedFrom}`);
  meta.push('---', '');
  return `${meta.join('\n')}${String(task.notes || '').replace(/^\n+/, '')}`;
}

export function newTask(title = '') {
  const now = new Date().toISOString();
  const id = newTaskId();
  return {
    id,
    title: cleanTitle(title),
    status: 'inbox',
    priority: 'normal',
    tags: [],
    created: now,
    updated: now,
    notes: '',
    path: taskPathOf(now, id),
    size: 0,
  };
}

export function isTaskConflict(task) {
  return /（冲突副本）|\(冲突副本/.test(task.path);
}
