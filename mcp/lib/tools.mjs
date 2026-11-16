/**
 * MCP 工具定义与实现：只做参数校验与结果整形，文件操作全部交给 store。
 */

import { dailyTitleOf, dateKey, ideaTitle, parseDateKey, PRIORITY_LABEL, STATUS_LABEL } from './md.mjs';
import { APP_COLORS, HOME_COLORS, HOME_ICON_KEYS } from './appstore.mjs';

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const DESTROY = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };

const str = (description) => ({ type: 'string', description });
const bool = (description) => ({ type: 'boolean', description });
const int = (description, min = 1, max = 500) => ({ type: 'integer', description, minimum: min, maximum: max });
const tagsSchema = { type: 'array', items: { type: 'string' }, description: '标签列表；传空数组表示清空' };
const locatorProps = {
  id: str('笔记 id（frontmatter 里的 id，优先级最高）'),
  path: str('仓库内相对路径，如 notes/工作/周报.md（可省略 notes/ 前缀）'),
  title: str('笔记标题（仅唯一时可用；重名会返回候选）'),
};

function cleanArgs(args) {
  return args && typeof args === 'object' && !Array.isArray(args) ? args : {};
}

function asString(v, fallback = '') {
  return v === undefined || v === null ? fallback : String(v);
}

function asLimit(v, fallback, max = 200) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(1, Math.round(n)));
}

function noteSummary(note) {
  return {
    id: note.id,
    title: note.title,
    notebook: note.notebook,
    path: note.path,
    tags: note.tags,
    pinned: note.pinned,
    created: note.created,
    updated: note.updated,
    deletedAt: note.deletedAt,
    size: note.size,
    excerpt: note.excerpt,
  };
}

function noteFull(note) {
  return { ...noteSummary(note), content: note.content };
}

function daysUntil(due) {
  const d = parseDateKey(due);
  if (!d) return null;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((d.getTime() - today.getTime()) / 86400000);
}

