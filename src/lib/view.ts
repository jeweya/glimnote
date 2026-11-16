import type { Note } from './markdown';
import { searchNotes } from './search';
import { t } from './i18n';

export type View = { type: 'notebook' | 'smart' | 'trash'; value: string };

export const SMART_LABELS: Record<string, { label: string; sub: string }> = {
  home: { label: '首页', sub: '快捷入口与今天的概况' },
  all: { label: '全部笔记', sub: '所有笔记本中的内容' },
  pinned: { label: '置顶', sub: '你标记为重要的笔记' },
  ideas: { label: '灵感', sub: '随手记下的碎片，整理后变成笔记或待办' },
  todo: { label: '待办', sub: '独立的任务清单，按截止日期整理' },
  images: { label: '含图片', sub: '正文里插入过图片的笔记' },
  recent: { label: '最近 7 天', sub: '一周内修改过的笔记' },
  calendar: { label: '日历', sub: '按月查看日记与当天记录' },
  timeline: { label: '时间轴', sub: '按修改时间倒序分组' },
};

export function sortNotes(notes: Note[]) {
  return [...notes].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return +new Date(b.updated) - +new Date(a.updated);
  });
}

/** 首页不是笔记列表：中栏 / 右栏由 HomePage 整块接管 */
export function isHomeView(view: View) {
  return view.type === 'smart' && view.value === 'home';
}

export function isCalendarView(view: View) {
  return view.type === 'smart' && view.value === 'calendar';
}

export function isTimelineView(view: View) {
  return view.type === 'smart' && view.value === 'timeline';
}

export function isTodoView(view: View) {
  return view.type === 'smart' && view.value === 'todo';
}

export function isIdeasView(view: View) {
  return view.type === 'smart' && view.value === 'ideas';
}

export function visibleNotes(notes: Note[], view: View, query: string) {
  if (view.type === 'trash') return [];
  if (isHomeView(view)) return [];
  if (isCalendarView(view)) return [];
  // 待办是独立任务库，不能按「笔记正文里有 - [ ]」来筛
  if (isTodoView(view)) return [];
  // 灵感同样是独立的库，由 IdeasPanel 整块接管
  if (isIdeasView(view)) return [];
  let pool = notes;
  if (view.type === 'notebook') {
    if (view.value && view.value !== 'all') {
      pool = pool.filter((n) => n.notebook === view.value || n.notebook.startsWith(`${view.value}/`));
    }
  } else if (view.type === 'smart') {
    if (view.value === 'pinned') pool = pool.filter((n) => n.pinned);
    else if (view.value === 'todo') pool = pool.filter((n) => /-\s\[ \]/.test(n.content));
    else if (view.value === 'images') pool = pool.filter((n) => /!\[[^\]]*\]\([^)]*\)/.test(n.content));
    else if (view.value === 'recent') {
      const cutoff = Date.now() - 7 * 86400000;
      pool = pool.filter((n) => +new Date(n.updated) >= cutoff);
    }
  }
  const q = query.trim();
  if (q) {
    const hits = searchNotes(pool, q);
    return isTimelineView(view) ? byUpdated(hits) : hits;
  }
  // 时间轴按时间排，置顶不插队，否则分组会乱
  return isTimelineView(view) ? byUpdated(pool) : sortNotes(pool);
}

function byUpdated(notes: Note[]) {
  return [...notes].sort((a, b) => +new Date(b.updated) - +new Date(a.updated));
}

export interface TimelineGroup {
  label: string;
  notes: Note[];
}

function startOfDay(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** 今天 / 昨天 / 本周 / 本月 / 更早（周一为一周起点） */
export function groupByTimeline(notes: Note[]): TimelineGroup[] {
  const today = startOfDay(new Date());
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const weekStart = new Date(today);
  weekStart.setDate(today.getDate() - ((today.getDay() + 6) % 7));
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);

  const buckets = [
    { label: '今天', from: +today, notes: [] as Note[] },
    { label: '昨天', from: +yesterday, notes: [] as Note[] },
    { label: '本周', from: +weekStart, notes: [] as Note[] },
    { label: '本月', from: +monthStart, notes: [] as Note[] },
    { label: '更早', from: -Infinity, notes: [] as Note[] },
  ];
  for (const n of byUpdated(notes)) {
    const t = +new Date(n.updated);
    const bucket = buckets.find((b) => t >= b.from) || buckets[buckets.length - 1];
    bucket.notes.push(n);
  }
  return buckets.filter((b) => b.notes.length).map(({ label, notes: list }) => ({ label: t(label), notes: list }));
}

export function viewTitle(view: View, query: string) {
  if (query.trim()) return t('搜索结果');
  if (view.type === 'trash') return t('回收站');
  if (view.type === 'smart') return t(SMART_LABELS[view.value]?.label || '智能列表');
  return view.value && view.value !== 'all' ? view.value : t('全部笔记');
}
