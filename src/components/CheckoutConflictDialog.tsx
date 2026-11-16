import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../lib/i18n';
import { AlertTriangle, FolderOpen, Loader2, RefreshCw } from 'lucide-react';

interface Props {
  busy?: boolean;
  onClose: () => void;
  onForce: () => void;
  onManual: () => void;
}

/**
 * 连接时本地已有同名文件、内容和仓库不同。
 *
 * isomorphic-git 不允许静默覆盖，这里必须让用户明确二选一：
 * 用仓库版本覆盖本地（先自动备份），或者打开目录自己改名后重连。
 * 强制覆盖是破坏性操作，所以点遮罩不关闭、回车也不触发，只认按钮。
 */
export function CheckoutConflictDialog({ busy = false, onClose, onForce, onManual }: Props) {
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
        style={{ width: 460 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <div>
            <div className="modal-title" style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              <AlertTriangle size={16} style={{ color: 'var(--warning)' }} />
              {tr('本地有同名文件，内容不同')}
            </div>
            <div className="modal-desc">{tr('仓库里已经有同名文件，而且内容和本地这份不一样，所以没有直接覆盖。')}</div>
            <div className="modal-desc" style={{ marginTop: 8 }}>
              <b>{tr('强制覆盖')}</b>：{tr('用仓库版本覆盖本地这几篇。覆盖前会自动导出 ZIP 备份，被覆盖的内容可以从备份找回。')}
            </div>
            <div className="modal-desc" style={{ marginTop: 6 }}>
              <b>{tr('手动处理')}</b>：{tr('打开笔记所在目录，把本地这几篇改名或移走，再回来点「校验并连接」。')}
            </div>
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn btn-ghost" onClick={onManual} disabled={busy}>
            <FolderOpen size={14} /> {tr('手动处理')}
          </button>
          <button className="btn btn-danger" onClick={onForce} disabled={busy}>
            {busy ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
            {busy ? tr('正在覆盖本地…') : tr('强制覆盖本地（自动备份）')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
