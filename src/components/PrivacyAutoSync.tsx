import { useEffect } from 'react';
import { useApp } from '../store/app';
import { PRIVACY_CHANGED_EVENT } from '../lib/privacy';
import { schedulePrivacySync } from '../lib/privacySync';

/**
 * 隐私锁改动后的自动同步。
 *
 * 加锁 / 解锁 / 改密码只改了 localStorage，这里把它们尽快写进
 * .glimnote/privacy.json，并标记待同步，下一次 Git 同步就会带上。
 * 启动时的读取和同步后的合并放在 store 的 init / refresh 里做。
 */
export function PrivacyAutoSync() {
  useEffect(() => {
    const onChange = () => {
      useApp.getState().markPending();
      schedulePrivacySync();
    };
    window.addEventListener(PRIVACY_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(PRIVACY_CHANGED_EVENT, onChange);
  }, []);

  return null;
}
