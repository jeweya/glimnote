import { useEffect, useRef } from 'react';
import {
  Compartment,
  EditorState,
  Prec,
  RangeSetBuilder,
  StateEffect,
  StateField,
  Transaction,
} from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  keymap,
  drawSelection,
  dropCursor,
  highlightSpecialChars,
  placeholder as cmPlaceholder,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { insertNewlineContinueMarkup, markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { HighlightStyle, syntaxHighlighting, syntaxTree } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import {
  autocompletion,
  closeBrackets,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete';
import { searchKeymap } from '@codemirror/search';
import type { Note } from '../lib/markdown';
import { useApp } from '../store/app';
import { listTemplates, renderTemplate } from '../lib/repo';
import {
  insertAttachmentFile,
  insertImageFile,
  setActiveView,
  toggleLinePrefix,
  wrapSelection,
} from '../lib/editorBridge';
import { pendingStyleExtensions, pendingStyleField, setPendingStyle } from '../lib/pendingStyle';
import { ASSET_URL_EVENT, rewriteAssetLinks } from '../lib/assetLibrary';
import { sanitizePastedText } from '../lib/rich/sanitize';
import { escapeHtml } from '../lib/utils';
import { t } from '../lib/i18n';

/**
 * CodeMirror 6 的 Markdown 高亮靠 Tag → class 的映射；
 * 类名沿用 app.css 里已有的 .cm-header-1 / .cm-formatting 等，样式即可生效。
 */
const mdHighlight = HighlightStyle.define([
  { tag: tags.heading1, class: 'cm-header cm-header-1' },
  { tag: tags.heading2, class: 'cm-header cm-header-2' },
  { tag: tags.heading3, class: 'cm-header cm-header-3' },
  { tag: tags.heading4, class: 'cm-header cm-header-4' },
  { tag: tags.heading5, class: 'cm-header cm-header-5' },
  { tag: tags.heading6, class: 'cm-header cm-header-6' },
  { tag: tags.strong, class: 'cm-strong' },
  { tag: tags.emphasis, class: 'cm-em' },
  { tag: tags.strikethrough, class: 'cm-strikethrough' },
  { tag: tags.link, class: 'cm-link' },
  { tag: tags.url, class: 'cm-url' },
  { tag: tags.monospace, class: 'cm-inline-code' },
  { tag: tags.quote, class: 'cm-quote' },
  { tag: tags.processingInstruction, class: 'cm-formatting' },
  { tag: tags.contentSeparator, class: 'cm-formatting' },
]);

/** 搜索结果高亮：用 StateEffect 把关键词送进编辑器，纯装饰，不改文档 */
const setSearchTerms = StateEffect.define<string[]>();

function searchHitDecorations(state: EditorState, terms: string[]): DecorationSet {
  const text = state.doc.toString();
  const lower = text.toLowerCase();
  const spans: { from: number; to: number }[] = [];
  for (const raw of terms) {
    const term = raw.trim().toLowerCase();
    if (!term) continue;
    let at = lower.indexOf(term);
    while (at >= 0 && spans.length < 800) {
      spans.push({ from: at, to: at + term.length });
      at = lower.indexOf(term, at + Math.max(1, term.length));
    }
  }
  spans.sort((a, b) => a.from - b.from || b.to - a.to);
  const builder = new RangeSetBuilder<Decoration>();
  let lastTo = -1;
  for (const span of spans) {
    if (span.from < lastTo) continue;
    builder.add(span.from, span.to, Decoration.mark({ class: 'cm-search-hit' }));
    lastTo = span.to;
  }
  return builder.finish();
}

const searchHitField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setSearchTerms)) return searchHitDecorations(tr.state, effect.value);
    }
    return tr.docChanged ? value.map(tr.changes) : value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

function firstSearchHit(state: EditorState, terms: string[]): number {
  const text = state.doc.toString().toLowerCase();
  let best = -1;
  for (const raw of terms) {
    const term = raw.trim().toLowerCase();
    if (!term) continue;
    const at = text.indexOf(term);
    if (at >= 0 && (best < 0 || at < best)) best = at;
  }
  return best;
}

interface Props {
  note: Note;
  onChange: (content: string) => void;
  onNotice?: (text: string) => void;
  /** 打字机模式：输入时让光标所在行保持在编辑区垂直中央 */
  typewriter?: boolean;
  /** 重新挂载时把光标放回这里（从预览切回编辑时用） */
  initialPos?: number;
  /** 挂载后自动聚焦编辑器（从预览切回编辑时用） */
  focusOnMount?: boolean;
  /** 从搜索结果打开时要高亮的正文关键词，不改动文档内容 */
  highlightTerms?: string[];
}

