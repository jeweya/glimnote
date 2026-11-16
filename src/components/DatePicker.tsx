import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn, dateKey, parseDateKey } from '../lib/utils';
import { useT } from '../lib/i18n';

interface Props {
  /** 当前截止日期 YYYY-MM-DD */
  value?: string;
  x: number;
  y: number;
  onPick: (due: string | undefined) => void;
  onClose: () => void;
}

const WEEK = ['一', '二', '三', '四', '五', '六', '日'];

function mondayFirst(d: Date) {
  return (d.getDay() + 6) % 7;
}

/** 迷你月历：快速新增、行内改日期、任务详情共用 */
export function DatePicker({ value, x, y, onPick, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const tr = useT();
  const [pos, setPos] = useState({ left: x, top: y });
  const [cursor, setCursor] = useState(() => parseDateKey(value || '') || new Date());
  const [month, setMonth] = useState(() => {
    const d = parseDateKey(value || '') || new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let left = x;
    let top = y;
    if (left + r.width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - r.width - 8);
    if (top + r.height > window.innerHeight - 8) top = Math.max(8, y - r.height);
    setPos({ left, top });
  }, [x, y]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [onClose]);

  const today = dateKey();
  const shift = (days: number) => {
    const next = new Date(cursor);
    next.setDate(next.getDate() + days);
    setCursor(next);
    setMonth(new Date(next.getFullYear(), next.getMonth(), 1));
  };

  const pick = (key: string) => onPick(key);

  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const offset = mondayFirst(first);
  const start = new Date(first);
  start.setDate(first.getDate() - offset);
  const days = Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return d;
  });

  const nextMonday = () => {
    const d = new Date();
    const add = (8 - d.getDay()) % 7 || 7;
    d.setDate(d.getDate() + add);
    return dateKey(d);
  };

  return (
    <div
      className="date-pop"
      ref={ref}
      style={{ left: pos.left, top: pos.top }}
      role="dialog"
      aria-label={tr('选择截止日期')}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          onClose();
        } else if (e.key === 'ArrowLeft') {
          e.preventDefault();
          shift(-1);
        } else if (e.key === 'ArrowRight') {
          e.preventDefault();
          shift(1);
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          shift(-7);
        } else if (e.key === 'ArrowDown') {
          e.preventDefault();
          shift(7);
        } else if (e.key === 'Enter') {
          e.preventDefault();
          pick(dateKey(cursor));
        }
      }}
    >
      <div className="dp-head">
        <button
          className="icon-btn"
          onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}
          title={tr('上个月')}
        >
          <ChevronLeft size={14} />
        </button>
        <span>
          {tr('{y}年{m}月', { y: month.getFullYear(), m: month.getMonth() + 1 })}
        </span>
        <button
          className="icon-btn"
          onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}
          title={tr('下个月')}
        >
          <ChevronRight size={14} />
        </button>
      </div>
      <div className="dp-grid dp-week">
        {WEEK.map((w) => (
          <span key={w}>{tr(w)}</span>
        ))}
      </div>
      <div className="dp-grid">
        {days.map((d) => {
          const key = dateKey(d);
          return (
            <button
              key={key}
              className={cn(
                'dp-day',
                d.getMonth() !== month.getMonth() && 'muted',
                key === today && 'today',
                key === value && 'on',
                dateKey(cursor) === key && 'cursor',
              )}
              onClick={() => pick(key)}
              onMouseEnter={() => setCursor(d)}
            >
              {d.getDate()}
            </button>
          );
        })}
      </div>
      <div className="dp-quick">
        <button onClick={() => pick(today)}>{tr('今天')}</button>
        <button
          onClick={() => {
            const d = new Date();
            d.setDate(d.getDate() + 1);
            pick(dateKey(d));
          }}
        >
          {tr('明天')}
        </button>
        <button onClick={() => pick(nextMonday())}>{tr('下周一')}</button>
        <button className="muted" onClick={() => onPick(undefined)}>
          {tr('清除')}
        </button>
      </div>
    </div>
  );
}
