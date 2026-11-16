import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowUp,
  ArrowUpRight,
  Check,
  Circle,
  Download,
  History,
  Layers,
  Minus,
  Pencil,
  PenLine,
  RefreshCw,
  Settings2,
  Sparkles,
  Square,
  Trash2,
  Undo2,
  X,
  type LucideIcon,
} from 'lucide-react';
import {
  AppError,
  checkHtml,
  generateApp,
  listVersions,
  readVersion,
  shortAppName,
  type AppColor,
  type AppMeta,
} from '../lib/apps';
import {
  ANNO_COLORS,
  ANNO_TOOLS,
  annotationSummary,
  describeShapes,
  renderThumbnail,
  type AnnoShape,
  type AnnoTool,
} from '../lib/annotate';
import { dropDraftData, migrateDraftData } from '../lib/appDataHost';
import { PreviewAnnotator } from './PreviewAnnotator';
import { AppMetaFields } from './AppMetaFields';
import type { ImportedApp } from '../lib/importApp';
import { HOME_ICON_OPTIONS, iconFor } from './homeIcons';
import { APP_GROUP_NAME } from '../lib/home';
import { useHome } from '../store/home';
import { useApp } from '../store/app';
import { registerBuilderStop, useAppBuilder } from '../store/appBuilder';
import { desktop } from '../lib/desktop';
import { cn, downloadText } from '../lib/utils';
import { useT } from '../lib/i18n';

interface Props {
  /** 生成会话 id：会话由 AppBuilderHost 统一管理，多开 / 最小化都靠它 */
  sessionId: string;
  initial: { meta: AppMeta; html: string } | null;
  /** 从首页导入的应用：作为新应用载入预览，保存时才落盘 */
  incoming: ImportedApp | null;
  /** 前台可见；false 时保持挂载但不渲染，正在进行的生成不会中断 */
  visible: boolean;
}

const EXAMPLES = [
  {
    title: '科学计算器',
    prompt: '做一个科学计算器，支持四则运算、括号、三角函数、平方根和百分比，保留最近 8 条计算历史。',
  },
  {
    title: 'JSON 格式化',
    prompt: '做一个 JSON 格式化工具：粘贴 JSON 后可以格式化、压缩，出错时显示具体位置和原因，并能一键复制结果。',
  },
  {
    title: '单位换算',
    prompt: '做一个单位换算器，支持长度、重量、温度、面积、数据存储五类单位互换，输入一个值实时显示所有结果。',
  },
  {
    title: '番茄钟',
    prompt:
      '做一个番茄钟：25 分钟专注 + 5 分钟休息，可以开始、暂停、重置，显示剩余时间和当前阶段，结束时播放一段简短的提示音（用 Web Audio 合成，不要外部音频）。',
  },
  {
    title: 'Base64 编解码',
    prompt: '做一个 Base64 / URL 编解码工具，支持中文，输入时实时转换，带复制按钮和清空按钮。',
  },
  {
    title: '正则测试',
    prompt: '做一个正则表达式测试器：输入正则和测试文本，高亮所有匹配项，显示匹配数量和捕获组，支持常用标志位。',
  },
];

const TOOL_ICONS: Record<AnnoTool, LucideIcon> = {
  pen: Pencil,
  arrow: ArrowUpRight,
  rect: Square,
  ellipse: Circle,
};

interface ChatMsg {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  at: number;
  kind?: 'app' | 'error' | 'info';
  issues?: string[];
  appName?: string;
  appDesc?: string;
  thumb?: string;
  annoCount?: number;
  retryText?: string;
  retryAnno?: string;
  /** 失败原因是输出额度 / 超时：额外给一个「去设置调整」的入口 */
  budget?: boolean;
}

let seq = 0;
function msgId() {
  seq += 1;
  return `m${Date.now().toString(36)}${seq}`;
}

