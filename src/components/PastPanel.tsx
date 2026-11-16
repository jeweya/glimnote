import { useMemo, useState } from 'react';
import { History, X } from 'lucide-react';
import type { Note } from '../lib/markdown';
import { dateKey, parseDateKey } from '../lib/utils';
import { useT } from '../lib/i18n';

const HIDE_KEY = 'glimnote.past.hidden';

function noteDay(note: Note) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(note.title)) {
    const d = parseDateKey(note.title);
    if (d) return d;
  }
  const d = new Date(note.created || note.updated);
  return Number.isNaN(d.getTime()) ? null : d;
}

function sameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

interface Item {
  note: Note;
  when: string;
  day: Date;
}

interface Props {
  notes: Note[];
  onOpen: (note: Note) => void;
}

/**
 * 当年今日 / 上月今天的笔记，最多 5 条。
 * 只在中栏安静地出现一次，关掉后当天不再打扰。
 */
export function PastPanel({ notes, onOpen }: Props) {
  const [hidden, setHidden] = useState(() => localStorage.getItem(HIDE_KEY) === dateKey());
  const tr = useT();

  const items = useMemo<Item[]>(() => {
    const today = new Date();
    const lastYear = new Date(today.getFullYear() - 1, today.getMonth(), today.getDate());
    const daysInPrevMonth = new Date(today.getFullYear(), today.getMonth(), 0).getDate();
    const lastMonth = new Date(today.getFullYear(), today.getMonth() - 1, Math.min(today.getDate(), daysInPrevMonth));
    const out: Item[] = [];
    for (const note of notes) {
      const day = noteDay(note);
      if (!day) continue;
      if (sameDay(day, lastYear)) out.push({ note, when: '去年今天', day });
      else if (sameDay(day, lastMonth)) out.push({ note, when: '上月今天', day });
      if (out.length >= 40) break;
    }
    out.sort((a, b) => +b.day - +a.day);
    return out.slice(0, 5);
  }, [notes]);

  if (hidden || items.length === 0) return null;

  const countOf = (when: string) => items.filter((i) => i.when === when).length;
  const parts: string[] = [];
  if (countOf('去年今天')) parts.push(tr('去年今天 {n} 篇', { n: countOf('去年今天') }));
  if (countOf('上月今天')) parts.push(tr('上月今天 {n} 篇', { n: countOf('上月今天') }));

  const dismiss = () => {
    localStorage.setItem(HIDE_KEY, dateKey());
    setHidden(true);
  };

  return (
    <div className="past-card">
      <div className="past-head">
        <span className="past-title">
          <History size={14} strokeWidth={1.75} /> {tr('那年今日')}
        </span>
        <span className="past-sub">{parts.join(' · ')}</span>
        <button className="icon-btn past-close" onClick={dismiss} title={tr('今天不再显示')}>
          <X size={14} />
        </button>
      </div>
      <div className="past-list">
        {items.map(({ note, when }) => (
          <button
            key={note.id}
            className="past-item"
            onClick={() => onOpen(note)}
            title={`${note.title} · ${note.notebook || tr('未分类')}`}
          >
            <span className="past-when">{tr(when)}</span>
            <span className="past-text">
              <span className="past-name">{note.title || tr('未命名笔记')}</span>
              <span className="past-ex">{note.excerpt || tr('空白笔记')}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
