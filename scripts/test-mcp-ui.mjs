/**
 * 设置 → 集成（MCP）网页版走查：只展示 HTTP 配置、状态卡、复制。
 * 运行：node scripts/test-mcp-ui.mjs [dist] [port] [shots]（先 npm run build）
 */
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

const root = resolve(process.argv[2] || 'dist');
const port = Number(process.argv[3] || 4340);
const shots = resolve(process.argv[4] || 'shots');
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

const server = createServer(async (req, res) => {
  const url = (req.url || '/').split('?')[0];
  let file = join(root, url);
  if (!existsSync(file) || url === '/') file = join(root, 'index.html');
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise((r) => server.listen(port, '127.0.0.1', r));
await mkdir(shots, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1280, height: 860 },
  permissions: ['clipboard-read', 'clipboard-write'],
});
await context.addInitScript(() => {
  try {
    localStorage.setItem('glimnote.syncPrompt.off', '1');
    localStorage.setItem('glimnote.theme', 'light');
  } catch {}
});
const page = await context.newPage();
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(String(e)));
const assert = (cond, msg) => {
  if (!cond) throw new Error(`断言失败：${msg}`);
  console.log(`  ✓ ${msg}`);
};

try {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.app');
  await page.locator('.side-item', { hasText: '设置' }).click();
  await page.waitForSelector('.settings-body');
  await page.locator('.settings-tab', { hasText: '集成' }).click();
  await page.waitForSelector('.mcp-card');
  await page.waitForTimeout(350);

  const bodyText = await page.locator('.settings-body').innerText();
  assert(!bodyText.includes('glimnote-mcp.cmd'), '界面不再出现 stdio 启动命令');
  assert(!bodyText.includes('glimnote-mcp-http.cmd'), '界面不再出现 HTTP 的 .cmd 启动器');
  assert((await page.locator('.mcp-no').count()) === 0, '不再有三步编号');

  const json = await page.locator('.mcp-json pre').innerText();
  assert(json.includes('"url": "http://127.0.0.1:8765/mcp"'), '配置只有 url 一种接法');
  assert(!json.includes('"command"'), '配置里没有 command/std——只留 HTTP');

  assert((await page.locator('.mcp-card-title').innerText()) === '仅桌面端可用', '网页版状态写明仅桌面端可用');
  assert((await page.locator('.mcp-card .switch').count()) === 0, '网页版不显示服务开关');
  assert((await page.locator('.mcp-dot.on').count()) === 0, '网页版状态点是熄灭的');

  const card = await page.locator('.mcp-card').boundingBox();
  const pre = await page.locator('.mcp-json pre').boundingBox();
  assert(card && pre && pre.width <= card.width - 30, '配置块不溢出卡片');
  assert(pre.height >= 35 && pre.height <= 80, '三行 JSON 的高度正常（无多余空行）');

  await page.locator('.mcp-copy').click();
  await page.waitForTimeout(200);
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  assert(clip === json, '复制按钮写入的内容与展示一致');
  assert((await page.locator('.mcp-copy').innerText()).includes('已复制'), '复制后按钮有反馈');

  await page.screenshot({ path: join(shots, 'mcp-1280.png') });

  await page.setViewportSize({ width: 960, height: 800 });
  await page.waitForTimeout(400);
  const card960 = await page.locator('.mcp-card').boundingBox();
  const pre960 = await page.locator('.mcp-json pre').boundingBox();
  assert(card960 && pre960 && pre960.width <= card960.width - 30, '960 宽下配置块仍不溢出');
  assert(pre960.height <= 80, '960 宽下 JSON 仍保持三行');
  await page.screenshot({ path: join(shots, 'mcp-960.png') });

  console.log('\n控制台错误：', errors.length ? errors : '无');
  console.log('全部通过');
} catch (e) {
  await page.screenshot({ path: join(shots, '99-failure.png') });
  console.error('\n测试失败：', e.message);
  console.error('控制台错误：', errors);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
