import { META_DIR, ROOT, readText, removePath, writeText } from './storage';
import { isOpenTask, taskTitle, type Task, type TaskNotifyChannel } from './tasks';
import type { Provider } from './git';
import { sendWebhookText } from './taskNotify';
import pushScriptSource from './templates/push.mjs?raw';

/**
 * 云端推送。
 *
 * 桌面端只负责三个文件：push.json（配置，含 Webhook）、digest.json（待办摘要）、
 * push.mjs（无依赖发送脚本），再加上一份平台工作流。它们都在仓库里，随普通同步上传；
 * 平台按 cron 起一个 Node 进程，读摘要、算窗口、发一条汇总消息。
 *
 * 这样即使电脑没开、应用没运行，推送也能照常发生；本机不常驻任何定时器。
 */

export const CLOUD_PUSH_FILE = `${META_DIR}/push.json`;
export const CLOUD_PUSH_DIGEST_FILE = `${META_DIR}/digest.json`;
export const CLOUD_PUSH_SCRIPT_FILE = `${META_DIR}/push.mjs`;
export const CLOUD_PUSH_GITHUB_WORKFLOW = `${ROOT}/.github/workflows/glimnote-push.yml`;
export const CLOUD_PUSH_GITCODE_WORKFLOW = `${ROOT}/.gitcode/workflows/glimnote-push.yml`;

/** 平台定时任务按北京时间理解；写成固定偏移，CI 里不用处理夏令时 */
export const CLOUD_PUSH_TIMEZONE = 'Asia/Shanghai';
export const CLOUD_PUSH_UTC_OFFSET_HOURS = 8;
export const CLOUD_PUSH_WINDOW_MIN = 24;
export const CLOUD_PUSH_WINDOW_MAX = 24 * 7;
export const CLOUD_PUSH_DEFAULT_TIME = '08:00';
export const CLOUD_PUSH_DEFAULT_WINDOW = 24;

export interface CloudPushConfig {
  enabled: boolean;
  channel: TaskNotifyChannel;
  webhook: string;
  /** 每天几点推送，HH:mm（北京时间） */
  time: string;
  /** 从推送时间往后算多少小时；最小 24 */
  windowHours: number;
  /**
   * 手动「刷新配置」的时间戳。只写进工作流文件的注释里：
   * 平台只有在工作流文件内容变化时才会重新登记定时任务，单纯同步不会产生提交。
   */
  refreshedAt?: string;
}

export const DEFAULT_CLOUD_PUSH: CloudPushConfig = {
  enabled: false,
  channel: 'wecom',
  webhook: '',
  time: CLOUD_PUSH_DEFAULT_TIME,
  windowHours: CLOUD_PUSH_DEFAULT_WINDOW,
};

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const CHANNELS: TaskNotifyChannel[] = ['wecom', 'feishu', 'dingtalk'];

function clampWindow(n: unknown) {
  const value = typeof n === 'number' ? n : Number(n);
  if (!Number.isFinite(value)) return CLOUD_PUSH_DEFAULT_WINDOW;
  return Math.min(CLOUD_PUSH_WINDOW_MAX, Math.max(CLOUD_PUSH_WINDOW_MIN, Math.round(value)));
}

/** 手改过 / 旧版本的文件都可能缺字段，读进来先收一遍 */
export function normalizeCloudPush(value: unknown): CloudPushConfig {
  const raw = (value || {}) as Partial<CloudPushConfig>;
  const channel = CHANNELS.includes(raw.channel as TaskNotifyChannel)
    ? (raw.channel as TaskNotifyChannel)
    : DEFAULT_CLOUD_PUSH.channel;
  return {
    enabled: raw.enabled === true || (raw.enabled as unknown) === 'true',
    channel,
    webhook: typeof raw.webhook === 'string' ? raw.webhook.trim() : '',
    time: typeof raw.time === 'string' && TIME_RE.test(raw.time) ? raw.time : CLOUD_PUSH_DEFAULT_TIME,
    windowHours: clampWindow(raw.windowHours),
    refreshedAt: typeof raw.refreshedAt === 'string' && raw.refreshedAt.trim() ? raw.refreshedAt.trim() : undefined,
  };
}

let cache: CloudPushConfig | null = null;

/** 组件里同步读取用；第一次打开前先调用 readCloudPushConfig() */
export function cachedCloudPushConfig() {
  return cache || DEFAULT_CLOUD_PUSH;
}

export async function readCloudPushConfig(): Promise<CloudPushConfig> {
  try {
    const raw = await readText(CLOUD_PUSH_FILE);
    cache = normalizeCloudPush(JSON.parse(raw));
  } catch {
    cache = DEFAULT_CLOUD_PUSH;
  }
  window.dispatchEvent(new Event('glimnote:cloud-push-changed'));
  return cache;
}

