import { useEffect } from 'react';
import { Sparkles } from 'lucide-react';
import { useApp } from './store/app';
import { visibleNotes } from './lib/view';
import { exportNoteMarkdown } from './lib/export';
import { canCommitNow } from './lib/git';
import { SHORTCUTS, loadBindings, matchCombo } from './lib/shortcuts';
import * as repo from './lib/repo';
import { desktop, type MainOpenTarget } from './lib/desktop';
import { getActiveView } from './lib/editorBridge';
import { isNoteWindow } from './lib/windowMode';
import { snoozeReminder } from './lib/reminders';
import { cn } from './lib/utils';
import { TitleBar } from './components/TitleBar';
import { Sidebar } from './components/Sidebar';
import { NoteList } from './components/NoteList';
import { EditorPane } from './components/EditorPane';
import { TaskPanel } from './components/TaskPanel';
import { TaskDetail } from './components/TaskDetail';
import { HomePage } from './components/HomePage';
import { IdeasPanel } from './components/IdeasPanel';
import { Palette } from './components/Palette';
import { SettingsModal } from './components/SettingsModal';
import { SyncInvite } from './components/SyncInvite';
import { MoveDialog } from './components/MoveDialog';
import { Toasts } from './components/Toasts';
import { LockScreen } from './components/LockScreen';
import { TaskReminders } from './components/TaskReminders';
import { RepoPrivacyGate } from './components/RepoPrivacyGate';
import { CloudPushAutoSync } from './components/CloudPushAutoSync';
import { PrivacyAutoSync } from './components/PrivacyAutoSync';
import { UpdateDialog } from './components/UpdateDialog';
import { PrivacyDialog } from './components/PrivacyDialog';
import { usePrivacy } from './store/privacy';
import { useHome } from './store/home';
import { noteNeedsPassword } from './lib/privacy';
import { useLang, useT } from './lib/i18n';

let started = false;

const detachedWindow = isNoteWindow;

/**
 * 把编辑器里还没到 180ms 防抖的输入立刻交给 store。
 * 富文本编辑器监听 glimnote:flush-editor；源码模式直接从 CodeMirror 取文档。
 * 关窗、隐藏到托盘、退出前都要先做这一步，否则最后几个字会丢。
 */
function commitActiveEditor() {
  window.dispatchEvent(new Event('glimnote:flush-editor'));
  const view = getActiveView();
  const cur = useApp.getState().current;
  if (view && cur) useApp.getState().updateContent(cur.id, view.state.doc.toString());
}

function Splash() {
  const t = useT();
  return (
    <div className="splash">
      <div className="splash-inner">
        <div className="mark-lg">
          <Sparkles size={20} strokeWidth={1.75} />
        </div>
        <div className="bar">
          <i />
        </div>
        <span>{t('正在打开你的笔记本…')}</span>
      </div>
    </div>
  );
}

