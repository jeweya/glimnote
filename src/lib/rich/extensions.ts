import { Extension, Mark, Node, mergeAttributes } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { TextStyle, FontSize, Color, BackgroundColor } from '@tiptap/extension-text-style';
import { HardBreak } from '@tiptap/extension-hard-break';
import Paragraph from '@tiptap/extension-paragraph';
import Image from '@tiptap/extension-image';
import type { Node as PMNode } from '@tiptap/pm/model';
import { parseImageAlt, resolveAsset } from '../assets';
import { cachedAssetUrl } from './assetUrls';
import { EDITOR_BROKEN_HINT, isBrokenImage, markImageBroken, resetBrokenImage } from './imageFallback';

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

    /**
     * 网络图片加载失败时，ProseMirror 默认只会留下一个几乎看不见的裂图。
     * 这里用 NodeView 自己管理 <img>，出错就换成看得懂的占位图。
     *
     * 不能直接给普通节点改 src：ProseMirror 会把属性变化当成文档改动解析回去，
     * 占位图的 data URI 就会被写进 Markdown。NodeView 的 DOM 不参与解析，改起来安全。
     */
    addNodeView() {
      if (typeof document === 'undefined') return null;
      return ({ node }: { node: PMNode }) => {
        const dom = document.createElement('img');
        let current = node;

        const apply = (next: PMNode) => {
          resetBrokenImage(dom);
          dom.removeAttribute('data-glimnote-asset');
          const raw = String(next.attrs.src || '');
          const alt = String(next.attrs.alt || '');
          const title = String(next.attrs.title || '');
          const { width } = parseImageAlt(alt);
          const widthAttr = next.attrs.width ? String(next.attrs.width) : '';
          dom.alt = alt;
          if (title) dom.setAttribute('title', title);
          else dom.removeAttribute('title');
          const resolvedWidth = width ? String(width) : widthAttr;
          if (resolvedWidth) {
            dom.setAttribute('width', resolvedWidth);
            dom.style.width = `${resolvedWidth}px`;
            dom.style.maxWidth = '100%';
            dom.style.height = 'auto';
          } else {
            dom.removeAttribute('width');
            dom.style.width = '';
            dom.style.maxWidth = '';
            dom.style.height = '';
          }
          if (next.attrs.height) dom.style.height = `${next.attrs.height}px`;

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
            if (raw) dom.src = raw;
            else dom.removeAttribute('src');
          } else {
            // 仓库内的图片交给 assetUrls 换成 blob URL；没取到前先挂路径，
            // 避免出现裂图，编辑器的 hydrateAssetImages 会补上 src。
            const cached = cachedAssetUrl(abs);
            if (cached) {
              dom.src = cached;
            } else {
              dom.removeAttribute('src');
              dom.setAttribute('data-glimnote-asset', abs);
            }
          }
        };

        const onError = () => {
          if (isBrokenImage(dom)) return;
          markImageBroken(dom, EDITOR_BROKEN_HINT);
        };

        apply(node);
        dom.addEventListener('error', onError);

        return {
          dom,
          update(next: PMNode) {
            if (next.type !== current.type) return false;
            const same =
              String(next.attrs.src || '') === String(current.attrs.src || '') &&
              String(next.attrs.alt || '') === String(current.attrs.alt || '') &&
              String(next.attrs.title || '') === String(current.attrs.title || '') &&
              String(next.attrs.width || '') === String(current.attrs.width || '') &&
              String(next.attrs.height || '') === String(current.attrs.height || '');
            current = next;
            if (!same) apply(next);
            return true;
          },
          selectNode() {
            dom.classList.add('ProseMirror-selectednode');
          },
          deselectNode() {
            dom.classList.remove('ProseMirror-selectednode');
          },
          destroy() {
            dom.removeEventListener('error', onError);
          },
        };
      };
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

/**
 * 粘贴图片时的临时占位。
 *
 * 粘贴后要压缩图片、必要时上传七牛云，几秒钟里编辑器里什么都没有，
 * 很容易被当成没粘上。这里先插一个带本地预览的占位节点，图立刻可见、
 * 盖一层「正在保存」；保存完成后由编辑器把它换成正真的图片节点。
 *
 * 占位不属于笔记内容：renderMarkdown 返回空串，就算这期间自动存盘，
 * Markdown 里也不会出现 blob: 地址，更不会把占位写进笔记。
 */
const PENDING_IMAGE_TEXT = '正在保存图片…';

export const PendingImage = Node.create({
  name: 'pendingImage',
  inline: true,
  group: 'inline',
  atom: true,
  selectable: false,
  draggable: false,
  addAttributes() {
    return {
      /** 用来在文档里找回这个占位，换成真图片 */
      id: { default: null },
      /** 本地预览地址（blob:），只在编辑期间有效 */
      src: { default: '' },
      /** 已经本地化的提示文字，例如「正在保存粘贴的图片…」 */
      label: { default: '' },
    };
  },
  // 不参与解析：复制出去的占位不该在别处又变成一个永远转不完的转圈
  parseHTML() {
    return [];
  },
  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes({ 'data-pending-image': '' }, HTMLAttributes)];
  },
  renderMarkdown() {
    return '';
  },
  addNodeView() {
    if (typeof document === 'undefined') return null;
    return ({ node }: { node: PMNode }) => {
      const dom = document.createElement('span');
      dom.className = 'gm-pending-image';
      dom.setAttribute('data-pending-image', '');
      // 占位里的文字只是提示，不算笔记内容：查找 / 复制都不该捞到它
      dom.contentEditable = 'false';

      const img = document.createElement('img');
      img.className = 'gm-pending-preview';
      img.alt = '';
      img.draggable = false;

      const chip = document.createElement('span');
      chip.className = 'gm-pending-chip';
      const ring = document.createElement('span');
      ring.className = 'gm-pending-ring';
      const text = document.createElement('span');
      chip.append(ring, text);
      dom.append(img, chip);

      let current = node;
      let blobUrl = '';

      const apply = (next: PMNode) => {
        const src = String(next.attrs.src || '');
        // 预览地址变了（或占位被复用到别的图片）时，旧的 blob URL 要释放
        if (src !== blobUrl) {
          if (blobUrl.startsWith('blob:')) URL.revokeObjectURL(blobUrl);
          blobUrl = src;
        }
        if (blobUrl) {
          if (img.getAttribute('src') !== blobUrl) img.src = blobUrl;
          dom.classList.add('has-preview');
        } else {
          img.removeAttribute('src');
          dom.classList.remove('has-preview');
        }
        text.textContent = String(next.attrs.label || '') || PENDING_IMAGE_TEXT;
      };

      apply(node);

      return {
        dom,
        update(next: PMNode) {
          if (next.type !== current.type) return false;
          current = next;
          apply(next);
          return true;
        },
        destroy() {
          if (blobUrl.startsWith('blob:')) URL.revokeObjectURL(blobUrl);
        },
      };
    };
  },
});

export { TextStyle, FontSize, Color, BackgroundColor };
