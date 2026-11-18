import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Copy,
  ExternalLink,
  Eye,
  Minus,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Table2,
  Trash2,
  X,
} from 'lucide-react';
import { Editor as TiptapEditor } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { FontSize, Color, BackgroundColor } from '@tiptap/extension-text-style';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import { TableKit } from '@tiptap/extension-table';
import Placeholder from '@tiptap/extension-placeholder';
import type { Note } from '../lib/markdown';
import { listTemplates, renderTemplate } from '../lib/repo';
import { useApp } from '../store/app';
import { effectiveAttachLimitMb, prepareAttachmentAsset, prepareImageAsset } from '../lib/editorBridge';
import { markdownToHtml } from '../lib/rich/markdown';
import {
  Alignment,
  MarkdownSafeParagraph,
  MarkdownTextStyle,
  PageBreak,
  SoftHardBreak,
  WikiLink,
  createRichImage,
} from '../lib/rich/extensions';
import { richInsertAttachment, richInsertImage, richTableAtPosition, richToggleList, setActiveRichEditor } from '../lib/rich/bridge';
import { hydrateAssetImages } from '../lib/rich/assetUrls';
import { sanitizePastedHtml, sanitizePastedText } from '../lib/rich/sanitize';
import { htmlToPlainText, plainTextToHtml } from '../lib/rich/formattedPaste';
import { parseImageAlt, withImageWidth } from '../lib/assets';
import { openExternal } from '../lib/openExternal';
import { t, useT } from '../lib/i18n';

interface Props {
  note: Note;
  onChange: (content: string) => void;
  onNotice?: (text: string) => void;
  /** 打字机模式：输入时让光标所在行保持在编辑区垂直中央 */
  typewriter?: boolean;
  /** 重新挂载时把光标放回这里（ProseMirror 文档位置） */
  initialPos?: number;
  /** 挂载后自动聚焦 */
  focusOnMount?: boolean;
  /** 从搜索结果打开时要高亮的正文关键词，不改动文档内容 */
  highlightTerms?: string[];
  /** 点击 [[双链]] 时跳到对应笔记 */
  onWiki?: (title: string) => void;
}

interface Template {
  name: string;
  content: string;
}

interface SuggestItem {
  label: string;
  detail: string;
  run: (editor: TiptapEditor) => void;
}

interface SuggestState {
  kind: 'slash' | 'wiki';
  from: number;
  to: number;
  query: string;
  left: number;
  top: number;
  items: SuggestItem[];
  index: number;
}

/** 把光标所在行滚到编辑区正中 */
function centerOn(editor: TiptapEditor) {
  const host = editor.view.dom.closest('.rich-scroll') as HTMLElement | null;
  if (!host) return;
  const coords = editor.view.coordsAtPos(editor.state.selection.head);
  const rect = host.getBoundingClientRect();
  const target = host.scrollTop + (coords.top + coords.bottom) / 2 - (rect.top + rect.height / 2);
  const max = host.scrollHeight - host.clientHeight;
  host.scrollTop = Math.max(0, Math.min(target, max));
}

