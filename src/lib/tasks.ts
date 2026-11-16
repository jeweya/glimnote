import { parseFrontmatter, stripFrontmatter } from './markdown';
import { t } from './i18n';
import { pad, parseDateKey, dateKey } from './utils';

/** 四态：待整理（时间未定）/ 待办 / 跟进中 / 已完成，见 docs/11 4.5 */
export type TaskStatus = 'inbox' | 'todo' | 'doing' | 'done';
/** 未完成的三态；勾选完成时记进 prevStatus，取消完成时还原 */
export type OpenStatus = Exclude<TaskStatus, 'done'>;
export type TaskPriority = 'high' | 'normal' | 'low';

/** 到点提醒可以同时发到这些群机器人；Webhook 地址统一在设置里配置 */
export type TaskNotifyChannel = 'wecom' | 'feishu' | 'dingtalk';

export const TASK_NOTIFY_CHANNELS: TaskNotifyChannel[] = ['wecom', 'feishu', 'dingtalk'];

export const NOTIFY_CHANNEL_LABEL: Record<TaskNotifyChannel, string> = {
  wecom: '企业微信',
  feishu: '飞书',
  dingtalk: '钉钉',
};

/** 手改 frontmatter 可能写成字符串，统一收成去重的合法渠道列表 */
export function normalizeNotifyChannels(value: unknown): TaskNotifyChannel[] {
  const list = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.replace(/^\[|\]$/g, '').split(/[,，\s]+/)
      : [];
  const out: TaskNotifyChannel[] = [];
  for (const item of list) {
    const id = String(item).trim().toLowerCase();
    if ((TASK_NOTIFY_CHANNELS as string[]).includes(id) && !out.includes(id as TaskNotifyChannel)) {
      out.push(id as TaskNotifyChannel);
    }
  }
  return out;
}

export const OPEN_STATUSES: OpenStatus[] = ['inbox', 'todo', 'doing'];

/** 循环频率；循环任务必须有截止日期，下一次由本文件里的算法推导 */
export type TaskRepeat = 'daily' | 'weekly' | 'monthly' | 'yearly';

export const TASK_REPEATS: TaskRepeat[] = ['daily', 'weekly', 'monthly', 'yearly'];

export const REPEAT_LABEL: Record<TaskRepeat, string> = {
  daily: '每天',
  weekly: '每周',
  monthly: '每月',
  yearly: '每年',
};

/** ISO：1=周一 … 7=周日，与保存进文件的口径一致 */
export const WEEKDAY_NAMES = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
export const WEEKDAY_SHORT = ['一', '二', '三', '四', '五', '六', '日'];

/** 提前提醒的固定档位（分钟）；「自定义」另算 */
export const REMIND_BEFORE_PRESETS = [5, 15, 30, 60, 1440] as const;

export const STATUS_LABEL: Record<TaskStatus, string> = {
  inbox: '待整理',
  todo: '待办',
  doing: '跟进中',
  done: '已完成',
};

/** 不变量：待整理 = 时间未定，所以它永远没有截止日期 */
export function normalizeStatus(status: TaskStatus, due?: string): TaskStatus {
  if (status === 'done') return 'done';
  if (status === 'inbox') return due ? 'todo' : 'inbox';
  return status;
}

/**
 * 一条任务 = 一个 Markdown 文件：frontmatter 放结构化字段，正文是备注。
 * 与笔记无关，独立成库（docs/11 方案 C）。
 */
export interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  due?: string;
  /** 具体到分钟的提醒时间 HH:mm；只有设了截止日期的待办才有 */
  dueTime?: string;
  priority: TaskPriority;
  /** 所属分类（工作 / 家庭 …）；空表示未分类。分类本身可增删改，见 lib/taskCategories */
  category?: string;
  /** 到点时额外发送到哪些群机器人；空表示只弹本地提醒 */
  notify?: TaskNotifyChannel[];
  /** 纳入每日云端推送摘要；本机到点提醒与群通知照常，云端只在早上多推一份汇总 */
  cloudPush?: boolean;
  /** 循环规则；缺省表示一次性任务 */
  repeat?: TaskRepeat;
  /** 每隔几个周期一次，默认 1（如每 2 周） */
  repeatEvery?: number;
  /** 周几重复，ISO 1=周一 … 7=周日；仅 weekly 使用 */
  repeatDays?: number[];
  /** 月内第几天，或当月最后一天；仅 monthly（yearly 也用它表示日）使用 */
  repeatDay?: number | 'last';
  /** 年内第几月；仅 yearly 使用 */
  repeatMonth?: number;
  /** 循环结束日期（含当天）；空表示永不结束 */
  repeatUntil?: string;
  /** 同一循环系列共享的 id，用于多端生成同一条下一次 */
  seriesId?: string;
  /** 提前提醒的分钟数，可多档；空表示只到点提醒 */
  remindBefore?: number[];
  /** 仅「跳过本次」写入；完成组里显示为已跳过 */
  skippedAt?: string;
  tags: string[];
  noteId?: string;
  noteTitle?: string;
  created: string;
  updated: string;
  doneAt?: string;
  /** 完成前处于哪一态；取消完成时按它还原 */
  prevStatus?: OpenStatus;
  deletedAt?: string;
  deletedFrom?: string;
  /** 备注正文（frontmatter 之后的内容） */
  notes: string;
  /** 运行时字段：仓库内相对路径，不写回文件 */
  path: string;
  size: number;
  /** 运行时字段：由冲突副本派生出来的 id */
  conflict?: boolean;
  /** 运行时字段：本版本不认识的 frontmatter 原文行，写回时原样保留 */
  extra?: string[];
}

const ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/** 循环系列 id：和任务 id 同一套字符集，便于肉眼区分度与排序 */
export function newSeriesId() {
  return newTaskId();
}

/** 12 位 base36：前 8 位是时间前缀，后 4 位随机 */
export function newTaskId() {
  const time = Date.now().toString(36).padStart(8, '0').slice(-8);
  let rand = '';
  for (let i = 0; i < 4; i += 1) rand += ID_ALPHABET[Math.floor(Math.random() * 36)];
  return `${time}${rand}`;
}

export function taskDirOf(created: string) {
  const d = new Date(created);
  const date = Number.isNaN(d.getTime()) ? new Date() : d;
  return `tasks/${date.getFullYear()}/${pad(date.getMonth() + 1)}`;
}

/** 正常任务的路径可由 created + id 推导；冲突副本以运行时 path 为准 */
export function taskPathOf(created: string, id: string) {
  return `${taskDirOf(created)}/${id}.md`;
}

function cleanTitle(value: string) {
  return value.replace(/\s+/g, ' ').trim();
}

/** 兜底：正文第一行（去掉 Markdown 记号）当标题 */
function titleFromBody(body: string) {
  const line = body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find(Boolean);
  if (!line) return '';
  return cleanTitle(line.replace(/^#{1,6}\s+/, '').replace(/^[-*+]\s+(\[[ xX]\]\s+)?/, ''));
}

export function isTaskConflict(task: Task) {
  return Boolean(task.conflict) || /（冲突副本）|\(冲突副本/.test(task.path);
}

function normalizeRepeat(value: unknown): TaskRepeat | undefined {
  return value === 'daily' || value === 'weekly' || value === 'monthly' || value === 'yearly'
    ? value
    : undefined;
}

/** 间隔限制在 1–99，手改出 0 或负数时按 1 处理 */
export function normalizeRepeatEvery(value: unknown) {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? Math.min(99, Math.max(1, Math.round(n))) : 1;
}

export function normalizeRepeatDays(value: unknown): number[] {
  const list = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[,，\s]+/)
      : [];
  const out: number[] = [];
  for (const item of list) {
    const n = Number(item);
    if (Number.isInteger(n) && n >= 1 && n <= 7 && !out.includes(n)) out.push(n);
  }
  return out.sort((a, b) => a - b);
}

export function normalizeRepeatDay(value: unknown): number | 'last' | undefined {
  if (typeof value === 'string' && value.trim().toLowerCase() === 'last') return 'last';
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 31 ? n : undefined;
}

export function normalizeRepeatMonth(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 12 ? n : undefined;
}

/** 提前提醒分钟数：去重、升序，最多 30 天 */
export function normalizeRemindBefore(value: unknown): number[] {
  const list = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[,，\s]+/)
      : [];
  const out: number[] = [];
  for (const item of list) {
    const n = Number(item);
    if (Number.isInteger(n) && n >= 1 && n <= 30 * 24 * 60 && !out.includes(n)) out.push(n);
  }
  return out.sort((a, b) => a - b);
}

const KNOWN_TASK_KEYS = new Set([
  'id',
  'title',
  'status',
  'due',
  'dueTime',
  'priority',
  'category',
  'notify',
  'cloudPush',
  'tags',
  'noteId',
  'noteTitle',
  'created',
  'updated',
  'doneAt',
  'prevStatus',
  'deletedAt',
  'deletedFrom',
  'repeat',
  'repeatEvery',
  'repeatDays',
  'repeatDay',
  'repeatMonth',
  'repeatUntil',
  'seriesId',
  'remindBefore',
  'skippedAt',
]);

const TASK_FM_RE = /^﻿?---\r?\n([\s\S]*?)\r?\n---/;

/** 收集本版本不认识的 frontmatter 行，避免其他版本/工具写的字段被我们改写时丢掉 */
function extraFrontmatterLines(raw: string) {
  const m = raw.match(TASK_FM_RE);
  if (!m) return undefined;
  const out: string[] = [];
  for (const line of m[1].split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    if (key && !KNOWN_TASK_KEYS.has(key) && line.trim()) out.push(line.trimEnd());
  }
  return out.length ? out : undefined;
}

/** 解析一个任务文件；缺字段时尽量兜底，不抛异常 */
export function parseTask(path: string, raw: string, fallbackTime = new Date().toISOString()): Task {
  const fm = parseFrontmatter(raw);
  const body = stripFrontmatter(raw);
  const fileName = (path.split('/').pop() || '').replace(/\.md$/, '');
  const id = typeof fm.id === 'string' && fm.id.trim() ? fm.id.trim() : fileName;
  const rawTitle = typeof fm.title === 'string' ? cleanTitle(fm.title) : '';
  const created = typeof fm.created === 'string' && fm.created ? fm.created : fallbackTime;
  const updated = typeof fm.updated === 'string' && fm.updated ? fm.updated : created;
  const due = typeof fm.due === 'string' && parseDateKey(fm.due) ? fm.due.slice(0, 10) : undefined;
  const rawTime = typeof fm.dueTime === 'string' ? fm.dueTime.trim() : '';
  // 日期被清掉或时间格式不对时，提醒时间也一并当作没有
  let dueTime = due && /^([01]\d|2[0-3]):[0-5]\d$/.test(rawTime) ? rawTime : undefined;
  const priority: TaskPriority =
    fm.priority === 'high' || fm.priority === 'low' || fm.priority === 'normal'
      ? (fm.priority as TaskPriority)
      : 'normal';
  // 手改过 / 旧版本的文件可能带未知状态：当作待办，不让它从列表里消失
  const rawStatus: TaskStatus =
    fm.status === 'inbox' || fm.status === 'todo' || fm.status === 'doing' || fm.status === 'done'
      ? (fm.status as TaskStatus)
      : 'todo';
  const prevStatus: OpenStatus | undefined =
    fm.prevStatus === 'inbox' || fm.prevStatus === 'todo' || fm.prevStatus === 'doing'
      ? (fm.prevStatus as OpenStatus)
      : undefined;
  const notify = normalizeNotifyChannels(fm.notify);
  const cloudPush = fm.cloudPush === true || fm.cloudPush === 'true';
  const repeat = normalizeRepeat(fm.repeat);
  // 全天循环任务默认 09:00 提醒；手写的旧文件也按这个口径显示与调度
  if (due && !dueTime && repeat) dueTime = '09:00';
  const repeatDays = normalizeRepeatDays(fm.repeatDays);
  const repeatDay = normalizeRepeatDay(fm.repeatDay);
  const repeatMonth = normalizeRepeatMonth(fm.repeatMonth);
  const remindBefore = normalizeRemindBefore(fm.remindBefore);
  return {
    id,
    title: rawTitle || titleFromBody(body),
    status: normalizeStatus(rawStatus, due),
    due,
    dueTime,
    priority,
    category:
      typeof fm.category === 'string' && fm.category.trim()
        ? fm.category
            .replace(/[\[\]\n\r]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 16)
        : undefined,
    notify: notify.length ? notify : undefined,
    cloudPush: cloudPush || undefined,
    ...(repeat
      ? {
          repeat,
          repeatEvery: normalizeRepeatEvery(fm.repeatEvery),
          repeatDays: repeat === 'weekly' && repeatDays.length ? repeatDays : undefined,
          repeatDay: repeat === 'monthly' || repeat === 'yearly' ? repeatDay : undefined,
          repeatMonth: repeat === 'yearly' ? repeatMonth : undefined,
          repeatUntil:
            typeof fm.repeatUntil === 'string' && parseDateKey(fm.repeatUntil)
              ? fm.repeatUntil.slice(0, 10)
              : undefined,
          // 手工写的循环文件可能没有 seriesId：用任务 id 兜底，保证多端推导一致
          seriesId:
            typeof fm.seriesId === 'string' && fm.seriesId.trim()
              ? fm.seriesId.trim().slice(0, 32)
              : id,
        }
      : {}),
    remindBefore: remindBefore.length ? remindBefore : undefined,
    skippedAt: typeof fm.skippedAt === 'string' && fm.skippedAt ? fm.skippedAt : undefined,
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
    conflict: /（冲突副本）|\(冲突副本/.test(fileName) || undefined,
    extra: extraFrontmatterLines(raw),
  };
}

/** 序列化为任务文件；字段顺序固定，diff 才好读 */
export function buildTaskFile(task: Task) {
  const meta: string[] = [
    '---',
    `id: ${task.id}`,
    `title: ${cleanTitle(task.title).replace(/\n/g, ' ')}`,
    `status: ${task.status}`,
  ];
  if (task.due) meta.push(`due: ${task.due}`);
  if (task.due && task.dueTime) meta.push(`dueTime: ${task.dueTime}`);
  meta.push(`priority: ${task.priority}`);
  // 分类放在标签前：粗分在前、细分在后，读 frontmatter 时顺序也符合直觉
  if (task.category) meta.push(`category: ${cleanTitle(task.category).slice(0, 16)}`);
  if (task.notify?.length) meta.push(`notify: [${task.notify.join(', ')}]`);
  if (task.cloudPush) meta.push('cloudPush: true');
  if (task.repeat) {
    meta.push(`repeat: ${task.repeat}`);
    if ((task.repeatEvery ?? 1) > 1) meta.push(`repeatEvery: ${task.repeatEvery}`);
    if (task.repeat === 'weekly' && task.repeatDays?.length) {
      meta.push(`repeatDays: ${task.repeatDays.join(',')}`);
    }
    if ((task.repeat === 'monthly' || task.repeat === 'yearly') && task.repeatDay !== undefined) {
      meta.push(`repeatDay: ${task.repeatDay}`);
    }
    if (task.repeat === 'yearly' && task.repeatMonth) meta.push(`repeatMonth: ${task.repeatMonth}`);
    if (task.repeatUntil) meta.push(`repeatUntil: ${task.repeatUntil}`);
    if (task.seriesId) meta.push(`seriesId: ${task.seriesId}`);
  }
  if (task.remindBefore?.length) meta.push(`remindBefore: ${task.remindBefore.join(',')}`);
  if (task.skippedAt) meta.push(`skippedAt: ${task.skippedAt}`);
  if (task.tags.length) meta.push(`tags: [${task.tags.map((t) => t.replace(/[,\]]/g, ' ')).join(', ')}]`);
  if (task.noteId) meta.push(`noteId: ${task.noteId}`);
  if (task.noteTitle) meta.push(`noteTitle: ${cleanTitle(task.noteTitle).replace(/\n/g, ' ')}`);
  meta.push(`created: ${task.created}`, `updated: ${task.updated}`);
  if (task.doneAt) meta.push(`doneAt: ${task.doneAt}`);
  if (task.status === 'done' && task.prevStatus) meta.push(`prevStatus: ${task.prevStatus}`);
  if (task.deletedAt) meta.push(`deletedAt: ${task.deletedAt}`);
  if (task.deletedFrom) meta.push(`deletedFrom: ${task.deletedFrom}`);
  // 未知字段原样保留，避免别的版本或手工加的自定义字段被这次保存吃掉
  for (const line of task.extra || []) {
    const key = line.slice(0, line.indexOf(':')).trim();
    if (key && !KNOWN_TASK_KEYS.has(key)) meta.push(line);
  }
  meta.push('---', '');
  return meta.join('\n') + task.notes.replace(/^\n+/, '');
}

export function newTask(title = ''): Task {
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

/* ---------- 循环任务：日期推导 ---------- */

const DAY_MS = 86400000;

function weekdayIso(d: Date) {
  return ((d.getDay() + 6) % 7) + 1;
}

function mondayOf(d: Date) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - (weekdayIso(x) - 1));
  return x;
}

function addDaysKey(key: string, days: number) {
  const d = parseDateKey(key);
  if (!d) return key;
  d.setDate(d.getDate() + days);
  return dateKey(d);
}

function daysInMonth(year: number, month0: number) {
  return new Date(year, month0 + 1, 0).getDate();
}

function makeDateKey(year: number, month0: number, day: number) {
  return dateKey(new Date(year, month0, Math.min(day, daysInMonth(year, month0))));
}

/** 从 cursor 往后走一个周期；weekly 的「每 N 周」始终以原始截止日所在周为锚点，避免多次推进后漂移 */
function stepRepeat(task: Task, cursorKey: string, anchorKey: string, every: number): string | null {
  if (task.repeat === 'daily') return addDaysKey(cursorKey, every);

  if (task.repeat === 'weekly') {
    const cursor = parseDateKey(cursorKey);
    const anchor = parseDateKey(anchorKey);
    if (!cursor || !anchor) return null;
    const days = task.repeatDays?.length ? task.repeatDays : [weekdayIso(anchor)];
    const anchorMonday = mondayOf(anchor);
    // 最多找 4 个周期，足够覆盖「一周只选一天 + 间隔较大」的情况
    for (let i = 1; i <= 7 * every * 4 + 21; i += 1) {
      const key = addDaysKey(cursorKey, i);
      const d = parseDateKey(key);
      if (!d || !days.includes(weekdayIso(d))) continue;
      if (every > 1) {
        const weeks = Math.round((mondayOf(d).getTime() - anchorMonday.getTime()) / DAY_MS / 7);
        if (weeks % every !== 0) continue;
      }
      return key;
    }
    return null;
  }

  if (task.repeat === 'monthly') {
    const cursor = parseDateKey(cursorKey);
    const anchor = parseDateKey(anchorKey);
    if (!cursor || !anchor) return null;
    const target = task.repeatDay ?? anchor.getDate();
    for (let i = 1; i <= 240; i += 1) {
      const base = new Date(cursor.getFullYear(), cursor.getMonth() + every * i, 1);
      const day = target === 'last' ? daysInMonth(base.getFullYear(), base.getMonth()) : target;
      const key = makeDateKey(base.getFullYear(), base.getMonth(), day);
      if (key > cursorKey) return key;
    }
    return null;
  }

  if (task.repeat === 'yearly') {
    const cursor = parseDateKey(cursorKey);
    const anchor = parseDateKey(anchorKey);
    if (!cursor || !anchor) return null;
    const month0 = (task.repeatMonth ?? anchor.getMonth() + 1) - 1;
    const target = task.repeatDay ?? anchor.getDate();
    for (let i = 1; i <= 200; i += 1) {
      const year = cursor.getFullYear() + every * i;
      const day = target === 'last' ? daysInMonth(year, month0) : target;
      const key = makeDateKey(year, month0, day);
      if (key > cursorKey) return key;
    }
    return null;
  }

  return null;
}

/**
 * 下一次截止日：严格晚于当前这次，且不早于今天（逾期很久的任务完成后直接跳到未来）。
 * repeatUntil 之后不再生成，返回 null。
 */
export function nextRepeatDate(task: Task, fromKey = task.due, today = new Date()): string | null {
  if (!task.repeat || !fromKey) return null;
  if (!parseDateKey(fromKey)) return null;
  const every = normalizeRepeatEvery(task.repeatEvery);
  const todayKey = dateKey(today);
  let cursor = fromKey;
  for (let guard = 0; guard < 10000; guard += 1) {
    const next = stepRepeat(task, cursor, fromKey, every);
    if (!next) return null;
    if (task.repeatUntil && next > task.repeatUntil) return null;
    cursor = next;
    if (cursor >= todayKey) return cursor;
  }
  return cursor;
}

const WEEKDAY_PREFIX = ['', '一', '二', '三', '四', '五', '六', '日'];

/** 「每周一、三、五」「每月 15 日」「每年 3 月 10 日」 */
export function repeatSummary(task: Task): string {
  if (!task.repeat) return '';
  const every = normalizeRepeatEvery(task.repeatEvery);

  if (task.repeat === 'daily') {
    return every > 1 ? `每 ${every} 天` : '每天';
  }

  if (task.repeat === 'weekly') {
    const dueDate = task.due ? parseDateKey(task.due) : null;
    const days = task.repeatDays?.length
      ? task.repeatDays
      : dueDate
        ? [weekdayIso(dueDate)]
        : [];
    if (!days.length) return every > 1 ? `每 ${every} 周` : '每周';
    if (every > 1) return `每 ${every} 周的${days.map((d) => WEEKDAY_NAMES[d - 1]).join('、')}`;
    return `每周${days.map((d) => WEEKDAY_PREFIX[d]).join('、')}`;
  }

  if (task.repeat === 'monthly') {
    const dueDate = task.due ? parseDateKey(task.due) : null;
    const day = task.repeatDay ?? dueDate?.getDate();
    const dayText = day === 'last' ? '最后一天' : day ? `${day} 日` : '';
    if (every > 1) return `每 ${every} 月的${dayText}`;
    if (day === 'last') return '每月最后一天';
    return dayText ? `每月 ${dayText}` : '每月';
  }

  const dueDate = task.due ? parseDateKey(task.due) : null;
  const month = task.repeatMonth ?? (dueDate ? dueDate.getMonth() + 1 : 1);
  const day = task.repeatDay ?? (dueDate ? dueDate.getDate() : 1);
  const dayText = day === 'last' ? '最后一天' : `${day} 日`;
  const body = `${month} 月 ${dayText}`;
  return every > 1 ? `每 ${every} 年的 ${body}` : `每年 ${body}`;
}

/** 12 位 base36 的确定性 id：系列 + 下一次日期相同，多端就会落到同一个文件 */
function stableId(input: string) {
  let a = 0x811c9dc5;
  let b = 0x9e3779b9;
  for (let i = 0; i < input.length; i += 1) {
    const c = input.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x85ebca6b);
  }
  const n = (BigInt(a >>> 0) << 32n) | BigInt(b >>> 0);
  return n.toString(36).padStart(12, '0').slice(-12);
}