export default function App() {
  const t = useT();
  const lang = useLang();
  const ready = useApp((s) => s.ready);
  const init = useApp((s) => s.init);
  const notes = useApp((s) => s.notes);
  const current = useApp((s) => s.current);
  const view = useApp((s) => s.view);
  const query = useApp((s) => s.query);
  const focusMode = useApp((s) => s.focusMode);
  const typewriter = useApp((s) => s.typewriter);
  const toggleTypewriter = useApp((s) => s.toggleTypewriter);
  const cfg = useApp((s) => s.cfg);
  const token = useApp((s) => s.token);
  const syncInterval = useApp((s) => s.syncInterval);
  const locked = useApp((s) => s.locked);
  const currentLocked = usePrivacy((s) => (current ? noteNeedsPassword(current, s, s.unlocked) : false));

  useEffect(() => {
    // 锁着的时候先别读仓库、别自动同步：解锁后再启动，避免密码还没输就先拉了一轮数据
    if (started || locked) return;
    started = true;
    void init();
  }, [init, locked]);

  // 隐私解锁只在当前这篇笔记 / 这个页面内有效：切到别的笔记或页面就自动重新上锁
  useEffect(() => {
    if (!ready) return;
    usePrivacy.getState().relockAway(current ? { id: current.id, notebook: current.notebook || '' } : null, view);
  }, [ready, current?.id, current?.notebook, view.type, view.value]);

  useEffect(() => {
    // 单篇窗口没有侧栏、列表和设置面板，主窗口的全局快捷键在这里只会打开看不见的东西
    if (detachedWindow) return;
    const onKey = (e: KeyboardEvent) => {
      const s = useApp.getState();
      if (s.locked) return;
      if (e.key === 'Escape') {
        if (s.paletteOpen) {
          s.setPalette(false);
          return;
        }
        if (s.settingsOpen) {
          s.setSettings(false);
          return;
        }
        if (s.moveNoteId) {
          s.setMoveNote(null);
          return;
        }
        if (s.focusMode) s.toggleFocus();
        return;
      }

      // 快捷键可在「设置 → 快捷键」里改，这里按配置逐条匹配
      const bindings = loadBindings();
      for (const def of SHORTCUTS) {
        if (!matchCombo(e, bindings[def.id])) continue;
        let handled = true;
        switch (def.id) {
          case 'home':
            s.setView({ type: 'smart', value: 'home' });
            break;
          case 'palette':
            s.setPalette(true, 'search');
            break;
          case 'switch':
            s.setPalette(true, 'switch');
            break;
          case 'new':
            void s.create();
            break;
          case 'daily':
            void s.openDaily();
            break;
          case 'settings':
            s.setSettings(!s.settingsOpen);
            break;
          case 'sidebar':
            s.toggleSidebar();
            break;
          case 'focus':
            s.toggleFocus();
            break;
          case 'toc':
            s.toggleToc();
            break;
          case 'typewriter':
            s.toggleTypewriter();
            break;
          case 'sync':
            // 手动同步 = 明确要求现在提交，不等自动提交间隔
            void s.syncNow(true);
            break;
          case 'move':
            if (s.current) s.setMoveNote(s.current.id);
            else handled = false;
            break;
          case 'export':
            if (s.current) {
              exportNoteMarkdown(s.current);
              s.toast('已导出当前笔记', 'success');
            } else handled = false;
            break;
        }
        if (handled) e.preventDefault();
        return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    // 托盘命令、速记保存都只属于主窗口；单篇窗口跟着响应会多建一次笔记 / 多同步一轮
    if (detachedWindow) return;
    const bridge = desktop();
    if (!bridge) return;
    void bridge.setCloseToTray(localStorage.getItem('glimnote.closeToTray') !== '0');
    const offCapture = bridge.onCaptureSaved((info) => {
      void (async () => {
        // 快速捕获现在写进灵感库：刷新后提示，并允许撤销
        if (info.notebook === 'ideas') {
          await useApp.getState().loadIdeas(true);
          const s = useApp.getState();
          const created = s.ideas.find((i) => i.id === info.id);
          s.toast(
            `${t('已存入灵感')} · ${info.title}`,
            'success',
            created
              ? {
                  label: t('撤销'),
                  run: async () => {
                    await repo.deleteIdea(created);
                    await useApp.getState().loadIdeas(true);
                    useApp.getState().toast(t('已撤销这次速记'), 'info');
                  },
                }
              : undefined,
          );
          return;
        }
        await useApp.getState().refresh();
        const s = useApp.getState();
        const created = s.notes.find((n) => n.id === info.id);
        s.toast(
          `${t('已存入 inbox')} · ${info.title}`,
          'success',
          created
            ? {
                label: t('撤销'),
                run: async () => {
                  await repo.purgeNote(created);
                  await useApp.getState().refresh();
                  useApp.getState().toast(t('已撤销这次速记'), 'info');
                },
              }
            : undefined,
        );
      })();
    });
    const offCommand = bridge.onCommand((command) => {
      if (command === 'sync-now') void useApp.getState().syncNow(true);
      else if (command === 'new-note') void useApp.getState().create();
      // 点了更新通知：直接打开「设置 → 关于」，由用户决定更新还是忽略
      else if (command === 'open-update') useApp.getState().setSettings(true, 'about');
    });
    return () => {
      offCapture();
      offCommand();
    };
  }, []);

  useEffect(() => {
    if (view.type === 'trash') return;
    const list = visibleNotes(notes, view, query);
    if (current && list.some((n) => n.id === current.id)) return;
    if (list[0]) useApp.getState().select(list[0].id);
  }, [notes, view, query, current]);

  useEffect(() => {
    // 云同步只由主窗口做：两个窗口同时 pull/push 会抢 .git/index
    if (detachedWindow || !ready || !cfg || !token) return;
    const timer = window.setTimeout(() => void useApp.getState().syncNow(), 1600);
    return () => window.clearTimeout(timer);
  }, [ready, cfg, token]);

  // MCP / 其他程序改的是磁盘文件，窗口回到前台时补读一次（有未落盘编辑会自动跳过）
  useEffect(() => {
    if (!ready) return;
    const check = () => void useApp.getState().refreshFromDisk();
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      check();
      // 从最小化 / 其他桌面切回来时顺手看一眼远端：syncNow 自己限频，频繁切换不会重复拉取
      const s = useApp.getState();
      if (s.cfg && s.token && s.syncState !== 'syncing') void s.syncNow();
    };
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [ready]);

  // 上锁状态同步给主进程：托盘快捷键不能绕过锁屏打开待办浮窗
  useEffect(() => {
    if (detachedWindow) return;
    void desktop()?.setLocked?.(locked);
  }, [locked]);

  // 浮窗直接写的是磁盘文件：它改完发 card:changed，主窗口把两库重读一遍。
  // 即使当前还没打开待办页也要标记待同步，否则这次改动会等到下次人工同步才上传。
  useEffect(() => {
    if (detachedWindow) return;
    const bridge = desktop();
    if (!bridge?.onCardChanged) return;
    return bridge.onCardChanged(() => {
      const s = useApp.getState();
      if (s.tasksLoaded) void s.loadTasks(true);
      if (s.ideasLoaded) void s.loadIdeas(true);
      // 浮窗也能拖动快捷入口：顺序直接写进 home/，主窗口必须重读并进同步队列
      if (useHome.getState().loaded) void useHome.getState().load(true);
      s.markPending();
    });
  }, []);

  // 浮窗里点了「笔记本 / 智能视图」：主进程把目标转过来，这里只负责切视图。
  // 不新建窗口、也不复制一套选中逻辑，和侧栏点击走同一个 setView。
  useEffect(() => {
    if (detachedWindow) return;
    const bridge = desktop();
    if (!bridge?.onMainTarget) return;
    return bridge.onMainTarget((target: MainOpenTarget) => {
      if (!target) return;
      const s = useApp.getState();
      s.setQuery('');
      if (target.kind === 'home') {
        s.setView({ type: 'smart', value: 'home' });
      } else if (target.kind === 'notebook') {
        s.setView({ type: 'notebook', value: target.value || '' });
      } else if (target.kind === 'view' && target.value) {
        s.setView({ type: 'smart', value: target.value });
      }
    });
  }, []);

  // 主窗口里改快捷入口（新增 / 删除 / 排序）时，正在开着的浮窗也要跟着刷新；
  // 连续操作合并成一次，避免每拖一下就重读一遍 home/。
  useEffect(() => {
    if (detachedWindow) return;
    const bridge = desktop();
    if (!bridge?.refreshCard) return;
    let timer = 0;
    const unsub = useHome.subscribe((state, prev) => {
      if (state.groups === prev.groups && state.entries === prev.entries) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void bridge.refreshCard?.(), 350);
    });
    return () => {
      window.clearTimeout(timer);
      unsub();
    };
  }, []);

  // 桌面右下角提醒浮层里点了按钮：完成 / 延后 / 打开都回到主窗口，沿用原有逻辑
  useEffect(() => {
    if (detachedWindow) return;
    const bridge = desktop();
    if (!bridge?.onReminderAction) return;
    return bridge.onReminderAction(({ action, id }) => {
      const s = useApp.getState();
      if (action === 'snooze') {
        const task = s.tasks.find((t) => t.id === id);
        if (task) snoozeReminder(task);
        return;
      }
      if (action === 'done') {
        const task = s.tasks.find((t) => t.id === id);
        // toggleTask 是开关：已经完成的任务不能再点一次把它翻回未完成
        if (task && task.status !== 'done') void s.toggleTask(id);
        return;
      }
      if (action === 'open') {
        if (id) {
          s.selectTask(id);
          s.setView({ type: 'smart', value: 'todo' });
        }
        void bridge.showMain?.();
      }
    });
  }, []);

  // 主窗口里改了任务 / 灵感，通知已打开的浮窗重读；连续修改合并成一次
  useEffect(() => {
    if (detachedWindow) return;
    const bridge = desktop();
    if (!bridge?.refreshCard) return;
    let timer = 0;
    const unsub = useApp.subscribe((state, prev) => {
      if (state.tasks === prev.tasks && state.ideas === prev.ideas) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void bridge.refreshCard?.(), 350);
    });
    return () => {
      window.clearTimeout(timer);
      unsub();
    };
  }, []);

  useEffect(() => {
    if (detachedWindow || !cfg || !token) return;
    const tick = window.setInterval(() => {
      const s = useApp.getState();
      // 有未提交改动时，只有到了自动提交间隔才发请求；否则交给下面的定时拉取
      if (s.syncState === 'pending' && canCommitNow()) void s.syncNow();
    }, 60000);
    const onFocus = () => {
      const s = useApp.getState();
      if (s.cfg && s.token && s.syncState !== 'syncing') void s.syncNow();
    };
    const onOnline = () => {
      const s = useApp.getState();
      if (s.cfg && s.token) void s.syncNow();
    };
    window.addEventListener('focus', onFocus);
    window.addEventListener('online', onOnline);
    return () => {
      window.clearInterval(tick);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('online', onOnline);
    };
  }, [cfg, token]);

  useEffect(() => {
    if (detachedWindow || !cfg || !token || syncInterval <= 0) return;
    const timer = window.setInterval(() => {
      // 窗口在后台 / 收进托盘时不轮询：回来时 focus / visibilitychange 会立刻检查一次，
      // 挂在后台一整天也不该每分钟发一次请求
      if (document.hidden) return;
      const s = useApp.getState();
      // error 已经由同步自身的退避重试接管；这里再触发会叠成「每分钟重试一次」的死循环。
      // 失败停下后由用户点同步、窗口重新获得焦点或网络恢复来重新发起。
      if (
        s.syncState === 'syncing' ||
        s.syncState === 'conflict' ||
        s.syncState === 'offline' ||
        s.syncState === 'error'
      ) {
        return;
      }
      void s.syncNow();
    }, syncInterval * 60000);
    return () => window.clearInterval(timer);
  }, [cfg, token, syncInterval]);

  // 桌面端关窗进托盘、再从托盘打开时，主进程会发来 window-hidden。
  // 上锁会卸载编辑器，所以先把还在 700ms 防抖里的内容落盘，再强制提交推送一次，最后才上锁。
  useEffect(() => {
    if (detachedWindow) return;
    const bridge = desktop();
    if (!bridge?.onWindowHidden) return;
    return bridge.onWindowHidden(() => {
      const s = useApp.getState();
      void (async () => {
        try {
          commitActiveEditor();
          await s.flushPendingWrites();
        } catch {
          /* 落盘失败也要继续上锁，内容仍在内存里，下次交互会重试 */
        }
        const now = useApp.getState();
        if (now.cfg && now.token && now.syncState === 'pending') void now.syncNow(true);
        now.lockNow();
      })();
    });
  }, []);

  // 退出程序（托盘「退出」、关闭窗口即退出、⌘Q）前，主进程会先来问一次：
  // 留出最多几秒把未提交的改动提交并推送，再真正退出。失败也不阻塞退出，本地已经落盘。
  useEffect(() => {
    if (detachedWindow) return;
    const bridge = desktop();
    if (!bridge?.onQuitRequest) return;
    return bridge.onQuitRequest(() => {
      void (async () => {
        const s = useApp.getState();
        try {
          commitActiveEditor();
          await Promise.race([s.flushPendingWrites(), new Promise((r) => setTimeout(r, 800))]);
          if (s.cfg && s.token) {
            await Promise.race([s.syncNow(true, true), new Promise((r) => setTimeout(r, 2500))]);
          }
        } catch {
          /* 尽力而为：离线或认证失败时，改动仍在本地，下次启动继续同步 */
        } finally {
          void bridge.quitReady?.();
        }
      })();
    });
  }, []);

  // 单篇窗口：主进程关窗前会先来要一次落盘，确认之后窗口才真正关闭
  useEffect(() => {
    if (!detachedWindow) return;
    const bridge = desktop();
    if (!bridge?.onNoteCloseRequest) return;
    const flushThen = (done?: () => Promise<boolean>) => {
      void (async () => {
        try {
          commitActiveEditor();
          await useApp.getState().flushPendingWrites();
        } catch {
          /* 写盘失败也让窗口能关；内容还在内存里，主窗口下次交互会重试 */
        } finally {
          await done?.();
        }
      })();
    };
    const offClose = bridge.onNoteCloseRequest(() => flushThen(bridge.noteCloseReady));
    const offFlush = bridge.onNoteFlushRequest?.(() => flushThen(bridge.noteFlushReady));
    return () => {
      offClose();
      offFlush?.();
    };
  }, []);

  // 窗口标题跟着笔记走：任务栏 / Alt+Tab 里能分清哪扇窗是哪篇
  useEffect(() => {
    // 主窗口和单篇窗口共用：任务栏 / Alt+Tab 里能分清哪扇窗是哪篇，切语言也会跟着更新
    const brand = t('萤光笔记');
    document.title = current ? `${currentLocked ? t('隐私笔记') : current.title || t('未命名笔记')} · ${brand}` : brand;
  }, [current?.title, currentLocked, lang]);

  // 锁屏时也保留提醒调度：到点改走系统通知，不把待办标题画在锁屏上
  if (locked) {
    return (
      <>
        <LockScreen />
        <TaskReminders />
        <UpdateDialog />
      </>
    );
  }
  if (!ready) return <Splash />;

  // 单篇窗口只有一篇文章，不要侧栏和列表，把宽度留给正文
  if (detachedWindow) {
    return (
      <div className="app solo">
        <TitleBar solo />
        <div className="main">
          <EditorPane />
        </div>
        <PrivacyDialog />
        <Toasts />
      </div>
    );
  }

  // 首页整块接管中栏与右栏
  const isHome = view.type === 'smart' && view.value === 'home';
  // 待办是独立任务库：中栏换成任务列表，右栏换成任务详情
  const isTodo = view.type === 'smart' && view.value === 'todo';
  // 灵感没有编辑器，整块接管中栏与右栏
  const isIdeas = view.type === 'smart' && view.value === 'ideas';

  return (
    <div className={cn('app', focusMode && 'focus-mode')}>
      <TitleBar />
      <div className="main">
        <Sidebar />
        {isHome ? <HomePage /> : isTodo ? <TaskPanel /> : isIdeas ? <IdeasPanel /> : <NoteList />}
        {isHome ? null : isTodo ? <TaskDetail /> : isIdeas ? null : <EditorPane />}
        {focusMode && (
          <div className="focus-topbar">
            <span>{t('专注模式 · Esc 退出')}</span>
            {current && <span>· {currentLocked ? t('隐私笔记') : current.title}</span>}
            <button
              className={cn('focus-chip', typewriter && 'on')}
              onClick={toggleTypewriter}
              title={t('打字机模式：光标始终保持垂直居中')}
              aria-pressed={typewriter}
            >
              {t('打字机')}
            </button>
          </div>
        )}
      </div>
      <Palette />
      <SettingsModal />
      <SyncInvite />
      <MoveDialog />
      <TaskReminders />
      <RepoPrivacyGate />
      <CloudPushAutoSync />
      <PrivacyAutoSync />
      <PrivacyDialog />
      <UpdateDialog />
      <Toasts />
    </div>
  );
}
