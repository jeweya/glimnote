import { buildFile, extractLinks, newNote, safeFileName, stripFrontmatter, type Note } from './markdown';
import { dailyTitleOf, dateKey, weekKey } from './utils';
import { buildTaskFile, newTask, taskPathOf, type Task } from './tasks';
import { getLang, t } from './i18n';
import { buildIdeaFile, ideaStamp, ideaTitle, newIdea, type Idea } from './ideas';
import {
  NOTES,
  ROOT,
  TRASH,
  TRASH_TASKS,
  TEMPLATES,
  exists,
  fs,
  readText,
  removePath,
  scanIdeas,
  scanNotebookDirs,
  scanNotes,
  scanTasks,
  scanTrash,
  walk,
  writeNote,
  writeText,
  ensureDir,
} from './storage';

export async function loadNotes() {
  jitter();
  return scanNotes();
}

export async function loadTrash() {
  return scanTrash();
}

/** notes/ 下真实存在的文件夹（包括已经空的），用来让侧栏保留空笔记本 */
export async function loadNotebookDirs() {
  return scanNotebookDirs();
}

function jitter() {
  /* 占位：真实磁盘读取无需抖动 */
}

export async function uniquePath(notebook: string, title: string, ignorePath?: string) {
  const dir = notebook ? `${NOTES}/${notebook}` : NOTES;
  const base = safeFileName(title);
  let candidate = `${dir}/${base}.md`;
  let i = 2;
  while (candidate !== ignorePath && (await exists(candidate))) {
    candidate = `${dir}/${base} (${i}).md`;
    i += 1;
  }
  return candidate.replace(`${ROOT}/`, '');
}

/** 日记 / 周报的默认标题：省得每次新建都要自己敲日期 */
function defaultTitleOf(notebook: string) {
  const name = notebook.split('/').pop() || '';
  if (name === '日记') return dateKey();
  if (name === '周报') return weekKey();
  return '';
}

export async function createNote(notebook: string, title?: string): Promise<Note> {
  const note = newNote(notebook, title || defaultTitleOf(notebook) || t('未命名笔记'));
  note.path = await uniquePath(notebook, note.title);
  await writeNote(note);
  return note;
}

export async function saveNote(note: Note) {
  note.updated = new Date().toISOString();
  note.size = note.content.length;
  note.path = await uniquePath(note.notebook, note.title, `${ROOT}/${note.path}`);
  if (note.path.startsWith('notes/')) {
    await writeNote(note);
  }
}

export async function renameNoteFile(note: Note, oldPath: string) {
  const newPath = await uniquePath(note.notebook, note.title, `${ROOT}/${oldPath}`);
  if (newPath === oldPath) {
    await writeNote(note);
    return oldPath;
  }
  note.updated = new Date().toISOString();
  note.path = newPath;
  await writeNote(note);
  try {
    await removePath(`${ROOT}/${oldPath}`);
  } catch {
    /* ignore */
  }
  return newPath;
}

export async function deleteNote(note: Note) {
  const dayDir = `${TRASH}/${dateKey()}`;
  await ensureDir(dayDir);
  const fileName = `${safeFileName(note.title)}-${note.id.slice(0, 6)}.md`;
  const target = `${dayDir}/${fileName}`;
  note.deletedAt = new Date().toISOString();
  await writeNoteAt(target, note);
  try {
    await removePath(`${ROOT}/${note.path}`);
  } catch {
    /* ignore */
  }
  return target.replace(`${ROOT}/`, '');
}

async function writeNoteAt(absPath: string, note: Note) {
  await writeText(absPath, buildFile(note));
}

export async function restoreNote(note: Note) {
  const rawNotebook = note.notebook || '';
  const notebook = rawNotebook.startsWith('.trash') || /^\d{4}-\d{2}-\d{2}$/.test(rawNotebook) ? 'inbox' : rawNotebook;
  const restored: Note = {
    ...note,
    notebook,
    deletedAt: undefined,
    path: await uniquePath(notebook || 'inbox', note.title),
  };
  await writeNote(restored);
  try {
    await removePath(`${ROOT}/${note.path}`);
  } catch {
    /* ignore */
  }
  return restored;
}

