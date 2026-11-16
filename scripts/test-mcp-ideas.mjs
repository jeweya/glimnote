/**
 * MCP 灵感 / 每日日记工具冒烟：直接对临时仓库调用工具，不启动 HTTP 服务。
 * 覆盖：工具清单、灵感增删改查、两种整理、已转化只读、路径与长度边界、每日日记创建与追加。
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
    return;
  }
  throw new Error(`${label}：应当报错 ${code}`);
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'glimnote-mcp-ideas-'));
const store = createStore(root);
const call = (name, args) => callTool(name, args, store);

try {
  /* 工具清单 */
  const names = TOOLS.map((t) => t.name);
  assert.equal(names.length, 56);
  for (const name of [
    'list_ideas',
    'get_idea',
    'create_idea',
    'update_idea',
    'delete_idea',
    'convert_ideas',
    'get_daily_note',
    'append_daily_note',
  ]) {
    ok(names.includes(name), `工具清单包含 ${name}`);
  }

  /* 空仓库 */
  let info = await call('repo_info');
  ok(info.ideas === 0 && info.openIdeas === 0, '空仓库灵感计数为 0');
  let listed = await call('list_ideas');
  ok(listed.total === 0 && listed.counts.total === 0, '空灵感库返回 0');

  /* 新建与读取 */
  const a = await call('create_idea', { text: '把首页的加载速度再压一压' });
  ok(a.created && a.idea.open, '新建灵感');
  ok(/^ideas\/\d{4}\/\d{2}\/[0-9a-z]{12}\.md$/.test(a.idea.path), '灵感路径为 ideas/YYYY/MM/<id>.md');
  ok(a.idea.text === '把首页的加载速度再压一压', '正文原样保存');
  await new Promise((r) => setTimeout(r, 15));
  const b = await call('create_idea', { text: '给搜索框加个快捷键\n第二行是补充说明' });
  ok(b.idea.text.includes('\n第二行'), '多行灵感保留换行');

  listed = await call('list_ideas');
  ok(listed.total === 2 && listed.counts.open === 2, '默认只列未整理');
  ok(listed.ideas[0].id === b.idea.id, '按记下时间倒序');
  const found = await call('list_ideas', { query: '搜索框' });
  ok(found.total === 1 && found.ideas[0].id === b.idea.id, '按正文搜索');
  const one = await call('get_idea', { id: a.idea.id });
  ok(one.idea.id === a.idea.id && one.idea.text === a.idea.text, '按 id 读取灵感');
  const byPath = await call('get_idea', { path: a.idea.path.replace(/^ideas\//, '') });
  ok(byPath.idea.id === a.idea.id, 'path 可省略 ideas/ 前缀');

  /* 修改 */
  const updated = await call('update_idea', { id: a.idea.id, text: '把首页加载速度压到 1 秒内' });
  ok(updated.idea.text === '把首页加载速度压到 1 秒内', '修改灵感正文');
  const fileA = await fs.readFile(path.join(root, a.idea.path), 'utf8');
  ok(
    fileA.startsWith('---\nid: ') && /^created: /m.test(fileA) && /^updated: /m.test(fileA),
    '灵感文件 frontmatter 顺序稳定',
  );
  ok(fileA.endsWith('把首页加载速度压到 1 秒内'), '灵感文件正文结尾无多余空行');

  /* 单条转笔记 */
  const toNote = await call('convert_ideas', { ids: [a.idea.id], target: 'note' });
  ok(toNote.converted && toNote.count === 1 && toNote.note, '单条灵感转笔记');
  ok(toNote.note.title === '把首页加载速度压到 1 秒内', '单条笔记标题取正文首行');
  ok(toNote.note.notebook === 'inbox', '转出的笔记放在 inbox');
  const noteRaw = await fs.readFile(path.join(root, toNote.note.path), 'utf8');
  ok(noteRaw.includes('把首页加载速度压到 1 秒内'), '笔记正文包含灵感原文');
  const aAfter = await call('get_idea', { id: a.idea.id });
  ok(aAfter.idea.convertedType === 'note' && aAfter.idea.convertedId === toNote.note.id, '灵感回写转化信息');
  ok(aAfter.idea.convertedTitle === toNote.note.title, '灵感回写成品标题');

  /* 已转化只读与不重复转化 */
  await rejects(() => call('update_idea', { id: a.idea.id, text: '改一下' }), 'IDEA_CONVERTED', '已转化灵感不可修改');
  await rejects(
    () => call('convert_ideas', { ids: [a.idea.id], target: 'task' }),
    'IDEA_CONVERTED',
    '已转化灵感不可重复转化',
  );

  /* 多条转待办（这里只剩一条，验证拆分规则） */
  const toTask = await call('convert_ideas', { ids: [b.idea.id], target: 'task' });
  ok(toTask.converted && toTask.tasks.length === 1, '灵感转待办');
  ok(toTask.tasks[0].status === 'inbox', '待办初始为待整理');
  ok(toTask.tasks[0].title === '给搜索框加个快捷键', '待办标题取首行');
  const taskRaw = await fs.readFile(path.join(root, toTask.tasks[0].path), 'utf8');
  ok(taskRaw.includes('第二行是补充说明'), '待办备注保留多行内容');

  /* 多条合并成一篇笔记 */
  const d = await call('create_idea', { text: '早上想到：给灵感加个快捷键' });
  await new Promise((r) => setTimeout(r, 15));
  const e = await call('create_idea', { text: '晚上想到：整理台可以再简化' });
  const merged = await call('convert_ideas', { paths: [e.idea.path, d.idea.path], target: 'note' });
  const now = new Date();
  ok(
    merged.count === 2 && merged.note.title === `灵感整理 · ${now.getMonth() + 1}月${now.getDate()}日`,
    '多条合并笔记标题',
  );
  const mergedRaw = await fs.readFile(path.join(root, merged.note.path), 'utf8');
  ok(
    mergedRaw.indexOf('给灵感加个快捷键') >= 0 &&
      mergedRaw.indexOf('给灵感加个快捷键') < mergedRaw.indexOf('整理台可以再简化'),
    '合并笔记按记下时间从早到晚',
  );
  ok(/^- \d{2}:\d{2} · /m.test(mergedRaw), '合并笔记带时间清单');
  const dAfter = await call('get_idea', { id: d.idea.id });
  ok(dAfter.idea.convertedType === 'note' && dAfter.idea.convertedId === merged.note.id, '多条合并后逐条回写');

  /* 多条拆成待办 */
  const f = await call('create_idea', { text: '把设置页的开关分组' });
  await new Promise((r) => setTimeout(r, 15));
  const g = await call('create_idea', { text: '给导出加一个进度条' });
  const split = await call('convert_ideas', { ids: [g.idea.id, f.idea.id], target: 'task' });
  ok(split.count === 2 && split.tasks.length === 2, '两条灵感拆成两条待办');
  ok(split.tasks[0].status === 'inbox' && split.tasks[1].status === 'inbox', '拆出的待办都为待整理');
  ok(
    split.tasks[0].title === '把设置页的开关分组' && split.tasks[1].title === '给导出加一个进度条',
    '拆待办保持时间顺序',
  );

  /* 列表过滤 */
  listed = await call('list_ideas', { status: 'open' });
  ok(listed.total === 0, '全部转化后未整理为空');
  listed = await call('list_ideas', { status: 'converted' });
  ok(listed.total === 6 && listed.counts.converted === 6, '已转化页签');
  listed = await call('list_ideas', { status: 'all', convertedType: 'task' });
  ok(listed.total === 3, '按整理去向筛选待办');
  listed = await call('list_ideas', { status: 'all', convertedType: 'note' });
  ok(listed.total === 3, '按整理去向筛选笔记');

  /* 删除 */
  const c = await call('create_idea', { text: '一条待删除的灵感' });
  const del = await call('delete_idea', { id: c.idea.id });
  ok(del.deleted && del.recoverable === false, '删除灵感标记不可恢复');
  await rejects(() => fs.access(path.join(root, c.idea.path)), 'ENOENT', '删除后文件不存在');
  await rejects(() => call('get_idea', { id: c.idea.id }), 'NOT_FOUND', '删除后按 id 找不到');

  /* 边界 */
  await rejects(() => call('create_idea', { text: '   ' }), 'EMPTY_CONTENT', '空灵感不保存');
  await rejects(() => call('create_idea', { text: 'x'.repeat(2001) }), 'TOO_LONG', '超过 2000 字拒绝');
  await rejects(() => call('get_idea', { path: '../outside.md' }), 'BAD_PATH', '拒绝 .. 路径');
  await rejects(() => call('convert_ideas', { target: 'note' }), undefined, '整理时不选灵感报错');

  /* 每日日记 */
  const dailyMiss = await call('get_daily_note', { date: '2026-10-30' });
  ok(dailyMiss.found === false && dailyMiss.title === '10月30日 周五', '当天日记不存在时不创建');
  const d1 = await call('append_daily_note', { date: '2026-10-30', content: '今天把 MCP 补上灵感工具。' });
  ok(d1.appended && d1.created, '第一次追加会创建当天日记');
  const dailyRaw = await fs.readFile(path.join(root, d1.note.path), 'utf8');
  ok(dailyRaw.includes('title: 2026-10-30'), '日记标题为日期键');
  ok(dailyRaw.includes('# 10月30日 周五'), '日记正文首行为中文日期');
  ok(/^tags: \[日记\]$/m.test(dailyRaw), '日记带「日记」标签');
  const d2 = await call('append_daily_note', { date: '2026-10-30', content: '第二条记录。' });
  ok(d2.created === false, '同一天第二次追加不重复创建');
  const daily = await call('get_daily_note', { date: '2026-10-30' });
  ok(
    daily.found && daily.note.content.includes('MCP 补上灵感工具') && daily.note.content.includes('第二条记录'),
    '日记内容按顺序追加',
  );
  ok(daily.note.notebook === '日记', '日记落在「日记」笔记本');
  await rejects(
    () => call('append_daily_note', { date: '2026-10-31', content: '   ' }),
    'EMPTY_CONTENT',
    '空内容不追加',
  );
  const emptyDay = await call('get_daily_note', { date: '2026-10-31' });
  ok(emptyDay.found === false, '空内容追加失败时不会留下空日记');
  await rejects(() => call('append_daily_note', { date: '2026-13-01', content: 'x' }), undefined, '非法日期报错');

  /* 最终计数 */
  info = await call('repo_info');
  ok(info.ideas === 6 && info.openIdeas === 0, 'repo_info 统计灵感总数与未整理数');

  console.log(`\n灵感 / 日记 MCP 冒烟通过：${passed} 项`);
  console.log(`临时仓库：${root}`);
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
