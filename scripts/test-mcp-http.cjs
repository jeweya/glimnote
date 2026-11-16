/**
 * 单测 electron/mcp-http.cjs：用真实 node 拉起 mcp/server.mjs，走一遍开关流程。
 * 运行：node scripts/test-mcp-http.cjs（不需要打包，也不需要 Electron）
 */
const path = require('node:path');
const os = require('node:os');
const fsp = require('node:fs/promises');
const { createMcpHttpController } = require('../electron/mcp-http.cjs');

const SERVER = path.join(__dirname, '..', 'mcp', 'server.mjs');
const PORT = Number(process.env.MCP_TEST_PORT || 4399);

const assert = (cond, msg) => {
  if (!cond) throw new Error(`断言失败：${msg}`);
  console.log(`  ✓ ${msg}`);
};

async function health(url) {
  const res = await fetch(url.replace(/\/mcp$/, '/health'), { signal: AbortSignal.timeout(2500) });
  return res.json();
}

(async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mcp-http-'));
  const logs = [];
  const ctl = createMcpHttpController({
    execPath: process.execPath,
    serverPath: SERVER,
    getRoot: () => root,
    port: PORT,
    log: (level, msg) => logs.push(`${level}:${msg}`),
  });

  const s0 = ctl.state();
  assert(s0.running === false && s0.error === '', '初始状态：未运行、无错误');
  assert(s0.url === `http://127.0.0.1:${PORT}/mcp`, 'url 指向回环地址的 /mcp');

  ctl.setWanted(true);
  const s1 = await ctl.start();
  assert(s1.running === true, 'start 后状态为运行中');
  const h = await health(s1.url);
  assert(h.ok === true && h.transport === 'http', '/health 返回 ok 且是 HTTP 传输');
  assert(h.root === root, '/health 的根目录就是传入的笔记目录');
  assert(
    logs.some((l) => l.includes('HTTP 模式已启动')),
    '子进程日志被转发出来',
  );

  const s2 = ctl.stop();
  assert(s2.running === false, 'stop 后状态为未运行');
  await new Promise((r) => setTimeout(r, 300));
  const dead = await fetch(s2.url, { method: 'POST' }).then(
    () => false,
    () => true,
  );
  assert(dead, '停掉后端口不再响应');

  // 端口占用：另起一个同端口的控制器，应把原因带回界面
  const other = createMcpHttpController({
    execPath: process.execPath,
    serverPath: SERVER,
    getRoot: () => root,
    port: PORT,
    waitMs: 1200,
  });
  await ctl.start();
  const s3 = await other.start();
  assert(s3.running === false && /占用/.test(s3.error), '端口被占用时给出中文原因');
  ctl.stop();

  const missing = createMcpHttpController({
    execPath: process.execPath,
    serverPath: path.join(root, 'nope.mjs'),
    getRoot: () => root,
    port: PORT + 1,
    waitMs: 100,
  });
  const s4 = await missing.start();
  assert(s4.running === false && /找不到/.test(s4.error), '脚本缺失时提示重装');

  await fsp.rm(root, { recursive: true, force: true });
  console.log('\n全部通过');
})().catch((e) => {
  console.error('\n测试失败：', e.message);
  process.exitCode = 1;
});
