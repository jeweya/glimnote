/**
 * 系统应用在本机找不到时的提示框。
 *
 * 系统应用入口只保存在当前电脑（.glimnote/local/home），换电脑、卸载或挪动
 * 安装位置后绝对路径就会失效。这里给出两条路：重新检查（可能刚装好），
 * 或者手动挑一个本机程序把入口重新关联上。
 *
 * 和设置类弹窗一样：只认 Esc 与右上角 ×，点遮罩不关闭，避免误触丢操作。
 */
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../lib/i18n';
import { AlertTriangle, FolderSearch, RefreshCw, X } from 'lucide-react';
import { desktop, type SystemApp } from '../lib/desktop';
import type { HomeEntry } from '../lib/home';

interface Props {
  /** 打不开的那个入口；null 时不渲染 */
  entry: HomeEntry | null;
  onClose: () => void;
  /** 选好新的程序后保存入口（首页走 store，浮窗直接写文件） */
  onPicked: (entry: HomeEntry, app: SystemApp) => Promise<void> | void;
  /** 重新检查本机是否已经能读到这个程序 */
  onRecheck?: () => Promise<void> | void;
}

function fileNameOf(target: string) {
  return target.split(/[\\/]/).pop() || target;
}

export function SystemAppMissingDialog({ entry, onClose, onPicked, onRecheck }: Props) {
  const [busy, setBusy] = useState(false);
  const tr = useT();
  const [error, setError] = useState('');

  useEffect(() => {
    if (!entry) return;
    setBusy(false);
    setError('');
  }, [entry]);

  useEffect(() => {
    if (!entry) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [entry, busy, onClose]);

  if (!entry) return null;

  const target = entry.target || '';
  const title = entry.title || (target ? fileNameOf(target) : tr('系统应用'));

  const pick = async () => {
    const bridge = desktop();
    if (!bridge?.pickSystemApp) {
      setError(tr('当前环境不支持手动选择程序，请在桌面客户端里操作。'));
      return;
    }
    setBusy(true);
    setError('');
    try {
      const result = await bridge.pickSystemApp();
      if (result.canceled) return;
      if (result.error || !result.app) {
        setError(result.error || tr('这个文件不能作为快捷入口，请选择 .exe / .lnk / .app 程序。'));
        return;
      }
      await onPicked(entry, result.app);
      onClose();
    } catch (e) {
      setError((e as Error).message || tr('保存失败，请稍后再试。'));
    } finally {
      setBusy(false);
    }
  };

  const recheck = async () => {
    setBusy(true);
    setError('');
    try {
      // 先自己确认一次：装好了就关窗，没装好留在原地给出说明，
      // 不然用户点了「重新检查」只看到弹窗消失、标记还在，容易以为坏了
      const api = desktop()?.systemAppStatus;
      if (api && target) {
        const found = await api([target]).catch(() => [] as string[]);
        await onRecheck?.();
        if (found.includes(target)) {
          onClose();
          return;
        }
        setError(tr('还是没找到这个程序。请先安装它，或点「手动选择本机程序」。'));
        return;
      }
      await onRecheck?.();
      onClose();
    } catch (e) {
      setError((e as Error).message || tr('检查失败，请稍后再试。'));
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div className="overlay">
      <div className="modal system-missing-dialog" role="dialog" aria-modal="true" aria-label={tr('找不到这个系统应用')}>
        <div className="modal-head">
          <div className="system-missing-head">
            <span className="system-missing-badge">
              <AlertTriangle size={17} strokeWidth={1.9} />
            </span>
            <div>
              <div className="modal-title">{tr('找不到「{title}」', { title })}</div>
              <div className="modal-desc">
                {tr('系统应用只保存在这台电脑上。换电脑、卸载或移动了安装位置后，原来的路径就失效了。')}
              </div>
            </div>
          </div>
          <button className="icon-btn" onClick={onClose} disabled={busy} aria-label={tr('关闭')}>
            <X size={16} />
          </button>
        </div>

        <div className="modal-body system-missing-body">
          <div className="system-missing-path">
            <span>{tr('上次记录的位置')}</span>
            <code>{target || tr('（没有记录路径）')}</code>
          </div>
          <p className="system-missing-tip">
            {tr('请先安装这个应用；装好了可以点「重新检查」。如果程序换了位置，点「手动选择本机程序」重新关联，入口的名称和分组不会变。')}
          </p>
          {error && <div className="home-form-error">{error}</div>}
        </div>

        <div className="modal-foot">
          <button className="btn btn-ghost" onClick={onClose} disabled={busy}>
            {tr('取消')}
          </button>
          <button className="btn btn-secondary" onClick={() => void recheck()} disabled={busy}>
            <RefreshCw size={13} strokeWidth={1.9} />
            {tr('重新检查')}
          </button>
          <button className="btn btn-primary" onClick={() => void pick()} disabled={busy}>
            <FolderSearch size={13} strokeWidth={1.9} />
            {busy ? tr('处理中…') : tr('手动选择本机程序')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
