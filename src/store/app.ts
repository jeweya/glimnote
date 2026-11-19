import { create } from 'zustand';
import { excerptOf, type Note } from '../lib/markdown';
import { bootstrap, isDesktop, writeNote } from '../lib/storage';
import { desktop } from '../lib/desktop';
import { isNoteWindow, noteWindowId } from '../lib/windowMode';
import { dateKey } from '../lib/utils';
import {
  applyTaskPatch,
  buildNextRepeatTask,
  newSeriesId,
  nextRepeatDate,
  normalizeStatus,
  shortDateWithWeekday,
  type OpenStatus,
  type Task,
  type TaskStatusFilter,
  type TaskTimeFilter,
} from '../lib/tasks';
import { cleanIdeaText, isIdeaOpen, type Idea } from '../lib/ideas';
import {
  cleanCategoryName,
  loadCategories,
  mergeCategories,
  nextCategoryColor,
  saveCategories,
  TASK_CATEGORY_ALL,
  type TaskCategory,
  type TaskCategoryFilter,
} from '../lib/taskCategories';
import * as repo from '../lib/repo';
import { removeAll as removeHistory, snapshot } from '../lib/history';
import { errorText, log } from '../lib/log';
import { hasPasswordLock } from '../lib/lock';
import { rebuild } from '../lib/search';
import {
  GitError,
  commitDueAt,
  compactHistory,
  errorDetail,
  isWorkflowScopeFailure,
  lastSyncCheckAt,
  loadCommitInterval,
  loadConfig,
  loadToken,
  normalizeConfig,
  resyncWithoutWorkflow,
  resetFromRemote,
  saveCommitInterval,
  saveConfig as persistConfig,
  saveToken,
  sync,
  type GitConfig,
} from '../lib/git';
import {
  disableLegacyCloudPush,
  readCloudPushConfig,
  refreshCloudPushDigest,
  saveCloudPushConfig,
} from '../lib/cloudPush';
import {
  canDropFolder,
  loadNotebookOrder,
  nameOf,
  orderAfterMove,
  orderAfterRemove,
  orderAfterRename,
  parentOf,
  saveNotebookOrder,
  type NotebookOrder,
} from '../lib/notebookOrder';
import { flushPrivacySync, syncPrivacyNow } from '../lib/privacySync';
import { usePrivacy } from './privacy';

export interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'success' | 'warn' | 'error';
  /** 前面显示转圈：用于「正在打开 / 正在加载」这类等待提示 */
  busy?: boolean;
  action?: { label: string; run: () => void };
  /** 第二个操作，例如删掉入口后的「去市场」；和 action 并列显示 */
  alt?: { label: string; run: () => void };
}

export type SyncState = 'local' | 'pending' | 'syncing' | 'synced' | 'error' | 'offline' | 'conflict';

/** 设置弹窗的页签；「仅本地」直接落到同步页，不用再找 */
export type SettingsTab = 'general' | 'security' | 'stats' | 'ai' | 'notify' | 'sync' | 'mcp' | 'keys' | 'about';

interface AppState {
  ready: boolean;
  notes: Note[];
  trash: Note[];
  current: Note | null;
  /** 独立任务库（docs/11 方案 C），按需加载 */
  tasks: Task[];
  tasksLoaded: boolean;
  tasksLoading: boolean;
  currentTaskId: string | null;
  taskTrash: Task[];
  taskTrashOpen: boolean;
  /** 独立灵感库（docs/14），按需加载 */
  ideas: Idea[];
  ideasLoaded: boolean;
  ideasLoading: boolean;
  /** 待办页的筛选：会话内视图状态，不写盘（docs/11 6.5） */
  taskTimeFilter: TaskTimeFilter;
  taskStatusFilter: TaskStatusFilter;
  /** 当前只看哪个分类；与侧栏的分类子项联动 */
  taskCategoryFilter: TaskCategoryFilter;
  /** 分类管理弹窗由 store 控制，侧栏与详情都能打开 */
  taskCategoryModalOpen: boolean;
  /** 待办分类（工作 / 家庭…）：顺序与颜色存本机，分类名随任务文件同步 */
  categories: TaskCategory[];
  notebooks: string[];
  /** 笔记本的手动顺序（父级路径 → 子名称）；只存本机，不影响笔记文件 */
  notebookOrder: NotebookOrder;
  view: { type: 'notebook' | 'smart' | 'trash'; value: string };
  query: string;
  /** 从全局搜索打开某篇笔记时的关键词：只用于正文高亮，不改列表过滤 */
  searchHit: { id: string; query: string } | null;
  theme: 'light' | 'paper' | 'dark' | 'system';
  focusMode: boolean;
  /** 专注模式里的打字机效果：光标所在行保持垂直居中 */
  typewriter: boolean;
  /** 编辑器左侧的目录面板 */
  tocOpen: boolean;
  sidebarOpen: boolean;
  paletteOpen: boolean;
  paletteMode: 'search' | 'switch';
  settingsOpen: boolean;
  settingsTab: SettingsTab;
  /** 密码锁是否挡在界面前面；只在内存里，不持久化（重开/刷新必然重新锁定） */
  locked: boolean;
  /** 打开「移动到…」对话框的笔记 id */
  moveNoteId: string | null;
  /** 正在拖拽的笔记 id，用于侧栏高亮可放置的笔记本 */
  draggingNote: string | null;
  /** 刚新建的笔记 id：编辑器挂载后自动聚焦一次，用完即清 */
  focusNoteId: string | null;
  toasts: Toast[];
  syncState: SyncState;
  syncAt?: string;
  syncMessage?: string;
  /** 定时拉取间隔（分钟），最小 1 分钟 */
  syncInterval: number;
  /** Git 自动提交间隔（分钟）；本地落盘仍然是 700ms */
  commitInterval: number;
  /** 远端历史被压缩过，本机需要重新下载 */
  needsReclone: boolean;
  /** 令牌没有 workflow 权限，云端推送的工作流文件挡住了笔记同步 */
  syncBlockedByWorkflow: boolean;
  cfg: GitConfig | null;
  login: string;
  token: string;
  /** 外部（MCP / 其他程序）改过磁盘后递增，用来强制编辑器重载当前笔记 */
  diskEpoch: number;

  init: () => Promise<void>;
  refresh: () => Promise<void>;
  /** 窗口重新获得焦点时读一次磁盘；有未落盘的编辑时跳过 */
  refreshFromDisk: () => Promise<void>;
  loadTasks: (force?: boolean) => Promise<void>;
  selectTask: (id: string | null) => void;
  createTask: (title: string, patch?: Partial<Task>) => Promise<Task | null>;
  patchTask: (id: string, patch: Partial<Task>, debounce?: boolean) => void;
  toggleTask: (id: string) => Promise<void>;
  skipTask: (id: string) => Promise<void>;
  endTaskRepeat: (id: string) => void;
  undoRepeatComplete: (taskId: string, nextId: string | null, skipped?: boolean) => Promise<void>;
  removeTask: (id: string) => Promise<void>;
  restoreTask: (id: string) => Promise<void>;
  purgeTask: (id: string) => Promise<void>;
  openTaskTrash: (open: boolean) => Promise<void>;
  emptyTaskTrash: () => Promise<void>;
  setTaskStatus: (id: string, status: OpenStatus) => void;
  setTaskTimeFilter: (filter: TaskTimeFilter) => void;
  setTaskStatusFilter: (filter: TaskStatusFilter) => void;
  setTaskCategoryFilter: (filter: TaskCategoryFilter) => void;
  openTaskCategoryModal: () => void;
  closeTaskCategoryModal: () => void;
  clearTaskFilters: () => void;
  /** 新建分类；重名或空名返回 false */
  addCategory: (name: string) => boolean;
  /** 改名会同步改写已使用旧分类的任务，返回 false 表示重名 */
  renameCategory: (from: string, to: string) => Promise<boolean>;
  /** 删除分类：其中的任务改成未分类，任务本身不删 */
  removeCategory: (name: string) => Promise<void>;
  loadIdeas: (force?: boolean) => Promise<void>;
  addIdea: (text: string) => Promise<Idea | null>;
  updateIdea: (id: string, text: string) => Promise<void>;
  removeIdeas: (ids: string[]) => Promise<void>;
  convertIdeasToNote: (ids: string[]) => Promise<void>;
  convertIdeasToTasks: (ids: string[]) => Promise<void>;
  /** 打开「已转化」那条灵感对应的笔记/待办 */
  openConverted: (id: string) => void;
  select: (id: string) => void;
  setView: (view: AppState['view']) => void;
  setQuery: (q: string) => void;
  setSearchHit: (hit: AppState['searchHit']) => void;
  create: (notebook?: string, title?: string) => Promise<Note>;
  updateContent: (id: string, content: string) => void;
  setTitle: (id: string, title: string) => Promise<void>;
  setTags: (id: string, tags: string[]) => void;
  togglePin: (id: string) => void;
  removeNote: (id: string) => Promise<void>;
  restore: (id: string) => Promise<void>;
  purge: (id: string) => Promise<void>;
  openDaily: (key?: string) => Promise<void>;
  openTrash: () => void;
  setTheme: (t: AppState['theme']) => void;
  toggleFocus: () => void;
  toggleTypewriter: () => void;
  toggleToc: () => void;
  toggleSidebar: () => void;
  setPalette: (open: boolean, mode?: 'search' | 'switch') => void;
  /** 打开设置时可以指定落到哪一页；不传就保留上次的页签 */
  setSettings: (open: boolean, tab?: SettingsTab) => void;
  /** 解锁（密码校验通过后由锁屏调用） */
  unlock: () => void;
  /** 立即锁定；没设置密码时什么也不做 */
  lockNow: () => void;
  setMoveNote: (id: string | null) => void;
  setDraggingNote: (id: string | null) => void;
  /** 编辑器已经按 focusNoteId 聚焦过，把请求清掉，避免以后重新挂载又抢焦点 */
  clearFocusNote: () => void;
  moveTo: (id: string, notebook: string) => Promise<void>;
  addNotebook: (name: string) => void;
  removeNotebook: (name: string) => void;
  renameNotebook: (path: string, name: string) => Promise<void>;
  /**
   * 拖动文件夹：targetParent 是目标父级（空字符串表示顶层），targetSiblings 是目标父级
   * 当前的兄弟名称（不含被拖动的那一个），index 是插入位置。
   */
  moveNotebook: (path: string, targetParent: string, targetSiblings: string[], index: number) => Promise<void>;
  deleteNotebook: (path: string) => Promise<void>;
  cycleTheme: () => void;
  toast: (
    text: string,
    kind?: Toast['kind'],
    action?: Toast['action'],
    alt?: Toast['alt'],
    holdMs?: number,
    busy?: boolean,
  ) => void;
  dismissToast: (id: number) => void;
  configureGit: (cfg: GitConfig, token: string, login: string) => void;
  disconnectGit: () => void;
  syncNow: (force?: boolean, allowLocked?: boolean) => Promise<void>;
  /** 关闭云端推送，移除工作流文件后以远端为基点重新提交，恢复笔记同步 */
  recoverSyncWithoutCloudPush: () => Promise<void>;
  markPending: () => void;
  setSyncInterval: (minutes: number) => void;
  setCommitInterval: (minutes: number) => void;
  /** 把当前内容压成新的历史起点，强制推送；其他设备需要重新下载 */
  compactRepo: () => Promise<{ oid: string; oldOid: string | null }>;
  /** 历史被压缩后，重新克隆远端并覆盖本地工作区（界面会先导出备份） */
  resetRepo: () => Promise<void>;
  /** 更换存储位置前把还没落盘的编辑立刻写掉，避免迁移时丢最后几个字 */
  flushPendingWrites: () => Promise<void>;
}

