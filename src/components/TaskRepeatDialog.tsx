import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { CalendarDays, Clock, Repeat, X } from 'lucide-react';
import { useApp } from '../store/app';
import {
  REPEAT_LABEL,
  TASK_REPEATS,
  WEEKDAY_NAMES,
  normalizeRepeatEvery,
  type Task,
  type TaskRepeat,
} from '../lib/tasks';
import { cn, parseDateKey } from '../lib/utils';
import { DatePicker } from './DatePicker';
import { TimePicker } from './TimePicker';
import { useLang, useT } from '../lib/i18n';

interface Props {
  task: Task;
  onClose: () => void;
}

const EVERY_UNIT: Record<TaskRepeat, string> = {
  daily: '天',
  weekly: '周',
  monthly: '月',
  yearly: '年',
};

const EVERY_UNIT_EN: Record<TaskRepeat, [string, string]> = {
  daily: ['day', 'days'],
  weekly: ['week', 'weeks'],
  monthly: ['month', 'months'],
  yearly: ['year', 'years'],
};

/**
 * 循环设置：频率、间隔、周几 / 月日、结束日期和提醒时间。
 * 表单密集，只认 Esc 与 ×，不点遮罩关闭。
 */
export function TaskRepeatDialog({ task, onClose }: Props) {
  const tr = useT();
  const lang = useLang();
  const patchTask = useApp((s) => s.patchTask);

  const dueDate = task.due ? parseDateKey(task.due) : null;
  const [freq, setFreq] = useState<TaskRepeat | 'none'>(task.repeat ?? 'none');
  const [every, setEvery] = useState(task.repeatEvery ?? 1);
  const [days, setDays] = useState<number[]>(() =>
    task.repeatDays?.length
      ? task.repeatDays
      : dueDate
        ? [((dueDate.getDay() + 6) % 7) + 1]
        : [((new Date().getDay() + 6) % 7) + 1],
  );
  const [monthDay, setMonthDay] = useState<number | 'last'>(
    task.repeatDay ?? (dueDate ? dueDate.getDate() : 1),
  );
  const [month, setMonth] = useState(task.repeatMonth ?? (dueDate ? dueDate.getMonth() + 1 : 1));
  const [until, setUntil] = useState(task.repeatUntil ?? '');
  // 循环任务的提醒时间就是它的到点时间；全天任务在读取时已经默认成 09:00
  const [remindTime, setRemindTime] = useState(task.dueTime ?? '09:00');
  const [datePop, setDatePop] = useState<{ x: number; y: number } | null>(null);
  const [timePop, setTimePop] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      if (datePop) setDatePop(null);
      else if (timePop) setTimePop(null);
      else onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose, datePop, timePop]);

  const toggleDay = (day: number) => {
    setDays((prev) =>
      prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day].sort((a, b) => a - b),
    );
  };

  const save = () => {
    if (freq !== 'none' && freq === 'weekly' && !days.length) return;
    if (freq === 'none') {
      patchTask(task.id, {
        repeat: undefined,
        repeatEvery: undefined,
        repeatDays: undefined,
        repeatDay: undefined,
        repeatMonth: undefined,
        repeatUntil: undefined,
        seriesId: undefined,
        remindBefore: undefined,
      });
      onClose();
      return;
    }
    patchTask(task.id, {
      repeat: freq,
      repeatEvery: normalizeRepeatEvery(every),
      repeatDays: freq === 'weekly' ? days : undefined,
      repeatDay: freq === 'monthly' || freq === 'yearly' ? monthDay : undefined,
      repeatMonth: freq === 'yearly' ? month : undefined,
      repeatUntil: until || undefined,
      dueTime: remindTime,
      remindBefore: undefined,
    });
    onClose();
  };

  const untilWarn = Boolean(until && task.due && until <= task.due);

  return createPortal(
    <div className="overlay">
      <div className="modal repeat-modal" role="dialog" aria-modal="true" aria-label={tr('循环设置')}>
        <div className="modal-head">
          <div>
            <div className="modal-title">
              <Repeat size={16} strokeWidth={1.9} /> {tr('循环任务')}
            </div>
            <div className="modal-desc">
              {tr('完成这一次后自动生成下一次；提醒时间与到点提醒共用。')}
            </div>
          </div>
          <button className="icon-btn" onClick={onClose} title={tr('关闭')}>
            <X size={16} />
          </button>
        </div>

        <div className="modal-body repeat-body">
          <div className="repeat-row">
            <span className="repeat-label">{tr('频率')}</span>
            <div className="segment repeat-freq">
              <button className={cn(freq === 'none' && 'on')} onClick={() => setFreq('none')}>
                {tr('不循环')}
              </button>
              {TASK_REPEATS.map((r) => (
                <button key={r} className={cn(freq === r && 'on')} onClick={() => setFreq(r)}>
                  {tr(REPEAT_LABEL[r])}
                </button>
              ))}
            </div>
          </div>

          {freq !== 'none' && (
            <>
              <div className="repeat-row">
                <span className="repeat-label">{tr('间隔')}</span>
                <div className="repeat-every">
                  {tr('每')}
                  <input
                    type="number"
                    min={1}
                    max={99}
                    value={every}
                    aria-label={tr('周期间隔')}
                    onChange={(e) => setEvery(normalizeRepeatEvery(e.target.value))}
                  />
                  {lang === 'en'
                    ? EVERY_UNIT_EN[freq][every === 1 ? 0 : 1]
                    : EVERY_UNIT[freq]}
                </div>
              </div>

              {freq === 'weekly' && (
                <div className="repeat-block">
                  <div className="repeat-label">{tr('周几')}</div>
                  <div className="repeat-days">
                    {WEEKDAY_NAMES.map((name, i) => {
                      const day = i + 1;
                      const on = days.includes(day);
                      return (
                        <button
                          key={name}
                          className={cn('repeat-day', on && 'on')}
                          aria-pressed={on}
                          onClick={() => toggleDay(day)}
                        >
                          {tr(name)}
                        </button>
                      );
                    })}
                  </div>
                  {!days.length && <div className="repeat-warn">{tr('至少选一天')}</div>}
                </div>
              )}

              {freq === 'monthly' && (
                <div className="repeat-row">
                  <span className="repeat-label">{tr('日期')}</span>
                  <select
                    className="repeat-select"
                    value={String(monthDay)}
                    aria-label={tr('每月哪一天')}
                    onChange={(e) =>
                      setMonthDay(e.target.value === 'last' ? 'last' : Number(e.target.value))
                    }
                  >
                    {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                      <option key={d} value={d}>
                        {tr('{n} 日', { n: d })}
                      </option>
                    ))}
                    <option value="last">{tr('最后一天')}</option>
                  </select>
                  <span className="repeat-anchor">{tr('当月没有这一天时取月末')}</span>
                </div>
              )}

              {freq === 'yearly' && (
                <div className="repeat-row">
                  <span className="repeat-label">{tr('日期')}</span>
                  <div className="repeat-ym">
                    <select
                      className="repeat-select"
                      value={month}
                      aria-label={tr('每年哪个月')}
                      onChange={(e) => setMonth(Number(e.target.value))}
                    >
                      {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                        <option key={m} value={m}>
                          {tr('{n} 月', { n: m })}
                        </option>
                      ))}
                    </select>
                    <select
                      className="repeat-select"
                      value={String(monthDay)}
                      aria-label={tr('每年哪一天')}
                      onChange={(e) =>
                        setMonthDay(e.target.value === 'last' ? 'last' : Number(e.target.value))
                      }
                    >
                      {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                        <option key={d} value={d}>
                          {tr('{n} 日', { n: d })}
                        </option>
                      ))}
                      <option value="last">{tr('最后一天')}</option>
                    </select>
                  </div>
                  <span className="repeat-anchor">{tr('2 月 29 日在平年落到 28 日')}</span>
                </div>
              )}

              <div className="repeat-row">
                <span className="repeat-label">{tr('结束')}</span>
                <button
                  className="repeat-date-btn"
                  onClick={(e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    setDatePop({ x: r.left, y: r.bottom + 6 });
                  }}
                >
                  <CalendarDays size={13} />
                  {until || tr('永不结束')}
                </button>
                {until && (
                  <button className="icon-btn" title={tr('清除结束日期')} onClick={() => setUntil('')}>
                    <X size={13} />
                  </button>
                )}
              </div>
              {untilWarn && (
                <div className="repeat-warn">
                  {tr('结束日期不晚于当前截止日，完成后不会生成下一次。')}
                </div>
              )}

              <div className="repeat-row">
                <span className="repeat-label">{tr('提醒时间')}</span>
                <button
                  className="repeat-date-btn"
                  onClick={(e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    setTimePop({ x: r.left, y: r.bottom + 6 });
                  }}
                >
                  <Clock size={13} />
                  {remindTime || tr('选择时间')}
                </button>
                {task.remindBefore?.length ? (
                  <span className="repeat-anchor">{tr('保存后取消原来的提前档位')}</span>
                ) : null}
              </div>
              <div className="repeat-hint">{tr('每次到期当天按这个时间提醒。')}</div>
            </>
          )}
        </div>

        <div className="modal-foot">
          <span className="repeat-foot-tip">{tr('规则会写进任务文件，换设备同步后仍在。')}</span>
          <button className="btn btn-ghost" onClick={onClose}>
            {tr('取消')}
          </button>
          <button
            className="btn btn-primary"
            disabled={freq === 'weekly' && !days.length}
            onClick={save}
          >
            {tr('保存')}
          </button>
        </div>

        {timePop && (
          <TimePicker
            value={remindTime || undefined}
            x={timePop.x}
            y={timePop.y}
            onPick={(next) => {
              setRemindTime(next);
              setTimePop(null);
            }}
            onClose={() => setTimePop(null)}
          />
        )}

        {datePop && (
          <DatePicker
            value={until || undefined}
            x={datePop.x}
            y={datePop.y}
            onPick={(next) => {
              setUntil(next || '');
              setDatePop(null);
            }}
            onClose={() => setDatePop(null)}
          />
        )}
      </div>
    </div>,
    document.body,
  );
}
