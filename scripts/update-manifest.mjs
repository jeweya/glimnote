#!/usr/bin/env node
/**
 * 生成 electron-updater 需要的 latest.yml。
 *
 * 用法（先打出安装包，再运行）：
 *   npm run release:manifest
 *   node scripts/update-manifest.mjs --installer release/Glimnote-Setup-0.1.1.exe
 *
 * 发版时把 latest.yml 和安装包一起传到 GitCode Release 的同一个 tag（如 v0.1.1）。
 * 客户端先查 GitCode API 拿最新 tag，再从该 tag 的下载目录读取 latest.yml，
 * 最后按里面的文件名下载安装包。
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

function argValue(name) {
  const prefix = `--${name}=`;
  const hit = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  if (hit) return hit.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : '';
}

async function hashFile(file, algorithm) {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest();
}

const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const version = String(pkg.version || '').trim();
if (!version) {
  console.error('package.json 里没有 version，先补上再发版。');
  process.exit(1);
}

const installer = argValue('installer') || path.join('release', `Glimnote-Setup-${version}.exe`);
const installerPath = path.resolve(root, installer);

let stat;
try {
  stat = await fs.stat(installerPath);
} catch {
  console.error(`找不到安装包：${installerPath}`);
  console.error(`先打包 0.1.0 这种版本号一致的安装包，或用 --installer 指定路径。`);
  process.exit(1);
}
if (!stat.isFile() || stat.size < 1024 * 1024) {
  console.error(`安装包看起来不完整（${stat.size} 字节）：${installerPath}`);
  process.exit(1);
}

const fileName = path.basename(installerPath);
const [sha512, sha256] = await Promise.all([hashFile(installerPath, 'sha512'), hashFile(installerPath, 'sha256')]);
const sha512Base64 = sha512.toString('base64');
const releaseDate = new Date().toISOString();

const latest = [
  `version: ${version}`,
  'files:',
  `  - url: ${fileName}`,
  `    sha512: ${sha512Base64}`,
  `    size: ${stat.size}`,
  `path: ${fileName}`,
  `sha512: ${sha512Base64}`,
  `releaseDate: '${releaseDate}'`,
  '',
].join('\n');

const output = path.join(root, 'release', 'latest.yml');
await fs.writeFile(output, latest, 'utf8');

console.log(`已生成 ${path.relative(root, output)}`);
console.log(`  版本：${version}`);
console.log(`  文件：${fileName}（${stat.size} 字节）`);
console.log(`  SHA-512：${sha512Base64}`);
console.log(`  SHA-256：${sha256.toString('hex')}`);
console.log('');
console.log(`下一步：在 GitCode 建一个 Release，tag 用 v${version}，上传这两个文件：`);
console.log(`  ${installer}`);
console.log(`  ${path.relative(root, output)}`);
console.log('');
console.log('发布后客户端会从下面的目录读取更新：');
console.log(`  https://gitcode.com/jewey/glimnote/releases/download/v${version}/latest.yml`);
