import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, Download, FolderOpen, Loader2, Merge } from 'lucide-react';
import { useT } from '../lib/i18n';

interface Props {
  /** 正在执行哪一种选择，用于给对应按钮显示加载态 */
  busyMode?: 'keep-local' | 'overwrite' | null;
  onClose: () => void;
  onKeepLocal: () => void;
  onOverwrite: () => void;
  onManual: () => void;
}

/**
 * 连接 / 合并时两边都有改动，而且有文件没法自动合并。
 *
 * 常见于换平台或换账号后连到同名仓库：本机还留着旧仓库的历史。
 * 不能只丢一句「请自己处理」，也不能一直提示「再点一次」；这里给出三条
 * 真正能走下去的路，并且两条自动处理都不会丢任何一边的内容。
 */
export function MergeConflictDialog({ busyMode = null, onClose, onKeepLocal, onOverwrite, onManual }: Props) {
  const busy = Boolean(busyMode);
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
              {tr('两边都有改动，没法完全自动合并')}
            </div>
            <div className="modal-desc">
              {tr('这个仓库里已经有内容，本机也保留着另一份历史（常见于换平台、换账号后连接到同名仓库）。本机笔记已经保存成提交，下面两种做法都不会丢数据。')}
            </div>
            <div className="modal-desc" style={{ marginTop: 8 }}>
              <b>{tr('保留本机')}</b>：{tr('以本机内容为准继续连接；仓库里同名的那一份会另存为「冲突副本」，两份都在。')}
            </div>
            <div className="modal-desc" style={{ marginTop: 6 }}>
              <b>{tr('用仓库覆盖本地')}</b>：{tr('先自动导出 ZIP 备份本机笔记，再用仓库内容替换本机。适合以云端为准的情况。')}
            </div>
            <div className="modal-desc" style={{ marginTop: 6 }}>
              <b>{tr('手动处理')}</b>：{tr('打开笔记目录，把冲突文件改名或移走后，再回来点「校验并连接」。')}
            </div>
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn btn-ghost" onClick={onManual} disabled={busy}>
            <FolderOpen size={14} /> {tr('手动处理')}
          </button>
          <button className="btn btn-secondary" onClick={onOverwrite} disabled={busy}>
            {busyMode === 'overwrite' ? <Loader2 size={14} className="spin" /> : <Download size={14} />}
            {busyMode === 'overwrite' ? tr('正在备份并覆盖…') : tr('用仓库覆盖本地（先备份）')}
          </button>
          <button className="btn btn-primary" onClick={onKeepLocal} disabled={busy}>
            {busyMode === 'keep-local' ? <Loader2 size={14} className="spin" /> : <Merge size={14} />}
            {busyMode === 'keep-local' ? tr('正在保留本机…') : tr('保留本机（推荐）')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