/** 回收站保留 30 天；超期文件在启动时清理，避免越积越多 */
export async function purgeExpiredTrash(days = 30) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const notes = await scanTrash();
  for (const n of notes) {
    const t = n.deletedAt ? Date.parse(n.deletedAt) : NaN;
    if (Number.isFinite(t) && t < cutoff) {
      try {
        await purgeNote(n);
      } catch {
        /* ignore */
      }
    }
  }
}

export async function purgeNote(note: Note) {
  await removePath(`${ROOT}/${note.path}`);
}

export async function emptyTrash() {
  // 只清笔记回收站；任务回收站由 emptyTaskTrash() 单独清理
  const files = (await walk(TRASH)).filter((f) => !f.startsWith(`${TRASH_TASKS}/`));
  for (const f of files) await removePath(f);
}

/* ---------------- 任务库（docs/11 方案 C） ---------------- */

/** 冲突副本会带着同一个 id；后加载的派生 id，避免列表 key 打架 */
function dedupeTaskIds(tasks: Task[]) {
  const seen = new Map<string, number>();
  return tasks.map((task) => {
    const n = seen.get(task.id) || 0;
    seen.set(task.id, n + 1);
    if (n === 0) return task;
    return { ...task, id: `${task.id}c${n}`, conflict: true };
  });
}

export async function loadTasks() {
  return dedupeTaskIds(await scanTasks());
}

export async function loadTaskTrash() {
  return dedupeTaskIds(await scanTasks(TRASH_TASKS));
}

export async function createTask(title: string, patch: Partial<Task> = {}): Promise<Task> {
  const base = newTask(title);
  const task: Task = {
    ...base,
    ...patch,
    id: base.id,
    created: base.created,
    path: taskPathOf(base.created, base.id),
  };
  task.updated = new Date().toISOString();
  await writeTask(task);
  return task;
}

/** 写入单个任务文件；path 是运行时真源（冲突副本不按 id 重算路径） */
export async function writeTask(task: Task) {
  task.size = buildTaskFile(task).length;
  await writeText(`${ROOT}/${task.path}`, buildTaskFile(task));
}

export async function saveTask(task: Task) {
  task.updated = new Date().toISOString();
  await writeTask(task);
}

export async function deleteTask(task: Task) {
  const dayDir = `${TRASH_TASKS}/${dateKey()}`;
  await ensureDir(dayDir);
  let target = `${dayDir}/${task.id}.md`;
  let i = 2;
  while (await exists(target)) {
    target = `${dayDir}/${task.id}-${i}.md`;
    i += 1;
  }
  task.deletedAt = new Date().toISOString();
  task.deletedFrom = task.path;
  await writeText(target, buildTaskFile(task));
  try {
    await removePath(`${ROOT}/${task.path}`);
  } catch {
    /* ignore */
  }
  return target.replace(`${ROOT}/`, '');
}

/** 从回收站恢复：优先回到 deletedFrom，其次按 created + id 推导 */
export async function restoreTask(task: Task) {
  const target = task.deletedFrom || taskPathOf(task.created, task.id);
  let path = target;
  if (await exists(`${ROOT}/${path}`)) {
    const stem = path.replace(/\.md$/, '');
    let i = 2;
    while (await exists(`${ROOT}/${stem}-${i}.md`)) i += 1;
    path = `${stem}-${i}.md`;
  }
  const restored: Task = { ...task, deletedAt: undefined, deletedFrom: undefined, path };
  restored.updated = new Date().toISOString();
  await writeTask(restored);
  try {
    await removePath(`${ROOT}/${task.path}`);
  } catch {
    /* ignore */
  }
  return restored;
}

export async function purgeTask(task: Task) {
  await removePath(`${ROOT}/${task.path}`);
}

export async function emptyTaskTrash() {
  let entries: any[] = [];
  try {
    entries = (await fs.promises.readdir(TRASH_TASKS)) as any[];
  } catch {
    return;
  }
  for (const entry of entries) {
    const name = typeof entry === 'string' ? entry : entry.name;
    if (!name || name.startsWith('.')) continue;
    try {
      await removePath(`${TRASH_TASKS}/${name}`);
    } catch {
      /* ignore */
    }
  }
}

