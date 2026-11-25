/**
 * 七牛云直传：图片 / 附件先传到对象存储，仓库里只留公网链接。
 *
 * - 配置默认只存在本机 localStorage；用户在设置里明确开启后才由 keySync 写进私有仓库；
 * - 上传令牌用 WebCrypto 现场签 HMAC-SHA1，不需要额外依赖，也没有后端；
 * - 没配置时调用方继续把文件写进 Git，并可通过 promptQiniuOnce 弹一次提示。
 */

export interface QiniuConfig {
  /** 七牛「密钥管理」里的 AccessKey */
  accessKey: string;
  /** 七牛「密钥管理」里的 SecretKey；只存本机 */
  secretKey: string;
  /** 存储空间名 */
  bucket: string;
  /** 绑定到存储空间的访问域名，例如 https://cdn.example.com */
  domain: string;
}

interface QiniuConfigRaw {
  accessKey?: unknown;
  secretKey?: unknown;
  bucket?: unknown;
  domain?: unknown;
}

const CONFIG_KEY = 'glimnote.qiniu.config';
/** 云存储总开关：关掉后新图片 / 附件退回本机仓库，但配置本身保留 */
const ENABLED_KEY = 'glimnote.qiniu.enabled';
/** 配置最后改动时间：开启「同步密钥到云端」后用来判断哪台设备的更新 */
export const QINIU_CONFIG_AT = 'glimnote.qiniu.configAt';
const SNOOZE_KEY = 'glimnote.qiniu.promptSnoozeUntil';
export const QINIU_PROMPT_EVENT = 'glimnote:qiniu-prompt';
export const QINIU_CONFIG_EVENT = 'glimnote:qiniu-config';
export const QINIU_SECTION_EVENT = 'glimnote:qiniu-section';
/** 「近期不提醒」的期限 */
export const QINIU_SNOOZE_DAYS = 7;

/**
 * 两次提示之间的最短间隔：同一批粘贴会连续存多张图片，只弹一次；
 * 但没有勾「近期不提醒」时，下次再插入图片仍会重新提示。
 */
const PROMPT_COOLDOWN_MS = 3000;
let lastPromptAt = 0;
/** 「去配置」的滚动请求：事件可能先于设置弹窗挂载，用标记兜底 */
let sectionJump = false;

export function requestQiniuSectionJump() {
  sectionJump = true;
  window.dispatchEvent(new CustomEvent(QINIU_SECTION_EVENT));
}

export function consumeQiniuSectionJump() {
  const jump = sectionJump;
  sectionJump = false;
  return jump;
}

/** 七牛自动分配的测试域名后缀：30 天回收，而且不支持 HTTPS */
const QINIU_TEST_DOMAIN = /(^|\.)(clouddn\.com|qiniucdn\.com|qiniudn\.com|qnssl\.com|qbox\.me)$/i;

/** 判断是不是七牛测试域名（允许带 http/https 前缀和路径） */
export function isQiniuTestDomain(input: string) {
  const host = input
    .trim()
    .replace(/^https?:\/\//i, '')
    .split('/')[0]
    .toLowerCase();
  return Boolean(host) && QINIU_TEST_DOMAIN.test(host);
}

/** 补全协议、去掉结尾斜杠，避免拼出 // 或缺少 https */
export function normalizeQiniuDomain(input: string) {
  let domain = input.trim();
  if (!domain) return '';
  if (!/^https?:\/\//i.test(domain)) {
    // 测试域名不支持 HTTPS，默认补 http；自己绑定的域名默认走 https
    domain = `${isQiniuTestDomain(domain) ? 'http' : 'https'}://${domain}`;
  }
  return domain.replace(/\/+$/, '');
}

export type QiniuProtocol = 'http' | 'https';

/**
 * 界面上的访问域名拆成「协议下拉框 + 主机名输入框」。
 * 默认 http：绝大多数用户不会去配证书，http 直接能用；
 * 已经配好 HTTPS 的，保存下来的 https 会被原样识别。
 */
export function splitQiniuDomain(input: string): { protocol: QiniuProtocol; host: string } {
  const raw = input.trim();
  const match = /^(https?):\/\/(.*)$/i.exec(raw);
  if (match) {
    return {
      protocol: match[1].toLowerCase() === 'https' ? 'https' : 'http',
      host: match[2].trim(),
    };
  }
  return { protocol: 'http', host: raw };
}

/** 读取已保存的配置，不看开关：设置页表单、密钥同步都要能看到它 */
export function readQiniuConfig(): QiniuConfig | null {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as QiniuConfigRaw;
    const cfg: QiniuConfig = {
      accessKey: String(parsed.accessKey ?? '').trim(),
      secretKey: String(parsed.secretKey ?? '').trim(),
      bucket: String(parsed.bucket ?? '').trim(),
      domain: normalizeQiniuDomain(String(parsed.domain ?? '')),
    };
    if (!cfg.accessKey || !cfg.secretKey || !cfg.bucket || !cfg.domain) return null;
    return cfg;
  } catch {
    return null;
  }
}