export function AppBuilder({ sessionId, initial, incoming, visible }: Props) {
  const tr = useT();
  const saveApp = useHome((s) => s.saveApp);
  const updateAppInfo = useHome((s) => s.updateAppInfo);
  const apps = useHome((s) => s.apps);
  // 只统计 AI 生成的应用。首页里预装的三个市场小应用（时钟/随机决定/课程表）不算，
  // 否则第一次创建 AI 应用就会显示「你已经保存了 3 个 AI 应用」，让人以为搞错了。
  const aiApps = useMemo(() => apps.filter((app) => app.source === 'ai'), [apps]);
  const groups = useHome((s) => s.groups);
  const toast = useApp((s) => s.toast);
  const minimizeSession = useAppBuilder((s) => s.minimize);
  const requestClose = useAppBuilder((s) => s.requestClose);
  const othersCount = useAppBuilder((s) => s.sessions.filter((item) => item.id !== sessionId && item.minimized).length);

  const [prompt, setPrompt] = useState('');
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [code, setCode] = useState('');
  /** 当前已经落盘的应用；新建应用第一次生成后自动保存，此后都按它递增版本 */
  const [current, setCurrent] = useState<AppMeta | null>(initial?.meta ?? null);
  /** 上一次成功保存的代码，用来避免重复保存同一个版本 */
  const [savedHtml, setSavedHtml] = useState(initial?.html ?? '');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [icon, setIcon] = useState('sparkles');
  const [color, setColor] = useState<AppColor>('green');
  const [groupId, setGroupId] = useState('');
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [reloadKey, setReloadKey] = useState(0);
  const [metaOpen, setMetaOpen] = useState(false);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [versions, setVersions] = useState<{ name: string; at: string }[]>([]);
  const [annotating, setAnnotating] = useState(false);
  const [tool, setTool] = useState<AnnoTool>('pen');
  const [annoColor, setAnnoColor] = useState(ANNO_COLORS[0].value);
  const [shapes, setShapes] = useState<AnnoShape[]>([]);

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const startedAt = useRef(0);
  const busyRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const visibleRef = useRef(visible);

  const annoText = useMemo(() => describeShapes(shapes), [shapes]);
  const annoThumb = useMemo(() => renderThumbnail(shapes, 1.5), [shapes]);

  useEffect(() => {
    visibleRef.current = visible;
  }, [visible]);

  // 最小化 / 收起时组件不渲染，但生成不能断；真正关闭由 store 先中断请求
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      registerBuilderStop(sessionId, null);
      // 会话真正结束：未保存预览的内存草稿没有归宿，清掉避免常驻占用
      dropDraftData(sessionId);
    };
  }, [sessionId]);

  // 只在这个会话第一次挂载时初始化；最小化回来不会清空对话
  useEffect(() => {
    setPrompt('');
    const importMessage = incoming
      ? {
          id: msgId(),
          role: 'assistant' as const,
          at: Date.now(),
          kind: 'info' as const,
          text: tr(
            '已导入「{name}」：{summary}（{size}KB）。右侧可以直接试运行，点标题旁的铅笔可以改名；确认没问题后点「保存到首页」。{warnings}',
            {
              name: incoming.name,
              summary:
                incoming.fileCount > 1
                  ? tr('{n} 个文件合并成 1 个 HTML', { n: incoming.fileCount })
                  : tr('单文件 HTML'),
              size: (incoming.bytes / 1024).toFixed(1),
              warnings: incoming.warnings.length
                ? tr(' 有 {n} 处小提示：{list}。', {
                    n: incoming.warnings.length,
                    list: incoming.warnings.slice(0, 2).join('; '),
                  })
                : '',
            },
          ),
        }
      : null;
    setMessages(
      importMessage
        ? [importMessage]
        : initial
          ? [
              {
                id: msgId(),
                role: 'assistant',
                at: Date.now(),
                kind: 'info',
                text: tr(
                  '已载入「{name}」v{version}。右侧是当前版本，描述你想改的地方；只想改某一小块时，点右上角「标注」，直接在预览上圈出来再发送。',
                  { name: initial.meta.name, version: initial.meta.version },
                ),
              },
            ]
          : [],
    );
    setBusy(false);
    busyRef.current = false;
    setSaving(false);
    setElapsed(0);
    setReloadKey(0);
    setMetaOpen(false);
    setVersionsOpen(false);
    setVersions([]);
    setAnnotating(false);
    setShapes([]);
    setTool('pen');
    setAnnoColor(ANNO_COLORS[0].value);
    setCurrent(initial?.meta ?? null);
    setSavedHtml(initial?.html ?? '');
    if (initial) {
      setCode(initial.html);
      setName(initial.meta.name);
      setDescription(initial.meta.description);
      setIcon(initial.meta.icon);
      setColor(initial.meta.color);
      setGroupId(groups[0]?.id || '');
      void listVersions(initial.meta.id)
        .then(setVersions)
        .catch(() => setVersions([]));
    } else if (incoming) {
      setCode(incoming.html);
      setName(incoming.name);
      setDescription(incoming.description);
      setIcon(HOME_ICON_OPTIONS.includes(incoming.icon) ? incoming.icon : 'sparkles');
      setColor('green');
      setGroupId(groups.find((g) => g.name === APP_GROUP_NAME)?.id || '');
    } else {
      setCode('');
      setName('');
      setDescription('');
      setIcon('sparkles');
      setColor('green');
      // 默认放进「AI 小应用」分组；分组还不存在时留空，保存时会自动创建
      setGroupId(groups.find((g) => g.name === APP_GROUP_NAME)?.id || '');
    }
    window.setTimeout(() => inputRef.current?.focus(), 60);
    // 会话挂载时取一次初始数据与默认分组；之后 groups 变化不需要重置表单
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (annotating) {
        setAnnotating(false);
        return;
      }
      if (metaOpen) {
        setMetaOpen(false);
        return;
      }
      if (versionsOpen) {
        setVersionsOpen(false);
        return;
      }
      if (!saving) requestClose(sessionId);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visible, sessionId, annotating, metaOpen, versionsOpen, saving, requestClose]);

  useEffect(() => {
    if (!busy) return;
    startedAt.current = Date.now();
    setElapsed(0);
    const timer = window.setInterval(() => setElapsed(Math.round((Date.now() - startedAt.current) / 1000)), 500);
    return () => window.clearInterval(timer);
  }, [busy]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, busy, metaOpen, versionsOpen, visible]);

  // 输入框跟着内容长高，最多 5 行左右
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(120, Math.max(38, el.scrollHeight))}px`;
  }, [prompt, visible]);

  // 改名 / 改说明 / 换图标颜色也自动保存，关掉生成器不会丢
  useEffect(() => {
    if (!current || busy || saving) return;
    const clean = name.replace(/\s+/g, ' ').trim().slice(0, 20);
    if (!clean) return;
    const desc = description.trim().slice(0, 160);
    if (clean === current.name && desc === current.description && icon === current.icon && color === current.color) {
      return;
    }
    const timer = window.setTimeout(() => {
      void updateAppInfo(current.id, { name: clean, description: desc, icon, color })
        .then(() => {
          const fresh = useHome.getState().apps.find((a) => a.id === current.id);
          if (!fresh) return;
          setCurrent(fresh);
        })
        .catch(() => {
          /* 应用可能刚被别的设备删掉；保持界面原样即可 */
        });
    }, 700);
    return () => window.clearTimeout(timer);
  }, [current, name, description, icon, color, busy, saving, updateAppInfo]);

  if (!visible) return null;

  const pushMessage = (message: ChatMsg) => setMessages((prev) => [...prev, message].slice(-30));

  const historyFor = (list: ChatMsg[]) =>
    list
      .filter((message) => message.text && message.kind !== 'error' && message.kind !== 'info')
      .map((message) => ({ role: message.role, content: message.text }))
      .slice(-8);

  const openRename = () => {
    if (!code) return;
    setMetaOpen(true);
    setVersionsOpen(false);
    window.setTimeout(() => {
      nameRef.current?.focus();
      nameRef.current?.select();
    }, 60);
  };

  /** 最小化、或窗口在后台时，用系统通知把结果告诉用户 */
  const notifyAway = (title: string, body: string, kind: 'success' | 'error') => {
    if (visibleRef.current && document.hasFocus()) return;
    const bridge = desktop();
    // 锁屏时不把应用名写进通知，和待办提醒保持一致
    if (useApp.getState().locked) {
      if (bridge?.notify) {
        void bridge.notify({
          title: tr('AI 小应用任务已结束'),
          body: tr('解锁后可回到生成器查看结果。'),
          action: `builder:${sessionId}`,
        });
      }
      return;
    }
    if (bridge?.notify) {
      void bridge.notify({ title, body, action: `builder:${sessionId}` });
      return;
    }
    useApp.getState().toast(body ? `${title} · ${body}` : title, kind);
  };

  /**
   * 把当前代码写入仓库。生成成功后会自动调用，手动「保存」也走这里，
   * 所以两条路径的版本递增、历史快照、首页入口和已打开面板的刷新行为完全一致。
   */
  const persist = async (input: {
    name: string;
    description: string;
    icon: string;
    color: AppColor;
    html: string;
    groupId: string;
  }): Promise<AppMeta> => {
    const baseMeta = current || initial?.meta || null;
    const blocked = checkHtml(input.html);
    if (blocked.length) throw new AppError(tr('应用没有通过安全检查，暂时不能保存。'), blocked);
    const meta = await saveApp({
      meta: baseMeta || undefined,
      name: input.name,
      description: input.description,
      icon: input.icon,
      color: input.color,
      html: input.html,
      groupId: input.groupId,
      // 新应用记下来源：导入会话保存的是导入应用，其余都是 AI 现场生成。
      // 已存在的应用保留原来的来源，之后继续用 AI 修改也不会改变出身。
      ...(baseMeta ? {} : { source: incoming ? ('import' as const) : ('ai' as const) }),
    });
    setCurrent(meta);
    setSavedHtml(input.html);
    void listVersions(meta.id)
      .then(setVersions)
      .catch(() => setVersions([]));
    // 新建 / 导入时如果应用已经往草稿里写过数据，保存后并入 data.json
    if (!baseMeta) void migrateDraftData(sessionId, meta.id).catch(() => {});
    return meta;
  };

  const run = async (text: string, annotation: string, echo: boolean) => {
    if (busyRef.current || saving) return;
    const cleaned = text.trim();
    if (!cleaned) return;
    busyRef.current = true;
    setBusy(true);
    setElapsed(0);
    const controller = new AbortController();
    abortRef.current = controller;
    registerBuilderStop(sessionId, () => controller.abort());
    const startedLabel = !code ? shortAppName(cleaned) : '';
    useAppBuilder.getState().patch(sessionId, {
      busy: true,
      phase: 'generating',
      startedAt: Date.now(),
      ...(startedLabel ? { label: startedLabel } : {}),
    });
    const history = historyFor(messages);
    if (echo) {
      pushMessage({
        id: msgId(),
        role: 'user',
        text: cleaned,
        at: Date.now(),
        thumb: shapes.length ? annoThumb : undefined,
        annoCount: shapes.length || undefined,
      });
      setPrompt('');
    }
    try {
      const first = !code;
      const result = await generateApp({
        prompt: cleaned,
        base: code ? { name: name || current?.name || initial?.meta.name, html: code } : undefined,
        annotations: annotation || undefined,
        history,
        signal: controller.signal,
      });
      setCode(result.html);
      if (first) {
        setName(result.name);
        setDescription(result.description);
        if (HOME_ICON_OPTIONS.includes(result.icon)) setIcon(result.icon);
      } else {
        if (!name.trim()) setName(result.name);
        if (!description.trim()) setDescription(result.description);
      }
      setReloadKey((k) => k + 1);
      setShapes([]);

      // 生成成功立刻落盘：窗口被误关、应用崩溃都不会再丢这一版。
      // 代码和已保存的一模一样时不重复存，避免版本号被空转推高。
      const unchanged = Boolean(current && result.html === savedHtml);
      let savedMeta: AppMeta | null = unchanged ? current : null;
      let saveError = '';
      if (!savedMeta) {
        try {
          setSaving(true);
          savedMeta = await persist({
            name: first ? result.name : name.trim() || result.name,
            description: first ? result.description : description.trim() || result.description,
            icon: first && HOME_ICON_OPTIONS.includes(result.icon) ? result.icon : icon,
            color,
            html: result.html,
            groupId,
          });
          toast(tr('已自动保存「{name}」v{version}', { name: savedMeta.name, version: savedMeta.version }), 'success');
        } catch (e) {
          saveError = (e as Error)?.message || tr('保存失败');
          pushMessage({
            id: msgId(),
            role: 'assistant',
            at: Date.now(),
            kind: 'error',
            text: tr('应用已经生成，但自动保存失败：{err}。可以点右上角「保存」重试。', { err: saveError }),
            issues: e instanceof AppError ? e.issues : undefined,
          });
        } finally {
          setSaving(false);
        }
      }

      const changelog = result.changelog || tr('右侧预览已经更新，可以继续提要求，或者直接在预览上标注要改的位置。');
      const saveNote = !savedMeta
        ? ''
        : unchanged
          ? `\n\n${tr('这一版和 v{version} 完全一样，没有新增版本。', { version: savedMeta.version })}`
          : `\n\n${tr('已自动保存为 v{version}，入口已放到首页，误关也能找回来。', { version: savedMeta.version })}`;
      pushMessage({
        id: msgId(),
        role: 'assistant',
        at: Date.now(),
        kind: 'app',
        text: `${changelog}${saveNote}`,
        appName: result.name,
        appDesc: result.description,
      });
      useAppBuilder.getState().patch(sessionId, {
        label: result.name,
        phase: savedMeta ? 'done' : 'unsaved',
      });
      if (savedMeta) {
        notifyAway(tr('AI 小应用已生成并保存'), tr('「{name}」已保存到首页，点这里继续调整。', { name: savedMeta.name }), 'success');
      } else {
        notifyAway(
          tr('AI 小应用已生成，但没保存成功'),
          tr('{err} 点这里处理。', { err: saveError.slice(0, 80) }),
          'error',
        );
      }
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') {
        // 主动停止不算失败：不给错误气泡，也不弹系统通知
        pushMessage({
          id: msgId(),
          role: 'assistant',
          at: Date.now(),
          kind: 'info',
          text: tr('已停止这次生成。改一下描述可以重新发送，之前生成的内容还在。'),
        });
        useAppBuilder.getState().patch(sessionId, { phase: 'idle' });
      } else {
        const err = e as Error & { issues?: string[]; code?: string };
        const text = err.message || tr('生成失败，请稍后再试');
        // 输出额度用完 / 等太久：不是网络或模型坏了，用户自己调大或调小设置就能解决，
        // 所以额外给一个直达设置项的按钮，别只让他去翻设置找。
        const budget =
          err.code === 'TIMEOUT' ||
          err.code === 'BUDGET' ||
          err.code === 'EMPTY_LENGTH' ||
          text.includes('最大输出 tokens');
        pushMessage({
          id: msgId(),
          role: 'assistant',
          at: Date.now(),
          kind: 'error',
          text:
            budget && err.code === 'TIMEOUT'
              ? tr('{msg}。如果是生成整页小应用等到超时，可以到设置里把「最大输出 tokens」调小一些（写得短、更快返回），或换一个更快的模型。', { msg: text })
              : text,
          issues: err instanceof AppError ? err.issues : undefined,
          retryText: cleaned,
          retryAnno: annotation || undefined,
          budget,
        });
        useAppBuilder.getState().patch(sessionId, { phase: 'error' });
        notifyAway(tr('AI 小应用没能生成'), tr('{err} 点这里回到生成器重试。', { err: text.slice(0, 80) }), 'error');
      }
    } finally {
      abortRef.current = null;
      registerBuilderStop(sessionId, null);
      busyRef.current = false;
      setBusy(false);
      useAppBuilder.getState().patch(sessionId, { busy: false });
    }
  };

  const send = () => {
    const text = prompt.trim() || (shapes.length ? tr('按预览标注修改') : '');
    if (!text) return;
    void run(text, annoText, true);
  };

  const retry = (message: ChatMsg) => {
    if (!message.retryText) return;
    void run(message.retryText, message.retryAnno || '', false);
  };

  /** 收进任务坞再打开设置：生成器占了整屏，直接叠设置弹窗会被挡住 */
  const openBudgetSettings = () => {
    useAppBuilder.getState().minimize(sessionId);
    useApp.getState().setSettings(true, 'ai');
  };

  const save = async () => {
    if (!code || saving || busy) return;
    if (current && code === savedHtml) {
      toast(tr('当前版本已经保存，不用重复保存'), 'info');
      return;
    }
    setSaving(true);
    const lastUser = [...messages].reverse().find((message) => message.role === 'user')?.text || '';
    const finalName = name.trim() || current?.name || shortAppName(lastUser || tr('AI 小应用'));
    if (!name.trim()) setName(finalName);
    try {
      const meta = await persist({
        name: finalName,
        description: description.trim(),
        icon,
        color,
        html: code,
        groupId,
      });
      toast(
        current
          ? tr('已保存「{name}」v{version}', { name: meta.name, version: meta.version })
          : tr('已保存「{name}」，入口已放到首页', { name: meta.name }),
        'success',
      );
    } catch (e) {
      const err = e as AppError;
      pushMessage({
        id: msgId(),
        role: 'assistant',
        at: Date.now(),
        kind: 'error',
        text: err.message || tr('保存失败'),
        issues: err instanceof AppError ? err.issues : undefined,
      });
    } finally {
      setSaving(false);
    }
  };

  /** 保存失败（比如代码里引用了外部脚本）或想发给别人时，至少能把这一版带走 */
  const download = () => {
    if (!code) return;
    const base = (name.trim() || current?.name || tr('AI 小应用')).replace(/[\\/:*?"<>|]/g, '-');
    downloadText(`${base || tr('AI 小应用')}.html`, code, 'text/html;charset=utf-8');
    toast(tr('已下载 HTML 备份'), 'success');
  };

  const restoreVersion = async (version: { name: string; at: string }) => {
    if (!current || busy || saving) return;
    setSaving(true);
    try {
      const html = await readVersion(current.id, version.name);
      // 恢复也走保存：当前版本会先被快照，所以这一步本身可以再撤销
      const meta = await persist({
        name: name.trim() || current.name,
        description: description.trim(),
        icon,
        color,
        html,
        groupId,
      });
      setCode(html);
      setReloadKey((k) => k + 1);
      setVersionsOpen(false);
      setShapes([]);
      pushMessage({
        id: msgId(),
        role: 'assistant',
        at: Date.now(),
        kind: 'info',
        text: tr('已恢复到 {at} 的版本，并保存为 v{version}。恢复前的版本仍在历史里，随时可以再换回去。', {
          at: version.at,
          version: meta.version,
        }),
      });
      toast(tr('已恢复并保存为 v{version}', { version: meta.version }), 'success');
    } catch (e) {
      toast((e as Error)?.message || tr('这个历史版本读不到了'), 'error');
    } finally {
      setSaving(false);
    }
  };

  const titleText = current
    ? tr('继续修改「{name}」', { name: (name || current.name).trim() })
    : name.trim() || tr('想做个小工具？');
  const phase =
    elapsed < 5
      ? tr('正在理解你的需求')
      : elapsed < 25
        ? tr('正在生成界面与交互逻辑')
        : tr('内容比较长，模型仍在输出');
  const toolHint = tr(ANNO_TOOLS.find((item) => item.id === tool)?.hint || '');
  const AppIcon = iconFor(icon, 'sparkles');

  /** 还有其他任务在后台时，当前窗口最小化、把最早的一个换到前台 */
  const switchTask = () => {
    const state = useAppBuilder.getState();
    const next = state.sessions.find((item) => item.id !== sessionId && item.minimized);
    if (!next) return;
    state.minimize(sessionId);
    state.restore(next.id);
  };

  return createPortal(
    <div className="app-builder-overlay" role="dialog" aria-modal="true" aria-label={tr('AI 小应用生成器')}>
      <div className="app-builder">
        <aside className="app-builder-side app-chat">
          <header className="app-builder-head">
            <div className="app-builder-head-main">
              <div className="app-builder-kicker">
                <Sparkles size={13} /> {tr('AI 小应用')}
              </div>
              <div className="app-builder-title-row">
                <div className="app-builder-title">{titleText}</div>
                {code && (
                  <button className="app-title-edit" onClick={openRename} title={tr('修改名称')} aria-label={tr('修改名称')}>
                    <Pencil size={12} />
                  </button>
                )}
              </div>
            </div>
            <div className="app-builder-head-actions">
              {current && versions.length > 0 && (
                <button
                  className={cn('icon-btn', versionsOpen && 'on')}
                  title={tr('历史版本')}
                  aria-label={tr('历史版本')}
                  onClick={() => {
                    setVersionsOpen((v) => !v);
                    setMetaOpen(false);
                  }}
                >
                  <History size={15} />
                </button>
              )}
              {code && (
                <button
                  className={cn('icon-btn', metaOpen && 'on')}
                  title={tr('应用信息')}
                  aria-label={tr('应用信息')}
                  onClick={() => {
                    setMetaOpen((v) => !v);
                    setVersionsOpen(false);
                  }}
                >
                  <Settings2 size={15} />
                </button>
              )}
              {othersCount > 0 && (
                <button
                  className="app-builder-tasks"
                  onClick={switchTask}
                  title={tr('切换到后台任务（还有 {n} 个）', { n: othersCount })}
                  aria-label={tr('切换到后台任务，还有 {n} 个', { n: othersCount })}
                >
                  <Layers size={12} />
                  <span>{othersCount}</span>
                </button>
              )}
              <button
                className="icon-btn"
                onClick={() => minimizeSession(sessionId)}
                title={tr('最小化到后台（生成会继续）')}
                aria-label={tr('最小化到后台')}
              >
                <Minus size={16} />
              </button>
              <button className="icon-btn" onClick={() => requestClose(sessionId)} aria-label={tr('关闭')}>
                <X size={16} />
              </button>
            </div>
          </header>

          <div className="app-chat-scroll" ref={scrollRef}>
            {messages.length === 0 && (
              <div className="app-chat-welcome">
                <div className="acw-title">{tr('用一句话，做一个属于自己的小工具')}</div>
                <p>
                  {tr(
                    '描述想要的工具，AI 会生成一个单文件应用，保存在笔记仓库里，随时从首页打开。不满意可以继续对话修改，也可以在预览上画圈标注。',
                  )}
                </p>
                <div className="app-example-grid">
                  {EXAMPLES.map((item) => (
                    <button
                      key={item.title}
                      className="app-example"
                      onClick={() => {
                        setPrompt(tr(item.prompt));
                        inputRef.current?.focus();
                      }}
                    >
                      <span className="ae-title">{tr(item.title)}</span>
                      <span className="ae-sub">{tr(item.prompt).slice(0, 34)}…</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((message) => (
              <div key={message.id} className={cn('chat-row', message.role)}>
                {message.role === 'assistant' && (
                  <div className="chat-avatar">
                    <Sparkles size={13} />
                  </div>
                )}
                <div className="chat-stack">
                  {message.thumb && (
                    <div className="chat-anno-thumb">
                      <img src={message.thumb} alt={tr('预览标注缩略图')} />
                    </div>
                  )}
                  <div
                    className={cn(
                      'chat-bubble',
                      message.kind === 'error' && 'is-error',
                      message.kind === 'app' && 'is-app',
                      message.kind === 'info' && 'is-info',
                    )}
                  >
                    {message.kind === 'app' && message.appName && (
                      <div className="chat-app-head">
                        <div className="chat-app-icon">
                          <AppIcon size={15} strokeWidth={1.8} />
                        </div>
                        <div className="chat-app-meta">
                          <div className="chat-app-name">{message.appName}</div>
                          {message.appDesc && <div className="chat-app-desc">{message.appDesc}</div>}
                        </div>
                        <button className="chat-app-rename" onClick={openRename} title={tr('修改名称')} aria-label={tr('修改名称')}>
                          <Pencil size={11} />
                        </button>
                      </div>
                    )}
                    <div className="chat-text">{message.text}</div>
                    {message.annoCount ? (
                      <div className="chat-anno-tag">{tr('已引用 {n} 处预览标注', { n: message.annoCount })}</div>
                    ) : null}
                    {message.issues && message.issues.length > 0 && (
                      <ul className="chat-issues">
                        {message.issues.slice(0, 5).map((issue) => (
                          <li key={issue}>{issue}</li>
                        ))}
                      </ul>
                    )}
                    {message.kind === 'error' && (message.retryText || message.budget) && (
                      <div className="chat-actions">
                        {message.retryText && (
                          <button className="chat-retry" onClick={() => retry(message)} disabled={busy}>
                            <RefreshCw size={12} /> {tr('重试这一轮')}
                          </button>
                        )}
                        {message.budget && (
                          <button className="chat-retry" onClick={openBudgetSettings}>
                            <Settings2 size={12} /> {tr('调整输出上限')}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ))}

            {busy && (
              <div className="chat-row assistant">
                <div className="chat-avatar">
                  <Sparkles size={13} />
                </div>
                <div className="chat-stack">
                  <div className="chat-bubble is-typing">
                    <span className="ct-phase">{phase}</span>
                    <span className="ct-dots">
                      <i />
                      <i />
                      <i />
                    </span>
                    <span className="ct-time">{elapsed}s</span>
                  </div>
                  <div className="chat-progress-hint">{tr('通常需要 10–40 秒；可以最小化到后台，完成后会在右下角提醒你')}</div>
                </div>
              </div>
            )}

            {metaOpen && code && (
              <div className="app-meta-card">
                <div className="app-meta-card-head">
                  <span>{tr('应用信息')}</span>
                  <button className="icon-btn" title={tr('收起')} onClick={() => setMetaOpen(false)}>
                    <X size={13} />
                  </button>
                </div>
                <AppMetaFields
                  value={{ name, description, icon, color }}
                  onChange={(patch) => {
                    if (patch.name !== undefined) setName(patch.name);
                    if (patch.description !== undefined) setDescription(patch.description);
                    if (patch.icon !== undefined) setIcon(patch.icon);
                    if (patch.color !== undefined) setColor(patch.color);
                  }}
                  nameRef={nameRef}
                >
                  {!current && (
                    <div className="field">
                      <label>{tr('放到分组')}</label>
                      <select className="input" value={groupId} onChange={(e) => setGroupId(e.target.value)}>
                        <option value="">{tr('{name}（自动新建）', { name: APP_GROUP_NAME })}</option>
                        {groups.map((g) => (
                          <option key={g.id} value={g.id}>
                            {g.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                </AppMetaFields>
              </div>
            )}

            {versionsOpen && current && versions.length > 0 && (
              <div className="app-meta-card app-versions-card">
                <div className="app-meta-card-head">
                  <span>{tr('历史版本（{n}）', { n: versions.length })}</span>
                  <button className="icon-btn" title={tr('收起')} onClick={() => setVersionsOpen(false)}>
                    <X size={13} />
                  </button>
                </div>
                <div className="app-history-list">
                  {versions.map((version) => (
                    <button key={version.name} onClick={() => void restoreVersion(version)} disabled={busy || saving}>
                      <span>{version.at}</span>
                      <span className="ahr-restore">{tr('恢复')}</span>
                    </button>
                  ))}
                </div>
                <div className="app-versions-tip">
                  {tr('最多保留最近 10 个版本（只存在这台电脑）。恢复会立即保存为新版本，当前版本仍留在历史里。')}
                </div>
              </div>
            )}
          </div>

          <footer className="app-chat-foot">
            {shapes.length > 0 && (
              <div className="app-anno-chip">
                {annoThumb && <img src={annoThumb} alt={tr('标注缩略图')} />}
                <div className="aac-text">
                  <b>{annotationSummary(shapes)}</b>
                  <span>{tr('发送修改要求时会一起交给 AI，优先处理这些位置')}</span>
                </div>
                <button
                  className="icon-btn"
                  title={tr('清除全部标注')}
                  aria-label={tr('清除全部标注')}
                  onClick={() => setShapes([])}
                >
                  <X size={13} />
                </button>
              </div>
            )}
            <div className={cn('app-chat-composer', annotating && 'is-annotating')}>
              <textarea
                ref={inputRef}
                value={prompt}
                maxLength={1000}
                rows={1}
                placeholder={
                  code
                    ? tr('描述要改的地方，例如：按钮再大一点，历史记录移到右侧')
                    : tr('描述你想要的工具、功能和交互…')
                }
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    send();
                  }
                }}
              />
              <div className="acc-row">
                <div className="acc-tools">
                  <button
                    className={cn('acc-anno-btn', annotating && 'on')}
                    title={code ? (annotating ? tr('退出标注') : tr('在预览上标注')) : tr('生成应用后可以在预览上标注')}
                    disabled={!code || saving}
                    onClick={() => setAnnotating((v) => !v)}
                  >
                    <PenLine size={14} />
                    <span>{annotating ? tr('正在标注') : tr('标注')}</span>
                  </button>
                  <span className="acc-hint">
                    {annotating ? tr('在右侧预览上拖动绘制') : tr('Enter 发送 · Shift + Enter 换行')}
                  </span>
                </div>
                <button
                  className="app-send"
                  aria-label={tr('发送')}
                  title={tr('发送')}
                  disabled={busy || saving || (!prompt.trim() && shapes.length === 0)}
                  onClick={send}
                >
                  <ArrowUp size={15} strokeWidth={2.2} />
                </button>
              </div>
            </div>
            <div className="app-chat-security">{tr('沙箱运行 · 可以联网，但读不到笔记和密钥')}</div>
          </footer>
        </aside>

        <section className="app-builder-stage">
          <header className={cn('app-builder-stage-bar', annotating && 'is-annotating')}>
            {annotating ? (
              <>
                <span className="asb-title">
                  <PenLine size={13} /> {tr('标注预览')}
                </span>
                <div className="anno-toolbar">
                  {ANNO_TOOLS.map((item) => {
                    const ToolIcon = TOOL_ICONS[item.id];
                    return (
                      <button
                        key={item.id}
                        className={cn('anno-tool', tool === item.id && 'on')}
                        title={tr(item.hint)}
                        onClick={() => setTool(item.id)}
                      >
                        <ToolIcon size={14} />
                        <span>{tr(item.label)}</span>
                      </button>
                    );
                  })}
                  <span className="anno-sep" />
                  {ANNO_COLORS.map((item) => (
                    <button
                      key={item.id}
                      className={cn('anno-color', annoColor === item.value && 'on')}
                      style={{ backgroundColor: item.value }}
                      title={tr(item.label)}
                      aria-label={tr(item.label)}
                      onClick={() => setAnnoColor(item.value)}
                    />
                  ))}
                  <span className="anno-sep" />
                  <button
                    className="anno-act"
                    title={tr('撤销最后一处')}
                    aria-label={tr('撤销最后一处')}
                    disabled={!shapes.length}
                    onClick={() => setShapes((prev) => prev.slice(0, -1))}
                  >
                    <Undo2 size={14} />
                  </button>
                  <button
                    className="anno-act"
                    title={tr('清除全部')}
                    aria-label={tr('清除全部')}
                    disabled={!shapes.length}
                    onClick={() => setShapes([])}
                  >
                    <Trash2 size={14} />
                  </button>
                  <button className="btn btn-primary btn-sm anno-done" onClick={() => setAnnotating(false)}>
                    <Check size={13} /> {tr('完成')}
                  </button>
                </div>
              </>
            ) : (
              <>
                <span className="asb-title">{tr('预览')}</span>
                <div className="asb-actions">
                  {code && (
                    <button className="btn btn-ghost btn-sm asb-anno" onClick={() => setAnnotating(true)}>
                      <PenLine size={13} /> {tr('标注')}
                    </button>
                  )}
                  {code && (
                    <button className="icon-btn" title={tr('重新加载预览')} onClick={() => setReloadKey((k) => k + 1)}>
                      <RefreshCw size={14} />
                    </button>
                  )}
                  {code && (
                    <button className="icon-btn" title={tr('下载 HTML 备份')} aria-label={tr('下载 HTML 备份')} onClick={download}>
                      <Download size={14} />
                    </button>
                  )}
                  {code && (
                    <button
                      className="btn btn-primary btn-sm"
                      onClick={() => void save()}
                      disabled={busy || saving || Boolean(current && code === savedHtml)}
                      title={
                        current && code === savedHtml
                          ? tr('这一版已经保存过了')
                          : tr('保存当前版本；生成成功时会自动保存')
                      }
                    >
                      <Check size={13} />
                      {saving
                        ? tr('保存中…')
                        : current
                          ? code === savedHtml
                            ? tr('已保存 v{version}', { version: current.version })
                            : tr('保存')
                          : tr('保存到首页')}
                    </button>
                  )}
                </div>
              </>
            )}
          </header>

          {code ? (
            <PreviewAnnotator
              code={code}
              appId={current?.id || ''}
              draftKey={sessionId}
              reloadKey={reloadKey}
              annotating={annotating}
              tool={tool}
              color={annoColor}
              shapes={shapes}
              onShapesChange={setShapes}
            />
          ) : (
            <div className="app-builder-blank">
              <div className="abb-icon">
                <Sparkles size={22} strokeWidth={1.6} />
              </div>
              <div className="abb-title">{tr('预览会出现在这里')}</div>
              <div className="abb-sub">{tr('先描述一个小工具，或者从左边挑一个例子开始。')}</div>
              {aiApps.length > 0 && (
                <div className="abb-count">{tr('你已经保存了 {n} 个 AI 应用', { n: aiApps.length })}</div>
              )}
            </div>
          )}

          {annotating && (
            <div className="anno-tip">
              <PenLine size={12} />
              <span>{toolHint}{tr('；画好后在左侧描述要改成什么样，发送时标注会一起交给 AI。')}</span>
            </div>
          )}
        </section>
      </div>
    </div>,
    document.body,
  );
}