const writeTimers = new Map<string, number>();
const taskWriteTimers = new Map<string, number>();
/** 聚焦读盘的最小间隔，避免频繁切窗时反复扫描整个仓库 */
let lastDiskRefresh = 0;
const PENDING_KEY = 'glimnote.pending';
const INTERVAL_KEY = 'glimnote.syncInterval';
/** 定时拉取默认间隔（分钟）：一个人多在一台电脑上写，回到窗口时会立即检查，不必高频轮询 */
export const SYNC_INTERVAL_DEFAULT = 60;

/**
 * 自动同步的最小间隔。
 *
 * 每次「检查更新」都是一次完整的 fetch（Git 没有更便宜的探测接口），平台会按
 * 拉取次数统计。窗口反复获得焦点、一分钟定时器、待提交改动叠在一起时，5 分钟
 * 内只发一次请求就够；手动同步、退出前、云端推送前走 force，不受这个限制。
 */
const AUTO_SYNC_MIN_GAP = 5 * 60 * 1000;

/** 读取定时拉取间隔（分钟）；未设置、或旧版本存下的「仅手动 0」都回落到默认值 */
function loadSyncInterval() {
  const stored = localStorage.getItem(INTERVAL_KEY);
  if (stored === null) return SYNC_INTERVAL_DEFAULT;
  const raw = Number(stored);
  if (!Number.isFinite(raw) || raw <= 0) return SYNC_INTERVAL_DEFAULT;
  return raw <= 1440 ? Math.max(1, Math.round(raw)) : SYNC_INTERVAL_DEFAULT;
}

/** 同步失败后的退避重试：5s → 15s → 45s → 2min → 5min，成功后清零 */
const RETRY_DELAYS = [5000, 15000, 45000, 120000, 300000];
let retryTimer: number | null = null;
let retryAttempt = 0;

function clearRetry() {
  if (retryTimer) {
    window.clearTimeout(retryTimer);
    retryTimer = null;
  }
}

function scheduleWrite(note: Note) {
  const t = writeTimers.get(note.id);
  if (t) window.clearTimeout(t);
  const timer = window.setTimeout(async () => {
    await writeNote(note);
    void snapshot(note).catch(() => {});
    writeTimers.delete(note.id);
    localStorage.setItem(PENDING_KEY, '1');
  }, 700);
  writeTimers.set(note.id, timer);
}

function cancelScheduledWrite(id: string) {
  const t = writeTimers.get(id);
  if (t) {
    window.clearTimeout(t);
    writeTimers.delete(id);
  }
}

/** 任务的标题/备注停止输入 400ms 后落盘；勾选与字段修改走立即写入 */
function scheduleTaskWrite(get: () => AppState, id: string) {
  const t = taskWriteTimers.get(id);
  if (t) window.clearTimeout(t);
  const timer = window.setTimeout(async () => {
    taskWriteTimers.delete(id);
    const task = get().tasks.find((x) => x.id === id);
    if (!task) return;
    try {
      await repo.saveTask(task);
      localStorage.setItem(PENDING_KEY, '1');
    } catch (e) {
      console.warn('save task failed', e);
      get().toast('待办保存失败，改动可能只在本次运行中有效', 'error');
    }
  }, 400);
  taskWriteTimers.set(id, timer);
}

function cancelTaskWrite(id: string) {
  const t = taskWriteTimers.get(id);
  if (t) {
    window.clearTimeout(t);
    taskWriteTimers.delete(id);
  }
}

