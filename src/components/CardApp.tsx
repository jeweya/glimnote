import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  CalendarDays,
  Check,
  ChevronDown,
  ChevronUp,
  Clock,
  Expand,
  LayoutGrid,
  Lightbulb,
  List,
  Loader2,
  Pencil,
  Pin,
  Plus,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  Undo2,
  X,
} from 'lucide-react';
import { bootstrap } from '../lib/storage';
import * as repo from '../lib/repo';
import { desktop, type SystemApp } from '../lib/desktop';
import {
  applyTaskPatch,
  dueLabel,
  groupTasks,
  isOpenTask,
  parseQuickTaskInput,
  taskDueAt,
  taskTitle,
  type Task,
} from '../lib/tasks';
import { cleanIdeaText, ideaTimeText, type Idea } from '../lib/ideas';
import { listApps, type AppMeta } from '../lib/apps';
import {
  HOME_VIEWS,
  MAX_GROUP_ENTRIES,
  hostOf,
  loadHome,
  saveEntry,
  saveGroup,
  type HomeColor,
  type HomeEntry,
  type HomeGroup,
  type HomeSnapshot,
} from '../lib/home';
import { openExternal } from '../lib/openExternal';
import { sitePresetForUrl } from '../lib/shortcutPresets';
import { applyStoredTheme } from '../lib/theme';
import { t, useT } from '../lib/i18n';
import { log } from '../lib/log';
import { openAppInNewWindow, openNoteInNewWindow } from '../lib/windowMode';
import { cn, dateKey, parseDateKey } from '../lib/utils';
import { CardLockedView, useCardLock } from './CardLocked';
import { DatePicker } from './DatePicker';
import { useCardWindowDrag } from './useCardWindowDrag';
import { iconFor } from './homeIcons';
import { SystemAppMissingDialog } from './SystemAppMissingDialog';
import { useSystemAppStatus } from '../hooks/useSystemAppStatus';

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
/** 首页还没读出来时给 hook 一个稳定引用，避免每帧都重新检查 */
const EMPTY_ENTRIES: Record<string, HomeEntry> = {};

/** 展开态的最小 / 最大尺寸；收成一条时高度只有 COLLAPSED_H */
const MIN_W = 300;
const MIN_H = 320;
const MAX_W = 760;
const MAX_H = 1000;
const COLLAPSED_H = 72;
/** 收成一条时只留日期、数量与两个按钮，宽度同步收窄，不沿用展开态的宽 */
const COLLAPSED_W = 260;
/** 可以一路调到 0：完全隐形时把鼠标移回原位置（或按热键）就会恢复 */
const OPACITY_MIN = 0;

/** 浮窗里的待办分组：今天（含过期）在最前，其余按时间远近归类 */
const CARD_GROUPS = [
  { key: 'focus', label: '今天' },
  { key: 'week', label: '7 天内' },
  { key: 'month', label: '1 个月内' },
  { key: 'later', label: '以后' },
  { key: 'someday', label: '无日期' },
  { key: 'inbox', label: '待整理' },
] as const;

type CardTab = 'tasks' | 'ideas' | 'apps';

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}

function readOpacity() {
  const raw = localStorage.getItem('glimnote.card.opacity');
  if (raw === null) return 1;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : 1;
}

/** 记住的是展开态尺寸；收起之后再展开要回到这个大小 */
function readCardSize() {
  try {
    const raw = JSON.parse(localStorage.getItem('glimnote.card.size') || 'null') as { w?: number; h?: number } | null;
    if (raw && Number.isFinite(raw.w) && Number.isFinite(raw.h)) {
      return {
        w: clamp(Math.round(Number(raw.w)), MIN_W, MAX_W),
        h: clamp(Math.round(Number(raw.h)), MIN_H, MAX_H),
      };
    }
  } catch {
    /* 值坏了就回默认尺寸 */
  }
  return { w: 368, h: 572 };
}

function readTab(): CardTab {
  const saved = localStorage.getItem('glimnote.card.tab');
  return saved === 'ideas' || saved === 'apps' ? saved : 'tasks';
}

/** 浮窗里的入口排版：图标格子适合扫一眼，列表适合看副标题；只记本机 */
type ShortcutLayout = 'grid' | 'list';
const SHORTCUT_LAYOUT_KEY = 'glimnote.card.shortcuts.layout';

function readShortcutLayout(): ShortcutLayout {
  return localStorage.getItem(SHORTCUT_LAYOUT_KEY) === 'list' ? 'list' : 'grid';
}

interface ShortcutView {
  title: string;
  sub: string;
  icon: string;
  color: HomeColor;
  /** 常用网站的品牌角标（知 / B / 微……），和首页保持一致 */
  badge?: string;
  brand?: string;
  missing?: boolean;
}

/**
 * 浮窗里的入口文案。和首页用同一套规则：
 * 只有配置了笔记入口时才扫一次笔记（结果缓存在 noteMap），不会每 30 秒重扫整库。
 */
function shortcutView(
  entry: HomeEntry,
  apps: AppMeta[],
  noteMap: Record<string, { title: string; notebook: string }>,
  notesScanned: boolean,
): ShortcutView {
  const color = entry.color || 'green';
  if (entry.type === 'note') {
    const note = entry.target ? noteMap[entry.target] : undefined;
    return {
      title: entry.title || note?.title || t('笔记'),
      sub: note?.notebook || (notesScanned ? t('笔记已不存在') : t('笔记')),
      icon: entry.icon || 'file',
      color,
      missing: notesScanned && !note,
    };
  }
  if (entry.type === 'notebook') {
    return { title: entry.title || entry.target || t('笔记本'), sub: t('笔记本'), icon: entry.icon || 'folder', color };
  }
  if (entry.type === 'daily') {
    const d = new Date();
    return {
      title: entry.title || t('今日日记'),
      sub: t('{m} 月 {d} 日', { m: d.getMonth() + 1, d: d.getDate() }),
      icon: entry.icon || 'pen',
      color,
    };
  }
  if (entry.type === 'view') {
    return {
      title: entry.title || (HOME_VIEWS.find((v) => v.key === entry.target)?.label ? t(HOME_VIEWS.find((v) => v.key === entry.target)!.label) : '') || t('智能视图'),
      sub: t('智能视图'),
      icon: entry.icon || 'grid',
      color,
    };
  }
  if (entry.type === 'url') {
    const host = hostOf(entry.target);
    const site = !entry.icon || entry.icon === 'globe' ? sitePresetForUrl(entry.target) : null;
    return {
      title: entry.title || host || t('网页'),
      sub: host || t('网址'),
      icon: entry.icon || 'globe',
      color,
      badge: site?.badge,
      brand: site?.color,
    };
  }
  if (entry.type === 'system') {
    const file = (entry.target || '').split(/[\\/]/).pop() || '';
    const fallback = file.replace(/\.(lnk|exe|app|desktop)$/i, '') || t('系统应用');
    return {
      title: entry.title || fallback,
      sub: t('系统应用'),
      icon: entry.icon || 'monitor',
      color: entry.color || 'blue',
    };
  }
  const app = apps.find((a) => a.id === entry.target);
  return {
    title: app?.name || entry.title || t('AI 应用'),
    sub: app ? app.description || t('第 {v} 版', { v: app.version }) : t('应用已不存在'),
    icon: app?.icon || entry.icon || 'sparkles',
    color: app?.color || color,
    missing: !app,
  };
}

