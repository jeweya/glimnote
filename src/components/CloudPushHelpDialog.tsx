import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { HelpCircle, Loader2, RefreshCw } from 'lucide-react';
import { useT } from '../lib/i18n';
import type { CloudPushConfig } from '../lib/cloudPush';

interface Props {
  cfg: CloudPushConfig;
  busy: boolean;
  onRefresh: () => void;
  /** 跳到设置 → 通知 → 云端推送 */
  onEdit: () => void;
  onClose: () => void;
}

/**
 * 待办详情「云端推送」右侧问号打开的说明。
 * 除了讲清可靠性边界，底部还留一个「刷新配置」：
 * 平台把定时任务丢了的时候，让工作流文件内容变一次就能重新登记。
 */
export function CloudPushHelpDialog({ cfg, busy, onRefresh, onEdit, onClose }: Props) {
  const tr = useT();

  useEffect(() => {
    // 和 ConfirmDialog 一样用捕获阶段，避免 Esc 同时关掉下层弹窗
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return createPortal(
    <div className="overlay overlay-confirm" onClick={onClose}>
      <div
        className="modal cloud-help-modal"
        role="dialog"
        aria-modal="true"
        aria-label={tr('云端推送说明')}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <div>
            <div className="modal-title" style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              <HelpCircle size={16} style={{ color: 'var(--accent)' }} />
              {tr('云端推送说明')}
            </div>
            <div className="modal-desc cloud-help-body">
              <p>
                {tr(
                  '云端推送不完全可靠。它借用的是 Git 平台的免费定时任务：触发时间可能晚几分钟到几十分钟；仓库长期没有活动时，平台可能悄悄暂停定时任务；摘要也只到上一次成功同步为止。请不要过度依赖，重要任务仍以本机到点提醒为准。',
                )}
              </p>
              <p>
                {tr(
                  '如果开启后一直没收到消息，可能是平台的定时任务被暂停或注册丢失。点下方「刷新配置」，应用会重新提交一次工作流，让平台重新登记；之后请关注下一次推送时间的消息。',
                )}
              </p>
              <p>{tr('刷新只会更新仓库里的工作流，不会改动待办、推送时间或 Webhook。')}</p>
              <p className="cloud-help-meta">
                {cfg.enabled
                  ? tr('当前配置：每天 {time}（北京时间）推送 {hours} 小时内待办', {
                      time: cfg.time,
                      hours: cfg.windowHours,
                    })
                  : tr('云端推送总开关当前是关闭的，先到「设置 → 通知」开启。')}
                <button type="button" className="cloud-help-edit" onClick={onEdit}>
                  {tr('修改配置')}
                </button>
              </p>
            </div>
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn btn-ghost" onClick={onClose}>
            {tr('关闭')}
          </button>
          <button
            className="btn btn-primary"
            onClick={onRefresh}
            disabled={busy || !cfg.enabled}
            title={cfg.enabled ? tr('让平台重新登记定时任务') : tr('云端推送还没开启')}
          >
            {busy ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
            {tr('刷新配置')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
