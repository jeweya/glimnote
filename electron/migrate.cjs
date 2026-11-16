const path = require('node:path');
const fsp = require('node:fs/promises');

/**
 * 笔记存储位置迁移（用户在「设置 → 常规」里主动换目录时调用）。
 * 品牌改名不在这里做兼容迁移：项目仍在开发阶段，旧目录由用户自行清理。
 */

/**
 * 统计目录里的文件数与总字节数。迁移后用它比对，确认复制完整再删旧目录。
 */
async function treeStats(dir) {
  let files = 0;
  let bytes = 0;
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = await treeStats(full);
      files += sub.files;
      bytes += sub.bytes;
    } else if (entry.isFile()) {
      const st = await fsp.stat(full).catch(() => null);
      if (!st) continue;
      files += 1;
      bytes += st.size;
    }
  }
  return { files, bytes };
}

/**
 * 把笔记仓库从 from 整体搬到 to（用户主动改存储位置时调用）。
 * 目标必须不存在或为空，避免把两台设备的笔记混在一起。
 * 复制完先比对文件数与字节数，一致才删旧目录；不一致直接报错，旧数据原样保留。
 */
async function moveRepoDir({ from, to, log = () => {} }) {
  const src = path.resolve(String(from || ''));
  const dst = path.resolve(String(to || ''));
  if (!from || !to) throw new Error('位置不能为空');
  if (src === dst) return { moved: false, path: dst, files: 0 };
  if (dst.startsWith(src + path.sep) || src.startsWith(dst + path.sep)) {
    throw new Error('新位置不能是当前笔记文件夹的子目录或上级目录，请换一个并列的文件夹');
  }

  const srcStat = await fsp.stat(src).catch(() => null);
  if (!srcStat || !srcStat.isDirectory()) throw new Error('原文件夹不存在，无法迁移');

  const dstStat = await fsp.stat(dst).catch(() => null);
  if (dstStat) {
    if (!dstStat.isDirectory()) throw new Error('目标位置已经有一个同名文件，请换一个文件夹');
    const entries = await fsp.readdir(dst).catch(() => []);
    if (entries.length) throw new Error('目标文件夹不是空的，请换一个空文件夹');
  }

  const before = await treeStats(src);
  await fsp.mkdir(dst, { recursive: true });
  try {
    await fsp.cp(src, dst, { recursive: true, force: false, errorOnExist: false });
  } catch (e) {
    await fsp.rm(dst, { recursive: true, force: true }).catch(() => {});
    throw new Error(`复制失败：${(e && e.message) || e}`);
  }

  const after = await treeStats(dst);
  if (after.files !== before.files || after.bytes !== before.bytes) {
    await fsp.rm(dst, { recursive: true, force: true }).catch(() => {});
    throw new Error('复制校验没有通过，旧数据已原样保留，请重试');
  }

  await fsp.rm(src, { recursive: true, force: true }).catch((e) => {
    log('warn', `旧笔记目录删除失败，可手动清理：${(e && e.message) || e}`);
  });
  log('info', `笔记存储位置已迁移到 ${dst}（${after.files} 个文件 · ${Math.round(after.bytes / 1024)} KB）`);
  return { moved: true, path: dst, files: after.files };
}

module.exports = { moveRepoDir, treeStats };
