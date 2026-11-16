const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  shell,
  Menu,
  Tray,
  nativeImage,
  globalShortcut,
  net,
  safeStorage,
  Notification,
  screen,
  session,
  clipboard,
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { registerGitProxy } = require('./git-proxy.cjs');
const logFile = require('./log-file.cjs');
const { moveRepoDir } = require('./migrate.cjs');
const { registerAiProxy, registerWebhookProxy } = require('./ai-proxy.cjs');
const { createMcpHttpController, DEFAULT_PORT: MCP_HTTP_PORT } = require('./mcp-http.cjs');
const { createCredentialStore } = require('./credentials.cjs');
const { createConfigStore } = require('./config-file.cjs');
const { createWorkspaceManager, repoWorkspaceName } = require('./workspace.cjs');
const cardPlacement = require('./card-placement.cjs');
const { createSystemAppsController } = require('./system-apps.cjs');

const isDev = process.argv.includes('--dev');
const ASSETS = path.join(__dirname, 'assets');

/**
 * 极简启动面包屑：同步追加到 <userData>/boot.log，记录「主进程脚本跑到了哪一步」。
 * 主日志是 400ms 批量落盘，进程如果在窗口出现前就被结束（闪退、被安全软件拦下），
 * 主日志里一行都不会留下；这里每次启动只写几行，能区分「根本没起来」和「起来后才崩」。
 * 超过 64KB 自动清空，避免常年累积。
 */
function writeBootLine(text) {
  try {
    const file = path.join(app.getPath('userData'), 'boot.log');
    try {
      if (fs.statSync(file).size > 64 * 1024) fs.writeFileSync(file, '');
    } catch {
      /* 第一次写，文件还不存在 */
    }
    fs.appendFileSync(file, `${new Date().toISOString()}  ${text}\n`, 'utf8');
  } catch {
    /* 面包屑写不进去也不能影响启动 */
  }
}

/**
 * 自动更新源：GitCode Releases。
 * GitCode 没有 GitHub 那样的 releases/latest 固定目录，所以先问一次 API 拿到
 * 最新版本 tag，再让 generic provider 指向该版本的下载目录，由它读取 latest.yml。
 * 发版时把安装包与 latest.yml 传到同一个 tag（如 v0.1.1）即可。
 */
const UPDATE_API = 'https://api.gitcode.com/api/v5/repos/jewey/glimnote/releases/latest';
const UPDATE_DOWNLOAD_BASE = 'https://gitcode.com/jewey/glimnote/releases/download';
const UPDATE_TIMEOUT = 10000;

// 到点提醒是应用自己发声，不依赖用户先点过页面；Electron 默认的自动播放限制会把提示音吞掉
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

/**
 * 「重置应用」用标记文件实现：对话框里点重置后先写标记，再 relaunch。
 * 下次启动、Chromium 打开任何缓存之前，把整个 userData 目录改名挪走。
 * 笔记在各工作区的笔记目录（默认「文档/glimnote」），不在 userData 里，所以重置不会碰到笔记。
 */
const RESET_FLAG = 'glimnote-reset.once';
let resetBackupDir = '';

function consumeResetFlag() {
  const flag = path.join(app.getPath('appData'), RESET_FLAG);
  if (!fs.existsSync(flag)) return false;
  try {
    fs.rmSync(flag, { force: true });
  } catch {
    /* 标记删不掉也要继续重置 */
  }
  const userData = app.getPath('userData');
  const backup = `${userData}.broken-${Date.now()}`;
  try {
    fs.renameSync(userData, backup);
    resetBackupDir = backup;
    return true;
  } catch (e) {
    // 目录被占用时退而求其次：清掉 userData 里除应用自己的配置以外的全部内容。
    // Chromium 的 profile 目录很多，逐个点名容易漏，索性只保留白名单。
    const keep = new Set([
      'prefs.json',
      'git-config.json',
      'credentials.bin',
      'mcp-root.txt',
      'logs',
      'workspaces.json',
      'workspaces',
    ]);
    try {
      for (const entry of fs.readdirSync(userData, { withFileTypes: true })) {
        if (keep.has(entry.name)) continue;
        try {
          fs.rmSync(path.join(userData, entry.name), { recursive: true, force: true, maxRetries: 2 });
        } catch {
          /* 单个条目失败不影响其它条目 */
        }
      }
    } catch {
      /* userData 还不存在，等同于全新安装 */
    }
    console.warn('reset userData fallback', e && e.message);
    return true;
  }
}

writeBootLine(`主进程脚本已加载 · electron ${process.versions.electron || '?'}`);

const resetApplied = consumeResetFlag();

// 工作区必须在打开日志 / 窗口之前确定：笔记目录、同步配置、令牌、日志都跟着它走
const workspace = createWorkspaceManager({ app });
writeBootLine(`工作区就绪 · ${workspace.active().name} · ${workspace.dir()}`);

/**
 * 安装器写在程序目录里的日志位置（UTF-16LE，可能带 BOM 或引号）。
 * 只有绝对路径才认；目录建不出来也退回默认位置，不能让一个坏文件把应用拖垮。
 */
function readLogDirOverride() {
  try {
    const file = path.join(path.dirname(app.getPath('exe')), 'log-dir.txt');
    const raw = fs.readFileSync(file, 'utf16le').replace(/^\uFEFF/, '').trim();
    const value = raw.replace(/^"(.*)"$/, '$1').trim();
    if (!value || !path.isAbsolute(value)) return '';
    fs.mkdirSync(value, { recursive: true });
    return value;
  } catch {
    return '';
  }
}

// 尽早确定日志目录：连启动阶段的崩溃也要写进文件（按工作区分开）
// 有安装器配置时用用户选的目录，否则 logFile.init 会自己拼上 <工作区>/logs
logFile.setDirOverride(readLogDirOverride());
logFile.init(workspace.dir());

let mainWindow = null;
/** 主窗口白屏自救：先自动清缓存重载一次，再失败就走原生对话框 */
let mainLoadRetryCount = 0;
let mainLoadedOnce = false;
let loadFailureDialogShown = false;
let mainLoadWatchdog = null;
let rendererCrashCount = 0;
let captureWindow = null;
let cardWindow = null;
/** 浮窗渲染进程上次是不是崩了：下次打开时先重载，别把一个空白窗口摆到用户面前 */
let cardCrashed = false;
/** 浮窗热键没抢到（被其它软件占用）：设置页和提示里都要说清楚 */
let cardHotkeyTaken = false;
/** 桌面右下角的到点提醒浮层；只保留一个实例，用完只是隐藏 */
let reminderWindow = null;
let reminderHideTimer = null;
/** 浮层此刻显示了几个待办标题；上锁时要据此换成只报条数的版本 */
let lastReminderCount = 0;
/** 当前浮层是不是「已锁定」的汇总提醒（里面没有具体标题） */
let reminderGeneric = false;
let tray = null;
/** 托盘菜单语言：跟随界面语言，由渲染进程通过 app:ui-lang 同步过来 */
let uiLang = null;
/** 浮窗位置 / 大小：下次打开还在原地，避免每次都要重新摆 */
let cardBounds = null;
let cardBoundsTimer = null;
/** 浮窗最近一次被摆到用户眼前的时间；开关按钮据此区分「刚叫出来没看到」和「确实想收起」 */
let cardRevealedAt = 0;
/** 刚显示后的宽限期：这段时间内再点一次入口只重新叫到前面，不会收起 */
const CARD_REVEAL_GRACE = 2200;
/** 浮窗是否置顶：默认 false，别一开就盖住别的软件；用户点图钉才置顶 */
let cardPinned = false;
/** 浮窗是否开着：写进偏好，重启后自动放回桌面；退出过程不算「用户收起」 */
let cardOpen = false;
/** 启动时发现上次浮窗开着，等主窗口报过一次锁状态后再恢复，避免锁屏前先亮出内容 */
let cardRestorePending = false;
/** 主窗口上锁时，浮窗也不能用快捷键调出来（里面是待办和灵感） */
let cardLocked = false;
let isQuitting = false;
let closeToTray = true;
/** 退出前先让渲染层落盘并同步一次；等它确认，或超时后直接退出 */
let quitAfterSync = false;
let quitSyncTimer = null;
/** 独立笔记窗口：一篇笔记一个窗口，key 是笔记 id */
const noteWindows = new Map();
/** 独立小应用窗口：浮窗入口允许同一应用开多个，这里负责复用与生命周期 */
const appWindows = new Set();
/** 窗口对应的应用 id：再次打开时恢复原窗口，不再重复建窗 */
const appWindowIds = new WeakMap();
/** 收成一条的小应用：窗口先藏起来，在桌面底部的合并条上留一个入口 */
const collapsedApps = new Map();
/** 收起前的位置 / 大小；从合并条放大时按这个尺寸在屏幕居中 */
const appExpandedBounds = new WeakMap();
/** 上锁时被藏起来的小应用窗口；解锁后重新放回桌面 */
const appWindowsHiddenByLock = new Set();
/** 桌面底部的合并条：多个小应用收成一条时只占这一条 */
let dockWindow = null;
/** 上锁时连合并条一起藏起来，解锁后再放出来 */
let dockHiddenByLock = false;
/** 合并条最近一次的宽度；重建窗口时沿用，避免先闪一下默认宽度 */
let dockWidth = 0;
/** 用户把合并条拖到哪儿了：记忆位置（prefs.json 的 dockPos），重开也在原地 */
let dockPos = null;
/** 小应用窗口「最大化」前的正常大小（透明窗体不能用系统最大化） */
const appMaximizedBounds = new WeakMap();
/** 已经同意关闭 / 退出的窗口，close 事件不再拦截 */
const forceClose = new WeakSet();
/** 退出时还在等这些独立窗口落盘 */
const noteFlushPending = new Set();
/** 主窗口是否已经完成退出前落盘 */
let mainQuitReady = false;
/** 自动更新：组件实例、安装包是否已下载、用户是否点了「重启并安装」 */
let updaterInstance = null;
let updateDownloaded = false;
/** 已下载的版本号：检查到更高版本时不能沿用旧安装包 */
let updateDownloadedVersion = '';
/** 正在下载时的共享 Promise：重复点「下载更新」复用同一次下载，不会又开一份 */
let updateDownloadPromise = null;
let pendingInstallUpdate = false;
/** 自动检查更新：启动后延迟一次，之后每 24 小时一次 */
const UPDATE_AUTO_DELAY = 15 * 1000;
const UPDATE_AUTO_INTERVAL = 24 * 60 * 60 * 1000;
let autoUpdateTimers = [];
/** 最近一次检查到的新版本，供「关于」页进来时直接显示 */
let lastAvailableVersion = '';
/** 本次运行已经弹过通知的版本，避免同一次运行里反复提醒 */
let notifiedUpdateVersion = '';
/** 解析出来的最新版本下载目录；每次进程只查一次，检查更新时刷新 */
let updateFeedBase = '';
/** require('electron-updater') 失败时的原始原因，用于日志和界面兜底说明 */
let updaterLoadError = '';
/** GitCode Releases 页面：更新组件不可用时让用户手动下载 */
const RELEASES_PAGE = 'https://gitcode.com/jewey/glimnote/releases';
/** 系统通知的对象要留住引用，否则可能在用户点击前被回收 */
const liveNotifications = new Set();

/** 当前工作区的笔记目录；切换工作区后由 workspace.cjs 决定 */
let activeRepoRoot = null;
/** 开发模式进程内切换工作区期间，销毁旧窗口不能触发「关完窗口就退出」 */
let switchingWorkspace = false;

function defaultRepoRoot() {
  return path.join(app.getPath('documents'), 'glimnote');
}

function repoRoot() {
  return activeRepoRoot || workspace.root();
}

/**
 * Chromium 存储分区：默认工作区不设 partition，沿用升级前的默认 session；
 * 其它工作区各用一份，localStorage / IndexedDB / 缓存互不可见。
 */
function workspacePartition() {
  return workspace.activeItem().partition || undefined;
}

function resolvePath(input) {
  const rel = String(input).replace(/^\/repo\/?/, '');
  const base = repoRoot();
  const full = path.resolve(base, rel);
  if (full !== base && !full.startsWith(base + path.sep)) {
    throw new Error('路径超出笔记仓库范围');
  }
  return full;
}

/** 把仓库位置写给 MCP 服务，避免 OneDrive 重定向「文档」时找错目录 */
async function publishMcpRoot() {
  try {
    const target = path.join(app.getPath('userData'), 'mcp-root.txt');
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, repoRoot(), 'utf8');
  } catch (e) {
    console.warn('publish mcp root failed', e);
  }
}

/** MCP 脚本目录：打包后在 resources/mcp，开发时在项目目录里 */
function mcpDir() {
  return path.join(app.isPackaged ? process.resourcesPath : app.getAppPath(), 'mcp');
}

/* 授权令牌：按工作区用系统密钥加密保存，切换工作区后互不串用（docs/05 §3） */
let credentials;
/* 同步配置：每个工作区一份普通 JSON，开发版和安装版共用同一个工作区（见 config-file.cjs） */
let gitConfig;

/** 把令牌 / 配置存储重新绑到当前工作区；开发模式下进程内切换工作区时也要重新调用 */
function bindWorkspaceStores() {
  credentials = createCredentialStore({
    dir: workspace.dir(),
    safeStorage,
    log: (level, msg) => logFile.write('auth', level, msg),
  });
  gitConfig = createConfigStore({
    dir: workspace.dir(),
    log: (level, msg) => logFile.write('sync', level, msg),
  });
}

bindWorkspaceStores();

/* 内置 MCP HTTP 服务：设置里的开关控制它，退出应用时一起停掉 */
const systemApps = createSystemAppsController({ app, shell, dialog });
const mcpHttp = createMcpHttpController({
  execPath: process.execPath,
  serverPath: path.join(mcpDir(), 'server.mjs'),
  getRoot: () => repoRoot(),
  port: MCP_HTTP_PORT,
  log: (level, msg) => logFile.write('mcp', level, msg),
});

function prefsPath() {
  return path.join(app.getPath('userData'), 'prefs.json');
}

async function readPrefs() {
  try {
    return JSON.parse(await fsp.readFile(prefsPath(), 'utf8'));
  } catch {
    return {};
  }
}

/** 写入排成一条队列：位置、置顶、开关可能同一时刻各写一次，并发读改写会丢掉其中一个 */
let prefsWriteQueue = Promise.resolve();
function writePrefs(patch) {
  prefsWriteQueue = prefsWriteQueue.catch(() => {}).then(async () => {
    const current = await readPrefs();
    const next = { ...current, ...patch };
    await fsp.mkdir(path.dirname(prefsPath()), { recursive: true }).catch(() => {});
    await fsp.writeFile(prefsPath(), JSON.stringify(next, null, 2), 'utf8').catch(() => {});
    return next;
  });
  return prefsWriteQueue;
}

/** 开机自启时带上的参数：日志里能区分「用户双击」和「系统登录拉起」 */
const AUTOSTART_ARG = '--autostart';

/**
 * 开机自启状态以操作系统启动项为准，避免本地偏好和系统实际状态不一致。
 * 开发模式下 process.execPath 是 electron.exe，写进去只会让系统启动一个空壳，
 * 所以只在安装版开放；Linux 交给桌面环境的自启动设置。
 */