/** 浏览器预览时没有真实仓库目录，写文件会失败；界面仍要能保存配置 */
function canWriteFiles() {
  return typeof window !== 'undefined';
}

interface DigestEntry {
  id: string;
  title: string;
  /** 带时区偏移的 ISO；全天任务按当天 23:59（北京时间）算 */
  dueAt: string;
  dueDate: string;
  allDay: boolean;
  priority: string;
  category?: string;
}

export function digestEntries(tasks: Task[]): DigestEntry[] {
  const out: DigestEntry[] = [];
  for (const task of tasks) {
    if (!task.cloudPush || !task.due || !isOpenTask(task) || task.deletedAt) continue;
    const date = task.due.slice(0, 10);
    const time = task.dueTime && TIME_RE.test(task.dueTime) ? task.dueTime : '23:59';
    const dueAt = `${date}T${time}:00+0${CLOUD_PUSH_UTC_OFFSET_HOURS}:00`;
    if (!Number.isFinite(Date.parse(dueAt))) continue;
    out.push({
      id: task.id,
      title: taskTitle(task).slice(0, 200),
      dueAt,
      dueDate: date,
      allDay: !task.dueTime,
      priority: task.priority,
      category: task.category,
    });
  }
  out.sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt));
  return out;
}

function cronOf(time: string) {
  const [h, m] = time.split(':').map(Number);
  const utcHour = (h - CLOUD_PUSH_UTC_OFFSET_HOURS + 24) % 24;
  return `${m} ${utcHour} * * *`;
}

