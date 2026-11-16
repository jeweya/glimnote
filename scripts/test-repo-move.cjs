/**
 * 迁移存储位置的单元测试：用临时目录模拟真实笔记仓库。
 * 跑法：node scripts/test-repo-move.cjs
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');
const { moveRepoDir, treeStats } = require('../electron/migrate.cjs');

async function write(dir, rel, text) {
  const full = path.join(dir, rel);
  await fsp.mkdir(path.dirname(full), { recursive: true });
  await fsp.writeFile(full, text);
}

(async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'glimnote-move-'));
  const from = path.join(base, 'old', 'glimnote');
  const to = path.join(base, 'new', 'glimnote');

  await write(from, 'notes/工作/周报.md', '# 周报\n');
  await write(from, 'notes/inbox/想法.md', '想法\n');
  await write(from, 'assets/2026/10/a.png', Buffer.from([137, 80, 78, 71]));
  await write(from, '.git/config', '[core]\n');
  await fsp.mkdir(path.join(from, '.git/objects'), { recursive: true });

  const before = await treeStats(from);
  const res = await moveRepoDir({ from, to });
  assert.equal(res.moved, true);
  assert.equal(res.files, before.files);
  assert.equal(await fsp.readFile(path.join(to, 'notes/工作/周报.md'), 'utf8'), '# 周报\n');
  assert.equal(await fsp.readFile(path.join(to, '.git/config'), 'utf8'), '[core]\n');
  assert.equal(await fsp.stat(from).catch(() => null), null, '旧目录应已删除');

  // 目标非空必须拒绝，且旧数据保持原样
  const from2 = path.join(base, 'old2');
  const to2 = path.join(base, 'taken');
  await write(from2, 'notes/a.md', 'a');
  await write(to2, 'other.txt', 'x');
  await assert.rejects(() => moveRepoDir({ from: from2, to: to2 }), /不是空/);
  assert.ok(fs.existsSync(path.join(from2, 'notes/a.md')), '失败时旧数据必须还在');
  assert.ok(fs.existsSync(path.join(to2, 'other.txt')), '目标里的内容不能被删');

  // 子目录 / 上级目录要拦住，否则会递归复制自己
  await assert.rejects(() => moveRepoDir({ from: from2, to: path.join(from2, 'sub') }), /子目录/);
  await assert.rejects(() => moveRepoDir({ from: path.join(base, 'old/new/glimnote'), to: base }), /子目录|上级/);

  // 同一位置是空操作
  const same = await moveRepoDir({ from: from2, to: from2 });
  assert.equal(same.moved, false);

  await fsp.rm(base, { recursive: true, force: true });
  console.log('ALL REPO MOVE TESTS PASSED');
})().catch((e) => {
  console.error('FAILED', e);
  process.exit(1);
});