/** 把光标所在行滚到编辑区正中；用屏幕坐标换算，自动把 scroller 的留白算进去 */
function centerOn(view: EditorView, pos: number) {
  const scroller = view.scrollDOM;
  const coords = view.coordsAtPos(pos);
  if (!coords) return;
  const rect = scroller.getBoundingClientRect();
  const target = scroller.scrollTop + (coords.top + coords.bottom) / 2 - (rect.top + rect.height / 2);
  const max = scroller.scrollHeight - scroller.clientHeight;
  scroller.scrollTop = Math.max(0, Math.min(target, max));
}

const typewriterExtensions = [
  EditorView.updateListener.of((u) => {
    if (!u.docChanged && !u.selectionSet) return;
    const view = u.view;
    const pos = u.state.selection.main.head;
    // 等 CodeMirror 本轮自身的「保持可见」滚动做完（它常在下一帧才生效），再覆盖成居中
    requestAnimationFrame(() => requestAnimationFrame(() => centerOn(view, pos)));
  }),
];

interface Template {
  name: string;
  content: string;
}

/**
 * 换行后把样式交给待用状态。只带 effect 的事务不改文档也不动选区，
 * CodeMirror 不会通知工具栏，按钮会先掉回正文默认字号、下一次输入才跳回去；
 * 这里补发一次同步事件，让按钮立刻显示接下来要用的字号。
 */
function carryPendingAfterEnter(view: EditorView, css: string) {
  view.dispatch({ effects: setPendingStyle.of(css) });
  window.dispatchEvent(new CustomEvent('glimnote:editor-selection', { detail: { view } }));
}

/**
 * 回车前的两个小照顾：
 * 1. 光标停在 `**`、`~~`、`` ` `` 这类收尾标记前面时，先跨过标记再换行，免得把标记拆到下一行；
 * 2. 在空的引用行里再按一次回车，直接退出引用（内置规则会一直续写 `> `）。
 */