function loginItemState() {
  if (process.platform === 'linux') {
    return { supported: false, enabled: false, error: 'Linux 请使用系统的自启动设置' };
  }
  if (!app.isPackaged) {
    return { supported: false, enabled: false, error: '开发模式下不写入开机启动，安装版可用' };
  }
  try {
    const state = app.getLoginItemSettings({ args: [AUTOSTART_ARG] });
    return { supported: true, enabled: Boolean(state.openAtLogin) };
  } catch (e) {
    return {
      supported: false,
      enabled: false,
      error: `读取开机启动项失败：${(e && e.message) || e}`,
    };
  }
}

/** 浮窗所在的屏幕：取窗口中心点最近的那块，跨屏拖动时行为才符合直觉 */
function cardWorkArea(rect) {
  return screen.getDisplayNearestPoint({
    x: Math.round(rect.x + rect.width / 2),
    y: Math.round(rect.y + rect.height / 2),
  }).workArea;
}

/** 把浮窗矩形完整收进当前屏幕；还原、拔副屏、改分辨率都靠它兜底 */
function fitCardRect(rect) {
  const size = cardPlacement.normalizeSize(rect.width, rect.height);
  const next = { ...size, x: Math.round(rect.x), y: Math.round(rect.y) };
  return cardPlacement.fitRect(next, cardWorkArea(next));
}

/**
 * 记住的浮窗位置必须还能看见：拔掉副屏、改分辨率后不再直接丢掉用户的尺寸，
 * 而是保留宽高、把位置收回到离它最近的那块屏幕上。
 */
function usableCardBounds(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const width = Math.round(Number(raw.width));
  const height = Math.round(Number(raw.height));
  const x = Math.round(Number(raw.x));
  const y = Math.round(Number(raw.y));
  if (![x, y, width, height].every(Number.isFinite)) return null;
  // 高度下限要留给「收成一条」的 72px 形态，渲染层自己会把展开态限制在 320 以上
  return fitCardRect({ x, y, width, height });
}

/**
 * 副屏拔掉 / 分辨率变了：开着的浮窗可能整块落到屏幕外。
 * 立即收回可视区域并写回偏好，下次打开还在看得见的地方。
 */
function refitCardWindow() {
  const win = cardWindow;
  if (!win || win.isDestroyed()) return;
  const rect = win.getBounds();
  const next = fitCardRect(rect);
  const changed = next.x !== rect.x || next.y !== rect.y || next.width !== rect.width || next.height !== rect.height;
  if (changed) {
    win.setBounds(next, false);
    logFile.write('app', 'info', `显示设置变化，浮窗已收回可视区域（${next.x},${next.y}）`);
  }
  flushCardBounds();
}

/** 浮窗外框：无边框、透明，圆角和阴影都画在页面里 */
function defaultCardBounds() {
  const area = screen.getPrimaryDisplay().workArea;
  const width = 368;
  const height = 572;
  return {
    width,
    height,
    x: area.x + area.width - width - 28,
    y: area.y + Math.max(24, Math.round((area.height - height) * 0.38)),
  };
}

/**
 * 同步引擎经常「先读一下，不存在再说」：isomorphic-git 会为每个未跟踪文件
 * 逐个探测各级目录的 .gitignore，缺文件就抛 ENOENT。
 *
 * ipcMain.handle 里一旦 throw，Electron 会往控制台打一行
 * "Error occurred in handler for 'fs:readFile'"，而渲染进程其实已经按 code 当正常情况处理了。
 * 这里把结果包成普通返回值，由 preload 还原成异常，行为不变，但不再刷屏。
 */
const FS_IPC_TAG = '__glimnoteFsResult';

async function fsResult(run) {
  try {
    return { [FS_IPC_TAG]: true, ok: true, value: await run() };
  } catch (e) {
    const err = e && typeof e === 'object' ? e : {};
    return {
      [FS_IPC_TAG]: true,
      ok: false,
      error: {
        name: err.name || 'Error',
        message: err.message || String(e),
        code: err.code,
        errno: err.errno,
        syscall: err.syscall,
        path: err.path,
      },
    };
  }
}

