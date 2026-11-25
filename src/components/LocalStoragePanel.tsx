import { useCallback, useEffect, useMemo, useState, type MouseEvent } from 'react';
import {
  BookOpen,
  ChevronLeft,
  ChevronRight,
  Cloud,
  CloudUpload,
  Copy,
  FileText,
  HardDrive,
  Image as ImageIcon,
  ImageOff,
  Loader2,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { useT } from '../lib/i18n';
import { useApp } from '../store/app';
import { isQiniuEnabled, readQiniuConfig } from '../lib/qiniu';
import { loadAssetUrl } from '../lib/rich/assetUrls';
import {
  ASSETS_CHANGED_EVENT,
  countAssetReferences,
  deleteLocalAsset,
  deleteLocalAssets,
  disambiguateAssetNames,
  findAssetReferences,
  forgetAssetUploaded,
  formatAssetSize,
  scanCloudOnlyAssets,
  scanLocalAssets,
  type LocalAsset,
} from '../lib/assetLibrary';
import { AssetUploadDialog, type AssetTarget } from './AssetUploadDialog';
import { ConfirmDialog } from './Confirm';
import { ImageLightbox } from './ImageLightbox';
import { Menu, type MenuEntry } from './Menu';

/** 一页放 24 个：大约是四列六行，翻页比在一个长列表里找更省事 */
const STORAGE_PAGE_SIZE = 24;

interface Props {
  /** 没配七牛云时切到「云存储设置」子页签 */
  onConfigureCloud: () => void;
}

function AssetThumb({ asset, onPreview }: { asset: LocalAsset; onPreview: (url: string) => void }) {
  const tr = useT();
  const [url, setUrl] = useState<string | null>(null);
  /** 云端链接可能已经失效，缩略图要显示看得懂的占位，而不是一片空白 */
  const [broken, setBroken] = useState(false);

  useEffect(() => {
    let alive = true;
    setBroken(false);
    if (!asset.image) {
      setUrl(null);
      return;
    }
    // 本机副本已删掉时直接用云端地址，不再尝试读本地文件
    if (asset.remoteOnly && asset.uploaded) {
      setUrl(asset.uploaded);
      return;
    }
    void loadAssetUrl(asset.abs).then((value) => {
      if (alive) setUrl(value);
    });
    return () => {
      alive = false;
    };
  }, [asset.abs, asset.image, asset.remoteOnly, asset.uploaded]);

  if (!asset.image) {
    return (
      <span className="storage-thumb file" aria-hidden>
        <FileText size={17} strokeWidth={1.7} />
      </span>
    );
  }
  if (url && broken) {
    return (
      <span
        className="storage-thumb broken"
        title={tr('图片加载失败：{url}', { url })}
        aria-label={tr('图片加载失败')}
      >
        <ImageOff size={16} strokeWidth={1.7} />
      </span>
    );
  }
  return url ? (
    <button
      type="button"
      className="storage-thumb-btn"
      onClick={() => onPreview(url)}
      title={tr('点击放大查看')}
      aria-label={tr('点击放大查看')}
    >
      <img
        className="storage-thumb"
        src={url}
        alt={asset.name}
        loading="lazy"
        onError={() => setBroken(true)}
      />
    </button>
  ) : (
    <span className="storage-thumb placeholder" aria-hidden>
      <ImageIcon size={16} strokeWidth={1.7} />
    </span>
  );
}

/**
 * 设置 → 存储 → 存储管理。
 *
 * 只盘点仓库 assets/ 里真实存在的文件，所以数字就是 Git 会跟着变重的部分。
 * 本机和已上传七牛云的都列出来，用缩略图左上角的角标标明所在位置。
 */
export function LocalStoragePanel({ onConfigureCloud }: Props) {
  const t = useT();
  const toast = useApp((s) => s.toast);
  const [assets, setAssets] = useState<LocalAsset[]>([]);
  /** 上传过、本机副本已删除的文件；记录存在同步的登记表里，换设备也能看到 */
  const [cloudAssets, setCloudAssets] = useState<LocalAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [menu, setMenu] = useState<{ x: number; y: number; asset: LocalAsset } | null>(null);
  const [target, setTarget] = useState<AssetTarget | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<{ asset: LocalAsset; refs: number } | null>(null);
  const [preview, setPreview] = useState<{ url: string; alt: string } | null>(null);
  const [confirmCleanup, setConfirmCleanup] = useState<LocalAsset[] | null>(null);
  /** 本地 / 云端两个页签，替代原来上下两段长列表 */
  const [tab, setTab] = useState<'local' | 'cloud'>('local');
  const [page, setPage] = useState(1);

  /** force = true（「重新扫描」）时强制和真实目录对一次账，平时只读登记表 */
  const load = useCallback(async (force = false) => {
    setLoading(true);
    setError('');
    try {
      const local = await scanLocalAssets(force);
      const cloud = await scanCloudOnlyAssets(local.map((a) => a.rel));
      setAssets(local);
      setCloudAssets(cloud);
      // 本机已经清空、只剩云端文件时，直接落在「云端文件」页签
      if (local.length === 0 && cloud.length > 0) setTab('cloud');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const onChange = () => void load();
    window.addEventListener(ASSETS_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(ASSETS_CHANGED_EVENT, onChange);
  }, [load]);

  const uploadedAssets = useMemo(() => assets.filter((a) => a.uploaded), [assets]);
  const totalBytes = useMemo(() => assets.reduce((sum, a) => sum + a.size, 0), [assets]);
  const uploadedBytes = useMemo(() => uploadedAssets.reduce((sum, a) => sum + a.size, 0), [uploadedAssets]);
  const imageCount = useMemo(() => assets.filter((a) => a.image).length, [assets]);
  const unusedAssets = useMemo(() => assets.filter((a) => a.refs === 0), [assets]);
  const unusedBytes = useMemo(() => unusedAssets.reduce((sum, a) => sum + a.size, 0), [unusedAssets]);

  // 早期粘贴的图片都叫 image.png，同名时补上短哈希，列表里才分得清
  const localList = useMemo(() => disambiguateAssetNames(assets), [assets]);
  const cloudList = useMemo(() => disambiguateAssetNames(cloudAssets), [cloudAssets]);
  const list = tab === 'local' ? localList : cloudList;
  const pageCount = Math.max(1, Math.ceil(list.length / STORAGE_PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const pageItems = list.slice((safePage - 1) * STORAGE_PAGE_SIZE, safePage * STORAGE_PAGE_SIZE);

  useEffect(() => {
    setPage(1);
  }, [tab]);

  const startUpload = (asset: LocalAsset) => {
    if (!readQiniuConfig()) {
      toast(t('先配置七牛云，再回来上传这个文件'), 'warn');
      onConfigureCloud();
      return;
    }
    if (!isQiniuEnabled()) {
      toast(t('云存储开关是关着的，先在设置里打开再上传'), 'warn');
      onConfigureCloud();
      return;
    }
    setTarget({ abs: asset.abs, rel: asset.rel, name: asset.name, size: asset.size, image: asset.image });
  };

  const askDelete = (asset: LocalAsset) => {
    setConfirmDelete({ asset, refs: countAssetReferences(asset.abs) });
  };

  const copyUrl = (url?: string) => {
    const value = url || '';
    if (!value) return;
    if (!navigator.clipboard) {
      toast(t('没能写入剪贴板'), 'warn');
      return;
    }
    void navigator.clipboard.writeText(value).then(
      () => toast(t('已复制云端链接'), 'success'),
      () => toast(t('没能写入剪贴板'), 'warn'),
    );
  };

  /** 只清掉本机的「上传过」记录，七牛云上的文件不会被删除 */
  const forgetCloud = async (asset: LocalAsset) => {
    await forgetAssetUploaded(asset.rel);
    window.dispatchEvent(new Event(ASSETS_CHANGED_EVENT));
    toast(t('已从列表移除；七牛云上的文件仍然保留'), 'info');
  };

  const remove = async (asset: LocalAsset) => {
    try {
      await deleteLocalAsset(asset.abs);
      toast(t('已删除本地文件'), 'success');
    } catch (err) {
      toast(t('删除失败：{msg}', { msg: err instanceof Error ? err.message : String(err) }), 'warn');
    }
  };

  const cleanUnused = async (list: LocalAsset[]) => {
    const failed = await deleteLocalAssets(list.map((a) => a.abs));
    const failedSet = new Set(failed);
    const freed = list.filter((a) => !failedSet.has(a.abs)).reduce((sum, a) => sum + a.size, 0);
    if (failed.length > 0) {
      toast(
        t('已清理 {n} 个文件，释放 {size}；{failed} 个删除失败', {
          n: list.length - failed.length,
          size: formatAssetSize(freed),
          failed: failed.length,
        }),
        'warn',
      );
    } else {
      toast(t('已清理 {n} 个未被引用的文件，释放 {size}', { n: list.length, size: formatAssetSize(freed) }), 'success');
    }
  };

  /** 跳到正文里引用它的第一篇日记；有多篇时再提示还剩几篇 */
  const jumpToNote = (asset: LocalAsset) => {
    const refs = findAssetReferences(asset.abs, asset.uploaded);
    const first = refs[0];
    if (!first) {
      toast(t('没有日记在引用这个文件'), 'warn');
      return;
    }
    const app = useApp.getState();
    app.select(first.note.id);
    app.setView({ type: 'notebook', value: first.note.notebook });
    app.setSettings(false);
    if (refs.length > 1) toast(t('还有 {n} 篇日记也引用了它', { n: refs.length - 1 }), 'info');
  };

  const openMenu = (event: MouseEvent<HTMLDivElement>, asset: LocalAsset) => {
    event.preventDefault();
    setMenu({ x: event.clientX, y: event.clientY, asset });
  };

  const current = menu?.asset;
  const currentRefs = current ? findAssetReferences(current.abs, current.uploaded) : [];
  const menuItems: (MenuEntry | 'sep')[] = current
    ? [
        {
          label: currentRefs.length
            ? t('打开引用的日记（{n}）', { n: currentRefs.length })
            : t('没有日记引用它'),
          icon: <BookOpen size={14} />,
          disabled: currentRefs.length === 0,
          onClick: () => jumpToNote(current),
        },
        'sep',
        ...(current.remoteOnly
          ? []
          : ([
              {
                label: current.uploaded ? t('重新上传到七牛云') : t('上传到七牛云'),
                icon: <CloudUpload size={14} />,
                onClick: () => startUpload(current),
              },
            ] as MenuEntry[])),
        ...(current.uploaded
          ? ([
              {
                label: t('复制云端链接'),
                icon: <Cloud size={14} />,
                onClick: () => copyUrl(current.uploaded),
              },
            ] as MenuEntry[])
          : []),
        // 从日记里扫出来的云端链接没有本机记录，「从列表移除」对它没有意义
        ...(current.derived
          ? []
          : ([
              'sep',
              current.remoteOnly
                ? {
                    label: t('从列表移除（云端文件保留）'),
                    icon: <Trash2 size={14} />,
                    onClick: () => void forgetCloud(current),
                  }
                : {
                    label: current.uploaded ? t('删除本机文件') : current.image ? t('删除图片') : t('删除文件'),
                    icon: <Trash2 size={14} />,
                    danger: true,
                    onClick: () => askDelete(current),
                  },
            ] as (MenuEntry | 'sep')[])),
      ]
    : [];

  const empty = !loading && !error && assets.length === 0 && cloudAssets.length === 0;

  const deleteDesc = (() => {
    if (!confirmDelete) return '';
    const { asset, refs } = confirmDelete;
    if (asset.uploaded && refs > 0) {
      return t(
        '「{name}」会从本机删除，删除后不可恢复。七牛云上的副本仍然保留；还有 {n} 处内容仍指向本地文件，删除后这些图片会失效。',
        { name: asset.name, n: refs },
      );
    }
    if (asset.uploaded) {
      return t('「{name}」会从本机删除，删除后不可恢复。七牛云上的副本仍然保留，笔记里的云链接不受影响。', {
        name: asset.name,
      });
    }
    if (refs > 0) {
      return t('「{name}」会从仓库删除，删除后不可恢复。还有 {n} 处笔记在引用它，删除后这些图片会失效。', {
        name: asset.name,
        n: refs,
      });
    }
    return t('「{name}」会从仓库删除，删除后不可恢复。', { name: asset.name });
  })();

  return (
    <div className="storage-panel">
      <div className="storage-overview">
        <div className="storage-overview-main">
          <div className="storage-kicker">{t('本机占用')}</div>
          <div className="storage-total">{formatAssetSize(totalBytes)}</div>
          <div className="storage-sub">
            {t('{n} 个文件', { n: assets.length })}
            {assets.length > 0 && (
              <>
                <span className="storage-dot">·</span>
                {t('图片 {n}', { n: imageCount })}
                <span className="storage-dot">·</span>
                {t('附件 {n}', { n: assets.length - imageCount })}
              </>
            )}
          </div>
          {uploadedAssets.length > 0 && (
            <div className="storage-uploaded-hint">
              {t('其中 {n} 个已上传七牛云，本机副本仍占 {size}；没有引用的可以直接清理', {
                n: uploadedAssets.length,
                size: formatAssetSize(uploadedBytes),
              })}
            </div>
          )}
          {cloudAssets.length > 0 && (
            <div className="storage-uploaded-hint">
              {t('另有 {n} 个已上传七牛云，本机副本已删除', { n: cloudAssets.length })}
            </div>
          )}
          {unusedAssets.length > 0 && (
            <div className="storage-unused-hint">
              {t('其中 {n} 个没有被任何日记引用（{size}），可以清理', {
                n: unusedAssets.length,
                size: formatAssetSize(unusedBytes),
              })}
            </div>
          )}
        </div>
        <div className="storage-overview-actions">
          {unusedAssets.length > 0 && (
            <button
              className="btn btn-secondary storage-clean-btn"
              onClick={() => setConfirmCleanup(unusedAssets)}
              title={t('清理未被引用的文件（{n} 个）', { n: unusedAssets.length })}
              aria-label={t('清理未被引用的文件')}
            >
              <Trash2 size={13} />
              {t('清理')}
            </button>
          )}
          <button className="icon-btn" onClick={() => void load(true)} title={t('重新扫描')} aria-label={t('重新扫描')}>
            {loading ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />}
          </button>
        </div>
      </div>

      {error && <div className="qiniu-msg bad">{t('读取资源失败：{msg}', { msg: error })}</div>}

      {loading && assets.length === 0 ? (
        <div className="storage-loading">
          <Loader2 size={15} className="spin" /> {t('正在扫描仓库里的资源…')}
        </div>
      ) : empty ? (
        <div className="storage-empty">
          <span className="storage-empty-icon" aria-hidden>
            <Cloud size={22} strokeWidth={1.6} />
          </span>
          <div className="storage-empty-title">{t('仓库里还没有图片或附件')}</div>
          <div className="storage-empty-desc">
            {t('插入图片、粘贴截图或添加附件时，默认保存在这里的 assets/ 目录，会跟着 Git 一起提交。')}
          </div>
        </div>
      ) : (
        <>
          <div className="storage-tabs" role="tablist" aria-label={t('存储文件分类')}>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'local'}
              className={tab === 'local' ? 'storage-tab on' : 'storage-tab'}
              onClick={() => setTab('local')}
            >
              <HardDrive size={14} />
              {t('本地文件')}
              <span className="storage-tab-count">{assets.length}</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'cloud'}
              className={tab === 'cloud' ? 'storage-tab on' : 'storage-tab'}
              onClick={() => setTab('cloud')}
            >
              <Cloud size={14} />
              {t('云端文件')}
              <span className="storage-tab-count">{cloudAssets.length}</span>
            </button>
          </div>

          <div className="storage-section-desc storage-tab-desc">
            {tab === 'local'
              ? t('保存在仓库 assets/ 目录，会跟着 Git 一起提交。上传到七牛云后本机文件会自动删除，并移到「云端文件」。')
              : t('只存在七牛云上的文件，笔记里的云端链接仍然可用。列表来自本机的上传记录和正文里的链接，换设备后看到的可能不同。')}
          </div>

          {list.length === 0 ? (
            <div className="storage-empty">
              <span className="storage-empty-icon" aria-hidden>
                {tab === 'local' ? <HardDrive size={22} strokeWidth={1.6} /> : <Cloud size={22} strokeWidth={1.6} />}
              </span>
              <div className="storage-empty-title">
                {tab === 'local' ? t('assets/ 里还没有文件') : t('还没有云端文件')}
              </div>
              <div className="storage-empty-desc">
                {tab === 'local'
                  ? t('插入图片、粘贴截图或添加附件后会出现在这里。')
                  : t('上传本地文件后，本机副本会删除，文件出现在这里。')}
              </div>
            </div>
          ) : (
            <>
              <div className="storage-grid" role="list">
                {pageItems.map((asset) => (
                  <div
                    key={asset.rel}
                    className="storage-card"
                    role="listitem"
                    onContextMenu={(event) => openMenu(event, asset)}
                    title={
                      tab === 'local'
                        ? asset.refs === 0
                          ? t('本机没有笔记引用它，右键可以清理')
                          : t('右键打开引用的日记、上传或删除')
                        : t('右键查看引用的日记、复制云端链接或从列表移除')
                    }
                  >
                    <div className="storage-card-thumb">
                      <AssetThumb asset={asset} onPreview={(url) => setPreview({ url, alt: asset.name })} />
                      <span
                        className={tab === 'local' && !asset.uploaded ? 'storage-origin local' : 'storage-origin cloud'}
                        title={
                          tab === 'cloud'
                            ? t('只存在七牛云上，本机没有副本')
                            : asset.uploaded
                              ? t('已上传到七牛云')
                              : t('仅保存在本机')
                        }
                      >
                        {tab === 'cloud' ? t('云端') : asset.uploaded ? t('七牛云') : t('本机')}
                      </span>
                      {asset.refs === 0 && (
                        <span
                          className="storage-flag warn"
                          title={
                            tab === 'local'
                              ? t('正文里已经没有指向这个本地文件的链接')
                              : t('现在没有日记引用这个云端链接')
                          }
                        >
                          {t('未引用')}
                        </span>
                      )}
                      {tab === 'local' ? (
                        <button
                          className="storage-op"
                          onClick={() => startUpload(asset)}
                          title={asset.uploaded ? t('重新上传到七牛云') : t('上传到七牛云')}
                          aria-label={asset.uploaded ? t('重新上传到七牛云') : t('上传到七牛云')}
                        >
                          <CloudUpload size={14} />
                        </button>
                      ) : (
                        <button
                          className="storage-op"
                          onClick={() => copyUrl(asset.uploaded)}
                          title={t('复制云端链接')}
                          aria-label={t('复制云端链接')}
                        >
                          <Copy size={14} />
                        </button>
                      )}
                    </div>
                    <div className="storage-card-body">
                      <div className="storage-card-name" title={asset.name}>
                        {asset.name}
                      </div>
                      <div className="storage-card-meta">
                        <span>{tab === 'cloud' && asset.size === 0 ? '—' : formatAssetSize(asset.size)}</span>
                        <span className="storage-card-ext">
                          {asset.image ? t('图片') : (asset.ext || t('附件')).toUpperCase()}
                        </span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              <div className="storage-pager">
                <span className="storage-pager-info">
                  {pageCount > 1
                    ? t('第 {from}–{to} 个，共 {n} 个', {
                        from: (safePage - 1) * STORAGE_PAGE_SIZE + 1,
                        to: Math.min(safePage * STORAGE_PAGE_SIZE, list.length),
                        n: list.length,
                      })
                    : t('共 {n} 个文件', { n: list.length })}
                </span>
                {pageCount > 1 && (
                  <div className="storage-pager-nav">
                    <button
                      type="button"
                      className="icon-btn storage-page-btn"
                      disabled={safePage <= 1}
                      onClick={() => setPage(safePage - 1)}
                      title={t('上一页')}
                      aria-label={t('上一页')}
                    >
                      <ChevronLeft size={15} />
                    </button>
                    <span className="storage-page-num">
                      {safePage} / {pageCount}
                    </span>
                    <button
                      type="button"
                      className="icon-btn storage-page-btn"
                      disabled={safePage >= pageCount}
                      onClick={() => setPage(safePage + 1)}
                      title={t('下一页')}
                      aria-label={t('下一页')}
                    >
                      <ChevronRight size={15} />
                    </button>
                  </div>
                )}
              </div>
            </>
          )}

          <div className="hint storage-foot-hint">
            {tab === 'local'
              ? t('左上角的角标表示文件保存在本机还是已上传七牛云；点缩略图可以放大查看，右键可以跳到引用它的日记、上传或删除。上传成功后本机文件会自动删除，并移到「云端文件」。')
              : t('左上角的角标表示文件只存在七牛云上；点缩略图可以放大查看，右键可以跳到引用它的日记、复制云端链接或从列表移除。从列表移除不会删除七牛云上的文件。')}
          </div>
        </>
      )}

      {menu && <Menu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />}

      {target && <AssetUploadDialog target={target} onClose={() => setTarget(null)} />}

      {preview && <ImageLightbox url={preview.url} alt={preview.alt} onClose={() => setPreview(null)} />}

      {confirmCleanup && (
        <ConfirmDialog
          title={t('清理 {n} 个未被引用的文件？', { n: confirmCleanup.length })}
          desc={t(
            '这些文件在本机和回收站里都找不到引用，删除后不可恢复，共释放 {size}。已上传七牛云的文件会保留云端副本。',
            { size: formatAssetSize(confirmCleanup.reduce((sum, a) => sum + a.size, 0)) },
          )}
          confirmLabel={t('清理')}
          danger
          onCancel={() => setConfirmCleanup(null)}
          onConfirm={() => {
            const targets = confirmCleanup;
            setConfirmCleanup(null);
            void cleanUnused(targets);
          }}
        />
      )}

      {confirmDelete && (
        <ConfirmDialog
          title={
            confirmDelete.asset.uploaded
              ? t('删除本机文件？')
              : confirmDelete.asset.image
                ? t('删除这张图片？')
                : t('删除这个文件？')
          }
          desc={deleteDesc}
          confirmLabel={t('删除')}
          danger
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => {
            const asset = confirmDelete.asset;
            setConfirmDelete(null);
            void remove(asset);
          }}
        />
      )}
    </div>
  );
}
