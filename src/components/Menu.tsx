import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Check } from 'lucide-react';

export interface MenuEntry {
  label: string;
  icon?: ReactNode;
  kbd?: string;
  danger?: boolean;
  /** 当前生效的选项（如优先级） */
  checked?: boolean;
  /** 置灰但保留位置：让菜单结构固定，位置不会跳（编辑器右键菜单用） */
  disabled?: boolean;
  onClick: () => void;
}

interface Props {
  x: number;
  y: number;
  items: (MenuEntry | 'sep')[];
  onClose: () => void;
}

export function Menu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let left = x;
    let top = y;
    if (left + r.width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - r.width - 8);
    if (top + r.height > window.innerHeight - 8) top = Math.max(8, y - r.height);
    setPos({ left, top });
  }, [x, y, items.length]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', onClose);
    window.addEventListener('blur', onClose);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);

  return (
    <div className="menu" ref={ref} style={{ left: pos.left, top: pos.top }} role="menu">
      {items.map((item, i) =>
        item === 'sep' ? (
          <div className="menu-sep" key={`sep-${i}`} />
        ) : (
          <button
            key={item.label + i}
            className={item.danger ? 'menu-item danger' : 'menu-item'}
            disabled={item.disabled}
            onClick={() => {
              if (item.disabled) return;
              onClose();
              item.onClick();
            }}
          >
            {item.icon}
            <span>{item.label}</span>
            {item.checked && <Check size={14} className="menu-check" />}
            {item.kbd && <span className="k">{item.kbd}</span>}
          </button>
        ),
      )}
    </div>
  );
}
