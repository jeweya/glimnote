import { useEffect, useState } from 'react';
import { openSearchPanel } from '@codemirror/search';
import {
  Bold,
  ClipboardPaste,
  Copy,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  Link2,
  List,
  Quote,
  Scissors,
  Search,
  Sparkles,
  SquareCheck,
  Strikethrough,
  Type,
} from 'lucide-react';
import type { Toast } from '../store/app';
import { getActiveView, toggleLinePrefix, wrapSelection } from '../lib/editorBridge';
import {
  getActiveRichEditor,
  richDeleteSelection,
  richSelection,
  richToggleBold,
  richToggleItalic,
  richTogglePrefix,
  richToggleStrike,
} from '../lib/rich/bridge';
import { sanitizePastedText } from '../lib/rich/sanitize';
import { htmlToPlainText, normalizeSourceText } from '../lib/rich/formattedPaste';
import { Menu, type MenuEntry } from './Menu';
import { useT } from '../lib/i18n';

/** Editor 在右键时抛这个事件，带给它的是鼠标坐标（编辑器自己不想管菜单状态） */
const OPEN_EVENT = 'glimnote:editor-menu';

interface Props {
  /** AI 润色：交给 EditorPane，那里才知道当前笔记与 Key 状态 */
  onPolish: () => void;
  onNotice: (text: string, kind?: Toast['kind']) => void;
}

/** 把纯文本写进系统剪贴板；navigator 不可用时退回 execCommand（老内核 / 非安全上下文） */
async function writeClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

interface ClipboardPayload {
  html: string;
  text: string;
  files: File[];
  denied: boolean;
}

function base64ToBytes(base64: string) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * 读剪贴板里的 HTML、纯文本和图片。
 *
 * 桌面端走主进程的 Clipboard，能稳定拿到 text/html；网页端退回
 * navigator.clipboard.read()，再不行只读纯文本。这样右键「粘贴」能尽量
 * 和 Ctrl+V 使用同一份剪贴板内容，而不是只剩一串没有格式的文字。
 */
async function readClipboard(): Promise<ClipboardPayload> {
  const desktop = (window as unknown as {
    glimnote?: {
      clipboardRead?: () => Promise<{
        text?: string;
        html?: string;
        files?: Array<{ name?: string; type?: string; data?: string }>;
      }>;
    };
  }).glimnote;

  if (desktop?.clipboardRead) {
    try {
      const raw = await desktop.clipboardRead();
      const files = (raw.files || [])
        .filter((file) => file?.data)
        .map((file) => new File([base64ToBytes(file.data || '')], file.name || '粘贴图片.png', { type: file.type || 'image/png' }));
      return { html: raw.html || '', text: raw.text || '', files, denied: false };
    } catch {
      /* 主进程读取失败时继续尝试浏览器的接口 */
    }
  }

  let html = '';
  let text = '';
  const files: File[] = [];
  let denied = false;
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      if (!html && item.types.includes('text/html')) {
        try {
          html = await (await item.getType('text/html')).text();
        } catch {
          /* 单个类型读失败不影响其它类型 */
        }
      }
      if (!text && item.types.includes('text/plain')) {
        try {
          text = await (await item.getType('text/plain')).text();
        } catch {
          /* 同上 */
        }
      }
      if (!html && !text) {
        const imageType = item.types.find((type) => /^image\//i.test(type));
        if (imageType) {
          try {
            const blob = await item.getType(imageType);
            const ext = imageType.split('/')[1]?.replace('jpeg', 'jpg').replace(/[^a-z0-9]/gi, '') || 'png';
            files.push(new File([blob], `粘贴图片.${ext}`, { type: imageType }));
          } catch {
            /* 图片读不出来就当作没有 */
          }
        }
      }
    }
  } catch {
    denied = true;
  }
  if (!text) {
    try {
      text = await navigator.clipboard.readText();
      denied = false;
    } catch {
      /* 保留 denied，交给调用方提示 */
    }
  }
  return { html, text, files, denied };
}

