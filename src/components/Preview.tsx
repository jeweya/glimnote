import { useEffect, useMemo, useRef, useState } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { readBinary } from '../lib/storage';
import { escapeHtml } from '../lib/utils';
import { mimeOf, parseImageAlt, resolveAsset } from '../lib/assets';
import { ImageLightbox } from './ImageLightbox';
import { t, useT } from '../lib/i18n';

marked.setOptions({ gfm: true, breaks: true });

function renderMarkdown(content: string) {
  const withWiki = content.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, target: string, alias?: string) => {
    const label = escapeHtml((alias || target).trim());
    return `<a href="#" class="wiki" data-note="${escapeHtml(target.trim())}">${label}</a>`;
  });
  const raw = marked.parse(withWiki, { async: false }) as string;
  // GFM 的任务列表会渲染成 <li><input type="checkbox">，给所在列表补个类名，好去掉圆点
  const doc = new DOMParser().parseFromString(raw, 'text/html');
  // 旧笔记里可能留着「选了字体但没输入」的空 span；渲染时会白占一行，字号越大越明显
  doc.querySelectorAll('span').forEach((span) => {
    if (!span.childNodes.length) span.remove();
  });
  doc.querySelectorAll('li > input[type="checkbox"]').forEach((input) => {
    const li = input.closest('li');
    li?.classList.add('task-item');
    li?.parentElement?.classList.add('task-list');
  });
  return DOMPurify.sanitize(doc.body.innerHTML, { ADD_ATTR: ['data-note', 'target'] });
}

interface Props {
  content: string;
  notePath: string;
  onWiki?: (title: string) => void;
  onNotice?: (text: string) => void;
}

interface Viewer {
  url: string;
  alt: string;
}

export function Preview({ content, notePath, onWiki, onNotice }: Props) {
  const tr = useT();
  const ref = useRef<HTMLDivElement>(null);
  const [viewer, setViewer] = useState<Viewer | null>(null);
  const html = useMemo(() => renderMarkdown(content), [content]);

  useEffect(() => {
    const host = ref.current;
    if (!host) return;
    const urls: string[] = [];
    let cancelled = false;

    host.querySelectorAll('a[href^="http"]').forEach((a) => {
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noreferrer noopener');
    });

    const images = Array.from(host.querySelectorAll('img'));
    void (async () => {
      for (const img of images) {
        // 尺寸写在 alt 末尾（![说明|360](…)），这里还原成真实宽度
        const size = parseImageAlt(img.getAttribute('alt') || '');
        img.alt = size.alt;
        if (size.width) {
          img.style.width = `${size.width}px`;
          img.style.maxWidth = '100%';
          img.style.height = 'auto';
        }
        const raw = img.getAttribute('src') || '';
        let src = raw;
        try {
          // 浏览器 / 清洗器会把中文文件名转成 %E6…，还原后再去仓库里找文件
          src = decodeURI(raw);
        } catch {
          src = raw;
        }
        const abs = resolveAsset(notePath, src);
        if (!abs) continue;
        try {
          const data = await readBinary(abs);
          const url = URL.createObjectURL(new Blob([data.slice().buffer as ArrayBuffer]));
          if (cancelled) {
            URL.revokeObjectURL(url);
            continue;
          }
          img.src = url;
          urls.push(url);
        } catch {
          img.classList.add('broken');
          img.alt = t('{name}（附件缺失）', { name: img.alt || t('图片') });
        }
      }
    })();

    return () => {
      cancelled = true;
      urls.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [html, notePath]);

  if (!content.trim()) {
    return (
      <div className="editor-empty">
        <div className="big">{tr('这篇笔记还是空的')}</div>
        <div className="hint">{tr('切回编辑模式，写下第一句话。')}</div>
      </div>
    );
  }

  return (
    <div className="preview">
      <div
        className="preview-inner"
        ref={ref}
        dangerouslySetInnerHTML={{ __html: html }}
        onClick={(e) => {
          const a = (e.target as HTMLElement).closest('a[data-note]');
          if (a) {
            e.preventDefault();
            const title = a.getAttribute('data-note');
            if (title) onWiki?.(title);
            return;
          }
          // 相对路径的链接指向仓库里的附件：点一下下载，而不是跳出应用
          const fileLink = (e.target as HTMLElement).closest('a[href]') as HTMLAnchorElement | null;
          const href = fileLink?.getAttribute('href') || '';
          if (fileLink && href && !/^(https?:|mailto:|#)/i.test(href)) {
            e.preventDefault();
            const abs = resolveAsset(notePath, decodeURI(href));
            if (!abs) return;
            // 下载时用用户看得懂的原文件名，而不是仓库里的哈希名
            const name = (fileLink.textContent || '').trim() || abs.split('/').pop() || tr('附件');
            void readBinary(abs)
              .then((data) => {
                const url = URL.createObjectURL(new Blob([data.slice().buffer as ArrayBuffer], { type: mimeOf(abs) }));
                const link = document.createElement('a');
                link.href = url;
                link.download = name;
                document.body.appendChild(link);
                link.click();
                link.remove();
                setTimeout(() => URL.revokeObjectURL(url), 15000);
                onNotice?.(tr('正在下载附件「{name}」', { name }));
              })
              .catch(() => onNotice?.(tr('附件不存在或已损坏')));
            return;
          }
          const img = (e.target as HTMLElement).closest('img') as HTMLImageElement | null;
          if (img?.src && !img.classList.contains('broken')) {
            e.preventDefault();
            setViewer({ url: img.src, alt: img.alt || tr('图片') });
          }
        }}
      />

      {viewer && <ImageLightbox url={viewer.url} alt={viewer.alt} onClose={() => setViewer(null)} />}
    </div>
  );
}
