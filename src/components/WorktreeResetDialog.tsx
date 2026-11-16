import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../lib/i18n';
import { AlertTriangle, Loader2, RotateCcw, Trash2 } from 'lucide-react';

interface Props {
  /** 连接时抛出的说明，包含缺失文件数量 */
  message: string;
  busy?: boolean;
  /** 正在执行哪一种选择，用于给对应按钮显示加载态 */
  busyMode?: 'restore' | 'keep' | null;
  onClose: () => void;
  onRestore: () => void;
  onKeep: () => void;
}

/**
 * 本机仓库历史还在，但工作区的文件被整片清空了。
 *
 * 这时 HEAD 和远端可能一模一样，merge 不会发生；如果直接 commitAll，缺掉的
 * 文件会被当成删除提交推送上去，云端数据就被覆盖了。必须让用户明确选择：
 * 补回本地（推荐），或者确认这些文件确实应该从云端删除。
 */
export function WorktreeResetDialog({ message, busy = false, busyMode = null, onClose, onRestore, onKeep }: Props) {
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
        style={{ width: 500 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <div>
            <div className="modal-title" style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              <AlertTriangle size={16} style={{ color: 'var(--warning)' }} />
              {tr('本地笔记目录像是被重置了')}
            </div>
            <div className="modal-desc">{message}</div>
            <div className="modal-desc" style={{ marginTop: 8 }}>
              <b>{tr('用仓库内容恢复本地')}</b>：{tr('把缺少的文件按本地历史补回来，本机后来新增的笔记和应用原样保留。这是推荐做法。')}
            </div>
            <div className="modal-desc" style={{ marginTop: 6 }}>
              <b>{tr('仍然继续')}</b>：{tr('只在确定这些文件应该从云端删除时使用。提交后，其它设备同步时也会跟着删除。')}
            </div>
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn btn-secondary" onClick={onKeep} disabled={busy}>
            {busyMode === 'keep' ? <Loader2 size={14} className="spin" /> : <Trash2 size={14} />}
            {busyMode === 'keep' ? tr('正在继续…') : tr('仍然继续（会删除云端文件）')}
          </button>
          <button className="btn btn-primary" onClick={onRestore} disabled={busy}>
            {busyMode === 'restore' ? <Loader2 size={14} className="spin" /> : <RotateCcw size={14} />}
            {busyMode === 'restore' ? tr('正在恢复…') : tr('用仓库内容恢复本地（推荐）')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
