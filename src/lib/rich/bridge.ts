import type { Editor } from '@tiptap/core';
import type { ParsedTable } from '../table';
import type { CaretTextStyle } from '../richtext';
import type { Align } from './extensions';

/**
 * 富文本编辑器与周边组件（工具栏、右键菜单、弹窗、目录、AI）之间的窄接口。
 *
 * 这些组件原本直接操作 CodeMirror 的 EditorView。TipTap 接管后，位置、选区和
 * 命令都不一样，所以统一收在这里：调用方只表达「加粗」「改字号」这类意图，
 * 不必知道底下是 ProseMirror 还是 CodeMirror。
 */

let active: Editor | null = null;

export function setActiveRichEditor(editor: Editor | null) {
  active = editor;
}

export function getActiveRichEditor() {
  return active;
}

export function richSelection() {
  if (!active) return null;
  const { from, to } = active.state.selection;
  return {
    from,
    to,
    text: active.state.doc.textBetween(from, to, '\n', ' '),
  };
}

export function richSelectionText() {
  return richSelection()?.text || '';
}

export function richToggleBold() {
  active?.chain().focus().toggleBold().run();
}

export function richToggleItalic() {
  active?.chain().focus().toggleItalic().run();
}

export function richToggleStrike() {
  active?.chain().focus().toggleStrike().run();
}

/** 字号 / 颜色 / 背景色；null 表示清除该项，其余属性保留 */
export function richApplyTextStyle(props: {
  'font-size'?: string | null;
  color?: string | null;
  'background-color'?: string | null;
}) {
  const editor = active;
  if (!editor) return;
  const chain = editor.chain().focus();
  if ('font-size' in props) {
    if (props['font-size']) chain.setFontSize(props['font-size']);
    else chain.unsetFontSize();
  }
  if ('color' in props) {
    if (props.color) chain.setColor(props.color);
    else chain.unsetColor();
  }
  if ('background-color' in props) {
    if (props['background-color']) chain.setBackgroundColor(props['background-color']);
    else chain.unsetBackgroundColor();
  }
  chain.run();
}

export function richStyleAt(): CaretTextStyle {
  if (!active) return {};
  const attrs = active.getAttributes('textStyle');
  return { size: typeof attrs.fontSize === 'string' ? attrs.fontSize : undefined };
}

export function richDefaultFontSize() {
  if (!active) return '';
  return getComputedStyle(active.view.dom).fontSize || '';
}

export function richApplyAlign(align: Align) {
  active?.chain().focus().setAlignment(align).run();
}

export function richToggleList(kind: 'taskList' | 'bulletList' | 'orderedList') {
  const editor = active;
  if (!editor) return;
  const chain = editor.chain().focus();
  if (kind === 'taskList') chain.toggleTaskList();
  else if (kind === 'bulletList') chain.toggleBulletList();
  else chain.toggleOrderedList();
  chain.run();
}

export function richTogglePrefix(prefix: string) {
  const editor = active;
  if (!editor) return;
  if (prefix.startsWith('- [ ]')) return richToggleList('taskList');
  if (prefix === '- ' || prefix === '* ' || prefix === '+ ') return richToggleList('bulletList');
  if (/^\d+[.)]\s/.test(prefix)) return richToggleList('orderedList');
  if (prefix === '> ') {
    editor.chain().focus().toggleBlockquote().run();
    return;
  }
  if (/^#{1,6}\s/.test(prefix)) {
    editor.chain().focus().toggleHeading({ level: prefix.trim().length as 1 | 2 | 3 | 4 | 5 | 6 }).run();
  }
}

export function richInsertHorizontalRule() {
  active?.chain().focus().setHorizontalRule().run();
}

export function richInsertPageBreak() {
  active?.chain().focus().insertContent({ type: 'pageBreak' }).run();
}

export function richInsertText(text: string) {
  active?.chain().focus().insertContent({ type: 'text', text }).run();
}

export function richDeleteSelection() {
  active?.chain().focus().deleteSelection().run();
}

export function richSetLink(text: string, url: string) {
  const editor = active;
  if (!editor) return;
  const { from, to } = editor.state.selection;
  const selected = editor.state.doc.textBetween(from, to, '\n', ' ');
  const label = text.trim() || selected || '链接文字';
  const href = url.trim() || 'https://';
  const chain = editor.chain().focus();
  if (from < to && selected === label) {
    // 文字没改，只给它套链接，原来的加粗 / 颜色都保留
    editor.chain().focus().extendMarkRange('link').setLink({ href }).run();
    return;
  }
  chain.insertContentAt({ from, to }, { type: 'text', text: label, marks: [{ type: 'link', attrs: { href } }] }).run();
}

export function richInsertWikiLink(title: string) {
  const editor = active;
  if (!editor) return;
  const { from, to } = editor.state.selection;
  const alias = editor.state.doc.textBetween(from, to, '\n', ' ').trim();
  const insert = alias ? `[[${title}|${alias}]]` : `[[${title}]]`;
  editor.chain().focus().insertContentAt({ from, to }, { type: 'text', text: insert }).run();
}

