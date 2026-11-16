import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import {
  AppWindow,
  Check,
  FolderOpen,
  LayoutGrid,
  Loader2,
  RefreshCw,
  Search,
  SearchX,
  Sparkles,
  X,
} from 'lucide-react';
import type { Note } from '../lib/markdown';
import type { AppMeta } from '../lib/apps';
import {
  HOME_COLORS,
  HOME_VIEWS,
  LEGACY_SHORTCUT_TYPES,
  SHORTCUT_PICKER_TYPES,
  SHORTCUT_TYPE_LABEL,
  hostOf,
  normalizeUrl,
  type HomeColor,
  type HomeEntry,
  type HomeGroup,
  type ShortcutType,
} from '../lib/home';
import { desktop, type SystemApp } from '../lib/desktop';
import { COMMON_SITES, commonAppRank } from '../lib/shortcutPresets';
import { HOME_ICON_OPTIONS, iconFor } from './homeIcons';
import { cn } from '../lib/utils';
import { useT } from '../lib/i18n';

interface Props {
  open: boolean;
  entry?: HomeEntry | null;
  defaultGroupId?: string;
  groups: HomeGroup[];
  notes: Note[];
  notebooks: string[];
  apps: AppMeta[];
  onClose: () => void;
  /** 小应用列表里找不到时，直接跳到「用 AI 生成小应用」 */
  onCreateApp?: () => void;
  /** 小应用列表里找不到时，跳到应用市场挑现成的 */
  onOpenMarket?: () => void;
  onSave: (
    input: {
      type: ShortcutType;
      title?: string;
      icon?: string;
      color?: HomeColor;
      target?: string;
    },
    groupId: string,
    entryId?: string,
  ) => Promise<void>;
}

const DEFAULT_ICON: Record<ShortcutType, string> = {
  note: 'file',
  notebook: 'folder',
  daily: 'pen',
  view: 'grid',
  url: 'globe',
  app: 'sparkles',
  system: 'monitor',
};

/** 图标加载状态：loading 显示转圈，none 表示这个程序确实取不到图标 */
type SysIconPhase = 'loading' | 'none';

/**
 * 系统应用图标懒加载。
 *
 * 扫描结果通常有几十到几百个，用户真正会选的只有几个。这里用 IntersectionObserver
 * 盯着卡片：进入视口（含 140px 预取边距）才请求图标，滚出视口的不请求；
 * 请求期间显示转圈占位，取不到再退回窗口图标。这样弹窗打开时只加载看得见的几张。
 */
function LazySystemIcon({
  path,
  url,
  phase,
  onNeed,
}: {
  path: string;
  url?: string;
  phase?: SysIconPhase;
  onNeed: (path: string) => void;
}) {
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (url || phase === 'none') return;
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === 'undefined') {
      onNeed(path);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          onNeed(path);
          io.disconnect();
        }
      },
      { rootMargin: '140px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [path, url, phase, onNeed]);

  return (
    <span className="home-app-icon sys" ref={ref}>
      {url ? (
        <img src={url} alt="" draggable={false} />
      ) : phase === 'loading' ? (
        <Loader2 size={15} strokeWidth={1.8} className="spin" />
      ) : (
        <AppWindow size={17} strokeWidth={1.6} />
      )}
    </span>
  );
}

