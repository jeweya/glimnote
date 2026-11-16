/**
 * 待办分类：像「文件夹」一样给任务分组（工作 / 家庭 / 学习…）。
 *
 * 分类名写在每个任务文件的 frontmatter 里（`category: 工作`），所以任务同步到
 * 另一台设备时分类跟着走；分类列表本身只存本机，负责顺序、颜色和「空分类」——
 * 其他设备传来的新分类名会在加载任务时自动补进列表。
 */

export interface TaskCategory {
  name: string;
  /** 小圆点的颜色；不参与任务数据，只影响显示 */
  color: string;
}

/**
 * 待办页当前看哪一类。用对象而不是字符串，避免分类名恰好叫 all / none 时撞车。
 * undefined 不用：对象本身能表达「全部」，store 里也更容易比较。
 */
export type TaskCategoryFilter = { kind: 'all' } | { kind: 'none' } | { kind: 'cat'; name: string };

export const TASK_CATEGORY_ALL: TaskCategoryFilter = { kind: 'all' };

/** 与编辑器颜色盘同一套色值，深浅主题下都够清楚 */
export const CATEGORY_COLORS = ['#3e63dd', '#30a46c', '#f76b15', '#8e4ec6', '#e5484d', '#0e9bb5', '#c99a00', '#8b8b8b'];

const STORE_KEY = 'glimnote.task.categories';

const DEFAULT_CATEGORIES: TaskCategory[] = [
  { name: '工作', color: CATEGORY_COLORS[0] },
  { name: '家庭', color: CATEGORY_COLORS[1] },
];

export function cleanCategoryName(value: string) {
  return value
    .replace(/[\[\]\n\r]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 16);
}

function fallbackColor(name: string) {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) % 997;
  return CATEGORY_COLORS[hash % CATEGORY_COLORS.length];
}

/** 读本机分类表；没存过时给两个默认分类，存过空数组就尊重用户「全删了」 */
export function loadCategories(): TaskCategory[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw === null) return DEFAULT_CATEGORIES.map((c) => ({ ...c }));
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return DEFAULT_CATEGORIES.map((c) => ({ ...c }));
    return parsed
      .map((item) => {
        const name = cleanCategoryName(String(item?.name || ''));
        if (!name) return null;
        const color =
          typeof item?.color === 'string' && /^#[0-9a-f]{3,8}$/i.test(item.color) ? item.color : fallbackColor(name);
        return { name, color };
      })
      .filter((item): item is TaskCategory => Boolean(item))
      .filter((item, index, list) => list.findIndex((c) => c.name === item.name) === index);
  } catch {
    return DEFAULT_CATEGORIES.map((c) => ({ ...c }));
  }
}

export function saveCategories(list: TaskCategory[]) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(list));
  } catch {
    /* 隐私模式下写不进去也不影响任务本身，分类名仍在 frontmatter 里 */
  }
}

/** 取下一个没被用过的颜色，用完再循环 */
export function nextCategoryColor(list: TaskCategory[]) {
  const used = new Set(list.map((c) => c.color));
  return CATEGORY_COLORS.find((c) => !used.has(c)) || CATEGORY_COLORS[list.length % CATEGORY_COLORS.length];
}

export function categoryColor(name: string, list: TaskCategory[]) {
  return list.find((c) => c.name === name)?.color || fallbackColor(name);
}

/**
 * 把任务里出现过、但本机列表里没有的分类补进来。
 * 场景：另一台设备新建了「旅行」，同步下来任务有分类、本机却没有这一项。
 */
export function mergeCategories(list: TaskCategory[], names: string[]): TaskCategory[] {
  const next = [...list];
  for (const raw of names) {
    const name = cleanCategoryName(raw);
    if (!name || next.some((c) => c.name === name)) continue;
    next.push({ name, color: nextCategoryColor(next) });
  }
  return next.length === list.length ? list : next;
}
