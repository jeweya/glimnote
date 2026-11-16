import { marked } from 'marked';

/**
 * TipTap 负责富文本，Markdown 仍是磁盘上的唯一格式。
 *
 * 读取时先把 Markdown 交给 marked 转成 HTML：marked 了解行内 HTML 里还能嵌
 * `**加粗**` 这类语法，正好对应旧笔记里的 `<span style="…">`。直接把带 span 的
 * Markdown 交给 @tiptap/markdown 反而会把 span 里的记号当普通文字。
 * 写回时再由 @tiptap/markdown 从文档 JSON 生成 Markdown，两段互不依赖。
 */
marked.setOptions({ gfm: true, breaks: true });

export function markdownToHtml(markdown: string): string {
  const raw = marked.parse(markdown, { async: false }) as string;
  if (typeof DOMParser === 'undefined') return raw;

  const doc = new DOMParser().parseFromString(raw, 'text/html');

  // 旧笔记里可能留着「选了样式但没输入」的空 span，白占一行
  doc.querySelectorAll('span').forEach((span) => {
    if (!span.childNodes.length) span.remove();
  });

  // marked 把任务项输出成 <li><input type="checkbox"> 待办</li>；
  // TipTap 的任务节点认的是 li[data-type=taskItem]，这里换成它的结构。
  doc.querySelectorAll('li').forEach((li) => {
    const input = li.querySelector(':scope > input[type="checkbox"]');
    if (!input) return;
    const checked = input.hasAttribute('checked');
    input.remove();

    const nested = Array.from(li.children).filter((el) => /^(UL|OL)$/i.test(el.tagName));
    const paragraph = doc.createElement('p');
    Array.from(li.childNodes).forEach((node) => {
      if (!nested.includes(node as Element)) paragraph.appendChild(node);
    });
    const box = doc.createElement('div');
    box.appendChild(paragraph);

    li.textContent = '';
    li.appendChild(box);
    nested.forEach((node) => li.appendChild(node));
    li.setAttribute('data-type', 'taskItem');
    li.setAttribute('data-checked', checked ? 'true' : 'false');
    if (li.parentElement?.tagName.toLowerCase() === 'ul') {
      li.parentElement.setAttribute('data-type', 'taskList');
    }
  });

  return doc.body.innerHTML;
}
