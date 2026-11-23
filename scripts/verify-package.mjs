#!/usr/bin/env node
/**
 * 打包产物校验：在发布安装包之前，确认 app.asar 里真的带上了自动更新组件。
 *
 * 背景：0.1.16 的安装包里 app.asar 只有 dist / electron / package.json，
 * 没有 node_modules，运行时 require('electron-updater') 必然失败，
 * 已经装上的用户就只能手动下载新版本。这个脚本把这种包挡在发布之前。
 *
 * 用法（electron:build 结束会自动执行）：
 *   npm run release:verify
 *   node scripts/verify-package.mjs --asar path/to/app.asar
 *   node scripts/verify-package.mjs --installer release/Glimnote-Setup-0.1.17.exe
 *
 * 校验内容：
 *   1. app.asar 存在，且包含 electron-updater 及其关键运行时依赖；
 *   2. app.asar 内的 package.json 版本与根目录 package.json 一致；
 *   3. 有 latest.yml 时，版本、文件名、大小、sha512 与实际安装包一致。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

function argValue(name) {
  const prefix = `--${name}=`;
  const hit = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  if (hit) return hit.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] || '' : '';
}

const root = path.resolve(argValue('root') || fileURLToPath(new URL('..', import.meta.url)));
const releaseDir = path.join(root, 'release');

function fail(message) {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

function warn(message) {
  console.warn(`  ! ${message}`);
}

function ok(message) {
  console.log(`  ✓ ${message}`);
}

const pkg = JSON.parse(await fsp.readFile(path.join(root, 'package.json'), 'utf8'));
const version = String(pkg.version || '').trim();
if (!version) fail('package.json 里没有 version，无法校验打包产物。');

let asarLib;
try {
  const mod = await import('@electron/asar');
  asarLib = mod.listPackage ? mod : mod.default;
} catch {
  fail('找不到 @electron/asar。先运行 npm install；它通常随 electron-builder 一起安装。');
}

const asarPath = path.resolve(root, argValue('asar') || path.join('release', 'win-unpacked', 'resources', 'app.asar'));
const installerPath = path.resolve(
  root,
  argValue('installer') || path.join('release', `Glimnote-Setup-${version}.exe`),
);

console.log(`\n校验 Glimnote ${version} 打包产物`);
console.log(`  app.asar：${path.relative(root, asarPath)}`);

let stat;
try {
  stat = await fsp.stat(asarPath);
} catch {
  fail(
    `找不到 ${path.relative(root, asarPath)}。\n` +
      '  请先完整执行 electron-builder 打包（npm run electron:build）；' +
      '不要把手工拼出来的 asar 直接当安装包。',
  );
}
if (!stat.isFile() || stat.size < 1024 * 1024) {
  fail(`app.asar 看起来不完整（${stat.size} 字节）。`);
}

let entries;
try {
  entries = asarLib.listPackage(asarPath).map((entry) => {
    const normalized = String(entry).replace(/\\/g, '/');
    return normalized.startsWith('/') ? normalized : `/${normalized}`;
  });
} catch (e) {
  fail(`读不出 app.asar 的文件列表：${(e && e.message) || e}`);
}
ok(`app.asar 可读取，共 ${entries.length} 个条目`);

const exactRequired = [
  ['/electron/main.cjs', 'Electron 主进程'],
  ['/dist/index.html', '前端构建产物'],
  ['/package.json', '应用 package.json'],
];

// electron-builder 会把部分依赖嵌套装在 electron-updater/node_modules 下，
// 所以这里用「路径后缀」匹配，顶层或嵌套都算存在。
const dependencyRequired = [
  ['/node_modules/electron-updater/package.json', '自动更新组件 electron-updater'],
  ['/node_modules/builder-util-runtime/package.json', 'electron-updater 依赖 builder-util-runtime'],
  ['/node_modules/fs-extra/package.json', 'electron-updater 依赖 fs-extra'],
  ['/node_modules/js-yaml/package.json', 'electron-updater 依赖 js-yaml'],
  ['/node_modules/semver/package.json', 'electron-updater 依赖 semver'],
];

const entrySet = new Set(entries);
const missing = [
  ...exactRequired.filter(([file]) => !entrySet.has(file)),
  ...dependencyRequired.filter(([file]) => !entries.some((entry) => entry.endsWith(file))),
];
if (missing.length) {
  console.error('\n✗ app.asar 缺少以下文件，安装后将无法自动更新：');
  for (const [file, label] of missing) console.error(`    - ${file}（${label}）`);
  console.error(
    '\n  最常见的原因是打包时只把 dist、electron、package.json 手工放进了 asar，' +
      '没有带上生产依赖 node_modules。\n' +
      '  请使用 electron-builder 完整打包（npm run electron:build），不要手写 asar。\n',
  );
  process.exit(1);
}
ok('electron-updater 及其关键依赖都在 app.asar 里');

let packagedPkg;
try {
  const raw = asarLib.extractFile(asarPath, 'package.json');
  packagedPkg = JSON.parse(raw.toString('utf8'));
} catch (e) {
  fail(`读不出 app.asar 里的 package.json：${(e && e.message) || e}`);
}
if (packagedPkg.version !== version) {
  fail(`app.asar 里的版本是 ${packagedPkg.version || '(空)'}，和 package.json 的 ${version} 不一致。`);
}
if (packagedPkg.name !== pkg.name) {
  fail(`app.asar 里的应用名是 ${packagedPkg.name || '(空)'}，和 package.json 的 ${pkg.name} 不一致。`);
}
if (packagedPkg.main !== pkg.main) {
  fail(`app.asar 里的入口是 ${packagedPkg.main || '(空)'}，和 package.json 的 ${pkg.main} 不一致。`);
}
ok(`应用版本 / 名称 / 入口与 package.json 一致（${version}）`);

// 安装器版本号统一来自 package.json（打包脚本通过 -DAPP_VERSION 传入），
// 安装脚本里不允许再写死一份，避免两处版本各写各的。
const nsiPath = path.join(root, 'build', 'installer.nsi');
try {
  const nsi = await fsp.readFile(nsiPath, 'utf8');
  const hit = /!define\s+APP_VERSION\s+"([^"]+)"/.exec(nsi);
  if (hit) {
    fail(`build/installer.nsi 里写死了 APP_VERSION ${hit[1]}；版本号只放在 package.json，由打包脚本传给 makensis。`);
  }
  ok('安装器版本号统一取自 package.json');
} catch {
  warn('没读到 build/installer.nsi，跳过安装器版本号检查。');
}

// 安装包本身
let installerStat = null;
try {
  installerStat = await fsp.stat(installerPath);
  if (!installerStat.isFile() || installerStat.size < 1024 * 1024) {
    fail(`安装包看起来不完整（${installerStat.size} 字节）：${path.relative(root, installerPath)}`);
  }
  ok(`安装包存在：${path.relative(root, installerPath)}（${installerStat.size} 字节）`);
} catch {
  warn(
    `没找到 release 根目录下的 ${path.basename(installerPath)}；` +
      `如果安装包已归档到 release/v${version}/，会由 latest.yml 校验覆盖。`,
  );
}

// latest.yml：有就严格比对，避免清单和安装包对不上导致客户端 404 / 校验失败
const manifestCandidates = [path.join(releaseDir, `v${version}`, 'latest.yml'), path.join(releaseDir, 'latest.yml')];
let manifestPath = '';
for (const candidate of manifestCandidates) {
  try {
    await fsp.access(candidate);
    manifestPath = candidate;
    break;
  } catch {
    /* 继续找下一个 */
  }
}

