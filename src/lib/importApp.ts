/**
 * 从外部导入 AI 生成的小应用（docs/15 6.6）。
 *
 * 外部 AI（Claude、WorkBuddy 等）常见的产物有三种：
 * 1. 一个自包含的 HTML；
 * 2. 一个 HTML + styles.css + app.js + 图片；
 * 3. 上面这些文件打成的 zip。
 *
 * 系统只接受「单文件、离线、不能访问宿主」的应用，所以这里先把多文件合并：
 * 本地 CSS / JS 内联成 <style> / <script>，图片和字体内联成 data URL，
 * 然后再走和 AI 生成完全相同的安全检查。外链、联网、本地存储一律拒绝，
 * 不做「自动删掉危险代码」这种会让人误以为安全的处理。
 */
import JSZip from 'jszip';
import { MAX_HTML_BYTES, checkHtml, shortAppName } from './apps';
import { t } from './i18n';

export interface ImportedApp {
  html: string;
  name: string;
  description: string;
  icon: string;
  entry: string;
  fileCount: number;
  inlined: number;
  bytes: number;
  warnings: string[];
}

export class ImportError extends Error {
  issues: string[];
  constructor(message: string, issues: string[] = []) {
    super(message);
    this.name = 'ImportError';
    this.issues = issues;
  }
}

const MAX_FILES = 300;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const MAX_ASSET_BYTES = 180 * 1024;

const MIME: Record<string, string> = {
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  mjs: 'text/javascript',
  json: 'application/json',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  mp4: 'video/mp4',
  webm: 'video/webm',
};

function extOf(path: string) {
  const name = path.split('/').pop() || '';
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
}

function mimeOf(path: string, fallback = 'application/octet-stream') {
  return MIME[extOf(path)] || fallback;
}

