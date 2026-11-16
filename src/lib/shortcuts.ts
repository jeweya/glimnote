export interface ShortcutDef {
  id: string;
  label: string;
  def: string;
}

/**
 * 可在设置里改键的全局快捷键。
 * 组合键统一存成 `Ctrl+Shift+O` 这种形式；`Ctrl` 在 macOS 上也接受 ⌘。
 */
export const SHORTCUTS: ShortcutDef[] = [
  { id: 'home', label: '回到首页', def: 'Ctrl+Shift+H' },
  { id: 'palette', label: '搜索 / 命令面板', def: 'Ctrl+K' },
  { id: 'switch', label: '快速切换笔记', def: 'Ctrl+P' },
  { id: 'new', label: '新建笔记', def: 'Ctrl+N' },
  { id: 'daily', label: '今日日记', def: 'Ctrl+D' },
  { id: 'settings', label: '打开设置', def: 'Ctrl+,' },
  { id: 'sidebar', label: '显示 / 隐藏侧栏', def: 'Ctrl+\\' },
  { id: 'focus', label: '专注模式', def: 'Ctrl+Shift+F' },
  { id: 'toc', label: '显示 / 隐藏目录', def: 'Ctrl+Shift+O' },
  { id: 'typewriter', label: '打字机模式', def: 'Ctrl+Shift+Y' },
  { id: 'sync', label: '立即同步', def: 'Ctrl+Shift+S' },
  { id: 'move', label: '移动当前笔记', def: 'Ctrl+Shift+M' },
  { id: 'export', label: '导出当前笔记', def: 'Ctrl+E' },
];

const KEY = 'glimnote.keys';
const MODIFIERS = new Set(['Control', 'Shift', 'Alt', 'Meta']);

function defaults() {
  return Object.fromEntries(SHORTCUTS.map((s) => [s.id, s.def])) as Record<string, string>;
}

let cached: Record<string, string> | null = null;

export function loadBindings(): Record<string, string> {
  if (cached) return cached;
  let saved: Record<string, string> = {};
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '{}') as Record<string, string>;
    for (const s of SHORTCUTS) {
      const value = raw[s.id];
      if (typeof value === 'string' && value.trim()) saved[s.id] = value;
    }
  } catch {
    saved = {};
  }
  cached = { ...defaults(), ...saved };
  return cached;
}

export function saveBindings(bindings: Record<string, string>) {
  cached = { ...defaults(), ...bindings };
  localStorage.setItem(KEY, JSON.stringify(cached));
}

export function resetBindings() {
  localStorage.removeItem(KEY);
  cached = defaults();
  return cached;
}

/** 把键盘事件规范化成 `Ctrl+Shift+O`；只按修饰键时返回 null */
export function comboFromEvent(e: KeyboardEvent): string | null {
  if (MODIFIERS.has(e.key) || e.key === 'Dead' || e.key === 'Unidentified') return null;
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  parts.push(normalizeKey(e.key));
  return parts.join('+');
}

function normalizeKey(raw: string) {
  if (raw === ' ') return 'Space';
  if (raw === 'Escape') return 'Esc';
  if (raw === 'ArrowUp') return 'Up';
  if (raw === 'ArrowDown') return 'Down';
  if (raw === 'ArrowLeft') return 'Left';
  if (raw === 'ArrowRight') return 'Right';
  if (raw.length === 1) return raw.toUpperCase();
  return raw;
}

export function matchCombo(e: KeyboardEvent, combo: string | undefined) {
  if (!combo) return false;
  const parts = combo.split('+');
  const key = parts[parts.length - 1];
  const wantCtrl = parts.includes('Ctrl');
  const wantAlt = parts.includes('Alt');
  const wantShift = parts.includes('Shift');
  if ((e.ctrlKey || e.metaKey) !== wantCtrl) return false;
  if (e.altKey !== wantAlt) return false;
  if (e.shiftKey !== wantShift) return false;
  return normalizeKey(e.key) === key;
}

export function findConflict(bindings: Record<string, string>, id: string, combo: string) {
  return SHORTCUTS.find((s) => s.id !== id && bindings[s.id] === combo) || null;
}