function smartEnter(view: EditorView) {
  const { from, to } = view.state.selection.main;
  if (from !== to) return false;

  // 换行时把光标所在文字的字号 / 颜色带到新行。
  // 顺手在光标处合上当前 span：标签跨行以后，删除时很容易只删掉一半而露出 HTML。
  const pending = view.state.field(pendingStyleField, false);
  const styled = characterStyleAt(view.state, from);
  const newline = () => {
    if (!insertNewlineContinueMarkup(view)) view.dispatch(view.state.replaceSelection('\n'));
  };
  if (styled) {
    // 刚选过但还没敲字的那层样式也一起带上（例如在已有样式的段落里只改了字号）
    const carried = [characterTagCss(styled.tag), pending].filter(Boolean).join(';') || styled.tag;
    const empty = styled.openTo === styled.closeFrom && from === styled.openTo;
    if (empty) {
      // 旧笔记里遗留的空标签：收走，换行后改用「待用样式」，不在空行里留标签
      view.dispatch({
        changes: { from: styled.openFrom, to: styled.closeTo, insert: '' },
        filter: false,
      });
      newline();
      carryPendingAfterEnter(view, carried);
      view.focus();
      return true;
    }
    // 光标正好在标签两侧（可见文字的开头 / 末尾）：先把光标挪到标签外，
    // 否则会往标签中间再插一个闭合标签，留下多余的 </span>。
    if (from === styled.openTo || from === styled.closeFrom) {
      view.dispatch({ selection: { anchor: from === styled.openTo ? styled.openFrom : styled.closeTo } });
      newline();
      carryPendingAfterEnter(view, carried);
      view.focus();
      return true;
    }
    if (from === styled.closeTo) {
      newline();
      carryPendingAfterEnter(view, carried);
      view.focus();
      return true;
    }
    if (from > styled.openTo && from < styled.closeFrom) {
      // 光标在样式中间：先合上这一段，剩下的文字由原来的结束标签管
      view.dispatch({
        changes: { from, insert: '</span>' },
        selection: { anchor: from + '</span>'.length },
        filter: false,
      });
      newline();
      const pos = view.state.selection.main.head;
      // 原来的结束标签还在下一段文字末尾，只需补开始标签
      view.dispatch({
        changes: { from: pos, insert: styled.tag },
        selection: { anchor: pos + styled.tag.length },
        filter: false,
      });
      view.focus();
      return true;
    }
  }
  if (pending) {
    // 只选过字号 / 颜色、还没输入：换行后样式跟着光标走，正文里不留空标签
    newline();
    carryPendingAfterEnter(view, pending);
    view.focus();
    return true;
  }

  const line = view.state.doc.lineAt(from);
  const tail = view.state.sliceDoc(from, line.to);

  if (!tail.trim()) {
    const before = view.state.sliceDoc(line.from, from);
    if (/^\s*>\s?$/.test(before)) {
      view.dispatch({ changes: { from: line.from, to: line.from + before.length, insert: '' } });
      return false;
    }
    // 空的列表项 / 待办项再按一次回车，就退出列表，回到普通段落
    if (/^\s*([-*+]|\d+[.)])\s(\[[ xX]\]\s?)?$/.test(before)) {
      view.dispatch({ changes: { from: line.from, to: line.from + before.length, insert: '' } });
      return false;
    }
  }

  const match = /^(\*\*|~~|`|\*)\s*$/.exec(tail);
  if (!match) return false;
  view.dispatch({ selection: { anchor: from + match[1].length } });
  return false;
}

/** 删掉的是彩色 / 背景色 span 里最后一个可见字时，连 <span …> 和 </span> 一起删掉，别把空标签留在正文里 */
function spanDeleteRange(state: EditorState, from: number, to: number) {
  if (from >= to) return null;
  const line = state.doc.lineAt(from);
  if (state.doc.lineAt(Math.max(from, to - 1)).number !== line.number) return null;
  const before = state.doc.sliceString(line.from, from);
  const open = /<span\b[^>]*>$/i.exec(before);
  const after = state.doc.sliceString(to, Math.min(state.doc.length, to + 16));
  const close = /^<\/span\s*>/i.exec(after);
  if (!open || !close) return null;
  return {
    from: line.from + open.index,
    to: to + close[0].length,
    css: characterTagCss(open[0]),
  };
}

interface SpanPair {
  openFrom: number;
  openTo: number;
  closeFrom: number;
  closeTo: number;
  tag: string;
  closeTag: string;
}

/** 全文里成对的 <span …>…</span>：标签可能跨行（在样式文字中间按过回车），不能按行配对 */
function allSpanPairs(state: EditorState) {
  const text = state.doc.toString();
  const stack: { from: number; to: number }[] = [];
  const pairs: SpanPair[] = [];
  const re = /<span\b[^>]*>|<\/span\s*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m[0][1] !== '/') {
      stack.push({ from: m.index, to: m.index + m[0].length });
      continue;
    }
    const open = stack.pop();
    if (!open) continue;
    pairs.push({
      openFrom: open.from,
      openTo: open.to,
      closeFrom: m.index,
      closeTo: m.index + m[0].length,
      tag: text.slice(open.from, open.to),
      closeTag: m[0],
    });
  }
  return pairs;
}

/** 只取和 [from,to] 有交集的那些对 */
function spanPairsBetween(state: EditorState, from: number, to: number) {
  return allSpanPairs(state).filter((p) => p.openFrom < to && p.closeTo > from);
}

function tagCss(tag: string) {
  const m = /\bstyle\s*=\s*"([^"]*)"/i.exec(tag) || /\bstyle\s*=\s*'([^']*)'/i.exec(tag);
  return m ? m[1] : '';
}

/** 一行的字号 / 颜色这类字符样式（旧笔记里的 font-family 也认）；对齐用的 display:block 不算 */
function characterTagCss(tag: string) {
  const css = tagCss(tag);
  if (/display\s*:\s*block/i.test(css)) return null;
  return /(?:^|;)\s*(?:font-family|font-size|color|background-color)\s*:/i.test(css) ? css : null;
}

/** 光标处正在生效的字符样式（含旧笔记里选好样式但还没输入的空 span、紧跟在结束标签之后的位置） */
function characterStyleAt(state: EditorState, pos: number): SpanPair | null {
  const pairs = allSpanPairs(state);
  const innermost = (list: SpanPair[]) => list.sort((a, b) => a.closeFrom - a.openTo - (b.closeFrom - b.openTo));
  for (const p of innermost(pairs.filter((x) => pos >= x.openTo && pos <= x.closeFrom))) {
    if (characterTagCss(p.tag)) return p;
  }
  for (const p of innermost(pairs.filter((x) => x.closeTo === pos))) {
    if (characterTagCss(p.tag)) return p;
  }
  return null;
}

/**
 * 删除的是某段带样式文字的最后内容时，返回这段文字的 CSS。
 * 删除标签后由调用方交接待用样式，下一次输入继续用同样的字号 / 颜色。
 * 只认“样式 span 完整落在删除范围内”的情况；并排的混合选段不猜，避免样式乱粘。
 */
function carryCssForDeletion(state: EditorState, from: number, to: number) {
  const pairs = allSpanPairs(state).filter((p) => {
    if (!characterTagCss(p.tag)) return false;
    return from >= p.openFrom && from <= p.openTo && to >= p.closeFrom && to <= p.closeTo;
  });
  // 嵌套时只取最内层；两段并排的样式（混合选段）没有“唯一归属”，不交接
  const inner = pairs.filter((p) => !pairs.some((q) => q !== p && q.openFrom >= p.openFrom && q.closeTo <= p.closeTo));
  if (inner.length !== 1) return null;
  const target = inner[0];
  // 外层先写、内层后写，同名 CSS 属性由内层覆盖
  return (
    pairs
      .filter((p) => p.openFrom <= target.openFrom && p.closeTo >= target.closeTo)
      .sort((a, b) => b.closeFrom - b.openTo - (a.closeFrom - a.openTo))
      .map((p) => characterTagCss(p.tag))
      .filter(Boolean)
      .join(';') || null
  );
}

/** 复制 / 剪切：把选中的 Markdown 原样放进剪贴板，同时提供一份等价的 HTML */
function writeClipboard(event: ClipboardEvent, view: EditorView, cut: boolean) {
  const { from, to } = view.state.selection.main;
  if (from === to || !event.clipboardData) return false;
  const text = view.state.sliceDoc(from, to);
  event.preventDefault();
  event.clipboardData.setData('text/plain', text);
  event.clipboardData.setData(
    'text/html',
    `<div style="white-space:pre-wrap">${escapeHtml(text).replace(/\n/g, '<br>')}</div>`,
  );
  if (cut) {
    view.dispatch({
      changes: { from, to, insert: '' },
      userEvent: 'delete.cut',
      scrollIntoView: true,
    });
  }
  return true;
}

/** pos 是不是落在某个标签内部（键盘扩选时可能出现，插入会把标签拆成两半） */
function tagAt(state: EditorState, pos: number) {
  const text = state.doc.toString();
  const re = /<span\b[^>]*>|<\/span\s*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const to = m.index + m[0].length;
    if (pos > m.index && pos < to) return { from: m.index, to, close: m[0][1] === '/' };
  }
  return null;
}

/**
 * 删除或替换选区时，别把 <span …> / </span> 拆成半截。
 * 端点落进标签就挪出标签；只删到一半时把被删掉的标签补到新文字的另一侧，
 * 这样剩下的文字仍保持原来的样式，正文里也不会冒出半截 HTML。
 */
function repairSpanChange(state: EditorState, from: number, to: number, input: string) {
  let a = from;
  let b = to;
  let inserted = input;
  let prefix = '';
  let suffix = '';
  const pairs = spanPairsBetween(state, from, to);

  // 端点落进标签内部（键盘扩选、中文输入法都可能出现）：
  // 起点挪到标签后面，终点挪到标签前面。输入法在这种情况下会把标签剩下的字符
  // 一起塞进 inserted，例如「pan>文字」，要先把这段不是用户输入的内容剥掉。
  const tagBounds = (pos: number) => {
    for (const p of pairs) {
      if (pos > p.openFrom && pos < p.openTo) return { start: p.openFrom, end: p.openTo };
      if (pos > p.closeFrom && pos < p.closeTo) return { start: p.closeFrom, end: p.closeTo };
    }
    return null;
  };
  const startTag = tagBounds(a);
  if (startTag) {
    const leaked = state.sliceDoc(a, startTag.end);
    if (leaked && inserted.startsWith(leaked)) inserted = inserted.slice(leaked.length);
    a = startTag.end;
  }
  const endTag = tagBounds(b);
  if (endTag) b = endTag.start;
  if (b < a) b = a;

  // 选区整段落在某个标签里：把落点挪到标签外（删除时等于什么都不删）
  for (const p of pairs) {
    if (a >= p.openFrom && b <= p.openTo) return { from: p.openTo, to: p.openTo, insert: inserted };
    if (a >= p.closeFrom && b <= p.closeTo) return { from: p.closeTo, to: p.closeTo, insert: inserted };
  }

  const done = new Set<number>();
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < pairs.length; i++) {
      if (done.has(i)) continue;
      const p = pairs[i];
      if (b <= p.openFrom || a >= p.closeTo) continue;
      if (a <= p.openFrom && b >= p.closeTo) continue; // 整对都在删除范围里
      if (a < p.openTo && b > p.openFrom) {
        done.add(i);
        if (b >= p.closeFrom) {
          // 从开始标签删到正文末尾：整对一起收走
          a = Math.min(a, p.openFrom);
          b = Math.max(b, p.closeTo);
        } else {
          // 后面还留着正文：把开始标签补到新文字后面
          a = Math.min(a, p.openFrom);
          suffix = p.tag + suffix;
        }
        changed = true;
        continue;
      }
      if (a < p.closeTo && b > p.closeFrom) {
        done.add(i);
        if (a <= p.openTo) {
          // 前面已经没有正文：整对一起收走
          a = Math.min(a, p.openFrom);
          b = Math.max(b, p.closeTo);
        } else {
          // 前面还留着正文：把结束标签补到新文字前面
          b = Math.max(b, p.closeTo);
          prefix = p.closeTag + prefix;
        }
        changed = true;
        continue;
      }
      if (a <= p.openTo && b >= p.closeFrom) {
        done.add(i);
        // 选区正好是 span 里的全部正文
        if (!inserted) {
          a = Math.min(a, p.openFrom);
          b = Math.max(b, p.closeTo);
          changed = true;
        } else if (b >= p.closeTo) {
          // 开始标签在选区外、结束标签被一起选走了：给新文字补一个结束标签，
          // 否则会剩下一个没有闭合的 span，正文里就会露出 HTML
          b = Math.max(b, p.closeTo);
          suffix += p.closeTag;
          changed = true;
        }
        // 输入文字覆盖时保留标签，新文字自然继承原来的样式
      }
    }
  }
  return { from: a, to: b, insert: prefix + inserted + suffix };
}

/**
 * 输入文字覆盖选区、剪切、拖拽删除都会绕过退格守卫。
 * 在事务层再兜一次底：只要这次改动会拆开 span 标签，就把范围补成整对标签。
 */
function guardSpanTransaction(tr: Transaction) {
  if (!tr.docChanged) return tr;
  if (!tr.isUserEvent('input') && !tr.isUserEvent('delete')) return tr;
  const changes: { from: number; to: number; insert: string }[] = [];
  let repaired = false;
  let carry: string | null = null;
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    const text = inserted.toString();
    if (toA === fromA && text) {
      // 光标万一落进标签内部，把输入挪到标签外侧，别把标签拆开
      const tag = tagAt(tr.startState, fromA);
      if (tag) {
        repaired = true;
        const pos = tag.close ? tag.from : tag.to;
        changes.push({ from: pos, to: pos, insert: text });
        return;
      }
    }
    if (toA > fromA) {
      // 选中的正好是一整段带样式的文字：标签会被一起收走，先把样式记下来
      if (!text) carry = carryCssForDeletion(tr.startState, fromA, toA);
      const fixed = repairSpanChange(tr.startState, fromA, toA, text);
      if (fixed.from !== fromA || fixed.to !== toA || fixed.insert !== text) {
        repaired = true;
        changes.push({ from: fixed.from, to: fixed.to, insert: fixed.insert });
        return;
      }
    }
    changes.push({ from: fromA, to: toA, insert: text });
  });
  if (!repaired && !carry) return tr;
  // 修补后选区长度可能还对不上新文档（输入法场景），插入文字时把光标放到文字末尾
  const cursor =
    changes.length === 1 && changes[0].insert ? { anchor: changes[0].from + changes[0].insert.length } : undefined;
  return {
    changes,
    selection: cursor,
    effects: carry ? [...tr.effects, setPendingStyle.of(carry)] : tr.effects,
    userEvent: tr.annotation(Transaction.userEvent) || undefined,
    scrollIntoView: tr.scrollIntoView,
  };
}

/** 行首的代码围栏（``` 或 ~~~），允许后面带语言名 */
const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})/;

