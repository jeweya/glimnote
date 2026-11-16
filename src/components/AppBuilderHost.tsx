/**
 * AI 小应用生成器的宿主。
 *
 * 挂在主窗口根部、App 的旁边：切页面、锁屏、把窗口收进托盘都不会卸载，
 * 因此后台生成不会中断。所有会话各自保留一份 AppBuilder（最小化时只是
 * 不渲染界面，React 状态和请求都还在），底部任务坞负责把最小化的会话
 * 叫回来，并在生成中提供停止 / 关闭。
 */
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, Check, Clock3, Minimize2, Sparkles, Square, X } from 'lucide-react';
import { useApp } from '../store/app';
import { useAppBuilder, type BuilderSession } from '../store/appBuilder';
import { desktop } from '../lib/desktop';
import { dockLayer } from '../lib/dockLayer';
import { cn } from '../lib/utils';
import { t, useT } from '../lib/i18n';
import { AppBuilder } from './AppBuilder';

function seconds(value: number) {
  return Math.max(0, Math.round(value / 1000));
}

function statusOf(session: BuilderSession, now: number) {
  if (session.busy) {
    const from = session.startedAt || now;
    return t('生成中 · {n}s', { n: seconds(now - from) });
  }
  if (session.phase === 'done') return t('已自动保存 · 点开继续');
  if (session.phase === 'unsaved') return t('没保存成功 · 点开处理');
  if (session.phase === 'error') return t('生成失败 · 点开重试');
  return t('待继续 · 点开编辑');
}

function DockIcon({ session }: { session: BuilderSession }) {
  if (session.busy) return <span className="bdock-spinner" aria-hidden="true" />;
  if (session.phase === 'done') return <Check size={12} strokeWidth={2.4} />;
  if (session.phase === 'error' || session.phase === 'unsaved') return <AlertTriangle size={12} />;
  return <Sparkles size={12} />;
}

export function AppBuilderHost() {
  const tr = useT();
  const sessions = useAppBuilder((s) => s.sessions);
  const confirmingId = useAppBuilder((s) => s.confirming);
  const locked = useApp((s) => s.locked);
  const restore = useAppBuilder((s) => s.restore);
  const requestClose = useAppBuilder((s) => s.requestClose);
  const stop = useAppBuilder((s) => s.stop);
  const cancelClose = useAppBuilder((s) => s.cancelClose);
  const keepInBackground = useAppBuilder((s) => s.keepInBackground);
  const stopAndClose = useAppBuilder((s) => s.stopAndClose);

  const [now, setNow] = useState(() => Date.now());
  const minimized = sessions.filter((s) => s.minimized);
  // 确认框里的已用秒数也要跟着走，所以按全部会话判断是否有生成中
  const anyBusy = sessions.some((s) => s.busy);
  const front = sessions.some((s) => !s.minimized);
  const confirming = sessions.find((s) => s.id === confirmingId) || null;

  // 只在任务坞里确实有生成中的任务时打点，避免空转
  useEffect(() => {
    if (!anyBusy) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [anyBusy]);

  // 点桌面通知回来：主进程已经叫出主窗口，这里把对应会话恢复到前台
  useEffect(() => {
    const bridge = desktop();
    if (!bridge?.onBuilderFocus) return;
    return bridge.onBuilderFocus((id) => {
      if (useAppBuilder.getState().sessions.some((s) => s.id === id)) restore(id);
    });
  }, [restore]);

  // 确认框打开时用捕获阶段拦 Esc，避免同时触发下面生成器的关闭逻辑
  useEffect(() => {
    if (!confirming) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      e.preventDefault();
      cancelClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [confirming, cancelClose]);

  return (
    <>
      {sessions.map((session) => (
        <AppBuilder
          key={session.id}
          sessionId={session.id}
          initial={session.initial}
          incoming={session.incoming}
          visible={!session.minimized && !locked}
        />
      ))}

      {!locked &&
        !front &&
        minimized.length > 0 &&
        createPortal(
          <div className="builder-dock" role="toolbar" aria-label={tr('后台 AI 生成任务')}>
            <div className="builder-dock-label">
              <Sparkles size={12} />
              <span>{tr('后台任务')}</span>
            </div>
            {minimized.map((session) => (
              <div
                key={session.id}
                className={cn(
                  'builder-dock-chip',
                  session.busy && 'is-busy',
                  session.phase === 'done' && 'is-done',
                  (session.phase === 'error' || session.phase === 'unsaved') && 'is-error',
                )}
              >
                <button className="bdock-main" onClick={() => restore(session.id)} title={tr('回到生成器')}>
                  <span className="bdock-icon">
                    <DockIcon session={session} />
                  </span>
                  <span className="bdock-text">
                    <span className="bdock-name">{session.label}</span>
                    <span className="bdock-status">{statusOf(session, now)}</span>
                  </span>
                </button>
                {session.busy && (
                  <button
                    className="bdock-act"
                    title={tr('停止生成（保留窗口）')}
                    aria-label={tr('停止生成')}
                    onClick={() => stop(session.id)}
                  >
                    <Square size={10} strokeWidth={2.4} />
                  </button>
                )}
                <button
                  className="bdock-close"
                  title={session.busy ? tr('关闭（会先问你）') : tr('关闭')}
                  aria-label={tr('关闭')}
                  onClick={() => requestClose(session.id)}
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>,
          dockLayer(),
        )}

      {!locked &&
        confirming &&
        createPortal(
          <div className="overlay overlay-confirm" role="dialog" aria-modal="true" aria-label={tr('生成还在进行')}>
            <div className="modal builder-confirm">
              <div className="modal-head">
                <div>
                  <div className="modal-title builder-confirm-title">
                    <span className="bcf-icon">
                      <Sparkles size={15} />
                    </span>
                    {tr('「{label}」还在生成', { label: confirming.label })}
                  </div>
                  <div className="modal-desc">
                    {tr('已经用了 {n} 秒。现在关掉会中断这次生成；', { n: seconds(now - (confirming.startedAt || now)) })}
                    {confirming.minimized
                      ? tr('选择「继续生成」就留在后台接着跑，完成后会在桌面右下角提醒你。')
                      : tr('也可以最小化到后台，写别的、去别的页面都行，完成后会在桌面右下角提醒你。')}
                  </div>
                </div>
              </div>
              <div className="builder-confirm-note">
                <Clock3 size={13} />
                <span>{tr('这一轮生成结果还没出来，关掉会中断；已经自动保存过的版本不受影响。')}</span>
              </div>
              <div className="modal-foot builder-confirm-foot">
                {!confirming.minimized && (
                  <button className="btn btn-ghost" onClick={cancelClose}>
                    {tr('继续等待')}
                  </button>
                )}
                <button className="btn btn-danger" onClick={() => stopAndClose(confirming.id)}>
                  <X size={13} /> {tr('停止并关闭')}
                </button>
                <button
                  className="btn btn-primary"
                  onClick={confirming.minimized ? cancelClose : () => keepInBackground(confirming.id)}
                >
                  {confirming.minimized ? (
                    <>
                      <Clock3 size={13} /> {tr('继续生成')}
                    </>
                  ) : (
                    <>
                      <Minimize2 size={13} /> {tr('最小化后台继续')}
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
