/**
 * 标题栏同步入口回归：未配置 / 有仓库但缺令牌 / 已连接 三种状态。
 * 运行：node scripts/test-sync-entry.mjs [dist] [port] [shots]（先 npm run build）
 */
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

const root = resolve(process.argv[2] || 'dist');
const port = Number(process.argv[3] || 4388);
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
const assert = (cond, msg) => {
  if (!cond) throw new Error(`断言失败：${msg}`);
  console.log(`  ✓ ${msg}`);
};

async function open(label, setup) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  await context.addInitScript((extra) => {
    try {
      localStorage.setItem('glimnote.syncPrompt.off', '1');
      localStorage.setItem('glimnote.theme', 'light');
      if (extra?.config) localStorage.setItem('glimnote.git.config', JSON.stringify(extra.config));
      if (extra?.token) sessionStorage.setItem('glimnote.git.token', extra.token);
    } catch {}
  }, setup || {});
  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.sync-pill');
  await page.waitForTimeout(400);
  const info = await page.evaluate(() => {
    const pill = document.querySelector('.sync-pill');
    const cta = document.querySelector('.sync-pill-cta');
    const r = pill.getBoundingClientRect();
    return {
      text: pill.innerText.replace(/\s+/g, ' ').trim(),
      setup: pill.classList.contains('setup'),
      ctaVisible: !!(cta && cta.getBoundingClientRect().width > 0),
      ctaText: cta ? cta.innerText.trim() : null,
      h: Math.round(r.height),
      title: pill.getAttribute('title'),
    };
  });
  await page.locator('.titlebar').screenshot({ path: join(shots, `titlebar-${label}.png`) });
  return { context, page, info, errors };
}

async function clickToSettings(t) {
  await t.page.locator('.sync-pill').click();
  await t.page.waitForSelector('.settings-body');
  await t.page.waitForTimeout(300);
  return t.page.evaluate(() => document.querySelector('.settings-tab.on')?.innerText?.trim() || null);
}

try {
  /* 1. 全新用户：胶囊是入口 */
  const a = await open('new-user');
  assert(a.info.setup === true, '未配置时胶囊处于 setup 态');
  assert(a.info.ctaVisible === true, '未配置时能看到引导按钮');
  assert(a.info.ctaText === '开启同步', '引导按钮文案是「开启同步」');
  assert(a.info.text === '仅本地 开启同步', '文案为「仅本地 │ 开启同步 →」');
  assert(a.info.h === 26, '入口胶囊高 26px');
  assert((await clickToSettings(a)) === '同步', '点击后直接落到设置「同步」页');
  assert(a.errors.length === 0, '新用户场景控制台无错误');
  await a.context.close();

  /* 2. 有仓库配置但没有令牌：仍要能看出怎么继续，而不是灰点 */
  const cfg = { provider: 'gitee', owner: 'someone', repo: 'my-notes', branch: 'main', remember: true };
  const b = await open('cfg-no-token', { config: cfg });
  assert(b.info.setup === true, '只剩仓库配置时胶囊仍是入口，不是灰点');
  assert(b.info.ctaVisible === true, '能看到「继续同步」引导按钮');
  assert(b.info.ctaText === '继续同步', '有配置缺令牌时文案是「继续同步」');
  assert(/令牌/.test(b.info.title || ''), '悬浮说明讲清是令牌需要重新填写');
  assert((await clickToSettings(b)) === '同步', '点击后同样落到设置「同步」页');
  assert(b.errors.length === 0, '缺令牌场景控制台无错误');
  await b.context.close();

  /* 3. 仓库 + 令牌都在：恢复成状态胶囊，不再抢注意力 */
  const c = await open('connected', { config: cfg, token: 'dummy-token' });
  assert(c.info.setup === false, '已连接时不再处于 setup 态');
  assert(c.info.ctaVisible === false, '已连接时不显示引导按钮');
  assert(c.info.text === '仅本地', '同步还没跑之前显示「仅本地」状态');
  await c.context.close();

  console.log('\n全部通过');
  await browser.close();
  server.close();
} catch (e) {
  await browser.close();
  server.close();
  console.error('\n测试失败：', e.message);
  process.exitCode = 1;
}