if (!manifestPath) {
  warn('还没有 latest.yml（发版前用 npm run release:manifest 生成），本次先跳过清单校验。');
} else {
  const text = await fsp.readFile(manifestPath, 'utf8');
  const readField = (re) => {
    const hit = re.exec(text);
    return hit ? hit[1].trim() : '';
  };
  const manifestVersion = readField(/^version:\s*(\S+)\s*$/m);
  const fileName = readField(/^\s*-\s*url:\s*(\S+)\s*$/m) || readField(/^path:\s*(\S+)\s*$/m);
  const manifestSize = Number(readField(/^\s*size:\s*(\d+)\s*$/m));
  const manifestSha = readField(/^sha512:\s*(\S+)\s*$/m);
  const relativeManifest = path.relative(root, manifestPath);

  if (!manifestVersion || manifestVersion !== version) {
    fail(`latest.yml（${relativeManifest}）里的版本是 ${manifestVersion || '(空)'}，和 ${version} 不一致。`);
  }
  if (!fileName) fail(`latest.yml（${relativeManifest}）里没有安装包文件名。`);

  const installerCandidates = [
    path.join(path.dirname(manifestPath), fileName),
    path.join(releaseDir, `v${version}`, fileName),
    path.join(releaseDir, fileName),
  ];
  let manifestInstaller = '';
  let manifestInstallerStat = null;
  for (const candidate of installerCandidates) {
    try {
      manifestInstallerStat = await fsp.stat(candidate);
      manifestInstaller = candidate;
      break;
    } catch {
      /* 继续找下一个位置 */
    }
  }
  if (!manifestInstallerStat) {
    fail(`latest.yml 指向的 ${fileName} 不在 release/ 或 release/v${version}/ 下。`);
  }
  if (Number.isFinite(manifestSize) && manifestSize > 0 && manifestInstallerStat.size !== manifestSize) {
    fail(`latest.yml 记录的大小是 ${manifestSize}，实际安装包是 ${manifestInstallerStat.size}。`);
  }
  if (manifestSha) {
    const hash = createHash('sha512');
    for await (const chunk of fs.createReadStream(manifestInstaller)) hash.update(chunk);
    const actual = hash.digest('base64');
    if (actual !== manifestSha) fail('latest.yml 里的 sha512 和实际安装包不一致。');
  }
  ok(`latest.yml 与安装包一致（版本 ${version}，大小 ${manifestInstallerStat.size} 字节）`);
}

console.log('\n✓ 打包产物校验通过，可以发布。\n');