function normPath(raw: string) {
  const parts: string[] = [];
  for (const seg of raw.replace(/\\/g, '/').split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

function isExternal(ref: string) {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(ref.trim());
}

function isData(ref: string) {
  return ref.trim().toLowerCase().startsWith('data:');
}

function dirname(path: string) {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

function basename(path: string) {
  return path.split('/').pop() || path;
}

function decodeEntities(text: string) {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
}

function stripTags(text: string) {
  return decodeEntities(text.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function unquote(value: string) {
  const v = value.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
  return v;
}

function attr(tag: string, name: string) {
  const found = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  if (!found) return '';
  return unquote(found[2] ?? found[3] ?? found[4] ?? '');
}

function escapeAttr(value: string) {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function toDataUrl(bytes: Uint8Array, mime: string) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

interface Sources {
  map: Map<string, Uint8Array>;
  types: Map<string, string>;
  warnings: string[];
}

async function readZip(file: File, out: Sources) {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(await file.arrayBuffer());
  } catch {
    throw new ImportError(t('「{name}」不是有效的 zip 文件，或者已经损坏。', { name: file.name }));
  }
  const entries = Object.values(zip.files).filter(
    (entry) => !entry.dir && !entry.name.startsWith('__MACOSX/') && !entry.name.endsWith('/.DS_Store'),
  );
  if (entries.length > MAX_FILES) {
    throw new ImportError(t('zip 里有 {n} 个文件，超过 {max} 个上限。请只保留这个应用用到的文件。', { n: entries.length, max: MAX_FILES }));
  }
  let total = 0;
  for (const entry of entries) {
    const path = normPath(entry.name);
    if (!path) continue;
    const bytes = await entry.async('uint8array');
    total += bytes.length;
    if (bytes.length > MAX_FILE_BYTES || total > MAX_TOTAL_BYTES) {
      throw new ImportError(t('压缩包解压后体积过大（超过 20MB），请精简后再导入。'));
    }
    out.map.set(path, bytes);
    out.types.set(path, mimeOf(path));
  }
}

async function collect(files: File[]): Promise<Sources> {
  const out: Sources = { map: new Map(), types: new Map(), warnings: [] };
  const zips = files.filter((file) => /\.zip$/i.test(file.name));
  if (zips.length > 1) throw new ImportError(t('一次只能导入一个 zip。把应用打包成一个 zip 再试。'));
  if (zips.length === 1) {
    if (files.length > 1) {
      throw new ImportError(t('zip 里已经有全部文件了，不用再叠加其它文件。只选这一个 zip 就行。'));
    }
    await readZip(zips[0], out);
    return out;
  }

  if (files.length > MAX_FILES)
    throw new ImportError(t('一次选了 {n} 个文件，超过 {max} 个上限。只保留这个应用用到的文件。', { n: files.length, max: MAX_FILES }));

  // 通过文件夹选择时，webkitRelativePath 会带上根目录名；保留它，方便相对路径解析
  const paths = files.map((file) =>
    normPath((file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name),
  );
  const roots = new Set(paths.filter(Boolean).map((path) => path.split('/')[0]));
  const stripRoot =
    files.length > 1 && roots.size === 1 && paths.every((path) => path.includes('/')) ? [...roots][0] : '';

  for (let i = 0; i < files.length; i += 1) {
    const file = files[i];
    const path = stripRoot && paths[i].startsWith(`${stripRoot}/`) ? paths[i].slice(stripRoot.length + 1) : paths[i];
    if (!path) continue;
    if (file.size > MAX_FILE_BYTES)
      throw new ImportError(
        t('「{name}」有 {size}MB，超过 4MB。压缩一下或换一张小图。', { name: file.name, size: (file.size / 1024 / 1024).toFixed(1) }),
      );
    out.map.set(path, new Uint8Array(await file.arrayBuffer()));
    out.types.set(path, file.type || mimeOf(path));
  }
  return out;
}

function pickEntry(sources: Sources) {
  const htmls = [...sources.map.keys()].filter((path) => /\.html?$/i.test(path));
  if (!htmls.length) {
    throw new ImportError(t('没找到 HTML 入口。如果应用有多个文件，请选择包含 index.html 的整个文件夹，或打包成 zip。'));
  }
  const index = htmls.find((path) => basename(path).toLowerCase() === 'index.html');
  if (index) return index;
  if (htmls.length === 1) return htmls[0];
  throw new ImportError(
    t('这个文件夹里有几个 HTML，分不清哪个是首页。把要用的那个改名为 index.html，或者只选它一个文件。'),
    htmls.slice(0, 8).map((path) => path),
  );
}

function resolveRef(sources: Sources, basePath: string, ref: string): string | null {
  const clean = decodeURIComponent(ref.trim().split('#')[0].split('?')[0]);
  if (!clean || isExternal(clean) || isData(clean)) return null;
  const joined = normPath(clean.startsWith('/') ? clean.slice(1) : `${dirname(basePath)}/${clean}`);
  if (sources.map.has(joined)) return joined;

  // 有些 AI 导出的 HTML 写在根目录、资源却放在子目录，按文件名兜底找一次
  const wanted = basename(joined).toLowerCase();
  const matches = [...sources.map.keys()].filter((path) => basename(path).toLowerCase() === wanted);
  return matches.length === 1 ? matches[0] : null;
}

interface InlineContext extends Sources {
  inlined: number;
  warned: Set<string>;
}

function warnMissing(ctx: InlineContext, ref: string) {
  if (ctx.warned.has(ref) || ctx.warned.size >= 6) return;
  ctx.warned.add(ref);
  ctx.warnings.push(`找不到「${ref}」，已保留原引用（预览里可能显示不全）`);
}

function dataFor(ctx: InlineContext, ref: { base: string; value: string }) {
  const path = resolveRef(ctx, ref.base, ref.value);
  if (!path) {
    if (!isExternal(ref.value) && !isData(ref.value) && !ref.value.trim().startsWith('#')) warnMissing(ctx, ref.value);
    return null;
  }
  const bytes = ctx.map.get(path)!;
  if (bytes.length > MAX_ASSET_BYTES) {
    if (!ctx.warned.has(path)) {
      ctx.warned.add(path);
      ctx.warnings.push(`「${path}」超过 180KB，没有内联；应用总大小限制为 200KB`);
    }
    return null;
  }
  ctx.inlined += 1;
  return toDataUrl(bytes, ctx.types.get(path) || mimeOf(path));
}

function inlineCss(ctx: InlineContext, css: string, base: string) {
  return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (whole, _quote, value: string) => {
    if (isExternal(value) || isData(value) || value.trim().startsWith('#')) return whole;
    const url = dataFor(ctx, { base, value });
    return url ? `url("${url}")` : whole;
  });
}

function inlineHtml(sources: Sources, entry: string, raw: string) {
  const ctx: InlineContext = { ...sources, inlined: 0, warned: new Set() };
  let html = raw.replace(/<base\b[^>]*>/gi, '');

  // 内联 <style> 里的本地资源
  html = html.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (_whole, open: string, css: string, close: string) => {
    return `${open}${inlineCss(ctx, css, entry)}${close}`;
  });

  // <link rel="stylesheet" href="...">
  html = html.replace(/<link\b[^>]*>/gi, (tag) => {
    if (!/rel\s*=\s*["']?[^"'>]*stylesheet/i.test(tag)) return tag;
    const href = attr(tag, 'href');
    if (!href || isExternal(href) || isData(href)) return tag;
    const path = resolveRef(ctx, entry, href);
    if (!path) {
      warnMissing(ctx, href);
      return tag;
    }
    const css = new TextDecoder().decode(ctx.map.get(path)!);
    ctx.inlined += 1;
    return `<style data-from="${escapeAttr(path)}">\n${inlineCss(ctx, css, path).replace(/<\/style/gi, '<\\/style')}\n</style>`;
  });

  // <script src="...">（保留其它属性，例如 type="module"）
  html = html.replace(/<script\b([^>]*)>\s*<\/script>/gi, (_whole, attrs: string) => {
    const src = attr(`<script${attrs}>`, 'src');
    if (!src || isExternal(src) || isData(src)) return `<script${attrs}></script>`;
    const path = resolveRef(ctx, entry, src);
    if (!path) {
      warnMissing(ctx, src);
      return `<script${attrs}></script>`;
    }
    const js = new TextDecoder().decode(ctx.map.get(path)!);
    if (/^\s*(?:import|export)\s/m.test(js)) {
      ctx.warnings.push(`「${path}」是 ES Module，内联后相对导入可能失效`);
    }
    const rest = attrs.replace(/\s*src\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i, '');
    ctx.inlined += 1;
    return `<script${rest}>\n${js.replace(/<\/script/gi, '<\\/script')}\n</script>`;
  });

  // img / source / audio / video 的本地资源
  html = html.replace(/<(img|source|audio|video)\b([^>]*)>/gi, (_whole, name: string, attrs: string) => {
    let next = attrs.replace(
      /\b(src|poster)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi,
      (whole, key: string, _all: string, dq: string, sq: string, bare: string) => {
        const value = dq ?? sq ?? bare ?? '';
        if (!value || isExternal(value) || isData(value)) return whole;
        const url = dataFor(ctx, { base: entry, value });
        return url ? `${key}="${url}"` : whole;
      },
    );
    // srcset 里的地址无法保证是本地文件，直接去掉，避免预览时偷偷联网
    next = next.replace(/\s+srcset\s*=\s*("[^"]*"|'[^']*')/gi, '');
    return `<${name}${next}>`;
  });

  // 行内 style="..." 里的背景图 / 字体
  html = html.replace(/\bstyle\s*=\s*("[^"]*"|'[^']*')/gi, (whole, rawValue: string) => {
    const quote = rawValue[0];
    const css = rawValue.slice(1, -1);
    if (!/url\(/i.test(css)) return whole;
    return `style=${quote}${inlineCss(ctx, css, entry)}${quote}`;
  });

  return { html, warnings: ctx.warnings, inlined: ctx.inlined };
}

const ICON_HINTS: { re: RegExp; icon: string }[] = [
  { re: /计算器|calculator/i, icon: 'calculator' },
  { re: /json|格式化|校验/i, icon: 'braces' },
  { re: /正则|regex|表达式/i, icon: 'code' },
  { re: /颜色|取色|配色|color|palette/i, icon: 'palette' },
  { re: /番茄|计时|倒计时|时钟|timer|clock/i, icon: 'clock' },
  { re: /音乐|节拍|音阶|music|audio/i, icon: 'music' },
  { re: /数据库|表格|sql|database/i, icon: 'database' },
  { re: /图片|图像|裁剪|image|photo/i, icon: 'image' },
  { re: /文本|笔记|写作|markdown|字数/i, icon: 'pen' },
  { re: /换算|转换|单位|convert/i, icon: 'wrench' },
  { re: /查询|搜索|浏览器|url/i, icon: 'globe' },
  { re: /待办|清单|任务|todo/i, icon: 'briefcase' },
  { re: /换算|公式|实验|flask/i, icon: 'flask' },
];

function guessIcon(html: string, name: string) {
  const head = `${name} ${stripTags(html.slice(0, 6000))}`;
  for (const hint of ICON_HINTS) if (hint.re.test(head)) return hint.icon;
  return 'sparkles';
}

function readMeta(html: string, entry: string) {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] || '';
  const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1] || '';
  const descTag =
    /<meta\b[^>]*name\s*=\s*["']description["'][^>]*>/i.exec(html)?.[0] ||
    /<meta\b[^>]*content\s*=\s*["'][^"']*["'][^>]*name\s*=\s*["']description["'][^>]*>/i.exec(html)?.[0] ||
    '';
  const desc = descTag ? attr(descTag, 'content') : '';
  const fileBase = basename(entry).replace(/\.html?$/i, '');
  let rawName = stripTags(title) || stripTags(h1) || fileBase;
  // 浏览器标签页标题常见「应用名 - 站点名」，只取前半段
  rawName = rawName.split(/\s+[-–—|·]\s+/)[0].trim() || rawName;
  const name = shortAppName(stripTags(h1) || fileBase, rawName);
  const description = stripTags(desc).slice(0, 160) || t('从外部导入的小应用');
  return { name, description, icon: guessIcon(html, name) };
}

/** 把一堆 File（HTML / zip / 多个资源）合成一个可保存的单文件应用 */
export async function importAppFiles(files: File[]): Promise<ImportedApp> {
  if (!files.length) throw new ImportError(t('先选择要导入的文件。'));
  const sources = await collect(files);
  const entry = pickEntry(sources);
  const raw = new TextDecoder().decode(sources.map.get(entry)!);
  const bundled = inlineHtml(sources, entry, raw);
  const html = bundled.html.trim();
  if (!/<html[\s>]/i.test(html) && !/<!doctype\s+html/i.test(html)) {
    throw new ImportError(t('这个 HTML 不完整，缺少 <!doctype html> 或 <html>。让 AI 重新输出一个完整页面吧。'));
  }
  const bytes = new TextEncoder().encode(html).length;
  if (bytes > MAX_HTML_BYTES) {
    throw new ImportError(
      t('合并后 {size}KB，超过 {max}KB。让 AI 精简代码，或把大图换成 emoji 再来。', { size: (bytes / 1024).toFixed(1), max: Math.round(MAX_HTML_BYTES / 1024) }),
    );
  }
  const issues = checkHtml(html);
  if (issues.length) {
    throw new ImportError(
      t('这个应用需要联网或读取本地数据，为了安全不能导入。按下面的提示改一下，或复制提示词让 AI 重做：'),
      issues,
    );
  }
  const meta = readMeta(html, entry);
  const warnings = bundled.warnings.slice(0, 6);
  return {
    html,
    name: meta.name,
    description: meta.description,
    icon: meta.icon,
    entry,
    fileCount: sources.map.size,
    inlined: bundled.inlined,
    bytes,
    warnings,
  };
}
