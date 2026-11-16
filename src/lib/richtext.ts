import { syntaxTree } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { pendingStyleField, setPendingStyle } from './pendingStyle';

/**
 * 普通用户不写 HTML：工具栏把颜色、背景色、对齐包装成行内 <span style="…">，
 * 好处是 span 内部的 Markdown 仍然会被解析（加粗、链接都还在），预览和导出的 HTML 也一致。
 */

const OPEN_TAG_END = /<span\b[^>]*>$/i;

const INLINE_NODES = new Set(['StrongEmphasis', 'Emphasis', 'Strikethrough', 'InlineCode', 'Link']);

/**
 * 颜色要包在 `**加粗**` 外层而不是插进标记中间：
 * Lezer 在「起始标记后面紧跟 HTML 标签」时会放弃识别强调，标记就露出来了。
 */
function expandInline(state: EditorState, from: number, to: number) {
  let changed = true;
  while (changed) {
    changed = false;
    syntaxTree(state).iterate({
      from,
      to,
      enter: (node) => {
        if (!INLINE_NODES.has(node.name)) return;
        if (node.from > from || node.to < to) return;
        if (node.from === from && node.to === to) return false;
        from = node.from;
        to = node.to;
        changed = true;
        return false;
      },
    });
  }
  return { from, to };
}

function styleOf(tag: string) {
  const m = /\bstyle\s*=\s*"([^"]*)"/i.exec(tag) || /\bstyle\s*=\s*'([^']*)'/i.exec(tag);
  return m ? m[1] : '';
}

function setProps(css: string, props: Record<string, string | null>) {
  const lower = Object.keys(props).map((k) => k.toLowerCase());
  const out = css
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((part) => {
      const key = part.split(':')[0].trim().toLowerCase();
      return !lower.includes(key);
    });
  for (const [key, value] of Object.entries(props)) {
    if (value) out.push(`${key}:${value}`);
  }
  const joined = out.join(';');
  // 有背景色就必须有确定的文字色，否则深色主题下浅底浅字看不清
  if (/background-color\s*:/i.test(joined) && !/(^|;)\s*color\s*:/i.test(joined)) {
    return `${joined};color:#202124`;
  }
  return joined;
}

/** 找正好包住 [from,to] 的 span 标签；工具栏只会生成单层 style，够用 */
function enclosingSpan(view: EditorView, from: number, to: number) {
  const state = view.state;
  const before = state.sliceDoc(Math.max(0, from - 400), from);
  const open = OPEN_TAG_END.exec(before);
  if (!open) return null;
  const after = state.sliceDoc(to, Math.min(state.doc.length, to + 8));
  const close = /^<\/span\s*>/i.exec(after);
  if (!close) return null;
  return { openFrom: from - open[0].length, openTo: from, closeFrom: to, closeTo: to + close[0].length, tag: open[0] };
}

/** 光标正好夹在一对空 span 中间：工具栏为「接着输入的文字」预留的样式 */
function emptySpanAt(state: EditorState, pos: number) {
  const before = state.sliceDoc(Math.max(0, pos - 400), pos);
  const open = OPEN_TAG_END.exec(before);
  if (!open) return null;
  const after = state.sliceDoc(pos, Math.min(state.doc.length, pos + 8));
  const close = /^<\/span\s*>/i.exec(after);
  if (!close) return null;
  return {
    openFrom: pos - open[0].length,
    openTo: pos,
    closeFrom: pos,
    closeTo: pos + close[0].length,
    tag: open[0],
  };
}

/** 遗留的空 span（选了字号 / 颜色但没输入任何字），下次应用样式时顺手清掉 */
function staleEmptySpans(state: EditorState) {
  const found: { from: number; to: number }[] = [];
  const re = /<span\b[^>]*><\/span\s*>/gi;
  const text = state.doc.toString();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) found.push({ from: m.index, to: m.index + m[0].length });
  return found;
}

/** 代码块、表格、HTML 块里不要塞 span，会把原结构弄坏 */
function lineBlocked(state: EditorState, pos: number) {
  let node = syntaxTree(state).resolveInner(pos, 1);
  while (node) {
    if (node.name === 'FencedCode' || node.name === 'Table' || node.name === 'HTMLBlock') return true;
    node = node.parent!;
  }
  return false;
}

