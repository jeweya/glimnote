import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ChevronDown } from 'lucide-react';
import { useT } from '../lib/i18n';

interface Props {
  value: string;
  options: string[];
  placeholder?: string;
  onChange: (value: string) => void;
}

/**
 * 模型名输入框 + 自绘候选列表。
 *
 * 为什么不用 <datalist>：它弹出的列表由浏览器/系统渲染，CSS 管不到。
 * 系统是深色模式、应用却是浅色时，列表会黑成一块（用户实测反馈），
 * 所以这里自己画一层，颜色跟着应用主题走，输入仍然自由——不在名单里的模型名也能填。
 */
export function ModelPicker({ value, options, placeholder, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const tr = useT();
  const [active, setActive] = useState(-1);
  const box = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);

  const list = useMemo(() => {
    const q = value.trim().toLowerCase();
    if (!q) return options;
    // 已经填了某个候选本身：当作「想换一个」，列全部；否则按输入内容做子串筛选
    if (options.some((m) => m.toLowerCase() === q)) return options;
    return options.filter((m) => m.toLowerCase().includes(q));
  }, [options, value]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  useEffect(() => {
    if (!open) setActive(-1);
  }, [open]);

  const pick = (m: string) => {
    onChange(m);
    setOpen(false);
  };

  // 键位放在整块上而不是只挂在输入框：点箭头后焦点在按钮上，Esc 也要能只关列表
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!open) {
        setOpen(true);
        return;
      }
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      const next = Math.min(list.length - 1, Math.max(0, active + step));
      setActive(list.length ? next : -1);
      return;
    }
    if (e.key === 'Enter' && open && active >= 0 && list[active]) {
      e.preventDefault();
      pick(list[active]);
      return;
    }
    if (e.key === 'Escape' && open) {
      // 别让 Esc 冒泡到设置弹窗，否则想关候选列表却把整个设置关了
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    }
  };

  return (
    <div className="model-picker" ref={box} onKeyDown={onKeyDown}>
      <input
        ref={field}
        className="input model-input"
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        role="combobox"
        aria-expanded={open}
        aria-controls="glimnote-model-list"
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
          setActive(-1);
        }}
      />
      <button
        type="button"
        className="peek-btn"
        title={open ? tr('收起候选模型') : tr('看看有哪些模型')}
        aria-label={open ? tr('收起候选模型') : tr('展开候选模型')}
        onClick={() => {
          setOpen((v) => !v);
          // 展开后把光标送回输入框，接着敲字就能筛选
          field.current?.focus();
        }}
      >
        <ChevronDown size={14} strokeWidth={1.75} className="model-caret" data-open={open ? '1' : '0'} />
      </button>

      {open && list.length > 0 && (
        <div className="model-menu" id="glimnote-model-list" role="listbox">
          {list.map((m, i) => (
            <button
              key={m}
              type="button"
              role="option"
              aria-selected={m === value}
              className={`model-opt${i === active ? ' active' : ''}${m === value ? ' on' : ''}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(m)}
            >
              {m}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
