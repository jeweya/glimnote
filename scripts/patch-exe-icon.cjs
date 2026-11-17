#!/usr/bin/env node
/**
 * 给已经解包的 Windows 可执行文件换图标、补版本信息（不需要 wine）。
 *
 * `electron-builder` 在 Windows 上打包时会自动用 `build/icon.ico` 改 exe 图标，
 * 并把产品名 / 版本号写进文件属性；在 Linux 里手动打包（asar pack + makensis）时
 * 没有 rcedit / wine，这里直接用 electron-builder 自带的 resedit 改写 PE 资源，
 * 免得程序图标还是 Electron 的、属性里显示「Electron / GitHub, Inc.」。
 *
 * 用法：
 *   node scripts/patch-exe-icon.cjs [exe 路径] [ico 路径]
 * 默认：release/win-unpacked/Glimnote.exe ← build/icon.ico
 */
const fs = require('fs');
const path = require('path');
const { NtExecutable, NtExecutableResource, Resource, Data } = require('resedit');

const root = path.join(__dirname, '..');
const exePath = process.argv[2] || path.join(root, 'release', 'win-unpacked', 'Glimnote.exe');
const icoPath = process.argv[3] || path.join(root, 'build', 'icon.ico');

if (!fs.existsSync(exePath)) throw new Error(`找不到可执行文件：${exePath}`);
if (!fs.existsSync(icoPath)) throw new Error(`找不到图标文件：${icoPath}`);

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = String(pkg.version || '').trim() || '0.0.0';
// Windows 的 FileVersion / ProductVersion 必须是纯数字，预发版去掉 -beta.1 后缀
const numericVersion = (version.match(/\d+(?:\.\d+){0,3}/) || ['0.0.0'])[0];

const exe = NtExecutable.from(fs.readFileSync(exePath), { ignoreCert: true });
const res = NtExecutableResource.from(exe);
const ico = Data.IconFile.from(fs.readFileSync(icoPath));

// 1. 图标：沿用已有的图标组 id / 语言，没有就按最常见的 1 / 1033 新建
const groups = Resource.IconGroupEntry.fromEntries(res.entries);
const iconGroupID = groups.length > 0 ? groups[0].id : 1;
const lang = groups.length > 0 ? groups[0].lang : 1033;

Resource.IconGroupEntry.replaceIconsForResource(
  res.entries,
  iconGroupID,
  lang,
  ico.icons.map((item) => item.data),
);

// 2. 版本信息：Electron 默认资源会让「属性」里显示 Electron / GitHub, Inc.
const infos = Resource.VersionInfo.fromEntries(res.entries);
if (infos.length > 0) {
  const info = infos[0];
  const language = info.getAllLanguagesForStringValues()[0] || { lang: 1033, codepage: 1200 };
  info.setStringValues(language, {
    FileDescription: '萤光笔记 Glimnote',
    ProductName: 'Glimnote',
    CompanyName: 'Glimnote contributors',
    LegalCopyright: 'Copyright © 2026 萤光笔记 Glimnote',
    InternalName: 'Glimnote',
    OriginalFilename: 'Glimnote.exe',
  });
  info.setFileVersion(`${numericVersion}.0`, language.lang);
  info.setProductVersion(`${numericVersion}.0`, language.lang);
  info.outputToResourceEntries(res.entries);
}

res.outputResource(exe);

const out = Buffer.from(exe.generate());
fs.writeFileSync(exePath, out);
console.log(
  `已更新 ${path.relative(root, exePath)}：图标 ${ico.icons.length} 个尺寸，版本 ${version}，${out.length} 字节`,
);
