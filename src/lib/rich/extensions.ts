import { Extension, Mark, Node, mergeAttributes } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { TextStyle, FontSize, Color, BackgroundColor } from '@tiptap/extension-text-style';
import { HardBreak } from '@tiptap/extension-hard-break';
import Paragraph from '@tiptap/extension-paragraph';
import Image from '@tiptap/extension-image';
import { parseImageAlt, resolveAsset } from '../assets';
import { cachedAssetUrl } from './assetUrls';

export type Align = 'left' | 'center' | 'right';

/**
 * 字号 / 颜色 / 背景色在 Markdown 里一直是用行内 span 保存的：
 * `<span style="font-size:24px">…</span>`。TipTap 自带的 TextStyle 只处理编辑区 DOM，
 * 不会写回 Markdown，这里补上序列化，保证存盘格式和旧笔记完全兼容。
 */
export const MarkdownTextStyle = TextStyle.extend({
  renderMarkdown(node, helpers) {
    const attrs = node.attrs || {};
    const styles: string[] = [];
    if (attrs.fontSize) styles.push(`font-size:${attrs.fontSize}`);
    if (attrs.color) styles.push(`color:${attrs.color}`);
    if (attrs.backgroundColor) styles.push(`background-color:${attrs.backgroundColor}`);
    if (attrs.fontFamily) styles.push(`font-family:${attrs.fontFamily}`);
    const content = helpers.renderChildren(node.content || []);
    if (!styles.length) return content;
    return `<span style="${styles.join(';')}">${content}</span>`;
  },
});

/**
 * 对齐沿用旧格式 `<span style="display:block;text-align:center">整行</span>`，
 * 阅读预览和导出 HTML 都能直接认出来。它是一个 Mark，不改变段落结构，
 * 因此标题、列表前缀都还在。
 */
export const Alignment = Mark.create({
  name: 'alignment',
  priority: 90,
  addAttributes() {
    return {
      align: {
        default: null,
        parseHTML: (element) => {
          const value = (element as HTMLElement).style.textAlign;
          return value === 'center' || value === 'right' || value === 'left' ? value : null;
        },
        renderHTML: (attributes) => {
          if (!attributes.align || attributes.align === 'left') return {};
          return { style: `display:block;text-align:${attributes.align}` };
        },
      },
    };
  },
  parseHTML() {
    return [
      {
        tag: 'span',
        consuming: false,
        getAttrs: (element) => {
          const value = (element as HTMLElement).style.textAlign;
          if (value !== 'center' && value !== 'right' && value !== 'left') return false;
          return { align: value };
        },
      },
    ];
  },
  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes), 0];
  },
  renderMarkdown(node, helpers) {
    const align = node.attrs?.align as Align | null;
    const content = helpers.renderChildren(node.content || []);
    if (!align || align === 'left') return content;
    return `<span style="display:block;text-align:${align}">${content}</span>`;
  },
  addCommands() {
    return {
      setAlignment:
        (align: Align) =>
        ({ state, tr, dispatch }) => {
          const ranges: { from: number; to: number }[] = [];
          state.doc.nodesBetween(state.selection.from, state.selection.to, (node, pos) => {
            if (node.isTextblock) {
              ranges.push({ from: pos + 1, to: pos + 1 + node.content.size });
              return false;
            }
            return true;
          });
          if (!ranges.length) {
            const { $from } = state.selection;
            for (let depth = $from.depth; depth > 0; depth--) {
              const node = $from.node(depth);
              if (node.isTextblock) {
                ranges.push({ from: $from.start(depth), to: $from.end(depth) });
                break;
              }
            }
          }
          if (!dispatch) return true;
          const markType = state.schema.marks.alignment;
          if (!markType) return false;
          for (const range of ranges) {
            if (range.to > range.from) {
              if (align === 'left') tr.removeMark(range.from, range.to, markType);
              else tr.addMark(range.from, range.to, markType.create({ align }));
            } else if (align !== 'left') {
              // 空段落：把样式挂在待输入状态上，接着敲的字才会居中
              tr.setStoredMarks([
                ...(tr.storedMarks || state.storedMarks || state.selection.$from.marks()),
                markType.create({ align }),
              ]);
            }
          }
          dispatch(tr);
          return true;
        },
    };
  },
});

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    alignment: {
      setAlignment: (align: Align) => ReturnType;
    };
  }
}

/** 分页符：打印 / 导出 PDF 时的硬分页，Markdown 里仍是一个普通 HTML div */
export const PageBreak = Node.create({
  name: 'pageBreak',
  group: 'block',
  atom: true,
  selectable: true,
  parseHTML() {
    return [{ tag: 'div.page-break' }, { tag: 'div[data-type="page-break"]' }];
  },
  renderHTML() {
    return ['div', { class: 'page-break', 'data-type': 'page-break' }];
  },
  renderMarkdown() {
    return '<div class="page-break"></div>';
  },
});

/**
 * 单个换行在旧笔记里很常见（日记尤其多）。marked 用 breaks:true 把它当换行，
 * 序列化时也写回一个裸换行，而不是 GFM 的「两个空格 + 换行」，避免每次保存都改格式。
 */
export const SoftHardBreak = HardBreak.extend({
  renderMarkdown() {
    return '\n';
  },
});

