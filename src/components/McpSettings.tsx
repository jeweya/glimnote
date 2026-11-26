import { useEffect, useState } from 'react';
import { Check, Copy, FolderOpen, Sparkles, TriangleAlert } from 'lucide-react';
import { useApp } from '../store/app';
import { cn } from '../lib/utils';
import { desktop, type McpHttpState, type McpInfo } from '../lib/desktop';
import { useT } from '../lib/i18n';

/**
 * 设置 → MCP：把「用 WorkBuddy / Claude Desktop 等 AI 客户端通过 MCP 管笔记」做成一件事：
 * 打开开关 → 复制一段配置 → 粘进客户端。服务由应用自己拉起，用户不用碰 .cmd。
 * 细节见 docs/mydoc/13-MCP集成.md。
 */
const FALLBACK: McpInfo = {
  dir: 'C:\\Users\\<you>\\AppData\\Local\\Programs\\Glimnote\\resources\\mcp',
  stdio: '',
  http: '',
  server: '',
  root: 'C:\\Users\\<you>\\Documents\\glimnote',
  dev: false,
  ready: false,
};

const FALLBACK_STATE: McpHttpState = {
  running: false,
  wanted: false,
  port: 8765,
  url: 'http://127.0.0.1:8765/mcp',
  root: '',
  error: '',
};