/** 找出包含 pos 的整块围栏代码 */
function fencedRangeAt(state: EditorState, pos: number) {
  let node = syntaxTree(state).resolveInner(Math.min(Math.max(pos, 0), state.doc.length), 1);
  while (node && node.name !== 'FencedCode') node = node.parent!;
  return node ? { from: node.from, to: node.to } : null;
}

/**
 * 围栏本身是藏起来的，删掉一半会让下文整段被当成代码。
 * 空代码块：整块删掉；已有内容的代码块：这次删除直接忽略，
 * 免得手一抖就把整段代码的灰底和等宽字体弄丢了（真想去掉，先把里面的内容删空）。
 */
function unwrapFence(view: EditorView, range: { from: number; to: number }, back: boolean) {
  const state = view.state;
  const first = state.doc.lineAt(range.from);
  const last = state.doc.lineAt(Math.max(range.from, range.to - 1));
  if (state.doc.sliceString(first.to, last.from).trim()) return;
  const to = last.to < state.doc.length ? last.to + 1 : last.to;
  view.dispatch({
    changes: { from: first.from, to },
    userEvent: back ? 'delete.backward' : 'delete.forward',
  });
}

/** 这一行是不是这块代码的首行或末行围栏（代码正文里出现的 ``` 不算） */
function isFenceLineOf(state: EditorState, range: { from: number; to: number }, lineFrom: number) {
  const first = state.doc.lineAt(range.from);
  const last = state.doc.lineAt(Math.max(range.from, range.to - 1));
  return lineFrom === first.from || lineFrom === last.from;
}

