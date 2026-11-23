import { desktop } from './desktop';
import { dateKey, parseDateKey } from './utils';

/**
 * 中国法定节假日与调休补班表。
 *
 * 数据来源：国务院办公厅每年 11 月前后发布的《关于下一年部分节假日安排的通知》。
 * 只保留「当前年 + 已公布的未来年」：循环任务永远从今天往后推算，过去年份的数据用不上，
 * 每年通知发布后补上下一年的安排、同时删掉已经过完的年份即可。
 *
 * 更新方式：
 * - 内置表随应用版本打包，离线可用；超出范围的年份按「周一至周五」兜底，
 *   仍可正常循环，只是节假日当天可能被当成工作日、节前调休上班日可能被当成休息日；
 * - 循环设置里可以手动点「刷新节假日数据」：从 GitCode 仓库的 `data/workdays.json` 拉取最新表，
 *   校验通过后写入 localStorage 缓存，之后离线也继续生效；刷新失败保留原有数据。
 *
 * 说明：
 * - `off` 是放假的日期区间（含首尾），含与周末连休的调休日；
 * - `work` 是调休补班的周末日期，上班日优先于周末判断；
 * - 所有日期都是本地日历日，用 YYYY-MM-DD 表示。
 */
interface YearPlan {
  off: [string, string][];
  work: string[];
}

const BUILTIN_PLANS: Record<number, YearPlan> = {
  2026: {
    off: [
      ['2026-01-01', '2026-01-03'],
      ['2026-02-15', '2026-02-23'],
      ['2026-04-04', '2026-04-06'],
      ['2026-05-01', '2026-05-05'],
      ['2026-06-19', '2026-06-21'],
      ['2026-09-25', '2026-09-27'],
      ['2026-10-01', '2026-10-07'],
    ],
    work: ['2026-01-04', '2026-02-14', '2026-02-28', '2026-05-09', '2026-09-20', '2026-10-10'],
  },
  2027: {
    off: [
      ['2027-01-01', '2027-01-03'],
      ['2027-02-05', '2027-02-13'],
      ['2027-04-03', '2027-04-05'],
      ['2027-05-01', '2027-05-05'],
      ['2027-06-09', '2027-06-09'],
      ['2027-09-15', '2027-09-15'],
      ['2027-10-01', '2027-10-07'],
    ],
    work: ['2027-01-31', '2027-02-14', '2027-05-08', '2027-09-26', '2027-10-09'],
  },
};

/** 手动刷新后缓存在本机的表（只对本机生效，不随笔记同步） */
const STORAGE_KEY = 'glimnote.workdays';
/** 防御异常数据：最多接受 12 个年份、每年 60 段假期与 120 个补班日 */
const MAX_YEARS = 12;
const MAX_RANGES = 60;
const MAX_WORK_DAYS = 120;

/** 远程节假日表地址；仓库里的 `data/workdays.json` 每年更新一次 */
const REMOTE_URL = 'https://raw.gitcode.com/jewey/glimnote/raw/main/data/workdays.json';

function addDays(key: string, days: number) {
  const d = parseDateKey(key);
  if (!d) return key;
  d.setDate(d.getDate() + days);
  return dateKey(d);
}

function isDateKey(v: unknown): v is string {
  return typeof v === 'string' && parseDateKey(v) !== null;
}

function normalizePlan(raw: unknown): YearPlan | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as { off?: unknown; work?: unknown };
  const off: [string, string][] = [];
  if (Array.isArray(obj.off)) {
    for (const pair of obj.off.slice(0, MAX_RANGES)) {
      if (!Array.isArray(pair) || pair.length < 2) continue;
      const [start, end] = pair;
      if (!isDateKey(start) || !isDateKey(end) || start > end) continue;
      off.push([start, end]);
    }
  }
  const work: string[] = [];
  if (Array.isArray(obj.work)) {
    for (const day of obj.work.slice(0, MAX_WORK_DAYS)) {
      if (isDateKey(day)) work.push(day);
    }
  }
  if (!off.length && !work.length) return null;
  return { off, work };
}

function normalizePayload(raw: unknown) {
  if (!raw || typeof raw !== 'object') return null;
  const src = raw as Record<string, unknown>;
  const yearsRaw =
    src.years && typeof src.years === 'object' ? (src.years as Record<string, unknown>) : src;
  const years: Record<number, YearPlan> = {};
  let count = 0;
  for (const [key, value] of Object.entries(yearsRaw)) {
    if (!/^\d{4}$/.test(key)) continue;
    const year = Number(key);
    if (year < 2000 || year > 2100) continue;
    const plan = normalizePlan(value);
    if (!plan) continue;
    years[year] = plan;
    count += 1;
    if (count >= MAX_YEARS) break;
  }
  if (!count) return null;
  const updated =
    typeof src.updated === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(src.updated) ? src.updated : '';
  return { years, updated };
}

let extraPlans: Record<number, YearPlan> = {};
let extraUpdated = '';
let overrideLoaded = false;
let HOLIDAYS = new Set<string>();
let MAKEUP_WORKDAYS = new Set<string>();
let planYears: number[] = [];

