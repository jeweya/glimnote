import { useEffect, useRef, useState } from 'react';
import { AlarmClock, Check, X } from 'lucide-react';
import { useApp } from '../store/app';
import { desktop, type DesktopReminderItem } from '../lib/desktop';
import { log } from '../lib/log';
import { notifyConfigured, sendTaskNotify } from '../lib/taskNotify';
import {
  dueReminders,
  markReminded,
  pruneReminderState,
  recentlyReminded,
  remindersEnabled,
  snoozeReminder,
  type DueReminder,
} from '../lib/reminders';
import { playReminderChime } from '../lib/sound';
import { dueLabel, remindBeforeLabel, taskDueAt, taskTitle, type Task } from '../lib/tasks';
import { t, useT } from '../lib/i18n';

const MAX_VISIBLE = 3;

function timeText(task: Task) {
  const at = taskDueAt(task);
  if (at) {
    return `${at.getHours() < 10 ? '0' : ''}${at.getHours()}:${at.getMinutes() < 10 ? '0' : ''}${at.getMinutes()}`;
  }
  return task.dueTime || '';
}

/** 交给桌面浮层显示的内容；到点时间在这里就拼好，浮层只管画 */
function toPopupItems(list: DueReminder[], at: Date): DesktopReminderItem[] {
  return list.map(({ task, offset }) => {
    const when = [dueLabel(task.due || '', at), timeText(task)].filter(Boolean).join(' ');
    return {
      id: task.id,
      title: taskTitle(task),
      meta:
        offset === 0
          ? t('{when} 到点', { when })
          : t('{when} · 提前 {n}提醒', { when, n: remindBeforeLabel(offset) }),
    };
  });
}

const dueCountText = (n: number) => (n === 1 ? t('有 1 条待办到时间了') : t('有 {n} 条待办到时间了', { n }));
const dueBodyText = (n: number) =>
  n === 1 ? t('有 1 条待办到时间了，点这里打开应用') : t('有 {n} 条待办到时间了，点这里打开应用', { n });

/**
 * 待办到点提醒的调度器。
 *
 * 桌面版：把到点的待办交给独立的主进程浮层窗口，贴住「桌面」右下角显示 ——
 * 主窗口收进托盘、最小化、没在前台都不影响。已上锁时改发系统通知且不带标题，
 * 避免锁屏时把待办内容露出来。
 * 网页版：主窗口可见时在应用内右下角弹卡；标签页在后台时改发系统通知。
 */