/**
 * 由完成的那次派生下一次：保留规则、分类、标签与备注，换日期、换 id。
 * seriesId 缺省时用当前 id 兜底，保证同一文件在不同设备推导出同一个系列。
 */
export function buildNextRepeatTask(task: Task, nextDue: string): Task {
  const now = new Date().toISOString();
  const seriesId = task.seriesId || task.id;
  const id = stableId(`${seriesId}:${nextDue}`);
  return {
    ...task,
    id,
    status: 'todo',
    due: nextDue,
    dueTime: task.dueTime || '09:00',
    seriesId,
    created: now,
    updated: now,
    doneAt: undefined,
    prevStatus: undefined,
    skippedAt: undefined,
    deletedAt: undefined,
    deletedFrom: undefined,
    conflict: undefined,
    extra: undefined,
    path: taskPathOf(now, id),
    size: 0,
  };
}

/** 「11 月 18 日（周二）」 */
export function shortDateWithWeekday(key: string) {
  const d = parseDateKey(key);
  if (!d) return key;
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日（${WEEKDAY_NAMES[weekdayIso(d) - 1]}）`;
}

/** 「15 分钟」「1 小时」「1 天」 */
export function remindBeforeLabel(minutes: number) {
  if (minutes % 1440 === 0) return `${minutes / 1440} 天`;
  if (minutes % 60 === 0) return `${minutes / 60} 小时`;
  return `${minutes} 分钟`;
}

/**
 * 把一次改动落到任务上，同时维持「待整理 = 时间未定」这条不变量：
 * 设为待整理 → 清空日期并提示；在待整理上定日期 → 自动升为待办。
 */
export function applyTaskPatch(task: Task, patch: Partial<Task>): { next: Task; notice?: string } {
  let next: Task = { ...task, ...patch };
  let notice: string | undefined;
  if (patch.status === 'inbox') {
    if (next.due) {
      // 日期没了，提醒时间也不能留着，否则会变成一条永远不响的提醒
      next = { ...next, due: undefined, dueTime: undefined };
      notice = '待整理不设截止日期，已清空日期';
    }
  } else if (patch.due && next.status === 'inbox') {
    next = { ...next, status: 'todo' };
  }
  if ('due' in patch && !patch.due && next.dueTime) {
    next = { ...next, dueTime: undefined };
  }
  return { next, notice };
}

const PRIORITY_RANK: Record<TaskPriority, number> = { high: 0, normal: 1, low: 2 };

export const PRIORITY_LABEL: Record<TaskPriority, string> = {
  high: '高',
  normal: '普通',
  low: '低',
};

export function taskTitle(task: Task) {
  return task.title || t('未命名待办');
}

export function todayStart(now = new Date()) {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

export function dayDiff(due: string, now = new Date()) {
  const d = parseDateKey(due);
  if (!d) return NaN;
  return Math.round((d.getTime() - todayStart(now).getTime()) / 86400000);
}

/** 「已过期 3 天 / 今天 / 明天 / 周五 / 11-12 / 2027-01-05」 */
export function dueLabel(due: string, now = new Date()) {
  const diff = dayDiff(due, now);
  if (!Number.isFinite(diff)) return '';
  if (diff < 0) return t('已过期 {n} 天', { n: -diff });
  if (diff === 0) return t('今天');
  if (diff === 1) return t('明天');
  const d = parseDateKey(due)!;
  const weekEnd = new Date(todayStart(now));
  // 周一为一周起点：距离本周日还有几天
  const toSunday = (7 - ((now.getDay() + 6) % 7) - 1 + 7) % 7;
  weekEnd.setDate(weekEnd.getDate() + toSunday);
  if (d.getTime() <= weekEnd.getTime()) {
    return t(['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()]);
  }
  if (d.getFullYear() === now.getFullYear()) {
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function dueFullLabel(due: string | undefined, dueTime?: string) {
  if (!due) return t('无日期');
  const d = parseDateKey(due);
  if (!d) return t('无日期');
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${t(['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()])}`;
  return isTimeKey(dueTime) ? `${date} ${dueTime}` : date;
}

