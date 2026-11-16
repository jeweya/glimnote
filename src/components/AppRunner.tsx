import { useCallback, useEffect, useState } from 'react';
import { Loader2, Minus, Pin, RefreshCw, Wand2, X } from 'lucide-react';
import { bootstrap } from '../lib/storage';
import { readAppHtml, readAppMeta, withCsp, type AppMeta } from '../lib/apps';
import { useAppDataHost } from '../lib/appDataHost';
import { useAppBuilder } from '../store/appBuilder';
import { desktop } from '../lib/desktop';
import { useT } from '../lib/i18n';
import { iconFor } from './homeIcons';
import { ConfirmDialog } from './Confirm';

interface Props {
  appId: string;
  /** 第几个窗口：层叠时依次向右下错开一点，让人看到后面还开着别的应用 */
  stack: number;
  /** 是否在最上层：标题栏描边高亮，避免分不清当前操作的是哪个 */
  active: boolean;
  /** 收进任务坞：保留 iframe 不卸载，应用里的临时状态不会丢 */
  minimized: boolean;
  zIndex: number;
  onRaise: () => void;
  onMinimize: () => void;
  onClose: () => void;
}

/**
 * 主窗口内的 AI 小应用运行器。
 *
 * 首页点小应用就在这里打开，不再一上来就弹独立窗口，浮窗出问题时应用本身
 * 也一定能用。可以同时开多个：后开的压在上层，最小化后收进底部任务坞，
 * 需要时再点回来；右上角的 AI 按钮直接带着当前代码打开生成器继续修改。
 */
export function AppRunner({ appId, stack, active, minimized, zIndex, onRaise, onMinimize, onClose }: Props) {
  const t = useT();
  const [app, setApp] = useState<AppMeta | null>(null);
  const [html, setHtml] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  /** 代码读完了不等于画出来了：iframe 里的 CDN 库、首屏渲染还要一两秒 */
  const [frameReady, setFrameReady] = useState(false);
  const [pinAsk, setPinAsk] = useState(false);
  const setFrame = useAppDataHost(app?.id || '', app?.id || appId);
  const bridge = desktop();

  const load = useCallback(async () => {
    setLoading(true);
    setFrameReady(false);
    setError('');
    try {
      await bootstrap();
      const meta = await readAppMeta(appId);
      if (!meta) {
        setError(t('这个应用已经不在了，可能被删除或同步覆盖。'));
        return;
      }
      setApp(meta);
      const code = await readAppHtml(meta.id);
      setHtml(code);
      if (!code) setError(t('应用代码读不到了，可能已被删除或同步覆盖。'));
    } catch (e) {
      setError((e as Error)?.message || t('读取应用失败'));
    } finally {
      setLoading(false);
    }
  }, [appId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  /** 带着当前代码打开 AI 生成器：改完保存后，这里的 iframe 通过仓库刷新事件重新加载 */
  const editWithAi = () => {
    if (!app || !html) return;
    useAppBuilder.getState().open({ initial: { meta: app, html } });
  };

  /**
   * 切换为桌面置顶浮窗：主窗口的面板必须关掉，窗口才能独立存在，应用里的
   * 临时输入也会重置。所以先说明清楚再动手，避免用户以为点完应用崩了。
   */
  const sendToDesktop = async () => {
    setPinAsk(false);
    if (!app || !bridge?.openAppWindow) return;
    try {
      const ok = await bridge.openAppWindow(app.id, { pinned: true });
      if (ok) onClose();
    } catch {
      /* 打开失败就保留面板，内容还在，不影响继续用 */
    }
  };

  const Icon = iconFor(app?.icon, 'sparkles');

  return (
    <div
      className={`app-runner${active ? ' is-active' : ''}${minimized ? ' is-minimized' : ''}`}
      role="dialog"
      aria-label={app?.name || t('小应用')}
      style={{
        zIndex,
        // 右下错开形成层叠；顶层窗口保持在正中
        transform: `translate(calc(-50% + ${stack * 12}px), calc(-50% + ${stack * 10}px))`,
      }}
      onMouseDown={onRaise}
    >
      <header className="app-runner-bar">
        <div className="app-runner-title">
          <span className={app ? `app-runner-icon hc-${app.color}` : 'app-runner-icon hc-gray'}>
            <Icon size={15} strokeWidth={1.9} />
          </span>
          <span className="app-runner-dot" aria-hidden="true" />
          <strong>{app?.name || t('小应用')}</strong>
          {app ? <span className="app-runner-version">v{app.version}</span> : null}
          {app?.description ? <span className="app-runner-desc">{app.description}</span> : null}
        </div>
        <div className="app-runner-actions">
          {bridge?.openAppWindow ? (
            <button
              className="icon-btn"
              onClick={() => setPinAsk(true)}
              disabled={!app || loading}
              title={t('切换为桌面置顶浮窗')}
              aria-label={t('切换为桌面置顶浮窗')}
            >
              <Pin size={15} />
            </button>
          ) : null}
          <button
            className="icon-btn"
            onClick={editWithAi}
            disabled={!app || !html || loading}
            title={t('用 AI 修改这个应用')}
            aria-label={t('用 AI 修改')}
          >
            <Wand2 size={15} />
          </button>
          <button
            className="icon-btn"
            title={t('重新加载')}
            aria-label={t('重新加载应用')}
            onClick={() => {
              setReloadKey((value) => value + 1);
              void load();
            }}
            disabled={loading || !app}
          >
            <RefreshCw size={15} />
          </button>
          <button className="icon-btn" title={t('最小化')} aria-label={t('最小化')} onClick={onMinimize}>
            <Minus size={15} />
          </button>
          <button className="icon-btn" title={t('关闭')} aria-label={t('关闭')} onClick={onClose}>
            <X size={16} />
          </button>
        </div>
      </header>

      <div className="app-runner-stage">
        {loading ? (
          <div className="app-runner-hint">
            <Loader2 size={16} className="spin" /> {t('正在打开应用…')}
          </div>
        ) : error ? (
          <div className="app-runner-error">{error}</div>
        ) : (
          <>
            <iframe
              key={`${app?.id || appId}-${reloadKey}-${app?.version || 0}`}
              ref={setFrame}
              className="app-runner-frame"
              title={app?.name || t('小应用')}
              sandbox="allow-scripts allow-forms"
              allow="clipboard-write"
              referrerPolicy="no-referrer"
              srcDoc={withCsp(html)}
              style={frameReady ? undefined : { visibility: 'hidden' }}
              onLoad={() => setFrameReady(true)}
            />
            {frameReady ? null : (
              <div className="app-runner-loading" role="status" aria-live="polite">
                <Loader2 size={18} className="spin" />
                <span>{t('正在加载应用页面…')}</span>
              </div>
            )}
          </>
        )}
      </div>

      <footer className="app-runner-foot">
        {t('隔离沙箱运行，可以联网，但读不到笔记和令牌；应用数据保存在仓库里，随同步上云。')}
      </footer>

      {pinAsk ? (
        <ConfirmDialog
          title={t('切换为桌面置顶浮窗？')}
          desc={t('这里的小应用面板会先关闭，再在桌面上以置顶窗口重新打开，方便边看笔记边用。应用里没保存的临时输入会重置，已保存的数据不受影响。')}
          confirmLabel={t('切换')}
          cancelLabel={t('取消')}
          onCancel={() => setPinAsk(false)}
          onConfirm={() => void sendToDesktop()}
        />
      ) : null}
    </div>
  );
}
