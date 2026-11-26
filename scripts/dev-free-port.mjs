/**
 * electron:dev 启动前的端口清理。
 *
 * 开发时关窗口默认只是收进托盘，Electron 和 concurrently 拉起的 Vite 都还活着；
 * 再执行一次 npm run electron:dev 就会撞上「Port 5174 is already in use」。
 * 这里把「属于本仓库」的旧 Vite / Electron 开发进程结束掉，再让新的开发服务启动；
 * 如果 5174 被别的程序占着，只报告，不乱杀。
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = 5174;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = repoRoot.replace(/\\/g, '/').toLowerCase();

if (process.platform !== 'win32') {
  // macOS / Linux 下端口冲突很少见，保留原来的直接启动行为
  process.exit(0);
}

function run(cmd, args) {
  try {
    return execFileSync(cmd, args, {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch {
    return '';
  }
}

function powershell(script) {
  return run('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    script,
  ]);
}

function listeningPids() {
  // 不带 -p tcp：Vite 绑定 localhost 时可能只监听 [::1]，TCPv6 行也要算进来
  const out = run('netstat', ['-ano']);
  const pids = new Set();
  for (const line of out.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    // 只看本地端口，避免把 51740、15174 之类误判进来
    if (cols[0]?.toUpperCase() !== 'TCP' || !/LISTENING/i.test(line)) continue;
    const local = cols[1] || '';
    if (Number(local.slice(local.lastIndexOf(':') + 1)) !== PORT) continue;
    const pid = Number(cols[cols.length - 1]);
    if (Number.isFinite(pid)) pids.add(pid);
  }
  return [...pids];
}

function commandLineOf(pid) {
  return powershell(`(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`).trim();
}

function devElectronPids() {
  const out = powershell(
    `Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress`,
  );
  if (!out.trim()) return [];
  try {
    const parsed = JSON.parse(out);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list
      .filter((p) => {
        const cmd = String(p.CommandLine || '').replace(/\\/g, '/').toLowerCase();
        return cmd.includes(repo) && cmd.includes('--dev');
      })
      .map((p) => Number(p.ProcessId))
      .filter((pid) => Number.isFinite(pid));
  } catch {
    return [];
  }
}

function killTree(pid, why) {
  run('taskkill', ['/PID', String(pid), '/T', '/F']);
  console.log(`[dev] ${why}，已结束进程 ${pid}`);
}

function sleep(ms) {
  const shared = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(shared), 0, 0, ms);
}

const busy = listeningPids();
const foreign = [];
for (const pid of busy) {
  if (commandLineOf(pid).replace(/\\/g, '/').toLowerCase().includes(repo)) {
    killTree(pid, `端口 ${PORT} 被上次的开发服务占用`);
  } else {
    foreign.push(pid);
  }
}
if (foreign.length) {
  console.error(`[dev] 端口 ${PORT} 被其他程序占用（PID ${foreign.join(', ')}），为避免误杀已停止启动。`);
  console.error(`[dev] 请关闭它，或执行：taskkill /PID <进程号> /T /F`);
  process.exit(1);
}

// 端口空着也可能有残留的 Electron 停在托盘：单实例锁会让新实例直接退出
for (const pid of devElectronPids()) killTree(pid, '结束上次残留的开发窗口');

// taskkill 返回后端口通常还要几十毫秒才真正释放
const deadline = Date.now() + 6000;
while (listeningPids().length && Date.now() < deadline) sleep(200);
if (listeningPids().length) {
  console.error(`[dev] 端口 ${PORT} 仍未释放，请检查：netstat -ano | findstr :${PORT}`);
  process.exit(1);
}