/** 删一个换行会把围栏和正文粘在一起时（下文会整段落进代码块），返回那块代码的范围 */
function fenceBreakAt(state: EditorState, pos: number, back: boolean) {
  const line = state.doc.lineAt(pos);
  if (back) {
    if (pos !== line.from || pos === 0) return null;
    const up = state.doc.lineAt(pos - 1);
    if (!FENCE_LINE.test(up.text) && !FENCE_LINE.test(line.text)) return null;
    const range = fencedRangeAt(state, pos) || fencedRangeAt(state, pos - 1);
    if (!range) return null;
    const fenceFrom = FENCE_LINE.test(line.text) ? line.from : up.from;
    return isFenceLineOf(state, range, fenceFrom) ? range : null;
  }
  if (pos !== line.to) return null;
  if (FENCE_LINE.test(line.text)) {
    const range = fencedRangeAt(state, Math.max(0, pos - 1)) || fencedRangeAt(state, pos);
    return range && isFenceLineOf(state, range, line.from) ? range : null;
  }
  if (pos + 1 < state.doc.length) {
    const next = state.doc.lineAt(pos + 1);
    if (FENCE_LINE.test(next.text)) {
      const range = fencedRangeAt(state, pos + 1);
      return range && isFenceLineOf(state, range, next.from) ? range : null;
    }
  }
  return null;
}

