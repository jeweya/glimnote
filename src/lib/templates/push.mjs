// 由萤光笔记自动生成：设置 → 通知 → 云端推送
// 不要手改，应用下次同步会覆盖。读取同目录的 push.json / digest.json 后发一条汇总。
import { readFileSync } from 'node:fs';

const readJson = (name) => JSON.parse(readFileSync(new URL(name, import.meta.url), 'utf8'));

let cfg;
let digest;
try {
  cfg = readJson('./push.json');
  digest = readJson('./digest.json');
} catch {
  console.log('没有推送配置，跳过');
  process.exit(0);
}
if (!cfg || !cfg.enabled || !cfg.webhook) {
  console.log('云端推送未启用，跳过');
  process.exit(0);
}

const tz = cfg.timezone || 'Asia/Shanghai';
const hours = Math.max(24, Number(cfg.windowHours) || 24);
const now = new Date();
const nowMs = now.getTime();
const pad = (n) => String(n).padStart(2, '0');
const dayKey = (date) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);

/** 任意时区都能算出偏移；配置固定是北京时间，这里不依赖夏令时规则 */
function zoneOffset(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
    .formatToParts(date)
    .reduce((acc, part) => {
      if (part.type !== 'literal') acc[part.type] = part.value;
      return acc;
    }, {});
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - date.getTime();
}

// 定时任务可能晚点启动：用「今天计划时间」当窗口起点，晚启动也不会漏掉刚过点的待办；
// 手动触发、或距计划时间太远时，就从现在开始算。
const todayKey = dayKey(now);
const [hh, mm] = String(cfg.time || '08:00').split(':').map(Number);
const scheduled =
  Date.parse(todayKey + 'T' + pad(hh) + ':' + pad(mm) + ':00Z') - zoneOffset(now);
// GitHub 的定时任务只是「尽力而为」：高峰期可能晚几小时才真正启动。
// 晚太多就跳过这一次，免得 18:40 的汇总被拖到凌晨才发；手动触发不受这个限制。
const isGithub = String(cfg.platform || '') === 'GitHub';
const manual = process.env.GITHUB_EVENT_NAME === 'workflow_dispatch';
const lateMs = nowMs - scheduled;
if (isGithub && !manual && lateMs > 2 * 3600 * 1000) {
  console.log(
    '定时任务比计划晚 ' + (lateMs / 3600000).toFixed(1) + ' 小时启动，跳过本次，避免深夜打扰',
  );
  process.exit(0);
}
const start =
  scheduled <= nowMs && nowMs - scheduled <= 12 * 3600 * 1000 ? scheduled : nowMs;
const end = start + hours * 3600 * 1000;

const tasks = Array.isArray(digest.tasks) ? digest.tasks : [];
const due = [];
for (const task of tasks) {
  const at = Date.parse(task.dueAt || '');
  if (!Number.isFinite(at)) continue;
  // 只发窗口内的任务；逾期任务不再每天重复推送，由应用里的本机提醒负责
  if (at >= start && at < end) due.push({ ...task, at });
}

if (!due.length) {
  console.log('窗口内没有待办，不发消息');
  process.exit(0);
}

const mdOf = (ms) =>
  new Intl.DateTimeFormat('zh-CN', { timeZone: tz, month: 'long', day: 'numeric' }).format(
    new Date(ms),
  );
const timeOf = (task) => {
  if (task.allDay) return '全天';
  const h = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(task.at));
  return h;
};
const labelOf = (ms) => {
  const diff = Math.round(
    (Date.parse(dayKey(new Date(ms)) + 'T00:00:00Z') - Date.parse(todayKey + 'T00:00:00Z')) /
      86400000,
  );
  if (diff === 0) return '今天';
  if (diff === 1) return '明天';
  if (diff === 2) return '后天';
  return mdOf(ms);
};
const lineOf = (task) => {
  const star = task.priority === 'high' ? '‼ ' : '';
  const cat = task.category ? '（' + task.category + '）' : '';
  return '· ' + timeOf(task) + ' ' + star + task.title + cat;
};

const counts = new Map();
for (const task of due) {
  const label = labelOf(task.at);
  counts.set(label, (counts.get(label) || 0) + 1);
}
const body = [];
let lastLabel = '';
for (const task of due) {
  const label = labelOf(task.at);
  if (label !== lastLabel) {
    body.push(label + '（' + counts.get(label) + '）');
    lastLabel = label;
  }
  body.push(lineOf(task));
}
// 企业微信 text 消息上限 2048 字节，留出余量；超长时按行截断，别把一条消息发失败
const LIMIT = 1800;
const head = '【萤光笔记 · ' + mdOf(nowMs) + '待办】';
// 末尾带上平台名和仓库名：同一个群里可能开着多个仓库，一眼就能分清消息来源
const platform = String(cfg.platform || '').trim();
const repo = String(cfg.repo || '').trim();
const source = platform && repo
  ? '来自 ' + platform + '（' + repo + '）'
  : platform
    ? '来自 ' + platform
    : repo
      ? '来自 ' + repo
      : '';
const footer = '共 ' + due.length + ' 条' + (source ? ' · ' + source : '');
const packed = [];
let bytes = Buffer.byteLength(head + '\n' + footer, 'utf8') + 8;
let itemTotal = 0;
let itemShown = 0;
let truncated = false;
for (const line of body) {
  const isItem = line.startsWith('· ');
  if (isItem) itemTotal += 1;
  const size = Buffer.byteLength(line + '\n', 'utf8');
  if (truncated || bytes + size > LIMIT) {
    truncated = true;
    continue;
  }
  packed.push(line);
  bytes += size;
  if (isItem) itemShown += 1;
}
const skipped = itemTotal - itemShown;
if (skipped > 0) packed.push('…还有 ' + skipped + ' 条，打开应用查看');
const text = [head, packed.join('\n'), footer].filter(Boolean).join('\n');

const payload =
  cfg.channel === 'feishu'
    ? { msg_type: 'text', content: { text } }
    : { msgtype: 'text', text: { content: text } };

let res;
try {
  res = await fetch(cfg.webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
} catch (e) {
  console.error('网络请求失败：' + (e && e.message ? e.message : e));
  process.exit(1);
}
const reply = await res.text().catch(() => '');
if (!res.ok) {
  console.error('推送失败：HTTP ' + res.status);
  process.exit(1);
}
try {
  const data = JSON.parse(reply);
  const code =
    data.code !== undefined ? data.code : data.StatusCode !== undefined ? data.StatusCode : data.errcode;
  if (code !== undefined && Number(code) !== 0) {
    console.error('推送失败：' + (data.msg || data.StatusMessage || data.errmsg || code));
    process.exit(1);
  }
} catch {
  // 有的反向代理返回空正文，HTTP 2xx 就当作成功
}
console.log('已推送 ' + due.length + ' 条' + (source ? ' · ' + source : ''));
