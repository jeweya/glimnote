import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { FolderOpen, Loader2, Plus, RefreshCw, X } from 'lucide-react';
import { desktop, type WorkspaceInfo } from '../lib/desktop';
import { useT } from '../lib/i18n';

interface Props {
  open: boolean;
  items: WorkspaceInfo[];
  /** 当前正在使用的工作区 id */
  currentId: string;
  busy?: boolean;
  onClose: () => void;
  onSwitch: (id: string) => Promise<{ ok: boolean; error?: string }>;
  onCreate: (name: string, root?: string) => Promise<{ ok: boolean; error?: string }>;
  onOpenFolder: (id: string) => void;
  /** 新建 / 切换后刷新列表 */
  onRefresh: () => void;
}

/**
 * 工作区管理。
 *
 * 一个工作区就是一套完全独立的本地数据：笔记目录、云端仓库、令牌、日志、
 * 界面设置都不与其它工作区串用。同一台电脑多人使用时，每人建一个即可；
 * 想同时维护两份互不相干的笔记（比如工作 / 私人）也用它。
 */
export function WorkspaceDialog({
  open,
  items,
  currentId,
  busy = false,
  onClose,
  onSwitch,
  onCreate,
  onOpenFolder,
  onRefresh,
}: Props) {
  const tr = useT();
  const [name, setName] = useState('');
  const [root, setRoot] = useState('');
  const [working, setWorking] = useState<'' | 'create' | 'switch'>('');
  const [error, setError] = useState('');
  const [confirm, setConfirm] = useState<WorkspaceInfo | null>(null);

  useEffect(() => {
    if (!open) {
      setName('');
      setRoot('');
      setError('');
      setConfirm(null);
      setWorking('');
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || working || busy) return;
      e.stopPropagation();
      e.preventDefault();
      if (confirm) setConfirm(null);
      else onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, working, busy, confirm, onClose]);

  if (!open) return null;

  const pickRoot = async () => {
    const bridge = desktop();
    if (!bridge?.workspacePickRoot) return;
    try {
      const res = await bridge.workspacePickRoot();
      if (!res.canceled && res.path) setRoot(res.path);
    } catch (e) {
      setError(String((e as Error)?.message || e));
    }
  };

  const doCreate = async () => {
    const clean = name.trim();
    if (!clean) {
      setError(tr('先给工作区起个名字，比如「工作」或「家人」'));
      return;
    }
    setWorking('create');
    setError('');
    const res = await onCreate(clean, root.trim() || undefined);
    setWorking('');
    if (!res.ok) {
      setError(res.error || tr('创建失败'));
      return;
    }
    onRefresh();
  };

  const doSwitch = async (item: WorkspaceInfo) => {
    setConfirm(null);
    setWorking('switch');
    setError('');
    const res = await onSwitch(item.id);
    setWorking('');
    if (!res.ok) setError(res.error || tr('切换失败'));
  };

  return createPortal(
    <div className="overlay overlay-confirm">
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        style={{ width: 560 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <div>
            <div className="modal-title">{confirm ? tr('切换工作区？') : tr('工作区')}</div>
            <div className="modal-desc">
              {confirm
                ? tr('即将切换到「{name}」。应用会重新载入一遍，编辑中的内容会先保存；当前工作区的笔记不会被删除，之后还可以切回来。', { name: confirm.name })
                : tr('每个工作区都有独立的笔记文件夹、云端仓库、令牌、日志和界面设置。同一台电脑多人使用，或想分开工作和私人笔记时，各用一个工作区。')}
            </div>
          </div>
          <button className="icon-btn" onClick={onClose} disabled={Boolean(working)} title={tr('关闭')}>
            <X size={16} />
          </button>
        </div>

        {confirm ? (
          <>
            <div className="modal-foot" style={{ marginTop: 8 }}>
              <button className="btn btn-ghost" onClick={() => setConfirm(null)} disabled={Boolean(working)}>
                {tr('取消')}
              </button>
              <button className="btn btn-primary" onClick={() => void doSwitch(confirm)} disabled={Boolean(working)}>
                {working === 'switch' ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
                {working === 'switch' ? tr('正在切换…') : tr('切换')}
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="modal-body ws-body">
              <div className="set-section-title">{tr('已有工作区')}</div>
              <div className="ws-list">
                {items.map((it) => {
                  const current = it.id === currentId;
                  return (
                    <div key={it.id} className="ws-item">
                      <div className="ws-main">
                        <div className="ws-name">
                          <span className="ws-title" title={it.name}>
                            {it.name}
                          </span>
                          {it.repo ? (
                            <span className="tag" title={tr('平台 · 账号/仓库（三者都相同才是同一份笔记）')}>
                              {it.repo.provider} · {it.repo.owner}/{it.repo.repo}
                            </span>
                          ) : (
                            <span className="tag">{tr('未关联仓库')}</span>
                          )}
                          {current && <span className="tag tag-accent">{tr('当前')}</span>}
                        </div>
                        <div className="ws-path" title={it.root}>
                          {it.root}
                        </div>
                      </div>
                      <div className="set-actions">
                        <button className="btn btn-ghost" onClick={() => onOpenFolder(it.id)} title={tr('在资源管理器中打开')}>
                          <FolderOpen size={14} /> {tr('打开')}
                        </button>
                        <button
                          className="btn btn-secondary"
                          onClick={() => setConfirm(it)}
                          disabled={Boolean(working) || current}
                          title={current ? tr('当前正在使用') : tr('切换到这个工作区')}
                        >
                          {current ? tr('使用中') : tr('切换')}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="set-section-title">{tr('新建工作区')}</div>
              <div className="ws-create">
                <div className="set-label">{tr('名称')}</div>
                <input
                  className="input"
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    setError('');
                  }}
                  placeholder={tr('例如：工作笔记 / 家人的笔记')}
                  maxLength={40}
                  style={{ marginTop: 6 }}
                />
                <div className="set-desc" style={{ marginTop: 8 }}>
                  {tr('存放位置：{path}', { path: root || tr('文档 / glimnote-workspaces / 按名称自动创建') })}
                </div>
                <div className="ws-create-actions">
                  <button className="btn btn-ghost" onClick={() => void pickRoot()} disabled={Boolean(working)}>
                    <FolderOpen size={14} /> {tr('选择文件夹…')}
                  </button>
                  <button
                    className="btn btn-primary"
                    onClick={() => void doCreate()}
                    disabled={Boolean(working) || !name.trim()}
                  >
                    {working === 'create' ? <Loader2 size={14} className="spin" /> : <Plus size={14} />}
                    {working === 'create' ? tr('正在创建…') : tr('创建并切换')}
                  </button>
                </div>
                {error && (
                  <div className="set-desc ws-error" role="alert">
                    {error}
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
