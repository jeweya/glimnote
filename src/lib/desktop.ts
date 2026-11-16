export interface UpdateResult {
  status: 'dev' | 'unavailable' | 'noconfig' | 'available' | 'manual' | 'latest' | 'error';
  message: string;
  version?: string;
  /** 安装包已经下载到本地：直接进入重启安装流程，不要再显示「下载更新」 */
  downloaded?: boolean;
  /** 当前安装包没有自动更新组件，只能打开发布页手动下载 */
  manual?: boolean;
  /** 手动下载时要打开的页面 */
  url?: string;
}

/** 主进程推送的更新进度：下载百分比、下载完成、失败 */
export interface UpdateProgress {
  state: 'downloading' | 'downloaded' | 'error';
  percent?: number;
  transferred?: number;
  total?: number;
  version?: string;
  message?: string;
}

export interface RepoLocation {
  path: string;
  defaultPath: string;
  custom: boolean;
}

export interface RepoPick {
  canceled: boolean;
  /** 选中后发现就是当前位置 */
  same?: boolean;
  path?: string;
  current?: string;
}

export interface AiHttpResponse {
  status: number;
  text: string;
}

export interface CaptureInfo {
  id: string;
  title: string;
  notebook: string;
}

/** 桌面右下角提醒浮层里的一条待办 */
export interface DesktopReminderItem {
  id: string;
  title: string;
  meta: string;
}

export type DesktopReminderAction = 'done' | 'snooze' | 'close' | 'open';

/** 桌面底部合并条上的一项：收起来的一个小应用窗口 */
export interface AppDockItem {
  /** 窗口 id，同一个应用开多个也能区分 */
  token: number;
  /** 应用 id，用来读应用名和图标 */
  id: string;
}

export interface McpInfo {
  /** MCP 脚本所在目录 */
  dir: string;
  /** stdio 启动器（推荐给客户端填 command） */
  stdio: string;
  /** HTTP 启动器 */
  http: string;
  /** 服务入口，缺少 .cmd 时可直接用 node 跑它 */
  server: string;
  /** 笔记仓库根目录，MCP 读写的就是这里 */
  root: string;
  /** 开发模式（脚本在源码目录里，不在安装目录） */
  dev: boolean;
  /** 启动器是否存在 */
  ready: boolean;
}

/** 内置 MCP HTTP 服务的状态；running 为 true 才说明端口已经能连 */
export interface McpHttpState {
  running: boolean;
  /** 用户是否按开了开关（启动中 / 启动失败时为 true） */
  wanted: boolean;
  port: number;
  /** http://127.0.0.1:8765/mcp */
  url: string;
  /** 服务实际读写的笔记根目录 */
  root: string;
  /** 启动失败的中文原因，空串表示没出问题 */
  error: string;
}

/** 电脑上的一个应用：开始菜单快捷方式、.exe 或 macOS 的 .app */
export interface SystemApp {
  id: string;
  name: string;
  /** 绝对路径；启动时原样交回主进程 */
  path: string;
}

export interface SystemAppList {
  platform: string;
  apps: SystemApp[];
  /** 平台不支持时的中文原因，空串表示正常 */
  error?: string;
}

/** 手动选择程序的结果：取消时没有 app，选错文件时带 error */
export interface SystemAppPick {
  canceled: boolean;
  app?: SystemApp;
  error?: string;
}

/** 开机自启：主进程读系统启动项，渲染层只负责展示和切换 */
export interface LoginItemState {
  /** 当前平台 / 版本是否支持 */
  supported: boolean;
  enabled: boolean;
  /** 不支持或写入失败时的中文原因 */
  error?: string;
}

/** 浮窗拖动后的落点（屏幕坐标） */
export interface CardDragResult {
  x: number;
  y: number;
}

/** 从浮窗打开主窗口时要落到哪里；不传就只把主窗口叫出来 */
export interface MainOpenTarget {
  kind: 'home' | 'notebook' | 'view';
  /** kind 为 notebook 时是笔记本路径，view 时是智能视图键 */
  value?: string;
}

/** 当前工作区绑定的仓库（只放定位信息，不含令牌） */
export interface WorkspaceRepo {
  provider: string;
  owner: string;
  repo: string;
  branch: string;
  at?: string;
}

