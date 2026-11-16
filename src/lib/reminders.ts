import { isOpenTask, taskDueAt, type Task } from './tasks';

/**
 * 待办到点提醒的本地状态。
 *
 * 只用 localStorage 记两件小事：
 * - 哪条待办已经响过（同一条待办改了日期 / 时间要重新提醒）；
 * - 点了「10 分钟后」的暂时静音。
 * 不往仓库写任何提醒记录，所以不会把 pending 状态弄脏，也不会同步到别的设备。
 */

export const REMINDER_PREF_KEY = 'glimnote.taskReminder';
export const REMINDER_FIRED_KEY = 'glimnote.taskReminders';
export const REMINDER_SNOOZE_KEY = 'glimnote.taskSnooze';

/** 超过这个时间就不再补报：早上打开电脑，不应该为昨晚的任务连响一串 */
export const REMINDER_WINDOW = 45 * 60 * 1000;
export const SNOOZE_MS = 10 * 60 * 1000;

export function remindersEnabled() {
  try {
    return localStorage.getItem(REMINDER_PREF_KEY) !== '0';
  } catch {
    return true;
  }
}

export function setRemindersEnabled(on: boolean) {
  try {
    localStorage.setItem(REMINDER_PREF_KEY, on ? '1' : '0');
  } catch {
    /* 隐私模式下存不了也不影响本次运行 */
  }
  window.dispatchEvent(new Event('glimnote:reminder-pref'));
}

/** 同一条待办的「这一次到期」：改了日期或时间就算新的一次 */
export function reminderKey(task: Task) {
  return `${task.due || ''}T${task.dueTime || ''}`;
}

/** 0 = 到点提醒；其余为提前分钟数，升序去重 */
export function reminderOffsetsOf(task: Task) {
  const list = [0, ...(task.remindBefore || [])];
  return [...new Set(list.filter((n) => Number.isInteger(n) && n >= 0))].sort((a, b) => a - b);
}

/** 一次提醒：offset 是本次触发的档位，offsets 是同时被这一响消化掉的档位 */
export interface DueReminder {
  task: Task;
  offset: number;
  offsets: number[];
}

interface FiredEntry {
  key: string;
  at: number;
}

interface SnoozeEntry {
  key: string;
  until: number;
}

function readMap<T>(key: string): Record<string, T> {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, T>) : {};
  } catch {
    return {};
  }
}

function writeMap(key: string, value: Record<string, unknown>) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

/** 存储槽带档位，才可能「提前 1 天」和「提前 1 小时」各响一次；旧的只按任务 id 存的记录继续兼容 */
function firedSlot(taskId: string, offset: number) {
  return `${taskId}|${offset}`;
}

function firedEntryOf(fired: Record<string, FiredEntry>, task: Task, offset: number) {
  return fired[firedSlot(task.id, offset)] || (offset === 0 ? fired[task.id] : undefined);
}

export function markReminded(task: Task, offset = 0, now = Date.now()) {
  const fired = readMap<FiredEntry>(REMINDER_FIRED_KEY);
  fired[firedSlot(task.id, offset)] = { key: reminderKey(task), at: now };
  if (offset === 0) delete fired[task.id];
  writeMap(REMINDER_FIRED_KEY, fired);
}

export function clearReminded(task: Task) {
  const fired = readMap<FiredEntry>(REMINDER_FIRED_KEY);
  let changed = false;
  for (const slot of Object.keys(fired)) {
    if (slot === task.id || slot.startsWith(`${task.id}|`)) {
      delete fired[slot];
      changed = true;
    }
  }
  if (changed) writeMap(REMINDER_FIRED_KEY, fired);
}

export function snoozeReminder(task: Task, now = Date.now(), ms = SNOOZE_MS) {
  // 静音期间不算响过：10 分钟后再走一遍正常判断
  clearReminded(task);
  const snooze = readMap<SnoozeEntry>(REMINDER_SNOOZE_KEY);
  snooze[task.id] = { key: reminderKey(task), until: now + ms };
  writeMap(REMINDER_SNOOZE_KEY, snooze);
}

function readSnooze(task: Task, now: number) {
  const snooze = readMap<SnoozeEntry>(REMINDER_SNOOZE_KEY);
  const entry = snooze[task.id];
  if (!entry) return { active: false, woke: false };
  // 日期 / 时间改过，旧的暂缓自动作废
  if (entry.key !== reminderKey(task)) {
    delete snooze[task.id];
    writeMap(REMINDER_SNOOZE_KEY, snooze);
    return { active: false, woke: false };
  }
  // 暂缓刚结束：允许补响一次，不受 45 分钟窗口限制
  if (entry.until <= now) {
    delete snooze[task.id];
    writeMap(REMINDER_SNOOZE_KEY, snooze);
    return { active: false, woke: true };
  }
  return { active: true, woke: false };
}