export function McpSettings() {
  const toast = useApp((s) => s.toast);
  const tr = useT();
  const [info, setInfo] = useState<McpInfo>(FALLBACK);
  const [state, setState] = useState<McpHttpState>(FALLBACK_STATE);
  const [isDesktop, setIsDesktop] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [promptCopied, setPromptCopied] = useState(false);
  const [err, setErr] = useState('');

  // 打开页签时读一次状态，之后每 5 秒对一下——服务可能在别处被停掉
  useEffect(() => {
    const bridge = desktop();
    if (!bridge?.mcpHttpStatus) return;
    setIsDesktop(true);
    let alive = true;
    const pull = () => {
      bridge
        .mcpHttpStatus()
        .then((next) => {
          if (alive) setState(next);
        })
        .catch(() => {});
    };
    void pull();
    if (bridge.mcpInfo) {
      bridge
        .mcpInfo()
        .then((next) => {
          if (alive) setInfo(next);
        })
        .catch(() => {});
    }
    const timer = window.setInterval(pull, 5000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  const url = state.url || FALLBACK_STATE.url;
  // 三行就够：整段 JSON 缩进两格读起来清爽，又不至于把卡片撑得很高
  const config = `{\n  "mcpServers": { "glimnote": { "url": "${url}" } }\n}`;

  // 只走 HTTP：WorkBuddy 这类能操作本机的 AI 拿到地址和一段配置就能接，
  // 不再塞 stdio / .cmd 的备选，避免用户在一堆路径里做选择。
  const prompt = [
    tr('请帮我把「萤光笔记」的 MCP 服务接入当前客户端。服务地址：{url}', { url }),
    '',
    tr('把下面这项合并进客户端已有的 mcpServers，保留其他服务器，保存后重启客户端或重新加载 MCP：'),
    config,
    '',
    tr('确认工具列表里出现 glimnote 的笔记、待办、灵感、日记工具。'),
    tr('如果找不到，提醒我完全退出并重启客户端——多数客户端要重启才会加载新添加的 MCP。'),
    '',
    tr('如果你不能读写本机设置，直接告诉我该点哪里、把配置粘到哪里，不要编造文件路径。只修改 MCP 配置，不要改动我的笔记文件。'),
    ...(state.running
      ? []
      : ['', tr('注意：MCP 服务当前未运行。连接失败时，提醒我先在萤光笔记的「设置 → MCP」里打开服务开关。')]),
  ].join('\n');

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(config);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setErr(tr('复制失败，请手动选中文字复制'));
    }
  };

  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(prompt);
      setPromptCopied(true);
      window.setTimeout(() => setPromptCopied(false), 1800);
    } catch {
      setErr(tr('复制失败，请手动选中文字复制'));
    }
  };

  const toggle = async () => {
    const bridge = desktop();
    if (!bridge?.mcpHttpStart || busy) return;
    setBusy(true);
    setErr('');
    try {
      const next = state.running ? await bridge.mcpHttpStop() : await bridge.mcpHttpStart();
      setState(next);
    } catch (e) {
      setErr(tr('操作失败：{msg}', { msg: String((e as Error)?.message || e) }));
    } finally {
      setBusy(false);
    }
  };

  const title = !isDesktop
    ? tr('仅桌面端可用')
    : busy
      ? tr('正在切换…')
      : state.running
        ? tr('服务运行中')
        : state.wanted
          ? tr('服务未启动')
          : tr('服务已停止');

  const subtitle = !isDesktop
    ? tr('网页版的数据在浏览器里，其它程序碰不到。')
    : state.running
      ? tr('{url} · 只监听本机', { url })
      : tr('打开右侧开关后，客户端才能连上。');

  const problem = err || state.error;

  return (
    <>
      <div className="set-section-title">{tr('AI 客户端（MCP）')}</div>

      <div className="set-row">
        <div>
          <div className="set-label">{tr('让 AI 客户端直接读写笔记')}</div>
          <div className="set-desc">
            {tr('WorkBuddy、Claude Desktop、Cursor 这类支持 MCP 的客户端，可以新建、修改、搜索笔记，建待办并打勾，不用打开萤光笔记窗口。')}
          </div>
        </div>
      </div>

      <div className="mcp-card">
        <div className="mcp-card-head">
          <span className={cn('mcp-dot', state.running && 'on')} aria-hidden />
          <div className="mcp-card-text">
            <div className="mcp-card-title">{title}</div>
            <div className="mcp-card-sub">{subtitle}</div>
          </div>
          {isDesktop && (
            <button
              className={cn('switch', state.running && 'on')}
              role="switch"
              aria-checked={state.running}
              aria-label={state.running ? tr('停止 MCP 服务') : tr('启动 MCP 服务')}
              title={state.running ? tr('停止服务') : tr('启动服务，并随应用下次启动自动开启')}
              disabled={busy}
              onClick={() => void toggle()}
            />
          )}
        </div>

        {problem && <div className="mcp-error">{problem}</div>}

        <div className="mcp-ai">
          <div className="mcp-ai-head">
            <div className="mcp-ai-text">
              <div className="mcp-ai-title">
                <Sparkles size={13} strokeWidth={1.75} /> {tr('让 AI 帮你接入')}
                <span className="mcp-ai-badge">{tr('推荐')}</span>
              </div>
              <div className="mcp-ai-desc">
                {tr('把提示词发给 WorkBuddy 等能操作电脑的 AI，它会直接帮你把 MCP 配置加好。')}
              </div>
            </div>
            <button type="button" className="btn btn-secondary mcp-copy" onClick={() => void copyPrompt()}>
              {promptCopied ? <Check size={14} /> : <Copy size={14} />} {promptCopied ? tr('已复制') : tr('复制提示词')}
            </button>
          </div>
          <pre className="mcp-ai-prompt">{prompt}</pre>
        </div>

        <div className="mcp-json">
          <div className="mcp-json-head">
            <span>{tr('客户端配置')}</span>
            <button type="button" className="btn btn-secondary mcp-copy" onClick={() => void copy()}>
              {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? tr('已复制') : tr('复制')}
            </button>
          </div>
          <pre>{config}</pre>
        </div>

        <div className="hint">
          {isDesktop
            ? tr('粘进客户端的 MCP 设置后重启客户端即可；服务只监听本机回环地址，别的设备连不进来。')
            : tr('这段配置只在桌面版有效。')}
        </div>
      </div>

      <div className="set-row">
        <div style={{ minWidth: 0 }}>
          <div className="set-label mcp-warn-head">
            <TriangleAlert size={13} strokeWidth={1.75} /> {tr('数据与权限')}
          </div>
          <div className="set-desc">
            {tr('AI 读写的就是')} <span className="mono mcp-path">{info.root}</span> {tr('里的 Markdown，改动同样会被 Git 同步。')}
            <b>{tr('密码锁只挡界面')}</b>{tr('，MCP 直接读文件——笔记本机别长期放着不管。')}
          </div>
        </div>
        {isDesktop && (
          <div className="set-actions">
            <button
              className="btn btn-secondary"
              onClick={() => {
                const bridge = desktop();
                if (!bridge?.openMcpFolder) return;
                void bridge.openMcpFolder().then((res) => {
                  if (res !== true) toast(tr('打不开脚本文件夹'));
                });
              }}
            >
              <FolderOpen size={14} /> {tr('脚本文件夹')}
            </button>
          </div>
        )}
      </div>
    </>
  );
}