/** 一个工作区 = 独立的笔记目录 + 同步配置 + 令牌 + 日志 + 界面缓存 */
export interface WorkspaceInfo {
  id: string;
  name: string;
  root: string;
  /** 创建这个工作区时的笔记文件夹；设置页「恢复默认」迁回这里 */
  baseRoot?: string;
  repo: WorkspaceRepo | null;
  isDefault: boolean;
  /** 默认工作区为 null；其它工作区为 Chromium 的 persist: 分区名 */
  partition: string | null;
}

export interface WorkspaceList {
  active: string;
  items: WorkspaceInfo[];
}

export interface WorkspaceCreateResult {
  ok: boolean;
  item?: WorkspaceInfo;
  error?: string;
}

export interface WorkspaceBindResult {
  ok: boolean;
  item?: WorkspaceInfo;
  /** 另一个工作区已经绑定了同一个仓库 */
  conflict?: WorkspaceInfo;
  error?: string;
}

export interface WorkspacePrepareResult {
  ok: boolean;
  item?: WorkspaceInfo;
  /** 这次新建了工作区（false 表示复用了已有的同仓库工作区） */
  created?: boolean;
  /** 目标就是当前工作区，无需切换 */
  same?: boolean;
  conflict?: WorkspaceInfo;
  error?: string;
}