/**
 * 段落写回 Markdown 时，库只转义行内符号（* _ ` [ ] ~），不管行首的块级语法。
 * 于是从网页复制来的「# 标题」「- 条目」「1. 步骤」「    缩进」存盘后重新打开
 * 就变成了标题 / 列表 / 代码块，和粘贴时看到的不是同一篇笔记。这里逐行补一次
 * 行首转义，让原文原样保存。
 */
function escapeMarkdownLineStarts(markdown: string) {
  return markdown
    .split('\n')
    .map((line) => {
      let out = line;
      // 四空格 / 制表符缩进在 Markdown 里是代码块，换成等值的 HTML 实体
      out = out.replace(/^([ \t]+)/, (spaces) => {
        if (spaces.replace(/\t/g, '    ').length < 4) return spaces;
        return spaces.replace(/\t/g, '&#32;&#32;&#32;&#32;').replace(/ /g, '&#32;');
      });
      // ATX 标题
      out = out.replace(/^([ \t]*)(#{1,6})(?=[ \t]|$)/, '$1\\$2');
      // 无序列表（- 还包括 --- / - - - 这种分隔线）
      out = out.replace(/^([ \t]*)(-)(?=[ \t]|$|-)/, '$1\\$2');
      out = out.replace(/^([ \t]*)(\+)(?=[ \t]|$)/, '$1\\$2');
      // 有序列表
      out = out.replace(/^([ \t]*)(\d{1,9})([.)])(?=[ \t]|$)/, '$1$2\\$3');
      // 上一行的下划线标题
      out = out.replace(/^([ \t]*)(=+)[ \t]*$/, '$1\\$2');
      return out;
    })
    .join('\n');
}

export const MarkdownSafeParagraph = Paragraph.extend({
  renderMarkdown(node, helpers, ctx) {
    if (!node) return '';
    const content = Array.isArray(node.content) ? node.content : [];
    if (content.length === 0) {
      const previousContent = Array.isArray(ctx?.previousNode?.content) ? ctx.previousNode.content : [];
      return ctx?.previousNode?.type === 'paragraph' && previousContent.length === 0 ? '&nbsp;' : '';
    }
    return escapeMarkdownLineStarts(helpers.renderChildren(content));
  },
});

/**
 * 图片：文档里保留笔记内的相对路径（存回 Markdown 用）。
 * 渲染时把仓库路径交给 assetUrls 换成本地 blob URL（/repo/… 浏览器打不开），
 * 取不到地址前先不写 src；alt 末尾的 |宽度 也一并还原。
 */
export function createRichImage(notePath: string) {
  return Image.extend({
    renderHTML({ node, HTMLAttributes }) {
      const raw = String(node.attrs.src || '');
      const alt = String(node.attrs.alt || '');
      const { width } = parseImageAlt(alt);
      const attrs: Record<string, unknown> = {
        ...mergeAttributes(HTMLAttributes),
        alt,
        ...(width
          ? {
              width: String(width),
              style: `width:${width}px;max-width:100%;height:auto`,
            }
          : {}),
      };
      // 文件名里的中文 / 空格有时被编码成 %E6…，和阅读模式一样先还原再找文件
      let src = raw;
      try {
        src = decodeURI(raw);
      } catch {
        src = raw;
      }
      const abs = resolveAsset(notePath, src);
      if (!abs) {
        // 网络图片 / data URL 原样显示
        attrs.src = raw;
      } else {
        // 仓库内的图片不能直接拿 /repo/… 当 src，交给 assetUrls 换成 blob URL；
        // 还没取到地址时先不写 src，避免出现裂图，挂个路径让编辑器去补。
        const cached = cachedAssetUrl(abs);
        if (cached) {
          attrs.src = cached;
        } else {
          delete attrs.src;
          attrs['data-glimnote-asset'] = abs;
        }
      }
      return ['img', attrs];
    },
  });
}

const WIKI_RE = /\[\[([^[\]|]+)(?:\|([^[\]]+))?\]\]/g;
const wikiKey = new PluginKey('wikiLinkDecoration');

/**
 * 双链 `[[标题]]` / `[[标题|别名]]` 在 Markdown 里就是纯文字。
 * 不把它做成节点，只用装饰器上色和加点击区域：读写都不会多出任何语法，
 * 旧笔记、其它编辑器（Obsidian 等）看到的仍是原样。
 */
export const WikiLink = Extension.create({
  name: 'wikiLinkDecoration',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: wikiKey,
        props: {
          decorations(state) {
            const decorations: Decoration[] = [];
            state.doc.descendants((node, pos) => {
              if (!node.isText) return;
              if (node.marks.some((mark) => mark.type.name === 'code')) return;
              if (state.doc.resolve(pos).parent?.type.name === 'codeBlock') return;
              const text = node.text || '';
              WIKI_RE.lastIndex = 0;
              let match: RegExpExecArray | null;
              while ((match = WIKI_RE.exec(text))) {
                const from = pos + match.index;
                decorations.push(
                  Decoration.inline(from, from + match[0].length, {
                    class: 'tiptap-wiki',
                    'data-wiki': match[1].trim(),
                  }),
                );
              }
            });
            return DecorationSet.create(state.doc, decorations);
          },
        },
      }),
    ];
  },
});

export { TextStyle, FontSize, Color, BackgroundColor };
