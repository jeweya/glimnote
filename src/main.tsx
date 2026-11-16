// 必须排在所有模块之前：isomorphic-git 依赖全局 Buffer，晚一步就会在首次同步时报错
import './lib/bufferPolyfill';
import { createRoot } from 'react-dom/client';
import App from './App';
import { AppWindow } from './components/AppWindow';
import { AppDock } from './components/AppDock';
import { AppBuilderHost } from './components/AppBuilderHost';
import { CaptureApp } from './components/CaptureApp';
import { CardApp } from './components/CardApp';
import { ReminderApp } from './components/ReminderApp';
import { ErrorBoundary } from './components/ErrorBoundary';
import { desktop } from './lib/desktop';
import { installLogCapture, log } from './lib/log';
import './styles/tokens.css';
import './styles/app.css';
import './styles/extra.css';
import './styles/home.css';
import './styles/card.css';
import './styles/error.css';

const savedSize = localStorage.getItem('glimnote.editorSize');
if (savedSize) document.documentElement.style.setProperty('--editor-size', `${savedSize}px`);
const savedMeasure = localStorage.getItem('glimnote.measure');
if (savedMeasure) document.documentElement.style.setProperty('--editor-measure', savedMeasure);

const params = new URLSearchParams(window.location.search);
const capture = params.get('capture') === '1';
// 桌面悬浮卡片走同一个 index.html，只是换一套根组件；transparent 窗体需要 body 透明
const card = params.get('card') === '1';
if (card) document.documentElement.dataset.window = 'card';
// 独立小应用窗口：一个应用一个窗口，内容由 AppWindow 自己读 apps/<id>/
const appWin = Boolean(params.get('app'));
if (appWin) document.documentElement.dataset.window = 'app';
// 桌面底部的合并条：收成一条的小应用都列在这里，同样是透明窗体
const dock = params.get('dock') === '1';
if (dock) document.documentElement.dataset.window = 'dock';
// 到点提醒的桌面浮层：同样是透明窗体，贴在屏幕右下角
const reminder = params.get('reminder') === '1';
if (reminder) document.documentElement.dataset.window = 'reminder';

installLogCapture();
if (!capture && !card && !appWin && !dock && !reminder) {
  // 开发模式下页面也走 http，所以按「有没有桌面桥」判断，而不是看协议
  log('app', 'info', `界面启动 · ${desktop() ? '桌面版' : '网页版'}`);
}

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    {capture ? (
      <CaptureApp />
    ) : card ? (
      <CardApp />
    ) : appWin ? (
      <AppWindow />
    ) : dock ? (
      <AppDock />
    ) : reminder ? (
      <ReminderApp />
    ) : (
      <>
        <App />
        {/* 生成器挂在 App 旁边：切页面、锁屏、收进托盘都不会打断后台生成 */}
        <AppBuilderHost />
      </>
    )}
  </ErrorBoundary>,
);

/*
 * 桌面版不注册 Service Worker。
 *
 * 它是给网页版断网打开用的，但桌面版用 file:// 加载页面，Service Worker 会在
 * file:// 上拦截页面导航、拿不到响应，Chromium 记成 -2 ERR_FAILED。主窗口有
 * 「清缓存 + 重试」勉强能自救，浮窗 / 小应用窗口没有重试，表现就是窗口出来了、
 * 里面一片空白。旧版本已经把 SW 装进了本机配置，这里顺手注销，主进程启动时
 * 也会整体清一次。
 */
if (desktop() && 'serviceWorker' in navigator) {
  void navigator.serviceWorker
    .getRegistrations()
    .then((regs) => Promise.all(regs.map((reg) => reg.unregister())))
    .catch(() => {
      /* 注销失败不影响界面，主进程启动时还会再清一次 */
    });
}

if (
  !capture &&
  !card &&
  !appWin &&
  !dock &&
  !reminder &&
  !desktop() &&
  'serviceWorker' in navigator &&
  import.meta.env.PROD
) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker
      .register(`${import.meta.env.BASE_URL}sw.js`)
      .then(async () => {
        const reg = await navigator.serviceWorker.ready;
        // 首次访问时页面资源是在 SW 接管前加载的，主动把已加载的资源补进缓存，
        // 否则断网重开会拿到 index.html 却缺 JS / CSS。
        const urls = performance
          .getEntriesByType('resource')
          .map((entry) => entry.name)
          .filter((url) => url.startsWith(window.location.origin));
        reg.active?.postMessage({ type: 'cache-assets', urls: [...new Set(urls)] });
      })
      .catch(() => {
        /* PWA 离线能力在部分环境不可用 */
      });
  });
}