export interface DesktopBridge {
  platform: string;
  isDesktop?: boolean;
  repoPath: () => Promise<string>;
  /** 同步界面语言给主进程（托盘菜单） */
  setUiLang?: (lang: 'zh' | 'en') => Promise<boolean>;
  repoLocation: () => Promise<RepoLocation>;
  chooseRepoLocation: () => Promise<RepoPick>;
  moveRepoLocation: (target: string) => Promise<{ moved: boolean; path: string; files: number }>;
  openRepoFolder: () => Promise<void>;
  /** 当前工作区信息（名称、笔记目录、关联仓库） */
  workspaceInfo?: () => Promise<WorkspaceInfo>;
  workspaceList?: () => Promise<WorkspaceList>;
  workspaceCreate?: (payload: { name: string; root?: string }) => Promise<WorkspaceCreateResult>;
  /** 切换工作区：主进程会重启应用，返回 restarting=true */
  workspaceSwitch?: (
    id: string,
  ) => Promise<{ ok: boolean; restarting?: boolean; error?: string; item?: WorkspaceInfo }>;
  workspaceBindRepo?: (
    repo: { provider: string; owner: string; repo: string; branch: string } | null,
    opts?: { force?: boolean },
  ) => Promise<WorkspaceBindResult>;
  workspaceFindRepo?: (repo: { provider: string; owner: string; repo: string }) => Promise<WorkspaceInfo | null>;
  /** 为不同身份的仓库准备独立工作区（目录 / 配置 / 令牌），随后由界面切换过去 */
  workspacePrepareConnect?: (payload: {
    repo: { provider: string; owner: string; repo: string; branch: string };
    cfg: { provider: string; owner: string; repo: string; branch: string; remember: boolean };
    login: string;
    token: string;
  }) => Promise<WorkspacePrepareResult>;
  workspaceRename?: (id: string, name: string) => Promise<{ ok: boolean; item?: WorkspaceInfo; error?: string }>;
  workspacePickRoot?: () => Promise<{ canceled: boolean; path?: string }>;
  workspaceOpen?: (id: string) => Promise<boolean>;
  /** 用系统默认浏览器打开 http(s) 网址；只允许 http / https */
  openExternal?: (url: string) => Promise<boolean>;
  aiRequest: (req: {
    /** 渲染层生成的请求 id，停止生成时按它中断 */
    id?: string;
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    /** 本次请求最长等待（毫秒）；主进程上限 8 分钟 */
    timeoutMs?: number;
  }) => Promise<AiHttpResponse>;
  /** 中断主进程里正在进行的 AI 请求；请求已结束则返回 false */
  aiAbort?: (id: string) => Promise<boolean>;
  /** 群机器人 Webhook：同样由主进程代发，返回状态码与正文 */
  webhookSend?: (req: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  }) => Promise<AiHttpResponse>;
  getPrefs: () => Promise<{ closeToTray?: boolean }>;
  /** 是否随系统登录自动启动；安装版才有意义 */
  getLoginItem?: () => Promise<LoginItemState>;
  /** 开启 / 关闭开机自启，返回系统里的真实状态 */
  setLoginItem?: (value: boolean) => Promise<LoginItemState>;
  mcpInfo: () => Promise<McpInfo>;
  openMcpFolder: () => Promise<boolean | { error: string }>;
  mcpHttpStatus: () => Promise<McpHttpState>;
  mcpHttpStart: () => Promise<McpHttpState>;
  mcpHttpStop: () => Promise<McpHttpState>;
  /** 系统密钥是否可用；不可用时令牌只在本次运行有效 */
  credentialAvailable?: () => Promise<boolean>;
  /** 按平台取回加密保存的授权令牌，没有则空串 */
  credentialGet?: (provider: string) => Promise<string>;
  /** 加密保存令牌；false 表示系统密钥不可用或写入失败 */
  credentialSet?: (provider: string, token: string) => Promise<boolean>;
  credentialClear?: (provider: string) => Promise<boolean>;
  /** 同步配置（平台/用户名/仓库/分支）存在 userData，开发版与安装版共用；null 表示没配置 */
  configGet?: () => Promise<{ cfg: unknown; login?: string } | null>;
  /** 写入同步配置；传 null 表示断开同步，会删掉配置文件 */
  configSet?: (data: { cfg: unknown; login?: string } | null) => Promise<boolean>;
  setCloseToTray: (value: boolean) => Promise<boolean>;
  openCapture: () => Promise<void>;
  closeCapture: () => Promise<void>;
  /** 桌面浮窗：打开 / 收起（收起只是隐藏，下次秒开）；打不开时返回原因 */
  openCard?: () => Promise<boolean | { ok: boolean; reason?: string }>;
  /**
   * 标题栏按钮 / 热键的开关：浮窗在前台或已稳定显示时收起；刚显示的两秒内
   * 再点一次只重新叫到最前面，避免「第一次没看到、第二次反而把它收起来」。
   */
  toggleCard?: () => Promise<{ ok: boolean; visible: boolean; reason?: string }>;
  /** 浮窗当前是否显示：设置页的开关要以主进程为准 */
  isCardOpen?: () => Promise<boolean>;
  /** 浮窗全局热键是否被其它软件占用（true 时设置页提示改用标题栏 / 托盘入口） */
  cardHotkey?: () => Promise<{ shortcut: string; taken: boolean }>;
  /** 浮窗显示 / 隐藏时触发（含 Ctrl+Alt+D 快捷键） */
  onCardVisibility?: (cb: (visible: boolean) => void) => () => void;
  hideCard?: () => Promise<boolean>;
  /** 浮窗改尺寸：右下角拖拽缩放、收成一条都用它；宽高为内容区尺寸 */
  resizeCard?: (size: { width: number; height: number }) => Promise<boolean>;
  /** 扫描电脑上的应用（Windows 开始菜单 / macOS 应用程序），供快捷入口选择 */
  listSystemApps?: (force?: boolean) => Promise<SystemAppList>;
  /** 按路径批量取应用图标（PNG data URL），取不到的路径不会出现在结果里 */
  systemAppIcons?: (paths: string[]) => Promise<Record<string, string>>;
  /** 批量确认路径在当前电脑上还存在，返回存在的路径（换电脑后判断入口是否还有效） */
  systemAppStatus?: (paths: string[]) => Promise<string[]>;
  /** 从系统文件选择框里手动挑一个扫描不到的程序 */
  pickSystemApp?: () => Promise<SystemAppPick>;
  /** 启动一个系统应用；只接受扫描结果里的 .lnk / .exe / .app / .desktop */
  openSystemApp?: (path: string) => Promise<boolean>;
  /** 浮窗是否置顶；默认 false，图钉按钮切换后写进偏好 */
  getCardPinned?: () => Promise<boolean>;
  setCardPinned?: (value: boolean) => Promise<boolean>;
  /** 自绘标题栏拖动：先取窗口位置，再按屏幕坐标增量发绝对位置 */
  cardDragStart?: () => Promise<{ x: number; y: number } | null>;
  /** 返回窗口实际落点（完全跟手，不做贴边吸附） */
  cardDragMove?: (pos: { x: number; y: number }) => Promise<CardDragResult | null>;
  /** 松手：主进程不做吸附，直接记住当前位置 */
  cardDragEnd?: () => Promise<CardDragResult | null>;
  /** 从浮窗打开主窗口（页脚按钮） */
  showMain?: () => Promise<boolean>;
  /** 从浮窗打开主窗口并落到指定页面（首页 / 笔记本 / 智能视图） */
  openMainTarget?: (target: MainOpenTarget) => Promise<boolean>;
  /** 主窗口收到「打开指定页面」的请求；浮窗与主窗口之间的导航只用这一条通道 */
  onMainTarget?: (cb: (target: MainOpenTarget) => void) => () => void;
  /** 主窗口上锁 / 解锁：锁着时主进程拒绝打开浮窗 */
  setLocked?: (value: boolean) => Promise<boolean>;
  /** 浮窗改了待办 / 灵感：通知主窗口重读 */
  cardChanged?: () => Promise<boolean>;
  /** 主窗口数据变了：让浮窗重读（主进程转发） */
  refreshCard?: () => Promise<boolean>;
  onCardChanged?: (cb: () => void) => () => void;
  onCardRefresh?: (cb: () => void) => () => void;
  /** 主窗口收进托盘并上锁：浮窗不关闭，只切成锁定态 */
  onCardLock?: (cb: () => void) => () => void;
  /** 主窗口解锁：浮窗恢复待办 / 灵感内容 */
  onCardUnlock?: (cb: () => void) => () => void;
  /** 系统通知：主窗口收起或锁屏时用它提醒；action 让点击回到对应界面 */
  notify?: (payload: { title: string; body: string; action?: string }) => Promise<boolean>;
  /** 点通知回来：主进程已叫出窗口，这里把对应 AI 生成会话恢复到前台 */
  onBuilderFocus?: (cb: (id: string) => void) => () => void;
  /** 桌面右下角的到点提醒浮层（独立窗口，主窗口收起也能弹） */
  showReminder?: (items: DesktopReminderItem[]) => Promise<boolean>;
  hideReminder?: () => Promise<boolean>;
  /** 提醒浮层按内容调整自身高度，始终贴着屏幕右下角 */
  reminderResize?: (height: number) => Promise<boolean>;
  /** 提醒浮层里的按钮：交给主窗口执行，浮层随即收起 */
  reminderAction?: (payload: { action: DesktopReminderAction; id: string }) => Promise<boolean>;
  onReminderData?: (cb: (items: DesktopReminderItem[]) => void) => () => void;
  onReminderAction?: (cb: (payload: { action: DesktopReminderAction; id: string }) => void) => () => void;
  /** 解锁后补报：上锁期间只显示了条数，解锁时把具体待办重新弹一次 */
  onReminderReplay?: (cb: () => void) => () => void;
  /** 在独立窗口里打开一篇笔记；已开过就聚焦原窗口 */
  openNoteWindow?: (id: string) => Promise<boolean>;
  /** 在独立窗口里打开一个 AI 小应用；同一个应用只保留一个窗口。pinned 让新窗口直接置顶 */
  openAppWindow?: (id: string, options?: { multiple?: boolean; pinned?: boolean }) => Promise<boolean>;
  /** 关闭某个应用已经打开的所有独立窗口（删除应用时调用） */
  closeAppWindows?: (id: string) => Promise<number>;
  /** 独立小应用窗口置顶 / 取消置顶，返回主进程实际状态 */
  setAppWindowPinned?: (value: boolean) => Promise<boolean>;
  /** 查询独立小应用窗口当前是否置顶（复用已开窗口被直接置顶时同步图钉图标） */
  isAppWindowPinned?: () => Promise<boolean>;
  /** 最小化独立小应用窗口；从浮窗打开的窗口会收进底部合并条并返回 true */
  minimizeAppWindow?: () => Promise<boolean>;
  /** 当前窗口的位置与大小（页面里的缩放把手先取一次基准） */
  appWindowBounds?: () => Promise<{ x: number; y: number; width: number; height: number } | null>;
  /** 按绝对坐标设置窗口位置与大小（透明窗体没有系统边缘缩放） */
  setAppWindowBounds?: (rect: { x: number; y: number; width: number; height: number }) => Promise<boolean>;
  /** 自绘标题栏拖动：先取窗口位置，再按屏幕坐标增量发绝对位置 */
  appWindowDragStart?: () => Promise<{ x: number; y: number } | null>;
  appWindowDragMove?: (pos: { x: number; y: number }) => Promise<boolean>;
  /** 最大化 / 还原独立小应用窗口，返回切换后的状态 */
  maximizeAppWindow?: () => Promise<boolean>;
  /** 查询独立小应用窗口当前是否最大化 */
  isAppWindowMaximized?: () => Promise<boolean>;
  /** 桌面底部合并条上的条目：token 是窗口 id，同一个应用开多个也能区分 */
  dockItems?: () => Promise<AppDockItem[]>;
  /** 合并条按内容宽度收紧，并贴着屏幕底部居中 */
  dockResize?: (size: { width: number; height: number }) => Promise<boolean>;
  /** 点合并条上的条目：把对应小应用放大到屏幕中央 */
  dockActivate?: (token: number) => Promise<boolean>;
  /** 关闭合并条上列出的某个小应用 */
  dockClose?: (token: number) => Promise<boolean>;
  /** 合并条可拖动：先取位置，再按屏幕坐标增量发绝对位置，松手时记下新位置 */
  dockDragStart?: () => Promise<{ x: number; y: number } | null>;
  dockDragMove?: (pos: { x: number; y: number }) => Promise<boolean>;
  dockDragEnd?: () => Promise<boolean>;
  /** 合并条内容变化（收起 / 放大 / 关闭）时推送 */
  onDockUpdate?: (cb: (items: AppDockItem[]) => void) => () => void;
  /** 设置独立小应用窗口的系统窗口透明度，返回实际生效值（失败为 false） */
  setAppWindowOpacity?: (value: number) => Promise<number | false>;
  /** 独立窗口收到关闭请求：落盘后调用 noteCloseReady 才真正关闭 */
  onNoteCloseRequest?: (cb: () => void) => () => void;
  noteCloseReady?: () => Promise<boolean>;
  /** 退出前主进程要求独立窗口落盘，完成后回 noteFlushReady */
  onNoteFlushRequest?: (cb: () => void) => () => void;
  noteFlushReady?: () => Promise<boolean>;
  captureSaved: (info: CaptureInfo) => Promise<boolean>;
  checkUpdate: () => Promise<UpdateResult>;
  /** 下载更新；完成后主进程推 downloaded，这里只返回成败 */
  downloadUpdate: () => Promise<{ ok: boolean; message?: string }>;
  /** 重启并静默安装：会先走一遍正常的落盘 + 同步流程 */
  installUpdate: () => Promise<{ ok: boolean; message?: string }>;
  onUpdateProgress: (cb: (progress: UpdateProgress) => void) => () => void;
  /** 自动检查发现新版本时触发：主窗口弹窗让用户选择安装或忽略 */
  onUpdateAvailable?: (cb: (info: { version: string; manual?: boolean }) => void) => () => void;
  /** 忽略当前版本，之后只有更新的版本才会提醒 */
  ignoreUpdate?: (version: string) => Promise<boolean>;
  /** 主进程最近一次自动检查发现的新版本，以及已忽略的版本 */
  updateInfo?: () => Promise<{ version: string; ignored: string; downloaded?: boolean }>;
  /** 界面起不来时的最后出口：清空本机配置并重启；笔记目录不受影响 */
  resetApp?: (reason?: string) => Promise<boolean>;
  /** 把一段已格式化的日志追加到本地日志文件，失败也只是 false */
  appendLog: (text: string) => Promise<boolean>;
  /** 当天的日志文件路径与所在文件夹 */
  logPath: () => Promise<{ dir: string; file: string }>;
  openLogFolder: () => Promise<boolean | { error: string }>;
  onCaptureSaved: (cb: (info: CaptureInfo) => void) => () => void;
  onCommand: (cb: (command: string) => void) => () => void;
  /** 窗口被收进托盘（hide）时触发：先落盘并提交，再重新上锁 */
  onWindowHidden?: (cb: () => void) => () => void;
  /** 退出前主进程来询问：渲染层落盘 / 同步完调用 quitReady，主进程才真正退出 */
  onQuitRequest?: (cb: () => void) => () => void;
  quitReady?: () => Promise<boolean>;
}

export function desktop(): DesktopBridge | null {
  const bridge = (window as unknown as { glimnote?: DesktopBridge }).glimnote;
  return bridge && bridge.isDesktop ? bridge : null;
}
