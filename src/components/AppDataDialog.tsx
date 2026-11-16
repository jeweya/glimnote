import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Database, Download, Trash2, X } from 'lucide-react';
import { clearAppData, readAppData, type AppMeta } from '../lib/apps';
import { useApp } from '../store/app';
import { downloadText } from '../lib/utils';
import { useT } from '../lib/i18n';

interface Props {
  app: AppMeta | null;
  onClose: () => void;
}

function sizeText(bytes: number) {
  if (!bytes) return '0 B';
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

/**
 * 应用数据管理：看键数 / 体积，导出或清空。
 *
 * 数据写在 apps/<id>/data.json，跟随 Git 同步；这里不展示完整值，
 * 只给键名和一行预览，避免把用户的私密内容摊得满屏都是。
 */
export function AppDataDialog({ app, onClose }: Props) {
  const tr = useT();
  const toast = useApp((s) => s.toast);
  const [data, setData] = useState<Record<string, unknown> | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!app) return;
    let alive = true;
    setData(null);
    setConfirming(false);
    setBusy(false);
    void readAppData(app.id)
      .then((value) => {
        if (alive) setData(value);
      })
      .catch(() => {
        if (alive) setData({});
      });
    return () => {
      alive = false;
    };
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

  const entries = Object.entries(data || {});
  const bytes = data ? new TextEncoder().encode(JSON.stringify(data)).length : 0;

  const exportData = () => {
    downloadText(
      `${app.name.replace(/[\\/:*?"<>|]/g, '-') || tr('AI 小应用')}-${tr('数据')}.json`,
      `${JSON.stringify(data || {}, null, 2)}\n`,
      'application/json;charset=utf-8',
    );
    toast(tr('已导出应用数据'), 'success');
  };

  const doClear = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await clearAppData(app.id);
      useApp.getState().markPending();
      setData({});
      setConfirming(false);
      toast(tr('已清空「{name}」的数据', { name: app.name }), 'success');
    } catch (e) {
      toast((e as Error)?.message || tr('清空失败'), 'error');
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div className="overlay">
      <div className="modal home-dialog app-data-dialog" role="dialog" aria-modal="true" aria-label={tr('应用数据')}>
        <div className="modal-head">
          <div>
            <div className="modal-title">
              <span className="app-data-icon">
                <Database size={15} />
              </span>
              {tr('「{name}」的数据', { name: app.name })}
            </div>
            <div className="modal-desc">
              {tr('存在仓库的 apps/{id}/data.json，跟随同步到云端和其他设备；应用代码本身读不到笔记或令牌。', { id: app.id })}
            </div>
          </div>
          <button className="icon-btn" onClick={onClose} disabled={busy} aria-label={tr('关闭')}>
            <X size={16} />
          </button>
        </div>

        <div className="modal-body home-dialog-body">
          {data === null ? (
            <div className="app-data-empty">{tr('正在读取…')}</div>
          ) : entries.length === 0 ? (
            <div className="app-data-empty">{tr('这个应用还没有保存过数据。应用里录入的内容会自动出现在这里。')}</div>
          ) : (
            <>
              <div className="app-data-summary">
                <span>{tr('{n} 个键', { n: entries.length })}</span>
                <span>{sizeText(bytes)} / 512 KB</span>
              </div>
              <div className="app-data-keys">
                {entries.slice(0, 8).map(([key, value]) => {
                  let preview = '';
                  try {
                    preview = JSON.stringify(value) ?? '';
                  } catch {
                    preview = '';
                  }
                  return (
                    <div className="app-data-key" key={key}>
                      <span className="adk-name">{key}</span>
                      <span className="adk-value">{preview.slice(0, 48)}</span>
                    </div>
                  );
                })}
                {entries.length > 8 && (
                  <div className="app-data-more">{tr('还有 {n} 个键，导出后可以看完整内容。', { n: entries.length - 8 })}</div>
                )}
              </div>
            </>
          )}
          <div className="app-data-tip">
            {tr('两台设备同时改数据时，后同步的一方会覆盖同一份 data.json；应用数据适合放偏好、历史记录这类可以整体替换的内容。')}
          </div>
        </div>

        <div className="modal-foot">
          <button className="btn btn-ghost" onClick={onClose} disabled={busy}>
            {tr('关闭')}
          </button>
          <button className="btn btn-secondary" onClick={exportData} disabled={!entries.length || busy}>
            <Download size={14} /> {tr('导出 JSON')}
          </button>
          {confirming ? (
            <button className="btn btn-danger" onClick={() => void doClear()} disabled={busy}>
              <Trash2 size={14} /> {busy ? tr('清空中…') : tr('再点一次清空')}
            </button>
          ) : (
            <button
              className="btn btn-ghost app-data-clear"
              onClick={() => setConfirming(true)}
              disabled={!entries.length || busy}
            >
              <Trash2 size={14} /> {tr('清空数据')}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