function registerFsHandlers() {
  ipcMain.handle('fs:mkdir', (_e, p) => fsResult(() => fsp.mkdir(resolvePath(p), { recursive: true })));
  ipcMain.handle('fs:rmdir', (_e, p) => fsResult(() => fsp.rmdir(resolvePath(p))));
  ipcMain.handle('fs:readdir', (_e, p) => fsResult(() => fsp.readdir(resolvePath(p))));
  ipcMain.handle('fs:readFile', (_e, p, opts) =>
    fsResult(() => {
      const encoding = typeof opts === 'string' ? opts : opts && opts.encoding;
      if (encoding === 'utf8') return fsp.readFile(resolvePath(p), 'utf8');
      return fsp.readFile(resolvePath(p));
    }),
  );
  ipcMain.handle('fs:writeFile', (_e, p, data, opts) =>
    fsResult(async () => {
      const encoding = typeof opts === 'string' ? opts : opts && opts.encoding;
      const full = resolvePath(p);
      if (typeof data === 'string') {
        await fsp.writeFile(full, data, encoding || 'utf8');
      } else {
        await fsp.writeFile(full, Buffer.from(data));
      }
    }),
  );
  ipcMain.handle('fs:unlink', (_e, p) => fsResult(() => fsp.unlink(resolvePath(p))));
  ipcMain.handle('fs:stat', (_e, p) => fsResult(async () => toPlainStat(await fsp.stat(resolvePath(p)))));
  ipcMain.handle('fs:lstat', (_e, p) => fsResult(async () => toPlainStat(await fsp.lstat(resolvePath(p)))));
  ipcMain.handle('fs:rename', (_e, from, to) => fsResult(() => fsp.rename(resolvePath(from), resolvePath(to))));
  ipcMain.handle('fs:chmod', (_e, p, mode) => fsResult(() => fsp.chmod(resolvePath(p), mode)));
  ipcMain.handle('fs:readlink', (_e, p) => fsResult(() => fsp.readlink(resolvePath(p))));
  ipcMain.handle('fs:symlink', (_e, target, p) => fsResult(() => fsp.symlink(target, resolvePath(p))));
  ipcMain.handle('app:ui-lang', (_e, lang) => {
    uiLang = String(lang) === 'en' ? 'en' : 'zh';
    createTray();
    return true;
  });
  ipcMain.handle('app:repo-path', () => repoRoot());
  ipcMain.handle('app:repo-location', () => {
    const item = workspace.activeItem();
    // 「恢复默认」要回到这个工作区创建时的文件夹，而不是按 id 现算一个路径：
    // 用户新建工作区时可以自选位置，按 id 推算会把笔记迁到一个从没出现过的目录。
    const suggested = item.baseRoot || (item.id === 'default' ? defaultRepoRoot() : item.root);
    return {
      path: repoRoot(),
      defaultPath: suggested,
      custom: path.resolve(repoRoot()) !== path.resolve(suggested),
      workspace: item,
    };
  });
  // 让用户选父目录：真正存放笔记的是里面的 glimnote 子目录，避免把一堆 .md 散在用户选的目录里
  ipcMain.handle('app:choose-repo-location', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: '选择笔记存放的文件夹',
      buttonLabel: '用这个文件夹',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (res.canceled || !res.filePaths[0]) return { canceled: true };
    const parent = path.resolve(res.filePaths[0]);
    const target = path.basename(parent).toLowerCase() === 'glimnote' ? parent : path.join(parent, 'glimnote');
    const current = path.resolve(repoRoot());
    if (target === current) return { canceled: false, same: true, path: target };
    return { canceled: false, path: target, current };
  });
  ipcMain.handle('app:move-repo-location', async (_e, target) => {
    const from = repoRoot();
    const raw = String(target || '').trim();
    if (!raw) throw new Error('新位置不能为空');
    const to = path.resolve(raw);
    // 每个工作区必须各占一个目录：迁进别人的笔记目录会让两份日志混在一起
    const other = workspace.list().items.find((it) => it.id !== workspace.active().id && path.resolve(it.root) === to);
    if (other) throw new Error(`这个文件夹已经是工作区「${other.name}」的笔记目录，请换一个空文件夹`);
    const result = await moveRepoDir({
      from,
      to,
      log: (level, msg) => logFile.write('app', level, msg),
    });
    activeRepoRoot = to;
    workspace.updateRoot(workspace.active().id, to);
    // 默认工作区同时写回老偏好，降级到旧版本时仍能找到笔记
    if (workspace.active().id === 'default') {
      const sameAsDefault = path.resolve(to) === path.resolve(defaultRepoRoot());
      await writePrefs({ repoRoot: sameAsDefault ? null : to });
    }
    await publishMcpRoot();
    return result;
  });
  ipcMain.handle('app:open-repo', async () => {
    await fsp.mkdir(repoRoot(), { recursive: true });
    await shell.openPath(repoRoot());
  });
  // 工作区：一套独立的笔记目录 + 同步配置 + 令牌 + 日志 + 界面缓存
  ipcMain.handle('app:workspace-info', () => workspace.activeItem());
  ipcMain.handle('app:workspace-list', () => workspace.list());
  ipcMain.handle('app:workspace-create', (_e, payload) => workspace.create(payload || {}));
  ipcMain.handle('app:workspace-bind-repo', (_e, repo, opts) => workspace.bindRepo(repo || null, opts || {}));
  ipcMain.handle('app:workspace-find-repo', (_e, repo) => workspace.findByRepo(repo || {}));
  // 连接一个和当前工作区不是同一份笔记的仓库时，为它准备独立的工作区目录，
  // 并把同步配置 / 令牌先写进去；切换（应用重启）之后就能直接继续同步。
  ipcMain.handle('app:workspace-prepare-connect', async (_e, payload) => {
    const repo = payload && payload.repo ? payload.repo : {};
    const cfg = payload && payload.cfg ? payload.cfg : null;
    const login = payload && typeof payload.login === 'string' ? payload.login : '';
    const token = payload && typeof payload.token === 'string' ? payload.token : '';
    if (!cfg || !repo.provider || !repo.owner || !repo.repo) return { ok: false, error: '缺少仓库信息' };

    let item = workspace.findByRepo(repo);
    let created = false;
    if (!item) {
      const res = workspace.create({ name: repoWorkspaceName(repo) });
      if (!res.ok || !res.item) return res;
      item = res.item;
      created = true;
    }
    if (item.id === workspace.active().id) return { ok: true, item, created, same: true };

    const bound = workspace.bindRepoFor(item.id, { ...repo, branch: cfg.branch });
    if (!bound.ok) return bound;

    const dir = workspace.dir(item.id);
    const cfgStore = createConfigStore({ dir, log: (level, msg) => logFile.write('sync', level, msg) });
    if (!(await cfgStore.write({ cfg, login }))) {
      return { ok: false, error: '新工作区的同步配置写入失败，请稍后重试' };
    }
    if (token) {
      const creds = createCredentialStore({ dir, safeStorage, log: (level, msg) => logFile.write('auth', level, msg) });
      if (!(await creds.set(cfg.provider, token))) {
        // 令牌没存住不阻断切换：重启后取不回来，设置页会提示重新填写
        logFile.write('auth', 'warn', '独立工作区的令牌没能保存（系统密钥不可用）');
      }
    }
    logFile.write(
      'app',
      'info',
      `为仓库 ${repo.provider} · ${repo.owner}/${repo.repo} 准备独立工作区 · ${bound.item.name} · ${bound.item.root}`,
    );
    return { ok: true, item: bound.item, created };
  });
  ipcMain.handle('app:workspace-rename', (_e, id, name) => workspace.rename(String(id || ''), name));
  ipcMain.handle('app:workspace-pick-root', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: '选择工作区存放的父文件夹',
      buttonLabel: '用这个文件夹',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (res.canceled || !res.filePaths[0]) return { canceled: true };
    return { canceled: false, path: path.resolve(res.filePaths[0]) };
  });
  ipcMain.handle('app:workspace-open', async (_e, id) => {
    const item = workspace.list().items.find((it) => it.id === id);
    if (!item) return false;
    await fsp.mkdir(item.root, { recursive: true }).catch(() => {});
    await shell.openPath(item.root);
    return true;
  });
  ipcMain.handle('app:workspace-switch', async (_e, id) => {
    const res = workspace.switchTo(String(id || ''));
    if (!res.ok || res.same) return { ...res, restarting: false };
    logFile.write('app', 'info', `切换工作区 · ${res.item.name} · ${res.item.root}`);
    // 渲染层在调用前已经落盘；这里留一点时间让返回值回到页面，然后再切换
    setTimeout(() => {
      try {
        logFile.flushSync();
      } catch {
        /* 日志写不进去不阻断切换 */
      }
      if (isDev) {
        // 开发模式下 Vite 由 npm script / concurrently 管着：app.relaunch() 让 Electron
        // 退出时会把 Vite 一起收掉，新进程只能连到 localhost:5174 被拒绝，用户看到
        // 「界面加载失败 -102」。这里在原进程里重建存储绑定和窗口，开发服务器不受影响。
        void softSwitchWorkspace();
        return;
      }
      mcpHttp.stop();
      app.relaunch();
      app.exit(0);
    }, 250);
    return { ...res, restarting: true };
  });
  // 首页的网址入口：只放行 http / https，其它协议（file:、javascript: 等）一律拒绝
  ipcMain.handle('app:open-external', async (_e, url) => {
    const value = String(url || '').trim();
    if (!/^https?:\/\//i.test(value)) return false;
    await shell.openExternal(value);
    return true;
  });
  // 首页的「系统应用」入口：扫描本机应用、按需取图标、按路径启动
  ipcMain.handle('system:list-apps', (_e, force) => systemApps.list(Boolean(force)));
  ipcMain.handle('system:app-icons', (_e, paths) => systemApps.icons(paths));
  ipcMain.handle('system:app-status', (_e, paths) => systemApps.status(paths));
  ipcMain.handle('system:pick-app', () => systemApps.pick());
  ipcMain.handle('system:open-app', (_e, target) => systemApps.open(target));
  // 设置 → 集成：把 MCP 脚本的位置告诉界面，好让用户直接复制到客户端配置里
  ipcMain.handle('app:mcp-info', async () => {
    const dir = path.join(app.isPackaged ? process.resourcesPath : app.getAppPath(), 'mcp');
    const stdio = path.join(dir, 'glimnote-mcp.cmd');
    return {
      dir,
      stdio,
      http: path.join(dir, 'glimnote-mcp-http.cmd'),
      server: path.join(dir, 'server.mjs'),
      root: repoRoot(),
      dev: !app.isPackaged,
      // 开发版或还没打包的资源目录里可能没有脚本，界面上要如实说明
      ready: await fsp.access(stdio).then(
        () => true,
        () => false,
      ),
    };
  });
  ipcMain.handle('app:open-mcp-folder', async () => {
    const err = await shell.openPath(mcpDir());
    return err ? { error: err } : true;
  });
  // 设置 → 集成里的开关：开 = 拉起本机常驻服务并记住，关 = 停掉
  ipcMain.handle('app:mcp-http-status', () => mcpHttp.state());
  ipcMain.handle('app:mcp-http-start', async () => {
    mcpHttp.setWanted(true);
    await writePrefs({ mcpHttp: true });
    return mcpHttp.start();
  });
  ipcMain.handle('app:mcp-http-stop', async () => {
    mcpHttp.setWanted(false);
    mcpHttp.clearError();
    await writePrefs({ mcpHttp: false });
    return mcpHttp.stop();
  });
  // 令牌只走主进程：渲染层拿不到密文文件，明文只在内存里待一次同步
  ipcMain.handle('app:credential-available', () => credentials.available());
  ipcMain.handle('app:credential-get', (_e, provider) => credentials.get(String(provider || '')));
  ipcMain.handle('app:credential-set', (_e, provider, token) =>
    credentials.set(String(provider || ''), String(token || '')),
  );
  ipcMain.handle('app:credential-clear', (_e, provider) => credentials.clear(String(provider || '')));
  // 同步配置不涉密，直接放 JSON；这样开发版和安装版不会各存一份
  ipcMain.handle('app:config-get', () => gitConfig.read());
  ipcMain.handle('app:config-set', (_e, data) => gitConfig.write(data));
  ipcMain.handle('app:get-prefs', () => ({ closeToTray }));
  ipcMain.handle('app:set-close-to-tray', async (_e, value) => {
    closeToTray = Boolean(value);
    await writePrefs({ closeToTray });
    return closeToTray;
  });
  // 开机自启：设置页只切开关，真正的启动项由主进程写进系统
  ipcMain.handle('app:login-item', () => loginItemState());
  ipcMain.handle('app:set-login-item', async (_e, value) => {
    if (!app.isPackaged) return loginItemState();
    const enabled = Boolean(value);
    try {
      app.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: false, args: [AUTOSTART_ARG] });
      await writePrefs({ openAtLogin: enabled });
    } catch (e) {
      return {
        supported: true,
        enabled: !enabled,
        error: `设置开机启动失败：${(e && e.message) || e}`,
      };
    }
    const state = loginItemState();
    if (state.enabled !== enabled) {
      return { ...state, error: '系统没有接受这个设置，可以到系统设置的启动项里检查。' };
    }
    return state;
  });
  // 渲染层已落盘并完成（或放弃）最后一次同步，可以退出了
  ipcMain.handle('app:quit-ready', () => {
    mainQuitReady = true;
    maybeFinishQuit();
    return true;
  });
  ipcMain.handle('app:open-capture', () => showCapture());
  ipcMain.handle('app:open-note-window', (_e, id) => openNoteWindow(id));
  // AI 小应用从浮窗打开：一个应用一个独立窗口，可以和其他窗口并排
  ipcMain.handle('app:open-app-window', (_e, id, options) => openAppWindow(id, options));
  // 删除应用时把它已经打开的独立窗口一起关掉：否则窗口还留在桌面上，
  // 一刷新才发现代码已经没了。浮窗和主窗口打开的都走这一条。
  ipcMain.handle('app:close-app-windows', (_e, id) => {
    const key = String(id || '');
    if (!key) return 0;
    let closed = 0;
    for (const win of [...appWindows]) {
      if (win.isDestroyed() || appWindowIds.get(win) !== key) continue;
      win.close();
      closed += 1;
    }
    return closed;
  });
  // 独立小应用窗口的「置顶 / 最小化」：和浮窗一样从自己的标题栏控制
  ipcMain.handle('app:window-pin', (e, value) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win || win.isDestroyed()) return false;
    const pinned = Boolean(value);
    win.setAlwaysOnTop(pinned, 'floating');
    // Windows 上 setAlwaysOnTop(true) 不一定立刻抬到最前，补一次 moveTop
    if (pinned) win.moveTop();
    return win.isAlwaysOnTop();
  });
  ipcMain.handle('app:window-pinned', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    return Boolean(win && !win.isDestroyed() && win.isAlwaysOnTop());
  });
  ipcMain.handle('app:window-minimize', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win || win.isDestroyed()) return false;
    // 独立小应用窗口一律不占任务栏，系统最小化后用户点不回来；
    // 统一改成收进桌面底部的合并条，点条目就在屏幕居中放大。
    return collapseAppWindow(win);
  });
  // 从合并条展开（渲染层也会直接走 app:dock-activate）
  ipcMain.handle('app:window-expand', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    return expandAppWindow(win);
  });
  // 透明窗体没有原生最大化：自己按工作区尺寸切换，标题栏双击走这条
  ipcMain.handle('app:window-maximize', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    return toggleAppMaximize(win);
  });
  ipcMain.handle('app:window-maximized', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    return Boolean(win && !win.isDestroyed() && appMaximizedBounds.has(win));
  });
  // 透明窗体拿不到系统边缘缩放：页面里的拖拽把手自己算尺寸，这里只负责落位
  ipcMain.handle('app:window-bounds', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    return win && !win.isDestroyed() ? win.getBounds() : null;
  });
  ipcMain.handle('app:window-set-bounds', (e, rect) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win || win.isDestroyed() || !rect) return false;
    const x = Math.round(Number(rect.x));
    const y = Math.round(Number(rect.y));
    const width = Math.round(Number(rect.width));
    const height = Math.round(Number(rect.height));
    if (![x, y, width, height].every(Number.isFinite)) return false;
    win.setBounds({ x, y, width: Math.max(360, width), height: Math.max(300, height) }, false);
    return true;
  });
  // 自绘标题栏拖动：和浮窗同一套做法，按下取一次位置，之后只发绝对坐标
  ipcMain.handle('app:window-drag-start', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win || win.isDestroyed()) return null;
    const [x, y] = win.getPosition();
    return { x, y };
  });
  ipcMain.handle('app:window-drag-move', (e, pos) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win || win.isDestroyed()) return false;
    const x = Math.round(Number(pos && pos.x));
    const y = Math.round(Number(pos && pos.y));
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    // 只兜底保证标题栏还抓得到，不做贴边吸附
    const rect = win.getBounds();
    const area = screen.getDisplayMatching({ ...rect, x, y }).workArea;
    const nextX = Math.min(Math.max(x, area.x - rect.width + 160), area.x + area.width - 160);
    const nextY = Math.min(Math.max(y, area.y), area.y + area.height - 48);
    win.setPosition(nextX, nextY, false);
    return true;
  });
  // 合并条：条目列表 / 按内容收紧 / 点条目放大 / 关闭某个应用
  ipcMain.handle('app:dock-items', () => dockItems());
  ipcMain.handle('app:dock-resize', (e, size) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win || win.isDestroyed() || win !== dockWindow || !size) return false;
    placeDock(win, size.width, size.height);
    return true;
  });
  ipcMain.handle('app:dock-activate', (_e, token) => {
    const win = collapsedWindowByToken(Number(token));
    return expandAppWindow(win);
  });
  ipcMain.handle('app:dock-close', (_e, token) => {
    const win = collapsedWindowByToken(Number(token));
    if (!win) return false;
    win.close();
    return true;
  });
  // 合并条可以拖到不遮住内容的位置：和浮窗一样自己发 IPC，松手后把位置记进 prefs
  ipcMain.handle('app:dock-drag-start', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win || win.isDestroyed() || win !== dockWindow) return null;
    const [x, y] = win.getPosition();
    return { x, y };
  });
  ipcMain.handle('app:dock-drag-move', (e, pos) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win || win.isDestroyed() || win !== dockWindow || !pos) return false;
    const x = Math.round(Number(pos.x));
    const y = Math.round(Number(pos.y));
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    const { width: w, height: h } = win.getBounds();
    const area = screen.getDisplayMatching({ x, y, width: w, height: h }).workArea;
    // 左右至少留 80px 在屏幕内，别拖丢了；高度完整可见
    const nextX = Math.min(Math.max(x, area.x - w + 80), area.x + area.width - 80);
    const nextY = Math.min(Math.max(y, area.y), area.y + area.height - h);
    win.setPosition(nextX, nextY, false);
    dockPos = { x: nextX, y: nextY };
    return true;
  });
  ipcMain.handle('app:dock-drag-end', () => {
    if (!dockPos) return false;
    void writePrefs({ dockPos });
    return true;
  });
  // 独立窗口是普通不透明窗（要保留边缘缩放），CSS opacity 只会让内容变淡、
  // 透不出桌面。这里用系统窗口透明度，才能真正像浮窗一样看到后面的内容。
  ipcMain.handle('app:window-opacity', (e, value) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win || win.isDestroyed()) return false;
    const n = Number(value);
    if (!Number.isFinite(n)) return false;
    win.setOpacity(Math.min(1, Math.max(0.2, n)));
    return win.getOpacity();
  });
  // 桌面浮窗：隐藏而不是销毁，再次打开能秒回上次的滚动位置与输入
  // 返回 {ok, reason}，让设置页在「上锁了 / 打不开」时给出原因，而不是点了没反应
  ipcMain.handle('card:open', () => {
    // 只有 showCard 明确返回 false（当前就是密码锁锁定）才算 locked；
    // 首次创建窗口没有返回值的旧逻辑会把成功误报成「应用已上锁」。
    const ok = showCard() !== false;
    return { ok, reason: ok ? '' : 'locked' };
  });
  // 标题栏按钮 / 热键走真正的「开关」：只有浮窗确实在前台（或早已稳定显示）才收起。
  // 旧逻辑只看 isVisible：用户点开后没看到窗口、再点一次反而把它藏起来，看起来
  // 就像「怎么点都不打开」。现在刚显示后的宽限期内再点只会重新叫到最前面。
  ipcMain.handle('card:toggle', () => {
    const win = cardWindow;
    const visible = Boolean(win && !win.isDestroyed() && win.isVisible());
    const hideNow = visible && (win.isFocused() || Date.now() - cardRevealedAt > CARD_REVEAL_GRACE);
    if (hideNow) {
      win.hide();
      return { ok: true, visible: false, reason: '' };
    }
    const ok = showCard() !== false;
    const shown = Boolean(cardWindow && !cardWindow.isDestroyed() && cardWindow.isVisible());
    return { ok, visible: ok && shown, reason: ok ? '' : 'locked' };
  });
  // 全局热键被其它软件占用时，设置页要能如实说明，而不是让用户以为快捷键坏了
  ipcMain.handle('app:card-hotkey', () => ({ shortcut: 'Control+Alt+D', taken: cardHotkeyTaken }));
  ipcMain.handle('card:hide', () => {
    if (cardWindow && !cardWindow.isDestroyed()) cardWindow.hide();
    return true;
  });
  // 设置页的开关要跟真实窗口状态一致，不能只看本地记的「上次点过」
  ipcMain.handle('card:is-open', () => Boolean(cardWindow && !cardWindow.isDestroyed() && cardWindow.isVisible()));
  // 浮窗右下角把手 / 收起成一条：尺寸由渲染层算好，这里只做范围兜底
  ipcMain.handle('card:resize', (_e, size) => {
    const win = cardWindow;
    if (!win || win.isDestroyed()) return false;
    const width = Math.round(Number(size && size.width));
    const height = Math.round(Number(size && size.height));
    if (!Number.isFinite(width) || !Number.isFinite(height)) return false;
    // 宽度下限 260：收成一条时页面会把宽度一起收窄
    const { width: w, height: h } = cardPlacement.normalizeSize(width, height);
    const [cw, ch] = win.getContentSize();
    if (cw === w && ch === h) return true;
    // 贴着右 / 下边放大时，先按新尺寸把窗口挪回来，否则缩放把手会跑出屏幕
    const [px, py] = win.getPosition();
    const fitted = cardPlacement.fitRect(
      { x: px, y: py, width: w, height: h },
      cardWorkArea({ x: px, y: py, width: w, height: h }),
    );
    if (fitted.x !== px || fitted.y !== py) win.setPosition(fitted.x, fitted.y, false);
    win.setContentSize(fitted.width, fitted.height, false);
    // 原生 resize 事件不一定来，这里主动记尺寸；展开 / 收成一条都能沿用
    saveCardBounds();
    return true;
  });
  // 浮窗默认不置顶；图钉按钮切换后立刻生效，并写进偏好，下次打开沿用
  ipcMain.handle('card:get-pinned', () => cardPinned);
  ipcMain.handle('card:set-pinned', (_e, value) => {
    cardPinned = Boolean(value);
    const win = cardWindow;
    if (win && !win.isDestroyed()) {
      win.setAlwaysOnTop(cardPinned, 'floating');
      // Windows 上 setAlwaysOnTop(true) 不一定立刻抬到最前，补一次 moveTop
      if (cardPinned) win.moveTop();
    }
    void writePrefs({ cardPinned });
    return cardPinned;
  });
  // 自绘标题栏拖动：渲染层按下时取一次窗口位置，之后只发绝对坐标。
  // 不用 -webkit-app-region: drag，是因为拖拽区会被 Chromium 当成非客户区，
  // 鼠标移进去时页面收不到 hover，顶部就会退回透明。
  ipcMain.handle('card:drag-start', () => {
    const win = cardWindow;
    if (!win || win.isDestroyed()) return null;
    const [x, y] = win.getPosition();
    return { x, y };
  });
  ipcMain.handle('card:drag-move', (_e, pos) => {
    const win = cardWindow;
    if (!win || win.isDestroyed()) return false;
    const x = Math.round(Number(pos && pos.x));
    const y = Math.round(Number(pos && pos.y));
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    // 完全跟手：不吸边、不做动画。只兜底限制位置，保证标题栏始终还抓得到，
    // 免得拖到屏幕外之后用户没法把鼠标移过去找回来。
    const rect = win.getBounds();
    rect.x = x;
    rect.y = y;
    const next = cardPlacement.keepReachable(rect, cardWorkArea(rect));
    win.setPosition(next.x, next.y, false);
    return { x: next.x, y: next.y };
  });
  // 松手：不做任何吸附，直接记住当前位置（不等 moved 防抖）
  ipcMain.handle('card:drag-end', () => {
    const win = cardWindow;
    if (!win || win.isDestroyed()) return null;
    flushCardBounds();
    const [x, y] = win.getPosition();
    return { x, y };
  });
  ipcMain.handle('card:changed', () => {
    // 浮窗写了任务 / 灵感：主窗口若已加载这两库，会重新读盘并标记待同步
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('card:changed');
    return true;
  });
  ipcMain.handle('card:refresh', () => {
    if (cardWindow && !cardWindow.isDestroyed()) cardWindow.webContents.send('card:refresh');
    return true;
  });
  ipcMain.handle('app:show-main', () => {
    showMain();
    return true;
  });
  // 浮窗的快捷入口：打开主窗口并导航到首页 / 指定笔记本 / 智能视图
  ipcMain.handle('app:open-main', (_e, target) => {
    const payload = target && typeof target === 'object' ? target : null;
    showMain();
    if (payload) sendToMain('app:main-target', payload);
    return true;
  });
  // 右键菜单的粘贴：Electron 的 navigator.clipboard.read() 在部分内核上读不到
  // text/html，这里用主进程 Clipboard 直接取，保证「粘贴」和 Ctrl+V 拿到同一份内容。
  ipcMain.handle('clipboard:read', () => {
    const text = clipboard.readText() || '';
    const html = clipboard.readHTML() || '';
    const files = [];
    // 只有没有文字 / HTML 时才当作图片，避免和 HTML 里的 <img> 重复插入
    if (!text && !html) {
      const image = clipboard.readImage();
      if (image && !image.isEmpty()) {
        files.push({
          name: '粘贴图片.png',
          type: 'image/png',
          data: image.toPNG().toString('base64'),
        });
      }
    }
    return { text, html, files };
  });
  // 渲染层上锁 / 解锁时同步给主进程：锁着的时候热键也不该把待办浮窗叫出来
  ipcMain.handle('app:set-locked', (_e, value) => {
    cardLocked = Boolean(value);
    // 主窗口还开着时上锁（手动上锁 / 离开自动锁）：浮窗照旧收起来。
    // 主窗口已经收进托盘才上锁时，浮窗不关，改成锁定态——窗口留在桌面上，
    // 待办和灵感的内容不再显示。
    const mainVisible = Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible());
    if (cardLocked) {
      if (cardWindow && !cardWindow.isDestroyed()) {
        if (mainVisible) {
          cardWindow.hide();
        } else if (cardWindow.isVisible() && !cardWindow.webContents.isDestroyed()) {
          cardWindow.webContents.send('card:lock');
        }
      }
      // 小应用窗口也跟着上锁：桌面上不留下应用内容，解锁后再放回来
      for (const w of appWindows) {
        if (!w.isDestroyed() && w.isVisible()) {
          appWindowsHiddenByLock.add(w);
          w.hide();
        }
      }
      // 合并条上写着应用名，锁上后也一起藏起来；上锁期间新收起的应用不再弹出合并条
      dockHiddenByLock = true;
      if (dockWindow && !dockWindow.isDestroyed()) dockWindow.hide();
      // 提醒浮层上有待办标题：锁上后立刻换成只显示条数的版本，不能留着标题
      if (reminderWindow && !reminderWindow.isDestroyed() && reminderWindow.isVisible() && lastReminderCount > 0) {
        showReminder([
          {
            id: '',
            title: lastReminderCount === 1 ? '有 1 条待办到时间了' : `有 ${lastReminderCount} 条待办到时间了`,
            meta: '应用已锁定，解锁后查看详情',
          },
        ]);
      } else {
        hideReminderWindow();
      }
    } else {
      // 解锁后让浮窗退出锁定态：窗口一直留着，主窗口解锁后应该马上能继续用
      if (cardWindow && !cardWindow.isDestroyed() && !cardWindow.webContents.isDestroyed()) {
        cardWindow.webContents.send('card:unlock');
      }
      // 上锁时藏起来的小应用窗口原样放回桌面（收进合并条的仍留在合并条上）
      for (const w of appWindowsHiddenByLock) {
        if (!w.isDestroyed()) w.show();
      }
      appWindowsHiddenByLock.clear();
      // 合并条也放回桌面；没有收起的应用时 updateDock 会把它藏掉
      dockHiddenByLock = false;
      if (collapsedApps.size) updateDock();
      if (reminderGeneric) {
        // 解锁后，上锁时那条汇总提醒就没有意义了；喊主窗口把具体待办补弹一次，
        // 不然用户只看到过「有 N 条待办到时间了」，解锁后反而什么都没有
        hideReminderWindow();
        if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
          mainWindow.webContents.send('reminder:replay');
        }
      }
    }
    // 上次退出时浮窗开着：主窗口此时已经报过真实锁状态，解锁了才放回来。
    // 稍等一拍，避免主窗口首屏还没画出来，浮窗就先压上去抢注意力。
    if (cardRestorePending && !cardLocked) {
      setTimeout(() => {
        if (!cardRestorePending || cardLocked) return;
        showCard({ focus: false });
      }, 900);
    }
    return true;
  });
  // 桌面右下角提醒浮层：显示 / 收起 / 按内容高度贴边
  ipcMain.handle('reminder:show', (_e, items) => showReminder(items));
  ipcMain.handle('reminder:hide', () => {
    hideReminderWindow();
    return true;
  });
  ipcMain.handle('reminder:resize', (_e, height) => {
    placeReminderWindow(height);
    return true;
  });
  // 浮层里的按钮不直接改数据：转给主窗口，沿用它原本的完成 / 延后逻辑
  ipcMain.handle('reminder:action', (_e, payload) => {
    const action = String((payload && payload.action) || '');
    const id = String((payload && payload.id) || '');
    hideReminderWindow();
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('reminder:action', { action, id });
    }
    return true;
  });
  ipcMain.handle('app:notify', (_e, payload) => {
    if (!Notification.isSupported()) return false;
    const title = String((payload && payload.title) || '萤光笔记');
    const body = String((payload && payload.body) || '');
    const note = new Notification({
      title,
      body,
      icon: path.join(ASSETS, process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    });
    liveNotifications.add(note);
    note.on('click', () => {
      liveNotifications.delete(note);
      showMain();
      // 通知带 action 时回到对应位置：生成器回到对应会话，小应用优先聚焦它的独立窗口
      const action = String((payload && payload.action) || '');
      if (action.startsWith('builder:')) {
        sendToMain('app:builder-focus', action.slice('builder:'.length));
      } else if (action.startsWith('app:')) {
        const id = action.slice('app:'.length);
        const target = [...appWindows].find((w) => !w.isDestroyed() && appWindowIds.get(w) === id);
        if (target) {
          if (target.isMinimized()) target.restore();
          target.show();
          target.focus();
          target.moveTop();
        } else {
          sendToMain('app:notify-focus', id);
        }
      }
    });
    note.on('close', () => liveNotifications.delete(note));
    note.show();
    return true;
  });
  // 独立窗口已经落盘，可以关了
  ipcMain.handle('app:note-close-ready', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (win && !win.isDestroyed()) {
      forceClose.add(win);
      win.close();
    }
    return true;
  });
  // 退出前：独立窗口报告「已经写完」
  ipcMain.handle('app:note-flush-ready', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (win) noteFlushPending.delete(win.id);
    maybeFinishQuit();
    return true;
  });
  ipcMain.handle('capture:close', () => {
    if (captureWindow && !captureWindow.isDestroyed()) captureWindow.close();
  });
  ipcMain.handle('capture:saved', (_e, info) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('capture:saved', info || {});
    }
    if (captureWindow && !captureWindow.isDestroyed()) captureWindow.close();
    return true;
  });
  ipcMain.handle('app:check-update', () => checkUpdate());
  ipcMain.handle('app:update-ignore', (_e, version) => ignoreUpdateVersion(version));
  ipcMain.handle('app:update-info', async () => ({
    version: lastAvailableVersion,
    ignored: String((await readPrefs()).ignoredUpdateVersion || ''),
    downloaded: updateDownloaded,
  }));
  ipcMain.handle('app:download-update', () => downloadUpdate());
  ipcMain.handle('app:install-update', () => installUpdate());
  // 渲染层兜底错误页里的「重置应用」：与主进程白屏对话框走同一条路径
  ipcMain.handle('app:reset', (_e, reason) => requestAppReset(reason || 'renderer'));
}

