/**
 * 首页（docs/15）：问候与快速记录 + 今日概况 + 分组快捷入口 + AI 小应用。
 *
 * 首页本身不复制任何笔记内容：入口只保存指向，点击后切到对应视图。
 * 布局上的「主区 / 侧栏」在窄窗口下会变成单列，避免快捷卡片被挤成一条。
 */
import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  BookOpen,
  CalendarDays,
  CircleCheck,
  Clock3,
  Database,
  Download,
  FolderInput,
  FolderPlus,
  LayoutGrid,
  Lightbulb,
  Loader2,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
  Wand2,
  X,
} from 'lucide-react';
import { useApp } from '../store/app';
import { useHome } from '../store/home';
import { getLang, t, useT } from '../lib/i18n';
import { useAppBuilder } from '../store/appBuilder';
import { HOME_VIEWS, hostOf, type HomeColor, type HomeEntry, type HomeGroup, type ShortcutType } from '../lib/home';
import { exportApp, readAppHtml, type AppMeta } from '../lib/apps';
import { sitePresetForUrl } from '../lib/shortcutPresets';
import type { Note } from '../lib/markdown';
import { openExternal } from '../lib/openExternal';
import { desktop } from '../lib/desktop';
import { computeWritingStats, formatWords } from '../lib/stats';
import { friendlyTime, dateKey, cn } from '../lib/utils';
import { isIdeaOpen } from '../lib/ideas';
import { dayDiff, isOpenTask } from '../lib/tasks';
import { iconFor } from './homeIcons';
import { ShortcutDialog } from './ShortcutDialog';
import { HomeGroupDialog, HomeGroupDeleteDialog } from './HomeGroupDialog';
import { ImportAppDialog } from './ImportAppDialog';
import { AppInfoDialog } from './AppInfoDialog';
import { AppDataDialog } from './AppDataDialog';
import { AppRunner } from './AppRunner';
import { SystemAppMissingDialog } from './SystemAppMissingDialog';
import { useSystemAppStatus } from '../hooks/useSystemAppStatus';
import { Menu, type MenuEntry } from './Menu';
import { ConfirmDialog } from './Confirm';

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

const DEFAULT_ICON: Record<ShortcutType, string> = {
  note: 'file',
  notebook: 'folder',
  daily: 'pen',
  view: 'grid',
  url: 'globe',
  app: 'sparkles',
  system: 'monitor',
};

interface EntryView {
  title: string;
  sub: string;
  icon: string;
  color: HomeColor;
  /** 网址命中常用站点时显示的品牌角标（知 / B / 微……），代替图标 */
  badge?: string;
  /** 角标用的品牌色 */
  brand?: string;
  missing?: boolean;
}

function entryView(entry: HomeEntry, notes: Note[], apps: AppMeta[]): EntryView {
  const color = entry.color || 'green';
  const icon = entry.icon || DEFAULT_ICON[entry.type];
  if (entry.type === 'note') {
    const note = notes.find((n) => n.id === entry.target);
    return {
      title: entry.title || note?.title || t('未命名笔记'),
      sub: note ? note.notebook || t('根目录') : t('笔记已不存在'),
      icon,
      color,
      missing: !note,
    };
  }
  if (entry.type === 'notebook') {
    return { title: entry.title || entry.target || t('笔记本'), sub: t('笔记本'), icon, color };
  }
  if (entry.type === 'daily') {
    const d = new Date();
    return {
      title: entry.title || t('今日日记'),
      sub: getLang() === 'en'
        ? d.toLocaleString('en-US', { month: 'short', day: 'numeric', weekday: 'short' })
        : `${d.getMonth() + 1} 月 ${d.getDate()} 日 · ${WEEKDAYS[d.getDay()]}`,
      icon,
      color,
    };
  }
  if (entry.type === 'view') {
    return {
      title: entry.title || t(HOME_VIEWS.find((v) => v.key === entry.target)?.label || '智能视图'),
      sub: t('智能视图'),
      icon,
      color,
    };
  }
  if (entry.type === 'url') {
    const host = hostOf(entry.target);
    // 常用站点用品牌角标代替通用地球图标；用户自己换过图标的保持原样
    const site = !entry.icon || entry.icon === 'globe' ? sitePresetForUrl(entry.target) : null;
    return {
      title: entry.title || host || t('网页'),
      sub: host || entry.target || '',
      icon,
      color,
      badge: site?.badge,
      brand: site?.color,
    };
  }
  if (entry.type === 'system') {
    const file = (entry.target || '').split(/[\\/]/).pop() || '';
    const fallback = file.replace(/\.(lnk|exe|app|desktop)$/i, '') || t('系统应用');
    return { title: entry.title || fallback, sub: t('系统应用'), icon: icon || 'monitor', color: entry.color || 'blue' };
  }
  const app = apps.find((a) => a.id === entry.target);
  // 应用的名称 / 图标 / 颜色以应用信息为准，入口只负责摆放位置；
  // 应用已不存在时退回入口里的记录，卡片不至于变成空白。
  return {
    title: app?.name || entry.title || t('AI 应用'),
    sub: app ? app.description || t('第 {n} 版', { n: app.version }) : t('应用已不存在'),
    icon: app?.icon || entry.icon || 'sparkles',
    color: app?.color || color,
    missing: !app,
  };
}

function greetingOf(hour: number) {
  if (hour < 5) return t('夜深了');
  if (hour < 11) return t('早上好');
  if (hour < 13) return t('中午好');
  if (hour < 18) return t('下午好');
  return t('晚上好');
}

interface MenuState {
  kind: 'entry' | 'group';
  id: string;
  x: number;
  y: number;
}

/** 主窗口内运行的一个小应用窗口；最小化后留在底部任务坞 */
interface RunnerWindow {
  key: string;
  appId: string;
  minimized: boolean;
  /** 层级：后打开或点一下的窗口压在上面 */
  z: number;
}

