const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

/**
 * 主进程把 fs 的成败包在返回值里（见 electron/main.cjs 的 fsResult），
 * 这样「文件不存在」这类正常探测不会触发 Electron 的 “Error occurred in handler” 日志。
 * 在这里还原成异常，渲染进程拿到的还是带 code / path 的普通 Error。
 */
const FS_IPC_TAG = '__glimnoteFsResult';

function unwrapFsResult(result) {
  if (!result || typeof result !== 'object' || result[FS_IPC_TAG] !== true) return result;
  if (result.ok) return result.value;
  const raw = result.error || {};
  const err = new Error(raw.message || '文件操作失败');
  if (raw.name) err.name = raw.name;
  if (raw.code) err.code = raw.code;
  if (raw.path) err.path = raw.path;
  if (raw.errno !== undefined) err.errno = raw.errno;
  if (raw.syscall) err.syscall = raw.syscall;
  throw err;
}

const invokeFs = async (channel, ...args) => unwrapFsResult(await invoke(channel, ...args));

const promises = {
  mkdir: (p) => invokeFs('fs:mkdir', p),
  rmdir: (p) => invokeFs('fs:rmdir', p),
  readdir: (p) => invokeFs('fs:readdir', p),
  readFile: (p, opts) => invokeFs('fs:readFile', p, opts),
  writeFile: (p, data, opts) => invokeFs('fs:writeFile', p, data, opts),
  unlink: (p) => invokeFs('fs:unlink', p),
  stat: (p) => invokeFs('fs:stat', p),
  lstat: (p) => invokeFs('fs:lstat', p),
  rename: (from, to) => invokeFs('fs:rename', from, to),
  chmod: (p, mode) => invokeFs('fs:chmod', p, mode),
  readlink: (p) => invokeFs('fs:readlink', p),
  symlink: (target, p) => invokeFs('fs:symlink', target, p),
};

