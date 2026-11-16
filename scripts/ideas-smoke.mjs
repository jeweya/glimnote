/**
 * 灵感功能冒烟测试：用 Playwright 驱动打包后的产物，走一遍真实交互。
 * 运行：node scripts/ideas-smoke.mjs（需要先 npm run build）
 */
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

const root = resolve(process.argv[2] || 'dist');
const port = Number(process.argv[3] || 4190);
const shots = resolve(process.argv[4] || 'shots-ideas');
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
const context = await browser.newContext({ viewport: { width: 1280, height: 820 } });
await context.addInitScript(() => {
  try {
    localStorage.setItem('glimnote.syncPrompt.off', '1');
  } catch {}
});
const page = await context.newPage();
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(String(e)));

const step = (name) => console.log(`\n▶ ${name}`);
const shot = (name) => page.screenshot({ path: join(shots, `${name}.png`) });
const assert = (cond, msg) => {
  if (!cond) throw new Error(`断言失败：${msg}`);
  console.log(`  ✓ ${msg}`);
};
const openIdeas = async () => {
  await page.locator('.side-item', { hasText: '灵感' }).first().click();
  await page.waitForSelector('.idea-composer textarea', { timeout: 8000 });
};
const cards = () => page.locator('[data-idea-row]');
const tabCount = async (name) =>
  Number((await page.locator('.idea-tab', { hasText: name }).locator('em').innerText()).trim());
const addIdea = async (text) => {
  const box = page.locator('.idea-composer textarea');
  await box.fill(text);
  await box.press('Enter');
  await page.waitForTimeout(350);
};