/** 任务回收站同样保留 30 天 */
export async function purgeExpiredTaskTrash(days = 30) {
  const cutoff = Date.now() - days * 86400000;
  const tasks = await loadTaskTrash();
  for (const task of tasks) {
    const t = task.deletedAt ? Date.parse(task.deletedAt) : NaN;
    if (Number.isFinite(t) && t < cutoff) {
      try {
        await purgeTask(task);
      } catch {
        /* ignore */
      }
    }
  }
}

/* ---------------- 灵感库（docs/14） ---------------- */

export async function loadIdeas() {
  return scanIdeas();
}

export async function writeIdea(idea: Idea) {
  const content = buildIdeaFile(idea);
  idea.size = content.length;
  await writeText(`${ROOT}/${idea.path}`, content);
}

export async function createIdea(text: string): Promise<Idea> {
  const idea = newIdea(text);
  await writeIdea(idea);
  return idea;
}

export async function saveIdea(idea: Idea) {
  idea.updated = new Date().toISOString();
  await writeIdea(idea);
}

export async function deleteIdea(idea: Idea) {
  await removePath(`${ROOT}/${idea.path}`);
}

/** 撤销删除：按原路径写回，同 id 的文件不会撞名 */
export async function restoreIdea(idea: Idea) {
  await writeIdea(idea);
}

/** 多条灵感合并成一篇笔记时的时间线正文 */
function mergedIdeaBody(list: Idea[]) {
  const now = new Date();
  const out: string[] = [];
  for (const idea of list) {
    const [first, ...rest] = idea.text.split('\n');
    out.push(`- ${ideaStamp(idea.created, now)} · ${first.trim()}`);
    for (const line of rest) out.push(line.trim() ? `  ${line}` : '');
    out.push('');
  }
  return out.join('\n').trimEnd() + '\n';
}

/** 整理成一篇笔记：一条灵感就是它自己，多条合并成「灵感整理 · M月D日」 */
export async function noteFromIdeas(ideas: Idea[]): Promise<Note> {
  const list = [...ideas].sort((a, b) => +new Date(a.created) - +new Date(b.created));
  const now = new Date();
  const title =
    list.length === 1
      ? ideaTitle(list[0].text, 40) || t('灵感')
      : t('灵感整理 · {date}', {
          date:
            getLang() === 'en'
              ? now.toLocaleString('en-US', { month: 'short', day: 'numeric' })
              : `${now.getMonth() + 1}月${now.getDate()}日`,
        });
  const note = newNote('inbox', title);
  note.content = list.length === 1 ? `${list[0].text}\n` : mergedIdeaBody(list);
  note.path = await uniquePath('inbox', title);
  await writeNote(note);
  return note;
}

/** 整理成待办：一条灵感一条，落在「待整理」，日期留到之后决定 */
export async function tasksFromIdeas(ideas: Idea[]): Promise<Task[]> {
  const out: Task[] = [];
  for (const idea of [...ideas].sort((a, b) => +new Date(a.created) - +new Date(b.created))) {
    const title = ideaTitle(idea.text, 80) || t('未命名灵感');
    const body = idea.text.trim();
    const task = await createTask(title, { status: 'inbox', notes: body === title ? '' : body });
    out.push(task);
  }
  return out;
}

/** 找到（或新建）指定日期的日记；不传日期即今天 */
export async function ensureDailyNote(key = dateKey()): Promise<Note> {
  const title = key;
  const notes = await scanNotes();
  const found = notes.find((n) => n.notebook === '日记' && n.title === title);
  if (found) return found;
  const note = newNote('日记', title);
  note.path = await uniquePath('日记', title);
  note.content = `# ${dailyTitleOf(title)}\n\n`;
  note.tags = ['日记'];
  await writeNote(note);
  return note;
}

export async function listTemplates() {
  const files = await walk(TEMPLATES);
  const out: { name: string; content: string }[] = [];
  for (const f of files) {
    out.push({ name: f.split('/').pop()!.replace(/\.md$/, ''), content: await readText(f) });
  }
  return out;
}

export function renderTemplate(text: string, title: string) {
  const now = new Date();
  const week = Math.ceil(((now.getTime() - new Date(now.getFullYear(), 0, 1).getTime()) / 86400000 + 1) / 7);
  return text
    .replaceAll('{{title}}', title)
    .replaceAll(
      '{{date}}',
      `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`,
    )
    .replaceAll('{{time}}', `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`)
    .replaceAll('{{weekday}}', ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][now.getDay()])
    .replaceAll('{{week}}', String(week));
}

