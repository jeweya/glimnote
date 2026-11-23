/**
 * AI 请求代理。
 *
 * 浏览器的 fetch 受同源策略限制：多数大模型接口（OpenAI、DeepSeek、智谱…）
 * 不会给桌面端页面返回允许跨域的响应头，直接请求只会拿到 `TypeError: Failed to fetch`，
 * 用户看到的就是「网络不通」，根本没法判断是地址错了、Key 错了还是跨域。
 * 这里由主进程用 Electron `net.fetch` 代发（自动继承系统代理），把状态码和正文原样带回，
 * 渲染进程就能给出「401 密钥不对」「404 地址不对」这类可执行提示。
 *
 * 只有主进程能读磁盘，所以接口地址允许用户自定义；仍然限制为 http/https，
 * 且默认只允许回环地址走明文 http，避免把 Key 发到不安全的地址上。
 */
const MAX_RESPONSE = 4 * 1024 * 1024; // 4MB：正常对话响应远小于此
const TIMEOUT_MS = 90_000;
// 生成整页应用可能要好几分钟，允许渲染层按请求放宽；上限 8 分钟
const MAX_TIMEOUT_MS = 8 * 60_000;

function assertUrl(raw) {
  let url;
  try {
    url = new URL(String(raw || ''));
  } catch {
    throw new Error('接口地址格式不正确，应以 https:// 开头');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('接口地址必须以 https:// 或 http:// 开头');
  }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
  if (url.protocol === 'http:' && !loopback) {
    throw new Error('出于安全考虑，非本机地址必须使用 https://');
  }
  return url;
}

function registerAiProxy(ipcMain, net, log = () => {}) {
  /** requestId → 正在进行的请求；渲染层点「停止生成」时按 id 中断 */
  const pending = new Map();

  ipcMain.handle('ai:abort', (_e, id) => {
    const key = String(id || '');
    const controller = pending.get(key);
    if (!controller) return false;
    pending.delete(key);
    try {
      controller.abort();
    } catch {
      /* 已经结束的请求忽略 */
    }
    log('info', `AI 请求已停止 · ${key}`);
    return true;
  });

  ipcMain.handle('ai:request', async (_e, req) => {
    const url = assertUrl(req && req.url);
    if (req.method && req.method !== 'POST') throw new Error('只支持 POST 请求');
    const started = Date.now();
    const requestId = String((req && req.id) || '');
    const wanted = Number(req && req.timeoutMs) || TIMEOUT_MS;
    const timeout = Math.min(Math.max(wanted, 10_000), MAX_TIMEOUT_MS);
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeout);
    if (requestId) pending.set(requestId, controller);
    try {
      const res = await net.fetch(url.toString(), {
        method: 'POST',
        headers: req.headers || {},
        body: typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {}),
        signal: controller.signal,
      });
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.byteLength > MAX_RESPONSE) throw new Error('模型返回的内容太大，请缩短输入后再试');
      const text = buf.toString('utf8');
      log(
        'info',
        `AI 请求 ${url.host}${url.pathname} → ${res.status} · ${Date.now() - started}ms · ${buf.byteLength}B`,
      );
      return { status: res.status, text };
    } catch (e) {
      if (e && e.name === 'AbortError') {
        // 超时和用户主动停止都会走到这里，分开报，别把「我停的」说成「超时」
        if (timedOut) {
          log('warn', `AI 请求超时：${url.host}`);
          throw new Error('模型响应超时，请稍后重试或换一个更快的模型');
        }
        throw new Error('已停止生成');
      }
      log('warn', `AI 请求失败 ${url.host}：${(e && e.message) || e}`);
      throw e;
    } finally {
      clearTimeout(timer);
      if (requestId) pending.delete(requestId);
    }
  });
}

/**
 * 群机器人 Webhook 代理：企业微信 / 飞书 / 钉钉的地址同样不带 CORS 头，
 * 网页里直接 fetch 会失败，所以桌面端统一由主进程代发。
 * 只允许 POST，按时长和响应体大小做上限，避免误填地址后挂住。
 */
function registerWebhookProxy(ipcMain, net, log = () => {}) {
  ipcMain.handle('webhook:send', async (_e, req) => {
    const url = assertUrl(req && req.url);
    if (req.method && req.method !== 'POST') throw new Error('通知只支持 POST 请求');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const res = await net.fetch(url.toString(), {
        method: 'POST',
        headers: req.headers || { 'Content-Type': 'application/json' },
        body: typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {}),
        signal: controller.signal,
      });
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.byteLength > 256 * 1024) throw new Error('通知接口返回内容异常，请检查 Webhook 地址');
      const text = buf.toString('utf8');
      log('info', `通知请求 ${url.host}${url.pathname} → ${res.status} · ${buf.byteLength}B`);
      return { status: res.status, text };
    } catch (e) {
      if (e && e.name === 'AbortError') {
        log('warn', `通知请求超时：${url.host}`);
        throw new Error('通知接口响应超时，请检查网络或 Webhook 地址');
      }
      log('warn', `通知请求失败 ${url.host}：${(e && e.message) || e}`);
      throw e;
    } finally {
      clearTimeout(timer);
    }
  });
}

/**
 * 节假日表代理：GitCode raw 同样不带 CORS 头，桌面端由主进程代发 GET。
 * 只允许拉取 GitCode 的 raw 文件，响应上限 1MB，避免被误用成通用下载器。
 */
function registerHolidayProxy(ipcMain, net, log = () => {}) {
  ipcMain.handle('holiday:fetch', async (_e, raw) => {
    const url = assertUrl(raw);
    if (url.hostname !== 'raw.gitcode.com') throw new Error('节假日数据只能从 GitCode 拉取');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    try {
      const res = await net.fetch(url.toString(), {
        headers: { Accept: 'application/json', 'User-Agent': 'Glimnote' },
        signal: controller.signal,
      });
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.byteLength > 1024 * 1024) throw new Error('节假日数据过大，已停止读取');
      const text = buf.toString('utf8');
      log('info', `节假日数据 ${url.host}${url.pathname} → ${res.status} · ${buf.byteLength}B`);
      return { status: res.status, text };
    } catch (e) {
      if (e && e.name === 'AbortError') {
        log('warn', `节假日数据请求超时：${url.host}`);
        throw new Error('节假日数据请求超时');
      }
      log('warn', `节假日数据请求失败 ${url.host}：${(e && e.message) || e}`);
      throw e;
    } finally {
      clearTimeout(timer);
    }
  });
}

module.exports = { registerAiProxy, registerWebhookProxy, registerHolidayProxy, assertUrl };