function toPlainStat(stat) {
  return {
    isDirectory: stat.isDirectory(),
    isFile: stat.isFile(),
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
    mode: stat.mode,
    ino: stat.ino,
  };
}

/** 写标记并重启：下次启动会把损坏的 userData 整体挪走（见 consumeResetFlag） */
function requestAppReset(reason) {
  try {
    fs.writeFileSync(
      path.join(app.getPath('appData'), RESET_FLAG),
      `${new Date().toISOString()} ${reason || ''}\n`,
      'utf8',
    );
  } catch (e) {
    logFile.write('app', 'error', `无法写入重置标记：${(e && e.message) || e}`);
    return false;
  }
  logFile.write('app', 'warn', `重置应用（${reason || '未知原因'}）：清空本机设置后重启，笔记不受影响`);
  logFile.flushSync();
  isQuitting = true;
  app.relaunch();
  app.exit(0);
  return true;
}

/**
 * 主窗口加载失败 / 超时：
 * - 第一次自动清掉 Chromium 缓存并重载（最常见的白屏原因就是缓存或 profile 损坏）；
 * - 再失败就弹原生对话框，给「重置应用并重启」这个一步到位的出口。
 * 用原生对话框是因为这时渲染层本身可能起不来，不能依赖 React。
 */
async function showLoadFailure(win, detail) {
  if (loadFailureDialogShown) return;
  loadFailureDialogShown = true;
  if (win && !win.isDestroyed() && !win.isVisible()) win.show();

  // 开发模式的界面来自 Vite（localhost:5174），最常见的是开发服务器没在跑。
  // 这时「重置应用」既治不好问题，还会白清设置，所以改成提示 + 重新加载。
  if (isDev) {
    const devDetail =
      `${detail || '页面没有加载出来'}\n\n` +
      '当前是开发模式，界面从 http://localhost:5174 加载。\n' +
      '请确认 Vite 开发服务器正在运行（npm run electron:dev，或另开终端 npm run dev），然后点「重新加载」。\n' +
      '这里不会清理任何设置或笔记。';
    const result = await dialog.showMessageBox(win && !win.isDestroyed() ? win : undefined, {
      type: 'error',
      title: '萤光笔记没能打开',
      message: '开发服务器没有响应',
      detail: devDetail,
      buttons: ['重新加载', '打开日志目录', '退出'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    });
    if (result.response === 0) {
      loadFailureDialogShown = false;
      if (win && !win.isDestroyed()) loadRenderer(win);
      else createWindow();
      return;
    }
    if (result.response === 1) {
      try {
        await fsp.mkdir(logFile.logDir(), { recursive: true });
        await logFile.flush();
        await shell.openPath(logFile.logDir());
      } catch {
        /* 打不开日志目录也不该拦住用户 */
      }
      loadFailureDialogShown = false;
      setTimeout(() => void showLoadFailure(win, detail), 300);
      return;
    }
    isQuitting = true;
    app.quit();
    return;
  }

  const { response } = await dialog.showMessageBox(win && !win.isDestroyed() ? win : undefined, {
    type: 'error',
    title: '萤光笔记没能打开',
    message: '界面加载失败',
    detail:
      `${detail || '页面没有加载出来'}\n\n` +
      '这通常是本机的缓存或配置文件损坏，不是笔记丢了。\n' +
      '「重置应用并重启」只会清空本机设置（同步连接、密码、偏好），不会删除笔记文件夹（设置 → 常规 → 笔记存储位置）里的内容；重置后重新连接 Git 仓库即可。\n' +
      '如果重置后仍然打不开，请重新安装应用，笔记同样不受影响。',
    buttons: ['重置应用并重启（推荐）', '打开日志目录', '退出'],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  });
  if (response === 0) {
    requestAppReset('load-failure');
    return;
  }
  if (response === 1) {
    try {
      await fsp.mkdir(logFile.logDir(), { recursive: true });
      await logFile.flush();
      await shell.openPath(logFile.logDir());
    } catch {
      /* 打不开日志目录也不该拦住用户 */
    }
    loadFailureDialogShown = false;
    setTimeout(() => void showLoadFailure(win, detail), 300);
    return;
  }
  isQuitting = true;
  app.quit();
}

/**
 * 加载失败先自救：清缓存、清代码缓存和 Service Worker，再重新加载。
 *
 * 覆盖安装后第一次启动偶尔会碰到 -2 ERR_FAILED：旧缓存/旧 Service Worker
 * 还在被 Chromium 使用，或者新文件刚落盘、杀毒软件还在扫描。直接弹重置
 * 太重了，这里先等一会儿重试两次，多数情况会自动恢复。
 */
async function recoverMainWindow(win) {
  if (mainLoadRetryCount >= 2 || !win || win.isDestroyed()) return;
  mainLoadRetryCount += 1;
  const attempt = mainLoadRetryCount;
  logFile.write('app', 'warn', `界面第 ${attempt} 次加载失败，正在清理缓存并重试`);
  try {
    await win.webContents.session.clearCache();
    await win.webContents.session.clearCodeCaches({});
    // 第二次再清 Service Worker / Cache Storage：它们也可能把旧页面拦下来
    if (attempt >= 2) {
      await win.webContents.session.clearStorageData({ storages: ['serviceworkers', 'cachestorage'] });
    }
  } catch {
    /* 清不掉也继续重载 */
  }
  if (!win.isDestroyed() && !win.isVisible()) win.show();
  setTimeout(
    () => {
      if (win.isDestroyed()) return;
      if (isDev) win.webContents.reload();
      else loadRenderer(win);
    },
    // 第一次稍等，第二次多给一点时间让杀毒扫描和新文件句柄释放
    attempt === 1 ? 1000 : 2500,
  );
}

/**
 * 开发模式下的工作区切换：不重启进程，只重建「存储绑定 + 窗口」。
 *
 * 生产环境仍用 app.relaunch()，因为这样才能彻底重建 Chromium 分区和主进程状态；
 * 但 `npm run electron:dev` 里 Vite 是 concurrently 的子进程，Electron 一退出
 * 它也会被收掉，relaunch 出来的新进程连 localhost:5174 只会 ERR_CONNECTION_REFUSED。
 */
async function softSwitchWorkspace() {
  switchingWorkspace = true;
  try {
    for (const win of BrowserWindow.getAllWindows()) {
      try {
        win.destroy();
      } catch {
        /* 单个窗口销毁失败不影响其它窗口 */
      }
    }
    noteWindows.clear();
    appWindows.clear();
    collapsedApps.clear();
    appWindowsHiddenByLock.clear();
    mainWindow = null;
    captureWindow = null;
    cardWindow = null;
    reminderWindow = null;
    dockWindow = null;
    bindWorkspaceStores();
    // 旧工作区还没落盘的日志先写回旧目录，再切换日志目标
    logFile.flushSync();
    logFile.init(workspace.dir());
    activeRepoRoot = null;
    await publishMcpRoot();
    createWindow();
    logFile.write('app', 'info', `开发模式下已切换工作区 · ${workspace.activeItem().name}`);
  } finally {
    // window-all-closed 可能在新窗口出现之后才派发，留一点缓冲再恢复
    setTimeout(() => {
      switchingWorkspace = false;
    }, 1500);
  }
}

function loadRenderer(win, query) {
  if (isDev) {
    const suffix = query ? `?${new URLSearchParams(query).toString()}` : '';
    win.loadURL(`http://localhost:5174/${suffix}`);
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'), query ? { query } : undefined);
  }
}

/**
 * 二级窗口（浮窗 / 小应用 / 单篇笔记 / 快速捕获 / 合并条 / 提醒）的加载兜底。
 *
 * 主窗口有自己的「清缓存 → 重试两次 → 兜底提示」，这些窗口以前加载失败就只剩
 * 一个空白框。根因（Service Worker 拦截 file:// 导航）已经在启动时清掉，这里再
 * 留一次重试：杀毒软件扫描新文件、磁盘刚忙完这类偶发 -2 也能自己恢复。
 */
function loadRendererWithRetry(win, query, label) {
  let retried = false;
  win.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    // -3 是主动取消（例如马上又导航到别的地址），不该重试
    if (!isMainFrame || code === -3) return;
    if (retried) {
      logFile.write('app', 'error', `${label}加载再次失败 ${code} ${desc} ${url}`);
      return;
    }
    retried = true;
    logFile.write('app', 'warn', `${label}加载失败 ${code} ${desc}，1 秒后自动重试`);
    setTimeout(() => {
      if (!win.isDestroyed()) loadRenderer(win, query);
    }, 1000);
  });
  loadRenderer(win, query);
}

