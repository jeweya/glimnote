/**
 * 主进程 Git HTTP 代理。
 *
 * 为什么需要它：Git 的 smart HTTP 接口（/info/refs、/git-upload-pack、/git-receive-pack）
 * 在 Gitee、GitCode、GitHub 上都不返回 Access-Control-Allow-Origin。渲染进程里的
 * isomorphic-git 用 fetch 请求时，浏览器会先拦掉响应，JS 只能拿到 `TypeError: Failed to fetch`，
 * 于是 401、403、404 全都被误判成「网络不通」。代理放在主进程，走 Chromium 网络栈：
 * 不受页面 CORS 限制，并且能继承系统代理设置。
 *
 * 安全约束：
 * - 只允许 https，且主机名必须在白名单内（避免被当成任意 URL 的 SSRF 跳板）
 * - 只允许 GET / POST
 * - 不记录、不转发 Cookie；Authorization 仅随本次请求发送
 * - 超时 180 秒、响应上限 128MB
 */

const GIT_HOSTS = new Set([
  'github.com',
  'codeload.github.com',
  'objects.githubusercontent.com',
  'gitee.com',
  'gitcode.com',
]);

const MAX_BYTES = 128 * 1024 * 1024;
const TIMEOUT_MS = 180 * 1000;
// 这些头由网络栈自己决定，透传会与 fetch 冲突
const DROP_HEADERS = /^(host|connection|content-length|transfer-encoding)$/i;

function errorOf(e) {
  return String((e && e.message) || e || '未知错误').slice(0, 200);
}

/**
 * @param {typeof fetch} fetchImpl
 * @param {{url?: string, method?: string, headers?: Record<string, string>, bodyBase64?: string}} req
 */
async function gitRequest(fetchImpl, req) {
  const url = String((req && req.url) || '');
  let target;
  try {
    target = new URL(url);
  } catch {
    return { error: 'BAD_URL' };
  }
  if (target.protocol !== 'https:') return { error: 'BAD_URL' };
  if (!GIT_HOSTS.has(target.hostname)) return { error: 'HOST_BLOCKED' };

  const method = String((req && req.method) || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'POST') return { error: 'METHOD_BLOCKED' };

  const headers = {};
  for (const [key, value] of Object.entries((req && req.headers) || {})) {
    if (typeof value === 'string' && !DROP_HEADERS.test(key)) headers[key] = value;
  }
  const body = req && req.bodyBase64 ? Buffer.from(req.bodyBase64, 'base64') : undefined;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      method,
      headers,
      body,
      redirect: 'follow',
      signal: controller.signal,
    });
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > MAX_BYTES) return { error: 'TOO_LARGE' };
    const outHeaders = {};
    res.headers.forEach((value, key) => {
      outHeaders[key] = value;
    });
    return {
      url: res.url,
      status: res.status,
      statusText: res.statusText,
      headers: outHeaders,
      bodyBase64: bytes.toString('base64'),
    };
  } catch (e) {
    return { error: 'NETWORK', message: errorOf(e) };
  } finally {
    clearTimeout(timer);
  }
}

/** 只留 主机 + 路径，去掉查询串（可能带 access_token） */
function briefUrl(input) {
  try {
    const u = new URL(String(input || ''));
    return `${u.host}${u.pathname}`;
  } catch {
    return '(bad url)';
  }
}

/**
 * @param {import('electron').IpcMain} ipcMain
 * @param {{fetch: typeof fetch}} net
 * @param {(level: 'info'|'warn', msg: string) => void} [onLog] 把每次请求的结果写进日志文件
 */
function registerGitProxy(ipcMain, net, onLog) {
  ipcMain.handle('git:request', async (_event, req) => {
    const started = Date.now();
    const res = await gitRequest(net.fetch.bind(net), req);
    if (onLog) {
      const ms = Date.now() - started;
      const where = briefUrl(req && req.url);
      if (res && res.error)
        onLog('warn', `${where} → ${res.error}${res.message ? ` · ${res.message}` : ''}（${ms}ms）`);
      else onLog('info', `${where} → HTTP ${res && res.status}（${ms}ms）`);
    }
    return res;
  });
}

module.exports = { registerGitProxy, gitRequest, GIT_HOSTS };
