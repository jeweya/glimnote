/**
 * Markdown 表格的生成（源码模式插入表格用）。
 * 富文本模式由 TipTap 的表格节点负责序列化，不需要再解析 Markdown。
 */

export interface ParsedTable {
  header: string[];
  rows: string[][];
}

/** 单元格里的 | 会破坏表格结构，换行也放不进一行，统一转义 */
function escapeCell(text: string) {
  return text
    .replace(/\|/g, '\\|')
    .replace(/\s*\n\s*/g, ' ')
    .trim();
}

/** 生成一段对齐的 Markdown 表格（列宽按内容补齐，源码模式下也好看） */
export function buildTable(header: string[], rows: string[][]): string {
  const cols = Math.max(header.length, ...rows.map((r) => r.length), 1);
  const head = Array.from({ length: cols }, (_, i) => escapeCell(header[i] || `列 ${i + 1}`));
  const body = rows.map((r) => Array.from({ length: cols }, (_, i) => escapeCell(r[i] || '')));
  const widths = head.map((h, i) => Math.max(3, h.length, ...body.map((r) => r[i].length)));
  const cell = (text: string, w: number) => ` ${text}${' '.repeat(Math.max(0, w - text.length))} `;
  const out = [
    `|${head.map((h, i) => cell(h, widths[i])).join('|')}|`,
    `|${widths.map((w) => ` ${'-'.repeat(w)} `).join('|')}|`,
    ...body.map((r) => `|${r.map((c, i) => cell(c, widths[i])).join('|')}|`),
  ];
  return out.join('\n');
}