/**
 * 云存储总开关。老版本没有这个记录：只要配过就算开启，升级后行为不变。
 */
export function isQiniuEnabled() {
  if (!readQiniuConfig()) return false;
  return localStorage.getItem(ENABLED_KEY) !== '0';
}

/** 只切开关，不动配置：关掉后随时可以打开继续用 */
export function setQiniuEnabled(on: boolean) {
  localStorage.setItem(ENABLED_KEY, on ? '1' : '0');
  window.dispatchEvent(new CustomEvent(QINIU_CONFIG_EVENT));
}

/**
 * 插入图片 / 上传前统一用这个：开关关掉时返回 null，
 * 调用方会当作「没配置」，自动退回本机仓库存储。
 */
export function loadQiniuConfig(): QiniuConfig | null {
  return isQiniuEnabled() ? readQiniuConfig() : null;
}

export function isQiniuConfigured() {
  return Boolean(readQiniuConfig());
}

export function saveQiniuConfig(input: QiniuConfig): QiniuConfig {
  const cfg: QiniuConfig = {
    accessKey: input.accessKey.trim(),
    secretKey: input.secretKey.trim(),
    bucket: input.bucket.trim(),
    domain: normalizeQiniuDomain(input.domain),
  };
  localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
  localStorage.setItem(QINIU_CONFIG_AT, new Date().toISOString());
  window.dispatchEvent(new CustomEvent(QINIU_CONFIG_EVENT));
  return cfg;
}

export function clearQiniuConfig() {
  localStorage.removeItem(CONFIG_KEY);
  localStorage.removeItem(QINIU_CONFIG_AT);
  localStorage.removeItem(ENABLED_KEY);
  window.dispatchEvent(new CustomEvent(QINIU_CONFIG_EVENT));
}

/* ---------------- 「近期不提醒」 ---------------- */

export function qiniuPromptSnoozed(now = Date.now()) {
  const until = Number(localStorage.getItem(SNOOZE_KEY) || 0);
  return Number.isFinite(until) && until > now;
}

export function snoozeQiniuPrompt(days = QINIU_SNOOZE_DAYS) {
  const until = Date.now() + Math.max(1, days) * 24 * 60 * 60 * 1000;
  localStorage.setItem(SNOOZE_KEY, String(until));
}

/**
 * 没配七牛云、也没在「近期不提醒」期内时，通知界面弹说明。
 * 只有勾了「近期不提醒」才会安静一段时间；没勾的话下次插入图片还会提醒。
 */
export function promptQiniuOnce() {
  // 配过但主动关掉开关的，算用户已经做过选择，不再追着提示
  if (readQiniuConfig()) return;
  if (qiniuPromptSnoozed()) return;
  const now = Date.now();
  if (now - lastPromptAt < PROMPT_COOLDOWN_MS) return;
  lastPromptAt = now;
  window.dispatchEvent(new CustomEvent(QINIU_PROMPT_EVENT));
}

export function onQiniuPrompt(cb: () => void) {
  const handler = () => cb();
  window.addEventListener(QINIU_PROMPT_EVENT, handler);
  return () => window.removeEventListener(QINIU_PROMPT_EVENT, handler);
}

/* ---------------- 上传 ---------------- */

