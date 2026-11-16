import type { PointerEvent as ReactPointerEvent } from 'react';
import type { DesktopBridge } from '../lib/desktop';

/**
 * 浮窗标题栏拖动。
 *
 * 不用 `-webkit-app-region: drag`：被 Chromium 当成非客户区后，鼠标停在标题上
 * 页面收不到 hover，静置透明度就不会恢复。这里改为自己发 IPC 移动窗口，
 * 整个标题都还是普通 DOM，悬停恢复 100% 才对得上。
 *
 * 放在单独文件里，普通浮窗和锁定占位共用同一个拖动实现。
 */
export function useCardWindowDrag(bridge: DesktopBridge | null) {
  return (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest('button, input, textarea, select, a, [data-no-drag]')) return;
    const dragStart = bridge?.cardDragStart;
    const dragMove = bridge?.cardDragMove;
    const dragEnd = bridge?.cardDragEnd;
    if (!dragStart || !dragMove) return;

    e.preventDefault();
    const sx = e.screenX;
    const sy = e.screenY;
    const el = e.currentTarget;
    const pointerId = e.pointerId;
    let origin: { x: number; y: number } | null = null;
    let latestX = sx;
    let latestY = sy;
    let last = 0;
    let ended = false;
    // 只是点了一下标题栏不用写偏好
    let moved = false;

    const flush = () => {
      if (!origin) return Promise.resolve(null);
      return dragMove({ x: origin.x + latestX - sx, y: origin.y + latestY - sy }).catch(() => null);
    };
    const report = () => {
      void flush();
    };
    const move = (ev: PointerEvent) => {
      latestX = ev.screenX;
      latestY = ev.screenY;
      if (!moved && Math.abs(latestX - sx) + Math.abs(latestY - sy) > 2) moved = true;
      const t = performance.now();
      if (t - last < 16) return;
      last = t;
      report();
    };
    const finish = () => {
      ended = true;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      document.documentElement.classList.remove('card-dragging');
      // 先让最后一次位移落到主进程，再让它记住位置
      void flush()
        .catch(() => null)
        .then(() => (moved ? dragEnd?.() : null))
        .catch(() => null);
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
    document.documentElement.classList.add('card-dragging');
    try {
      el.setPointerCapture(pointerId);
    } catch {
      /* window 监听同样能收到 */
    }
    // 取窗口初始位置是异步的；先开始记位移，拿到位置后把这段时间的移动补上
    void dragStart().then((pos) => {
      if (ended || !pos) return;
      origin = pos;
      report();
    });
  };
}
