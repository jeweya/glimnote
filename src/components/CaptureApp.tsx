import { useEffect, useRef, useState } from 'react';
import { Check, Feather, Loader2, X } from 'lucide-react';
import { IDEA_MAX, cleanIdeaText, ideaTitle } from '../lib/ideas';
import * as repo from '../lib/repo';
import { bootstrap } from '../lib/storage';
import { desktop } from '../lib/desktop';
import { t, useT } from '../lib/i18n';

export function CaptureApp() {
  const tr = useT();
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const [saved, setSaved] = useState(false);
  const [failed, setFailed] = useState(false);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const bridge = desktop();

  useEffect(() => {
    document.title = t('快速捕获 · 萤光笔记');
    const theme = localStorage.getItem('glimnote.theme') || 'light';
    const dark = theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : theme === 'paper' ? 'paper' : 'light';
    void bootstrap();
    areaRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (bridge) void bridge.closeCapture();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [bridge]);

  const save = async () => {
    const body = cleanIdeaText(text);
    if (!body || saving) {
      if (!body) {
        setFailed(false);
        setNotice(tr('写点什么再保存'));
      }
      return;
    }
    setSaving(true);
    setFailed(false);
    setNotice('');
    try {
      const idea = await repo.createIdea(body);
      if (bridge) {
        await bridge.captureSaved({ id: idea.id, title: ideaTitle(body, 24), notebook: 'ideas' });
      } else {
        setSaved(true);
        setText('');
        setNotice(tr('已存入灵感（网页预览模式）'));
        areaRef.current?.focus();
        window.setTimeout(() => setSaved(false), 1800);
      }
    } catch (e) {
      setFailed(true);
      setNotice(tr('保存失败：{msg}', { msg: String((e as Error)?.message || e).slice(0, 60) }));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="capture-app">
      <header className="capture-head">
        <span className="capture-brand">
          <Feather size={14} strokeWidth={1.75} /> {tr('快速捕获')}
        </span>
        <span className="capture-hint">{tr('Ctrl + Enter 保存 · Esc 关闭')}</span>
        <button
          className="capture-x"
          title={tr('关闭')}
          onClick={() => (bridge ? void bridge.closeCapture() : window.close())}
        >
          <X size={14} />
        </button>
      </header>

      <textarea
        ref={areaRef}
        className="capture-area"
        value={text}
        placeholder={tr('刚才想到了什么？先记下来，稍后再整理。')}
        spellCheck={false}
        maxLength={IDEA_MAX}
        onChange={(e) => {
          setText(e.target.value);
          if (notice) setNotice('');
        }}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            e.preventDefault();
            void save();
          }
        }}
      />

      <footer className="capture-foot">
        <span className={cnNotice(saved, failed)}>
          {saved ? <Check size={14} /> : null}
          {notice || tr('保存到灵感，自动同步')}
        </span>
        <span className="capture-count">{tr('{n} 字', { n: text.length })}</span>
        <button className="btn btn-primary capture-save" disabled={!text.trim() || saving} onClick={() => void save()}>
          {saving ? <Loader2 size={14} className="spin" /> : null}
          {tr('保存')}
        </button>
      </footer>
    </div>
  );
}

function cnNotice(saved: boolean, failed: boolean) {
  return saved ? 'capture-note ok' : failed ? 'capture-note bad' : 'capture-note';
}
