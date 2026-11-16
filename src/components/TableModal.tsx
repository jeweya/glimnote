import { useEffect, useState } from 'react';
import { Plus, Trash2, X } from 'lucide-react';
import { getActiveView } from '../lib/editorBridge';
import { getActiveRichEditor, richDeleteTable, richInsertTable, richReplaceTable } from '../lib/rich/bridge';
import { buildTable, type ParsedTable } from '../lib/table';
import { t, useT } from '../lib/i18n';

interface Props {
  open: boolean;
  /** 富文本里被点开的表格节点位置；新建表格时为 null */
  richPos?: number | null;
  initial?: ParsedTable | null;
  onClose: () => void;
}

const newHeader = () => [t('列 1'), t('列 2'), t('列 3')];
const NEW_ROW = ['', '', ''];

/** 新建表格的初始内容：三列两行，改起来比先插一堆 | 直观 */
function freshTable(): ParsedTable {
  return { header: newHeader(), rows: [['', '', ''], [...NEW_ROW]] };
}

/**
 * 表格编辑弹窗：在格子里直接打字，加行加列都在这里；
 * 点「确定」才把整张表按对齐好的 Markdown 写回笔记，不会再看到一堆 | --- |。
 */
export function TableModal({ open, richPos, initial, onClose }: Props) {
  const tr = useT();
  const [header, setHeader] = useState<string[]>(newHeader);
  const [rows, setRows] = useState<string[][]>([['', '', ''], [...NEW_ROW]]);

  useEffect(() => {
    if (!open) return;
    const data = initial || freshTable();
    setHeader(data.header.length ? [...data.header] : newHeader());
    setRows(
      data.rows.length ? data.rows.map((row) => data.header.map((_, i) => row[i] || '')) : [data.header.map(() => '')],
    );
  }, [open, initial]);

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

  const cols = header.length;

  const setHead = (i: number, value: string) =>
    setHeader((prev) => prev.map((cell, idx) => (idx === i ? value : cell)));

  const setCell = (r: number, c: number, value: string) =>
    setRows((prev) => prev.map((row, idx) => (idx === r ? row.map((cell, ci) => (ci === c ? value : cell)) : row)));

  const addColumn = () => {
    setHeader((prev) => [...prev, tr('列 {n}', { n: prev.length + 1 })]);
    setRows((prev) => prev.map((row) => [...row, '']));
  };

  const removeColumn = (index: number) => {
    if (cols <= 1) return;
    setHeader((prev) => prev.filter((_, i) => i !== index));
    setRows((prev) => prev.map((row) => row.filter((_, i) => i !== index)));
  };

  const addRow = () => setRows((prev) => [...prev, header.map(() => '')]);

  const removeRow = (index: number) => setRows((prev) => prev.filter((_, i) => i !== index));

  /** 源码模式：把整张表写在光标处 */
  const write = (text: string) => {
    const view = getActiveView();
    if (!view) return false;
    const { from, to } = view.state.selection.main;
    const line = view.state.doc.lineAt(from);
    const lead = line.text.trim() ? '\n' : '';
    const block = `${lead}${text}\n`;
    view.dispatch({
      changes: { from, to, insert: block },
      selection: { anchor: from + block.length },
    });
    view.focus();
    return true;
  };

  const confirm = () => {
    // 末尾没填的空行不写进笔记，免得表格下面留一条空白
    const body = [...rows];
    while (body.length && body[body.length - 1].every((cell) => !cell.trim())) body.pop();
    if (getActiveRichEditor()) {
      const data = { header, rows: body };
      // 位置失效时宁可不写，也不要在别处再插一张重复的表
      if (richPos != null) richReplaceTable(richPos, data);
      else richInsertTable(data);
      onClose();
      return;
    }
    if (write(buildTable(header, body))) onClose();
  };

  const removeTable = () => {
    if (richPos == null) return;
    richDeleteTable(richPos);
    onClose();
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal table-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <div className="modal-title">{richPos != null ? tr('编辑表格') : tr('插入表格')}</div>
            <div className="modal-desc">{tr('在格子里直接打字，需要几行几列就加几行几列；确定后才会写进笔记。')}</div>
          </div>
          <button className="icon-btn" onClick={onClose} title={tr('关闭  Esc')}>
            <X size={16} />
          </button>
        </div>

        <div className="modal-body table-body">
          <div className="table-scroll">
            <table className="table-edit">
              <thead>
                <tr>
                  {header.map((cell, i) => (
                    <th key={i}>
                      <input
                        value={cell}
                        placeholder={tr('列 {n}', { n: i + 1 })}
                        onChange={(e) => setHead(i, e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') confirm();
                        }}
                      />
                      {cols > 1 && (
                        <button
                          type="button"
                          className="table-del-col"
                          title={tr('删除这一列')}
                          onClick={() => removeColumn(i)}
                        >
                          <X size={14} strokeWidth={1.75} />
                        </button>
                      )}
                    </th>
                  ))}
                  <th className="table-add-col">
                    <button type="button" title={tr('加一列')} onClick={addColumn}>
                      <Plus size={14} strokeWidth={1.75} />
                    </button>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, r) => (
                  <tr key={r}>
                    {header.map((_, c) => (
                      <td key={c}>
                        <input
                          value={row[c] || ''}
                          onChange={(e) => setCell(r, c, e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') confirm();
                          }}
                        />
                      </td>
                    ))}
                    <td className="table-del-cell">
                      <button type="button" title={tr('删除这一行')} onClick={() => removeRow(r)}>
                        <X size={14} strokeWidth={1.75} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <button type="button" className="table-add-row" onClick={addRow}>
            <Plus size={14} strokeWidth={1.75} /> {tr('加一行')}
          </button>
        </div>

        <div className="modal-foot table-foot">
          {richPos != null ? (
            <button className="btn btn-danger table-remove" onClick={removeTable}>
              <Trash2 size={14} strokeWidth={1.75} /> {tr('删除整张表格')}
            </button>
          ) : (
            <span className="table-foot-tip">{tr('第一行是表头，会显示成加粗的一行')}</span>
          )}
          <span className="fmt-grow" />
          <button className="btn btn-secondary" onClick={onClose}>
            {tr('取消')}
          </button>
          <button className="btn btn-primary" onClick={confirm}>
            {tr('确定')}
          </button>
        </div>
      </div>
    </div>
  );
}
