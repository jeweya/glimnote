import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../lib/i18n';
import { Check, X } from 'lucide-react';
import type { AppMeta } from '../lib/apps';
import { AppMetaFields, type AppMetaDraft } from './AppMetaFields';

interface Props {
  app: AppMeta | null;
  onClose: () => void;
  onSave: (patch: AppMetaDraft) => Promise<void>;
}

/** 首页应用卡片「⋯ → 编辑应用信息」：名称、说明、图标、颜色，和生成页的应用信息卡同一套表单 */
export function AppInfoDialog({ app, onClose, onSave }: Props) {
  const [draft, setDraft] = useState<AppMetaDraft>({ name: '', description: '', icon: 'sparkles', color: 'green' });
  const tr = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!app) return;
    setDraft({ name: app.name, description: app.description, icon: app.icon, color: app.color });
    setBusy(false);
    setError('');
    const timer = window.setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 50);
    return () => window.clearTimeout(timer);
  }, [app]);

  useEffect(() => {
    if (!app) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || busy) return;
      event.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [app, busy, onClose]);

  if (!app) return null;

  const cleanName = draft.name.replace(/\s+/g, ' ').trim();

  const submit = async () => {
    if (busy) return;
    if (!cleanName) {
      setError(tr('应用名称不能为空'));
      return;
    }
    setBusy(true);
    setError('');
    try {
      await onSave({ ...draft, name: cleanName, description: draft.description.trim() });
      onClose();
    } catch (e) {
      setError((e as Error).message || tr('保存失败，稍后再试'));
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div className="overlay">
      <div
        className="modal home-dialog app-info-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={tr('应用信息')}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
          if (!(event.target instanceof HTMLInputElement)) return;
          event.preventDefault();
          void submit();
        }}
      >
        <div className="modal-head">
          <div>
            <div className="modal-title">{tr('应用信息')}</div>
            <div className="modal-desc">{tr('名称、说明和外观会同步到首页入口，不会改动应用代码。')}</div>
          </div>
          <button className="icon-btn" onClick={onClose} disabled={busy} aria-label={tr('关闭')}>
            <X size={16} />
          </button>
        </div>
        <div className="modal-body home-dialog-body">
          <AppMetaFields
            value={draft}
            onChange={(patch) => setDraft((current) => ({ ...current, ...patch }))}
            nameRef={inputRef}
            autoFocusName
          />
          {error && <div className="home-form-error">{error}</div>}
        </div>
        <div className="modal-foot">
          <button className="btn btn-ghost" onClick={onClose} disabled={busy}>
            {tr('取消')}
          </button>
          <button className="btn btn-primary" onClick={() => void submit()} disabled={busy || !cleanName}>
            <Check size={14} />
            {busy ? tr('保存中…') : tr('保存')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
