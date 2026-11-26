import { useEffect, useRef, useState } from 'react';
import {
  Check,
  ChevronDown,
  Cloud,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  FileDown,
  FolderOpen,
  HardDrive,
  HelpCircle,
  Info,
  KeyRound,
  Loader2,
  Package,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  Sparkles,
  Trash2,
  Upload,
  X,
  Zap,
} from 'lucide-react';
import { useApp, type SettingsTab } from '../store/app';
import { setLang, useLang, useT } from '../lib/i18n';
import { LockSettings } from './LockSettings';
import { McpSettings } from './McpSettings';
import { ModelPicker } from './ModelPicker';
import { NotifySettings } from './NotifySettings';
import {
  GitError,
  PROVIDERS,
  PROVIDER_ORDER,
  COMMIT_INTERVAL_OPTIONS,
  connect,
  createRepo,
  errorDetail,
  friendlyGitMessage,
  getRepo,
  manualPrivateHint,
  markSeedReadme,
  providerLabel,
  repoSettingsUrl,
  repoSize,
  resetFromRemote,
  setRepoPrivate,
  verifyToken,
  type GitConfig,
  type Provider,
  type RepoSize,
} from '../lib/git';
import { exportAllZip } from '../lib/export';
import { migrateNotebooks } from '../lib/repo';
import { importMarkdownFiles } from '../lib/importer';
import {
  desktop,
  type LoginItemState,
  type RepoLocation,
  type UpdateResult,
  type UpdateProgress,
  type WorkspaceInfo,
} from '../lib/desktop';
import {
  AI_PROMPT_DESC,
  AI_PROMPT_GROUPS,
  AI_PROMPT_LABEL,
  AI_MAX_TOKENS_MAX,
  AI_MAX_TOKENS_MIN,
  AI_PROVIDERS,
  AI_PROVIDER_ORDER,
  AiError,
  DEFAULT_AI_MAX_TOKENS,
  DEFAULT_AI_PROMPTS,
  clampAiMaxTokens,
  loadAiConfig,
  loadAiKey,
  loadAiPrompts,
  saveAiConfig,
  saveAiKey,
  saveAiPrompts,
  testAi,
  type AiConfig,
  type AiPromptKey,
  type AiPrompts,
  type AiProviderId,
} from '../lib/ai';
import {
  ATTACH_LIMIT_DEFAULT,
  ATTACH_LIMIT_MAX,
  ATTACH_LIMIT_MIN,
  attachLimitMb,
  setAttachLimitMb,
} from '../lib/editorBridge';
import {
  QINIU_SECTION_EVENT,
  clearQiniuConfig,
  consumeQiniuSectionJump,
  isQiniuEnabled,
  isQiniuTestDomain,
  normalizeQiniuDomain,
  readQiniuConfig,
  saveQiniuConfig,
  setQiniuEnabled,
  splitQiniuDomain,
  testQiniuUpload,
  type QiniuConfig,
} from '../lib/qiniu';
import { buildDiagnostics, errorText, log } from '../lib/log';
import { remindersEnabled, setRemindersEnabled } from '../lib/reminders';
import { cn, dateKey, downloadText, timeKey } from '../lib/utils';
import {
  SHORTCUTS as SHORTCUT_DEFS,
  comboFromEvent,
  findConflict,
  loadBindings,
  resetBindings,
  saveBindings,
} from '../lib/shortcuts';
import { openExternal } from '../lib/openExternal';
import { CheckoutConflictDialog } from './CheckoutConflictDialog';
import { FirstConnectDialog } from './FirstConnectDialog';
import { MergeConflictDialog } from './MergeConflictDialog';
import { WorktreeResetDialog } from './WorktreeResetDialog';
import { WorkspaceDialog } from './WorkspaceDialog';
import { ConfirmDialog } from './Confirm';
import { CreateRepoPrompt } from './CreateRepoPrompt';
import { StatsPanel } from './StatsPanel';
import { LocalStoragePanel } from './LocalStoragePanel';
import { QiniuHelpDialog } from './QiniuHelpDialog';
import {
  KEY_SYNC_EVENT,
  keySyncEnabled,
  removeSyncedKey,
  setKeySyncEnabled,
  syncKeysNow,
} from '../lib/keySync';

/** 七牛存储空间的默认名字：在七牛新建同名空间就能直接开用 */
const QINIU_DEFAULT_BUCKET = 'glimnote';

/** 同步状态用中文说人话，别把内部状态名直接摆给用户 */
const SYNC_LABEL: Record<string, string> = {
  local: '仅保存在本地',
  pending: '已保存，等待上传',
  syncing: '正在同步',
  synced: '已是最新',
  error: '上次同步失败',
  offline: '当前离线',
  conflict: '有一处改动需要确认',
};

