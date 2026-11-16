/**
 * 主进程日志文件。
 *
 * 为什么要有它：界面上的「运行日志」只存在 localStorage 里，最多 300 条，关掉应用就没了，
 * 用户遇到同步 / 连接问题时往往来不及导出。这里把同样的日志按天写进磁盘，
 * 出问题后可以直接打开文件夹把当天文件发过来。
 *
 * 约定：
 * - 位置：<userData>/logs/glimnote-YYYY-MM-DD.log（Windows 下就是 %APPDATA%/glimnote/logs）
 * - 每行 `ISO 时间  [级别]  作用域: 内容`，与界面导出的格式一致
 * - 单日上限 5MB，超出后停止写当天文件并留一行提示，避免日志把磁盘写满
 * - 只保留最近 7 个文件，启动时和跨天时清理
 * - 全部写失败都吞掉：日志不能反过来拖垮应用（写不出来就算了，最多 console.warn）
 */

const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');

const KEEP_FILES = 7;
const MAX_BYTES = 5 * 1024 * 1024;
const FLUSH_DELAY = 400;
// glimnote-2026-10-30.log
const NAME_RE = /^glimnote-(\d{4}-\d{2}-\d{2})\.log$/;

let dir = '';
let day = ''; // 当前写入的日期，跨天自动换文件
let bytes = 0; // 当天已写字节数，用于体积上限
let ready = false;
let pending = '';
let timer = null;
let flushing = false;
let overflowed = false;

function dayKey(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function fileOf(key) {
  return path.join(dir, `glimnote-${key}.log`);
}

/** 主进程里直接拼一行，格式与渲染进程 log.ts 保持一致 */
function format(scope, level, msg) {
  const text = String(msg == null ? '' : msg).replace(/\r?\n/g, ' ⏎ ');
  return `${new Date().toISOString()}  [${level}]  ${scope}: ${text.slice(0, 2000)}`;
}

/** 只删除自己写的、超出保留天数的日志；文件夹里别的东西一律不碰 */
async function prune() {
  try {
    const names = await fsp.readdir(dir);
    const logs = names.filter((n) => NAME_RE.test(n)).sort();
    const stale = logs.slice(0, Math.max(0, logs.length - KEEP_FILES));
    for (const name of stale) {
      await fsp.unlink(path.join(dir, name)).catch(() => {});
    }
  } catch {
    /* 目录还没建好就下次再说 */
  }
}

/** 换日时重置体积计数 */
async function useDay(key) {
  day = key;
  bytes = 0;
  overflowed = false;
  try {
    const stat = await fsp.stat(fileOf(key));
    bytes = stat.size;
  } catch {
    bytes = 0;
  }
  if (bytes > MAX_BYTES) overflowed = true;
}

function schedule() {
  if (timer || flushing) return;
  timer = setTimeout(() => {
    timer = null;
    void flush();
  }, FLUSH_DELAY);
  if (typeof timer.unref === 'function') timer.unref();
}

async function flush() {
  if (flushing || !pending) return;
  flushing = true;
  const key = dayKey();
  try {
    if (!ready) {
      await fsp.mkdir(dir, { recursive: true });
      ready = true;
      await prune();
    }
    if (key !== day) await useDay(key);
    const chunk = pending;
    pending = '';
    if (!chunk) return;
    if (overflowed || bytes > MAX_BYTES) {
      if (!overflowed) {
        overflowed = true;
        pending = '';
      }
      return;
    }
    await fsp.appendFile(fileOf(day), chunk, 'utf8');
    bytes += Buffer.byteLength(chunk, 'utf8');
    if (bytes > MAX_BYTES) {
      const note = format('log', 'warn', '当天日志超过 5MB，暂停写入，后续日志请看界面里的「导出日志」');
      await fsp.appendFile(fileOf(day), note + '\n', 'utf8').catch(() => {});
    }
  } catch (e) {
    // 日志写入失败不影响应用；下一批会重新尝试
    console.warn('write log file failed', e && e.message);
  } finally {
    flushing = false;
    if (pending) schedule();
  }
}

/**
 * 安装器允许用户指定日志目录（写在程序目录的 log-dir.txt 里）。
 * 覆盖只影响日志，不改变工作区结构；所以单独存一份，切工作区重建时还能继续用。
 */
let dirOverride = '';

function setDirOverride(value) {
  dirOverride = typeof value === 'string' ? value.trim() : '';
}

function init(userDataDir) {
  dir = dirOverride || path.join(userDataDir, 'logs');
  ready = false;
  day = '';
  bytes = 0;
}

function logDir() {
  return dir;
}

/** 追加一行（scope / level 与界面日志一致） */
function write(scope, level, msg) {
  if (!dir) return;
  pending += format(scope, level, msg) + '\n';
  schedule();
}

/** 追加一段已经格式化好的文本（渲染进程批量上报的日志） */
function writeRaw(text) {
  if (!dir || !text) return;
  const body = String(text).slice(-200 * 1024);
  pending += body.endsWith('\n') ? body : body + '\n';
  schedule();
  if (pending.length > 1024 * 1024) void flush();
}

/** 退出前尽量把缓冲写出去（同步写，避免进程结束丢失） */
function flushSync() {
  if (!dir || !pending) return;
  const chunk = pending;
  pending = '';
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(fileOf(dayKey()), chunk, 'utf8');
  } catch {
    /* 关窗阶段写不进去就算了 */
  }
}

/** 注册 IPC：渲染进程上报日志 / 打开日志文件夹 / 查询路径 */
function registerLogHandlers(ipcMain, shell) {
  ipcMain.handle('log:append', (_e, text) => {
    writeRaw(text);
    return true;
  });
  ipcMain.handle('log:path', () => ({ dir: logDir(), file: fileOf(dayKey()) }));
  ipcMain.handle('log:open', async () => {
    try {
      await fsp.mkdir(logDir(), { recursive: true });
      // 先落盘再打开，用户进文件夹能立刻看到当天文件
      await flush();
      await shell.openPath(logDir());
      return true;
    } catch (e) {
      return { error: String((e && e.message) || e).slice(0, 160) };
    }
  });
}

module.exports = { init, setDirOverride, logDir, write, writeRaw, flush, flushSync, registerLogHandlers };
