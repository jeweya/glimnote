import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, PenLine } from 'lucide-react';
import type { Note } from '../lib/markdown';
import { cn, dailyTitleOf, dateKey, parseDateKey } from '../lib/utils';
import { useT } from '../lib/i18n';

const DOW = ['一', '二', '三', '四', '五', '六', '日'];

interface Props {
  notes: Note[];
  /** 选中日期，形如 2026-10-29 */
  selected: string;
  onSelect: (key: string) => void;
  onWrite: (key: string) => void;
}

export function CalendarPanel({ notes, selected, onSelect, onWrite }: Props) {
  const initial = parseDateKey(selected) || new Date();
  const [cursor, setCursor] = useState({ year: initial.getFullYear(), month: initial.getMonth() });
  const tr = useT();

  // 外部改了选中日期（Ctrl+D、打开某天的日记）时跟着翻月
  useEffect(() => {
    const d = parseDateKey(selected);
    if (!d) return;
    setCursor((c) =>
      c.year === d.getFullYear() && c.month === d.getMonth() ? c : { year: d.getFullYear(), month: d.getMonth() },
    );
  }, [selected]);

  /** 有日记的日期 → 当天笔记数 */
  const marked = useMemo(() => {
    const map = new Map<string, number>();
    for (const n of notes) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(n.title)) map.set(n.title, (map.get(n.title) || 0) + 1);
    }
    return map;
  }, [notes]);

  const todayKey = dateKey();
  const first = new Date(cursor.year, cursor.month, 1);
  const offset = (first.getDay() + 6) % 7;
  const daysInMonth = new Date(cursor.year, cursor.month + 1, 0).getDate();
  const rows = Math.ceil((offset + daysInMonth) / 7);
  const cells = Array.from({ length: rows * 7 }, (_, i) => new Date(cursor.year, cursor.month, 1 - offset + i));
  const monthCount = [...marked.keys()].filter((k) =>
    k.startsWith(`${cursor.year}-${String(cursor.month + 1).padStart(2, '0')}`),
  ).length;

  const shift = (delta: number) => {
    const d = new Date(cursor.year, cursor.month + delta, 1);
    setCursor({ year: d.getFullYear(), month: d.getMonth() });
  };

  const hasDiary = notes.some((n) => n.notebook === '日记' && n.title === selected);

  return (
    <div className="cal-panel">
      <div className="cal-head">
        <span className="cal-month">
          {tr('{y}年{m}月', { y: cursor.year, m: cursor.month + 1 })}
        </span>
        <span className="cal-month-count">{monthCount ? tr('{n} 天有记录', { n: monthCount }) : tr('暂无记录')}</span>
        <button className="icon-btn cal-nav" onClick={() => shift(-1)} title={tr('上个月')}>
          <ChevronLeft size={14} />
        </button>
        <button
          className="cal-today"
          onClick={() => onSelect(todayKey)}
          disabled={selected === todayKey}
          title={tr('回到今天')}
        >
          {tr('今天')}
        </button>
        <button className="icon-btn cal-nav" onClick={() => shift(1)} title={tr('下个月')}>
          <ChevronRight size={14} />
        </button>
      </div>

      <div className="cal-grid">
        {DOW.map((d) => (
          <span key={d} className="cal-dow">
            {tr(d)}
          </span>
        ))}
        {cells.map((d) => {
          const key = dateKey(d);
          const out = d.getMonth() !== cursor.month;
          const count = marked.get(key) || 0;
          return (
            <button
              key={key}
              className={cn(
                'cal-cell',
                out && 'out',
                key === todayKey && 'today',
                key === selected && 'on',
                count > 0 && 'has',
              )}
              title={count ? tr('{title} · {n} 篇', { title: dailyTitleOf(key), n: count }) : dailyTitleOf(key)}
              onClick={() => {
                if (out) setCursor({ year: d.getFullYear(), month: d.getMonth() });
                onSelect(key);
              }}
            >
              <span className="cal-num">{d.getDate()}</span>
              <span className="cal-dot" />
            </button>
          );
        })}
      </div>

      <div className="cal-foot">
        <span className="cal-day">{dailyTitleOf(selected)}</span>
        <button
          className="cal-write"
          onClick={() => onWrite(selected)}
          title={hasDiary ? tr('打开这一天的日记') : tr('新建这一天的日记')}
        >
          <PenLine size={14} />
          {hasDiary ? tr('打开日记') : tr('写这一天')}
        </button>
      </div>
    </div>
  );
}
