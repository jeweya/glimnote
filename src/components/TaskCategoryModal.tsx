import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Plus, Trash2, X } from 'lucide-react';
import { useApp } from '../store/app';
import { CATEGORY_COLORS, cleanCategoryName, saveCategories } from '../lib/taskCategories';
import { cn } from '../lib/utils';
import { ConfirmDialog } from './Confirm';
import { useT } from '../lib/i18n';

interface Props {
  onClose: () => void;
}

/**
 * 分类管理：像整理文件夹一样增删改。
 * 分类名写在任务文件里，这里改的是本机的顺序与颜色，改名的同时会改写已使用它的任务。
 */
export function TaskCategoryModal({ onClose }: Props) {
  const categories = useApp((s) => s.categories);
  const tasks = useApp((s) => s.tasks);
  const addCategory = useApp((s) => s.addCategory);
  const renameCategory = useApp((s) => s.renameCategory);
  const removeCategory = useApp((s) => s.removeCategory);
  const toast = useApp((s) => s.toast);
  const tr = useT();

  const [adding, setAdding] = useState('');
  const [renaming, setRenaming] = useState<{ name: string; value: string } | null>(null);
  const [colorFor, setColorFor] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const addRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // 表单密集的弹窗只认 Esc，不点遮罩关闭，避免误触丢输入
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !removing) {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose, removing]);

  const countOf = (name: string) => tasks.filter((t) => t.category === name).length;

  const submitAdd = () => {
    const clean = cleanCategoryName(adding);
    if (!clean) return;
    if (!addCategory(clean)) {
      toast(tr('已经有同名分类了'), 'info');
      return;
    }
    setAdding('');
    addRef.current?.focus();
  };

  const submitRename = () => {
    if (!renaming) return;
    const to = cleanCategoryName(renaming.value);
    const from = renaming.name;
    setRenaming(null);
    if (!to || to === from) return;
    void (async () => {
      const ok = await renameCategory(from, to);
      if (!ok) toast(tr('已经有同名分类了'), 'info');
      else toast(tr('分类已改名，相关待办一起更新'), 'success');
    })();
  };

  const changeColor = (name: string, color: string) => {
    const next = categories.map((c) => (c.name === name ? { ...c, color } : c));
    saveCategories(next);
    useApp.setState({ categories: next });
    setColorFor(null);
  };

  const removingCount = removing ? countOf(removing) : 0;

  return createPortal(
    <div className="overlay">
      <div className="modal cat-modal" role="dialog" aria-modal="true" aria-label={tr('管理待办分类')}>
        <div className="modal-head">
          <div>
            <div className="modal-title">{tr('待办分类')}</div>
            <div className="modal-desc">{tr('分类会写进待办文件，换设备同步后仍在。')}</div>
          </div>
          <button className="icon-btn" onClick={onClose} title={tr('关闭')}>
            <X size={16} />
          </button>
        </div>

        <div className="cat-list">
          {categories.length === 0 && (
            <div className="cat-empty">{tr('还没有分类。在下面加一个，比如「工作」「家庭」「学习」。')}</div>
          )}
          {categories.map((cat) => {
            const count = countOf(cat.name);
            const isRenaming = renaming?.name === cat.name;
            return (
              <div className={cn('cat-row', isRenaming && 'editing')} key={cat.name}>
                <div className="cat-row-main">
                  <button
                    className="cat-dot"
                    style={{ background: cat.color }}
                    title={tr('换个颜色')}
                    onClick={() => setColorFor(colorFor === cat.name ? null : cat.name)}
                  />
                  {isRenaming ? (
                    <input
                      className="cat-name-input"
                      autoFocus
                      maxLength={16}
                      value={renaming.value}
                      onChange={(e) => setRenaming({ name: cat.name, value: e.target.value })}
                      onBlur={submitRename}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          submitRename();
                        } else if (e.key === 'Escape') {
                          e.stopPropagation();
                          setRenaming(null);
                        }
                      }}
                    />
                  ) : (
                    <button
                      className="cat-name"
                      title={tr('点击改名')}
                      onClick={() => setRenaming({ name: cat.name, value: cat.name })}
                    >
                      {cat.name}
                    </button>
                  )}
                  <span className="cat-count">{tr('{n} 条', { n: count })}</span>
                  <button className="icon-btn cat-del" title={tr('删除分类')} onClick={() => setRemoving(cat.name)}>
                    <Trash2 size={14} />
                  </button>
                </div>
                {colorFor === cat.name && (
                  <div className="cat-swatches">
                    {CATEGORY_COLORS.map((color) => (
                      <button
                        key={color}
                        className={cn('cat-swatch', cat.color === color && 'on')}
                        style={{ background: color }}
                        title={tr('使用这个颜色')}
                        onClick={() => changeColor(cat.name, color)}
                      >
                        {cat.color === color && <Check size={11} strokeWidth={2.5} />}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="cat-add">
          <Plus size={14} />
          <input
            ref={addRef}
            value={adding}
            maxLength={16}
            placeholder={tr('新建分类，回车保存')}
            onChange={(e) => setAdding(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                submitAdd();
              }
            }}
          />
          <button className="btn btn-primary cat-add-btn" disabled={!cleanCategoryName(adding)} onClick={submitAdd}>
            {tr('添加')}
          </button>
        </div>

        <div className="modal-foot cat-foot">
          <span className="cat-tip">{tr('点圆点换颜色，点名字改名；删除分类不会删掉里面的待办。')}</span>
          <button className="btn btn-ghost" onClick={onClose}>
            {tr('完成')}
          </button>
        </div>
      </div>

      {removing && (
        <ConfirmDialog
          title={tr('删除分类「{name}」？', { name: removing })}
          desc={
            removingCount
              ? tr('里面的 {n} 条待办会变成「未分类」，待办本身不会被删除。', { n: removingCount })
              : tr('这个分类里还没有待办。')
          }
          confirmLabel={tr('删除')}
          danger
          onCancel={() => setRemoving(null)}
          onConfirm={() => {
            const name = removing;
            setRemoving(null);
            void removeCategory(name).then(() => toast(tr('分类已删除'), 'info'));
          }}
        />
      )}
    </div>,
    document.body,
  );
}