/**
 * 清掉桌面端遗留的 Service Worker。
 *
 * 这是 0.1.12 及以前「浮窗 / 小应用窗口打不开、打开了也是空白」的根因：
 * web 版为了离线打开在 main.tsx 里注册了 sw.js，桌面版也会执行同一段代码，
 * 于是一个作用在 file:// 上的 Service Worker 被装进了本机配置。它拦截页面
 * 导航后对 file:// 请求拿不到响应，Chromium 记录为 -2 ERR_FAILED——主窗口有
 * 「清缓存 + 重试」能自救（每次启动先失败两次），浮窗和小应用窗口没有，就只
 * 剩下空白。桌面端现在不再注册 SW，启动时再主动清一次，升级上来的机器第一
 * 次打开就恢复，不用等主窗口走一遍自救。
 */
async function purgeDesktopServiceWorkers() {
  const parts = new Set(['']);
  const part = workspacePartition();
  if (part) parts.add(part);
  for (const name of parts) {
    try {
      const ses = name ? session.fromPartition(name) : session.defaultSession;
      await ses.clearStorageData({ storages: ['serviceworkers', 'cachestorage'] });
    } catch (err) {
      logFile.write('app', 'warn', `清理 Service Worker 失败：${(err && err.message) || err}`);
    }
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 920,
    minHeight: 600,
    backgroundColor: '#fbfbf9',
    title: '萤光笔记',
    icon: path.join(ASSETS, process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // 每个工作区一套 localStorage / IndexedDB；默认工作区留空以保留老版本的界面设置
      ...(workspacePartition() ? { partition: workspacePartition() } : {}),
      // 窗口收进托盘 / 最小化时，待办到点仍要按 20 秒的节奏检查，不能被后台节流拖到一分钟
      backgroundThrottling: false,
    },
  });

  mainWindow = win;
  mainLoadRetryCount = 0;
  mainLoadedOnce = false;
  loadFailureDialogShown = false;
  rendererCrashCount = 0;
  win.once('ready-to-show', () => win.show());

  // 渲染进程的 console 警告 / 报错也进日志文件：同步问题经常只在这里露头
  win.webContents.on('console-message', (event, level, message, line, sourceId) => {
    const detail = event && typeof event === 'object' && 'message' in event ? event : null;
    const lvl = detail ? detail.level : level;
    const text = detail ? detail.message : message;
    const from = detail ? detail.sourceId : sourceId;
    const at = detail ? detail.lineNumber : line;
    const isError = lvl === 'error' || lvl === 3 || lvl >= 3;
    const isWarn = isError || lvl === 'warning' || lvl === 2;
    if (!isWarn) return;
    // Electron 自己的开发期安全提示对排查没有帮助，别把日志刷满
    if (/Electron Security Warning/i.test(String(text || ''))) return;
    const where = from ? ` (${String(from).replace(/^.*[/\\]/, '')}:${at})` : '';
    logFile.write('renderer', isError ? 'error' : 'warn', String(text || '') + where);
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (isMainFrame === false) return;
    logFile.write('app', 'error', `页面加载失败 ${code} ${desc} ${url || ''}`);
    // -3 是主动取消（重载 / 跳转时很常见），不能当成故障
    if (code === -3 || win.isDestroyed()) return;
    if (mainLoadRetryCount < 2) void recoverMainWindow(win);
    else void showLoadFailure(win, `页面加载失败（${code} ${desc}）`);
  });
  win.webContents.on('did-finish-load', () => {
    // 新建窗口自带的 about:blank 也会触发这个事件，不能把它当成界面加载成功
    const loadedUrl = win.webContents.getURL();
    if (!loadedUrl || loadedUrl === 'about:blank') return;
    mainLoadedOnce = true;
    if (mainLoadWatchdog) {
      clearTimeout(mainLoadWatchdog);
      mainLoadWatchdog = null;
    }
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    logFile.write(
      'app',
      'error',
      `渲染进程退出：${(details && details.reason) || '?'} / ${(details && details.exitCode) || 0}`,
    );
    if (win.isDestroyed() || isQuitting) return;
    // 渲染进程崩溃后页面停在白屏，Electron 不会自己恢复；第一次直接重载，连续崩溃再走重置
    rendererCrashCount += 1;
    if (rendererCrashCount === 1) {
      setTimeout(() => {
        if (!win.isDestroyed()) win.webContents.reload();
      }, 600);
    } else {
      void showLoadFailure(win, `界面进程连续崩溃（${(details && details.reason) || '未知原因'}）`);
    }
  });

  win.on('close', (e) => {
    if (isQuitting) return;
    if (closeToTray) {
      e.preventDefault();
      win.hide();
      return;
    }
    // 设置为「关闭窗口即退出」时，也先落盘 + 同步再走
    if (requestQuitSync()) e.preventDefault();
  });
  // 关窗进托盘后要重新输密码：hide 时通知渲染层上锁（最小化不算，避免打断写作）
  win.on('hide', () => {
    if (!win.isDestroyed()) win.webContents.send('app:window-hidden');
    // 单篇窗口跟着一起藏起来：主窗口上锁后，屏幕上不该还留着别的笔记内容
    for (const w of noteWindows.values()) {
      if (!w.isDestroyed()) w.hide();
    }
    // 小应用窗口不跟着主窗口一起藏：它们和浮窗一样常驻桌面，
    // 统一由底部合并条收放；如果设了密码锁，渲染层紧接着会调
    // app:set-locked，那里再把它们和合并条一起藏起来。
    // 浮窗也不跟着主窗口一起藏：关掉主窗口后，待办浮窗还要留在桌面上。
    // 如果启用了密码锁，渲染层紧接着会调 app:set-locked，那时再把浮窗切成锁定态。
  });
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  loadRenderer(win);
  // 看门狗：不只防「加载失败」，也防「页面加载成功但脚本卡死、界面永远空白」
  const limit = isDev ? 60000 : 15000;
  mainLoadWatchdog = setTimeout(() => {
    mainLoadWatchdog = null;
    if (win.isDestroyed() || mainLoadedOnce) return;
    logFile.write('app', 'error', `界面 ${Math.round(limit / 1000)} 秒内没有加载完成`);
    if (mainLoadRetryCount < 2) void recoverMainWindow(win);
    else void showLoadFailure(win, `界面加载超时（${Math.round(limit / 1000)} 秒）`);
  }, limit);
  return win;
}

/**
 * 独立笔记窗口：同一篇笔记只开一个，再双击就聚焦原来的窗口。
 * 它和主窗口读写同一批文件，但不跑同步；关窗 / 退出前由这里等它落盘。
 */
function openNoteWindow(id) {
  const key = String(id || '').trim();
  if (!key) return false;
  const existing = noteWindows.get(key);
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore();
    existing.show();
    existing.focus();
    return true;
  }

  const win = new BrowserWindow({
    width: 980,
    height: 820,
    minWidth: 560,
    minHeight: 420,
    backgroundColor: '#fbfbf9',
    title: '萤光笔记 · 单篇',
    icon: path.join(ASSETS, process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // 每个工作区一套 localStorage / IndexedDB；默认工作区留空以保留老版本的界面设置
      ...(workspacePartition() ? { partition: workspacePartition() } : {}),
    },
  });
  noteWindows.set(key, win);
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.on('close', (e) => {
    if (isQuitting || forceClose.has(win)) return;
    // 编辑器是 0.7 秒防抖落盘，直接关会丢掉最后几个字：先问渲染层要一次落盘
    e.preventDefault();
    if (!win.webContents.isDestroyed()) win.webContents.send('note:close-request');
    setTimeout(() => {
      if (win.isDestroyed()) return;
      forceClose.add(win);
      win.close();
    }, 2500);
  });
  win.on('closed', () => {
    noteWindows.delete(key);
    noteFlushPending.delete(win.id);
    maybeFinishQuit();
  });
  loadRendererWithRetry(win, { note: key }, '单篇窗口');
  return true;
}

/**
 * 新应用窗口落在上一个应用窗口右下方 28px，避免多个窗口完全叠在一起；
 * 超出屏幕就回到左上重新开始。只影响这一次打开，不记忆每个窗口的位置。
 */
function cascadeAppBounds() {
  const last = [...appWindows].reverse().find((w) => !w.isDestroyed());
  if (!last) return null;
  const base = last.getBounds();
  const area = screen.getDisplayMatching(base).workArea;
  let x = base.x + 28;
  let y = base.y + 28;
  if (x + 920 > area.x + area.width) x = area.x + 32;
  if (y + 760 > area.y + area.height) y = area.y + 32;
  return { x, y };
}

/**
 * 浮窗小应用收成一条：窗口先藏起来（应用仍在后台运行），
 * 桌面底部的合并条上留一个入口；多个应用收起来也只用同一条。
 * 返回 true 表示确实收起来了。
 */
function collapseAppWindow(win) {
  if (!win || win.isDestroyed()) return false;
  if (collapsedApps.has(win)) return true;
  // 记下当前位置和大小，从合并条放大时按这个尺寸居中
  const b = win.getBounds();
  appExpandedBounds.set(win, b);
  const id = appWindowIds.get(win) || '';
  collapsedApps.set(win, { id });
  win.hide();
  updateDock();
  return true;
}

/** 从合并条放大：回到收起前的尺寸，在窗口原来所在的屏幕上居中显示 */
function expandAppWindow(win) {
  if (!win || win.isDestroyed()) return false;
  const b = appExpandedBounds.get(win);
  if (!b) return false;
  appExpandedBounds.delete(win);
  collapsedApps.delete(win);
  const area = screen.getDisplayMatching(b).workArea;
  const width = Math.min(b.width, area.width);
  const height = Math.min(b.height, area.height);
  win.setBounds(
    {
      x: Math.round(area.x + (area.width - width) / 2),
      y: Math.round(area.y + (area.height - height) / 2),
      width,
      height,
    },
    false,
  );
  win.show();
  win.focus();
  updateDock();
  return true;
}

/** 透明窗体不能用系统最大化：自己记住原大小，用工作区尺寸来回切 */
function toggleAppMaximize(win) {
  if (!win || win.isDestroyed()) return false;
  const normal = appMaximizedBounds.get(win);
  if (normal) {
    appMaximizedBounds.delete(win);
    win.setBounds(normal, false);
    return false;
  }
  const area = screen.getDisplayMatching(win.getBounds()).workArea;
  appMaximizedBounds.set(win, win.getBounds());
  win.setBounds(area, false);
  return true;
}

/** 合并条上的条目：token 是窗口 id，同一个应用开多个也能区分 */
function dockItems() {
  const items = [];
  for (const [win, info] of collapsedApps) {
    if (win.isDestroyed()) continue;
    items.push({ token: win.id, id: info.id });
  }
  return items;
}

function collapsedWindowByToken(token) {
  for (const win of collapsedApps.keys()) {
    if (!win.isDestroyed() && win.id === token) return win;
  }
  return null;
}

/**
 * 合并条的落点：用户拖过就沿用记下的位置（夹在当前屏幕内），
 * 没拖过就贴屏幕底部居中。宽度跟随内容，拖过之后只改宽高不动左上角。
 */
function dockBoundsFor(width, height) {
  const h = Math.max(44, Math.min(96, Math.round(Number(height) || 56)));
  const remembered = dockPos;
  const area = remembered
    ? screen.getDisplayMatching({ x: remembered.x, y: remembered.y, width: 1, height: 1 }).workArea
    : screen.getPrimaryDisplay().workArea;
  const w = Math.max(140, Math.min(Math.round(Number(width) || 0), area.width - 24));
  if (!remembered) {
    return {
      x: Math.round(area.x + (area.width - w) / 2),
      y: Math.round(area.y + area.height - h - 16),
      width: w,
      height: h,
    };
  }
  return {
    // 拖到哪就停在哪，只保证左右至少留 80px 抓得回来、高度完整可见
    x: Math.round(Math.min(Math.max(remembered.x, area.x - w + 80), area.x + area.width - 80)),
    y: Math.round(Math.min(Math.max(remembered.y, area.y), area.y + area.height - h)),
    width: w,
    height: h,
  };
}

/** prefs 里的 dockPos 只接受有限坐标，坏值当作没记过 */
function usableDockPos(value) {
  if (!value || typeof value !== 'object') return null;
  const x = Number(value.x);
  const y = Number(value.y);
  return Number.isFinite(x) && Number.isFinite(y) ? { x: Math.round(x), y: Math.round(y) } : null;
}

