/**
 * AI 小应用（docs/15）。
 *
 * 应用就是一个自包含 HTML + 一份元数据，放在仓库的 apps/<id>/ 里，
 * 跟随 Git 同步；历史版本放在 .glimnote/history/apps/（不参与同步）。
 *
 * 生成的 HTML 按不可信代码处理：运行时用无同源权限的 iframe + CSP 隔离，
 * 保存前再做一次静态检查，避免把外部脚本、联网请求或宿主访问写进仓库。
 */
import {
  AiError,
  COMPACT_APP_SUFFIX,
  chatCompleteDetailed,
  loadAiConfig,
  loadAiPrompts,
  reasoningTokens,
  type ChatTurn,
} from './ai';
import { listFiles, readText, removePath, writeText } from './storage';
import { ROOT } from './storage';
import { downloadText } from './utils';
import { APP_BRIDGE_SCRIPT, APP_PREVIEW_BRIDGE_SCRIPT } from './appBridge';

export const APPS_DIR = `${ROOT}/apps`;
export const APP_HISTORY = `${ROOT}/.glimnote/history/apps`;
export const MAX_APPS = 50;
export const MAX_HTML_BYTES = 200 * 1024;
export const MAX_VERSIONS = 10;

/**
 * 应用数据：apps/<id>/data.json，跟随 Git 同步。
 * 单值上限只为了避免某一次写入把界面卡住，总量上限保证仓库体积可控。
 */
export const MAX_APP_DATA_BYTES = 512 * 1024;
export const MAX_APP_DATA_VALUE_BYTES = 128 * 1024;
export const MAX_APP_DATA_KEYS = 200;

export const APP_COLORS = ['green', 'blue', 'amber', 'red', 'purple', 'gray'] as const;
export type AppColor = (typeof APP_COLORS)[number];

/** 应用来源：应用市场、AI 现场生成、从外部导入，用于首页选择器按来源筛选 */
export const APP_SOURCES = ['market', 'ai', 'import'] as const;
export type AppSource = (typeof APP_SOURCES)[number];

export interface AppMeta {
  v: number;
  id: string;
  name: string;
  description: string;
  icon: string;
  color: AppColor;
  version: number;
  model: string;
  /** 应用市场模板 id：从市场装的应用记下来，避免同一个模板被重复安装 */
  template?: string;
  /** 应用来源；旧数据没有这个字段，读取时按 template 推断（见 normalizeMeta） */
  source?: AppSource;
  created: string;
  updated: string;
}

export interface GeneratedApp {
  name: string;
  description: string;
  icon: string;
  html: string;
  changelog: string;
}

export class AppError extends Error {
  issues: string[];
  constructor(message: string, issues: string[] = []) {
    super(message);
    this.name = 'AppError';
    this.issues = issues;
  }
}

const now = () => new Date().toISOString();

function text(value: unknown, max: number) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function isSource(value: unknown): value is AppSource {
  return typeof value === 'string' && (APP_SOURCES as readonly string[]).includes(value);
}

/**
 * 应用名要短：模型偶尔会写一整句「一个支持四则运算和三角函数的科学计算器」，
 * 直接塞进入口卡片会换行、挤掉说明。优先用模型给的名字，太长就按关键词归纳。
 */
const APP_NAME_HINTS: { re: RegExp; name: string }[] = [
  { re: /计算器|calculator/i, name: '科学计算器' },
  { re: /json|格式化|校验/i, name: 'JSON 格式化' },
  { re: /base64|url\s*编|编解码/i, name: 'Base64 编解码' },
  { re: /正则|regex|表达式/i, name: '正则测试' },
  { re: /番茄|pomodoro/i, name: '番茄钟' },
  { re: /单位换算|换算|convert/i, name: '单位换算' },
  { re: /颜色|取色|配色|color|palette/i, name: '颜色取色器' },
  { re: /密码|password/i, name: '密码生成器' },
  { re: /二维码|qrcode|qr\s*code/i, name: '二维码工具' },
  { re: /markdown/i, name: 'Markdown 工具' },
  { re: /时间戳|时区|日期|date/i, name: '时间工具' },
  { re: /字数|文本统计|统计/i, name: '文本统计' },
  { re: /随机|抽签|抽奖|random/i, name: '随机生成器' },
  { re: /计时|倒计时|时钟|timer|clock/i, name: '倒计时' },
  { re: /待办|清单|todo|task/i, name: '待办清单' },
  { re: /音乐|节拍|音阶|music/i, name: '音乐工具' },
];

