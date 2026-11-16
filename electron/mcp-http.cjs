/**
 * 内置 MCP HTTP 服务的「拉起 / 停掉 / 报状态」三件事。
 *
 * 客户端只配一个 url 就能连，前提是本机有个常驻服务。以前要用户双击
 * resources/mcp/glimnote-mcp-http.cmd，现在改成应用自己拉起子进程：
 * 设置里的开关 = 启动 / 停止，偏好里记一个值决定下次启动要不要自动开。
 * 子进程用 ELECTRON_RUN_AS_NODE 跑同一个 exe，打包后不要求用户装 Node。
 *
 * 独立成模块是为了能脱离 Electron 单测（见 scripts/test-mcp-http.cjs）。
 */
const { spawn } = require('node:child_process');
const fsp = require('node:fs/promises');

const DEFAULT_PORT = 8765;
const START_WAIT_MS = 700;

/**
 * @param {object} options
 * @param {string} options.execPath  拉起子进程用的可执行文件（Electron 里是 process.execPath）
 * @param {string} options.serverPath mcp/server.mjs 的绝对路径
 * @param {() => string} [options.getRoot] 笔记仓库根目录；用户改位置后要跟着变，所以传函数
 * @param {number} [options.port]
 * @param {(level: string, msg: string) => void} [options.log]
 * @param {number} [options.waitMs] 启动后等多久再回报状态，留给端口绑定失败暴露出来
 */
function createMcpHttpController({
  execPath,
  serverPath,
  getRoot,
  port = DEFAULT_PORT,
  log = () => {},
  waitMs = START_WAIT_MS,
}) {
  let child = null;
  let wanted = false;
  let error = '';

  const root = () => (typeof getRoot === 'function' ? getRoot() : '');
  const running = () => Boolean(child && child.exitCode === null && !child.killed);

  function state() {
    return {
      running: running(),
      wanted,
      port,
      url: `http://127.0.0.1:${port}/mcp`,
      root: root(),
      error,
    };
  }

  function stop() {
    const current = child;
    // 先断开引用：退出回调看到 child 已经不是它，就不会把「主动关闭」误报成崩溃
    child = null;
    if (!current || current.exitCode !== null) return state();
    try {
      current.kill();
    } catch {
      /* 已经退出 */
    }
    return state();
  }

  async function start() {
    if (running()) return state();
    error = '';
    const exists = await fsp.access(serverPath).then(
      () => true,
      () => false,
    );
    if (!exists) {
      error = '找不到 MCP 服务文件，重新安装应用可以恢复';
      return state();
    }
    const args = [serverPath, '--http', '--port', String(port)];
    const dir = root();
    if (dir) args.push('--root', dir);
    let proc;
    try {
      proc = spawn(execPath, args, {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe'],
      });
    } catch (e) {
      error = `MCP 服务启动失败：${(e && e.message) || e}`;
      return state();
    }
    child = proc;
    proc.stderr.on('data', (chunk) => {
      const text = String(chunk).trim();
      if (text) log('info', text.slice(0, 500));
    });
    proc.on('error', (e) => {
      if (child === proc) child = null;
      error = `MCP 服务启动失败：${(e && e.message) || e}`;
    });
    proc.on('exit', (code) => {
      if (child !== proc) return;
      child = null;
      if (code && !error) {
        error = `MCP 服务退出了（错误码 ${code}），端口 ${port} 可能被其它程序占用`;
      }
    });
    // 给它一点时间绑端口：失败时界面能立刻看到原因，而不是先亮一下「运行中」
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    return state();
  }

  return {
    state,
    start,
    stop,
    setWanted(value) {
      wanted = Boolean(value);
    },
    clearError() {
      error = '';
    },
  };
}

module.exports = { createMcpHttpController, DEFAULT_PORT };
