import { useCallback, useEffect, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { Loader2, Minus, Pin, RefreshCw, SlidersHorizontal, X } from 'lucide-react';
import { bootstrap } from '../lib/storage';
import { readAppHtml, readAppMeta, withCsp, type AppMeta } from '../lib/apps';
import { useAppDataHost } from '../lib/appDataHost';
import { desktop } from '../lib/desktop';
import { applyStoredTheme } from '../lib/theme';
import { appWindowId, appWindowPinned } from '../lib/windowMode';
import { iconFor } from './homeIcons';
import { useAppWindowDrag } from './useAppWindowDrag';
import { cn } from '../lib/utils';
import { t, useT } from '../lib/i18n';

/** 每个应用各自记一份透明度；换应用打开时不继承上一个的值 */
const OPACITY_PREFIX = 'glimnote.appWindow.opacity.';
const PINNED_KEY = 'glimnote.appWindow.pinned';
/** 和主窗口面板同一套规则：最低 20%，别透明到找不到窗口 */
const MIN_OPACITY = 0.2;
/** 和主进程保持一致的最小窗口尺寸 */
const MIN_WIN_W = 360;
const MIN_WIN_H = 300;
/** 四边四角的缩放把手；透明窗体没有系统边缘缩放，自己算尺寸 */
const RESIZE_DIRS = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const;
type ResizeDir = (typeof RESIZE_DIRS)[number];

function readWindowOpacity(appId: string) {
  const raw = localStorage.getItem(OPACITY_PREFIX + appId);
  if (raw === null) return 1;
  const n = Number(raw);
  return Number.isFinite(n) && n >= MIN_OPACITY && n <= 1 ? n : 1;
}

/**
 * 独立小应用窗口：`?app=<id>`。
 *
 * 和主窗口里的大浮层运行的是同一份 HTML，只是把 chrome 换成适合独立窗口的
 * 一条标题栏；代码仍然放进无同源权限的 sandbox iframe，读不到笔记和令牌。
 * 从浮窗再点一次可以给同一个应用开多个窗口，方便并排摆着用。
 */
export function AppWindow() {
  const tr = useT();
  const [app, setApp] = useState<AppMeta | null>(null);
  const [html, setHtml] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  /** iframe 真正画出来之前先盖一层加载提示，避免打开后停在一张空白页上 */
  const [frameReady, setFrameReady] = useState(false);
  // 应用 id 还没读出来之前先按 100%，读到后立刻换成这个应用上次的值
  const [opacity, setOpacity] = useState(1);
  const [opacityOpen, setOpacityOpen] = useState(false);
  // 从主窗口面板图钉打开时带 `pinned=1`：这次窗口直接置顶，不用等用户再点一次
  const [pinned, setPinned] = useState(() => appWindowPinned || localStorage.getItem(PINNED_KEY) === '1');
  /** 鼠标是否在窗口里；静置半透明，移入恢复 100%，和桌面浮窗一致 */
  const [hovering, setHovering] = useState(false);
  const setFrame = useAppDataHost(app?.id || '', appWindowId);
  const bridge = desktop();
  const startWindowDrag = useAppWindowDrag(bridge);

  const load = useCallback(async () => {
    setLoading(true);
    setFrameReady(false);
    setError('');
    try {
      await bootstrap();
      const meta = await readAppMeta(appWindowId);
      if (!meta) {
        setError(tr('这个应用已经不在了，可能被删除或同步覆盖。回到主窗口的首页可以重新创建。'));
        return;
      }
      setApp(meta);
      setOpacity(readWindowOpacity(meta.id));
      document.title = tr('{name} · 萤光笔记', { name: meta.name });
      const code = await readAppHtml(meta.id);
      setHtml(code);
      if (!code) setError(tr('应用代码读不到了，可能已被删除或同步覆盖。'));
    } catch (e) {
      setError((e as Error)?.message || tr('读取应用失败'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    applyStoredTheme();
    document.title = t('小应用 · 萤光笔记');
    void load();
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'glimnote.theme') applyStoredTheme();
      if (e.key === PINNED_KEY) {
        const next = localStorage.getItem(PINNED_KEY) === '1';
        setPinned(next);
        void bridge?.setAppWindowPinned?.(next);
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [bridge, load]);

  // 同一个应用开多个窗口时，一个窗口调了透明度，另一个跟着变；别的应用不受影响
  useEffect(() => {
    const id = app?.id;
    if (!id) return;
    const key = OPACITY_PREFIX + id;
    const onStorage = (e: StorageEvent) => {
      if (e.key === key) setOpacity(readWindowOpacity(id));
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [app?.id]);

  // 图钉状态以主进程为准：从面板图钉打开（`pinned=1`）、复用已开窗口时被直接置顶、
  // 上次关窗时是置顶的，都在这里同步，标题栏图标不会和窗口真实状态对不上。
  useEffect(() => {
    if (!bridge?.setAppWindowPinned || !bridge.isAppWindowPinned) return;
    let alive = true;
    const sync = () => {
      void bridge
        .isAppWindowPinned?.()
        .then((value) => {
          if (alive) setPinned(Boolean(value));
        })
        .catch(() => {});
    };
    if (appWindowPinned || localStorage.getItem(PINNED_KEY) === '1') {
      void bridge
        .setAppWindowPinned(true)
        .then(sync)
        .catch(() => {});
    } else {
      sync();
    }
    window.addEventListener('focus', sync);
    return () => {
      alive = false;
      window.removeEventListener('focus', sync);
    };
  }, [bridge]);

  // 桌面端用系统窗口透明度（透明窗体会丢掉边缘缩放）；网页版没有这层桥，
  // 继续用 CSS opacity 兜底。鼠标在窗口里时始终保持 100%：调透明度时设置面板
  // 也是清楚的，移出窗口后才按设定值淡出。
  useEffect(() => {
    if (!bridge?.setAppWindowOpacity) return;
    void bridge.setAppWindowOpacity(hovering ? 1 : opacity).catch(() => {});
  }, [bridge, hovering, opacity]);

  // 透明度弹层开着时按 Esc 也能关，和点遮罩一样，避免只能靠点空白处
  useEffect(() => {
    if (!opacityOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpacityOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [opacityOpen]);

  const changeOpacity = (value: number) => {
    const next = Math.min(1, Math.max(MIN_OPACITY, Math.round(value * 100) / 100));
    setOpacity(next);
    const id = app?.id;
    if (!id) return;
    try {
      localStorage.setItem(OPACITY_PREFIX + id, String(next));
    } catch {
      /* 存不下只影响下次打开的默认值 */
    }
  };

  const togglePinned = async () => {
    if (!bridge?.setAppWindowPinned) return;
    const next = !pinned;
    setPinned(next);
    try {
      const value = await bridge.setAppWindowPinned(next);
      setPinned(Boolean(value));
      try {
        localStorage.setItem(PINNED_KEY, value ? '1' : '0');
      } catch {
        /* 记不住就只在本次窗口生效 */
      }
    } catch {
      setPinned(!next);
    }
  };

  // 从浮窗打开的小应用没有任务栏入口：主进程会把它收进桌面底部的合并条；
  // 其它来源的窗口照旧是系统最小化
  const minimizeWindow = async () => {
    try {
      await bridge?.minimizeAppWindow?.();
    } catch {
      /* 主进程没响应：保持原样 */
    }
  };

  // 透明窗体不能用系统最大化，主进程按工作区尺寸切换；双击标题栏走这里
  const toggleMaximize = async () => {
    try {
      await bridge?.maximizeAppWindow?.();
    } catch {
      /* 失败就保持原样 */
    }
  };

  // 透明窗体没有系统边缘缩放：四边四角各一条隐形把手，拖动时自己算窗口尺寸
  const startResize = async (dir: ResizeDir, event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    const api = bridge;
    if (!api?.appWindowBounds || !api.setAppWindowBounds) return;
    event.preventDefault();
    event.stopPropagation();
    const start = await api.appWindowBounds();
    if (!start) return;
    const sx = event.screenX;
    const sy = event.screenY;
    const target = event.currentTarget;
    const pointerId = event.pointerId;
    let next = { x: start.x, y: start.y, width: start.width, height: start.height };
    let last = 0;

    const send = () => {
      void api.setAppWindowBounds?.(next).catch(() => {});
    };
    const move = (ev: PointerEvent) => {
      const dx = ev.screenX - sx;
      const dy = ev.screenY - sy;
      let { x, y, width, height } = start;
      if (dir.includes('e')) width = Math.max(MIN_WIN_W, start.width + dx);
      if (dir.includes('s')) height = Math.max(MIN_WIN_H, start.height + dy);
      if (dir.includes('w')) {
        width = Math.max(MIN_WIN_W, start.width - dx);
        x = start.x + start.width - width;
      }
      if (dir.includes('n')) {
        height = Math.max(MIN_WIN_H, start.height - dy);
        y = start.y + start.height - height;
      }
      next = {
        x: Math.round(x),
        y: Math.round(y),
        width: Math.round(width),
        height: Math.round(height),
      };
      // 约 16ms 一次，够跟手又不会把 IPC 刷爆
      const t = performance.now();
      if (t - last < 16) return;
      last = t;
      send();
    };
    const finish = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      document.documentElement.classList.remove('app-win-resizing');
      send();
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
    document.documentElement.classList.add('app-win-resizing');
    try {
      target.setPointerCapture(pointerId);
    } catch {
      /* window 监听同样能收到 */
    }
  };

  const Icon = iconFor(app?.icon, 'sparkles');

  return (
    <div
      className="app-win"
      // 桌面端透明度交给系统窗口，CSS 只做网页版兜底，避免叠加两次变暗
      style={bridge?.setAppWindowOpacity ? undefined : ({ '--app-win-opacity': opacity } as CSSProperties)}
      onPointerEnter={() => setHovering(true)}
      onPointerLeave={() => setHovering(false)}
    >
      <header
        className="app-win-bar"
        // 透明窗体不能用 -webkit-app-region: drag，标题栏拖动自己发 IPC
        onPointerDown={startWindowDrag}
        onDoubleClick={(event) => {
          if ((event.target as HTMLElement).closest('button, input, .app-win-opacity-pop, .app-win-opacity-veil'))
            return;
          void toggleMaximize();
        }}
      >
        <span className={cn('app-win-icon', app ? `hc-${app.color}` : 'hc-gray')}>
          <Icon size={16} strokeWidth={1.9} />
        </span>
        <div className="app-win-title">
          <strong>{app?.name || tr('小应用')}</strong>
          {app ? <span className="app-win-version">v{app.version}</span> : null}
          {app?.description ? <span className="app-win-desc">{app.description}</span> : null}
        </div>
        <div className="app-win-actions">
          {bridge?.setAppWindowPinned ? (
            <button
              className={cn('icon-btn', pinned && 'pinned')}
              title={pinned ? tr('取消置顶') : tr('置顶窗口')}
              aria-label={pinned ? tr('取消置顶') : tr('置顶窗口')}
              aria-pressed={pinned}
              onClick={() => void togglePinned()}
            >
              <Pin size={15} />
            </button>
          ) : null}
          <div className="app-win-opacity-wrap">
            <button
              className={cn('icon-btn', opacityOpen && 'on')}
              title={tr('窗口透明度')}
              aria-label={tr('窗口透明度')}
              aria-expanded={opacityOpen}
              onClick={() => setOpacityOpen((value) => !value)}
            >
              <SlidersHorizontal size={15} />
            </button>
            {opacityOpen ? (
              <>
                <div
                  className="app-win-opacity-veil"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={() => setOpacityOpen(false)}
                />
                <div
                  className="app-win-opacity-pop"
                  role="dialog"
                  aria-label={tr('窗口透明度')}
                  onPointerDown={(event) => event.stopPropagation()}
                >
                  <div className="app-win-opacity-head">
                    <span>{tr('不透明度')}</span>
                    <b>{Math.round(opacity * 100)}%</b>
                  </div>
                  <input
                    type="range"
                    min={20}
                    max={100}
                    step={5}
                    value={Math.round(opacity * 100)}
                    aria-label={tr('窗口不透明度')}
                    onChange={(e) => changeOpacity(Number(e.target.value) / 100)}
                  />
                  <div className="app-win-opacity-hint">
                    {tr('只影响当前应用；鼠标在窗口里保持 100%，移出后按这个值变透明，最低 20%')}
                  </div>
                </div>
              </>
            ) : null}
          </div>
          <button
            className="icon-btn"
            title={tr('重新加载')}
            aria-label={tr('重新加载应用')}
            onClick={() => setReloadKey((value) => value + 1)}
            disabled={loading || !app}
          >
            <RefreshCw size={15} />
          </button>
          {bridge?.minimizeAppWindow ? (
            <button
              className="icon-btn"
              title={tr('收进底部小条')}
              aria-label={tr('收进底部小条')}
              onClick={() => void minimizeWindow()}
            >
              <Minus size={16} />
            </button>
          ) : null}
          <button className="icon-btn" title={tr('关闭窗口')} aria-label={tr('关闭窗口')} onClick={() => window.close()}>
            <X size={16} />
          </button>
        </div>
      </header>

      <div className="app-win-stage">
        {loading ? (
          <div className="app-win-hint">
            <Loader2 size={16} className="spin" /> {tr('正在打开应用…')}
          </div>
        ) : error ? (
          <div className="app-win-error">{error}</div>
        ) : (
          <>
            <iframe
              key={`${app?.id || appWindowId}-${reloadKey}-${app?.version || 0}`}
              ref={setFrame}
              className="app-win-frame"
              title={app?.name || tr('小应用')}
              sandbox="allow-scripts allow-forms"
              allow="clipboard-write"
              referrerPolicy="no-referrer"
              srcDoc={withCsp(html)}
              style={frameReady ? undefined : { visibility: 'hidden' }}
              onLoad={() => setFrameReady(true)}
            />
            {frameReady ? null : (
              <div className="app-win-loading" role="status" aria-live="polite">
                <Loader2 size={18} className="spin" />
                <span>{tr('正在加载应用页面…')}</span>
              </div>
            )}
          </>
        )}
      </div>

      <footer className="app-win-foot">
        {tr('隔离沙箱运行，可以联网，但读不到笔记和令牌；应用数据保存在仓库里，随同步上云。')}
      </footer>

      {/* 透明窗体没有系统边缘缩放：四边四角各放一条隐形把手，拖动时自己算尺寸 */}
      {bridge?.setAppWindowBounds
        ? RESIZE_DIRS.map((dir) => (
            <span
              key={dir}
              className={`app-win-rz app-win-rz-${dir}`}
              aria-hidden
              onPointerDown={(event) => void startResize(dir, event)}
            />
          ))
        : null}
    </div>
  );
}