function on(channel, cb) {
  const handler = (_event, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('glimnote', {
  platform: 'electron',
  isDesktop: true,
  fs: { promises },
  // 渲染进程的 isomorphic-git 通过它走主进程转发，绕开 Git 服务端不返回 CORS 头的限制
  gitRequest: (req) => invoke('git:request', req),
  repoPath: () => invoke('app:repo-path'),
  // 安装包的真实版本号（运行时由主进程读取，界面不再写死）
  version: () => invoke('app:version'),
  // 界面语言切换后，托盘菜单跟着换
  setUiLang: (lang) => invoke('app:ui-lang', lang),
  repoLocation: () => invoke('app:repo-location'),
  chooseRepoLocation: () => invoke('app:choose-repo-location'),
  moveRepoLocation: (target) => invoke('app:move-repo-location', target),
  openRepoFolder: () => invoke('app:open-repo'),
  // 工作区：同一台电脑上把不同人的笔记 / 不同仓库的笔记完全分开
  workspaceInfo: () => invoke('app:workspace-info'),
  workspaceList: () => invoke('app:workspace-list'),
  workspaceCreate: (payload) => invoke('app:workspace-create', payload),
  workspaceSwitch: (id) => invoke('app:workspace-switch', id),
  workspaceBindRepo: (repo, opts) => invoke('app:workspace-bind-repo', repo, opts),
  workspaceFindRepo: (repo) => invoke('app:workspace-find-repo', repo),
  workspacePrepareConnect: (payload) => invoke('app:workspace-prepare-connect', payload),
  workspaceRename: (id, name) => invoke('app:workspace-rename', id, name),
  workspacePickRoot: () => invoke('app:workspace-pick-root'),
  workspaceOpen: (id) => invoke('app:workspace-open', id),
  // 首页的网址入口：交给系统浏览器，不在应用里内嵌网页
  openExternal: (url) => invoke('app:open-external', url),
  // 首页的「系统应用」入口：扫描本机开始菜单 / 应用程序，按需取图标并启动
  listSystemApps: (force) => invoke('system:list-apps', force),
  systemAppIcons: (paths) => invoke('system:app-icons', paths),
  // 批量确认入口里保存的绝对路径在当前电脑上是否还存在（换电脑后自动匹配用）
  systemAppStatus: (paths) => invoke('system:app-status', paths),
  pickSystemApp: () => invoke('system:pick-app'),
  openSystemApp: (target) => invoke('system:open-app', target),
  // AI 请求同样走主进程：大模型接口普遍不带 CORS 头（见 electron/ai-proxy.cjs）
  aiRequest: (req) => invoke('ai:request', req),
  // 用户点「停止生成」时中断主进程里对应的请求
  aiAbort: (id) => invoke('ai:abort', id),
  // 群机器人 Webhook 也由主进程代发，绕开浏览器跨域限制
  webhookSend: (req) => invoke('webhook:send', req),
  getPrefs: () => invoke('app:get-prefs'),
  // MCP（WorkBuddy 等 AI 客户端）脚本位置与仓库根目录，供设置 → 集成展示
  mcpInfo: () => invoke('app:mcp-info'),
  openMcpFolder: () => invoke('app:open-mcp-folder'),
  // 内置 MCP HTTP 服务的开关与状态（服务由主进程拉起，见 electron/mcp-http.cjs）
  mcpHttpStatus: () => invoke('app:mcp-http-status'),
  mcpHttpStart: () => invoke('app:mcp-http-start'),
  mcpHttpStop: () => invoke('app:mcp-http-stop'),
  // 授权令牌由主进程用系统密钥加密保存（electron/credentials.cjs），渲染层只拿明文
  credentialAvailable: () => invoke('app:credential-available'),
  credentialGet: (provider) => invoke('app:credential-get', provider),
  credentialSet: (provider, token) => invoke('app:credential-set', provider, token),
  credentialClear: (provider) => invoke('app:credential-clear', provider),
  // 同步配置放 userData 的 JSON（不涉密），开发版和安装版共用一份
  configGet: () => invoke('app:config-get'),
  configSet: (data) => invoke('app:config-set', data),
  setCloseToTray: (value) => invoke('app:set-close-to-tray', value),
  // 开机自启：系统启动项由主进程读写，渲染层只显示状态
  getLoginItem: () => invoke('app:login-item'),
  setLoginItem: (value) => invoke('app:set-login-item', value),
  openCapture: () => invoke('app:open-capture'),
  closeCapture: () => invoke('capture:close'),
  // 桌面浮窗（待办 + 灵感）：与主窗口共用本地文件，改完发 card:changed 让主窗口重读
  openCard: () => invoke('card:open'),
  // 标题栏按钮 / 热键共用：可见且在前台才收起，否则先叫到前面
  toggleCard: () => invoke('card:toggle'),
  hideCard: () => invoke('card:hide'),
  resizeCard: (size) => invoke('card:resize', size),
  getCardPinned: () => invoke('card:get-pinned'),
  setCardPinned: (value) => invoke('card:set-pinned', value),
  cardDragStart: () => invoke('card:drag-start'),
  cardDragMove: (pos) => invoke('card:drag-move', pos),
  // 松手时让主进程立即记住当前位置
  cardDragEnd: () => invoke('card:drag-end'),
  showMain: () => invoke('app:show-main'),
  // 浮窗入口：打开主窗口并落到首页 / 笔记本 / 智能视图
  openMainTarget: (target) => invoke('app:open-main', target),
  setLocked: (value) => invoke('app:set-locked', value),
  // 右键粘贴：主进程直接读系统剪贴板，text/html 比 navigator.clipboard.read() 稳
  clipboardRead: () => invoke('clipboard:read'),
  cardChanged: () => invoke('card:changed'),
  refreshCard: () => invoke('card:refresh'),
  isCardOpen: () => invoke('card:is-open'),
  // 浮窗全局热键是否被其它软件占用（占用时设置页会给出替代入口）
  cardHotkey: () => invoke('app:card-hotkey'),
  onCardChanged: (cb) => on('card:changed', cb),
  onCardRefresh: (cb) => on('card:refresh', cb),
  onCardVisibility: (cb) => on('card:visibility', cb),
  // 主窗口收进托盘并上锁时，浮窗留在桌面上但切成锁定态；解锁后恢复内容
  onCardLock: (cb) => on('card:lock', cb),
  onCardUnlock: (cb) => on('card:unlock', cb),
  notify: (payload) => invoke('app:notify', payload),
  // 桌面右下角提醒浮层：独立窗口，位置由主进程贴住屏幕工作区右下角
  showReminder: (items) => invoke('reminder:show', items),
  hideReminder: () => invoke('reminder:hide'),
  reminderResize: (height) => invoke('reminder:resize', height),
  reminderAction: (payload) => invoke('reminder:action', payload),
  onReminderData: (cb) => on('reminder:data', cb),
  onReminderAction: (cb) => on('reminder:action', cb),
  // 解锁后由主进程喊一嗓子：把上锁期间只报了条数的提醒重新补出来
  onReminderReplay: (cb) => on('reminder:replay', cb),
  // 双击笔记 → 独立窗口。关窗前主进程会先请求落盘，避免最后几个字丢掉
  openNoteWindow: (id) => invoke('app:open-note-window', id),
  // AI 小应用 → 独立的沙箱窗口；同一个应用重复打开会聚焦原窗口
  openAppWindow: (id, options) => invoke('app:open-app-window', id, options),
  closeAppWindows: (id) => invoke('app:close-app-windows', id),
  // 独立小应用窗口的外观控制：和浮窗一样在自己的标题栏置顶 / 最大化 / 最小化
  setAppWindowPinned: (value) => invoke('app:window-pin', value),
  // 复用已开窗口时主进程会直接把它置顶，渲染层靠这个查询同步图钉图标
  isAppWindowPinned: () => invoke('app:window-pinned'),
  minimizeAppWindow: () => invoke('app:window-minimize'),
  // 透明窗体拿不到系统边缘缩放：页面里的把手自己算尺寸，这里只负责落位
  appWindowBounds: () => invoke('app:window-bounds'),
  setAppWindowBounds: (rect) => invoke('app:window-set-bounds', rect),
  // 自绘标题栏拖动：透明窗体的拖动区和悬停都交给页面处理
  appWindowDragStart: () => invoke('app:window-drag-start'),
  appWindowDragMove: (pos) => invoke('app:window-drag-move', pos),
  maximizeAppWindow: () => invoke('app:window-maximize'),
  isAppWindowMaximized: () => invoke('app:window-maximized'),
  setAppWindowOpacity: (value) => invoke('app:window-opacity', value),
  // 收成一条的小应用在桌面底部的合并条上：列表、按内容收紧、放大、关闭
  dockItems: () => invoke('app:dock-items'),
  dockResize: (size) => invoke('app:dock-resize', size),
  dockActivate: (token) => invoke('app:dock-activate', token),
  dockClose: (token) => invoke('app:dock-close', token),
  // 合并条可以拖开，避免遮住桌面上的内容；松手把位置记进 prefs
  dockDragStart: () => invoke('app:dock-drag-start'),
  dockDragMove: (pos) => invoke('app:dock-drag-move', pos),
  dockDragEnd: () => invoke('app:dock-drag-end'),
  onDockUpdate: (cb) => on('app:dock-update', cb),
  onNoteCloseRequest: (cb) => on('note:close-request', cb),
  noteCloseReady: () => invoke('app:note-close-ready'),
  onNoteFlushRequest: (cb) => on('note:flush-request', cb),
  noteFlushReady: () => invoke('app:note-flush-ready'),
  captureSaved: (info) => invoke('capture:saved', info),
  checkUpdate: () => invoke('app:check-update'),
  // 自动更新：下载进度由主进程推送，下载完再让用户选择重启安装
  downloadUpdate: () => invoke('app:download-update'),
  installUpdate: () => invoke('app:install-update'),
  onUpdateProgress: (cb) => on('app:update-progress', cb),
  // 自动检查发现新版本：主窗口直接弹窗让用户选择安装或忽略
  onUpdateAvailable: (cb) => on('app:update-available', cb),
  // 忽略某个版本：之后只有比它更新的版本才会再提醒
  ignoreUpdate: (version) => invoke('app:update-ignore', version),
  updateInfo: () => invoke('app:update-info'),
  // 界面彻底起不来时的最后出口：清空本机配置并重启（笔记目录不受影响）
  resetApp: (reason) => invoke('app:reset', reason),
  // 日志落盘：渲染进程批量上报，主进程按天写文件（见 electron/log-file.cjs）
  appendLog: (text) => invoke('log:append', text),
  logPath: () => invoke('log:path'),
  openLogFolder: () => invoke('log:open'),
  onCaptureSaved: (cb) => on('capture:saved', cb),
  onMainTarget: (cb) => on('app:main-target', cb),
  // 桌面通知点击后回到对应的 AI 生成器
  onBuilderFocus: (cb) => on('app:builder-focus', cb),
  onCommand: (cb) => on('app:command', cb),
  onWindowHidden: (cb) => on('app:window-hidden', cb),
  onQuitRequest: (cb) => on('app:quit-request', cb),
  quitReady: () => invoke('app:quit-ready'),
});
