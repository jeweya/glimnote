/**
 * 待办功能冒烟测试：用 Playwright 驱动打包后的产物，走一遍真实交互。
 * 运行：node scripts/todo-smoke.mjs（需要先 npm run build）
 */
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

const root = resolve(process.argv[2] || 'dist');
const port = Number(process.argv[3] || 4180);
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
const context = await browser.newContext({ viewport: { width: 1280, height: 820 } });
// 跳过首次打开的「配置云端仓库」引导，避免 1.8s 后弹出的遮罩挡住点击
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

try {
  step('打开应用');
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.app', { timeout: 15000 });
  await shot('01-home');

  step('进入待办页');
  await page.locator('.side-item', { hasText: '待办' }).first().click();
  await page.waitForSelector('.task-panel', { timeout: 8000 });
  await page.waitForSelector('.task-quick input');
  await page.waitForTimeout(500);
  await shot('02-todo-empty');

  step('快速新增三条（今天 / 明天 / 无日期）');
  const quick = page.locator('[data-quick-add]');
  await quick.fill('买牛奶和面包');
  await page.locator('.quick-chip', { hasText: '日期' }).click();
  await page.locator('.dp-quick button', { hasText: '今天' }).click();
  await quick.press('Enter');
  await page.waitForTimeout(150);

  await quick.fill('回复周报邮件');
  await page
    .locator('.quick-chip')
    .filter({ hasText: /日期|今天|明天/ })
    .first()
    .click();
  await page.locator('.dp-quick button', { hasText: '明天' }).click();
  await page.locator('.quick-chip').nth(1).click();
  await page.locator('.menu-item', { hasText: '高' }).click();
  await quick.press('Enter');
  await page.waitForTimeout(150);

  await quick.fill('整理桌面文件');
  await quick.press('Enter');
  await page.waitForTimeout(400);
  assert((await page.locator('.task-row').count()) === 3, '列表里出现 3 条待办');
  const heads = await page.locator('.task-group-head').allTextContents();
  assert(
    heads.some((h) => h.includes('今天')),
    '有「今天」分组',
  );
  assert(
    heads.some((h) => h.includes('7 天内')),
    '有「7 天内」分组（明天）',
  );
  assert(
    heads.some((h) => h.includes('待整理')),
    '没设日期的落在「待整理」分组',
  );
  await shot('03-todo-groups');

  step('打开详情并修改字段');
  await page.locator('.task-row', { hasText: '买牛奶和面包' }).click();
  await page.waitForSelector('.td-title');
  // 详情面板挂载时先渲染上一条的草稿，这里等它同步到当前选中项
  await page
    .waitForFunction(() => document.querySelector('.td-title')?.value === '买牛奶和面包', null, { timeout: 5000 })
    .catch(() => {});
  assert((await page.locator('.td-title').inputValue()) === '买牛奶和面包', '详情标题与选中项一致');
  await page.locator('.td-seg button', { hasText: '高' }).click();
  await page.locator('.td-add').click();
  await page.locator('.td-tag-input').fill('生活');
  await page.locator('.td-tag-input').press('Enter');
  await page.locator('.td-notes textarea').fill('把牛奶换成低脂的；面包买全麦。');
  await page.waitForTimeout(700);
  assert((await page.locator('.td-tags .tag-chip').count()) === 1, '标签已添加');
  await shot('04-todo-detail');

  step('勾选完成');
  await page.locator('.task-row', { hasText: '回复周报邮件' }).locator('.task-check').click();
  await page.waitForTimeout(900);
  assert((await page.locator('.task-row', { hasText: '回复周报邮件' }).count()) === 0, '完成的条目移出未完成分组');
  assert((await page.locator('.task-group-head', { hasText: '已完成' }).count()) === 1, '出现「已完成」分组');
  await page.locator('.task-group-head', { hasText: '已完成' }).click();
  await page.waitForTimeout(300);
  assert((await page.locator('.task-row', { hasText: '回复周报邮件' }).count()) === 1, '展开后能看到已完成的条目');
  await shot('05-todo-done');

  step('刷新后数据仍在');
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.app');
  await page.locator('.side-item', { hasText: '待办' }).first().click();
  await page.waitForSelector('.task-row', { timeout: 8000 });
  await page.waitForTimeout(400);
  assert((await page.locator('.task-row').count()) >= 2, '刷新后仍能看到未完成的待办');
  const buy = page.locator('.task-row', { hasText: '买牛奶和面包' });
  assert((await buy.count()) === 1, '刷新后「买牛奶和面包」还在');
  const detailTitle = await page
    .locator('.td-title')
    .inputValue()
    .catch(() => '');
  assert(detailTitle !== '', '右栏仍有任务详情');
  await shot('06-after-reload');

  step('删除并撤销');
  const countBefore = await page.locator('.task-row').count();
  await buy.hover();
  await buy.locator('.task-more').click();
  await page.locator('.menu-item', { hasText: '删除待办' }).click();
  await page.waitForTimeout(400);
  assert((await page.locator('.task-row', { hasText: '买牛奶和面包' }).count()) === 0, '删除后列表里消失');
  await page.locator('.toast', { hasText: '已删除待办' }).locator('button', { hasText: '撤销' }).click();
  await page.waitForTimeout(600);
  assert((await page.locator('.task-row', { hasText: '买牛奶和面包' }).count()) === 1, '撤销后条目回来');
  await shot('07-undo');

  step('删除进任务回收站 → 恢复 → 再删 → 永久删除');
  const dust = page.locator('.task-row', { hasText: '整理桌面文件' });
  await dust.hover();
  await dust.locator('.task-more').click();
  await page.locator('.menu-item', { hasText: '删除待办' }).click();
  await page.waitForTimeout(400);
  assert((await page.locator('.task-row', { hasText: '整理桌面文件' }).count()) === 0, '再次删除后列表里消失');

  const openTaskTrash = async () => {
    await page.locator('.list-head .icon-btn').click();
    await page.locator('.menu-item', { hasText: '已删除的待办' }).click();
    await page.waitForSelector('.task-trash-row', { timeout: 8000 });
    await page.waitForTimeout(350);
  };
  await openTaskTrash();
  assert(
    (await page.locator('.task-trash-row', { hasText: '整理桌面文件' }).count()) === 1,
    '回收站里能看到刚删的待办',
  );
  await shot('08-task-trash');

  await page.locator('.task-trash-row', { hasText: '整理桌面文件' }).locator('[title="恢复"]').click();
  await page.waitForTimeout(700);
  assert((await page.locator('.task-trash-empty').count()) === 1, '恢复后回收站变空');
  await page.locator('.task-trash .icon-btn[title="关闭"]').click();
  await page.waitForTimeout(300);
  assert((await page.locator('.task-row', { hasText: '整理桌面文件' }).count()) === 1, '恢复后回到未完成列表');

  await page.locator('.task-row', { hasText: '整理桌面文件' }).hover();
  await page.locator('.task-row', { hasText: '整理桌面文件' }).locator('.task-more').click();
  await page.locator('.menu-item', { hasText: '删除待办' }).click();
  await page.waitForTimeout(500);
  await openTaskTrash();
  await page.locator('.task-trash-row', { hasText: '整理桌面文件' }).locator('[title="永久删除"]').click();
  await page.waitForTimeout(700);
  assert((await page.locator('.task-trash-empty').count()) === 1, '永久删除后回收站变空');
  await page.locator('.task-trash .icon-btn[title="关闭"]').click();
  await page.waitForTimeout(300);
  assert((await page.locator('.task-row', { hasText: '整理桌面文件' }).count()) === 0, '永久删除后列表里也没有了');

  step('任务回收站与笔记回收站互不混淆');
  await page.locator('.side-item', { hasText: '回收站' }).click();
  await page.waitForTimeout(500);
  assert((await page.locator('.note-row', { hasText: '买牛奶' }).count()) === 0, '笔记回收站里不会出现任务');
  await shot('09-note-trash');

  step('返回待办，检查优先级竖条与日期');
  await page.locator('.side-item', { hasText: '待办' }).first().click();
  await page.waitForSelector('.task-row');
  await page.waitForTimeout(300);
  assert((await page.locator('.task-row.high').count()) >= 1, '高优先级有竖条标记');
  await shot('10-todo-final');

  step('状态：待整理 → 定日期升待办 → 跟进中');
  const quick2 = page.locator('[data-quick-add]');
  await quick2.fill('跟进社区反馈');
  await quick2.press('Enter');
  await page.waitForTimeout(450);
  const follow = page.locator('.task-row', { hasText: '跟进社区反馈' });
  assert((await page.locator('.task-group-head', { hasText: '待整理' }).count()) === 1, '新条目落在「待整理」组');
  assert((await follow.locator('.task-status.inbox').count()) === 1, '行次显示「待整理」字样');

  await follow.click();
  await page.waitForSelector('.td-seg-status');
  await page.locator('.td-field', { hasText: '截止日期' }).locator('.td-value').click();
  await page.locator('.dp-quick button', { hasText: '今天' }).click();
  await page.waitForTimeout(500);
  assert(
    (await page.locator('.td-seg-status button.on').innerText()).trim() === '待办',
    '待整理设了日期自动升为「待办」',
  );
  assert((await follow.locator('.task-status.inbox').count()) === 0, '升为待办后行次不再显示待整理');

  await page.locator('.td-seg-status button', { hasText: '跟进中' }).click();
  await page.waitForTimeout(450);
  assert((await follow.locator('.task-status.doing').count()) === 1, '「跟进中」在行次可见');

  await page.locator('.td-seg-status button', { hasText: '待整理' }).click();
  await page.waitForTimeout(450);
  assert((await page.locator('.toast', { hasText: '待整理不设截止日期' }).count()) === 1, '改为待整理会提示清空日期');
  assert(
    (await page.locator('.td-field', { hasText: '截止日期' }).innerText()).includes('无日期'),
    '改为待整理后日期被清空',
  );
  await shot('11-status');

  // 重新定日期并设为跟进中，留给筛选与「取消完成恢复状态」用
  await page.locator('.td-field', { hasText: '截止日期' }).locator('.td-value').click();
  await page.locator('.dp-quick button', { hasText: '今天' }).click();
  await page.waitForTimeout(400);
  await page.locator('.td-seg-status button', { hasText: '跟进中' }).click();
  await page.waitForTimeout(450);

  step('筛选：时间 × 状态');
  assert((await page.locator('.tf-chips .tf-chip').count()) === 5, '筛选条有 5 个时间选项');
  await page.locator('.tf-chip', { hasText: '今天' }).click();
  await page.waitForTimeout(400);
  assert((await page.locator('.list-foot', { hasText: '已筛选' }).count()) === 1, '底部显示「已筛选」与清除入口');
  assert((await page.locator('.task-row').count()) === 2, '「今天」筛选后剩 2 条');

  await page.locator('.tf-status').click();
  await page.locator('.menu-item', { hasText: '跟进中' }).click();
  await page.waitForTimeout(400);
  assert((await page.locator('.task-row').count()) === 1, '「今天 + 跟进中」取交集剩 1 条');
  const todayChip = (await page.locator('.tf-chip', { hasText: '今天' }).innerText()).replace(/\s+/g, '');
  assert(todayChip === '今天1', '时间 chip 的计数随状态筛选联动（今天1）');
  assert((await page.locator('.task-group', { hasText: '已完成' }).count()) === 0, '筛选时不显示「已完成」组');
  await shot('12-filter');

  await page.locator('.foot-clear').click();
  await page.waitForTimeout(400);
  assert((await page.locator('.task-row').count()) >= 2, '清除筛选后回到全部');
  assert((await page.locator('.list-foot', { hasText: '已筛选' }).count()) === 0, '底部不再显示筛选状态');

  step('完成再取消完成，状态回到跟进中');
  await page.locator('.task-row', { hasText: '跟进社区反馈' }).locator('.task-check').click();
  await page.waitForTimeout(1000);
  // 「已完成」组可能还是展开的，别把它点回去
  if ((await page.locator('.task-row', { hasText: '跟进社区反馈' }).count()) === 0) {
    await page.locator('.task-group-head', { hasText: '已完成' }).click();
    await page.waitForTimeout(350);
  }
  await page.locator('.task-row', { hasText: '跟进社区反馈' }).locator('.task-check').click();
  await page.waitForTimeout(900);
  assert(
    (await page.locator('.task-row', { hasText: '跟进社区反馈' }).locator('.task-status.doing').count()) === 1,
    '取消完成回到完成前的「跟进中」',
  );

  step('搜索与导出');
  await page.locator('.search-inline input').fill('牛奶');
  await page.waitForTimeout(400);
  assert((await page.locator('.task-row').count()) === 1, '搜索只留下匹配的待办');
  assert((await page.locator('.task-group-head', { hasText: '搜索' }).count()) === 1, '搜索时不分日期组');
  await page.locator('.search-inline input').fill('');
  await page.waitForTimeout(300);
  assert((await page.locator('.task-row').count()) >= 1, '清空搜索后回到分组视图');

  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 8000 }),
    (async () => {
      await page.locator('.list-head .icon-btn').click();
      await page.locator('.menu-item', { hasText: '导出为 Markdown' }).click();
    })(),
  ]);
  const md = await readFile(await download.path(), 'utf8');
  assert(download.suggestedFilename().endsWith('.md'), '导出文件名是 .md');
  assert(md.includes('买牛奶和面包'), '导出的清单包含当前待办');
  assert(/\[x\]|已完成/.test(md), '导出内容带完成状态');
  await writeFile(join(shots, 'export-preview.md'), md);

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
