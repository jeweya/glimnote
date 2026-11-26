/**
 * 仓库读写层：笔记 notes/、待办 tasks/、灵感 ideas/、回收站 .trash/，
 * 以及 AI 小应用 apps/、首页入口 home/、本机应用历史与系统入口 .glimnote/。
 * 所有路径都限制在仓库根目录内；写入采用「同目录临时文件 + rename」，
 * 避免桌面端读到半截文件。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { StoreError } from './errors.mjs';
import { createAppStore } from './appstore.mjs';
import { createNotebookMap } from './notebooks.mjs';
import {
  buildIdeaFile,
  buildNoteFile,
  buildTaskFile,
  cleanCategory,
  cleanIdeaText,
  cleanTitle,
  countWords,
  dailyTitleOf,
  dateKey,
  ideaStamp,
  ideaTitle,
  IDEA_MAX,
  newId,
  newIdea,
  newNote,
  newTask,
  normalizeStatus,
  OPEN_STATUSES,
  parseDateKey,
  parseIdea,
  parseNote,
  parseTask,
  PRIORITIES,
  safeFileName,
  TASK_STATUSES,
  taskPathOf,
} from './md.mjs';

export { StoreError } from './errors.mjs';

const NOTES_DIR = 'notes';
const TASKS_DIR = 'tasks';
const IDEAS_DIR = 'ideas';
const TRASH_DIR = '.trash';
const TRASH_TASKS_DIR = '.trash/tasks';
const MAX_FILES = 20000;
const MAX_CONTENT = 4 * 1024 * 1024;

function normRel(p) {
  return String(p || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
}

function inside(root, full) {
  const rel = path.relative(root, full);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function createStore(rootInput) {
  const root = path.resolve(rootInput);
  const abs = (rel) => path.resolve(root, normRel(rel));
  // 显示笔记本名 ↔ 物理 ID 目录；与桌面端共用 .glimnote/notebooks.json
  const notebooks = createNotebookMap(root);

  function assertRel(rel, kind = 'any') {
    const clean = normRel(rel);
    if (!clean) throw new StoreError('路径不能为空', 'BAD_PATH');
    if (clean.split('/').some((seg) => seg === '..' || seg === '.')) {
      throw new StoreError('路径不合法：不允许 . 或 ..', 'BAD_PATH');
    }
    const full = abs(clean);
    if (!inside(root, full)) throw new StoreError('路径超出笔记仓库范围', 'BAD_PATH');
    const isApp = clean.startsWith('apps/') || clean.startsWith('.glimnote/history/apps/');
    const isHome =
      clean === 'home/home.json' ||
      clean.startsWith('home/groups/') ||
      clean.startsWith('home/entries/') ||
      clean.startsWith('.glimnote/local/home/');
    const allowed =
      kind === 'note'
        ? clean.startsWith(`${NOTES_DIR}/`) ||
          (clean.startsWith(`${TRASH_DIR}/`) && !clean.startsWith(`${TRASH_TASKS_DIR}/`))
        : kind === 'task'
          ? clean.startsWith(`${TASKS_DIR}/`) || clean.startsWith(`${TRASH_TASKS_DIR}/`)
          : kind === 'idea'
            ? clean.startsWith(`${IDEAS_DIR}/`)
            : kind === 'app'
              ? isApp
              : kind === 'home'
                ? isHome
                : clean.startsWith(`${NOTES_DIR}/`) ||
                  clean.startsWith(`${TASKS_DIR}/`) ||
                  clean.startsWith(`${IDEAS_DIR}/`) ||
                  clean.startsWith(`${TRASH_DIR}/`) ||
                  isApp ||
                  isHome;
    if (!allowed) {
      throw new StoreError(
        `只能操作 notes/、tasks/、ideas/、apps/、home/、.trash/ 与本机 .glimnote/ 数据（收到 ${clean}）`,
        'BAD_PATH',
      );
    }
    return { rel: clean, full };
  }

  async function exists(full) {
    try {
      await fs.access(full);
      return true;
    } catch {
      return false;
    }
  }

  async function ensureDir(full) {
    await fs.mkdir(full, { recursive: true });
  }

  async function readText(full) {
    return fs.readFile(full, 'utf8');
  }

  async function writeAtomic(full, text) {
    await ensureDir(path.dirname(full));
    const tmp = path.join(
      path.dirname(full),
      `.${path.basename(full)}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`,
    );
    await fs.writeFile(tmp, text, 'utf8');
    try {
      await fs.rename(tmp, full);
    } catch (e) {
      // Windows 下杀软/索引器短暂占用目标文件时，稍等再试一次
      if (['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) {
        await new Promise((r) => setTimeout(r, 80));
        try {
          await fs.rename(tmp, full);
          return;
        } catch {
          /* fall through */
        }
      }
      await fs.rm(tmp, { force: true }).catch(() => {});
      throw e;
    }
  }

  async function removeFile(full) {
    await fs.rm(full, { force: true });
  }

  async function pruneEmpty(dir, stopAt) {
    let cur = dir;
    while (cur.startsWith(root) && cur !== stopAt && cur !== root) {
      let entries = [];
      try {
        entries = await fs.readdir(cur);
      } catch {
        return;
      }
      if (entries.length) return;
      try {
        await fs.rmdir(cur);
      } catch {
        return;
      }
      cur = path.dirname(cur);
    }
  }

  async function walkMd(dirRel) {
    const out = [];
    const top = abs(dirRel);
    async function walk(full) {
      if (out.length >= MAX_FILES) return;
      let entries = [];
      try {
        entries = await fs.readdir(full, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        const child = path.join(full, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) await walk(child);
        else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
          if (inside(root, child)) out.push(path.relative(root, child).replace(/\\/g, '/'));
        }
        if (out.length >= MAX_FILES) return;
      }
    }
    await walk(top);
    return out.sort();
  }

  async function mtimeIso(full) {
    try {
      const st = await fs.stat(full);
      return st.mtime.toISOString();
    } catch {
      return new Date().toISOString();
    }
  }

  /* ---------------- 输入清洗 ---------------- */

  function cleanNotebook(input) {
    const raw = String(input ?? '').trim();
    if (!raw) return '';
    const segs = raw
      .replace(/\\/g, '/')
      .split('/')
      .map((s) =>
        s
          .trim()
          .replace(/[:*?"<>|]/g, '-')
          .slice(0, 40),
      )
      .filter((s) => s && s !== '.' && s !== '..');
    return segs.join('/').slice(0, 160);
  }

  function cleanTags(input) {
    if (input == null) return [];
    const list = Array.isArray(input) ? input : String(input).split(/[,，\s]+/);
    const seen = new Set();
    const out = [];
    for (const item of list) {
      const tag = String(item).trim().replace(/^#/, '').replace(/[,\]]/g, ' ').trim().slice(0, 20);
      if (!tag || seen.has(tag)) continue;
      seen.add(tag);
      out.push(tag);
      if (out.length >= 50) break;
    }
    return out;
  }

  function cleanContent(input) {
    const text = String(input ?? '');
    if (text.length > MAX_CONTENT) throw new StoreError('正文超过 4 MB，MCP 不支持写入超大文件', 'TOO_LARGE');
    return text;
  }

  function cleanDue(input) {
    if (input === null || input === undefined || input === '') return undefined;
    const value = String(input).trim();
    if (!parseDateKey(value)) throw new StoreError(`截止日期格式应为 YYYY-MM-DD（收到 ${value}）`, 'BAD_DATE');
    return value;
  }

  /** 到点提醒时间 HH:mm；null / 空串表示清空 */
  function cleanDueTime(input) {
    if (input === null || input === undefined || input === '') return undefined;
    const value = String(input).trim();
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
      throw new StoreError(`提醒时间格式应为 HH:mm（收到 ${value}）`, 'BAD_TIME');
    }
    return value;
  }

  function cleanStatus(input) {
    if (input === undefined) return undefined;
    if (!TASK_STATUSES.includes(input)) {
      throw new StoreError(`状态只能是 inbox / todo / doing / done（收到 ${input}）`, 'BAD_STATUS');
    }
    return input;
  }

  function cleanPriority(input) {
    if (input === undefined) return undefined;
    if (!PRIORITIES.includes(input)) throw new StoreError('优先级只能是 high / normal / low', 'BAD_PRIORITY');
    return input;
  }

  /* ---------------- 笔记 ---------------- */

  async function uniqueNotePath(notebook, title, ignoreRel) {
    const physical = notebook ? await notebooks.physicalDir(notebook) : '';
    const dir = physical ? `${NOTES_DIR}/${physical}` : NOTES_DIR;
    const base = safeFileName(title);
    let candidate = `${dir}/${base}.md`;
    let i = 2;
    while (candidate !== ignoreRel && (await exists(abs(candidate)))) {
      candidate = `${dir}/${base} (${i}).md`;
      i += 1;
    }
    return candidate;
  }

  async function writeNote(note) {
    const { full } = assertRel(note.path, 'note');
    note.size = buildNoteFile(note).length;
    await writeAtomic(full, buildNoteFile(note));
  }

  async function scanNotes() {
    const files = await walkMd(NOTES_DIR);
    const out = [];
    for (const rel of files) {
      try {
        out.push(parseNote(rel, await readText(abs(rel))));
      } catch {
        /* 单个坏文件不影响整体 */
      }
    }
    // path 保持物理路径；notebook 换成映射表里的显示名，免得侧栏 / AI 看到一串 nb-xxxx
    return notebooks.translateNotes(out);
  }

  async function scanNoteTrash() {
    const files = (await walkMd(TRASH_DIR)).filter((f) => !f.startsWith(`${TRASH_TASKS_DIR}/`));
    const out = [];
    for (const rel of files) {
      try {
        out.push(parseNote(rel, await readText(abs(rel))));
      } catch {
        /* skip */
      }
    }
    return out;
  }

  function matchLocator(list, locator) {
    const id = locator.id ? String(locator.id).trim() : '';
    const rawPath = locator.path ? normRel(locator.path) : '';
    const title = locator.title ? theTitle(locator.title) : '';
    if (id) {
      const hits = list.filter((n) => n.id === id);
      if (hits.length === 1) return hits[0];
      if (hits.length > 1) {
        throw new StoreError(`id ${id} 对应多个文件：${hits.map((n) => n.path).join('、')}，请改用 path`, 'AMBIGUOUS');
      }
      return null;
    }
    if (rawPath) {
      const candidates = new Set([rawPath, `${NOTES_DIR}/${rawPath}`, `${TRASH_DIR}/${rawPath}`]);
      const hit = list.find((n) => candidates.has(n.path));
      if (hit) return hit;
      return null;
    }
    if (title) {
      const hits = list.filter((n) => theTitle(n.title) === title);
      if (hits.length === 1) return hits[0];
      if (hits.length > 1) {
        throw new StoreError(
          `标题「${title}」有 ${hits.length} 篇，请改用 id 或 path：${hits.map((n) => n.path).join('、')}`,
          'AMBIGUOUS',
        );
      }
    }
    return null;
  }

  function theTitle(v) {
    return String(v || '').trim();
  }

  async function findNote(locator = {}, opts = {}) {
    if (locator && locator.path && normRel(locator.path).split('/').includes('..')) {
      throw new StoreError('路径不合法：不允许 ..', 'BAD_PATH');
    }
    if (!locator || (!locator.id && !locator.path && !locator.title)) {
      throw new StoreError('需要提供 id、path 或 title 之一来定位笔记', 'MISSING_LOCATOR');
    }
    const list = opts.trash ? await scanNoteTrash() : await scanNotes();
    const hit = matchLocator(list, locator);
    if (!hit) {
      const where = opts.trash ? '回收站' : '笔记库';
      throw new StoreError(`${where}中找不到这篇笔记（id/path/title 都没匹配上）`, 'NOT_FOUND');
    }
    return hit;
  }

  async function createNote(input = {}) {
    const title = (cleanTitle(input.title) || `未命名笔记 ${dateKey()}`).slice(0, 200);
    const notebook = cleanNotebook(input.notebook);
    const note = newNote(notebook, title, cleanContent(input.content));
    note.tags = cleanTags(input.tags);
    note.pinned = Boolean(input.pinned);
    note.path = await uniqueNotePath(notebook, title);
    await writeNote(note);
    return note;
  }

  async function updateNote(locator, patch = {}) {
    const note = await findNote(locator);
    const oldPath = note.path;
    const nextTitle = patch.title !== undefined ? cleanTitle(patch.title).slice(0, 200) : note.title;
    if (!nextTitle) throw new StoreError('标题不能为空', 'BAD_TITLE');
    const nextNotebook = patch.notebook !== undefined ? cleanNotebook(patch.notebook) : note.notebook;
    if (patch.content !== undefined) note.content = cleanContent(patch.content);
    if (patch.tags !== undefined) note.tags = cleanTags(patch.tags);
    if (patch.pinned !== undefined) note.pinned = Boolean(patch.pinned);
    note.title = nextTitle;
    note.notebook = nextNotebook;
    note.updated = new Date().toISOString();
    note.deletedAt = undefined;
    note.path = await uniqueNotePath(nextNotebook, nextTitle, oldPath);
    await writeNote(note);
    if (note.path !== oldPath) {
      await removeFile(abs(oldPath));
      // 不清理空的旧笔记本目录：旧式可读目录靠它留在映射表里，
      // 也是侧栏「空笔记本」的依据；ID 目录留着同样没有副作用。
    }
    return note;
  }

  async function appendNote(locator, text, separator = '\n\n') {
    const note = await findNote(locator);
    const addition = cleanContent(text);
    if (!addition) throw new StoreError('要追加的内容不能为空', 'EMPTY_CONTENT');
    const sep = String(separator ?? '\n\n');
    const base = note.content.replace(/\s+$/, '');
    note.content = base ? `${base}${sep}${addition}` : addition;
    note.updated = new Date().toISOString();
    await writeNote(note);
    return note;
  }

  async function duplicateNote(locator, input = {}) {
    const source = await findNote(locator);
    const title = cleanTitle(input.title) || `${source.title} 副本`;
    const notebook = input.notebook !== undefined ? cleanNotebook(input.notebook) : source.notebook;
    const copy = {
      ...source,
      id: newId(),
      title,
      notebook,
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
      pinned: false,
      deletedAt: undefined,
      path: '',
    };
    copy.path = await uniqueNotePath(notebook, title);
    await writeNote(copy);
    return copy;
  }

  async function deleteNoteSafe(locator) {
    const note = await findNote(locator);
    const original = note.path;
    const dayDir = `${TRASH_DIR}/${dateKey()}`;
    const stem = `${safeFileName(note.title)}-${note.id.slice(0, 6)}`;
    let rel = `${dayDir}/${stem}.md`;
    let i = 2;
    while (await exists(abs(rel))) {
      rel = `${dayDir}/${stem}-${i}.md`;
      i += 1;
    }
    note.deletedAt = new Date().toISOString();
    note.path = rel;
    await writeNote(note);
    await removeFile(abs(original));
    // 保留空目录（理由同上）：删掉最后一篇笔记不等于删掉笔记本
    return note;
  }

  async function restoreNote(trashPath) {
    const note = await findNote({ path: trashPath }, { trash: true });
    const raw = cleanNotebook(note.notebook);
    const notebook = raw.startsWith('.trash') || /^\d{4}-\d{2}-\d{2}$/.test(raw) ? 'inbox' : raw;
    const oldPath = note.path;
    note.notebook = notebook;
    note.deletedAt = undefined;
    note.updated = new Date().toISOString();
    note.path = await uniqueNotePath(notebook, note.title);
    await writeNote(note);
    await removeFile(abs(oldPath));
    await pruneEmpty(path.dirname(abs(oldPath)), abs(TRASH_DIR));
    return note;
  }

  async function purgeNote(trashPath) {
    const note = await findNote({ path: trashPath }, { trash: true });
    await removeFile(abs(note.path));
    await pruneEmpty(path.dirname(abs(note.path)), abs(TRASH_DIR));
    return note;
  }

  async function emptyNoteTrash() {
    const files = (await walkMd(TRASH_DIR)).filter((f) => !f.startsWith(`${TRASH_TASKS_DIR}/`));
    for (const rel of files) {
      await removeFile(abs(rel));
      await pruneEmpty(path.dirname(abs(rel)), abs(TRASH_DIR));
    }
    return files.length;
  }

  async function listNotebooks() {
    const notes = await scanNotes();
    const map = new Map();
    // 空笔记本也列出来：映射表知道它存在，但 notes 里没有对应文件
    for (const name of await notebooks.list()) {
      map.set(name, { name, label: name || '（根目录）', count: 0, total: 0 });
    }
    for (const note of notes) {
      const name = note.notebook || '';
      const item = map.get(name) || { name, label: name || '（根目录）', count: 0, total: 0 };
      item.count += 1;
      map.set(name, item);
    }
    const list = [...map.values()];
    for (const item of list) {
      item.total = item.name
        ? notes.filter((n) => n.notebook === item.name || n.notebook.startsWith(`${item.name}/`)).length
        : item.count;
    }
    return list.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  }

  async function listTags() {
    const notes = await scanNotes();
    const map = new Map();
    for (const note of notes) {
      for (const tag of note.tags) map.set(tag, (map.get(tag) || 0) + 1);
    }
    return [...map.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, 'zh'));
  }

  function scoreNote(note, q) {
    const lower = q.toLowerCase();
    let score = 0;
    if (note.title.toLowerCase().includes(lower)) score += 6;
    if (note.tags.some((t) => t.toLowerCase().includes(lower))) score += 4;
    const body = note.content.toLowerCase();
    const idx = body.indexOf(lower);
    if (idx >= 0) {
      score += 2;
      let from = 0;
      let hits = 0;
      while (hits < 6) {
        const at = body.indexOf(lower, from);
        if (at < 0) break;
        hits += 1;
        from = at + lower.length;
      }
      score += hits * 0.3;
    }
    if (!score) return null;
    let snippet = note.excerpt;
    if (idx >= 0) {
      const start = Math.max(0, idx - 40);
      snippet = `${start > 0 ? '…' : ''}${note.content.slice(start, idx + q.length + 60).replace(/\s+/g, ' ')}${idx + q.length + 60 < note.content.length ? '…' : ''}`;
    }
    return { score: Math.round(score * 10) / 10, snippet };
  }

  /* ---------------- 待办 ---------------- */

  async function scanTasks() {
    const files = await walkMd(TASKS_DIR);
    const out = [];
    for (const rel of files) {
      try {
        out.push(parseTask(rel, await readText(abs(rel)), await mtimeIso(abs(rel))));
      } catch {
        /* skip */
      }
    }
    return out;
  }

  async function scanTaskTrash() {
    const files = await walkMd(TRASH_TASKS_DIR);
    const out = [];
    for (const rel of files) {
      try {
        out.push(parseTask(rel, await readText(abs(rel)), await mtimeIso(abs(rel))));
      } catch {
        /* skip */
      }
    }
    return out;
  }

  async function writeTask(task) {
    const { full } = assertRel(task.path, 'task');
    task.size = buildTaskFile(task).length;
    await writeAtomic(full, buildTaskFile(task));
  }

  function matchTaskLocator(list, locator = {}) {
    if (!locator || (!locator.id && !locator.path)) {
      throw new StoreError('需要提供 id 或 path 来定位待办', 'MISSING_LOCATOR');
    }
    if (locator.id) {
      const hits = list.filter((t) => t.id === String(locator.id).trim());
      if (hits.length === 1) return hits[0];
      if (hits.length > 1) {
        throw new StoreError(
          `id ${locator.id} 对应多个任务文件：${hits.map((t) => t.path).join('、')}，请改用 path`,
          'AMBIGUOUS',
        );
      }
      return null;
    }
    const p = normRel(locator.path);
    return (
      list.find((t) => t.path === p || t.path === `${TASKS_DIR}/${p}` || t.path === `${TRASH_TASKS_DIR}/${p}`) || null
    );
  }

  async function findTask(locator, opts = {}) {
    if (locator && locator.path && normRel(locator.path).split('/').includes('..')) {
      throw new StoreError('路径不合法：不允许 ..', 'BAD_PATH');
    }
    const list = opts.trash ? await scanTaskTrash() : await scanTasks();
    const hit = matchTaskLocator(list, locator);
    if (!hit) throw new StoreError(opts.trash ? '任务回收站中找不到该任务' : '任务库中找不到该任务', 'NOT_FOUND');
    return hit;
  }

  async function createTask(input = {}) {
    const title = cleanTitle(input.title).slice(0, 200);
    if (!title) throw new StoreError('待办标题不能为空', 'BAD_TITLE');
    const due = cleanDue(input.due);
    const priority = cleanPriority(input.priority) || 'normal';
    const requested = cleanStatus(input.status) || (due ? 'todo' : 'inbox');
    const status = normalizeStatus(requested, due);
    const task = newTask(title);
    task.status = status;
    task.due = status === 'inbox' ? undefined : due;
    task.dueTime = task.due ? cleanDueTime(input.dueTime) : undefined;
    task.priority = priority;
    const category = cleanCategory(input.category);
    if (category) task.category = category;
    task.tags = cleanTags(input.tags);
    task.notes = cleanContent(input.notes);
    if (input.noteId) task.noteId = String(input.noteId).trim();
    if (input.noteTitle) task.noteTitle = cleanTitle(input.noteTitle);
    if (status === 'done') {
      task.doneAt = new Date().toISOString();
      task.prevStatus = 'todo';
    }
    await writeTask(task);
    return task;
  }

  async function updateTask(locator, patch = {}) {
    const task = await findTask(locator);
    const prevStatus = task.status;
    if (patch.title !== undefined) {
      const title = cleanTitle(patch.title).slice(0, 200);
      if (!title) throw new StoreError('待办标题不能为空', 'BAD_TITLE');
      task.title = title;
    }
    if (patch.due !== undefined) task.due = cleanDue(patch.due);
    if (patch.dueTime !== undefined) task.dueTime = cleanDueTime(patch.dueTime);
    if (patch.priority !== undefined) task.priority = cleanPriority(patch.priority);
    if (patch.category !== undefined) task.category = cleanCategory(patch.category) || undefined;
    if (patch.tags !== undefined) task.tags = cleanTags(patch.tags);
    if (patch.notes !== undefined) task.notes = cleanContent(patch.notes);
    if (patch.noteId !== undefined) task.noteId = patch.noteId ? String(patch.noteId).trim() : undefined;
    if (patch.noteTitle !== undefined) task.noteTitle = patch.noteTitle ? cleanTitle(patch.noteTitle) : undefined;

    if (patch.status !== undefined) {
      const next = cleanStatus(patch.status);
      if (next === 'inbox') {
        task.due = undefined;
        task.dueTime = undefined;
        task.status = 'inbox';
        task.doneAt = undefined;
        task.prevStatus = undefined;
      } else if (next === 'done') {
        task.status = 'done';
        task.doneAt = new Date().toISOString();
        if (prevStatus !== 'done') task.prevStatus = prevStatus;
      } else {
        task.status = next;
        task.doneAt = undefined;
        task.prevStatus = undefined;
      }
    } else if (task.status === 'inbox' && task.due) {
      task.status = 'todo';
    }
    if (task.status === 'done' && !task.prevStatus) task.prevStatus = prevStatus === 'done' ? 'todo' : prevStatus;
    // 日期没了，提醒时间也不该留着
    if (!task.due) task.dueTime = undefined;
    task.updated = new Date().toISOString();
    await writeTask(task);
    return task;
  }

  async function completeTask(locator) {
    return updateTask(locator, { status: 'done' });
  }

  async function reopenTask(locator) {
    const task = await findTask(locator);
    const status = OPEN_STATUSES.includes(task.prevStatus) ? task.prevStatus : 'todo';
    task.status = status;
    task.doneAt = undefined;
    task.prevStatus = undefined;
    task.updated = new Date().toISOString();
    await writeTask(task);
    return task;
  }

  async function appendTaskNote(locator, text, separator = '\n\n') {
    const task = await findTask(locator);
    const addition = cleanContent(text);
    if (!addition) throw new StoreError('要追加的内容不能为空', 'EMPTY_CONTENT');
    const sep = String(separator ?? '\n\n');
    const base = task.notes.replace(/\s+$/, '');
    task.notes = base ? `${base}${sep}${addition}` : addition;
    task.updated = new Date().toISOString();
    await writeTask(task);
    return task;
  }

  async function deleteTask(locator) {
    const task = await findTask(locator);
    const original = task.path;
    const dayDir = `${TRASH_TASKS_DIR}/${dateKey()}`;
    let rel = `${dayDir}/${task.id}.md`;
    let i = 2;
    while (await exists(abs(rel))) {
      rel = `${dayDir}/${task.id}-${i}.md`;
      i += 1;
    }
    task.deletedAt = new Date().toISOString();
    task.deletedFrom = original;
    task.path = rel;
    await writeTask(task);
    await removeFile(abs(original));
    await pruneEmpty(path.dirname(abs(original)), abs(TASKS_DIR));
    return task;
  }

  async function restoreTask(trashPath) {
    const task = await findTask({ path: trashPath }, { trash: true });
    const original = task.path;
    let rel = task.deletedFrom || taskPathOf(task.created, task.id);
    try {
      const { rel: checked } = assertRel(rel, 'task');
      if (checked.startsWith(`${TRASH_TASKS_DIR}/`)) rel = taskPathOf(task.created, task.id);
    } catch {
      rel = taskPathOf(task.created, task.id);
    }
    if (await exists(abs(rel))) {
      const stem = rel.replace(/\.md$/, '');
      let i = 2;
      while (await exists(abs(`${stem}-${i}.md`))) i += 1;
      rel = `${stem}-${i}.md`;
    }
    task.path = rel;
    task.deletedAt = undefined;
    task.deletedFrom = undefined;
    task.updated = new Date().toISOString();
    await writeTask(task);
    await removeFile(abs(original));
    await pruneEmpty(path.dirname(abs(original)), abs(TRASH_TASKS_DIR));
    return task;
  }

  async function purgeTask(trashPath) {
    const task = await findTask({ path: trashPath }, { trash: true });
    await removeFile(abs(task.path));
    await pruneEmpty(path.dirname(abs(task.path)), abs(TRASH_TASKS_DIR));
    return task;
  }

  async function emptyTaskTrash() {
    const files = await walkMd(TRASH_TASKS_DIR);
    for (const rel of files) {
      await removeFile(abs(rel));
      await pruneEmpty(path.dirname(abs(rel)), abs(TRASH_TASKS_DIR));
    }
    return files.length;
  }

  /* ---------------- 灵感（docs/14） ---------------- */

  async function scanIdeas() {
    const files = await walkMd(IDEAS_DIR);
    const out = [];
    for (const rel of files) {
      try {
        out.push(parseIdea(rel, await readText(abs(rel)), await mtimeIso(abs(rel))));
      } catch {
        /* 单个坏文件不影响整个库 */
      }
    }
    return out;
  }

  function matchIdeaLocator(list, locator = {}) {
    if (!locator || (!locator.id && !locator.path)) {
      throw new StoreError('需要提供 id 或 path 来定位灵感', 'MISSING_LOCATOR');
    }
    if (locator.id) {
      const hits = list.filter((i) => i.id === String(locator.id).trim());
      if (hits.length === 1) return hits[0];
      if (hits.length > 1) {
        throw new StoreError(
          `id ${locator.id} 对应多条灵感：${hits.map((i) => i.path).join('、')}，请改用 path`,
          'AMBIGUOUS',
        );
      }
      return null;
    }
    const p = normRel(locator.path);
    return list.find((i) => i.path === p || i.path === `${IDEAS_DIR}/${p}`) || null;
  }

  async function findIdea(locator) {
    if (locator && locator.path && normRel(locator.path).split('/').includes('..')) {
      throw new StoreError('路径不合法：不允许 ..', 'BAD_PATH');
    }
    const hit = matchIdeaLocator(await scanIdeas(), locator);
    if (!hit) throw new StoreError('灵感库中找不到这条灵感（id/path 都没匹配上）', 'NOT_FOUND');
    return hit;
  }

  function cleanIdeaBody(input) {
    const raw = String(input ?? '');
    if (raw.length > IDEA_MAX) throw new StoreError(`单条灵感最多 ${IDEA_MAX} 字（收到 ${raw.length} 字）`, 'TOO_LONG');
    const text = cleanIdeaText(raw);
    if (!text) throw new StoreError('灵感内容不能为空', 'EMPTY_CONTENT');
    return text;
  }

  async function writeIdea(idea) {
    const { full } = assertRel(idea.path, 'idea');
    const content = buildIdeaFile(idea);
    idea.size = content.length;
    await writeAtomic(full, content);
  }

  async function createIdea(input = {}) {
    const idea = newIdea(cleanIdeaBody(input.text));
    await writeIdea(idea);
    return idea;
  }

  async function updateIdea(locator, text) {
    const idea = await findIdea(locator);
    if (idea.convertedType) {
      throw new StoreError('这条灵感已经整理成笔记/待办，原文只读；请直接修改对应的成品', 'IDEA_CONVERTED');
    }
    idea.text = cleanIdeaBody(text);
    idea.updated = new Date().toISOString();
    await writeIdea(idea);
    return idea;
  }

  async function deleteIdea(locator) {
    const idea = await findIdea(locator);
    await removeFile(abs(idea.path));
    await pruneEmpty(path.dirname(abs(idea.path)), abs(IDEAS_DIR));
    return idea;
  }

  /** 多条灵感合并成一篇笔记时的时间线正文，与界面 repo.ts 保持一致 */
  function mergedIdeaBody(list) {
    const now = new Date();
    const out = [];
    for (const idea of list) {
      const [first, ...rest] = idea.text.split('\n');
      out.push(`- ${ideaStamp(idea.created, now)} · ${first.trim()}`);
      for (const line of rest) out.push(line.trim() ? `  ${line}` : '');
      out.push('');
    }
    return `${out.join('\n').trimEnd()}\n`;
  }

  /** 整理灵感：note = 合并成一篇笔记，task = 一条灵感一条待办；原文保留并回写转化信息 */
  async function convertIdeas(locators, target) {
    if (target !== 'note' && target !== 'task') {
      throw new StoreError('target 只能是 note 或 task', 'BAD_TARGET');
    }
    if (!Array.isArray(locators) || !locators.length) {
      throw new StoreError('至少选择一条灵感', 'MISSING_LOCATOR');
    }
    const all = await scanIdeas();
    const picked = [];
    const seen = new Set();
    for (const locator of locators) {
      const hit = matchIdeaLocator(all, locator);
      if (!hit) throw new StoreError('灵感库中找不到这条灵感（id/path 都没匹配上）', 'NOT_FOUND');
      if (hit.convertedType) {
        throw new StoreError(`「${ideaTitle(hit.text, 20) || hit.id}」已经整理过，不能重复转化`, 'IDEA_CONVERTED');
      }
      if (seen.has(hit.path)) continue;
      seen.add(hit.path);
      picked.push(hit);
    }
    picked.sort((a, b) => +new Date(a.created) - +new Date(b.created));

    const now = new Date();
    let note;
    let tasks = [];
    if (target === 'note') {
      const title =
        picked.length === 1
          ? ideaTitle(picked[0].text, 40) || '灵感'
          : `灵感整理 · ${now.getMonth() + 1}月${now.getDate()}日`;
      note = await createNote({
        title,
        notebook: 'inbox',
        content: picked.length === 1 ? `${picked[0].text}\n` : mergedIdeaBody(picked),
      });
    } else {
      for (const idea of picked) {
        const title = ideaTitle(idea.text, 80) || '未命名灵感';
        const body = idea.text.trim();
        tasks.push(await createTask({ title, status: 'inbox', notes: body === title ? '' : body }));
      }
    }

    const convertedAt = new Date().toISOString();
    const converted = [];
    for (let i = 0; i < picked.length; i += 1) {
      const idea = picked[i];
      const product = target === 'note' ? note : tasks[i];
      idea.convertedType = target;
      idea.convertedId = product.id;
      idea.convertedTitle = product.title;
      idea.convertedAt = convertedAt;
      idea.updated = convertedAt;
      await writeIdea(idea);
      converted.push(idea);
    }
    return { target, note, tasks, converted };
  }

  /* ---------------- 每日日记（F-A03） ---------------- */

  async function findDailyNote(key = dateKey()) {
    const notes = await scanNotes();
    return notes.find((n) => n.notebook === '日记' && n.title === key) || null;
  }

  async function createDailyNote(key = dateKey()) {
    if (!parseDateKey(key)) throw new StoreError(`日期格式应为 YYYY-MM-DD（收到 ${key}）`, 'BAD_DATE');
    return createNote({
      title: key,
      notebook: '日记',
      content: `# ${dailyTitleOf(key)}\n\n`,
      tags: ['日记'],
    });
  }

  async function appendDailyNote(key, text, separator = '\n\n') {
    const addition = cleanContent(text);
    if (!String(addition || '').trim()) throw new StoreError('要追加的内容不能为空', 'EMPTY_CONTENT');
    let note = await findDailyNote(key);
    const created = !note;
    if (!note) note = await createDailyNote(key);
    note = await appendNote({ path: note.path }, addition, separator);
    return { note, created };
  }

  /* ---------------- 应用与首页 ---------------- */

  const appStore = createAppStore({
    root,
    abs,
    assertRel,
    exists,
    ensureDir,
    readText,
    writeAtomic,
    findNote,
    scanNotes,
  });

  /* ---------------- 仓库信息与统计 ---------------- */

  async function repoInfo() {
    const notes = await scanNotes();
    const trash = await scanNoteTrash();
    const tasks = await scanTasks();
    const taskTrash = await scanTaskTrash();
    const ideas = await scanIdeas();
    const appList = await appStore.listApps();
    let home = { groups: 0, entries: 0 };
    try {
      home = await appStore.homeCounts();
    } catch {
      /* 首页坏文件不影响仓库概况 */
    }
    const notebooks = new Set(notes.map((n) => n.notebook).filter(Boolean));
    const tags = new Set(notes.flatMap((n) => n.tags));
    return {
      root,
      initialized: await exists(abs('.glimnote/repo.json')),
      git: await exists(abs('.git')),
      notes: notes.length,
      notebooks: notebooks.size,
      tags: tags.size,
      trash: trash.length,
      tasks: tasks.length,
      openTasks: tasks.filter((t) => t.status !== 'done' && !t.deletedAt).length,
      taskTrash: taskTrash.length,
      ideas: ideas.length,
      openIdeas: ideas.filter((i) => !i.convertedType).length,
      apps: appList.length,
      appDataBytes: appList.reduce((sum, app) => sum + (app.dataBytes || 0), 0),
      homeGroups: home.groups,
      homeEntries: home.entries,
    };
  }

  /** 写作统计：与 src/lib/stats.ts 同一套口径，按笔记最后修改日归属 */
  async function repoStats() {
    const notes = await scanNotes();
    const tasks = await scanTasks();
    const ideas = await scanIdeas();
    const appList = await appListSafe();

    const perDay = new Map();
    let totalWords = 0;
    for (const note of notes) {
      const words = countWords(note.content);
      totalWords += words;
      const at = new Date(note.updated);
      if (Number.isNaN(at.getTime())) continue;
      const key = dateKey(at);
      const item = perDay.get(key) || { words: 0, notes: 0 };
      item.words += words;
      item.notes += 1;
      perDay.set(key, item);
    }

    const today = new Date();
    const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const daily = [];
    let weekWords = 0;
    let weekNotes = 0;
    let weekDays = 0;
    for (let i = 6; i >= 0; i -= 1) {
      const d = startOfDay(today);
      d.setDate(d.getDate() - i);
      const key = dateKey(d);
      const hit = perDay.get(key);
      if (hit) {
        weekDays += 1;
        weekWords += hit.words;
        weekNotes += hit.notes;
      }
      daily.push({
        key,
        label: `${d.getMonth() + 1}/${d.getDate()}`,
        words: hit ? hit.words : 0,
        notes: hit ? hit.notes : 0,
      });
    }

    let streak = 0;
    const cursor = startOfDay(today);
    if (!perDay.has(dateKey(cursor))) cursor.setDate(cursor.getDate() - 1);
    while (perDay.has(dateKey(cursor))) {
      streak += 1;
      cursor.setDate(cursor.getDate() - 1);
    }

    const todayKey = dateKey(today);
    return {
      notes: notes.length,
      totalWords,
      tasks: {
        total: tasks.length,
        open: tasks.filter((t) => t.status !== 'done').length,
        done: tasks.filter((t) => t.status === 'done').length,
        overdue: tasks.filter((t) => t.status !== 'done' && t.due && t.due < todayKey).length,
        today: tasks.filter((t) => t.status !== 'done' && t.due === todayKey).length,
      },
      ideas: { total: ideas.length, open: ideas.filter((i) => !i.convertedType).length },
      apps: { total: appList.length },
      writing: { weekDays, weekWords, weekNotes, streak, totalWords, totalNotes: notes.length, daily },
    };
  }

  async function appListSafe() {
    try {
      return await appStore.listApps();
    } catch {
      return [];
    }
  }

  return {
    root,
    repoInfo,
    scanNotes,
    scanNoteTrash,
    findNote,
    createNote,
    updateNote,
    appendNote,
    duplicateNote,
    deleteNote: deleteNoteSafe,
    restoreNote,
    purgeNote,
    emptyNoteTrash,
    listNotebooks,
    listTags,
    scoreNote,
    scanTasks,
    scanTaskTrash,
    findTask,
    createTask,
    updateTask,
    completeTask,
    reopenTask,
    appendTaskNote,
    deleteTask,
    restoreTask,
    purgeTask,
    emptyTaskTrash,
    scanIdeas,
    findIdea,
    createIdea,
    updateIdea,
    deleteIdea,
    convertIdeas,
    findDailyNote,
    createDailyNote,
    appendDailyNote,
    repoStats,
    ...appStore,
  };
}

export { NOTES_DIR, TASKS_DIR, IDEAS_DIR, TRASH_DIR, TRASH_TASKS_DIR };