/**
 * 编辑器右键菜单。
 *
 * 为什么自己画：Electron 默认不弹任何右键菜单，右击像「没反应」；浏览器自带的菜单里
 * 也没有加粗、转标题这些本项目最常用的动作。这里复用笔记列表那套 Menu，样式与层级一致。
 *
 * 菜单结构固定、不可用项置灰（不做「缺什么就藏什么」）：右键是肌肉记忆，条目位置
 * 每次都不一样最容易点错。
 */
export function EditorContextMenu({ onPolish, onNotice }: Props) {
  const tr = useT();
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const onOpen = (e: Event) => {
      const detail = (e as CustomEvent<{ x: number; y: number }>).detail;
      if (detail) setAt({ x: detail.x, y: detail.y });
    };
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_EVENT, onOpen);
  }, []);

  // 菜单是 fixed 定位，编辑器一滚就会飘在半空，索性收起
  useEffect(() => {
    if (!at) return;
    const close = () => setAt(null);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [at]);

  const rich = getActiveRichEditor();
  const view = rich ? null : getActiveView();
  const sel = view?.state.selection.main;
  const selected = rich ? richSelection()?.text || '' : view && sel ? view.state.sliceDoc(sel.from, sel.to) : '';
  const hasSel = selected.trim().length > 0;

  const close = () => setAt(null);

  const cut = async () => {
    if (getActiveRichEditor()) {
      const text = richSelection()?.text || '';
      if (!text) return;
      if (!(await writeClipboard(text))) {
        onNotice(tr('没能写入剪贴板，请按 Ctrl+X'), 'warn');
        return;
      }
      richDeleteSelection();
      return;
    }
    const v = getActiveView();
    if (!v) return;
    const { from, to } = v.state.selection.main;
    if (from === to) return;
    const ok = await writeClipboard(v.state.sliceDoc(from, to));
    if (!ok) {
      onNotice(tr('没能写入剪贴板，请按 Ctrl+X'), 'warn');
      return;
    }
    v.dispatch({ changes: { from, to, insert: '' }, selection: { anchor: from } });
    v.focus();
  };

  const copy = async () => {
    if (getActiveRichEditor()) {
      const text = richSelection()?.text || '';
      if (!text) return;
      if (!(await writeClipboard(text))) onNotice(tr('没能写入剪贴板，请按 Ctrl+C'), 'warn');
      return;
    }
    const v = getActiveView();
    if (!v) return;
    const { from, to } = v.state.selection.main;
    if (from === to) return;
    if (!(await writeClipboard(v.state.sliceDoc(from, to)))) onNotice(tr('没能写入剪贴板，请按 Ctrl+C'), 'warn');
  };

  /** 和 Ctrl+V 走同一套内容：有 HTML 就按 HTML 插入，否则按行拆成段落 */
  const paste = async () => {
    const { html, text, files, denied } = await readClipboard();
    if (!html && !text.trim() && !files.length) {
      onNotice(tr(denied ? '浏览器不允许读取剪贴板，请按 Ctrl+V 粘贴' : '剪贴板里没有可粘贴的内容'), 'warn');
      return;
    }
    if (getActiveRichEditor()) {
      window.dispatchEvent(
        new CustomEvent('glimnote:paste-clipboard', { detail: { mode: 'native', html, text, files } }),
      );
      return;
    }
    const v = getActiveView();
    if (!v) return;
    const clean = sanitizePastedText(text.trim() ? text : htmlToPlainText(html));
    if (!clean) {
      onNotice(tr('剪贴板里没有可粘贴的内容'), 'warn');
      return;
    }
    const { from, to } = v.state.selection.main;
    v.dispatch({ changes: { from, to, insert: clean }, selection: { anchor: from + clean.length } });
    v.focus();
  };

  /** 只取文字、丢掉所有格式；富文本里每行一个段落，不再合成一个段落 */
  const pasteTextOnly = async () => {
    const { html, text, denied } = await readClipboard();
    if (!html && !text.trim()) {
      onNotice(tr(denied ? '浏览器不允许读取剪贴板，请按 Ctrl+V 粘贴' : '剪贴板里没有可粘贴的内容'), 'warn');
      return;
    }
    if (getActiveRichEditor()) {
      window.dispatchEvent(
        new CustomEvent('glimnote:paste-clipboard', { detail: { mode: 'text', html, text } }),
      );
      return;
    }
    const v = getActiveView();
    if (!v) return;
    const clean = normalizeSourceText(text.trim() ? text : htmlToPlainText(html));
    if (!clean) {
      onNotice(tr('剪贴板里没有可粘贴的内容'), 'warn');
      return;
    }
    const { from, to } = v.state.selection.main;
    v.dispatch({ changes: { from, to, insert: clean }, selection: { anchor: from + clean.length } });
    v.focus();
  };

  const prefix = (text: string) => {
    if (getActiveRichEditor()) {
      richTogglePrefix(text);
      return;
    }
    const v = getActiveView();
    if (!v) return;
    toggleLinePrefix(v, text);
  };

  const mark = (kind: 'bold' | 'italic' | 'strike') => {
    if (getActiveRichEditor()) {
      if (kind === 'bold') richToggleBold();
      else if (kind === 'italic') richToggleItalic();
      else richToggleStrike();
      return;
    }
    const v = getActiveView();
    if (!v) return;
    wrapSelection(
      v,
      kind === 'bold' ? '**' : kind === 'italic' ? '*' : '~~',
      kind === 'bold' ? '**' : kind === 'italic' ? '*' : '~~',
    );
  };

  const insertLink = () => {
    // 与工具栏「插入 → 链接…」、Ctrl+Shift+K 共用同一个弹层
    window.dispatchEvent(new Event('glimnote:insert-link'));
  };

  const find = () => {
    if (getActiveRichEditor()) {
      window.dispatchEvent(new Event('glimnote:rich-find'));
      return;
    }
    const v = getActiveView();
    if (v) openSearchPanel(v);
  };

  const items: (MenuEntry | 'sep')[] = [
    { label: tr('剪切'), icon: <Scissors size={14} />, kbd: 'Ctrl+X', disabled: !hasSel, onClick: () => void cut() },
    { label: tr('复制'), icon: <Copy size={14} />, kbd: 'Ctrl+C', disabled: !hasSel, onClick: () => void copy() },
    { label: tr('粘贴'), icon: <ClipboardPaste size={14} />, kbd: 'Ctrl+V', onClick: () => void paste() },
    { label: tr('只粘贴文本'), icon: <Type size={14} />, onClick: () => void pasteTextOnly() },
    'sep',
    { label: tr('加粗'), icon: <Bold size={14} />, kbd: 'Ctrl+B', onClick: () => mark('bold') },
    { label: tr('斜体'), icon: <Italic size={14} />, kbd: 'Ctrl+I', onClick: () => mark('italic') },
    { label: tr('删除线'), icon: <Strikethrough size={14} />, onClick: () => mark('strike') },
    { label: tr('插入链接…'), icon: <Link2 size={14} />, kbd: 'Ctrl+Shift+K', onClick: insertLink },
    'sep',
    { label: tr('标题 1'), icon: <Heading1 size={14} />, onClick: () => prefix('# ') },
    { label: tr('标题 2'), icon: <Heading2 size={14} />, onClick: () => prefix('## ') },
    { label: tr('标题 3'), icon: <Heading3 size={14} />, onClick: () => prefix('### ') },
    { label: tr('无序列表'), icon: <List size={14} />, onClick: () => prefix('- ') },
    { label: tr('待办'), icon: <SquareCheck size={14} />, kbd: 'Ctrl+Shift+X', onClick: () => prefix('- [ ] ') },
    { label: tr('引用'), icon: <Quote size={14} />, onClick: () => prefix('> ') },
    'sep',
    { label: tr('AI 润色选中文字'), icon: <Sparkles size={14} />, disabled: !hasSel, onClick: onPolish },
    'sep',
    { label: tr('查找…'), icon: <Search size={14} />, kbd: 'Ctrl+F', onClick: find },
  ];

  if (!at) return null;
  return <Menu x={at.x} y={at.y} items={items} onClose={close} />;
}
