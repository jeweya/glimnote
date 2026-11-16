/**
 * 时间下拉 + 网页粘贴冒烟测试：用 Playwright 驱动打包后的产物，走一遍真实交互。
 * 运行：node scripts/time-paste-smoke.mjs（需要先 npm run build）
 * 环境变量：SMOKE_SKIP_TIME=1 只跑粘贴部分；SMOKE_NO_SHOT=1 跳过截图
 */
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

const root = resolve(process.argv[2] || 'dist');
const port = Number(process.argv[3] || 4200);
const shots = resolve(process.argv[4] || 'shots-timepaste');
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

const browser = await chromium.launch({
  args: ['--disable-dev-shm-usage', '--disable-gpu', '--no-sandbox'],
});
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
const shot = async (name, tries = 3) => {
  if (process.env.SMOKE_NO_SHOT) return;
  for (let i = 0; i < tries; i++) {
    try {
      await page.screenshot({ path: join(shots, `${name}.png`), animations: 'disabled' });
      return;
    } catch (e) {
      if (i === tries - 1) throw e;
      await page.waitForTimeout(500);
    }
  }
};
const assert = (cond, msg) => {
  if (!cond) throw new Error(`断言失败：${msg}`);
  console.log(`  ✓ ${msg}`);
};

/** 在富文本编辑器里模拟一次带 HTML 的粘贴 */
const pasteHtml = async (html, text) => {
  await page.evaluate(
    ({ html, text }) => {
      const el = document.querySelector('.rich-content');
      if (!el) throw new Error('找不到富文本编辑器');
      const dt = new DataTransfer();
      dt.setData('text/html', html);
      dt.setData('text/plain', text);
      const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
      if (!ev.clipboardData) Object.defineProperty(ev, 'clipboardData', { value: dt });
      el.dispatchEvent(ev);
    },
    { html, text },
  );
  await page.waitForTimeout(500);
};

const clearEditor = async () => {
  await page.locator('.rich-content').click();
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(250);
};

const readSource = async () => {
  await page.locator('.fmt-live').click();
  await page.waitForSelector('.cm-content', { timeout: 5000 });
  await page.waitForTimeout(300);
  return page.locator('.cm-line').allTextContents();
};

const backToRich = async () => {
  await page.locator('.fmt-live').click();
  await page.waitForSelector('.rich-content', { timeout: 5000 });
  await page.waitForTimeout(300);
};