/** 「近 7 天」的终点：今天 + 6 天的零点（含今天正好 7 天），和筛选 chip 的口径一致 */
export function nearWeekEndOf(now = new Date()) {
  const end = todayStart(now);
  end.setDate(end.getDate() + 6);
  return end;
}

/** 「近 1 月」的终点：今天往后翻一个月的零点（含今天到同一天） */
export function nearMonthEndOf(now = new Date()) {
  const end = todayStart(now);
  end.setMonth(end.getMonth() + 1);
  return end;
}

export interface TaskGroups {
  overdue: Task[];
  today: Task[];
  week: Task[];
  month: Task[];
  later: Task[];
  someday: Task[];
  inbox: Task[];
  /** 最近 14 天的完成项，供导出沿用旧口径；列表展示改用 completedTasks() */
  done: Task[];
  /** 全部已完成数量（不受 14 天窗口限制），折叠组头上显示它 */
  doneTotal: number;
  /** 最近 14 天完成数，给「都做完了」空态用 */
  doneRecent: number;
}

/** 未完成且未删除的「活任务」，筛选与计数都以它为底 */
export function isOpenTask(task: Task) {
  return task.status !== 'done' && !task.deletedAt;
}

/** 有没有合法的 HH:mm；表单与解析共用一套规则 */
export function isTimeKey(value: string | undefined) {
  return Boolean(value && /^([01]\d|2[0-3]):[0-5]\d$/.test(value));
}

