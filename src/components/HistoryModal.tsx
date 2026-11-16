import { useEffect, useState } from 'react';
import { Clock3, History, RotateCcw } from 'lucide-react';
import type { Note } from '../lib/markdown';
import { listVersions, readVersion, snapshot, type VersionInfo } from '../lib/history';
import { pad } from '../lib/utils';
import { Preview } from './Preview';
import { t, useT } from '../lib/i18n';

interface Props {
  note: Note;
  onClose: () => void;
  onRestore: (content: string) => void;
}

function stampLabel(iso: string) {
  const d = new Date(iso);
  const now = new Date();
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.toDateString() === now.toDateString()) return `${t('今天')} ${time}`;
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `${t('昨天')} ${time}`;
  const sameYear = d.getFullYear() === now.getFullYear();
  const date = `${t('{m}月{d}日', { m: d.getMonth() + 1, d: d.getDate() })} ${time}`;
  return sameYear ? date : t('{y}年{date}', { y: d.getFullYear(), date });
}

export function HistoryModal({ note, onClose, onRestore }: Props) {
  const tr = useT();
  const [versions, setVersions] = useState<VersionInfo[] | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const list = await listVersions(note.id);
      if (cancelled) return;
      setVersions(list);
      setActive(list[0]?.id || null);
    })();
    return () => {
      cancelled = true;
    };
  }, [note.id]);

  useEffect(() => {
    if (!active) {
      setContent('');
      return;
    }
    let cancelled = false;
    setLoading(true);
    void readVersion(note.id, active).then((text) => {
      if (cancelled) return;
      setContent(text || '');
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [active, note.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const restore = () => {
    if (!content) return;
    void snapshot(note, { force: true }).catch(() => {});
    onRestore(content);
  };

  const selected = versions?.find((v) => v.id === active) || null;

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal history-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <div className="modal-title">
              <History size={16} style={{ verticalAlign: '-2px', marginRight: 6 }} />
              历史版本
            </div>
            <div className="modal-desc">
              {tr('「{title}」· 最近 {n} 份快照，最多保留 40 份', { title: note.title, n: versions?.length || 0 })}
            </div>
          </div>
          <button className="icon-btn" onClick={onClose} title={tr('关闭')}>
            ✕
          </button>
        </div>

        <div className="history-body">
          <div className="history-list">
            {versions === null && <div className="history-hint">{tr('正在读取…')}</div>}
            {versions && versions.length === 0 && (
              <div className="history-hint">
                <Clock3 size={20} strokeWidth={1.75} />
                <div>{tr('还没有历史版本')}</div>
                <p>{tr('继续编辑，内容变化后大约每 90 秒会留下一份快照。所有快照都保存在本地，不依赖网络。')}</p>
              </div>
            )}
            {versions?.map((v) => (
              <button
                key={v.id}
                className={v.id === active ? 'history-item on' : 'history-item'}
                onClick={() => setActive(v.id)}
              >
                <span className="hi-time">{stampLabel(v.at)}</span>
                <span className="hi-meta">{tr('{n} 字', { n: v.words })}</span>
              </button>
            ))}
          </div>

          <div className="history-preview">
            {!versions?.length ? (
              <div className="history-preview-empty">{tr('选择一个版本，这里会显示当时的内容。')}</div>
            ) : loading ? (
              <div className="history-preview-empty">{tr('读取中…')}</div>
            ) : (
              <Preview content={content} notePath={note.path} />
            )}
          </div>
        </div>

        <div className="modal-foot">
          {selected && <span className="history-current">{tr('当前正文不会被直接覆盖，恢复后会生成一份新快照。')}</span>}
          <button className="btn btn-ghost" onClick={onClose}>
            {tr('取消')}
          </button>
          <button className="btn btn-primary" disabled={!content} onClick={restore}>
            <RotateCcw size={14} /> {tr('恢复这个版本')}
          </button>
        </div>
      </div>
    </div>
  );
}
