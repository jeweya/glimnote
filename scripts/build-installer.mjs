#!/usr/bin/env node
/**
 * 用 build/installer.nsi 编译 Windows 安装包。
 *
 * 为什么不直接用 electron-builder 的 nsis target：
 * build/installer.nsi 自己定义了 APP_ID，而 electron-builder 打包时还会通过
 * 命令行再传一个 APP_ID，makensis 会报 `!define: "APP_ID" already defined!`
 * 并中止。所以这里先用 `electron-builder --dir` 生成 release/win-unpacked，
 * 再单独调用 makensis 编译自定义安装脚本。
 *
 * 版本号只从 package.json 读，和安装包文件名、程序版本保持同一份来源。
 *
 * 用法：
 *   npm run installer                                   # 已有 win-unpacked 时只重打安装包
 *   node scripts/build-installer.mjs                    # 正常打包，版本取自 package.json
 *   node scripts/build-installer.mjs --version 0.1.22   # 调试用：临时指定版本
 *   node scripts/build-installer.mjs --src release/win-unpacked --out release/Glimnote-Setup-0.1.22.exe
 *
 * makensis 查找顺序：
 *   1. 环境变量 MAKENSIS（文件路径或命令名）
 *   2. PATH 里的 makensis / makensis.exe
 *   3. electron-builder 的 NSIS 缓存
 *   4. Windows 常见的 NSIS 安装目录
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const buildDir = path.join(root, 'build');
const installerScript = path.join(buildDir, 'installer.nsi');

function argValue(name) {
  const prefix = `--${name}=`;
  const hit = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  if (hit) return hit.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] || '' : '';
}

function fail(message) {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

/** 项目内的路径显示成相对路径，项目外的直接显示绝对路径 */
function displayPath(file) {
  const rel = path.relative(root, file);
  return rel && !rel.startsWith('..') ? rel : file;
}

async function isFile(file) {
  try {
    return (await fsp.stat(file)).isFile();
  } catch {
    return false;
  }
}

async function findOnPath(name) {
  const pathEnv = process.env.PATH || process.env.Path || '';
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    if (await isFile(candidate)) return candidate;
  }
  return null;
}

async function findMakensis() {
  const fromEnv = (process.env.MAKENSIS || '').trim();
  if (fromEnv) {
    const direct = path.resolve(fromEnv);
    if (await isFile(direct)) return direct;
    const onPath = await findOnPath(fromEnv);
    if (onPath) return onPath;
    fail(`MAKENSIS 指向的文件不存在：${fromEnv}`);
  }

  const exe = process.platform === 'win32' ? 'makensis.exe' : 'makensis';
  const onPath = await findOnPath(exe);
  if (onPath) return onPath;

  const candidates = [];

  // electron-builder 第一次打 NSIS 包时会把官方 NSIS 解到缓存里，直接复用
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    const cacheDir = path.join(localAppData, 'electron-builder', 'Cache', 'nsis');
    try {
      const dirs = (await fsp.readdir(cacheDir))
        .filter((name) => name.startsWith('nsis-'))
        .sort()
        .reverse();
      for (const name of dirs) {
        candidates.push(path.join(cacheDir, name, 'Bin', exe));
        candidates.push(path.join(cacheDir, name, exe));
      }
    } catch {
      // 没有缓存就继续找别的
    }
  }

  for (const base of [process.env['ProgramFiles(x86)'], process.env.ProgramFiles]) {
    if (base) candidates.push(path.join(base, 'NSIS', exe));
  }
  if (process.platform !== 'win32') {
    candidates.push('/usr/bin/makensis', '/usr/local/bin/makensis', '/opt/nsis/bin/makensis');
  }

  for (const candidate of candidates) {
    if (await isFile(candidate)) return candidate;
  }
  return null;
}

if (!(await isFile(installerScript))) {
  fail(`找不到安装脚本：${path.relative(root, installerScript)}`);
}

const pkg = JSON.parse(await fsp.readFile(path.join(root, 'package.json'), 'utf8'));
const version = (argValue('version') || String(pkg.version || '')).trim();
if (!version) fail('package.json 里没有 version，先补上再打包。');

// VIProductVersion 只接受四段纯数字，预发版 0.1.22-beta.1 取 0.1.22
const versionNum = version.replace(/-.*$/, '');
if (!/^\d+\.\d+\.\d+$/.test(versionNum)) {
  fail(`版本号 ${version} 不能用于 VIProductVersion，需要 x.y.z 形式。`);
}

const srcDir = path.resolve(root, argValue('src') || path.join('release', 'win-unpacked'));
const outFile = path.resolve(root, argValue('out') || path.join('release', `Glimnote-Setup-${version}.exe`));

if (!(await isFile(path.join(srcDir, 'Glimnote.exe')))) {
  fail(
    `解包目录里没有 Glimnote.exe：${srcDir}\n` +
      '  先执行 electron-builder --win --x64 --dir 生成 release/win-unpacked。',
  );
}

const makensis = await findMakensis();
if (!makensis) {
  fail(
    '找不到 makensis（NSIS 编译器）。\n' +
      '  可以装一个 NSIS 3.x（Unicode 版），或设置 MAKENSIS 环境变量指向 makensis.exe。\n' +
      '  跑过 npx electron-builder --win nsis 之后，缓存里通常也会留一份。',
  );
}

await fsp.mkdir(path.dirname(outFile), { recursive: true });

console.log(`\n编译安装包 Glimnote ${version}`);
console.log(`  makensis：${makensis}`);
console.log(`  解包目录：${displayPath(srcDir)}`);
console.log(`  输出文件：${displayPath(outFile)}\n`);

const args = [
  '-V1',
  // 脚本是 UTF-8（带 BOM）：显式声明输入编码，避免 Windows 上 NSIS 按系统 ANSI
  // 代码页（中文环境为 GBK）解析中文文案时报 “Bad text encoding”
  '-INPUTCHARSET',
  'UTF8',
  `-DAPP_VERSION=${version}`,
  `-DAPP_VERSION_NUM=${versionNum}`,
  `-DSRC_DIR=${srcDir}`,
  `-DOUTFILE=${outFile}`,
  'installer.nsi',
];

const exitCode = await new Promise((resolve) => {
  // cwd 用 build/：installer.nsi 里的 MUI_ICON "icon.ico" 是相对路径
  const child = spawn(makensis, args, { cwd: buildDir, stdio: 'inherit' });
  child.on('error', (error) => {
    console.error(`\n启动 makensis 失败：${error.message}`);
    resolve(-1);
  });
  child.on('close', (code) => resolve(code ?? -1));
});

if (exitCode !== 0) fail(`makensis 退出码 ${exitCode}，安装包没有生成。`);

let stat;
try {
  stat = await fsp.stat(outFile);
} catch {
  fail(`makensis 报告成功，但没有找到 ${path.relative(root, outFile)}。`);
}
if (!stat.isFile() || stat.size < 1024 * 1024) {
  fail(`安装包看起来不完整（${stat.size} 字节）。`);
}

console.log(`\n✓ 安装包已生成：${displayPath(outFile)}（${(stat.size / 1024 / 1024).toFixed(1)} MB）`);
console.log('  下一步：npm run release:manifest && npm run release:verify && npm run release:folder');
