/**
 * MCP AI 小应用 / 首页入口冒烟：直接对临时仓库调用工具，不启动 HTTP 服务。
 * 覆盖：创建与安全检查、修改与历史快照、数据读写边界、首页入口与分组、删除联动。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../mcp/lib/store.mjs';
import { TOOLS, callTool } from '../mcp/lib/tools.mjs';

let passed = 0;
function ok(cond, label) {
  assert.ok(cond, label);
  passed += 1;
}
async function rejects(fn, code, label) {
  try {
    await fn();
  } catch (e) {
    if (code !== undefined) assert.equal(e.code, code, `${label}：期望 ${code}，实际 ${e.code} ${e.message}`);
    passed += 1;
    return e;
  }
  throw new Error(`${label}：应当报错 ${code}`);
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'glimnote-mcp-apps-'));
const store = createStore(root);
const call = (name, args) => callTool(name, args, store);

const HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>计数器</title></head>
<body><h1>计数器</h1><button id="b">+1</button><p id="o">0</p>
<script>let n=0;const o=document.getElementById('o');document.getElementById('b').onclick=async()=>{n++;o.textContent=n;try{await window.glimnote.data.set('n',n)}catch{}};</script>
</body></html>`;

try {
  /* 工具清单 */
  const names = TOOLS.map((t) => t.name);
  assert.equal(names.length, 56);
  for (const name of [
    'get_app_guide',
    'list_apps',
    'get_app',
    'create_app',
    'update_app',
    'delete_app',
    'get_app_data',
    'set_app_data',
    'clear_app_data',
    'list_app_versions',
    'restore_app_version',
    'list_home',
    'add_home_entry',
    'update_home_entry',
    'delete_home_entry',
    'add_home_group',
    'update_home_group',
    'delete_home_group',
    'repo_stats',
    'list_task_categories',
  ]) {
    ok(names.includes(name), `工具清单包含 ${name}`);
  }
  const guide = await call('get_app_guide');
  ok(guide.limits.htmlBytes === 200 * 1024 && guide.dataApi.length >= 5, '生成规范含大小上限与数据接口');

  /* 空仓库 */
  let info = await call('repo_info');
  ok(info.apps === 0 && info.homeGroups === 0 && info.homeEntries === 0, '空仓库没有应用与首页入口');

  /* 创建应用 */
  const created = await call('create_app', {
    name: '计数器',
    description: '点一下加一',
    icon: 'calculator',
    color: 'blue',
    html: HTML,
  });
  ok(created.app && created.app.version === 1, '创建应用版本为 1');
  ok(/^[0-9a-z]{12}$/.test(created.app.id), '应用 id 为 12 位小写字母数字');
  ok(created.home && created.home.group.name === 'AI 小应用', '默认放进「AI 小应用」分组');
  const appDir = path.join(root, 'apps', created.app.id);
  ok(await fs.stat(path.join(appDir, 'app.json')), '写出 app.json');
  ok(await fs.stat(path.join(appDir, 'index.html')), '写出 index.html');
  const metaRaw = JSON.parse(await fs.readFile(path.join(appDir, 'app.json'), 'utf8'));
  ok(
    metaRaw.id === created.app.id && metaRaw.name === '计数器' && metaRaw.source === 'ai',
    'app.json 字段与桌面端一致',
  );
  const home = await call('list_home');
  ok(home.counts.groups === 1 && home.counts.entries === 1, '首页有 1 个分组 1 个入口');
  ok(home.groups[0].entries[0].type === 'app' && home.groups[0].entries[0].title === '计数器', '首页入口跟随应用名');

  /* 安全检查 */
  await rejects(
    () => call('create_app', { name: '危险', html: '<html><script>localStorage.setItem("x", 1)</script></html>' }),
    'BAD_HTML',
    '拒绝 localStorage',
  );
  await rejects(
    () =>
      call('create_app', { name: '危险', html: '<html><script>window.parent.document.body.remove()</script></html>' }),
    'BAD_HTML',
    '拒绝访问宿主窗口',
  );
  await rejects(() => call('create_app', { name: '危险', html: '<div>只有片段</div>' }), 'BAD_HTML', '拒绝不完整 HTML');
  await rejects(() => call('create_app', { name: '空' }), 'BAD_HTML', '拒绝空内容');
  await rejects(() => call('create_app', { name: '', html: HTML }), 'BAD_TITLE', '拒绝空名称');
  const apps = await call('list_apps');
  ok(apps.count === 1, '非法创建不会留下应用');

  /* 读取 */
  const full = await call('get_app', { id: created.app.id });
  ok(full.html === HTML && full.app.name === '计数器', '按 id 读取完整 HTML');
  const byName = await call('get_app', { name: '计数器', includeHtml: false });
  ok(byName.app.id === created.app.id && byName.html === undefined, '按名称读取且可省略 HTML');
  await rejects(() => call('get_app', { name: '不存在' }), 'NOT_FOUND', '读取不存在的应用报错');

  /* 修改：只改元数据不升版本 */
  let updated = await call('update_app', { id: created.app.id, description: '新的说明' });
  ok(
    updated.app.description === '新的说明' && updated.app.version === 1 && !updated.versionBumped,
    '只改元数据不升版本',
  );
  ok(updated.app.name === '计数器', '未传名称时保留原名');

  /* 修改：换 HTML 升版本并留快照 */
  updated = await call('update_app', { id: created.app.id, html: HTML.replace('计数器', '计数器 2') });
  ok(updated.app.version === 2 && updated.versionBumped, '换 HTML 版本 +1');
  let versions = await call('list_app_versions', { id: created.app.id });
  ok(versions.count === 1, '旧版留了 1 份快照');
  const versionName = versions.versions[0].name;
  const restored = await call('restore_app_version', { id: created.app.id, version: versionName });
  ok(restored.app.version === 3, '恢复历史版本也升版本');
  ok((await call('get_app', { id: created.app.id })).html.includes('计数器</h1>'), '恢复后代码回到旧版');
  await rejects(
    () => call('restore_app_version', { id: created.app.id, version: '../../evil' }),
    'BAD_PATH',
    '拒绝路径穿越的版本名',
  );

  /* 应用数据 */
  let data = await call('set_app_data', { id: created.app.id, data: { n: 3, label: 'x' } });
  ok(data.updated && data.keys === 2, '写入两个键');
  data = await call('set_app_data', { id: created.app.id, values: { n: 4 } });
  ok(data.keys === 2, 'values 按键合并');
  let got = await call('get_app_data', { id: created.app.id });
  ok(got.data.n === 4 && got.data.label === 'x', '读取到合并后的数据');
  await call('set_app_data', { id: created.app.id, removeKeys: ['label'] });
  got = await call('get_app_data', { id: created.app.id });
  ok(got.data.label === undefined && got.keys === 1, 'removeKeys 删除指定键');
  await call('set_app_data', { id: created.app.id, data: { only: true }, replace: true });
  got = await call('get_app_data', { id: created.app.id });
  ok(got.keys === 1 && got.data.only === true, 'replace 整体替换');
  await rejects(
    () => call('set_app_data', { id: created.app.id, values: { big: 'x'.repeat(128 * 1024) } }),
    'TOO_LARGE',
    '拒绝超过 128KB 的单值',
  );
  await rejects(() => call('set_app_data', { id: created.app.id }), 'EMPTY_CONTENT', '没有数据时报错');
  const rawData = JSON.parse(await fs.readFile(path.join(appDir, 'data.json'), 'utf8'));
  ok(rawData.v === 1 && rawData.updated && rawData.data.only === true, 'data.json 使用 {v,updated,data} 包装');
  data = await call('clear_app_data', { id: created.app.id });
  ok(data.cleared && data.keys === 0, '清空应用数据');

  /* 首页分组与入口 */
  const group = await call('add_home_group', { name: '网站', icon: 'globe', color: 'blue' });
  ok(group.group.name === '网站' && /^g-/.test(group.group.id), '新建首页分组');
  await rejects(() => call('add_home_group', { name: '网站' }), 'DUPLICATE', '拒绝重名分组');

  const urlEntry = await call('add_home_entry', {
    type: 'url',
    target: 'example.com',
    title: '示例',
    groupId: group.group.id,
  });
  ok(urlEntry.entry.target === 'https://example.com/', '网址自动补 https 并规范化');
  const note = await call('create_note', { title: '首页入口笔记', content: 'x' });
  const noteEntry = await call('add_home_entry', { type: 'note', target: note.note.id, groupId: group.group.id });
  ok(noteEntry.entry.target === note.note.id, '笔记入口按 id 保存');
  await rejects(() => call('add_home_entry', { type: 'note', target: 'missing-id' }), 'NOT_FOUND', '拒绝不存在的笔记');
  await rejects(
    () => call('add_home_entry', { type: 'system', target: 'C:/x.exe' }),
    'BAD_TYPE',
    'MCP 不允许添加系统应用',
  );
  await rejects(
    () => call('add_home_entry', { type: 'url', target: 'javascript:alert(1)' }),
    'BAD_TARGET',
    '拒绝非 http(s) 网址',
  );

  const moved = await call('update_home_entry', {
    id: urlEntry.entry.id,
    title: '示例站点',
    target: 'https://example.org',
    groupName: 'AI 小应用',
    index: 0,
  });
  ok(moved.entry.title === '示例站点' && moved.group.name === 'AI 小应用', '入口改名并移动分组');
  let homeAfter = await call('list_home');
  const aiGroup = homeAfter.groups.find((g) => g.name === 'AI 小应用');
  ok(aiGroup.entries[0].id === urlEntry.entry.id, '移动后按指定顺序插入');
  await rejects(
    () => call('update_home_entry', { id: urlEntry.entry.id, type: 'note' }),
    'UNSUPPORTED',
    '不支持改入口类型',
  );

  const removed = await call('delete_home_entry', { id: noteEntry.entry.id });
  ok(removed.deleted && !removed.entry.local, '删除首页入口');
  await rejects(() => call('delete_home_group', { id: 'g-missing' }), 'NOT_FOUND', '删除不存在的分组报错');

  /* 分组删除联动：只剩网址入口在应用组，网站组为空 */
  const deletedGroup = await call('delete_home_group', { id: group.group.id });
  ok(deletedGroup.deleted && deletedGroup.removedEntries === 0, '删除空分组');
  homeAfter = await call('list_home');
  ok(homeAfter.groups.length === 1 && homeAfter.counts.entries === 2, '删除分组后入口计数正确');

  /* 统计 */
  const stats = await call('repo_stats');
  ok(stats.notes === 1 && stats.apps.total === 1 && stats.writing.totalNotes === 1, 'repo_stats 汇总笔记与应用');
  ok(stats.writing.daily.length === 7, '统计包含最近 7 天');
  const categories = await call('list_task_categories');
  ok(categories.total === 0 && categories.categories.length === 0, '空任务库分类为空');

  /* 删除应用：目录、快照与首页入口一起清理 */
  const deleted = await call('delete_app', { id: created.app.id });
  ok(deleted.deleted && deleted.removedEntries === 1, '删除应用并移除首页入口');
  await assert.rejects(fs.stat(appDir));
  await assert.rejects(fs.stat(path.join(root, '.glimnote', 'history', 'apps', created.app.id)));
  info = await call('repo_info');
  ok(info.apps === 0 && info.homeEntries === 1, '删除应用后 repo_info 计数正确');

  console.log(`\nAI 小应用 / 首页 MCP 冒烟通过：${passed} 项`);
  console.log(`临时仓库：${root}`);
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
