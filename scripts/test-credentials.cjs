/**
 * 单测 electron/credentials.cjs：用假的 safeStorage 模拟 DPAPI，验证密文读写与清理。
 * 运行：node scripts/test-credentials.cjs
 */
const path = require('node:path');
const os = require('node:os');
const fsp = require('node:fs/promises');
const { createCredentialStore } = require('../electron/credentials.cjs');

const assert = (cond, msg) => {
  if (!cond) throw new Error(`断言失败：${msg}`);
  console.log(`  ✓ ${msg}`);
};

/** 一个足够像 safeStorage 的替身：加密后是 ENC: + base64，明文不会留在文件里 */
function fakeSafeStorage(enabled = true) {
  return {
    isEncryptionAvailable: () => enabled,
    encryptString: (text) => Buffer.from(`ENC:${Buffer.from(text, 'utf8').toString('base64')}`, 'utf8'),
    decryptString: (buf) => {
      const text = Buffer.from(buf).toString('utf8');
      if (!text.startsWith('ENC:')) throw new Error('不是本程序写入的密文');
      return Buffer.from(text.slice(4), 'base64').toString('utf8');
    },
  };
}

(async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'glimnote-cred-'));
  const logs = [];
  const store = createCredentialStore({
    dir,
    safeStorage: fakeSafeStorage(),
    log: (level, msg) => logs.push(`${level}:${msg}`),
  });

  assert(store.available() === true, '系统密钥可用时 available() 为 true');
  assert((await store.get('gitee')) === '', '从没保存过时返回空串');
  assert((await store.get('bogus')) === '', '未知平台直接返回空串，不落盘');

  const token = 'gitee-token-abc123';
  assert((await store.set('gitee', token)) === true, '保存 Gitee 令牌成功');
  assert((await store.get('gitee')) === token, '读回来的令牌与写入一致');

  const raw = await fsp.readFile(path.join(dir, 'credentials.bin'));
  const text = raw.toString('utf8');
  assert(!text.includes(token), '文件里看不到明文令牌');
  assert(text.startsWith('ENC:'), '文件内容确实经过 safeStorage 加密');

  assert((await store.set('github', 'gh-token-xyz')) === true, '再保存 GitHub 令牌成功');
  assert((await store.get('gitee')) === token, '后保存的平台不会覆盖前一个');
  assert((await store.get('github')) === 'gh-token-xyz', '两个平台各自取回自己的令牌');

  assert((await store.clear('gitee')) === true, '清除 Gitee 令牌成功');
  assert((await store.get('gitee')) === '', '清除后取不到 Gitee 令牌');
  assert((await store.get('github')) === 'gh-token-xyz', '清除一个平台不影响另一个');

  // 系统密钥不可用：不写明文、不报异常
  const unsafeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'glimnote-cred-nokey-'));
  const unsafe = createCredentialStore({ dir: unsafeDir, safeStorage: fakeSafeStorage(false) });
  assert(unsafe.available() === false, '系统密钥不可用时 available() 为 false');
  assert((await unsafe.set('gitee', 'secret')) === false, '不可用时保存直接返回 false');
  assert((await unsafe.get('gitee')) === '', '不可用时读不到令牌');
  const files = await fsp.readdir(unsafeDir).catch(() => []);
  assert(files.length === 0, '不可用时不会退化成明文文件');

  // 文件损坏：当没有，不崩
  await fsp.writeFile(path.join(dir, 'credentials.bin'), Buffer.from('broken', 'utf8'));
  assert((await store.get('github')) === '', '密文损坏时返回空串');
  assert(
    logs.some((l) => l.startsWith('warn:')),
    '损坏时留下一条警告日志',
  );

  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.rm(unsafeDir, { recursive: true, force: true });
  console.log('\n全部通过');
})().catch((e) => {
  console.error('\n测试失败：', e.message);
  process.exitCode = 1;
});
