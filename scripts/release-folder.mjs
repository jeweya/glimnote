#!/usr/bin/env node
/**
 * 把安装包和 latest.yml 收进版本文件夹，一个版本一个目录：
 *   release/v0.1.8/Glimnote-Setup-0.1.8.exe
 *   release/v0.1.8/latest.yml
 *   release/v0.1.8/更新说明.md   ← 从根目录 CHANGELOG.md 的对应版本小节提取
 *
 * 用法：
 *   npm run release:folder           # 整理 package.json 当前版本
 *   npm run release:folder -- --all  # 顺手把 release/ 根目录下所有旧安装包也归档
 *
 * 发版时直接把 release/vX.Y.Z/ 里的两个文件传到 GitCode 同名 tag 即可。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const releaseDir = path.join(root, 'release');
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const version = String(pkg.version || '').trim();
if (!version) {
  console.error('package.json 里没有 version，先补上再归档。');
  process.exit(1);
}

/** 从 CHANGELOG.md 里取出某个版本的小节；没有写就返回空串，由调用方提示 */
async function notesFor(ver) {
  let md = '';
  try {
    md = await fs.readFile(path.join(root, 'CHANGELOG.md'), 'utf8');
  } catch {
    return '';
  }
  const lines = md.split(/\r?\n/);
  const head = new RegExp(`^##\\s+v?${ver.replace(/\./g, '\\.')}\\s*$`);
  let start = -1;
  let end = lines.length;
  for (let i = 0; i < lines.length; i += 1) {
    if (start < 0) {
      if (head.test(lines[i])) start = i + 1;
    } else if (/^##\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return start < 0 ? '' : lines.slice(start, end).join('\n').trim();
}

async function writeNotes(ver) {
  const body = await notesFor(ver);
  const dir = path.join(releaseDir, `v${ver}`);
  await fs.mkdir(dir, { recursive: true });
  if (!body) {
    console.warn(`  ! CHANGELOG.md 里没有 ${ver} 的内容，release/v${ver}/更新说明.md 未生成`);
    return;
  }
  const text = `# 萤光笔记 ${ver} 更新说明\n\n${body}\n`;
  await fs.writeFile(path.join(dir, '更新说明.md'), text, 'utf8');
  console.log(`  CHANGELOG.md -> release/v${ver}/更新说明.md`);
}

async function moveInto(file, ver) {
  const dir = path.join(releaseDir, `v${ver}`);
  await fs.mkdir(dir, { recursive: true });
  const dest = path.join(dir, path.basename(file));
  try {
    await fs.rename(file, dest);
  } catch {
    // 跨盘或文件被占用时退回「复制后删除」
    await fs.copyFile(file, dest);
    await fs.unlink(file);
  }
  console.log(`  ${path.basename(file)} -> release/v${ver}/`);
}

const all = process.argv.includes('--all');
if (all) {
  for (const name of await fs.readdir(releaseDir)) {
    const hit = /^Glimnote-Setup-(.+)\.exe$/i.exec(name);
    if (!hit) continue;
    await moveInto(path.join(releaseDir, name), hit[1]);
    await writeNotes(hit[1]);
  }
}

for (const name of [`Glimnote-Setup-${version}.exe`, 'latest.yml']) {
  const file = path.join(releaseDir, name);
  try {
    await fs.access(file);
    await moveInto(file, version);
  } catch {
    // 这个版本还没生成对应文件，跳过
  }
}

await writeNotes(version);

console.log('');
console.log(`归档完成：release/v${version}/`);
console.log('发版时上传这个文件夹里的安装包、latest.yml 和更新说明.md 即可。');
