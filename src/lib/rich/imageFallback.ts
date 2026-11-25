/**
 * 网络图片加载失败时的占位图。
 *
 * 浏览器默认只会在原位置留一个几乎看不见的裂图图标（alt 为空时干脆什么都没有），
 * 七牛域名没备案、存储空间改成私有、链接过期这些情况，在日记里看起来就像
 * 「图片凭空消失了」。这里统一换成一张能看懂的说明图：写明加载失败、附上地址，
 * 还能再点一次重试。占位图是内联 SVG（data URI），不会产生额外请求。
 */

export const BROKEN_IMAGE_CLASS = 'glimnote-img-broken';
const BROKEN_SRC = 'data-glimnote-broken-src';
const BROKEN_STYLE = 'data-glimnote-broken-style';
const BROKEN_ALT = 'data-glimnote-broken-alt';
const BROKEN_TITLE = 'data-glimnote-broken-title';

/** 编辑区里点一下是「选中」，重试放在图片工具条里；阅读模式没有工具条，点击直接重试 */
export const EDITOR_BROKEN_HINT = '选中图片后可在工具条里重新加载';
export const PREVIEW_BROKEN_HINT = '点击图片可重新加载';

function escapeXml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function cssColor(name: string, fallback: string) {
  try {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || fallback;
  } catch {
    return fallback;
  }
}

/** 占位图上展示的地址：域名 + 路径，太长就截断 */
function shortLabel(url: string) {
  let label = url;
  try {
    const parsed = new URL(url);
    label = `${parsed.host}${parsed.pathname}`;
    try {
      label = decodeURI(label);
    } catch {
      /* 地址里有坏掉的 %xx，按原样显示 */
    }
  } catch {
    /* data: / blob: 之类解析不了就直接用原值 */
  }
  label = label.replace(/\/+$/, '');
  return label.length > 60 ? `${label.slice(0, 59)}…` : label;
}

/** 同一地址 + 主题 + 提示语只生成一次；只留最近几条，避免切主题时越攒越多 */
const cache = new Map<string, string>();
const CACHE_LIMIT = 24;

function placeholderFor(url: string, hint: string) {
  const bg = cssColor('--surface-2', '#f2f2ee');
  const line = cssColor('--line-strong', '#cfc8bb');
  const ink = cssColor('--text-2', '#514d46');
  const mute = cssColor('--text-3', '#69645b');
  const key = `${bg}|${line}|${ink}|${mute}|${hint}|${url}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const label = escapeXml(shortLabel(url));
  const tip = escapeXml(hint);
  // 520×96 的固定画布：比裂图图标醒目，又不会把整行占满；容器窄时按 max-width 等比缩小
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="520" height="96" viewBox="0 0 520 96" role="img" aria-label="图片加载失败">
  <rect x="1" y="1" width="518" height="94" rx="12" fill="${bg}" stroke="${line}" stroke-width="2" stroke-dasharray="8 6"/>
  <g fill="none" stroke="${mute}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
    <rect x="22" y="28" width="36" height="32" rx="5"/>
    <path d="M22 52l10-10 8 8 6-6 12 12"/>
    <path d="M52 21l15 15M67 21L52 36"/>
  </g>
  <text x="78" y="42" font-family="system-ui, -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif" font-size="16" font-weight="600" fill="${ink}">图片加载失败</text>
  <text x="78" y="64" font-family="system-ui, -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif" font-size="12" fill="${mute}">${label}</text>
  <text x="78" y="84" font-family="system-ui, -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif" font-size="11" fill="${mute}">${tip}</text>
</svg>`;

  const src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  cache.set(key, src);
  if (cache.size > CACHE_LIMIT) {
    const first = cache.keys().next().value;
    if (first) cache.delete(first);
  }
  return src;
}

export function isBrokenImage(img: HTMLImageElement) {
  return img.classList.contains(BROKEN_IMAGE_CLASS);
}

