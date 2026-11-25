import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Cloud, CloudUpload, GitBranch, Settings2, X } from 'lucide-react';
import { useApp } from '../store/app';
import { useT } from '../lib/i18n';
import {
  QINIU_SNOOZE_DAYS,
  onQiniuPrompt,
  requestQiniuSectionJump,
  snoozeQiniuPrompt,
} from '../lib/qiniu';

/**
 * 没配置七牛云时，第一次插入图片后弹一次说明。
 *
 * 不是拦截：图片已经存进仓库了，这里只是告诉用户还有更省仓库的做法；
 * 勾上「近期不提醒」就安静 7 天，不勾也只在本次运行里出现一次。
 */
export function QiniuPrompt() {
  const tr = useT();
  const setSettings = useApp((s) => s.setSettings);
  const [open, setOpen] = useState(false);
  const [snooze, setSnooze] = useState(false);

  useEffect(
    () =>
      onQiniuPrompt(() => {
        setSnooze(false);
        setOpen(true);
      }),
    [],
  );

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        setOpen(false);
      }
    };
    // 捕获阶段拦下 Esc，别让底下的编辑器 / 弹窗跟着响应
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open]);

  if (!open) return null;

  const remember = () => {
    if (snooze) snoozeQiniuPrompt(QINIU_SNOOZE_DAYS);
  };

  const keepLocal = () => {
    remember();
    setOpen(false);
  };

  const goSettings = () => {
    remember();
    setOpen(false);
    setSettings(true, 'storage');
    // 设置弹窗比这一下点击晚挂载，用标记 + 事件双保险，确保滚到七牛云那一节
    requestQiniuSectionJump();
  };

  return createPortal(
    <div className="overlay qiniu-overlay">
      <div className="modal qiniu-modal" role="dialog" aria-modal="true" aria-labelledby="qiniu-prompt-title">
        <button className="qiniu-close" onClick={keepLocal} aria-label={tr('关闭提示')} title={tr('关闭提示')}>
          <X size={15} />
        </button>

        <div className="qiniu-hero">
          <span className="qiniu-icon" aria-hidden>
            <CloudUpload size={22} strokeWidth={1.8} />
          </span>
          <div>
            <div className="modal-title" id="qiniu-prompt-title">
              {tr('图片也可以存到云端')}
            </div>
            <div className="modal-desc">
              {tr('这张图片已经存进 Git 仓库。Gitee 免费仓库单文件上限 50MB、总容量也有限，图片一多，仓库和每次同步都会越来越重。配置七牛云后，之后插入的图片和附件直接上传到云端，仓库里只保留链接。')}
            </div>
          </div>
        </div>

        <div className="qiniu-compare">
          <div className="qiniu-point">
            <span className="qiniu-point-icon now" aria-hidden>
              <GitBranch size={15} />
            </span>
            <div>
              <strong>{tr('当前状态')}</strong>
              <span>{tr('图片跟着笔记一起提交，仓库会变重，还可能顶到 Gitee 单文件 50MB 的上限。')}</span>
            </div>
          </div>
          <div className="qiniu-point">
            <span className="qiniu-point-icon cloud" aria-hidden>
              <Cloud size={15} />
            </span>
            <div>
              <strong>{tr('配好七牛云')}</strong>
              <span>{tr('实名后有每月有免费存储，个人日常基本够用；一次填写，之后自动上传，断网或失败会存回仓库。')}</span>
            </div>
          </div>
        </div>

        <label className="qiniu-check">
          <input type="checkbox" checked={snooze} onChange={(e) => setSnooze(e.target.checked)} />
          <span>{tr('7 天内不再提醒')}</span>
        </label>

        <div className="modal-foot qiniu-foot">
          <span className="qiniu-safe">{tr('密钥只存在本机，不会写进仓库')}</span>
          <span className="grow" />
          <button className="btn btn-ghost" onClick={keepLocal}>
            {tr('继续使用 Git')}
          </button>
          <button className="btn btn-primary" onClick={goSettings}>
            <Settings2 size={14} /> {tr('去配置')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