/** 正文里第一个一级标题的文字；用作新笔记的默认标题 */
function titleFromHeading(content: string) {
  const m = content.match(/^\s{0,3}#\s+(.+)$/m);
  if (!m) return '';
  // 标题里可能带着颜色 / 对齐的 span，取标题文字时只留看得见的部分
  const plain = m[1].replace(/<\/?[a-zA-Z][^>]*>/g, '').replace(/[*_`~]/g, '');
  return plain.replace(/\s+/g, ' ').trim().slice(0, 80);
}

/** 记住哪些标题是自动从正文里取的，用户手动改过之后就不再覆盖 */
const autoTitles = new Map<string, string>();

/** 主题的轮换顺序：浅色 → 暖白 → 深色 → 跟随系统 */
export const THEME_ORDER: AppState['theme'][] = ['paper', 'light', 'dark', 'system'];

function isTheme(v: unknown): v is AppState['theme'] {
  return typeof v === 'string' && (THEME_ORDER as string[]).includes(v);
}

/** 2026-10-30 起的主题版本：默认从旧「浅色」（米黄）改为现在的「浅色」（素白） */
const THEME_VERSION_KEY = 'glimnote.theme.v2';

function loadTheme(): AppState['theme'] {
  const saved = localStorage.getItem('glimnote.theme');
  if (!localStorage.getItem(THEME_VERSION_KEY)) {
    localStorage.setItem(THEME_VERSION_KEY, '1');
    // 老版本没记录过主动选择，light 其实就是默认值，统一迁到新的默认「浅色」；
    // 深色 / 跟随系统是用户明确选过的，保留。
    const next: AppState['theme'] = saved === 'dark' || saved === 'system' ? saved : 'paper';
    localStorage.setItem('glimnote.theme', next);
    return next;
  }
  return isTheme(saved) ? saved : 'paper';
}

function applyTheme(theme: AppState['theme']) {
  const dark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  // 「跟随系统」只决定深浅，落到 dark / light；paper 是独立的一套。
  const resolved = dark ? 'dark' : theme === 'paper' ? 'paper' : 'light';
  document.documentElement.dataset.theme = resolved;
  localStorage.setItem('glimnote.theme', theme);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    const color = resolved === 'dark' ? '#131210' : resolved === 'paper' ? '#fbfbf9' : '#f1eee7';
    meta.setAttribute('content', color);
  }
}

export const useApp = create<AppState>((set, get) => ({
  ready: false,
  notes: [],
  trash: [],
  current: null,
  tasks: [],
  tasksLoaded: false,
  tasksLoading: false,
  currentTaskId: null,
  taskTrash: [],
  taskTrashOpen: false,
  ideas: [],
  ideasLoaded: false,
  ideasLoading: false,
  taskTimeFilter: 'all',
  taskStatusFilter: 'all',
  taskCategoryFilter: TASK_CATEGORY_ALL,
  taskCategoryModalOpen: false,
  categories: loadCategories(),
  notebooks: [],
  notebookOrder: loadNotebookOrder(),
  view: { type: 'notebook', value: '工作' },
  query: '',
  searchHit: null,
  theme: loadTheme(),
  focusMode: false,
  typewriter: localStorage.getItem('glimnote.typewriter') === '1',
  tocOpen: localStorage.getItem('glimnote.toc') === '1',
  sidebarOpen: true,
  paletteOpen: false,
  paletteMode: 'search',
  settingsOpen: false,
  settingsTab: 'general',
  // 单篇窗口是从已解锁的主窗口点出来的，再要一次密码只会打断对比
  locked: hasPasswordLock() && !isNoteWindow,
  moveNoteId: null,
  draggingNote: null,
  focusNoteId: null,
  toasts: [],
  syncState: 'local',
  syncInterval: loadSyncInterval(),
  commitInterval: loadCommitInterval(),
  needsReclone: false,
  syncBlockedByWorkflow: false,
  cfg: loadConfig(),
  login: localStorage.getItem('glimnote.login') || '',
  token: loadToken(),
  diskEpoch: 0,

  async init() {
    await bootstrap();
    const bridge = desktop();
    // 同步配置以 userData 里的 JSON 为准：开发版（localhost）和安装版（file://）
    // 的 localStorage 是两个独立站点，只存浏览器里会让装完之后「配置丢失」
    if (bridge?.configGet) {
      const disk = await bridge.configGet().catch(() => null);
      const fromDisk = normalizeConfig(disk?.cfg);
      if (fromDisk) {
        persistConfig(fromDisk);
        if (disk?.login) localStorage.setItem('glimnote.login', disk.login);
        set({ cfg: fromDisk, login: disk?.login || get().login });
      } else if (disk) {
        // 文件里是「已断开」的墓碑：清掉本机缓存，不要拿旧配置又顶回去
        persistConfig(null);
        saveToken('');
        localStorage.removeItem('glimnote.login');
        set({ cfg: null, login: '', token: '' });
      } else if (get().cfg) {
        // 老版本只存在 localStorage：顺手迁进文件，下次换版本就不用重配
        void bridge.configSet?.({ cfg: get().cfg, login: get().login }).catch(() => {});
      }
    }
    // 桌面端令牌由主进程加密保存：重启后取回来，同步才不会悄悄停掉
    // （sessionStorage 只在本次运行有效，关掉应用就没了）
    const savedCfg = get().cfg;
    if (bridge?.credentialGet && savedCfg && !get().token) {
      const saved = await bridge.credentialGet(savedCfg.provider).catch(() => '');
      if (saved) {
        set({ token: saved });
        log('sync', 'info', '已取回本机保存的授权令牌');
      }
    }
    await repo.purgeExpiredTrash().catch(() => {});
    // 云端推送配置存在仓库文件里：先读进来，任务详情和设置页才能显示规则，
    // 第一次自动同步也能直接刷新摘要
    await readCloudPushConfig().catch(() => {});
    // 隐私锁与密码哈希也在仓库里：先合并进来，另一台设备锁上的笔记本同样受保护
    await syncPrivacyNow().catch(() => {});
    usePrivacy.getState().reloadFromStorage();
    const notes = await repo.loadNotes();
    const trash = await repo.loadTrash();
    rebuild(notes);
    // 单篇窗口按 URL 里的 note 打开；主窗口沿用上次打开的笔记
    const lastId = (isNoteWindow ? noteWindowId : '') || localStorage.getItem('glimnote.last');
    const current =
      notes.find((n) => n.id === lastId) ||
      notes.sort((a, b) => +new Date(b.updated) - +new Date(a.updated))[0] ||
      null;
    const storedNotebooks = JSON.parse(localStorage.getItem('glimnote.notebooks') || '[]') as string[];
    // 把磁盘上真实存在的文件夹也并进来：笔记删完后「日记」这类空文件夹还在，
    // 但本地记录里可能没有它，只看笔记会让它从侧栏消失。
    const diskNotebooks = await repo.loadNotebookDirs().catch(() => [] as string[]);
    const custom = [...new Set([...storedNotebooks, ...diskNotebooks])];
    if (custom.length !== storedNotebooks.length) {
      localStorage.setItem('glimnote.notebooks', JSON.stringify(custom));
    }
    const pendingLocal = Boolean(get().cfg && get().token) && localStorage.getItem(PENDING_KEY) === '1';
    // 默认先看首页；设置里关掉后沿用上次打开的笔记
    const startHome = localStorage.getItem('glimnote.startHome') !== '0';
    set({
      notes,
      trash,
      current,
      notebooks: custom,
      ready: true,
      syncState: pendingLocal ? 'pending' : 'local',
      view: startHome
        ? { type: 'smart', value: 'home' }
        : current
          ? { type: 'notebook', value: current.notebook }
          : { type: 'notebook', value: 'inbox' },
    });
    applyTheme(get().theme);
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme(get().theme));
    log(
      'app',
      'info',
      `启动 · ${isDesktop ? '桌面端文件系统' : '浏览器 OPFS'} · ${notes.length} 篇笔记 · ${trash.length} 篇在回收站`,
    );
    void repo.purgeExpiredTaskTrash().catch(() => {});
    // 后台预热任务库与灵感库：这样侧栏计数不会一直空着，失败也不影响任何功能
    window.setTimeout(() => {
      if (!get().tasksLoaded) void get().loadTasks();
      if (!get().ideasLoaded) void get().loadIdeas();
    }, 1200);
  },

  async refresh() {
    const notes = await repo.loadNotes();
    const trash = await repo.loadTrash();
    rebuild(notes);
    // 同步、删除之后重新对齐磁盘目录，空文件夹也留在侧栏
    const diskNotebooks = await repo.loadNotebookDirs().catch(() => [] as string[]);
    const notebooks = [...new Set([...get().notebooks, ...diskNotebooks])];
    const notebooksChanged = notebooks.length !== get().notebooks.length;
    if (notebooksChanged) localStorage.setItem('glimnote.notebooks', JSON.stringify(notebooks));
    const cur = get().current;
    const fresh = cur ? notes.find((n) => n.id === cur.id) : null;
    const fallback = fresh || (cur && get().view.type === 'trash' ? cur : notes[0] || null);
    set({ notes, trash, current: fallback, ...(notebooksChanged ? { notebooks } : {}) });
    // 同步后任务也可能被别的设备改过，已加载过的库跟着刷新
    if (get().tasksLoaded) {
      const tasks = await repo.loadTasks();
      const currentTask = get().currentTaskId;
      const merged = mergeCategories(
        get().categories,
        tasks.map((t) => t.category || ''),
      );
      if (merged !== get().categories) saveCategories(merged);
      set({
        tasks,
        categories: merged,
        currentTaskId: currentTask && tasks.some((t) => t.id === currentTask) ? currentTask : null,
      });
    }
    // 灵感也可能被别的设备改过（转化状态、删除），已加载过就一起刷新
    if (get().ideasLoaded) {
      const ideas = await repo.loadIdeas();
      set({ ideas });
    }
    // 拉取下来的仓库可能带着另一台设备的锁 / 密码：合并后再刷新界面状态
    await syncPrivacyNow().catch(() => {});
    usePrivacy.getState().reloadFromStorage();
    // 同步 / 外部改动之后，首页把 home/ 里的分组和入口重读一遍
    window.dispatchEvent(new Event('glimnote:repo-refreshed'));
  },

  async refreshFromDisk() {
    // 外部进程（MCP）只改文件，不会通知界面；窗口回到前台时补一次读盘。
    // 有未落盘的编辑或正在同步时跳过，避免把用户刚敲的内容盖掉。
    if (!isDesktop) return;
    if (writeTimers.size || taskWriteTimers.size) return;
    if (get().syncState === 'syncing') return;
    const now = Date.now();
    if (now - lastDiskRefresh < 1200) return;
    lastDiskRefresh = now;
    const before = get().current;
    try {
      await get().refresh();
    } catch (e) {
      console.warn('refresh from disk failed', e);
      return;
    }
    const after = get().current;
    // 当前笔记被外部改过：递增 epoch，让编辑器用新内容重建（光标会回到上次位置附近）
    if (
      before &&
      after &&
      before.id === after.id &&
      (before.content !== after.content || before.updated !== after.updated)
    ) {
      set({ diskEpoch: get().diskEpoch + 1 });
    }
  },

  async loadTasks(force = false) {
    if (get().tasksLoading) return;
    if (get().tasksLoaded && !force) return;
    set({ tasksLoading: true });
    try {
      const tasks = await repo.loadTasks();
      // 别的设备新建的分类名只存在任务文件里，加载时补进本机列表（顺序/颜色仍按本机）
      const merged = mergeCategories(
        get().categories,
        tasks.map((t) => t.category || ''),
      );
      if (merged !== get().categories) saveCategories(merged);
      set({ tasks, categories: merged, tasksLoaded: true, tasksLoading: false });
    } catch (e) {
      console.warn('load tasks failed', e);
      set({ tasksLoading: false, tasksLoaded: true });
      get().toast('任务库读取失败', 'error');
    }
  },

  selectTask(id) {
    set({ currentTaskId: id });
  },

  async createTask(title, patch = {}) {
    const clean = title.trim().slice(0, 200);
    if (!clean) return null;
    // 没设日期就是「待整理」；设了日期直接进「待办」——录入时只做一个决定
    const status = normalizeStatus(patch.status ?? (patch.due ? 'todo' : 'inbox'), patch.due);
    try {
      const task = await repo.createTask(clean, { ...patch, status });
      set({ tasks: [task, ...get().tasks], currentTaskId: task.id, tasksLoaded: true });
      get().markPending();
      return task;
    } catch (e) {
      console.warn('create task failed', e);
      get().toast('待办没保存成功，请检查磁盘空间或权限', 'error');
      return null;
    }
  },

  patchTask(id, patch, debounce = false) {
    const task = get().tasks.find((t) => t.id === id);
    if (!task) return;
    let effective = patch;
    if ('repeat' in patch) {
      if (patch.repeat) {
        // 循环任务必须有截止日与提醒时间：没有就补今天 / 09:00，避免规则悬空
        effective = {
          ...patch,
          due: patch.due ?? task.due ?? dateKey(),
          status: patch.status ?? (task.status === 'inbox' ? 'todo' : task.status),
          dueTime: patch.dueTime ?? task.dueTime ?? '09:00',
          seriesId: patch.seriesId ?? task.seriesId ?? newSeriesId(),
        };
      } else {
        // 关闭循环时把所有规则字段一起清掉，不留半套规则
        effective = {
          ...patch,
          repeat: undefined,
          repeatEvery: undefined,
          repeatDays: undefined,
          repeatDay: undefined,
          repeatMonth: undefined,
          repeatUntil: undefined,
          seriesId: undefined,
        };
      }
    }
    const { next: patched, notice } = applyTaskPatch(task, effective);
    const next: Task = { ...patched, updated: new Date().toISOString() };
    set({ tasks: get().tasks.map((t) => (t.id === id ? next : t)) });
    if (notice) get().toast(notice, 'info');
    get().markPending();
    if (debounce) {
      scheduleTaskWrite(get, id);
      return;
    }
    cancelTaskWrite(id);
    void repo.saveTask(next).catch((e) => {
      console.warn('save task failed', e);
      get().toast('待办保存失败，改动可能只在本次运行中有效', 'error');
    });
  },

  async toggleTask(id) {
    const task = get().tasks.find((t) => t.id === id);
    if (!task) return;
    const done = task.status !== 'done';
    const nowIso = new Date().toISOString();
    const next: Task = done
      ? {
          ...task,
          status: 'done',
          prevStatus: task.status === 'done' ? undefined : task.status,
          doneAt: nowIso,
          skippedAt: undefined,
          updated: nowIso,
        }
      : {
          ...task,
          // 取消完成回到完成前的状态；老文件没有 prevStatus 时按有没有日期兜底
          status: task.prevStatus ?? (task.due ? 'todo' : 'inbox'),
          prevStatus: undefined,
          doneAt: undefined,
          skippedAt: undefined,
          updated: nowIso,
        };
    set({ tasks: get().tasks.map((t) => (t.id === id ? next : t)) });
    get().markPending();
    cancelTaskWrite(id);
    try {
      await repo.saveTask(next);
    } catch (e) {
      console.warn('toggle task failed', e);
      get().toast('勾选没写进磁盘，界面状态可能只是暂时的', 'error');
      return;
    }
    if (!done || !task.repeat) return;

    // 循环任务：完成这次后立即生成下一次；逾期很久也只生成未来最近的一次
    const nextDue = nextRepeatDate(task);
    if (!nextDue) {
      get().toast('已完成；这个循环已经结束', 'success');
      return;
    }
    const generated = buildNextRepeatTask(task, nextDue);
    if (!get().tasks.some((t) => t.id === generated.id)) {
      try {
        await repo.writeTask(generated);
        set({ tasks: [generated, ...get().tasks] });
        get().markPending();
      } catch (e) {
        console.warn('create next repeat task failed', e);
        get().toast('下一次任务没写进磁盘，请稍后重试', 'error');
        return;
      }
    }
    get().toast(
      `已完成，下次：${shortDateWithWeekday(nextDue)}`,
      'success',
      {
        label: '撤销',
        run: () => {
          void get().undoRepeatComplete(id, generated.id);
        },
      },
      undefined,
      8000,
    );
  },

  /** 跳过本次：记一条已跳过，同时生成下一次；不写完成时间之外的历史 */
  async skipTask(id) {
    const task = get().tasks.find((t) => t.id === id);
    if (!task || !task.repeat || task.status === 'done') return;
    const nowIso = new Date().toISOString();
    const skipped: Task = {
      ...task,
      status: 'done',
      prevStatus: task.status,
      doneAt: nowIso,
      skippedAt: nowIso,
      updated: nowIso,
    };
    set({ tasks: get().tasks.map((t) => (t.id === id ? skipped : t)) });
    get().markPending();
    cancelTaskWrite(id);
    try {
      await repo.saveTask(skipped);
    } catch (e) {
      console.warn('skip task failed', e);
      get().toast('跳过没写进磁盘，界面状态可能只是暂时的', 'error');
      return;
    }

    const nextDue = nextRepeatDate(task);
    if (!nextDue) {
      get().toast('已跳过本次；这个循环已经结束', 'info');
      return;
    }
    const generated = buildNextRepeatTask(task, nextDue);
    if (!get().tasks.some((t) => t.id === generated.id)) {
      try {
        await repo.writeTask(generated);
        set({ tasks: [generated, ...get().tasks], currentTaskId: generated.id });
        get().markPending();
      } catch (e) {
        console.warn('create next repeat task failed', e);
        get().toast('下一次任务没写进磁盘，请稍后重试', 'error');
        return;
      }
    } else {
      set({ currentTaskId: generated.id });
    }
    get().toast(
      `已跳过本次，下次：${shortDateWithWeekday(nextDue)}`,
      'info',
      {
        label: '撤销',
        run: () => {
          void get().undoRepeatComplete(id, generated.id, true);
        },
      },
      undefined,
      8000,
    );
  },

  /** 结束循环：当前任务保留，只是以后不再生成 */
  endTaskRepeat(id) {
    const task = get().tasks.find((t) => t.id === id);
    if (!task || !task.repeat) return;
    get().patchTask(id, {
      repeat: undefined,
      repeatEvery: undefined,
      repeatDays: undefined,
      repeatDay: undefined,
      repeatMonth: undefined,
      repeatUntil: undefined,
      seriesId: undefined,
      remindBefore: undefined,
    });
    get().toast('已结束循环，这条待办保留', 'info');
  },

  /** 撤销「完成/跳过」：恢复这一次，并删掉刚生成的下一次 */
  async undoRepeatComplete(taskId, nextId, skipped = false) {
    const task = get().tasks.find((t) => t.id === taskId);
    if (!task) return;
    const generated = nextId ? get().tasks.find((t) => t.id === nextId) : null;
    const restored: Task = {
      ...task,
      status: task.prevStatus ?? (task.due ? 'todo' : 'inbox'),
      prevStatus: undefined,
      doneAt: undefined,
      skippedAt: undefined,
      updated: new Date().toISOString(),
    };
    set({
      tasks: get().tasks.map((t) => (t.id === taskId ? restored : t)),
      currentTaskId: taskId,
    });
    get().markPending();
    try {
      await repo.saveTask(restored);
    } catch (e) {
      console.warn('undo repeat complete failed', e);
      get().toast('撤销没写进磁盘，界面状态可能只是暂时的', 'error');
      return;
    }
    if (generated) {
      try {
        await repo.deleteTask(generated);
        set({ tasks: get().tasks.filter((t) => t.id !== generated.id) });
      } catch (e) {
        console.warn('remove generated repeat task failed', e);
      }
    }
    get().toast(skipped ? '已撤销跳过' : '已撤销完成', 'success');
  },

  async removeTask(id) {
    const task = get().tasks.find((t) => t.id === id);
    if (!task) return;
    cancelTaskWrite(id);
    try {
      const trashPath = await repo.deleteTask(task);
      const entry: Task = { ...task, deletedAt: task.deletedAt, path: trashPath };
      set({
        tasks: get().tasks.filter((t) => t.id !== id),
        currentTaskId: get().currentTaskId === id ? null : get().currentTaskId,
        taskTrash: [entry, ...get().taskTrash],
      });
      get().markPending();
      get().toast('已删除待办', 'info', {
        label: '撤销',
        run: () => {
          void (async () => {
            try {
              const restored = await repo.restoreTask(entry);
              set({
                tasks: [restored, ...get().tasks],
                taskTrash: get().taskTrash.filter((t) => t.id !== entry.id),
                currentTaskId: restored.id,
              });
              get().markPending();
            } catch {
              get().toast('撤销失败', 'error');
            }
          })();
        },
      });
    } catch (e) {
      console.warn('delete task failed', e);
      get().toast('删除失败', 'error');
    }
  },

  async restoreTask(id) {
    const task = get().taskTrash.find((t) => t.id === id);
    if (!task) return;
    try {
      const restored = await repo.restoreTask(task);
      set({
        tasks: [restored, ...get().tasks],
        taskTrash: get().taskTrash.filter((t) => t.id !== id),
        currentTaskId: restored.id,
      });
      get().markPending();
      get().toast('已恢复待办', 'success');
    } catch {
      get().toast('恢复失败', 'error');
    }
  },

  async purgeTask(id) {
    const task = get().taskTrash.find((t) => t.id === id);
    if (!task) return;
    try {
      await repo.purgeTask(task);
      set({ taskTrash: get().taskTrash.filter((t) => t.id !== id) });
      get().markPending();
      get().toast('已永久删除', 'info');
    } catch {
      get().toast('删除失败', 'error');
    }
  },

  async openTaskTrash(open) {
    set({ taskTrashOpen: open });
    if (!open) return;
    try {
      const taskTrash = await repo.loadTaskTrash();
      set({ taskTrash });
    } catch {
      get().toast('回收站读取失败', 'error');
    }
  },

  async emptyTaskTrash() {
    try {
      await repo.emptyTaskTrash();
      set({ taskTrash: [] });
      get().markPending();
      get().toast('任务回收站已清空', 'info');
    } catch {
      get().toast('清空失败', 'error');
    }
  },

  setTaskStatus(id, status) {
    get().patchTask(id, { status });
  },

  setTaskTimeFilter(filter) {
    // 再点一次已选中的时间 chip 等于回到「全部」
    set({ taskTimeFilter: get().taskTimeFilter === filter ? 'all' : filter });
  },

  setTaskStatusFilter(filter) {
    set({ taskStatusFilter: get().taskStatusFilter === filter ? 'all' : filter });
  },

  setTaskCategoryFilter(filter) {
    set({ taskCategoryFilter: filter });
  },

  openTaskCategoryModal() {
    set({ taskCategoryModalOpen: true });
  },

  closeTaskCategoryModal() {
    set({ taskCategoryModalOpen: false });
  },

  clearTaskFilters() {
    set({ taskTimeFilter: 'all', taskStatusFilter: 'all', taskCategoryFilter: TASK_CATEGORY_ALL });
  },

  addCategory(name) {
    const clean = cleanCategoryName(name);
    if (!clean) return false;
    const list = get().categories;
    if (list.some((c) => c.name === clean)) return false;
    const next = [...list, { name: clean, color: nextCategoryColor(list) }];
    saveCategories(next);
    set({ categories: next });
    return true;
  },

  async renameCategory(from, to) {
    const clean = cleanCategoryName(to);
    if (!clean) return false;
    if (clean === from) return true;
    const list = get().categories;
    if (list.some((c) => c.name === clean)) return false;
    const next = list.map((c) => (c.name === from ? { ...c, name: clean } : c));
    saveCategories(next);
    const filter = get().taskCategoryFilter;
    set({
      categories: next,
      taskCategoryFilter: filter.kind === 'cat' && filter.name === from ? { kind: 'cat', name: clean } : filter,
    });
    // 任务文件里存的是分类名，改名必须把用到的任务一起改写，否则它们会「掉回未分类」
    const now = new Date().toISOString();
    const affected = get()
      .tasks.filter((t) => t.category === from)
      .map((t) => ({ ...t, category: clean, updated: now }));
    if (!affected.length) return true;
    const byId = new Map(affected.map((t) => [t.id, t]));
    set({ tasks: get().tasks.map((t) => byId.get(t.id) || t) });
    get().markPending();
    for (const task of affected) {
      try {
        await repo.saveTask(task);
      } catch (e) {
        console.warn('rename category task failed', e);
        get().toast('部分任务没能写入磁盘，分类改名可能只在本次运行中有效', 'error');
        break;
      }
    }
    return true;
  },

  async removeCategory(name) {
    const next = get().categories.filter((c) => c.name !== name);
    saveCategories(next);
    const filter = get().taskCategoryFilter;
    set({
      categories: next,
      taskCategoryFilter: filter.kind === 'cat' && filter.name === name ? TASK_CATEGORY_ALL : filter,
    });
    // 只摘掉分类标签，任务本身保留，落回「未分类」
    const now = new Date().toISOString();
    const affected = get()
      .tasks.filter((t) => t.category === name)
      .map((t) => ({ ...t, category: undefined, updated: now }));
    if (!affected.length) return;
    const byId = new Map(affected.map((t) => [t.id, t]));
    set({ tasks: get().tasks.map((t) => byId.get(t.id) || t) });
    get().markPending();
    for (const task of affected) {
      try {
        await repo.saveTask(task);
      } catch (e) {
        console.warn('remove category task failed', e);
        get().toast('部分任务没能写入磁盘，分类可能还会回来', 'error');
        break;
      }
    }
  },

  async loadIdeas(force = false) {
    if (get().ideasLoading) return;
    if (get().ideasLoaded && !force) return;
    set({ ideasLoading: true });
    try {
      const ideas = await repo.loadIdeas();
      set({ ideas, ideasLoaded: true, ideasLoading: false });
    } catch (e) {
      console.warn('load ideas failed', e);
      set({ ideasLoading: false, ideasLoaded: true });
      get().toast('灵感库读取失败', 'error');
    }
  },

  async addIdea(text) {
    const clean = cleanIdeaText(text);
    if (!clean) return null;
    try {
      const idea = await repo.createIdea(clean);
      set({ ideas: [idea, ...get().ideas], ideasLoaded: true });
      get().markPending();
      return idea;
    } catch (e) {
      console.warn('create idea failed', e);
      get().toast('灵感没保存成功，请检查磁盘空间或权限', 'error');
      return null;
    }
  },

  async updateIdea(id, text) {
    const idea = get().ideas.find((i) => i.id === id);
    if (!idea) return;
    const clean = cleanIdeaText(text);
    // 清空等于取消编辑：想删就用删除按钮，避免误触把整条抹掉
    if (!clean || clean === idea.text) return;
    const next: Idea = { ...idea, text: clean, updated: new Date().toISOString() };
    set({ ideas: get().ideas.map((i) => (i.id === id ? next : i)) });
    get().markPending();
    try {
      await repo.saveIdea(next);
    } catch (e) {
      console.warn('save idea failed', e);
      get().toast('灵感保存失败，改动可能只在本次运行中有效', 'error');
    }
  },

  async removeIdeas(ids) {
    const targets = get().ideas.filter((i) => ids.includes(i.id));
    if (!targets.length) return;
    const stash = targets.map((i) => ({ ...i }));
    for (const idea of targets) await repo.deleteIdea(idea).catch(() => {});
    // 以磁盘为准：个别文件删不掉时不会在界面上「假消失」
    try {
      set({ ideas: await repo.loadIdeas() });
    } catch {
      set({ ideas: get().ideas.filter((i) => !ids.includes(i.id)) });
    }
    get().markPending();
    get().toast(targets.length === 1 ? '已删除这条灵感' : `已删除 ${targets.length} 条灵感`, 'info', {
      label: '撤销',
      run: () => {
        void (async () => {
          try {
            for (const idea of stash) await repo.restoreIdea(idea);
            const ideas = await repo.loadIdeas();
            set({ ideas });
            get().markPending();
            get().toast('已恢复', 'success');
          } catch {
            get().toast('撤销失败', 'error');
          }
        })();
      },
    });
  },

  async convertIdeasToNote(ids) {
    const list = get()
      .ideas.filter((i) => ids.includes(i.id) && isIdeaOpen(i))
      .sort((a, b) => +new Date(a.created) - +new Date(b.created));
    if (!list.length) return;
    try {
      const note = await repo.noteFromIdeas(list);
      const at = new Date().toISOString();
      const converted: Idea[] = list.map((i) => ({
        ...i,
        convertedType: 'note',
        convertedId: note.id,
        convertedTitle: note.title,
        convertedAt: at,
        updated: at,
      }));
      for (const idea of converted) await repo.saveIdea(idea);
      const byId = new Map(converted.map((i) => [i.id, i]));
      const notes = [note, ...get().notes];
      rebuild(notes);
      set({ ideas: get().ideas.map((i) => byId.get(i.id) || i), notes });
      get().markPending();
      get().toast(
        list.length === 1 ? `已整理为笔记「${note.title}」` : `已把 ${list.length} 条灵感合并成「${note.title}」`,
        'success',
        {
          label: '打开笔记',
          run: () => {
            get().select(note.id);
            set({ view: { type: 'notebook', value: note.notebook }, query: '' });
          },
        },
      );
    } catch (e) {
      console.warn('convert ideas to note failed', e);
      get().toast('整理成笔记失败，请检查磁盘空间或权限', 'error');
    }
  },

  async convertIdeasToTasks(ids) {
    const list = get()
      .ideas.filter((i) => ids.includes(i.id) && isIdeaOpen(i))
      .sort((a, b) => +new Date(a.created) - +new Date(b.created));
    if (!list.length) return;
    try {
      const tasks = await repo.tasksFromIdeas(list);
      const at = new Date().toISOString();
      const converted: Idea[] = list.map((i, idx) => ({
        ...i,
        convertedType: 'task',
        convertedId: tasks[idx]?.id,
        convertedTitle: tasks[idx]?.title,
        convertedAt: at,
        updated: at,
      }));
      for (const idea of converted) await repo.saveIdea(idea);
      const byId = new Map(converted.map((i) => [i.id, i]));
      set({
        ideas: get().ideas.map((i) => byId.get(i.id) || i),
        tasks: [...tasks, ...get().tasks],
        tasksLoaded: true,
      });
      get().markPending();
      get().toast(
        tasks.length === 1 ? `已整理为待办「${tasks[0].title}」` : `已拆成 ${tasks.length} 条待办，都在「待整理」`,
        'success',
        {
          label: '查看待办',
          run: () => {
            get().setView({ type: 'smart', value: 'todo' });
            if (tasks[0]) get().selectTask(tasks[0].id);
          },
        },
      );
    } catch (e) {
      console.warn('convert ideas to tasks failed', e);
      get().toast('整理成待办失败，请检查磁盘空间或权限', 'error');
    }
  },

  openConverted(id) {
    const idea = get().ideas.find((i) => i.id === id);
    if (!idea?.convertedType) return;
    if (idea.convertedType === 'note') {
      const note =
        get().notes.find((n) => n.id === idea.convertedId) || get().notes.find((n) => n.title === idea.convertedTitle);
      if (!note) {
        get().toast('对应的笔记已不在库里（可能被删除了）', 'info');
        return;
      }
      get().select(note.id);
      set({ view: { type: 'notebook', value: note.notebook }, query: '' });
      return;
    }
    const openTask = () => {
      const task = get().tasks.find((t) => t.id === idea.convertedId);
      set({ view: { type: 'smart', value: 'todo' }, query: '' });
      if (task) get().selectTask(task.id);
      else get().toast('对应的待办已不在库里（可能被删除了）', 'info');
    };
    if (get().tasksLoaded) openTask();
    else void get().loadTasks().then(openTask);
  },

  select(id) {
    const note = get().notes.find((n) => n.id === id) || get().trash.find((n) => n.id === id) || null;
    if (!note) return;
    // 单篇窗口只是开着看的一扇窗，不该改掉主窗口下次启动时打开的笔记
    if (!isNoteWindow) localStorage.setItem('glimnote.last', id);
    // 换到别的笔记就不再带着上一次全局搜索的高亮；目标就是搜索命中的那篇时保留
    const keepHit = get().searchHit?.id === id;
    set({ current: note, focusNoteId: null, ...(keepHit ? {} : { searchHit: null }) });
  },

  setView(view) {
    set({ view });
    if (view.type === 'smart' && view.value === 'todo') void get().loadTasks();
    if (view.type === 'smart' && view.value === 'ideas') void get().loadIdeas();
  },

  setQuery(q) {
    // 用户自己开始搜了，就以左侧搜索框为准，别让上一次全局搜索的高亮串进来
    set(q.trim() ? { query: q, searchHit: null } : { query: q });
  },

  setSearchHit(hit) {
    set({ searchHit: hit });
  },

  async create(notebook, title) {
    const nb = notebook ?? (get().view.type === 'notebook' ? get().view.value : 'inbox');
    const note = await repo.createNote(nb, title);
    const notes = [note, ...get().notes];
    rebuild(notes);
    // focusNoteId 让刚挂载的编辑器自己聚焦：新建完就能直接敲字，不用先点第一行
    set({ notes, current: note, view: { type: 'notebook', value: nb }, focusNoteId: note.id });
    if (!isNoteWindow) localStorage.setItem('glimnote.last', note.id);
    get().markPending();
    return note;
  },

  updateContent(id, content) {
    const notes = get().notes.map((n) => {
      if (n.id !== id) return n;
      // 新笔记还没起名字时，用正文的第一个一级标题当标题，列表里就不用满屏「未命名笔记」
      const auto = autoTitles.get(id);
      const untitled = !n.title || n.title === '未命名笔记' || (auto !== undefined && n.title === auto);
      const derived = untitled ? titleFromHeading(content) : '';
      if (derived) autoTitles.set(id, derived);
      return {
        ...n,
        title: derived || n.title,
        content,
        updated: new Date().toISOString(),
        excerpt: excerptOf(content),
      };
    });
    const current = get().current?.id === id ? notes.find((n) => n.id === id)! : get().current;
    set({ notes, current });
    const note = notes.find((n) => n.id === id);
    if (note) scheduleWrite(note);
    get().markPending();
  },

  async setTitle(id, title) {
    const note = get().notes.find((n) => n.id === id);
    if (!note) return;
    autoTitles.delete(id);
    const oldPath = note.path;
    const updated = { ...note, title, updated: new Date().toISOString() };
    await writeNote(updated);
    const newPath = await repo.renameNoteFile(updated, oldPath);
    const notes = get().notes.map((n) => (n.id === id ? { ...updated, path: newPath } : n));
    rebuild(notes);
    set({ notes, current: get().current?.id === id ? { ...updated, path: newPath } : get().current });
    get().markPending();
  },

  setTags(id, tags) {
    const notes = get().notes.map((n) => (n.id === id ? { ...n, tags, updated: new Date().toISOString() } : n));
    const note = notes.find((n) => n.id === id);
    if (note) scheduleWrite(note);
    set({ notes, current: get().current?.id === id ? note! : get().current });
    get().markPending();
  },

  togglePin(id) {
    const notes = get().notes.map((n) => (n.id === id ? { ...n, pinned: !n.pinned } : n));
    const note = notes.find((n) => n.id === id);
    if (note) scheduleWrite(note);
    set({ notes, current: get().current?.id === id ? note! : get().current });
    get().markPending();
  },

  async removeNote(id) {
    const note = get().notes.find((n) => n.id === id);
    if (!note) return;
    cancelScheduledWrite(id);
    const snapshot = { ...note };
    const trashPath = await repo.deleteNote(note);
    const entry: Note = { ...snapshot, deletedAt: note.deletedAt, path: trashPath };
    const notes = get().notes.filter((n) => n.id !== id);
    const trash = [entry, ...get().trash];
    // 删掉的是这个文件夹的最后一条笔记时，文件夹本身还在磁盘上，
    // 要把它留在笔记本列表里，否则侧栏会立刻把它当成不存在。
    const notebook = note.notebook || '';
    const notebooks =
      notebook && !get().notebooks.includes(notebook)
        ? [...get().notebooks, notebook]
        : get().notebooks;
    if (notebooks !== get().notebooks) {
      localStorage.setItem('glimnote.notebooks', JSON.stringify(notebooks));
    }
    rebuild(notes);
    set({ notes, trash, notebooks, current: notes[0] || null });
    get().markPending();
    get().toast('已移到回收站', 'info', {
      label: '撤销',
      run: async () => {
        if (!get().trash.some((n) => n.id === entry.id)) return;
        const restored = await repo.restoreNote(entry);
        await get().refresh();
        get().select(restored.id);
        set({ view: { type: 'notebook', value: restored.notebook } });
      },
    });
  },

  async restore(id) {
    const note = get().trash.find((n) => n.id === id);
    if (!note) return;
    const restored = await repo.restoreNote(note);
    await get().refresh();
    if (get().current?.id === id && get().view.type === 'trash') set({ current: null });
    get().toast(`已恢复到「${restored.notebook || '根目录'}」`, 'success', {
      label: '查看',
      run: () => {
        get().select(restored.id);
        set({ view: { type: 'notebook', value: restored.notebook } });
      },
    });
  },

  async purge(id) {
    const note = get().trash.find((n) => n.id === id);
    if (!note) return;
    await repo.purgeNote(note);
    await removeHistory(note.id).catch(() => {});
    set({ trash: get().trash.filter((n) => n.id !== id) });
    get().toast('已永久删除', 'info');
  },

  async openDaily(key) {
    const day = key || dateKey();
    const existed = get().notes.some((n) => n.notebook === '日记' && n.title === day);
    const note = await repo.ensureDailyNote(day);
    await get().refresh();
    const fresh = get().notes.find((n) => n.id === note.id) || note;
    // 在日历里打开某一天的日记时留在日历，写完还能看到这一天的其他记录
    const view = get().view;
    const stay =
      view.type === 'smart' && view.value === 'calendar' ? view : { type: 'notebook' as const, value: '日记' };
    // 今天还没写过日记时，建好直接聚焦到标题下面，接着写就行
    // 注意要落到 stay：从待办等页面点「今日日记」时，得真的切回日记视图
    set({ current: fresh, view: stay, ...(existed ? {} : { focusNoteId: fresh.id }) });
    if (!isNoteWindow) localStorage.setItem('glimnote.last', fresh.id);
    if (!get().notes.find((n) => n.id === note.id)) set({ notes: [note, ...get().notes] });
  },

  openTrash() {
    set({ view: { type: 'trash', value: 'trash' }, current: null });
  },

  setTheme(theme) {
    applyTheme(theme);
    set({ theme });
  },

  toggleFocus() {
    set({ focusMode: !get().focusMode });
  },

  toggleTypewriter() {
    const typewriter = !get().typewriter;
    localStorage.setItem('glimnote.typewriter', typewriter ? '1' : '0');
    set({ typewriter });
    get().toast(
      typewriter
        ? get().focusMode
          ? '打字机模式已开启 · 光标保持居中'
          : '打字机模式已开启 · 进入专注模式后生效'
        : '打字机模式已关闭',
      'info',
    );
  },

  toggleToc() {
    const tocOpen = !get().tocOpen;
    localStorage.setItem('glimnote.toc', tocOpen ? '1' : '0');
    set({ tocOpen });
  },

  toggleSidebar() {
    set({ sidebarOpen: !get().sidebarOpen });
  },

  setPalette(open, mode = 'search') {
    set({ paletteOpen: open, paletteMode: mode });
  },

  setSettings(open, tab) {
    set(tab ? { settingsOpen: open, settingsTab: tab } : { settingsOpen: open });
  },

  unlock() {
    set({ locked: false });
  },

  lockNow() {
    // 应用锁一落、或窗口被收进托盘，隐私锁本次会话的解锁状态都一起作废
    usePrivacy.getState().relockAll();
    if (!hasPasswordLock()) return;
    // 锁上时顺手收起设置、浮层和桌面卡片，别把令牌、笔记内容留在解锁后的第一屏
    void desktop()?.hideCard?.();
    set({ locked: true, settingsOpen: false, paletteOpen: false, moveNoteId: null });
  },

  setMoveNote(id) {
    set({ moveNoteId: id });
  },

  setDraggingNote(id) {
    set({ draggingNote: id });
  },

  clearFocusNote() {
    if (get().focusNoteId) set({ focusNoteId: null });
  },

  async moveTo(id, notebook) {
    const note = get().notes.find((n) => n.id === id);
    if (!note) return;
    const target = notebook.trim();
    if ((note.notebook || '') === target) {
      get().toast('已经在这个笔记本里了', 'info');
      set({ moveNoteId: null });
      return;
    }
    cancelScheduledWrite(id);
    const wasCurrent = get().current?.id === id;
    const source = note.notebook || '';
    const moved = await repo.moveNote(note, target);
    const notes = get().notes.map((n) => (n.id === id ? moved : n));
    // 移走的可能是来源文件夹的最后一条笔记：空目录还在，别让它从侧栏消失
    const notebooks =
      source && !get().notebooks.includes(source)
        ? [...get().notebooks, source]
        : get().notebooks;
    if (notebooks !== get().notebooks) {
      localStorage.setItem('glimnote.notebooks', JSON.stringify(notebooks));
    }
    rebuild(notes);
    const view = get().view;
    // 移动当前笔记时跟随它切到目标笔记本，避免编辑器突然跳到另一篇
    const nextView =
      wasCurrent && view.type === 'notebook' && view.value !== target
        ? { type: 'notebook' as const, value: target }
        : view;
    set({
      notes,
      notebooks,
      current: wasCurrent ? moved : get().current,
      view: nextView,
      moveNoteId: null,
      draggingNote: null,
    });
    get().markPending();
    get().toast(`已移到「${target || '全部笔记'}」`, 'success', {
      label: '查看',
      run: () => {
        get().select(moved.id);
        set({ view: { type: 'notebook', value: target } });
      },
    });
  },

  addNotebook(name) {
    // 允许「父/子/孙」这样的层级路径：逐段清洗，只保留段与段之间的斜杠
    const clean = name
      .split('/')
      .map((seg) => seg.trim().replace(/[\\:*?"<>|]/g, '-'))
      .filter(Boolean)
      .join('/');
    if (!clean) return;
    const notebooks = [...new Set([...get().notebooks, clean])];
    localStorage.setItem('glimnote.notebooks', JSON.stringify(notebooks));
    set({ notebooks, view: { type: 'notebook', value: clean } });
  },

  removeNotebook(name) {
    const notebooks = get().notebooks.filter((n) => n !== name);
    localStorage.setItem('glimnote.notebooks', JSON.stringify(notebooks));
    set({ notebooks });
  },

  async renameNotebook(path, name) {
    const clean = name
      .trim()
      .replace(/[\\/:*?"<>|]/g, '-')
      .slice(0, 40);
    if (!clean) return;
    const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    const next = parent ? `${parent}/${clean}` : clean;
    if (next === path) return;
    // 文件夹里可能有还没落盘的编辑：先取消旧路径的定时写入，
    // 由下面的移动把状态里的最新内容写进新路径，避免旧文件被重新写回来
    for (const n of get().notes) {
      if (n.notebook === path || n.notebook.startsWith(`${path}/`)) cancelScheduledWrite(n.id);
    }
    await repo.renameNotebook(path, next, get().notes);
    usePrivacy.getState().renameFolderLock(path, next);
    const notebooks = get().notebooks.map((n) =>
      n === path || n.startsWith(`${path}/`) ? next + n.slice(path.length) : n,
    );
    localStorage.setItem('glimnote.notebooks', JSON.stringify(notebooks));
    const view = get().view;
    const nextView =
      view.type === 'notebook' && (view.value === path || view.value.startsWith(`${path}/`))
        ? { ...view, value: next + view.value.slice(path.length) }
        : view;
    // 改名后手动顺序也要跟着换名字，否则这一级会退回按名称排
    const order = orderAfterRename(get().notebookOrder, path, next);
    saveNotebookOrder(order);
    set({ notebooks, view: nextView, notebookOrder: order });
    await get().refresh();
    get().markPending();
    get().toast(`已重命名为「${clean}」`, 'success');
  },

  async moveNotebook(path, targetParent, targetSiblings, index) {
    const name = nameOf(path);
    const parent = parentOf(path);
    const target = targetParent.replace(/^\/+|\/+$/g, '');
    if (!name) return;
    if (!canDropFolder(path, target)) {
      get().toast('不能把文件夹移到它自己或它的子文件夹里', 'error');
      return;
    }

    // 同级拖动只是排序：只改本机顺序，不动任何笔记文件
    if (target === parent) {
      const siblings = targetSiblings.filter((n) => n !== name);
      const at = Math.max(0, Math.min(index, siblings.length));
      siblings.splice(at, 0, name);
      if (JSON.stringify(siblings) === JSON.stringify(get().notebookOrder[parent] || [])) return;
      const order = { ...get().notebookOrder, [parent]: siblings };
      saveNotebookOrder(order);
      set({ notebookOrder: order });
      return;
    }

    // 目标里已经有同名文件夹时自动加 (2)，不覆盖原来的
    let finalName = name;
    const taken = new Set(targetSiblings);
    let i = 2;
    while (taken.has(finalName)) {
      finalName = `${name} (${i})`;
      i += 1;
    }
    const next = target ? `${target}/${finalName}` : finalName;
    // 同改名：先取消旧路径的定时写入，移动时会把最新内容写到新路径
    for (const n of get().notes) {
      if (n.notebook === path || n.notebook.startsWith(`${path}/`)) cancelScheduledWrite(n.id);
    }
    await repo.renameNotebook(path, next, get().notes);
    usePrivacy.getState().renameFolderLock(path, next);

    const notebooks = get().notebooks.map((n) =>
      n === path || n.startsWith(`${path}/`) ? next + n.slice(path.length) : n,
    );
    localStorage.setItem('glimnote.notebooks', JSON.stringify(notebooks));

    const order = orderAfterMove(get().notebookOrder, path, next, target, targetSiblings, index, finalName);
    saveNotebookOrder(order);

    const view = get().view;
    const nextView =
      view.type === 'notebook' && (view.value === path || view.value.startsWith(`${path}/`))
        ? { ...view, value: next + view.value.slice(path.length) }
        : view;
    set({ notebooks, view: nextView, notebookOrder: order });
    await get().refresh();
    get().markPending();
    get().toast(`已移到「${target || '全部笔记'}」`, 'success');
  },

  async deleteNotebook(path) {
    const affected = get().notes.filter((n) => n.notebook === path || n.notebook.startsWith(`${path}/`));
    for (const n of affected) {
      cancelScheduledWrite(n.id);
      await repo.deleteNote(n);
    }
    // 同时清掉磁盘上的空目录，否则 refresh 时目录扫描会把它重新加回侧栏
    await repo.removeNotebookDir(path).catch(() => {});
    const notebooks = get().notebooks.filter((n) => n !== path && !n.startsWith(`${path}/`));
    localStorage.setItem('glimnote.notebooks', JSON.stringify(notebooks));
    const order = orderAfterRemove(get().notebookOrder, path);
    saveNotebookOrder(order);
    const view = get().view;
    const nextView =
      view.type === 'notebook' && (view.value === path || view.value.startsWith(`${path}/`))
        ? { type: 'notebook' as const, value: 'inbox' }
        : view;
    set({ notebooks, view: nextView, notebookOrder: order });
    await get().refresh();
    get().markPending();
    get().toast(
      affected.length ? `已把 ${affected.length} 篇笔记移到回收站` : '已删除这个笔记本',
      'info',
      affected.length ? { label: '查看回收站', run: () => get().openTrash() } : undefined,
    );
  },

  cycleTheme() {
    const next = THEME_ORDER[(THEME_ORDER.indexOf(get().theme) + 1) % THEME_ORDER.length];
    get().setTheme(next);
  },

  toast(text, kind = 'info', action, alt, holdMs, busy) {
    const id = Date.now() + Math.random();
    set({ toasts: [...get().toasts, { id, text, kind, action, alt, busy }].slice(-3) });
    // 错误提示也自动消失（停留久一点），否则内容较长时容易一直挂在右下角
    window.setTimeout(() => get().dismissToast(id), holdMs ?? (action || alt ? 5000 : kind === 'error' ? 10000 : 2600));
  },

  dismissToast(id) {
    set({ toasts: get().toasts.filter((t) => t.id !== id) });
  },

  configureGit(cfg, token, login) {
    persistConfig(cfg);
    saveToken(token);
    localStorage.setItem('glimnote.login', login);
    // 桌面端再存一份密文：下次启动自动取回，不用重新粘贴令牌
    const bridge = desktop();
    if (bridge?.credentialSet) {
      void bridge
        .credentialSet(cfg.provider, token)
        .then((ok) => {
          if (!ok) log('sync', 'warn', '令牌没能保存到本机（系统密钥不可用），下次启动需要重新填写');
        })
        .catch(() => log('sync', 'warn', '令牌没能保存到本机，下次启动需要重新填写'));
    }
    // 配置另存到 userData：换开发版/安装版、重装之后照样能直接同步
    if (bridge?.configSet) {
      void bridge
        .configSet({ cfg, login })
        .then((ok) => {
          if (!ok) log('sync', 'warn', '同步配置没能写入本机文件，下次启动可能需要重新配置');
        })
        .catch(() => log('sync', 'warn', '同步配置没能写入本机文件，下次启动可能需要重新配置'));
    }
    retryAttempt = 0;
    clearRetry();
    log('sync', 'info', `已配置仓库 · ${cfg.provider} · 分支 ${cfg.branch}`);
    // 重新保存令牌后可能已经补上了 workflow 权限，清掉旧的阻断提示
    set({ cfg, token, login, syncState: 'pending', syncBlockedByWorkflow: false });
  },

  disconnectGit() {
    const provider = get().cfg?.provider;
    persistConfig(null);
    saveToken('');
    localStorage.removeItem('glimnote.login');
    // 断开就是真的断开：本机保存的密文也一起清掉，换账号时不残留
    const bridge = desktop();
    if (bridge?.credentialClear && provider) void bridge.credentialClear(provider).catch(() => {});
    if (bridge?.configSet) void bridge.configSet(null).catch(() => {});
    retryAttempt = 0;
    clearRetry();
    log('sync', 'info', '已断开云端连接');
    set({ cfg: null, token: '', login: '', syncState: 'local', syncBlockedByWorkflow: false });
  },

  markPending() {
    if (!get().cfg) return;
    set({ syncState: 'pending' });
  },

  setSyncInterval(minutes) {
    // 定时检查不再提供「仅手动」；传入 0 / 非法值时按默认间隔处理，避免旧设置残留成停摆状态
    const value =
      Number.isFinite(minutes) && minutes > 0
        ? Math.min(1440, Math.max(1, Math.round(minutes)))
        : SYNC_INTERVAL_DEFAULT;
    localStorage.setItem(INTERVAL_KEY, String(value));
    set({ syncInterval: value });
    log('sync', 'info', `定时检查间隔改为 ${value} 分钟`);
  },

  setCommitInterval(minutes) {
    const value = saveCommitInterval(minutes);
    set({ commitInterval: value });
    log('sync', 'info', `自动提交间隔改为 ${value} 分钟（本地保存不受影响）`);
  },

  async flushPendingWrites() {
    const noteIds = [...writeTimers.keys()];
    for (const id of noteIds) {
      const t = writeTimers.get(id);
      if (t) window.clearTimeout(t);
      writeTimers.delete(id);
      const note = get().notes.find((n) => n.id === id);
      if (!note) continue;
      try {
        await writeNote(note);
        void snapshot(note).catch(() => {});
        localStorage.setItem(PENDING_KEY, '1');
      } catch (e) {
        console.warn('flush note failed', e);
      }
    }
    const taskIds = [...taskWriteTimers.keys()];
    for (const id of taskIds) {
      const t = taskWriteTimers.get(id);
      if (t) window.clearTimeout(t);
      taskWriteTimers.delete(id);
      const task = get().tasks.find((x) => x.id === id);
      if (!task) continue;
      try {
        await repo.saveTask(task);
        localStorage.setItem(PENDING_KEY, '1');
      } catch (e) {
        console.warn('flush task failed', e);
      }
    }
    // 隐私锁的写入平时有 600ms 防抖：提交前补一次，别让最后一次加锁漏在提交外面
    try {
      await flushPrivacySync();
    } catch (e) {
      console.warn('flush privacy failed', e);
    }
  },

  async syncNow(force = false, allowLocked = false) {
    const { cfg, token, login } = get();
    clearRetry();
    // 手动/强制同步是用户重新发起，给满一轮重试预算；自动同步则沿用计数，避免无限重试
    if (force) retryAttempt = 0;
    // 锁屏时不做任何云端往来：密码还没输入，不该动数据。
    // 退出程序是例外：界面已经锁着也要把未推送的改动交上去，否则最后一次改动会一直等下次启动。
    if (get().locked && !allowLocked) return;
    if (!cfg || !token) {
      // 没令牌时直接落到同步页：这里是最需要用户动手的地方，别让他再找一遍
      get().setSettings(true, 'sync');
      return;
    }
    if (get().syncState === 'syncing') return;
    // 自动同步限频：5 分钟内看过远端就不再发请求。重试（retryAttempt > 0）要放行，
    // 否则一次网络抖动之后退避重试会被自己的冷却挡掉，改动要等到下个定时器才上传。
    if (!force && retryAttempt === 0) {
      const lastCheck = lastSyncCheckAt();
      if (lastCheck && Date.now() - lastCheck < AUTO_SYNC_MIN_GAP) return;
    }
    // 公开仓库提醒只在用户主动点同步时做一次；自动同步不查，避免频繁调 API。
    // 事件是异步的，不阻塞也不影响同步本身。
    if (force) window.dispatchEvent(new Event('glimnote:check-repo-privacy'));
    set({ syncState: 'syncing', syncMessage: undefined });
    try {
      log('sync', 'info', force ? '开始同步（手动，立即提交）' : '开始同步');
      // 编辑停止 700ms 后才写盘，这里先把还在计时器里的改动落盘，避免手动同步漏掉最后几个字
      await get().flushPendingWrites();
      // 云端推送：每次同步前刷新待办摘要，任务改过之后不用再手动「保存配置」。
      // 配置关着时函数内部直接返回，不写任何文件。
      try {
        const pushTasks = get().tasksLoaded ? get().tasks : await repo.loadTasks();
        // 云端推送已改为只支持 GitHub：旧平台留着开启状态的，自动关闭并删除执行文件
        if (await disableLegacyCloudPush(pushTasks, cfg.provider, `${cfg.owner}/${cfg.repo}`)) {
          log('sync', 'info', '云端推送只支持 GitHub，已自动关闭并清理旧平台的定时任务');
        }
        await refreshCloudPushDigest(pushTasks, cfg.provider, `${cfg.owner}/${cfg.repo}`);
      } catch (e) {
        // 写摘要失败不能挡住笔记同步：下次同步还会重试
        console.warn('refresh cloud push digest failed', e);
      }
      const res = await sync(
        cfg,
        token,
        login,
        `note: 自动保存 ${new Date().toLocaleString('zh-CN', { hour12: false })}`,
        { force },
      );

      // 未到自动提交间隔：内容已经写盘，等下一次到点再合并提交，不刷 Git 历史
      if (res.deferred) {
        retryAttempt = 0;
        const mins = Math.max(1, Math.ceil((commitDueAt() - Date.now()) / 60000));
        set({
          syncState: 'pending',
          syncMessage: `已保存到本机，约 ${mins} 分钟后自动上传（想马上上传可点「立即同步」）`,
        });
        log('sync', 'info', `未到自动提交间隔，${mins} 分钟后再提交`);
        return;
      }

      retryAttempt = 0;
      await get().refresh();
      localStorage.removeItem(PENDING_KEY);
      log(
        'sync',
        'info',
        `同步完成 · 拉取=${res.pulled ? '是' : '否'} · 推送=${res.pushed ? '是' : '否'} · 冲突副本=${res.conflicts.length}`,
      );

      if (res.conflicts.length) {
        const copies = get().notes.filter((n) => res.conflicts.includes(n.path));
        const label = copies.length === 1 ? `「${copies[0].title}」` : `${res.conflicts.length} 篇笔记`;
        set({
          syncState: 'synced',
          syncAt: new Date().toISOString(),
          syncMessage: `已保留 ${res.conflicts.length} 份冲突副本`,
          syncBlockedByWorkflow: false,
        });
        get().toast(
          `另一台设备改过${label}，已保留冲突副本，两边内容都在`,
          'warn',
          copies[0]
            ? {
                label: '查看',

                run: () => {
                  get().select(copies[0].id);
                  set({ view: { type: 'notebook', value: copies[0].notebook } });
                },
              }
            : undefined,
        );
        return;
      }

      set({
        syncState: 'synced',
        syncAt: new Date().toISOString(),
        syncMessage: res.pushed ? '已推送' : '已是最新',
        needsReclone: false,
        syncBlockedByWorkflow: false,
      });
    } catch (e) {
      const err = e as GitError;
      // 把原始报错也写进日志：翻译后的中文适合展示，但排查 GitHub 的 200+拒绝这类问题得看原文
      const detail = errorDetail(err);
      log('sync', 'error', detail ? `${errorText(err)} · ${detail}` : errorText(err));
      if (err.code === 'HISTORY_REWRITTEN') {
        set({ syncState: 'error', syncMessage: err.message, needsReclone: true });
        return;
      }
      if (err.code === 'CONFLICT') {
        set({ syncState: 'conflict', syncMessage: err.message });
        return;
      }
      if (err.code === 'AUTH_INVALID' || err.code === 'AUTH_FORBIDDEN') {
        // 只有 workflow 权限这一种，可以靠关闭云端推送绕过去；其他权限问题仍需用户改令牌
        set({
          syncState: 'error',
          syncMessage: err.message,
          syncBlockedByWorkflow: isWorkflowScopeFailure(err.cause || err.message),
        });
        return;
      }
      if (err.code === 'CORS_BLOCKED') {
        // 网页版的跨域限制不会自己恢复，自动重试只是白白刷日志和耗电
        set({ syncState: 'error', syncMessage: err.message });
        return;
      }

      // 网络/未知错误自动退避重试；认证与冲突类错误交给用户处理
      // 重试有上限：权限、仓库地址这类问题不会自己恢复，无限重试只会每分钟发一次请求、刷满日志
      if (retryAttempt >= RETRY_DELAYS.length) {
        set({
          syncState: err.code === 'NETWORK' ? 'offline' : 'error',
          syncMessage: `${err.message} · 已停止自动重试，可在同步设置里手动重试，或按 Ctrl+Shift+S`,
        });
        return;
      }
      const delay = RETRY_DELAYS[retryAttempt];
      retryAttempt += 1;
      retryTimer = window.setTimeout(() => {
        retryTimer = null;
        void get().syncNow();
      }, delay);
      const wait = delay >= 60000 ? `${Math.round(delay / 60000)} 分钟` : `${Math.round(delay / 1000)} 秒`;
      set({
        syncState: err.code === 'NETWORK' ? 'offline' : 'error',
        syncMessage: `${err.message} · ${wait}后自动重试`,
      });
    }
  },

  async recoverSyncWithoutCloudPush() {
    const { cfg, token, login } = get();
    if (!cfg || !token) {
      get().setSettings(true, 'sync');
      return;
    }
    if (get().syncState === 'syncing') return;
    clearRetry();
    retryAttempt = 0;
    set({ syncState: 'syncing', syncMessage: '正在关闭云端推送并恢复同步…' });
    try {
      await get().flushPendingWrites();
      // 先关掉云端推送：否则重新提交前的摘要刷新会把工作流文件又写回来
      const push = await readCloudPushConfig();
      if (push.enabled) {
        const tasks = get().tasksLoaded ? get().tasks : await repo.loadTasks();
        await saveCloudPushConfig({ ...push, enabled: false }, tasks, cfg.provider, `${cfg.owner}/${cfg.repo}`);
      }
      const res = await resyncWithoutWorkflow(
        cfg,
        token,
        login,
        `note: 跳过云端推送工作流同步 ${new Date().toLocaleString('zh-CN', { hour12: false })}`,
      );
      await get().refresh();
      localStorage.removeItem(PENDING_KEY);
      set({
        syncState: 'synced',
        syncAt: new Date().toISOString(),
        syncMessage: res.pushed ? '已推送（云端推送已关闭）' : '已是最新',
        needsReclone: false,
        syncBlockedByWorkflow: false,
      });
      log('sync', 'info', '已关闭云端推送并移除工作流，笔记同步恢复');
      get().toast(
        '已关闭云端推送，笔记恢复同步；需要云端推送时补上令牌 workflow 权限后可重新开启',
        'success',
        undefined,
        undefined,
        8000,
      );
    } catch (e) {
      const err = e as GitError;
      const detail = errorDetail(err);
      log('sync', 'error', `跳过工作流恢复同步失败 · ${errorText(err)}${detail ? ` · ${detail}` : ''}`);
      set({
        syncState: 'error',
        syncMessage: err.message || '恢复同步失败',
        syncBlockedByWorkflow: isWorkflowScopeFailure(err.cause || err.message),
      });
      get().toast(err.message || '恢复同步失败', 'error');
    }
  },

  async compactRepo() {
    const { cfg, token, login } = get();
    if (!cfg || !token) throw new GitError('AUTH_INVALID', '还没有连接云端仓库，无法压缩历史');
    if (get().syncState === 'syncing') throw new Error('正在同步，请稍后再试');
    set({ syncState: 'syncing', syncMessage: '正在压缩仓库历史…' });
    try {
      await get().flushPendingWrites();
      const res = await compactHistory(cfg, token, login);
      await get().refresh();
      localStorage.removeItem(PENDING_KEY);
      set({
        syncState: 'synced',
        syncAt: new Date().toISOString(),
        syncMessage: '仓库历史已压缩',
        needsReclone: false,
      });
      log('sync', 'info', `仓库历史压缩完成 · ${res.oldOid ? res.oldOid.slice(0, 7) : '无'} → ${res.oid.slice(0, 7)}`);
      return res;
    } catch (e) {
      const err = e as GitError;
      log('sync', 'error', `压缩历史失败 · ${errorText(err)}`);
      set({ syncState: 'error', syncMessage: errorText(err) });
      throw e;
    }
  },

  async resetRepo() {
    const { cfg, token, login } = get();
    if (!cfg || !token) throw new GitError('AUTH_INVALID', '还没有连接云端仓库，无法重新下载');
    if (get().syncState === 'syncing') throw new Error('正在同步，请稍后再试');
    set({ syncState: 'syncing', syncMessage: '正在重新下载远端仓库…' });
    try {
      await get().flushPendingWrites();
      await resetFromRemote(cfg, token, login);
      localStorage.removeItem(PENDING_KEY);
      await get().refresh();
      set({
        syncState: 'synced',
        syncAt: new Date().toISOString(),
        syncMessage: '已重新下载远端历史',
        needsReclone: false,
      });
      log('sync', 'info', '已重新下载远端仓库并对齐工作区');
    } catch (e) {
      const err = e as GitError;
      log('sync', 'error', `重新下载失败 · ${errorText(err)}`);
      set({
        syncState: 'error',
        syncMessage: errorText(err),
        needsReclone: err.code === 'HISTORY_REWRITTEN' ? true : get().needsReclone,
      });
      throw e;
    }
  },
}));