/**
 * 把加载失败的图片换成占位图。原始地址、宽度和 alt 都记在 data 属性上，
 * 重试时才能原样恢复（编辑区是 ProseMirror 的 NodeView，改 DOM 不会被写回文档）。
 */
export function markImageBroken(img: HTMLImageElement, hint = PREVIEW_BROKEN_HINT) {
  if (isBrokenImage(img)) return;
  const current = img.getAttribute('src') || '';
  // 只处理真正的网络图片；本地 blob / data 失败时保留原有处理方式
  if (!/^https?:\/\//i.test(current)) return;

  if (!img.hasAttribute(BROKEN_SRC)) img.setAttribute(BROKEN_SRC, current);
  if (!img.hasAttribute(BROKEN_STYLE)) img.setAttribute(BROKEN_STYLE, img.getAttribute('style') || '');
  if (!img.hasAttribute(BROKEN_ALT)) img.setAttribute(BROKEN_ALT, img.getAttribute('alt') || '');
  if (!img.hasAttribute(BROKEN_TITLE)) img.setAttribute(BROKEN_TITLE, img.getAttribute('title') || '');

  img.classList.add(BROKEN_IMAGE_CLASS);
  img.removeAttribute('width');
  // 占位图按自己的 520×96 显示；原来写在 alt 里的宽度等重试成功后再还原
  img.style.width = '';
  img.style.height = 'auto';
  img.style.maxWidth = '100%';
  img.alt = '图片加载失败';
  img.title = `图片加载失败：${img.getAttribute(BROKEN_SRC) || current}`;
  img.src = placeholderFor(img.getAttribute(BROKEN_SRC) || current, hint);
}

/** 重试失败后由 error 事件再次调用；成功后占位状态自然消失 */
function bustCache(url: string) {
  try {
    const parsed = new URL(url);
    parsed.searchParams.set('glimnote_retry', String(Date.now()));
    return parsed.toString();
  } catch {
    return url;
  }
}

export function retryBrokenImage(img: HTMLImageElement) {
  const src = img.getAttribute(BROKEN_SRC) || '';
  if (!src) return;
  img.classList.remove(BROKEN_IMAGE_CLASS);
  const style = img.getAttribute(BROKEN_STYLE) || '';
  if (style) img.setAttribute('style', style);
  else img.removeAttribute('style');
  img.alt = img.getAttribute(BROKEN_ALT) || '';
  const title = img.getAttribute(BROKEN_TITLE) || '';
  if (title) img.setAttribute('title', title);
  else img.removeAttribute('title');
  // 加上时间戳，避免浏览器直接拿出缓存里的那次失败
  img.src = bustCache(src);
}

/** NodeView 重新套用节点属性前清掉占位状态（换图 / 改宽度后不会残留） */
export function resetBrokenImage(img: HTMLImageElement) {
  img.classList.remove(BROKEN_IMAGE_CLASS);
  img.removeAttribute(BROKEN_SRC);
  img.removeAttribute(BROKEN_STYLE);
  img.removeAttribute(BROKEN_ALT);
  img.removeAttribute(BROKEN_TITLE);
}

/**
 * 阅读模式用：图片的 error 事件不冒泡，只能在容器上捕获。
 * 同时补扫一遍已经失败的图片——innerHTML 渲染后到 effect 挂上监听这段时间，
 * 浏览器可能已经把加载失败处理完了。
 */
export function watchBrokenImages(root: HTMLElement, hint = PREVIEW_BROKEN_HINT) {
  const onError = (event: Event) => {
    const target = event.target;
    if (target instanceof HTMLImageElement) markImageBroken(target, hint);
  };
  root.addEventListener('error', onError, true);

  for (const img of Array.from(root.querySelectorAll('img'))) {
    if (img.complete && img.naturalWidth === 0) markImageBroken(img, hint);
  }

  return () => root.removeEventListener('error', onError, true);
}
