import {
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { X } from 'lucide-react';
import { bootstrap } from '../lib/storage';
import { readAppMeta, type AppMeta } from '../lib/apps';
import { desktop, type AppDockItem } from '../lib/desktop';
import { applyStoredTheme } from '../lib/theme';
import { iconFor } from './homeIcons';
import { cn } from '../lib/utils';
import { t, useT } from '../lib/i18n';

/** 合并条窗口高度：胶囊 + 上下留白，阴影画在透明留白里 */
const DOCK_H = 56;
/**
 * 窗口宽度在胶囊内容宽度之外要多留的像素：左右留白 4px × 2、胶囊描边 1px × 2，
 * 再加一点余量。少算这几像素，最右边那一条就会探出胶囊边框。
 */
const DOCK_CHROME = 12;
/** 指针移动超过这个距离才算拖动，否则仍然当作点击条目 */
const DRAG_THRESHOLD = 5;

/**
 * 桌面底部的合并条（`?dock=1`）。
 *
 * 浮窗小应用最小化后不再各自缩成一条散在桌面上，而是统一收进这一条：
 * 每项只显示应用图标和名字，点一下就在屏幕中央放大，右侧 × 直接关闭。
 * 按住胶囊还能把它拖到不挡内容的地方，松手后主进程把位置记进 prefs。
 */
export function AppDock() {
  const tr = useT();
  const bridge = desktop();
  const [items, setItems] = useState<AppDockItem[]>([]);
  const [metas, setMetas] = useState<Record<string, AppMeta>>({});
  const [ready, setReady] = useState(false);
  const barRef = useRef<HTMLDivElement>(null);
  /** 已经去读过的应用 id：读不到元数据时不要反复重试，否则 effect 会一直转 */
  const requested = useRef(new Set<string>());
  /** 刚拖完的那一下 pointerup 会再生成一个 click，要吞掉，避免误触发条目 */
  const suppressClick = useRef(false);

  useEffect(() => {
    applyStoredTheme();
    document.title = t('小应用小条 · 萤光笔记');
    let alive = true;
    void bootstrap()
      .catch(() => {})
      .finally(() => {
        if (!alive) return;
        setReady(true);
        void bridge
          ?.dockItems?.()
          .then((list) => {
            if (alive) setItems(list);
          })
          .catch(() => {});
      });
    const off = bridge?.onDockUpdate?.((list) => setItems(list));
    const onStorage = (event: StorageEvent) => {
      if (event.key === 'glimnote.theme') applyStoredTheme();
    };
    window.addEventListener('storage', onStorage);
    return () => {
      alive = false;
      off?.();
      window.removeEventListener('storage', onStorage);
    };
  }, [bridge]);

  // 读应用名与图标；同一个小应用开多个窗口时只读一次。
  //
  // 这里不能用 effect 的 cleanup 取消读取：合并条第一次出现时，主进程会先推一次
  // `app:dock-update`，页面自己也拉取一次 `dockItems()`，两次列表内容相同但不是
  // 同一个数组，effect 会再跑一遍并把先发起的那次读取作废；而 id 已经记进
  // `requested`，之后不会再读，条目就永远只剩兜底名「小应用」。
  // 读取本身是幂等的，直接写完即可；失败（应用被删 / 同步还没到）就把 id 放回去，
  // 下次列表变化再试，不能一次失败就永久兜底。
  useEffect(() => {
    if (!ready) return;
    const ids = [...new Set(items.map((item) => item.id))].filter((id) => !requested.current.has(id));
    if (!ids.length) return;
    for (const id of ids) requested.current.add(id);
    void Promise.all(ids.map(async (id) => [id, await readAppMeta(id).catch(() => null)] as const)).then((list) => {
      setMetas((prev) => {
        const next = { ...prev };
        // 按请求时的目录 id 存，而不是 meta.id：两者万一不一致也不能让名字丢
        for (const [id, meta] of list) if (meta) next[id] = meta;
        return next;
      });
      for (const [id, meta] of list) if (!meta) requested.current.delete(id);
    });
  }, [ready, items]);

  // 内容变了把宽度量回去：宽度跟着条目数量收紧，位置由主进程决定（贴底居中或用户拖过的位置）
  useEffect(() => {
    const resize = bridge?.dockResize;
    if (!resize) return;
    let alive = true;
    let frame = 0;
    const measure = () => {
      if (!alive) return;
      // scrollWidth 是胶囊的真实内容宽度，即使窗口暂时比它窄也能量准
      const width = Math.ceil(barRef.current?.scrollWidth || 0) + DOCK_CHROME;
      void resize({ width, height: DOCK_H }).catch(() => {});
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    schedule();
    // 中文字体或应用图标晚到都会让胶囊变宽，字体就绪后再量一次
    void document.fonts?.ready.then(schedule).catch(() => {});
    return () => {
      alive = false;
      cancelAnimationFrame(frame);
    };
  }, [bridge, ready, items, metas]);

  // 按住胶囊拖动：移动超过阈值才开始，松手把位置记进 prefs，下次打开还在原地
  const startDockDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const api = bridge;
    if (!api?.dockDragStart || !api.dockDragMove) return;
    // 每次按下都按「还没拖过」处理，正常点击不会被上一次拖动影响
    suppressClick.current = false;
    const sx = event.screenX;
    const sy = event.screenY;
    const bar = event.currentTarget;
    const pointerId = event.pointerId;
    let origin: { x: number; y: number } | null = null;
    let latestX = sx;
    let latestY = sy;
    let started = false;
    let last = 0;

    const flush = () => {
      if (!origin) return;
      void api.dockDragMove?.({ x: origin.x + latestX - sx, y: origin.y + latestY - sy }).catch(() => {});
    };
    const move = (ev: PointerEvent) => {
      latestX = ev.screenX;
      latestY = ev.screenY;
      if (!started) {
        if (Math.abs(latestX - sx) < DRAG_THRESHOLD && Math.abs(latestY - sy) < DRAG_THRESHOLD) {
          return;
        }
        started = true;
        suppressClick.current = true;
        document.documentElement.classList.add('dock-dragging');
        // 开始拖之后再捕获指针：窗口跟着鼠标走，鼠标偶尔会离开窗口，不捕获会掉线；
        // 放在阈值之后才捕获，普通点击仍然落在条目按钮上
        try {
          bar.setPointerCapture(pointerId);
        } catch {
          /* window 监听同样能收到 */
        }
      }
      // 约 16ms 一次，够跟手又不会把 IPC 刷爆
      const t = performance.now();
      if (t - last < 16) return;
      last = t;
      flush();
    };
    const finish = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      document.documentElement.classList.remove('dock-dragging');
      if (!started) return;
      flush();
      void api.dockDragEnd?.().catch(() => {});
      // 兜底：click 派发完以后清掉标记，键盘触发的点击不会被误吞
      window.setTimeout(() => {
        suppressClick.current = false;
      }, 0);
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
    // 取初始位置是异步的：先记录位移，拿到位置后把这段时间的移动补上
    void api.dockDragStart?.().then((pos) => {
      if (!pos) return;
      origin = pos;
      flush();
    });
  };

  // 拖动结束时浏览器还会补一个 click：吞掉它，免得松手时顺手打开了某个应用
  const swallowClickAfterDrag = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!suppressClick.current) return;
    suppressClick.current = false;
    event.preventDefault();
    event.stopPropagation();
  };

  if (!items.length) return null;

  return (
    <div className="dock">
      <div className="dock-bar" ref={barRef} onPointerDown={startDockDrag} onClickCapture={swallowClickAfterDrag}>
        {items.map((item) => {
          const meta = metas[item.id];
          const Icon = iconFor(meta?.icon, 'sparkles');
          const name = meta?.name || tr('小应用');
          return (
            <div className="dock-chip" key={item.token}>
              <button
                type="button"
                className="dock-chip-main"
                title={tr('打开 {name}', { name })}
                onClick={() => void bridge?.dockActivate?.(item.token)?.catch(() => {})}
              >
                <span className={cn('dock-chip-icon', meta ? `hc-${meta.color}` : 'hc-gray')}>
                  <Icon size={14} strokeWidth={1.9} />
                </span>
                <span className="dock-chip-name">{name}</span>
              </button>
              <button
                type="button"
                className="dock-chip-x"
                title={tr('关闭 {name}', { name })}
                aria-label={tr('关闭 {name}', { name })}
                onClick={() => void bridge?.dockClose?.(item.token)?.catch(() => {})}
              >
                <X size={11} />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
