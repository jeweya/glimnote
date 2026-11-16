import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Clock, HelpCircle, PanelLeft, PictureInPicture2, RefreshCw, Search, Sparkles } from 'lucide-react';
import { useApp, type SyncState } from '../store/app';
import { desktop } from '../lib/desktop';
import { commitDueAt } from '../lib/git';
import { cn } from '../lib/utils';
import { useT } from '../lib/i18n';

const SYNC_LABELS: Record<SyncState, string> = {
  local: '仅本地',
  pending: '已保存',
  syncing: '同步中',
  synced: '已同步',
  offline: '离线',
  error: '同步失败',
  conflict: '需要处理',
};

export function SyncPill() {
  const t = useT();
  const syncState = useApp((s) => s.syncState);
  const syncMessage = useApp((s) => s.syncMessage);
  const cfg = useApp((s) => s.cfg);
  const token = useApp((s) => s.token);
  const ready = useApp((s) => s.ready);
  const setSettings = useApp((s) => s.setSettings);
  const syncNow = useApp((s) => s.syncNow);
  const commitEvery = useApp((s) => s.commitInterval);
  const [online, setOnline] = useState(navigator.onLine);
  const [helpOpen, setHelpOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);

  const effective: SyncState = cfg && !online ? 'offline' : syncState;
  /**
   * 「连上了」= 有仓库配置 + 有能用的令牌。
   * 只看 cfg 是不够的：令牌在网页版是 sessionStorage、换标签页就没了，
   * 桌面端重启时也要等主进程把密文取回来——这期间同步其实是停的，
   * 必须重新做成「继续同步 →」的入口，而不是一个不会动的灰点。
   */
  const connected = Boolean(cfg && token);
  const label = !connected ? t('仅本地') : effective === 'pending' ? t('已保存') : t(SYNC_LABELS[effective]);
  /** 还没真正连上时，把这条状态做成明确的入口 */
  const setup = ready && !connected;
  const needToken = Boolean(cfg) && !token;
  const canExplain = effective === 'pending';

  /**
   * 「已保存」状态下显示距离下一次自动上传还有多久。
   * 用户最想知道的是「它自己会不会传、什么时候传」，把答案直接放在胶囊上，
   * 就不会因为看不见进度而反复点同步。
   */
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (effective !== 'pending') return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [effective]);

  const dueAt = commitDueAt();
  const remainMin = dueAt ? Math.max(0, Math.ceil((dueAt - now) / 60000)) : 0;
  const etaText =
    remainMin <= 0
      ? t('即将自动上传')
      : remainMin >= 90
        ? t('约 {n} 小时后自动上传', { n: Math.round(remainMin / 60) })
        : t('约 {n} 分钟后自动上传', { n: remainMin });
  const etaShort =
    remainMin <= 0
      ? t('即将上传')
      : remainMin >= 90
        ? t('约 {n} 小时后上传', { n: Math.round(remainMin / 60) })
        : t('约 {n} 分钟后上传', { n: remainMin });

  useEffect(() => {
    if (!helpOpen) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setHelpOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setHelpOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [helpOpen]);

  useEffect(() => {
    if (!canExplain) setHelpOpen(false);
  }, [canExplain]);

  return (
    <div className="sync-wrap" ref={wrapRef}>
      <button
        className={cn('sync-pill no-drag', setup && 'setup', effective === 'pending' && 'pending')}
        aria-label={
          setup
            ? needToken
              ? t('重新连接云端同步')
              : t('笔记仅保存在本地，点击设置同步')
            : effective === 'pending'
              ? t('已保存到本机，{eta}，点击立即上传', { eta: etaText })
              : label
        }
        title={
          setup
            ? needToken
              ? t('这个设备还没有可用的授权令牌（重启应用或换浏览器后需要重新粘贴一次）。点这里重新连接，笔记和仓库设置都还在')
              : t('笔记只存在这台电脑。点这里连接 GitCode、Gitee 或 GitHub 的私有仓库，免费、自动同步')
            : effective === 'pending'
              ? t('已保存到本机，{eta}。不用手动点；想马上上传可点这里或按 Ctrl+Shift+S', { eta: etaText })
              : syncMessage || t('点击立即同步（Ctrl+Shift+S）')
        }
        onClick={() => {
          if (setup) setSettings(true, 'sync');
          else if (effective === 'conflict' || effective === 'error') setSettings(true, 'sync');
          else void syncNow(true);
        }}
      >
        {effective === 'syncing' ? (
          <RefreshCw size={14} className="spin" />
        ) : effective === 'pending' ? (
          <Clock size={12} strokeWidth={1.9} className="sync-clock" />
        ) : (
          <span className={cn('sync-dot', setup ? 'setup' : effective)} />
        )}
        <span>{label}</span>
        {effective === 'pending' && <span className="sync-eta">· {etaShort}</span>}
        {setup && (
          <span className="sync-pill-cta">
            {needToken ? t('继续同步') : t('开启同步')}
            <ArrowRight size={11} strokeWidth={2} />
          </span>
        )}
      </button>
      {canExplain && (
        <button
          className={cn('sync-help-btn no-drag', helpOpen && 'on')}
          aria-label={t('自动同步说明：多久上传一次、保存在哪里')}
          aria-expanded={helpOpen}
          title={t('多久自动上传一次？查看保存与上传说明')}
          onClick={() => setHelpOpen((v) => !v)}
        >
          <HelpCircle size={13} strokeWidth={1.9} />
        </button>
      )}
      {helpOpen && (
        <div className="sync-help-pop no-drag" role="dialog" aria-label={t('自动同步说明')}>
          <div className="shp-title">{t('自动同步：每 {n} 分钟上传一次', { n: commitEvery })}</div>
          <div className="shp-now">
            <Clock size={13} strokeWidth={1.9} />
            <span>{t('现在：已保存在本机，{eta}。不用手动点。', { eta: etaText })}</span>
          </div>
          <p>
            <b>{t('本地保存：')}</b>
            {t('停止打字约 0.7 秒后自动写入这台电脑。断网、没登录都不影响，每篇笔记还会保留最近 40 个历史版本。')}
          </p>
          <p>
            <b>{t('云端上传：')}</b>
            {t('有改动后最多等 {n} 分钟，把这段时间的修改合并成一次 Git 提交再上传。可在「设置 → 同步 → 自动提交」调整。', { n: commitEvery })}
          </p>
          <p>
            <b>{t('想马上上传：')}</b>
            {t('按')} <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>S</kbd>{' '}
            {t('，或点左上角的「已保存」。关窗到托盘、退出程序前也会自动提交一次。')}
          </p>
          <p className="shp-note">
            {t('为什么不实时提交：Git 每提交一次，都会把改动文件的完整副本存进历史，图片和附件也算在内。Gitee 免费仓库只有 500MB，提交太密会很快占满；合并提交不会影响本地保存，也不影响历史版本回滚。')}
          </p>
        </div>
      )}
    </div>
  );
}

