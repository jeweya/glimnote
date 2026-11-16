/**
 * 隐私锁的独立密码。
 *
 * 与应用密码锁分开存：用户只想给几篇笔记上锁时，不必先把整个应用锁起来。
 * 这里仍然只做界面遮挡，不是文件加密；密码只保存盐和哈希。
 *
 * 勾选了「随 Git 同步」后，盐和哈希会跟着锁记录一起写进
 * .glimnote/privacy.json，多台设备用同一个隐私密码。拿到仓库的人
 * 可以看到哈希，但正文本来就是明文，这件事不会额外泄露笔记内容。
 */
import { markPrivacyPasswordTouched } from './privacy';
import { HASH_ITER, hashPassword, newSalt } from './lock';

const STORE_KEY = 'glimnote.privacy.password.v1';
export const PRIVACY_PASSWORD_MIN = 6;

export interface PrivacyPasswordRecord {
  v: 1;
  salt: string;
  hash: string;
  iter: number;
  createdAt: string;
}

function stored(): PrivacyPasswordRecord | null {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return null;
    const rec = JSON.parse(raw) as PrivacyPasswordRecord;
    return rec && rec.v === 1 && rec.salt && rec.hash ? rec : null;
  } catch {
    return null;
  }
}

/** 给同步模块读取：把盐 / 哈希原样写进仓库 */
export function exportPrivacyPassword(): PrivacyPasswordRecord | null {
  return stored();
}

/** 从仓库导入另一台设备设置好的隐私密码；传 null 表示仓库里已经没有密码 */
export function importPrivacyPassword(rec: PrivacyPasswordRecord | null): void {
  try {
    if (!rec) {
      localStorage.removeItem(STORE_KEY);
      return;
    }
    localStorage.setItem(STORE_KEY, JSON.stringify({ ...rec, v: 1 }));
  } catch {
    /* 写不进去时下一次同步会再试 */
  }
}

export function hasPrivacyPassword(): boolean {
  return stored() !== null;
}

export function privacyPasswordCreatedAt(): string | null {
  return stored()?.createdAt ?? null;
}

export async function setupPrivacyPassword(password: string): Promise<void> {
  if (password.length < PRIVACY_PASSWORD_MIN) throw new Error(`隐私密码至少 ${PRIVACY_PASSWORD_MIN} 位`);
  const salt = newSalt();
  const rec: PrivacyPasswordRecord = {
    v: 1,
    salt,
    hash: await hashPassword(password, salt, HASH_ITER),
    iter: HASH_ITER,
    createdAt: new Date().toISOString(),
  };
  localStorage.setItem(STORE_KEY, JSON.stringify(rec));
  markPrivacyPasswordTouched(rec.createdAt);
}

export async function verifyPrivacyPassword(password: string): Promise<boolean> {
  const rec = stored();
  if (!rec || !password) return false;
  return (await hashPassword(password, rec.salt, rec.iter)) === rec.hash;
}

export async function changePrivacyPassword(oldPassword: string, next: string): Promise<void> {
  if (!(await verifyPrivacyPassword(oldPassword))) throw new Error('当前隐私密码不对');
  await setupPrivacyPassword(next);
}

export async function removePrivacyPassword(password: string): Promise<void> {
  if (!(await verifyPrivacyPassword(password))) throw new Error('隐私密码不对，没有关闭');
  localStorage.removeItem(STORE_KEY);
  markPrivacyPasswordTouched();
}