const LINE_PREFIX = /^(\s*(?:#{1,6}\s+|>\s?|[-*+]\s(?:\[[ xX]\]\s)?|\d+[.)]\s)?)([\s\S]*)$/;

function lineParts(text: string) {
  const m = LINE_PREFIX.exec(text);
  return { prefix: m?.[1] || '', body: m?.[2] || '' };
}

/** 行级样式：如果整行正文已经被一层 span 包着就改它的属性，否则重新包 */
function wrapLineBody(props: Record<string, string | null>, body: string) {
  const allCleared = Object.values(props).every((v) => !v);
  const wrapped = /^<span\b[^>]*>([\s\S]*)<\/span>$/.exec(body);
  if (wrapped) {
    const css = setProps(styleOf(wrapped[0]), props);
    return css ? `<span style="${css}">${wrapped[1]}</span>` : wrapped[1];
  }
  if (allCleared) return body;
  return `<span style="${setProps('', props)}">${body}</span>`;
}

/** 选中多行时逐行上色，避免一个 span 跨越多个段落 */
function applyLineStyles(view: EditorView, from: number, to: number, props: Record<string, string | null>) {
  const state = view.state;
  const first = state.doc.lineAt(from).number;
  const last = state.doc.lineAt(to - 1).number;
  const changes: { from: number; to: number; insert: string }[] = [];
  for (let n = first; n <= last; n++) {
    const line = state.doc.line(n);
    if (lineBlocked(state, line.from)) continue;
    const { prefix, body } = lineParts(line.text);
    const trimmed = body.replace(/\s+$/, '');
    if (!trimmed.trim()) continue;
    const next = `${prefix}${wrapLineBody(props, trimmed)}`;
    if (next !== line.text) changes.push({ from: line.from, to: line.to, insert: next });
  }
  if (changes.length) view.dispatch({ changes, userEvent: 'input', filter: false });
  view.focus();
}

/**
 * 给选区加字号 / 颜色 / 背景色。没有选区时把样式记在编辑器的待用状态里，
 * 接着输入的文字自动落在样式里（不往正文写空标签，也不插入「文字」之类的占位内容）。
 * 传 null 表示清除这一个属性（其余属性保留）。
 */
export function applyTextStyle(view: EditorView, props: Record<string, string | null>) {
  const state = view.state;
  let { from, to } = state.selection.main;
  const allCleared = Object.values(props).every((v) => !v);
  if (to > from) ({ from, to } = expandInline(state, from, to));

  if (to > from && state.doc.lineAt(from).number !== state.doc.lineAt(to - 1).number) {
    applyLineStyles(view, from, to, props);
    return;
  }

  if (from === to) {
    // 待用样式不再写成空 <span></span>：空标签在阅读预览、导出 HTML 和粘贴到
    // 其它编辑器时会被当成一行（字号越大空行越高）。旧笔记里的空标签顺手清掉。
    const current = emptySpanAt(state, from);
    const base = state.field(pendingStyleField, false) || (current ? styleOf(current.tag) : '');
    if (allCleared) {
      const stale = staleEmptySpans(state);
      if (!stale.length && !base) return;
      view.dispatch({
        changes: stale.map((r) => ({ from: r.from, to: r.to, insert: '' })),
        effects: setPendingStyle.of(null),
        userEvent: 'delete.backward',
        filter: false,
      });
      view.focus();
      return;
    }
    // 连着换字号又换颜色：把新旧属性合在一起，换颜色不会丢掉刚选的尺寸
    const css = setProps(base, props);
    const stale = staleEmptySpans(state);
    view.dispatch({
      changes: stale.map((r) => ({ from: r.from, to: r.to, insert: '' })),
      effects: setPendingStyle.of(css),
      userEvent: 'input',
      filter: false,
    });
    view.focus();
    return;
  }

  const span = enclosingSpan(view, from, to);
  if (!span) {
    if (allCleared) {
      view.focus();
      return;
    }
    const css = setProps('', props);
    const open = `<span style="${css}">`;
    const close = '</span>';
    view.dispatch({
      changes: [
        { from, to: from, insert: open },
        { from: to, to, insert: close },
      ],
      selection: { anchor: from + open.length, head: to + open.length },
      userEvent: 'input',
      filter: false,
    });
    view.focus();
    return;
  }

  const css = setProps(styleOf(span.tag), props);
  const newOpen = css ? `<span style="${css}">` : '';
  const newClose = css ? '</span>' : '';
  const delta = newOpen.length - (span.openTo - span.openFrom);
  view.dispatch({
    changes: [
      { from: span.openFrom, to: span.openTo, insert: newOpen },
      { from: span.closeFrom, to: span.closeTo, insert: newClose },
    ],
    selection: { anchor: from + delta, head: to + delta },
    userEvent: 'input',
    filter: false,
  });
  view.focus();
}

export interface CaretTextStyle {
  /** 光标处 / 选区内文字实际使用的字号；没有局部样式时为空，由调用方回退到正文默认字号 */
  size?: string;
}

const SPAN_TOKEN = /<span\b[^>]*>|<\/span\s*>/gi;

function cssValue(css: string, prop: string) {
  const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, 'i').exec(css);
  return m ? m[1].trim() : undefined;
}

interface CharacterSpan {
  from: number;
  /** 开始标签终点：正文从这里开始 */
  openTo: number;
  /** 结束标签起点：正文到这里结束 */
  closeFrom: number;
  to: number;
  css: string;
}

/** 全文里带字符样式的 span。旧笔记的标签可能跨行，所以按全文配对，不按行 */
function characterSpans(state: EditorState) {
  const text = state.doc.toString();
  const stack: { from: number; openTo: number; css: string }[] = [];
  const spans: CharacterSpan[] = [];
  SPAN_TOKEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SPAN_TOKEN.exec(text))) {
    if (m[0][1] !== '/') {
      stack.push({ from: m.index, openTo: m.index + m[0].length, css: styleOf(m[0]) });
      continue;
    }
    const open = stack.pop();
    if (!open) continue;
    // 对齐用的 display:block 只影响整行排版，不代表这段文字有自己的字号
    if (!/(?:^|;)\s*(?:font-size|font-family|color|background-color)\s*:/i.test(open.css)) continue;
    spans.push({ ...open, closeFrom: m.index, to: m.index + m[0].length });
  }
  return spans;
}

