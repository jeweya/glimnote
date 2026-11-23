import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Clock, X } from 'lucide-react';
import { cn, dateKey, parseDateKey } from '../lib/utils';
import { useT } from '../lib/i18n';
import { TimePicker } from './TimePicker';

interface Props {
  /** 当前截止日期 YYYY-MM-DD */
  value?: string;
  x: number;
  y: number;
  onPick: (due: string | undefined) => void;
  onClose: () => void;
  /** 点到弹窗外面时触发；不传就等同于 onClose */
  onOutside?: () => void;
  /** 当前到点提醒 HH:mm；传入 onTimePick 后进入「日期 + 时间」模式 */
  time?: string;
  onTimePick?: (time: string | undefined) => void;
}

const WEEK = ['一', '二', '三', '四', '五', '六', '日'];

function mondayFirst(d: Date) {
  return (d.getDay() + 6) % 7;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** 默认提醒时间：当前时间 + 1 小时，向上取整到 00 / 30 分（10:49 → 12:00，10:28 → 11:30） */
export function defaultReminderTime(now = new Date()) {
  const d = new Date(now);
  d.setMinutes(d.getMinutes() + 60);
  const m = d.getMinutes();
  if (m !== 0 && m !== 30) d.setMinutes(m < 30 ? 30 : 60);
  // 跨过零点时不落到今天的过去时间
  if (dateKey(d) !== dateKey(now)) return '23:30';
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 迷你月历：快速新增、行内改日期、任务详情共用；带 onTimePick 时同时设置到点提醒 */
export function DatePicker({ value, x, y, onPick, onClose, onOutside, time, onTimePick }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const tr = useT();
  const combined = Boolean(onTimePick);
  const [pos, setPos] = useState({ left: x, top: y });
  const [cursor, setCursor] = useState(() => parseDateKey(value || '') || new Date());
  const [month, setMonth] = useState(() => {
    const d = parseDateKey(value || '') || new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  // 日期 + 时间模式：先攒着，点「确定」再一起提交，点日期不会马上关掉
  const [pending, setPending] = useState<string | undefined>(value);
  const [timeText, setTimeText] = useState(() =>
    time ?? (onTimePick ? defaultReminderTime() : ''),
  );
  // 时间面板与任务详情共用 TimePicker：点按钮再弹出，支持手输时 / 分
  const [timePop, setTimePop] = useState<{ x: number; y: number } | null>(null);

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
      if (ref.current && !ref.current.contains(e.target as Node)) (onOutside ?? onClose)();
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [onClose, onOutside]);

  const today = dateKey();
  const shift = (days: number) => {
    const next = new Date(cursor);
    next.setDate(next.getDate() + days);
    setCursor(next);
    setMonth(new Date(next.getFullYear(), next.getMonth(), 1));
  };

  const pick = (key: string) => onPick(key);

  /** 普通模式直接选完就关；日期 + 时间模式只更新选中项 */
  const choose = (key: string) => {
    if (!combined) {
      pick(key);
      return;
    }
    const d = parseDateKey(key);
    if (d) {
      setCursor(d);
      setMonth(new Date(d.getFullYear(), d.getMonth(), 1));
    }
    setPending(key);
  };

  const commitCombined = () => {
    // 只填了时间没选日期时，落到今天
    const finalDate = pending ?? (timeText ? today : undefined);
    onTimePick?.(timeText || undefined);
    onPick(finalDate);
    onClose();
  };

  const confirm = () => {
    if (combined) commitCombined();
    else pick(dateKey(cursor));
  };

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

  const selected = combined ? pending : value;

  return (
    <div
      className={cn('date-pop', combined && 'with-time')}
      ref={ref}
      style={{ left: pos.left, top: pos.top }}
      role="dialog"
      aria-label={combined ? tr('设置截止日期与到点提醒') : tr('选择截止日期')}
      onKeyDown={(e) => {
        // 时间输入框自己处理回车 / 方向键 / Esc，避免把月历光标挪走
        if (e.target instanceof HTMLInputElement) return;
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
          confirm();
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
                key === selected && 'on',
                dateKey(cursor) === key && 'cursor',
              )}
              onClick={() => choose(key)}
              onMouseEnter={() => setCursor(d)}
            >
              {d.getDate()}
            </button>
          );
        })}
      </div>
      <div className="dp-quick">
        <button onClick={() => choose(today)}>{tr('今天')}</button>
        <button
          onClick={() => {
            const d = new Date();
            d.setDate(d.getDate() + 1);
            choose(dateKey(d));
          }}
        >
          {tr('明天')}
        </button>
        <button onClick={() => choose(nextMonday())}>{tr('下周一')}</button>
        {!combined && (
          <button className="muted" onClick={() => onPick(undefined)}>
            {tr('清除')}
          </button>
        )}
      </div>

      {combined && (
        <>
          <div className="dp-time">
            <div className="dp-time-head">
              <span>{tr('到点提醒')}</span>
              <button
                type="button"
                className={cn('td-time-btn', !timeText && 'muted')}
                aria-label={tr('到点提醒时间')}
                title={tr('点开选择时间，也可以直接输入时和分')}
                onClick={(e) => {
                  const r = e.currentTarget.getBoundingClientRect();
                  setTimePop({ x: r.left, y: r.bottom + 6 });
                }}
              >
                <span>{timeText || tr('选择时间')}</span>
                <Clock size={13} />
              </button>
              {timeText && (
                <button
                  type="button"
                  className="icon-btn"
                  title={tr('取消提醒时间')}
                  aria-label={tr('取消提醒时间')}
                  onClick={() => setTimeText('')}
                >
                  <X size={12} />
                </button>
              )}
            </div>
          </div>
          <div className="dp-actions">
            <button className="ghost" onClick={onClose}>
              {tr('取消')}
            </button>
            <button className="primary" onClick={commitCombined}>
              {tr('确定')}
            </button>
          </div>
          {timePop && (
            <TimePicker
              value={timeText || undefined}
              x={timePop.x}
              y={timePop.y}
              onPick={(next) => {
                setTimeText(next);
                setTimePop(null);
              }}
              onDraft={(next) => setTimeText(next)}
              onClose={() => setTimePop(null)}
            />
          )}
        </>
      )}
    </div>
  );
}