function rebuild() {
  HOLIDAYS = new Set<string>();
  MAKEUP_WORKDAYS = new Set<string>();
  const years = new Set<number>([
    ...Object.keys(BUILTIN_PLANS).map(Number),
    ...Object.keys(extraPlans).map(Number),
  ]);
  for (const year of years) {
    const plan = extraPlans[year] ?? BUILTIN_PLANS[year];
    if (!plan) continue;
    for (const [start, end] of plan.off) {
      let cursor = start;
      // 防御手写错误的数据：区间最多展开 60 天
      for (let i = 0; i < 60; i += 1) {
        HOLIDAYS.add(cursor);
        if (cursor >= end) break;
        cursor = addDays(cursor, 1);
      }
    }
    for (const key of plan.work) MAKEUP_WORKDAYS.add(key);
  }
  planYears = [...years].sort((a, b) => a - b);
}

/** 读取本机缓存；没有 localStorage（MCP / 单测等 Node 环境）时直接跳过 */
function ensureOverride() {
  if (overrideLoaded) return;
  overrideLoaded = true;
  try {
    if (typeof localStorage === 'undefined') return;
    const text = localStorage.getItem(STORAGE_KEY);
    if (!text) return;
    const payload = normalizePayload(JSON.parse(text));
    if (!payload) return;
    extraPlans = payload.years;
    extraUpdated = payload.updated;
    rebuild();
  } catch {
    /* 缓存损坏就当没有，继续用内置表 */
  }
}

rebuild();

/** 某天是否是法定工作日：调休补班日上班，节假日休息，其余按周一至周五 */
export function isChinaWorkday(date: Date | string) {
  ensureOverride();
  const key = typeof date === 'string' ? date.slice(0, 10) : dateKey(date);
  if (MAKEUP_WORKDAYS.has(key)) return true;
  if (HOLIDAYS.has(key)) return false;
  const d = parseDateKey(key);
  if (!d) return false;
  const weekday = d.getDay();
  return weekday !== 0 && weekday !== 6;
}

/** 严格晚于给定日期的下一个法定工作日 */
export function nextChinaWorkday(key: string) {
  let cursor = key;
  for (let i = 0; i < 400; i += 1) {
    cursor = addDays(cursor, 1);
    if (isChinaWorkday(cursor)) return cursor;
  }
  return addDays(key, 1);
}

/** 已收录的年份（含手动刷新后新增的年份） */
export function chinaWorkdayPlanYears() {
  ensureOverride();
  return [...planYears];
}

/** 节假日表覆盖的年份区间；表为空时返回 null */
export function chinaWorkdayCoverage() {
  const years = chinaWorkdayPlanYears();
  if (!years.length) return null;
  return { from: years[0], to: years[years.length - 1] };
}

/** 某个日期所在年份是否已收录在节假日表里 */
export function isChinaWorkdayYearCovered(date: Date | string) {
  const key = typeof date === 'string' ? date.slice(0, 10) : dateKey(date);
  const year = Number(key.slice(0, 4));
  return chinaWorkdayPlanYears().includes(year);
}

export interface WorkdayCalendarInfo {
  /** 应用内置表的年份范围 */
  builtinFrom: number;
  builtinTo: number;
  /** 当前实际生效的年份范围（内置 + 手动刷新） */
  from: number;
  to: number;
  /** 手动刷新数据里的更新日期，未刷新过为空串 */
  updated: string;
  /** 是否已手动刷新过 */
  remote: boolean;
}

/** 给界面显示的数据来源与覆盖范围 */
export function chinaWorkdayDataInfo(): WorkdayCalendarInfo {
  ensureOverride();
  const builtin = Object.keys(BUILTIN_PLANS)
    .map(Number)
    .sort((a, b) => a - b);
  const from = planYears[0] ?? 0;
  const to = planYears[planYears.length - 1] ?? 0;
  return {
    builtinFrom: builtin[0] ?? 0,
    builtinTo: builtin[builtin.length - 1] ?? 0,
    from,
    to,
    updated: extraUpdated,
    remote: Object.keys(extraPlans).length > 0,
  };
}

/**
 * 校验并应用一份节假日数据（刷新或测试用）。
 * 返回应用后的覆盖范围；数据格式不对时返回 null，且不改动现有数据。
 */
export function applyHolidayData(raw: unknown) {
  const payload = normalizePayload(raw);
  if (!payload) return null;
  ensureOverride();
  extraPlans = payload.years;
  extraUpdated = payload.updated;
  rebuild();
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ schemaVersion: 1, updated: payload.updated, years: payload.years }),
      );
    }
  } catch {
    /* 存不进缓存不影响本次会话生效 */
  }
  return { from: planYears[0], to: planYears[planYears.length - 1], updated: payload.updated };
}

/**
 * 从 GitCode 拉取并应用最新节假日表；失败时抛错，现有数据不变。
 * 桌面端走主进程 `net.fetch`（GitCode raw 不带 CORS 头），网页端直接 fetch。
 */
export async function refreshChinaWorkdays() {
  const bridge = typeof window === 'undefined' ? null : desktop();
  let payload: unknown;
  if (bridge?.holidayFetch) {
    const res = await bridge.holidayFetch(REMOTE_URL);
    if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`);
    payload = JSON.parse(res.text);
  } else {
    const controller = typeof AbortController === 'undefined' ? null : new AbortController();
    const timer = controller ? setTimeout(() => controller.abort(), 8000) : null;
    try {
      const res = await fetch(REMOTE_URL, {
        cache: 'no-store',
        signal: controller?.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      payload = await res.json();
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  const applied = applyHolidayData(payload);
  if (!applied) throw new Error('数据格式不正确');
  return { ...applied, source: REMOTE_URL };
}
