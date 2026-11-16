/**
 * 建仓失败 → 重试 → 仓库已存在 → 继续连接 的回归测试。
 * 用 Playwright 拦截 Gitee API 与 git 的 HTTP 请求，验证：
 * 1) 设置页底部不再有第二个「创建私有仓库并连接」按钮；
 * 2) 桌面端走 git:request 代理，网络中断只给中文下一步提示，不出现底层英文；
 * 3) 重试时平台返回「已存在」不会打断流程，origin 也不会因为已存在而报错；
 * 4) 网页版没有代理时不再谎报「网络不通」，而是明确说明跨域限制、改用桌面端。
 */
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

// 截图目录按需创建（仓库根目录不保留这些产物）
fs.mkdirSync('shots', { recursive: true });

const TEXT_BAD = /Failed|already exists|force|exists/i;

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
};

function serve(dir, port) {
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent((req.url || '/').split('?')[0]);
    let file = path.join(dir, url === '/' ? 'index.html' : url);
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(dir, 'index.html');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

async function mock(page, state) {
  // 令牌校验：GET /user
  await page.route('https://gitee.com/api/v5/user**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ login: 'jewey', name: 'Jewey' }),
    }),
  );
  // 仓库查询：创建成功后返回私有仓库，默认分支 master（Gitee 常见）
  await page.route('https://gitee.com/api/v5/repos/**', (route) =>
    state.created
      ? route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ private: true, default_branch: 'master', size: 0 }),
        })
      : route.fulfill({ status: 404, contentType: 'application/json', body: '{"message":"Not Found"}' }),
  );
  // 建仓：abort = 模拟网络中断；created = 建成功；exists = 平台返回 422
  await page.route('https://gitee.com/api/v5/user/repos**', async (route) => {
    state.posts += 1;
    if (state.mode === 'abort') return route.abort('failed');
    if (state.mode === 'exists') {
      return route.fulfill({ status: 422, contentType: 'application/json', body: '{"message":"already exists"}' });
    }
    state.created = true;
    return route.fulfill({ status: 201, contentType: 'application/json', body: '{"name":"my-notes","private":true}' });
  });
  // git 协议：一律视为网络不通，避免真的访问 gitee
  await page.route('https://gitee.com/jewey/**', (route) => route.abort('failed'));
}

// 状态分两行：第一行是中文结论，第二行是可复制的原始报错（允许英文）
async function statusText(page) {
  const body = page.locator('.settings-foot .status-line .status-body > div').first();
  if (await body.count()) return (await body.innerText()).trim();
  return await statusText(page);
}

async function readError(page) {
  const prompt = page.locator('.repo-prompt');
  const err = prompt.locator('.prompt-error');
  if (await err.count()) return (await err.innerText()).trim();
  return (await prompt.locator('.error-text').innerText()).trim();
}

async function openPage(browser, base, desktop) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  const errs = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errs.push(m.text());
  });
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));

  const state = { created: false, posts: 0, mode: 'abort' };
  if (desktop) {
    // 模拟 preload 注入的桌面桥：git 请求交给「主进程」，这里固定回网络失败，
    // 用来验证渲染层确实走了代理，以及代理失败时的中文提示。
    await page.addInitScript(() => {
      window.__gitCalls = 0;
      window.glimnote = {
        platform: 'electron',
        isDesktop: true,
        gitRequest: async () => {
          window.__gitCalls += 1;
          throw new Error('Failed to fetch');
        },
        onCaptureSaved: () => () => {},
        onCommand: () => () => {},
        repoPath: async () => '',
        openRepoFolder: async () => {},
        getPrefs: async () => ({}),
        setCloseToTray: async (v) => v,
        openCapture: async () => {},
        closeCapture: async () => {},
        captureSaved: async () => true,
        checkUpdate: async () => ({ status: 'dev', message: '' }),
      };
    });
  }
  await page.addInitScript(() => localStorage.setItem('glimnote.syncPrompt.off', '1'));
  await mock(page, state);
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.waitForTimeout(700);
  return { page, context, state, errs };
}

async function openForm(page) {
  await page.locator('.sync-pill').click();
  await page.waitForTimeout(400);
  await page.locator('input[type=password]').fill('fake-token-123');
  await page.getByRole('button', { name: /校验令牌/ }).click();
  await page.waitForSelector('.repo-prompt', { timeout: 5000 });
}

