import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { CloudUpload, FileText, Loader2, X } from 'lucide-react';
import { ROOT, pathSize } from '../lib/storage';
import { loadAssetUrl } from '../lib/rich/assetUrls';
import { useApp } from '../store/app';
import { useT } from '../lib/i18n';
import {
  ASSETS_CHANGED_EVENT,
  assetDisplayName,
  deleteLocalAsset,
  formatAssetSize,
  isImageAsset,
  markAssetUploaded,
  replaceAssetReferences,
  uploadLocalAsset,
} from '../lib/assetLibrary';

export interface AssetTarget {
  abs: string;
  rel?: string;
  name?: string;
  size?: number;
  image?: boolean;
}

interface Props {
  target: AssetTarget;
  onClose: () => void;
  onUploaded?: (result: { url: string; deleted: boolean; remaining: number }) => void;
}

/**
 * 「上传到七牛云」的确认弹窗。
 *
 * 上传的目的是让仓库变轻，所以成功后会自动删除本地文件：
 * 先把全仓库里的引用换成云端链接，确认没有残留引用才删除；
 * 万一还有引用没替换成功，就保留本地文件，避免笔记里的图片变成裂图。
 */
export function AssetUploadDialog({ target, onClose, onUploaded }: Props) {
  const t = useT();
  const toast = useApp((s) => s.toast);
  const rel = target.rel ?? target.abs.slice(ROOT.length + 1);
  const name = target.name ?? assetDisplayName(rel);
  const image = target.image ?? isImageAsset(rel);
  const [size, setSize] = useState(target.size ?? 0);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    if (!target.size) {
      void pathSize(target.abs).then((r) => {
        if (alive) setSize(r.bytes);
      }).catch(() => {});
    }
    if (image) {
      void loadAssetUrl(target.abs).then((url) => {
        if (alive) setPreview(url);
      });
    }
    return () => {
      alive = false;
    };
  }, [target.abs, target.size, image]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      e.preventDefault();
      if (!busy) onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [busy, onClose]);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const { url } = await uploadLocalAsset(target.abs);
      await markAssetUploaded(rel, url, size);
      const result = await replaceAssetReferences(target.abs, url);
      let deleted = false;
      let deleteError = '';
      // 上传的意义就是给仓库减重：引用全部换成云端地址后删掉本机副本
      if (result.remaining === 0) {
        try {
          await deleteLocalAsset(target.abs);
          deleted = true;
        } catch (err) {
          // 上传已经成功，删除失败只是少省一点空间，不能报成「上传失败」
          deleteError = err instanceof Error ? err.message : String(err);
          window.dispatchEvent(new Event(ASSETS_CHANGED_EVENT));
        }
      } else {
        window.dispatchEvent(new Event(ASSETS_CHANGED_EVENT));
      }
      onUploaded?.({ url, deleted, remaining: result.remaining });
      if (deleteError) {
        toast(t('已上传到七牛云，但删除本地文件失败：{msg}', { msg: deleteError }), 'warn');
      } else if (result.remaining > 0) {
        toast(t('已上传到七牛云，但还有 {n} 处引用没能替换，本地文件已保留', { n: result.remaining }), 'warn');
      } else if (deleted) {
        toast(t('已上传到七牛云，本地文件已删除'), 'success');
      } else {
        toast(t('已上传到七牛云'), 'success');
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div className="overlay asset-upload-overlay">
      <div className="modal asset-upload-modal" role="dialog" aria-modal="true" aria-labelledby="asset-upload-title">
        <button className="qiniu-close" onClick={onClose} disabled={busy} aria-label={t('关闭')} title={t('关闭')}>
          <X size={15} />
        </button>

        <div className="modal-head">
          <div>
            <div className="modal-title" id="asset-upload-title">
              {t('上传到七牛云')}
            </div>
            <div className="modal-desc">
              {t('上传后，笔记里的引用会自动换成云端链接，随后删除本机文件，仓库里只保留链接。')}
            </div>
          </div>
        </div>

        <div className="asset-upload-body">
          <div className="asset-upload-file">
            {image ? (
              preview ? (
                <img className="asset-upload-thumb" src={preview} alt="" />
              ) : (
                <span className="asset-upload-thumb placeholder">
                  <CloudUpload size={20} strokeWidth={1.7} />
                </span>
              )
            ) : (
              <span className="asset-upload-thumb placeholder">
                <FileText size={20} strokeWidth={1.7} />
              </span>
            )}
            <div className="asset-upload-meta">
              <div className="asset-upload-name" title={rel}>
                {name}
              </div>
              <div className="asset-upload-sub">
                {rel}
                {size > 0 && <span> · {formatAssetSize(size)}</span>}
              </div>
            </div>
          </div>

          <div className="asset-upload-note">
            <span>
              <strong>{t('上传成功后会删除本机文件，减少仓库体积')}</strong>
              <em>{t('笔记里的链接会自动换成云端地址；如果还有引用没替换成功，会保留本机文件。')}</em>
            </span>
          </div>

          {error && <div className="qiniu-msg bad">{t('上传失败：{msg}', { msg: error })}</div>}
        </div>

        <div className="modal-foot">
          <button className="btn btn-ghost" onClick={onClose} disabled={busy}>
            {t('取消')}
          </button>
          <button className="btn btn-primary" onClick={() => void submit()} disabled={busy}>
            {busy ? <Loader2 size={14} className="spin" /> : <CloudUpload size={14} />}
            {busy ? t('正在上传…') : t('上传')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