/** 底部合并条：所有收成一条的小应用共用这一条，点哪一项就在屏幕居中放大 */
function ensureDockWindow() {
  if (dockWindow && !dockWindow.isDestroyed()) return dockWindow;
  const bounds = dockBoundsFor(dockWidth || 220, 56);
  const win = new BrowserWindow({
    ...bounds,
    frame: false,
    // 和浮窗一样用透明窗体：圆角、阴影都交给页面，窗口本身不描边
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    title: '小应用小条 · 萤光笔记',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      ...(workspacePartition() ? { partition: workspacePartition() } : {}),
    },
  });
  dockWindow = win;
  win.setAlwaysOnTop(true, 'floating');
  win.on('closed', () => {
    if (dockWindow === win) dockWindow = null;
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  // 加载完成前发的数据会丢：这里补一次，页面挂载时也会主动取一次
  win.webContents.once('did-finish-load', () => {
    if (win.isDestroyed()) return;
    win.webContents.send('app:dock-update', dockItems());
    if (!dockHiddenByLock && collapsedApps.size) win.showInactive();
  });
  loadRendererWithRetry(win, { dock: '1' }, '合并条');
  return win;
}

/** 合并条按内容宽度贴屏幕底部居中；没有收起的应用时直接藏起来 */
function updateDock() {
  const items = dockItems();
  if (!items.length) {
    if (dockWindow && !dockWindow.isDestroyed()) dockWindow.hide();
    return;
  }
  const win = ensureDockWindow();
  if (!win || win.isDestroyed()) return;
  if (!win.webContents.isDestroyed()) win.webContents.send('app:dock-update', items);
  if (dockHiddenByLock) return;
  if (!win.isVisible()) win.showInactive();
  win.setAlwaysOnTop(true, 'floating');
}

/** 渲染层量好内容宽度后回传：窗口跟着收紧；没拖过就贴底居中，拖过就留在原地 */
function placeDock(win, width, height) {
  if (!win || win.isDestroyed()) return;
  const bounds = dockBoundsFor(width, height);
  dockWidth = bounds.width;
  win.setBounds(bounds, false);
}

/**
 * 独立小应用窗口：只有浮窗「小应用」tab 传 multiple=true，允许同一应用开多个
 * （例如两份计算器并排对照）；其它入口默认复用已开的窗口。
 * 只读 apps/<id>/ 下的元数据和 HTML，应用代码本身仍跑在沙箱 iframe 里。
 */
function openAppWindow(id, options = {}) {
  const key = String(id || '').trim();
  // 应用 id 由本应用生成，限制字符集，避免把奇怪的值带进查询参数
  if (!/^[a-zA-Z0-9_-]{1,40}$/.test(key)) return false;
  if (options?.multiple !== true) {
    const existing = [...appWindows].find((w) => !w.isDestroyed() && appWindowIds.get(w) === key);
    if (existing) {
      if (existing.isMinimized()) existing.restore();
      // 复用的是一个收进合并条的浮窗小应用：先放大，别只把藏着的窗口叫到前台
      if (collapsedApps.has(existing)) expandAppWindow(existing);
      existing.show();
      existing.focus();
      // 已有窗口被复用：这次要求置顶就顺手置顶，不新开一份
      if (options?.pinned === true) {
        existing.setAlwaysOnTop(true, 'floating');
        existing.moveTop();
      }
      return true;
    }
  }

  const win = new BrowserWindow({
    width: 920,
    height: 760,
    minWidth: 360,
    minHeight: 300,
    ...(cascadeAppBounds() || {}),
    title: '小应用 · 萤光笔记',
    icon: path.join(ASSETS, process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    // 和桌面浮窗一样去掉系统边框：窗口里已经有一套自己的标题栏
    //（置顶 / 透明度 / 最大化 / 最小化 / 关闭），再套一层原生边框就重复了。
    //
    // 使用透明窗体：四周 10px 留白、14px 圆角和投影都由页面画，桌面直接透出来，
    // 不再用窗口底色铺一圈白边。0.1.12 曾因「窗口显示但内容空白」改成不透明，
    // 根因是 Service Worker 拦截 file:// 导航（0.1.13 已修），这里恢复透明。
    // 原生边缘缩放依旧关掉，改用页面里的拖拽把手 + app:window-set-bounds。
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    // 系统方影会沿矩形窗口画一圈，和圆角对不上；投影交给 CSS box-shadow
    hasShadow: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    autoHideMenuBar: true,
    // 不占任务栏：窗口被挡住时从浮窗「小应用」tab 或主窗口入口再打开一次即可；
    // 最小化 / Win+↓ 仍照常收进底部合并条，合并条就是它的常驻入口。
    skipTaskbar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // 每个工作区一套 localStorage / IndexedDB；默认工作区留空以保留老版本的界面设置
      ...(workspacePartition() ? { partition: workspacePartition() } : {}),
      // 计算器、番茄钟这类应用即使窗口在后台也要按真实时间走，不能被节流拖慢
      backgroundThrottling: false,
    },
  });
  appWindowIds.set(win, key);
  appWindows.add(win);
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.on('closed', () => {
    appWindowIds.delete(win);
    appWindows.delete(win);
    appWindowsHiddenByLock.delete(win);
    collapsedApps.delete(win);
    appExpandedBounds.delete(win);
    appMaximizedBounds.delete(win);
    updateDock();
  });
  // 系统级最小化（Win + ↓ 等）也不能让小应用消失：它没有任务栏图标，
  // 藏下去就找不回来了，所以立刻还原再收进合并条。
  win.on('minimize', () => {
    if (win.isDestroyed()) return;
    setTimeout(() => {
      if (win.isDestroyed()) return;
      if (win.isMinimized()) win.restore();
      collapseAppWindow(win);
    }, 0);
  });
  // pinned=1 让渲染层一进来就把图钉显示为选中，和窗口真实置顶状态一致。
  // 不能复用 card=1：那是浮窗自己的路由标记，会把这个窗口渲染成浮窗面板。
  const query = { app: key };
  if (options?.pinned === true) query.pinned = '1';
  loadRendererWithRetry(win, query, '小应用窗口');

  // 等新窗口真正显示后再 resolve：从主窗口面板图钉过来时，调用方要等这个
  // 结果才收掉旧面板。先关面板再等新窗口加载会留出一段空白，看起来就像
  // 「闪一下重新打开」。加载失败 / 窗口被提前关掉时 resolve(false)；超时
  // 兜底 resolve(true)，避免旧面板一直挂着不消失。
  return new Promise((resolve) => {
    let settled = false;
    let revealed = false;
    let revealTimer = null;
    const finish = (visible) => {
      if (settled) return;
      settled = true;
      if (revealTimer) clearTimeout(revealTimer);
      resolve(visible);
    };
    /*
     * 部分 Windows 显卡驱动 / 远程桌面下 ready-to-show 可能不来，窗口就一直停在
     * show:false，表现就是「首页点小应用没反应」。和桌面浮窗一样多留几个显示时机，
     * 谁先到谁显示。
     */
    const reveal = (why) => {
      if (revealed || win.isDestroyed()) return;
      revealed = true;
      // show() 在 Windows 上仍可能被最大化主窗口挡住：先临时置顶，再压几秒。
      // 原来 800ms 就恢复普通层级，用户还没看到就被盖回去，和「没打开」一样。
      win.setAlwaysOnTop(true, 'floating');
      win.show();
      win.moveTop();
      win.focus();
      if (options?.pinned !== true) {
        let released = false;
        const release = () => {
          if (released) return;
          released = true;
          if (!win.isDestroyed()) win.setAlwaysOnTop(false);
        };
        win.once('blur', release);
        setTimeout(release, 5000);
      }
      logFile.write('app', 'info', `小应用窗口已显示：${query.app}（${why}）`);
      finish(true);
    };
    // 兜底：页面迟迟没有首帧也必须把窗口交到用户手上
    revealTimer = setTimeout(() => reveal('兜底计时到点'), 1500);
    win.once('ready-to-show', () => reveal('首帧就绪'));
    win.webContents.once('did-finish-load', () => setTimeout(() => reveal('页面加载完成'), 60));
    win.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
      if (!isMainFrame) return;
      logFile.write('app', 'error', `小应用页面加载失败 ${code} ${desc} ${url}`);
      reveal('加载失败，先显示出来并写日志');
    });
    win.once('closed', () => finish(false));
  });
}

/**
 * 给主窗口发一条消息。窗口刚创建时还在加载，等 did-finish-load 再发，
 * 否则浮窗点「首页 / 笔记本」时导航请求会掉在加载完成之前。
 */
function sendToMain(channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
  const send = () => {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
    mainWindow.webContents.send(channel, payload);
  };
  if (mainWindow.webContents.isLoading()) {
    // 再等一拍，让渲染层的 onMainTarget 订阅先挂好
    mainWindow.webContents.once('did-finish-load', () => setTimeout(send, 60));
  } else {
    send();
  }
}

function showMain() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function showCapture() {
  if (captureWindow && !captureWindow.isDestroyed()) {
    captureWindow.show();
    captureWindow.focus();
    return;
  }
  const win = new BrowserWindow({
    width: 520,
    height: 300,
    resizable: false,
    maximizable: false,
    minimizable: false,
    frame: false,
    show: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    title: '快速捕获 · 萤光笔记',
    backgroundColor: '#fbfbf9',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // 每个工作区一套 localStorage / IndexedDB；默认工作区留空以保留老版本的界面设置
      ...(workspacePartition() ? { partition: workspacePartition() } : {}),
    },
  });

  captureWindow = win;
  win.setAlwaysOnTop(true, 'floating');
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => {
    if (captureWindow === win) captureWindow = null;
  });
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.key === 'Escape') win.close();
  });
  loadRendererWithRetry(win, { capture: '1' }, '快速捕获');
}

/** 位置变化很密（拖动 / 缩放），攒 400ms 再落盘，避免每帧都写文件 */
function saveCardBounds() {
  if (cardBoundsTimer) clearTimeout(cardBoundsTimer);
  cardBoundsTimer = setTimeout(flushCardBounds, 400);
}

/** 关窗、隐藏、拔屏这种「马上就走」的时机不能等防抖，立刻写一次 */
function flushCardBounds() {
  if (cardBoundsTimer) {
    clearTimeout(cardBoundsTimer);
    cardBoundsTimer = null;
  }
  if (!cardWindow || cardWindow.isDestroyed()) return;
  cardBounds = cardWindow.getBounds();
  void writePrefs({ cardBounds });
}

/**
 * 桌面浮窗：无边框小卡片，看今天的待办、勾完成、随手记灵感。
 * 默认不置顶，避免一打开就盖住别的软件；用户点图钉后才常驻最上层。
 * 只保留一个实例；关掉只是隐藏，下次用快捷键打开时状态还在。
 */
/** 浮窗显示/隐藏时通知主窗口：设置页的开关和 Ctrl+Alt+D 才能保持一致 */
function notifyCardVisible(visible) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('card:visibility', Boolean(visible));
  }
}

/**
 * 把浮窗真正摆到用户眼前。
 * 无边框窗口如果只是 show()，在 Windows 上可能被主窗口盖住（后台进程拿不到前台权），
 * 用户看到的就是「点了没反应」。先临时置顶再恢复原状，能稳定把它抬上来。
 */
/** 未置顶时临时压在其它窗口上方，松手的时机：浮窗失焦（用户点去别处）或超时 */
let cardHoldTopTimer = null;
let cardHoldTopRelease = null;

function holdCardOnTop(win) {
  if (!win || win.isDestroyed() || cardPinned) return;
  // 先清掉上一次还没结束的临时置顶，避免多个定时器互相打架
  if (cardHoldTopTimer) {
    clearTimeout(cardHoldTopTimer);
    cardHoldTopTimer = null;
  }
  if (cardHoldTopRelease) {
    win.removeListener('blur', cardHoldTopRelease);
    cardHoldTopRelease = null;
  }
  win.setAlwaysOnTop(true, 'floating');
  const release = () => {
    if (cardHoldTopTimer) {
      clearTimeout(cardHoldTopTimer);
      cardHoldTopTimer = null;
    }
    cardHoldTopRelease = null;
    if (!win.isDestroyed() && !cardPinned) win.setAlwaysOnTop(false);
  };
  cardHoldTopRelease = release;
  // 用户点到别处就恢复「不置顶」，不用一直压在其它软件上面。
  // 但至少保持 5 秒：主窗口仍在前台时，0.8 秒就取消会被重新盖住，
  // 看起来就像「点了打开浮窗却什么都没出现」。
  win.once('blur', release);
  if (cardHoldTopTimer) clearTimeout(cardHoldTopTimer);
  cardHoldTopTimer = setTimeout(release, 5000);
}

/** 打开 / 收起时同步偏好；关窗、退出不要反复写同一份文件 */
function setCardOpen(open) {
  if (cardOpen === open) return;
  cardOpen = open;
  void writePrefs({ cardOpen: open });
}

function revealCardWindow(win, { focus = true } = {}) {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  cardRevealedAt = Date.now();
  // 启动恢复用 showInactive：窗口放到桌面上，但不把用户正在输入的主窗口抢走焦点
  if (focus) {
    win.show();
    win.focus();
  } else {
    win.showInactive();
  }
  win.moveTop();
  setCardOpen(true);
  if (cardPinned) {
    win.setAlwaysOnTop(true, 'floating');
    win.moveTop();
  } else {
    holdCardOnTop(win);
  }
  // 极少数显卡驱动下首次 show 不绘制：稍后再抬一次，确保窗口真的到了用户眼前
  setTimeout(() => {
    if (win.isDestroyed() || !win.isVisible()) return;
    if (cardPinned) {
      win.setAlwaysOnTop(true, 'floating');
      win.moveTop();
    } else {
      holdCardOnTop(win);
    }
  }, 300);
}

