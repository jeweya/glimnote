import { useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent as ReactDragEvent } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertTriangle,
  Check,
  Copy,
  FileArchive,
  FileUp,
  LayoutGrid,
  Loader2,
  Plus,
  ShieldCheck,
  Sparkles,
  Upload,
  X,
} from 'lucide-react';
import { ImportError, importAppFiles, type ImportedApp } from '../lib/importApp';
import { withCsp, type AppMeta } from '../lib/apps';
import { useHome } from '../store/home';
import {
  MARKET_APPS,
  MARKET_CATEGORIES,
  buildMarketApp,
  marketApps,
  type MarketApp,
  type MarketCategory,
} from '../apps/market/catalog';
import { loadAiPrompts } from '../lib/ai';
import { APP_GROUP_NAME } from '../lib/home';
import { useApp } from '../store/app';
import { cn } from '../lib/utils';
import { iconFor } from './homeIcons';
import { t, useT } from '../lib/i18n';

interface Props {
  onClose: () => void;
  /** 导入文件：交给生成器预览，确认后再保存 */
  onImported: (app: ImportedApp) => void;
  /** 应用市场：已经直接落库，这里只负责关掉弹窗并打开刚装好的应用 */
  onOpenInstalled: (app: AppMeta) => void;
  /** 打开时停在哪个页签；删掉 AI 小应用入口后跳回来会直接落到「AI 生成」 */
  initialTab?: 'market' | 'ai' | 'file';
}

const ACCEPT = '.html,.htm,.zip';

/** 把技术检查结果翻成「该怎么改」，普通用户不需要知道 CSP、宿主这些词 */
const ISSUE_HINTS: { re: RegExp; hint: string }[] = [
  { re: /本地存储|Cookie/, hint: t('去掉 localStorage / Cookie，状态用 window.glimnote.data 保存。') },
  { re: /宿主窗口/, hint: t('去掉 window.parent / top，应用只能在自己的页面里运行。') },
  { re: /嵌套页面|插件/, hint: t('去掉 iframe / object / embed，把内容直接画在页面里。') },
  { re: /javascript:/, hint: t('把 javascript: 链接改成普通按钮点击事件。') },
  { re: /<base>|base 标签/i, hint: t('去掉 <base> 标签，用相对路径即可。') },
  { re: /自动跳转/, hint: t('去掉 meta refresh，改成页面里的按钮切换。') },
  { re: /HTML 文档结构/, hint: t('补上 <!doctype html> 和 <html>，或让 AI 重新输出完整页面。') },
  { re: /体积|200KB/, hint: t('让 AI 精简代码，或压缩图片后再试。') },
];

/**
 * 应用卡片：市场模板与「AI 生成」共用同一套外观。
 * 右边的勾只表示「首页还有这个入口」；应用装过但入口被删了，仍然显示 +，
 * 点一下把入口加回来，不会重复装一份应用。
 */
function AppCard(props: {
  name: string;
  description: string;
  icon: string;
  color: string;
  /** 应用本体还在本机 */
  exists: boolean;
  /** 首页还有指向它的快捷入口 */
  linked: boolean;
  busy: boolean;
  disabled: boolean;
  onOpen: () => void;
  onAdd: () => void;
  openTitle: string;
  addTitle: string;
}) {
  const tr = useT();
  const Icon = iconFor(props.icon, 'sparkles');
  return (
    <div
      role="button"
      tabIndex={0}
      aria-disabled={props.disabled}
      className={cn('market-card', props.busy && 'is-busy', (props.linked || props.exists) && 'is-installed')}
      title={props.openTitle}
      onClick={() => {
        if (!props.disabled) props.onOpen();
      }}
      onKeyDown={(e) => {
        // 键盘落在 + 上时交给 + 自己处理，别同时打开卡片
        if (props.disabled || (e.target as HTMLElement).closest('button')) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          props.onOpen();
        }
      }}
    >
      <span className={cn('market-icon', 'hc-' + props.color)}>
        <Icon size={15} />
      </span>
      <span className="market-body">
        <span className="market-name">
          {props.name}
          {props.linked ? (
            <span className="market-badge">{tr('已添加')}</span>
          ) : props.exists ? (
            <span className="market-badge is-installed">{tr('已安装')}</span>
          ) : null}
        </span>
        <span className="market-desc">{props.description}</span>
      </span>
      <button
        type="button"
        className={cn('market-add', props.linked && 'is-installed')}
        title={props.linked ? tr('{name}已经在首页，不用重复添加', { name: props.name }) : props.addTitle}
        aria-label={props.linked ? tr('{name}已经在首页', { name: props.name }) : props.addTitle}
        disabled={props.disabled}
        onClick={(e) => {
          e.stopPropagation();
          props.onAdd();
        }}
      >
        {props.busy ? <Loader2 size={14} className="spin" /> : props.linked ? <Check size={14} /> : <Plus size={14} />}
      </button>
    </div>
  );
}

