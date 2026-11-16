/**
 * 密码锁：只做「挡在界面前面」这一件事。
 *
 * 设计取舍写在这里，改之前先看：
 * - 密码与恢复码都用 PBKDF2-SHA256（随机盐 + 15 万次迭代）派生，本地只存盐和结果，不存明文；
 * - 校验在渲染层完成，锁记录存在 localStorage，桌面端与网页版共用一套；
 * - 这不是加密：笔记文件仍然以明文躺在磁盘 / 仓库里，拿到文件的人不输密码也能读。
 *   界面锁的目标是「别人顺手打开电脑看不到内容」，不是防取证。要真加密得另做一套。
 */
import { t } from './i18n';

const LOCK_KEY = 'glimnote.lock.v1';
const ITER = 150000;
/** 其他本地密码（例如隐私密码）复用同一套迭代参数，避免两处漂移 */
export const HASH_ITER = ITER;
const RECOVERY_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const RECOVERY_LEN = 20;
export const PASSWORD_MIN = 6;

export interface LockRecord {
  v: 1;
  salt: string;
  hash: string;
  iter: number;
  recSalt: string;
  recHash: string;
  createdAt: string;
}

export class LockError extends Error {}

export function b64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 1) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

export function unb64(text: string): Uint8Array {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

export function randomBytes(n: number): Uint8Array {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  return bytes;
}

export async function derive(secret: string, salt: Uint8Array, iter: number): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new LockError(t('当前环境不支持安全哈希，无法使用密码锁'));
  const key = await subtle.importKey('raw', new TextEncoder().encode(secret), 'PBKDF2', false, ['deriveBits']);
  // TS 5.7 起 Uint8Array 带 ArrayBufferLike 泛型，WebCrypto 只收 ArrayBuffer 视图，这里显式收窄
  const bits = await subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as unknown as BufferSource, iterations: iter, hash: 'SHA-256' },
    key,
    256,
  );
  return b64(new Uint8Array(bits));
}

function makeRecoveryCode(): string {
  const bytes = randomBytes(RECOVERY_LEN);
  let raw = '';
  for (let i = 0; i < RECOVERY_LEN; i += 1) raw += RECOVERY_ALPHABET[bytes[i] % RECOVERY_ALPHABET.length];
  return raw.match(/.{1,5}/g)?.join('-') ?? raw;
}

/** 去掉用户从纸上抄回来时的空格、连字符和小写差异 */
export function normalizeRecovery(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function newSalt(): string {
  return b64(randomBytes(16));
}

/** 用 base64 盐做 PBKDF2；隐私密码模块共用这套实现 */
export async function hashPassword(secret: string, salt: string, iter: number): Promise<string> {
  return derive(secret, unb64(salt), iter);
}

function stored(): LockRecord | null {
  try {
    const raw = localStorage.getItem(LOCK_KEY);
    if (!raw) return null;
    const rec = JSON.parse(raw) as LockRecord;
    return rec && rec.v === 1 && rec.salt && rec.hash ? rec : null;
  } catch {
    return null;
  }
}

export function hasPasswordLock(): boolean {
  return stored() !== null;
}

export function lockCreatedAt(): string | null {
  return stored()?.createdAt ?? null;
}

/** 设置密码，返回一次性的恢复码（之后不再显示） */
export async function setupLock(password: string): Promise<{ recovery: string }> {
  if (password.length < PASSWORD_MIN) throw new LockError(t('密码至少 {n} 位', { n: PASSWORD_MIN }));
  const salt = randomBytes(16);
  const recSalt = randomBytes(16);
  const recovery = makeRecoveryCode();
  const rec = {
    v: 1 as const,
    salt: b64(salt),
    hash: await derive(password, salt, ITER),
    iter: ITER,
    recSalt: b64(recSalt),
    recHash: await derive(normalizeRecovery(recovery), recSalt, ITER),
    createdAt: new Date().toISOString(),
  };
  localStorage.setItem(LOCK_KEY, JSON.stringify(rec));
  return { recovery };
}

export async function verifyPassword(password: string): Promise<boolean> {
  const rec = stored();
  if (!rec || !password) return false;
  const got = await derive(password, unb64(rec.salt), rec.iter);
  return got === rec.hash;
}

export async function verifyRecovery(code: string): Promise<boolean> {
  const rec = stored();
  const clean = normalizeRecovery(code);
  if (!rec || clean.length !== RECOVERY_LEN) return false;
  const got = await derive(clean, unb64(rec.recSalt), rec.iter);
  return got === rec.recHash;
}

/** 用恢复码重设密码；成功后会换一组新的恢复码 */
export async function resetWithRecovery(code: string, next: string): Promise<{ recovery: string }> {
  if (!(await verifyRecovery(code))) throw new LockError(t('恢复码不对，检查一下有没有抄错字符'));
  return setupLock(next);
}

/** 修改密码：需要旧密码，成功后恢复码一并换新 */
export async function changePassword(oldPassword: string, next: string): Promise<{ recovery: string }> {
  if (!(await verifyPassword(oldPassword))) throw new LockError(t('当前密码不对'));
  return setupLock(next);
}

export async function removeLock(password: string): Promise<void> {
  if (!(await verifyPassword(password))) throw new LockError(t('密码不对，密码锁没有关闭'));
  localStorage.removeItem(LOCK_KEY);
}