/**
 * 七牛的 URL 安全 Base64：只把 + / 换成 - _，末尾的 = 按官方示例保留。
 * 之前顺手把 = 去掉了，凭证可能被判成 bad token。
 */
function base64Url(bytes: Uint8Array) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_');
}

/** 七牛上传令牌：AccessKey:urlsafe(HMAC-SHA1(SecretKey, policy)):policy */
async function uploadToken(cfg: QiniuConfig) {
  // crypto.subtle 只在安全上下文可用（https / localhost / 桌面端）。
  // 用明文 http 打开网页版时提前给个能看懂的提示，而不是 undefined 报错。
  if (!globalThis.crypto?.subtle) {
    throw new Error('当前页面不是安全上下文，请用 https 或桌面端打开后再上传');
  }
  // 从控制台复制密钥时容易带上首尾空格或换行；签名前统一去掉，
  // 否则七牛只会回一个含糊的 bad token。
  const accessKey = cfg.accessKey.trim();
  const secretKey = cfg.secretKey.trim();
  const bucket = cfg.bucket.trim();
  if (!accessKey || !secretKey || !bucket) {
    throw new Error('AccessKey、SecretKey 和存储空间都要填写');
  }
  const policy = JSON.stringify({
    // 只给这个 bucket 的新增权限，够插入图片用
    scope: bucket,
    deadline: Math.floor(Date.now() / 1000) + 60 * 60,
  });
  const encodedPolicy = base64Url(new TextEncoder().encode(policy));
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secretKey),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(encodedPolicy));
  return `${accessKey}:${base64Url(new Uint8Array(signature))}:${encodedPolicy}`;
}

/** 把七牛返回的英文错误码翻译成能照着改的提示 */
function describeUploadError(reason: string, cfg: QiniuConfig) {
  const bucket = cfg.bucket.trim();
  if (/bad token/i.test(reason)) {
    return `密钥或存储空间对不上（bad token）。当前空间是「${bucket}」，请确认：空间名和七牛控制台完全一致；AK 和 SK 是同一对密钥；粘贴时没有多余的空格或换行。`;
  }
  if (/out of date|expired/i.test(reason)) {
    return '上传凭证已过期：请把电脑的系统时间校准后再试';
  }
  if (/no such bucket|bucket not found/i.test(reason)) {
    return `找不到存储空间「${bucket}」：请核对空间名是否和控制台一致`;
  }
  return reason;
}

/** 拼公网地址；key 里可能有中文，逐段编码，括号也转义成 Markdown 链接不会断的形式 */
export function qiniuPublicUrl(cfg: QiniuConfig, key: string) {
  const path = key
    .split('/')
    .map((part) => encodeURIComponent(part).replace(/\(/g, '%28').replace(/\)/g, '%29'))
    .join('/');
  return `${cfg.domain}/${path}`;
}

/* ---------------- 上传节点 ---------------- */

/**
 * upload.qiniup.com 是七牛的「自动区域」入口，多数空间能直接找到；
 * 少数空间（尤其早期创建的）会返回 incorrect region，要求改用 up-z0 / up-z2 这类节点。
 * 这里把每个存储空间用过的节点记在本机，下次直接命中，不再先失败一次。
 */
const UPLOAD_HOST_KEY = 'glimnote.qiniu.uploadHost';
const DEFAULT_UPLOAD_HOST = 'upload.qiniup.com';

function uploadHostFor(bucket: string) {
  try {
    const raw = localStorage.getItem(UPLOAD_HOST_KEY);
    if (!raw) return DEFAULT_UPLOAD_HOST;
    const rec = JSON.parse(raw) as Record<string, unknown>;
    const host = String(rec[bucket] ?? '').trim().toLowerCase();
    return /^[a-z0-9-]+(\.[a-z0-9-]+)*\.qiniup\.com$/.test(host) ? host : DEFAULT_UPLOAD_HOST;
  } catch {
    return DEFAULT_UPLOAD_HOST;
  }
}

function rememberUploadHost(bucket: string, host: string) {
  try {
    const raw = localStorage.getItem(UPLOAD_HOST_KEY);
    const rec = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    rec[bucket] = host;
    localStorage.setItem(UPLOAD_HOST_KEY, JSON.stringify(rec));
  } catch {
    /* 隐私模式写不进去就每次重试，不影响上传 */
  }
}

