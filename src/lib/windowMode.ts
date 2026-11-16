import { desktop } from './desktop';

/**
 * 单篇窗口：用 `?note=<id>` 打开同一个前端。
 *
 * 它和主窗口共享同一份笔记文件（桌面端都走 preload 的文件 IPC），但不能各同步各的：
 * isomorphic-git 会同时写 `.git/index`，两个窗口一起 pull / push 只会互相抢锁。
 * 所以单篇窗口只负责读写本地文件，云端同步留给主窗口；关窗和退出前由主进程等它
 * 把还在防抖里的内容落盘，再真正关闭。
 */
const params = new URLSearchParams(window.location.search);
export const noteWindowId = params.get('note') || '';
export const isNoteWindow = Boolean(noteWindowId);
/** 独立小应用窗口：`?app=<id>`，同一个应用可以开多个 */
export const appWindowId = params.get('app') || '';
/** 从主窗口面板图钉打开：窗口创建时就置顶，标题栏图钉直接显示为选中 */
export const appWindowPinned = params.get('pinned') === '1';
/** 网页版多开用的窗口名序号：同一毫秒内连点两次也不会撞名 */
let appPopupSeq = 0;

/**
 * 在独立窗口里打开 AI 小应用；桌面端走主进程，网页端退化为新标签页。
 * 只有浮窗「小应用」tab 会传 multiple=true，允许同一应用开多个；
 * 其它入口复用同一个窗口，避免一个应用被重复点出一排窗口。
 * 所有独立窗口的行为一致：常驻桌面、显示在任务栏，最小化收进底部合并条
 * （由主进程统一管理，入口不同不再分两套逻辑）。
 * `pinned=true` 时新窗口直接置顶（主窗口面板的图钉走这条路）。
 *
 * 桌面端返回的 Promise 在新窗口真正显示（ready-to-show）后才 resolve，
 * 主窗口面板可以等它再收起，避免「先关面板、后弹窗口」的闪烁。
 */
export function openAppInNewWindow(
  id: string,
  options: { multiple?: boolean; pinned?: boolean } = {},
): Promise<boolean> {
  if (!id) return Promise.resolve(false);
  const bridge = desktop();
  if (bridge?.openAppWindow) return bridge.openAppWindow(id, options);
  const url = new URL(window.location.href);
  url.search = '';
  url.searchParams.set('app', id);
  // 多开时给窗口名加递增序号，浏览器才不会把第二次打开并回同一个标签页
  const name = options.multiple ? `glimnote-app-${id}-${++appPopupSeq}` : `glimnote-app-${id}`;
  const popup = window.open(url.toString(), name, 'popup=yes,width=980,height=760');
  return Promise.resolve(Boolean(popup));
}

/** 双击笔记时调用：桌面端开真正的新窗口，网页端退化为新标签页 */
export function openNoteInNewWindow(id: string) {
  if (!id) return;
  const bridge = desktop();
  if (bridge?.openNoteWindow) {
    void bridge.openNoteWindow(id);
    return;
  }
  const url = new URL(window.location.href);
  url.search = '';
  url.searchParams.set('note', id);
  // 命名窗口：同一篇笔记重复双击时复用，不会开出一串一模一样的标签页
  window.open(url.toString(), `glimnote-note-${id}`, 'popup=yes,width=1000,height=820');
}
