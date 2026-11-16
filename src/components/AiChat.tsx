import { useEffect, useRef, useState } from 'react';
import {
  Check,
  Copy,
  Languages,
  List,
  Maximize2,
  Minimize2,
  PenLine,
  Quote,
  RefreshCw,
  RotateCcw,
  SendHorizontal,
  Settings2,
  Sparkles,
  StopCircle,
  Wand2,
  X,
} from 'lucide-react';
import {
  AiError,
  aiReady,
  loadAiConfig,
  writerChat,
  type WriterChatContext,
  type WriterChatTurn,
} from '../lib/ai';
import { errorText, log } from '../lib/log';
import { useApp } from '../store/app';
import { useT } from '../lib/i18n';
import { cn } from '../lib/utils';

/** 编辑器当前状态：位置按各自编辑器的坐标系来，聊天窗不关心底层是 TipTap 还是 CodeMirror */
export interface AiEditorState {
  docLength: number;
  selection: { from: number; to: number; text: string };
  cursor: number;
  noteText: string;
}

export interface AiApplyAnchor {
  from: number;
  to: number;
  /** 没有引用时插入到这里 */
  at: number;
  docLength: number;
}

export type AiApplyMode = 'replace' | 'insert';
export type AiApplyResult = 'ok' | 'stale' | 'no-editor';

type ChatScope = 'quote' | 'cursor' | 'note';

interface QuoteRef {
  text: string;
  from: number;
  to: number;
  docLength: number;
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: number;
  /** 这条消息对应的引用；助手回复沿用发起它的那条用户消息的引用 */
  quote?: QuoteRef;
  anchor: AiApplyAnchor;
  scope: ChatScope;
  loading?: boolean;
  error?: string;
}

interface ChatSession {
  messages: ChatMessage[];
  input: string;
  quote: QuoteRef | null;
  scope: ChatScope;
}

interface SendOptions {
  quote?: QuoteRef | null;
  scope?: ChatScope;
  /** 右键润色时已经拿到了选区快照，别因为面板抢焦点再读一次 */
  editor?: AiEditorState | null;
}

interface Props {
  noteId: string;
  title: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 右键「AI 润色选中文字」时递增，聊天窗据此自动发起一次润色 */
  polishSeq: number;
  readEditor: () => AiEditorState | null;
  applyText: (text: string, mode: AiApplyMode, anchor: AiApplyAnchor) => AiApplyResult;
  onOpenSettings: () => void;
  /** 目录面板展开时，聊天窗与悬浮按钮让开右侧这一栏 */
  tocOpen?: boolean;
}

const LARGE_KEY = 'glimnote.ai.chatLarge';