export function TaskReminders() {
  const ready = useApp((s) => s.ready);
  const loaded = useApp((s) => s.tasksLoaded);
  const tasks = useApp((s) => s.tasks);
  const toggleTask = useApp((s) => s.toggleTask);
  const loadTasks = useApp((s) => s.loadTasks);
  const selectTask = useApp((s) => s.selectTask);
  const setView = useApp((s) => s.setView);
  const [items, setItems] = useState<DueReminder[]>([]);
  const tr = useT();
  const bridge = desktop();
  // 同一次运行里同一个渠道只提示一次失败，避免每条待办都弹一遍
  const notifyWarned = useRef<Set<string>>(new Set());

  // 侧栏计数会预热任务库；这里再兜一层，避免用户一直没进待办页就收不到提醒
  useEffect(() => {
    if (ready && !loaded) void loadTasks();
  }, [ready, loaded, loadTasks]);

  useEffect(() => {
    if (!ready || !loaded) return;

    const run = () => {
      const state = useApp.getState();
      if (!remindersEnabled()) {
        setItems((prev) => (prev.length ? [] : prev));
        void bridge?.hideReminder?.();
        return;
      }
      pruneReminderState(state.tasks);
      const at = new Date();
      const due = dueReminders(state.tasks, at);
      if (!due.length) return;
      // 先记账再提醒：同一时刻多个 effect / 重渲染都不会重复响。
      // offsets 里包含被这次提醒一并消化的更早档位，防止下一轮又补响。
      for (const item of due) {
        for (const offset of item.offsets) markReminded(item.task, offset);
      }

      // 群机器人通知：只发到任务里勾选、且设置里配好地址的渠道。
      // 「云端推送」只是每天多一条早间汇总，不替代这里的到点提醒，两者各发各的；
      // 上锁时只发条数，不把待办标题推到群里。
      for (const { task } of due) {
        const channels = (task.notify || []).filter(notifyConfigured);
        if (!channels.length) continue;
        void sendTaskNotify(task, at, channels, {
          hideTitle: state.locked,
          lockedCount: due.length,
        }).then((results) => {
          results.forEach((result, i) => {
            if (result.status !== 'rejected') return;
            const channel = channels[i];
            const reason = (result.reason as Error)?.message || t('发送失败');
            log('notify', 'warn', `待办通知发送失败 ${channel}：${reason}`);
            if (notifyWarned.current.has(channel)) return;
            notifyWarned.current.add(channel);
            useApp.getState().toast(reason, 'warn');
          });
        });
      }

      // 已上锁：桌面浮层只显示条数，不出现待办标题；没有浮层能力时退回系统通知
      if (state.locked) {
        setItems((prev) => (prev.length ? [] : prev));
        void bridge?.hideReminder?.();
        if (bridge?.showReminder) {
          void bridge.showReminder([
            {
              id: '',
              title: dueCountText(due.length),
              meta: t('应用已锁定，解锁后查看详情'),
            },
          ]);
        } else {
          void bridge?.notify?.({
            title: t('萤光笔记 · 待办到点'),
            body: dueBodyText(due.length),
          });
        }
        return;
      }

      // 桌面版：弹在「桌面」右下角的独立浮层里，和应用窗口在不在前台无关
      if (bridge?.showReminder) {
        setItems((prev) => (prev.length ? [] : prev));
        void bridge.showReminder(toPopupItems(due, at));
        return;
      }

      // 网页版标签页在后台：页面里的卡片看不见，改发系统通知
      if (document.visibilityState === 'hidden') {
        setItems((prev) => (prev.length ? [] : prev));
        void bridge?.notify?.({
          title: t('萤光笔记 · 待办到点'),
          body: dueBodyText(due.length),
        });
        return;
      }

      playReminderChime();
      setItems((prev) => {
        const seen = new Set(
          prev.map((item) => `${item.task.id}|${item.task.due}|${item.task.dueTime}|${item.offset}`),
        );
        const next = due.filter(
          (item) => !seen.has(`${item.task.id}|${item.task.due}|${item.task.dueTime}|${item.offset}`),
        );
        return [...prev, ...next].slice(-MAX_VISIBLE);
      });
    };

    run();
    const timer = window.setInterval(run, 20000);
    const onPref = () => {
      setItems([]);
      run();
    };
    window.addEventListener('glimnote:reminder-pref', onPref);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('glimnote:reminder-pref', onPref);
    };
  }, [ready, loaded, tasks, bridge]);

  // 解锁后把上锁期间「只报了条数」的提醒补出来，刚响过的不算重复打扰
  useEffect(() => {
    const off = bridge?.onReminderReplay?.(() => {
      if (!bridge?.showReminder) return;
      const state = useApp.getState();
      if (state.locked || !remindersEnabled()) return;
      const list = recentlyReminded(state.tasks);
      if (list.length) void bridge.showReminder(toPopupItems(list, new Date()));
    });
    return () => off?.();
  }, [bridge]);

  // 在别处完成 / 删除后，弹卡跟着消失
  useEffect(() => {
    setItems((prev) => {
      const next = prev.filter((item) => {
        const task = tasks.find((t) => t.id === item.task.id);
        return task && task.status !== 'done' && !task.deletedAt;
      });
      return next.length === prev.length ? prev : next;
    });
  }, [tasks]);

  if (!items.length) return null;
  const now = new Date();

  const dismiss = (task: Task) => {
    setItems((prev) => prev.filter((item) => item.task.id !== task.id));
  };

  const complete = (task: Task) => {
    dismiss(task);
    void toggleTask(task.id);
  };

  const snooze = (task: Task) => {
    snoozeReminder(task);
    dismiss(task);
  };

  const open = (task: Task) => {
    dismiss(task);
    selectTask(task.id);
    setView({ type: 'smart', value: 'todo' });
    void bridge?.showMain?.();
  };

  return (
    <div className="reminder-stack" role="region" aria-label={tr('待办到点提醒')}>
      {items.map((item) => {
        const { task, offset } = item;
        const at = taskDueAt(task);
        const time = at
          ? `${at.getHours() < 10 ? '0' : ''}${at.getHours()}:${at.getMinutes() < 10 ? '0' : ''}${at.getMinutes()}`
          : task.dueTime || '';
        const when = [dueLabel(task.due || '', now), time].filter(Boolean).join(' ');
        return (
          <div className="reminder-card" key={`${task.id}|${offset}`} role="alert">
            <span className="reminder-mark">
              <AlarmClock size={16} strokeWidth={1.8} />
            </span>
            <div className="reminder-body">
              <button className="reminder-title" onClick={() => open(task)} title={tr('打开这条待办')}>
                {taskTitle(task)}
              </button>
              <div className="reminder-meta">
                {offset === 0
                  ? tr('{when} 到点', { when })
                  : tr('{when} · 提前 {n}提醒', { when, n: remindBeforeLabel(offset) })}
              </div>
              <div className="reminder-actions">
                <button className="reminder-secondary" onClick={() => snooze(task)}>
                  {tr('10 分钟后')}
                </button>
                <button className="reminder-done" onClick={() => complete(task)}>
                  <Check size={13} strokeWidth={2.2} /> {tr('完成')}
                </button>
              </div>
            </div>
            <button className="reminder-close" onClick={() => dismiss(task)} title={tr('关闭提醒')} aria-label={tr('关闭提醒')}>
              <X size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
