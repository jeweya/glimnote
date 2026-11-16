import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../lib/i18n';
import { ArrowRight, Cloud, Gift, RefreshCw, ShieldCheck, X } from 'lucide-react';
import { useApp } from '../store/app';

const DISMISS_KEY = 'glimnote.syncPrompt.off';

/**
 * 首次打开、且没有配置云端仓库时的引导弹窗。
 * 只在启动后弹一次；勾了「不再提示」就永久记住。
 * 不拦截任何本地功能——关掉照样能写。
 */
export function SyncInvite() {
  const ready = useApp((s) => s.ready);
  const cfg = useApp((s) => s.cfg);
  const settingsOpen = useApp((s) => s.settingsOpen);
  const paletteOpen = useApp((s) => s.paletteOpen);
  const moveNoteId = useApp((s) => s.moveNoteId);
  const setSettings = useApp((s) => s.setSettings);
  const tr = useT();

  const [open, setOpen] = useState(false);
  const [never, setNever] = useState(() => localStorage.getItem(DISMISS_KEY) === '1');
  const fired = useRef(false);

  // 启动后稍等一下再弹，先让用户看到笔记，不要一开门就挡脸
  useEffect(() => {
    if (fired.current || !ready || cfg) return;
    if (localStorage.getItem(DISMISS_KEY) === '1') return;
    fired.current = true;
    const timer = window.setTimeout(() => {
      const s = useApp.getState();
      if (!s.cfg && !s.settingsOpen && !s.paletteOpen) setOpen(true);
    }, 1800);
    return () => window.clearTimeout(timer);
  }, [ready, cfg]);

  // 设置或命令面板打开时让位，不要两层弹窗叠在一起
  useEffect(() => {
    if (open && (settingsOpen || paletteOpen || moveNoteId)) setOpen(false);
  }, [open, settingsOpen, paletteOpen, moveNoteId]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open]);

  const remember = (value: boolean) => {
    setNever(value);
    if (value) localStorage.setItem(DISMISS_KEY, '1');
    else localStorage.removeItem(DISMISS_KEY);
  };

  if (!open) return null;

  const close = () => setOpen(false);
  const goSetup = () => {
    close();
    setSettings(true, 'sync');
  };

  return createPortal(
    <div className="overlay overlay-invite" onClick={close}>
      <div
        className="modal sync-invite"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sync-invite-title"
        onClick={(e) => e.stopPropagation()}
      >
        <button className="icon-btn invite-close" onClick={close} title={tr('关闭')}>
          <X size={16} />
        </button>

        <div className="invite-hero">
          <span className="invite-mark">
            <Cloud size={22} strokeWidth={1.75} />
          </span>
          <div className="invite-title" id="sync-invite-title">
            {tr('免费把笔记同步到云端？')}
          </div>
          <p className="invite-lead">
            {tr('笔记现在只保存在这台电脑上。连一个免费的私有仓库，换电脑、重装系统都不用担心丢失。')}
          </p>
        </div>

        <ul className="invite-list">
          <li>
            <span className="invite-ico">
              <Gift size={16} strokeWidth={1.75} />
            </span>
            <div>
              <div className="invite-item-title">{tr('GitCode、Gitee 私有仓库免费')}</div>
              <div className="invite-item-desc">{tr('手机号就能注册，国内直连，不用买服务器也不用折腾网络。')}</div>
            </div>
          </li>
          <li>
            <span className="invite-ico">
              <ShieldCheck size={16} strokeWidth={1.75} />
            </span>
            <div>
              <div className="invite-item-title">{tr('只有你自己能看')}</div>
              <div className="invite-item-desc">
                {tr('笔记直接写进你的私有仓库；如果仓库是公开的，连接前会先提醒你改为私有。')}
              </div>
            </div>
          </li>
          <li>
            <span className="invite-ico">
              <RefreshCw size={16} strokeWidth={1.75} />
            </span>
            <div>
              <div className="invite-item-title">{tr('改完几秒自动同步')}</div>
              <div className="invite-item-desc">{tr('公司电脑、家里电脑接着写同一份笔记，本地照旧离线可用。')}</div>
            </div>
          </li>
        </ul>

        <div className="modal-foot invite-foot">
          <label className="invite-never">
            <input type="checkbox" checked={never} onChange={(e) => remember(e.target.checked)} />
            <span>{tr('以后不再提示')}</span>
          </label>
          <div className="invite-actions">
            <button className="btn btn-ghost" onClick={close}>
              {tr('稍后再说')}
            </button>
            <button className="btn btn-primary" onClick={goSetup}>
              {tr('去开启同步')}
              <ArrowRight size={14} strokeWidth={2} />
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
