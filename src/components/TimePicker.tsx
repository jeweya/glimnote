import { useEffect, useLayoutEffect, useRef, useState, type FocusEvent } from 'react';
import { cn } from '../lib/utils';
import { useT } from '../lib/i18n';

interface Props {
  /** 当前时间 HH:mm；空表示还没设 */
  value?: string;
  x: number;
  y: number;
  onPick: (time: string) => void;
  onClose: () => void;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** 下拉里按 5 分钟一档，从 00:00 到 23:55 */
const TIMES: string[] = [];
for (let h = 0; h < 24; h += 1) {
  for (let m = 0; m < 60; m += 5) TIMES.push(`${pad(h)}:${pad(m)}`);
}

function nearestIndex(time?: string) {
  if (time) {
    const i = TIMES.indexOf(time);
    if (i >= 0) return i;
  }
  const now = new Date();
  return now.getHours() * 12 + Math.floor(now.getMinutes() / 5);
}

/**
 * 到点提醒的下拉时间选择：滚轮列表每 5 分钟一档，顶部也可以直接手输。
 * 时和分分开两个输入框，中间的冒号只是显示，用户不用自己敲。
 * 点击某一档立即生效；打开时自动滚到当前值（没有值就滚到现在的时刻）。
 */
export function TimePicker({ value, x, y, onPick, onClose }: Props) {
  const tr = useT();
  const ref = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const hourRef = useRef<HTMLInputElement>(null);
  const minuteRef = useRef<HTMLInputElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  const [hour, setHour] = useState(() => (value ? value.split(':')[0] : ''));
  const [minute, setMinute] = useState(() => (value ? value.split(':')[1] || '' : ''));
  const [bad, setBad] = useState(false);

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

  // 打开时把选中项滚到列表中间；没有值就定位到当前时间附近
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const index = nearestIndex(value);
    list.scrollTop = Math.max(0, index * 30 - list.clientHeight / 2 + 15);
  }, [value]);

  // 只在下拉刚打开时聚焦「时」；之后值变化（比如失焦提交）不能把焦点抢回来
  useEffect(() => {
    hourRef.current?.focus();
    hourRef.current?.select();
  }, []);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [onClose]);

  /** 两个输入框合起来的时间；时没填或超出范围都算不合法 */
  const readTime = () => {
    if (!hour.trim()) return null;
    const h = Number(hour);
    const m = minute.trim() ? Number(minute) : 0;
    if (!Number.isInteger(h) || h < 0 || h > 23) return null;
    if (!Number.isInteger(m) || m < 0 || m > 59) return null;
    return `${pad(h)}:${pad(m)}`;
  };

  const commit = (close: boolean) => {
    const next = readTime();
    if (!next) {
      setBad(true);
      return false;
    }
    setBad(false);
    onPick(next);
    if (close) onClose();
    return true;
  };

  /** 只留数字、最多两位；时填满两位就自动跳到分 */
  const typePart = (raw: string, setter: (text: string) => void, next?: 'minute') => {
    const digits = raw.replace(/\D/g, '').slice(0, 2);
    setter(digits);
    setBad(false);
    if (next === 'minute' && digits.length === 2 && !minute) minuteRef.current?.focus();
  };

  const typed = readTime();
  const blurCommit = (e: FocusEvent<HTMLInputElement>) => {
    // 在「时」和「分」之间切换、或点列表项时不算离开，交给对应的操作提交
    if (e.relatedTarget instanceof Node && ref.current?.contains(e.relatedTarget)) return;
    if (readTime()) commit(false);
  };

  return (
    <div
      className="time-pop"
      ref={ref}
      style={{ left: pos.left, top: pos.top }}
      role="dialog"
      aria-label={tr('选择提醒时间')}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          onClose();
        } else if (e.key === 'Enter') {
          e.preventDefault();
          commit(true);
        }
      }}
    >
      <div className="tp-time-fields">
        <input
          ref={hourRef}
          className={cn('tp-input', bad && 'bad')}
          value={hour}
          placeholder="09"
          aria-label={tr('小时')}
          inputMode="numeric"
          autoComplete="off"
          maxLength={2}
          onChange={(e) => typePart(e.target.value, setHour, 'minute')}
          onFocus={(e) => e.currentTarget.select()}
          onBlur={blurCommit}
        />
        <span className="tp-colon">:</span>
        <input
          ref={minuteRef}
          className={cn('tp-input', bad && 'bad')}
          value={minute}
          placeholder="00"
          aria-label={tr('分钟')}
          inputMode="numeric"
          autoComplete="off"
          maxLength={2}
          onChange={(e) => typePart(e.target.value, setMinute)}
          onFocus={(e) => e.currentTarget.select()}
          onBlur={blurCommit}
        />
      </div>
      <div className="tp-list" ref={listRef} role="listbox" aria-label={tr('常用时间')}>
        {TIMES.map((time) => {
          const on = time === value || time === typed;
          return (
            <button
              key={time}
              type="button"
              role="option"
              aria-selected={on}
              className={cn('tp-item', on && 'on')}
              onClick={() => {
                onPick(time);
                onClose();
              }}
            >
              {time}
            </button>
          );
        })}
      </div>
    </div>
  );
}