/** 删除时保护代码围栏和彩色文字的 span 不被拆成半截 */
function guardSmartDelete(view: EditorView, back: boolean) {
  const sel = view.state.selection.main;
  if (!sel.empty) return false; // 交给 guardSpanTransaction 统一修补
  const state = view.state;
  const pos = sel.head;
  const probeFrom = back ? pos - 1 : pos;
  const probeTo = back ? pos : pos + 1;
  if (probeFrom < 0 || probeTo > state.doc.length) return false;

  const broken = fenceBreakAt(state, pos, back);
  if (broken) {
    unwrapFence(view, broken, back);
    return true;
  }

  // 彩色文字删到最后一个字时，把空的 span 一起收走（否则正文里会剩一对空标签）
  const spanRange = spanDeleteRange(state, probeFrom, probeTo);
  if (spanRange) {
    view.dispatch({
      changes: { from: spanRange.from, to: spanRange.to },
      // 删掉最后一个字后，下一次输入继续沿用刚刚的字号 / 颜色
      effects: spanRange.css ? setPendingStyle.of(spanRange.css) : undefined,
      userEvent: back ? 'delete.backward' : 'delete.forward',
    });
    return true;
  }

  return false;
}

function smartDeleteBackward(view: EditorView) {
  return guardSmartDelete(view, true);
}

function smartDeleteForward(view: EditorView) {
  return guardSmartDelete(view, false);
}

function applyText(text: string, offset = 0) {
  return (view: EditorView, _completion: Completion, from: number, to: number) => {
    view.dispatch({
      changes: { from, to, insert: text },
      selection: { anchor: from + (offset || text.length) },
    });
    view.focus();
  };
}

/** 斜杠命令先吃掉输入的那几个字，再让工具栏打开对应的弹窗 */
function openDialog(event: string) {
  return (view: EditorView, _completion: Completion, from: number, to: number) => {
    view.dispatch({ changes: { from, to, insert: '' }, selection: { anchor: from } });
    window.dispatchEvent(new Event(event));
  };
}