function dueSortMs(task: Task) {
  if (!task.due) return Infinity;
  const at = taskDueAt(task);
  if (at) return at.getTime();
  const d = parseDateKey(task.due);
  return d ? d.getTime() + 86399999 : Infinity;
}

/**
 * 桌面浮窗的内容。
 *
 * 它不经过主窗口的 store：直接读写同一批 Markdown 文件（和独立笔记窗口一样），
 * 所以主窗口收进托盘时，浮窗自己也能用；写完再通知主窗口重读，避免两边显示不一致。
 */
export function CardApp() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [ideas, setIdeas] = useState<Idea[]>([]);
  const [apps, setApps] = useState<AppMeta[]>([]);
  /** 首页配置：浮窗只读同一批 home/ 文件，不做另一套入口 */
  const [homeSnap, setHomeSnap] = useState<HomeSnapshot | null>(null);
  const [homeError, setHomeError] = useState('');
  /** 笔记入口的标题与所在笔记本：只有配置了笔记入口时才扫一次笔记 */
  const [noteMap, setNoteMap] = useState<Record<string, { title: string; notebook: string }>>({});
  const [notesScanned, setNotesScanned] = useState(false);
  const noteScanRef = useRef(false);
  const noteTriedRef = useRef(new Set<string>());
  /** 图标 / 列表两种排版：跟窗口宽度无关，用户自己选，记在本机 */
  const [layout, setLayout] = useState<ShortcutLayout>(readShortcutLayout);
  const [systemIcons, setSystemIcons] = useState<Record<string, string>>({});
  /** 本机找不到的系统应用入口：点开时弹引导框 */
  const [missingEntry, setMissingEntry] = useState<HomeEntry | null>(null);
  /** 正在拉起的网址 / 系统应用：在入口行里转起来，避免看起来没反应 */
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropHint, setDropHint] = useState<{ groupId: string; index: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [taskDraft, setTaskDraft] = useState('');
  const [ideaDraft, setIdeaDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState('');
  /** 提示前面带转圈：用于「打开中，请稍候…」这类等待提示 */
  const [flashBusy, setFlashBusy] = useState(false);
  /** 删除后的撤销入口，8 秒内有效 */
  const [undo, setUndo] = useState<{ run: () => Promise<void> } | null>(null);
  const [tab, setTab] = useState<CardTab>(readTab);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('glimnote.card.collapsed') === '1');
  const [opacity, setOpacity] = useState(readOpacity);
  const [opacityOpen, setOpacityOpen] = useState(false);
  /** 是否置顶：默认不置顶，免得一打开就盖住别的软件 */
  const [pinned, setPinned] = useState(false);
  /** 正在改日期的那一行：日期浮层要贴着这一行弹出来 */
  const [datePop, setDatePop] = useState<{ task: Task; x: number; y: number } | null>(null);
  /** 正在改到点时间的那一行；同一时刻只开一个 */
  const [timeEdit, setTimeEdit] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());
  const addRef = useRef<HTMLInputElement>(null);
  const shortcutScrollRef = useRef<HTMLDivElement>(null);
  /** 拖拽中不靠 React 状态判断滚动，避免高速拖动时闭包拿到旧值 */
  const dragIdRef = useRef<string | null>(null);
  /** 取过图标的路径记下来：失败不反复请求，下次重新打开浮窗再试 */
  const iconTriedRef = useRef(new Set<string>());
  const flashTimer = useRef(0);
  const bridge = desktop();
  const tr = useT();
  /** 标题栏拖动：普通形态和锁定占位共用同一套指针 → IPC 移动 */
  const startWindowDrag = useCardWindowDrag(bridge);

  const say = useCallback(
    (text: string, undoTarget?: () => Promise<void>, holdMs?: number, spin?: boolean) => {
      setFlash(text);
      setFlashBusy(Boolean(spin));
      setUndo(undoTarget ? { run: undoTarget } : null);
      window.clearTimeout(flashTimer.current);
      flashTimer.current = window.setTimeout(
        () => {
          setFlash('');
          setFlashBusy(false);
          setUndo(null);
        },
        undoTarget ? 8000 : holdMs ?? 1800,
      );
    },
    [],
  );

  const load = useCallback(async () => {
    // 首页配置读失败时只是这个 tab 空着，不能把待办 / 灵感一起打红
    const homeState: { snap: HomeSnapshot | null; error: string } = { snap: null, error: '' };
    const homeTask = loadHome()
      .then((snapshot) => {
        homeState.snap = snapshot;
      })
      .catch((e) => {
        homeState.error = String((e as Error)?.message || e).slice(0, 48);
      });
    try {
      const [nextTasks, nextIdeas, nextApps] = await Promise.all([
        repo.loadTasks(),
        repo.loadIdeas(),
        // 应用读失败时不拖累待办 / 灵感，浮窗照样能用
        listApps().catch(() => [] as AppMeta[]),
        homeTask,
      ]);
      setTasks(nextTasks);
      setIdeas(nextIdeas);
      setApps(nextApps);
      if (homeState.snap) {
        setHomeSnap(homeState.snap);
        setHomeError('');
        // 浮窗先打开、主窗口还没读过 home/ 时，播种出来的默认分组也要进同步队列
        if (homeState.snap.seeded) void bridge?.cardChanged?.();
      } else if (homeState.error) {
        setHomeError(t('快捷入口读取失败：{msg}', { msg: homeState.error }));
      }
      setError('');
    } catch (e) {
      setError(t('读取失败：{msg}', { msg: String((e as Error)?.message || e).slice(0, 48) }));
    } finally {
      setLoading(false);
    }
  }, [bridge]);

  // 主窗口改了设置（透明度）时不用整页刷新，把外观重新读一遍就行
  const syncChrome = useCallback(() => {
    setOpacity(readOpacity());
    applyStoredTheme();
  }, []);

  useEffect(() => {
    document.title = t('待办浮窗 · 萤光笔记');
    applyStoredTheme();
    // 主进程日志里能看到「浮窗已显示」但界面空白时，靠这一条判断是页面没起来
    log('card', 'info', `浮窗界面已挂载 · ${window.innerWidth}×${window.innerHeight}`);
    void (async () => {
      try {
        await bootstrap();
      } catch (e) {
        log('card', 'error', `浮窗初始化失败：${String((e as Error)?.message || e).slice(0, 120)}`);
        setError(t('初始化失败：{msg}', { msg: String((e as Error)?.message || e).slice(0, 48) }));
        setLoading(false);
        return;
      }
      await load();
      log('card', 'info', '浮窗数据读取完成');
    })();
    // 上次停在「一条」的形态就按条的高度开；否则把记错的窗口高度修正回展开尺寸
    if (localStorage.getItem('glimnote.card.collapsed') === '1') {
      void bridge?.resizeCard?.({ width: COLLAPSED_W, height: COLLAPSED_H });
    } else if (window.innerHeight < MIN_H - 20) {
      const size = readCardSize();
      void bridge?.resizeCard?.({ width: size.w, height: size.h });
    }
    requestAnimationFrame(() => addRef.current?.focus());
    return () => window.clearTimeout(flashTimer.current);
  }, [bridge, load]);

  // 透明度是整张卡片的「静置」状态，鼠标移入 / 焦点在里面时由 CSS 恢复 100%
  useEffect(() => {
    document.documentElement.style.setProperty('--card-idle-opacity', String(opacity));
  }, [opacity]);

  // 主窗口的「设置 → 浮窗透明度」写的是同一个 localStorage，storage 事件能实时同步
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'glimnote.card.opacity') setOpacity(readOpacity());
      if (e.key === 'glimnote.theme') applyStoredTheme();
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  // 置顶状态存在主进程的 prefs.json 里：窗口重建后也要跟上次一致
  useEffect(() => {
    if (!bridge?.getCardPinned) return;
    let alive = true;
    void bridge
      .getCardPinned()
      .then((value) => {
        if (alive) setPinned(Boolean(value));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [bridge]);

  // 主窗口改了任务 / 灵感会发 card:refresh；自己每半分钟也读一次盘，跨零点、外部编辑都能跟上
  useEffect(() => {
    const off = bridge?.onCardRefresh?.(() => {
      syncChrome();
      // 正在拖动时不要换掉列表，否则手里的卡片会突然消失
      if (!dragIdRef.current) void load();
    });
    const timer = window.setInterval(() => {
      setNow(new Date());
      if (!dragIdRef.current) void load();
    }, 30000);
    const onFocus = () => {
      setNow(new Date());
      if (!dragIdRef.current) void load();
    };
    window.addEventListener('focus', onFocus);
    return () => {
      off?.();
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [bridge, load, syncChrome]);

  // 主窗口关闭到托盘且启用了密码锁时，浮窗留在桌面上但切换成锁定态：
  // 内容整体从 DOM 里拿掉，桌面上不留待办和灵感的标题；解锁后再读一次盘恢复。
  const locked = useCardLock(bridge, load, () => {
    setOpacityOpen(false);
    setDatePop(null);
    setTimeEdit(null);
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // 先关透明度面板，最后才收起浮窗
      if (opacityOpen) {
        setOpacityOpen(false);
        return;
      }
      const el = e.target as HTMLElement;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) el.blur();
      else void bridge?.hideCard?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [bridge, opacityOpen]);

  const today = dateKey(now);
  const openTasks = useMemo(() => tasks.filter(isOpenTask), [tasks]);
  // 和主窗口待办列表同一套分组规则：过期 / 今天 / 7 天内 / 1 个月内 / 以后 / 无日期 / 待整理
  const groups = useMemo(() => groupTasks(tasks, now), [tasks, now]);
  /** 今天这一组把「已过期」也算进来，过期的先排、看着最要紧 */
  const focusTasks = useMemo(
    () => [...groups.overdue, ...groups.today].sort((a, b) => dueSortMs(a) - dueSortMs(b)),
    [groups],
  );
  const cardGroups = useMemo(
    () =>
      CARD_GROUPS.map((group) => ({
        key: group.key,
        label: group.label,
        tasks: group.key === 'focus' ? focusTasks : groups[group.key],
      })).filter((group) => group.tasks.length > 0),
    [groups, focusTasks],
  );
  // 顶部进度只算「截止日期是今天」的待办：过期、7 天内、以后和灵感都不进分子分母
  const todayTasks = useMemo(() => tasks.filter((task) => !task.deletedAt && task.due === today), [tasks, today]);
  const doneToday = useMemo(() => todayTasks.filter((task) => task.status === 'done').length, [todayTasks]);
  const openIdeas = useMemo(
    () => ideas.filter((idea) => !idea.convertedType).sort((a, b) => +new Date(b.created) - +new Date(a.created)),
    [ideas],
  );
  /** 首页分组 → 可直接渲染的入口；已删除的入口 id 自动跳过 */
  const shortcutGroups = useMemo(() => {
    if (!homeSnap) return [];
    return homeSnap.groups.map((group) => ({
      group,
      entries: group.entries.map((id) => homeSnap.entries[id]).filter((entry): entry is HomeEntry => Boolean(entry)),
    }));
  }, [homeSnap]);
  const shortcutCount = useMemo(
    () => shortcutGroups.reduce((total, item) => total + item.entries.length, 0),
    [shortcutGroups],
  );
  const filledShortcutGroups = shortcutGroups.filter((item) => item.entries.length > 0).length;
  /** 只有系统应用需要向主进程取真实图标，其它入口都用内置图标 */
  const systemPaths = useMemo(
    () =>
      homeSnap
        ? Object.values(homeSnap.entries)
            .filter((entry) => entry.type === 'system' && entry.target)
            .map((entry) => entry.target as string)
        : [],
    [homeSnap],
  );
  const systemPathsKey = systemPaths.join('\n');
  // 浮窗和首页看的是同一份入口：路径失效时打标记，点开走同一个引导框
  const systemStatus = useSystemAppStatus(homeSnap?.entries || EMPTY_ENTRIES);

  // 系统应用图标：只取当前首页里配置过的那几个，按批交给主进程；失败不反复重试
  useEffect(() => {
    const api = bridge?.systemAppIcons;
    if (!api) return;
    const missing = systemPaths.filter((path) => !systemIcons[path] && !iconTriedRef.current.has(path));
    if (!missing.length) return;
    for (const path of missing) iconTriedRef.current.add(path);
    let alive = true;
    void api(missing)
      .then((map) => {
        if (!alive || !map || !Object.keys(map).length) return;
        setSystemIcons((prev) => ({ ...prev, ...map }));
      })
      .catch(() => {
        /* 取不到就用通用图标，入口本身照常可点 */
      });
    return () => {
      alive = false;
    };
  }, [bridge, systemPaths, systemPathsKey, systemIcons]);

  // 笔记入口：只有确实配置了笔记才读一次标题，之后新出现的入口再补扫；
  // 删除的目标也会被记为「已扫过」，不会反复扫描整库。
  useEffect(() => {
    if (!homeSnap) return;
    const ids = Object.values(homeSnap.entries)
      .filter((entry) => entry.type === 'note' && entry.target)
      .map((entry) => entry.target as string);
    if (!ids.length) return;
    const need = ids.filter((id) => !noteMap[id] && !noteTriedRef.current.has(id));
    if (!need.length || noteScanRef.current) return;
    for (const id of need) noteTriedRef.current.add(id);
    noteScanRef.current = true;
    void repo
      .loadNotes()
      .then((notes) => {
        setNoteMap((prev) => {
          const next = { ...prev };
          for (const note of notes) next[note.id] = { title: note.title, notebook: note.notebook };
          return next;
        });
        setNotesScanned(true);
      })
      .catch(() => {
        /* 扫不到就保留通用「笔记」文案，入口照常能点 */
      })
      .finally(() => {
        noteScanRef.current = false;
      });
  }, [homeSnap, noteMap]);

  const overdueCount = groups.overdue.length;
  const progressTotal = todayTasks.length;

  const addTask = async () => {
    const text = taskDraft.trim();
    if (!text || busy) return;
    const quick = parseQuickTaskInput(text);
    setBusy(true);
    try {
      await repo.createTask(quick.title, {
        due: today,
        dueTime: quick.dueTime,
        status: 'todo',
      });
      setTaskDraft('');
      await load();
      say(quick.dueTime ? tr('已加入今天 {time}', { time: quick.dueTime }) : tr('已加入今天'));
      void bridge?.cardChanged?.();
      requestAnimationFrame(() => addRef.current?.focus());
    } catch {
      say(tr('待办没保存成功'));
    } finally {
      setBusy(false);
    }
  };

  const completeTask = async (task: Task) => {
    if (busy) return;
    setBusy(true);
    const done: Task = {
      ...task,
      status: 'done',
      prevStatus: task.status === 'done' ? undefined : task.status,
      doneAt: new Date().toISOString(),
      updated: new Date().toISOString(),
    };
    // 先让勾选动画落下来，再把行移走，避免点完像是什么都没发生
    setTasks((prev) => prev.map((t) => (t.id === task.id ? done : t)));
    try {
      await repo.saveTask(done);
      void bridge?.cardChanged?.();
      window.setTimeout(() => {
        setTasks((prev) => prev.filter((t) => t.id !== task.id));
      }, 420);
    } catch {
      setTasks((prev) => prev.map((t) => (t.id === task.id ? task : t)));
      say(tr('勾选没写进磁盘'));
    } finally {
      setBusy(false);
    }
  };

  /** 待办删除进回收站（repo.deleteTask 会改写 task.deletedFrom，并返回回收站路径） */
  const removeTask = async (task: Task) => {
    if (busy) return;
    setBusy(true);
    const before = tasks;
    setTasks((prev) => prev.filter((t) => t.id !== task.id));
    try {
      const trashPath = await repo.deleteTask(task);
      void bridge?.cardChanged?.();
      // 撤销时用回收站里的那一份：restoreTask 会按 deletedFrom 放回原位置
      const trashed: Task = { ...task, path: trashPath };
      say(tr('已移入回收站'), async () => {
        await repo.restoreTask(trashed);
        await load();
        void bridge?.cardChanged?.();
      });
    } catch {
      setTasks(before);
      say(tr('删除失败，待办还在'));
    } finally {
      setBusy(false);
    }
  };

  const addIdea = async () => {
    const text = cleanIdeaText(ideaDraft);
    if (!text || busy) return;
    setBusy(true);
    try {
      const idea = await repo.createIdea(text);
      setIdeas((prev) => [idea, ...prev]);
      setIdeaDraft('');
      say(tr('灵感已记下'));
      void bridge?.cardChanged?.();
    } catch {
      say(tr('灵感没保存成功'));
    } finally {
      setBusy(false);
    }
  };

  const removeIdea = async (idea: Idea) => {
    if (busy) return;
    setBusy(true);
    const before = ideas;
    setIdeas((prev) => prev.filter((i) => i.id !== idea.id));
    try {
      await repo.deleteIdea(idea);
      void bridge?.cardChanged?.();
      // 灵感没有回收站，撤销就按原路径写回
      say(tr('灵感已删除'), async () => {
        await repo.restoreIdea(idea);
        await load();
        void bridge?.cardChanged?.();
      });
    } catch {
      setIdeas(before);
      say(tr('删除失败，灵感还在'));
    } finally {
      setBusy(false);
    }
  };

  const runUndo = async () => {
    if (!undo || busy) return;
    const fn = undo.run;
    window.clearTimeout(flashTimer.current);
    setUndo(null);
    setBusy(true);
    try {
      await fn();
      say(tr('已撤销'));
    } catch {
      say(tr('撤销失败'));
    } finally {
      setBusy(false);
    }
  };

  const pickTab = (next: CardTab) => {
    setTab(next);
    localStorage.setItem('glimnote.card.tab', next);
    setOpacityOpen(false);
    // 切 tab 时日期 / 时间浮层留在原地会盖住新内容，先收起来
    setDatePop(null);
    setTimeEdit(null);
    if (next === 'tasks') requestAnimationFrame(() => addRef.current?.focus());
  };

  /** 打开主窗口的指定位置；主进程没准备好时退化成「只把主窗口叫出来」 */
  const openHomePage = () => {
    if (bridge?.openMainTarget) void bridge.openMainTarget({ kind: 'home' });
    else void bridge?.showMain?.();
  };

  const changeLayout = (next: ShortcutLayout) => {
    setLayout(next);
    try {
      localStorage.setItem(SHORTCUT_LAYOUT_KEY, next);
    } catch {
      /* 存不下也不影响这次切换 */
    }
  };

  /** 手动选好本机程序后换掉入口里的路径；系统应用只写本机文件，不进 Git */
  const linkSystemApp = async (entry: HomeEntry, app: SystemApp) => {
    const next: HomeEntry = {
      ...entry,
      target: app.path,
      title: entry.title || app.name,
      updated: new Date().toISOString(),
    };
    await saveEntry(next);
    setHomeSnap((prev) => (prev ? { ...prev, entries: { ...prev.entries, [next.id]: next } } : prev));
    systemStatus.refresh();
    say(tr('已重新关联到「{name}」', { name: app.name }));
  };

  /**
   * 点入口直接去目标：
   * - 笔记 / 今日日记 → 独立笔记窗口，不打断浮窗；
   * - 笔记本 / 智能视图 → 主窗口对应位置；
   * - 网址 / 系统应用 / AI 应用 → 交给原来的打开逻辑。
   */
  /** 转圈至少留一会儿，避免一闪而过 */
  const keepOpening = async (startedAt: number, ms = 700) => {
    const left = ms - (Date.now() - startedAt);
    if (left > 0) await new Promise((resolve) => window.setTimeout(resolve, left));
  };

  const openShortcut = async (entry: HomeEntry) => {
    if (entry.type === 'note') {
      const target = entry.target;
      if (!target) {
        say(tr('这个入口还没指定笔记'));
        return;
      }
      if (notesScanned && !noteMap[target]) {
        say(tr('这篇笔记已经不在仓库里了，可以回首页编辑入口重新指向'));
        return;
      }
      openNoteInNewWindow(target);
      return;
    }
    if (entry.type === 'daily') {
      try {
        const note = await repo.ensureDailyNote();
        openNoteInNewWindow(note.id);
        // 浮窗可能刚新建了今天的日记文件，让主窗口补一次读盘与同步标记
        void bridge?.cardChanged?.();
      } catch {
        say(tr('今日日记打不开'));
      }
      return;
    }
    if (entry.type === 'notebook' || entry.type === 'view') {
      const target =
        entry.type === 'notebook'
          ? ({ kind: 'notebook', value: entry.target || '' } as const)
          : ({ kind: 'view', value: entry.target || '' } as const);
      if (bridge?.openMainTarget) void bridge.openMainTarget(target);
      else void bridge?.showMain?.();
      return;
    }
    if (entry.type === 'url') {
      const startedAt = Date.now();
      setOpeningId(entry.id);
      window.setTimeout(() => say(tr('网站打开中，请稍候…'), undefined, 4000, true), 600);
      try {
        await openExternal(entry.target || '');
      } catch (e) {
        say((e as Error).message || tr('网址打不开'));
      } finally {
        await keepOpening(startedAt);
        setOpeningId(null);
      }
      return;
    }
    if (entry.type === 'system') {
      if (!bridge?.openSystemApp) {
        say(tr('系统应用只能在桌面客户端里打开'));
        return;
      }
      if (systemStatus.missingOf(entry)) {
        setMissingEntry(entry);
        return;
      }
      const startedAt = Date.now();
      setOpeningId(entry.id);
      window.setTimeout(() => say(tr('应用打开中，请稍候…'), undefined, 4000, true), 600);
      try {
        const ok = await bridge.openSystemApp(entry.target || '');
        if (!ok) {
          systemStatus.refresh();
          setMissingEntry(entry);
        }
      } catch {
        setMissingEntry(entry);
      } finally {
        await keepOpening(startedAt);
        setOpeningId(null);
      }
      return;
    }
    const app = apps.find((item) => item.id === entry.target);
    if (!app) {
      say(tr('这个 AI 应用已经删除了'));
      return;
    }
    // 小应用窗口和浮窗一样常驻桌面：显示在任务栏，最小化收进底部合并条
    openAppInNewWindow(app.id, { multiple: true });
  };

  /**
   * 把入口挪到指定分组的指定位置，直接改 home/groups/*.json。
   * 同一分组内按「插到第几个之前」处理；跨分组时插到目标位置。
   */
  const moveShortcut = async (entryId: string, toGroupId: string, index: number) => {
    const snap = homeSnap;
    if (!snap) return;
    const from = snap.groups.find((group) => group.entries.includes(entryId));
    const to = snap.groups.find((group) => group.id === toGroupId);
    if (!from || !to) return;
    if (from.id !== to.id && to.entries.length >= MAX_GROUP_ENTRIES) {
      say(tr('「{name}」最多放 {n} 个入口', { name: to.name, n: MAX_GROUP_ENTRIES }));
      return;
    }

    const at = new Date().toISOString();
    let nextGroups: HomeGroup[];
    let message: string;
    if (from.id === to.id) {
      const list = [...from.entries];
      const oldIndex = list.indexOf(entryId);
      const insert = clamp(index, 0, list.length);
      // 落点线画在目标卡片前面：往后拖时要扣掉自己移走后的那一位
      if (insert === oldIndex || insert === oldIndex + 1) return;
      list.splice(oldIndex, 1);
      list.splice(insert > oldIndex ? insert - 1 : insert, 0, entryId);
      const next: HomeGroup = { ...from, entries: list, updated: at };
      try {
        await saveGroup(next);
      } catch {
        say(tr('顺序没保存成功'));
        await load();
        return;
      }
      nextGroups = snap.groups.map((group) => (group.id === next.id ? next : group));
      message = tr('顺序已保存');
    } else {
      const fromNext: HomeGroup = { ...from, entries: from.entries.filter((id) => id !== entryId), updated: at };
      const toList = [...to.entries];
      toList.splice(clamp(index, 0, toList.length), 0, entryId);
      const toNext: HomeGroup = { ...to, entries: toList, updated: at };
      try {
        await saveGroup(fromNext);
        await saveGroup(toNext);
      } catch {
        say(tr('移动没保存成功'));
        await load();
        return;
      }
      nextGroups = snap.groups.map((group) =>
        group.id === fromNext.id ? fromNext : group.id === toNext.id ? toNext : group,
      );
      message = tr('已移到「{name}」', { name: to.name });
    }
    setHomeSnap((prev) => (prev ? { ...prev, groups: nextGroups } : prev));
    say(message);
    // 主窗口收到后重读 home/ 并标记待同步；浮窗本身不跑 Git
    void bridge?.cardChanged?.();
  };

  const beginShortcutDrag = (e: ReactDragEvent<HTMLButtonElement>, entry: HomeEntry) => {
    setDragId(entry.id);
    dragIdRef.current = entry.id;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', entry.id);
  };

  const finishShortcutDrag = () => {
    setDragId(null);
    dragIdRef.current = null;
    setDropHint(null);
  };

  const allowShortcutDrop = (e: ReactDragEvent, groupId: string, index: number) => {
    if (!dragIdRef.current) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    if (!dropHint || dropHint.groupId !== groupId || dropHint.index !== index) {
      setDropHint({ groupId, index });
    }
  };

  const dropShortcut = (e: ReactDragEvent, groupId: string, index: number) => {
    const id = dragIdRef.current;
    if (!id) return;
    e.preventDefault();
    e.stopPropagation();
    setDragId(null);
    dragIdRef.current = null;
    setDropHint(null);
    void moveShortcut(id, groupId, index);
  };

  /** 拖到滚动区上下边缘时自己滚，不然跨分组要先把鼠标松开再滚动 */
  const autoScrollWhileDragging = (e: ReactDragEvent<HTMLDivElement>) => {
    if (!dragIdRef.current) return;
    const el = shortcutScrollRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (e.clientY < rect.top + 28) el.scrollTop -= 10;
    else if (e.clientY > rect.bottom - 28) el.scrollTop += 10;
  };

  const changeOpacity = (value: number) => {
    const next = clamp(Math.round(value * 100) / 100, OPACITY_MIN, 1);
    setOpacity(next);
    localStorage.setItem('glimnote.card.opacity', String(next));
  };

  const togglePinned = async () => {
    if (!bridge?.setCardPinned) return;
    const next = !pinned;
    setPinned(next);
    try {
      const value = await bridge.setCardPinned(next);
      setPinned(Boolean(value));
      say(value ? tr('已置顶，浮在其他窗口上方') : tr('已取消置顶'));
    } catch {
      setPinned(!next);
      say(tr('置顶设置没保存成功'));
    }
  };

  /* ---------- 改日期 / 到点时间 ---------- */
  /** 和主窗口共用 applyTaskPatch：清掉日期时提醒时间一起清掉，待整理排了日期会自动转待办 */
  const patchTaskField = async (task: Task, patch: Partial<Task>) => {
    const { next, notice } = applyTaskPatch(task, patch);
    setTasks((prev) => prev.map((t) => (t.id === task.id ? next : t)));
    setDatePop(null);
    setTimeEdit(null);
    try {
      await repo.saveTask(next);
      void bridge?.cardChanged?.();
      if (notice) say(notice);
    } catch {
      say(tr('日期没保存成功'));
      await load();
    }
  };

  const openDatePop = (task: Task, e: ReactMouseEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setTimeEdit(null);
    setDatePop({ task, x: rect.left, y: rect.bottom + 6 });
  };

  const collapseCard = () => {
    const w = clamp(Math.round(window.innerWidth), MIN_W, MAX_W);
    const h = clamp(Math.round(window.innerHeight), MIN_H, MAX_H);
    // 展开态的尺寸要留着，展开时原样还回去（宽度也可能被拖过）
    localStorage.setItem('glimnote.card.size', JSON.stringify({ w, h }));
    localStorage.setItem('glimnote.card.collapsed', '1');
    setCollapsed(true);
    setOpacityOpen(false);
    // 宽度也一起收：一条形态不该占着展开态的整幅宽度
    void bridge?.resizeCard?.({ width: COLLAPSED_W, height: COLLAPSED_H });
  };

  const expandCard = () => {
    const size = readCardSize();
    localStorage.setItem('glimnote.card.collapsed', '0');
    setCollapsed(false);
    void bridge?.resizeCard?.({ width: size.w, height: size.h });
    requestAnimationFrame(() => addRef.current?.focus());
  };

  /* ---------- 右下角拖拽缩放 ---------- */
  /**
   * 拖动缩放。透明窗口一旦改变尺寸，指针可能跑到窗口外面，
   * 所以监听挂在 window 上（再补一个指针捕获），松手时按最终位置补发一次尺寸，
   * 避免「拖了但没反应」或者停在半路。
   */
  type ResizeState = { sx: number; sy: number; w: number; h: number; next: { w: number; h: number }; last: number };
  const resizeRef = useRef<ResizeState | null>(null);

  const startResize = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const w = clamp(Math.round(window.innerWidth), MIN_W, MAX_W);
    const h = clamp(Math.round(window.innerHeight), MIN_H, MAX_H);
    const st: ResizeState = { sx: e.screenX, sy: e.screenY, w, h, next: { w, h }, last: 0 };
    resizeRef.current = st;
    document.documentElement.classList.add('card-resizing');

    const move = (ev: PointerEvent) => {
      st.next = {
        w: clamp(Math.round(st.w + ev.screenX - st.sx), MIN_W, MAX_W),
        h: clamp(Math.round(st.h + ev.screenY - st.sy), MIN_H, MAX_H),
      };
      // 约 16ms 一次，够跟手又不会把 IPC 刷爆；不用 rAF，未聚焦时也不会被节流
      const t = performance.now();
      if (t - st.last < 16) return;
      st.last = t;
      void bridge?.resizeCard?.({ width: st.next.w, height: st.next.h });
    };
    const finish = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      document.documentElement.classList.remove('card-resizing');
      const cur = resizeRef.current;
      resizeRef.current = null;
      if (!cur) return;
      void bridge?.resizeCard?.({ width: cur.next.w, height: cur.next.h });
      localStorage.setItem('glimnote.card.size', JSON.stringify(cur.next));
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* 拿不到捕获也不影响：window 上的监听同样能收到拖动 */
    }
  };

  const headActions = (
    <div className="card-head-actions">
      {bridge?.setCardPinned ? (
        <button
          className={cn('card-icon', pinned && 'pinned')}
          title={pinned ? tr('取消置顶') : tr('置顶浮窗')}
          aria-label={pinned ? tr('取消置顶') : tr('置顶浮窗')}
          aria-pressed={pinned}
          onClick={() => void togglePinned()}
        >
          <Pin size={13} strokeWidth={1.9} />
        </button>
      ) : null}
      <div className="card-opacity-wrap">
        <button
          className={cn('card-icon', opacityOpen && 'on')}
          title={tr('浮窗透明度')}
          aria-label={tr('浮窗透明度')}
          aria-expanded={opacityOpen}
          onClick={() => setOpacityOpen((v) => !v)}
        >
          <SlidersHorizontal size={14} />
        </button>
        {opacityOpen ? (
          <>
            {/* data-no-drag：否则点遮罩会被标题栏当成拖拽起点，窗口一动 click 就丢了，面板关不掉 */}
            <div className="card-opacity-veil" data-no-drag onClick={() => setOpacityOpen(false)} />
            <div className="card-opacity-pop" data-no-drag role="dialog" aria-label={tr('浮窗透明度')}>
              <div className="card-opacity-head">
                <span>{tr('不透明度')}</span>
                <b>{Math.round(opacity * 100)}%</b>
              </div>
              <input
                type="range"
                min={Math.round(OPACITY_MIN * 100)}
                max={100}
                step={5}
                value={Math.round(opacity * 100)}
                aria-label={tr('浮窗不透明度')}
                onChange={(e) => changeOpacity(Number(e.target.value) / 100)}
              />
              <div className="card-opacity-hint">
                {tr('鼠标移入自动恢复 100%；0% 时完全隐形，把鼠标移回原位或按 Ctrl+Alt+D 可叫回')}
              </div>
            </div>
          </>
        ) : null}
      </div>
      <button className="card-icon" title={tr('收成一条')} aria-label={tr('收成一条')} onClick={collapseCard}>
        <ChevronDown size={15} />
      </button>
      <button
        className="card-icon"
        title={tr('收起浮窗（Esc）')}
        aria-label={tr('收起浮窗')}
        onClick={() => void bridge?.hideCard?.()}
      >
        <X size={14} />
      </button>
    </div>
  );

  if (locked) {
    return (
      <CardLockedView
        collapsed={collapsed}
        onDragStart={startWindowDrag}
        onHide={() => void bridge?.hideCard?.()}
        // 叫出主窗口；有密码时那里是锁屏，输完密码浮窗自动恢复
        onUnlock={() => void bridge?.showMain?.()}
      />
    );
  }

  if (collapsed) {
    return (
      <div className="card-shell card-shell-mini">
        <div className="card-mini" onPointerDown={startWindowDrag}>
          <div className="card-mini-main">
            <span className="card-mini-date">
              {tr('{m} 月 {d} 日', { m: now.getMonth() + 1, d: now.getDate() })} · {tr(WEEKDAYS[now.getDay()])}
            </span>
            <span className="card-mini-sub">
              {loading ? tr('读取中…') : tr('{n} 条待办 · {m} 条灵感', { n: focusTasks.length, m: openIdeas.length })}
            </span>
          </div>
          <div className="card-mini-actions">
            <button className="card-icon" title={tr('展开浮窗')} aria-label={tr('展开浮窗')} onClick={expandCard}>
              <ChevronUp size={15} />
            </button>
            <button
              className="card-icon"
              title={tr('收起浮窗（Esc）')}
              aria-label={tr('收起浮窗')}
              onClick={() => void bridge?.hideCard?.()}
            >
              <X size={14} />
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="card-shell">
      <header className="card-head" onPointerDown={startWindowDrag}>
        <div className="card-head-main">
          <div className="card-day">
            <span className="card-day-num">{now.getDate()}</span>
            <span className="card-day-side">
              <b>{tr('{m} 月', { m: now.getMonth() + 1 })}</b>
              <i>{tr(WEEKDAYS[now.getDay()])}</i>
            </span>
          </div>
          <div className="card-head-sub">
            {loading
              ? tr('正在读取…')
              : progressTotal
                ? tr('今天 {done} / {total}', { done: doneToday, total: progressTotal }) +
                  (overdueCount ? tr(' · {n} 条已过期', { n: overdueCount }) : '')
                : tr('今天没有排期') + (overdueCount ? tr(' · {n} 条已过期', { n: overdueCount }) : '')}
          </div>
        </div>
        {headActions}
      </header>

      {!loading && progressTotal > 0 ? (
        <div className="card-progress" aria-hidden>
          <i style={{ width: `${Math.round((doneToday / progressTotal) * 100)}%` }} />
        </div>
      ) : null}

      <div className="card-tabs" role="tablist" aria-label={tr('浮窗内容')}>
        <button
          role="tab"
          aria-selected={tab === 'tasks'}
          className={cn('card-tab', tab === 'tasks' && 'on')}
          onClick={() => pickTab('tasks')}
        >
          {tr('待办')}
          {openTasks.length ? <span className="card-tab-count">{openTasks.length}</span> : null}
        </button>
        <button
          role="tab"
          aria-selected={tab === 'ideas'}
          className={cn('card-tab', tab === 'ideas' && 'on')}
          onClick={() => pickTab('ideas')}
        >
          {tr('灵感')}
          {openIdeas.length ? <span className="card-tab-count">{openIdeas.length}</span> : null}
        </button>
        <button
          role="tab"
          aria-selected={tab === 'apps'}
          className={cn('card-tab', tab === 'apps' && 'on')}
          title={tr('首页的应用与快捷入口')}
          onClick={() => pickTab('apps')}
        >
          {tr('应用')}
          {shortcutCount ? <span className="card-tab-count">{shortcutCount}</span> : null}
        </button>
      </div>

      {tab === 'tasks' ? (
        <div className="card-body" role="tabpanel" aria-label={tr('待办清单')}>
          <form
            className="card-add"
            onSubmit={(e) => {
              e.preventDefault();
              void addTask();
            }}
          >
            <Plus size={14} strokeWidth={2} />
            <input
              ref={addRef}
              value={taskDraft}
              placeholder={tr('添加今天的待办；结尾写 18:00 可提醒')}
              aria-label={tr('添加待办')}
              onChange={(e) => setTaskDraft(e.target.value)}
            />
            <button type="submit" className="card-add-btn" disabled={!taskDraft.trim() || busy}>
              {tr('添加')}
            </button>
          </form>

          <div className="card-scroll">
            {loading ? (
              <div className="card-empty">
                <Loader2 size={16} className="spin" /> {tr('读取中…')}
              </div>
            ) : error ? (
              <div className="card-empty bad">{error}</div>
            ) : cardGroups.length === 0 ? (
              <div className="card-empty">
                <Check size={16} strokeWidth={1.8} />
                {tr('还没有待办，在上面加一条')}
              </div>
            ) : (
              <div className="card-groups">
                {cardGroups.map((group) => (
                  <section className="card-group" key={group.key}>
                    <div className="card-group-head">
                      <span>{tr(group.label)}</span>
                      {group.key === 'focus' && overdueCount > 0 ? <em>{tr('{n} 条过期', { n: overdueCount })}</em> : null}
                      <i>{group.tasks.length}</i>
                    </div>
                    <ul className="card-task-list">
                      {group.tasks.map((task) => {
                        const late = Boolean(task.due && task.due < today);
                        return (
                          <li className={cn('card-task', late && 'late')} key={task.id}>
                            <button
                              className="card-check"
                              role="checkbox"
                              aria-checked={false}
                              aria-label={tr('完成「{title}」', { title: taskTitle(task) })}
                              onClick={() => void completeTask(task)}
                              title={tr('标记完成')}
                            >
                              <Check size={12} strokeWidth={2.4} />
                            </button>
                            <div className="card-task-main">
                              <div className="card-task-title">{taskTitle(task)}</div>
                              <div className="card-task-meta">
                                <button
                                  className={cn('card-date-chip', late && 'late', !task.due && 'empty')}
                                  onClick={(e) => openDatePop(task, e)}
                                  title={task.due ? tr('修改日期') : tr('设置日期')}
                                  aria-label={tr('{action}「{title}」的日期', { action: task.due ? tr('修改') : tr('设置'), title: taskTitle(task) })}
                                >
                                  <CalendarDays size={11} strokeWidth={1.9} />
                                  {task.due ? dueLabel(task.due, now) : tr('加日期')}
                                </button>
                                {task.due ? (
                                  timeEdit === task.id ? (
                                    <input
                                      className="card-time-input"
                                      type="time"
                                      defaultValue={task.dueTime || ''}
                                      autoFocus
                                      aria-label={tr('到点提醒时间')}
                                      title={tr('留空表示只到日期，不提醒')}
                                      onBlur={(e) => {
                                        const value = e.currentTarget.value;
                                        void patchTaskField(task, { dueTime: value || undefined });
                                      }}
                                      onKeyDown={(e) => {
                                        if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur();
                                      }}
                                    />
                                  ) : (
                                    <button
                                      className={cn('card-time-chip', task.dueTime && 'set')}
                                      title={task.dueTime ? tr('修改到点时间') : tr('设置到点提醒时间')}
                                      aria-label={tr('{action}「{title}」的到点时间', { action: task.dueTime ? tr('修改') : tr('设置'), title: taskTitle(task) })}
                                      onClick={() => {
                                        setDatePop(null);
                                        setTimeEdit(task.id);
                                      }}
                                    >
                                      <Clock size={11} strokeWidth={1.9} />
                                      {task.dueTime || tr('加时间')}
                                    </button>
                                  )
                                ) : null}
                              </div>
                            </div>
                            <button
                              className="card-row-del"
                              title={tr('删除待办（移入回收站）')}
                              aria-label={tr('删除「{title}」', { title: taskTitle(task) })}
                              disabled={busy}
                              onClick={() => void removeTask(task)}
                            >
                              <Trash2 size={13} strokeWidth={1.8} />
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                ))}
              </div>
            )}
          </div>
        </div>
      ) : tab === 'ideas' ? (
        <div className="card-body" role="tabpanel" aria-label={tr('随手记灵感')}>
          <div className="card-idea-compose">
            <textarea
              value={ideaDraft}
              rows={2}
              placeholder={tr('刚想到什么？写一句就记下…')}
              aria-label={tr('写一条灵感')}
              onChange={(e) => setIdeaDraft(e.target.value)}
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                  e.preventDefault();
                  void addIdea();
                }
              }}
            />
            <button
              className="card-idea-save"
              disabled={!ideaDraft.trim() || busy}
              onClick={() => void addIdea()}
              title={tr('保存灵感（Ctrl + Enter）')}
            >
              {tr('记下')}
            </button>
          </div>

          <div className="card-scroll">
            {loading ? (
              <div className="card-empty">
                <Loader2 size={16} className="spin" /> {tr('读取中…')}
              </div>
            ) : error ? (
              <div className="card-empty bad">{error}</div>
            ) : openIdeas.length === 0 ? (
              <div className="card-empty">
                <Lightbulb size={16} strokeWidth={1.8} />
                {tr('还没有灵感，写一句试试')}
              </div>
            ) : (
              <div className="card-idea-list">
                {openIdeas.map((idea) => (
                  <div className="card-idea" key={idea.id}>
                    <span className="card-idea-dot" />
                    <div className="card-idea-text" title={idea.text}>
                      {idea.text}
                    </div>
                    <span className="card-idea-time">{ideaTimeText(idea.created, now)}</span>
                    <button
                      className="card-row-del"
                      title={tr('删除这条灵感')}
                      aria-label={tr('删除这条灵感')}
                      disabled={busy}
                      onClick={() => void removeIdea(idea)}
                    >
                      <Trash2 size={12} strokeWidth={1.8} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="card-body card-shortcut-body" role="tabpanel" aria-label={tr('快捷入口')}>
          <div className="card-shortcut-bar">
            <span className="card-shortcut-summary">
              {loading
                ? tr('正在读取入口…')
                : homeError
                  ? tr('入口读取失败')
                  : shortcutCount
                    ? tr('{g} 组 · {n} 个入口', { g: filledShortcutGroups, n: shortcutCount })
                    : tr('首页还没有快捷入口')}
            </span>
            <div className="card-layout-switch" role="group" aria-label={tr('入口排版')}>
              <button
                className={cn(layout === 'grid' && 'on')}
                aria-pressed={layout === 'grid'}
                title={tr('图标排版：一行多个，适合快速点')}
                aria-label={tr('图标排版')}
                onClick={() => changeLayout('grid')}
              >
                <LayoutGrid size={12} strokeWidth={2} />
              </button>
              <button
                className={cn(layout === 'list' && 'on')}
                aria-pressed={layout === 'list'}
                title={tr('列表排版：显示说明，适合入口多时找')}
                aria-label={tr('列表排版')}
                onClick={() => changeLayout('list')}
              >
                <List size={12} strokeWidth={2} />
              </button>
            </div>
            <button className="card-shortcut-manage" title={tr('打开首页，添加或编辑快捷入口')} onClick={openHomePage}>
              <Pencil size={11} strokeWidth={1.9} />
              {tr('管理')}
            </button>
          </div>

          <div
            className="card-scroll card-shortcut-scroll"
            ref={shortcutScrollRef}
            onDragOver={autoScrollWhileDragging}
          >
            {loading ? (
              <div className="card-empty">
                <Loader2 size={16} className="spin" /> {tr('读取中…')}
              </div>
            ) : homeError ? (
              <div className="card-empty bad card-shortcut-none">
                <span>{homeError}</span>
                <button className="card-shortcut-action" onClick={() => void load()}>
                  {tr('重试')}
                </button>
              </div>
            ) : shortcutCount === 0 ? (
              <div className="card-empty card-shortcut-none">
                <LayoutGrid size={18} strokeWidth={1.7} />
                <span>{tr('首页还没有快捷入口')}</span>
                <button className="card-shortcut-action" onClick={openHomePage}>
                  {tr('去首页添加入口')}
                </button>
              </div>
            ) : (
              <>
                {shortcutGroups.map(({ group, entries }) => {
                  const GroupIcon = iconFor(group.icon, 'folder');
                  return (
                    <section
                      className="card-shortcut-group"
                      key={group.id}
                      aria-label={tr('分组 {name}', { name: group.name })}
                      onDragOver={(e) => allowShortcutDrop(e, group.id, entries.length)}
                      onDrop={(e) => dropShortcut(e, group.id, entries.length)}
                    >
                      <div className="card-shortcut-head">
                        <span className={cn('card-shortcut-group-icon', `hc-${group.color || 'green'}`)}>
                          <GroupIcon size={10} strokeWidth={2} />
                        </span>
                        <span className="card-shortcut-group-name">{group.name}</span>
                        <i>{entries.length}</i>
                      </div>
                      <div
                        className={cn(
                          'card-shortcuts',
                          layout === 'grid' ? 'is-grid' : 'is-list',
                          entries.length === 0 && 'is-empty',
                          dropHint?.groupId === group.id && dropHint.index >= entries.length && 'drop-end',
                        )}
                      >
                        {entries.map((entry, index) => {
                          const view = shortcutView(entry, apps, noteMap, notesScanned);
                          const Icon = iconFor(view.icon, 'star');
                          const sysIcon = entry.type === 'system' && entry.target ? systemIcons[entry.target] : '';
                          const unlinked = systemStatus.missingOf(entry);
                          return (
                            <button
                              className={cn(
                                'card-shortcut',
                                dragId === entry.id && 'dragging',
                                view.missing && 'missing',
                                unlinked && 'unlinked',
                                openingId === entry.id && 'opening',
                                dropHint?.groupId === group.id && dropHint.index === index && 'drop-before',
                              )}
                              key={entry.id}
                              draggable
                              data-shortcut={entry.id}
                              title={
                                unlinked
                                  ? tr('「{title}」在本机没有关联，点击可重新选择程序', { title: view.title })
                                  : view.missing
                                    ? tr('「{title}」已不存在，可到首页重新设置', { title: view.title })
                                    : tr('打开「{title}」{sub}；拖动可调整位置', { title: view.title, sub: view.sub ? ` · ${tr(view.sub)}` : '' })
                              }
                              aria-label={tr('打开{title}', { title: view.title })}
                              onDragStart={(e) => beginShortcutDrag(e, entry)}
                              onDragEnd={finishShortcutDrag}
                              onDragOver={(e) => allowShortcutDrop(e, group.id, index)}
                              onDrop={(e) => dropShortcut(e, group.id, index)}
                              onClick={() => void openShortcut(entry)}
                            >
                              <span className={cn('card-shortcut-icon', `hc-${view.color}`, view.missing && 'missing')}>
                                {openingId === entry.id ? (
                                  <Loader2 size={layout === 'grid' ? 15 : 13} className="spin" />
                                ) : sysIcon ? (
                                  <img src={sysIcon} alt="" draggable={false} />
                                ) : view.badge ? (
                                  <span
                                    className="card-shortcut-badge"
                                    style={view.brand ? { color: view.brand } : undefined}
                                    aria-hidden
                                  >
                                    {view.badge}
                                  </span>
                                ) : (
                                  <Icon size={layout === 'grid' ? 15 : 13} strokeWidth={1.9} />
                                )}
                                {unlinked && (
                                  <span className="entry-unlinked-dot" title={tr('本机未关联')} aria-hidden>
                                    !
                                  </span>
                                )}
                              </span>
                              <span className="card-shortcut-text">
                                <span className="card-shortcut-title">{view.title}</span>
                                <span className="card-shortcut-sub">
                                  {openingId === entry.id ? tr('正在打开…') : unlinked ? tr('本机未关联') : tr(view.sub)}
                                </span>
                              </span>
                            </button>
                          );
                        })}
                        {entries.length === 0 ? (
                          <span className="card-shortcut-empty">{dragId ? tr('放这里') : tr('暂无入口')}</span>
                        ) : null}
                      </div>
                    </section>
                  );
                })}
                <div className="card-shortcut-hint">{tr('拖动可排序，拖到其他分组即可移动；改动会和首页同步')}</div>
              </>
            )}
          </div>
        </div>
      )}

      <footer className="card-foot">
        <span className={cn('card-flash', flash && 'on', flashBusy && 'busy')} role="status" aria-live="polite">
          {flashBusy ? <Loader2 size={11} className="spin" /> : null}
          {flash || (
            <>
              <Sparkles size={11} strokeWidth={1.8} /> {tr('本地保存，自动同步')}
            </>
          )}
        </span>
        {undo ? (
          <button className="card-undo" onClick={() => void runUndo()} title={tr('撤销刚才的删除')}>
            <Undo2 size={11} strokeWidth={1.9} /> {tr('撤销')}
          </button>
        ) : null}
        {bridge?.showMain ? (
          <button
            className="card-home"
            title={tr('打开主窗口（Ctrl+Alt+D 开关浮窗）')}
            aria-label={tr('打开主窗口')}
            onClick={() => void bridge.showMain?.()}
          >
            <Expand size={11} strokeWidth={1.9} /> {tr('主窗口')}
          </button>
        ) : (
          <span className="card-foot-hint">{tr('Ctrl+Alt+D 开关')}</span>
        )}
      </footer>

      <div className="card-resize" title={tr('拖动调整浮窗大小')} aria-hidden onPointerDown={startResize} />

      <SystemAppMissingDialog
        entry={missingEntry}
        onClose={() => setMissingEntry(null)}
        onRecheck={() => systemStatus.refresh()}
        onPicked={linkSystemApp}
      />

      {datePop ? (
        <DatePicker
          value={datePop.task.due}
          x={datePop.x}
          y={datePop.y}
          onPick={(due) => void patchTaskField(datePop.task, { due })}
          onClose={() => setDatePop(null)}
        />
      ) : null}
    </div>
  );
}
