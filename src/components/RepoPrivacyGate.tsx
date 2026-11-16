import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ExternalLink, Loader2, ShieldAlert } from 'lucide-react';
import { useApp } from '../store/app';
import { getRepo, manualPrivateHint, repoSettingsUrl, setRepoPrivate } from '../lib/git';
import { log } from '../lib/log';
import { useT } from '../lib/i18n';

/** 同一会话里两次检查之间至少隔 10 分钟，避免连点同步把 API 打满 */
const CHECK_COOLDOWN = 10 * 60 * 1000;

/**
 * 公开仓库提醒。
 *
 * 云端推送会把 Webhook 和待办摘要写进仓库，所以仓库应当是私有的。
 * 这里只做提醒，不强制、不挡同步：用户点「取消」后所有数据照常同步，
 * 下次启动或下次手动同步时再查一次。自动同步不触发检查。
 */
export function RepoPrivacyGate() {
  const cfg = useApp((s) => s.cfg);
  const token = useApp((s) => s.token);
  const toast = useApp((s) => s.toast);
  const tr = useT();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const lastCheck = useRef(0);
  const checking = useRef(false);

  const provider = cfg?.provider;
  const owner = cfg?.owner;
  const repoName = cfg?.repo;

  useEffect(() => {
    if (!cfg || !token || !provider || !owner || !repoName) return;
    let alive = true;

    const check = async () => {
      if (checking.current) return;
      if (Date.now() - lastCheck.current < CHECK_COOLDOWN) return;
      checking.current = true;
      lastCheck.current = Date.now();
      try {
        const info = await getRepo(provider, token, owner, repoName);
        if (alive && info.private === false) {
          setError('');
          setOpen(true);
        }
      } catch (e) {
        // 网络不好或令牌权限不足时静默跳过：这只是个提醒，不能影响正常同步
        log('sync', 'warn', `仓库可见性检查失败：${(e as Error).message || '未知原因'}`);
      } finally {
        checking.current = false;
      }
    };

    // 启动时查一次；手动同步会发同一个事件
    const timer = window.setTimeout(() => void check(), 2500);
    const onCheck = () => void check();
    window.addEventListener('glimnote:check-repo-privacy', onCheck);
    return () => {
      alive = false;
      window.clearTimeout(timer);
      window.removeEventListener('glimnote:check-repo-privacy', onCheck);
    };
  }, [cfg, token, provider, owner, repoName]);

  const cancel = () => {
    setOpen(false);
    setError('');
  };

  const makePrivate = async () => {
    if (!cfg || !token || !provider || !owner || !repoName || busy) return;
    setBusy(true);
    setError('');
    try {
      await setRepoPrivate(provider, token, owner, repoName);
      // 有的平台返回 2xx 但实际没改：再看一次，不把「成功」说早
      const info = await getRepo(provider, token, owner, repoName).catch(() => null);
      if (info && info.private === false) {
        setError(tr('平台返回成功，但仓库现在还是公开的。请到仓库设置里手动改为私有。'));
        return;
      }
      setOpen(false);
      toast(tr('仓库已改为私有'), 'success');
    } catch (e) {
      setError((e as Error).message || tr('修改失败，请稍后再试或手动修改'));
    } finally {
      setBusy(false);
    }
  };

  if (!open || !cfg) return null;

  return createPortal(
    <div className="overlay overlay-confirm">
      <div className="modal" role="alertdialog" aria-modal="true" style={{ width: 460 }}>
        <div className="modal-head">
          <div>
            <div className="modal-title" style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              <ShieldAlert size={16} style={{ color: 'var(--warning)' }} />
              {tr('建议把仓库改为私有')}
            </div>
            <div className="modal-desc">
              {tr('当前仓库 {owner}/{repo} 是公开的。云端推送会把群机器人 Webhook 和待办摘要写进仓库，任何人都能看到；笔记和待办本身也会一并暴露。', {
                owner: cfg.owner,
                repo: cfg.repo,
              })}
            </div>
          </div>
        </div>

        <div className="modal-desc" style={{ padding: '0 22px' }}>
          {tr('这只是提醒，不会阻止同步。点「取消」后所有数据仍会照常同步，下次启动应用或手动同步时会再提醒一次。')}
        </div>

        {error && (
          <div className="notify-status bad" style={{ padding: '8px 22px 0', alignItems: 'flex-start' }}>
            <ShieldAlert size={14} style={{ flex: 'none', marginTop: 1 }} />
            <span>
              {error}
              <br />
              {manualPrivateHint(cfg.provider, cfg.owner, cfg.repo)}{' '}
              <a className="ext-link" href={repoSettingsUrl(cfg.provider, cfg.owner, cfg.repo)} target="_blank" rel="noreferrer">
                {tr('打开仓库设置')} <ExternalLink size={11} />
              </a>
            </span>
          </div>
        )}

        <div className="modal-foot">
          <button className="btn btn-ghost" onClick={cancel} disabled={busy}>
            {tr('取消')}
          </button>
          <button className="btn btn-primary" onClick={() => void makePrivate()} disabled={busy}>
            {busy ? <Loader2 size={14} className="spin" /> : null}
            {tr('自动改为私有')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
