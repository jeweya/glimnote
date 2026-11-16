import { useEffect, useRef, useState } from 'react';
import { Loader2, Sparkles, X } from 'lucide-react';
import { getActiveView } from '../lib/editorBridge';
import { getActiveRichEditor, richInsertCodeBlock } from '../lib/rich/bridge';
import { CODE_LANGUAGES, canPrettify, findLanguage, formatCode } from '../lib/codeFormat';
import { useT } from '../lib/i18n';

interface Props {
  open: boolean;
  onClose: () => void;
  onInserted?: (text: string) => void;
}

const LANG_KEY = 'glimnote.codeLang';

/**
 * 插入代码块：先把语言选好、代码粘进来，点「格式化」整好缩进，再一次性放进笔记。
 * 直接在编辑器里手敲 ``` 也可以，这个弹窗只是给不想记语法的人准备的。
 */
export function CodeModal({ open, onClose, onInserted }: Props) {
  const tr = useT();
  const [lang, setLang] = useState(() => {
    const saved = localStorage.getItem(LANG_KEY) || '';
    return CODE_LANGUAGES.some((l) => l.id === saved) ? saved : 'js';
  });
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!open) return;
    setCode('');
    setBusy(false);
    setStatus(null);
    const timer = window.setTimeout(() => areaRef.current?.focus(), 30);
    return () => window.clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    localStorage.setItem(LANG_KEY, lang);
  }, [lang]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const insert = () => {
    const text = code.replace(/\n+$/, '');
    if (!text.trim()) {
      onClose();
      return;
    }
    if (getActiveRichEditor()) {
      richInsertCodeBlock(text, lang);
      onInserted?.(text);
      onClose();
      return;
    }
    const view = getActiveView();
    if (!view) {
      onClose();
      return;
    }
    const fence = findLanguage(lang).fence;
    const { from, to } = view.state.selection.main;
    const line = view.state.doc.lineAt(from);
    const lead = line.text.trim() ? '\n' : '';
    const block = `${lead}\`\`\`${fence}\n${text}\n\`\`\`\n`;
    view.dispatch({
      changes: { from, to, insert: block },
      selection: { anchor: from + block.length },
    });
    view.focus();
    onInserted?.(text);
    onClose();
  };

  const runFormat = async () => {
    if (!code.trim() || busy) return;
    setBusy(true);
    setStatus(null);
    try {
      const result = await formatCode(code, lang);
      setCode(result.code);
      setStatus({
        kind: 'ok',
        text: result.mode === 'prettier' ? tr('已按代码规范排好') : tr('这个语言暂时只能整理空白'),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message.split('\n')[0] : '';
      setStatus({
        kind: 'error',
        text: message
          ? tr('代码有语法问题，没能格式化：{msg}', { msg: message })
          : tr('代码有语法问题，没能格式化'),
      });
    } finally {
      setBusy(false);
      areaRef.current?.focus();
    }
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal code-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <div className="modal-title">{tr('插入代码块')}</div>
            <div className="modal-desc">{tr('选好语言，把代码粘贴进来；点「格式化」可以自动整理缩进，满意了再插入。')}</div>
          </div>
          <button className="icon-btn" onClick={onClose} title={tr('关闭  Esc')}>
            <X size={16} />
          </button>
        </div>

        <div className="modal-body">
          <div className="code-toolbar">
            <label className="code-lang">
              <span>{tr('语言')}</span>
              <select value={lang} onChange={(e) => setLang(e.target.value)}>
                {CODE_LANGUAGES.map((item) => (
                  <option key={item.id} value={item.id}>
                    {tr(item.label)}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="btn btn-secondary code-fmt"
              disabled={busy || !code.trim()}
              title={
                canPrettify(lang)
                  ? tr('按该语言的通用规范重新缩进、换行')
                  : tr('该语言暂不支持精排，只清理行尾空格与多余空行')
              }
              onClick={() => void runFormat()}
            >
              {busy ? <Loader2 size={14} className="spin" /> : <Sparkles size={14} strokeWidth={1.75} />}
              {tr('格式化')}
            </button>
            {status && <span className={`code-status ${status.kind}`}>{status.text}</span>}
          </div>

          <textarea
            ref={areaRef}
            className="code-area"
            value={code}
            spellCheck={false}
            placeholder={tr('在这里粘贴代码，例如：{code}', { code: '\nconsole.log("hello")' })}
            onChange={(e) => {
              setCode(e.target.value);
              setStatus(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                insert();
              }
            }}
          />
        </div>

        <div className="modal-foot code-foot">
          <span className="code-foot-tip">{tr('插入后就是一个正常的代码块，随时可以在编辑区里改')}</span>
          <button className="btn btn-secondary" onClick={onClose}>
            {tr('取消')}
          </button>
          <button className="btn btn-primary" disabled={!code.trim()} onClick={insert}>
            {tr('插入')}
          </button>
        </div>
      </div>
    </div>
  );
}
