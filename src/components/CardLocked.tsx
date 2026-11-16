import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Lock, X } from 'lucide-react';
import type { DesktopBridge } from '../lib/desktop';
import { useT } from '../lib/i18n';

/**
 * 浮窗的锁定态。
 *
 * 主窗口关到托盘后浮窗不再跟着隐藏：没设密码锁就照常可用；设了密码锁则由主进程
 * 发 card:lock，把待办和灵感整体换成这块占位，桌面上不留内容。点「解锁」叫出
 * 主窗口锁屏，输完密码后主进程发 card:unlock，浮窗再读一次盘恢复。
 *
 * 锁定态单独放在这里，CardApp 只负责订阅和渲染，不和主界面的状态搅在一起。
 */
export function useCardLock(bridge: DesktopBridge | null, reload: () => Promise<void>, onLock?: () => void) {
  const [locked, setLocked] = useState(false);
  // 回调用 ref：订阅只跟着 bridge 走，不会因为每次渲染的函数身份变化反复解绑
  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  const onLockRef = useRef(onLock);
  onLockRef.current = onLock;

  useEffect(() => {
    const offLock = bridge?.onCardLock?.(() => {
      setLocked(true);
      onLockRef.current?.();
    });
    const offUnlock = bridge?.onCardUnlock?.(() => {
      setLocked(false);
      void reloadRef.current();
    });
    return () => {
      offLock?.();
      offUnlock?.();
    };
  }, [bridge]);

  return locked;
}

type CardLockedViewProps = {
  /** 收成一条时只留一行，不占满整张卡片 */
  collapsed: boolean;
  onDragStart: (e: ReactPointerEvent<HTMLElement>) => void;
  onHide: () => void;
  /** 叫出主窗口；有密码时那里是锁屏，解锁后浮窗自动恢复 */
  onUnlock: () => void;
};

export function CardLockedView({ collapsed, onDragStart, onHide, onUnlock }: CardLockedViewProps) {
  const tr = useT();
  if (collapsed) {
    return (
      <div className="card-shell card-shell-mini">
        <div className="card-mini" onPointerDown={onDragStart}>
          <div className="card-mini-main">
            <span className="card-mini-date card-mini-locked">
              <Lock size={12} strokeWidth={2} />
              {tr('已上锁')}
            </span>
            <span className="card-mini-sub">{tr('解锁后查看待办与灵感')}</span>
          </div>
          <div className="card-mini-actions">
            <button className="card-mini-unlock" onClick={onUnlock}>
              {tr('解锁')}
            </button>
            <button className="card-icon" title={tr('收起浮窗（Esc）')} aria-label={tr('收起浮窗')} onClick={onHide}>
              <X size={14} />
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="card-shell card-shell-locked">
      <div className="card-locked" onPointerDown={onDragStart}>
        <button className="card-icon card-locked-close" title={tr('收起浮窗（Esc）')} aria-label={tr('收起浮窗')} onClick={onHide}>
          <X size={14} />
        </button>
        <div className="card-locked-body">
          <span className="card-locked-icon">
            <Lock size={18} strokeWidth={1.9} />
          </span>
          <div className="card-locked-title">{tr('已上锁')}</div>
          <div className="card-locked-sub">{tr('主窗口已收起，解锁后继续查看待办与灵感')}</div>
          <button className="card-locked-btn" onClick={onUnlock}>
            {tr('解锁')}
          </button>
        </div>
      </div>
    </div>
  );
}