/**
 * 快速录入时允许把时间写在结尾：「交周报 18:00」。
 * 只认整串末尾的合法时间，标题里正常出现的数字不会被误吞。
 */
export function parseQuickTaskInput(raw: string) {
  const text = raw.trim();
  const m = /(^|\s)([01]?\d|2[0-3]):([0-5]\d)$/.exec(text);
  if (!m) return { title: text };
  const title = text.slice(0, m.index).trim();
  if (!title) return { title: text };
  return { title, dueTime: `${pad(Number(m[2]))}:${m[3]}` };
}

/**
 * 到点提醒的绝对时间。只有「日期 + 时间」都齐全才返回；
 * 只设日期不设时间的待办不猜时间，避免在用户没约定的时刻打扰。
 */
export function taskDueAt(task: Task): Date | null {
  if (!task.due || !isTimeKey(task.dueTime)) return null;
  const d = parseDateKey(task.due);
  if (!d) return null;
  const [h, m] = task.dueTime!.split(':').map(Number);
  d.setHours(h, m, 0, 0);
  return d;
}

/** 同一天里按提醒时间排，没设时间的排在当天最后 */
function sortDueMs(task: Task) {
  if (!task.due) return Infinity;
  const d = parseDateKey(task.due);
  if (!d) return Infinity;
  const at = taskDueAt(task);
  return at ? at.getTime() : d.getTime() + 86399999;
}