/**
 * 找出「现在该响」的待办。每个任务每轮最多返回一档：
 * - 到点档：未超过 45 分钟，或「10 分钟后」刚结束；
 * - 提前档：提醒时刻已到、还没过截止时刻；错过多档时只补最接近现在的一档。
 * 只认设了具体时间的待办；只有日期的任务不猜时刻。
 */
export function dueReminders(tasks: Task[], now = new Date()): DueReminder[] {
  if (!remindersEnabled()) return [];
  const at = now.getTime();
  const fired = readMap<FiredEntry>(REMINDER_FIRED_KEY);
  const result: DueReminder[] = [];
  let firedChanged = false;

  for (const task of tasks) {
    if (!isOpenTask(task) || !task.dueTime) continue;
    const dueAt = taskDueAt(task);
    if (!dueAt) continue;
    const key = reminderKey(task);

    // 日期 / 时间改过，这个任务名下所有旧记录都作废
    for (const slot of Object.keys(fired)) {
      if (slot !== task.id && !slot.startsWith(`${task.id}|`)) continue;
      if (fired[slot].key !== key) {
        delete fired[slot];
        firedChanged = true;
      }
    }

    const snooze = readSnooze(task, at);
    if (snooze.active) continue;

    const dueMs = dueAt.getTime();
    const candidates: { offset: number; remindAt: number }[] = [];
    for (const offset of reminderOffsetsOf(task)) {
      const remindAt = dueMs - offset * 60000;
      if (at < remindAt) continue;
      // 提前档一旦过了截止时刻就不再补，交给到点档兜底
      if (offset > 0 && at >= dueMs) continue;
      const entry = firedEntryOf(fired, task, offset);
      if (entry && entry.key === key) continue;
      const delta = at - remindAt;
      if (offset === 0 && delta > REMINDER_WINDOW && !snooze.woke) continue;
      candidates.push({ offset, remindAt });
    }
    if (!candidates.length) continue;

    // 同时错过多个提前档时只发最接近现在的那个；其余档位一并记为已处理，
    // 否则下一轮轮询又会把更早的档位补出来。
    const chosen = candidates.reduce((a, b) => (b.remindAt > a.remindAt ? b : a));
    result.push({ task, offset: chosen.offset, offsets: candidates.map((c) => c.offset) });
  }

  if (firedChanged) writeMap(REMINDER_FIRED_KEY, fired);
  return result;
}

/**
 * 上锁期间只报了条数，解锁后需要把具体内容补弹一次：
 * 取「刚响过、还开着」的待办。不改动 fired 记录，所以不会造成下一轮重复响。
 */
export function recentlyReminded(
  tasks: Task[],
  now = Date.now(),
  withinMs = 5 * 60 * 1000,
): DueReminder[] {
  const fired = readMap<FiredEntry>(REMINDER_FIRED_KEY);
  const result: DueReminder[] = [];
  for (const task of tasks) {
    if (!isOpenTask(task) || !task.dueTime) continue;
    const key = reminderKey(task);
    let best: { at: number; offset: number } | null = null;
    for (const slot of Object.keys(fired)) {
      if (slot !== task.id && !slot.startsWith(`${task.id}|`)) continue;
      const entry = fired[slot];
      if (!entry || entry.key !== key) continue;
      if (now - entry.at > withinMs) continue;
      const offset = slot.includes('|') ? Number(slot.slice(slot.lastIndexOf('|') + 1)) : 0;
      if (!Number.isFinite(offset)) continue;
      if (!best || entry.at > best.at) best = { at: entry.at, offset };
    }
    if (best) result.push({ task, offset: best.offset, offsets: [best.offset] });
  }
  return result;
}

/** 清理任务库里已经不存在的提醒记录，避免 localStorage 越积越多 */
export function pruneReminderState(tasks: Task[]) {
  const ids = new Set(tasks.map((t) => t.id));
  const fired = readMap<FiredEntry>(REMINDER_FIRED_KEY);
  let changed = false;
  for (const slot of Object.keys(fired)) {
    const id = slot.includes('|') ? slot.slice(0, slot.indexOf('|')) : slot;
    if (!ids.has(id)) {
      delete fired[slot];
      changed = true;
    }
  }
  if (changed) writeMap(REMINDER_FIRED_KEY, fired);
  const snooze = readMap<SnoozeEntry>(REMINDER_SNOOZE_KEY);
  changed = false;
  for (const id of Object.keys(snooze)) {
    if (!ids.has(id)) {
      delete snooze[id];
      changed = true;
    }
  }
  if (changed) writeMap(REMINDER_SNOOZE_KEY, snooze);
}