function dateText() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function timeText() {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

/** TipTap 导出的 Markdown 不带结尾换行，落盘前补回来，和手写笔记保持一致 */
function markdownOf(editor: TiptapEditor) {
  const markdown = editor.getMarkdown();
  if (!markdown.trim()) return '';
  return markdown.endsWith('\n') ? markdown : `${markdown}\n`;
}

/**
 * 剪贴板里的图片：files 大多数情况有值，但截图工具 / 部分应用只把文件放在
 * items 里，直接读 files 会漏掉，于是粘贴后什么都没有。
 */
function clipboardFiles(data: DataTransfer | null): File[] {
  if (!data) return [];
  const direct = Array.from(data.files || []);
  if (direct.length) return direct;
  const files: File[] = [];
  for (const item of Array.from(data.items || [])) {
    if (item.kind !== 'file') continue;
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  return files;
}

/**
 * 网页剪贴板里的内嵌图片常常是 data URL（base64 或百分号编码）。编辑器默认
 * 不收 base64，直接落盘成仓库文件，既不会丢图，也不会把整张图塞进 Markdown。
 */
function dataUrlToFile(dataUrl: string, alt: string): File | null {
  const match = /^data:(image\/[a-z0-9.+-]+)((?:;[^,]*)*),([\s\S]*)$/i.exec(dataUrl);
  if (!match) return null;
  const mime = match[1].toLowerCase();
  const meta = match[2] || '';
  const payload = match[3] || '';
  if (!payload) return null;

  let bytes: Uint8Array;
  try {
    if (/;\s*base64/i.test(meta)) {
      const binary = atob(payload.replace(/\s+/g, ''));
      bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    } else {
      bytes = new TextEncoder().encode(decodeURIComponent(payload));
    }
  } catch {
    return null;
  }
  if (!bytes.length) return null;

  const subtype = mime.slice('image/'.length);
  const ext = subtype === 'jpeg' ? 'jpg' : subtype === 'svg+xml' ? 'svg' : subtype.replace(/[^a-z0-9]/g, '') || 'png';
  const base = (alt || '粘贴图片').replace(/[\\/:*?"<>|\r\n]+/g, ' ').trim().slice(0, 32) || '粘贴图片';
  return new File([bytes.buffer as ArrayBuffer], `${base}.${ext}`, { type: mime });
}

interface TextPiece {
  node: Text;
  start: number;
  end: number;
}

/**
 * 查找只针对正文可见文字：任务项的复选框标签、分页符这些不该出现在结果里。
 * 跨 block 的拼接处补一个换行，避免一句话被搜到下一段。
 */
function collectText(root: HTMLElement) {
  const pieces: TextPiece[] = [];
  let text = '';
  let lastBlock: Element | null = null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      const value = node.nodeValue;
      if (!parent || !value || !value.trim()) return NodeFilter.FILTER_REJECT;
      if (parent.closest('label, [contenteditable="false"], .page-break')) return NodeFilter.FILTER_REJECT;
      if (parent.closest('.rich-suggest')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let current: Node | null = walker.nextNode();
  while (current) {
    const node = current as Text;
    const parent = node.parentElement!;
    const block = parent.closest('p, h1, h2, h3, h4, h5, h6, li, blockquote, pre, td, th') || parent;
    if (lastBlock && block !== lastBlock) text += '\n';
    lastBlock = block;
    const start = text.length;
    text += node.nodeValue || '';
    pieces.push({ node, start, end: text.length });
    current = walker.nextNode();
  }
  return { text, pieces };
}

function rangeFor(pieces: TextPiece[], start: number, end: number) {
  const first = pieces.find((piece) => start >= piece.start && start < piece.end);
  const last = pieces.find((piece) => end > piece.start && end <= piece.end);
  if (!first || !last) return null;
  const range = document.createRange();
  range.setStart(first.node, start - first.start);
  range.setEnd(last.node, end - last.start);
  return range;
}

function findRanges(root: HTMLElement, query: string) {
  const { text, pieces } = collectText(root);
  const needle = query.toLocaleLowerCase();
  const haystack = text.toLocaleLowerCase();
  const out: Range[] = [];
  if (!needle) return out;
  let at = haystack.indexOf(needle);
  while (at >= 0 && out.length < 500) {
    const range = rangeFor(pieces, at, at + needle.length);
    if (range) out.push(range);
    at = haystack.indexOf(needle, at + Math.max(1, needle.length));
  }
  return out;
}

function paintFind(ranges: Range[], active: number) {
  const registry = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
  const HighlightCtor = (window as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
  if (!registry || !HighlightCtor) return;
  try {
    if (!ranges.length) {
      registry.delete('glimnote-find');
      registry.delete('glimnote-find-current');
      return;
    }
    registry.set('glimnote-find', new HighlightCtor(...ranges));
    if (active >= 0 && ranges[active]) {
      registry.set('glimnote-find-current', new HighlightCtor(ranges[active]));
    } else {
      registry.delete('glimnote-find-current');
    }
  } catch {
    /* 浏览器不支持高亮 API 时仍可用上下条定位 */
  }
}

function revealRange(range: Range) {
  const host = document.querySelector<HTMLElement>('.rich-scroll');
  if (!host) return;
  const rect = range.getBoundingClientRect();
  if (!rect.height) return;
  const box = host.getBoundingClientRect();
  const target = host.scrollTop + rect.top - box.top - box.height / 2 + rect.height / 2;
  host.scrollTo({ top: Math.max(0, Math.min(target, host.scrollHeight - host.clientHeight)), behavior: 'smooth' });
}

export function RichEditor({
  note,
  onChange,
  onNotice,
  typewriter = false,
  initialPos = 0,
  focusOnMount = false,
  highlightTerms,
  onWiki,
}: Props) {
  const tr = useT();
  const hostRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<TiptapEditor | null>(null);
  const noteRef = useRef(note);
  const changeRef = useRef(onChange);
  const noticeRef = useRef(onNotice);
  const wikiRef = useRef(onWiki);
  const typewriterRef = useRef(typewriter);
  const templatesRef = useRef<Template[]>([]);
  const saveTimer = useRef(0);
  const dirty = useRef(false);
  const applying = useRef(false);
  const [menu, setMenu] = useState<SuggestState | null>(null);
  const menuRef = useRef<SuggestState | null>(null);
  menuRef.current = menu;
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [findTotal, setFindTotal] = useState(0);
  const [findPos, setFindPos] = useState(0);
  const findRangesRef = useRef<Range[]>([]);
  const findPosRef = useRef(0);
  const findInputRef = useRef<HTMLInputElement>(null);
  const highlightRef = useRef<string[]>([]);
  highlightRef.current = highlightTerms || [];
  /** 光标在表格里时浮在表格右上角的「编辑表格」入口 */
  const [tableChip, setTableChip] = useState<{ pos: number; left: number; top: number } | null>(null);
  /** 点中图片后浮在图片上方的宽度调节条 */
  const [imageBar, setImageBar] = useState<{ pos: number; left: number; top: number; width: number } | null>(null);
  /** 点中链接后浮出的查看 / 编辑条：可直接打开、复制、改地址或去掉链接 */
  const [linkPop, setLinkPop] = useState<{
    href: string;
    text: string;
    left: number;
    top: number;
    editing: boolean;
  } | null>(null);

  noteRef.current = note;
  changeRef.current = onChange;
  noticeRef.current = onNotice;
  wikiRef.current = onWiki;
  typewriterRef.current = typewriter;

  useEffect(() => {
    void listTemplates().then((list) => {
      templatesRef.current = list;
    });
  }, []);

  /** 表格入口跟着「光标是否在表格里」走，贴在表格右上角 */
  function syncTableChip(editor: TiptapEditor) {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const { $from } = editor.state.selection;
    let depth = $from.depth;
    while (depth > 0 && $from.node(depth).type.name !== 'table') depth -= 1;
    if (depth <= 0) {
      setTableChip(null);
      return;
    }
    const pos = $from.before(depth);
    const nodeDom = editor.view.nodeDOM(pos);
    if (!(nodeDom instanceof HTMLElement)) {
      setTableChip(null);
      return;
    }
    const rect = nodeDom.getBoundingClientRect();
    const box = wrap.getBoundingClientRect();
    // 表格整个滚出视口时不要再浮一个入口
    if (rect.bottom < box.top || rect.top > box.bottom) {
      setTableChip(null);
      return;
    }
    const left = Math.max(4, Math.min(rect.right - box.left - 96, box.width - 104));
    const top = Math.max(4, rect.top - box.top - 28);
    setTableChip((prev) =>
      prev && prev.pos === pos && prev.left === left && prev.top === top ? prev : { pos, left, top },
    );
  }

  /** 宽度条贴在图片上沿，改完宽度 / 文档变化后重新定位 */
  function placeImageBar(pos: number) {
    const wrap = wrapRef.current;
    const editor = editorRef.current;
    if (!wrap || !editor) return;
    const nodeDom = editor.view.nodeDOM(pos);
    if (!(nodeDom instanceof HTMLImageElement)) {
      setImageBar(null);
      return;
    }
    const rect = nodeDom.getBoundingClientRect();
    const box = wrap.getBoundingClientRect();
    const barWidth = 236;
    const left = Math.max(4, Math.min(rect.right - box.left - barWidth, box.width - barWidth - 4));
    const top = Math.max(4, rect.top - box.top - 32);
    const width = Math.round(rect.width);
    setImageBar((prev) =>
      prev && prev.pos === pos && prev.left === left && prev.top === top && prev.width === width
        ? prev
        : { pos, left, top, width },
    );
  }

  /** 点中图片：在文档里找到它的位置，浮出宽度调节条 */
  function openImageBar(img: HTMLImageElement) {
    const editor = editorRef.current;
    if (!editor) return;
    let found = -1;
    editor.state.doc.descendants((node, pos) => {
      if (found >= 0) return false;
      if (node.type.name === 'image' && editor.view.nodeDOM(pos) === img) {
        found = pos;
        return false;
      }
      return true;
    });
    if (found < 0) setImageBar(null);
    else placeImageBar(found);
  }

  /**
   * 点中链接：光标已经落在链接文字里（TipTap 关闭了 openOnClick），
   * 这里只负责把查看 / 编辑条贴在链接下方。位置按链接的实际宽度夹住，
   * 免得靠近右边框时浮层伸出编辑区外。
   */
  function openLinkPop(anchor: HTMLAnchorElement) {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const href = anchor.getAttribute('href') || '';
    if (!href) return;
    const rect = anchor.getBoundingClientRect();
    const box = wrap.getBoundingClientRect();
    const width = 340;
    const left = Math.max(4, Math.min(rect.left - box.left, box.width - width - 8));
    // 下面放得下就放下面，靠近底部时翻到链接上方
    const below = rect.bottom - box.top + 8;
    const top = below + 150 > box.height ? Math.max(4, rect.top - box.top - 46) : below;
    setLinkPop({ href, text: anchor.textContent || '', left, top, editing: false });
    setImageBar(null);
    setTableChip(null);
  }

  /** 保存链接修改：文字没变只改地址，文字改了就连同链接一起替换 */
  const applyLinkEdit = () => {
    const editor = editorRef.current;
    if (!editor || !linkPop) return;
    const href = linkPop.href.trim() || 'https://';
    const text = linkPop.text.trim() || t('链接文字');
    editor.chain().focus().extendMarkRange('link').run();
    const { from, to } = editor.state.selection;
    const selected = editor.state.doc.textBetween(from, to, '\n', ' ');
    if (selected === text) {
      editor.chain().focus().setLink({ href }).run();
    } else {
      editor
        .chain()
        .focus()
        .insertContentAt({ from, to }, { type: 'text', text, marks: [{ type: 'link', attrs: { href } }] })
        .run();
    }
    setLinkPop(null);
  };

  const removeLink = () => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.chain().focus().extendMarkRange('link').unsetLink().run();
    setLinkPop(null);
  };

  const openLinkTarget = () => {
    if (!linkPop) return;
    void openExternal(linkPop.href).catch((err) => {
      noticeRef.current?.(err instanceof Error ? err.message : String(err));
    });
  };

  const copyLink = () => {
    if (!linkPop) return;
    void navigator.clipboard
      .writeText(linkPop.href)
      .then(() => noticeRef.current?.(t('链接已复制')))
      .catch(() => noticeRef.current?.(t('没能写入剪贴板，请手动选中复制')));
  };

  /** 打开表格弹窗：数据从当前表格节点读，位置交给桥接层替换 */
  const openTableModal = () => {
    if (!tableChip) return;
    // +1 落在表格内部，才能沿祖先链找到 table 节点本身
    const info = richTableAtPosition(tableChip.pos + 1);
    if (!info) {
      setTableChip(null);
      return;
    }
    window.dispatchEvent(new CustomEvent('glimnote:edit-rich-table', { detail: { pos: info.pos, data: info.data } }));
  };

  /** 图片宽度仍写在 alt 里（![说明|宽度](路径)），换宽度就是换 alt */
  const resizeImage = (factor: number | null) => {
    const editor = editorRef.current;
    const bar = imageBar;
    if (!editor || !bar) return;
    const node = editor.state.doc.nodeAt(bar.pos);
    if (!node || node.type.name !== 'image') {
      setImageBar(null);
      return;
    }
    const rawAlt = String(node.attrs.alt || '');
    const base = parseImageAlt(rawAlt).width || bar.width;
    const next = factor == null ? null : Math.max(40, Math.min(4000, Math.round(base * factor)));
    editor
      .chain()
      .focus()
      .setNodeSelection(bar.pos)
      .updateAttributes('image', { alt: withImageWidth(rawAlt, next) })
      .run();
    requestAnimationFrame(() => placeImageBar(bar.pos));
  };

  const previewImage = () => {
    const editor = editorRef.current;
    if (!editor || !imageBar) return;
    const el = editor.view.nodeDOM(imageBar.pos);
    if (!(el instanceof HTMLImageElement)) return;
    window.dispatchEvent(
      new CustomEvent('glimnote:image-preview', {
        detail: { url: el.currentSrc || el.src, alt: el.alt || t('图片') },
      }),
    );
  };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const edit = new TiptapEditor({
      element: host,
      content: markdownToHtml(noteRef.current.content),
      extensions: [
        StarterKit.configure({
          hardBreak: false,
          paragraph: false,
          link: { openOnClick: false, autolink: true, linkOnPaste: true },
        }),
        MarkdownSafeParagraph,
        SoftHardBreak,
        Markdown,
        MarkdownTextStyle,
        FontSize,
        Color,
        BackgroundColor,
        Alignment,
        PageBreak,
        WikiLink,
        TaskList,
        TaskItem.configure({ nested: true }),
        TableKit,
        createRichImage(noteRef.current.path),
        Placeholder.configure({
          placeholder: t('开始写点什么…  输入 / 打开命令，输入 [[ 引用另一篇笔记'),
        }),
      ],
      editorProps: {
        attributes: {
          class: 'tiptap rich-content',
          spellcheck: 'false',
        },
        transformPastedText(text) {
          return sanitizePastedText(text);
        },
        transformPastedHTML(html) {
          return sanitizePastedHtml(html);
        },
        handlePaste(view, event) {
          const files = clipboardFiles(event.clipboardData);
          if (files.length) {
            event.preventDefault();
            void insertFiles(files);
            return true;
          }
          const data = event.clipboardData;
          if (!data) return false;
          const html = data.getData('text/html');
          // 内嵌 data URL 图片要先存成仓库文件，异步处理完再一次性插入
          if (html && /data:image\//i.test(html)) {
            const { from, to } = view.state.selection;
            event.preventDefault();
            void insertHtmlWithDataImages(html, from, to);
            return true;
          }
          return false;
        },
        handleDrop(_view, event) {
          const files = clipboardFiles(event.dataTransfer);
          if (!files.length) return false;
          event.preventDefault();
          void insertFiles(files);
          return true;
        },
        handleDOMEvents: {
          contextmenu(view, event) {
            const mouse = event as MouseEvent;
            mouse.preventDefault();
            // 右击不自动挪光标，但菜单里的加粗 / 复制得作用在点到的位置
            const at = view.posAtCoords({ left: mouse.clientX, top: mouse.clientY });
            const { from, to } = view.state.selection;
            if (at && (from === to || at.pos < from || at.pos > to)) {
              view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at.pos)));
              view.focus();
            }
            window.dispatchEvent(
              new CustomEvent('glimnote:editor-menu', {
                detail: { x: mouse.clientX, y: mouse.clientY, rich: true },
              }),
            );
            return true;
          },
        },
      },
      onCreate({ editor }) {
        setActiveRichEditor(editor);
        if (initialPos > 0) {
          const at = Math.min(initialPos, editor.state.doc.content.size);
          editor.commands.setTextSelection(at);
          requestAnimationFrame(() => editor.commands.scrollIntoView());
        }
        if (focusOnMount) {
          requestAnimationFrame(() => {
            // 新建的日记自带标题，光标落到正文末尾；普通新笔记是空文档，落哪都一样
            if (initialPos === 0 && editor.state.doc.content.size > 0) editor.commands.focus('end');
            else editor.commands.focus();
          });
        }
      },
      onFocus({ editor }) {
        setActiveRichEditor(editor);
        window.dispatchEvent(new CustomEvent('glimnote:editor-selection', { detail: { rich: true } }));
      },
      onSelectionUpdate({ editor }) {
        window.dispatchEvent(new CustomEvent('glimnote:editor-selection', { detail: { rich: true } }));
        syncTableChip(editor);
        if (typewriterRef.current) {
          requestAnimationFrame(() => requestAnimationFrame(() => centerOn(editor)));
        }
      },
      onUpdate({ editor }) {
        dirty.current = true;
        window.dispatchEvent(new CustomEvent('glimnote:editor-selection', { detail: { rich: true } }));
        syncTableChip(editor);
        if (saveTimer.current) window.clearTimeout(saveTimer.current);
        saveTimer.current = window.setTimeout(() => {
          saveTimer.current = 0;
          if (!dirty.current) return;
          dirty.current = false;
          changeRef.current(markdownOf(editor));
        }, 180);
        updateSuggestions(editor);
        // 新粘贴 / 新插入的图片在下一帧补上地址
        void hydrateAssetImages(editor.view.dom);
      },
      onBlur({ editor }) {
        if (saveTimer.current) window.clearTimeout(saveTimer.current);
        saveTimer.current = 0;
        if (dirty.current) {
          dirty.current = false;
          changeRef.current(markdownOf(editor));
        }
        // 点到编辑区外就收起图片宽度条（条上按钮已阻止默认，不会触发这里）
        setImageBar(null);
        setMenu(null);
      },
      onDestroy() {
        setActiveRichEditor(null);
        if (saveTimer.current) window.clearTimeout(saveTimer.current);
        saveTimer.current = 0;
        if (dirty.current) {
          dirty.current = false;
          const current = editorRef.current;
          if (current) changeRef.current(markdownOf(current));
        }
      },
    });

    editorRef.current = edit;
    // 首屏：仓库内的图片读成 blob URL（渲染时来不及同步取）
    void hydrateAssetImages(edit.view.dom);

    const insertFiles = async (files: File[]) => {
      for (const file of files) {
        if (file.type.startsWith('image/')) {
          const asset = await prepareImageAsset(file, noteRef.current.path, (text) => noticeRef.current?.(text));
          if (asset) {
            richInsertImage(asset.rel, asset.alt);
            noticeRef.current?.(asset.notice);
          }
        } else {
          const asset = await prepareAttachmentAsset(file, noteRef.current.path, (text) => noticeRef.current?.(text));
          if (asset) {
            richInsertAttachment(asset.rel, asset.label);
            noticeRef.current?.(asset.notice);
          }
        }
      }
    };

    const insertHtmlWithDataImages = async (html: string, from: number, to: number) => {
      const tpl = document.createElement('template');
      tpl.innerHTML = html;
      const images = Array.from(tpl.content.querySelectorAll('img')).filter((img) =>
        /^data:image\//i.test(img.getAttribute('src') || ''),
      );
      const limitBytes = effectiveAttachLimitMb() * 1024 * 1024;
      let saved = 0;
      let failed = 0;
      for (const img of images) {
        const raw = img.getAttribute('src') || '';
        // base64 大约膨胀 4/3，先按编码后的长度挡掉离谱的大图，避免解码卡住界面
        if (raw.length > (limitBytes * 4) / 3 + 1024) {
          img.remove();
          failed += 1;
          continue;
        }
        const file = dataUrlToFile(raw, img.getAttribute('alt') || '');
        const asset = file
          ? await prepareImageAsset(file, noteRef.current.path, () => {})
          : null;
        if (!asset) {
          img.remove();
          failed += 1;
          continue;
        }
        img.setAttribute('src', asset.rel);
        saved += 1;
      }
      edit.chain().focus().insertContentAt({ from, to }, sanitizePastedHtml(tpl.innerHTML)).run();
      void hydrateAssetImages(edit.view.dom);
      if (saved && failed) {
        noticeRef.current?.(
          t('已保存 {saved} 张图片，{failed} 张未能保存（超过大小上限或格式不支持）', { saved, failed }),
        );
      } else if (saved) {
        noticeRef.current?.(t('已保存 {n} 张粘贴的图片', { n: saved }));
      } else if (failed) {
        noticeRef.current?.(t('粘贴的图片未能保存（超过大小上限或格式不支持）'));
      }
    };

    // 右键「粘贴 / 只粘贴文本」：剪贴板内容已经在菜单层读好。
    // native 模式尽量按 HTML 原样插入（与 Ctrl+V 一致）；text 模式只取文字，
    // 并且每行一个段落，不把多行压进同一个段落。
    const onPasteClipboard = (event: Event) => {
      if (editorRef.current !== edit) return;
      const detail = (
        event as CustomEvent<{
          mode?: 'native' | 'text';
          html?: string;
          text?: string;
          files?: File[];
        }>
      ).detail;
      if (!detail) return;
      const { from, to } = edit.state.selection;
      if (detail.mode === 'text') {
        const text = detail.text?.trim() ? detail.text : htmlToPlainText(detail.html || '');
        const html = plainTextToHtml(text);
        if (!html) {
          noticeRef.current?.(t('剪贴板里没有可粘贴的内容'));
          return;
        }
        void insertHtmlWithDataImages(html, from, to);
        return;
      }
      if (detail.html) {
        void insertHtmlWithDataImages(detail.html, from, to);
        return;
      }
      if (detail.files?.length) {
        void insertFiles(detail.files);
        return;
      }
      const html = plainTextToHtml(detail.text || '');
      if (!html) {
        noticeRef.current?.(t('剪贴板里没有可粘贴的内容'));
        return;
      }
      void insertHtmlWithDataImages(html, from, to);
    };
    window.addEventListener('glimnote:paste-clipboard', onPasteClipboard);

    const dom = edit.view.dom;

    const onClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      const wiki = target?.closest<HTMLElement>('.tiptap-wiki');
      if (wiki) {
        event.preventDefault();
        const title = wiki.getAttribute('data-wiki');
        if (title) wikiRef.current?.(title);
        return;
      }
      const anchor = target?.closest<HTMLAnchorElement>('a[href]');
      if (anchor && dom.contains(anchor)) {
        // 不拦的话 Electron 窗口会直接跳到网页，编辑中的笔记就没了
        event.preventDefault();
        openLinkPop(anchor);
        return;
      }
      if (target?.tagName === 'IMG') {
        openImageBar(target as HTMLImageElement);
        return;
      }
      setImageBar(null);
      setLinkPop(null);
    };

    const onDoubleClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.tagName !== 'IMG') return;
      const img = target as HTMLImageElement;
      window.dispatchEvent(
        new CustomEvent('glimnote:image-preview', {
          detail: { url: img.currentSrc || img.src, alt: img.alt || t('图片') },
        }),
      );
    };

    dom.addEventListener('click', onClick);
    dom.addEventListener('dblclick', onDoubleClick);

    // 滚动后浮层坐标就不准了：宽度条直接收起，表格入口按新位置重新贴
    let scrollTimer = 0;
    const onScroll = () => {
      setImageBar(null);
      setLinkPop(null);
      if (scrollTimer) window.clearTimeout(scrollTimer);
      scrollTimer = window.setTimeout(() => {
        scrollTimer = 0;
        const editor = editorRef.current;
        if (editor) syncTableChip(editor);
      }, 80);
    };
    const onResize = () => {
      setImageBar(null);
      setTableChip(null);
      setLinkPop(null);
    };
    const scroller = dom.closest('.rich-scroll');
    scroller?.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onResize);

    return () => {
      dom.removeEventListener('click', onClick);
      dom.removeEventListener('dblclick', onDoubleClick);
      scroller?.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('glimnote:paste-clipboard', onPasteClipboard);
      if (scrollTimer) window.clearTimeout(scrollTimer);
      setTableChip(null);
      setImageBar(null);
      setLinkPop(null);
      // 先销毁再清 ref：onDestroy 里最后一次落盘还要用 editorRef 取 Markdown
      edit.destroy();
      editorRef.current = null;
      setActiveRichEditor(null);
    };
    // 只在换笔记时重建；打字不应重置编辑器
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note.id]);

  // 隐藏浮层：编辑区滚动或窗口尺寸变化后坐标就不再准了
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener('resize', close);
    const scroller = wrapRef.current?.querySelector('.rich-scroll');
    scroller?.addEventListener('scroll', close, { passive: true });
    return () => {
      window.removeEventListener('resize', close);
      scroller?.removeEventListener('scroll', close);
    };
  }, [menu]);

  // 链接浮层：点别处（包括正文空白 / 另一条链接）就收起。
  // 捕获阶段先关，再让正文的 click 决定要不要给新链接重新弹出。
  useEffect(() => {
    if (!linkPop) return;
    const onDown = (event: PointerEvent) => {
      const el = event.target as HTMLElement | null;
      if (el?.closest('.rich-link-pop')) return;
      setLinkPop(null);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [linkPop]);

  useEffect(() => {
    const open = () => setFindOpen(true);
    window.addEventListener('glimnote:rich-find', open);
    return () => window.removeEventListener('glimnote:rich-find', open);
  }, []);

  // 关窗 / 退出前：把还在 180ms 防抖里的输入立刻交给 store，
  // 紧接着 App 会调用 flushPendingWrites 落盘，最后几个字才不会丢
  useEffect(() => {
    const flush = () => {
      const editor = editorRef.current;
      if (!editor) return;
      if (saveTimer.current) {
        window.clearTimeout(saveTimer.current);
        saveTimer.current = 0;
      }
      if (!dirty.current) return;
      dirty.current = false;
      changeRef.current(markdownOf(editor));
    };
    window.addEventListener('glimnote:flush-editor', flush);
    return () => window.removeEventListener('glimnote:flush-editor', flush);
  }, []);

  useEffect(() => {
    if (!findOpen) return;
    const timer = window.setTimeout(() => {
      findInputRef.current?.focus();
      findInputRef.current?.select();
    }, 20);
    return () => window.clearTimeout(timer);
  }, [findOpen]);

  // 富文本查找用浏览器的高亮 API，不往文档里塞节点，关掉查找不留痕迹
  useEffect(() => () => paintFind([], -1), []);

  const applyFind = (query: string, mode: 'fresh' | 'next' | 'prev') => {
    const editor = editorRef.current;
    const term = query.trim();
    if (!editor || !term) {
      findRangesRef.current = [];
      findPosRef.current = 0;
      setFindTotal(0);
      setFindPos(0);
      paintFind([], -1);
      return;
    }
    const ranges = findRanges(editor.view.dom as HTMLElement, term);
    findRangesRef.current = ranges;
    setFindTotal(ranges.length);
    if (!ranges.length) {
      findPosRef.current = 0;
      setFindPos(0);
      paintFind([], -1);
      return;
    }
    let index = 0;
    if (mode === 'next') index = (findPosRef.current + 1) % ranges.length;
    else if (mode === 'prev') index = (findPosRef.current - 1 + ranges.length) % ranges.length;
    findPosRef.current = index;
    setFindPos(index);
    paintFind(ranges, index);
    revealRange(ranges[index]);
  };

  /** 搜索结果高亮：复用查找用的浏览器高亮 API，不往文档里塞节点 */
  const applySearchHighlight = (): Range[] => {
    const editor = editorRef.current;
    const terms = highlightRef.current.map((term) => term.trim()).filter(Boolean);
    paintFind([], -1);
    if (!editor || !terms.length) return [];
    const ranges: Range[] = [];
    for (const term of terms) ranges.push(...findRanges(editor.view.dom as HTMLElement, term));
    if (!ranges.length) return [];
    ranges.sort((a, b) => a.compareBoundaryPoints(Range.START_TO_START, b));
    const unique: Range[] = [];
    for (const range of ranges) {
      const prev = unique[unique.length - 1];
      // 多个关键词命中同一段文字时只留第一段，高亮范围不能重叠
      if (prev && range.compareBoundaryPoints(Range.START_TO_END, prev) < 0) continue;
      unique.push(range);
    }
    paintFind(unique, 0);
    return unique;
  };

  // 打开搜索结果后把关键词标出来，并滚到第一处命中
  useEffect(() => {
    if (findOpen) return;
    const timer = window.setTimeout(() => {
      const ranges = applySearchHighlight();
      if (ranges.length) revealRange(ranges[0]);
    }, 90);
    return () => window.clearTimeout(timer);
  }, [highlightTerms, findOpen]);

  const closeFind = () => {
    setFindOpen(false);
    setFindQuery('');
    setFindTotal(0);
    findRangesRef.current = [];
    findPosRef.current = 0;
    paintFind([], -1);
    requestAnimationFrame(() => {
      const ranges = applySearchHighlight();
      if (ranges.length) revealRange(ranges[0]);
      editorRef.current?.commands.focus();
    });
  };

  const updateSuggestions = (editor: TiptapEditor) => {
    if (applying.current) return;
    const { $from, empty, from: selFrom } = editor.state.selection;
    if (!empty || !$from.parent.isTextblock) {
      setMenu(null);
      return;
    }
    const textBefore = $from.parent.textBetween(0, $from.parentOffset, undefined, '￼');

    const wiki = /\[\[([^\]\n]*)$/.exec(textBefore);
    if (wiki) {
      const query = wiki[1];
      const notes = useApp
        .getState()
        .notes.filter((n) => n.id !== noteRef.current.id)
        .filter((n) => n.title.toLowerCase().includes(query.toLowerCase()))
        .slice(0, 8);
      if (!notes.length) {
        setMenu(null);
        return;
      }
      show(editor, {
        kind: 'wiki',
        from: selFrom - query.length - 2,
        to: selFrom,
        query,
        items: notes.map((n) => ({
          label: n.title,
          detail: n.notebook || t('未分类'),
          run: (ed) =>
            ed
              .chain()
              .focus()
              .insertContent({ type: 'text', text: `[[${n.title}]]` })
              .run(),
        })),
      });
      return;
    }

    const slash = /(^|\s)\/([^\s]*)$/.exec(textBefore);
    if (slash) {
      const slashAt = textBefore.lastIndexOf('/');
      if (textBefore.slice(0, slashAt).trim() !== '') {
        setMenu(null);
        return;
      }
      const query = slash[2];
      const date = dateText();
      const time = timeText();
      const items: SuggestItem[] = [
        { label: t('/标题'), detail: t('二级标题'), run: (ed) => ed.chain().focus().toggleHeading({ level: 2 }).run() },
        { label: t('/待办'), detail: t('任务清单'), run: () => richToggleList('taskList') },
        { label: t('/列表'), detail: t('无序列表'), run: () => richToggleList('bulletList') },
        { label: t('/有序'), detail: t('编号列表'), run: () => richToggleList('orderedList') },
        { label: t('/引用'), detail: t('引用段落'), run: (ed) => ed.chain().focus().toggleBlockquote().run() },
        {
          label: t('/代码'),
          detail: t('代码块，可粘贴并格式化'),
          run: () => window.dispatchEvent(new Event('glimnote:insert-code')),
        },
        {
          label: t('/表格'),
          detail: t('在弹窗里填内容'),
          run: () => window.dispatchEvent(new Event('glimnote:insert-table')),
        },
        {
          label: t('/分割线'),
          detail: t('水平分隔'),
          run: (ed) => ed.chain().focus().setHorizontalRule().run(),
        },
        {
          label: t('/日期'),
          detail: date,
          run: (ed) => ed.chain().focus().insertContent({ type: 'text', text: date }).run(),
        },
        {
          label: t('/时间'),
          detail: time,
          run: (ed) => ed.chain().focus().insertContent({ type: 'text', text: time }).run(),
        },
        ...templatesRef.current.map((tpl) => ({
          label: t('/模板：{name}', { name: tpl.name }),
          detail: t('插入模板'),
          run: (ed: TiptapEditor) =>
            ed
              .chain()
              .focus()
              .insertContent(markdownToHtml(renderTemplate(tpl.content, noteRef.current.title)))
              .run(),
        })),
      ];
      const term = query.toLowerCase();
      const filtered = term
        ? items.filter((item) => item.label.toLowerCase().includes(term) || item.detail.toLowerCase().includes(term))
        : items;
      if (!filtered.length) {
        setMenu(null);
        return;
      }
      show(editor, {
        kind: 'slash',
        from: selFrom - query.length - 1,
        to: selFrom,
        query,
        items: filtered,
      });
      return;
    }

    setMenu(null);
  };

  const show = (editor: TiptapEditor, next: Omit<SuggestState, 'left' | 'top' | 'index'>) => {
    const coords = editor.view.coordsAtPos(next.from);
    const width = 272;
    const height = 300;
    let left = coords.left;
    let top = coords.bottom + 6;
    if (left + width > window.innerWidth - 10) left = window.innerWidth - width - 10;
    if (top + height > window.innerHeight - 10) top = Math.max(8, coords.top - height - 6);
    setMenu((prev) => {
      // 同一次触发里选项没变时保留当前选中项，避免每敲一个字都跳回第一项
      if (prev && prev.kind === next.kind && prev.from === next.from && prev.items.length === next.items.length) {
        return { ...prev, ...next, left, top, index: Math.min(prev.index, next.items.length - 1) };
      }
      return { ...next, left, top, index: 0 };
    });
  };

  const applySuggestion = (item: SuggestItem) => {
    const editor = editorRef.current;
    const state = menuRef.current;
    if (!editor || !state) return;
    applying.current = true;
    editor.chain().focus().deleteRange({ from: state.from, to: state.to }).run();
    item.run(editor);
    applying.current = false;
    setMenu(null);
  };

  const onKeyDownCapture = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!event.nativeEvent.isComposing) {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        event.stopPropagation();
        setFindOpen(true);
        return;
      }
      if (event.key === 'Escape' && findOpen) {
        event.preventDefault();
        event.stopPropagation();
        closeFind();
        return;
      }
      if (event.key === 'Escape' && imageBar) {
        event.preventDefault();
        event.stopPropagation();
        setImageBar(null);
        return;
      }
      if (event.key === 'Escape' && linkPop) {
        event.preventDefault();
        event.stopPropagation();
        setLinkPop(null);
        return;
      }
    }
    const state = menuRef.current;
    if (!state || event.nativeEvent.isComposing) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      event.stopPropagation();
      setMenu((prev) => (prev ? { ...prev, index: (prev.index + 1) % prev.items.length } : prev));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      event.stopPropagation();
      setMenu((prev) => (prev ? { ...prev, index: (prev.index - 1 + prev.items.length) % prev.items.length } : prev));
    } else if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      event.stopPropagation();
      const item = state.items[state.index];
      if (item) applySuggestion(item);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setMenu(null);
    }
  };

  return (
    <div
      className={typewriter ? 'rich-host typewriter' : 'rich-host'}
      ref={wrapRef}
      onKeyDownCapture={onKeyDownCapture}
    >
      <div className="rich-scroll">
        <div ref={hostRef} />
      </div>
      {findOpen && (
        <div className="rich-find" role="search" aria-label={tr('查找')}>
          <Search size={14} strokeWidth={1.75} className="rich-find-icon" />
          <input
            ref={findInputRef}
            value={findQuery}
            placeholder={tr('在当前笔记中查找')}
            spellCheck={false}
            aria-label={tr('查找内容')}
            onChange={(event) => {
              const value = event.target.value;
              setFindQuery(value);
              applyFind(value, 'fresh');
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                event.stopPropagation();
                applyFind(findQuery, event.shiftKey ? 'prev' : 'next');
              } else if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                closeFind();
              }
            }}
          />
          <span className="rich-find-count" aria-live="polite">
            {findQuery.trim() ? (findTotal ? `${findPos + 1}/${findTotal}` : tr('无结果')) : ''}
          </span>
          <span className="rich-find-actions">
            <button
              type="button"
              title={tr('上一个  Shift+Enter')}
              aria-label={tr('上一个')}
              disabled={!findTotal}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => applyFind(findQuery, 'prev')}
            >
              <ArrowUp size={14} />
            </button>
            <button
              type="button"
              title={tr('下一个  Enter')}
              aria-label={tr('下一个')}
              disabled={!findTotal}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => applyFind(findQuery, 'next')}
            >
              <ArrowDown size={14} />
            </button>
            <button
              type="button"
              title={tr('关闭查找  Esc')}
              aria-label={tr('关闭查找')}
              onMouseDown={(event) => event.preventDefault()}
              onClick={closeFind}
            >
              <X size={14} />
            </button>
          </span>
        </div>
      )}
      {tableChip && (
        <button
          type="button"
          className="rich-table-chip"
          style={{ left: tableChip.left, top: tableChip.top }}
          title={tr('打开表格弹窗：改内容、加行加列')}
          onMouseDown={(event) => event.preventDefault()}
          onClick={openTableModal}
        >
          <Table2 size={13} strokeWidth={1.75} /> {tr('编辑表格')}
        </button>
      )}
      {imageBar && (
        <div
          className="rich-objbar rich-img-bar"
          style={{ left: imageBar.left, top: imageBar.top }}
          role="toolbar"
          aria-label={tr('图片宽度')}
        >
          <button
            type="button"
            title={tr('缩小 10%')}
            aria-label={tr('缩小图片')}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => resizeImage(0.9)}
          >
            <Minus size={14} />
          </button>
          <span className="rich-img-size">{imageBar.width ? `${imageBar.width}px` : tr('原始')}</span>
          <button
            type="button"
            title={tr('放大 10%')}
            aria-label={tr('放大图片')}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => resizeImage(1.1)}
          >
            <Plus size={14} />
          </button>
          <span className="rich-objbar-sep" />
          <button
            type="button"
            title={tr('去掉宽度限制，按原图显示')}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => resizeImage(null)}
          >
            <RotateCcw size={13} /> {tr('原始')}
          </button>
          <button
            type="button"
            title={tr('预览图片')}
            aria-label={tr('预览图片')}
            onMouseDown={(event) => event.preventDefault()}
            onClick={previewImage}
          >
            <Eye size={14} />
          </button>
        </div>
      )}
      {linkPop && (
        <div
          className="rich-objbar rich-link-pop"
          style={{ left: linkPop.left, top: linkPop.top }}
          role="dialog"
          aria-label={tr('链接')}
        >
          {linkPop.editing ? (
            <div className="rich-link-form">
              <label>
                <span>{tr('显示文字')}</span>
                <input
                  autoFocus
                  value={linkPop.text}
                  placeholder={tr('链接文字')}
                  onChange={(event) => setLinkPop((prev) => (prev ? { ...prev, text: event.target.value } : prev))}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      applyLinkEdit();
                    }
                  }}
                />
              </label>
              <label>
                <span>{tr('链接地址')}</span>
                <input
                  value={linkPop.href}
                  placeholder="https://"
                  onChange={(event) => setLinkPop((prev) => (prev ? { ...prev, href: event.target.value } : prev))}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      applyLinkEdit();
                    }
                  }}
                />
              </label>
              <div className="rich-link-actions">
                <button
                  type="button"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => setLinkPop((prev) => (prev ? { ...prev, editing: false } : prev))}
                >
                  {tr('取消')}
                </button>
                <button
                  type="button"
                  className="primary"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={applyLinkEdit}
                >
                  {tr('保存')}
                </button>
              </div>
            </div>
          ) : (
            <>
              <span className="rich-link-url" title={linkPop.href}>
                {linkPop.href}
              </span>
              <span className="rich-objbar-sep" />
              <button
                type="button"
                title={
                  /^https?:/i.test(linkPop.href) ? tr('在浏览器里打开') : tr('这个地址不是有效的 http / https 网址')
                }
                disabled={!/^https?:/i.test(linkPop.href)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={openLinkTarget}
              >
                <ExternalLink size={13} /> {tr('打开')}
              </button>
              <button
                type="button"
                title={tr('复制链接')}
                onMouseDown={(event) => event.preventDefault()}
                onClick={copyLink}
              >
                <Copy size={13} /> {tr('复制')}
              </button>
              <button
                type="button"
                title={tr('编辑链接')}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => setLinkPop((prev) => (prev ? { ...prev, editing: true } : prev))}
              >
                <Pencil size={13} /> {tr('编辑')}
              </button>
              <button
                type="button"
                title={tr('移除链接')}
                aria-label={tr('移除链接')}
                onMouseDown={(event) => event.preventDefault()}
                onClick={removeLink}
              >
                <Trash2 size={13} />
              </button>
            </>
          )}
        </div>
      )}
      {menu && (
        <div
          className="rich-suggest"
          style={{ left: menu.left, top: menu.top }}
          role="listbox"
          aria-label={menu.kind === 'slash' ? tr('斜杠命令') : tr('引用笔记')}
        >
          <div className="rich-suggest-head">{menu.kind === 'slash' ? tr('命令') : tr('引用笔记')}</div>
          {menu.items.map((item, index) => (
            <button
              key={item.label + index}
              type="button"
              className={index === menu.index ? 'rich-suggest-item on' : 'rich-suggest-item'}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setMenu((prev) => (prev ? { ...prev, index } : prev))}
              onClick={() => applySuggestion(item)}
            >
              <span className="rich-suggest-label">{item.label}</span>
              <span className="rich-suggest-detail">{item.detail}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