export function Editor({
  note,
  onChange,
  onNotice,
  typewriter = false,
  initialPos = 0,
  focusOnMount = false,
  highlightTerms,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const typewriterSlot = useRef(new Compartment());
  const noteRef = useRef(note);
  const changeRef = useRef(onChange);
  const noticeRef = useRef(onNotice);
  const templatesRef = useRef<Template[]>([]);
  const highlightRef = useRef<string[]>([]);
  highlightRef.current = highlightTerms || [];
  noteRef.current = note;
  changeRef.current = onChange;
  noticeRef.current = onNotice;

  useEffect(() => {
    void listTemplates().then((list) => {
      templatesRef.current = list;
    });
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const slashSource = (ctx: CompletionContext): CompletionResult | null => {
      const m = ctx.matchBefore(/\/[^\s]*$/);
      if (!m) return null;
      const lineStart = ctx.state.doc.lineAt(m.from).from;
      if (ctx.state.sliceDoc(lineStart, m.from).trim() !== '') return null;

      const now = new Date();
      const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

      const options = [
        { label: t('/标题'), detail: t('二级标题'), apply: applyText('## ') },
        { label: t('/待办'), detail: t('任务清单'), apply: applyText('- [ ] ') },
        { label: t('/列表'), detail: t('无序列表'), apply: applyText('- ') },
        { label: t('/有序'), detail: t('编号列表'), apply: applyText('1. ') },
        { label: t('/引用'), detail: t('引用段落'), apply: applyText('> ') },
        { label: t('/代码'), detail: t('代码块，可粘贴并格式化'), apply: openDialog('glimnote:insert-code') },
        { label: t('/表格'), detail: t('在弹窗里填内容'), apply: openDialog('glimnote:insert-table') },
        { label: t('/分割线'), detail: t('水平分隔'), apply: applyText('---\n') },
        { label: t('/日期'), detail: dateStr, apply: applyText(dateStr) },
        { label: t('/时间'), detail: timeStr, apply: applyText(timeStr) },
        ...templatesRef.current.map((tpl) => ({
          label: t('/模板：{name}', { name: tpl.name }),
          detail: t('插入模板'),
          apply: applyText(renderTemplate(tpl.content, noteRef.current.title)),
        })),
      ];
      const term = m.text.slice(1).toLowerCase();
      const filtered = term
        ? options.filter((o) => o.label.toLowerCase().includes(term) || o.detail.toLowerCase().includes(term))
        : options;
      if (!filtered.length) return null;
      return { from: m.from, options: filtered, filter: false, validFor: /^\/[^\s]*$/ };
    };

    const wikiSource = (ctx: CompletionContext): CompletionResult | null => {
      const m = ctx.matchBefore(/\[\[[^\]\n]*$/);
      if (!m) return null;
      const term = m.text.slice(2);
      const notes = useApp.getState().notes;
      const options = notes
        .filter((n) => n.id !== noteRef.current.id && n.title.toLowerCase().includes(term.toLowerCase()))
        .slice(0, 24)
        .map((n) => ({
          label: n.title,
          detail: n.notebook || t('未分类'),
          apply: `${n.title}]]`,
        }));
      if (!options.length) return null;
      return { from: m.from + 2, options, filter: false, validFor: /^[^\]\n]*$/ };
    };

    const handleFiles = async (files: File[], view: EditorView) => {
      for (const file of files) {
        if (file.type.startsWith('image/')) {
          await insertImageFile(view, file, noteRef.current.path, (text) => noticeRef.current?.(text));
        } else {
          await insertAttachmentFile(view, file, noteRef.current.path, (text) => noticeRef.current?.(text));
        }
      }
    };

    const startPos = Math.min(Math.max(0, initialPos), noteRef.current.content.length);
    const state = EditorState.create({
      doc: noteRef.current.content,
      selection: { anchor: startPos },
      extensions: [
        ...pendingStyleExtensions,
        EditorState.transactionFilter.of(guardSpanTransaction),
        history(),
        drawSelection(),
        dropCursor(),
        highlightSpecialChars(),
        closeBrackets(),
        EditorState.allowMultipleSelections.of(true),
        // 比 markdown 自带的回车/退格规则更早介入：先退出空的引用行，也别删到藏起来的标记
        Prec.high(
          keymap.of([
            { key: 'Enter', run: smartEnter },
            { key: 'Backspace', run: smartDeleteBackward },
            { key: 'Delete', run: smartDeleteForward },
          ]),
        ),
        markdown({ base: markdownLanguage }),
        syntaxHighlighting(mdHighlight),
        searchHitField,
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({ spellcheck: 'false' }),
        cmPlaceholder(t('开始写点什么…  选中文字可以用上方按钮加粗')),
        autocompletion({ override: [slashSource, wikiSource], activateOnTyping: true, icons: false }),
        keymap.of([
          {
            key: 'Mod-b',
            run: (view) => {
              wrapSelection(view, '**', '**');
              return true;
            },
          },
          {
            key: 'Mod-i',
            run: (view) => {
              wrapSelection(view, '*', '*');
              return true;
            },
          },
          {
            key: 'Mod-Shift-x',
            run: (view) => {
              toggleLinePrefix(view, '- [ ] ');
              return true;
            },
          },
          {
            // 和工具栏「插入 → 链接…」共用同一个弹层，不再直接塞占位文字
            key: 'Mod-Shift-k',
            run: () => {
              window.dispatchEvent(new Event('glimnote:insert-link'));
              return true;
            },
          },
          ...defaultKeymap,
          ...historyKeymap,
          ...searchKeymap,
          indentWithTab,
        ]),
        typewriterSlot.current.of(typewriter ? typewriterExtensions : []),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) changeRef.current(u.state.doc.toString());
          if (u.focusChanged && u.view.hasFocus) setActiveView(u.view);
          // 工具栏靠这个事件同步「光标处 / 选中文字实际的字号」，光标移动和输入都会触发
          if (u.selectionSet || u.docChanged || u.focusChanged) {
            window.dispatchEvent(new CustomEvent('glimnote:editor-selection', { detail: { view: u.view } }));
          }
        }),
        EditorView.domEventHandlers({
          copy: (event, view) => writeClipboard(event, view, false),
          cut: (event, view) => writeClipboard(event, view, true),
          paste: (event, view) => {
            const data = event.clipboardData;
            if (!data) return false;
            const files: File[] = [];
            for (const item of data.items) {
              if (item.kind === 'file') {
                const f = item.getAsFile();
                if (f) files.push(f);
              }
            }
            if (files.length) {
              event.preventDefault();
              void handleFiles(files, view);
              return true;
            }
            // 源码模式只收纯文本；夹带不换行空格 / 零宽字符时先清掉再插入
            const raw = data.getData('text/plain');
            if (!raw) return false;
            const text = sanitizePastedText(raw);
            if (text === raw) return false;
            event.preventDefault();
            const { from, to } = view.state.selection.main;
            view.dispatch({
              changes: { from, to, insert: text },
              selection: { anchor: from + text.length },
            });
            return true;
          },
          drop: (event, view) => {
            const files = Array.from(event.dataTransfer?.files || []);
            if (!files.length) return false;
            event.preventDefault();
            void handleFiles(files, view);
            return true;
          },
          contextmenu: (event, view) => {
            // 菜单自己画（见 EditorContextMenu）；浏览器 / 系统那套在 Electron 里压根不弹
            event.preventDefault();
            const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
            const main = view.state.selection.main;
            // CodeMirror 只处理左键，右击不会自动挪光标。点在选择之外就移到点击处，
            // 否则菜单里的加粗 / 复制会作用在别的地方，看起来像「点错了」
            if (pos != null && (main.empty || pos < main.from || pos > main.to)) {
              view.dispatch({ selection: { anchor: pos } });
            }
            window.dispatchEvent(
              new CustomEvent('glimnote:editor-menu', {
                detail: { x: event.clientX, y: event.clientY },
              }),
            );
            return true;
          },
        }),
      ],
    });

    const view = new EditorView({ state, parent: host });
    viewRef.current = view;
    setActiveView(view);

    // 资源上传后把源码里的本地路径换成云端链接（富文本编辑器有另一套实现）
    const onAssetUrl = (event: Event) => {
      if (viewRef.current !== view) return;
      const detail = (event as CustomEvent<{ abs?: string; url?: string }>).detail;
      const abs = String(detail?.abs || '');
      const url = String(detail?.url || '');
      if (!abs || !url) return;
      const before = view.state.doc.toString();
      const next = rewriteAssetLinks(before, noteRef.current.path, abs, url);
      if (next === before) return;
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: next } });
    };
    window.addEventListener(ASSET_URL_EVENT, onAssetUrl);
    if (startPos > 0) {
      // 从阅读预览切回来时光标要回到原处，别把人扔回文章开头
      requestAnimationFrame(() => {
        if (viewRef.current !== view) return;
        view.dispatch({ effects: EditorView.scrollIntoView(startPos, { y: 'center' }) });
      });
    }
    if (focusOnMount) {
      // 新建日记有现成标题：光标放到末尾，别停在 # 前面
      if (startPos === 0 && view.state.doc.length > 0) {
        view.dispatch({ selection: { anchor: view.state.doc.length } });
      }
      view.focus();
    }

    return () => {
      if (document.activeElement === view.contentDOM) {
        /* 失去焦点由浏览器处理 */
      }
      window.removeEventListener(ASSET_URL_EVENT, onAssetUrl);
      viewRef.current = null;
      setActiveView(null);
      view.destroy();
    };
  }, [note.id]);

  // 关键词变化时只更新装饰，不重建编辑器，输入内容不会丢
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const terms = (highlightTerms || []).map((term) => term.trim()).filter(Boolean);
    const hit = terms.length ? firstSearchHit(view.state, terms) : -1;
    view.dispatch({
      effects: [setSearchTerms.of(terms), ...(hit >= 0 ? [EditorView.scrollIntoView(hit, { y: 'center' })] : [])],
    });
  }, [highlightTerms]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: typewriterSlot.current.reconfigure(typewriter ? typewriterExtensions : []),
    });
    if (typewriter) {
      const pos = view.state.selection.main.head;
      requestAnimationFrame(() => centerOn(view, pos));
    }
  }, [typewriter]);

  return <div className={typewriter ? 'cm-host typewriter' : 'cm-host'} ref={hostRef} />;
}
