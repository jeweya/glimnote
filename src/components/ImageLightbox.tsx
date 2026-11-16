import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { Minus, Plus, RotateCcw, X } from 'lucide-react';
import { useT } from '../lib/i18n';

const ZOOM_MIN = 1;
const ZOOM_MAX = 6;

interface Props {
  url: string;
  alt?: string;
  onClose: () => void;
}

/** 图片大图预览：滚轮缩放、拖动查看、双击复原、Esc 关闭。阅读预览与编辑区共用。 */
export function ImageLightbox({ url, alt, onClose }: Props) {
  const tr = useT();
  const altText = alt ?? tr('图片');
  const stageRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });

  const resetZoom = () => {
    setZoom(1);
    setOffset({ x: 0, y: 0 });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // 滚轮缩放要 preventDefault，React 的 onWheel 在部分浏览器里是 passive，改用原生监听
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      setZoom((z) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z * (e.deltaY < 0 ? 1.12 : 0.89))));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const startPan = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (zoom <= 1) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y };
  };

  const movePan = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    setOffset({ x: d.ox + e.clientX - d.x, y: d.oy + e.clientY - d.y });
  };

  const endPan = () => {
    dragRef.current = null;
  };

  return createPortal(
    <div className="lightbox" onClick={onClose}>
      <div
        className="lb-stage"
        ref={stageRef}
        onClick={(e) => e.stopPropagation()}
        onPointerDown={startPan}
        onPointerMove={movePan}
        onPointerUp={endPan}
        onPointerCancel={endPan}
        onDoubleClick={resetZoom}
        style={{ cursor: zoom > 1 ? 'grab' : 'zoom-in' }}
      >
        <img
          src={url}
          alt={altText}
          draggable={false}
          style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})` }}
        />
      </div>
      <div className="lb-bar" onClick={(e) => e.stopPropagation()}>
        <span className="lb-name">{altText}</span>
        <div className="lb-actions">
          <button title={tr('缩小')} onClick={() => setZoom((z) => Math.max(ZOOM_MIN, z / 1.4))}>
            <Minus size={14} />
          </button>
          <button title={tr('重置')} onClick={resetZoom}>
            <RotateCcw size={14} />
          </button>
          <button title={tr('放大')} onClick={() => setZoom((z) => Math.min(ZOOM_MAX, z * 1.4))}>
            <Plus size={14} />
          </button>
          <button title={tr('关闭  Esc')} onClick={onClose}>
            <X size={16} />
          </button>
        </div>
      </div>
      <div className="lb-hint">{tr('滚轮缩放 · 拖动查看 · 双击复原 · Esc 关闭')}</div>
    </div>,
    document.body,
  );
}
