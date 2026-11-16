import { useEffect, useMemo, useState } from 'react';
import { Check, Folder, Inbox, Loader2, Search, X } from 'lucide-react';
import { useApp } from '../store/app';
import { cn } from '../lib/utils';
import { t, useT } from '../lib/i18n';

interface Option {
  path: string;
  depth: number;
  label: string;
}

const INBOX = 'inbox';

/** 把笔记与自定义笔记本整理成可选的路径列表，并补上中间层级的父目录 */
function collectOptions(notebooks: string[], custom: string[]): Option[] {
  const set = new Set<string>();
  for (const path of [...notebooks, ...custom]) {
    if (!path) continue;
    const segs = path.split('/').filter(Boolean);
    let prefix = '';
    for (const seg of segs) {
      prefix = prefix ? `${prefix}/${seg}` : seg;
      set.add(prefix);
    }
  }
  set.delete(INBOX);
  const list = [...set].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
  const options: Option[] = [
    { path: INBOX, depth: 0, label: t('收件箱') },
    ...list.map((path) => ({
      path,
      depth: path.split('/').length - 1,
      label: path.split('/').pop() || path,
    })),
  ];
  return options;
}

export function MoveDialog() {
  const id = useApp((s) => s.moveNoteId);
  const note = useApp((s) => s.notes.find((n) => n.id === s.moveNoteId) || null);
  const notes = useApp((s) => s.notes);
  const notebooks = useApp((s) => s.notebooks);
  const setMoveNote = useApp((s) => s.setMoveNote);
  const moveTo = useApp((s) => s.moveTo);
  const [query, setQuery] = useState('');
  const tr = useT();
  const [busy, setBusy] = useState('');

  useEffect(() => {
    if (id) {
      setQuery('');
      setBusy('');
    }
  }, [id]);

  const options = useMemo(
    () => collectOptions(notes.map((n) => n.notebook).filter(Boolean), notebooks),
    [notes, notebooks],
  );

  if (!id || !note) return null;

  const q = query.trim().toLowerCase();
  const list = q
    ? options.filter((o) => o.label.toLowerCase().includes(q) || o.path.toLowerCase().includes(q))
    : options;
  const close = () => setMoveNote(null);

  return (
    <div className="overlay" onClick={close}>
      <div className="modal move-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <div className="modal-title">{tr('移动到…')}</div>
            <div className="modal-desc">{tr('「{title}」会移动到选中的笔记本', { title: note.title || tr('未命名笔记') })}</div>
          </div>
          <button className="icon-btn" onClick={close} title={tr('关闭  Esc')}>
            <X size={16} />
          </button>
        </div>

        <div className="move-search">
          <Search size={14} strokeWidth={1.75} />
          <input
            autoFocus
            value={query}
            placeholder={tr('搜索笔记本')}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') close();
            }}
          />
        </div>

        <div className="move-list">
          {list.map((opt) => {
            const active = (note.notebook || '') === opt.path;
            const Icon = opt.path === INBOX ? Inbox : Folder;
            return (
              <button
                key={opt.path}
                className={cn('move-item', active && 'on')}
                style={{ paddingLeft: 10 + (opt.path === INBOX ? 0 : opt.depth) * 14 }}
                disabled={Boolean(busy) || active}
                title={opt.path}
                onClick={async () => {
                  setBusy(opt.path);
                  try {
                    await moveTo(note.id, opt.path);
                  } finally {
                    setBusy('');
                  }
                }}
              >
                {busy === opt.path ? <Loader2 size={14} className="spin" /> : <Icon size={14} />}
                <span className="move-label">{opt.label}</span>
                {active && (
                  <span className="move-here">
                    <Check size={14} /> {tr('当前')}
                  </span>
                )}
              </button>
            );
          })}
          {list.length === 0 && <div className="move-empty">{tr('没有匹配的笔记本，换个关键词，或先在侧栏新建一个。')}</div>}
        </div>

        <div className="move-foot">
          <span>{tr('移动只改变文件夹，历史版本与标签都会保留。')}</span>
          <button className="btn btn-secondary" onClick={close}>
            {tr('取消')}
          </button>
        </div>
      </div>
    </div>
  );
}
