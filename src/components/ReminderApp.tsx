import { useEffect, useState } from 'react';
import { AlarmClock, Check, X } from 'lucide-react';
import { desktop, type DesktopReminderAction, type DesktopReminderItem } from '../lib/desktop';
import { playReminderChime } from '../lib/sound';
import { t, useT } from '../lib/i18n';

function applyStoredTheme() {
  const theme = localStorage.getItem('glimnote.theme') || 'paper';
  const dark = theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : theme === 'paper' ? 'paper' : 'light';
}

/**
 * 桌面右下角的到点提醒浮层。
 *
 * 这是一个独立的透明窗口，由主进程贴住屏幕右下角；不依附主窗口，
 * 所以主窗口收进托盘、最小化，甚至只是没在前台时，提醒照样出现在桌面上。
 * 点击「完成 / 10 分钟后」不在这里改数据，交给主窗口沿用原有的任务逻辑。
 */
export function ReminderApp() {
  const tr = useT();
  const [items, setItems] = useState<DesktopReminderItem[]>([]);
  const bridge = desktop();

  const act = (action: DesktopReminderAction, id: string) => {
    setItems([]);
    void bridge?.reminderAction?.({ action, id });
  };

  useEffect(() => {
    document.title = t('待办提醒 · 萤光笔记');
    applyStoredTheme();
    const off = bridge?.onReminderData?.((list) => {
      const next = Array.isArray(list) ? list : [];
      setItems(next);
      if (next.length) playReminderChime();
    });
    return () => off?.();
  }, [bridge]);

  // 内容高度决定窗口高度：窗口锚定在右下角，长高时往上顶，不会盖住任务栏
  useEffect(() => {
    if (!items.length) return;
    const measure = () => {
      const el = document.querySelector('.reminder-desktop');
      if (!el) return;
      const height = Math.ceil(el.getBoundingClientRect().height);
      if (height > 0) void bridge?.reminderResize?.(height);
    };
    const raf = requestAnimationFrame(measure);
    const timer = window.setTimeout(measure, 120);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(timer);
    };
  }, [items, bridge]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') act('close', '');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // 这里只用到稳定的 setItems / bridge，闭包不会读到过期状态
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!items.length) return null;

  return (
    <div className="reminder-desktop" role="region" aria-label={tr('待办到点提醒')}>
      {items.map((item) => (
        <div className="reminder-card" key={item.id} role="alert">
          <span className="reminder-mark">
            <AlarmClock size={16} strokeWidth={1.8} />
          </span>
          <div className="reminder-body">
            <button className="reminder-title" onClick={() => act('open', item.id)} title={tr('打开这条待办')}>
              {item.title}
            </button>
            <div className="reminder-meta">{item.meta}</div>
            <div className="reminder-actions">
              {item.id ? (
                <>
                  <button className="reminder-secondary" onClick={() => act('snooze', item.id)}>
                    {tr('10 分钟后')}
                  </button>
                  <button className="reminder-done" onClick={() => act('done', item.id)}>
                    <Check size={13} strokeWidth={2.2} /> {tr('完成')}
                  </button>
                </>
              ) : (
                // 上锁时的汇总提醒：只能回主窗口解锁，不提供完成 / 延后
                <button className="reminder-done" onClick={() => act('open', '')}>
                  {tr('打开应用')}
                </button>
              )}
            </div>
          </div>
          <button
            className="reminder-close"
            onClick={() => act('close', item.id)}
            title={tr('关闭提醒')}
            aria-label={tr('关闭提醒')}
          >
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
