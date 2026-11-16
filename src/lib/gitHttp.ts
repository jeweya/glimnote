import type { GitHttpRequest, GitHttpResponse } from 'isomorphic-git';
import httpWeb from 'isomorphic-git/http/web';
import { log } from './log';
import { t } from './i18n';

/**
 * 渲染层 Git HTTP 客户端。
 *
 * 桌面端把请求交给主进程代发（window.glimnote.gitRequest）：Git 服务端不给
 * Access-Control-Allow-Origin，浏览器会直接丢掉响应，连接失败时只能看到
 * `Failed to fetch`，401 反而被误报成「网络不通」。主进程不受页面 CORS 约束，
 * 因此能拿到真实状态码。
 *
 * 网页版没有这个桥，只能退回浏览器 fetch；Gitee / GitCode / GitHub 的 Git 端点
 * 都不允许跨域，所以网页版本身无法完成云同步，由上层给出明确说明。
 */

interface BridgeRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  bodyBase64?: string;
}

interface BridgeResponse {
  url?: string;
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
  bodyBase64?: string;
  error?: string;
  message?: string;
}

type GitRequestBridge = (req: BridgeRequest) => Promise<BridgeResponse>;

function bridge(): GitRequestBridge | null {
  const api = (globalThis as unknown as { glimnote?: { gitRequest?: GitRequestBridge } }).glimnote;
  return api && typeof api.gitRequest === 'function' ? api.gitRequest : null;
}

/** 当前环境能否走主进程代理（桌面端为 true，网页版为 false） */
export function canProxyGit() {
  return Boolean(bridge());
}

/** 代理层错误：NETWORK=真的连不上；BLOCKED=请求被安全策略拦下；TOO_LARGE=数据超限 */
export class GitBridgeError extends Error {
  code: 'NETWORK' | 'BLOCKED' | 'TOO_LARGE';

  constructor(code: 'NETWORK' | 'BLOCKED' | 'TOO_LARGE', message: string) {
    super(message);
    this.code = code;
  }
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

function base64ToBytes(text: string) {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * 主进程需要完整一段 Buffer，而 isomorphic-git 传进来的 body 可能是
 * async iterator、普通数组，或单个 Uint8Array（clone 时就是 [packbuffer]）。
 */
async function collect(body: GitHttpRequest['body']) {
  if (!body) return null;
  const chunks: Uint8Array[] = [];
  const value = body as unknown;

  if (value instanceof Uint8Array) {
    chunks.push(value);
  } else if (typeof (value as { next?: unknown }).next === 'function') {
    const iter = value as AsyncIterableIterator<Uint8Array>;
    for (;;) {
      const { value: chunk, done } = await iter.next();
      if (chunk) chunks.push(chunk);
      if (done) break;
    }
  } else if (typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function') {
    for await (const chunk of value as AsyncIterable<Uint8Array>) chunks.push(chunk);
  } else {
    for (const chunk of value as Iterable<Uint8Array>) chunks.push(chunk);
  }

  let size = 0;
  for (const chunk of chunks) size += chunk.byteLength;
  const all = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return all;
}

/** 把整段响应包回成 isomorphic-git 需要的 async iterator */
function fromBytes(bytes: Uint8Array) {
  let queue: Uint8Array[] = [bytes];
  return {
    next() {
      return Promise.resolve({ done: queue.length === 0, value: queue.pop() });
    },
    return() {
      queue = [];
      return {};
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  } as AsyncIterableIterator<Uint8Array>;
}

async function request(req: GitHttpRequest): Promise<GitHttpResponse> {
  const send = bridge();
  const method = req.method || 'GET';
  // 网页版没有代理，只能走原生 fetch（会受跨域限制）
  if (!send) {
    log('git', 'warn', `网页直连 ${method} ${req.url}（受跨域限制）`);
    return httpWeb.request(req);
  }
  // 请求一发出就记一行：即使后面卡在代理之外，也能看出到底走到哪一步了
  log('git', 'info', `→ ${method} ${req.url}`);

  const body = await collect(req.body);
  let res: BridgeResponse;
  try {
    res = await send({
      url: req.url,
      method,
      headers: { ...(req.headers || {}) },
      bodyBase64: body ? bytesToBase64(body) : undefined,
    });
  } catch (e) {
    const msg = String((e as { message?: string } | null)?.message || e || '');
    log('git', 'error', `✕ ${method} ${req.url} · ${msg || '没有拿到响应'}`);
    // 旧版桌面端没有注册 git:request，会直接抛「No handler registered」
    if (/No handler registered|not registered/i.test(msg)) {
      throw new GitBridgeError('BLOCKED', t('桌面客户端版本过旧，缺少网络代理能力，请更新到最新版本后再连接。'));
    }
    throw new GitBridgeError('NETWORK', msg || t('网络请求失败'));
  }

  if (res.error) {
    log('git', 'error', `✕ ${method} ${req.url} · ${res.error}${res.message ? ` · ${res.message}` : ''}`);
    if (res.error === 'NETWORK') throw new GitBridgeError('NETWORK', res.message || t('网络请求失败'));
    if (res.error === 'TOO_LARGE') {
      throw new GitBridgeError('TOO_LARGE', t('一次同步的数据超过 128MB，请把大附件移出笔记仓库后再试。'));
    }
    throw new GitBridgeError('BLOCKED', t('Git 请求被安全策略拦截（{code}）', { code: res.error }));
  }
  log('git', 'info', `← ${res.status || 0} ${method} ${req.url}`);

  const bytes = res.bodyBase64 ? base64ToBytes(res.bodyBase64) : new Uint8Array(0);
  return {
    url: res.url || req.url,
    method,
    statusCode: res.status || 0,
    statusMessage: res.statusText || '',
    headers: res.headers || {},
    body: fromBytes(bytes),
  };
}

export const gitHttp = { request };
