/**
 * 主进程 Git 代理的回归测试（不依赖 Electron）。
 * 直接调用 gitRequest，验证白名单、方法限制，以及真实 Git 服务器的状态码能原样带回来。
 * 运行：node scripts/test-git-proxy.cjs
 */
const assert = require('node:assert');
const { gitRequest } = require('../electron/git-proxy.cjs');

const fetchImpl = globalThis.fetch;

async function run() {
  const rejectedProtocol = await gitRequest(fetchImpl, { url: 'http://gitee.com/a/b.git/info/refs' });
  assert.equal(rejectedProtocol.error, 'BAD_URL', '非 https 应被拒绝');

  const rejectedHost = await gitRequest(fetchImpl, { url: 'https://example.com/a/b.git/info/refs' });
  assert.equal(rejectedHost.error, 'HOST_BLOCKED', '非白名单主机应被拒绝');

  const rejectedMethod = await gitRequest(fetchImpl, {
    url: 'https://gitee.com/oschina/git-osc.git/info/refs?service=git-upload-pack',
    method: 'DELETE',
  });
  assert.equal(rejectedMethod.error, 'METHOD_BLOCKED', '只允许 GET / POST');

  const publicRepo = await gitRequest(fetchImpl, {
    url: 'https://gitee.com/oschina/git-osc.git/info/refs?service=git-upload-pack',
    method: 'GET',
    headers: { 'user-agent': 'git/2.43.0', accept: '*/*' },
  });
  assert.equal(publicRepo.error, undefined, `公开仓库请求失败：${publicRepo.message || ''}`);
  assert.equal(publicRepo.status, 200, `期望 200，实际 ${publicRepo.status}`);
  const advert = Buffer.from(publicRepo.bodyBase64, 'base64').toString('utf8');
  assert.ok(advert.includes('# service=git-upload-pack'), '响应体应是 git 的 pkt-line 广告');
  assert.equal(publicRepo.headers['content-type'], 'application/x-git-upload-pack-advertisement');

  // 未授权时 Gitee 返回 401；代理必须把这个状态原样交给渲染进程，而不是变成 Failed to fetch
  const unauthorized = await gitRequest(fetchImpl, {
    url: 'https://gitee.com/glimnote-probe-does-not-exist/probe.git/info/refs?service=git-upload-pack',
    method: 'GET',
  });
  assert.equal(unauthorized.error, undefined, '401 也应作为正常响应返回');
  assert.ok([401, 404].includes(unauthorized.status), `期望 401/404，实际 ${unauthorized.status}`);

  console.log('git proxy tests passed:', {
    publicStatus: publicRepo.status,
    unauthorizedStatus: unauthorized.status,
    advertBytes: Buffer.from(publicRepo.bodyBase64, 'base64').length,
  });
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