export function TitleBar({ solo = false }: { solo?: boolean }) {
  const t = useT();
  const toggleSidebar = useApp((s) => s.toggleSidebar);
  const setPalette = useApp((s) => s.setPalette);
  const setView = useApp((s) => s.setView);
  const toast = useApp((s) => s.toast);
  const bridge = desktop();
  const [floatOpen, setFloatOpen] = useState(false);

  /**
   * 浮窗按钮：先问主进程真实状态再决定开还是收，避免本地状态过期时
   * 点「打开」反而把已经存在的窗口收起来；打不开时明确说明原因。
   */
  const toggleFloat = async () => {
    if (!bridge?.openCard) return;
    try {
      // 新版本主进程统一判断：刚刚显示过的浮窗再点一次只叫到最前面，不收起。
      // 旧版没有 toggleCard 时退回原来的「可见就收起」逻辑。
      if (bridge.toggleCard) {
        const result = await bridge.toggleCard();
        setFloatOpen(Boolean(result.visible));
        if (!result.ok) {
          toast(
            result.reason === 'locked'
              ? t('应用已上锁：先在主窗口输入密码解锁，再打开浮窗；可以在「设置 → 安全 → 密码锁」关闭。')
              : t('浮窗没能打开，可以再试一次'),
            'error',
          );
        }
        return;
      }
      const actual = (await bridge.isCardOpen?.()) ?? floatOpen;
      if (actual) {
        await bridge.hideCard?.();
        setFloatOpen(false);
        return;
      }
      const result = await bridge.openCard();
      const ok = typeof result === 'object' ? result.ok : result !== false;
      setFloatOpen(Boolean(ok));
      if (!ok) {
        const reason = typeof result === 'object' ? result.reason : '';
        toast(
          reason === 'locked'
            ? t('应用已上锁：先在主窗口输入密码解锁，再打开浮窗；可以在「设置 → 安全 → 密码锁」关闭。')
            : t('浮窗没能打开，可以再试一次'),
          'error',
        );
      }
    } catch {
      toast(t('浮窗没能打开，可以再试一次'), 'error');
    }
  };

  // 浮窗按钮跟着真实窗口状态走：打开后高亮，再点一下收起
  useEffect(() => {
    if (solo || !bridge?.isCardOpen) return;
    let alive = true;
    void bridge
      .isCardOpen()
      .then((open) => {
        if (alive) setFloatOpen(open);
      })
      .catch(() => {});
    const off = bridge.onCardVisibility?.((open) => setFloatOpen(open));
    return () => {
      alive = false;
      off?.();
    };
  }, [bridge, solo]);

  // 单篇窗口只留拖拽区：没有侧栏可收，云同步也由主窗口负责
  if (solo) {
    return (
      <header className="titlebar">
        <div className="brand">
          <span className="brand-mark">
            <Sparkles size={14} strokeWidth={1.75} />
          </span>
          <span>{t('萤光笔记')}</span>
        </div>
        <span className="titlebar-sub">{t('单篇窗口 · 修改会自动保存')}</span>
        <div className="titlebar-spacer" />
      </header>
    );
  }

  return (
    <header className="titlebar">
      <button className="titlebar-btn no-drag" onClick={toggleSidebar} title={t('收起 / 展开侧栏  Ctrl+\\')}>
        <PanelLeft size={16} strokeWidth={1.75} />
      </button>
      <button
        className="brand brand-home no-drag"
        title={t('回到首页  Ctrl+Shift+H')}
        onClick={() => setView({ type: 'smart', value: 'home' })}
      >
        <span className="brand-mark">
          <Sparkles size={14} strokeWidth={1.75} />
        </span>
        <span>{t('萤光笔记')}</span>
      </button>
      <SyncPill />
      <div className="titlebar-spacer" />
      <div className="titlebar-actions">
        <button className="icon-btn" onClick={() => setPalette(true, 'search')} title={t('搜索  Ctrl+K')} aria-label={t('搜索')}>
          <Search size={16} strokeWidth={1.75} />
        </button>
        {bridge?.openCard && (
          <button
            className={cn('float-pill no-drag', floatOpen && 'is-open')}
            onClick={() => void toggleFloat()}
            title={floatOpen ? t('收起桌面浮窗') : t('打开桌面浮窗：待办、灵感随手记')}
            aria-label={floatOpen ? t('收起桌面浮窗') : t('打开桌面浮窗')}
            aria-pressed={floatOpen}
          >
            <PictureInPicture2 size={15} strokeWidth={1.8} />
            <span>{t('浮窗')}</span>
          </button>
        )}
      </div>
    </header>
  );
}
