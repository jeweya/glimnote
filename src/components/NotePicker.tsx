import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { FileText, Search } from 'lucide-react';
import type { Note } from '../lib/markdown';
import { useT } from '../lib/i18n';

interface Props {
  notes: Note[];
  x: number;
  y: number;
  onPick: (note: Note) => void;
  onClose: () => void;
}

/** 「关联一篇笔记」的小面板：视觉沿用「移动到…」的列表 */
export function NotePicker({ notes, x, y, onPick, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const tr = useT();
  const inputRef = useRef<HTMLInputElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  const [q, setQ] = useState('');

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let left = x;
    let top = y;
    if (left + r.width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - r.width - 8);
    if (top + r.height > window.innerHeight - 8) top = Math.max(8, y - r.height);
    setPos({ left, top });
  }, [x, y]);

  useEffect(() => {
    const t = window.setTimeout(() => inputRef.current?.focus(), 20);
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener('mousedown', onDown);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener('mousedown', onDown);
    };
  }, [onClose]);

  const list = useMemo(() => {
    const term = q.trim().toLowerCase();
    const pool = term
      ? notes.filter(
          (n) =>
            n.title.toLowerCase().includes(term) ||
            n.notebook.toLowerCase().includes(term) ||
            n.excerpt.toLowerCase().includes(term),
        )
      : notes;
    return [...pool].sort((a, b) => +new Date(b.updated) - +new Date(a.updated)).slice(0, 8);
  }, [notes, q]);

  return (
    <div
      className="note-pop"
      ref={ref}
      style={{ left: pos.left, top: pos.top }}
      role="dialog"
      aria-label={tr('关联笔记')}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          onClose();
        }
      }}
    >
      <div className="np-search">
        <Search size={14} />
        <input
          ref={inputRef}
          value={q}
          placeholder={tr('搜索笔记标题或正文')}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && list[0]) onPick(list[0]);
          }}
        />
      </div>
      <div className="np-list">
        {list.length === 0 ? (
          <div className="np-empty">{tr('没有匹配的笔记')}</div>
        ) : (
          list.map((n) => (
            <button key={n.id} className="np-item" onClick={() => onPick(n)}>
              <FileText size={14} />
              <span className="np-title">{n.title || tr('未命名笔记')}</span>
              <span className="np-sub">{n.notebook || tr('未分类')}</span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
