/**
 * 待办回顾：把一段时间里「已完成」的待办整理成一段日记。
 *
 * 为什么按完成时间而不是截止日期取数：「我今天做完的事」看的是勾选那一刻，
 * 昨天逾期、今天补完的任务也算今天的成果。
 */

import { PRIORITY_LABEL, taskTitle, type Task } from './tasks';
import { dailyTitleOf, dateKey, pad } from './utils';
import { getLang, t } from './i18n';

export type ReviewRange = 'today' | 'week' | 'month';

export const REVIEW_RANGES: ReviewRange[] = ['today', 'week', 'month'];

export const REVIEW_RANGE_LABEL: Record<ReviewRange, string> = {
  today: '今天',
  week: '近 7 天',
  month: '近 30 天',
};

/** 勾选完成的时间；老文件没有 doneAt 时退回 updated */
export function reviewDoneAt(task: Task) {
  return task.doneAt || task.updated;
}

/** 区间起点（含）：今天 = 今天零点；近 7 天 = 六天前的零点 */
export function reviewRangeStart(range: ReviewRange, now = new Date()) {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  start.setDate(start.getDate() - (range === 'today' ? 0 : range === 'week' ? 6 : 29));
  return start;
}

/** 区间内完成的待办，新完成的排在前面 */
export function completedInRange(tasks: Task[], range: ReviewRange, now = new Date()) {
  const start = reviewRangeStart(range, now).getTime();
  return tasks
    .filter((task) => {
      if (task.status !== 'done' || task.deletedAt) return false;
      const at = new Date(reviewDoneAt(task)).getTime();
      return Number.isFinite(at) && at >= start;
    })
    .sort((a, b) => +new Date(reviewDoneAt(b)) - +new Date(reviewDoneAt(a)));
}

export interface ReviewGroup {
  /** 分类名；未分类记为空串 */
  name: string;
  items: Task[];
}

/** 按分类分组：顺序沿用分类表，未分类永远排最后 */
export function groupReviewByCategory(tasks: Task[], order: string[]): ReviewGroup[] {
  const groups = new Map<string, Task[]>();
  for (const task of tasks) {
    const name = task.category || '';
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name)!.push(task);
  }
  const ordered = order.filter((name) => groups.has(name));
  const extra = [...groups.keys()].filter((name) => name && !order.includes(name)).sort();
  const names = [...ordered, ...extra];
  if (groups.has('')) names.push('');
  return names.map((name) => ({ name, items: groups.get(name)! }));
}

/** 同一条待办完成两次（取消再勾选）算两次成果，所以 key 带上完成日期 */
export function reviewExportKey(task: Task) {
  return `${task.id}@${reviewDoneAt(task).slice(0, 10)}`;
}

const EXPORTED_KEY = 'glimnote.task.reviewed';
const EXPORTED_LIMIT = 400;

export function loadExportedKeys(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(EXPORTED_KEY) || '[]');
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

export function saveExportedKeys(keys: string[]) {
  try {
    localStorage.setItem(EXPORTED_KEY, JSON.stringify([...new Set(keys)].slice(-EXPORTED_LIMIT)));
  } catch {
    /* 隐私模式下写不进去，只影响「已导出」标记 */
  }
}

function timeOf(task: Task, range: ReviewRange) {
  const d = new Date(reviewDoneAt(task));
  if (Number.isNaN(d.getTime())) return '';
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (range === 'today') return hm;
  return getLang() === 'en'
    ? `${d.toLocaleString('en-US', { month: 'short', day: 'numeric' })} ${hm}`
    : `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

/** 生成追加到日记里的 Markdown 片段 */
export function buildReviewMarkdown(opts: { groups: ReviewGroup[]; range: ReviewRange; summary?: string; now?: Date }) {
  const now = opts.now || new Date();
  const total = opts.groups.reduce((sum, g) => sum + g.items.length, 0);
  const datePart = dailyTitleOf(dateKey(now));
  const title =
    opts.range === 'today'
      ? t('待办回顾 · {date}', { date: datePart })
      : t('待办回顾 · {date}（{range}）', { date: datePart, range: t(REVIEW_RANGE_LABEL[opts.range]) });
  const sep = getLang() === 'en' ? ', ' : '、';
  const breakdown = opts.groups.map((g) => `${g.name || t('未分类')} ${g.items.length}`).join(sep);
  const doneLine = breakdown
    ? t('完成 {n} 条：{breakdown}', { n: total, breakdown })
    : t('完成 {n} 条', { n: total });
  const lines = [`## ${title}`, '', doneLine, ''];
  for (const group of opts.groups) {
    lines.push(`### ${group.name || t('未分类')}`, '');
    for (const task of group.items) {
      const when = timeOf(task, opts.range);
      lines.push(`- [x] ${taskTitle(task)}${when ? `（${when}）` : ''}`);
    }
    lines.push('');
  }
  if (opts.summary?.trim()) {
    lines.push(`### ${t('小结')}`, '', opts.summary.trim(), '');
  }
  return lines.join('\n');
}

/**
 * 「导出到本地」用的独立 Markdown：不写进日记，也不带 AI 小结，
 * 把勾选条目的完成时间、分类、优先级、标签和备注完整带走，方便存档或发给别人。
 */
export function buildReviewLocalExport(opts: { groups: ReviewGroup[]; range: ReviewRange; now?: Date }) {
  const now = opts.now || new Date();
  const total = opts.groups.reduce((sum, g) => sum + g.items.length, 0);
  const lines = [
    t('# 待办导出 · {date}', { date: dailyTitleOf(dateKey(now)) }),
    '',
    t('范围：{range} · 共 {n} 条', { range: t(REVIEW_RANGE_LABEL[opts.range]), n: total }),
    '',
  ];
  for (const group of opts.groups) {
    lines.push(`## ${group.name || t('未分类')}`, '');
    for (const task of group.items) {
      lines.push(`### ${taskTitle(task)}`, '');
      const meta: string[] = [];
      const when = timeOf(task, opts.range);
      const sep = getLang() === 'en' ? ', ' : '、';
      if (when) meta.push(t('完成 {when}', { when }));
      if (task.priority !== 'normal') meta.push(t('优先级 {level}', { level: t(PRIORITY_LABEL[task.priority]) }));
      if (task.category) meta.push(t('分类 {name}', { name: task.category }));
      if (task.tags.length) meta.push(t('标签 {tags}', { tags: task.tags.join(sep) }));
      if (task.due) meta.push(t('截止 {date}', { date: `${task.due}${task.dueTime ? ` ${task.dueTime}` : ''}` }));
      if (meta.length) lines.push(meta.join(' · '), '');
      const notes = task.notes.trim();
      if (notes) lines.push(notes, '');
    }
  }
  return `${lines.join('\n').trim()}\n`;
}

/** 追加到当天日记：保证标题和上一段之间空一行，读起来不会粘在一起 */
export function appendToDailyNote(existing: string, block: string) {
  const base = existing.replace(/\s+$/, '');
  return `${base}${base ? '\n\n' : ''}${block.trim()}\n`;
}