/** 仓库体检里只显示人看得懂的大小，别摆一串字节数 */
function sizeText(bytes: number) {
  if (!bytes) return '0 B';
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

export function SettingsModal() {
  const t = useT();
  const lang = useLang();
  const open = useApp((s) => s.settingsOpen);
  const setSettings = useApp((s) => s.setSettings);
  const tab = useApp((s) => s.settingsTab);
  const theme = useApp((s) => s.theme);
  const setTheme = useApp((s) => s.setTheme);
  const cfg = useApp((s) => s.cfg);
  const token = useApp((s) => s.token);
  const notes = useApp((s) => s.notes);
  const view = useApp((s) => s.view);
  const current = useApp((s) => s.current);
  const configureGit = useApp((s) => s.configureGit);
  const disconnectGit = useApp((s) => s.disconnectGit);
  const syncNow = useApp((s) => s.syncNow);
  const flushPendingWrites = useApp((s) => s.flushPendingWrites);
  const syncState = useApp((s) => s.syncState);
  const syncMessage = useApp((s) => s.syncMessage);
  const syncInterval = useApp((s) => s.syncInterval);
  const setSyncInterval = useApp((s) => s.setSyncInterval);
  const commitEvery = useApp((s) => s.commitInterval);
  const setCommitInterval = useApp((s) => s.setCommitInterval);
  const needsReclone = useApp((s) => s.needsReclone);
  const syncBlockedByWorkflow = useApp((s) => s.syncBlockedByWorkflow);
  const recoverSyncWithoutCloudPush = useApp((s) => s.recoverSyncWithoutCloudPush);
  const compactRepo = useApp((s) => s.compactRepo);
  const resetRepo = useApp((s) => s.resetRepo);
  const openTrash = useApp((s) => s.openTrash);
  const refresh = useApp((s) => s.refresh);
  const toast = useApp((s) => s.toast);

  const [editorSize, setEditorSize] = useState(() => Number(localStorage.getItem('glimnote.editorSize') || 14));
  const [measure, setMeasure] = useState(() => localStorage.getItem('glimnote.measure') || '66');
  const [provider, setProvider] = useState<Provider>(cfg?.provider || 'gitcode');
  const [tokenInput, setTokenInput] = useState(token || '');
  const [showToken, setShowToken] = useState(false);
  // 已连接时也能换令牌：补了 workflow 权限或重新生成了令牌，不用断开重连
  const [newToken, setNewToken] = useState('');
  const [updatingToken, setUpdatingToken] = useState(false);
  const [repoName, setRepoName] = useState(cfg?.repo || 'my-notes');
  const [branch, setBranch] = useState(cfg?.branch || 'main');
  const [owner, setOwner] = useState(cfg?.owner || '');
  const [status, setStatus] = useState<{
    kind: 'ok' | 'bad' | 'info';
    text: string;
    /** 出错时的原始报错，点一下可复制，方便把现象描述给别人 */
    detail?: string;
    /** 失败后的下一步：例如「打开仓库设置页」，直接跳到平台手动处理 */
    action?: { label: string; url: string };
  } | null>(null);
  const [busy, setBusy] = useState('');
  const [createPrompt, setCreatePrompt] = useState(false);
  const [createErr, setCreateErr] = useState('');
  /** 仓库已存在但是公开的：先问要不要自动改为私有，用户不确认就不连接 */
  const [publicAsk, setPublicAsk] = useState<{ who: string; repo: string } | null>(null);
  const [makingPrivate, setMakingPrivate] = useState(false);
  /** 连接时本地有同名不同内容的文件：弹窗让用户选强制覆盖或手动处理 */
  const [checkoutConflict, setCheckoutConflict] = useState<{
    provider: Provider;
    who: string;
    repo: string;
    branch: string;
  } | null>(null);
  const [overwritingLocal, setOverwritingLocal] = useState(false);
  /** 首次连接已有内容的仓库、本机也有用户内容：弹窗选择合并或覆盖 */
  const [firstConnect, setFirstConnect] = useState<{
    provider: Provider;
    who: string;
    repo: string;
    branch: string;
  } | null>(null);
  const [firstBusy, setFirstBusy] = useState<'merge' | 'adopt-remote' | null>(null);
  /** 两边都有改动、有文件无法自动合并：让用户选保留本机还是用仓库覆盖 */
  const [mergeConflict, setMergeConflict] = useState<{
    provider: Provider;
    who: string;
    repo: string;
    branch: string;
  } | null>(null);
  const [mergeBusy, setMergeBusy] = useState<'keep-local' | 'overwrite' | null>(null);
  /** 本机工作区被清空 / 重装后只剩示例：连接前先确认是补回文件还是继续 */
  const [worktreeReset, setWorktreeReset] = useState<{
    provider: Provider;
    who: string;
    repo: string;
    branch: string;
    message: string;
  } | null>(null);
  const [worktreeBusy, setWorktreeBusy] = useState<'restore' | 'keep' | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [compactAsk, setCompactAsk] = useState(false);
  const [resetAsk, setResetAsk] = useState(false);
  const [repoBusy, setRepoBusy] = useState<'' | 'compact' | 'reset' | 'notebooks'>('');
  const [size, setSize] = useState<RepoSize | null>(null);
  const [sizeLoading, setSizeLoading] = useState(false);
  const [closeToTray, setCloseToTray] = useState(() => localStorage.getItem('glimnote.closeToTray') !== '0');
  const [loginItem, setLoginItem] = useState<LoginItemState | null>(null);
  const [loginBusy, setLoginBusy] = useState(false);
  // 启动页：默认首页；改成「关」后沿用上次打开的笔记
  const [startHome, setStartHome] = useState(() => localStorage.getItem('glimnote.startHome') !== '0');
  const [cardOpen, setCardOpen] = useState(false);
  /** 浮窗热键是否被其它软件占用：被占用时如实说明，别让用户以为热键坏了 */
  const [cardHotkeyTaken, setCardHotkeyTaken] = useState(false);
  const [reminderOn, setReminderOn] = useState(() => remindersEnabled());
  const [cardOpacity, setCardOpacity] = useState(() => {
    const raw = localStorage.getItem('glimnote.card.opacity');
    // 没存过时 Number(null) 会变成 0，这里必须单独判断，否则默认就成了全透明
    if (raw === null) return 1;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 && n <= 1 ? n : 1;
  });
  const [repoLocation, setRepoLocation] = useState<RepoLocation | null>(null);
  const [repoPick, setRepoPick] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([]);
  const [wsInfo, setWsInfo] = useState<WorkspaceInfo | null>(null);
  const [wsOpen, setWsOpen] = useState(false);
  /** 连接前的工作区提醒：这个仓库属于另一份笔记，或已经有别的工作区 */
  const [wsAsk, setWsAsk] = useState<null | {
    kind: 'separate' | 'duplicate';
    provider: Provider;
    who: string;
    repo: string;
    branch: string;
    /** 当前工作区名字（separate）或已占用仓库的工作区名字（duplicate） */
    name?: string;
    otherId?: string;
  }>(null);
  const [wsBusy, setWsBusy] = useState(false);
  const [attachMb, setAttachMb] = useState(() => attachLimitMb());
  const [attachDraft, setAttachDraft] = useState(() => String(attachLimitMb()));
  // 七牛云配置只存本机；草稿和已保存状态分开，改到一半关掉设置不影响已生效的配置
  const [qiniu, setQiniu] = useState<QiniuConfig>(
    () =>
      readQiniuConfig() ?? {
        accessKey: '',
        secretKey: '',
        bucket: QINIU_DEFAULT_BUCKET,
        domain: '',
      },
  );
  const [qiniuReady, setQiniuReady] = useState(() => Boolean(readQiniuConfig()));
  /** 云存储总开关：关掉后新图片 / 附件存本机，配置保留 */
  const [qiniuOn, setQiniuOn] = useState(() => isQiniuEnabled());
  // 密钥是否跟着 Git 同步；默认关，只在用户明确打开时才写进仓库
  const [qiniuKeySync, setQiniuKeySync] = useState(() => keySyncEnabled('qiniu'));
  const [showQiniuSecret, setShowQiniuSecret] = useState(false);
  const [qiniuBusy, setQiniuBusy] = useState(false);
  const [qiniuMsg, setQiniuMsg] = useState<{ text: string; ok: boolean } | null>(null);
  // 「太复杂不会配置？」的兜底弹窗：用本地存储，或让 AI 带着配
  const [qiniuHelpOpen, setQiniuHelpOpen] = useState(false);
  // 「存储」页里的两个子页签：云存储设置 / 存储管理
  const [storageTab, setStorageTab] = useState<'cloud' | 'local'>('cloud');
  // 预设档位和 loadSyncInterval 的默认值保持一致：5 / 15 / 60 分钟
  const syncPresets = [5, 15, 60];
  const [customInterval, setCustomInterval] = useState(() => !syncPresets.includes(syncInterval));
  const [intervalDraft, setIntervalDraft] = useState(() => String(syncInterval || 60));
  const [customCommit, setCustomCommit] = useState(() => ![30, 60].includes(commitEvery));
  const [commitDraft, setCommitDraft] = useState(() => String(commitEvery));
  const [aiCfg, setAiCfg] = useState<AiConfig>(() => loadAiConfig());
  // 数字输入框单独存草稿：边输边 clamp 的话，删到一半就会被跳成默认值
  const [maxDraft, setMaxDraft] = useState(() => String(loadAiConfig().maxTokens));
  const [aiKey, setAiKey] = useState(() => loadAiKey());
  const [aiKeySync, setAiKeySync] = useState(() => keySyncEnabled('ai'));
  const [showKey, setShowKey] = useState(false);
  const [aiStatus, setAiStatus] = useState<{ kind: 'ok' | 'bad' | 'info'; text: string } | null>(null);
  const [aiTesting, setAiTesting] = useState(false);
  const [prompts, setPrompts] = useState<AiPrompts>(() => loadAiPrompts());
  const [aiTab, setAiTab] = useState<'conn' | 'prompts'>('conn');
  const [openPrompt, setOpenPrompt] = useState<AiPromptKey | null>(null);
  // 版本号优先用主进程的运行时值：前端构建时写死的 __APP_VERSION__ 只在网页版兜底
  const [appVersion, setAppVersion] = useState(__APP_VERSION__);
  const [update, setUpdate] = useState<UpdateResult | null>(null);
  const [updateProgress, setUpdateProgress] = useState<UpdateProgress | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [checking, setChecking] = useState(false);
  /** 下载完成后自动重启安装的倒计时；0 表示不自动安装 */
  const [installCountdown, setInstallCountdown] = useState(0);
  /** 本次下载是不是用户刚点「下载更新」触发的：只有这种才自动重启 */
  const autoInstallRef = useRef(false);
  const [logFile, setLogFile] = useState('');
  const [bindings, setBindings] = useState<Record<string, string>>(() => loadBindings());
  const [recording, setRecording] = useState<string | null>(null);
  const [conflict, setConflict] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const repoRef = useRef<HTMLInputElement>(null);
  const bridge = desktop();

  // 保存反馈：toast 出现在主窗右下角，设置弹窗打开时容易被挡住或忽略，
  // 改成在保存按钮旁边就地亮一条「已保存」，几秒后自动消失。
  const [saveFlash, setSaveFlash] = useState<{ key: string; text: string } | null>(null);
  const saveFlashTimer = useRef<number | null>(null);
  const [notifyHint, setNotifyHint] = useState<{ text: string; ok: boolean } | null>(null);
  const notifyHintTimer = useRef<number | null>(null);

  const flashSaved = (key: string, text: string) => {
    setSaveFlash({ key, text });
    if (saveFlashTimer.current) window.clearTimeout(saveFlashTimer.current);
    saveFlashTimer.current = window.setTimeout(() => setSaveFlash(null), 2800);
  };

  // 通知页的保存逻辑在 NotifySettings 里，结果通过事件回传到页脚就地显示
  useEffect(() => {
    const onHint = (e: Event) => {
      const detail = (e as CustomEvent<{ text?: string; ok?: boolean }>).detail;
      if (!detail?.text) return;
      setNotifyHint({ text: detail.text, ok: detail.ok !== false });
      if (notifyHintTimer.current) window.clearTimeout(notifyHintTimer.current);
      notifyHintTimer.current = window.setTimeout(() => setNotifyHint(null), 4000);
    };
    window.addEventListener('glimnote:notify-save-hint', onHint);
    return () => {
      window.removeEventListener('glimnote:notify-save-hint', onHint);
      if (notifyHintTimer.current) window.clearTimeout(notifyHintTimer.current);
      if (saveFlashTimer.current) window.clearTimeout(saveFlashTimer.current);
    };
  }, []);

  // 打开设置时同步一次七牛云配置：别的窗口 / 提示弹窗里改过也不会显示成旧值
  useEffect(() => {
    if (!open) return;
    const saved = readQiniuConfig();
    setQiniu(
      saved ?? { accessKey: '', secretKey: '', bucket: QINIU_DEFAULT_BUCKET, domain: '' },
    );
    setQiniuReady(Boolean(saved));
    setQiniuOn(isQiniuEnabled());
    setShowQiniuSecret(false);
    setQiniuMsg(null);
  }, [open]);

  // 从「图片存到哪」的提示点「去配置」进来：等正文挂载后滚到七牛云这一节
  useEffect(() => {
    if (!open) return;
    const locate = (delay: number) => {
      window.setTimeout(() => {
        document.getElementById('set-qiniu')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }, delay);
    };
    // 点「去配置」的那一下可能早于本组件挂载，先看有没有留下的跳转标记
    if (consumeQiniuSectionJump()) {
      setStorageTab('cloud');
      locate(120);
    }
    const onLocate = () => {
      consumeQiniuSectionJump();
      setStorageTab('cloud');
      locate(60);
    };
    window.addEventListener(QINIU_SECTION_EVENT, onLocate);
    return () => window.removeEventListener(QINIU_SECTION_EVENT, onLocate);
  }, [open]);

  // 版本号运行时从主进程取：安装包升级后界面立即显示新版本，
  // 不再依赖构建时写死的 __APP_VERSION__（曾经因此显示成上一版）。
  useEffect(() => {
    if (!bridge?.version) return;
    let cancelled = false;
    void bridge
      .version()
      .then((value) => {
        if (!cancelled && value) setAppVersion(String(value));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [bridge]);

  // 打开「关于」页时，把主进程后台自动检查到的新版本带进来：
  // 用户点通知进来就能直接看到版本和操作，而不是一片空白。
  useEffect(() => {
    if (!open || tab !== 'about' || !bridge?.updateInfo) return;
    let cancelled = false;
    void bridge
      .updateInfo()
      .then((info) => {
        if (cancelled || !info?.version || info.version === info.ignored) return;
        if (info.downloaded) setUpdateProgress((prev) => prev ?? { state: 'downloaded', version: info.version });
        setUpdate((prev) =>
          prev ?? {
            status: 'available',
            version: info.version,
            message: t('发现新版本 {v}。可以下载更新，也可以先忽略这个版本。', { v: info.version }),
          },
        );
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open, tab, bridge]);

  // 录制新快捷键：捕获阶段拦下按键，避免触发全局快捷键
  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        setRecording(null);
        setConflict('');
        return;
      }
      if (e.key === 'Backspace' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        const def = SHORTCUT_DEFS.find((d) => d.id === recording);
        if (def) {
          const next = { ...bindings, [def.id]: def.def };
          setBindings(next);
          saveBindings(next);
        }
        setRecording(null);
        setConflict('');
        return;
      }
      const combo = comboFromEvent(e);
      if (!combo) return;
      const clash = findConflict(bindings, recording, combo);
      if (clash) {
        setConflict(t('「{combo}」已经被「{label}」使用，这次修改没有保存。', { combo, label: t(clash.label) }));
        setRecording(null);
        return;
      }
      const next = { ...bindings, [recording]: combo };
      setBindings(next);
      saveBindings(next);
      setRecording(null);
      setConflict('');
      toast(t('快捷键已改为 {combo}', { combo }), 'success');
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [recording, bindings, toast]);

  // 桌面版：把当天日志文件的位置显示出来，用户不用自己猜路径
  useEffect(() => {
    if (!bridge || typeof bridge.logPath !== 'function') return;
    let alive = true;
    void bridge
      .logPath()
      .then((p) => {
        if (alive && p && p.file) setLogFile(p.file);
      })
      .catch(() => {
        /* 取不到就不显示路径，不影响其它设置 */
      });
    return () => {
      alive = false;
    };
  }, [bridge]);

  // 更新进度由主进程推送：下载百分比、下载完成、失败都在这里落到界面
  useEffect(() => {
    if (!bridge?.onUpdateProgress) return;
    return bridge.onUpdateProgress((progress) => {
      setUpdateProgress(progress);
      if (progress.state === 'downloaded') {
        setDownloading(false);
        setUpdate((prev) =>
          prev
            ? {
                ...prev,
                message: progress.version
                  ? t('新版本 {v} 已下载', { v: progress.version })
                  : t('新版本已下载'),
              }
            : prev,
        );
        // 用户刚点了「下载更新」：直接进入重启安装流程，不用再点第二次
        if (autoInstallRef.current) {
          autoInstallRef.current = false;
          setInstallCountdown(6);
        }
      } else if (progress.state === 'error') {
        setDownloading(false);
        autoInstallRef.current = false;
        setInstallCountdown(0);
        toast(t('更新失败：{msg}', { msg: progress.message || t('请稍后再试') }), 'error');
      }
    });
  }, [bridge, toast]);

  // 打开设置时读一次真实的存储位置：用户可能刚在资源管理器里挪过
  useEffect(() => {
    if (!open || !bridge || typeof bridge.repoLocation !== 'function') return;
    let alive = true;
    void bridge
      .repoLocation()
      .then((loc) => {
        if (alive) setRepoLocation(loc);
      })
      .catch(() => {
        /* 读不到就只显示「打开」按钮，不影响其它设置 */
      });
    return () => {
      alive = false;
    };
  }, [open, bridge]);

  // 工作区列表：打开设置时重新读一次，切换 / 新建后也靠它刷新
  const loadWorkspaces = async () => {
    if (!bridge?.workspaceList) return;
    try {
      const list = await bridge.workspaceList();
      setWorkspaces(list.items);
      setWsInfo(list.items.find((it) => it.id === list.active) || null);
    } catch {
      /* 读不到就不展示工作区区块，不影响其它设置 */
    }
  };

  useEffect(() => {
    if (!open) return;
    void loadWorkspaces();
  }, [open, bridge]);

  // 打开同步页时体检一次仓库；同步状态变化后也重新统计，数字不会一直停在旧值
  useEffect(() => {
    if (!open || tab !== 'sync' || !cfg || !token) return;
    let alive = true;
    setSizeLoading(true);
    repoSize()
      .then((value) => {
        if (alive) setSize(value);
      })
      .catch(() => {
        /* 统计失败不影响同步，保持上一次的数字 */
      })
      .finally(() => {
        if (alive) setSizeLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [open, tab, cfg, token, syncState]);

  // 开机自启以系统启动项为准：每次打开设置都读一次，避免显示和系统实际不一致
  useEffect(() => {
    if (!open || !bridge?.getLoginItem) return;
    let alive = true;
    void bridge
      .getLoginItem()
      .then((state) => {
        if (alive) setLoginItem(state);
      })
      .catch(() => {
        if (alive) setLoginItem({ supported: false, enabled: false, error: t('读取开机启动项失败') });
      });
    return () => {
      alive = false;
    };
  }, [open, bridge]);

  // 待办浮窗是独立窗口，状态在主进程：打开设置时读一次，之后跟着显示/隐藏事件走
  useEffect(() => {
    if (!open || !bridge) return;
    let alive = true;
    void bridge
      .isCardOpen?.()
      .then((value) => {
        if (alive) setCardOpen(value);
      })
      .catch(() => {});
    const off = bridge.onCardVisibility?.((visible) => setCardOpen(visible));
    void bridge
      .cardHotkey?.()
      .then((state) => {
        if (alive) setCardHotkeyTaken(Boolean(state?.taken));
      })
      .catch(() => {});
    return () => {
      alive = false;
      off?.();
    };
  }, [open, bridge]);

  // 关闭设置页就停止自动安装，避免用户以为关掉就安全了却被直接退出
  useEffect(() => {
    if (!open) setInstallCountdown(0);
  }, [open]);

  // 下载完成后倒计时自动重启：保留几秒让用户看到安全软件提示，也可以取消
  useEffect(() => {
    if (installCountdown <= 0) return;
    const timer = window.setTimeout(() => {
      if (installCountdown <= 1) {
        setInstallCountdown(0);
        void bridge?.installUpdate?.();
      } else {
        setInstallCountdown(installCountdown - 1);
      }
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [installCountdown, bridge]);

  // 同步把另一台设备的密钥带回来时，设置页里空着的输入框跟着补上。
  // 必须放在 `if (!open) return null` 之前：否则关闭和打开时 hook 数量不同会直接崩溃
  useEffect(() => {
    const onApplied = () => {
      setAiKey((cur) => cur || loadAiKey());
      const cfg = readQiniuConfig();
      if (cfg) {
        setQiniu((cur) => (cur.accessKey && cur.secretKey ? cur : cfg));
        setQiniuReady(true);
      }
    };
    window.addEventListener(KEY_SYNC_EVENT, onApplied);
    return () => window.removeEventListener(KEY_SYNC_EVENT, onApplied);
  }, []);

  if (!open) return null;

  const close = () => setSettings(false);

  const pickRepoLocation = async () => {
    if (!bridge || moving) return;
    try {
      const picked = await bridge.chooseRepoLocation();
      if (picked.canceled) return;
      if (picked.same) {
        toast(t('这就是当前使用的文件夹'), 'info');
        return;
      }
      if (picked.path) setRepoPick(picked.path);
    } catch (e) {
      toast(t('打开文件夹选择器失败：{err}', { err: errorText(e) }), 'error');
    }
  };

  const moveRepo = async () => {
    if (!bridge || !repoPick) return;
    setMoving(true);
    try {
      // 让编辑器先失去焦点：迁移期间不能再往旧目录写新内容
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      // 还没落盘的编辑先写掉，否则迁移的是几百毫秒前的版本
      await useApp.getState().flushPendingWrites();
      const res = await bridge.moveRepoLocation(repoPick);
      setRepoPick(null);
      const same = (a: string, b: string) =>
        a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase();
      const defaultPath = repoLocation?.defaultPath || '';
      setRepoLocation({ path: res.path, defaultPath, custom: !defaultPath || !same(res.path, defaultPath) });
      // 工作区列表里也显示着这个路径，迁移完马上同步，避免两个地方不一致
      void loadWorkspaces();
      toast(t('笔记已迁移（{n} 个文件），马上重新载入…', { n: res.files }), 'success');
      window.setTimeout(() => window.location.reload(), 900);
    } catch (e) {
      toast(t('迁移失败：{err}', { err: errorText(e) }), 'error');
    } finally {
      setMoving(false);
    }
  };

  /** 切换工作区：先落盘，再让主进程改注册表并重新载入应用 */
  const switchWorkspace = async (id: string) => {
    if (!bridge?.workspaceSwitch) return { ok: false, error: t('仅桌面端支持多个工作区') };
    try {
      await flushPendingWrites();
      const res = await bridge.workspaceSwitch(id);
      if (!res.ok) return { ok: false, error: res.error || t('切换失败') };
      if (res.restarting) {
        setWsOpen(false);
        toast(t('正在切换工作区，稍等片刻…'), 'info');
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: errorText(e) };
    }
  };

  /** 新建工作区后直接切过去：新目录是空的，不存在覆盖旧笔记的风险 */
  const createWorkspace = async (name: string, root?: string) => {
    if (!bridge?.workspaceCreate) return { ok: false, error: t('仅桌面端支持多个工作区') };
    try {
      const res = await bridge.workspaceCreate({ name, root });
      if (!res.ok || !res.item) return { ok: false, error: res.error || t('创建失败') };
      await loadWorkspaces();
      return switchWorkspace(res.item.id);
    } catch (e) {
      return { ok: false, error: errorText(e) };
    }
  };

  const commitAttachLimit = () => {
    const n = Number(attachDraft);
    if (!Number.isFinite(n) || n <= 0) {
      setAttachDraft(String(attachMb));
      return;
    }
    const value = setAttachLimitMb(n);
    setAttachMb(value);
    setAttachDraft(String(value));
    flashSaved(
      'attach',
      value === Math.round(n)
        ? t('附件上限已保存')
        : t('已按 {min}–{max}MB 调整', { min: ATTACH_LIMIT_MIN, max: ATTACH_LIMIT_MAX }),
    );
  };

  const qiniuDomainParts = splitQiniuDomain(qiniu.domain);

  const qiniuComplete = Boolean(
    qiniu.accessKey.trim() && qiniu.secretKey.trim() && qiniu.bucket.trim() && qiniuDomainParts.host,
  );

  /** 输入框只显示主机名；粘贴完整 URL 时自动把协议拆到左边的下拉框 */
  const changeQiniuDomain = (raw: string) => {
    const parsed = splitQiniuDomain(raw);
    setQiniu((v) => {
      const protocol = /^https?:\/\//i.test(raw.trim())
        ? parsed.protocol
        : splitQiniuDomain(v.domain).protocol;
      return { ...v, domain: `${protocol}://${parsed.host}` };
    });
    setQiniuMsg(null);
  };

  const changeQiniuProtocol = (protocol: 'http' | 'https') => {
    setQiniu((v) => {
      // 域名先空着也把协议记住，等填主机名时就能直接拼上
      const host = splitQiniuDomain(v.domain).host;
      return { ...v, domain: `${protocol}://${host}` };
    });
    setQiniuMsg(null);
  };

  /**
   * 把本机密钥写进仓库并标记待提交。
   * 只在本机这一项开关打开、或刚改过这项密钥时调用；
   * 关掉开关不会反过来删除仓库里的记录。
   */
  const pushKeysToRepo = () => {
    const store = useApp.getState();
    void syncKeysNow()
      .then(() => store.markPending())
      .catch((e) => console.warn('key sync failed', e));
  };

  /** 用户主动清除某项密钥时，连同仓库里的记录一起删掉，否则下次同步又会被导回来 */
  const dropKeysFromRepo = (feature: 'ai' | 'qiniu') => {
    const store = useApp.getState();
    void removeSyncedKey(feature)
      .then(() => store.markPending())
      .catch((e) => console.warn('remove synced key failed', e));
  };

  const applyKeySync = (feature: 'ai' | 'qiniu', on: boolean) => {
    if (feature === 'ai') setAiKeySync(on);
    else setQiniuKeySync(on);
    setKeySyncEnabled(feature, on);
    // 开关只决定「这台设备的这份密钥要不要上传」；
    // 关掉时仓库里已有的记录原样保留，其它设备同步过去仍能自动使用
    if (on) pushKeysToRepo();
    toast(
      on
        ? t('已开启上传：提交后这份密钥会写进私有仓库，其它设备同步即可使用')
        : t('已关闭上传：仓库里已有的密钥仍会自动导入这台设备'),
      'info',
    );
  };

  const persistQiniu = () => {
    if (!qiniuComplete) return;
    const saved = saveQiniuConfig(qiniu);
    // 保存成功就代表用户想用云存储：自动把开关打开
    setQiniuEnabled(true);
    setQiniu(saved);
    setQiniuReady(true);
    setQiniuOn(true);
    setQiniuMsg({ text: t('已保存并开启云存储，之后的图片和附件会直接上传到七牛云'), ok: true });
    flashSaved('qiniu', t('七牛云配置已保存'));
    if (qiniuKeySync) pushKeysToRepo();
  };

  /** 顶部开关：打开前必须有完整配置，否则只提醒、不硬开 */
  const toggleQiniu = (next: boolean) => {
    if (!next) {
      setQiniuEnabled(false);
      setQiniuOn(false);
      setQiniuMsg({ text: t('已关闭云存储，新插入的图片和附件会存进本机仓库'), ok: true });
      return;
    }
    if (!readQiniuConfig()) {
      setQiniuOn(false);
      setQiniuMsg({
        text: t('还没有可用的七牛云配置：请在下面填好存储空间、密钥和域名，保存并测试通过后会自动打开'),
        ok: false,
      });
      toast(t('先完成下面的七牛云配置，才能打开云存储'), 'warn');
      return;
    }
    setQiniuEnabled(true);
    setQiniuOn(true);
    setQiniuMsg({ text: t('已打开云存储，新插入的图片和附件会上传到七牛云'), ok: true });
  };

  const runQiniuTest = async () => {
    if (!qiniuComplete || qiniuBusy) return;
    setQiniuBusy(true);
    setQiniuMsg(null);
    try {
      // 能传到存储空间才保存，避免把写错的配置留成默认存储。
      // 粘贴密钥常带首尾空格，先去掉再测，失败时也别把空格一起存下来。
      const candidate = {
        accessKey: qiniu.accessKey.trim(),
        secretKey: qiniu.secretKey.trim(),
        bucket: qiniu.bucket.trim(),
        domain: normalizeQiniuDomain(qiniu.domain),
      };
      await testQiniuUpload(candidate);
      const saved = saveQiniuConfig(candidate);
      // 校验通过说明配置真的能用，自动打开开关
      setQiniuEnabled(true);
      setQiniu(saved);
      setQiniuReady(true);
      setQiniuOn(true);
      setQiniuMsg({ text: t('连接成功，已自动开启云存储：图片和附件会直接上传到七牛云'), ok: true });
      flashSaved('qiniu', t('七牛云已连接'));
      if (qiniuKeySync) pushKeysToRepo();
    } catch (e) {
      setQiniuMsg({
        text: t('连接失败：{msg}', { msg: e instanceof Error ? e.message : String(e) }),
        ok: false,
      });
    } finally {
      setQiniuBusy(false);
    }
  };

  const forgetQiniu = () => {
    clearQiniuConfig();
    setQiniu({
      accessKey: '',
      secretKey: '',
      bucket: QINIU_DEFAULT_BUCKET,
      domain: '',
    });
    setQiniuReady(false);
    setQiniuOn(false);
    setShowQiniuSecret(false);
    setQiniuMsg({ text: t('已清除，之后的图片和附件会存进仓库'), ok: true });
    flashSaved('qiniu', t('已清除七牛云配置'));
    dropKeysFromRepo('qiniu');
  };

  const commitEveryCustom = () => {
    const n = Math.round(Number(commitDraft));
    if (!Number.isFinite(n) || n <= 0) {
      setCommitDraft(String(commitEvery));
      return;
    }
    const value = Math.min(1440, Math.max(1, n));
    setCommitInterval(value);
    setCommitDraft(String(value));
  };

  const commitInterval = () => {
    const n = Math.round(Number(intervalDraft));
    if (!Number.isFinite(n) || n <= 0) {
      setIntervalDraft(String(syncInterval || 60));
      return;
    }
    const value = Math.min(1440, n);
    setSyncInterval(value);
    setIntervalDraft(String(value));
  };

  const refreshSize = async () => {
    setSizeLoading(true);
    try {
      setSize(await repoSize());
    } catch {
      /* 读不到就保持原样 */
    } finally {
      setSizeLoading(false);
    }
  };

  const doCompact = async () => {
    setCompactAsk(false);
    setRepoBusy('compact');
    try {
      // 压缩会改写历史，先把完整内容导出到本地，出问题也有后路
      await exportAllZip(notes);
      toast(t('已导出 ZIP 备份，开始压缩历史'), 'info');
      const res = await compactRepo();
      await refreshSize();
      toast(t('历史已压缩 · {from} → {to}', { from: res.oldOid ? res.oldOid.slice(0, 7) : t('无'), to: res.oid.slice(0, 7) }), 'success');
    } catch (e) {
      toast(t('压缩失败：{err}', { err: errorText(e) }), 'error');
    } finally {
      setRepoBusy('');
    }
  };

  const doReset = async () => {
    setResetAsk(false);
    setRepoBusy('reset');
    try {
      await exportAllZip(notes);
      toast(t('已导出 ZIP 备份，正在重新下载远端'), 'info');
      await resetRepo();
      await refreshSize();
      toast(t('已按远端最新历史重建本地仓库'), 'success');
    } catch (e) {
      toast(t('重新下载失败：{err}', { err: errorText(e) }), 'error');
    } finally {
      setRepoBusy('');
    }
  };

  /** 把旧的可读目录名升级成 nb-xxxxxxxx：只搬一次目录，以后改名只改映射表 */
  const doMigrateNotebooks = async () => {
    setRepoBusy('notebooks');
    try {
      await flushPendingWrites();
      const count = await migrateNotebooks();
      await refresh();
      toast(
        count
          ? t('已把 {n} 个旧笔记本升级为唯一目录 ID', { n: count })
          : t('所有笔记本都已使用唯一目录 ID'),
        'success',
      );
    } catch (e) {
      toast(t('刷新笔记本索引失败：{err}', { err: errorText(e) }), 'error');
    } finally {
      setRepoBusy('');
    }
  };

  /**
   * 用仓库覆盖本机：先把本机笔记导出成 ZIP，再用远端历史覆盖工作区。
   * 连接尚未成功时 store 里还没有 cfg，不能用 resetRepo()，所以直接用表单参数
   * 调 resetFromRemote()；两条冲突路径（首次连接同名文件 / 合并失败）共用。
   */
  const overwriteLocalWithRemote = async (target: {
    provider: Provider;
    who: string;
    repo: string;
    branch: string;
  }) => {
    const tk = tokenInput.trim();
    if (!tk) throw new Error(t('授权令牌已清空，请重新填写后再校验。'));
    await exportAllZip(notes);
    toast(t('已导出 ZIP 备份，正在用仓库覆盖本地'), 'info');
    await resetFromRemote(
      {
        provider: target.provider,
        owner: target.who,
        repo: target.repo,
        branch: target.branch,
        remember: true,
      },
      tk,
      target.who,
    );
  };

  /** 同名文件冲突时选「强制覆盖」：备份本机、覆盖工作区，再接着完成连接 */
  const forceOverwriteLocal = async () => {
    if (!checkoutConflict || overwritingLocal) return;
    const target = checkoutConflict;
    if (!tokenInput.trim()) {
      setCheckoutConflict(null);
      setStatus({ kind: 'bad', text: t('授权令牌已清空，请重新填写后再校验。') });
      return;
    }
    setOverwritingLocal(true);
    try {
      await overwriteLocalWithRemote(target);
      setCheckoutConflict(null);
      await doConnect(false, { who: target.who, repo: target.repo, branch: target.branch, workspaceConfirmed: true });
    } catch (e) {
      setCheckoutConflict(null);
      log('sync', 'error', `强制覆盖本地失败 · ${errorText(e)}`);
      setStatus({
        kind: 'bad',
        text: t('强制覆盖本地失败：{err}', { err: errorText(e) }),
        detail: errorDetail(e),
      });
    } finally {
      setOverwritingLocal(false);
    }
  };

  /** 打开笔记目录，让用户自己改名或移走冲突文件 */
  const openNotesFolderForConflict = () => {
    if (!bridge) {
      toast(t('网页版无法打开本地目录，请手动找到笔记文件改名后再连接'), 'info');
      return;
    }
    void bridge
      .openRepoFolder()
      .then(() => toast(t('已打开笔记目录；改好文件名后再点「校验并连接」'), 'info'))
      .catch((e) => toast(t('打不开目录：{err}', { err: errorText(e) }), 'error'));
  };

  /** 冲突弹窗的「手动处理」：打开笔记目录，用户改名或移走后重新连接 */
  const openConflictFolder = () => {
    if (overwritingLocal) return;
    setCheckoutConflict(null);
    openNotesFolderForConflict();
  };

  /** 合并失败的两种选择：保留本机（远端版本存冲突副本）或用仓库覆盖本地 */
  const resolveMergeConflict = async (mode: 'keep-local' | 'overwrite') => {
    if (!mergeConflict || mergeBusy) return;
    const target = mergeConflict;
    if (!tokenInput.trim()) {
      setMergeConflict(null);
      setStatus({ kind: 'bad', text: t('授权令牌已清空，请重新填写后再校验。') });
      return;
    }
    if (mode === 'keep-local') {
      setMergeConflict(null);
      setMergeBusy('keep-local');
      toast(t('正在保留本机内容，并把仓库版本存为冲突副本'), 'info');
      await doConnect(false, {
        who: target.who,
        repo: target.repo,
        branch: target.branch,
        mergeConflict: 'keep-local',
        workspaceConfirmed: true,
      }).finally(() => setMergeBusy(null));
      return;
    }
    setMergeBusy('overwrite');
    try {
      await overwriteLocalWithRemote(target);
      setMergeConflict(null);
      await doConnect(false, { who: target.who, repo: target.repo, branch: target.branch, workspaceConfirmed: true });
    } catch (e) {
      setMergeConflict(null);
      log('sync', 'error', `用仓库覆盖本地失败 · ${errorText(e)}`);
      setStatus({
        kind: 'bad',
        text: t('用仓库覆盖本地失败：{err}', { err: errorText(e) }),
        detail: errorDetail(e),
      });
    } finally {
      setMergeBusy(null);
    }
  };

  const confirmWorkspaceAsk = () => {
    if (!wsAsk || wsBusy) return;
    const target = wsAsk;
    // 两条路都要先把这次填写的同步配置和令牌写进目标工作区，再切换过去：
    // 「已经有工作区」的那个工作区可能之前被断开过（配置被写成墓碑、令牌被清掉），
    // 只切换目录的话重启后仍然没有授权，用户又得重填一次 —— 看起来就像没切成功。
    const duplicate = target.kind === 'duplicate';
    const tk = tokenInput.trim();
    if (!tk) {
      setWsAsk(null);
      setStatus({ kind: 'bad', text: t('授权令牌已清空，请重新填写后再校验。') });
      return;
    }
    if (!bridge?.workspacePrepareConnect) {
      setWsAsk(null);
      setStatus({
        kind: 'bad',
        text: duplicate
          ? t('当前版本不支持在切换时写入同步配置。请到「设置 → 常规 → 管理工作区」手动切换到那个工作区，再回到这里连接仓库。')
          : t('当前版本不支持自动创建独立工作区。请到「设置 → 常规 → 管理工作区」新建一个工作区，再连接到这个仓库。'),
      });
      return;
    }
    const cfg: GitConfig = {
      provider: target.provider,
      owner: target.who,
      repo: target.repo,
      branch: target.branch,
      remember: true,
    };
    setWsBusy(true);
    void bridge
      .workspacePrepareConnect({
        repo: { provider: cfg.provider, owner: cfg.owner, repo: cfg.repo, branch: cfg.branch },
        cfg,
        login: target.who,
        token: tk,
      })
      .then(async (res) => {
        if (!res?.ok || !res.item) throw new Error(res?.error || t(duplicate ? '写入该工作区的同步配置失败' : '准备独立工作区失败'));
        setWsAsk(null);
        const switched = await switchWorkspace(res.item.id);
        if (!switched.ok) {
          setStatus({
            kind: 'bad',
            text: duplicate
              ? t('工作区「{name}」已经写好同步配置，但切换时出错：{err}。请到「设置 → 常规 → 管理工作区」手动切换过去。', { name: res.item.name, err: switched.error || t('未知错误') })
              : t('独立工作区「{name}」已经建好，但切换时出错：{err}。请到「设置 → 常规 → 管理工作区」手动切换后再连接。', { name: res.item.name, err: switched.error || t('未知错误') }),
          });
          return;
        }
        toast(
          duplicate
            ? t('正在切换到工作区「{name}」，重启后会直接连接这个仓库', { name: res.item.name })
            : t('已切换到独立工作区「{name}」，应用重启后会自动连接', { name: res.item.name }),
          'info',
        );
      })
      .catch((e) => {
        setWsAsk(null);
        setStatus({
          kind: 'bad',
          text: duplicate
            ? t('没能写入工作区「{name}」的同步配置：{err}。已经切换过去的笔记没有改动。', { name: target.name || '', err: errorText(e) })
            : t('没能创建独立工作区：{err}。当前工作区的笔记没有改动。', { err: errorText(e) }),
          detail: errorDetail(e),
        });
      })
      .finally(() => setWsBusy(false));
  };

  /** 首次连接弹窗的两种选择：都重新走一次连接，只是带不同的处理方式 */
  const resolveFirstConnect = (mode: 'merge' | 'adopt-remote') => {
    if (!firstConnect || firstBusy) return;
    const target = firstConnect;
    const tk = tokenInput.trim();
    if (!tk) {
      setFirstConnect(null);
      setStatus({ kind: 'bad', text: t('授权令牌已清空，请重新填写后再校验。') });
      return;
    }
    setFirstConnect(null);
    setFirstBusy(mode);
    if (mode === 'adopt-remote') toast(t('正在备份本机笔记，然后用仓库内容覆盖'), 'info');
    void doConnect(false, {
      who: target.who,
      repo: target.repo,
      branch: target.branch,
      firstConnect: mode,
      // 第一次尝试已经走过工作区提醒（或根本不需要提醒），这里别让用户再确认一遍
      workspaceConfirmed: true,
    }).finally(() => setFirstBusy(null));
  };

  /** 工作区被重置弹窗的两种选择：补回缺失文件，或确认按现状继续 */
  const resolveWorktreeReset = (mode: 'restore' | 'keep') => {
    if (!worktreeReset || worktreeBusy) return;
    const target = worktreeReset;
    const tk = tokenInput.trim();
    if (!tk) {
      setWorktreeReset(null);
      setStatus({ kind: 'bad', text: t('授权令牌已清空，请重新填写后再校验。') });
      return;
    }
    setWorktreeReset(null);
    setWorktreeBusy(mode);
    if (mode === 'restore') toast(t('正在把缺失的笔记补回本地，不会删除云端内容'), 'info');
    void doConnect(false, {
      who: target.who,
      repo: target.repo,
      branch: target.branch,
      worktreeReset: mode,
      workspaceConfirmed: true,
    }).finally(() => setWorktreeBusy(null));
  };

  const applyAiProvider = (id: AiProviderId) => {
    const preset = AI_PROVIDERS[id];
    setAiCfg((c) => ({
      provider: id,
      baseUrl: preset.baseUrl || c.baseUrl,
      model: preset.models[0] || c.model,
      maxTokens: c.maxTokens,
    }));
    setAiStatus(null);
  };

  const persistAi = (silent = false) => {
    const next: AiConfig = {
      provider: aiCfg.provider,
      baseUrl: aiCfg.baseUrl.trim().replace(/\/+$/, ''),
      model: aiCfg.model.trim(),
      maxTokens: clampAiMaxTokens(maxDraft),
    };
    setAiCfg(next);
    setMaxDraft(String(next.maxTokens));
    saveAiConfig(next);
    saveAiKey(aiKey.trim());
    if (!aiKey.trim()) dropKeysFromRepo('ai');
    else if (aiKeySync) pushKeysToRepo();
    setPrompts(saveAiPrompts(prompts));
    if (!silent) flashSaved('ai', t('AI 设置已保存'));
  };

  const persistPrompts = () => {
    setPrompts(saveAiPrompts(prompts));
    flashSaved('prompts', t('提示词已保存'));
  };

  const runAiTest = async () => {
    const cfg: AiConfig = {
      provider: aiCfg.provider,
      baseUrl: aiCfg.baseUrl.trim().replace(/\/+$/, ''),
      model: aiCfg.model.trim(),
      maxTokens: clampAiMaxTokens(maxDraft),
    };
    if (!cfg.baseUrl || !cfg.model) {
      setAiStatus({ kind: 'bad', text: t('先填写接口地址和模型名') });
      return;
    }
    setAiTesting(true);
    setAiStatus({ kind: 'info', text: t('正在测试连接…') });
    try {
      const reply = await testAi(cfg, aiKey.trim());
      setAiStatus({ kind: 'ok', text: t('连接成功：{reply}', { reply: reply || t('模型已响应') }) });
      setAiCfg(cfg);
      setMaxDraft(String(cfg.maxTokens));
      saveAiConfig(cfg);
      saveAiKey(aiKey.trim());
      if (aiKeySync) pushKeysToRepo();
      log('ai', 'info', 'AI 连接测试成功');
    } catch (e) {
      const msg = e instanceof AiError ? e.message : errorText(e);
      setAiStatus({ kind: 'bad', text: msg });
      log('ai', 'warn', `AI 连接测试失败：${msg}`);
    } finally {
      setAiTesting(false);
    }
  };

  const applySize = (size: number) => {
    setEditorSize(size);
    localStorage.setItem('glimnote.editorSize', String(size));
    document.documentElement.style.setProperty('--editor-size', `${size}px`);
  };

  const applyMeasure = (em: string) => {
    setMeasure(em);
    localStorage.setItem('glimnote.measure', em);
    document.documentElement.style.setProperty('--editor-measure', em);
  };

  const applyStartHome = (value: boolean) => {
    setStartHome(value);
    localStorage.setItem('glimnote.startHome', value ? '1' : '0');
  };

  const applyCloseToTray = (value: boolean) => {
    setCloseToTray(value);
    localStorage.setItem('glimnote.closeToTray', value ? '1' : '0');
    void bridge?.setCloseToTray(value);
  };

  const applyLoginItem = async (value: boolean) => {
    if (!bridge?.setLoginItem || loginBusy) return;
    setLoginBusy(true);
    try {
      const state = await bridge.setLoginItem(value);
      setLoginItem(state);
      if (state.error) toast(state.error, 'error');
      else toast(state.enabled ? t('已开启开机自动启动') : t('已关闭开机自动启动'), 'success');
    } catch (e) {
      toast(t('设置开机启动失败：{err}', { err: errorText(e) }), 'error');
    } finally {
      setLoginBusy(false);
    }
  };

  // 待办浮窗开关：直接控制那个独立窗口，显示状态以主进程回传的为准
  const toggleCard = () => {
    const next = !cardOpen;
    setCardOpen(next);
    const pending = next ? bridge?.openCard?.() : bridge?.hideCard?.();
    void pending
      ?.then((result) => {
        // 主进程明确说没打开（目前只有「应用已上锁」）时把开关退回，并说明原因
        if (result && typeof result === 'object' && result.ok === false) {
          setCardOpen(false);
          toast(
            result.reason === 'locked'
              ? t('应用已上锁：先在主窗口输入密码解锁，再打开浮窗；可以在「设置 → 安全 → 密码锁」关闭。')
              : t('浮窗没能打开，可以再试一次'),
            'error',
          );
        }
      })
      .catch(() => {
        setCardOpen(!next);
        toast(t('浮窗没能打开，可以再试一次'), 'error');
      });
  };

  // 浮窗透明度：写进 localStorage，浮窗监听 storage 事件即时生效
  const applyCardOpacity = (value: number) => {
    const next = Math.round(Math.min(1, Math.max(0, value)) * 100) / 100;
    setCardOpacity(next);
    localStorage.setItem('glimnote.card.opacity', String(next));
    void bridge?.refreshCard?.();
  };

  const runCheckUpdate = async () => {
    if (!bridge) return;
    setChecking(true);
    setUpdate(null);
    setInstallCountdown(0);
    try {
      const result = await bridge.checkUpdate();
      setUpdate(result);
      // 安装包已经在本地：保持「已下载」状态，不把进度条和重启按钮清掉
      if (result.downloaded) {
        setDownloading(false);
        setUpdateProgress({ state: 'downloaded', version: result.version });
      } else if (!downloading) {
        // 没有本地安装包（全新检查 / 上次下载已失效）：清掉旧的「已下载」状态
        setDownloading(false);
        setUpdateProgress(null);
      }
    } finally {
      setChecking(false);
    }
  };

  // 忽略当前版本：写进 prefs，之后只有更高的版本才会再提醒
  const runIgnoreUpdate = async () => {
    const version = update?.version;
    if (!version || !bridge?.ignoreUpdate) return;
    try {
      const ok = await bridge.ignoreUpdate(version);
      if (!ok) {
        toast(t('没能记住这个版本，请稍后再试'), 'error');
        return;
      }
      setUpdate(null);
      setUpdateProgress(null);
      setDownloading(false);
      autoInstallRef.current = false;
      setInstallCountdown(0);
      toast(t('已忽略版本 {v}，之后有更新的版本才会再提醒', { v: version }), 'info');
    } catch (e) {
      toast(t('忽略失败：{err}', { err: errorText(e) }), 'error');
    }
  };

  const runDownloadUpdate = async () => {
    if (!bridge?.downloadUpdate) return;
    setDownloading(true);
    setInstallCountdown(0);
    autoInstallRef.current = true;
    setUpdateProgress({ state: 'downloading', percent: 0 });
    try {
      const result = await bridge.downloadUpdate();
      if (!result.ok) {
        autoInstallRef.current = false;
        setDownloading(false);
        setUpdateProgress(null);
        toast(result.message || t('下载更新失败，请稍后再试'), 'error');
      }
    } catch (e) {
      autoInstallRef.current = false;
      setDownloading(false);
      setUpdateProgress(null);
      toast(t('下载更新失败：{err}', { err: errorText(e) }), 'error');
    }
  };

  const runInstallUpdate = async () => {
    if (!bridge?.installUpdate) return;
    setInstallCountdown(0);
    const result = await bridge.installUpdate();
    if (result && result.ok === false) toast(result.message || t('现在还不能安装更新'), 'error');
  };

  const openLogs = async () => {
    if (!bridge) return;
    try {
      const res = await bridge.openLogFolder();
      if (res && typeof res === 'object' && 'error' in res) {
        toast(t('打不开日志文件夹：{err}', { err: res.error }), 'error');
        return;
      }
      log('app', 'info', '打开了日志文件夹');
    } catch (e) {
      toast(t('打不开日志文件夹：{err}', { err: errorText(e) }), 'error');
    }
  };

  const exportDiagnostics = () => {
    const state = useApp.getState();
    const text = buildDiagnostics({
      [t('应用版本')]: appVersion,
      [t('运行环境')]: bridge ? t('Electron 桌面端') : t('浏览器 / PWA'),
      [t('平台')]: navigator.platform || navigator.userAgent,
      [t('存储')]: bridge ? t('真实文件系统') : t('浏览器 OPFS（LightningFS）'),
      [t('主题')]: theme,
      [t('笔记本数')]: state.notebooks.length,
      [t('笔记数')]: state.notes.length,
      [t('回收站')]: state.trash.length,
      [t('云端')]: cfg ? `${cfg.provider} · ${t('分支')} ${cfg.branch}` : t('未连接'),
      Token: token ? t('会话内已保存') : t('无'),
      [t('同步状态')]: t(SYNC_LABEL[state.syncState] || state.syncState),
      [t('定时检查')]: t('{n} 分钟', { n: state.syncInterval || 60 }),
      [t('上次同步')]: state.syncAt || t('无'),
      [t('关闭到托盘')]: closeToTray ? t('开') : t('关'),
    });
    const name = t('萤光笔记-诊断-{date}-{time}.txt', { date: dateKey(), time: timeKey().replace(':', '') });
    downloadText(name, text, 'text/plain;charset=utf-8');
    log('app', 'info', '已导出诊断日志');
    toast(t('诊断日志已导出'), 'success');
  };

  /**
   * 未连接时底部只有一个主按钮：校验通过就直接连上，省掉「先校验、再点连接」
   * 的两步。桌面端才真能连（主进程代理绕过跨域）；网页版退化为纯校验，按钮
   * 文案也相应保留「校验令牌」，不摆一个注定失败的入口。
   */
  const verify = async (autoConnect = Boolean(bridge)) => {
    const tk = tokenInput.trim();
    if (!tk) {
      setStatus({ kind: 'bad', text: t('请先填写授权令牌') });
      return;
    }
    if (!repoName.trim()) {
      setStatus({ kind: 'bad', text: t('请填写仓库名称') });
      return;
    }
    setBusy('verify');
    setStatus({ kind: 'info', text: t('正在校验令牌…') });
    try {
      const who = await verifyToken(provider, tk);
      setOwner(who);
      try {
        const info = await getRepo(provider, tk, who, repoName.trim());
        if (!info.private) {
          // 不直接连，也不只丢一句「请自己改」：先问用户同不同意自动改成私有
          setPublicAsk({ who, repo: repoName.trim() });
          setStatus({
            kind: 'bad',
            text: t('仓库 {who}/{repo} 目前是公开的，先确认是否改为私有。', { who, repo: repoName.trim() }),
          });
        } else {
          const nextBranch = info.defaultBranch || branch;
          if (info.defaultBranch) setBranch(info.defaultBranch);
          if (autoConnect) {
            // 校验已通过，直接接着连接；状态文案从「校验」平滑切到「连接」，
            // 用户只点了一次，不出现「还要再点一下」的空档。
            setStatus({
              kind: 'info',
              text: t('令牌校验通过，正在连接 {who}/{repo}…', { who, repo: repoName.trim() }),
            });
            await doConnect(false, { who, repo: repoName.trim(), branch: nextBranch });
            return;
          }
          setStatus({
            kind: 'ok',
            text: t('已找到私有仓库 {who}/{repo}。网页版不能直连 Git 服务器，请用桌面客户端完成连接。', { who, repo: repoName.trim() }),
          });
        }
      } catch (e) {
        if (e instanceof GitError && e.code === 'REPO_NOT_FOUND') {
          setStatus({ kind: 'info', text: t('账号 {who} 的令牌校验通过，可以创建仓库了。', { who }) });
          setCreateErr('');
          setCreatePrompt(true);
        } else {
          throw e;
        }
      }
    } catch (e) {
      const err = e as GitError;
      setStatus({ kind: 'bad', text: err.message || t('校验失败') });
    } finally {
      setBusy('');
    }
  };

  /** 连接/建仓失败时给用户一句「下一步做什么」，不要直接把底层英文抛出来 */
  const friendlyConnectError = (e: unknown, createFirst: boolean, repoReady: boolean) => {
    const raw = String((e as { message?: string } | null)?.message || e || '');
    if (e instanceof GitError && e.code === 'CORS_BLOCKED') {
      // 网页版不是网络问题，而是浏览器不让读 Git 接口的响应，重试多少次都不会成功
      return createFirst && repoReady
        ? t('仓库已经建好了，不用再创建。但网页版浏览器不能直接连接 Git 服务器（跨域限制），所以这次没法同步。请改用桌面客户端登录这个仓库；本地笔记不受影响。')
        : e.message;
    }
    const net =
      (e instanceof GitError && e.code === 'NETWORK') ||
      /ENOTFOUND|ETIMEDOUT|Failed to fetch|NetworkError|load failed/i.test(raw);
    if (net) {
      if (createFirst) {
        return repoReady
          ? t('网络中断，这次没连上。仓库已经建好了，不用再创建。')
          : t('网络中断，暂时没确认仓库是否建好。保持仓库名不变再点一次即可，不会重复创建。');
      }
      return t('网络不通，没能连上仓库。检查网络后再点一次。');
    }
    if (e instanceof GitError) return e.message || t('连接失败');
    return friendlyGitMessage(raw, 'connect');
  };

  const doConnect = async (
    createFirst: boolean,
    opts?: {
      onError?: (message: string) => void;
      who?: string;
      repo?: string;
      branch?: string;
      firstConnect?: 'merge' | 'adopt-remote';
      worktreeReset?: 'restore' | 'keep';
      mergeConflict?: 'keep-local';
      /** 已经确认过「换仓库 / 仓库属于别的工作区」的提醒，不再重复弹 */
      workspaceConfirmed?: boolean;
    },
  ) => {
    const tk = tokenInput.trim();
    // 刚校验完或刚改完私有，state 可能还没刷新；调用方可以显式传值，避免用到旧值
    const who = (opts?.who || owner).trim();
    const repoValue = (opts?.repo ?? repoName).trim();
    const branchValue = (opts?.branch ?? branch).trim() || 'main';
    if (!tk || !who || !repoValue) {
      setStatus({ kind: 'bad', text: t('请先填写授权令牌和仓库名称') });
      return;
    }
    const next: GitConfig = {
      provider,
      owner: who,
      repo: repoValue,
      branch: branchValue,
      remember: true,
    };
    setBusy(createFirst ? 'create' : 'connect');
    setStatus({ kind: 'info', text: createFirst ? t('正在创建私有仓库…') : t('正在连接仓库并合并…') });
    // 仓库是否已经确实存在于平台上（决定失败后是「再建一次」还是「只重试连接」）
    let repoInfo: { private: boolean; defaultBranch: string } | null = null;
    try {
      if (createFirst) {
        try {
          await createRepo(provider, tk, next.repo);
          // 记住「这个仓库是应用刚建的」，连接成功后补一份介绍性的 README
          markSeedReadme(next);
          repoInfo = await getRepo(provider, tk, who, next.repo).catch(() => null);
          setStatus({ kind: 'info', text: t('仓库已创建，正在连接…') });
        } catch (e) {
          // 上一次点击可能其实已经把仓库建好了，只是网络中断后没收到回执；
          // 或者平台直接回了「已存在」。复查一次：存在且私有就接着连，不必让用户改名重来。
          const again = await getRepo(provider, tk, who, next.repo).catch(() => null);
          if (!again) throw e;
          if (!again.private) {
            // 已存在但是公开：不替用户做决定，收起建仓弹窗，等确认后再改私有并连接
            setCreatePrompt(false);
            setCreateErr('');
            setPublicAsk({ who, repo: next.repo });
            setStatus({
              kind: 'bad',
              text: t('仓库 {who}/{repo} 已经存在，但现在是公开的。先确认是否改为私有。', { who, repo: next.repo }),
            });
            return;
          }
          repoInfo = again;
          setStatus({ kind: 'info', text: t('仓库已经存在，正在直接连接…') });
        }
        // 平台新建仓库的默认分支不一定是 main（Gitee 常是 master），以平台返回为准
        if (repoInfo?.defaultBranch && repoInfo.defaultBranch !== next.branch) {
          next.branch = repoInfo.defaultBranch;
          setBranch(repoInfo.defaultBranch);
        }
      }
      // 连接前先确认工作区。判定仓库身份必须带上平台：只有「同一平台 + 同一账号
      // + 同一仓库」才是同一份笔记；换平台或换账号后的同名仓库要各自独立目录，
      // 绝不能把当前笔记目录改绑过去。
      if (bridge && !opts?.workspaceConfirmed) {
        try {
          const info = await bridge.workspaceInfo?.();
          // 这个仓库已经有工作区：直接切过去，不在同一台电脑上维护两份同步副本
          const other = await bridge.workspaceFindRepo?.({
            provider: next.provider,
            owner: next.owner,
            repo: next.repo,
          });
          if (other && other.id !== info?.id) {
            if (repoInfo) {
              setCreatePrompt(false);
              setCreateErr('');
            }
            setWsAsk({
              kind: 'duplicate',
              provider: next.provider,
              who: next.owner,
              repo: next.repo,
              branch: next.branch,
              name: other.name,
              otherId: other.id,
            });
            return;
          }
          // 老版本升级上来的工作区可能还没登记 repo，但本机仍连着某个仓库；
          // 用当前同步配置补上这一身份，避免把新仓库直接连进旧笔记目录。
          const bound = info?.repo || (cfg ? { provider: cfg.provider, owner: cfg.owner, repo: cfg.repo } : null);
          const same =
            !bound ||
            ((bound.provider || '').toLowerCase() === next.provider &&
              bound.owner.trim().toLowerCase() === next.owner.trim().toLowerCase() &&
              bound.repo.trim().toLowerCase() === next.repo.trim().toLowerCase());
          if (bound && !same) {
            if (repoInfo) {
              setCreatePrompt(false);
              setCreateErr('');
              setStatus({
                kind: 'info',
                text: t('仓库 {who}/{repo} 已创建。它需要单独的工作区，确认后应用会切换过去并自动连接。', { who: next.owner, repo: next.repo }),
              });
            }
            setWsAsk({
              kind: 'separate',
              provider: next.provider,
              who: next.owner,
              repo: next.repo,
              branch: next.branch,
              name: info?.name,
            });
            return;
          }
        } catch {
          /* 读不到工作区信息不影响正常连接 */
        }
      }
      log('sync', 'info', `开始连接 · ${next.provider} · ${who}/${next.repo} · 分支 ${next.branch || '(空)'}`);
      const res = await connect(next, tk, who, {
        firstConnect: opts?.firstConnect,
        worktreeReset: opts?.worktreeReset,
        mergeConflict: opts?.mergeConflict,
      });
      log('sync', 'info', `连接仓库成功 · ${next.provider} · 冲突副本 ${res.conflicts.length}`);
      configureGit(next, tk, who);
      // 记下当前工作区关联的仓库：下次换仓库前会先提醒，也能识别「仓库已有工作区」
      if (bridge?.workspaceBindRepo) {
        void bridge
          .workspaceBindRepo(
            {
              provider: next.provider,
              owner: next.owner,
              repo: next.repo,
              branch: next.branch,
            },
            // 用户已经确认过「换仓库 / 仓库属于别的工作区」，这里要真正写入；
            // 否则确认完却因为同一个冲突把绑定丢掉，下次连接又会被问一遍。
            opts?.workspaceConfirmed ? { force: true } : undefined,
          )
          .then((bind) => {
            if (bind?.conflict) {
              toast(
                t('仓库 {who}/{repo} 还关联着工作区「{name}」，两边会各自同步同一份笔记', {
                  who: next.owner,
                  repo: next.repo,
                  name: bind.conflict.name,
                }),
                'warn',
              );
            }
            void loadWorkspaces();
          })
          .catch(() => {});
      }
      setCreatePrompt(false);
      setCreateErr('');
      if (res.conflicts.length) {
        setStatus({
          kind: 'ok',
          text: t('已连接。合并时发现同名笔记，保留了 {n} 份冲突副本，两份内容都在。', { n: res.conflicts.length }),
        });
        toast(t('已连接，保留了 {n} 份冲突副本', { n: res.conflicts.length }), 'warn');
      } else {
        setStatus({ kind: 'ok', text: t('已连接，之后的修改会自动同步。') });
        toast(t('已连接云端仓库'), 'success');
      }
      void syncNow(true);
    } catch (e) {
      const repoReady = Boolean(repoInfo);
      const message = friendlyConnectError(e, createFirst, repoReady);
      const corsBlocked = e instanceof GitError && e.code === 'CORS_BLOCKED';
      // 兜底文案只说「检查仓库和令牌」，看不出到底哪一步失败。把原始错误附在下面，用户能复制给我定位。
      const detail = errorDetail(e);
      // 日志里连技术细节一起记，事后不用再让用户复述界面上的小字
      log('sync', 'error', `连接仓库失败 · ${errorText(e)}${detail ? ` · 细节：${detail}` : ''}`);
      if (e instanceof GitError && e.code === 'WORKTREE_RESET') {
        // 本地目录缺失大量仓库文件：绝不能一句「再点一次」就继续，那会把删除推上去
        setCreatePrompt(false);
        setCreateErr('');
        setStatus(null);
        setWorktreeReset({
          provider: next.provider,
          who: next.owner,
          repo: next.repo,
          branch: next.branch,
          message: e.message,
        });
        return;
      }
      if (e instanceof GitError && e.code === 'CHECKOUT_CONFLICT') {
        // 这不是一句能靠「再点一次」解决的提示：必须让用户明确选择覆盖还是手动处理
        setCreatePrompt(false);
        setCreateErr('');
        setStatus(null);
        setCheckoutConflict({
          provider: next.provider,
          who: next.owner,
          repo: next.repo,
          branch: next.branch,
        });
        return;
      }
      if (e instanceof GitError && e.code === 'FIRST_CONNECT_CHOICE') {
        // 远端有内容、本机也有内容：让用户明确选择「合并」还是「覆盖」，
        // 不默认替他把示例笔记推到别人的仓库里。
        setCreatePrompt(false);
        setCreateErr('');
        setStatus(null);
        setFirstConnect({
          provider: next.provider,
          who: next.owner,
          repo: next.repo,
          branch: next.branch,
        });
        return;
      }
      if (e instanceof GitError && e.code === 'MERGE_CONFLICT') {
        // 换平台 / 换账号后同名仓库很常见：两边都有提交，自动合并时有文件过不去。
        // 不能只丢一句「请自己处理」，也不能让「再点一次」变成无意义的循环。
        setCreatePrompt(false);
        setCreateErr('');
        setStatus(null);
        setMergeConflict({
          provider: next.provider,
          who: next.owner,
          repo: next.repo,
          branch: next.branch,
        });
        return;
      }
      if (createFirst && repoInfo) {
        // 仓库已经在平台上了，剩下的只是「连接」。只有网络类、不确定类错误才值得
        // 让用户再点一次；权限、跨域、冲突这类重试多少次结果都一样，别误导人。
        const noRetry =
          e instanceof GitError &&
          [
            'CONFLICT',
            'AUTH_FORBIDDEN',
            'AUTH_INVALID',
            'CORS_BLOCKED',
            'HISTORY_REWRITTEN',
            'REPO_NOT_FOUND',
            'REPO_PRIVATE_DENIED',
            'REPO_PRIVATE_FAILED',
          ].includes(e.code);
        setCreatePrompt(false);
        setCreateErr('');
        setStatus({
          kind: 'bad',
          text: corsBlocked || noRetry ? message : t('{msg} 再点一次底部的「校验并连接」即可继续。', { msg: message }),
          detail,
        });
      } else {
        setStatus({ kind: 'bad', text: message, detail });
        opts?.onError?.(message);
      }
    } finally {
      setBusy('');
    }
  };

  /**
   * 用户确认后：先把公开仓库改成私有，重新读到私有状态再继续连接。
   * 取消则什么都不做——公开仓库绝不连接。
   */
  const makePrivateAndConnect = async () => {
    if (!publicAsk || makingPrivate) return;
    const tk = tokenInput.trim();
    if (!tk) {
      setPublicAsk(null);
      setStatus({ kind: 'bad', text: t('授权令牌已清空，请重新填写后再校验。') });
      return;
    }
    const target = publicAsk;
    setMakingPrivate(true);
    setStatus({ kind: 'info', text: t('正在把仓库改为私有…') });
    try {
      await setRepoPrivate(provider, tk, target.who, target.repo);
      // 平台偶尔有几秒延迟，重新读一次，确认真的私有了再连，避免「看似成功其实没生效」
      const info = await getRepo(provider, tk, target.who, target.repo).catch(() => null);
      if (info && !info.private) {
        throw new GitError('REPO_PUBLIC', t('平台还没有生效，请等几秒再试一次；也可以到平台手动确认仓库已是私有。'));
      }
      const nextBranch = info?.defaultBranch || branch;
      setOwner(target.who);
      if (nextBranch) setBranch(nextBranch);
      setPublicAsk(null);
      setStatus({ kind: 'info', text: t('已改为私有，正在连接…') });
      log('sync', 'info', `公开仓库已改为私有 · ${target.who}/${target.repo}`);
      toast(t('已改为私有仓库'), 'success');
      await doConnect(false, { who: target.who, repo: target.repo, branch: nextBranch });
    } catch (e) {
      // 自动改失败时给一条能走通的路：直接给出平台仓库设置页，并说明改完回来怎么继续。
      // 令牌无效 / 仓库看不到 / 网络不通这几种，给链接也没用，只提示原因。
      const reason = (e as GitError)?.message || t('改为私有失败。');
      const code = (e as GitError)?.code || '';
      const canGuide = ['REPO_PRIVATE_DENIED', 'REPO_PRIVATE_FAILED', 'REPO_PUBLIC', 'AUTH_FORBIDDEN'].includes(code);
      setStatus({
        kind: 'bad',
        text: canGuide
          ? t('{reason} 也可以到平台网页自己改：{hint}', {
              reason,
              hint: manualPrivateHint(provider, target.who, target.repo),
            })
          : reason,
        detail: errorDetail(e),
        action: canGuide
          ? { label: t('打开仓库设置页手动改为私有'), url: repoSettingsUrl(provider, target.who, target.repo) }
          : undefined,
      });
      setPublicAsk(null);
      log('sync', 'error', `改为私有失败 · ${errorText(e)}`);
    } finally {
      setMakingPrivate(false);
    }
  };

  const connected = Boolean(cfg && token);

  /** 已连接时更换令牌：校验通过后直接覆盖本机保存的那一份，并立刻重试同步 */
  const updateToken = async () => {
    if (!cfg || updatingToken) return;
    const tk = newToken.trim();
    if (!tk) {
      toast(t('先粘贴新的令牌'), 'warn');
      return;
    }
    setUpdatingToken(true);
    try {
      const who = await verifyToken(cfg.provider, tk);
      configureGit(cfg, tk, who);
      setNewToken('');
      toast(t('令牌已更新，正在重新同步'), 'success');
      void syncNow(true);
    } catch (e) {
      toast((e as Error).message || t('令牌校验没有通过'), 'error');
    } finally {
      setUpdatingToken(false);
    }
  };

  const resetOne = (id: string) => {
    const def = SHORTCUT_DEFS.find((d) => d.id === id);
    if (!def) return;
    const next = { ...bindings, [id]: def.def };
    setBindings(next);
    saveBindings(next);
    setConflict('');
  };

  const resetAll = () => {
    const next = resetBindings();
    setBindings({ ...next });
    setRecording(null);
    setConflict('');
    toast(t('快捷键已恢复默认'), 'info');
  };

  return (
    <div className="overlay">
      <div className="modal settings">
        <div className="modal-head" style={{ paddingBottom: 10 }}>
          <div>
            <div className="modal-title">{t('设置')}</div>
            <div className="modal-desc">{t('界面、同步与本地数据')}</div>
          </div>
          <button className="icon-btn" onClick={close} title={t('关闭')}>
            <X size={16} />
          </button>
        </div>

        <div className="settings-tabs">
          {(
            [
              ['general', '常规'],
              ['sync', '同步'],
              ['storage', '存储'],
              ['ai', 'AI'],
              ['notify', '通知'],
              ['mcp', 'MCP'],
              ['security', '安全'],
              ['stats', '统计'],
              ['keys', '快捷键'],
              ['about', '关于'],
            ] as [SettingsTab, string][]
          ).map(([key, label]) => (
            <button
              key={key}
              className={cn('settings-tab', tab === key && 'on')}
              onClick={() => setSettings(true, key)}
            >
              {t(label)}
            </button>
          ))}
        </div>

        <div className="settings-body">
          {tab === 'general' && (
            <>
              {bridge?.workspaceList && (
                <>
                  <div className="set-section-title">{t('工作区')}</div>
                  <div className="set-row">
                    <div style={{ minWidth: 0 }}>
                      <div className="set-label">
                        {wsInfo?.name || t('默认工作区')}
                        {wsInfo?.repo && (
                          <span
                            className="tag"
                            style={{ marginLeft: 8 }}
                            title={t('平台 · 账号/仓库（三者都相同才是同一份笔记）')}
                          >
                            {wsInfo.repo.provider} · {wsInfo.repo.owner}/{wsInfo.repo.repo}
                          </span>
                        )}
                      </div>
                      <div className="set-desc">
                        {t('每个工作区都有独立的笔记文件夹、云端仓库、令牌、日志和界面设置。同一台电脑多人使用，或想把工作和私人笔记完全分开时，各建一个工作区即可，互不覆盖。')}
                      </div>
                      <div className="set-desc">
                        {wsInfo?.repo
                          ? t('切换工作区后，同步、令牌和日志都会跟着切换。')
                          : t('当前工作区还没有关联云端仓库。')}
                      </div>
                    </div>
                    <div className="set-actions">
                      <button className="btn btn-secondary" onClick={() => setWsOpen(true)}>
                        <HardDrive size={14} /> {t('管理工作区…')}
                      </button>
                    </div>
                  </div>
                </>
              )}
              {bridge?.repoLocation && (
                <div className="set-row">
                  <div style={{ minWidth: 0 }}>
                    <div className="set-label">{t('笔记存储位置')}</div>
                    <div className="set-desc">
                      {t('当前工作区「{name}」的笔记文件夹，所有笔记都是普通 Markdown 文件，换电脑或做备份直接拷这个文件夹就行。', {
                        name: wsInfo?.name || t('默认工作区'),
                      })}
                      {workspaces.length > 1 && t('切换工作区后会跟着换成对应工作区的文件夹。')}
                    </div>
                    <div className="set-path" title={repoLocation?.path || wsInfo?.root || ''}>
                      {repoLocation?.path || wsInfo?.root || t('读取中…')}
                    </div>
                    {repoLocation?.custom && (
                      <div className="set-desc">
                        {t('当前是自定义位置；点「恢复默认」会迁回这个工作区创建时的文件夹')}
                        {repoLocation.defaultPath ? `：${repoLocation.defaultPath}` : ''}。
                      </div>
                    )}
                  </div>
                  <div className="set-actions">
                    <button className="btn btn-secondary" onClick={() => void bridge?.openRepoFolder()}>
                      <FolderOpen size={14} /> {t('打开')}
                    </button>
                    <button className="btn btn-secondary" disabled={moving} onClick={() => void pickRepoLocation()}>
                      <HardDrive size={14} /> {t('更改位置…')}
                    </button>
                    {repoLocation?.custom && (
                      <button
                        className="btn btn-secondary"
                        disabled={moving}
                        onClick={() => setRepoPick(repoLocation.defaultPath)}
                        title={t('把当前工作区的笔记迁回创建时的文件夹')}
                      >
                        <RotateCcw size={14} /> {t('恢复默认')}
                      </button>
                    )}
                  </div>
                </div>
              )}
              <div className="set-section-title">{t('外观')}</div>
              <div className="set-row">
                <div>
                  <div className="set-label">{t('界面语言')}</div>
                  <div className="set-desc">
                    {t('切换后立即生效，界面文字会随之更新。')}
                  </div>
                </div>
                <div className="segment">
                  {(
                    [
                      ['zh', '简体中文'],
                      ['en', 'English'],
                    ] as ['zh' | 'en', string][]
                  ).map(([key, label]) => (
                    <button key={key} className={lang === key ? 'on' : undefined} onClick={() => setLang(key)}>
                      {t(label)}
                    </button>
                  ))}
                </div>
              </div>
              <div className="set-row">
                <div>
                  <div className="set-label">{t('主题')}</div>
                  <div className="set-desc">
                    {t('浅色更亮更中性、靠细线分区；暖白偏米黄。跟随系统会随操作系统的深浅色自动切换。')}
                  </div>
                </div>
                <div className="segment">
                  {(
                    [
                      ['paper', '浅色'],
                      ['light', '暖白'],
                      ['dark', '深色'],
                      ['system', '跟随系统'],
                    ] as [typeof theme, string][]
                  ).map(([key, label]) => (
                    <button key={key} className={theme === key ? 'on' : undefined} onClick={() => setTheme(key)}>
                      {t(label)}
                    </button>
                  ))}
                </div>
              </div>
              <div className="set-row">
                <div>
                  <div className="set-label">{t('编辑器字号')}</div>
                  <div className="set-desc">{t('同时影响编辑与阅读预览里的正文字号。')}</div>
                </div>
                <div className="segment">
                  {(
                    [
                      [14, '14'],
                      [16, '16'],
                      [18, '18'],
                    ] as [number, string][]
                  ).map(([size, label]) => (
                    <button
                      key={size}
                      className={editorSize === size ? 'on' : undefined}
                      onClick={() => applySize(size)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="set-row">
                <div>
                  <div className="set-label">{t('正文宽度')}</div>
                  <div className="set-desc">{t('编辑与阅读预览共用的行宽；屏幕宽时选「宽」可以让文字铺得更开。')}</div>
                </div>
                <div className="segment">
                  {(
                    [
                      ['40', '窄'],
                      ['56', '中'],
                      ['66', '宽'],
                    ] as [string, string][]
                  ).map(([em, label]) => (
                    <button key={em} className={measure === em ? 'on' : undefined} onClick={() => applyMeasure(em)}>
                      {t(label)}
                    </button>
                  ))}
                </div>
              </div>

              <div className="set-section-title">{t('启动')}</div>
              <div className="set-row">
                <div>
                  <div className="set-label">{t('启动时显示首页')}</div>
                  <div className="set-desc">{t('打开应用先看到快捷入口和今天的概况。关掉后回到上次打开的笔记。')}</div>
                </div>
                <button
                  className={cn('switch', startHome && 'on')}
                  role="switch"
                  aria-checked={startHome}
                  title={startHome ? t('启动时显示首页') : t('启动时打开上次的笔记')}
                  onClick={() => applyStartHome(!startHome)}
                />
              </div>

              {bridge && (
                <>
                  <div className="set-section-title">{t('桌面')}</div>
                  <div className="set-row">
                    <div>
                      <div className="set-label">{t('关闭窗口时最小化到托盘')}</div>
                      <div className="set-desc">{t('关闭按钮只是收起窗口，笔记继续在后台同步；从托盘菜单可以真正退出。')}</div>
                    </div>
                    <button
                      className={cn('switch', closeToTray && 'on')}
                      role="switch"
                      aria-checked={closeToTray}
                      title={closeToTray ? t('关闭时收起到托盘') : t('关闭时退出应用')}
                      onClick={() => applyCloseToTray(!closeToTray)}
                    />
                  </div>
                  <div className="set-row">
                    <div>
                      <div className="set-label">{t('开机自动启动')}</div>
                      <div className="set-desc">
                        {t('登录系统后自动打开萤光笔记主窗口，不用再去开始菜单找。')}
                        {loginItem && !loginItem.supported && loginItem.error ? `（${loginItem.error}）` : ''}
                      </div>
                    </div>
                    <button
                      className={cn('switch', loginItem?.enabled && 'on')}
                      role="switch"
                      aria-checked={Boolean(loginItem?.enabled)}
                      disabled={!loginItem?.supported || loginBusy}
                      title={
                        !loginItem
                          ? t('正在读取系统启动项')
                          : loginItem.supported
                            ? loginItem.enabled
                              ? t('关闭开机自动启动')
                              : t('开启开机自动启动')
                            : loginItem.error || t('当前环境不支持')
                      }
                      onClick={() => void applyLoginItem(!loginItem?.enabled)}
                    />
                  </div>
                  <div className="set-row">
                    <div>
                      <div className="set-label">{t('快速捕获')}</div>
                      <div className="set-desc">
                        {t('任何界面按 Alt + Space（被占用时为 Ctrl + Alt + Space）打开小窗，Ctrl + Enter 存入灵感，稍后再整理。')}
                      </div>
                    </div>
                    <button className="btn btn-secondary" onClick={() => void bridge.openCapture()}>
                      <Zap size={14} /> {t('打开')}
                    </button>
                  </div>
                  <div className="set-row">
                    <div>
                      <div className="set-label">{t('待办浮窗')}</div>
                      <div className="set-desc">
                        {t('常驻桌面的小卡片，直接看今天的待办、勾完成、随手记灵感。')}
                        {!cardHotkeyTaken && t('按 Ctrl + Alt + D 随时开关。')}
                      </div>
                    </div>
                    <button
                      className={cn('switch', cardOpen && 'on')}
                      role="switch"
                      aria-checked={cardOpen}
                      title={cardOpen ? t('隐藏待办浮窗') : t('显示待办浮窗')}
                      onClick={toggleCard}
                    />
                  </div>
                  <div className="set-row">
                    <div>
                      <div className="set-label">{t('浮窗透明度')}</div>
                      <div className="set-desc">
                        {t('调低后浮窗平时半透明，鼠标移上去自动恢复不透明，不挡后面的内容。拉到 0% 完全隐形，把鼠标移回原位置或按 Ctrl+Alt+D 就能叫回来。')}
                      </div>
                    </div>
                    <div className="set-inline-slider">
                      <input
                        type="range"
                        min={0}
                        max={100}
                        step={5}
                        value={Math.round(cardOpacity * 100)}
                        aria-label={t('浮窗透明度')}
                        onChange={(e) => applyCardOpacity(Number(e.target.value) / 100)}
                      />
                      <span>{Math.round(cardOpacity * 100)}%</span>
                    </div>
                  </div>
                  <div className="set-row">
                    <div>
                      <div className="set-label">{t('到点提醒')}</div>
                      <div className="set-desc">
                        {t('待办设了具体时间才会提醒：到点在桌面右下角弹出独立小窗并响两声提示音，主窗口收起也能看到；应用上锁时只提示条数，不露出待办标题。')}
                      </div>
                    </div>
                    <button
                      className={cn('switch', reminderOn && 'on')}
                      role="switch"
                      aria-checked={reminderOn}
                      title={reminderOn ? t('到点提醒已开启') : t('到点提醒已关闭')}
                      onClick={() => {
                        const next = !reminderOn;
                        setReminderOn(next);
                        setRemindersEnabled(next);
                        toast(next ? t('到点提醒已开启') : t('到点提醒已关闭'), 'info');
                      }}
                    />
                  </div>
                </>
              )}

              <div className="set-section-title">{t('数据')}</div>
              <div className="set-row">
                <div>
                  <div className="set-label">{t('导出全部笔记')}</div>
                  <div className="set-desc">{t('打包为 ZIP，包含所有 Markdown 与图片附件，可直接用其他编辑器打开。')}</div>
                </div>
                <button
                  className="btn btn-secondary"
                  onClick={() => {
                    void exportAllZip(notes).then(() => {
                      log('data', 'info', `导出全部笔记 · ${notes.length} 篇`);
                      toast(t('已导出全部笔记'), 'success');
                    });
                  }}
                >
                  <Package size={14} /> {t('导出 ZIP')}
                </button>
              </div>
              <div className="set-row">
                <div>
                  <div className="set-label">{t('导入 Markdown')}</div>
                  <div className="set-desc">
                    {t('导入到 {name} 笔记本。', {
                      name: current?.notebook || (view.type === 'notebook' ? view.value : 'inbox') || 'inbox',
                    })}
                  </div>
                </div>
                <button className="btn btn-secondary" onClick={() => fileRef.current?.click()}>
                  <Upload size={14} /> {t('选择文件')}
                </button>
                <input
                  ref={fileRef}
                  type="file"
                  accept=".md,.markdown,.txt"
                  multiple
                  hidden
                  onChange={async (e) => {
                    const files = Array.from(e.target.files || []);
                    e.target.value = '';
                    if (!files.length) return;
                    const target = current?.notebook || (view.type === 'notebook' ? view.value : '') || 'inbox';
                    const count = await importMarkdownFiles(files, target);
                    await refresh();
                    log('data', 'info', `导入 Markdown · ${count} 篇 → ${target}`);
                    toast(count ? t('已导入 {n} 篇笔记', { n: count }) : t('没有可导入的文件'), count ? 'success' : 'warn');
                  }}
                />
              </div>
              <div className="set-row">
                <div>
                  <div className="set-label">{t('附件大小上限')}</div>
                  <div className="set-desc">
                    {t('插入图片或附件时的单文件上限，超过会提示跳过。默认 {def}MB，可设 {min}–{max}MB。实际还会受平台限制：Gitee 免费仓库单文件 50MB，GitHub / GitCode 约 100MB。插入大图会自动压到长边 2000px，通常能省下一大半体积。', {
                      def: ATTACH_LIMIT_DEFAULT,
                      min: ATTACH_LIMIT_MIN,
                      max: ATTACH_LIMIT_MAX,
                    })}
                  </div>
                </div>
                <div className="num-field">
                  <input
                    className="input"
                    type="number"
                    min={ATTACH_LIMIT_MIN}
                    max={ATTACH_LIMIT_MAX}
                    value={attachDraft}
                    onChange={(e) => setAttachDraft(e.target.value)}
                    onBlur={commitAttachLimit}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') e.currentTarget.blur();
                    }}
                    aria-label={t('附件大小上限（MB）')}
                  />
                  <span>MB</span>
                  {saveFlash?.key === 'attach' && (
                    <span className="save-flash">
                      <Check size={13} /> {saveFlash.text}
                    </span>
                  )}
                </div>
              </div>
              <div className="set-row">
                <div>
                  <div className="set-label">{t('回收站')}</div>
                  <div className="set-desc">{t('删除的笔记保留 30 天，可随时恢复。')}</div>
                </div>
                <button
                  className="btn btn-secondary"
                  onClick={() => {
                    close();
                    openTrash();
                  }}
                >
                  <Trash2 size={14} /> {t('打开回收站')}
                </button>
              </div>
            </>
          )}

          {tab === 'storage' && (
            <div className="storage-page">
              <div className="settings-subtabs" role="tablist">
                <button
                  role="tab"
                  aria-selected={storageTab === 'cloud'}
                  className={cn('settings-subtab', storageTab === 'cloud' && 'on')}
                  onClick={() => setStorageTab('cloud')}
                >
                  <Cloud size={14} strokeWidth={1.8} /> {t('云存储设置')}
                </button>
                <button
                  role="tab"
                  aria-selected={storageTab === 'local'}
                  className={cn('settings-subtab', storageTab === 'local' && 'on')}
                  onClick={() => setStorageTab('local')}
                >
                  <HardDrive size={14} strokeWidth={1.8} /> {t('存储管理')}
                </button>
              </div>

              {storageTab === 'cloud' && (
              <div className="qiniu-section" id="set-qiniu">
                <div className="qiniu-head">
                  <div>
                    <div className="set-label">{t('图片与附件云存储（七牛云）')}</div>
                    <div className="set-desc">
                      {t(
                        '打开后，新插入的图片和附件会直接上传到七牛云，笔记里只留外链，不占 Git 仓库；关掉则存进本机仓库，配置会保留，随时可以再打开。',
                      )}
                    </div>
                  </div>
                  <div className="qiniu-switch-wrap">
                    <span className={cn('qiniu-switch-label', qiniuOn && 'on')}>
                      {qiniuOn ? t('已开启') : t('已关闭')}
                    </span>
                    <button
                      type="button"
                      className={cn('switch', qiniuOn && 'on')}
                      role="switch"
                      aria-checked={qiniuOn}
                      aria-label={t('启用七牛云存储')}
                      title={qiniuOn ? t('关闭后改用本地存储') : t('打开后图片和附件上传到七牛云')}
                      onClick={() => toggleQiniu(!qiniuOn)}
                    />
                  </div>
                </div>

                <div className="qiniu-notice" role="note">
                  <Info size={15} strokeWidth={1.8} className="qiniu-notice-icon" />
                  <div className="qiniu-notice-text">
                    <strong>{t('存储空间必须设为「公开」访问')}</strong>
                    <span>
                      {t(
                        '七牛新建的空间默认是私有：私有空间里的图片链接要带实时签名才能打开，贴进笔记会显示不出来。已经建好的空间，可以在控制台的空间设置里把访问控制改成公开。',
                      )}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="ext-link qiniu-notice-link"
                    onClick={() => openExternal('https://portal.qiniu.com/kodo/bucket')}
                  >
                    {t('去空间设置')} <ExternalLink size={12} />
                  </button>
                </div>

                <div className="qiniu-grid">
                  <div className="field field-wide">
                    <div className="field-label">
                      <label htmlFor="qiniu-bucket">{t('存储空间（Bucket）')}</label>
                      <button
                        type="button"
                        className="ext-link"
                        onClick={() => openExternal('https://portal.qiniu.com/kodo/bucket')}
                      >
                        {t('去创建')} <ExternalLink size={12} />
                      </button>
                    </div>
                    <input
                      id="qiniu-bucket"
                      className="input"
                      value={qiniu.bucket}
                      placeholder="glimnote"
                      spellCheck={false}
                      autoComplete="off"
                      onChange={(e) => {
                        setQiniu((v) => ({ ...v, bucket: e.target.value }));
                        setQiniuMsg(null);
                      }}
                    />
                    <div className="qiniu-field-hint">
                      {t('默认 glimnote，按建议创建空间后这里不用改；控制台里空间名不一样时再改成实际名字。新建空间时访问控制请选「公开」。')}
                    </div>
                  </div>
                  <div className="field">
                    <div className="field-label">
                      <label htmlFor="qiniu-ak">{t('AccessKey（AK）')}</label>
                      <button
                        type="button"
                        className="ext-link"
                        onClick={() => openExternal('https://portal.qiniu.com/user/key')}
                      >
                        {t('去获取')} <ExternalLink size={12} />
                      </button>
                    </div>
                    <input
                      id="qiniu-ak"
                      className="input"
                      value={qiniu.accessKey}
                      placeholder={t('粘贴「密钥管理」里的 AK')}
                      spellCheck={false}
                      autoComplete="off"
                      onChange={(e) => {
                        setQiniu((v) => ({ ...v, accessKey: e.target.value }));
                        setQiniuMsg(null);
                      }}
                    />
                  </div>
                  <div className="field">
                    <div className="field-label">
                      <label htmlFor="qiniu-sk">{t('SecretKey（SK）')}</label>
                      <button
                        type="button"
                        className="ext-link"
                        onClick={() => setShowQiniuSecret((v) => !v)}
                        title={showQiniuSecret ? t('隐藏密钥') : t('显示密钥')}
                      >
                        {showQiniuSecret ? <EyeOff size={12} /> : <Eye size={12} />}
                        {showQiniuSecret ? t('隐藏') : t('显示')}
                      </button>
                    </div>
                    <input
                      id="qiniu-sk"
                      className="input"
                      type={showQiniuSecret ? 'text' : 'password'}
                      value={qiniu.secretKey}
                      placeholder={t('粘贴同一对密钥里的 SK')}
                      spellCheck={false}
                      autoComplete="off"
                      onChange={(e) => {
                        setQiniu((v) => ({ ...v, secretKey: e.target.value }));
                        setQiniuMsg(null);
                      }}
                    />
                    <div className="qiniu-field-hint">
                      {t('AK 和 SK 要一起填（上传时用 SK 签名），两者都只保存在本机。')}
                    </div>
                  </div>
                  <div className="field field-wide">
                    <div className="field-label">
                      <label htmlFor="qiniu-domain">{t('访问域名')}</label>
                      <button
                        type="button"
                        className="ext-link"
                        onClick={() => openExternal('https://portal.qiniu.com/kodo/bucket')}
                      >
                        {t('去绑定')} <ExternalLink size={12} />
                      </button>
                    </div>
                    <div className="qiniu-domain-row">
                      <div className="select-wrap qiniu-protocol">
                        <select
                          className="input select"
                          aria-label={t('访问协议')}
                          value={qiniuDomainParts.protocol}
                          onChange={(e) => changeQiniuProtocol(e.target.value === 'https' ? 'https' : 'http')}
                        >
                          <option value="http">http://</option>
                          <option value="https">https://</option>
                        </select>
                      </div>
                      <input
                        id="qiniu-domain"
                        className="input"
                        value={qiniuDomainParts.host}
                        placeholder={t('你的域名')}
                        spellCheck={false}
                        autoComplete="off"
                        onChange={(e) => changeQiniuDomain(e.target.value)}
                      />
                    </div>
                    <div className="qiniu-domain-help">
                      <span>{t('还没有域名？')}</span>
                      <button
                        type="button"
                        className="ext-link"
                        onClick={() => openExternal('https://wanwang.aliyun.com/')}
                      >
                        {t('去注册域名')} <ExternalLink size={12} />
                      </button>
                      <span className="qiniu-domain-help-dot">·</span>
                      <button
                        type="button"
                        className="ext-link"
                        onClick={() =>
                          openExternal('https://developer.qiniu.com/kodo/8622/dev-the-binding-source-domain-name')
                        }
                      >
                        {t('怎么绑定')} <ExternalLink size={12} />
                      </button>
                    </div>
                    <div className="qiniu-field-hint">
                      {t('域名每年几十元，注册后要实名；国内加速还需备案（约 1–3 周），备案前可以先用测试域名。')}
                    </div>
                    {isQiniuTestDomain(qiniu.domain) && (
                      <div className="qiniu-field-hint qiniu-warn">
                        {t('这是七牛测试域名：30 天后会被回收，而且不支持 HTTPS，只适合临时试用；长期使用请绑定自己的域名。')}
                      </div>
                    )}
                  </div>
                </div>

                <div className="key-sync-row">
                  <div className="key-sync-text">
                    <div className="key-sync-title">{t('上传密钥到云端')}</div>
                    <div className="key-sync-desc">
                      {t(
                        '开启后，AK/SK 会明文写进仓库的 .glimnote/keys.json，其它设备同步后可直接使用。只建议在私有仓库开启；密钥会留在 Git 历史里，之后删除也无法从旧提交中抹掉。关闭只会停止上传，仓库里已有的密钥仍会自动导入本机。',
                      )}
                    </div>
                  </div>
                  <button
                    type="button"
                    className={cn('switch', qiniuKeySync && 'on')}
                    role="switch"
                    aria-checked={qiniuKeySync}
                    aria-label={t('上传七牛密钥到云端')}
                    title={qiniuKeySync ? t('关闭密钥上传') : t('开启密钥上传')}
                    onClick={() => applyKeySync('qiniu', !qiniuKeySync)}
                  />
                </div>

                <div className="qiniu-help-row">
                  <button type="button" className="qiniu-help-link" onClick={() => setQiniuHelpOpen(true)}>
                    <HelpCircle size={13} /> {t('太复杂不会配置？')}
                  </button>
                </div>

                <div className="qiniu-foot">
                  <button className="btn btn-primary" onClick={persistQiniu} disabled={!qiniuComplete}>
                    <Check size={14} /> {t('保存配置')}
                  </button>
                  <button className="btn btn-secondary" onClick={() => void runQiniuTest()} disabled={!qiniuComplete || qiniuBusy}>
                    {qiniuBusy ? <Loader2 size={14} className="spin" /> : <Zap size={14} />} {t('保存并测试')}
                  </button>
                  {qiniuReady && (
                    <button className="btn btn-ghost" onClick={forgetQiniu}>
                      {t('清除配置')}
                    </button>
                  )}
                  {saveFlash?.key === 'qiniu' && (
                    <span className="save-flash">
                      <Check size={13} /> {saveFlash.text}
                    </span>
                  )}
                </div>
                {qiniuMsg && <div className={cn('qiniu-msg', qiniuMsg.ok ? 'ok' : 'bad')}>{qiniuMsg.text}</div>}
                <div className="hint">
                  {t(
                    '点「保存并测试」会上传一个测试小文件，验证密钥、空间和域名是否都填对了。配置好后，可以在「存储管理」里补传已有资源，或右键正文里的本地图片单独上传。',
                  )}
                </div>
              </div>
              )}

              {storageTab === 'local' && <LocalStoragePanel onConfigureCloud={() => setStorageTab('cloud')} />}
            </div>
          )}

          {tab === 'security' && <LockSettings />}

          {tab === 'notify' && <NotifySettings />}

          {tab === 'mcp' && <McpSettings />}

          {tab === 'stats' && <StatsPanel />}

          {tab === 'ai' && (
            <>
              <div className="ai-head">
                <div className="segment" role="group" aria-label={t('AI 设置分类')}>
                  <button className={cn(aiTab === 'conn' && 'on')} onClick={() => setAiTab('conn')}>
                    {t('连接配置')}
                  </button>
                  <button className={cn(aiTab === 'prompts' && 'on')} onClick={() => setAiTab('prompts')}>
                    {t('提示词')}
                  </button>
                </div>
                <span className="ai-head-note">
                  {aiTab === 'conn'
                    ? aiKeySync
                      ? t('地址和模型存在本机；密钥按下面的设置上传到私有仓库')
                      : t('地址和模型存在本机；仓库里同步过的密钥会自动导入')
                    : t('展开一项即可修改，留空回落默认')}
                </span>
              </div>

              {aiTab === 'conn' && (
                <>
                  <div className="ai-intro">
                    <Sparkles size={16} strokeWidth={1.75} />
                    <div>
                      {t('编辑器工具栏里点 ✨ 可以润色选中的文字，或顺着光标前的内容续写。只有你点按钮时才会把这段文字发给下面的服务商，AI 结果不会自动写进笔记。')}
                    </div>
                  </div>

                  <div className="field">
                    <div className="field-label">
                      <label htmlFor="ai-provider">{t('服务商')}</label>
                      {AI_PROVIDERS[aiCfg.provider].keyUrl && (
                        <a
                          className="ext-link"
                          href={AI_PROVIDERS[aiCfg.provider].keyUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {t('获取 API Key')} <ExternalLink size={12} />
                        </a>
                      )}
                    </div>
                    <div className="select-wrap">
                      <select
                        id="ai-provider"
                        className="input select"
                        value={aiCfg.provider}
                        onChange={(e) => applyAiProvider(e.target.value as AiProviderId)}
                      >
                        {AI_PROVIDER_ORDER.map((id) => (
                          <option key={id} value={id}>
                            {t(AI_PROVIDERS[id].label)}
                            {id === 'deepseek' ? t('（推荐）') : ''}
                          </option>
                        ))}
                      </select>
                      <ChevronDown size={14} strokeWidth={1.75} className="select-caret" />
                    </div>
                    <div className="hint">
                      {t(AI_PROVIDERS[aiCfg.provider].note)}
                      {!bridge ? t('。网页版可能被浏览器的跨域策略拦住，连不上时请改用桌面客户端。') : ''}
                    </div>
                  </div>

                  <div className="field">
                    <label>{t('接口地址')}</label>
                    <input
                      className="input"
                      value={aiCfg.baseUrl}
                      placeholder="https://api.deepseek.com/v1"
                      spellCheck={false}
                      onChange={(e) => {
                        setAiCfg((c) => ({ ...c, baseUrl: e.target.value }));
                        setAiStatus(null);
                      }}
                    />
                    <div className="hint">
                      {t('OpenAI 兼容地址，通常以')} <code>/v1</code> {t('结尾；本机 Ollama 填 http://127.0.0.1:11434/v1。')}
                    </div>
                  </div>

                  <div className="field">
                    <label>{t('模型')}</label>
                    <ModelPicker
                      value={aiCfg.model}
                      options={AI_PROVIDERS[aiCfg.provider].models}
                      placeholder="deepseek-flash"
                      onChange={(v) => {
                        setAiCfg((c) => ({ ...c, model: v }));
                        setAiStatus(null);
                      }}
                    />
                    <div className="hint">
                      {t('候选模型：{list}', {
                        list:
                          AI_PROVIDERS[aiCfg.provider].models.join(lang === 'en' ? ', ' : '、') ||
                          t('按服务商文档填写'),
                      })}
                    </div>
                  </div>

                  <div className="field">
                    <div className="field-label">
                      <span className="field-label-main">
                        <label htmlFor="ai-max-tokens">{t('最大输出 tokens')}</label>
                        {/* 说明收进问号里，避免这一栏被一行长文字撑高 */}
                        <span
                          className="field-help"
                          tabIndex={0}
                          role="note"
                          aria-label={t('最大输出 tokens 说明')}
                          data-tip={t('生成 AI 小应用时允许模型输出的上限，思考型模型的「思考过程」也算在里面。默认 {def}；经常提示「输出到上限、代码没写完」就调大，反复超时或额度消耗太快就调小（{min}–{max}）。润色、续写和连接测试不受这里影响。', {
                            def: DEFAULT_AI_MAX_TOKENS,
                            min: AI_MAX_TOKENS_MIN,
                            max: AI_MAX_TOKENS_MAX,
                          })}
                        >
                          <HelpCircle size={13} strokeWidth={1.9} />
                        </span>
                      </span>
                      {Number(maxDraft) !== DEFAULT_AI_MAX_TOKENS && (
                        <button
                          type="button"
                          className="ext-link"
                          onClick={() => setMaxDraft(String(DEFAULT_AI_MAX_TOKENS))}
                        >
                          {t('恢复默认')} {DEFAULT_AI_MAX_TOKENS}
                        </button>
                      )}
                    </div>
                    <div className="num-field num-field-wide">
                      <input
                        id="ai-max-tokens"
                        className="input"
                        type="number"
                        min={AI_MAX_TOKENS_MIN}
                        max={AI_MAX_TOKENS_MAX}
                        step={1024}
                        value={maxDraft}
                        onChange={(e) => setMaxDraft(e.target.value)}
                        onBlur={() => setMaxDraft(String(clampAiMaxTokens(maxDraft)))}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') e.currentTarget.blur();
                        }}
                        aria-label={t('最大输出 tokens')}
                      />
                      <span>tokens</span>
                    </div>
                  </div>

                  <div className="field">
                    <div className="field-label">
                      <label>API Key</label>
                      <button
                        type="button"
                        className="ext-link"
                        onClick={() => setShowKey((v) => !v)}
                        title={showKey ? t('隐藏密钥') : t('显示密钥')}
                      >
                        {showKey ? <EyeOff size={12} /> : <Eye size={12} />}
                        {showKey ? t('隐藏') : t('显示')}
                      </button>
                    </div>
                    <input
                      className="input"
                      type={showKey ? 'text' : 'password'}
                      value={aiKey}
                      autoComplete="off"
                      placeholder={AI_PROVIDERS[aiCfg.provider].keyless ? t('本地模型可不填') : t('粘贴 API Key')}
                      onChange={(e) => {
                        setAiKey(e.target.value);
                        setAiStatus(null);
                      }}
                    />
                    <div className="hint">
                      {aiKeySync
                        ? t('已开启上传：密钥会明文写进仓库的 .glimnote/keys.json，跟着提交同步到其它设备。')
                        : t('密钥不会上传到仓库，也不会写进笔记；但仓库里已有云同步的密钥时，这里会自动导入。')}
                    </div>
                  </div>

                  <div className="key-sync-row">
                    <div className="key-sync-text">
                      <div className="key-sync-title">{t('上传密钥到云端')}</div>
                      <div className="key-sync-desc">
                        {t(
                          '开启后，API Key 会明文写进仓库的 .glimnote/keys.json，其它设备同步后可直接使用。只建议在私有仓库开启；密钥会留在 Git 历史里，之后删除也无法从旧提交中抹掉。关闭只会停止上传，仓库里已有的密钥仍会自动导入本机。',
                        )}
                      </div>
                    </div>
                    <button
                      type="button"
                      className={cn('switch', aiKeySync && 'on')}
                      role="switch"
                      aria-checked={aiKeySync}
                      aria-label={t('上传 AI 密钥到云端')}
                      title={aiKeySync ? t('关闭密钥上传') : t('开启密钥上传')}
                      onClick={() => applyKeySync('ai', !aiKeySync)}
                    />
                  </div>

                  <div className="ai-foot">
                    <button className="btn btn-secondary" onClick={() => persistAi()} disabled={aiTesting}>
                      {t('保存')}
                    </button>
                    {saveFlash?.key === 'ai' && (
                      <span className="save-flash">
                        <Check size={13} /> {saveFlash.text}
                      </span>
                    )}
                    <button className="btn btn-primary" onClick={() => void runAiTest()} disabled={aiTesting}>
                      {aiTesting ? <Loader2 size={14} className="spin" /> : <Sparkles size={14} />} {t('测试连接')}
                    </button>
                    {aiStatus && (
                      <span
                        className={cn('ai-status', aiStatus.kind === 'ok' && 'ok', aiStatus.kind === 'bad' && 'bad')}
                      >
                        {aiStatus.kind === 'ok' ? (
                          <Check size={13} />
                        ) : aiStatus.kind === 'bad' ? (
                          <X size={13} />
                        ) : (
                          <Loader2 size={13} className="spin" />
                        )}
                        {aiStatus.text}
                      </span>
                    )}
                  </div>

                  <div className="token-warn">
                    {t('隐私说明：AI 只会收到你主动选中的文字或光标前的片段，不会收到整库笔记；发送内容也不会进入 Git 仓库。')}
                  </div>
                </>
              )}

              {aiTab === 'prompts' && (
                <>
                  <div className="ai-intro">
                    <Sparkles size={16} strokeWidth={1.75} />
                    <div>
                      {t('写作三条影响润色、续写和待办总结；AI 小应用两条用于站内生成和「应用市场 → 人工导入」的复制说明。点标题展开，改完保存。')}
                    </div>
                  </div>

                  {AI_PROMPT_GROUPS.map((group) => (
                    <div className="ai-prompt-group" key={group.title}>
                      <div className="set-section-title">{t(group.title)}</div>
                      {group.keys.map((key) => {
                        const changed = prompts[key].trim() !== DEFAULT_AI_PROMPTS[key].trim();
                        const expanded = openPrompt === key;
                        return (
                          <div className={cn('ai-prompt-item', expanded && 'open')} key={key}>
                            <button
                              type="button"
                              className="ai-prompt-head"
                              aria-expanded={expanded}
                              onClick={() => setOpenPrompt(expanded ? null : key)}
                            >
                              <span className="ai-prompt-info">
                                <span className="ai-prompt-name">
                                  {t(AI_PROMPT_LABEL[key])}
                                  <span className={cn('ai-prompt-badge', changed && 'is-custom')}>
                                    {changed ? t('已自定义') : t('默认')}
                                  </span>
                                </span>
                                <span className="ai-prompt-desc">{t(AI_PROMPT_DESC[key])}</span>
                              </span>
                              <ChevronDown size={15} strokeWidth={1.75} className="ai-prompt-chevron" />
                            </button>
                            {expanded && (
                              <div className="ai-prompt-body">
                                <textarea
                                  className="input ai-prompt"
                                  rows={key === 'appGenerate' ? 9 : key === 'appImport' ? 7 : key === 'review' ? 4 : 3}
                                  value={prompts[key]}
                                  spellCheck={false}
                                  aria-label={t(AI_PROMPT_LABEL[key])}
                                  onChange={(e) => setPrompts((p) => ({ ...p, [key]: e.target.value }))}
                                />
                                <div className="ai-prompt-actions">
                                  <span className="hint">
                                    {t('{n} 字', { n: prompts[key].trim().length })}
                                    {key === 'appGenerate' || key === 'appImport'
                                      ? t(' · 改动过大可能影响生成效果，可随时恢复默认')
                                      : ''}
                                  </span>
                                  <button
                                    type="button"
                                    className="ext-link"
                                    onClick={() => setPrompts((p) => ({ ...p, [key]: DEFAULT_AI_PROMPTS[key] }))}
                                  >
                                    <RotateCcw size={12} /> {t('恢复默认')}
                                  </button>
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  ))}

                  <div className="ai-foot">
                    <button className="btn btn-primary" onClick={persistPrompts}>
                      {t('保存提示词')}
                    </button>
                    {saveFlash?.key === 'prompts' && (
                      <span className="save-flash">
                        <Check size={13} /> {saveFlash.text}
                      </span>
                    )}
                    <span className="hint">{t('保存后，站内生成和导入弹窗会使用新的提示词。')}</span>
                  </div>
                </>
              )}
            </>
          )}

          {tab === 'sync' && (
            <>
              {connected && cfg ? (
                <>
                  <div className="repo-box">
                    <div className="rb-title">
                      <Check size={14} style={{ color: 'var(--success)' }} /> {t('已连接')}
                    </div>
                    <div className="rb-sub">
                      {providerLabel(cfg.provider)} · {cfg.owner}/{cfg.repo} · {cfg.branch}
                    </div>
                    <div className="rb-sub">
                      {t('同步状态：')}
                      {t(SYNC_LABEL[syncState] || syncState)}
                      {syncMessage ? ` · ${syncMessage}` : ''}
                    </div>
                    <a
                      className="ext-link rb-link"
                      href={`${PROVIDERS[cfg.provider].site}/${cfg.owner}/${cfg.repo}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {t('在 {host} 查看仓库', { host: PROVIDERS[cfg.provider].host })} <ExternalLink size={12} />
                    </a>
                  </div>
                  {needsReclone && (
                    <div className="sync-warn">
                      <RotateCcw size={16} strokeWidth={1.75} />
                      <div>
                        <b>{t('远端历史被压缩过，本机需要重新下载。')}</b>{' '}
                        {t('另一台设备把仓库历史压成了新的起点。为了不把旧的大文件重新推回去，同步已暂停。请先导出备份，再按远端重建本地仓库。')}
                        <div style={{ marginTop: 8 }}>
                          <button
                            className="btn btn-secondary"
                            onClick={() => setResetAsk(true)}
                            disabled={repoBusy !== ''}
                          >
                            <RotateCcw size={14} /> {t('重新下载远端')}
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                  {syncBlockedByWorkflow && (
                    <div className="sync-warn">
                      <ShieldAlert size={16} strokeWidth={1.75} />
                      <div>
                        <b>{t('令牌没有 workflow 权限，云端推送的工作流文件挡住了笔记同步。')}</b>{' '}
                        {t('云端推送是可选功能，不应该拖累笔记同步。补上权限后两者都能继续用：经典令牌勾选 workflow，细粒度令牌把 Workflows 设为读写；暂时不想开云端推送，也可以直接关闭它，马上恢复同步。')}
                        <div className="sync-warn-actions">
                          <a
                            className="btn btn-secondary"
                            href="https://github.com/settings/tokens"
                            target="_blank"
                            rel="noreferrer"
                          >
                            <ExternalLink size={14} /> {t('去补令牌权限')}
                          </a>
                          <button
                            className="btn btn-secondary"
                            onClick={() => void recoverSyncWithoutCloudPush()}
                            disabled={repoBusy !== '' || syncState === 'syncing'}
                          >
                            <Cloud size={14} /> {t('关闭云端推送并恢复同步')}
                          </button>
                        </div>
                        <div className="set-desc" style={{ marginTop: 6 }}>
                          {t('恢复时会丢掉尚未上传的自动提交记录，笔记内容不会变；云端推送会自动关闭，之后可以重新开启。')}
                        </div>
                      </div>
                    </div>
                  )}
                  <div className="set-row">
                    <div>
                      <div className="set-label">{t('手动同步')}</div>
                      <div className="set-desc">
                        {t('会立即提交并推送，不受自动提交间隔限制。平时不需要点，改动会自动在后台同步。')}
                      </div>
                    </div>
                    <button className="btn btn-primary" onClick={() => void syncNow(true)}>
                      <RefreshCw size={14} /> {t('立即同步')}
                    </button>
                  </div>
                  <div className="set-row set-row-stack">
                    <div>
                      <div className="set-label">{t('自动提交')}</div>
                      <div className="set-desc">
                        {t('本机改动随时写盘，但隔一段时间才合并成一次 Git 提交。间隔越长，仓库增长越慢；即使不提交，每篇笔记的本地历史也照常保留，随时能回滚。')}
                      </div>
                    </div>
                    <div className="interval-picker">
                      <div className="segment">
                        {COMMIT_INTERVAL_OPTIONS.map((value) => (
                          <button
                            key={value}
                            className={commitEvery === value && !customCommit ? 'on' : undefined}
                            onClick={() => {
                              setCustomCommit(false);
                              setCommitDraft(String(value));
                              setCommitInterval(value);
                            }}
                          >
                            {t('{n} 分钟', { n: value })}
                          </button>
                        ))}
                        <button
                          className={customCommit ? 'on' : undefined}
                          onClick={() => {
                            setCustomCommit(true);
                            setCommitDraft(String(commitEvery));
                          }}
                        >
                          {t('自定义')}
                        </button>
                      </div>
                      {customCommit && (
                        <div className="num-field">
                          <input
                            className="input"
                            type="number"
                            min={1}
                            max={1440}
                            autoFocus
                            value={commitDraft}
                            onChange={(e) => setCommitDraft(e.target.value)}
                            onBlur={commitEveryCustom}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') e.currentTarget.blur();
                            }}
                            aria-label={t('自定义自动提交间隔（分钟）')}
                          />
                          <span>{t('分钟')}</span>
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="set-row set-row-stack">
                    <div>
                      <div className="set-label">{t('定时检查更新')}</div>
                      <div className="set-desc">
                        {t('隔一段时间检查另一台设备的修改，默认 60 分钟。窗口回到前台时会立即检查一次，所以只在一台电脑上写笔记时不用调得很短。每次检查都是一次拉取，平台会计入请求次数；拉取不会产生新提交，不会让仓库变大。')}
                      </div>
                    </div>
                    <div className="interval-picker">
                      <div className="segment">
                        {(
                          [
                            [5, t('5 分钟')],
                            [15, t('15 分钟')],
                            [60, t('60 分钟')],
                          ] as [number, string][]
                        ).map(([value, label]) => (
                          <button
                            key={value}
                            className={syncInterval === value && !customInterval ? 'on' : undefined}
                            onClick={() => {
                              setCustomInterval(false);
                              setIntervalDraft(String(value));
                              setSyncInterval(value);
                            }}
                          >
                            {label}
                          </button>
                        ))}
                        <button
                          className={customInterval ? 'on' : undefined}
                          onClick={() => {
                            setCustomInterval(true);
                            setIntervalDraft(String(syncInterval || 60));
                          }}
                        >
                          {t('自定义')}
                        </button>
                      </div>
                      {customInterval && (
                        <div className="num-field">
                          <input
                            className="input"
                            type="number"
                            min={1}
                            max={1440}
                            autoFocus
                            value={intervalDraft}
                            onChange={(e) => setIntervalDraft(e.target.value)}
                            onBlur={commitInterval}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') e.currentTarget.blur();
                            }}
                            aria-label={t('自定义同步间隔（分钟）')}
                          />
                          <span>{t('分钟')}</span>
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="repo-box repo-size">
                    <div className="rb-title">
                      <HardDrive size={14} strokeWidth={1.75} /> {t('仓库体积')}
                      <button className="link-btn rb-refresh" onClick={() => void refreshSize()} disabled={sizeLoading}>
                        {sizeLoading ? <Loader2 size={12} className="spin" /> : <RefreshCw size={12} />}
                        {sizeLoading ? t('统计中…') : t('重新统计')}
                      </button>
                    </div>
                    {size ? (
                      <>
                        <div className="size-grid">
                          <div>
                            <span>{t('笔记')}</span>
                            <b>{sizeText(size.notes)}</b>
                          </div>
                          <div>
                            <span>{t('附件')}</span>
                            <b>{sizeText(size.assets)}</b>
                          </div>
                          <div>
                            <span>{t('Git 历史')}</span>
                            <b>{sizeText(size.git)}</b>
                          </div>
                          <div>
                            <span>{t('合计')}</span>
                            <b>{sizeText(size.notes + size.assets + size.git)}</b>
                          </div>
                        </div>
                        <div className="rb-sub">
                          {t('共 {n} 个文件', { n: size.files })} ·{' '}
                          {cfg.provider === 'gitee'
                            ? t('Gitee 免费仓库 500 MB，单文件 50 MB')
                            : cfg.provider === 'gitcode'
                              ? t('GitCode 免费仓库容量以平台为准，单文件约 100 MB')
                              : t('GitHub 建议仓库控制在 1 GB 以内，单文件 100 MB')}
                        </div>
                      </>
                    ) : (
                      <div className="rb-sub">{sizeLoading ? t('正在统计…') : t('暂时读不到体积，点右上角重试')}</div>
                    )}
                  </div>
                  <div className="set-section-title">{t('仓库维护')}</div>
                  <div className="set-row">
                    <div>
                      <div className="set-label">{t('压缩历史')}</div>
                      <div className="set-desc">
                        {t('把当前内容做成一个全新的提交起点并强制推送，清掉旧提交里的图片和附件历史，之后体积约等于当前笔记加附件。其他设备需要重新下载；开始前会自动导出 ZIP 备份。')}
                      </div>
                    </div>
                    <button
                      className="btn btn-secondary"
                      onClick={() => setCompactAsk(true)}
                      disabled={repoBusy !== ''}
                    >
                      {repoBusy === 'compact' ? <Loader2 size={14} className="spin" /> : <Zap size={14} />}
                      {repoBusy === 'compact' ? t('正在压缩…') : t('压缩历史')}
                    </button>
                  </div>
                  <div className="set-row">
                    <div>
                      <div className="set-label">{t('重新下载远端')}</div>
                      <div className="set-desc">
                        {t('丢掉本机的 Git 缓存，按远端最新历史重建，并用它覆盖工作区。本机还没推送的改动会丢失，开始前会自动导出 ZIP 备份。')}
                      </div>
                    </div>
                    <button className="btn btn-secondary" onClick={() => setResetAsk(true)} disabled={repoBusy !== ''}>
                      {repoBusy === 'reset' ? <Loader2 size={14} className="spin" /> : <RotateCcw size={14} />}
                      {repoBusy === 'reset' ? t('正在下载…') : t('重新下载')}
                    </button>
                  </div>
                  <div className="set-row">
                    <div>
                      <div className="set-label">{t('刷新笔记本索引')}</div>
                      <div className="set-desc">
                        {t('新笔记本已经使用唯一目录 ID；这里把旧笔记本的可读目录名也升级成 ID。升级后改名只改映射表，不再搬动文件。笔记内容不受影响。')}
                      </div>
                    </div>
                    <button
                      className="btn btn-secondary"
                      onClick={() => void doMigrateNotebooks()}
                      disabled={repoBusy !== ''}
                    >
                      {repoBusy === 'notebooks' ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
                      {repoBusy === 'notebooks' ? t('正在刷新…') : t('刷新笔记本索引')}
                    </button>
                  </div>
                  <div className="set-row set-row-stack">
                    <div>
                      <div className="set-label">{t('更新授权令牌')}</div>
                      <div className="set-desc">
                        {t('在平台改了令牌权限、或重新生成了令牌后，在这里粘贴保存即可，不用断开重连。保存后会立即重新同步。')}
                      </div>
                    </div>
                    <div className="notify-input-row">
                      <input
                        className="input"
                        type="password"
                        value={newToken}
                        placeholder={
                          cfg?.provider === 'github' ? t('粘贴 GitHub 令牌（ghp_ 开头）') : t('粘贴新的访问令牌')
                        }
                        autoComplete="off"
                        spellCheck={false}
                        aria-label={t('新的授权令牌')}
                        onChange={(e) => setNewToken(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            void updateToken();
                          }
                        }}
                      />
                      <button className="btn btn-secondary" onClick={() => void updateToken()} disabled={updatingToken}>
                        {updatingToken ? <Loader2 size={14} className="spin" /> : <KeyRound size={14} />}
                        {t('保存并同步')}
                      </button>
                    </div>
                  </div>
                  <div className="set-row">
                    <div>
                      <div className="set-label">{t('断开连接')}</div>
                      <div className="set-desc">{t('只解除绑定，本地笔记不会删除；授权信息会一并清除。')}</div>
                    </div>
                    <button className="btn btn-danger" onClick={() => setConfirmDisconnect(true)}>
                      {t('断开')}
                    </button>
                  </div>
                  <div className="token-warn">
                    {t('授权令牌只保存在这台设备上：网页版关闭页面后需要重新填写，桌面版会用系统加密保存。笔记只会同步到私有仓库；如果仓库是公开的，连接前会先问你要不要改为私有，不确认就不会连。')}
                  </div>
                </>
              ) : (
                <>
                  <div className="set-section-title">{t('连接到你的私有仓库')}</div>

                  {!bridge && (
                    <div className="sync-warn">
                      <Info size={16} strokeWidth={1.75} />
                      <div>
                        <b>{t('网页版只能本地写作。')}</b>{' '}
                        {t('浏览器不允许网页直接访问 Git 服务器（跨域限制），所以同步这一步要回到桌面客户端完成。你仍然可以在这里校验令牌、把私有仓库准备好，之后在桌面端登录同一个仓库即可；笔记不会丢失。')}
                      </div>
                    </div>
                  )}

                  <div className="sync-tip">
                    <Cloud size={16} strokeWidth={1.75} />
                    <div>
                      <b>{t('笔记现在还只存在这台电脑上。')}</b>{' '}
                      {t('连上 GitCode 或 Gitee 的免费私有仓库，换电脑、重装系统都能接着写；笔记直接写进你的账号，不经过我们的服务器。')}
                    </div>
                  </div>

                  <div className="field">
                    <div className="field-label">
                      <label>{t('平台')}</label>
                      <a
                        className="ext-link"
                        href={PROVIDERS[provider].site}
                        target="_blank"
                        rel="noreferrer"
                        title={t('在浏览器中打开 {host}', { host: PROVIDERS[provider].host })}
                      >
                        {t('打开 {host}', { host: PROVIDERS[provider].host })} <ExternalLink size={12} />
                      </a>
                    </div>
                    <div className="provider-cards" role="radiogroup" aria-label={t('代码托管平台')}>
                      {PROVIDER_ORDER.map((key) => {
                        const info = PROVIDERS[key];
                        const on = provider === key;
                        return (
                          <button
                            key={key}
                            type="button"
                            role="radio"
                            aria-checked={on}
                            className={cn('provider-card', on && 'on')}
                            onClick={() => {
                              setProvider(key);
                              setOwner('');
                              setStatus(null);
                            }}
                          >
                            <span className="pc-top">
                              <span className="pc-name">{info.label}</span>
                              {key === 'gitcode' && <span className="pc-badge">{t('推荐')}</span>}
                            </span>
                            <span className="pc-host">{info.host}</span>
                            <span className="pc-note">{t(info.note)}</span>
                          </button>
                        );
                      })}
                    </div>
                    <div className="hint">
                      {provider === 'gitee' && t('手机号就能注册，私有仓库免费，国内直连不用代理。')}
                      {provider === 'gitcode' && t('国内的代码托管平台，手机号就能注册，私有仓库免费。')}
                      {provider === 'github' && t('已有 GitHub 账号就用它；国内网络访问 GitHub 可能需要代理。')}
                      {!bridge && provider !== 'github' && t(' 网页版受浏览器跨域限制，连接失败时请改用桌面版。')}
                    </div>
                  </div>

                  <div className="field">
                    <div className="field-label">
                      <label htmlFor="git-token">
                        {t('授权令牌')} <span className="tag-soft">{t('只需填一次')}</span>
                      </label>
                      <a
                        className="ext-link"
                        href={PROVIDERS[provider].tokenUrl}
                        target="_blank"
                        rel="noreferrer"
                        title={t('在浏览器中打开 {name} 令牌页面', { name: PROVIDERS[provider].label })}
                      >
                        {t('打开令牌页面')} <ExternalLink size={12} />
                      </a>
                    </div>
                    <div className="peek-field">
                      <input
                        id="git-token"
                        className="input"
                        type={showToken ? 'text' : 'password'}
                        value={tokenInput}
                        placeholder={
                          provider === 'github'
                            ? t('粘贴 GitHub 令牌（ghp_ 开头）')
                            : provider === 'gitcode'
                              ? t('粘贴 GitCode 访问令牌')
                              : t('粘贴 Gitee 私人令牌')
                        }
                        onChange={(e) => {
                          setTokenInput(e.target.value);
                        }}
                        autoComplete="off"
                        spellCheck={false}
                      />
                      <button
                        type="button"
                        className="peek-btn"
                        onClick={() => setShowToken((v) => !v)}
                        title={showToken ? t('隐藏令牌') : t('显示令牌，核对有没有粘贴完整')}
                        aria-label={showToken ? t('隐藏令牌') : t('显示令牌')}
                      >
                        {showToken ? <EyeOff size={14} strokeWidth={1.75} /> : <Eye size={14} strokeWidth={1.75} />}
                      </button>
                    </div>
                    <div className="hint">
                      {provider === 'github' && (
                        <>
                          {t('获取方式：右上角头像 → Settings → Developer settings → Personal access tokens →')}{' '}
                          <b>Tokens (classic)</b> {t('→ Generate new token (classic)，勾选')} <b>repo</b>{' '}
                          {t('和')} <b>workflow</b>{' '}
                          {t('权限，生成后复制到这里。repo 用于同步笔记，workflow 用于云端推送；暂时不用云端推送的话可以只勾 repo。不要选 Fine-grained tokens。')}
                        </>
                      )}
                      {provider === 'gitee' && (
                        <>
                          {t('获取方式：右上角头像 → 设置 → 安全设置 → 私人令牌 → 生成新令牌，勾选')} <b>projects</b>{' '}
                          {t('（项目）和')} <b>user_info</b> {t('（读取用户信息），生成后复制到这里。')}
                        </>
                      )}
                      {provider === 'gitcode' && (
                        <>
                          {t('获取方式：右上角头像 → 设置 → 访问令牌 → 新建访问令牌，勾选仓库读写权限，生成后复制到这里；令牌只显示一次，记得先保存。')}
                        </>
                      )}
                    </div>
                  </div>

                  <div className="field">
                    <label>
                      {t('仓库名称')} <span className="tag-soft">{t('默认即可')}</span>
                    </label>
                    <input
                      ref={repoRef}
                      className="input"
                      value={repoName}
                      placeholder="my-notes"
                      onChange={(e) => {
                        setRepoName(e.target.value);
                      }}
                    />
                    <div className="hint">
                      {t('保持 my-notes 就行。点底部的校验按钮时如果这个仓库还不存在，会弹窗问你要不要创建，确认后自动建好，免费。')}
                    </div>
                  </div>

                  <div className="field">
                    <label>
                      {t('分支')} <span className="tag-soft">{t('一般不用改')}</span>
                    </label>
                    <input className="input" value={branch} onChange={(e) => setBranch(e.target.value)} />
                    <div className="hint">
                      {t('保持 main 即可，校验后也会自动识别仓库的默认分支；只有你的仓库用 master 之类的名字时才需要改。')}
                    </div>
                  </div>

                  <div className="token-warn" style={{ marginTop: 16 }}>
                    {t('安全边界：数据只写入你自己的私有仓库；公开仓库会先提示改为私有，不确认就不连接。令牌只存在这台设备，权限越小越好。')}
                  </div>
                </>
              )}
            </>
          )}

          {tab === 'keys' && (
            <>
              <div className="set-section-title">{t('自定义快捷键')}</div>
              <div className="keys-hint">
                {t('点右侧组合键后按下新的按键即可。按 Esc 取消，按 Backspace 恢复这一项；组合冲突时不会保存。')}
              </div>
              <div className="keys-list">
                {SHORTCUT_DEFS.map((def) => {
                  const combo = bindings[def.id] || def.def;
                  const changed = combo !== def.def;
                  const active = recording === def.id;
                  return (
                    <div className="key-row" key={def.id}>
                      <span className="key-label">{t(def.label)}</span>
                      <span className="key-right">
                        {changed && (
                          <button className="icon-btn" title={t('恢复默认')} onClick={() => resetOne(def.id)}>
                            <RotateCcw size={14} />
                          </button>
                        )}
                        <button
                          className={cn('kbd key-cap', active && 'recording')}
                          onClick={() => {
                            setRecording(active ? null : def.id);
                            setConflict('');
                          }}
                          title={active ? t('按 Esc 取消') : t('点击后按下新组合')}
                        >
                          {active ? t('按下新组合…') : combo}
                        </button>
                      </span>
                    </div>
                  );
                })}
                <div className="key-row">
                  <span className="key-label">{t('关闭弹层')}</span>
                  <span className="key-right">
                    <span className="kbd key-cap static">Esc</span>
                  </span>
                </div>
              </div>
              {conflict && <div className="key-conflict">{conflict}</div>}
              <div className="keys-foot">
                <span>{t('加粗、任务清单、查找等编辑区快捷键保持不变。')}</span>
                <button className="btn btn-secondary" onClick={resetAll}>
                  {t('恢复全部默认')}
                </button>
              </div>
            </>
          )}

          {tab === 'about' && (
            <>
              <div className="repo-box">
                <div className="rb-title">
                  <Cloud size={14} /> {t('萤光笔记 Glimnote {version}', { version: appVersion })}
                </div>
                <div className="rb-sub">{t('萤火微光，记录细碎微小的灵感')}</div>
                <div className="rb-sub">{t('本地优先 · Markdown · Git 同步 · Windows 与网页')}</div>
              </div>
              {bridge && (
                <div className="set-row set-update-row">
                  <div>
                    <div className="set-label">{t('检查更新')}</div>
                    <div className="set-desc">
                      {update
                        ? update.message
                        : t('安装版会从 GitCode Releases 检查新版本；下载完成后可以重启安装，网页版刷新页面即是最新。')}
                    </div>
                    {/* 检查到预发版本时标出来：一眼能看出主进程有没有正确识别 Release 的预发标记 */}
                    {update?.prerelease && (
                      <div className="set-update-pre">
                        <span className="tag-soft">{t('预发版本')}</span>
                        {update.sourceTag ? <span className="set-update-tag">{update.sourceTag}</span> : null}
                      </div>
                    )}
                    {updateProgress && updateProgress.state === 'downloading' && (
                      <div className="set-update-progress">
                        <div
                          className="set-update-bar"
                          role="progressbar"
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-valuenow={updateProgress.percent || 0}
                        >
                          <i style={{ width: `${updateProgress.percent || 0}%` }} />
                        </div>
                        <span>{updateProgress.percent || 0}%</span>
                      </div>
                    )}
                    {updateProgress && updateProgress.state === 'downloaded' && (
                      <div className="set-update-hint">
                        {installCountdown > 0
                          ? t('{n} 秒后自动重启安装；需要先保存并同步笔记。', { n: installCountdown })
                          : t('更新已下载，重启后会静默安装，笔记会先自动保存并同步。')}
                      </div>
                    )}
                    {(update?.status === 'available' || updateProgress) && (
                      <div className="set-update-av">
                        {t('安装时如果 360 安全卫士 / 电脑管家提示「修改文件」，请选择「允许」，否则更新会中断。建议更新期间暂时退出这类软件。')}
                      </div>
                    )}
                  </div>
                  <div className="set-update-actions">
                    {(update?.status === 'error' ||
                      update?.status === 'manual' ||
                      update?.status === 'unavailable') && (
                      <button
                        className="btn btn-secondary"
                        onClick={() =>
                          void bridge.openExternal?.(
                            update?.url || 'https://gitcode.com/jewey/glimnote/releases',
                          )
                        }
                      >
                        {t('打开发布页')}
                      </button>
                    )}
                    {(update?.status === 'available' || update?.status === 'manual') && update.version && (
                      <button
                        className="btn btn-secondary"
                        disabled={downloading}
                        onClick={() => void runIgnoreUpdate()}
                        title={t('之后只有比这个版本更新的版本才会提醒')}
                      >
                        {t('忽略此版本')}
                      </button>
                    )}
                    {update?.status === 'available' && !(updateProgress && updateProgress.state === 'downloaded') && (
                      <button
                        className="btn btn-primary"
                        disabled={downloading}
                        onClick={() => void runDownloadUpdate()}
                      >
                        {downloading ? <Loader2 size={14} className="spin" /> : <Download size={14} />} {t('下载更新')}
                      </button>
                    )}
                    {updateProgress && updateProgress.state === 'downloaded' && (
                      <>
                        {installCountdown > 0 && (
                          <button className="btn btn-secondary" onClick={() => setInstallCountdown(0)}>
                            {t('取消自动安装')}
                          </button>
                        )}
                        <button className="btn btn-primary" onClick={() => void runInstallUpdate()}>
                          <RotateCcw size={14} /> {t('重启并安装')}
                        </button>
                      </>
                    )}
                    <button
                      className="btn btn-secondary"
                      disabled={checking || downloading}
                      onClick={() => void runCheckUpdate()}
                    >
                      {checking ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />} {t('检查更新')}
                    </button>
                  </div>
                </div>
              )}

              <div className="set-row">
                <div>
                  <div className="set-label">{t('日志文件')}</div>
                  <div className="set-desc">
                    {bridge
                      ? t('桌面版把启动、同步、连接和界面报错按天写进本机文件，最多留 7 天。遇到问题时点「打开文件夹」，把当天那份 .log 发过来就行。')
                      : t('网页版没有本地文件，遇到问题请点「导出日志」把运行日志下载下来。')}
                  </div>
                  {bridge && logFile ? (
                    <div className="set-path" title={logFile}>
                      {logFile}
                    </div>
                  ) : null}
                </div>
                {bridge ? (
                  <button className="btn btn-secondary" onClick={() => void openLogs()}>
                    <FolderOpen size={14} /> {t('打开文件夹')}
                  </button>
                ) : null}
              </div>

              <div className="set-row">
                <div>
                  <div className="set-label">{t('诊断日志')}</div>
                  <div className="set-desc">
                    {t('导出运行环境、同步状态与最近 300 条同步 / 连接日志。Token、仓库地址等敏感信息会自动打码，不含笔记正文。')}
                  </div>
                </div>
                <button className="btn btn-secondary" onClick={exportDiagnostics}>
                  <FileDown size={14} /> {t('导出日志')}
                </button>
              </div>

              <div className="token-warn" style={{ marginTop: 18 }}>
                {t('隐私说明：应用不收集任何使用数据，也不会把笔记发送到除你自己仓库以外的任何地方。搜索索引只存在内存中。')}
              </div>
            </>
          )}
        </div>

        {/* 通知页的保存也固定在底部，和同步页一样，表单再长也不用滚到底 */}
        {tab === 'notify' && (
          <div className="settings-foot">
            <div className="sync-buttons">
              <button
                className="btn btn-primary"
                onClick={() => window.dispatchEvent(new Event('glimnote:notify-save'))}
              >
                {t('保存')}
              </button>
              {notifyHint && (
                <span className={cn('save-flash', !notifyHint.ok && 'bad')}>
                  {notifyHint.ok ? <Check size={13} /> : <X size={13} />}
                  {notifyHint.text}
                </span>
              )}
            </div>
          </div>
        )}

        {/* 同步页未连接时把主操作固定在弹窗底部：表单再长也不用滚到底才能校验 */}
        {tab === 'sync' && !connected && (
          <div className="settings-foot">
            {status && (
              <div className={cn('status-line', status.kind === 'ok' && 'ok', status.kind === 'bad' && 'bad')}>
                {status.kind === 'ok' ? (
                  <Check size={14} />
                ) : status.kind === 'info' ? (
                  <Info size={14} />
                ) : (
                  <X size={14} />
                )}
                <div className="status-body">
                  <div>{status.text}</div>
                  {status.action && (
                    <button
                      type="button"
                      className="status-action"
                      onClick={() => {
                        void openExternal(status.action!.url).catch((err) =>
                          toast((err as Error)?.message || t('没能打开浏览器'), 'error'),
                        );
                      }}
                    >
                      <ExternalLink size={12} />
                      {status.action.label}
                    </button>
                  )}
                  {status.detail && (
                    <button
                      type="button"
                      className="status-detail"
                      title={t('点击复制这句技术细节')}
                      onClick={() => {
                        void navigator.clipboard.writeText(status.detail || '');
                        toast(t('技术细节已复制'), 'success');
                      }}
                    >
                      {status.detail}
                    </button>
                  )}
                </div>
              </div>
            )}
            <div className="sync-buttons">
              <button
                className="btn btn-primary"
                onClick={() => void verify()}
                disabled={Boolean(busy)}
                title={bridge ? undefined : t('网页版只能校验令牌，连接同步需要桌面客户端')}
              >
                {busy === 'verify' || busy === 'connect' ? <Loader2 size={14} className="spin" /> : <Cloud size={14} />}
                {bridge ? t('校验并连接') : t('校验令牌')}
              </button>
            </div>
          </div>
        )}

        {createPrompt && (
          <CreateRepoPrompt
            provider={provider}
            owner={owner}
            repo={repoName.trim()}
            busy={busy === 'create' ? 'create' : busy === 'connect' ? 'connect' : ''}
            error={createErr}
            onCancel={() => {
              setCreatePrompt(false);
              setStatus({
                kind: 'info',
                text: t('没有创建仓库。想换名字的话，改好仓库名称后再点一次底部的校验按钮即可。'),
              });
              requestAnimationFrame(() => repoRef.current?.focus());
            }}
            onCreate={() => {
              setCreateErr('');
              void doConnect(true, { onError: setCreateErr });
            }}
          />
        )}

        <WorkspaceDialog
          open={wsOpen}
          items={workspaces}
          currentId={wsInfo?.id || ''}
          onClose={() => setWsOpen(false)}
          onSwitch={switchWorkspace}
          onCreate={createWorkspace}
          onOpenFolder={(id) => {
            void bridge?.workspaceOpen?.(id);
          }}
          onRefresh={() => void loadWorkspaces()}
        />

        {checkoutConflict && (
          <CheckoutConflictDialog
            busy={overwritingLocal}
            onClose={() => {
              if (!overwritingLocal) setCheckoutConflict(null);
            }}
            onForce={() => void forceOverwriteLocal()}
            onManual={openConflictFolder}
          />
        )}

        {mergeConflict && (
          <MergeConflictDialog
            busyMode={mergeBusy}
            onClose={() => {
              if (!mergeBusy) setMergeConflict(null);
            }}
            onKeepLocal={() => void resolveMergeConflict('keep-local')}
            onOverwrite={() => void resolveMergeConflict('overwrite')}
            onManual={() => {
              if (mergeBusy) return;
              setMergeConflict(null);
              openNotesFolderForConflict();
            }}
          />
        )}

        {worktreeReset && (
          <WorktreeResetDialog
            message={worktreeReset.message}
            busy={Boolean(worktreeBusy)}
            busyMode={worktreeBusy}
            onClose={() => {
              if (!worktreeBusy) setWorktreeReset(null);
            }}
            onRestore={() => resolveWorktreeReset('restore')}
            onKeep={() => resolveWorktreeReset('keep')}
          />
        )}

        {firstConnect && (
          <FirstConnectDialog
            busy={Boolean(firstBusy)}
            busyMode={firstBusy}
            onClose={() => {
              if (!firstBusy) setFirstConnect(null);
            }}
            onMerge={() => resolveFirstConnect('merge')}
            onAdopt={() => resolveFirstConnect('adopt-remote')}
          />
        )}

        {wsAsk && (
          <ConfirmDialog
            title={wsAsk.kind === 'duplicate' ? t('这个仓库已经有工作区') : t('这个仓库需要单独的工作区')}
            desc={
              wsAsk.kind === 'duplicate'
                ? t('仓库 {name} · {who}/{repo} 已经由工作区「{ws}」使用，不会在同一台电脑上维护两份同步副本。点「切换过去」会把这次填写的授权令牌写进那个工作区并重启应用，重启后直接连接，不用再填一次。', {
                    name: providerLabel(wsAsk.provider),
                    who: wsAsk.who,
                    repo: wsAsk.repo,
                    ws: wsAsk.name || '',
                  })
                : t('当前工作区「{ws}」对应的是另一份笔记。只有同一平台、同一账号、同一仓库才算同一份日志；这次会为 {name} 的 {who}/{repo} 新建一个独立工作区和独立目录，写好同步配置与令牌后切换过去，应用重启会自动连接。当前工作区的笔记不会改动。', {
                    ws: wsAsk.name || '',
                    name: providerLabel(wsAsk.provider),
                    who: wsAsk.who,
                    repo: wsAsk.repo,
                  })
            }
            confirmLabel={
              wsBusy
                ? wsAsk.kind === 'duplicate'
                  ? t('正在切换…')
                  : t('正在准备独立工作区…')
                : wsAsk.kind === 'duplicate'
                  ? t('切换过去')
                  : t('新建独立工作区并切换')
            }
            cancelLabel={t('取消')}
            onCancel={() => {
              if (!wsBusy) setWsAsk(null);
            }}
            onConfirm={confirmWorkspaceAsk}
          />
        )}

        {publicAsk && (
          <ConfirmDialog
            title={makingPrivate ? t('正在改为私有…') : t('这个仓库是公开的')}
            desc={t('{who}/{repo} 现在任何人都能看到里面的笔记。点「改为私有并连接」会先把仓库改成私有，再继续同步；取消则不会连接。', {
              who: publicAsk.who,
              repo: publicAsk.repo,
            })}
            confirmLabel={makingPrivate ? t('请稍候…') : t('改为私有并连接')}
            cancelLabel={t('取消，不连接')}
            danger
            onCancel={() => {
              if (makingPrivate) return;
              const target = publicAsk;
              setPublicAsk(null);
              setStatus({
                kind: 'bad',
                text: t('已取消：公开仓库不会被连接。也可以现在去平台把它改为私有，改完回来再点一次底部的校验按钮即可。'),
                action: {
                  label: t('打开仓库设置页改为私有'),
                  url: repoSettingsUrl(provider, target.who, target.repo),
                },
              });
            }}
            onConfirm={() => void makePrivateAndConnect()}
          />
        )}

        {repoPick && (
          <ConfirmDialog
            title={moving ? t('正在迁移笔记…') : t('迁移笔记到新位置？')}
            desc={t('将把当前工作区的笔记整体复制到 {path}，校验完整后删除旧文件夹；其它工作区的笔记不受影响。迁移期间请别关闭应用，完成后会自动重新载入。', { path: repoPick })}
            confirmLabel={moving ? t('请稍候…') : t('开始迁移')}
            onCancel={() => {
              if (!moving) setRepoPick(null);
              }}
            onConfirm={() => void moveRepo()}
          />
        )}

        {compactAsk && (
          <ConfirmDialog
            title={repoBusy === 'compact' ? t('正在压缩历史…') : t('压缩仓库历史？')}
            desc={t('会把当前内容压成新的起点并强制推送到远端，旧提交（包括图片、附件的旧版本）将从仓库删除，体积通常能明显下降。其他设备之后需要重新下载。开始前会自动导出一份 ZIP 备份。')}
            confirmLabel={t('先备份并压缩')}
            danger
            onCancel={() => setCompactAsk(false)}
            onConfirm={() => void doCompact()}
          />
        )}

        {resetAsk && (
          <ConfirmDialog
            title={repoBusy === 'reset' ? t('正在重新下载…') : t('重新下载远端仓库？')}
            desc={t('会重新下载远端历史，并用它覆盖本地工作区；本机还没推送的改动会丢失。开始前会自动导出一份 ZIP 备份。')}
            confirmLabel={t('先备份并重新下载')}
            danger
            onCancel={() => setResetAsk(false)}
            onConfirm={() => void doReset()}
          />
        )}

        {confirmDisconnect && (
          <ConfirmDialog
            title={t('断开云端连接？')}
            desc={t('本地笔记会保留；重新连接后可继续同步。')}
            confirmLabel={t('断开')}
            danger
            onCancel={() => setConfirmDisconnect(false)}
            onConfirm={() => {
              setConfirmDisconnect(false);
              disconnectGit();
              setOwner('');
              setTokenInput('');
              setStatus(null);
              toast(t('已断开云端连接'), 'info');
            }}
          />
        )}
      {qiniuHelpOpen && (
        <QiniuHelpDialog configured={qiniuReady} onClose={() => setQiniuHelpOpen(false)} />
      )}
      </div>
    </div>
  );
}
