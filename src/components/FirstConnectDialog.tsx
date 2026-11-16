import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../lib/i18n';
import { AlertTriangle, Download, Loader2, Merge } from 'lucide-react';

interface Props {
  busy?: boolean;
  /** 正在执行哪一种选择，用于给对应按钮显示加载态 */
  busyMode?: 'merge' | 'adopt-remote' | null;
  onClose: () => void;
  onMerge: () => void;
  onAdopt: () => void;
}

/**
 * 首次连接一个已经有内容的仓库，而本机也有自己的笔记。
 *
 * 不替用户做决定：合并不会丢东西，覆盖会先备份本机再替换。
 * 这里没有「取消后继续连接」这种中间状态，两个按钮都会真正往下走。
 */
export function FirstConnectDialog({ busy = false, busyMode = null, onClose, onMerge, onAdopt }: Props) {
  const tr = useT();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || busy) return;
      e.stopPropagation();
      e.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [busy, onClose]);

  return createPortal(
    <div className="overlay overlay-confirm">
      <div
        className="modal"
        role="alertdialog"
        aria-modal="true"
        style={{ width: 480 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <div>
            <div className="modal-title" style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              <AlertTriangle size={16} style={{ color: 'var(--warning)' }} />
              {tr('仓库里已经有笔记')}
            </div>
            <div className="modal-desc">
              {tr('这是本机第一次连接这个仓库，本机也有自己的内容。两种做法都会先保住数据，不会直接丢。')}
            </div>
            <div className="modal-desc" style={{ marginTop: 8 }}>
              <b>{tr('合并两边')}</b>：{tr('本机和仓库的笔记都保留。同名但内容不同的文件会另存为「冲突副本」，两份都在。')}
            </div>
            <div className="modal-desc" style={{ marginTop: 6 }}>
              <b>{tr('用仓库覆盖本地')}</b>：{tr('先把本机笔记完整备份到')} <code>.glimnote/local</code>{tr('，再用仓库内容替换本机。适合这台电脑上的内容只是临时试用、以仓库为准的情况。')}
            </div>
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn btn-secondary" onClick={onAdopt} disabled={busy}>
            {busyMode === 'adopt-remote' ? <Loader2 size={14} className="spin" /> : <Download size={14} />}
            {busyMode === 'adopt-remote' ? tr('正在备份并覆盖…') : tr('用仓库覆盖本地（先备份）')}
          </button>
          <button className="btn btn-primary" onClick={onMerge} disabled={busy}>
            {busyMode === 'merge' ? <Loader2 size={14} className="spin" /> : <Merge size={14} />}
            {busyMode === 'merge' ? tr('正在合并…') : tr('合并两边（推荐）')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
