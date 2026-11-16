/**
 * 预置小应用市场（docs/15）。
 *
 * 每个模板就是同目录下的一份自包含 HTML，构建时用 `?raw` 懒加载，
 * 不参与主包体积；安装后与 AI 生成的应用完全一样——写进 apps/<id>/，
 * 可以随意改、可以删，跟随 Git 同步。
 *
 * 模板只依赖浏览器原生能力：
 * - 数据走 window.glimnote.data（宿主注入的数据桥），已做离线兜底；
 * - 可以联网（fetch / 外部脚本），但不用 localStorage / Cookie / window.parent，能过 checkHtml()；
 * - 沙箱 iframe 没有 allow-modals，所以模板里不能出现 alert / confirm / prompt；
 * - 需要提醒时用 window.glimnote.notify()，由宿主发系统通知。
 */
import { checkHtml } from '../../lib/apps';
import type { ImportedApp } from '../../lib/importApp';

/**
 * 模板一次性打进主包（eager）：Electron 安装版用 file:// 加载页面，
 * Chromium 不允许从 file:// 动态 import 分块，懒加载会让市场模板全部读不出来。
 * 36 个模板合计约 560KB，内联的代价远小于第一次打开首页就装不上应用。
 */
const templates = import.meta.glob('./*.html', { query: '?raw', import: 'default', eager: true }) as Record<
  string,
  string
>;

export type MarketCategory = 'time' | 'record' | 'learn' | 'tool';

export const MARKET_CATEGORIES: { id: MarketCategory; name: string }[] = [
  { id: 'time', name: '时间与专注' },
  { id: 'record', name: '长期记录' },
  { id: 'learn', name: '学习' },
  { id: 'tool', name: '随手工具' },
];

export interface MarketApp {
  id: string;
  name: string;
  description: string;
  /** 必须是 HOME_ICON_KEYS 里的名字 */
  icon: string;
  color: 'green' | 'blue' | 'amber' | 'red' | 'purple' | 'gray';
  category: MarketCategory;
  loader: () => Promise<string>;
}

