import { useEffect, useLayoutEffect, useRef, useState, type ChangeEvent, type MouseEvent, type ReactNode } from 'react';
import type { EditorView } from '@codemirror/view';
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  BookMarked,
  ChevronDown,
  Eye,
  EyeOff,
  FileCode2,
  Image as ImageIcon,
  Italic,
  Link2,
  List,
  ListOrdered,
  Minus,
  MoreVertical,
  Palette,
  Paperclip,
  Quote,
  Scissors,
  SquareCheck,
  Strikethrough,
  Table,
  type LucideIcon,
} from 'lucide-react';
import {
  getActiveView,
  insertAttachmentFile,
  insertAtCursor,
  insertImageFile,
  prepareAttachmentAsset,
  prepareImageAsset,
  toggleLinePrefix,
  wrapSelection,
} from '../lib/editorBridge';
import { applyAlign, applyTextStyle, textStyleAt, type CaretTextStyle } from '../lib/richtext';
import {
  getActiveRichEditor,
  richApplyAlign,
  richApplyTextStyle,
  richDefaultFontSize,
  richInsertAttachment,
  richInsertHorizontalRule,
  richInsertImage,
  richInsertPageBreak,
  richInsertWikiLink,
  richSelectionText,
  richSetLink,
  richStyleAt,
  richToggleBold,
  richToggleItalic,
  richTogglePrefix,
  richToggleStrike,
} from '../lib/rich/bridge';
import type { ParsedTable } from '../lib/table';
import { cn } from '../lib/utils';
import { useApp } from '../store/app';
import { CodeModal } from './CodeModal';
import { useT } from '../lib/i18n';
import { TableModal } from './TableModal';

const TEXT_COLORS = [
  { name: '红色', value: '#e5484d' },
  { name: '橙色', value: '#f76b15' },
  { name: '黄色', value: '#c99a00' },
  { name: '绿色', value: '#30a46c' },
  { name: '青色', value: '#0e9bb5' },
  { name: '蓝色', value: '#3e63dd' },
  { name: '紫色', value: '#8e4ec6' },
  { name: '灰色', value: '#8b8b8b' },
];

const BG_COLORS = [
  { name: '黄色', value: '#fff3bf' },
  { name: '绿色', value: '#d3f9d8' },
  { name: '蓝色', value: '#d0ebff' },
  { name: '粉色', value: '#ffdeeb' },
  { name: '紫色', value: '#e5dbff' },
  { name: '灰色', value: '#e9ecef' },
];

/**
 * 字号写成 Markdown 里的行内 span（font-size），编辑区、阅读预览与导出都直接复用。
 * 列表里没有「默认」项：不单独选字号时就用正文的全局字号（设置里的「编辑器字号」）。
 */
const FONT_SIZES = [
  { name: '12', value: '12px' },
  { name: '14', value: '14px' },
  { name: '16', value: '16px' },
  { name: '18', value: '18px' },
  { name: '20', value: '20px' },
  { name: '24', value: '24px' },
  { name: '28', value: '28px' },
];

type SizeChoice = (typeof FONT_SIZES)[number];

/** font-size 认 px；12 / 14 / 16 这些直接显示数字，其它单位原样显示 */
function resolveSize(value?: string): { name: string; value: string } {
  const raw = value?.trim();
  if (!raw) return { name: '', value: '' };
  const px = /^(\d+(?:\.\d+)?)px$/i.exec(raw);
  if (!px) return { name: raw, value: raw };
  const n = Math.round(Number(px[1]));
  return FONT_SIZES.find((s) => Math.round(parseFloat(s.value)) === n) || { name: String(n), value: `${n}px` };
}

interface ToolDef {
  key: string;
  /** 下拉菜单里的名字（带省略号的表示会开弹窗） */
  label: string;
  /** 图标按钮的 tooltip，含快捷键提示 */
  title: string;
  hint?: string;
  icon: LucideIcon;
  run: () => void;
  /** 宽版是否直接放到工具条上；false 表示留在「更多」里 */
  direct?: boolean;
}