export function HomePage() {
  const tr = useT();
  const notes = useApp((s) => s.notes);
  const notebooks = useApp((s) => s.notebooks);
  const tasks = useApp((s) => s.tasks);
  const tasksLoaded = useApp((s) => s.tasksLoaded);
  const ideas = useApp((s) => s.ideas);
  const ideasLoaded = useApp((s) => s.ideasLoaded);
  const setView = useApp((s) => s.setView);
  const setQuery = useApp((s) => s.setQuery);
  const select = useApp((s) => s.select);
  const openDaily = useApp((s) => s.openDaily);
  const addIdea = useApp((s) => s.addIdea);
  const removeIdeas = useApp((s) => s.removeIdeas);
  const toast = useApp((s) => s.toast);
  const loadTasks = useApp((s) => s.loadTasks);
  const loadIdeas = useApp((s) => s.loadIdeas);
  const setTaskTimeFilter = useApp((s) => s.setTaskTimeFilter);

  const loaded = useHome((s) => s.loaded);
  const loading = useHome((s) => s.loading);
  const issues = useHome((s) => s.issues);
  const data = useHome((s) => s.data);
  const groups = useHome((s) => s.groups);
  const entries = useHome((s) => s.entries);
  const apps = useHome((s) => s.apps);
  const load = useHome((s) => s.load);
  const addGroup = useHome((s) => s.addGroup);
  const updateGroup = useHome((s) => s.updateGroup);
  const deleteGroup = useHome((s) => s.deleteGroup);
  const moveGroup = useHome((s) => s.moveGroup);
  const addEntry = useHome((s) => s.addEntry);
  const updateEntry = useHome((s) => s.updateEntry);
  const deleteEntry = useHome((s) => s.deleteEntry);
  const restoreEntry = useHome((s) => s.restoreEntry);
  const moveEntry = useHome((s) => s.moveEntry);
  const moveEntryBy = useHome((s) => s.moveEntryBy);
  const deleteApp = useHome((s) => s.deleteApp);
  const updateAppInfo = useHome((s) => s.updateAppInfo);

  const [capture, setCapture] = useState('');
  const [captureBusy, setCaptureBusy] = useState(false);
  const [issuesHidden, setIssuesHidden] = useState(false);

  const [shortcutOpen, setShortcutOpen] = useState(false);
  const [editingEntry, setEditingEntry] = useState<HomeEntry | null>(null);
  const [defaultGroupId, setDefaultGroupId] = useState<string | undefined>();

  const [groupDialogOpen, setGroupDialogOpen] = useState(false);
  const [editingGroup, setEditingGroup] = useState<HomeGroup | null>(null);
  const [deletingGroup, setDeletingGroup] = useState<HomeGroup | null>(null);

  const [importOpen, setImportOpen] = useState(false);
  /** 应用市场默认停在哪个页签；从删掉的 AI 小应用入口跳过来时直接落到「AI 生成」 */
  const [importTab, setImportTab] = useState<'market' | 'ai' | 'file'>('market');
  const openMarket = (tab: 'market' | 'ai' | 'file' = 'market') => {
    setImportTab(tab);
    setImportOpen(true);
  };
  const [appInfoApp, setAppInfoApp] = useState<AppMeta | null>(null);
  const [appDataApp, setAppDataApp] = useState<AppMeta | null>(null);
  const [confirmApp, setConfirmApp] = useState<AppMeta | null>(null);
  /** 主窗口内运行的小应用：支持同时开多个，最小化后收进底部任务坞 */
  const [runners, setRunners] = useState<RunnerWindow[]>([]);
  /** 窗口自增 id 与层级：后打开的压在上面 */
  const runnerSeq = useRef(0);
  const runnerZ = useRef(0);

  /** 打开一个小应用：已经开着就恢复并置顶，不重复开第二个 */
  const openRunner = (appId: string) => {
    const z = ++runnerZ.current;
    setRunners((list) => {
      const existing = list.find((item) => item.appId === appId);
      if (existing) {
        return list.map((item) => (item.key === existing.key ? { ...item, minimized: false, z } : item));
      }
      runnerSeq.current += 1;
      return [...list, { key: `runner-${appId}-${runnerSeq.current}`, appId, minimized: false, z }];
    });
  };

  /** 点窗口任意位置把它抬到最上层 */
  const raiseRunner = (key: string) => {
    setRunners((list) => {
      const target = list.find((item) => item.key === key);
      if (!target || target.minimized) return list;
      const top = list.reduce((max, item) => (item.minimized ? max : Math.max(max, item.z)), 0);
      if (target.z === top) return list;
      const z = ++runnerZ.current;
      return list.map((item) => (item.key === key ? { ...item, z } : item));
    });
  };

  /** 从任务坞点回来 */
  const restoreRunner = (key: string) => {
    const z = ++runnerZ.current;
    setRunners((list) => list.map((item) => (item.key === key ? { ...item, minimized: false, z } : item)));
  };

  const minimizeRunner = (key: string) => {
    setRunners((list) => list.map((item) => (item.key === key ? { ...item, minimized: true } : item)));
  };

  const closeRunner = (key: string) => {
    setRunners((list) => list.filter((item) => item.key !== key));
  };

  // Esc 关掉最上面那个小应用；焦点在应用 iframe 里时浏览器不会把按键冒到主文档，右上角的按钮也能关
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setRunners((list) => {
        const open = list.filter((item) => !item.minimized);
        if (!open.length) return list;
        const top = open.reduce((a, b) => (a.z > b.z ? a : b));
        return list.filter((item) => item.key !== top.key);
      });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const [systemIcons, setSystemIcons] = useState<Record<string, string>>({});
  /** 点了打不开的系统应用入口：弹引导框，让用户重装或重新选程序 */
  const [missingEntry, setMissingEntry] = useState<HomeEntry | null>(null);
  /** 正在拉起的系统应用 / 网址：卡片上盖一层「正在打开…」，别让人以为没点上 */
  const [openingId, setOpeningId] = useState<string | null>(null);

  const [menu, setMenu] = useState<MenuState | null>(null);
  const [moveMenu, setMoveMenu] = useState<{ entryId: string; x: number; y: number } | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropHint, setDropHint] = useState<{ groupId: string; index: number } | null>(null);

  // 进入首页时强制读一次盘：外部进程（MCP）改了 apps/、home/ 只落文件，
  // 切到别的页面时 HomePage 会卸载，刷新事件没人接，靠这里的 force 兜底。
  useEffect(() => {
    void load(true);
  }, [load]);

  useEffect(() => {
    const onRefreshed = () => void load(true);
    window.addEventListener('glimnote:repo-refreshed', onRefreshed);
    return () => window.removeEventListener('glimnote:repo-refreshed', onRefreshed);
  }, [load]);

  // 任务 / 灵感是按需加载的，首页要显示数量就先补上；失败不影响其它内容
  useEffect(() => {
    if (!tasksLoaded) void loadTasks();
    if (!ideasLoaded) void loadIdeas();
  }, [tasksLoaded, ideasLoaded, loadTasks, loadIdeas]);

  const systemPaths = useMemo(
    () =>
      Object.values(entries)
        .filter((e) => e.type === 'system' && e.target)
        .map((e) => e.target as string),
    [entries],
  );
  // 本机是否还找得到这些系统应用：找不到的入口在图标上打「未关联」标记
  const systemStatus = useSystemAppStatus(entries);

  // 系统应用入口尽量显示真实图标；取不到就退回 monitor 兜底图标
  useEffect(() => {
    const bridge = desktop();
    if (!bridge?.systemAppIcons) return;
    const missing = systemPaths.filter((p) => !systemIcons[p]).slice(0, 20);
    if (!missing.length) return;
    let alive = true;
    void bridge
      .systemAppIcons(missing)
      .then((map) => {
        if (alive && map && Object.keys(map).length) setSystemIcons((prev) => ({ ...prev, ...map }));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [systemPaths, systemIcons]);

  const now = new Date();
  const todayKey = dateKey(now);
  const hour = now.getHours();
  const todayLabel = getLang() === 'en'
    ? now.toLocaleString('en-US', { month: 'short', day: 'numeric', weekday: 'short' })
    : `${now.getMonth() + 1} 月 ${now.getDate()} 日 · ${WEEKDAYS[now.getDay()]}`;

  const stats = useMemo(() => {
    const open = tasks.filter(isOpenTask);
    const dueToday = open.filter((t) => t.due === todayKey).length;
    const overdue = open.filter((t) => t.due && dayDiff(t.due) < 0).length;
    const pendingIdeas = ideas.filter(isIdeaOpen).length;
    const daily = notes.find((n) => n.notebook === '日记' && n.title === todayKey);
    return { dueToday, overdue, pendingIdeas, daily };
  }, [tasks, ideas, notes, todayKey]);

  const writing = useMemo(() => computeWritingStats(notes), [notes]);

  const recent = useMemo(
    () => [...notes].sort((a, b) => +new Date(b.updated) - +new Date(a.updated)).slice(0, 5),
    [notes],
  );
  const continueNotes = recent.slice(0, 3);

  const notebookList = useMemo(() => {
    const set = new Set(notebooks.filter(Boolean));
    for (const note of notes) if (note.notebook) set.add(note.notebook);
    return Array.from(set);
  }, [notes, notebooks]);

  const maxWeekWords = Math.max(1, ...writing.daily.map((d) => d.words));

  const groupList = useMemo(() => {
    if (!data) return groups;
    const map = new Map(groups.map((g) => [g.id, g]));
    const ordered = data.groupOrder.map((id) => map.get(id)).filter((g): g is HomeGroup => Boolean(g));
    for (const group of groups) if (!ordered.some((g) => g.id === group.id)) ordered.push(group);
    return ordered;
  }, [groups, data]);

  const groupOf = (entryId: string) => groups.find((g) => g.entries.includes(entryId)) || null;

  const submitCapture = async () => {
    const text = capture.trim();
    if (!text || captureBusy) return;
    setCaptureBusy(true);
    try {
      const idea = await addIdea(text);
      if (!idea) return;
      setCapture('');
      toast(tr('已记进灵感'), 'success', {
        label: tr('撤销'),
        run: () => void removeIdeas([idea.id]),
      });
    } finally {
      setCaptureBusy(false);
    }
  };

  const navigate = (view: { type: 'notebook' | 'smart' | 'trash'; value: string }) => {
    setView(view);
    setQuery('');
  };

  /** 让「正在打开」的转圈至少停一会儿，避免一闪而过 */
  const keepOpening = async (startedAt: number, ms = 700) => {
    const left = ms - (Date.now() - startedAt);
    if (left > 0) await new Promise((resolve) => window.setTimeout(resolve, left));
  };

  const openEntry = async (entry: HomeEntry) => {
    if (entry.type === 'note') {
      const note = notes.find((n) => n.id === entry.target);
      if (!note) {
        toast('这篇笔记已经不在仓库里了，可以编辑入口重新指向', 'warn');
        return;
      }
      select(note.id);
      navigate({ type: 'notebook', value: note.notebook });
      return;
    }
    if (entry.type === 'notebook') {
      navigate({ type: 'notebook', value: entry.target || '' });
      return;
    }
    if (entry.type === 'daily') {
      void openDaily();
      return;
    }
    if (entry.type === 'view') {
      if (entry.target) navigate({ type: 'smart', value: entry.target });
      return;
    }
    if (entry.type === 'url') {
      if (!entry.target) return;
      // 浏览器冷启动可能要好几秒：卡片先转起来，等超过半秒还没打开再补一条提示
      const startedAt = Date.now();
      setOpeningId(entry.id);
      window.setTimeout(
        () => toast(t('网站打开中，请稍候…'), 'info', undefined, undefined, 5000, true),
        600,
      );
      try {
        await openExternal(entry.target);
      } catch (e) {
        toast((e as Error).message || t('网址打不开'), 'warn');
      } finally {
        await keepOpening(startedAt);
        setOpeningId(null);
      }
      return;
    }
    if (entry.type === 'system') {
      const bridge = desktop();
      if (!bridge?.openSystemApp) {
        toast(t('系统应用只能在桌面客户端里打开'), 'warn');
        return;
      }
      // 已经确认路径不在了就直接引导，不必等启动失败
      if (systemStatus.missingOf(entry)) {
        setMissingEntry(entry);
        return;
      }
      const target = entry.target || '';
      const startedAt = Date.now();
      setOpeningId(entry.id);
      window.setTimeout(
        () => toast(t('应用打开中，请稍候…'), 'info', undefined, undefined, 5000, true),
        600,
      );
      try {
        const ok = await bridge.openSystemApp(target);
        if (!ok) {
          // 路径还在但启动失败（权限 / 程序损坏）：同样给出重选入口
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
    const app = apps.find((a) => a.id === entry.target);
    if (!app) {
      toast(t('这个 AI 应用已经删除了，可以编辑入口重新选择'), 'warn');
      return;
    }
    // 一律先在主窗口里打开：既能在个别机器浮窗起不来时保证可用，也方便同时开几个对照着用
    openRunner(app.id);
  };

  const startAddEntry = (groupId?: string) => {
    setEditingEntry(null);
    setDefaultGroupId(groupId || groupList[0]?.id);
    setShortcutOpen(true);
  };

  const startEditEntry = (entry: HomeEntry) => {
    setEditingEntry(entry);
    setDefaultGroupId(groupOf(entry.id)?.id);
    setShortcutOpen(true);
  };

  const saveEntry = async (
    input: { type: ShortcutType; title?: string; icon?: string; color?: HomeColor; target?: string },
    groupId: string,
    entryId?: string,
  ) => {
    if (entryId) {
      await updateEntry(entryId, input);
      const from = groupOf(entryId);
      if (from && from.id !== groupId) {
        const target = groups.find((g) => g.id === groupId);
        await moveEntry(entryId, groupId, target ? target.entries.length : 0);
      }
    } else {
      await addEntry(groupId, input);
    }
    toast(entryId ? t('入口已更新') : t('入口已添加'), 'success');
  };

  const startEditGroup = (group: HomeGroup) => {
    setEditingGroup(group);
    setGroupDialogOpen(true);
  };

  const saveGroup = async (input: { name: string; icon?: string; color?: HomeColor }) => {
    if (editingGroup) await updateGroup(editingGroup.id, input);
    else await addGroup(input);
    toast(editingGroup ? t('分组已更新') : t('分组已创建'), 'success');
  };

  const removeEntryWithUndo = async (entry: HomeEntry) => {
    const view = entryView(entry, notes, apps);
    // 小应用只是入口没了，应用本身还在；提示一句，给个直达应用市场的按钮
    const app = entry.type === 'app' ? apps.find((a) => a.id === entry.target) : null;
    const isApp = Boolean(app);
    try {
      const deleted = await deleteEntry(entry.id);
      toast(
        isApp
          ? t('已删除「{name}」入口，应用还在，可从应用市场加回来', { name: view.title })
          : t('已删除「{name}」', { name: view.title }),
        'success',
        {
          label: t('撤销'),
          run: () => void restoreEntry(deleted),
        },
        isApp
          ? {
              label: t('去市场'),
              run: () => openMarket(app?.source === 'ai' ? 'ai' : 'market'),
            }
          : undefined,
      );
    } catch (e) {
      toast((e as Error).message || t('删除失败'), 'error');
    }
  };

  const doMoveEntry = async (entryId: string, groupId: string, index: number) => {
    try {
      await moveEntry(entryId, groupId, index);
    } catch (e) {
      toast((e as Error).message || t('移动失败'), 'error');
    }
  };

  const handleDrop = (groupId: string, index: number) => {
    const id = dragId;
    setDragId(null);
    setDropHint(null);
    if (id) void doMoveEntry(id, groupId, index);
  };

  const openMenuAt = (e: ReactMouseEvent, kind: 'entry' | 'group', id: string) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ kind, id, x: e.clientX, y: e.clientY });
  };

  const entryMenuItems = (entry: HomeEntry): (MenuEntry | 'sep')[] => {
    const group = groupOf(entry.id);
    const index = group ? group.entries.indexOf(entry.id) : -1;
    const app = entry.type === 'app' ? apps.find((a) => a.id === entry.target) : null;
    const items: (MenuEntry | 'sep')[] = [
      { label: t('打开'), icon: <ArrowUpRight size={14} />, onClick: () => openEntry(entry) },
      { label: t('编辑入口'), icon: <Pencil size={14} />, onClick: () => startEditEntry(entry) },
      'sep',
      {
        label: t('上移'),
        icon: <ArrowUp size={14} />,
        disabled: !group || index <= 0,
        onClick: () => void moveEntryBy(entry.id, -1),
      },
      {
        label: t('下移'),
        icon: <ArrowDown size={14} />,
        disabled: !group || index < 0 || index >= group.entries.length - 1,
        onClick: () => void moveEntryBy(entry.id, 1),
      },
      {
        label: t('移到其他分组…'),
        icon: <FolderInput size={14} />,
        disabled: groups.length < 2,
        onClick: () => {
          if (menu) setMoveMenu({ entryId: entry.id, x: menu.x, y: menu.y });
        },
      },
    ];
    if (app) {
      items.push(
        'sep',
        {
          label: t('编辑应用信息'),
          icon: <Pencil size={14} />,
          onClick: () => setAppInfoApp(app),
        },
        {
          label: t('下载 HTML'),
          icon: <Download size={14} />,
          onClick: () => {
            void (async () => {
              try {
                const html = await readAppHtml(app.id);
                if (!html) {
                  toast(t('应用代码读不到了，可能已被删除或同步覆盖'), 'error');
                  return;
                }
                await exportApp(app, html);
                toast(t('已下载「{name}.html」', { name: app.name }), 'success');
              } catch (e) {
                toast((e as Error).message || t('导出应用失败'), 'error');
              }
            })();
          },
        },
        {
          label: t('查看应用数据…'),
          icon: <Database size={14} />,
          onClick: () => setAppDataApp(app),
        },
        {
          label: t('用 AI 继续修改'),
          icon: <Wand2 size={14} />,
          onClick: () => {
            void (async () => {
              try {
                const html = await readAppHtml(app.id);
                if (!html) {
                  toast(t('应用代码读不到了，可能已被删除或同步覆盖'), 'error');
                  return;
                }
                useAppBuilder.getState().open({ initial: { meta: app, html } });
              } catch (e) {
                toast((e as Error).message || t('读取应用失败'), 'error');
              }
            })();
          },
        },
      );
      items.push({
        label: t('删除这个应用…'),
        icon: <Trash2 size={14} />,
        danger: true,
        onClick: () => setConfirmApp(app),
      });
    }
    items.push('sep', {
      label: t('删除入口'),
      icon: <Trash2 size={14} />,
      danger: true,
      onClick: () => void removeEntryWithUndo(entry),
    });
    return items;
  };

  const groupMenuItems = (group: HomeGroup): (MenuEntry | 'sep')[] => {
    const index = groupList.findIndex((g) => g.id === group.id);
    return [
      { label: t('添加一个入口'), icon: <Plus size={14} />, onClick: () => startAddEntry(group.id) },
      { label: t('编辑分组'), icon: <Pencil size={14} />, onClick: () => startEditGroup(group) },
      'sep',
      {
        label: t('上移分组'),
        icon: <ArrowUp size={14} />,
        disabled: index <= 0,
        onClick: () => void moveGroup(group.id, -1),
      },
      {
        label: t('下移分组'),
        icon: <ArrowDown size={14} />,
        disabled: index < 0 || index >= groupList.length - 1,
        onClick: () => void moveGroup(group.id, 1),
      },
      'sep',
      {
        label: t('删除分组…'),
        icon: <Trash2 size={14} />,
        danger: true,
        disabled: groupList.length <= 1,
        onClick: () => setDeletingGroup(group),
      },
    ];
  };

  return (
    <div className="home">
      <div className="home-scroll">
        <header className="home-hero">
          <div className="home-hero-copy">
            <div className="home-greet">
              {greetingOf(hour)}
              <span className="home-greet-dot" />
              {todayLabel}
            </div>
            <h1 className="home-title">
              {stats.dueToday + stats.overdue > 0
                ? tr('今天还有 {n} 件事', { n: stats.dueToday + stats.overdue })
                : tr('今天想写点什么？')}
            </h1>
            <p className="home-sub">
              {writing.streak > 0 ? tr('已经连续记录 {n} 天，', { n: writing.streak }) : ''}
              {tr('本周写了 {words} 字 · {days} 天有更新', { words: formatWords(writing.weekWords), days: writing.weekDays })}
            </p>
          </div>

          <div className="home-capture">
            <Lightbulb size={17} className="home-capture-icon" />
            <input
              value={capture}
              maxLength={2000}
              placeholder={tr('随手记一句想法，回车存入灵感…')}
              onChange={(e) => setCapture(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void submitCapture();
                }
              }}
            />
            <button
              className="btn btn-primary home-capture-btn"
              disabled={!capture.trim() || captureBusy}
              onClick={() => void submitCapture()}
            >
              {tr('存入灵感')}
            </button>
          </div>
        </header>

        {issues > 0 && !issuesHidden && (
          <div className="home-issues">
            <AlertTriangle size={15} />
            <span>{tr('有 {n} 个首页入口文件格式不对，已经跳过，不会影响笔记和待办。', { n: issues })}</span>
            <button className="home-issues-close" onClick={() => setIssuesHidden(true)} aria-label={tr('知道了')}>
              {tr('知道了')}
            </button>
          </div>
        )}

        <div className="home-grid">
          <div className="home-main">
            <section className="home-stats" aria-label={tr('今日概况')}>
              <button
                className="home-stat"
                onClick={() => {
                  setTaskTimeFilter('today');
                  navigate({ type: 'smart', value: 'todo' });
                }}
              >
                <span className="home-stat-icon tone-amber">
                  <CircleCheck size={16} strokeWidth={1.8} />
                </span>
                <span className="home-stat-body">
                  <span className="home-stat-num">{tasksLoaded ? stats.dueToday : '–'}</span>
                  <span className="home-stat-label">{tr('今天到期')}</span>
                </span>
              </button>
              <button
                className={cn('home-stat', stats.overdue > 0 && 'warn')}
                onClick={() => {
                  setTaskTimeFilter('overdue');
                  navigate({ type: 'smart', value: 'todo' });
                }}
              >
                <span className="home-stat-icon tone-red">
                  <Clock3 size={16} strokeWidth={1.8} />
                </span>
                <span className="home-stat-body">
                  <span className="home-stat-num">{tasksLoaded ? stats.overdue : '–'}</span>
                  <span className="home-stat-label">{tr('已逾期')}</span>
                </span>
              </button>
              <button className="home-stat" onClick={() => navigate({ type: 'smart', value: 'ideas' })}>
                <span className="home-stat-icon tone-purple">
                  <Lightbulb size={16} strokeWidth={1.8} />
                </span>
                <span className="home-stat-body">
                  <span className="home-stat-num">{ideasLoaded ? stats.pendingIdeas : '–'}</span>
                  <span className="home-stat-label">{tr('待整理灵感')}</span>
                </span>
              </button>
              <button className="home-stat" onClick={() => void openDaily()}>
                <span className="home-stat-icon tone-green">
                  <BookOpen size={16} strokeWidth={1.8} />
                </span>
                <span className="home-stat-body">
                  <span className={cn('home-stat-num', !stats.daily && 'muted-num')}>
                    {stats.daily ? tr('已写') : tr('未写')}
                  </span>
                  <span className="home-stat-label">{tr('今日日记')}</span>
                </span>
              </button>
            </section>

            <section className="home-block home-shortcuts">
              <div className="home-block-head">
                <div>
                  <h2 className="home-block-title">{tr('快捷入口')}</h2>
                  <p className="home-block-sub">{tr('笔记、日记、网址和小应用都在这里；拖动可以排序。')}</p>
                </div>
                <div className="home-block-actions">
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => {
                      setEditingGroup(null);
                      setGroupDialogOpen(true);
                    }}
                  >
                    <FolderPlus size={14} />
                    {tr('新建分组')}
                  </button>
                  <button
                    className="btn btn-secondary btn-sm"
                    title={tr('挑一个现成的小应用装上，也可以导入 Claude、WorkBuddy 生成的 HTML 或 zip')}
                    onClick={() => openMarket()}
                  >
                    <LayoutGrid size={14} />
                    {tr('应用市场')}
                  </button>
                  <button className="btn btn-primary btn-sm" onClick={() => useAppBuilder.getState().open()}>
                    <Sparkles size={14} />
                    {tr('AI 小应用')}
                  </button>
                </div>
              </div>

              {loading && !loaded && (
                <div className="home-groups">
                  {[0, 1].map((i) => (
                    <div className="home-group home-skeleton" key={i}>
                      <div className="home-skeleton-line" />
                      <div className="home-entry-grid">
                        {[0, 1, 2, 3].map((j) => (
                          <div className="home-entry-card skeleton" key={j} />
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <div className="home-groups">
                {groupList.map((group) => {
                  const list = group.entries.map((id) => entries[id]).filter((e): e is HomeEntry => Boolean(e));
                  const GroupIcon = iconFor(group.icon || 'folder', 'folder');
                  const dropEnd = dropHint?.groupId === group.id && dropHint.index >= list.length;
                  return (
                    <div
                      key={group.id}
                      className={cn('home-group', `tone-${group.color || 'green'}`, dropEnd && 'drop-end')}
                      onDragOver={(e) => {
                        if (!dragId) return;
                        e.preventDefault();
                        e.dataTransfer.dropEffect = 'move';
                        if (!dropEnd) setDropHint({ groupId: group.id, index: list.length });
                      }}
                      onDragLeave={(e) => {
                        if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                          setDropHint((h) => (h?.groupId === group.id ? null : h));
                        }
                      }}
                      onDrop={(e) => {
                        if (!dragId) return;
                        e.preventDefault();
                        handleDrop(group.id, list.length);
                      }}
                    >
                      <div className="home-group-head">
                        <span className={cn('home-group-icon', `hc-${group.color || 'green'}`)}>
                          <GroupIcon size={15} strokeWidth={1.8} />
                        </span>
                        <span className="home-group-name">{group.name}</span>
                        <span className="home-group-count">{list.length}</span>
                        <div className="home-group-actions">
                          <button
                            className="home-mini-btn"
                            title={tr('往这个分组里加一个入口')}
                            onClick={() => startAddEntry(group.id)}
                          >
                            <Plus size={14} />
                          </button>
                          <button
                            className="home-mini-btn"
                            title={tr('分组操作')}
                            onClick={(e) => openMenuAt(e, 'group', group.id)}
                          >
                            <MoreHorizontal size={15} />
                          </button>
                        </div>
                      </div>

                      <div className="home-entry-grid">
                        {list.map((entry, index) => {
                          const view = entryView(entry, notes, apps);
                          const Icon = iconFor(view.icon, 'link');
                          const sysIcon = entry.type === 'system' ? systemIcons[entry.target || ''] : '';
                          // 系统应用只在当前电脑有效：路径失效时标出来，点击走引导框
                          const unlinked = systemStatus.missingOf(entry);
                          const isDropBefore = dropHint?.groupId === group.id && dropHint.index === index;
                          return (
                            <div
                              key={entry.id}
                              className={cn(
                                'home-entry-card',
                                `tone-${view.color}`,
                                view.missing && 'missing',
                                unlinked && 'unlinked',
                                dragId === entry.id && 'dragging',
                                isDropBefore && 'drop-before',
                                openingId === entry.id && 'opening',
                              )}
                              role="button"
                              tabIndex={0}
                              draggable
                              onDragStart={(e) => {
                                setDragId(entry.id);
                                e.dataTransfer.effectAllowed = 'move';
                                e.dataTransfer.setData('text/plain', entry.id);
                              }}
                              onDragEnd={() => {
                                setDragId(null);
                                setDropHint(null);
                              }}
                              onDragOver={(e) => {
                                if (!dragId || dragId === entry.id) return;
                                e.preventDefault();
                                e.stopPropagation();
                                e.dataTransfer.dropEffect = 'move';
                                if (!isDropBefore) setDropHint({ groupId: group.id, index });
                              }}
                              onDrop={(e) => {
                                if (!dragId) return;
                                e.preventDefault();
                                e.stopPropagation();
                                handleDrop(group.id, index);
                              }}
                              onClick={() => openEntry(entry)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                  e.preventDefault();
                                  openEntry(entry);
                                }
                              }}
                              onContextMenu={(e) => openMenuAt(e, 'entry', entry.id)}
                            >
                              <span className={cn('home-entry-icon', `hc-${view.color}`, sysIcon && 'has-img')}>
                                {sysIcon ? (
                                  <img src={sysIcon} alt="" draggable={false} />
                                ) : view.badge ? (
                                  <span
                                    className="home-entry-badge"
                                    style={view.brand ? { color: view.brand } : undefined}
                                    aria-hidden
                                  >
                                    {view.badge}
                                  </span>
                                ) : (
                                  <Icon size={18} strokeWidth={1.75} />
                                )}
                                {unlinked && (
                                  <span className="entry-unlinked-dot" title={tr('本机未关联')} aria-hidden>
                                    !
                                  </span>
                                )}
                              </span>
                              <span className="home-entry-text">
                                <span className="home-entry-title">{view.title}</span>
                                <span className="home-entry-sub">{unlinked ? tr('本机未关联') : tr(view.sub)}</span>
                              </span>
                              <button
                                className="home-entry-more"
                                title={tr('更多操作')}
                                onClick={(e) => openMenuAt(e, 'entry', entry.id)}
                              >
                                <MoreHorizontal size={14} />
                              </button>
                              {openingId === entry.id ? (
                                <span className="home-entry-opening" role="status" aria-live="polite">
                                  <Loader2 size={14} className="spin" />
                                  {tr('正在打开…')}
                                </span>
                              ) : null}
                            </div>
                          );
                        })}
                        <button className="home-entry-add" onClick={() => startAddEntry(group.id)}>
                          <Plus size={16} />
                          <span>{tr('添加')}</span>
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>

              {loaded && groupList.length === 0 && (
                <div className="home-empty">
                  <div className="home-empty-icon">
                    <GridGlyph />
                  </div>
                  <div className="home-empty-title">{tr('还没有快捷入口')}</div>
                  <div className="home-empty-sub">{tr('新建一个分组，把常用的笔记、日记或网址放进来。')}</div>
                  <button
                    className="btn btn-primary"
                    onClick={() => {
                      setEditingGroup(null);
                      setGroupDialogOpen(true);
                    }}
                  >
                    <FolderPlus size={14} /> {tr('新建分组')}
                  </button>
                </div>
              )}

              <button
                className="home-add-group"
                onClick={() => {
                  setEditingGroup(null);
                  setGroupDialogOpen(true);
                }}
              >
                <Plus size={15} />
                {tr('新建分组')}
              </button>
            </section>
          </div>

          <aside className="home-rail">
            <section className="home-rail-card home-week">
              <div className="home-rail-head">
                <h3>{tr('本周写作')}</h3>
                <span>{tr('{words} 字', { words: formatWords(writing.weekWords) })}</span>
              </div>
              <div className="home-week-bars">
                {writing.daily.map((day) => (
                  <div className="home-week-col" key={day.key} title={tr('{label} · {words} 字', { label: day.label, words: day.words })}>
                    <div className="home-week-bar-wrap">
                      <i
                        className={cn('home-week-bar', day.key === todayKey && 'today')}
                        style={{ height: `${Math.max(4, Math.round((day.words / maxWeekWords) * 100))}%` }}
                      />
                    </div>
                    <span>{day.label}</span>
                  </div>
                ))}
              </div>
              <div className="home-week-foot">
                <span>{tr('连续 {n} 天', { n: writing.streak })}</span>
                <span>{tr('共 {words} 字', { words: formatWords(writing.totalWords) })}</span>
              </div>
            </section>

            <section className="home-rail-card">
              <div className="home-rail-head">
                <h3>{tr('继续写')}</h3>
                <span className="home-rail-note">{tr('最近修改')}</span>
              </div>
              <div className="home-continue-list">
                {continueNotes.map((note) => (
                  <button
                    key={note.id}
                    className="home-continue-item"
                    onClick={() => {
                      select(note.id);
                      navigate({ type: 'notebook', value: note.notebook });
                    }}
                  >
                    <span className="home-continue-icon">
                      <BookOpen size={14} strokeWidth={1.8} />
                    </span>
                    <span className="home-continue-text">
                      <span className="home-continue-title">{note.title || tr('未命名笔记')}</span>
                      <span className="home-continue-sub">
                        {note.notebook || tr('根目录')} · {friendlyTime(note.updated)}
                      </span>
                    </span>
                  </button>
                ))}
                {!continueNotes.length && <div className="home-rail-empty">{tr('还没有笔记，先写第一篇吧。')}</div>}
              </div>
            </section>

            <section className="home-rail-card">
              <div className="home-rail-head">
                <h3>{tr('最近笔记')}</h3>
                <button className="home-rail-link" onClick={() => navigate({ type: 'smart', value: 'recent' })}>
                  {tr('最近 7 天')} <ArrowUpRight size={12} />
                </button>
              </div>
              <div className="home-recent-list">
                {recent.slice(3).map((note) => (
                  <button
                    key={note.id}
                    className="home-recent-item"
                    onClick={() => {
                      select(note.id);
                      navigate({ type: 'notebook', value: note.notebook });
                    }}
                  >
                    <span className="home-recent-dot" />
                    <span className="home-recent-title">{note.title || tr('未命名笔记')}</span>
                    <span className="home-recent-time">{friendlyTime(note.updated)}</span>
                  </button>
                ))}
                {recent.length <= 3 && <div className="home-rail-empty">{tr('最近更新会出现在这里。')}</div>}
              </div>
            </section>

            <section className="home-rail-card home-ai-promo">
              <div className="home-ai-glow" />
              <div className="home-ai-icon">
                <Sparkles size={18} strokeWidth={1.7} />
              </div>
              <div>
                <div className="home-ai-title">{tr('让 AI 做个小工具')}</div>
                <p className="home-ai-sub">{tr('计算器、JSON 格式化、番茄钟……描述一下，生成后直接从快捷入口打开。')}</p>
              </div>
              <button className="btn btn-secondary btn-sm home-ai-btn" onClick={() => useAppBuilder.getState().open()}>
                {tr('去生成')}
                <ArrowUpRight size={13} />
              </button>
              {apps.length > 0 && <div className="home-ai-count">{tr('已保存 {n} 个应用', { n: apps.length })}</div>}
            </section>
          </aside>
        </div>

        <footer className="home-foot">
          <button className="home-foot-link" onClick={() => navigate({ type: 'smart', value: 'calendar' })}>
            <CalendarDays size={13} /> {tr('打开日历')}
          </button>
          <span className="home-foot-sep" />
          <button className="home-foot-link" onClick={() => void openDaily()}>
            {tr('写今日日记')}
          </button>
          <span className="home-foot-sep" />
          <button className="home-foot-link" onClick={() => void load(true)}>
            <RefreshCw size={12} /> {tr('刷新首页')}
          </button>
        </footer>
      </div>

      <ShortcutDialog
        open={shortcutOpen}
        entry={editingEntry}
        defaultGroupId={defaultGroupId}
        groups={groupList}
        notes={notes}
        notebooks={notebookList}
        apps={apps}
        onClose={() => setShortcutOpen(false)}
        onCreateApp={() => {
          // 入口弹窗盖在生成器上面会挡视线，先收起；应用保存后会自动生成入口
          setShortcutOpen(false);
          setEditingEntry(null);
          useAppBuilder.getState().open();
        }}
        onOpenMarket={() => {
          // 同样先收起入口弹窗，市场里装好 / 加回入口后首页会自动出现
          setShortcutOpen(false);
          setEditingEntry(null);
          openMarket();
        }}
        onSave={saveEntry}
      />

      <HomeGroupDialog
        open={groupDialogOpen}
        group={editingGroup}
        onClose={() => setGroupDialogOpen(false)}
        onSave={saveGroup}
      />

      <HomeGroupDeleteDialog
        open={Boolean(deletingGroup)}
        group={deletingGroup}
        moveTarget={groupList.find((g) => g.id !== deletingGroup?.id)?.name}
        entryCount={deletingGroup?.entries.length || 0}
        onCancel={() => setDeletingGroup(null)}
        onMove={async () => {
          if (!deletingGroup) return;
          try {
            await deleteGroup(deletingGroup.id, 'move');
            toast(t('分组「{name}」已删除，入口已移到其他分组', { name: deletingGroup.name }), 'success');
            setDeletingGroup(null);
          } catch (e) {
            toast((e as Error).message || t('删除分组失败'), 'error');
          }
        }}
        onDelete={async () => {
          if (!deletingGroup) return;
          try {
            await deleteGroup(deletingGroup.id, 'delete');
            toast(t('分组「{name}」和其中的入口已删除', { name: deletingGroup.name }), 'success');
            setDeletingGroup(null);
          } catch (e) {
            toast((e as Error).message || t('删除分组失败'), 'error');
          }
        }}
      />

      <SystemAppMissingDialog
        entry={missingEntry}
        onClose={() => setMissingEntry(null)}
        onRecheck={() => systemStatus.refresh()}
        onPicked={async (entry, app) => {
          await updateEntry(entry.id, { target: app.path, title: entry.title || app.name });
          systemStatus.refresh();
          toast(t('已重新关联到「{name}」', { name: app.name }), 'success');
        }}
      />

      {importOpen && (
        <ImportAppDialog
          initialTab={importTab}
          onClose={() => setImportOpen(false)}
          onImported={(app) => {
            setImportOpen(false);
            useAppBuilder.getState().open({ incoming: app });
            toast(t('已导入「{name}」，先预览再保存', { name: app.name }), 'success');
          }}
          onOpenInstalled={(app) => {
            // 市场里的应用已经落库：关掉市场直接打开它，不再多走一遍生成器
            setImportOpen(false);
            openRunner(app.id);
            toast(t('已打开「{name}」', { name: app.name }), 'success');
          }}
        />
      )}

      <AppDataDialog app={appDataApp} onClose={() => setAppDataApp(null)} />

      <AppInfoDialog
        app={appInfoApp}
        onClose={() => setAppInfoApp(null)}
        onSave={async (patch) => {
          if (!appInfoApp) return;
          await updateAppInfo(appInfoApp.id, patch);
          toast('应用信息已更新', 'success');
        }}
      />

      {confirmApp && (
        <ConfirmDialog
          title={t('删除应用「{name}」？', { name: confirmApp.name })}
          desc={t('应用代码和它的历史版本都会从这台设备删除，并随同步从其他设备删除。入口会一起移除。')}
          confirmLabel={t('删除')}
          danger
          onCancel={() => setConfirmApp(null)}
          onConfirm={() => {
            const app = confirmApp;
            setConfirmApp(null);
            if (!app) return;
            // 应用没了，已经打开的独立窗口和主窗口里的运行器也一起关掉，不留下读不到代码的空界面
            void desktop()?.closeAppWindows?.(app.id);
            setRunners((list) => list.filter((item) => item.appId !== app.id));
            void deleteApp(app.id)
              .then(() => toast(t('已删除「{name}」', { name: app.name }), 'success'))
              .catch((e) => toast((e as Error).message || t('删除失败'), 'error'));
          }}
        />
      )}

      {runners.length ? (
        (() => {
          // 最小化的窗口只隐藏、不卸载，应用 iframe 里的临时状态不会丢
          const open = runners.filter((item) => !item.minimized).sort((a, b) => a.z - b.z);
          const order = new Map(open.map((item, index) => [item.key, index]));
          const topZ = open.length ? open[open.length - 1].z : 0;
          return (
            <div className={open.length ? 'app-runner-overlay' : 'app-runner-overlay is-empty'}>
              {runners.map((item) => {
                const index = order.get(item.key);
                return (
                  <AppRunner
                    key={item.key}
                    appId={item.appId}
                    minimized={item.minimized}
                    stack={index == null ? 0 : Math.min(index, 3)}
                    active={index != null && item.z === topZ}
                    zIndex={item.z}
                    onRaise={() => raiseRunner(item.key)}
                    onMinimize={() => minimizeRunner(item.key)}
                    onClose={() => closeRunner(item.key)}
                  />
                );
              })}
            </div>
          );
        })()
      ) : null}

      {runners.some((item) => item.minimized) ? (
        <div className="app-runner-dock" role="toolbar" aria-label={t('最小化的小应用')}>
          <span className="app-runner-dock-label">{t('小应用')}</span>
          {runners
            .filter((item) => item.minimized)
            .map((item) => {
              const app = apps.find((a) => a.id === item.appId);
              const DockIcon = iconFor(app?.icon, 'sparkles');
              return (
                <div className="app-runner-dock-chip" key={item.key}>
                  <button
                    className="app-runner-dock-main"
                    onClick={() => restoreRunner(item.key)}
                    title={t('恢复「{name}」', { name: app?.name || t('小应用') })}
                  >
                    <span className={app ? `app-runner-icon hc-${app.color}` : 'app-runner-icon hc-gray'}>
                      <DockIcon size={13} strokeWidth={1.9} />
                    </span>
                    <span className="app-runner-dock-name">{app?.name || t('小应用')}</span>
                  </button>
                  <button
                    className="app-runner-dock-close"
                    onClick={() => closeRunner(item.key)}
                    title={t('关闭')}
                    aria-label={t('关闭')}
                  >
                    <X size={12} />
                  </button>
                </div>
              );
            })}
        </div>
      ) : null}

      {menu && (
        <Menu
          x={menu.x}
          y={menu.y}
          items={
            menu.kind === 'entry'
              ? entries[menu.id]
                ? entryMenuItems(entries[menu.id])
                : []
              : groupList.find((g) => g.id === menu.id)
                ? groupMenuItems(groupList.find((g) => g.id === menu.id)!)
                : []
          }
          onClose={() => setMenu(null)}
        />
      )}

      {moveMenu && (
        <Menu
          x={moveMenu.x}
          y={moveMenu.y}
          items={(() => {
            const entry = entries[moveMenu.entryId];
            const from = entry ? groupOf(entry.id) : null;
            const targets = groupList.filter((g) => g.id !== from?.id);
            if (!targets.length) return [{ label: t('没有其他分组'), disabled: true, onClick: () => {} }];
            return targets.map((group) => ({
              label: t('移到「{name}」', { name: group.name }),
              icon: <FolderInput size={14} />,
              onClick: () => {
                if (entry) void doMoveEntry(entry.id, group.id, group.entries.length);
              },
            }));
          })()}
          onClose={() => setMoveMenu(null)}
        />
      )}
    </div>
  );
}

/** 空状态的小装饰：不额外引图标包，用现有 lucide 拼一个网格 */
function GridGlyph() {
  return (
    <span className="home-glyph" aria-hidden="true">
      <i />
      <i />
      <i />
      <i />
    </span>
  );
}