function sortGroup(list: Task[]) {
  return [...list].sort((a, b) => {
    const da = sortDueMs(a);
    const db = sortDueMs(b);
    if (da !== db) return da - db;
    const pa = PRIORITY_RANK[a.priority] ?? 1;
    const pb = PRIORITY_RANK[b.priority] ?? 1;
    if (pa !== pb) return pa - pb;
    return +new Date(b.created) - +new Date(a.created);
  });
}

const DONE_WINDOW = 14 * 86400000;

/** 已过期 / 今天 / 7 天内 / 1 个月内 / 以后 / 无日期 / 待整理 / 已完成 */
export function groupTasks(tasks: Task[], now = new Date()): TaskGroups {
  const today = todayStart(now);
  const weekEnd = nearWeekEndOf(now);
  const monthEnd = nearMonthEndOf(now);
  const groups: TaskGroups = {
    overdue: [],
    today: [],
    week: [],
    month: [],
    later: [],
    someday: [],
    inbox: [],
    done: [],
    doneTotal: 0,
    doneRecent: 0,
  };
  const recentDone: Task[] = [];
  for (const task of tasks) {
    if (task.deletedAt) continue;
    if (task.status === 'done') {
      groups.doneTotal += 1;
      const t = Date.parse(task.doneAt || task.updated);
      if (!Number.isFinite(t) || now.getTime() - t <= DONE_WINDOW) {
        groups.doneRecent += 1;
        // 导出只带最近 200 条，避免几千条完成记录把 Markdown 撑得没法读
        if (recentDone.length < 200) recentDone.push(task);
      }
      continue;
    }
    if (!task.due || !parseDateKey(task.due)) {
      if (task.status === 'inbox') groups.inbox.push(task);
      else groups.someday.push(task);
      continue;
    }
    const d = parseDateKey(task.due)!.getTime();
    if (d < today.getTime()) groups.overdue.push(task);
    else if (d === today.getTime()) groups.today.push(task);
    else if (d <= weekEnd.getTime()) groups.week.push(task);
    else if (d <= monthEnd.getTime()) groups.month.push(task);
    else groups.later.push(task);
  }
  recentDone.sort((a, b) => doneMsOf(b) - doneMsOf(a));
  groups.done = recentDone;
  (['overdue', 'today', 'week', 'month', 'later', 'someday', 'inbox'] as const).forEach((k) => {
    groups[k] = sortGroup(groups[k]);
  });
  return groups;
}

