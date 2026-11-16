import { desktop } from './desktop';
import { NOTIFY_CHANNEL_LABEL, taskTitle, type Task, type TaskNotifyChannel } from './tasks';

/**
 * 待办到点后，除了桌面浮层，还可以推一条消息到群里。
 *
 * 三个平台都只需要「群机器人 Webhook」：地址只存在本机 localStorage，不写进仓库，
 * 也不会跟着 Git 同步到别的设备。每一条待办单独勾选渠道，避免所有提醒都刷到同一个群。
 */

export interface NotifyChannelInfo {
  id: TaskNotifyChannel;
  label: string;
  /** 设置页的一句话说明 */
  desc: string;
  placeholder: string;
}

export const NOTIFY_CHANNELS: NotifyChannelInfo[] = [
  {
    id: 'wecom',
    label: NOTIFY_CHANNEL_LABEL.wecom,
    desc: '群聊右上角 → 群机器人 → 添加机器人，复制 Webhook 地址。',
    placeholder: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…',
  },
  {
    id: 'feishu',
    label: NOTIFY_CHANNEL_LABEL.feishu,
    desc: '群设置 → 群机器人 → 添加自定义机器人，复制 Webhook 地址。',
    placeholder: 'https://open.feishu.cn/open-apis/bot/v2/hook/…',
  },
  {
    id: 'dingtalk',
    label: NOTIFY_CHANNEL_LABEL.dingtalk,
    desc: '群设置 → 智能群助手 → 添加机器人 → 自定义，复制 Webhook 地址。',
    placeholder: 'https://oapi.dingtalk.com/robot/send?access_token=…',
  },
];

const KEY_PREFIX = 'glimnote.notify.';

export function loadNotifyWebhooks(): Record<TaskNotifyChannel, string> {
  const out = {} as Record<TaskNotifyChannel, string>;
  for (const channel of NOTIFY_CHANNELS) {
    try {
      out[channel.id] = localStorage.getItem(`${KEY_PREFIX}${channel.id}`) || '';
    } catch {
      out[channel.id] = '';
    }
  }
  return out;
}

export function loadNotifyWebhook(channel: TaskNotifyChannel) {
  try {
    return localStorage.getItem(`${KEY_PREFIX}${channel}`) || '';
  } catch {
    return '';
  }
}

export function saveNotifyWebhook(channel: TaskNotifyChannel, url: string) {
  const clean = url.trim();
  try {
    if (clean) localStorage.setItem(`${KEY_PREFIX}${channel}`, clean);
    else localStorage.removeItem(`${KEY_PREFIX}${channel}`);
  } catch {
    /* 隐私模式下存不了，本次运行仍可用 */
  }
}

export function notifyConfigured(channel: TaskNotifyChannel) {
  return Boolean(loadNotifyWebhook(channel).trim());
}

function failText(channel: TaskNotifyChannel, detail: string) {
  return `${NOTIFY_CHANNEL_LABEL[channel]}通知发送失败：${detail}`;
}

/** 把各平台不一致的响应体收成一句人话；返回空串表示成功 */
function responseError(channel: TaskNotifyChannel, status: number, text: string) {
  if (status >= 400) return `HTTP ${status}`;
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // 有的反向代理会返回空正文；HTTP 2xx 就当作成功
    return text.trim() ? '返回内容不是 JSON，请检查 Webhook 地址' : '';
  }
  if (channel === 'feishu') {
    const code = data.code ?? data.StatusCode;
    if (code !== undefined && Number(code) !== 0) {
      return String(data.msg || data.StatusMessage || `飞书返回 ${code}`);
    }
    return '';
  }
  const code = data.errcode;
  if (code !== undefined && Number(code) !== 0) {
    return String(data.errmsg || data.message || `错误码 ${code}`);
  }
  return '';
}

function payload(channel: TaskNotifyChannel, text: string) {
  if (channel === 'feishu') {
    return { msg_type: 'text', content: { text } };
  }
  return { msgtype: 'text', text: { content: text } };
}

/** 向一个明确的 Webhook 地址发纯文本；本地到点通知和云端推送测试共用 */
export async function sendWebhookText(channel: TaskNotifyChannel, url: string, text: string) {
  const target = url.trim();
  if (!target) throw new Error(failText(channel, '还没有配置 Webhook'));
  const body = JSON.stringify(payload(channel, text));
  const headers = { 'Content-Type': 'application/json' };
  const bridge = desktop();
  if (bridge?.webhookSend) {
    let res;
    try {
      res = await bridge.webhookSend({ url: target, method: 'POST', headers, body });
    } catch (e) {
      throw new Error(failText(channel, (e as Error).message || '网络请求失败'));
    }
    const err = responseError(channel, res.status, res.text);
    if (err) throw new Error(failText(channel, err));
    return;
  }
  let res: Response;
  try {
    res = await fetch(target, { method: 'POST', headers, body });
  } catch {
    throw new Error(failText(channel, '网页版被浏览器跨域策略拦住，请改用桌面客户端，或换一个允许跨域的地址'));
  }
  const text2 = await res.text();
  const err = responseError(channel, res.status, text2);
  if (err) throw new Error(failText(channel, err));
}

async function postWebhook(channel: TaskNotifyChannel, text: string) {
  const url = loadNotifyWebhook(channel).trim();
  if (!url) throw new Error(failText(channel, '还没有在「设置 → 通知」里配置 Webhook'));
  await sendWebhookText(channel, url, text);
}

function timeText(at: Date) {
  const h = String(at.getHours()).padStart(2, '0');
  const m = String(at.getMinutes()).padStart(2, '0');
  return `${at.getMonth() + 1}月${at.getDate()}日 ${h}:${m}`;
}

function notesSnippet(task: Task) {
  const clean = task.notes
    .replace(/[#>*_`~-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length > 120 ? `${clean.slice(0, 120)}…` : clean;
}

export function buildTaskNotifyText(task: Task, at: Date, opts: { hideTitle?: boolean; lockedCount?: number } = {}) {
  if (opts.hideTitle) {
    const n = opts.lockedCount || 1;
    return n > 1 ? `萤光笔记：有 ${n} 条待办到时间了（应用已锁定）` : '萤光笔记：有 1 条待办到时间了（应用已锁定）';
  }
  const lines = ['【萤光笔记 待办提醒】', `待办：${taskTitle(task)}`, `时间：${timeText(at)}`];
  if (task.category) lines.push(`分类：${task.category}`);
  const snippet = notesSnippet(task);
  if (snippet) lines.push(`备注：${snippet}`);
  return lines.join('\n');
}

/** 到点提醒时调用：只发给任务里勾选、且设置里配了地址的渠道 */
export async function sendTaskNotify(
  task: Task,
  at: Date,
  channels: TaskNotifyChannel[],
  opts: { hideTitle?: boolean; lockedCount?: number } = {},
) {
  const enabled = channels.filter(notifyConfigured);
  if (!enabled.length) return [];
  const text = buildTaskNotifyText(task, at, opts);
  return Promise.allSettled(enabled.map((channel) => postWebhook(channel, text)));
}

export async function testNotifyChannel(channel: TaskNotifyChannel) {
  await postWebhook(
    channel,
    `【萤光笔记 测试通知】\n收到这条消息说明${NOTIFY_CHANNEL_LABEL[channel]} Webhook 配置正确。\n时间段：${timeText(new Date())}`,
  );
}
