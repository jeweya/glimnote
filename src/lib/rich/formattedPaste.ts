import { sanitizePastedText } from './sanitize';

/**
 * 右键「只粘贴文本」与粘贴兜底共用的文本转换。
 *
 * 富文本里按行拆成多个段落，而不是把整段塞进一个 <p> 用 <br> 连接：
 * 用户按一次回车就是一段，粘贴后也应保持同样的块结构，之后改列表、
 * 调顺序、拖动都不会把整段当成一行。
 */

function escapeHtml(text: string) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 纯文本 → 每行一个段落；空行保留成空段落，首尾空行去掉 */
export function plainTextToHtml(text: string): string {
  const lines = sanitizePastedText(text).replace(/\r\n?/g, '\n').split('\n');
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  if (!lines.length) return '';
  return lines.map((line) => (line ? `<p>${escapeHtml(line)}</p>` : '<p></p>')).join('');
}

/**
 * 源码模式（CodeMirror）的「只粘贴文本」：统一换行、去掉行尾空格、
 * 把连续空行收成一个，并去掉首尾空行。
 */
export function normalizeSourceText(text: string): string {
  const lines = sanitizePastedText(text)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''));
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const out: string[] = [];
  for (const line of lines) {
    if (!line.trim() && out.length && !out[out.length - 1].trim()) continue;
    out.push(line);
  }
  return out.join('\n');
}

/** 只拿到 HTML、没有纯文本时的兜底：粗略转成带换行的文字 */
export function htmlToPlainText(html: string): string {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  tpl.content.querySelectorAll('br').forEach((br) => br.replaceWith('\n'));
  tpl.content
    .querySelectorAll('p,div,li,h1,h2,h3,h4,h5,h6,tr,blockquote,pre')
    .forEach((el) => el.append('\n'));
  return tpl.content.textContent || '';
}
