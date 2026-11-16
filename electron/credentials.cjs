/**
 * 授权令牌的本机保存（docs/05 §3）。
 *
 * 桌面端用 Electron safeStorage（Windows 走 DPAPI，绑定当前系统用户）把令牌
 * 加密后写进 userData/credentials.bin；文件里只有密文，明文永远不落盘。
 * 按平台分开存，换平台时两边的令牌都还在，不用重新生成。
 *
 * 系统密钥不可用（部分 Linux 桌面没有 keyring）时不退化成明文：
 * set() 返回 false，界面会提示「下次启动需要重新填写」。
 */
const path = require('node:path');
const fsp = require('node:fs/promises');

const PROVIDERS = new Set(['gitee', 'gitcode', 'github']);
const EMPTY = { v: 1, tokens: {} };

function createCredentialStore({ dir, safeStorage, log = () => {} }) {
  const file = path.join(dir, 'credentials.bin');

  function available() {
    try {
      return Boolean(safeStorage && safeStorage.isEncryptionAvailable());
    } catch {
      return false;
    }
  }

  async function readAll() {
    try {
      const buf = await fsp.readFile(file);
      const text = safeStorage.decryptString(buf);
      const data = JSON.parse(text);
      return data && typeof data === 'object' && data.tokens && typeof data.tokens === 'object' ? data : { ...EMPTY };
    } catch (e) {
      // 文件不存在是正常情况；解不开（换系统账户、DPAPI 失效）就当没有，
      // 但不要删文件——用户把机器修好后密文可能还能用。
      if (e && e.code !== 'ENOENT') log('warn', `读取已保存的令牌失败：${(e && e.message) || e}`);
      return { ...EMPTY };
    }
  }

  async function writeAll(data) {
    const buf = safeStorage.encryptString(JSON.stringify(data));
    await fsp.mkdir(dir, { recursive: true });
    const tmp = `${file}.tmp`;
    await fsp.writeFile(tmp, buf, { mode: 0o600 });
    await fsp.rename(tmp, file);
  }

  /** 读取某个平台的令牌；没有就返回空串 */
  async function get(provider) {
    if (!PROVIDERS.has(provider) || !available()) return '';
    const data = await readAll();
    const token = data.tokens[provider];
    return typeof token === 'string' ? token : '';
  }

  /** 保存（覆盖）某个平台的令牌；成功返回 true */
  async function set(provider, token) {
    if (!PROVIDERS.has(provider) || !token || !available()) return false;
    const data = await readAll();
    data.tokens = { ...data.tokens, [provider]: token };
    try {
      await writeAll(data);
      return true;
    } catch (e) {
      log('error', `保存令牌失败：${(e && e.message) || e}`);
      return false;
    }
  }

  /** 只清掉某个平台；断开同步时调用，不影响另一平台的令牌 */
  async function clear(provider) {
    if (!PROVIDERS.has(provider) || !available()) return false;
    const data = await readAll();
    if (!(provider in data.tokens)) return true;
    delete data.tokens[provider];
    try {
      await writeAll(data);
      return true;
    } catch (e) {
      log('error', `清除保存的令牌失败：${(e && e.message) || e}`);
      return false;
    }
  }

  return { file, available, get, set, clear };
}

module.exports = { createCredentialStore };