/* ---------- 已完成：区间、按天分组（列表展示用） ---------- */

export type DoneRange = '7d' | '30d' | 'all';

export const DONE_RANGES: DoneRange[] = ['7d', '30d', 'all'];

export const DONE_RANGE_LABEL: Record<DoneRange, string> = {
  '7d': '近 7 天',
  '30d': '近 30 天',
  all: '全部',
};

const DONE_RANGE_KEY = 'glimnote.todo.doneRange';

/** 记住用户上次选的完成区间；默认近 30 天，既不淹没列表，也不至于什么都看不到 */
export function loadDoneRange(): DoneRange {
  try {
    const value = localStorage.getItem(DONE_RANGE_KEY);
    return value === '7d' || value === '30d' || value === 'all' ? value : '30d';
  } catch {
    return '30d';
  }
}

export function saveDoneRange(range: DoneRange) {
  try {
    localStorage.setItem(DONE_RANGE_KEY, range);
  } catch {
    /* 隐私模式下 localStorage 可能不可写，区间退回默认即可 */
  }
}

/** 完成时间毫秒；旧文件没有 doneAt 就退回 updated */
export function doneMsOf(task: Task) {
  const t = Date.parse(task.doneAt || task.updated);
  return Number.isFinite(t) ? t : NaN;
}