/**
 * 导入外部 AI 生成的小应用：选文件 → 自动合并 & 安全检查 → 预览前确认名称。
 * 不直接写库，先载入右侧预览，用户试运行后点「保存到首页」才落盘。
 */
export function ImportAppDialog({ onClose, onImported, onOpenInstalled, initialTab = 'market' }: Props) {
  const toast = useApp((s) => s.toast);
  const tr = useT();
  // 市场里的模板只装一份：按 app.json 里的 template id 认，旧数据退回名称 + 说明
  const installedApps = useHome((s) => s.apps);
  const entries = useHome((s) => s.entries);
  const groups = useHome((s) => s.groups);
  const installedFor = (app: MarketApp) =>
    installedApps.find((a) => a.template === app.id) ||
    installedApps.find((a) => !a.template && a.name === app.name && a.description === app.description);

  /** 哪些应用在首页还有入口（入口文件存在，而且真的被某个分组引用） */
  const linkedAppIds = useMemo(() => {
    const ids = new Set<string>();
    for (const entry of Object.values(entries)) {
      if (entry.type !== 'app' || !entry.target) continue;
      if (groups.some((group) => group.entries.includes(entry.id))) ids.add(entry.target);
    }
    return ids;
  }, [entries, groups]);

  /** AI 现场生成的应用：删掉应用后自然从列表里消失 */
  const aiApps = useMemo(() => installedApps.filter((app) => app.source === 'ai'), [installedApps]);
  const fileRef = useRef<HTMLInputElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);
  const copyTimer = useRef<number | null>(null);

  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const [error, setError] = useState('');
  const [issues, setIssues] = useState<string[]>([]);
  const [result, setResult] = useState<ImportedApp | null>(null);
  const [draftName, setDraftName] = useState('');
  const [draftDesc, setDraftDesc] = useState('');
  const [copied, setCopied] = useState(false);
  // 应用市场默认打开：现成的通常比现做一个更快
  const [tab, setTab] = useState<'market' | 'ai' | 'file'>(initialTab);
  const [category, setCategory] = useState<MarketCategory | 'all'>('all');
  const [installing, setInstalling] = useState('');
  const [marketError, setMarketError] = useState('');
  /** 刚添加好的预置应用：先弹一层提示装到哪了，背后的市场不拿走 */
  const [installed, setInstalled] = useState<AppMeta | null>(null);
  /** 点卡片先看预览；只有点右边的 + 才直接添加 */
  const [preview, setPreview] = useState<MarketApp | null>(null);
  const [previewHtml, setPreviewHtml] = useState('');
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState('');
  /** 连续点不同卡片时丢掉旧模板的加载结果 */
  const previewReq = useRef(0);
  // 导入提示词允许在设置里改；每次打开弹窗读一次即可
  const [importPrompt] = useState(() => loadAiPrompts().appImport);

  useEffect(() => {
    if (tab === 'file') dropRef.current?.focus();
  }, [tab]);

  useEffect(() => {
    return () => {
      if (copyTimer.current) window.clearTimeout(copyTimer.current);
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      // Esc 先关最上面一层：预览 → 添加成功 → 整个市场
      if (preview) {
        previewReq.current += 1;
        setPreview(null);
        setPreviewHtml('');
        setPreviewError('');
        setPreviewLoading(false);
        return;
      }
      if (installed) {
        setInstalled(null);
        return;
      }
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose, preview, installed]);

  /** 选错文件时只提示一句，不进入合并流程 */
  const rejectFiles = (message: string) => {
    setBusy(false);
    setResult(null);
    setIssues([]);
    setError(message);
  };

  const accept = (files: File[]) => {
    if (!files.length) return;
    if (files.length > 1) {
      rejectFiles(tr('一次只能导入一个文件：选一个 HTML，或者一个 zip。'));
      return;
    }
    setBusy(true);
    setError('');
    setIssues([]);
    setResult(null);
    importAppFiles(files)
      .then((app) => {
        setResult(app);
        setDraftName(app.name);
        setDraftDesc(app.description);
      })
      .catch((e: unknown) => {
        if (e instanceof ImportError) {
          setError(e.message);
          setIssues(e.issues);
        } else {
          setError((e as Error)?.message || tr('这个文件读不出来，换一个再试。'));
        }
      })
      .finally(() => setBusy(false));
  };

  const onDrop = (event: ReactDragEvent) => {
    event.preventDefault();
    setDrag(false);
    if (busy) return;
    // 文件夹拖进来时 files 可能为空或只剩几个散文件，先按目录项拦下
    const entries = Array.from(event.dataTransfer.items || []).map((item) =>
      (item as DataTransferItem & { webkitGetAsEntry?: () => FileSystemEntry | null }).webkitGetAsEntry?.(),
    );
    if (entries.some((entry) => entry?.isDirectory)) {
      rejectFiles(tr('暂不支持导入文件夹，请先把整个文件夹压成一个 zip 再拖进来。'));
      return;
    }
    const files = Array.from(event.dataTransfer.files || []);
    if (files.length > 1) {
      rejectFiles(tr('一次只能导入一个文件：一个 HTML，或一个 zip。'));
      return;
    }
    accept(files);
  };

  const reset = () => {
    setResult(null);
    setError('');
    setIssues([]);
    setDraftName('');
    setDraftDesc('');
    setBusy(false);
  };

  const pickAgain = () => {
    reset();
    window.setTimeout(() => fileRef.current?.click(), 30);
  };

  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(importPrompt);
      setCopied(true);
      if (copyTimer.current) window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopied(false), 2200);
      toast(tr('提示词已复制，直接粘贴给 AI 就行'), 'success');
    } catch {
      toast(tr('复制失败，请手动选中提示词复制'), 'error');
    }
  };

  const confirm = () => {
    if (!result) return;
    const name = draftName.trim().slice(0, 20) || result.name;
    onImported({ ...result, name, description: draftDesc.trim().slice(0, 160) });
  };

  const issueRows = issues.map((issue) => ({
    issue,
    hint: ISSUE_HINTS.find((item) => item.re.test(issue))?.hint || '',
  }));

  /**
   * 点卡片先看预览：模板读出来直接放进沙箱 iframe，和真正装好后的运行环境一致。
   * 预览期间不接数据桥，应用只用内存里的示例数据，不会提前写进仓库。
   */
  const openPreview = (app: MarketApp) => {
    setPreview(app);
    setPreviewHtml('');
    setPreviewError('');
    setMarketError('');
    setPreviewLoading(true);
    const req = previewReq.current + 1;
    previewReq.current = req;
    buildMarketApp(app)
      .then((built) => {
        if (previewReq.current === req) setPreviewHtml(built.html);
      })
      .catch((e: unknown) => {
        if (previewReq.current === req) {
          setPreviewError((e as Error)?.message || tr('这个模板暂时打不开预览。'));
        }
      })
      .finally(() => {
        if (previewReq.current === req) setPreviewLoading(false);
      });
  };

  const closePreview = () => {
    previewReq.current += 1;
    setPreview(null);
    setPreviewHtml('');
    setPreviewError('');
    setPreviewLoading(false);
  };

  /**
   * 应用本体还在、只是首页入口被删了：把入口加回去，不重新安装一份应用。
   * 分组优先放「AI 小应用」，没有就放第一个分组。
   */
  const addHomeEntry = async (meta: AppMeta) => {
    if (linkedAppIds.has(meta.id)) {
      toast(tr('「{name}」已经在首页了', { name: meta.name }), 'info', {
        label: tr('打开'),
        run: () => onOpenInstalled(meta),
      });
      return;
    }
    const state = useHome.getState();
    const group = state.groups.find((g) => g.name === APP_GROUP_NAME) || state.groups[0];
    if (!group) {
      toast(tr('首页还没有分组，先新建一个分组再添加'), 'error');
      return;
    }
    setInstalling(meta.id);
    setMarketError('');
    try {
      await state.addEntry(group.id, { type: 'app', target: meta.id });
      toast(tr('「{name}」已加回首页', { name: meta.name }), 'success');
    } catch (e: unknown) {
      toast((e as Error)?.message || tr('入口没加上，请稍后再试'), 'error');
    } finally {
      setInstalling('');
    }
  };

  /**
   * 应用市场安装：不再走生成器预览，模板本来就已经通过同一套安全检查。
   * 保存成功后叠一层提示告诉用户装到了哪里，背后的市场仍然看得到，
   * 想马上试就点「打开试用」。
   */
  const install = async (app: MarketApp) => {
    if (installing) return;
    const existing = installedFor(app);
    if (existing) {
      // 应用已经装过：入口还在就提示一句；入口被删了就顺手加回去
      if (!linkedAppIds.has(existing.id)) {
        await addHomeEntry(existing);
        return;
      }
      toast(tr('「{name}」已经安装过了，不用重复添加', { name: existing.name }), 'info', {
        label: tr('打开'),
        run: () => onOpenInstalled(existing),
      });
      return;
    }
    setInstalling(app.id);
    setMarketError('');
    try {
      const built = await buildMarketApp(app);
      const meta = await useHome.getState().saveApp({
        name: built.name,
        description: built.description,
        icon: built.icon,
        color: app.color,
        html: built.html,
        template: app.id,
        source: 'market',
      });
      // 从预览里添加时把预览收掉，成功提示盖在市场上面，市场本身不消失
      closePreview();
      setInstalled(meta);
      toast(tr('「{name}」已添加到首页', { name: meta.name }), 'success');
    } catch (e: unknown) {
      setMarketError((e as Error)?.message || tr('这个模板装不上，稍后再试。'));
    } finally {
      setInstalling('');
    }
  };

  const shownApps = marketApps(category);
  const previewInstalled = preview ? installedFor(preview) : null;
  const previewLinked = Boolean(previewInstalled && linkedAppIds.has(previewInstalled.id));
  const InstalledIcon = iconFor(installed?.icon, 'sparkles');
  const PreviewIcon = iconFor(preview?.icon, 'sparkles');

  return createPortal(
    <div className="app-import-overlay" role="dialog" aria-modal="true" aria-label={tr('应用市场')}>
      <div className={cn('app-import', 'is-market')}>
        <header className="app-import-head">
          <div>
            <div className="app-import-title">{tr('应用市场')}</div>
            <div className="app-import-sub">
              {tab === 'market'
                ? tr('挑现成的小应用装上；也可以切到「人工导入」，放自己的文件')
                : tab === 'ai'
                  ? tr('AI 生成 · 已经保存的小应用都在这里；点卡片打开，点 + 把删掉的入口加回首页')
                  : tr('人工导入 · 拖入一个 AI 生成的 HTML 或 zip，合并检查后再决定是否保存')}
            </div>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label={tr('关闭')}>
            <X size={16} />
          </button>
        </header>

        <nav className="app-import-tabs" role="tablist" aria-label={tr('应用市场分类')}>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'market'}
            className={cn('ait-tab', tab === 'market' && 'is-on')}
            onClick={() => setTab('market')}
          >
            <LayoutGrid size={13} /> {tr('应用市场')}
            <span className="ait-count">{MARKET_APPS.length}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'ai'}
            className={cn('ait-tab', tab === 'ai' && 'is-on')}
            onClick={() => setTab('ai')}
          >
            <Sparkles size={13} /> {tr('AI 生成')}
            <span className="ait-count">{aiApps.length}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'file'}
            className={cn('ait-tab', tab === 'file' && 'is-on')}
            onClick={() => setTab('file')}
          >
            <FileUp size={13} /> {tr('人工导入')}
          </button>
        </nav>

        <div className="app-import-body">
          {tab === 'market' && (
            <>
              <div className="market-bar" role="group" aria-label={tr('分类')}>
                <button
                  type="button"
                  className={cn('market-chip', category === 'all' && 'is-on')}
                  aria-pressed={category === 'all'}
                  onClick={() => setCategory('all')}
                >
                  {tr('全部')}
                </button>
                {MARKET_CATEGORIES.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    className={cn('market-chip', category === c.id && 'is-on')}
                    aria-pressed={category === c.id}
                    onClick={() => setCategory(c.id)}
                  >
                    {c.name}
                  </button>
                ))}
              </div>

              <div className="market-grid">
                {shownApps.map((app) => {
                  const installedHere = installedFor(app);
                  const linkedHere = Boolean(installedHere && linkedAppIds.has(installedHere.id));
                  return (
                    // 卡片本身打开预览；只有右边的 + 才是「直接添加」，两个动作分开
                    <AppCard
                      key={app.id}
                      name={app.name}
                      description={app.description}
                      icon={app.icon}
                      color={app.color}
                      exists={Boolean(installedHere)}
                      linked={linkedHere}
                      busy={installing === app.id || (installedHere ? installing === installedHere.id : false)}
                      disabled={Boolean(installing)}
                      onOpen={() => openPreview(app)}
                      onAdd={() => void install(app)}
                      openTitle={tr('预览 {name}', { name: app.name })}
                      addTitle={
                        installedHere
                          ? tr('「{name}」应用还在，只是入口被删了；点 + 加回首页', { name: app.name })
                          : tr('添加到首页：{name}', { name: app.name })
                      }
                    />
                  );
                })}
              </div>

              {marketError && (
                <div className="app-import-error">
                  <div className="aie-head">
                    <AlertTriangle size={14} /> {tr('装不上')}
                  </div>
                  <p>{marketError}</p>
                </div>
              )}

              <p className="market-note">
                {tr('点卡片可以先在沙箱里预览；点右边的 + 直接添加到首页。添加后会告诉你在哪里打开，代码、名字、说明以后都能改。')}
              </p>
            </>
          )}

          {tab === 'ai' &&
            (aiApps.length ? (
              <>
                <div className="market-grid">
                  {aiApps.map((app) => {
                    const linked = linkedAppIds.has(app.id);
                    return (
                      <AppCard
                        key={app.id}
                        name={app.name}
                        description={app.description || tr('第 {n} 版', { n: app.version })}
                        icon={app.icon}
                        color={app.color}
                        exists
                        linked={linked}
                        busy={installing === app.id}
                        disabled={Boolean(installing)}
                        onOpen={() => onOpenInstalled(app)}
                        onAdd={() => void addHomeEntry(app)}
                        openTitle={tr('打开 {name}', { name: app.name })}
                        addTitle={tr('把「{name}」加回首页', { name: app.name })}
                      />
                    );
                  })}
                </div>
                <p className="market-note">
                  {tr('只列出用 AI 生成并保存过的小应用；删掉应用后，这里就不会再显示。应用还在、只是首页入口被删时，点 + 就能加回来。')}
                </p>
              </>
            ) : (
              <div className="market-empty">
                <Sparkles size={22} strokeWidth={1.6} />
                <strong>{tr('还没有 AI 生成的小应用')}</strong>
                <p>{tr('回到首页点「AI 小应用」做一个；保存后会自动出现在这里，也能随时把入口加回首页。')}</p>
              </div>
            ))}

          {tab === 'file' && !result && (
            <div
              ref={dropRef}
              className={cn('app-import-drop', drag && 'is-drag', busy && 'is-busy')}
              role="button"
              tabIndex={0}
              onClick={() => !busy && fileRef.current?.click()}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  if (!busy) fileRef.current?.click();
                }
              }}
              onDragOver={(e) => {
                e.preventDefault();
                if (!busy) setDrag(true);
              }}
              onDragLeave={() => setDrag(false)}
              onDrop={onDrop}
            >
              <div className="aid-icon">{busy ? <Upload size={20} /> : <FileArchive size={20} />}</div>
              <div className="aid-title">
                {busy ? tr('正在合并并检查…') : drag ? tr('松手即可导入') : tr('把 HTML 或 zip 拖到这里，或点击选择')}
              </div>
              <div className="aid-sub">
                {busy ? tr('大一点的 zip 需要几秒，请稍等') : tr('一次一个文件；多个文件请先压成一个 zip')}
              </div>
            </div>
          )}

          {tab === 'file' && !result && !error && (
            <>
              <div className="app-import-strip">
                <span>
                  <ShieldCheck size={12} /> {tr('单页应用')}
                </span>
                <span>
                  <ShieldCheck size={12} /> {tr('可联网')}
                </span>
                <span>
                  <ShieldCheck size={12} /> {tr('不读取笔记与密钥')}
                </span>
              </div>

              <section className="app-import-guide">
                <div className="aig-head">
                  <span className="aig-icon">
                    <Sparkles size={14} />
                  </span>
                  <div>
                    <div className="aig-title">{tr('没有现成文件？让 AI 现在做一个')}</div>
                    <p className="aig-sub">
                      {tr('复制下面的提示词，发给 Claude、WorkBuddy 或 ChatGPT，再把生成的文件拖回上面的框里。')}
                    </p>
                  </div>
                </div>

                <div className="aig-prompt">
                  <div className="aig-prompt-head">
                    <span>{tr('提示词')}</span>
                    <button className={cn('aig-copy', copied && 'is-copied')} onClick={() => void copyPrompt()}>
                      {copied ? <Check size={13} /> : <Copy size={13} />}
                      {copied ? tr('已复制') : tr('复制提示词')}
                    </button>
                  </div>
                  <pre>{importPrompt}</pre>
                </div>

                <ol className="aig-steps">
                  <li>
                    <b>1</b>{tr('复制提示词')}
                  </li>
                  <li>
                    <b>2</b>{tr('发给 AI 生成')}
                  </li>
                  <li>
                    <b>3</b>{tr('把文件拖回来')}
                  </li>
                </ol>
                <p className="app-import-note">{tr('只要浏览器能直接打开就行；格式有问题时会逐条告诉你怎么改。')}</p>
              </section>
            </>
          )}

          {tab === 'file' && error && (
            <div className="app-import-error">
              <div className="aie-head">
                <AlertTriangle size={14} /> {tr('这份文件暂时不能导入')}
              </div>
              <p>{error}</p>
              {issueRows.length > 0 && (
                <ul className="aie-list">
                  {issueRows.slice(0, 8).map((row) => (
                    <li key={row.issue}>
                      <span>{row.issue}</span>
                      {row.hint && <em>{tr(row.hint)}</em>}
                    </li>
                  ))}
                </ul>
              )}
              <div className="aie-actions">
                <button className="btn btn-secondary btn-sm" onClick={pickAgain}>
                  <Upload size={13} /> {tr('重新选择')}
                </button>
                <button className="btn btn-ghost btn-sm" onClick={() => void copyPrompt()}>
                  <Copy size={13} /> {tr('复制提示词让 AI 重做')}
                </button>
              </div>
            </div>
          )}

          {tab === 'file' && result && (
            <div className="app-import-result">
              <div className="air-head">
                <span>
                  <Check size={13} /> {tr('已合并并通过检查')}
                </span>
                <span className="air-size">{(result.bytes / 1024).toFixed(1)}KB</span>
              </div>
              <div className="app-import-stats">
                <span>{tr('入口 {entry}', { entry: result.entry })}</span>
                <span>{tr('{n} 个文件', { n: result.fileCount })}</span>
                {result.inlined > 0 && <span>{tr('内联 {n} 个资源', { n: result.inlined })}</span>}
              </div>
              <div className="field">
                <label>{tr('应用名称')}</label>
                <input
                  className="input"
                  value={draftName}
                  maxLength={20}
                  placeholder={tr('建议 2–12 个字')}
                  onChange={(e) => setDraftName(e.target.value)}
                />
              </div>
              <div className="field">
                <label>{tr('一句话说明')}</label>
                <input
                  className="input"
                  value={draftDesc}
                  maxLength={160}
                  placeholder={tr('会显示在首页入口的副标题里')}
                  onChange={(e) => setDraftDesc(e.target.value)}
                />
              </div>
              {result.warnings.length > 0 && (
                <div className="app-import-warnings">
                  <div className="aiw-head">{tr('有 {n} 处小问题，可以先预览看看', { n: result.warnings.length })}</div>
                  <ul>
                    {result.warnings.map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>

        <footer className="app-import-foot">
          <span className="app-import-foot-hint">
            {tab === 'market'
              ? tr('点卡片预览，点 + 直接添加到首页')
              : tab === 'ai'
                ? tr('点卡片直接打开；+ 只把入口加回首页')
                : result
                  ? tr('确认没问题后再保存，不会覆盖已有应用')
                  : tr('一次一个 HTML 或 zip；导入后先载入预览，不会自动保存')}
          </span>
          <div className="app-import-foot-actions">
            {tab !== 'file' ? (
              <button className="btn btn-ghost btn-sm" onClick={onClose}>
                {tr('关闭')}
              </button>
            ) : result ? (
              <>
                <button className="btn btn-ghost btn-sm" onClick={pickAgain}>
                  {tr('重新选择')}
                </button>
                <button className="btn btn-primary btn-sm" onClick={confirm} disabled={busy}>
                  <Check size={13} /> {tr('载入预览')}
                </button>
              </>
            ) : (
              <button className="btn btn-ghost btn-sm" onClick={onClose}>
                {tr('取消')}
              </button>
            )}
          </div>
        </footer>

        <input
          ref={fileRef}
          type="file"
          accept={ACCEPT}
          className="app-import-file"
          onChange={(e) => {
            accept(Array.from(e.target.files || []));
            e.target.value = '';
          }}
        />
      </div>

      {/* 添加成功：叠在市场上面，背后的应用市场不隐藏 */}
      {installed ? (
        <div className="market-layer">
          <div className="market-layer-veil" onClick={() => setInstalled(null)} />
          <div className="app-import is-success" role="status" aria-live="polite">
            <header className="app-import-head">
              <div>
                <div className="app-import-title">{tr('添加成功')}</div>
                <div className="app-import-sub">{tr('已经放进首页，想用的时候点一下就行')}</div>
              </div>
              <button className="icon-btn" onClick={() => setInstalled(null)} aria-label={tr('关闭提示')}>
                <X size={16} />
              </button>
            </header>

            <div className="app-import-success">
              <span className="ais-check">
                <Check size={22} />
              </span>
              <div className="ais-app">
                <span className={cn('market-icon', 'hc-' + installed.color)}>
                  <InstalledIcon size={16} />
                </span>
                <div className="ais-app-info">
                  <strong>{installed.name}</strong>
                  <span>{tr('v{n} · 已保存到仓库', { n: installed.version })}</span>
                </div>
              </div>
              <p className="ais-where">
                {tr('在首页「快捷入口」里就能打开（通常放在「AI 小应用」分组）；桌面浮窗的「小应用」tab 里也能看到它。')}
              </p>
              <p className="ais-hint">{tr('之后想改名字、说明或继续用 AI 修改，在首页应用卡片的「…」菜单里操作。')}</p>
            </div>

            <footer className="app-import-foot">
              <span className="app-import-foot-hint">{tr('关闭提示后可以接着逛市场')}</span>
              <div className="app-import-foot-actions">
                <button className="btn btn-ghost btn-sm" onClick={() => setInstalled(null)}>
                  {tr('继续逛应用市场')}
                </button>
                <button className="btn btn-primary btn-sm" onClick={() => onOpenInstalled(installed)}>
                  {tr('打开试用')}
                </button>
              </div>
            </footer>
          </div>
        </div>
      ) : null}

      {/* 卡片预览：先试再决定；放进沙箱 iframe，和装好后的运行环境一致 */}
      {preview ? (
        <div className="market-layer">
          <div className="market-layer-veil" onClick={closePreview} />
          <div className="market-preview" role="dialog" aria-modal="true" aria-label={tr('{name} 预览', { name: preview.name })}>
            <header className="market-preview-head">
              <span className={cn('market-icon', 'hc-' + preview.color)}>
                <PreviewIcon size={16} />
              </span>
              <strong className="mp-name">{preview.name}</strong>
              <span className="mp-cat">{MARKET_CATEGORIES.find((c) => c.id === preview.category)?.name}</span>
              <span className="mp-desc" title={preview.description}>
                {preview.description}
              </span>
              <button className="icon-btn" onClick={closePreview} aria-label={tr('关闭预览')}>
                <X size={16} />
              </button>
            </header>
            <div className="mp-stage">
              {previewLoading ? (
                <div className="mp-hint">
                  <Loader2 size={15} className="spin" /> {tr('正在准备预览…')}
                </div>
              ) : previewError ? (
                <div className="mp-error">{previewError}</div>
              ) : (
                <iframe
                  className="mp-frame"
                  title={tr('{name} 预览', { name: preview.name })}
                  sandbox="allow-scripts allow-forms"
                  allow="clipboard-write"
                  referrerPolicy="no-referrer"
                  srcDoc={withCsp(previewHtml, { bridge: 'preview' })}
                />
              )}
            </div>
            {marketError ? (
              <p className="mp-fail">
                <AlertTriangle size={12} /> {marketError}
              </p>
            ) : null}
            <footer className="mp-foot">
              <span className="mp-note">
                {previewInstalled
                  ? previewLinked
                    ? tr('这个应用已经在首页了，不用重复添加；可以直接打开使用。')
                    : tr('应用还在本机，只是首页入口被删了；点「加回首页」重新放回快捷入口。')
                  : tr('预览里随手试试，合适再添加到首页；添加后数据才会保存。')}
              </span>
              <div className="mp-actions">
                <button className="btn btn-ghost btn-sm" onClick={closePreview}>
                  {previewInstalled ? tr('关闭') : tr('取消')}
                </button>
                {previewInstalled ? (
                  previewLinked ? (
                    <button className="btn btn-primary btn-sm" onClick={() => onOpenInstalled(previewInstalled)}>
                      <Check size={13} /> {tr('打开已安装')}
                    </button>
                  ) : (
                    <button
                      className="btn btn-primary btn-sm"
                      onClick={() => {
                        void addHomeEntry(previewInstalled);
                        closePreview();
                      }}
                      disabled={Boolean(installing)}
                    >
                      {installing === previewInstalled.id ? <Loader2 size={13} className="spin" /> : <Plus size={13} />}
                      {tr('加回首页')}
                    </button>
                  )
                ) : (
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={() => void install(preview)}
                    disabled={Boolean(installing)}
                  >
                    {installing === preview.id ? <Loader2 size={13} className="spin" /> : <Plus size={13} />}
                    {tr('添加到首页')}
                  </button>
                )}
              </div>
            </footer>
          </div>
        </div>
      ) : null}
    </div>,
    document.body,
  );
}