export interface NotebookNode {
  path: string;
  name: string;
  count: number;
  children: NotebookNode[];
}

export function buildNotebookTree(notes: Note[]): NotebookNode[] {
  const root: NotebookNode = { path: '', name: '全部笔记', count: 0, children: [] };
  for (const n of notes) {
    const segs = n.notebook ? n.notebook.split('/').filter(Boolean) : [];
    let node = root;
    node.count += 1;
    for (const seg of segs) {
      let child = node.children.find((c) => c.name === seg);
      if (!child) {
        child = {
          path: node.path ? `${node.path}/${seg}` : seg,
          name: seg,
          count: 0,
          children: [],
        };
        node.children.push(child);
      }
      child.count += 1;
      node = child;
    }
  }
  const sort = (nodes: NotebookNode[]) => {
    nodes.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
    nodes.forEach((n) => sort(n.children));
  };
  sort(root.children);
  return root.children;
}

export function getBacklinks(notes: Note[], note: Note) {
  const title = note.title;
  return notes.filter((n) => n.id !== note.id && extractLinks(n.content).some((l) => l === title));
}

export async function importText(name: string, text: string, notebook: string) {
  const h1 = text.match(/^#\s+(.+)$/m);
  const title = (h1 ? h1[1] : name.replace(/\.md$/i, '')).trim().slice(0, 80) || '导入的笔记';
  const note = newNote(notebook || 'inbox', title);
  note.content = stripFrontmatter(text).replace(/^#\s+.+\n+/, '');
  note.path = await uniquePath(note.notebook, note.title);
  await writeNote(note);
  return note;
}

export async function duplicateNote(note: Note): Promise<Note> {
  const copy: Note = {
    ...note,
    id: crypto.randomUUID(),
    title: `${note.title} 副本`,
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
    pinned: false,
    deletedAt: undefined,
  };
  copy.path = await uniquePath(copy.notebook, copy.title);
  await writeNote(copy);
  return copy;
}

export async function moveNote(note: Note, notebook: string): Promise<Note> {
  const oldPath = note.path;
  const moved: Note = { ...note, notebook, updated: new Date().toISOString() };
  moved.path = await uniquePath(notebook, note.title, `${ROOT}/${oldPath}`);
  await writeNote(moved);
  if (moved.path !== oldPath) {
    try {
      await removePath(`${ROOT}/${oldPath}`);
    } catch {
      /* ignore */
    }
  }
  return moved;
}

/**
 * 改名 / 移动文件夹。
 *
 * newPath 是完整的「父/新名字」，逐段清洗后保留层级：以前把整条路径里的 `/` 都换成
 * `-`，于是「工作/增值项目」改成「增值」会写成「工作-增值」，看起来像跑到了顶层；
 * 现在只替换前缀，后面的层级原样保留。
 */
export async function renameNotebook(oldPath: string, newPath: string, notes: Note[]) {
  const clean = newPath
    .split('/')
    .map((seg) => seg.trim().replace(/[\\/:*?"<>|]/g, '-'))
    .filter(Boolean)
    .join('/');
  if (!clean || clean === oldPath) return 0;
  const affected = notes.filter((n) => n.notebook === oldPath || n.notebook.startsWith(`${oldPath}/`));
  for (const n of affected) {
    const next = clean + n.notebook.slice(oldPath.length);
    await moveNote(n, next);
  }
  // 笔记搬走后原目录会空着；只删掉确实为空的目录，里面有东西就保持原样
  await removeEmptyFolders(`${NOTES}/${oldPath}`);
  return affected.length;
}

/** 显式删除笔记本后清掉磁盘上的空目录，避免下次扫描又把它显示回来 */
export async function removeNotebookDir(notebook: string) {
  if (!notebook) return;
  await removeEmptyFolders(`${NOTES}/${notebook}`);
}

async function removeEmptyFolders(dir: string) {
  let cur = dir;
  while (cur.startsWith(`${NOTES}/`)) {
    try {
      const entries = (await fs.promises.readdir(cur)) as unknown[];
      if (entries.length) return;
      await fs.promises.rmdir(cur);
    } catch {
      return;
    }
    cur = cur.slice(0, cur.lastIndexOf('/'));
  }
}

export { NOTES };
