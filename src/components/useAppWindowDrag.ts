import type { PointerEvent as ReactPointerEvent } from 'react';
import type { DesktopBridge } from '../lib/desktop';

/**
 * 小应用窗口标题栏拖动。
 *
 * 透明窗体不能用 `-webkit-app-region: drag`：拖动区会被当成非客户区，
 * 页面收不到 hover，双击也到不了页面的最大化处理。所以和浮窗一样自己发
 * IPC 移动窗口，标题栏仍然完全是普通 DOM。
 */
export function useAppWindowDrag(bridge: DesktopBridge | null) {
  return (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    // 透明度弹层的遮罩和面板不能拖动：一旦在 pointerdown 里 preventDefault，
    // 浏览器就不会再生成本次 click，点遮罩关不掉弹层
    if (
      target.closest('button, input, textarea, select, a, [data-no-drag], .app-win-opacity-veil, .app-win-opacity-pop')
    )
      return;
    const dragStart = bridge?.appWindowDragStart;
    const dragMove = bridge?.appWindowDragMove;
    if (!dragStart || !dragMove) return;

    e.preventDefault();
    const sx = e.screenX;
    const sy = e.screenY;
    const el = e.currentTarget;
    const pointerId = e.pointerId;
    // 取窗口初始位置是异步的；先开始记位移，拿到位置后把这段时间的移动补上
    let origin: { x: number; y: number } | null = null;
    let latestX = sx;
    let latestY = sy;
    let last = 0;
    let ended = false;

    const flush = () => {
      if (!origin) return;
      void dragMove({ x: origin.x + latestX - sx, y: origin.y + latestY - sy }).catch(() => {});
    };
    const move = (ev: PointerEvent) => {
      latestX = ev.screenX;
      latestY = ev.screenY;
      // 约 16ms 一次，够跟手又不会把 IPC 刷爆
      const t = performance.now();
      if (t - last < 16) return;
      last = t;
      flush();
    };
    const finish = () => {
      ended = true;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      document.documentElement.classList.remove('app-win-dragging');
      flush();
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
    document.documentElement.classList.add('app-win-dragging');
    try {
      el.setPointerCapture(pointerId);
    } catch {
      /* window 监听同样能收到 */
    }
    void dragStart().then((pos) => {
      if (ended || !pos) return;
      origin = pos;
      flush();
    });
  };
}
