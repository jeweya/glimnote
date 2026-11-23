import { useCallback, useState } from 'react';
import { useApp } from '../store/app';
import { useT } from '../lib/i18n';
import { ConfirmDialog } from './Confirm';

/** 记住「不再提醒」的选择；只存在本机，不随仓库同步 */
const HINT_OFF_KEY = 'glimnote.trashHint.off';

/**
 * 删除笔记前先确认一次，告诉用户可以到回收站找回。
 * 勾选「不再提醒」后，本机后续删除直接执行，仍然保留撤销提示。
 */
export function useTrashConfirm() {
  const tr = useT();
  const removeNote = useApp((s) => s.removeNote);
  const [pending, setPending] = useState<string | null>(null);

  const request = useCallback(
    (id: string) => {
      if (localStorage.getItem(HINT_OFF_KEY) === '1') {
        void removeNote(id);
        return;
      }
      setPending(id);
    },
    [removeNote],
  );

  const dialog = pending ? (
    <ConfirmDialog
      title={tr('移到回收站？')}
      desc={tr('笔记会移到回收站，30 天内都可以恢复。')}
      confirmLabel={tr('移到回收站')}
      checkLabel={tr('不再提醒')}
      onCancel={() => setPending(null)}
      onConfirm={(dontRemind) => {
        if (dontRemind) localStorage.setItem(HINT_OFF_KEY, '1');
        const id = pending;
        setPending(null);
        if (id) void removeNote(id);
      }}
    />
  ) : null;

  return { request, dialog };
}