export function richInsertImage(rel: string, alt: string) {
  active?.chain().focus().setImage({ src: rel, alt }).run();
}

export function richInsertAttachment(rel: string, label: string) {
  active
    ?.chain()
    .focus()
    .insertContent([
      { type: 'text', text: label, marks: [{ type: 'link', attrs: { href: rel } }] },
      { type: 'text', text: ' ' },
    ])
    .run();
}

export function richInsertCodeBlock(code: string, language: string) {
  const text = code.replace(/\n+$/, '');
  if (!text.trim()) return;
  active
    ?.chain()
    .focus()
    .insertContent({
      type: 'codeBlock',
      attrs: { language },
      content: [{ type: 'text', text }],
    })
    .run();
}

function tableJson(table: ParsedTable) {
  const rows = [table.header, ...table.rows];
  const content = rows.map((cells, rowIndex) => ({
    type: 'tableRow',
    content: cells.map((cell) => ({
      type: rowIndex === 0 ? 'tableHeader' : 'tableCell',
      content: cell ? [{ type: 'paragraph', content: [{ type: 'text', text: cell }] }] : [{ type: 'paragraph' }],
    })),
  }));
  return { type: 'table', content };
}

export function richInsertTable(table: ParsedTable) {
  active?.chain().focus().insertContent(tableJson(table)).run();
}

/** 点击表格时，从光标位置往上找到整张表，转成弹窗能用的行列数据 */
export function richTableAtPosition(pos: number): { pos: number; data: ParsedTable } | null {
  const editor = active;
  if (!editor) return null;
  const $pos = editor.state.doc.resolve(pos);
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    const node = $pos.node(depth);
    if (node.type.name !== 'table') continue;
    const grid: string[][] = [];
    node.forEach((row) => {
      const cells: string[] = [];
      row.forEach((cell) => cells.push(cell.textContent.trim()));
      grid.push(cells);
    });
    const [header = [], ...rows] = grid;
    return { pos: $pos.before(depth), data: { header, rows } };
  }
  return null;
}

export function richReplaceTable(pos: number, table: ParsedTable) {
  const editor = active;
  if (!editor) return false;
  const node = editor.state.doc.nodeAt(pos);
  if (!node || node.type.name !== 'table') return false;
  editor
    .chain()
    .focus()
    .insertContentAt({ from: pos, to: pos + node.nodeSize }, tableJson(table))
    .run();
  return true;
}

export function richDeleteTable(pos: number) {
  const editor = active;
  if (!editor) return false;
  const node = editor.state.doc.nodeAt(pos);
  if (!node || node.type.name !== 'table') return false;
  editor
    .chain()
    .focus()
    .deleteRange({ from: pos, to: pos + node.nodeSize })
    .run();
  return true;
}

export function richUndo() {
  active?.chain().focus().undo().run();
}

export function richRedo() {
  active?.chain().focus().redo().run();
}

export function richDocText() {
  if (!active) return '';
  return active.getText({ blockSeparator: '\n\n' });
}

export function richDocSize() {
  return active?.state.doc.content.size || 0;
}

function inlineNodes(text: string) {
  return text.split('\n').flatMap((line, index) => {
    const nodes: Record<string, unknown>[] = [];
    if (index > 0) nodes.push({ type: 'hardBreak' });
    if (line) nodes.push({ type: 'text', text: line });
    return nodes;
  });
}

/**
 * 把 AI 结果写回文档。
 * - 润色：原位替换，换行写成 hardBreak，格式不跑丢；
 * - 续写：按空行拆段，落成真正的段落，而不是一个大文本框。
 */
export function richReplaceWithText(from: number, to: number, text: string, mode: 'replace' | 'append') {
  const editor = active;
  if (!editor) return false;
  if (mode === 'replace') {
    const nodes = inlineNodes(text);
    editor.chain().focus().insertContentAt({ from, to }, nodes).run();
    return true;
  }
  const paragraphs = text
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .filter((part) => part.trim())
    .map((part) => ({ type: 'paragraph', content: inlineNodes(part) }));
  if (!paragraphs.length) return false;
  editor.chain().focus().insertContentAt(to, paragraphs).run();
  return true;
}

/** 目录跳转：按文档顺序找到第 index 个标题，选中并滚到视口上方 */
export function richJumpToHeading(index: number) {
  const editor = active;
  if (!editor) return false;
  let current = -1;
  let target: number | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name !== 'heading') return true;
    current += 1;
    if (current === index) {
      target = pos + 1;
      return false;
    }
    return true;
  });
  if (target == null) return false;
  const at = Math.min(target, editor.state.doc.content.size);
  editor.chain().focus().setTextSelection(at).scrollIntoView().run();
  return true;
}