/** 从「please use [up-z2.qiniup.com]」里取出七牛建议的节点 */
function suggestedHost(reason: string) {
  const m = /please use \[?([a-z0-9-]+(?:\.[a-z0-9-]+)*\.qiniup\.com)/i.exec(reason);
  return m ? m[1].toLowerCase() : '';
}

/**
 * 上传一个文件，成功返回可直接写进 Markdown 的公网地址。
 * key 由调用方决定（和存进仓库时用同一套年 / 月 / 哈希命名，方便排查）。
 */
export async function uploadQiniuFile(file: File, cfg: QiniuConfig, key: string): Promise<string> {
  const token = await uploadToken(cfg);
  const bucket = cfg.bucket.trim();
  let host = uploadHostFor(bucket);
  // 所有文件统一放在存储空间的 glimnote/ 目录下，避免和空间里的其它内容混在一起
  const objectKey = key.replace(/^\/+/, '').startsWith('glimnote/')
    ? key.replace(/^\/+/, '')
    : `glimnote/${key.replace(/^\/+/, '')}`;

  let res: Response | null = null;
  let data: { key?: unknown; error?: unknown } | null = null;
  // 最多两次：第一次失败且七牛指明了正确区域时，换节点重传一次
  for (let attempt = 0; ; attempt += 1) {
    const form = new FormData();
    form.append('token', token);
    form.append('key', objectKey);
    form.append('file', file, file.name || 'file');
    try {
      res = await fetch(`https://${host}`, { method: 'POST', body: form });
    } catch {
      // fetch 报网络错误时，浏览器控制台看不到七牛的返回，
      // 最常见的原因是存储空间的跨域设置没放行 POST，所以一起提示出来
      throw new Error('连不上七牛云：请检查网络，以及存储空间「跨域设置」是否允许 POST');
    }
    data = (await res.json().catch(() => null)) as { key?: unknown; error?: unknown } | null;
    const reason = data && typeof data.error === 'string' ? data.error : '';
    const next = !res.ok ? suggestedHost(reason) : '';
    if (next && next !== host && attempt === 0) {
      rememberUploadHost(bucket, next);
      host = next;
      continue;
    }
    break;
  }

  if (!res || !res.ok || !data || typeof data.key !== 'string') {
    const reason = data && typeof data.error === 'string' ? data.error : `HTTP ${res?.status ?? 0}`;
    throw new Error(describeUploadError(reason, cfg));
  }
  return qiniuPublicUrl(cfg, data.key);
}

/** 1×1 透明 PNG：测试连接时顺便验证访问域名能不能真的打开图片 */
const TEST_PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='),
  (c) => c.charCodeAt(0),
);

function probeImage(url: string): Promise<'ok' | 'fail' | 'timeout'> {
  return new Promise((resolve) => {
    const img = new Image();
    const timer = setTimeout(() => resolve('timeout'), 8000);
    img.onload = () => {
      clearTimeout(timer);
      resolve('ok');
    };
    img.onerror = () => {
      clearTimeout(timer);
      resolve('fail');
    };
    img.src = url;
  });
}

/**
 * 设置页「测试连接」：覆盖一个固定的小文件，不会在存储空间里越堆越多。
 * 上传成功不代表外链能打开，所以再按真实图片加载一次公网地址：
 * 私有空间、域名没绑定 / CNAME 没生效、域名没备案，都会在这里暴露出来。
 */
export async function testQiniuUpload(cfg: QiniuConfig) {
  const file = new File([TEST_PNG], 'glimnote-connect-test.png', { type: 'image/png' });
  const url = await uploadQiniuFile(file, cfg, 'glimnote/.connect-test.png');
  const opened = await probeImage(url);
  if (opened !== 'ok') {
    throw new Error(
      `上传成功，但公网地址打不开：${url}（${opened === 'timeout' ? '加载超时' : '图片加载失败'}）。请检查：存储空间是否设为公开；访问域名是否绑定到这个空间、CNAME 是否生效、域名是否已备案；域名只支持 HTTPS 时，请把上面的协议改成 https。`,
    );
  }
  return url;
}