try {
  step('打开应用并进入灵感');
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.app', { timeout: 15000 });
  await openIdeas();
  await page.waitForTimeout(500);
  assert((await page.locator('.ideas-empty .e1', { hasText: '还没有灵感' }).count()) === 1, '空态给出上手提示');
  await shot('01-empty');

  step('快捷记下三条');
  await addIdea('把首页的加载速度再压一压');
  await addIdea('给灵感加一个快捷入口');
  await addIdea('周末试试手冲咖啡的新水粉比');
  assert((await cards().count()) === 3, '记下 3 条灵感');
  assert((await page.locator('.idea-group-head', { hasText: '今天' }).count()) === 1, '按「今天」分组');
  assert(
    (await page.locator('.side-item', { hasText: '灵感' }).locator('.count').innerText()).trim() === '3',
    '侧栏计数同步为 3',
  );
  assert((await page.locator('.idea-bar').count()) === 0, '没选中时不显示操作条');
  await shot('02-list');

  step('点文字直接改');
  await page.locator('.idea-text', { hasText: '给灵感加一个快捷入口' }).click();
  const edit = page.locator('.idea-edit');
  await edit.waitFor({ timeout: 3000 });
  await edit.fill('给灵感加一个快捷入口，放在待办上方');
  await edit.press('Control+Enter');
  await page.waitForTimeout(400);
  assert((await page.locator('.idea-text', { hasText: '放在待办上方' }).count()) === 1, '原地修改即时生效');
  assert((await page.locator('.idea-edit').count()) === 0, '保存后退出编辑态');

  step('多选两条，右侧整理台预览');
  const cardA = page.locator('[data-idea-row]', { hasText: '把首页的加载速度' });
  const cardC = page.locator('[data-idea-row]', { hasText: '手冲咖啡' });
  await cardA.locator('.idea-check').click();
  await cardC.locator('.idea-check').click();
  await page.waitForTimeout(250);
  assert(
    (await page.locator('.idea-bar-count').innerText()).replace(/\s+/g, ' ') === '已选 2 条',
    '底部出现「已选 2 条」',
  );
  assert((await page.locator('.desk-block-head', { hasText: '将生成一篇笔记' }).count()) === 1, '整理台预览笔记');
  assert((await page.locator('.desk-tasks li').count()) === 2, '整理台列出 2 条待办');
  assert((await page.locator('.desk-count').innerText()).includes('2'), '整理台显示已选数量');
  await shot('03-select');

  step('两条合并成一篇笔记');
  await page.locator('.idea-bar-btn.primary').click();
  await page.waitForSelector('.toast', { timeout: 6000 });
  await page.waitForTimeout(500);
  assert((await page.locator('.toast', { hasText: '已把 2 条灵感合并成' }).count()) === 1, '提示合并成笔记');
  assert((await cards().count()) === 1, '未整理只剩 1 条');
  assert((await tabCount('未整理')) === 1, '未整理页签计数为 1');
  assert((await tabCount('已转化')) === 2, '已转化页签计数为 2');
  await page.locator('.toast button', { hasText: '打开笔记' }).click();
  await page.waitForSelector('.editor-title', { timeout: 6000 });
  await page.waitForTimeout(300);
  const noteTitle = await page.locator('.editor-title').inputValue();
  assert(noteTitle.startsWith('灵感整理 ·'), '生成的就是「灵感整理」笔记');
  await shot('04-note');

  step('已转化页签：打开生成的笔记');
  await openIdeas();
  await page.locator('.idea-tab', { hasText: '已转化' }).click();
  await page.waitForTimeout(350);
  assert((await cards().count()) === 2, '已转化里有 2 条记录');
  assert((await page.locator('.idea-kind.note').count()) === 2, '两条都标记为「笔记」');
  await page.locator('.idea-target').first().click();
  await page.waitForSelector('.editor-title', { timeout: 6000 });
  await page.waitForTimeout(300);
  assert((await page.locator('.editor-title').inputValue()) === noteTitle, '从记录可以回到原笔记');
  assert((await page.locator('.note-row', { hasText: '灵感整理' }).count()) >= 1, '笔记列表里能找到它');
  await shot('05-converted');

  step('剩下一条转成待办');
  await openIdeas();
  await page.locator('.idea-tab', { hasText: '未整理' }).click();
  await page.waitForTimeout(250);
  const last = page.locator('[data-idea-row]', { hasText: '放在待办上方' });
  await last.hover();
  await last.locator('.idea-act[title="转为待办"]').click();
  await page.waitForSelector('.toast', { timeout: 6000 });
  await page.waitForTimeout(500);
  assert((await page.locator('.toast', { hasText: '已整理为待办' }).count()) === 1, '提示已整理为待办');
  assert((await page.locator('.ideas-empty .e1', { hasText: '都整理好了' }).count()) === 1, '未整理清空后给出空态');
  assert((await tabCount('已转化')) === 3, '已转化累计 3 条');

  step('从「已转化」打开对应待办');
  await page.locator('.idea-tab', { hasText: '已转化' }).click();
  await page.waitForTimeout(350);
  assert((await page.locator('.idea-kind.task').count()) === 1, '有一条标记为「待办」');
  const taskCard = page.locator('[data-idea-row]', { hasText: '放在待办上方' });
  await taskCard.locator('.idea-target').click();
  await page.waitForSelector('.td-title', { timeout: 8000 });
  await page.waitForTimeout(400);
  assert((await page.locator('.td-title').inputValue()).includes('给灵感加一个快捷入口'), '打开的就是那条待办');
  await shot('06-task');

  step('删除记录并撤销');
  await openIdeas();
  await page.locator('.idea-tab', { hasText: '已转化' }).click();
  await page.waitForTimeout(300);
  const firstDone = cards().first();
  await firstDone.hover();
  await firstDone.locator('.idea-act[title="删除这条转化记录"]').click();
  await page.waitForTimeout(500);
  assert((await page.locator('.toast', { hasText: '已删除这条灵感' }).count()) === 1, '提示已删除');
  assert((await cards().count()) === 2, '记录少了一条');
  await page.locator('.toast button', { hasText: '撤销' }).click();
  await page.waitForTimeout(700);
  assert((await cards().count()) === 3, '撤销后记录回来');

  step('搜索');
  await page.locator('.idea-tab', { hasText: '未整理' }).click();
  await addIdea('一条用于搜索的灵感');
  const search = page.locator('.ideas-search input');
  await search.fill('搜索');
  await page.waitForTimeout(350);
  assert((await cards().count()) === 1, '搜索只留下匹配项');
  await search.fill('并不存在的关键词');
  await page.waitForTimeout(350);
  assert((await page.locator('.ideas-empty .e1', { hasText: '没有匹配的灵感' }).count()) === 1, '无结果时给出空态');
  await page.locator('.ideas-empty button', { hasText: '清空搜索' }).click();
  await page.waitForTimeout(350);
  assert((await cards().count()) === 1, '清空搜索后恢复列表');
  await shot('07-search');

  step('清空已转化记录，不影响生成的笔记和待办');
  await page.locator('.idea-tab', { hasText: '已转化' }).click();
  await page.waitForTimeout(300);
  await page.locator('.ideas-linkbtn', { hasText: '清空' }).click();
  await page.locator('.overlay-confirm .btn-danger').click();
  await page.waitForTimeout(600);
  assert((await page.locator('.ideas-empty .e1', { hasText: '还没有转化过' }).count()) === 1, '已转化记录清空');
  await page.locator('.idea-tab', { hasText: '未整理' }).click();
  await page.waitForTimeout(300);
  assert((await cards().count()) === 1, '未整理里的灵感不受影响');
  await shot('08-cleared');

  step('刷新后数据仍在');
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.app', { timeout: 15000 });
  await openIdeas();
  await page.waitForTimeout(600);
  assert((await cards().count()) === 1, '刷新后仍有 1 条灵感');
  assert((await page.locator('[data-idea-row]', { hasText: '一条用于搜索的灵感' }).count()) === 1, '内容正确');
  assert(
    (await page.locator('.side-item', { hasText: '灵感' }).locator('.count').innerText()).trim() === '1',
    '侧栏计数恢复为 1',
  );

  step('深色主题与窄窗口');
  await page.evaluate(() => {
    localStorage.setItem('glimnote.theme', 'dark');
    document.documentElement.dataset.theme = 'dark';
  });
  await page.locator('.idea-check').first().click();
  await page.waitForTimeout(500);
  await shot('09-dark');
  await page.setViewportSize({ width: 900, height: 820 });
  await page.waitForTimeout(500);
  assert((await page.locator('.ideas-desk').isVisible()) === false, '窄窗口隐藏整理台');
  assert((await page.locator('.idea-bar').isVisible()) === true, '操作条仍然可用');
  await shot('10-narrow');
  await page.setViewportSize({ width: 1280, height: 820 });

  console.log('\n控制台错误：', errors.length ? errors : '无');
  console.log('全部通过');
} catch (e) {
  await shot('99-failure');
  console.error('\n测试失败：', e.message);
  console.error('控制台错误：', errors);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