function dueLabel(due) {
  if (!due) return '无日期';
  const diff = daysUntil(due);
  if (diff === null) return '无日期';
  if (diff < 0) return `已过期 ${-diff} 天`;
  if (diff === 0) return '今天';
  if (diff === 1) return '明天';
  if (diff === 2) return '后天';
  const d = parseDateKey(due);
  if (d.getFullYear() === new Date().getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
  return due;
}

function taskSummary(t) {
  const diff = t.due ? daysUntil(t.due) : null;
  return {
    id: t.id,
    title: t.title,
    status: t.status,
    statusLabel: STATUS_LABEL[t.status] || t.status,
    due: t.due,
    dueTime: t.dueTime,
    dueLabel: dueLabel(t.due) + (t.dueTime ? ` ${t.dueTime}` : ''),
    daysUntil: diff,
    overdue: t.status !== 'done' && diff !== null && diff < 0,
    priority: t.priority,
    priorityLabel: PRIORITY_LABEL[t.priority] || t.priority,
    category: t.category,
    tags: t.tags,
    noteId: t.noteId,
    noteTitle: t.noteTitle,
    created: t.created,
    updated: t.updated,
    doneAt: t.doneAt,
    prevStatus: t.prevStatus,
    path: t.path,
    excerpt: t.notes.replace(/\s+/g, ' ').slice(0, 90),
  };
}

function taskFull(t) {
  return { ...taskSummary(t), notes: t.notes };
}

function ideaSummary(idea) {
  return {
    id: idea.id,
    text: idea.text,
    title: ideaTitle(idea.text, 40),
    open: !idea.convertedType,
    convertedType: idea.convertedType,
    convertedId: idea.convertedId,
    convertedTitle: idea.convertedTitle,
    convertedAt: idea.convertedAt,
    created: idea.created,
    updated: idea.updated,
    path: idea.path,
    size: idea.size,
  };
}

function locatorOf(args) {
  return { id: args.id, path: args.path, title: args.title };
}

function priorityRank(p) {
  return p === 'high' ? 0 : p === 'low' ? 2 : 1;
}

function matchNoteQuery(note, q) {
  if (!q) return true;
  const needle = q.toLowerCase();
  return (
    note.title.toLowerCase().includes(needle) ||
    note.content.toLowerCase().includes(needle) ||
    note.tags.some((t) => t.toLowerCase().includes(needle))
  );
}

function inNotebook(note, notebook, includeSub) {
  if (!notebook) return true;
  const target = notebook.replace(/\/+$/, '');
  return note.notebook === target || (includeSub && note.notebook.startsWith(`${target}/`));
}

const TOOLS = [
  {
    name: 'repo_info',
    title: '仓库概况',
    description:
      '查看萤光笔记仓库根目录、笔记/笔记本/标签/待办/灵感/小应用/首页入口数量，以及是否已初始化、是否有 Git 仓库。回答「我有多少笔记/待办/应用」时先调用它。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: READ,
    handler: async (_args, store) => store.repoInfo(),
  },
  {
    name: 'list_notebooks',
    title: '列出笔记本',
    description:
      '列出所有笔记本及各自的直接笔记数、含子笔记本的总数。笔记本由笔记路径自动派生，没有笔记的空文件夹不会出现。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: READ,
    handler: async (_args, store) => {
      const notebooks = await store.listNotebooks();
      return { count: notebooks.length, notebooks };
    },
  },
  {
    name: 'list_tags',
    title: '列出标签',
    description: '列出全部笔记标签及出现次数，按次数降序。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: READ,
    handler: async (_args, store) => {
      const tags = await store.listTags();
      return { count: tags.length, tags };
    },
  },
  {
    name: 'list_notes',
    title: '列出笔记',
    description:
      '分页列出笔记（不含全文，只有摘要）。可按笔记本（默认含子笔记本）、标签、关键词、是否置顶筛选。想读全文请用 get_note，想按内容搜索请用 search_notes。',
    inputSchema: {
      type: 'object',
      properties: {
        notebook: str('笔记本路径，如 工作 或 工作/项目A；不传则全部'),
        includeSubnotebooks: bool('是否包含子笔记本，默认 true'),
        tag: str('按标签精确筛选'),
        query: str('关键词（匹配标题、正文、标签）'),
        pinned: bool('只看置顶笔记'),
        sort: { type: 'string', enum: ['updated', 'created', 'title'], description: '排序字段，默认 updated' },
        limit: int('返回条数，默认 30', 1, 200),
        offset: int('跳过条数，默认 0', 0, 100000),
      },
      additionalProperties: false,
    },
    annotations: READ,
    handler: async (args, store) => {
      const a = cleanArgs(args);
      const all = await store.scanNotes();
      let list = all.filter(
        (n) =>
          inNotebook(n, a.notebook, a.includeSubnotebooks !== false) &&
          (!a.tag || n.tags.includes(a.tag)) &&
          (a.pinned === undefined || n.pinned === Boolean(a.pinned)) &&
          matchNoteQuery(n, asString(a.query).trim()),
      );
      const sort = a.sort === 'created' ? 'created' : a.sort === 'title' ? 'title' : 'updated';
      list = list.sort((x, y) =>
        sort === 'title' ? x.title.localeCompare(y.title, 'zh') : +new Date(y[sort] || 0) - +new Date(x[sort] || 0),
      );
      const offset = Math.max(0, Number(a.offset) || 0);
      const limit = asLimit(a.limit, 30, 200);
      const page = list.slice(offset, offset + limit).map(noteSummary);
      return { total: list.length, offset, limit, count: page.length, notes: page };
    },
  },
  {
    name: 'get_note',
    title: '读取笔记',
    description: '按 id / path / title 读取一篇笔记的全文与元信息。标题重名时会返回候选列表，此时改用 id 或 path。',
    inputSchema: { type: 'object', properties: locatorProps, additionalProperties: false },
    annotations: READ,
    handler: async (args, store) => {
      const note = await store.findNote(locatorOf(cleanArgs(args)));
      return { note: noteFull(note) };
    },
  },
  {
    name: 'search_notes',
    title: '搜索笔记',
    description:
      '按关键词搜索笔记正文、标题与标签，返回命中片段和相关度。适合回答「我之前记过 XX」。不区分大小写；中文按原文匹配。',
    inputSchema: {
      type: 'object',
      properties: {
        query: str('搜索关键词（必填）'),
        notebook: str('限定笔记本（含子笔记本）'),
        tag: str('限定标签'),
        limit: int('返回条数，默认 20', 1, 100),
      },
      required: ['query'],
      additionalProperties: false,
    },
    annotations: READ,
    handler: async (args, store) => {
      const a = cleanArgs(args);
      const q = asString(a.query).trim();
      if (!q) throw new Error('搜索关键词不能为空');
      const limit = asLimit(a.limit, 20, 100);
      const matches = [];
      for (const note of await store.scanNotes()) {
        if (!inNotebook(note, a.notebook, true)) continue;
        if (a.tag && !note.tags.includes(a.tag)) continue;
        const hit = store.scoreNote(note, q);
        if (hit) matches.push({ ...noteSummary(note), snippet: hit.snippet, score: hit.score });
      }
      matches.sort((x, y) => y.score - x.score || +new Date(y.updated) - +new Date(x.updated));
      return {
        query: q,
        total: matches.length,
        count: Math.min(limit, matches.length),
        matches: matches.slice(0, limit),
      };
    },
  },
  {
    name: 'create_note',
    title: '新建笔记',
    description:
      '新建一篇 Markdown 笔记并立即写入磁盘。notebook 不存在会自动创建对应文件夹；标题相同会自动加 (2) 后缀，不会覆盖已有笔记。',
    inputSchema: {
      type: 'object',
      properties: {
        title: str('标题（必填）'),
        notebook: str('放入哪个笔记本，如 工作/项目A；不传为根目录'),
        content: str('Markdown 正文'),
        tags: tagsSchema,
        pinned: bool('是否置顶，默认 false'),
      },
      required: ['title'],
      additionalProperties: false,
    },
    annotations: WRITE,
    handler: async (args, store) => {
      const note = await store.createNote(cleanArgs(args));
      return { created: true, note: noteSummary(note) };
    },
  },
  {
    name: 'update_note',
    title: '更新笔记',
    description:
      '局部更新一篇笔记：只传要改的字段。content 会整体替换正文；newTitle 改标题、notebook 改笔记本时文件会相应重命名/移动（同名冲突自动加后缀）。',
    inputSchema: {
      type: 'object',
      properties: {
        ...locatorProps,
        newTitle: str('新的标题（不改标题就不要传）'),
        content: str('新的正文，整体替换已有正文'),
        notebook: str('移动到的笔记本；传空字符串表示根目录'),
        tags: tagsSchema,
        pinned: bool('是否置顶'),
      },
      additionalProperties: false,
    },
    annotations: WRITE,
    handler: async (args, store) => {
      const a = cleanArgs(args);
      const patch = {};
      if (a.newTitle !== undefined) patch.title = a.newTitle;
      if (a.content !== undefined) patch.content = a.content;
      if (a.notebook !== undefined) patch.notebook = a.notebook;
      if (a.tags !== undefined) patch.tags = a.tags;
      if (a.pinned !== undefined) patch.pinned = a.pinned;
      if (!Object.keys(patch).length) throw new Error('没有要更新的字段');
      const note = await store.updateNote(locatorOf(a), patch);
      return { updated: true, note: noteSummary(note) };
    },
  },
  {
    name: 'append_note',
    title: '追加内容到笔记',
    description: '在笔记正文末尾追加一段 Markdown，不影响已有内容。适合「帮我记一下…」这类追加场景。',
    inputSchema: {
      type: 'object',
      properties: {
        ...locatorProps,
        content: str('要追加的 Markdown（必填）'),
        separator: str('与原文之间的分隔符，默认两个换行'),
      },
      required: ['content'],
      additionalProperties: false,
    },
    annotations: WRITE,
    handler: async (args, store) => {
      const a = cleanArgs(args);
      const note = await store.appendNote(locatorOf(a), a.content, a.separator);
      return { appended: true, note: noteSummary(note) };
    },
  },
  {
    name: 'move_note',
    title: '移动笔记',
    description: '把笔记移动到另一个笔记本（等价于 update_note 只改 notebook）。',
    inputSchema: {
      type: 'object',
      properties: { ...locatorProps, notebook: str('目标笔记本；空字符串表示根目录') },
      required: ['notebook'],
      additionalProperties: false,
    },
    annotations: WRITE,
    handler: async (args, store) => {
      const a = cleanArgs(args);
      const note = await store.updateNote(locatorOf(a), { notebook: a.notebook });
      return { moved: true, note: noteSummary(note) };
    },
  },
  {
    name: 'duplicate_note',
    title: '复制笔记',
    description: '复制一篇笔记，默认标题加「副本」后缀、放在同一笔记本。',
    inputSchema: {
      type: 'object',
      properties: {
        ...locatorProps,
        newTitle: str('副本标题，默认「原标题 副本」'),
        notebook: str('副本放入的笔记本，默认与原笔记相同'),
      },
      additionalProperties: false,
    },
    annotations: WRITE,
    handler: async (args, store) => {
      const a = cleanArgs(args);
      const note = await store.duplicateNote(locatorOf(a), { title: a.newTitle, notebook: a.notebook });
      return { duplicated: true, note: noteSummary(note) };
    },
  },
  {
    name: 'delete_note',
    title: '删除笔记（进回收站）',
    description: '把笔记移入回收站，可恢复。需要彻底删除请用 purge_note。',
    inputSchema: { type: 'object', properties: locatorProps, additionalProperties: false },
    annotations: WRITE,
    handler: async (args, store) => {
      const note = await store.deleteNote(locatorOf(cleanArgs(args)));
      return { deleted: true, recoverable: true, note: noteSummary(note) };
    },
  },
  {
    name: 'list_trash',
    title: '列出笔记回收站',
    description: '列出回收站中的笔记（默认 30 天保留期，桌面端启动时清理过期项）。',
    inputSchema: {
      type: 'object',
      properties: { limit: int('返回条数，默认 50', 1, 200) },
      additionalProperties: false,
    },
    annotations: READ,
    handler: async (args, store) => {
      const limit = asLimit(cleanArgs(args).limit, 50, 200);
      const notes = await store.scanNoteTrash();
      notes.sort((a, b) => +new Date(b.deletedAt || b.updated) - +new Date(a.deletedAt || a.updated));
      return {
        total: notes.length,
        count: Math.min(limit, notes.length),
        notes: notes.slice(0, limit).map(noteSummary),
      };
    },
  },
  {
    name: 'restore_note',
    title: '恢复笔记',
    description: '从回收站恢复一篇笔记到它原来的笔记本（原笔记本不存在则放回 inbox）。path 用 list_trash 返回的路径。',
    inputSchema: {
      type: 'object',
      properties: { path: str('回收站内路径（必填）') },
      required: ['path'],
      additionalProperties: false,
    },
    annotations: WRITE,
    handler: async (args, store) => {
      const note = await store.restoreNote(cleanArgs(args).path);
      return { restored: true, note: noteSummary(note) };
    },
  },
  {
    name: 'purge_note',
    title: '彻底删除笔记',
    description: '从回收站永久删除一篇笔记，**不可恢复**。调用前应向用户确认。',
    inputSchema: {
      type: 'object',
      properties: { path: str('回收站内路径（必填）') },
      required: ['path'],
      additionalProperties: false,
    },
    annotations: DESTROY,
    handler: async (args, store) => {
      const note = await store.purgeNote(cleanArgs(args).path);
      return { purged: true, title: note.title, path: note.path };
    },
  },
  {
    name: 'empty_trash',
    title: '清空笔记回收站',
    description: '永久删除笔记回收站中的全部笔记，**不可恢复**；不会影响任务回收站。调用前应向用户确认。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: DESTROY,
    handler: async (_args, store) => ({ purged: await store.emptyNoteTrash() }),
  },
  {
    name: 'list_tasks',
    title: '列出待办',
    description:
      '列出待办任务，默认只含未完成。可按状态、截止日期区间、是否过期、标签、关键词筛选。返回 dueLabel（今天/明天/已过期 N 天）便于直接回答用户。',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['open', 'all', 'inbox', 'todo', 'doing', 'done'],
          description: '默认 open（未完成三态）；all 含已完成',
        },
        dueFrom: str('截止日期下限 YYYY-MM-DD（含）'),
        dueTo: str('截止日期上限 YYYY-MM-DD（含）'),
        overdueOnly: bool('只看已过期'),
        tag: str('按标签精确筛选'),
        query: str('关键词（标题、备注、关联笔记标题、标签）'),
        includeDone: bool('是否包含已完成，等价于 status=all'),
        limit: int('返回条数，默认 100', 1, 500),
      },
      additionalProperties: false,
    },
    annotations: READ,
    handler: async (args, store) => {
      const a = cleanArgs(args);
      const all = await store.scanTasks();
      const status = a.status && a.status !== 'all' ? a.status : a.includeDone ? 'all' : 'open';
      const q = asString(a.query).trim().toLowerCase();
      const from = a.dueFrom ? parseDateKey(a.dueFrom) : null;
      const to = a.dueTo ? parseDateKey(a.dueTo) : null;
      if (a.dueFrom && !from) throw new Error('dueFrom 格式应为 YYYY-MM-DD');
      if (a.dueTo && !to) throw new Error('dueTo 格式应为 YYYY-MM-DD');

      const filtered = all.filter((t) => {
        if (status === 'open' && t.status === 'done') return false;
        if (status !== 'open' && status !== 'all' && t.status !== status) return false;
        if (a.overdueOnly) {
          const diff = t.due ? daysUntil(t.due) : null;
          if (t.status === 'done' || diff === null || diff >= 0) return false;
        }
        if (from || to) {
          const d = t.due ? parseDateKey(t.due) : null;
          if (!d) return false;
          if (from && d.getTime() < from.getTime()) return false;
          if (to && d.getTime() > to.getTime()) return false;
        }
        if (a.tag && !t.tags.includes(a.tag)) return false;
        if (q) {
          const hay = [t.title, t.notes, t.noteTitle || '', ...t.tags].join('\n').toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      });

      filtered.sort((x, y) => {
        if (x.status === 'done' || y.status === 'done') {
          if (x.status === 'done' && y.status === 'done')
            return +new Date(y.doneAt || y.updated) - +new Date(x.doneAt || x.updated);
          return x.status === 'done' ? 1 : -1;
        }
        const dx = x.due ? parseDateKey(x.due).getTime() : Infinity;
        const dy = y.due ? parseDateKey(y.due).getTime() : Infinity;
        if (dx !== dy) return dx - dy;
        if (priorityRank(x.priority) !== priorityRank(y.priority))
          return priorityRank(x.priority) - priorityRank(y.priority);
        return +new Date(y.created) - +new Date(x.created);
      });

      const limit = asLimit(a.limit, 100, 500);
      const today = dateKey();
      const counts = {
        total: all.length,
        open: all.filter((t) => t.status !== 'done').length,
        done: all.filter((t) => t.status === 'done').length,
        overdue: all.filter((t) => t.status !== 'done' && t.due && daysUntil(t.due) < 0).length,
        today: all.filter((t) => t.status !== 'done' && t.due === today).length,
      };
      return {
        total: filtered.length,
        count: Math.min(limit, filtered.length),
        counts,
        tasks: filtered.slice(0, limit).map(taskSummary),
      };
    },
  },
  {
    name: 'get_task',
    title: '读取待办',
    description: '按 id 或 path 读取一条待办的全部字段与备注正文。',
    inputSchema: {
      type: 'object',
      properties: { id: str('待办 id'), path: str('任务文件相对路径，如 tasks/2026/10/xxxx.md') },
      additionalProperties: false,
    },
    annotations: READ,
    handler: async (args, store) => {
      const task = await store.findTask(cleanArgs(args));
      return { task: taskFull(task) };
    },
  },
  {
    name: 'create_task',
    title: '新建待办',
    description:
      '新建一条待办并写入磁盘。不传 due 时为「待整理」；传 due 且未指定 status 时自动进「待办」。可关联笔记（noteId/noteTitle）。',
    inputSchema: {
      type: 'object',
      properties: {
        title: str('待办标题（必填）'),
        status: {
          type: 'string',
          enum: ['inbox', 'todo', 'doing', 'done'],
          description: '默认：有日期 todo，无日期 inbox',
        },
        due: str('截止日期 YYYY-MM-DD；待整理没有日期'),
        dueTime: str('到点提醒时间 HH:mm，需要同时有 due；不填则只在日期层面记录'),
        priority: { type: 'string', enum: ['high', 'normal', 'low'], description: '默认 normal' },
        category: str('分类名，如「工作」「家庭」；不填为未分类'),
        tags: tagsSchema,
        notes: str('备注正文（Markdown）'),
        noteId: str('关联笔记 id'),
        noteTitle: str('关联笔记标题'),
      },
      required: ['title'],
      additionalProperties: false,
    },
    annotations: WRITE,
    handler: async (args, store) => {
      const task = await store.createTask(cleanArgs(args));
      return { created: true, task: taskSummary(task) };
    },
  },
  {
    name: 'update_task',
    title: '更新待办',
    description:
      '局部更新待办。due 传 null 或空字符串可清空日期；status 设为 inbox 会自动清空日期；设为 doing 表示跟进中。已完成任务改回 todo/doing 会清除 doneAt。',
    inputSchema: {
      type: 'object',
      properties: {
        id: str('待办 id（与 path 二选一）'),
        path: str('任务文件相对路径'),
        title: str('新标题'),
        status: { type: 'string', enum: ['inbox', 'todo', 'doing', 'done'] },
        due: { type: ['string', 'null'], description: 'YYYY-MM-DD；null 清空' },
        dueTime: { type: ['string', 'null'], description: 'HH:mm；null 或空串清空提醒时间' },
        priority: { type: 'string', enum: ['high', 'normal', 'low'] },
        category: { type: ['string', 'null'], description: '分类名；null 或空串表示未分类' },
        tags: tagsSchema,
        notes: str('替换备注正文'),
        noteId: str('关联笔记 id；null 取消关联'),
        noteTitle: str('关联笔记标题；null 取消'),
      },
      additionalProperties: false,
    },
    annotations: WRITE,
    handler: async (args, store) => {
      const a = cleanArgs(args);
      const patch = {};
      for (const key of ['title', 'status', 'priority', 'category', 'tags', 'notes', 'noteId', 'noteTitle']) {
        if (a[key] !== undefined) patch[key] = a[key];
      }
      if (a.due !== undefined) patch.due = a.due === null || a.due === '' ? null : a.due;
      if (a.dueTime !== undefined) patch.dueTime = a.dueTime === null || a.dueTime === '' ? null : a.dueTime;
      if (!Object.keys(patch).length) throw new Error('没有要更新的字段');
      const task = await store.updateTask({ id: a.id, path: a.path }, patch);
      return { updated: true, task: taskSummary(task) };
    },
  },
  {
    name: 'complete_task',
    title: '完成待办',
    description: '把待办标记为已完成，记录完成时间与完成前状态（取消完成时可还原）。',
    inputSchema: {
      type: 'object',
      properties: { id: str('待办 id'), path: str('任务文件相对路径') },
      additionalProperties: false,
    },
    annotations: WRITE,
    handler: async (args, store) => {
      const a = cleanArgs(args);
      const task = await store.completeTask({ id: a.id, path: a.path });
      return { completed: true, task: taskSummary(task) };
    },
  },
  {
    name: 'reopen_task',
    title: '取消完成',
    description: '把已完成的待办恢复为完成前的状态（之前是待整理/待办/跟进中则原样还原，否则回到待办）。',
    inputSchema: {
      type: 'object',
      properties: { id: str('待办 id'), path: str('任务文件相对路径') },
      additionalProperties: false,
    },
    annotations: WRITE,
    handler: async (args, store) => {
      const a = cleanArgs(args);
      const task = await store.reopenTask({ id: a.id, path: a.path });
      return { reopened: true, task: taskSummary(task) };
    },
  },
  {
    name: 'append_task_note',
    title: '追加待办备注',
    description: '在待办的备注正文末尾追加一段文字（不改变标题、状态、日期）。',
    inputSchema: {
      type: 'object',
      properties: {
        id: str('待办 id'),
        path: str('任务文件相对路径'),
        text: str('要追加的文本（必填）'),
        separator: str('分隔符，默认两个换行'),
      },
      required: ['text'],
      additionalProperties: false,
    },
    annotations: WRITE,
    handler: async (args, store) => {
      const a = cleanArgs(args);
      const task = await store.appendTaskNote({ id: a.id, path: a.path }, a.text, a.separator);
      return { appended: true, task: taskSummary(task) };
    },
  },
  {
    name: 'delete_task',
    title: '删除待办（进回收站）',
    description: '把待办移入任务回收站，可恢复。需要彻底删除请用 purge_task。',
    inputSchema: {
      type: 'object',
      properties: { id: str('待办 id'), path: str('任务文件相对路径') },
      additionalProperties: false,
    },
    annotations: WRITE,
    handler: async (args, store) => {
      const a = cleanArgs(args);
      const task = await store.deleteTask({ id: a.id, path: a.path });
      return { deleted: true, recoverable: true, task: taskSummary(task) };
    },
  },
  {
    name: 'list_task_trash',
    title: '列出任务回收站',
    description: '列出任务回收站中的待办（默认 30 天保留期）。',
    inputSchema: {
      type: 'object',
      properties: { limit: int('返回条数，默认 50', 1, 200) },
      additionalProperties: false,
    },
    annotations: READ,
    handler: async (args, store) => {
      const limit = asLimit(cleanArgs(args).limit, 50, 200);
      const tasks = await store.scanTaskTrash();
      tasks.sort((a, b) => +new Date(b.deletedAt || b.updated) - +new Date(a.deletedAt || a.updated));
      return {
        total: tasks.length,
        count: Math.min(limit, tasks.length),
        tasks: tasks.slice(0, limit).map(taskSummary),
      };
    },
  },
  {
    name: 'restore_task',
    title: '恢复待办',
    description:
      '从任务回收站恢复一条待办，优先回到删除前的位置，位置被占用时自动加序号。path 用 list_task_trash 返回的路径。',
    inputSchema: {
      type: 'object',
      properties: { path: str('回收站内路径（必填）') },
      required: ['path'],
      additionalProperties: false,
    },
    annotations: WRITE,
    handler: async (args, store) => {
      const task = await store.restoreTask(cleanArgs(args).path);
      return { restored: true, task: taskSummary(task) };
    },
  },
  {
    name: 'purge_task',
    title: '彻底删除待办',
    description: '从任务回收站永久删除一条待办，**不可恢复**。调用前应向用户确认。',
    inputSchema: {
      type: 'object',
      properties: { path: str('回收站内路径（必填）') },
      required: ['path'],
      additionalProperties: false,
    },
    annotations: DESTROY,
    handler: async (args, store) => {
      const task = await store.purgeTask(cleanArgs(args).path);
      return { purged: true, title: task.title, path: task.path };
    },
  },
  {
    name: 'empty_task_trash',
    title: '清空任务回收站',
    description: '永久删除任务回收站中的全部待办，**不可恢复**；不会影响笔记回收站。调用前应向用户确认。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: DESTROY,
    handler: async (_args, store) => ({ purged: await store.emptyTaskTrash() }),
  },
  {
    name: 'list_ideas',
    title: '列出灵感',
    description:
      '列出灵感库（随手记的碎片，一条一个文件，只有正文）。默认只看未整理；可按状态、整理去向、正文关键词筛选。每条都返回完整正文（最多 2000 字）。',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['open', 'converted', 'all'],
          description: 'open 未整理（默认）、converted 已转化、all 全部',
        },
        convertedType: { type: 'string', enum: ['note', 'task'], description: '只看整理成笔记或待办的记录' },
        query: str('按正文子串匹配，不区分大小写'),
        limit: int('返回条数，默认 50', 1, 200),
        offset: int('跳过条数，默认 0', 0, 100000),
      },
      additionalProperties: false,
    },
    annotations: READ,
    handler: async (args, store) => {
      const a = cleanArgs(args);
      const all = await store.scanIdeas();
      const status = a.status === 'converted' || a.status === 'all' ? a.status : 'open';
      const q = asString(a.query).trim().toLowerCase();
      const counts = {
        total: all.length,
        open: all.filter((i) => !i.convertedType).length,
        converted: all.filter((i) => i.convertedType).length,
      };
      let list = all.filter((i) => {
        if (status === 'open' && i.convertedType) return false;
        if (status === 'converted' && !i.convertedType) return false;
        if (a.convertedType && i.convertedType !== a.convertedType) return false;
        if (q && !i.text.toLowerCase().includes(q)) return false;
        return true;
      });
      list.sort((x, y) => +new Date(y.created) - +new Date(x.created));
      const offset = Math.max(0, Number(a.offset) || 0);
      const limit = asLimit(a.limit, 50, 200);
      const page = list.slice(offset, offset + limit).map(ideaSummary);
      return { total: list.length, offset, limit, count: page.length, counts, ideas: page };
    },
  },
  {
    name: 'get_idea',
    title: '读取灵感',
    description: '按 id 或 path 读取一条灵感的正文、时间与整理去向。',
    inputSchema: {
      type: 'object',
      properties: {
        id: str('灵感 id'),
        path: str('灵感文件相对路径，如 ideas/2026/10/xxxx.md（可省略 ideas/ 前缀）'),
      },
      additionalProperties: false,
    },
    annotations: READ,
    handler: async (args, store) => {
      const a = cleanArgs(args);
      const idea = await store.findIdea({ id: a.id, path: a.path });
      return { idea: ideaSummary(idea) };
    },
  },
  {
    name: 'create_idea',
    title: '记一条灵感',
    description:
      '随手记一条灵感：只有正文，不需要标题、笔记本或日期，最多 2000 字。写入 ideas/YYYY/MM/<id>.md，界面「灵感」里立即可见。',
    inputSchema: {
      type: 'object',
      properties: { text: str('灵感正文（必填，最多 2000 字，可多行）') },
      required: ['text'],
      additionalProperties: false,
    },
    annotations: WRITE,
    handler: async (args, store) => {
      const idea = await store.createIdea(cleanArgs(args));
      return { created: true, idea: ideaSummary(idea) };
    },
  },
  {
    name: 'update_idea',
    title: '修改灵感',
    description: '整体替换一条未整理灵感的正文。已经整理成笔记/待办的灵感只读，请改对应的成品。',
    inputSchema: {
      type: 'object',
      properties: {
        id: str('灵感 id（与 path 二选一）'),
        path: str('灵感文件相对路径'),
        text: str('新的正文（必填，最多 2000 字）'),
      },
      required: ['text'],
      additionalProperties: false,
    },
    annotations: WRITE,
    handler: async (args, store) => {
      const a = cleanArgs(args);
      const idea = await store.updateIdea({ id: a.id, path: a.path }, a.text);
      return { updated: true, idea: ideaSummary(idea) };
    },
  },
  {
    name: 'delete_idea',
    title: '删除灵感',
    description:
      '直接从 ideas/ 删除一条灵感，**不可恢复**（灵感库没有回收站；界面里的删除另有撤销，MCP 没有）。调用前应向用户确认。',
    inputSchema: {
      type: 'object',
      properties: {
        id: str('灵感 id'),
        path: str('灵感文件相对路径'),
      },
      additionalProperties: false,
    },
    annotations: DESTROY,
    handler: async (args, store) => {
      const a = cleanArgs(args);
      const idea = await store.deleteIdea({ id: a.id, path: a.path });
      return { deleted: true, recoverable: false, idea: ideaSummary(idea) };
    },
  },
  {
    name: 'convert_ideas',
    title: '整理灵感',
    description:
      '把一条或多条未整理的灵感变成成品：target=note 合并成一篇笔记（单条取首行作标题，多条标题为「灵感整理 · M月D日」并按时间排序，放进 inbox）；target=task 一条灵感生成一条「待整理」的待办。原文保留在「已转化」并记录成品 id 与标题。',
    inputSchema: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' }, description: '灵感 id 列表；与 paths 至少提供一个' },
        paths: { type: 'array', items: { type: 'string' }, description: '灵感文件相对路径列表' },
        target: { type: 'string', enum: ['note', 'task'], description: 'note 合并成笔记；task 拆成待办' },
      },
      required: ['target'],
      additionalProperties: false,
    },
    annotations: WRITE,
    handler: async (args, store) => {
      const a = cleanArgs(args);
      const list = (v) => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);
      const locators = [
        ...list(a.ids)
          .map((id) => ({ id: String(id).trim() }))
          .filter((l) => l.id),
        ...list(a.paths)
          .map((p) => ({ path: String(p).trim() }))
          .filter((l) => l.path),
      ];
      if (!locators.length) throw new Error('请提供 ids 或 paths（至少一条灵感）');
      const res = await store.convertIdeas(locators, a.target);
      return {
        converted: true,
        target: res.target,
        count: res.converted.length,
        note: res.note ? noteSummary(res.note) : undefined,
        tasks: res.tasks.map(taskSummary),
        ideas: res.converted.map(ideaSummary),
      };
    },
  },
  {
    name: 'get_daily_note',
    title: '读取当天日记',
    description:
      '按日期读取「日记」笔记本里的当天日记（标题为 YYYY-MM-DD）。默认今天；不存在时返回 found:false，不会创建文件。',
    inputSchema: {
      type: 'object',
      properties: { date: str('日期 YYYY-MM-DD，默认今天') },
      additionalProperties: false,
    },
    annotations: READ,
    handler: async (args, store) => {
      const key = cleanArgs(args).date ? String(cleanArgs(args).date).trim() : dateKey();
      if (!parseDateKey(key)) throw new Error(`date 格式应为 YYYY-MM-DD（收到 ${key}）`);
      const note = await store.findDailyNote(key);
      if (!note) {
        return {
          found: false,
          date: key,
          title: dailyTitleOf(key),
          hint: '当天日记还没创建，可用 append_daily_note 写入第一段',
        };
      }
      return { found: true, date: key, note: noteFull(note) };
    },
  },
  {
    name: 'append_daily_note',
    title: '追加到当天日记',
    description:
      '在指定日期（默认今天）的日记末尾追加一段内容；当天日记不存在时按界面规则自动创建（标题 YYYY-MM-DD、正文首行「M月D日 周X」、标签「日记」）。适合「帮我在今天日记里记一笔」。',
    inputSchema: {
      type: 'object',
      properties: {
        date: str('日期 YYYY-MM-DD，默认今天'),
        content: str('要追加的 Markdown（必填）'),
        separator: str('与原文之间的分隔符，默认两个换行'),
      },
      required: ['content'],
      additionalProperties: false,
    },
    annotations: WRITE,
    handler: async (args, store) => {
      const a = cleanArgs(args);
      const key = a.date ? String(a.date).trim() : dateKey();
      if (!parseDateKey(key)) throw new Error(`date 格式应为 YYYY-MM-DD（收到 ${key}）`);
      const { note, created } = await store.appendDailyNote(key, a.content, a.separator);
      return { appended: true, created, date: key, note: noteSummary(note) };
    },
  },
  {
    name: 'repo_stats',
    title: '写作与任务统计',
    description:
      '统计笔记总字数、最近 7 天写作情况、连续写作天数，以及待办（未完成/已完成/过期/今天）、灵感、小应用数量。适合回答「我最近写得怎么样」「这周完成了多少」。字数按中文单字、英文数字单词计算。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: READ,
    handler: async (_args, store) => store.repoStats(),
  },
  {
    name: 'list_task_categories',
    title: '列出待办分类',
    description:
      '从任务文件里汇总实际使用的分类名与数量（含未分类）。分类的颜色和排序只存在浏览器 localStorage 里，MCP 读不到也改不了；这里只返回分类名与任务数。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: READ,
    handler: async (_args, store) => {
      const tasks = await store.scanTasks();
      const map = new Map();
      let uncategorized = 0;
      for (const task of tasks) {
        const name = String(task.category || '').trim();
        if (!name) {
          uncategorized += 1;
          continue;
        }
        map.set(name, (map.get(name) || 0) + 1);
      }
      const categories = [...map.entries()]
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh'));
      return {
        total: tasks.length,
        uncategorized,
        categories,
        note: '分类颜色与顺序保存在本机浏览器存储中，MCP 不读取；新建待办时用 category 传分类名即可。',
      };
    },
  },
  {
    name: 'get_app_guide',
    title: '小应用生成规范',
    description:
      '返回生成萤光笔记「AI 小应用」必须遵守的规范、数据桥接口、安全限制与一份可复制的 HTML 骨架。MCP 服务本身不调用仓库里配置的 AI；由 MCP 客户端的大模型按这份规范生成完整 HTML，再调用 create_app 保存。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: READ,
    handler: async () => ({
      format:
        '单个自包含 HTML 文档（必须包含 <!doctype html> 或 <html>，并以 </html> 结束），保存为 apps/<id>/index.html。',
      limits: {
        htmlBytes: 200 * 1024,
        appCount: 50,
        dataKeys: 200,
        valueBytes: 128 * 1024,
        dataBytes: 512 * 1024,
        versions: 10,
      },
      colors: APP_COLORS,
      icons: HOME_ICON_KEYS,
      forbidden: [
        'localStorage / sessionStorage',
        'document.cookie',
        'window.parent / window.top / parent.document / top.location',
        '<base> / <iframe> / <object> / <embed>',
        'javascript: 链接',
        'meta refresh 自动跳转',
      ],
      allowed: [
        '内联 CSS / JavaScript，以及 https/http 外部样式、脚本、图片',
        'fetch / XMLHttpRequest / WebSocket 联网（自行处理超时、失败与 CORS）',
        'window.glimnote.data 持久化接口',
        'window.glimnote.notify 系统通知（桌面端）',
      ],
      dataApi: [
        "await window.glimnote.data.set('key', value)  // value 必须能 JSON 序列化",
        "const value = await window.glimnote.data.get('key', 默认值)",
        'const all = await window.glimnote.data.all()',
        "await window.glimnote.data.remove('key')",
        'await window.glimnote.data.clear()',
        'window.glimnote.data.onChange(function (key) {})',
      ],
      workflow: [
        '1. 根据用户描述生成完整、可离线运行的 HTML；不要只给片段或差异。',
        '2. 需要跨刷新保留的数据用 window.glimnote.data，不要用 localStorage。',
        '3. 调用 create_app 保存，名称 2–16 字、说明 160 字以内；默认会自动在首页「AI 小应用」分组添加入口。',
        '4. 修改已有应用时先 get_app 取回 html，再调用 update_app 传完整新版 html；服务端会为旧版留一份本机快照。',
      ],
      example:
        '<!doctype html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1">\n<title>示例</title>\n<style>body{font-family:system-ui;padding:24px}</style>\n</head>\n<body>\n<h1>示例小应用</h1>\n<button id="b">点我</button>\n<p id="out"></p>\n<script>\nconst out = document.getElementById("out");\nlet count = 0;\nconst paint = () => { out.textContent = "已点击 " + count + " 次"; };\nif (window.glimnote && window.glimnote.data) {\n  window.glimnote.data.get("count", 0).then((v) => { count = Number(v) || 0; paint(); }).catch(() => {});\n}\npaint();\ndocument.getElementById("b").onclick = async () => {\n  count += 1;\n  paint();\n  try { await window.glimnote.data.set("count", count); } catch {}\n};\n</script>\n</body>\n</html>',
    }),
  },
  {
    name: 'list_apps',
    title: '列出小应用',
    description:
      '列出仓库里的 AI 小应用（apps/<id>/），按最近更新时间倒序。返回名称、说明、图标、颜色、版本、来源、HTML 与数据体积。想读代码用 get_app。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: READ,
    handler: async (_args, store) => {
      const apps = await store.listApps();
      return { count: apps.length, apps };
    },
  },
  {
    name: 'get_app',
    title: '读取小应用',
    description:
      '按应用 id 或名称读取小应用：元数据、完整 HTML、数据键数量、版本列表。修改代码前先调用它拿到当前 HTML。',
    inputSchema: {
      type: 'object',
      properties: {
        id: str('应用 id'),
        name: str('应用名称（仅唯一时可用；重名会返回候选 id）'),
        includeHtml: bool('是否返回完整 HTML，默认 true'),
        includeData: bool('是否返回应用数据，默认 false'),
      },
      additionalProperties: false,
    },
    annotations: READ,
    handler: async (args, store) => {
      const a = cleanArgs(args);
      const key = a.id || a.name;
      if (!key) throw new Error('需要提供 id 或 name 之一');
      return store.getApp(key, { includeHtml: a.includeHtml !== false, includeData: Boolean(a.includeData) });
    },
  },
  {
    name: 'create_app',
    title: '创建小应用',
    description:
      '把一段完整 HTML 保存成 AI 小应用，并默认在首页「AI 小应用」分组添加入口。HTML 会按桌面端同一套规则做安全检查（禁止本地存储、Cookie、宿主窗口、嵌套页面等），超过 200KB 或结构不完整会被拒绝。先用 get_app_guide 了解规范。',
    inputSchema: {
      type: 'object',
      properties: {
        name: str('应用名称（必填，建议 2–16 字）'),
        html: str('完整单文件 HTML（必填，≤200KB）'),
        description: str('一句话说明（≤160 字）'),
        icon: { type: 'string', enum: HOME_ICON_KEYS, description: '图标名，默认 sparkles' },
        color: { type: 'string', enum: APP_COLORS, description: '主题色，默认 green' },
        source: { type: 'string', enum: ['ai', 'import', 'market'], description: '来源，默认 ai' },
        model: str('生成这个应用的模型名（可选，仅记录）'),
        template: str('应用市场模板 id（仅安装市场应用时使用）'),
        addToHome: bool('是否在首页添加入口，默认 true'),
        groupId: str('放到哪个首页分组 id（可选）'),
        groupName: str('放到哪个首页分组名（可选，如 AI 小应用）'),
      },
      required: ['name', 'html'],
      additionalProperties: false,
    },
    annotations: WRITE,
    handler: async (args, store) => store.createApp(cleanArgs(args)),
  },
  {
    name: 'update_app',
    title: '更新小应用',
    description:
      '局部更新小应用。传 html 时整体替换代码：旧版会留一份本机快照（最多 10 份），版本号 +1；只改名称/说明/图标/颜色时不升版本。修改前先用 get_app 取回当前 HTML。',
    inputSchema: {
      type: 'object',
      properties: {
        id: str('应用 id（与 name 二选一）'),
        name: str('应用名称（仅用于定位；要改名请用 newName）'),
        newName: str('新的应用名称'),
        description: str('新的说明'),
        icon: { type: 'string', enum: HOME_ICON_KEYS, description: '新的图标名' },
        color: { type: 'string', enum: APP_COLORS, description: '新的主题色' },
        model: str('记录本次生成使用的模型名'),
        html: str('完整的替换版 HTML（不是差异）'),
      },
      additionalProperties: false,
    },
    annotations: WRITE,
    handler: async (args, store) => {
      const a = cleanArgs(args);
      const key = a.id || a.name;
      if (!key) throw new Error('需要提供 id 或 name 之一');
      const patch = {};
      if (a.newName !== undefined) patch.name = a.newName;
      if (a.description !== undefined) patch.description = a.description;
      if (a.icon !== undefined) patch.icon = a.icon;
      if (a.color !== undefined) patch.color = a.color;
      if (a.model !== undefined) patch.model = a.model;
      if (a.html !== undefined) patch.html = a.html;
      if (!Object.keys(patch).length) throw new Error('没有要更新的字段');
      return store.updateApp(key, patch);
    },
  },
  {
    name: 'delete_app',
    title: '删除小应用',
    description: '删除应用目录、本机历史快照，以及首页指向它的全部入口，**不可恢复**。调用前应向用户确认。',
    inputSchema: {
      type: 'object',
      properties: { id: str('应用 id（与 name 二选一）'), name: str('应用名称') },
      additionalProperties: false,
    },
    annotations: DESTROY,
    handler: async (args, store) => {
      const a = cleanArgs(args);
      const key = a.id || a.name;
      if (!key) throw new Error('需要提供 id 或 name 之一');
      return store.deleteApp(key);
    },
  },
  {
    name: 'get_app_data',
    title: '读取小应用数据',
    description: '读取 apps/<id>/data.json 里保存的键值数据（窗口内数据桥 window.glimnote.data 写的持久化内容）。',
    inputSchema: {
      type: 'object',
      properties: { id: str('应用 id'), name: str('应用名称') },
      additionalProperties: false,
    },
    annotations: READ,
    handler: async (args, store) => {
      const a = cleanArgs(args);
      const key = a.id || a.name;
      if (!key) throw new Error('需要提供 id 或 name 之一');
      return store.getAppData(key);
    },
  },
  {
    name: 'set_app_data',
    title: '写入小应用数据',
    description:
      '写入应用数据。提供 data（整体替换，除非 replace=false 时合并）或 values（按键合并），也可以 removeKeys 删除指定键。单值 ≤128KB、总数据 ≤512KB、最多 200 个键。',
    inputSchema: {
      type: 'object',
      properties: {
        id: str('应用 id'),
        name: str('应用名称'),
        data: { type: 'object', description: '要写入的 JSON 对象；默认与现有数据合并' },
        values: { type: 'object', description: '要按键合并的 JSON 对象' },
        removeKeys: { type: 'array', items: { type: 'string' }, description: '要删除的键名' },
        replace: bool('为 true 时用 data 整体替换现有数据，默认 false（合并）'),
      },
      additionalProperties: false,
    },
    annotations: WRITE,
    handler: async (args, store) => {
      const a = cleanArgs(args);
      const key = a.id || a.name;
      if (!key) throw new Error('需要提供 id 或 name 之一');
      return store.setAppData(key, {
        data: a.data,
        values: a.values,
        removeKeys: a.removeKeys,
        replace: a.replace,
      });
    },
  },
  {
    name: 'clear_app_data',
    title: '清空小应用数据',
    description: '把应用数据重置为空对象，**不可恢复**。调用前应向用户确认；应用代码与元数据不受影响。',
    inputSchema: {
      type: 'object',
      properties: { id: str('应用 id'), name: str('应用名称') },
      additionalProperties: false,
    },
    annotations: DESTROY,
    handler: async (args, store) => {
      const a = cleanArgs(args);
      const key = a.id || a.name;
      if (!key) throw new Error('需要提供 id 或 name 之一');
      return store.clearAppData(key);
    },
  },
  {
    name: 'list_app_versions',
    title: '列出小应用历史版本',
    description: '列出本机保存的历史 HTML 快照（最多 10 份，不参与 Git 同步），按时间倒序。',
    inputSchema: {
      type: 'object',
      properties: { id: str('应用 id'), name: str('应用名称') },
      additionalProperties: false,
    },
    annotations: READ,
    handler: async (args, store) => {
      const a = cleanArgs(args);
      const key = a.id || a.name;
      if (!key) throw new Error('需要提供 id 或 name 之一');
      const app = await store.findApp(key);
      const versions = await store.listVersions(app.id);
      return { app: { id: app.id, name: app.name, version: app.version }, count: versions.length, versions };
    },
  },
  {
    name: 'restore_app_version',
    title: '恢复小应用历史版本',
    description:
      '把某个历史快照恢复为当前代码。当前版本会先留一份新快照，版本号 +1；可用 list_app_versions 查看快照名。',
    inputSchema: {
      type: 'object',
      properties: {
        id: str('应用 id'),
        name: str('应用名称'),
        version: str('快照名（list_app_versions 返回的 name，可不带 .html）'),
      },
      required: ['version'],
      additionalProperties: false,
    },
    annotations: WRITE,
    handler: async (args, store) => {
      const a = cleanArgs(args);
      const key = a.id || a.name;
      if (!key) throw new Error('需要提供 id 或 name 之一');
      return store.restoreVersion(key, a.version);
    },
  },
  {
    name: 'list_home',
    title: '读取首页',
    description:
      '读取首页分组与入口（网址、小应用、笔记、笔记本、今日日记、智能视图、本机系统应用）。入口会尽量补全应用名/笔记标题；本机系统应用标记 local=true。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: READ,
    handler: async (_args, store) => store.listHome(),
  },
  {
    name: 'add_home_entry',
    title: '添加首页入口',
    description:
      '在首页分组里添加入口。支持 url（自动补 https）、app（应用 id）、note（笔记 id）、notebook（笔记本路径）、daily（今日日记）、view（智能视图）。不指定分组时放到第一个分组；没有分组会自动建「常用」。系统应用入口只能在桌面端添加。',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['url', 'app', 'note', 'notebook', 'daily', 'view'], description: '入口类型' },
        target: str('网址 / 应用 id / 笔记 id / 笔记本路径 / 智能视图键（daily 不需要）'),
        title: str('显示名称（应用入口默认跟随应用名）'),
        icon: { type: 'string', enum: HOME_ICON_KEYS, description: '图标名' },
        color: { type: 'string', enum: HOME_COLORS, description: '颜色，默认 green' },
        groupId: str('目标分组 id'),
        groupName: str('目标分组名（与 groupId 二选一）'),
      },
      required: ['type'],
      additionalProperties: false,
    },
    annotations: WRITE,
    handler: async (args, store) => store.addHomeEntry(cleanArgs(args)),
  },
  {
    name: 'update_home_entry',
    title: '更新首页入口',
    description:
      '修改入口的名称、图标、颜色、目标，或移动到其它分组 / 调整组内顺序。不支持修改入口类型；需要换类型请删除后重新添加。',
    inputSchema: {
      type: 'object',
      properties: {
        id: str('入口 id（必填）'),
        title: { type: ['string', 'null'], description: '新名称；null 或空串表示跟随目标名称' },
        icon: { type: ['string', 'null'], enum: [...HOME_ICON_KEYS, null], description: '新图标；null 清空' },
        color: { type: ['string', 'null'], enum: [...HOME_COLORS, null], description: '新颜色；null 清空' },
        target: str('新的目标（网址 / 应用 id / 笔记 id / 笔记本路径 / 视图键）'),
        groupId: str('移动到哪个分组 id'),
        groupName: str('移动到哪个分组名'),
        index: int('组内位置（从 0 开始）', 0, 500),
      },
      required: ['id'],
      additionalProperties: false,
    },
    annotations: WRITE,
    handler: async (args, store) => {
      const a = cleanArgs(args);
      if (a.type !== undefined) {
        const error = new Error('MCP 不支持修改入口类型，请删除后重新添加');
        error.code = 'UNSUPPORTED';
        throw error;
      }
      return store.updateHomeEntry(a.id, {
        title: a.title,
        icon: a.icon,
        color: a.color,
        target: a.target,
        groupId: a.groupId,
        groupName: a.groupName,
        index: a.index,
      });
    },
  },
  {
    name: 'delete_home_entry',
    title: '删除首页入口',
    description: '删除一个首页入口（不会删除指向的笔记或小应用），**入口本身不可恢复**。调用前应向用户确认。',
    inputSchema: {
      type: 'object',
      properties: { id: str('入口 id（必填）') },
      required: ['id'],
      additionalProperties: false,
    },
    annotations: DESTROY,
    handler: async (args, store) => store.deleteHomeEntry(cleanArgs(args).id),
  },
  {
    name: 'add_home_group',
    title: '添加首页分组',
    description: '新建一个首页分组，最多 20 个；分组名不能重复。新分组会排在最后。',
    inputSchema: {
      type: 'object',
      properties: {
        name: str('分组名称（必填）'),
        icon: { type: 'string', enum: HOME_ICON_KEYS, description: '图标名，默认 star' },
        color: { type: 'string', enum: HOME_COLORS, description: '颜色，默认 green' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    annotations: WRITE,
    handler: async (args, store) => store.addHomeGroup(cleanArgs(args)),
  },
  {
    name: 'update_home_group',
    title: '更新首页分组',
    description: '修改分组名称、图标或颜色；分组名不能与其它分组重复。',
    inputSchema: {
      type: 'object',
      properties: {
        id: str('分组 id（必填）'),
        name: str('新分组名'),
        icon: { type: ['string', 'null'], enum: [...HOME_ICON_KEYS, null], description: '新图标；null 清空' },
        color: { type: ['string', 'null'], enum: [...HOME_COLORS, null], description: '新颜色；null 清空' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    annotations: WRITE,
    handler: async (args, store) => {
      const a = cleanArgs(args);
      return store.updateHomeGroup(a.id, { name: a.name, icon: a.icon, color: a.color });
    },
  },
  {
    name: 'delete_home_group',
    title: '删除首页分组',
    description:
      '删除一个分组；组内只属于该分组的入口文件也会一起删除，**不可恢复**。仍被其它分组引用的入口会保留。调用前应向用户确认。',
    inputSchema: {
      type: 'object',
      properties: { id: str('分组 id（必填）') },
      required: ['id'],
      additionalProperties: false,
    },
    annotations: DESTROY,
    handler: async (args, store) => store.deleteHomeGroup(cleanArgs(args).id),
  },
];

const byName = new Map(TOOLS.map((t) => [t.name, t]));

export function toolDescriptors() {
  return TOOLS.map(({ name, title, description, inputSchema, annotations }) => ({
    name,
    title,
    description,
    inputSchema,
    annotations,
  }));
}

export async function callTool(name, args, store) {
  const tool = byName.get(name);
  if (!tool) {
    const err = new Error(`未知工具：${name}`);
    err.code = -32602;
    throw err;
  }
  return tool.handler(args, store);
}

export { TOOLS };