function showCard({ focus = true } = {}) {
  if (cardLocked) {
    logFile.write('app', 'warn', '应用已上锁，浮窗保持关闭');
    return false;
  }
  // 用户自己点了入口，就不必再等启动恢复的那次
  cardRestorePending = false;
  if (cardWindow && !cardWindow.isDestroyed()) {
    const win = cardWindow;
    revealCardWindow(win, { focus });
    if (!win.webContents.isDestroyed()) {
      // 上次渲染进程崩过：重载一次再刷新，免得复用一个空白窗口
      if (cardCrashed) {
        cardCrashed = false;
        win.webContents.reload();
      } else {
        win.webContents.send('card:refresh');
      }
    }
    logFile.write('app', 'info', '浮窗已显示（复用已有窗口）');
    return true;
  }

  // 启动时已经校验过；运行期间可能换过屏幕，打开前再收一次，别在旧坐标上弹出来
  const bounds = fitCardRect(cardBounds || defaultCardBounds());
  const win = new BrowserWindow({
    ...bounds,
    // 宽度下限按「收成一条」的 260 给；展开态的 300 下限由页面里的拖拽把手保证
    minWidth: 260,
    // 下限按「收成一条」的高度给，展开态的 320 下限由页面里的拖拽把手保证
    minHeight: 56,
    maxWidth: 760,
    maxHeight: 1000,
    frame: false,
    // 透明窗体：卡片四周的 14px 留白、16px 圆角都交给页面 CSS 画，桌面上只剩
    // 一张悬浮卡片，没有窗口底色拼出来的灰边。0.1.12 曾因「窗口画不出来」改成
    // 不透明，后来定位到真正原因是 Service Worker 拦了 file:// 导航（0.1.13 已修），
    // 透明窗体本身没有问题，这里恢复透明。
    transparent: true,
    backgroundColor: '#00000000',
    // 透明窗体的系统投影会沿矩形窗口边画出一圈方影，和圆角卡片对不上，关掉；
    // 卡片自己的投影由 CSS box-shadow 负责。
    hasShadow: false,
    // 原生边框仍会吞掉右下角的鼠标事件，缩放手感也不稳；
    // 统一交给页面里的拖拽把手 + card:resize 处理，原生 resize 关掉。
    resizable: false,
    maximizable: false,
    // 不在任务栏占位，浮窗只通过托盘 / 标题栏图标 / Ctrl+Alt+D 唤出与收起；
    // 窗口被挡住时按热键会重新叫到最前。
    minimizable: false,
    fullscreenable: false,
    alwaysOnTop: cardPinned,
    skipTaskbar: true,
    show: false,
    title: '待办浮窗 · 萤光笔记',
    // 任务栏按钮用应用自己的图标，和主窗口保持一组
    icon: path.join(ASSETS, process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // 每个工作区一套 localStorage / IndexedDB；默认工作区留空以保留老版本的界面设置
      ...(workspacePartition() ? { partition: workspacePartition() } : {}),
      // 浮窗常年置顶不聚焦，拖拽缩放靠 rAF 节奏，不能被后台节流拖慢
      backgroundThrottling: false,
    },
  });
  cardWindow = win;
  cardCrashed = false;
  win.on('show', () => notifyCardVisible(true));
  win.on('hide', () => {
    // 收起时立刻记下位置，不能等防抖——用户可能收完就直接退出了
    flushCardBounds();
    // 退出过程中窗口也会 hide，那不是用户收起，下次启动还得照常放回来
    if (!isQuitting) setCardOpen(false);
    notifyCardVisible(false);
  });
  if (cardPinned) win.setAlwaysOnTop(true, 'floating');
  win.setMenuBarVisibility(false);

  /*
   * 显示时机不能只等 ready-to-show：在部分 Windows 显卡驱动 / 远程桌面下首帧事件
   * 可能不来，窗口就一直停在 show:false，表现就是「浮窗打不开」。
   * 这里三个时机谁先到谁显示，并各写一条日志，方便用户把日志发回来定位。
   */
  let revealed = false;
  let revealTimer = null;
  const reveal = (why) => {
    if (revealed || win.isDestroyed()) return;
    revealed = true;
    if (revealTimer) {
      clearTimeout(revealTimer);
      revealTimer = null;
    }
    revealCardWindow(win, { focus });
    if (!win.webContents.isDestroyed()) win.webContents.send('card:refresh');
    logFile.write('app', 'info', `浮窗已显示（${why}）`);
    // 用户反馈「显示成功但看不到」时，这条能区分「系统判定不可见」和
    // 「窗口在但位置/尺寸不对」，比只有一句「已显示」好定位
    setTimeout(() => {
      if (win.isDestroyed()) return;
      const b = win.getBounds();
      logFile.write(
        'app',
        'info',
        `浮窗状态：visible=${win.isVisible()} 位置 ${b.x},${b.y} 尺寸 ${b.width}×${b.height}`,
      );
    }, 600);
  };
  // 兜底：页面迟迟没有首帧也必须把窗口交到用户手上，不能静默失败
  revealTimer = setTimeout(() => reveal('兜底计时到点'), 1500);
  win.once('ready-to-show', () => reveal('首帧就绪'));
  win.webContents.once('did-finish-load', () => {
    // 等一拍再显示，尽量避开「窗口先出现、内容还是空」的一闪
    setTimeout(() => reveal('页面加载完成'), 60);
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame) return;
    logFile.write('app', 'error', `浮窗页面加载失败 ${code} ${desc} ${url}`);
    reveal('加载失败，先显示出来并写日志');
  });
  // 渲染进程崩溃时先自动重载，而不是直接把窗口藏起来：用户刚点了浮窗，
  // 窗口一消失就又会以为「打不开」。连续崩两次才放弃，避免无限重载。
  let crashReloads = 0;
  win.webContents.on('render-process-gone', (_e, details) => {
    cardCrashed = true;
    crashReloads += 1;
    logFile.write('app', 'error', `浮窗渲染进程退出：${(details && details.reason) || '未知原因'}（第 ${crashReloads} 次）`);
    if (win.isDestroyed()) return;
    if (crashReloads > 2) {
      win.hide();
      return;
    }
    setTimeout(() => {
      if (win.isDestroyed()) return;
      cardCrashed = false;
      win.webContents.reload();
      win.show();
    }, 400);
  });
  win.on('moved', saveCardBounds);
  // 原生缩放被关掉了，'resized' 在部分平台上不会触发；尺寸落盘由 card:resize 负责
  win.on('resized', saveCardBounds);
  win.on('close', flushCardBounds);
  win.on('closed', () => {
    if (revealTimer) clearTimeout(revealTimer);
    if (cardWindow === win) cardWindow = null;
    if (!isQuitting) setCardOpen(false);
    notifyCardVisible(false);
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  loadRendererWithRetry(win, { card: '1' }, '浮窗');
  return true;
}

/**
 * 快捷键是开关。浮窗在前台时立刻收起；只是 isVisible、其实被挡住或刚显示还没
 * 让用户看到时，再按一次是叫到最前面，而不是收起来让人以为热键失效。
 */
function toggleCard() {
  const win = cardWindow;
  if (!win || win.isDestroyed()) {
    showCard();
    return;
  }
  const visible = win.isVisible();
  if (visible && (win.isFocused() || Date.now() - cardRevealedAt > CARD_REVEAL_GRACE)) {
    win.hide();
    return;
  }
  showCard();
}

const REMINDER_WIDTH = 368;
const REMINDER_MARGIN = 20;

/**
 * 提醒浮层贴在「鼠标所在那块屏幕」的右下角。
 * 用鼠标所在屏而不是主屏，副屏上工作时提醒才不会跑到另一边。
 */
function reminderBounds(height) {
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const h = Math.max(80, Math.min(560, Math.round(Number(height) || 140)));
  return {
    width: REMINDER_WIDTH,
    height: h,
    x: area.x + area.width - REMINDER_WIDTH - REMINDER_MARGIN,
    y: area.y + area.height - h - REMINDER_MARGIN,
  };
}

function placeReminderWindow(height) {
  const win = reminderWindow;
  if (!win || win.isDestroyed()) return;
  win.setBounds(reminderBounds(height), false);
}

/** 到点提醒是独立窗口：主窗口收进托盘 / 最小化也照常弹在桌面右下角 */
function ensureReminderWindow() {
  if (reminderWindow && !reminderWindow.isDestroyed()) return reminderWindow;
  const win = new BrowserWindow({
    ...reminderBounds(140),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    title: '待办提醒 · 萤光笔记',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // 每个工作区一套 localStorage / IndexedDB；默认工作区留空以保留老版本的界面设置
      ...(workspacePartition() ? { partition: workspacePartition() } : {}),
      // 提示音和自动收起都跑在这个窗口里，后台节流会让它变慢
      backgroundThrottling: false,
    },
  });
  reminderWindow = win;
  // 压在普通窗口之上，但用 showInactive 弹出，不抢当前正在输入的光标
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setMenuBarVisibility(false);
  win.on('closed', () => {
    if (reminderWindow === win) reminderWindow = null;
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  loadRendererWithRetry(win, { reminder: '1' }, '提醒浮层');
  return win;
}

function hideReminderWindow() {
  if (reminderHideTimer) {
    clearTimeout(reminderHideTimer);
    reminderHideTimer = null;
  }
  reminderGeneric = false;
  if (reminderWindow && !reminderWindow.isDestroyed()) reminderWindow.hide();
}

/** 提醒不自动消失得太快，但也别一直挂在桌面上：5 分钟后收起 */
function scheduleReminderHide() {
  if (reminderHideTimer) clearTimeout(reminderHideTimer);
  reminderHideTimer = setTimeout(
    () => {
      reminderHideTimer = null;
      if (reminderWindow && !reminderWindow.isDestroyed()) reminderWindow.hide();
    },
    5 * 60 * 1000,
  );
}

function showReminder(items) {
  const list = Array.isArray(items) ? items.filter((it) => it && typeof it === 'object').slice(0, 5) : [];
  if (!list.length) {
    hideReminderWindow();
    return true;
  }
  const titled = list.filter((it) => it && it.id);
  if (titled.length) {
    lastReminderCount = titled.length;
    reminderGeneric = false;
  } else {
    reminderGeneric = true;
  }
  const win = ensureReminderWindow();
  // 先按条数估一个高度，渲染层量完真实内容后会再精调一次
  placeReminderWindow(48 + list.length * 132);
  const send = () => {
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
    win.webContents.send('reminder:data', list);
    win.showInactive();
    scheduleReminderHide();
  };
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send);
  else send();
  return true;
}

function sendCommand(command) {
  showMain();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('app:command', command);
  }
}

/**
 * 退出前向渲染层要一次「落盘 + 提交 + 推送」。
 * 主窗口负责提交推送；独立笔记窗口只落盘（它们不跑同步）。
 * 返回 true 表示已经发出请求（调用方应阻止本次退出）；没有窗口可问时返回 false。
 * 渲染进程崩溃或页面卡死时最多等 4 秒，绝不让程序关不掉。
 */
function requestQuitSync() {
  if (quitAfterSync) return true;
  const hasMain = Boolean(mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed());
  if (!hasMain && noteWindows.size === 0) return false;
  quitAfterSync = true;
  mainQuitReady = !hasMain;
  noteFlushPending.clear();
  for (const win of noteWindows.values()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
    noteFlushPending.add(win.id);
    try {
      win.webContents.send('note:flush-request');
    } catch {
      noteFlushPending.delete(win.id);
    }
  }
  if (hasMain) {
    try {
      mainWindow.webContents.send('app:quit-request');
    } catch {
      mainQuitReady = true;
    }
  }
  quitSyncTimer = setTimeout(() => finishQuit(true), 4000);
  if (mainQuitReady && noteFlushPending.size === 0) finishQuit();
  return true;
}

/** 主窗口和独立窗口都报告完成（或超时）后才真正退出 */
function maybeFinishQuit() {
  if (!quitAfterSync) return;
  if (mainQuitReady && noteFlushPending.size === 0) finishQuit();
}

function finishQuit(force = false) {
  if (!force && !(mainQuitReady && noteFlushPending.size === 0)) return;
  if (quitSyncTimer) {
    clearTimeout(quitSyncTimer);
    quitSyncTimer = null;
  }
  quitAfterSync = true;
  isQuitting = true;
  if (pendingInstallUpdate && updaterInstance && updateDownloaded) {
    pendingInstallUpdate = false;
    // 静默安装并自动启动新版本；安装器随后会覆盖当前目录，旧的进程已经准备退出
    updaterInstance.quitAndInstall(true, true);
    return;
  }
  app.quit();
}

function createTray() {
  try {
    if (tray && !tray.isDestroyed()) tray.destroy();
    if (!uiLang) uiLang = /^zh/i.test(app.getLocale()) ? 'zh' : 'en';
    const zh = uiLang !== 'en';
    const iconPath =
      process.platform === 'darwin'
        ? path.join(ASSETS, 'tray.png')
        : path.join(ASSETS, process.platform === 'win32' ? 'icon.ico' : 'tray.png');
    tray = new Tray(nativeImage.createFromPath(iconPath));
    tray.setToolTip(zh ? '萤光笔记 · 本地优先笔记' : 'Glimnote · local-first notes');
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: zh ? '打开萤光笔记' : 'Open Glimnote', click: showMain },
        { label: zh ? '待办浮窗' : 'Tasks card', accelerator: 'Control+Alt+D', click: showCard },
        { label: zh ? '快速捕获' : 'Quick capture', accelerator: 'Alt+Space', click: showCapture },
        { label: zh ? '立即同步' : 'Sync now', click: () => sendCommand('sync-now') },
        { type: 'separator' },
        { label: zh ? '在文件夹中打开' : 'Show in folder', click: () => shell.openPath(repoRoot()) },
        { type: 'separator' },
        {
          label: zh ? '退出' : 'Quit',
          click: () => {
            // 先给渲染层一点时间提交并推送，确认后（或 4 秒超时）再真正退出
            if (!requestQuitSync()) finishQuit(true);
          },
        },
      ]),
    );
    tray.on('click', showMain);
    tray.on('double-click', showMain);
  } catch (e) {
    console.warn('tray unavailable', e);
  }
}

function sendUpdateProgress(payload) {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send('app:update-progress', payload);
  }
}

/**
 * 向 GitCode 询问最新 Release，返回该版本的下载目录。
 * 地址是版本固定的，latest.yml 和安装包都从这里取，避免依赖 GitCode
 * 并未提供的 releases/latest 别名。
 */
async function resolveUpdateFeed() {
  // 用 Electron 的 net.fetch 而不是 Node 的 fetch：跟随系统代理设置，
  // 和 electron-updater 下载安装包走同一套网络栈。带上时间戳避免拿到缓存的旧版本。
  const res = await net.fetch(`${UPDATE_API}?t=${Date.now()}`, {
    signal: AbortSignal.timeout(UPDATE_TIMEOUT),
    headers: { Accept: 'application/json', 'User-Agent': 'Glimnote-Updater' },
  });
  if (!res.ok) {
    let detail = '';
    try {
      const body = await res.json();
      if (body && body.error_message) detail = `：${body.error_message}`;
    } catch {
      /* 错误响应不是 JSON 时只报状态码 */
    }
    throw new Error(`GitCode API 返回 HTTP ${res.status}${detail}`);
  }
  const data = await res.json();
  const tag = String((data && (data.tag_name || data.tag)) || '').trim();
  if (!tag) throw new Error('GitCode 没有返回最新版本 tag');
  updateFeedBase = `${UPDATE_DOWNLOAD_BASE}/${encodeURIComponent(tag)}`;
  return updateFeedBase;
}

async function applyUpdateFeed(updater) {
  const base = await resolveUpdateFeed();
  updater.setFeedURL({ provider: 'generic', url: base });
  return base;
}

function getUpdater() {
  if (updaterInstance) return updaterInstance;
  let autoUpdater;
  try {
    autoUpdater = require('electron-updater').autoUpdater;
  } catch (e) {
    // 以前这里静默返回 null，缺组件时只剩一句「未安装更新组件」，查不到是哪一层失败
    updaterLoadError = String((e && e.message) || e);
    try {
      logFile.write('app', 'warn', `更新组件加载失败：${updaterLoadError.slice(0, 200)}`);
    } catch {
      /* 日志写不进去也不能影响检查更新 */
    }
    return null;
  }
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  // GitCode 的 Release 资源只要 URL 带查询参数就直接返回 404，
  // 而 electron-updater 默认会给 latest.yml 拼 ?noCache=xxx，这里强制关掉。
  // 每个版本目录的内容不会变，本来也不需要缓存穿透。
  try {
    Object.defineProperty(autoUpdater, 'isAddNoCacheQuery', {
      configurable: true,
      get: () => false,
    });
  } catch {
    /* 属性不可配置时保持默认，至少不影响其它平台 */
  }
  autoUpdater.on('download-progress', (p) => {
    sendUpdateProgress({
      state: 'downloading',
      percent: Math.max(0, Math.min(100, Math.round(Number(p && p.percent) || 0))),
      transferred: Number(p && p.transferred) || 0,
      total: Number(p && p.total) || 0,
    });
  });
  autoUpdater.on('update-downloaded', (info) => {
    updateDownloaded = true;
    updateDownloadedVersion = info && info.version ? String(info.version) : lastAvailableVersion || '';
    sendUpdateProgress({ state: 'downloaded', version: updateDownloadedVersion });
  });
  autoUpdater.on('error', (e) => {
    // 不要把 electron-updater 的原始报错（含整页 HTML）直接塞给界面
    logFile.write('app', 'warn', `更新组件报错：${String((e && e.message) || e).slice(0, 200)}`);
    sendUpdateProgress({
      state: 'error',
      message: friendlyUpdateError(e, '更新失败，请稍后重试；如果一直失败，可以点「打开发布页」手动下载安装。'),
    });
  });
  updaterInstance = autoUpdater;
  return autoUpdater;
}

/**
 * 把更新错误翻成用户能看懂的一句话；原始报错仍然写进日志方便排查。
 * GitCode 的 Release 文件偶发 404（刚发布、还在同步）是常见情况。
 */
function friendlyUpdateError(e, fallback) {
  const text = String((e && e.message) || e);
  if (/\b404\b|not found|cannot find channel/i.test(text)) {
    return '更新服务器上暂时找不到更新文件（HTTP 404）。可能是新版本刚发布还没同步好，请稍后重试；如果一直失败，可以点「打开发布页」手动下载。';
  }
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|network|timed? ?out|abort/i.test(text)) {
    return '连不上更新服务器，请检查网络后重试。';
  }
  if (/\b5\d\d\b|bad gateway|service unavailable|gateway time-?out|internal server error/i.test(text)) {
    return '更新服务器（GitCode）暂时不可用（HTTP 5xx），通常是对方网关或本机网络代理的问题。请稍后重试；如果一直失败，可以点「打开发布页」手动下载安装包。';
  }
  return fallback;
}