export function ShortcutDialog({
  open,
  entry,
  defaultGroupId,
  groups,
  notes,
  notebooks,
  apps,
  onClose,
  onCreateApp,
  onOpenMarket,
  onSave,
}: Props) {
  const tr = useT();
  // 默认选中选择器里的第一个类型（系统应用），和按钮顺序保持一致
  const defaultType = SHORTCUT_PICKER_TYPES[0] || 'system';
  const [type, setType] = useState<ShortcutType>(defaultType);
  const [title, setTitle] = useState('');
  const [target, setTarget] = useState('');
  const [icon, setIcon] = useState(DEFAULT_ICON[defaultType]);
  const [color, setColor] = useState<HomeColor>('green');
  const [groupId, setGroupId] = useState('');
  const [query, setQuery] = useState('');
  const [appQuery, setAppQuery] = useState('');
  const [sysQuery, setSysQuery] = useState('');
  const [sysApps, setSysApps] = useState<SystemApp[] | null>(null);
  const [sysLoading, setSysLoading] = useState(false);
  const [sysError, setSysError] = useState('');
  const [sysPicking, setSysPicking] = useState(false);
  const [sysIcons, setSysIcons] = useState<Record<string, string>>({});
  const [sysIconPhase, setSysIconPhase] = useState<Record<string, SysIconPhase>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const appGridRef = useRef<HTMLDivElement>(null);
  const sysGridRef = useRef<HTMLDivElement>(null);
  /** 只在「打开编辑已有入口」时定位一次，用户点卡片不再跳动 */
  const appPickScroll = useRef(false);
  const sysPickScroll = useRef(false);
  const sysLoadedRef = useRef(false);
  const sysRequestRef = useRef(false);
  /** 记住自动填入的应用名，换一个应用时才能跟着改，用户手改过的名称不动 */
  const autoTitleRef = useRef('');
  /** 本次展开已经初始化过哪一份入口；后台刷新手首页数据时不重新重置表单 */
  const initKeyRef = useRef<string | null>(null);
  /** 图标请求队列：只收看得见的卡片，攒一小批一起交给主进程 */
  const sysIconsRef = useRef<Record<string, string>>({});
  const iconQueueRef = useRef<string[]>([]);
  const iconTimerRef = useRef<number | null>(null);
  const iconInflightRef = useRef<Set<string>>(new Set());
  const iconTriedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    sysIconsRef.current = sysIcons;
  }, [sysIcons]);

  useEffect(() => {
    if (!open) {
      initKeyRef.current = null;
      return;
    }
    /*
     * 只在这个弹窗「刚展开」或「换成另一条入口」时初始化。
     *
     * 之前这里直接依赖 groups：首页后台同步（repo-refreshed）会把分组重新读一遍，
     * 得到一个全新的数组引用，即便内容没变，也会让这个 effect 重跑并把类型打回
     * entry?.type || 默认类型。表现就是选着「系统应用 / AI 应用」时，隔一会儿突然
     * 跳回第一个类型——刷新时机随机，所以看起来毫无规律。
     */
    const key = entry?.id ? `edit:${entry.id}` : 'new';
    if (initKeyRef.current === key) return;
    initKeyRef.current = key;
    const t = entry?.type || defaultType;
    setType(t);
    setTitle(entry?.title || '');
    setTarget(entry?.target || '');
    setIcon(entry?.icon || DEFAULT_ICON[t]);
    setColor(entry?.color || 'green');
    setGroupId(
      entry
        ? groups.find((g) => g.entries.includes(entry.id))?.id || defaultGroupId || groups[0]?.id || ''
        : defaultGroupId || groups[0]?.id || '',
    );
    setQuery('');
    setAppQuery('');
    setSysQuery('');
    setSysError('');
    setSysPicking(false);
    setBusy(false);
    setError('');
    autoTitleRef.current = '';
    appPickScroll.current = Boolean(entry?.type === 'app' && entry?.target);
    sysPickScroll.current = Boolean(entry?.type === 'system' && entry?.target);
  }, [open, entry, defaultGroupId, groups]);

  // 分组在后台刷新后可能改名 / 删除；只修正分组选择，不动用户正在填的类型和内容
  useEffect(() => {
    if (!open || !groups.length) return;
    if (groups.some((g) => g.id === groupId)) return;
    const fallback = defaultGroupId && groups.some((g) => g.id === defaultGroupId) ? defaultGroupId : groups[0].id;
    setGroupId(fallback);
  }, [open, groups, groupId, defaultGroupId]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, busy, onClose]);

  const noteList = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? notes.filter((n) => `${n.title} ${n.notebook}`.toLowerCase().includes(q))
      : [...notes].sort((a, b) => +new Date(b.updated) - +new Date(a.updated));
    return list.slice(0, 30);
  }, [notes, query]);

  const notebookList = useMemo(() => {
    const set = new Set(notebooks.filter(Boolean));
    for (const n of notes) if (n.notebook) set.add(n.notebook);
    return Array.from(set).sort((a, b) => a.localeCompare(b, 'zh-CN'));
  }, [notebooks, notes]);

  // 应用一多，下拉框既看不全也分不清：改成可搜索的卡片墙，名称与说明都能搜
  const appList = useMemo(() => {
    const q = appQuery.trim().toLowerCase();
    if (!q) return apps;
    return apps.filter((app) => `${app.name} ${app.description}`.toLowerCase().includes(q));
  }, [apps, appQuery]);

  const selectedApp = useMemo(() => apps.find((app) => app.id === target) || null, [apps, target]);

  const typeOptions = useMemo(() => {
    const list = [...SHORTCUT_PICKER_TYPES];
    // 编辑旧入口时把原类型留在选择器里，不逼用户改掉一个还能正常用的入口
    if (entry && LEGACY_SHORTCUT_TYPES.includes(entry.type)) list.push(entry.type);
    return list;
  }, [entry]);

  const sysList = useMemo(() => {
    const all = sysApps || [];
    const q = sysQuery.trim().toLowerCase();
    const list = q ? all.filter((app) => `${app.name} ${app.path}`.toLowerCase().includes(q)) : [...all];
    // 常用软件排前面：微信、钉钉、企微、飞书……其余按名称排。
    // 搜索时也保持这个顺序，找「微信」时不会先冒出微信开发者工具。
    return list.sort((a, b) => {
      const diff = commonAppRank(a) - commonAppRank(b);
      return diff !== 0 ? diff : a.name.localeCompare(b.name, 'zh-CN');
    });
  }, [sysApps, sysQuery]);
  const sysShown = useMemo(() => sysList.slice(0, 120), [sysList]);
  /** 当前展示里排在最前面的常用应用数量，用来插「常用 / 其他应用」小标题 */
  const sysCommonCount = useMemo(() => {
    if (sysQuery.trim()) return 0;
    let count = 0;
    for (const app of sysShown) {
      if (commonAppRank(app) >= 999) break;
      count += 1;
    }
    return count;
  }, [sysShown, sysQuery]);
  const selectedSystem = useMemo(() => (sysApps || []).find((app) => app.path === target) || null, [sysApps, target]);

  const markIconPhase = useCallback((paths: string[], phase: SysIconPhase | null) => {
    setSysIconPhase((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const path of paths) {
        if (phase === null) {
          if (path in next) {
            delete next[path];
            changed = true;
          }
        } else if (next[path] !== phase) {
          next[path] = phase;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, []);

  /** 把队列里攒下的一小批路径交给主进程；主进程内部再 6 个一组取图标 */
  const flushSysIcons = () => {
    iconTimerRef.current = null;
    const batch = iconQueueRef.current.splice(0, 24);
    if (!batch.length) return;
    const bridge = desktop();
    const settle = (map: Record<string, string> | null) => {
      const reached: string[] = [];
      const missing: string[] = [];
      for (const path of batch) (map && map[path] ? reached : missing).push(path);
      if (reached.length && map) {
        setSysIcons((prev) => {
          const next = { ...prev };
          for (const path of reached) next[path] = map[path];
          return next;
        });
      }
      markIconPhase(reached, null);
      markIconPhase(missing, 'none');
      for (const path of batch) {
        iconInflightRef.current.delete(path);
        iconTriedRef.current.add(path);
      }
      if (iconQueueRef.current.length) {
        iconTimerRef.current = window.setTimeout(flushSysIcons, 80);
      }
    };
    if (!bridge?.systemAppIcons) {
      settle(null);
      return;
    }
    void bridge
      .systemAppIcons(batch)
      .then((map) => settle(map || null))
      .catch(() => settle(null));
  };

  /** 卡片真正滚进视口时才调用；重试用于「手动选择」刚加进来的程序 */
  const requestSysIcon = useCallback(
    (path: string, retry = false) => {
      if (!path) return;
      if (iconInflightRef.current.has(path)) return;
      if (!retry && (sysIconsRef.current[path] || iconTriedRef.current.has(path))) return;
      if (retry) iconTriedRef.current.delete(path);
      iconInflightRef.current.add(path);
      iconQueueRef.current.push(path);
      markIconPhase([path], 'loading');
      if (iconTimerRef.current == null) {
        iconTimerRef.current = window.setTimeout(flushSysIcons, 90);
      }
    },
    [markIconPhase],
  );

  useEffect(
    () => () => {
      if (iconTimerRef.current != null) window.clearTimeout(iconTimerRef.current);
      iconTimerRef.current = null;
      iconQueueRef.current = [];
    },
    [],
  );

  const loadSystemApps = (force = false) => {
    if (sysRequestRef.current) return;
    if (sysLoadedRef.current && !force) return;
    const bridge = desktop();
    if (!bridge?.listSystemApps) {
      sysLoadedRef.current = true;
      setSysApps([]);
      setSysError(tr('系统应用需要桌面客户端：网页版读不到电脑上的程序。'));
      return;
    }
    if (force) {
      // 重新扫描时主进程会清掉图标缓存，这里也把「取过但没有」的记录清空，给失败的图标一次机会
      iconTriedRef.current.clear();
      iconQueueRef.current = [];
      setSysIcons({});
      setSysIconPhase({});
    }
    sysRequestRef.current = true;
    setSysLoading(true);
    setSysError('');
    void bridge
      .listSystemApps(force)
      .then((res) => {
        sysLoadedRef.current = true;
        setSysApps(res.apps || []);
        setSysError(res.error || '');
      })
      .catch((e: unknown) => {
        sysLoadedRef.current = true;
        setSysApps([]);
        setSysError((e as Error)?.message || tr('扫描本机应用失败，请重试'));
      })
      .finally(() => {
        sysRequestRef.current = false;
        setSysLoading(false);
      });
  };

  useEffect(() => {
    if (open && type === 'system') loadSystemApps(false);
    // 只在打开弹窗 / 切到系统应用时扫一次；重复扫描由「重新扫描」按钮触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, type]);

  // 编辑已有入口时，把选中的应用滚到卡片墙中间；只定位一次，点选别的卡片不会跳
  useEffect(() => {
    if (!open || type !== 'app' || !target || !appPickScroll.current) return;
    const grid = appGridRef.current;
    const card = grid?.querySelector('.home-app-card.on') as HTMLElement | null;
    if (!grid || !card) return;
    const box = grid.getBoundingClientRect();
    const row = card.getBoundingClientRect();
    grid.scrollTop += row.top - box.top - (grid.clientHeight - row.height) / 2;
    appPickScroll.current = false;
  }, [open, type, target]);

  useEffect(() => {
    if (!open || type !== 'system' || !target || !sysPickScroll.current) return;
    const grid = sysGridRef.current;
    const card = grid?.querySelector('.home-app-card.on') as HTMLElement | null;
    if (!grid || !card) return;
    const box = grid.getBoundingClientRect();
    const row = card.getBoundingClientRect();
    grid.scrollTop += row.top - box.top - (grid.clientHeight - row.height) / 2;
    sysPickScroll.current = false;
  }, [open, type, target]);

  if (!open) return null;

  const chooseSystem = (app: SystemApp) => {
    setTarget(app.path);
    // 名称默认跟应用走；用户手改过就保留，换应用时也能正确更新自动填入的旧名字
    setTitle((prev) => {
      if (!prev.trim() || prev === autoTitleRef.current) {
        autoTitleRef.current = app.name;
        return app.name;
      }
      return prev;
    });
  };

  const chooseSite = (site: (typeof COMMON_SITES)[number]) => {
    setTarget(site.url);
    setTitle((prev) => {
      if (!prev.trim() || prev === autoTitleRef.current) {
        autoTitleRef.current = site.name;
        return site.name;
      }
      return prev;
    });
  };

  /** 开始菜单里扫不到的程序（绿色版、非标准安装位置），让用户自己选 */
  const pickSystemApp = async () => {
    const bridge = desktop();
    if (!bridge?.pickSystemApp) {
      setSysError(tr('手动选择程序需要在桌面客户端里使用。'));
      return;
    }
    setSysPicking(true);
    setSysError('');
    try {
      const result = await bridge.pickSystemApp();
      if (result?.canceled) return;
      if (!result?.app) {
        setSysError(result?.error || tr('这个文件不能作为应用入口，请换一个程序或快捷方式。'));
        return;
      }
      const picked = result.app;
      setSysApps((prev) => {
        const rest = (prev || []).filter((app) => app.path !== picked.path);
        return [...rest, picked].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
      });
      // 保留当前搜索词：手动选中的程序在结果下方单独展示，不会被搜索条件藏起来
      chooseSystem(picked);
      // 手选的程序不在当前扫描结果里，补一次图标；之前取失败过的也允许再试
      requestSysIcon(picked.path, true);
    } catch {
      setSysError(tr('没能打开文件选择框，请稍后再试。'));
    } finally {
      setSysPicking(false);
    }
  };

  const changeType = (next: ShortcutType) => {
    setType(next);
    setIcon(DEFAULT_ICON[next]);
    setTarget('');
    setQuery('');
    setAppQuery('');
    setSysQuery('');
    setError('');
  };

  const submit = async () => {
    let finalTarget = target.trim();
    if (type === 'url') {
      const url = normalizeUrl(finalTarget);
      if (!url) {
        setError(tr('网址格式不正确，只支持 http / https'));
        return;
      }
      finalTarget = url;
    }
    if (type !== 'daily' && !finalTarget) {
      setError(
        type === 'note'
          ? tr('先选一篇笔记')
          : type === 'notebook'
            ? tr('先选一个笔记本')
            : type === 'app'
              ? tr('先选一个小应用')
              : type === 'system'
                ? tr('先选一个系统应用')
                : tr('先选一个视图'),
      );
      return;
    }
    if (!groupId) {
      setError(tr('先选一个分组'));
      return;
    }
    setBusy(true);
    setError('');
    try {
      await onSave(
        type === 'app'
          ? { type, title: undefined, icon: undefined, color: undefined, target: finalTarget }
          : { type, title: title.trim() || undefined, icon, color, target: type === 'daily' ? undefined : finalTarget },
        groupId,
        entry?.id,
      );
      onClose();
    } catch (e) {
      setError((e as Error).message || tr('保存失败'));
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div className="overlay home-dialog-overlay">
      <div className="modal home-dialog" role="dialog" aria-modal="true" aria-label={entry ? tr('编辑入口') : tr('新建入口')}>
        <div className="modal-head">
          <div>
            <div className="modal-title">{entry ? tr('编辑入口') : tr('新建入口')}</div>
            <div className="modal-desc">{tr('快捷入口只保存指向，不会复制笔记或网页内容。')}</div>
          </div>
          <button className="icon-btn" onClick={onClose} disabled={busy} aria-label={tr('关闭')}>
            <X size={16} />
          </button>
        </div>

        <div className="modal-body home-dialog-body">
          <div className="field">
            <label>{tr('类型')}</label>
            <div className="home-type-grid">
              {typeOptions.map((value) => {
                const Icon = iconFor(DEFAULT_ICON[value], 'star');
                return (
                  <button
                    key={value}
                    type="button"
                    className={cn('home-type-btn', type === value && 'on')}
                    onClick={() => changeType(value)}
                  >
                    <Icon size={15} strokeWidth={1.75} />
                    {tr(SHORTCUT_TYPE_LABEL[value])}
                  </button>
                );
              })}
            </div>
          </div>

          <div className={cn('home-dialog-row', type === 'app' && 'single')}>
            <div className="field">
              <label>{tr('放到分组')}</label>
              <select className="input" value={groupId} onChange={(e) => setGroupId(e.target.value)}>
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </select>
            </div>
            {type !== 'app' && (
              <div className="field">
                <label>{tr('名称（可留空）')}</label>
                <input
                  className="input"
                  value={title}
                  maxLength={80}
                  placeholder={type === 'url' ? hostOf(target) || tr('跟随网址') : tr('跟随目标名称')}
                  onChange={(e) => setTitle(e.target.value)}
                />
              </div>
            )}
          </div>

          {type === 'note' && (
            <div className="field">
              <label>{tr('选择笔记')}</label>
              <div className="home-picker-search">
                <Search size={14} />
                <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={tr('搜索标题或笔记本')} />
              </div>
              <div className="home-picker-list">
                {noteList.map((note) => (
                  <button
                    key={note.id}
                    type="button"
                    className={cn('home-picker-item', target === note.id && 'on')}
                    onClick={() => setTarget(note.id)}
                  >
                    <span className="hp-title">{note.title || tr('未命名笔记')}</span>
                    <span className="hp-sub">{note.notebook || tr('根目录')}</span>
                  </button>
                ))}
                {!noteList.length && <div className="home-empty-line">{tr('没有找到笔记')}</div>}
              </div>
            </div>
          )}

          {type === 'notebook' && (
            <div className="field">
              <label>{tr('选择笔记本')}</label>
              <select className="input" value={target} onChange={(e) => setTarget(e.target.value)}>
                <option value="">{tr('请选择')}</option>
                {notebookList.map((path) => (
                  <option key={path} value={path}>
                    {path}
                  </option>
                ))}
              </select>
            </div>
          )}

          {type === 'view' && (
            <div className="field">
              <label>{tr('选择视图')}</label>
              <select className="input" value={target} onChange={(e) => setTarget(e.target.value)}>
                <option value="">{tr('请选择')}</option>
                {HOME_VIEWS.map((v) => (
                  <option key={v.key} value={v.key}>
                    {tr(v.label)}
                  </option>
                ))}
              </select>
            </div>
          )}

          {type === 'url' && (
            <div className="field">
              <label>{tr('网址')}</label>
              <input
                className="input"
                value={target}
                placeholder={tr('https://example.com，或从下方常用网站里选')}
                onChange={(e) => setTarget(e.target.value)}
                onBlur={() => {
                  if (!target.trim()) return;
                  const url = normalizeUrl(target);
                  if (url) setTarget(url);
                }}
              />
              <div className="hint">{tr('只支持 http / https；点击时用系统默认浏览器打开。')}</div>

              <div className="home-site-head">
                <span className="home-site-title">{tr('常用网站')}</span>
                <span className="home-app-pick-count">{tr('点一下自动填入')}</span>
              </div>
              <div className="home-site-grid" role="listbox" aria-label={tr('常用网站')}>
                {COMMON_SITES.map((site) => {
                  const selected = Boolean(target.trim()) && hostOf(target) === hostOf(site.url);
                  return (
                    <button
                      key={site.url}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      className={cn('home-app-card home-site-card', selected && 'on')}
                      title={`${site.name} · ${hostOf(site.url)}`}
                      style={{ '--site': site.color } as CSSProperties}
                      onClick={() => chooseSite(site)}
                    >
                      <span className="home-site-badge" aria-hidden="true">
                        {site.badge}
                      </span>
                      <span className="home-app-text">
                        <span className="home-app-name">{site.name}</span>
                        <span className="home-app-desc">{hostOf(site.url)}</span>
                      </span>
                      {selected && (
                        <span className="home-app-check" aria-hidden="true">
                          <Check size={11} strokeWidth={3} />
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {type === 'app' && (
            <div className="field">
              <div className="home-app-pick-head">
                <label>{tr('选择小应用')}</label>
                {apps.length > 0 && (
                  <span className="home-app-pick-count">
                    {appQuery.trim() ? `${appList.length} / ${apps.length}` : tr('共 {n} 个', { n: apps.length })}
                  </span>
                )}
              </div>

              {apps.length ? (
                <>
                  <div className="home-picker-search home-app-search">
                    <Search size={14} />
                    <input
                      value={appQuery}
                      onChange={(e) => setAppQuery(e.target.value)}
                      placeholder={tr('搜索应用名称或说明')}
                      aria-label={tr('搜索小应用')}
                    />
                    {appQuery && (
                      <button
                        type="button"
                        className="home-picker-clear"
                        onClick={() => setAppQuery('')}
                        aria-label={tr('清空搜索')}
                      >
                        <X size={12} />
                      </button>
                    )}
                  </div>

                  {appList.length ? (
                    <div className="home-app-grid" role="listbox" aria-label={tr('小应用')} ref={appGridRef}>
                      {appList.map((app) => {
                        const Icon = iconFor(app.icon, 'sparkles');
                        const selected = target === app.id;
                        return (
                          <button
                            key={app.id}
                            type="button"
                            role="option"
                            aria-selected={selected}
                            className={cn('home-app-card', selected && 'on')}
                            onClick={() => setTarget(app.id)}
                            title={`${app.name}${app.description ? ` · ${app.description}` : ''}`}
                          >
                            <span className={cn('home-app-icon', `hc-${app.color}`)}>
                              <Icon size={17} strokeWidth={1.75} />
                            </span>
                            <span className="home-app-text">
                              <span className="home-app-name">{app.name}</span>
                              <span className="home-app-desc">{app.description || tr('第 {n} 版', { n: app.version })}</span>
                            </span>
                            {selected && (
                              <span className="home-app-check" aria-hidden="true">
                                <Check size={11} strokeWidth={3} />
                              </span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="home-app-empty">
                      <SearchX size={20} strokeWidth={1.6} />
                      <span>{tr('没有匹配「{q}」的应用', { q: appQuery.trim() })}</span>
                      <button type="button" className="home-app-empty-act" onClick={() => setAppQuery('')}>
                        {tr('清空搜索')}
                      </button>
                    </div>
                  )}

                  {selectedApp ? (
                    <div className="home-app-picked">
                      <span className="home-app-picked-dot" aria-hidden="true" />
                      {tr('已选择「{name}」', { name: selectedApp.name })}
                    </div>
                  ) : target ? (
                    <div className="hint">{tr('原来选择的应用已不存在，请重新选一个。')}</div>
                  ) : (
                    <div className="hint">{tr('点一张卡片选中；名称、图标和颜色都跟随应用信息。')}</div>
                  )}
                </>
              ) : (
                <div className="home-app-empty tall">
                  <Sparkles size={22} strokeWidth={1.6} />
                  <span>{tr('还没有小应用')}</span>
                  <em>{tr('这里只显示已经安装的小应用；可以让 AI 做一个，或去应用市场挑现成的。')}</em>
                </div>
              )}

              {onCreateApp || onOpenMarket ? (
                <div className="home-app-ai-hint">
                  <span className="home-app-ai-tip">{tr('只显示已安装的小应用，没有想要的可以：')}</span>
                  <span className="home-app-ai-acts">
                    {onCreateApp ? (
                      <button type="button" className="home-app-ai-create" onClick={onCreateApp}>
                        <Sparkles size={12} strokeWidth={1.9} />{tr('让 AI 做一个')}
                      </button>
                    ) : null}
                    {onOpenMarket ? (
                      <button type="button" className="home-app-ai-create home-app-ai-market" onClick={onOpenMarket}>
                        <LayoutGrid size={12} strokeWidth={1.9} />
                        {tr('去应用市场')}
                      </button>
                    ) : null}
                  </span>
                </div>
              ) : null}
            </div>
          )}

          {type === 'system' && (
            <div className="field">
              <div className="home-app-pick-head">
                <label>{tr('选择系统应用')}</label>
                <div className="home-app-pick-tools">
                  {sysApps && sysApps.length > 0 && (
                    <span className="home-app-pick-count">
                      {sysQuery.trim() ? `${sysList.length} / ${sysApps.length}` : tr('共 {n} 个', { n: sysApps.length })}
                    </span>
                  )}
                  <button
                    type="button"
                    className="home-app-refresh"
                    onClick={() => void pickSystemApp()}
                    disabled={sysPicking || sysLoading}
                    title={tr('扫描不到？手动选择程序或开始菜单快捷方式')}
                  >
                    <FolderOpen size={12} />
                    {sysPicking ? tr('选择中') : tr('手动选择')}
                  </button>
                  <button
                    type="button"
                    className="home-app-refresh"
                    onClick={() => loadSystemApps(true)}
                    disabled={sysLoading || sysPicking}
                    title={tr('重新扫描电脑上的应用')}
                  >
                    <RefreshCw size={12} className={sysLoading ? 'spin' : undefined} />
                    {sysLoading ? tr('扫描中') : tr('重新扫描')}
                  </button>
                </div>
              </div>

              {sysApps === null && sysLoading ? (
                <div className="home-app-empty">
                  <Loader2 size={20} strokeWidth={1.6} className="spin" />
                  <span>{tr('正在扫描电脑上的应用…')}</span>
                </div>
              ) : sysError && !(sysApps && sysApps.length) ? (
                <div className="home-app-empty tall">
                  <AppWindow size={22} strokeWidth={1.6} />
                  <span>{sysError}</span>
                  {sysError.includes(tr('桌面客户端')) && (
                    <em>{tr('安装 Windows 桌面版后，就能把微信、浏览器、Office 等程序放进首页。')}</em>
                  )}
                </div>
              ) : sysApps && sysApps.length ? (
                <>
                  <div className="home-picker-search home-app-search">
                    <Search size={14} />
                    <input
                      value={sysQuery}
                      onChange={(e) => setSysQuery(e.target.value)}
                      placeholder={tr('搜索应用名称')}
                      aria-label={tr('搜索系统应用')}
                    />
                    {sysQuery && (
                      <button
                        type="button"
                        className="home-picker-clear"
                        onClick={() => setSysQuery('')}
                        aria-label={tr('清空搜索')}
                      >
                        <X size={12} />
                      </button>
                    )}
                  </div>

                  {sysShown.length ? (
                    <div className="home-app-grid" role="listbox" aria-label={tr('系统应用')} ref={sysGridRef}>
                      {sysShown.map((app, index) => {
                        const selected = target === app.path;
                        return (
                          <Fragment key={app.path}>
                            {index === 0 && sysCommonCount > 0 && <div className="home-app-divider">{tr('常用')}</div>}
                            {index === sysCommonCount && sysCommonCount > 0 && (
                              <div className="home-app-divider">{tr('其他应用')}</div>
                            )}
                            <button
                              type="button"
                              role="option"
                              aria-selected={selected}
                              className={cn('home-app-card', selected && 'on')}
                              onClick={() => chooseSystem(app)}
                              title={`${app.name}\n${app.path}`}
                            >
                              <LazySystemIcon
                                path={app.path}
                                url={sysIcons[app.path]}
                                phase={sysIconPhase[app.path]}
                                onNeed={requestSysIcon}
                              />
                              <span className="home-app-text">
                                <span className="home-app-name">{app.name}</span>
                                <span className="home-app-desc">
                                  {app.path.toLowerCase().endsWith('.lnk') ? tr('开始菜单快捷方式') : tr('应用程序')}
                                </span>
                              </span>
                              {selected && (
                                <span className="home-app-check" aria-hidden="true">
                                  <Check size={11} strokeWidth={3} />
                                </span>
                              )}
                            </button>
                          </Fragment>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="home-app-empty">
                      <SearchX size={20} strokeWidth={1.6} />
                      <span>{tr('没有匹配「{q}」的应用', { q: sysQuery.trim() })}</span>
                      <button type="button" className="home-app-empty-act" onClick={() => setSysQuery('')}>
                        {tr('清空搜索')}
                      </button>
                    </div>
                  )}

                  {selectedSystem && (
                    <div className="home-app-selected" role="status" aria-live="polite">
                      <LazySystemIcon
                        path={selectedSystem.path}
                        url={sysIcons[selectedSystem.path]}
                        phase={sysIconPhase[selectedSystem.path]}
                        onNeed={requestSysIcon}
                      />
                      <span className="home-app-text">
                        <span className="home-app-name">{selectedSystem.name}</span>
                        <span className="home-app-desc">
                          {selectedSystem.path.toLowerCase().endsWith('.lnk') ? tr('开始菜单快捷方式') : tr('应用程序')}
                        </span>
                      </span>
                      <span className="home-app-selected-tag">
                        <Check size={11} strokeWidth={3} />
                        {tr('已选择')}
                      </span>
                    </div>
                  )}

                  {sysList.length > sysShown.length && (
                    <div className="home-app-note">{tr('还有 {n} 个，输入名称继续筛选。', { n: sysList.length - sysShown.length })}</div>
                  )}

                  {sysError && <div className="home-form-error">{sysError}</div>}

                  <div className="home-app-note">
                    {tr('找不到想加的软件？点上方「手动选择」，直接选它的 exe、快捷方式或 .app。')}
                  </div>

                  {!selectedSystem && target && (
                    <div className="hint">{tr('原来选择的应用找不到了，可能已卸载；请重新选一个。')}</div>
                  )}
                </>
              ) : (
                <div className="home-app-empty tall">
                  <AppWindow size={22} strokeWidth={1.6} />
                  <span>{tr('没有找到可添加的应用')}</span>
                  <em>{tr('只读取开始菜单里的快捷方式；绿色版软件可以点「手动选择」直接挑程序。')}</em>
                  <button
                    type="button"
                    className="home-app-empty-act"
                    onClick={() => void pickSystemApp()}
                    disabled={sysPicking}
                  >
                    {sysPicking ? tr('正在打开选择框…') : tr('手动选择程序')}
                  </button>
                </div>
              )}
            </div>
          )}

          {type === 'daily' && <div className="hint">{tr('点击后打开今天的日记，没有就自动创建。')}</div>}

          {type !== 'app' && type !== 'system' && (
            <>
              <div className="field">
                <label>{tr('图标')}</label>
                <div className="home-icon-grid">
                  {HOME_ICON_OPTIONS.map((key) => {
                    const Icon = iconFor(key, 'star');
                    return (
                      <button
                        key={key}
                        type="button"
                        className={cn('home-icon-btn', icon === key && 'on')}
                        title={key}
                        aria-label={key}
                        onClick={() => setIcon(key)}
                      >
                        <Icon size={16} strokeWidth={1.75} />
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="field">
                <label>{tr('颜色')}</label>
                <div className="home-color-row">
                  {HOME_COLORS.map((value) => (
                    <button
                      key={value}
                      type="button"
                      className={cn('home-color-dot', `hc-${value}`, color === value && 'on')}
                      aria-label={value}
                      title={value}
                      onClick={() => setColor(value)}
                    />
                  ))}
                </div>
              </div>
            </>
          )}

          {error && <div className="home-form-error">{error}</div>}
        </div>

        <div className="modal-foot">
          <button className="btn btn-ghost" onClick={onClose} disabled={busy}>
            {tr('取消')}
          </button>
          <button className="btn btn-primary" onClick={() => void submit()} disabled={busy}>
            {busy ? tr('保存中…') : tr('保存')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