function uid(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function previewOf(text: string, max: number) {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

/**
 * 编辑区右下角的 AI 写作聊天窗。
 *
 * 设计取舍：
 * - 打开时如果正文里有选区，自动把它带成引用；之后仍然可以随时引用当前选区。
 * - 对话默认只发送「引用内容」，想让它读整篇必须手动切到「整篇笔记」，避免悄悄上传全文。
 * - AI 的输出先留在对话里，点「插入到光标 / 替换引用」才改正文；位置记的是发送时的快照，
 *   生成期间用户继续打字导致文档长度变化时，替换会要求重新选中，不会误删别的段落。
 * - 每个笔记的对话只放在内存里，切换笔记再回来还能接着聊，重启应用即清空。
 */
export function AiChat({
  noteId,
  title,
  open,
  onOpenChange,
  polishSeq,
  readEditor,
  applyText,
  onOpenSettings,
  tocOpen,
}: Props) {
  const t = useT();
  const toast = useApp((s) => s.toast);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [quote, setQuote] = useState<QuoteRef | null>(null);
  const [scope, setScope] = useState<ChatScope>('cursor');
  const [busy, setBusy] = useState(false);
  const [copiedId, setCopiedId] = useState('');
  const [large, setLarge] = useState(() => localStorage.getItem(LARGE_KEY) === '1');

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const readRef = useRef(readEditor);
  const sessionsRef = useRef(new Map<string, ChatSession>());
  const prevNoteRef = useRef(noteId);
  const wasOpenRef = useRef(false);
  const genRef = useRef(0);
  const sendRef = useRef<(text: string, opts?: SendOptions) => void>(() => {});
  const lastPolishRef = useRef(polishSeq);
  /** 上一次自动带进来的选区文本：只在选区真的变了才更新引用，避免轮询反复覆盖 */
  const syncedSelectionRef = useRef('');
  /** 点了引用右侧的 × 之后，同一段选区不要在下一轮轮询里又被自动加回来 */
  const dismissedSelectionRef = useRef('');

  readRef.current = readEditor;
  const messagesRef = useRef(messages);
  const inputValueRef = useRef(input);
  const quoteRef = useRef(quote);
  const scopeRef = useRef(scope);
  const busyRef = useRef(busy);
  messagesRef.current = messages;
  inputValueRef.current = input;
  quoteRef.current = quote;
  scopeRef.current = scope;
  busyRef.current = busy;

  const cfg = loadAiConfig();
  const ready = aiReady(cfg);

  // 切换笔记：先把上一段对话收进内存，再把这篇笔记上次的对话取出来
  useEffect(() => {
    const prev = prevNoteRef.current;
    if (prev === noteId) return;
    genRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    sessionsRef.current.set(prev, {
      messages: messagesRef.current.filter((m) => !m.loading),
      input: inputValueRef.current,
      quote: quoteRef.current,
      scope: scopeRef.current,
    });
    const next = sessionsRef.current.get(noteId);
    setMessages(next?.messages || []);
    setInput(next?.input || '');
    setQuote(next?.quote || null);
    setScope(next?.scope || 'cursor');
    setBusy(false);
    syncedSelectionRef.current = '';
    dismissedSelectionRef.current = '';
    prevNoteRef.current = noteId;
  }, [noteId]);

  // 面板打开期间轻量轮询选区：用户回正文选中一段，立即作为引用带进对话，
  // 不用再点刷新。同一段选区只自动带入一次——点了 × 移除后，不会被下一轮轮询
  // 又悄悄加回来；重新选一段（哪怕文字相同但位置变了）才会再次带入。
  useEffect(() => {
    if (!open) return;
    const tick = () => {
      const state = readRef.current();
      if (!state || !state.selection.text.trim()) return;
      const key = `${state.selection.from}:${state.selection.to}:${state.selection.text}`;
      if (key === syncedSelectionRef.current) return;
      syncedSelectionRef.current = key;
      if (key === dismissedSelectionRef.current) return;
      setQuote({
        text: state.selection.text,
        from: state.selection.from,
        to: state.selection.to,
        docLength: state.docLength,
      });
      setScope('quote');
    };
    tick();
    const timer = window.setInterval(tick, 400);
    return () => window.clearInterval(timer);
  }, [open, noteId]);

  // 打开时把当前选区带成引用；没有选区就沿用上次的引用
  useEffect(() => {
    if (open && !wasOpenRef.current) {
      const state = readRef.current();
      if (state && state.selection.text.trim()) {
        setQuote({
          text: state.selection.text,
          from: state.selection.from,
          to: state.selection.to,
          docLength: state.docLength,
        });
        setScope('quote');
        syncedSelectionRef.current = `${state.selection.from}:${state.selection.to}:${state.selection.text}`;
      }
      window.setTimeout(() => inputRef.current?.focus(), 30);
    }
    wasOpenRef.current = open;
  }, [open, noteId]);

  // 新消息或打开面板时滚到底部
  useEffect(() => {
    if (!open) return;
    const el = listRef.current;
    if (!el) return;
    const frame = window.requestAnimationFrame(() => {
      el.scrollTo({ top: el.scrollHeight, behavior: messages.length > 1 ? 'smooth' : 'auto' });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, messages]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onOpenChange(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onOpenChange]);

  const contextFor = (sc: ChatScope, state: AiEditorState): WriterChatContext => {
    if (sc === 'note') return { title, scope: 'note', text: state.noteText };
    if (sc === 'cursor') {
      const before = state.noteText.slice(0, state.cursor).slice(-4000);
      const after = state.noteText.slice(state.cursor, state.cursor + 1200);
      return { title, scope: 'cursor', text: `${before}${after}` };
    }
    return { title, scope: 'none' };
  };

  const toTurn = (message: ChatMessage): WriterChatTurn => {
    if (message.role === 'user' && message.quote?.text.trim()) {
      return {
        role: 'user',
        content: `${t('【引用内容】')}\n<<<\n${message.quote.text}\n>>>\n\n${message.text}`,
      };
    }
    return { role: message.role, content: message.text };
  };

  const runReply = async (assistantId: string, turns: WriterChatTurn[], context: WriterChatContext) => {
    const gen = ++genRef.current;
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    try {
      const reply = await writerChat(turns, context, controller.signal);
      if (gen !== genRef.current) return;
      setMessages((prev) =>
        prev.map((m) => (m.id === assistantId ? { ...m, text: reply, loading: false, error: '' } : m)),
      );
    } catch (e) {
      if (gen !== genRef.current) return;
      if (controller.signal.aborted) {
        setMessages((prev) => prev.filter((m) => m.id !== assistantId));
        return;
      }
      const message = e instanceof AiError ? e.message : errorText(e);
      setMessages((prev) =>
        prev.map((m) => (m.id === assistantId ? { ...m, loading: false, error: message } : m)),
      );
    } finally {
      if (gen === genRef.current) {
        setBusy(false);
        abortRef.current = null;
      }
    }
  };

  const send = (raw: string, options: SendOptions = {}) => {
    const body = raw.trim();
    if (!body || busyRef.current) return;
    const state = options.editor !== undefined ? options.editor : readRef.current();
    if (!state) {
      toast(t('先在正文里点一下要处理的位置'), 'warn');
      return;
    }
    if (!ready) {
      toast(t('先在设置里选好 AI 服务商并填写 Key'), 'warn');
      onOpenSettings();
      return;
    }

    const ref = options.quote !== undefined ? options.quote : quoteRef.current;
    let sc = options.scope ?? scopeRef.current;
    if (sc === 'quote' && !ref) sc = 'cursor';
    // 排查「引用没发出去」时，日志里能直接看到这一轮到底带了多少字的引用
    log('ai', 'info', `写作对话发送 · 引用 ${ref ? ref.text.trim().length : 0} 字 · 上下文 ${sc}`);
    const anchor: AiApplyAnchor = {
      from: ref?.from ?? state.selection.from,
      to: ref?.to ?? state.selection.to,
      at: ref ? ref.to : state.cursor,
      docLength: state.docLength,
    };

    const userMessage: ChatMessage = {
      id: uid('u'),
      role: 'user',
      text: body,
      createdAt: Date.now(),
      quote: ref || undefined,
      anchor,
      scope: sc,
    };
    const assistantId = uid('a');
    const assistantMessage: ChatMessage = {
      id: assistantId,
      role: 'assistant',
      text: '',
      createdAt: Date.now(),
      quote: ref || undefined,
      anchor,
      scope: sc,
      loading: true,
    };
    const history = [...messagesRef.current.filter((m) => !m.loading && !m.error), userMessage];
    setMessages([...messagesRef.current.filter((m) => !m.loading), userMessage, assistantMessage]);
    setInput('');
    window.setTimeout(() => inputRef.current?.focus(), 0);
    void runReply(assistantId, history.map(toTurn), contextFor(sc, state));
  };

  sendRef.current = send;

  // 右键菜单的「AI 润色选中文字」：打开面板并直接发出一次润色
  useEffect(() => {
    if (polishSeq === lastPolishRef.current) return;
    lastPolishRef.current = polishSeq;
    if (!polishSeq) return;
    const state = readRef.current();
    if (!state) return;
    if (!state.selection.text.trim()) {
      toast(t('先选中要润色的文字，再点润色'), 'warn');
      return;
    }
    const ref: QuoteRef = {
      text: state.selection.text,
      from: state.selection.from,
      to: state.selection.to,
      docLength: state.docLength,
    };
    setQuote(ref);
    setScope('quote');
    sendRef.current(t('请润色引用的这段文字：保持原意，让表达更自然、准确，标点规范；直接给出润色后的正文。'), {
      quote: ref,
      scope: 'quote',
      editor: state,
    });
  }, [polishSeq, t, toast]);

  // 引用右侧的 × 是「彻底删掉这条引用」：不只是隐藏，也不会在轮询下一拍
  // 因为正文里还选着同一段文字就又被带回来。
  const removeQuote = () => {
    const state = readRef.current();
    if (state) {
      dismissedSelectionRef.current = `${state.selection.from}:${state.selection.to}:${state.selection.text}`;
    }
    setQuote(null);
    setScope((current) => (current === 'quote' ? 'cursor' : current));
  };

  const quick = (kind: 'polish' | 'continue' | 'summary' | 'translate') => {
    const state = readRef.current();
    if (!state) {
      toast(t('先在正文里点一下要处理的位置'), 'warn');
      return;
    }
    const current = quoteRef.current;
    if (kind === 'polish') {
      if (!state.selection.text.trim() && !current) {
        toast(t('先选中要润色的文字，再点润色'), 'warn');
        return;
      }
      const ref = state.selection.text.trim()
        ? {
            text: state.selection.text,
            from: state.selection.from,
            to: state.selection.to,
            docLength: state.docLength,
          }
        : current;
      if (!ref) return;
      setQuote(ref);
      setScope('quote');
      send(t('请润色引用的这段文字：保持原意，让表达更自然、准确，标点规范；直接给出润色后的正文。'), {
        quote: ref,
        scope: 'quote',
        editor: state,
      });
      return;
    }
    if (kind === 'continue') {
      send(t('请接着光标前的正文继续写，保持同样的语气和节奏；直接给出续写内容。'), {
        scope: 'cursor',
        editor: state,
      });
      return;
    }
    if (kind === 'summary') {
      send(t('请总结这篇笔记的要点，分条列出，保留关键信息和数字。'), { scope: 'note', editor: state });
      return;
    }
    if (state.selection.text.trim()) {
      const ref = {
        text: state.selection.text,
        from: state.selection.from,
        to: state.selection.to,
        docLength: state.docLength,
      };
      setQuote(ref);
      setScope('quote');
      send(t('请把引用的内容翻译成英文，保留原有结构和 Markdown 格式。'), {
        quote: ref,
        scope: 'quote',
        editor: state,
      });
      return;
    }
    send(t('请把这篇笔记翻译成英文，保留原有结构和 Markdown 格式。'), { scope: 'note', editor: state });
  };

  const stop = () => {
    genRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    setBusy(false);
    setMessages((prev) => prev.filter((m) => !m.loading));
  };

  const resetChat = () => {
    stop();
    setMessages([]);
    setInput('');
    setQuote(null);
    setScope('cursor');
  };

  const retry = (message: ChatMessage) => {
    const index = messages.findIndex((m) => m.id === message.id);
    if (index < 1) return;
    const userMessage = messages[index - 1];
    if (!userMessage || userMessage.role !== 'user') return;
    const state = readRef.current();
    if (!state) {
      toast(t('先在正文里点一下要处理的位置'), 'warn');
      return;
    }
    if (!ready) {
      toast(t('先在设置里选好 AI 服务商并填写 Key'), 'warn');
      onOpenSettings();
      return;
    }
    const history = messages.slice(0, index).filter((m) => !m.loading && !m.error);
    setMessages((prev) =>
      prev.map((m) => (m.id === message.id ? { ...m, text: '', error: '', loading: true } : m)),
    );
    // 重试时用当前编辑器位置重算上下文；消息里保存的引用仍然随用户消息发送
    setMessages((prev) => {
      const copy = [...prev];
      const i = copy.findIndex((m) => m.id === message.id);
      if (i >= 0) {
        copy[i] = {
          ...copy[i],
          anchor: {
            from: copy[i].quote?.from ?? state.selection.from,
            to: copy[i].quote?.to ?? state.selection.to,
            at: copy[i].quote ? copy[i].quote.to : state.cursor,
            docLength: state.docLength,
          },
        };
      }
      return copy;
    });
    void runReply(message.id, history.map(toTurn), contextFor(message.scope, state));
  };

  const apply = (message: ChatMessage, mode: AiApplyMode) => {
    if (!message.text.trim()) return;
    const result = applyText(message.text, mode, message.anchor);
    if (result === 'ok') {
      toast(mode === 'replace' ? t('已替换引用的文字') : t('已插入到光标位置'), 'success');
      return;
    }
    toast(
      result === 'stale'
        ? t('原文已改动，请重新选中要替换的内容')
        : t('编辑器已关闭，请重新打开这篇笔记'),
      'warn',
    );
  };

  const copy = async (message: ChatMessage) => {
    try {
      await navigator.clipboard.writeText(message.text);
      setCopiedId(message.id);
      window.setTimeout(() => setCopiedId((id) => (id === message.id ? '' : id)), 1600);
    } catch {
      toast(t('没能写入剪贴板，请手动选中复制'), 'warn');
    }
  };

  const toggleLarge = () => {
    setLarge((value) => {
      const next = !value;
      localStorage.setItem(LARGE_KEY, next ? '1' : '0');
      return next;
    });
  };

  if (!open) {
    return (
      <button className={cn('ai-fab', tocOpen && 'toc-shift')} onClick={() => onOpenChange(true)} aria-label={t('AI 写作助手')} title={t('AI 写作助手')}>
        <Sparkles size={17} strokeWidth={1.9} />
        <span>{t('AI 写作')}</span>
        {messages.length > 0 && <i className="ai-fab-dot" aria-hidden="true" />}
      </button>
    );
  }

  const lastAssistantId = [...messages].reverse().find((m) => m.role === 'assistant')?.id;
  const quoteLength = quote ? quote.text.trim().length : 0;

  return (
    <div className={cn('ai-chat-panel', large && 'large', tocOpen && 'toc-shift')} role="dialog" aria-label={t('AI 写作助手')}>
      <div className="ai-chat-head">
        <div className="ai-chat-title">
          <span className="ai-chat-mark">
            <Sparkles size={15} strokeWidth={1.9} />
          </span>
          <div>
            <strong>{t('AI 写作助手')}</strong>
            <span title={title}>{ready ? cfg.model : t('未配置模型')}</span>
          </div>
        </div>
        <div className="ai-chat-head-actions">
          {messages.length > 0 && (
            <button className="icon-btn" onClick={resetChat} title={t('新对话')} aria-label={t('新对话')}>
              <RotateCcw size={14} />
            </button>
          )}
          <button
            className="icon-btn"
            onClick={onOpenSettings}
            title={t('AI 设置')}
            aria-label={t('AI 设置')}
          >
            <Settings2 size={14} />
          </button>
          <button
            className="icon-btn"
            onClick={toggleLarge}
            title={large ? t('还原大小') : t('放大')}
            aria-label={large ? t('还原大小') : t('放大')}
          >
            {large ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
          <button
            className="icon-btn"
            onClick={() => onOpenChange(false)}
            title={t('收起')}
            aria-label={t('收起')}
          >
            <X size={14} />
          </button>
        </div>
      </div>

      <div className="ai-chat-list" ref={listRef}>
        {messages.length === 0 ? (
          <div className="ai-chat-empty">
            <span className="ai-chat-empty-icon">
              <Sparkles size={20} strokeWidth={1.8} />
            </span>
            <h4>{t('和 AI 一起写')}</h4>
            <p>
              {t('选中正文里的文字再打开，会自动作为引用带进对话；也可以直接提问或让它改写、续写。')}
            </p>
            {ready ? (
              <>
                <div className="ai-chat-quicks">
                  <button onClick={() => quick('polish')}>
                    <Wand2 size={15} strokeWidth={1.8} />
                    <span>{t('润色')}</span>
                    <em>{t('引用或选中的文字')}</em>
                  </button>
                  <button onClick={() => quick('continue')}>
                    <PenLine size={15} strokeWidth={1.8} />
                    <span>{t('续写')}</span>
                    <em>{t('从光标处接着写')}</em>
                  </button>
                  <button onClick={() => quick('summary')}>
                    <List size={15} strokeWidth={1.8} />
                    <span>{t('总结全文')}</span>
                    <em>{t('提炼要点')}</em>
                  </button>
                  <button onClick={() => quick('translate')}>
                    <Languages size={15} strokeWidth={1.8} />
                    <span>{t('翻译')}</span>
                    <em>{t('引用或整篇')}</em>
                  </button>
                </div>
                <p className="ai-chat-privacy">
                  {t('默认只发送引用内容；需要时再切到「整篇笔记」。')}
                </p>
              </>
            ) : (
              <button className="btn btn-primary" onClick={onOpenSettings}>
                <Settings2 size={14} /> {t('去设置 AI 模型')}
              </button>
            )}
          </div>
        ) : (
          messages.map((message) => {
            const isLastAssistant = message.id === lastAssistantId;
            return (
              <div key={message.id} className={cn('ai-chat-msg', message.role)}>
                <span className="ai-chat-avatar" aria-hidden="true">
                  {message.role === 'user' ? t('你') : <Sparkles size={13} strokeWidth={2} />}
                </span>
                <div className="ai-chat-bubble">
                  {message.quote && (
                    <div className="ai-chat-msg-quote" title={message.quote.text}>
                      <Quote size={11} strokeWidth={2} />
                      <span>{previewOf(message.quote.text, 90)}</span>
                      <em>{t('{n} 字', { n: message.quote.text.trim().length })}</em>
                    </div>
                  )}
                  {message.loading ? (
                    <div className="ai-chat-typing" aria-label={t('正在思考…')}>
                      <i />
                      <i />
                      <i />
                      <span>{t('正在思考…')}</span>
                    </div>
                  ) : message.error ? (
                    <div className="ai-chat-error">
                      <span>{message.error}</span>
                    </div>
                  ) : (
                    <div className="ai-chat-text">{message.text}</div>
                  )}
                  {message.role === 'assistant' && !message.loading && message.text && (
                    <div className="ai-chat-actions">
                      <button onClick={() => void copy(message)}>
                        {copiedId === message.id ? <Check size={12} /> : <Copy size={12} />}
                        {copiedId === message.id ? t('已复制') : t('复制')}
                      </button>
                      <button onClick={() => apply(message, 'insert')}>
                        <CornerInsertIcon />
                        {t('插入到光标')}
                      </button>
                      {message.quote && (
                        <button onClick={() => apply(message, 'replace')}>
                          <RefreshCw size={12} />
                          {t('替换引用')}
                        </button>
                      )}
                      {isLastAssistant && (
                        <button onClick={() => retry(message)} title={t('重新生成这条回复')}>
                          <RotateCcw size={12} />
                          {t('重试')}
                        </button>
                      )}
                    </div>
                  )}
                  {message.error && isLastAssistant && (
                    <div className="ai-chat-actions">
                      <button onClick={() => retry(message)}>
                        <RotateCcw size={12} /> {t('重试')}
                      </button>
                      {!ready && (
                        <button onClick={onOpenSettings}>
                          <Settings2 size={12} /> {t('AI 设置')}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      <div className="ai-chat-composer">
        {quote && (
          <div className="ai-chat-quote">
            <Quote size={12} strokeWidth={2.1} />
            <div>
              <span title={quote.text}>{previewOf(quote.text, 120)}</span>
              <em>{t('{n} 字', { n: quoteLength })}</em>
            </div>
            <button
              className="icon-btn"
              onClick={removeQuote}
              title={t('删除这条引用')}
              aria-label={t('删除这条引用')}
            >
              <X size={12} />
            </button>
          </div>
        )}

        <textarea
          ref={inputRef}
          className="ai-chat-input"
          rows={2}
          value={input}
          spellCheck={false}
          placeholder={
            quote
              ? t('想让我怎么改这段引用？也可以直接问…')
              : t('问点什么，或让我改写、续写这篇笔记…')
          }
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
            event.preventDefault();
            send(input);
          }}
          aria-label={t('给 AI 发消息')}
        />

        <div className="ai-chat-foot">
          <div className="ai-chat-scope" role="group" aria-label={t('发给 AI 的上下文')}>
            {quote && (
              <button
                type="button"
                className={cn(scope === 'quote' && 'on')}
                onClick={() => setScope('quote')}
                title={t('只发送引用的内容')}
              >
                {t('仅引用')}
              </button>
            )}
            <button
              type="button"
              className={cn(scope === 'cursor' && 'on')}
              onClick={() => setScope('cursor')}
              title={t('发送光标附近的一段正文')}
            >
              {t('光标附近')}
            </button>
            <button
              type="button"
              className={cn(scope === 'note' && 'on')}
              onClick={() => setScope('note')}
              title={t('发送整篇笔记（过长会截断）')}
            >
              {t('整篇笔记')}
            </button>
          </div>
          <div className="ai-chat-send-wrap">
            <span className="ai-chat-kbd">{t('Enter 发送 · Shift+Enter 换行')}</span>
            {busy ? (
              <button
                type="button"
                className="ai-chat-send stop"
                onClick={stop}
                title={t('停止生成')}
                aria-label={t('停止生成')}
              >
                <StopCircle size={15} />
              </button>
            ) : (
              <button
                type="button"
                className="ai-chat-send"
                onClick={() => send(input)}
                disabled={!input.trim()}
                title={t('发送')}
                aria-label={t('发送')}
              >
                <SendHorizontal size={15} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** 插入光标的小图标：lucide 的 CornerDownLeft 在 12px 下太细，单画一条下行箭头 */
function CornerInsertIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M5 4v7a3 3 0 0 0 3 3h11" strokeLinecap="round" strokeLinejoin="round" />
      <path d="m15 10 4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