/** 本地时间戳，精确到秒；两次刷新才不会写出同一份内容 */
function refreshStamp() {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 手动刷新过才写这行；平时没有，内容保持稳定 */
function stampLine(refreshedAt?: string) {
  return refreshedAt ? `# 配置刷新：${refreshedAt}\n` : '';
}

function githubWorkflow(cron: string, refreshedAt?: string) {
  return `# 由萤光笔记自动生成：设置 → 通知 → 云端推送
${stampLine(refreshedAt)}name: Glimnote Daily Push
on:
  schedule:
    - cron: '${cron}'
  workflow_dispatch:
permissions:
  contents: read
concurrency:
  group: glimnote-daily-push
  cancel-in-progress: false
jobs:
  push:
    runs-on: ubuntu-latest
    steps:
      # v5 起这些 action 本身跑在 Node 24 上，避免 GitHub 的 Node 20 弃用警告
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version: '24'
      - name: Send daily digest
        run: node .glimnote/push.mjs
`;
}

function digestFile(cfg: CloudPushConfig, tasks: Task[]) {
  return JSON.stringify(
    {
      version: 1,
      timezone: CLOUD_PUSH_TIMEZONE,
      time: cfg.time,
      windowHours: cfg.windowHours,
      tasks: digestEntries(tasks),
    },
    null,
    2,
  );
}

async function removeQuietly(path: string) {
  try {
    await removePath(path);
  } catch {
    /* 本来就不存在 */
  }
}

/**
 * 内容没变就不写：每次同步都会跑一遍，避免摘要文件被无意义地改一遍、多出一条提交。
 * 文件里有任务列表但没有时间戳，所以两次内容可以直接比。
 */
async function writeIfChanged(path: string, content: string) {
  const next = content.endsWith('\n') ? content : content + '\n';
  try {
    if ((await readText(path)) === next) return;
  } catch {
    /* 还不存在 */
  }
  await writeText(path, next);
}

/** 写出 CI 需要的全部文件；云端推送只支持 GitHub，其他平台不生成任何会执行的流水线 */
export async function writeCloudPushArtifacts(
  cfg: CloudPushConfig,
  tasks: Task[],
  provider?: Provider,
  repoFull?: string,
) {
  if (!canWriteFiles()) return;
  // 平台名和仓库名写进 push.json，发送脚本把它们附在消息末尾；
  // 同一个群里可能开着多个仓库，一眼就能分辨消息来自哪里
  const platform = provider === 'github' ? 'GitHub' : provider === 'gitcode' ? 'GitCode' : '';
  const repo = (repoFull || '').trim();
  const configFile = JSON.stringify({ ...cfg, timezone: CLOUD_PUSH_TIMEZONE, platform, repo }, null, 2);
  if (!cfg.enabled) {
    // 关掉时保留 push.json（Webhook、时间等下次开启还要用），只清掉会执行的流水线和摘要
    await writeIfChanged(CLOUD_PUSH_FILE, configFile);
    await Promise.all(
      [CLOUD_PUSH_DIGEST_FILE, CLOUD_PUSH_SCRIPT_FILE, CLOUD_PUSH_GITHUB_WORKFLOW, CLOUD_PUSH_GITCODE_WORKFLOW].map(
        removeQuietly,
      ),
    );
    return;
  }
  if (provider !== 'github') {
    // GitCode 的定时任务会悄悄丢注册，已停止支持；旧配置即使还开着也不再生成摘要和脚本，
    // 并清掉遗留的 GitCode 工作流，避免它继续按旧摘要往群里发消息
    await writeIfChanged(CLOUD_PUSH_FILE, configFile);
    await Promise.all(
      [CLOUD_PUSH_DIGEST_FILE, CLOUD_PUSH_SCRIPT_FILE, CLOUD_PUSH_GITHUB_WORKFLOW, CLOUD_PUSH_GITCODE_WORKFLOW].map(
        removeQuietly,
      ),
    );
    return;
  }
  await writeIfChanged(CLOUD_PUSH_FILE, configFile);
  await writeIfChanged(CLOUD_PUSH_DIGEST_FILE, digestFile(cfg, tasks));
  await writeIfChanged(CLOUD_PUSH_SCRIPT_FILE, pushScriptSource);
  await writeIfChanged(CLOUD_PUSH_GITHUB_WORKFLOW, githubWorkflow(cronOf(cfg.time), cfg.refreshedAt));
  await removeQuietly(CLOUD_PUSH_GITCODE_WORKFLOW);
}

/**
 * 同步前调用：GitCode 等旧平台如果还留着开启状态，自动关掉并清理会执行的流水线与摘要。
 * push.json 里的 Webhook、时间等配置保留；以后换到 GitHub 仓库可以直接重新开启。
 */
export async function disableLegacyCloudPush(tasks: Task[], provider?: Provider, repoFull?: string) {
  const cfg = cache || (await readCloudPushConfig());
  if (!cfg.enabled || provider === 'github') return false;
  cache = { ...cfg, enabled: false };
  await writeCloudPushArtifacts(cache, tasks, provider, repoFull);
  window.dispatchEvent(new Event('glimnote:cloud-push-changed'));
  return true;
}

/** 同步前调用：配置开着就刷新摘要和工作流，任务改了不必手动点保存 */
export async function refreshCloudPushDigest(tasks: Task[], provider?: Provider, repoFull?: string) {
  // 云端推送只支持 GitHub；GitCode 的定时任务不稳定，已不再生成或刷新相关文件
  if (provider !== 'github') return;
  const cfg = cache || (await readCloudPushConfig());
  if (!cfg.enabled) return;
  await writeCloudPushArtifacts(cfg, tasks, provider, repoFull);
}

export async function saveCloudPushConfig(cfg: CloudPushConfig, tasks: Task[], provider?: Provider, repoFull?: string) {
  // 设置页提交的是表单字段；保留上次「刷新配置」的时间戳，别让普通保存把它丢掉
  cache = normalizeCloudPush({ ...(cache || {}), ...cfg });
  await writeCloudPushArtifacts(cache, tasks, provider, repoFull);
  window.dispatchEvent(new Event('glimnote:cloud-push-changed'));
}

/**
 * 待办详情里的「刷新配置」：更新工作流注释里的时间戳，让文件内容真正变一次。
 * GitHub 只在工作流文件变化时重新登记定时任务；
 * 平台悄悄把定时任务丢了的场景下，这是不需要改推送时间的恢复办法。
 * 写完后由调用方触发一次强制同步，把新文件提交上去。
 */
export async function refreshCloudPushRegistration(tasks: Task[], provider?: Provider, repoFull?: string) {
  if (provider !== 'github') {
    throw new Error('云端推送目前只支持 GitHub 仓库');
  }
  const current = cache || (await readCloudPushConfig());
  if (!current.enabled) throw new Error('云端推送还没开启');
  const next = normalizeCloudPush({ ...current, refreshedAt: refreshStamp() });
  cache = next;
  await writeCloudPushArtifacts(next, tasks, provider, repoFull);
  window.dispatchEvent(new Event('glimnote:cloud-push-changed'));
  return next;
}

/** 设置页「测试」：直接往这个地址发一条样例，不经过 CI */
export async function testCloudPush(cfg: CloudPushConfig) {
  const [h, m] = cfg.time.split(':');
  const text = [
    '【萤光笔记 · 云端推送测试】',
    '收到这条消息说明 Webhook 地址可用。',
    `推送时间：每天 ${h}:${m}（北京时间）`,
    `推送窗口：${h}:${m} 起 ${cfg.windowHours} 小时`,
    '只会推送在待办里勾了「云端推送」的任务；本机到点提醒和群通知照常，不受影响。',
  ].join('\n');
  await sendWebhookText(cfg.channel, cfg.webhook, text);
}
