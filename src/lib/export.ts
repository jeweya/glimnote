import JSZip from 'jszip';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { buildFile, type Note } from './markdown';
import { ROOT, listFiles, readBinary } from './storage';
import { assetDataUrl, parseImageAlt } from './assets';
import { downloadBlob, escapeHtml } from './utils';
import { getLang, t } from './i18n';

export async function exportAllZip(notes: Note[]) {
  const zip = new JSZip();
  for (const n of notes) {
    zip.file(`notes/${n.notebook ? `${n.notebook}/` : ''}${n.title.replace(/[\\/:*?"<>|]/g, '-')}.md`, buildFile(n));
  }
  const assets = await listFiles(`${ROOT}/assets`);
  for (const abs of assets) {
    const rel = abs.replace(`${ROOT}/`, '');
    try {
      zip.file(rel, await readBinary(abs));
    } catch {
      /* skip unreadable asset */
    }
  }
  zip.file(
    '.glimnote/repo.json',
    JSON.stringify({ schemaVersion: 1, app: 'glimnote', exportedAt: new Date().toISOString() }, null, 2),
  );
  const blob = await zip.generateAsync({ type: 'blob' });
  const day = new Date().toISOString().slice(0, 10);
  downloadBlob(t('萤光笔记-{date}.zip', { date: day }), blob);
}

export function exportNoteMarkdown(note: Note) {
  downloadBlob(
    `${note.title.replace(/[\\/:*?"<>|]/g, '-')}.md`,
    new Blob([buildFile(note)], { type: 'text/markdown;charset=utf-8' }),
  );
}

const PRINT_CSS = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0 auto;
    padding: 48px 32px 72px;
    max-width: 760px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB",
      "Microsoft YaHei", "Noto Sans CJK SC", sans-serif;
    font-size: 16px;
    line-height: 1.8;
    color: #24292f;
    background: #fff;
  }
  .doc-title { font-size: 30px; line-height: 1.3; margin: 0 0 6px; letter-spacing: -0.01em; }
  .doc-meta { font-size: 12px; color: #8a8f98; margin-bottom: 32px; }
  h1, h2, h3, h4 { line-height: 1.35; margin: 1.8em 0 0.6em; font-weight: 650; }
  h1 { font-size: 26px; } h2 { font-size: 21px; } h3 { font-size: 17px; } h4 { font-size: 15px; }
  p, ul, ol, blockquote, pre, table { margin: 0 0 1em; }
  a { color: #0969da; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .wiki { color: #6639ba; border-bottom: 1px dashed currentColor; }
  img { max-width: 100%; height: auto; border-radius: 6px; }
  blockquote { margin-left: 0; padding: 2px 0 2px 16px; border-left: 3px solid #d0d7de; color: #6a737d; }
  code { font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace; font-size: 0.88em; background: #f3f4f6; padding: 1px 5px; border-radius: 4px; }
  pre { background: #f6f8fa; padding: 14px 16px; border-radius: 8px; overflow-x: auto; }
  pre code { background: none; padding: 0; }
  table { border-collapse: collapse; width: 100%; font-size: 14px; }
  th, td { border: 1px solid #d8dee4; padding: 7px 10px; text-align: left; }
  th { background: #f6f8fa; }
  hr { border: none; border-top: 1px solid #e5e7eb; margin: 2em 0; }
  input[type="checkbox"] { margin-right: 6px; }
  li:has(> input[type="checkbox"]) { list-style: none; margin-left: -1.1em; }
  .doc-foot { margin-top: 48px; padding-top: 12px; border-top: 1px solid #eceff2; font-size: 11px; color: #a0a6ad; }
  .page-break { display: block; position: relative; height: 0; margin: 2.4em 0; border-top: 1px dashed #d0d7de; }
  .page-break::after { content: "${t('分页符')}"; position: absolute; left: 50%; top: -9px; transform: translateX(-50%); padding: 0 8px; background: #fff; font-size: 11px; color: #b0b6bd; }
  @media print {
    body { padding: 0; max-width: none; }
    a { color: inherit; }
    pre, blockquote, img { break-inside: avoid; }
    .page-break { break-after: page; page-break-after: always; border: none; margin: 0; }
    .page-break::after { content: none; }
  }
`;

/** 生成自包含的 HTML（图片转为 data URL），用于导出与打印 */
export async function buildNoteHtml(note: Note): Promise<string> {
  const converted = note.content.replace(
    /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
    (_m, target: string, alias?: string) => `<span class="wiki">${escapeHtml((alias || target).trim())}</span>`,
  );
  const raw = marked.parse(converted, { async: false }) as string;
  const safe = DOMPurify.sanitize(raw);

  const parsed = new DOMParser().parseFromString(`<div id="host">${safe}</div>`, 'text/html');
  const host = parsed.getElementById('host');
  // 空 span 在 Word / 浏览器里会按字号撑出一行，导出前直接去掉
  host?.querySelectorAll('span').forEach((span) => {
    if (!span.childNodes.length) span.remove();
  });
  const images = host ? Array.from(host.querySelectorAll('img')) : [];
  for (const img of images) {
    const size = parseImageAlt(img.getAttribute('alt') || '');
    img.setAttribute('alt', size.alt);
    if (size.width) {
      img.setAttribute('width', String(size.width));
      img.style.width = `${size.width}px`;
      img.style.height = 'auto';
    }
    const src = img.getAttribute('src') || '';
    try {
      const dataUrl = await assetDataUrl(note.path, src);
      if (dataUrl) img.setAttribute('src', dataUrl);
      else if (!/^(https?:|data:)/i.test(src)) img.remove();
    } catch {
      img.remove();
    }
  }

  const body = host ? host.innerHTML : safe;
  const title = escapeHtml(note.title || t('未命名笔记'));
  const created = new Date(note.created || note.updated).toLocaleString(getLang() === 'en' ? 'en-US' : 'zh-CN', { hour12: false });
  return `<!doctype html>
<html lang="${getLang() === 'en' ? 'en' : 'zh-CN'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>${PRINT_CSS}</style>
</head>
<body>
<h1 class="doc-title">${title}</h1>
<div class="doc-meta">${created}${note.tags.length ? ` · ${note.tags.map((t) => `#${escapeHtml(t)}`).join(' ')}` : ''}</div>
${body}
<div class="doc-foot">${t('导出自 萤光笔记 · {date}', { date: new Date().toLocaleDateString(getLang() === 'en' ? 'en-US' : 'zh-CN') })}</div>
</body>
</html>`;
}

export async function exportNoteHtml(note: Note) {
  const html = await buildNoteHtml(note);
  downloadBlob(
    `${note.title.replace(/[\\/:*?"<>|]/g, '-')}.html`,
    new Blob([html], { type: 'text/html;charset=utf-8' }),
  );
}

/** 在隐藏的 iframe 里打印，避免把整个应用界面打印出来 */
export async function printNote(note: Note) {
  const html = await buildNoteHtml(note);
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
  frame.srcdoc = html;
  frame.onload = () => {
    const win = frame.contentWindow;
    if (!win) {
      frame.remove();
      return;
    }
    window.setTimeout(() => {
      win.focus();
      win.print();
      window.setTimeout(() => frame.remove(), 1000);
    }, 120);
  };
  document.body.appendChild(frame);
}
