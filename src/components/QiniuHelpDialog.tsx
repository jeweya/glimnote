import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Copy, HardDrive, Sparkles, X } from 'lucide-react';
import { useT } from '../lib/i18n';
import { useApp } from '../store/app';

/** 给豆包 / DeepSeek / Kimi 的现成提示词：照着填写，不需要用户自己组织语言 */
const PROMPT = `我在用「萤光笔记」，想配置七牛云来存图片，但我完全没接触过对象存储。请一步一步教我，尽量简单：
1. 注册七牛云并完成实名认证；
2. 创建存储空间：空间名建议 glimnote，访问控制选公开，区域怎么选；
3. 在「密钥管理」里找到 AccessKey 和 SecretKey；
4. 绑定访问域名：先用测试域名可以吗？30 天后怎么办？正式域名怎么备案、怎么开 HTTPS？
5. 最后把空间名、AK、SK、访问域名填到「设置 → 存储管理 → 云存储设置」；域名只填主机名（例如 img.myname.com），没有证书时协议选 http。
每一步请告诉我点哪个菜单、填什么内容；遇到 CNAME、备案、证书这些词，请用大白话解释。我的电脑是 Windows。`;

interface Props {
  /** 已经配置成功时就不必再劝回本地存储了 */
  configured: boolean;
  onClose: () => void;
}

/** 「太复杂不会配置？」：介绍退回 Git 本地存储，或把配置交给 AI 带做 */
export function QiniuHelpDialog({ configured, onClose }: Props) {
  const tr = useT();
  const toast = useApp((s) => s.toast);
  const [copied, setCopied] = useState(false);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    // 用捕获阶段拦下 Esc，避免同时把下层的设置弹窗关掉
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
  }, [onClose]);

  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(PROMPT);
      setCopied(true);
      if (timerRef.current) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // 浏览器不给写剪贴板时，退回「选中自己按 Ctrl+C」
      promptRef.current?.focus();
      promptRef.current?.select();
      toast(tr('没能写入剪贴板，请按 Ctrl+C 复制'), 'error');
    }
  };

  return createPortal(
    <div className="overlay overlay-confirm">
      <div className="modal qiniu-help-modal" role="dialog" aria-modal="true" aria-label={tr('七牛云配置帮助')}>
        <div className="modal-head">
          <div>
            <div className="modal-title">{tr('不会配置？两种更省事的办法')}</div>
            <div className="modal-desc">
              {tr('不用在这里硬填。可以先继续用本地存储，或者把配置交给 AI，一步一步带着你做。')}
            </div>
          </div>
          <button className="icon-btn" onClick={onClose} title={tr('关闭')} aria-label={tr('关闭')}>
            <X size={16} />
          </button>
        </div>

        <div className="modal-body qiniu-help-body">
          {!configured && (
            <section className="qiniu-help-card">
              <div className="qiniu-help-card-head">
                <HardDrive size={15} />
                <strong>{tr('办法一：就用 Git 本地存储')}</strong>
              </div>
              <p>
                {tr(
                  '图片和附件直接存进笔记仓库，跟着同步和备份，不需要域名和密钥。缺点是仓库会变大，可以在「存储管理」里清理没有被笔记引用的文件。',
                )}
              </p>
            </section>
          )}

          <section className="qiniu-help-card">
            <div className="qiniu-help-card-head">
              <Sparkles size={15} />
              <strong>{tr('办法二：让 AI 教你配置')}</strong>
            </div>
            <p>{tr('复制下面这段提示词，粘贴到豆包、DeepSeek 或 Kimi 的对话框，它会按步骤带你做。')}</p>
            <textarea
              ref={promptRef}
              className="qiniu-help-prompt"
              readOnly
              rows={8}
              value={PROMPT}
              onFocus={(e) => e.currentTarget.select()}
              aria-label={tr('配置七牛云的提示词')}
            />
            <div className="qiniu-help-actions">
              <button className="btn btn-primary" onClick={() => void copyPrompt()}>
                {copied ? <Check size={14} /> : <Copy size={14} />}
                {copied ? tr('已复制') : tr('复制提示词')}
              </button>
            </div>
          </section>
        </div>

        <div className="modal-foot">
          <button className="btn btn-ghost" onClick={onClose}>
            {tr('关闭')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