interface Props {
  notePath: string;
  /** 富文本（TipTap）编辑器；关闭则为 Markdown 源码模式 */
  live: boolean;
  onToggleLive: () => void;
  onNotice?: (text: string) => void;
  /** 笔记级操作（目录 / 预览 / 置顶 / 专注 / 更多），放在格式栏右端 */
  actions?: ReactNode;
}

/** 在空行前不必补空行，避免文档一开头就多出两行 */
function insertBlock(view: EditorView, block: string) {
  const line = view.state.doc.lineAt(view.state.selection.main.from);
  const lead = line.text.trim() ? '\n' : '';
  insertAtCursor(view, `${lead}${block}\n`);
}

export function FormatBar({ notePath, live, onToggleLive, onNotice, actions }: Props) {
  const t = useT();
  const notes = useApp((s) => s.notes);
  const currentPath = useApp((s) => s.current?.path);
  const [pop, setPop] = useState<'link' | 'color' | 'align' | 'insert' | 'ref' | 'more' | 'list' | 'size' | null>(null);
  /** 光标处 / 选区内文字实际使用的字号；没有局部样式时回退到正文默认字号 */
  const [style, setStyle] = useState<CaretTextStyle>({});
  /** 正文默认字号（设置里的「编辑器字号」），没单独设过字号的文字就按它渲染 */
  const [defaultSize, setDefaultSize] = useState('14px');
  const [linkText, setLinkText] = useState('');
  const [linkUrl, setLinkUrl] = useState('');
  const [refQuery, setRefQuery] = useState('');
  const [codeOpen, setCodeOpen] = useState(false);
  /** 打开表格弹窗；richPos 是富文本里被点开的表格节点位置，新建时为 null */
  const [tableEdit, setTableEdit] = useState<{
    data: ParsedTable | null;
    richPos?: number | null;
  } | null>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const attachRef = useRef<HTMLInputElement>(null);

  /**
   * 工具条按「实际可用宽度」而不是窗口宽度决定展开程度：
   * 专注模式、收起侧栏时编辑器更宽，也要能直接看到列表和插入按钮。
   * 1020px 是「字号按钮和其余格式按钮一行放得下」的实测下限；
   * 低于它时列表、插入收进下拉，字号仍留在工具条上。
   */
  const [barWidth, setBarWidth] = useState(0);
  const wide = barWidth >= 1020;
  /** 附件、分页符是插入里的低频项：宽度很富余才直接摆出来，否则收进 ⋯ */
  const showRareInsert = !wide && barWidth >= 900;

  useLayoutEffect(() => {
    const el = barRef.current;
    if (!el) return;
    const update = () => setBarWidth(el.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // 宽窄切换时，列表/插入这类只属于窄版的下拉要收起，避免状态悬空
  useEffect(() => {
    if (wide) setPop((p) => (p === 'list' || p === 'insert' ? null : p));
  }, [wide]);

  useEffect(() => {
    if (!pop) return;
    const onDown = (e: globalThis.MouseEvent) => {
      if (barRef.current && !barRef.current.contains(e.target as Node)) setPop(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPop(null);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [pop]);

  /**
   * 按钮显示「光标处 / 选区内文字实际用的字号」（Word 里的行为）。
   * 事件由编辑器在选区、内容或焦点变化时派发；换笔记时编辑器会重建，
   * 所以这里也监听 notePath，并在下一帧主动读一次。
   * 正文默认字号从编辑区的计算样式读，设置里的 14 / 16 / 18 改了也能跟上。
   */
  useEffect(() => {
    const sync = (event?: Event) => {
      if (live) {
        const rich = getActiveRichEditor();
        if (rich) {
          setStyle(richStyleAt());
          setDefaultSize(richDefaultFontSize() || '14px');
          return;
        }
        const content = document.querySelector('.tiptap');
        if (content) setDefaultSize(getComputedStyle(content).fontSize || '14px');
        return;
      }
      const detail = (event as CustomEvent<{ view?: EditorView }> | undefined)?.detail;
      const view = detail?.view ?? getActiveView();
      if (view) {
        setStyle(textStyleAt(view));
        setDefaultSize(getComputedStyle(view.contentDOM).fontSize || '14px');
        return;
      }
      // 编辑器还没拿到焦点时也把正文默认字号读出来，避免设置成 16 / 18 后按钮先显示 14
      const content = document.querySelector('.cm-content');
      if (content) setDefaultSize(getComputedStyle(content).fontSize || '14px');
    };
    window.addEventListener('glimnote:editor-selection', sync);
    const raf = requestAnimationFrame(() => sync());
    return () => {
      window.removeEventListener('glimnote:editor-selection', sync);
      cancelAnimationFrame(raf);
    };
  }, [notePath, live]);

  const run = (fn: (view: EditorView) => void) => () => {
    const view = getActiveView();
    if (view) fn(view);
  };

  /** 行内格式：富文本走 TipTap 的 mark，源码模式仍是包 ** / * / ~~ */
  const toggleMark = (kind: 'bold' | 'italic' | 'strike') => {
    if (live) {
      if (kind === 'bold') richToggleBold();
      else if (kind === 'italic') richToggleItalic();
      else richToggleStrike();
      setStyle(richStyleAt());
      return;
    }
    const view = getActiveView();
    if (!view) return;
    wrapSelection(
      view,
      kind === 'bold' ? '**' : kind === 'italic' ? '*' : '~~',
      kind === 'bold' ? '**' : kind === 'italic' ? '*' : '~~',
    );
  };

  /** 列表 / 引用 / 标题：富文本切节点类型，源码模式改行首前缀 */
  const togglePrefix = (prefix: string) => {
    setPop(null);
    if (live) {
      richTogglePrefix(prefix);
      return;
    }
    const view = getActiveView();
    if (view) toggleLinePrefix(view, prefix);
  };

  /** 菜单项：先收起菜单，再执行（点图片 / 附件时要立刻触发文件选择） */
  const insertNow = (fn: () => void) => () => {
    setPop(null);
    fn();
  };

  const keepFocus = (e: MouseEvent<HTMLButtonElement>) => e.preventDefault();

  const btn = (title: string, icon: ReactNode, onClick: () => void, active?: boolean, keyName?: string) => (
    <button
      key={keyName}
      type="button"
      className={cn('fmt-btn', active && 'on')}
      title={title}
      aria-label={title}
      onMouseDown={keepFocus}
      onClick={onClick}
    >
      {icon}
    </button>
  );

  const currentSelectionText = () => {
    if (live) return richSelectionText();
    const view = getActiveView();
    if (!view) return '';
    const { from, to } = view.state.selection.main;
    return view.state.sliceDoc(from, to);
  };

  const openLink = () => {
    const selected = currentSelectionText();
    if (!live && !getActiveView()) return;
    setLinkText(selected);
    setLinkUrl('');
    setPop(pop === 'link' ? null : 'link');
  };

  const applyLink = () => {
    const text = linkText.trim() || '链接文字';
    const url = linkUrl.trim() || 'https://';
    if (live) {
      richSetLink(text, url);
      setPop(null);
      return;
    }
    const view = getActiveView();
    if (!view) return;
    const { from, to } = view.state.selection.main;
    const insert = `[${text}](${url})`;
    view.dispatch({
      changes: { from, to, insert },
      selection: { anchor: from + insert.length },
    });
    view.focus();
    setPop(null);
  };

  /** 引用链接：插到另一篇笔记上，点一下就能跳过去（双链） */
  // 快捷键 Ctrl+Shift+K：由 App 里统一的快捷键系统派发事件，这里负责打开弹层
  useEffect(() => {
    const onInsertLink = () => {
      if (!live && !getActiveView()) return;
      setLinkText(currentSelectionText());
      setLinkUrl('');
      setPop('link');
    };
    window.addEventListener('glimnote:insert-link', onInsertLink);
    return () => window.removeEventListener('glimnote:insert-link', onInsertLink);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live]);

  /** 富文本里点已有表格 / 两个编辑器的斜杠命令，都汇到这里开弹窗 */
  useEffect(() => {
    const onEditRichTable = (e: Event) => {
      const detail = (e as CustomEvent<{ pos: number; data: ParsedTable }>).detail;
      if (!detail) return;
      setTableEdit({ data: detail.data, richPos: detail.pos });
    };
    const onInsertTable = () => setTableEdit({ data: null });
    const onInsertCode = () => setCodeOpen(true);
    window.addEventListener('glimnote:edit-rich-table', onEditRichTable);
    window.addEventListener('glimnote:insert-table', onInsertTable);
    window.addEventListener('glimnote:insert-code', onInsertCode);
    return () => {
      window.removeEventListener('glimnote:edit-rich-table', onEditRichTable);
      window.removeEventListener('glimnote:insert-table', onInsertTable);
      window.removeEventListener('glimnote:insert-code', onInsertCode);
    };
  }, []);

  /** 引用链接：插到另一篇笔记上，点一下就能跳过去（双链） */
  const insertWikiLink = (title: string) => {
    setPop(null);
    setRefQuery('');
    if (live) {
      richInsertWikiLink(title);
      return;
    }
    const view = getActiveView();
    if (!view) return;
    const { from, to } = view.state.selection.main;
    const alias = view.state.sliceDoc(from, to).trim();
    const insert = alias ? `[[${title}|${alias}]]` : `[[${title}]]`;
    view.dispatch({
      changes: { from, to, insert },
      selection: { anchor: from + insert.length },
    });
    view.focus();
  };

  const refMatches = notes
    .filter((n) => n.path !== currentPath)
    .filter((n) => {
      const q = refQuery.trim().toLowerCase();
      if (!q) return true;
      return n.title.toLowerCase().includes(q) || n.notebook.toLowerCase().includes(q);
    })
    .slice(0, 7);

  const menuItem = (icon: ReactNode, label: string, hint: string, onClick: () => void) => (
    <button type="button" className="fmt-menu-item" onMouseDown={keepFocus} onClick={onClick}>
      <span className="fmt-menu-icon">{icon}</span>
      <span className="fmt-menu-label">{label}</span>
      <span className="fmt-menu-key">{hint}</span>
    </button>
  );

  const onPickImage = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (live) {
      const asset = await prepareImageAsset(file, notePath, onNotice);
      if (asset) {
        richInsertImage(asset.rel, asset.alt);
        onNotice?.(asset.notice);
      }
      return;
    }
    const view = getActiveView();
    if (!view) return;
    await insertImageFile(view, file, notePath, onNotice);
  };

  const onPickAttachment = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (live) {
      if (file.type.startsWith('image/')) {
        const asset = await prepareImageAsset(file, notePath, onNotice);
        if (asset) {
          richInsertImage(asset.rel, asset.alt);
          onNotice?.(asset.notice);
        }
      } else {
        const asset = await prepareAttachmentAsset(file, notePath, onNotice);
        if (asset) {
          richInsertAttachment(asset.rel, asset.label);
          onNotice?.(asset.notice);
        }
      }
      return;
    }
    const view = getActiveView();
    if (!view) return;
    if (file.type.startsWith('image/')) {
      await insertImageFile(view, file, notePath, onNotice);
    } else {
      await insertAttachmentFile(view, file, notePath, onNotice);
    }
  };

  const pickColor = (kind: 'text' | 'bg', value: string) => {
    setPop(null);
    const props: Record<string, string | null> =
      kind === 'text'
        ? { color: value || null }
        : { 'background-color': value || null, color: value ? '#202124' : null };
    if (live) {
      richApplyTextStyle(props);
      return;
    }
    run((v) => applyTextStyle(v, props))();
  };

  /**
   * 字号是常驻控件，点一下立刻套到选中的文字。没有选区时把字号记在编辑器的待用
   * 状态里，接着输入的文字自动套用，不会插入「文字」之类的占位内容；也不写进
   * localStorage——按钮显示的是光标处真实的字号，不再用「上次选过什么」冒充。
   */
  const chooseFontSize = (next: SizeChoice) => {
    if (live) {
      richApplyTextStyle({ 'font-size': next.value });
      setStyle(richStyleAt());
      return;
    }
    const view = getActiveView();
    if (!view) return;
    applyTextStyle(view, { 'font-size': next.value });
    setStyle(textStyleAt(view));
  };

  const pickAlign = (align: 'left' | 'center' | 'right') => {
    setPop(null);
    if (live) {
      richApplyAlign(align);
      return;
    }
    run((v) => applyAlign(v, align))();
  };

  /** 列表的 4 个动作在宽版直接展开，窄版仍走「列表」下拉 */
  const listTools: ToolDef[] = [
    { key: 'ul', label: t('无序列表'), title: t('无序列表'), icon: List, run: () => togglePrefix('- ') },
    {
      key: 'ol',
      label: t('编号列表'),
      title: t('编号列表'),
      icon: ListOrdered,
      run: () => togglePrefix('1. '),
    },
    {
      key: 'check',
      label: t('复选框'),
      title: t('复选框  Ctrl+Shift+X'),
      hint: 'Ctrl+Shift+X',
      icon: SquareCheck,
      run: () => togglePrefix('- [ ] '),
    },
    { key: 'quote', label: t('引用'), title: t('引用'), icon: Quote, run: () => togglePrefix('> ') },
  ];

  /** 插入：常用项直接展开，附件与分页符留在「更多」里 */
  const insertTools: ToolDef[] = [
    { key: 'link', label: t('链接…'), title: t('插入链接  Ctrl+Shift+K'), hint: 'Ctrl+Shift+K', icon: Link2, run: openLink },
    {
      key: 'ref',
      label: t('引用链接…'),
      title: t('引用链接：插到另一篇笔记上（双链）'),
      icon: BookMarked,
      run: () => {
        setRefQuery('');
        setPop('ref');
      },
    },
    {
      key: 'image',
      label: t('图片…'),
      title: t('插入图片…'),
      icon: ImageIcon,
      run: insertNow(() => fileRef.current?.click()),
    },
    {
      key: 'attach',
      label: t('附件…'),
      title: t('插入附件…'),
      icon: Paperclip,
      run: insertNow(() => attachRef.current?.click()),
    },
    {
      key: 'code',
      label: t('代码块…'),
      title: t('插入代码块…'),
      hint: t('粘贴并格式化'),
      icon: FileCode2,
      run: () => {
        setPop(null);
        setCodeOpen(true);
      },
    },
    {
      key: 'table',
      label: t('表格…'),
      title: t('插入表格…'),
      hint: t('在弹窗里填'),
      icon: Table,
      run: () => {
        setPop(null);
        setTableEdit({ data: null });
      },
    },
    {
      key: 'hr',
      label: t('分割线'),
      title: t('插入分割线'),
      icon: Minus,
      run: () => {
        setPop(null);
        if (live) {
          richInsertHorizontalRule();
          return;
        }
        run((v) => insertBlock(v, '---'))();
      },
    },
    {
      key: 'page-break',
      label: t('分页符'),
      title: t('插入分页符'),
      icon: Scissors,
      run: () => {
        setPop(null);
        if (live) {
          richInsertPageBreak();
          return;
        }
        run((v) => insertBlock(v, '<div class="page-break"></div>\n'))();
      },
    },
  ];

  // 前两个要挂浮层（普通链接 / 双链），单独取出来；其余直接排成图标。
  // 附件和分页符放最后，宽度不够时让位给 ⋯。
  const commonInsertTools = insertTools.filter((t) => t.key !== 'attach' && t.key !== 'page-break');
  const rareInsertTools = insertTools.filter((t) => t.key === 'attach' || t.key === 'page-break');
  const [linkTool, refTool, ...restInsertTools] = commonInsertTools;

  const toolMenuItem = (t: ToolDef) => (
    <button key={t.key} type="button" className="fmt-menu-item" onMouseDown={keepFocus} onClick={t.run}>
      <span className="fmt-menu-icon">
        <t.icon size={14} strokeWidth={1.75} />
      </span>
      <span className="fmt-menu-label">{t.label}</span>
      <span className="fmt-menu-key">{t.hint || ''}</span>
    </button>
  );

  const linkPop =
    pop === 'link' ? (
      <span className="fmt-pop fmt-link-pop">
        <label>
          {t('显示文字')}
          <input
            autoFocus
            value={linkText}
            placeholder={t('链接文字')}
            onChange={(e) => setLinkText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') applyLink();
            }}
          />
        </label>
        <label>
          {t('链接地址')}
          <input
            value={linkUrl}
            placeholder="https://"
            onChange={(e) => setLinkUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') applyLink();
            }}
          />
        </label>
        <div className="fmt-pop-foot">
          <button type="button" className="btn btn-secondary" style={{ height: 26 }} onClick={() => setPop(null)}>
            {t('取消')}
          </button>
          <button type="button" className="btn btn-primary" style={{ height: 26 }} onClick={applyLink}>
            {t('插入')}
          </button>
        </div>
      </span>
    ) : null;

  const refPop =
    pop === 'ref' ? (
      <span className="fmt-pop fmt-ref-pop">
        <input
          autoFocus
          value={refQuery}
          placeholder={t('搜索笔记标题…')}
          onChange={(e) => setRefQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && refMatches[0]) insertWikiLink(refMatches[0].title);
            if (e.key === 'Escape') setPop(null);
          }}
        />
        <span className="fmt-ref-list">
          {refMatches.length ? (
            refMatches.map((n) => (
              <button
                key={n.path}
                type="button"
                className="fmt-ref-item"
                onMouseDown={keepFocus}
                onClick={() => insertWikiLink(n.title)}
              >
                <span className="fmt-ref-title">{n.title}</span>
                {n.notebook && <span className="fmt-ref-book">{n.notebook}</span>}
              </button>
            ))
          ) : (
            <span className="fmt-ref-empty">{t('没有找到其它笔记')}</span>
          )}
        </span>
        <span className="fmt-ref-tip">{t('插入后点一下就能跳到那篇笔记')}</span>
      </span>
    ) : null;

  /** 颜色与对齐的浮层宽窄版共用同一份 */
  const colorPop =
    pop === 'color' ? (
      <span className="fmt-pop fmt-color-pop">
        <span className="fmt-pop-caption">{t('字体颜色')}</span>
        <span className="fmt-swatches">
          <button
            type="button"
            className="fmt-swatch fmt-swatch-none"
            title={t('默认颜色')}
            onMouseDown={keepFocus}
            onClick={() => pickColor('text', '')}
          >
            A
          </button>
          {TEXT_COLORS.map((c) => (
            <button
              key={c.value}
              type="button"
              className="fmt-swatch"
              title={t('文字颜色：{name}', { name: t(c.name) })}
              style={{ background: c.value }}
              onMouseDown={keepFocus}
              onClick={() => pickColor('text', c.value)}
            />
          ))}
        </span>
        <span className="fmt-pop-caption">{t('文字背景')}</span>
        <span className="fmt-swatches">
          <button
            type="button"
            className="fmt-swatch fmt-swatch-none"
            title={t('无背景色')}
            onMouseDown={keepFocus}
            onClick={() => pickColor('bg', '')}
          >
            <Minus size={14} strokeWidth={1.75} />
          </button>
          {BG_COLORS.map((c) => (
            <button
              key={c.value}
              type="button"
              className="fmt-swatch"
              title={t('背景色：{name}', { name: t(c.name) })}
              style={{ background: c.value }}
              onMouseDown={keepFocus}
              onClick={() => pickColor('bg', c.value)}
            />
          ))}
        </span>
      </span>
    ) : null;

  const alignPop =
    pop === 'align' ? (
      <span className="fmt-pop fmt-align-pop">
        <button type="button" className="fmt-align-item" onMouseDown={keepFocus} onClick={() => pickAlign('left')}>
          <AlignLeft size={16} strokeWidth={1.75} />
          {t('左对齐')}
        </button>
        <button type="button" className="fmt-align-item" onMouseDown={keepFocus} onClick={() => pickAlign('center')}>
          <AlignCenter size={16} strokeWidth={1.75} />
          {t('居中')}
        </button>
        <button type="button" className="fmt-align-item" onMouseDown={keepFocus} onClick={() => pickAlign('right')}>
          <AlignRight size={16} strokeWidth={1.75} />
          {t('右对齐')}
        </button>
      </span>
    ) : null;

  /**
   * 字号是常驻的工具栏按钮（当前值直接写在按钮上），点开是选项列表。
   * 显示值永远取自光标处 / 选区文字实际用的字号：光标停在 28 号字里就显示 28，
   * 停在普通段落里就显示正文默认字号，和接下来打出来的字保持一致。
   */
  const shownSize = resolveSize(style.size || defaultSize);
  const sizeUnit = /^\d+$/.test(shownSize.name) ? 'px' : '';

  const sizeControls = (
    <span className="fmt-type-controls">
      <span className="fmt-pop-host">
        <button
          type="button"
          className={cn('fmt-btn fmt-text-btn fmt-type-btn', pop === 'size' && 'on')}
          title={t('字号：{name}', { name: shownSize.name }) + sizeUnit}
          aria-label={t('字号：{name}', { name: shownSize.name }) + sizeUnit + t('，点击选择')}
          aria-expanded={pop === 'size'}
          onMouseDown={keepFocus}
          onClick={() => setPop(pop === 'size' ? null : 'size')}
        >
          <span className="fmt-type-label">{t('字号')}</span>
          <span className="fmt-type-current fmt-size-current">{shownSize.name}</span>
          <ChevronDown size={12} strokeWidth={1.75} className={cn('fmt-caret', pop === 'size' && 'open')} />
        </button>
        {pop === 'size' && (
          <span className="fmt-pop fmt-size-menu" role="menu" aria-label={t('选择字号')}>
            {FONT_SIZES.map((s) => (
              <button
                key={s.name}
                type="button"
                role="menuitemradio"
                aria-checked={s.value === shownSize.value}
                className={cn('fmt-size-item', s.value === shownSize.value && 'on')}
                onMouseDown={keepFocus}
                onClick={() => {
                  chooseFontSize(s);
                  setPop(null);
                }}
              >
                {s.name}
              </button>
            ))}
          </span>
        )}
      </span>
    </span>
  );

  return (
    <>
      <div className="format-bar" ref={barRef}>
        {/* 字号放在最左边：写日记时最常改的就是它 */}
        {sizeControls}
        <span className="fmt-sep" />

        {btn(t('加粗  Ctrl+B'), <Bold size={16} strokeWidth={1.75} />, () => toggleMark('bold'))}
        {btn(t('斜体  Ctrl+I'), <Italic size={16} strokeWidth={1.75} />, () => toggleMark('italic'))}

        {/* 宽版把这些直接排在工具条上；窄版仍收进「更多」 */}
        {wide ? (
          <>
            <span className="fmt-sep" />
            {btn(t('删除线'), <Strikethrough size={16} strokeWidth={1.75} />, () => toggleMark('strike'))}
            <span className="fmt-pop-host">
              {btn(
                t('字体颜色 / 背景色'),
                <Palette size={16} strokeWidth={1.75} />,
                () => setPop(pop === 'color' ? null : 'color'),
                pop === 'color',
              )}
              {colorPop}
            </span>
            <span className="fmt-pop-host">
              {btn(
                t('对齐方式'),
                <AlignLeft size={16} strokeWidth={1.75} />,
                () => setPop(pop === 'align' ? null : 'align'),
                pop === 'align',
              )}
              {alignPop}
            </span>
          </>
        ) : (
          <>
            <span className="fmt-sep" />
            <span className="fmt-pop-host fmt-more">
              {btn(
                t('更多行内格式：删除线、颜色、对齐'),
                <MoreVertical size={16} strokeWidth={1.75} />,
                () => setPop(pop === 'more' ? null : 'more'),
                pop === 'more' || pop === 'color' || pop === 'align',
              )}
              {pop === 'more' && (
                <span className="fmt-pop fmt-menu">
                  {menuItem(<Strikethrough size={14} strokeWidth={1.75} />, t('删除线'), '', () => toggleMark('strike'))}
                  {menuItem(<Palette size={14} strokeWidth={1.75} />, t('字体颜色 / 背景色'), '', () => setPop('color'))}
                  {menuItem(<AlignLeft size={14} strokeWidth={1.75} />, t('对齐方式'), '', () => setPop('align'))}
                </span>
              )}
              {colorPop}
              {alignPop}
            </span>
          </>
        )}

        {wide ? (
          <>
            <span className="fmt-sep" />
            {listTools.map((t) => btn(t.title, <t.icon size={16} strokeWidth={1.75} />, t.run, false, t.key))}
            <span className="fmt-sep" />
            <span className="fmt-pop-host fmt-pop-start">
              {btn(linkTool.title, <linkTool.icon size={16} strokeWidth={1.75} />, linkTool.run, pop === 'link')}
              {linkPop}
            </span>
            <span className="fmt-pop-host fmt-pop-start">
              {btn(refTool.title, <refTool.icon size={16} strokeWidth={1.75} />, refTool.run, pop === 'ref')}
              {refPop}
            </span>
            {restInsertTools.map((t) => btn(t.title, <t.icon size={16} strokeWidth={1.75} />, t.run, false, t.key))}
            {showRareInsert ? (
              rareInsertTools.map((t) => btn(t.title, <t.icon size={16} strokeWidth={1.75} />, t.run, false, t.key))
            ) : (
              <span className="fmt-pop-host fmt-more">
                {btn(
                  t('更多插入：附件、分页符'),
                  <MoreVertical size={16} strokeWidth={1.75} />,
                  () => setPop(pop === 'more' ? null : 'more'),
                  pop === 'more',
                )}
                {pop === 'more' && <span className="fmt-pop fmt-menu">{rareInsertTools.map(toolMenuItem)}</span>}
              </span>
            )}
          </>
        ) : (
          <>
            <span className="fmt-pop-host">
              <button
                type="button"
                className={cn('fmt-btn fmt-text-btn', pop === 'list' && 'on')}
                title={t('列表与引用')}
                aria-expanded={pop === 'list'}
                onMouseDown={keepFocus}
                onClick={() => setPop(pop === 'list' ? null : 'list')}
              >
                {t('列表')}
                <ChevronDown size={14} strokeWidth={1.75} className={cn('fmt-caret', pop === 'list' && 'open')} />
              </button>
              {pop === 'list' && <span className="fmt-pop fmt-menu">{listTools.map(toolMenuItem)}</span>}
            </span>

            <span className="fmt-sep" />
            <span className="fmt-pop-host">
              <button
                type="button"
                className={cn('fmt-btn fmt-text-btn', (pop === 'insert' || pop === 'link' || pop === 'ref') && 'on')}
                title={t('插入内容：链接、引用链接、图片、附件、代码块、表格、分割线、分页符')}
                aria-expanded={pop === 'insert'}
                onMouseDown={keepFocus}
                onClick={() => setPop(pop === 'insert' ? null : 'insert')}
              >
                {t('插入')}
                <ChevronDown size={14} strokeWidth={1.75} className={cn('fmt-caret', pop === 'insert' && 'open')} />
              </button>
              {pop === 'insert' && <span className="fmt-pop fmt-menu">{insertTools.map(toolMenuItem)}</span>}
              {refPop}
              {linkPop}
            </span>
          </>
        )}

        {/* 笔记级操作 + 模式开关作为一组靠右；窄窗口换行时整组一起走，不会散成两截。 */}
        <span className="fmt-actions">
          {actions}
          <span className="fmt-sep" />
          <button
            type="button"
            className={cn('fmt-btn fmt-live', !live && 'on')}
            title={live ? t('富文本编辑 · 点击查看原始 Markdown') : t('正在显示原始 Markdown · 点击回到富文本')}
            aria-label={live ? t('查看原始 Markdown 语法') : t('回到所见即所得')}
            aria-pressed={!live}
            onMouseDown={keepFocus}
            onClick={onToggleLive}
          >
            {live ? <EyeOff size={16} strokeWidth={1.75} /> : <Eye size={16} strokeWidth={1.75} />}
          </button>
        </span>

        <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => void onPickImage(e)} />
        <input ref={attachRef} type="file" hidden onChange={(e) => void onPickAttachment(e)} />
      </div>
      <CodeModal open={codeOpen} onClose={() => setCodeOpen(false)} onInserted={() => onNotice?.(t('代码块已插入'))} />
      <TableModal
        open={tableEdit !== null}
        richPos={tableEdit?.richPos ?? null}
        initial={tableEdit?.data || null}
        onClose={() => setTableEdit(null)}
      />
    </>
  );
}