export const MARKET_APPS: MarketApp[] = [
  {
    id: 'pomodoro',
    name: '番茄钟',
    description: '25 分钟专注 + 5 分钟休息，自动记下今天和最近七天',
    icon: 'clock',
    color: 'red',
    category: 'time',
    loader: () => Promise.resolve(templates['./pomodoro.html']),
  },
  {
    id: 'countdown',
    name: '倒数日',
    description: '考试、纪念日、旅行还剩几天，一眼看到',
    icon: 'calendar',
    color: 'amber',
    category: 'time',
    loader: () => Promise.resolve(templates['./countdown.html']),
  },
  {
    id: 'date-calc',
    name: '日期推算',
    description: '两个日期差几天、往后推 N 天、跳过周末算工作日',
    icon: 'calculator',
    color: 'blue',
    category: 'time',
    loader: () => Promise.resolve(templates['./date-calc.html']),
  },
  {
    id: 'world-clock',
    name: '多时区时钟',
    description: '开会前看一眼对面几点，夏令时自动处理',
    icon: 'globe',
    color: 'blue',
    category: 'time',
    loader: () => Promise.resolve(templates['./world-clock.html']),
  },
  {
    id: 'habit-tracker',
    name: '习惯打卡',
    description: '每天点一下，连续天数会累加，断一天归零',
    icon: 'heart',
    color: 'green',
    category: 'record',
    loader: () => Promise.resolve(templates['./habit-tracker.html']),
  },
  {
    id: 'ledger',
    name: '记账本',
    description: '随手记一笔，月底按分类自动汇总',
    icon: 'database',
    color: 'green',
    category: 'record',
    loader: () => Promise.resolve(templates['./ledger.html']),
  },
  {
    id: 'reading-log',
    name: '书影记录',
    description: '想看的存着，看完打个分、留一句短评',
    icon: 'book',
    color: 'purple',
    category: 'record',
    loader: () => Promise.resolve(templates['./reading-log.html']),
  },
  {
    id: 'goal-progress',
    name: '目标进度',
    description: '把目标拆成数字，每次更新都看得见往前走',
    icon: 'star',
    color: 'amber',
    category: 'record',
    loader: () => Promise.resolve(templates['./goal-progress.html']),
  },
  {
    id: 'flashcard',
    name: '记忆卡片',
    description: '正反面卡片，答得越稳，下次问得越晚',
    icon: 'lightbulb',
    color: 'purple',
    category: 'learn',
    loader: () => Promise.resolve(templates['./flashcard.html']),
  },
  {
    id: 'quiz',
    name: '知识小测',
    description: '存一份问答题库，自动生成四选一，答完给分',
    icon: 'flask',
    color: 'purple',
    category: 'learn',
    loader: () => Promise.resolve(templates['./quiz.html']),
  },
  {
    id: 'unit-convert',
    name: '单位换算',
    description: '长度、重量、温度、面积、数据，改一边另一边跟着变',
    icon: 'calculator',
    color: 'blue',
    category: 'tool',
    loader: () => Promise.resolve(templates['./unit-convert.html']),
  },
  {
    id: 'random-picker',
    name: '随机决定',
    description: '午饭吃什么、先做哪件，转一下就不纠结了',
    icon: 'sparkles',
    color: 'amber',
    category: 'tool',
    loader: () => Promise.resolve(templates['./random-picker.html']),
  },
  {
    id: 'color-picker',
    name: '配色助手',
    description: '取一个颜色，看它配黑字白字的对比度够不够',
    icon: 'palette',
    color: 'gray',
    category: 'tool',
    loader: () => Promise.resolve(templates['./color-picker.html']),
  },
  {
    id: 'password-gen',
    name: '密码生成器',
    description: '随机强密码，或者几个词拼成好记的短语',
    icon: 'terminal',
    color: 'gray',
    category: 'tool',
    loader: () => Promise.resolve(templates['./password-gen.html']),
  },
  {
    id: 'text-toolbox',
    name: '文本小工具',
    description: 'JSON 排版、Base64、URL 编码，外加字数统计',
    icon: 'braces',
    color: 'green',
    category: 'tool',
    loader: () => Promise.resolve(templates['./text-toolbox.html']),
  },
  {
    id: 'quadrant-todo',
    name: '四象限待办',
    description: '按重要和紧急分成四块，先做该做的那件',
    icon: 'grid',
    color: 'blue',
    category: 'time',
    loader: () => Promise.resolve(templates['./quadrant-todo.html']),
  },
  {
    id: 'day-blocks',
    name: '今日时间块',
    description: '把一天排成时间轴，什么时候做什么一眼看清',
    icon: 'clock',
    color: 'purple',
    category: 'time',
    loader: () => Promise.resolve(templates['./day-blocks.html']),
  },
  {
    id: 'kitchen-timer',
    name: '厨房计时',
    description: '煮蛋炖汤到点提醒，关掉窗口也照样计时',
    icon: 'clock',
    color: 'amber',
    category: 'time',
    loader: () => Promise.resolve(templates['./kitchen-timer.html']),
  },
  {
    id: 'weekly-report',
    name: '周报助手',
    description: '这周做了什么、下周做什么，凑成一段能直接发的周报',
    icon: 'pen',
    color: 'blue',
    category: 'record',
    loader: () => Promise.resolve(templates['./weekly-report.html']),
  },
  {
    id: 'work-hours',
    name: '工时记录',
    description: '开始、结束，自动累加今天和本周的工时',
    icon: 'briefcase',
    color: 'green',
    category: 'record',
    loader: () => Promise.resolve(templates['./work-hours.html']),
  },
  {
    id: 'shopping-list',
    name: '购物清单',
    description: '要买的列出来，买一样勾一样，进度看得见',
    icon: 'grid',
    color: 'green',
    category: 'record',
    loader: () => Promise.resolve(templates['./shopping-list.html']),
  },
  {
    id: 'water-tracker',
    name: '喝水记录',
    description: '点一下一杯，喝够了提醒你，还能看最近七天',
    icon: 'heart',
    color: 'blue',
    category: 'record',
    loader: () => Promise.resolve(templates['./water-tracker.html']),
  },
  {
    id: 'expiry-reminder',
    name: '到期提醒',
    description: '牛奶、药品、证件什么时候过期，提前排好队',
    icon: 'calendar',
    color: 'red',
    category: 'record',
    loader: () => Promise.resolve(templates['./expiry-reminder.html']),
  },
  {
    id: 'birthday-book',
    name: '生日簿',
    description: '家人朋友的生日按天数排好，今天生日的会高亮',
    icon: 'heart',
    color: 'purple',
    category: 'record',
    loader: () => Promise.resolve(templates['./birthday-book.html']),
  },
  {
    id: 'packing-list',
    name: '旅行清单',
    description: '按证件、衣物、电子分好类，出门前照着勾',
    icon: 'briefcase',
    color: 'amber',
    category: 'record',
    loader: () => Promise.resolve(templates['./packing-list.html']),
  },
  {
    id: 'mistake-book',
    name: '错题本',
    description: '把做错的题记下来，考前只看还没掌握的那些',
    icon: 'book',
    color: 'red',
    category: 'learn',
    loader: () => Promise.resolve(templates['./mistake-book.html']),
  },
  {
    id: 'timetable',
    name: '课程表',
    description: '一周课表点格子就能填，今天的那列自动高亮',
    icon: 'calendar',
    color: 'blue',
    category: 'learn',
    loader: () => Promise.resolve(templates['./timetable.html']),
  },
  {
    id: 'mental-math',
    name: '口算练习',
    description: '加减乘除随手练，一组二十题，看速度和正确率',
    icon: 'calculator',
    color: 'purple',
    category: 'learn',
    loader: () => Promise.resolve(templates['./mental-math.html']),
  },
  {
    id: 'text-diff',
    name: '文本对比',
    description: '改稿前后贴进来，删了什么加了什么标得清清楚楚',
    icon: 'code',
    color: 'gray',
    category: 'tool',
    loader: () => Promise.resolve(templates['./text-diff.html']),
  },
  {
    id: 'loan-calc',
    name: '贷款计算器',
    description: '等额本息和等额本金，月供、总利息、逐年还款都能看',
    icon: 'calculator',
    color: 'green',
    category: 'tool',
    loader: () => Promise.resolve(templates['./loan-calc.html']),
  },
  {
    id: 'qr-code',
    name: '二维码',
    description: '网址或一段文字生成二维码，可以复制图片直接发出去',
    icon: 'grid',
    color: 'gray',
    category: 'tool',
    loader: () => Promise.resolve(templates['./qr-code.html']),
  },
  {
    id: 'image-compress',
    name: '图片压缩',
    description: '改尺寸、调质量，压完的体积和节省比例一眼看见',
    icon: 'image',
    color: 'purple',
    category: 'tool',
    loader: () => Promise.resolve(templates['./image-compress.html']),
  },
  {
    id: 'scientific-calc',
    name: '科学计算器',
    description: '三角函数、对数、乘方、阶乘，键盘也能直接敲',
    icon: 'calculator',
    color: 'blue',
    category: 'tool',
    loader: () => Promise.resolve(templates['./scientific-calc.html']),
  },
  {
    id: 'json-format',
    name: 'JSON 格式化',
    description: '排版、压缩、校验、排序键名，还能展开看结构',
    icon: 'braces',
    color: 'green',
    category: 'tool',
    loader: () => Promise.resolve(templates['./json-format.html']),
  },
  {
    id: 'base64-encoder',
    name: 'Base64 编码器',
    description: '文本和 Base64 互转，支持中文、URL-safe 和文件',
    icon: 'code',
    color: 'gray',
    category: 'tool',
    loader: () => import('./base64-encoder.html?raw').then((m) => m.default),
  },
  {
    id: 'regex-test',
    name: '正则测试',
    description: '边写边看匹配、分组和替换结果，不用来回切工具',
    icon: 'terminal',
    color: 'purple',
    category: 'tool',
    loader: () => Promise.resolve(templates['./regex-test.html']),
  },
];

/** 新仓库首次打开时自动装上的小应用：替自己做个决定、随手算一笔、排一周课表 */
export const STARTER_APP_IDS = ['random-picker', 'scientific-calc', 'timetable'] as const;

export function marketApps(category: MarketCategory | 'all') {
  return category === 'all' ? MARKET_APPS : MARKET_APPS.filter((app) => app.category === category);
}

/**
 * 读出模板并走一遍与外部导入相同的静态检查。
 * 预置模板理应全部通过；这里保留检查是为了以后改模板时能立刻发现问题。
 */
export async function buildMarketApp(app: MarketApp): Promise<ImportedApp> {
  const html = await app.loader();
  const issues = checkHtml(html);
  if (issues.length) {
    throw new Error(`「${app.name}」没通过检查：${issues.slice(0, 3).join('；')}`);
  }
  return {
    html,
    name: app.name,
    description: app.description,
    icon: app.icon,
    entry: `${app.id}.html`,
    fileCount: 1,
    inlined: 0,
    bytes: new TextEncoder().encode(html).length,
    warnings: [],
  };
}