/** 同一位置可能套了好几层（先选字号再选颜色），取最里面那层 */
function innermost(spans: CharacterSpan[]) {
  return spans.sort((a, b) => a.closeFrom - a.openTo - (b.closeFrom - b.openTo));
}

/**
 * 读光标处 / 选中文字实际使用的字号，供工具栏显示。
 * 光标处先看待用样式（刚选的字号、删掉最后一个字后交接的样式），再找光标所在的 span——
 * 所以光标停在 28 号字里就显示 28，停在普通段落里就显示正文默认值，不会一直挂着上次的选择。
 * 选区优先找完整包住它的 span；跨出标签（混排）时按选区开头那个字显示。
 */
export function textStyleAt(view: EditorView): CaretTextStyle {
  const state = view.state;
  const sel = state.selection.main;
  // 只看写了 font-size 的 span：颜色 / 背景色 span 里也会继承外层字号，
  // 拿最内层的颜色 span 去读字号会读空，显示就掉回默认值了
  const spans = characterSpans(state).filter((s) => cssValue(s.css, 'font-size'));

  if (sel.empty) {
    const pending = state.field(pendingStyleField, false);
    // 待用样式只管它自己写了字号的情况；只选了颜色时，字号仍由光标所在的 span 决定
    const pendingSize = pending ? cssValue(pending, 'font-size') : undefined;
    if (pendingSize) return { size: pendingSize };
    // 开始标签之后、结束标签之前输入的字都会落进这个 span
    const hit = innermost(spans.filter((s) => s.openTo <= sel.head && sel.head <= s.closeFrom))[0];
    return { size: hit ? cssValue(hit.css, 'font-size') : undefined };
  }

  const covered = innermost(spans.filter((s) => s.openTo <= sel.from && s.closeFrom >= sel.to))[0];
  // 选区跨出标签（混排）时没有唯一字号，按选区开头那个字显示
  const start = innermost(spans.filter((s) => s.openTo <= sel.from && sel.from < s.closeFrom))[0];
  const hit = covered || start;
  return { size: hit ? cssValue(hit.css, 'font-size') : undefined };
}

/** 去掉行内已有的对齐包装（对齐 span 总是包住整行正文，闭合标签在行尾） */
function stripAlign(text: string) {
  const open = /<span\b[^>]*text-align\s*:[^>]*>/i.exec(text);
  if (!open) return text;
  const closeFrom = text.lastIndexOf('</span>');
  if (closeFrom < open.index + open[0].length) return text;
  return text.slice(0, open.index) + text.slice(open.index + open[0].length, closeFrom) + text.slice(closeFrom + 7);
}

/** 对齐当前行或选中的每一行：保留 `#`、`- `、`> ` 这些块级前缀，只包正文 */
export function applyAlign(view: EditorView, align: 'left' | 'center' | 'right') {
  const state = view.state;
  const sel = state.selection.main;
  const first = state.doc.lineAt(sel.from).number;
  const endPos = sel.to > sel.from ? sel.to - 1 : sel.to;
  const last = state.doc.lineAt(endPos).number;
  const changes: { from: number; to: number; insert: string }[] = [];

  for (let n = first; n <= last; n++) {
    const line = state.doc.line(n);
    if (lineBlocked(state, line.from)) continue;
    const text = stripAlign(line.text);
    const { prefix, body } = lineParts(text);
    const trimmed = body.replace(/\s+$/, '');
    if (!trimmed.trim()) continue;
    const insert =
      align === 'left'
        ? `${prefix}${trimmed}`
        : `${prefix}<span style="display:block;text-align:${align}">${trimmed}</span>`;
    if (insert !== line.text) changes.push({ from: line.from, to: line.to, insert });
  }

  if (changes.length) view.dispatch({ changes, userEvent: 'input', filter: false });
  view.focus();
}