try {
  step('打开应用');
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.app', { timeout: 15000 });

  if (process.env.SMOKE_SKIP_TIME) {
    console.log('  · 已跳过时间选择部分');
  } else {
    step('进入待办');
    await page.locator('.side-item', { hasText: '待办' }).first().click();
    await page.waitForSelector('.task-quick input');
    const quick = page.locator('[data-quick-add]');
    await quick.fill('时间选择测试');
    await quick.press('Enter');
    await page.waitForTimeout(500);
    await page.locator('.task-row', { hasText: '时间选择测试' }).click();
    await page.waitForSelector('.td-title');
    await page.locator('.td-field', { hasText: '截止日期' }).locator('.td-value').click();
    await page.locator('.dp-quick button', { hasText: '今天' }).click();
    await page.waitForSelector('.td-time-btn');

    step('点开时间区域，检查 5 分钟一档的滚动列表');
    await page.locator('.td-time-btn').click();
    await page.waitForSelector('.time-pop', { timeout: 3000 });
    assert((await page.locator('.tp-item').count()) === 288, '时间列表共 288 档（每 5 分钟）');
    assert((await page.locator('.tp-item').first().innerText()).trim() === '00:00', '第一档是 00:00');
    assert((await page.locator('.tp-item').last().innerText()).trim() === '23:55', '最后一档是 23:55');
    await page.waitForTimeout(600);
    await shot('01-time-picker');

    step('点选 14:35');
    await page.locator('.tp-item', { hasText: '14:35' }).click();
    await page.waitForTimeout(400);
    assert((await page.locator('.td-time-btn').innerText()).includes('14:35'), '详情里的时间更新为 14:35');
    assert((await page.locator('.time-pop').count()) === 0, '选完自动收起');

    step('手输 9:07');
    await page.locator('.td-time-btn').click();
    await page.waitForSelector('.time-pop');
    await page.locator('.tp-input').fill('9:07');
    await page.locator('.tp-input').press('Enter');
    await page.waitForTimeout(400);
    assert((await page.locator('.td-time-btn').innerText()).includes('09:07'), '手输 9:07 规范成 09:07');

    step('列表里的「到点提醒」浮窗用同一个时间选择器');
    const row = page.locator('.task-row', { hasText: '时间选择测试' });
    await row.hover();
    await row.locator('.task-more').click();
    await page.locator('.menu-item', { hasText: '到点提醒' }).click();
    await page.waitForSelector('.remind-pop', { timeout: 3000 });
    await page.locator('.rp-time-btn').click();
    await page.waitForSelector('.time-pop', { timeout: 3000 });
    assert((await page.locator('.tp-item').count()) === 288, '浮窗里也是完整的时间列表');
    await page.waitForTimeout(600);
    await shot('02-remind-popover');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);
  }

  step('新建笔记，粘贴「两行 + 中间空段落」');
  await page.locator('.side-item', { hasText: '全部笔记' }).click();
  await page.waitForSelector('.list-new', { timeout: 8000 });
  await page.locator('.list-new').click();
  await page.waitForSelector('.rich-content', { timeout: 8000 });
  await page.waitForTimeout(400);
  await pasteHtml('<p>line1</p><p><br></p><p>line2</p>', 'line1\n\nline2');
  const html1 = await page.locator('.rich-content').innerHTML();
  assert((html1.match(/<br/g) || []).length === 1, '两行之间只保留一个换行（不再多空一行）');
  assert(!html1.includes('<p></p>'), '没有残留的空段落');

  const md1 = await readSource();
  const mdText1 = md1.join('\n');
  assert(mdText1.includes('line1\nline2'), 'Markdown 里是单换行');
  assert(!mdText1.includes('line1\n\nline2'), 'Markdown 里没有多出来的空行');
  await shot('03-paste-source');
  await backToRich();

  step('粘贴「外层再包一层 div」的结构');
  await clearEditor();
  await pasteHtml('<div><p>甲</p><p><br></p><p>乙</p></div>', '甲\n\n乙');
  const html2 = await page.locator('.rich-content').innerHTML();
  assert((html2.match(/<br/g) || []).length === 1, '包装层里的两行也只留一个换行');
  const md2 = (await readSource()).join('\n');
  assert(md2.includes('甲\n乙') && !md2.includes('甲\n\n乙'), 'Markdown 里同样是单换行');
  await backToRich();

  step('粘贴「span + 连续 br」的结构');
  await clearEditor();
  await pasteHtml('<span>一</span><br><br><span>二</span>', '一\n\n二');
  const html3 = await page.locator('.rich-content').innerHTML();
  assert((html3.match(/<br/g) || []).length === 1, '连续 <br> 收成一个');
  const md3 = (await readSource()).join('\n');
  assert(md3.includes('一\n二') && !md3.includes('一\n\n二'), 'Markdown 里没有空行');
  await backToRich();

  step('带行内格式的粘贴仍然保留格式');
  await clearEditor();
  await pasteHtml('<p>正常行</p><p><b>加粗行</b></p>', '正常行\n加粗行');
  const html4 = await page.locator('.rich-content').innerHTML();
  assert(html4.includes('<strong>') || html4.includes('<b>'), '行内加粗保留');
  assert((html4.match(/<br/g) || []).length === 1, '两行之间只有一个换行');
  await shot('04-paste-rich');

  step('多行粘贴后给中间一行加复选框，每行各自一项');
  await clearEditor();
  const planLines = [
    '3.ai密码花园、鸿蒙、表达、1688采集、架构考试、大模型微调部署',
    '4.jtreecloud（6号开，需消耗完）',
    '5.服务器应急部署、服务器定时AI巡检',
    '11.ima研报采集',
  ];
  await pasteHtml('', planLines.join('\n'));
  assert((await page.locator('.rich-content br').count()) === 3, '四行被贴进同一个段落（三个软换行）');
  await page.locator('.rich-content').click();
  await page.keyboard.press('Control+Home');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Home');
  const checkBtn = page.locator('.fmt-btn[aria-label^="复选框"]');
  if (await checkBtn.count()) await checkBtn.first().click();
  else {
    await page.locator('.fmt-btn', { hasText: '列表' }).first().click();
    await page.locator('.fmt-menu').getByText('复选框').first().click();
  }
  await page.waitForTimeout(400);
  const boxes = page.locator('.rich-content li[data-checked]');
  assert((await boxes.count()) === 4, '四行各自变成一条复选框，不再整段共用一个');
  assert((await boxes.nth(0).innerText()).includes('3.ai密码花园'), '第一行复选框在第一行');
  assert((await boxes.nth(2).innerText()).includes('5.服务器应急部署'), '第三行复选框落在第三行');
  const caretText = await page.evaluate(() => {
    const sel = window.getSelection();
    const node = sel?.anchorNode;
    const el = node?.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    return el?.textContent?.slice(0, 24) || '';
  });
  assert(caretText.includes('5.服务器'), '光标留在原来的第三行');
  const mdBox = (await readSource()).filter((l) => l.trim().startsWith('- [ ]'));
  assert(mdBox.length === 4, 'Markdown 里是四条 - [ ]');
  assert(mdBox.every((l, i) => l.includes(planLines[i].slice(0, 6))), '四条顺序与原文一致');
  await backToRich();
  await shot('05-paste-checklist');

  step('粘贴「段落 + 列表 + 段落」的混合内容');
  await clearEditor();
  await pasteHtml(
    '<div><p>前段一</p><p><br></p><p>前段二</p><ul><li>甲项</li><li>乙项</li></ul><p>后段一</p><p><br></p><p>后段二</p></div>',
    '前段一\n\n前段二\n甲项\n乙项\n后段一\n\n后段二',
  );
  const htmlMix = await page.locator('.rich-content').innerHTML();
  assert((await page.locator('.rich-content li').count()) === 2, '列表结构保留为两项');
  assert(!htmlMix.includes('<p><br'), '空段落没有残留');
  const mdMix = (await readSource()).join('\n');
  assert(mdMix.includes('前段一\n前段二'), '列表前的两段收成一个软换行');
  assert(mdMix.includes('后段一\n后段二'), '列表后的两段也收成一个软换行');
  assert(!mdMix.includes('前段一\n\n前段二'), '列表前没有多出来的空行');
  assert(!mdMix.includes('后段一\n\n后段二'), '列表后没有多出来的空行');
  assert(mdMix.includes('甲项') && mdMix.includes('乙项'), '列表文字按原顺序保留');
  await backToRich();
  await shot('06-paste-mixed');

  step('粘贴内嵌 base64 图片时落盘为本地文件');
  await clearEditor();
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  await pasteHtml(
    `<p>图前</p><p><img src="data:image/png;base64,${png}" alt="内嵌图"></p><p>图后</p>`,
    '图前\n图后',
  );
  await page.waitForSelector('.rich-content img', { timeout: 8000 });
  await page.waitForTimeout(800);
  const imgSrc = await page.locator('.rich-content img').first().getAttribute('src');
  assert(!String(imgSrc || '').startsWith('data:'), '图片不再是 data URL');
  const mdImg = (await readSource()).join('\n');
  assert(mdImg.includes('![内嵌图](') && mdImg.includes('assets/'), 'Markdown 里是本地 assets 路径');
  assert(!mdImg.includes('data:image'), 'Markdown 里没有 base64 大段内容');
  await backToRich();
  await shot('07-paste-data-image');

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
