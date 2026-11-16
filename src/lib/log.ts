/**
 * 轻量运行日志：只记录同步、连接、导入导出等关键事件，
 * 不记录笔记正文。导出前统一脱敏（Token、Authorization 等）。
 *
 * 桌面版同时会把同样的内容按天写进本机日志文件（electron/log-file.cjs），
 * 关掉应用也还在，方便事后排查；网页版没有文件系统，只能靠「导出日志」。
 */
import { desktop } from './desktop';

export type LogLevel = 'info' | 'warn' | 'error';

export interface LogEntry {
  t: string;
  level: LogLevel;
  scope: string;
  msg: string;
}

const KEY = 'glimnote.logs';
const MAX = 300;
// 攒一小会儿再写文件：一次同步会连着记十几条，逐条 IPC 没必要
const FILE_DELAY = 700;

let buffer: LogEntry[] | null = null;
let pending: string[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let sending = false;

function load(): LogEntry[] {
  if (buffer) return buffer;
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    buffer = Array.isArray(parsed) ? parsed : [];
  } catch {
    buffer = [];
  }
  return buffer;
}

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(buffer || []));
  } catch {
    /* 存储满时放弃缓存，不影响主流程 */
  }
}

function fileLine(entry: LogEntry) {
  return `${entry.t}  [${entry.level}]  ${entry.scope}: ${redact(entry.msg)}`;
}

function scheduleFile() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    void flushLogs();
  }, FILE_DELAY);
}

/** 把攒下的日志交给桌面端写入文件；失败就丢掉这一批，绝不打断主流程 */
export async function flushLogs() {
  if (!pending.length) return;
  const bridge = desktop();
  if (!bridge || typeof bridge.appendLog !== 'function') {
    pending = [];
    return;
  }
  if (sending) {
    scheduleFile();
    return;
  }
  sending = true;
  const chunk = pending.join('\n');
  pending = [];
  try {
    await bridge.appendLog(chunk);
  } catch {
    /* 写日志失败不影响笔记本身 */
  } finally {
    sending = false;
    if (pending.length) scheduleFile();
  }
}

export function log(scope: string, level: LogLevel, msg: string) {
  try {
    const entry: LogEntry = { t: new Date().toISOString(), level, scope, msg: String(msg).slice(0, 500) };
    const list = load();
    list.push(entry);
    if (list.length > MAX) list.splice(0, list.length - MAX);
    persist();
    pending.push(fileLine(entry));
    scheduleFile();
  } catch {
    /* 日志本身不能抛错 */
  }
}

/** 网页版没有文件可写时，把错误也留在控制台，方便开 DevTools 看 */
export function installLogCapture() {
  if (typeof window === 'undefined') return;
  window.addEventListener('error', (e) => {
    const file = e.filename ? String(e.filename).split(/[/\\]/).pop() : '';
    const where = file ? `（${file}:${e.lineno}）` : '';
    log('window', 'error', `${e.message || '资源加载失败'}${where}`);
  });
  window.addEventListener('unhandledrejection', (e) => {
    log('window', 'error', `未处理的异常：${errorText(e.reason)}`);
  });
  // 页面被关掉 / 切到后台前，尽量把缓冲区送出去
  window.addEventListener('pagehide', () => void flushLogs());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void flushLogs();
  });
}

export function errorText(e: unknown) {
  const anyE = e as { message?: string; code?: string };
  const msg = typeof anyE?.message === 'string' ? anyE.message : String(e);
  const code = anyE?.code ? `${anyE.code}: ` : '';
  return `${code}${msg}`.slice(0, 300);
}

export function redact(text: string) {
  return (
    text
      .replace(/([?&]access_token=)[^&\s]+/gi, '$1***')
      .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1***')
      // Git 的 basic 认证是 base64(用户名:令牌)，整段都得抹掉
      .replace(/(Basic\s+)[A-Za-z0-9+/=]{8,}/gi, '$1***')
      // Authorization: Basic xxx / token: ghp_xxx —— 认证方式保留，后面的凭证整段打码
      .replace(/((?:token|password|authorization|secret)\s*[:=]\s*)((?:basic|bearer|token)\s+)?[^\s,;]+/gi, '$1$2***')
      .replace(/\b(gh[pousr]_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,})\b/g, '***')
      .replace(/\b[0-9a-f]{40}\b/gi, (m) => `${m.slice(0, 4)}…`)
  );
}

export function logLines() {
  return load().map((e) => `${e.t}  [${e.level}]  ${e.scope}: ${e.msg}`);
}

export function buildDiagnostics(extra: Record<string, string | number | boolean | undefined>) {
  const rows = Object.entries(extra)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}: ${v}`);
  const text = [
    '萤光笔记 诊断日志',
    `生成时间: ${new Date().toLocaleString('zh-CN', { hour12: false })}`,
    ...rows,
    '',
    '--- 最近运行日志（最多 300 条） ---',
    ...logLines(),
    '',
  ].join('\n');
  return redact(text);
}