/** 分组的完成时刻 HH:mm；没有可用时间就不显示 */
export function doneTimeLabel(task: Task) {
  const ms = doneMsOf(task);
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function doneCutoff(range: DoneRange, now: Date) {
  if (range === 'all') return -Infinity;
  return now.getTime() - (range === '7d' ? 7 : 30) * 86400000;
}

function inDoneRange(task: Task, range: DoneRange, now: Date) {
  const ms = doneMsOf(task);
  // 时间字段损坏的旧文件宁可显示出来，也不能悄悄吞掉一条完成记录
  return !Number.isFinite(ms) || ms >= doneCutoff(range, now);
}

/** 已完成任务：默认按完成时间新→旧；列表只在展开后调用 */
export function completedTasks(tasks: Task[], range: DoneRange, now = new Date()) {
  return tasks
    .filter((t) => !t.deletedAt && t.status === 'done' && inDoneRange(t, range, now))
    .sort((a, b) => {
      const am = doneMsOf(a);
      const bm = doneMsOf(b);
      if (!Number.isFinite(am) && !Number.isFinite(bm)) return 0;
      if (!Number.isFinite(am)) return 1;
      if (!Number.isFinite(bm)) return -1;
      return bm - am;
    });
}

/** 三个区间各有多少条，给切换按钮上的数字用 */
export function doneRangeCounts(tasks: Task[], now = new Date()): Record<DoneRange, number> {
  const counts: Record<DoneRange, number> = { '7d': 0, '30d': 0, all: 0 };
  for (const task of tasks) {
    if (task.deletedAt || task.status !== 'done') continue;
    counts.all += 1;
    if (inDoneRange(task, '30d', now)) counts['30d'] += 1;
    if (inDoneRange(task, '7d', now)) counts['7d'] += 1;
  }
  return counts;
}

export interface DoneDayGroup {
  /** 本地日期键；时间字段不可用时为 unknown */
  key: string;
  label: string;
  /** 组内最新一条的完成时刻，用于组排序；unknown 为 -Infinity */
  ms: number;
  items: Task[];
}

const DONE_WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/**
 * 按「完成日」分组：今天 / 昨天 / 10月28日 周三。
 * 上千条完成记录按天折叠后，扫起来像一份工作日志，也不会一次铺满屏幕。
 */
export function groupDoneByDay(tasks: Task[], now = new Date()): DoneDayGroup[] {
  const today = todayStart(now).getTime();
  const map = new Map<string, DoneDayGroup>();
  for (const task of tasks) {
    const ms = doneMsOf(task);
    let key = 'unknown';
    let label = '时间未知';
    let groupMs = -Infinity;
    if (Number.isFinite(ms)) {
      const d = new Date(ms);
      key = dateKey(d);
      const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
      const diff = Math.round((today - dayStart) / 86400000);
      const date = `${d.getMonth() + 1}月${d.getDate()}日`;
      if (diff === 0) label = '今天';
      else if (diff === 1) label = '昨天';
      else if (d.getFullYear() !== now.getFullYear()) label = `${d.getFullYear()}年${date}`;
      else label = `${date} ${DONE_WEEKDAYS[d.getDay()]}`;
      groupMs = dayStart;
    }
    const group = map.get(key);
    if (group) group.items.push(task);
    else map.set(key, { key, label, ms: groupMs, items: [task] });
  }
  return [...map.values()].sort((a, b) => b.ms - a.ms);
}

export function overdueCount(tasks: Task[], now = new Date()) {
  const today = todayStart(now).getTime();
  return tasks.filter((t) => isOpenTask(t) && t.due && parseDateKey(t.due) && parseDateKey(t.due)!.getTime() < today)
    .length;
}

/* ---------- 筛选（docs/11 6.5）：时间 × 状态，两个维度取交集 ---------- */

export type TaskTimeFilter = 'all' | 'today' | 'week' | 'month' | 'overdue';
export type TaskStatusFilter = 'all' | OpenStatus;

export interface TaskFilter {
  time: TaskTimeFilter;
  status: TaskStatusFilter;
}

export function isFilterActive(filter: TaskFilter) {
  return filter.time !== 'all' || filter.status !== 'all';
}

const TIME_END = {
  today: (now: Date) => todayStart(now).getTime(),
  week: (now: Date) => nearWeekEndOf(now).getTime(),
  month: (now: Date) => nearMonthEndOf(now).getTime(),
} as const;

/** 时间维度：今天 = 当天到期；近 7 天 / 近 1 月为「含今天」的滚动区间；已过期 = 到期日早于今天 */
export function matchTimeFilter(task: Task, filter: TaskTimeFilter, now = new Date()) {
  if (filter === 'all') return true;
  if (!task.due) return false;
  const d = parseDateKey(task.due);
  if (!d) return false;
  const today = todayStart(now).getTime();
  if (filter === 'overdue') return d.getTime() < today;
  const end = TIME_END[filter](now);
  return d.getTime() >= today && d.getTime() <= end;
}

export function matchStatusFilter(task: Task, filter: TaskStatusFilter) {
  return filter === 'all' || task.status === filter;
}

/** 只看未完成的任务：筛选永远不含已完成（已完成的去底部折叠组看） */
export function filterTasks(tasks: Task[], filter: TaskFilter, now = new Date()) {
  return tasks.filter(
    (t) => isOpenTask(t) && matchTimeFilter(t, filter.time, now) && matchStatusFilter(t, filter.status),
  );
}

export type TimeFilterCounts = Record<TaskTimeFilter, number>;
export type StatusFilterCounts = Record<TaskStatusFilter, number>;

/** 计数是「结果预览」：在当前另一维度的选择下，点它会得到多少条 */
export function timeFilterCounts(tasks: Task[], status: TaskStatusFilter = 'all', now = new Date()): TimeFilterCounts {
  const base = tasks.filter((t) => isOpenTask(t) && matchStatusFilter(t, status));
  const counts: TimeFilterCounts = { all: base.length, today: 0, week: 0, month: 0, overdue: 0 };
  for (const task of base) {
    (['today', 'week', 'month', 'overdue'] as const).forEach((f) => {
      if (matchTimeFilter(task, f, now)) counts[f] += 1;
    });
  }
  return counts;
}

export function statusFilterCounts(tasks: Task[], time: TaskTimeFilter = 'all', now = new Date()): StatusFilterCounts {
  const base = tasks.filter((t) => isOpenTask(t) && matchTimeFilter(t, time, now));
  const counts: StatusFilterCounts = { all: base.length, inbox: 0, todo: 0, doing: 0 };
  for (const task of base) {
    if (task.status === 'inbox' || task.status === 'todo' || task.status === 'doing') counts[task.status] += 1;
  }
  return counts;
}

export const TIME_FILTER_LABEL: Record<TaskTimeFilter, string> = {
  all: '全部',
  today: '今天',
  week: '近7天',
  month: '近1月',
  overdue: '已过期',
};

export function matchTask(task: Task, query: string) {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const haystack = [task.title, task.notes, task.noteTitle || '', ...task.tags].join('\n').toLowerCase();
  return haystack.includes(q);
}

export function parseTagsInput(raw: string) {
  return [
    ...new Set(
      raw
        .split(/[,，\s]+/)
        .map((t) => t.trim().replace(/^#/, '').slice(0, 20))
        .filter(Boolean),
    ),
  ];
}

/** 导出为 Markdown 清单：按分组排列，完成后加 x */
export function exportTasksMarkdown(tasks: Task[], now = new Date()) {
  const groups = groupTasks(tasks, now);
  const sections: { label: string; list: Task[] }[] = [
    { label: '已过期', list: groups.overdue },
    { label: '今天', list: groups.today },
    { label: '7 天内', list: groups.week },
    { label: '1 个月内', list: groups.month },
    { label: '以后', list: groups.later },
    { label: '无日期', list: groups.someday },
    { label: '待整理', list: groups.inbox },
    { label: '已完成', list: groups.done },
  ];
  const lines = [`# 待办清单 · ${dateKey(now)}`, ''];
  for (const section of sections) {
    if (!section.list.length) continue;
    lines.push(`## ${section.label}`, '');
    for (const task of section.list) {
      const extras: string[] = [];
      if (task.due) extras.push(`截止 ${task.due}`);
      if (task.status === 'doing') extras.push(STATUS_LABEL.doing);
      if (task.priority !== 'normal') extras.push(PRIORITY_LABEL[task.priority]);
      if (task.noteTitle) extras.push(`关联 ${task.noteTitle}`);
      const suffix = extras.length ? ` · ${extras.join(' · ')}` : '';
      lines.push(`- [${task.status === 'done' ? 'x' : ' '}] ${taskTitle(task)}${suffix}`);
    }
    lines.push('');
  }
  if (lines.length <= 2) lines.push('（暂无待办）', '');
  return lines.join('\n');
}