/** 版本号比较：只有远端的版本比当前新，才算「发现新版本」。
 *  GitCode 上的最新 Release 可能落后于本机已安装的版本，不能只看「不相等」。
 */
function isNewerVersion(remote, current) {
  const parse = (v) =>
    String(v || '')
      .trim()
      .replace(/^v/i, '')
      .split('.')
      .map((part) => parseInt(part, 10) || 0);
  const a = parse(remote);
  const b = parse(current);
  const len = Math.max(a.length, b.length, 3);
  for (let i = 0; i < len; i += 1) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}

async function checkUpdate() {
  if (!app.isPackaged) {
    return { status: 'dev', message: '开发模式下不检查更新，打包安装后可用。' };
  }
  const updater = getUpdater();
  if (!updater) {
    // 更新组件缺失（历史上 0.1.16 的 asar 没带 node_modules）时仍然查一次 GitCode：
    // 至少告诉用户有没有新版本、应该去哪里手动下载，而不是只回一句「无法检查」。
    const reason = updaterLoadError
      ? `自动更新组件加载失败（${updaterLoadError.slice(0, 120)}）`
      : '当前安装包缺少自动更新组件';
    try {
      const base = await resolveUpdateFeed();
      const tag = decodeURIComponent(String(base.split('/').pop() || '')).trim();
      const latest = tag.replace(/^v/i, '');
      if (latest && isNewerVersion(latest, app.getVersion())) {
        lastAvailableVersion = latest;
        return {
          status: 'manual',
          message: `发现新版本 ${latest}，但${reason}，无法自动下载。请打开发布页手动下载安装包。`,
          version: latest,
          manual: true,
          url: RELEASES_PAGE,
        };
      }
      return {
        status: 'latest',
        message: `已是最新版本 ${app.getVersion()}（${reason}，本次为手动检查）`,
      };
    } catch (e) {
      logFile.write('app', 'warn', `更新组件缺失且查询发布页失败：${String((e && e.message) || e).slice(0, 200)}`);
      return {
        status: 'unavailable',
        message: `${reason}，也连不上发布页：${friendlyUpdateError(e, '请稍后重试。')}`,
        url: RELEASES_PAGE,
      };
    }
  }
  try {
    // 先解析最新 tag，再把 feed 指到对应版本的目录；GitCode 没有 latest 直链
    await applyUpdateFeed(updater);
    const res = await updater.checkForUpdates();
    const latest = res && res.updateInfo ? res.updateInfo.version : '';
    if (latest && isNewerVersion(latest, app.getVersion())) {
      lastAvailableVersion = latest;
      // 本地安装包必须正好是这一版，才算「已下载」
      const downloaded = updateDownloaded && updateDownloadedVersion === latest;
      updateDownloaded = downloaded;
      // 安装包已经在本地时别让界面再显示一次「下载更新」：告诉渲染层直接进入安装流程
      return {
        status: 'available',
        message: downloaded ? `新版本 ${latest} 已下载，可直接重启安装` : `发现新版本 ${latest}`,
        version: latest,
        downloaded,
      };
    }
    lastAvailableVersion = '';
    updateDownloaded = false;
    updateDownloadedVersion = '';
    return { status: 'latest', message: `已是最新版本 ${app.getVersion()}` };
  } catch (e) {
    logFile.write('app', 'warn', `检查更新失败：${String((e && e.message) || e).slice(0, 200)}`);
    return { status: 'error', message: friendlyUpdateError(e, '检查更新失败，请稍后重试。') };
  }
}

/** 用户点了「忽略此版本」：只压住这一版，出现更新的版本仍然会提醒 */
async function ignoreUpdateVersion(version) {
  const value = String(version || '').trim();
  if (!value) return false;
  await writePrefs({ ignoredUpdateVersion: value });
  logFile.write('app', 'info', `已忽略版本 ${value}，之后只有更新的版本才会提醒`);
  return true;
}

/**
 * 有新版本时让主窗口直接弹窗，由用户选择「立即更新 / 稍后 / 忽略此版本」。
 * 不再用右下角系统通知：通知容易被忽略，也看不出安装说明。
 */
function offerUpdate(version, manual = false) {
  const target = mainWindow;
  if (!target || target.isDestroyed() || target.webContents.isDestroyed()) return false;
  sendToMain('app:update-available', { version: String(version || ''), manual: Boolean(manual) });
  return true;
}

/**
 * 自动检查更新：安装版启动 15 秒后查一次，此后每 24 小时一次。
 * 用户忽略过的版本不再弹出任何提醒，直到出现更高的版本号。
 */
async function autoCheckUpdate() {
  if (!app.isPackaged) return;
  try {
    const result = await checkUpdate();
    const manual = result.status === 'manual';
    if ((result.status !== 'available' && !manual) || !result.version) return;
    const ignored = String((await readPrefs()).ignoredUpdateVersion || '');
    if (ignored === result.version) return;
    if (notifiedUpdateVersion === result.version) return;
    notifiedUpdateVersion = result.version;
    // 主窗口收在托盘里时先不打扰，等用户下次打开界面时这次提醒仍会挂在状态里
    offerUpdate(result.version, manual);
    logFile.write(
      'app',
      'info',
      `发现新版本 ${result.version}${manual ? '（当前安装包只能手动下载）' : ''}，已提醒用户`,
    );
  } catch (e) {
    logFile.write('app', 'warn', `自动检查更新失败：${(e && e.message) || e}`);
  }
}

function scheduleAutoUpdateCheck() {
  if (!app.isPackaged || autoUpdateTimers.length) return;
  const first = setTimeout(() => void autoCheckUpdate(), UPDATE_AUTO_DELAY);
  const repeat = setInterval(() => void autoCheckUpdate(), UPDATE_AUTO_INTERVAL);
  if (typeof first.unref === 'function') first.unref();
  if (typeof repeat.unref === 'function') repeat.unref();
  autoUpdateTimers = [first, repeat];
}

async function downloadUpdate() {
  const updater = getUpdater();
  if (!updater) {
    return { ok: false, message: '更新组件不可用，请打开发布页手动下载完整安装包。' };
  }
  // 已经下载好：重新发一次 downloaded，避免界面停在「正在下载」的转圈上
  if (updateDownloaded) {
    sendUpdateProgress({ state: 'downloaded', version: lastAvailableVersion || '' });
    return { ok: true, message: '更新已经下载好了。' };
  }
  // 上一次下载还没结束时又点了一次：等同一个 Promise，不要启动第二个下载任务
  if (updateDownloadPromise) {
    try {
      await updateDownloadPromise;
      return { ok: true, message: '更新下载完成。' };
    } catch (e) {
      logFile.write('app', 'warn', `下载更新失败：${String((e && e.message) || e).slice(0, 200)}`);
      return { ok: false, message: friendlyUpdateError(e, '下载更新失败，请稍后重试。') };
    }
  }
  updateDownloadPromise = (async () => {
    // 正常流程是「检查」之后再「下载」；这里兜底，防止直接调用时还没设过 feed
    if (!updateFeedBase) await applyUpdateFeed(updater);
    await updater.downloadUpdate();
    // 有些 electron-updater 版本只在事件回调里标记，这里补一次，保证后续安装判断可靠
    updateDownloaded = true;
    updateDownloadedVersion = lastAvailableVersion || updateDownloadedVersion;
    sendUpdateProgress({ state: 'downloaded', version: updateDownloadedVersion });
  })();
  try {
    await updateDownloadPromise;
    return { ok: true, message: '更新下载完成。' };
  } catch (e) {
    logFile.write('app', 'warn', `下载更新失败：${String((e && e.message) || e).slice(0, 200)}`);
    return { ok: false, message: friendlyUpdateError(e, '下载更新失败，请稍后重试。') };
  } finally {
    updateDownloadPromise = null;
  }
}

function installUpdate() {
  if (!updaterInstance || !updateDownloaded) {
    return { ok: false, message: '更新还没有下载完，先点「下载更新」。' };
  }
  pendingInstallUpdate = true;
  // 走一遍正常的退出流程：先让渲染层落盘 + 提交 + 推送，再安装新版本
  if (!requestQuitSync()) finishQuit(true);
  return { ok: true };
}

/**
 * 安装器收尾：只写系统启动项，不创建窗口，设置完立刻退出。
 * 走应用自己的 setLoginItemSettings，注册表里的值名和设置页完全一致；
 * 安装器不需要猜 Electron 用的键名，卸载时也能用同一个参数删干净。
 */
const AUTOSTART_SETUP_ARG = '--install-autostart';
const AUTOSTART_REMOVE_ARG = '--remove-autostart';
const autostartSetupArg = process.argv.includes(AUTOSTART_SETUP_ARG)
  ? AUTOSTART_SETUP_ARG
  : process.argv.includes(AUTOSTART_REMOVE_ARG)
    ? AUTOSTART_REMOVE_ARG
    : '';

const gotLock = autostartSetupArg ? true : app.requestSingleInstanceLock();
writeBootLine(`单实例锁 · ${gotLock ? '拿到' : '已被占用'}${autostartSetupArg ? ' · 安装器模式' : ''}`);
if (autostartSetupArg) {
  app.whenReady().then(() => {
    const enabled = autostartSetupArg === AUTOSTART_SETUP_ARG;
    try {
      app.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: false, args: [AUTOSTART_ARG] });
      logFile.write('app', 'info', `安装器${enabled ? '开启' : '关闭'}了开机启动`);
    } catch (e) {
      logFile.write('app', 'warn', `安装器设置开机启动失败：${(e && e.message) || e}`);
    }
    logFile.flushSync();
    app.quit();
  });
} else if (!gotLock) {
  // 已经有实例在跑：正常退出，但留一行日志，避免「双击没反应 / 闪退」时什么都查不到
  logFile.write('app', 'warn', '已有实例在运行，本次启动直接退出');
  logFile.flushSync();
  app.quit();
} else {
  app.on('second-instance', () => {
    showMain();
    if (captureWindow && !captureWindow.isDestroyed()) captureWindow.focus();
  });

  app.on('before-quit', (e) => {
    mcpHttp.stop();
    if (quitAfterSync) {
      isQuitting = true;
      return;
    }
    isQuitting = true;
    // 托盘退出 / ⌘Q / 系统关机：先让渲染层提交并推送，确认后放行
    if (requestQuitSync()) e.preventDefault();
  });

  app.whenReady().then(async () => {
    writeBootLine('whenReady');
    app.setAppUserModelId('com.glimnote.app');
    const prefs = await readPrefs();
    cardBounds = usableCardBounds(prefs.cardBounds);
    cardPinned = prefs.cardPinned === true;
    // 上次退出时浮窗开着就标记恢复；等主窗口把锁状态报上来后再决定是否显示
    cardRestorePending = prefs.cardOpen === true;
    // 合并条上次被拖到哪儿：重开程序也留在原地，不重新贴底
    dockPos = usableDockPos(prefs.dockPos);
    // 笔记目录、同步配置、令牌与日志已由 workspace 在启动时确定，这里只处理窗口偏好
    logFile.registerLogHandlers(ipcMain, shell);
    if (resetApplied) {
      logFile.write('app', 'warn', `已重置本机配置${resetBackupDir ? `，旧目录保留在 ${resetBackupDir}` : ''}`);
    }
    logFile.write(
      'app',
      'info',
      `启动 v${app.getVersion()} · ${process.platform} ${process.arch}${app.isPackaged ? '' : ' · dev'}${
        process.argv.includes(AUTOSTART_ARG) ? ' · 开机自启' : ''
      } · 工作区 ${workspace.active().name}`,
    );
    // 启动这一行立刻落盘：万一接下来几秒内进程被结束，也能留下「这次确实启动过」的证据
    logFile.flushSync();
    await fsp.mkdir(repoRoot(), { recursive: true }).catch(() => {});
    await publishMcpRoot();
    closeToTray = prefs.closeToTray !== false;
    // 上次退出时服务是开着的就继续开；首次默认关闭，不占端口也不让人意外
    if (prefs.mcpHttp === true) {
      mcpHttp.setWanted(true);
      void mcpHttp.start();
    }
    registerFsHandlers();
    // Git smart HTTP 接口不带 CORS 头，必须由主进程代发，渲染进程才能拿到 401/403 等真实状态
    registerGitProxy(ipcMain, net, (level, msg) => logFile.write('git', level, msg));
    // 大模型接口通常不返回 CORS 头，和 Git 一样由主进程代发
    registerAiProxy(ipcMain, net, (level, msg) => logFile.write('ai', level, msg));
    // 企业微信 / 飞书 / 钉钉的群机器人同样受跨域限制
    registerWebhookProxy(ipcMain, net, (level, msg) => logFile.write('notify', level, msg));
    if (process.platform !== 'darwin') Menu.setApplicationMenu(null);
    // 先清掉旧版本留在本机配置里的 Service Worker 再开窗口，否则第一屏仍会
    // 先走一遍「加载失败 → 清缓存 → 重试」，浮窗也会跟着空白。
    await purgeDesktopServiceWorkers();
    createWindow();
    writeBootLine('主窗口已创建');
    createTray();
    // 启动后静默检查一次更新，之后每 24 小时一次；忽略过的版本不再提醒
    scheduleAutoUpdateCheck();
    // 拔副屏、改分辨率或改缩放后，开着的浮窗可能落到屏幕外，自己收回来
    screen.on('display-removed', refitCardWindow);
    screen.on('display-metrics-changed', refitCardWindow);
    const registered = globalShortcut.register('Alt+Space', showCapture);
    if (!registered) globalShortcut.register('Control+Alt+Space', showCapture);
    // 浮窗快捷键与托盘菜单同一组合。被其它软件占用时只记日志、不再弹提示：
    // 多数用户都用标题栏按钮或托盘菜单，每次启动弹「快捷键被占用」只会打扰。
    // 设置页会读这个状态，占用时不提快捷键，而不是给一条警告。
    cardHotkeyTaken = !globalShortcut.register('Control+Alt+D', toggleCard);
    if (cardHotkeyTaken) {
      logFile.write('app', 'info', '浮窗快捷键 Control+Alt+D 被占用，入口仍可用标题栏按钮或托盘菜单');
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      else showMain();
    });
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    logFile.write('app', 'info', '退出');
    logFile.flushSync();
  });

  app.on('window-all-closed', () => {
    if (process.platform === 'darwin') return;
    // 开发模式切换工作区时会先销毁全部窗口再重建，不能在这里退出
    if (switchingWorkspace) return;
    if (isQuitting || !closeToTray) app.quit();
  });

  // 主进程里的未捕获异常至少要留在日志里，方便用户把文件发过来定位
  // 用户遇到「界面没反应」时把这个日志文件发过来，比任何口头描述都管用
  process.on('uncaughtException', (err) => {
    const text = err && err.stack ? err.stack : String(err);
    logFile.write('app', 'error', `未捕获异常：${text}`);
    logFile.flushSync();
  });
  process.on('unhandledRejection', (reason) => {
    const text = reason && reason.stack ? reason.stack : String(reason);
    logFile.write('app', 'error', `未处理的 Promise 拒绝：${text}`);
  });
}
