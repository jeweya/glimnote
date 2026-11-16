import type { Note } from './markdown';
import { wordCount } from './markdown';
import { dateKey } from './utils';
import { getLang } from './i18n';

export interface DayStat {
  key: string;
  label: string;
  words: number;
  notes: number;
}

export interface WritingStats {
  /** 本周有写作的天数 */
  weekDays: number;
  /** 本周涉及的笔记字数（按最后修改日期归属，同一篇只计一次） */
  weekWords: number;
  weekNotes: number;
  /** 连续写作天数（今天没写则从昨天开始算） */
  streak: number;
  totalWords: number;
  totalNotes: number;
  /** 最近 7 天，含今天 */
  daily: DayStat[];
}

function startOfDay(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/**
 * 按「笔记最后修改日」统计写作情况。
 * 不做后台埋点，全部由本地笔记现算，离线也可用。
 */
export function computeWritingStats(notes: Note[]): WritingStats {
  const today = startOfDay(new Date());
  const perDay = new Map<string, { words: number; notes: number }>();
  let totalWords = 0;

  for (const note of notes) {
    const words = wordCount(note.content);
    totalWords += words;
    const d = new Date(note.updated);
    if (Number.isNaN(d.getTime())) continue;
    const key = dateKey(d);
    const cur = perDay.get(key) || { words: 0, notes: 0 };
    cur.words += words;
    cur.notes += 1;
    perDay.set(key, cur);
  }

  const daily: DayStat[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const key = dateKey(d);
    const hit = perDay.get(key);
    daily.push({
      key,
      label: `${d.getMonth() + 1}/${d.getDate()}`,
      words: hit?.words || 0,
      notes: hit?.notes || 0,
    });
  }

  const todayKey = dateKey(today);
  const weekStart = new Date(today);
  weekStart.setDate(today.getDate() - ((today.getDay() + 6) % 7));
  const weekStartKey = dateKey(weekStart);

  let weekDays = 0;
  let weekWords = 0;
  let weekNotes = 0;
  for (const [key, value] of perDay) {
    if (key >= weekStartKey && key <= todayKey) {
      weekDays += 1;
      weekWords += value.words;
      weekNotes += value.notes;
    }
  }

  let streak = 0;
  const cursor = new Date(today);
  if (!perDay.has(todayKey)) cursor.setDate(cursor.getDate() - 1);
  for (let guard = 0; guard < 3660; guard++) {
    if (!perDay.has(dateKey(cursor))) break;
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }

  return { weekDays, weekWords, weekNotes, streak, totalWords, totalNotes: notes.length, daily };
}

export function formatWords(n: number) {
  if (getLang() === 'en') {
    if (n >= 10000) return `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k`;
    return n.toLocaleString('en-US');
  }
  if (n >= 10000) return `${(n / 10000).toFixed(n >= 100000 ? 0 : 1)} 万`;
  return n.toLocaleString('zh-CN');
}