const PROMPT_LEAD =
  /^(?:(?:请|麻烦|帮我做|帮忙做|帮我|帮忙|给我|我想|我要|想要|需要|生成一个|生成|创建|开发|设计|做一个|做个|来一个|来个)\s*)+/u;

const GENERIC_NAMES = /^(?:document|untitled|index|app|my app|无标题|未命名|新建文档|小工具|小应用|应用)$/i;

function cleanNameText(value: unknown) {
  return (typeof value === 'string' ? value : '')
    .replace(/["'“”‘’《》\n\r\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 生成一个 2–16 字的简短应用名；prompt 用于模型没给名字时的关键词兜底 */
export function shortAppName(prompt: string, raw?: string): string {
  const cleanRaw = cleanNameText(raw)
    .replace(/[，。；：、,.!?！？;:]+$/u, '')
    .trim();
  const descriptive = cleanRaw.length > 12 || /^(?:一个|一款|可以|支持|用来|用于|这是|本应用)/u.test(cleanRaw);
  if (cleanRaw.length >= 2 && cleanRaw.length <= 16 && !descriptive && !GENERIC_NAMES.test(cleanRaw)) return cleanRaw;

  const source = `${cleanRaw} ${prompt}`;
  for (const hint of APP_NAME_HINTS) {
    if (hint.re.test(source)) return hint.name;
  }
  let text = cleanNameText(prompt).replace(PROMPT_LEAD, '');
  text = text.split(/[，。；：、,.!?！？;:（(]/)[0].trim();
  text = text.replace(/(?:的)?(?:小工具|小应用)$/u, '').trim();
  if (text.length > 12) text = text.slice(0, 12);
  return text || 'AI 小应用';
}

function isColor(value: unknown): value is AppColor {
  return typeof value === 'string' && (APP_COLORS as readonly string[]).includes(value);
}

function random8() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID().replace(/-/g, '').slice(0, 8);
  return Math.random().toString(36).slice(2, 10).padEnd(8, '0');
}

export function newAppId() {
  return `${Date.now().toString(36).slice(-4)}${random8()}`.slice(0, 12);
}

function appDir(id: string) {
  return `${APPS_DIR}/${id}`;
}

export function appPath(id: string) {
  return `${appDir(id)}/app.json`;
}

export function appHtmlPath(id: string) {
  return `${appDir(id)}/index.html`;
}

export function normalizeMeta(raw: unknown, fallbackId = ''): AppMeta | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const id = text(o.id, 40) || fallbackId;
  const name = text(o.name, 40);
  if (!id || !name) return null;
  const template = text(o.template, 40) || undefined;
  // 老版本只记了 template，没有 source：市场装的一眼能认出来，
  // 其余（AI 生成 / 导入）当时没区分，统一按 AI 生成归类，不丢应用。
  const source: AppSource = template ? 'market' : isSource(o.source) ? o.source : 'ai';
  return {
    v: Number(o.v) || 1,
    id,
    name,
    description: text(o.description, 160),
    icon: text(o.icon, 32) || 'sparkles',
    color: isColor(o.color) ? o.color : 'green',
    version: Math.max(1, Number(o.version) || 1),
    model: text(o.model, 80),
    template,
    source,
    created: text(o.created, 40) || now(),
    updated: text(o.updated, 40) || now(),
  };
}

export async function listApps(): Promise<AppMeta[]> {
  const files = await listFiles(APPS_DIR);
  const apps: AppMeta[] = [];
  for (const file of files) {
    if (!file.endsWith('/app.json') || file.includes('冲突副本')) continue;
    const id = file.split('/').slice(-2)[0];
    try {
      const meta = normalizeMeta(JSON.parse(await readText(file)), id);
      if (meta) apps.push(meta);
    } catch {
      /* 坏文件跳过，不影响其它应用 */
    }
  }
  return apps.sort((a, b) => +new Date(b.updated) - +new Date(a.updated));
}

export async function readAppMeta(id: string): Promise<AppMeta | null> {
  try {
    return normalizeMeta(JSON.parse(await readText(appPath(id))), id);
  } catch {
    return null;
  }
}

export async function readAppHtml(id: string): Promise<string> {
  try {
    return await readText(appHtmlPath(id));
  } catch {
    return '';
  }
}

export async function writeAppMeta(meta: AppMeta) {
  await writeText(appPath(meta.id), `${JSON.stringify(meta, null, 2)}\n`);
}

export async function writeAppHtml(id: string, html: string) {
  await writeText(appHtmlPath(id), html);
}

export function appDataPath(id: string) {
  return `${appDir(id)}/data.json`;
}

/**
 * 应用数据只认一份 JSON 对象；坏文件当作没有数据，不让应用因为数据损坏打不开。
 * 数据文件用 { v, updated, data } 包装，方便以后加迁移逻辑。
 */
export async function readAppData(id: string): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await readText(appDataPath(id))) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const data = parsed.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
    return data as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function writeAppData(id: string, data: Record<string, unknown>) {
  const payload = { v: 1, updated: now(), data };
  await writeText(appDataPath(id), `${JSON.stringify(payload, null, 2)}\n`);
}

export async function clearAppData(id: string) {
  await writeAppData(id, {});
}

/** 把上一版代码留一份本机快照，最多 10 份；目录已在同步忽略名单里 */
export async function snapshotVersion(id: string, html: string) {
  if (!html.trim()) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = `${APP_HISTORY}/${id}/${stamp}.html`;
  await writeText(file, html);
  const files = (await listFiles(`${APP_HISTORY}/${id}`)).filter((f) => f.endsWith('.html')).sort();
  for (const old of files.slice(0, Math.max(0, files.length - MAX_VERSIONS))) {
    await removePath(old).catch(() => {});
  }
}

export async function listVersions(id: string): Promise<{ name: string; path: string; at: string }[]> {
  const files = (await listFiles(`${APP_HISTORY}/${id}`)).filter((f) => f.endsWith('.html'));
  return files
    .map((path) => {
      const name = (path.split('/').pop() || '').replace(/\.html$/, '');
      const at = name.replace(/T/, ' ').replace(/-(\d{2})-(\d{2})-(\d{3})Z?$/, ':$1:$2');
      return { name, path, at };
    })
    .sort((a, b) => (a.name < b.name ? 1 : -1));
}

export async function readVersion(id: string, name: string): Promise<string> {
  return readText(`${APP_HISTORY}/${id}/${name}.html`);
}

export async function deleteAppFiles(id: string) {
  // 应用目录里有 app.json / index.html / data.json，历史快照在另一边，一起清掉
  await removePath(appDir(id)).catch(() => {});
  await removePath(`${APP_HISTORY}/${id}`).catch(() => {});
}

/**
 * 单文件 HTML 的安全边界：命中任何一条都不允许保存。
 * 允许联网与外部资源后，仍必须挡住宿主访问、本地存储、Cookie 和嵌套页面，
 * 保证应用只能在自己的沙箱里运行，读不到笔记、令牌与宿主窗口。
 */
export function checkHtml(html: string): string[] {
  const issues: string[] = [];
  if (!html.trim()) return ['应用内容为空'];
  const bytes = new TextEncoder().encode(html).length;
  if (bytes > MAX_HTML_BYTES) issues.push(`代码体积 ${Math.round(bytes / 1024)}KB，超过 200KB 上限`);
  if (!/<html[\s>]/i.test(html) && !/<!doctype\s+html/i.test(html)) issues.push('缺少完整的 HTML 文档结构');
  const rules: { re: RegExp; msg: string }[] = [
    { re: /<meta\b[^>]*http-equiv\s*=\s*["']?refresh/i, msg: '包含自动跳转（meta refresh）' },
    { re: /\b(?:localStorage|sessionStorage)\b/i, msg: '尝试读写浏览器本地存储' },
    { re: /\bdocument\.cookie\b/i, msg: '尝试读取 Cookie' },
    { re: /\bwindow\.parent\b|\bparent\.document\b|\bwindow\.top\b|\btop\.location\b/i, msg: '尝试访问宿主窗口' },
    { re: /<base\b/i, msg: '包含 <base> 标签' },
    { re: /<iframe\b|<object\b|<embed\b/i, msg: '包含嵌套页面或插件' },
    { re: /javascript\s*:/i, msg: '包含 javascript: 链接' },
  ];
  for (const rule of rules) if (rule.re.test(html)) issues.push(rule.msg);
  return Array.from(new Set(issues));
}

/**
 * 注入 CSP 和宿主数据桥。应用可以联网、可以引用外部资源，但仍然：
 * - 不能嵌套页面（frame-src / object-src 全关）；
 * - 不能提交表单离开沙箱（form-action 关）；
 * - 读不到宿主窗口（sandbox 无同源权限，且静态检查挡 window.parent）。
 * 数据桥必须在应用自己的脚本之前执行，所以放在 head 最前面。
 *
 * 市场预览传 `{ bridge: 'preview' }`：读写一律不落盘，应用尝试保存时
 * 会弹出「请先把应用添加到首页」。传 `'none'` 则完全不注入桥，应用走
 * 自己的内存兜底。默认是完整桥，供已安装应用使用。
 */
export function withCsp(html: string, options?: { bridge?: 'full' | 'preview' | 'none' }) {
  const mode = options?.bridge ?? 'full';
  const bridge =
    mode === 'none'
      ? ''
      : `<script>${mode === 'preview' ? APP_PREVIEW_BRIDGE_SCRIPT : APP_BRIDGE_SCRIPT}</script>`;
  const head =
    "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; script-src 'unsafe-inline' https: http:; style-src 'unsafe-inline' https: http:; img-src * data: blob:; font-src * data:; media-src * data: blob:; connect-src *; form-action 'none'; base-uri 'none'; frame-src 'none'; object-src 'none'\">" +
    bridge;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head([^>]*)>/i, `<head$1>${head}`);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html([^>]*)>/i, `<html$1><head>${head}</head>`);
  return `<!doctype html><html><head><meta charset="utf-8">${head}</head><body>${html}</body></html>`;
}

function stripFence(text: string) {
  return text
    .trim()
    .replace(/^```(?:json|html)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
}

/** 从可能夹着解释文字的返回里，截出真正的 HTML 文档 */
function isolateHtml(source: string) {
  const text = stripFence(source);
  const start = /<!doctype\s+html|<html[\s>]/i.exec(text);
  let html = start ? text.slice(start.index) : text;
  const end = html.toLowerCase().lastIndexOf('</html>');
  if (end >= 0) html = html.slice(0, end + 7);
  return html.trim();
}

function extractObject(raw: string): Record<string, unknown> | null {
  const text = stripFence(raw);
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * 新的返回格式是「一行 <<<META {...} >>> + 原始 HTML」。
 * 相比把整段 HTML 塞进 JSON 字符串，不用转义引号和换行，模型不容易写到一半断掉，
 * 也避免了输出额度耗尽后 JSON 解析失败、被当成「模型没有返回内容」。
 */
function splitMeta(raw: string) {
  const found = /<<<\s*META\s*([\s\S]*?)>>>/i.exec(raw);
  if (!found) return { meta: null as Record<string, unknown> | null, rest: raw, hasMeta: false };
  let meta: Record<string, unknown> | null = null;
  const json = found[1].trim();
  const start = json.indexOf('{');
  const end = json.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(json.slice(start, end + 1));
      if (parsed && typeof parsed === 'object') meta = parsed as Record<string, unknown>;
    } catch {
      /* 元数据写坏不影响 HTML 本身，用兜底名称 */
    }
  }
  return { meta, rest: raw.slice(found.index + found[0].length), hasMeta: true };
}

function parseGenerated(raw: string, prompt: string): GeneratedApp {
  const source = raw.trim();
  const { meta, rest, hasMeta } = splitMeta(source);
  let obj: Record<string, unknown> | null = meta;
  let html = '';

  if (hasMeta) {
    html = isolateHtml(rest);
  } else {
    obj = extractObject(source);
    if (obj && typeof obj.html === 'string') html = isolateHtml(obj.html);
    else if (/<!doctype\s+html|<html[\s>]/i.test(source)) html = isolateHtml(source);
  }

  if (!html.trim()) {
    throw new AppError('模型这轮没有返回可用的 HTML（可能只写了说明，或代码被截断）。');
  }
  if (!/<\/html\s*>/i.test(html)) {
    throw new AppError('模型这次输出的 HTML 不完整（可能被截断），暂时不能保存。');
  }
  return {
    name: shortAppName(prompt, text(obj?.name, 40)),
    description: text(obj?.description, 160) || '由 AI 生成的小工具',
    icon: text(obj?.icon, 32) || 'sparkles',
    html,
    changelog: text(obj?.changelog, 200) || '',
  };
}

/**
 * 应用数据接口说明始终追加在用户提示词后面：
 * 设置里保存的是旧版提示词时，也能让模型知道有这套接口。
 */
const APP_DATA_GUIDE = `

应用数据接口（宿主已内置，需要跨刷新 / 跨设备保留数据时使用）：
1. 用 window.glimnote.data，全部返回 Promise：
   await window.glimnote.data.set('key', value)      // value 必须能 JSON 序列化
   const value = await window.glimnote.data.get('key', 默认值)
   const all = await window.glimnote.data.all()      // 取回全部键值
   await window.glimnote.data.remove('key')
   await window.glimnote.data.clear()
   window.glimnote.data.onChange(function (key) {})  // 其他窗口改了数据时触发
2. 数据按应用隔离，保存在笔记仓库里，会随同步上云；单次写入不超过 128KB，总量不超过 512KB。
3. 每次调用都用 try / catch 包住；接口不可用时退回内存变量，保证界面仍然可用。
4. 仍然禁止 localStorage / sessionStorage；要持久化就用上面这套接口。

系统通知（桌面端弹到系统通知中心，网页端回落为站内提示）：
  await window.glimnote.notify('计时结束', { body: '该休息一下了' })
标题不超过 80 字，正文不超过 200 字；通知只在应用打开时触发，不保证后台常驻。

联网：
- 可以直接用 fetch / XMLHttpRequest / WebSocket 访问网络，也可以引用外部图片、样式和脚本。
- 请求要处理失败、超时与跨域（CORS）；不要把 API Key 写死在代码里。
- 仍然不能访问 window.parent / window.top，也不能用 localStorage / Cookie。`;

/** 提示词放在「设置 → AI → 提示词」里，这里只负责附加精简重试规则与数据接口 */
function buildSystemPrompt(compact: boolean) {
  const base = loadAiPrompts().appGenerate;
  return `${compact ? `${base}${COMPACT_APP_SUFFIX}` : base}${APP_DATA_GUIDE}`;
}

export interface GenerateInput {
  prompt: string;
  /** 继续修改时带上上一版代码 */
  base?: { name?: string; html: string };
  /** 预览标注的位置描述，模型会优先处理这些区域 */
  annotations?: string;
  /** 之前的对话轮次，用来理解「再大一点」这类连续修改 */
  history?: ChatTurn[];
  signal?: AbortSignal;
}

/** 只有「模型没吐东西 / 吐的解析不了 / 没过安全检查」才值得自动换精简模式重来 */
function retryable(e: unknown) {
  if (e instanceof AppError) return true;
  if (e instanceof AiError) return e.code === 'EMPTY' || e.code === 'EMPTY_LENGTH' || e.code === 'FORMAT';
  return false;
}

/** 输出被 finish_reason=length 截断时，给一句能看懂也能照做的原因 */
function truncatedError(usage?: Record<string, unknown>) {
  const reasoning = reasoningTokens(usage);
  const detail = reasoning ? `（其中 ${reasoning} tokens 花在思考上）` : '';
  const budget = loadAiConfig().maxTokens;
  return new AppError(
    `模型这次输出到上限就停了，代码没有写完整${detail}，不能保存半截版本。可以点「重试」，或到「设置 → AI → 连接配置」把「最大输出 tokens」调大（当前 ${budget}）。`,
    ['输出额度用完'],
  );
}

/** 调用当前配置的模型生成 / 修改一个应用 */
export async function generateApp(input: GenerateInput): Promise<GeneratedApp> {
  const prompt = input.prompt.trim();
  if (!prompt) throw new AppError('先描述一下你想做什么应用。');
  const base = input.base;
  const note = input.annotations?.trim() ? `\n\n${input.annotations.trim()}` : '';
  const user = base
    ? `这是上一版应用${base.name ? `「${base.name}」` : ''}的完整代码。请在保留原有功能的前提下，按下面的要求修改，并返回完整的新版本（不要只给差异）：\n\n修改要求：${prompt}${note}\n\n上一版代码：\n${base.html.slice(0, 90000)}`
    : `请生成这个应用：${prompt}${note}`;

  const attempts = [buildSystemPrompt(false), buildSystemPrompt(true)];
  let last: unknown;
  for (let i = 0; i < attempts.length; i += 1) {
    try {
      // 输出预算取自「设置 → AI → 最大输出 tokens」（默认 32000）：
      // 思考型模型会把 reasoning_tokens 算进 completion，12k 常在思考阶段就烧光。
      // 服务商上限更低时 requestWithBudget 会自动降档，用户也能自己调大。
      const {
        text: raw,
        finish,
        usage,
      } = await chatCompleteDetailed(attempts[i], user, {
        temperature: i === 0 ? 0.2 : 0.35,
        // 生成整页 HTML 可能要几分钟，别让主进程的默认超时把它掐掉
        timeoutMs: 5 * 60_000,
        signal: input.signal,
        history: input.history,
      });
      let result: GeneratedApp;
      try {
        result = parseGenerated(raw, prompt);
      } catch (e) {
        // 解析不了 + 输出被截断，真正原因是额度而不是模型「写错了」
        if (finish === 'length' && e instanceof AppError) throw truncatedError(usage);
        throw e;
      }
      const issues = checkHtml(result.html);
      if (issues.length) {
        throw new AppError(`生成结果没有通过安全检查：${issues.slice(0, 3).join('；')}`, issues);
      }
      return result;
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') throw e;
      if (!retryable(e)) throw e;
      last = e;
    }
  }

  if (last instanceof AppError) {
    throw new AppError(`自动换精简模式重试过一次仍未成功：${last.message}`, last.issues);
  }
  if (last instanceof AiError) {
    const reason = last.message.replace(/点「重试」[^。]*。/u, '').trim();
    throw new AppError(
      `${reason} 已经自动用精简模式重试过一次，仍然没有成功。可以稍后再试，或到 设置 → AI 换一个模型。`,
    );
  }
  throw last instanceof Error ? last : new AppError('生成失败，请稍后再试。');
}

export function appExportName(meta: AppMeta) {
  return `${meta.name.replace(/[\\/:*?"<>|]/g, '-') || 'AI 小应用'}.html`;
}

export async function exportApp(meta: AppMeta, html: string) {
  downloadText(appExportName(meta), html, 'text/html;charset=utf-8');
}

export { now as appNow };
