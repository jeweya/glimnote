import { useEffect, useMemo, useRef, useState } from 'react';
import { EditorView } from '@codemirror/view';
import { ListTree, X } from 'lucide-react';
import { getActiveView } from '../lib/editorBridge';
import { getActiveRichEditor, richJumpToHeading } from '../lib/rich/bridge';
import { cn } from '../lib/utils';
import { useT } from '../lib/i18n';

export interface Heading {
  level: number;
  text: string;
  line: number;
  pos: number;
}

/** 提取 H1–H3；跳过 ``` 代码块里的 # 注释；兼容 `标题` + `===` / `---` 的旧式写法 */
export function parseHeadings(content: string): Heading[] {
  const out: Heading[] = [];
  const lines = content.split('\n');
  let pos = 0;
  let fence = false;
  lines.forEach((line, index) => {
    if (/^\s*(```|~~~)/.test(line)) {
      fence = !fence;
    } else if (!fence) {
      const m = /^(#{1,3})\s+(.+?)\s*#*\s*$/.exec(line);
      const text = m?.[2].trim();
      const next = lines[index + 1] || '';
      const underline = /^\s*(=+|-+)\s*$/.exec(next);
      if (m && text) {
        out.push({ level: m[1].length, text, line: index + 1, pos });
      } else if (underline && line.trim() && !/^\s*([-*+>]|\d+\.)\s/.test(line)) {
        out.push({ level: underline[1][0] === '=' ? 1 : 2, text: line.trim(), line: index + 1, pos });
      }
    }
    pos += line.length + 1;
  });
  return out;
}

interface Props {
  content: string;
  preview: boolean;
  onClose: () => void;
}

export function TocPanel({ content, preview, onClose }: Props) {
  const tr = useT();
  const headings = useMemo(() => parseHeadings(content), [content]);
  const headingsRef = useRef(headings);
  headingsRef.current = headings;
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  // 点击跳转后短暂锁定高亮：短文档不会产生滚动，长文档滚到底时末级标题也顶不到视口顶部，
  // 这两种情况都不该把高亮立刻抢回上一个标题。
  const lockUntil = useRef(0);

  // 跟随滚动位置，高亮当前所在的标题
  useEffect(() => {
    setActive(0);
    let raf = 0;
    // 每帧最多算一次，标题很多时滚动也不掉帧
    const schedule = (compute: () => void) => () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        compute();
      });
    };

    if (preview) {
      const scroller = document.querySelector<HTMLElement>('.editor-main .preview');
      const host = scroller?.querySelector<HTMLElement>('.preview-inner');
      if (!scroller || !host) return;
      const compute = () => {
        if (Date.now() < lockUntil.current) return;
        const els = Array.from(host.querySelectorAll<HTMLElement>('h1, h2, h3'));
        if (!els.length) return;
        const top = scroller.getBoundingClientRect().top + 96;
        let idx = 0;
        els.forEach((el, i) => {
          if (el.getBoundingClientRect().top <= top) idx = i;
        });
        // 滚到底时最后一个标题可能顶不到视口顶部，直接高亮它
        if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 8) idx = els.length - 1;
        setActive(idx);
      };
      const onScroll = schedule(compute);
      scroller.addEventListener('scroll', onScroll, { passive: true });
      compute();
      return () => {
        scroller.removeEventListener('scroll', onScroll);
        if (raf) cancelAnimationFrame(raf);
      };
    }

    // 富文本模式：标题是 DOM，按位置算比拿 ProseMirror 位置更直接
    const richScroll = document.querySelector<HTMLElement>('.editor-main .rich-scroll');
    const richHost = richScroll?.querySelector<HTMLElement>('.tiptap');
    if (richScroll && richHost) {
      const compute = () => {
        if (Date.now() < lockUntil.current) return;
        const els = Array.from(richHost.querySelectorAll<HTMLElement>('h1, h2, h3'));
        if (!els.length) return;
        const top = richScroll.getBoundingClientRect().top + 96;
        let idx = 0;
        els.forEach((el, i) => {
          if (el.getBoundingClientRect().top <= top) idx = i;
        });
        if (richScroll.scrollTop + richScroll.clientHeight >= richScroll.scrollHeight - 8) idx = els.length - 1;
        setActive(idx);
      };
      const onScroll = schedule(compute);
      richScroll.addEventListener('scroll', onScroll, { passive: true });
      compute();
      return () => {
        richScroll.removeEventListener('scroll', onScroll);
        if (raf) cancelAnimationFrame(raf);
      };
    }

    const view = getActiveView();
    if (!view) return;
    const scroller = view.scrollDOM;
    const compute = () => {
      if (Date.now() < lockUntil.current) return;
      const list = headingsRef.current;
      if (!list.length) return;
      const block = view.lineBlockAtHeight(scroller.scrollTop + 48);
      const line = view.state.doc.lineAt(block.from).number;
      let idx = 0;
      list.forEach((h, i) => {
        if (h.line <= line) idx = i;
      });
      if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 8) idx = list.length - 1;
      setActive(idx);
    };
    const onScroll = schedule(compute);
    scroller.addEventListener('scroll', onScroll, { passive: true });
    compute();
    return () => {
      scroller.removeEventListener('scroll', onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [preview]);

  // 高亮项保持在目录可视范围内
  useEffect(() => {
    const list = listRef.current;
    const item = list?.children[active] as HTMLElement | undefined;
    if (!list || !item) return;
    const lr = list.getBoundingClientRect();
    const ir = item.getBoundingClientRect();
    if (ir.top < lr.top) list.scrollTop -= lr.top - ir.top + 6;
    else if (ir.bottom > lr.bottom) list.scrollTop += ir.bottom - lr.bottom + 6;
  }, [active]);

  const go = (index: number) => {
    const h = headings[index];
    if (!h) return;
    lockUntil.current = Date.now() + 900;
    setActive(index);
    if (preview) {
      const host = document.querySelector<HTMLElement>('.editor-main .preview-inner');
      const el = host?.querySelectorAll<HTMLElement>('h1, h2, h3')[index];
      el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    if (getActiveRichEditor()) {
      if (richJumpToHeading(index)) {
        const host = document.querySelector<HTMLElement>('.editor-main .rich-scroll .tiptap');
        const el = host?.querySelectorAll<HTMLElement>('h1, h2, h3')[index];
        el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
      return;
    }
    const view = getActiveView();
    if (!view) return;
    const pos = Math.min(h.pos, view.state.doc.length);
    view.dispatch({
      selection: { anchor: pos },
      effects: EditorView.scrollIntoView(pos, { y: 'start', yMargin: 28 }),
    });
    view.focus();
  };

  return (
    <aside className="toc-panel" aria-label={tr('目录')}>
      <div className="toc-head">
        <span className="toc-title">
          <ListTree size={14} strokeWidth={1.75} /> {tr('目录')}
        </span>
        <span className="toc-count">{headings.length}</span>
        <button className="icon-btn toc-close" onClick={onClose} title={tr('关闭目录  Ctrl+Shift+O')}>
          <X size={14} />
        </button>
      </div>
      <div className="toc-list" ref={listRef}>
        {headings.length === 0 ? (
          <div className="toc-empty">
            {tr('还没有标题。用 # 写小标题，这里会自动生成目录。')}
          </div>
        ) : (
          headings.map((h, i) => (
            <button
              key={`${h.pos}-${i}`}
              className={cn('toc-item', `lv-${h.level}`, i === active && 'on')}
              title={h.text}
              onClick={() => go(i)}
            >
              {h.text}
            </button>
          ))
        )}
      </div>
    </aside>
  );
}