async function desktopFlow(browser, base) {
  const { page, context, state, errs } = await openPage(browser, base, true);
  await openForm(page);
  console.log('desktop banner count:', await page.locator('.sync-warn').count());

  const foot = await page.locator('.settings-foot').innerText();
  console.log('footer text:', foot.replace(/\n/g, ' | '));
  console.log('footer create buttons:', await page.locator('.settings-foot').getByText('创建私有仓库并连接').count());

  await page.getByRole('button', { name: '返回修改' }).click();
  await page.waitForTimeout(300);
  console.log('status after cancel:', await statusText(page));
  console.log('focus:', await page.evaluate(() => document.activeElement?.getAttribute('placeholder')));
  await page.getByRole('button', { name: /校验令牌/ }).click();
  await page.waitForSelector('.repo-prompt', { timeout: 5000 });

  // 第 1 次：建仓时网络中断
  await page.getByRole('button', { name: /创建私有仓库并连接/ }).click();
  await page.waitForTimeout(1200);
  const e1 = await readError(page);
  console.log('attempt1 error:', e1);
  console.log('attempt1 english:', TEXT_BAD.test(e1));
  console.log('attempt1 prompt open:', await page.locator('.repo-prompt').count());
  await page.screenshot({ path: 'shots/repo-retry-1.png' });

  // 第 2 次：仓库其实已建好，平台回「已存在」；应复查后直接接着连
  state.mode = 'exists';
  state.created = true;
  await page.getByRole('button', { name: /创建私有仓库并连接/ }).click();
  await page.waitForTimeout(1800);
  console.log('attempt2 prompt open:', await page.locator('.repo-prompt').count());
  const s2 = await statusText(page);
  console.log('attempt2 status:', s2);
  console.log('attempt2 english:', TEXT_BAD.test(s2));
  console.log(
    'branch after create:',
    await page.locator('.field').filter({ hasText: '分支' }).locator('input').inputValue(),
  );
  console.log('connect button:', await page.getByRole('button', { name: '连接这个仓库' }).count());
  await page.screenshot({ path: 'shots/repo-retry-2.png' });

  // 第 3 次：平台返回「已存在」后点「连接这个仓库」重试；origin 必须被强制覆盖
  state.mode = 'exists';
  await page.getByRole('button', { name: '连接这个仓库' }).click();
  await page.waitForTimeout(1800);
  const s3 = await statusText(page);
  console.log('attempt3 status:', s3);
  console.log('attempt3 english:', TEXT_BAD.test(s3));
  console.log('attempt3 remote-exists hint:', s3.includes('仓库地址没有更新成功'));
  console.log('create posts:', state.posts);
  console.log('desktop git bridge calls:', await page.evaluate(() => window.__gitCalls || 0));
  await page.screenshot({ path: 'shots/repo-retry-3.png' });
  console.log('desktop console errors:', errs.length, errs.slice(0, 6));
  await context.close();
}

async function webFlow(browser, base) {
  const { page, context, state, errs } = await openPage(browser, base, false);
  await openForm(page);
  const banner = (await page.locator('.sync-warn').innerText()).replace(/\s+/g, ' ');
  console.log('web banner:', banner);

  await page.getByRole('button', { name: /创建私有仓库并连接/ }).click();
  await page.waitForTimeout(1200);
  console.log('web attempt1 error:', await readError(page));

  // 第二次：仓库已建好，但网页版仍然读不到 Git 的跨域响应
  state.mode = 'exists';
  state.created = true;
  await page.getByRole('button', { name: /创建私有仓库并连接/ }).click();
  await page.waitForTimeout(1800);
  const status = await statusText(page);
  console.log('web status:', status);
  console.log('web mentions desktop:', status.includes('桌面客户端'));
  console.log('web prompt open:', await page.locator('.repo-prompt').count());
  console.log('web connect button:', await page.getByRole('button', { name: '连接这个仓库' }).count());
  console.log('web english:', TEXT_BAD.test(status));
  await page.screenshot({ path: 'shots/repo-web-cors.png' });
  console.log('web console errors:', errs.length, errs.slice(0, 6));
  await context.close();
}

(async () => {
  const server = await serve(path.join(__dirname, '..', 'dist'), 5199);
  const browser = await chromium.launch();
  const base = 'http://127.0.0.1:5199';
  await desktopFlow(browser, base);
  await webFlow(browser, base);
  await browser.close();
  server.close();
})();
