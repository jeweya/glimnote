import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AlarmClock, CalendarDays, Clock, X } from 'lucide-react';
import { useApp } from '../store/app';
import { NOTIFY_CHANNEL_LABEL, TASK_NOTIFY_CHANNELS, dueFullLabel, type Task } from '../lib/tasks';
import { notifyConfigured } from '../lib/taskNotify';
import { cn, dateKey } from '../lib/utils';
import { useT } from '../lib/i18n';
import { TimePicker } from './TimePicker';

interface Props {
  task: Task;
  x: number;
  y: number;
  onClose: () => void;
}

/**
 * 列表「⋯ → 到点提醒」的小浮窗：改时间、勾选群通知都在这里完成，
 * 不用为了设一个提醒先打开右侧详情。
 */
export function TaskRemindPopover({ task, x, y, onClose }: Props) {
  const patchTask = useApp((s) => s.patchTask);
  const setSettings = useApp((s) => s.setSettings);
  const tr = useT();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
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
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const toggleChannel = (channel: (typeof TASK_NOTIFY_CHANNELS)[number]) => {
    if (!notifyConfigured(channel)) {
      onClose();
      setSettings(true, 'notify');
      return;
    }
    const current = task.notify || [];
    const next = current.includes(channel) ? current.filter((c) => c !== channel) : [...current, channel];
    patchTask(task.id, { notify: next.length ? next : undefined });
  };

  return (
    <div className="remind-pop" ref={ref} style={{ left: pos.left, top: pos.top }} role="dialog" aria-label={tr('到点提醒')}>
      <div className="rp-head">
        <span>
          <AlarmClock size={14} /> {tr('到点提醒')}
        </span>
        <button className="icon-btn" onClick={onClose} title={tr('关闭')}>
          <X size={14} />
        </button>
      </div>

      {task.due ? (
        <>
          <div className="rp-date">
            <CalendarDays size={13} />
            {dueFullLabel(task.due, task.dueTime)}
          </div>
          <div className="rp-row">
            <span>{tr('提醒时间')}</span>
            <div className="rp-time">
              <button
                className={cn('rp-time-btn', !task.dueTime && 'muted')}
                aria-label={tr('到点提醒时间')}
                title={tr('点开选择时间，也可以直接输入时和分')}
                onClick={(e) => {
                  const r = e.currentTarget.getBoundingClientRect();
                  setTimePop({ x: r.left, y: r.bottom + 6 });
                }}
              >
                <span>{task.dueTime || tr('选择时间')}</span>
                <Clock size={13} />
              </button>
              {task.dueTime && !task.repeat && (
                <button title={tr('取消提醒时间')} onClick={() => patchTask(task.id, { dueTime: undefined })}>
                  <X size={13} />
                </button>
              )}
            </div>
          </div>
          <div className="rp-hint">
            {task.repeat && task.dueTime
              ? tr('循环任务保留提醒时间')
              : task.dueTime
                ? tr('到点在桌面右下角提醒')
                : tr('设了具体时间才会响')}
          </div>
        </>
      ) : (
        <div className="rp-empty">
          <div>{tr('还没有截止日期，没法定时提醒。')}</div>
          <button onClick={() => patchTask(task.id, { due: dateKey() })}>{tr('设为今天')}</button>
        </div>
      )}

      <div className="rp-channels">
        <div className="rp-label">{tr('同时通知')}</div>
        <div className="rp-chips">
          {TASK_NOTIFY_CHANNELS.map((channel) => {
            const configured = notifyConfigured(channel);
            const on = Boolean(task.notify?.includes(channel));
            return (
              <button
                key={channel}
                className={cn('rp-chip', on && 'on', !configured && 'off')}
                aria-pressed={on}
                title={configured ? tr('到点时推送到这个群') : tr('先到设置里配置 Webhook')}
                onClick={() => toggleChannel(channel)}
              >
                <span className={cn('notify-dot', `ch-${channel}`)} />
                {tr(NOTIFY_CHANNEL_LABEL[channel])}
              </button>
            );
          })}
        </div>
        <div className="rp-foot">{tr('未配置的渠道会打开「设置 → 通知」')}</div>
      </div>

      {timePop && (
        <TimePicker
          value={task.dueTime}
          x={timePop.x}
          y={timePop.y}
          onPick={(next) => patchTask(task.id, { dueTime: next })}
          onClose={() => setTimePop(null)}
        />
      )}
    </div>
  );
}
