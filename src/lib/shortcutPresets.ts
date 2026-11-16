/**
 * 「新建入口」弹窗里的两批预设：
 *   1. 系统应用排序权重——微信、钉钉这类天天点的软件排在最前面；
 *   2. 常用网站——网址入口不用手打域名，点一张卡片就能填好。
 *
 * 这里只有静态数据，不联网、不读系统信息；系统应用仍然以本机扫描结果为准，
 * 预设只负责「排序」和「给一个顺手的默认选择」。
 */

/** 本机应用排序权重：数字越小越靠前，999 表示普通应用 */
const COMMON_APP_ORDER: { names: string[]; rank: number }[] = [
  { names: ['微信', 'wechat'], rank: 1 },
  { names: ['钉钉', 'dingtalk'], rank: 2 },
  { names: ['企业微信', 'wecom', 'wxwork'], rank: 3 },
  { names: ['飞书', 'feishu', 'lark'], rank: 4 },
  { names: ['qq'], rank: 5 },
  { names: ['腾讯会议', 'tencent meeting', 'wemeet', 'wemeetapp'], rank: 6 },
  { names: ['wps office', 'wps'], rank: 7 },
  { names: ['word', 'microsoft word'], rank: 8 },
  { names: ['excel', 'microsoft excel'], rank: 9 },
  { names: ['powerpoint', 'microsoft powerpoint', 'ppt'], rank: 10 },
  { names: ['chrome', 'google chrome'], rank: 11 },
  { names: ['edge', 'microsoft edge'], rank: 12 },
  { names: ['firefox', 'firefox 浏览器'], rank: 13 },
  { names: ['百度网盘', 'baidu netdisk', 'baidunetdisk'], rank: 14 },
  { names: ['哔哩哔哩', 'bilibili'], rank: 15 },
  { names: ['网易云音乐', 'netease cloud music', 'cloudmusic'], rank: 16 },
  { names: ['qq音乐', 'qqmusic'], rank: 17 },
  { names: ['微信读书', 'weread'], rank: 18 },
  { names: ['迅雷', 'thunder'], rank: 19 },
  { names: ['剪映', 'jianying', 'capcut'], rank: 20 },
  { names: ['抖音', 'douyin'], rank: 21 },
  { names: ['visual studio code', 'vs code', 'vscode'], rank: 22 },
  { names: ['notion'], rank: 23 },
  { names: ['obsidian'], rank: 24 },
  { names: ['typora'], rank: 25 },
  { names: ['有道云笔记'], rank: 26 },
  { names: ['印象笔记', 'evernote'], rank: 27 },
];

function normalize(value: string) {
  return value
    .toLowerCase()
    .replace(/\.(exe|lnk|app|desktop)$/i, '')
    .replace(/[\s　]+/g, ' ')
    .trim();
}

/** 名称是否命中某个预设词；「微信开发者工具」不会误命中「微信」 */
function hit(name: string, key: string) {
  if (name === key) return true;
  if (name.startsWith(key)) {
    const next = name.charAt(key.length);
    if (next === ' ' || next === '(' || next === '（' || next === '·' || next === '-' || next === '—') return true;
  }
  return ` ${name} `.includes(` ${key} `);
}

/**
 * 系统应用的常用程度，用于列表排序。
 * 同时看显示名称与文件名：有的快捷方式叫「微信」，可执行文件却叫 WeChat.exe。
 */
export function commonAppRank(app: { name: string; path?: string }): number {
  const name = normalize(app.name || '');
  const file = normalize((app.path || '').split(/[\\/]/).pop() || '');
  for (const preset of COMMON_APP_ORDER) {
    for (const key of preset.names) {
      if (hit(name, key) || (file && hit(file, key))) return preset.rank;
    }
  }
  return 999;
}

export interface SitePreset {
  name: string;
  /** 带协议与结尾斜杠，方便和输入框里的网址做同域比较 */
  url: string;
  /** 角标文字：一两个字符，不超过三个 */
  badge: string;
  /** 品牌色，只用于角标文字与淡色底 */
  color: string;
}

function siteHost(url: string) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * 按网址找预设站点：首页网址卡片用它显示品牌角标（知、B、微……）。
 * 忽略 www. 与子域，https://m.zhihu.com 也能对上知乎。
 */
export function sitePresetForUrl(url: string | undefined): SitePreset | null {
  if (!url) return null;
  const host = siteHost(/^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`);
  if (!host) return null;
  for (const site of COMMON_SITES) {
    const presetHost = siteHost(site.url);
    if (presetHost && (host === presetHost || host.endsWith(`.${presetHost}`))) return site;
  }
  return null;
}

/** 常用网站：覆盖搜索、社区、视频、购物、阅读与开发，按日常使用频率排序 */
export const COMMON_SITES: SitePreset[] = [
  { name: '百度', url: 'https://www.baidu.com/', badge: '百', color: '#2932e1' },
  { name: '知乎', url: 'https://www.zhihu.com/', badge: '知', color: '#0066ff' },
  { name: '微博', url: 'https://weibo.com/', badge: '微', color: '#e6162d' },
  { name: '哔哩哔哩', url: 'https://www.bilibili.com/', badge: 'B', color: '#fb7299' },
  { name: '小红书', url: 'https://www.xiaohongshu.com/', badge: '红', color: '#ff2442' },
  { name: '抖音', url: 'https://www.douyin.com/', badge: '抖', color: '#fe2c55' },
  { name: '豆瓣', url: 'https://www.douban.com/', badge: '豆', color: '#2e963d' },
  { name: '淘宝', url: 'https://www.taobao.com/', badge: '淘', color: '#ff5000' },
  { name: '京东', url: 'https://www.jd.com/', badge: '京', color: '#e2231a' },
  { name: '网易云音乐', url: 'https://music.163.com/', badge: '云', color: '#c20c0c' },
  { name: '腾讯视频', url: 'https://v.qq.com/', badge: '视', color: '#00a0e9' },
  { name: '爱奇艺', url: 'https://www.iqiyi.com/', badge: '爱', color: '#00be06' },
  { name: '微信读书', url: 'https://weread.qq.com/', badge: '读', color: '#2782d7' },
  { name: '飞书', url: 'https://www.feishu.cn/', badge: '飞', color: '#3370ff' },
  { name: '语雀', url: 'https://www.yuque.com/', badge: '语', color: '#25b864' },
  { name: '少数派', url: 'https://sspai.com/', badge: '少', color: '#d71a1b' },
  { name: '36氪', url: 'https://36kr.com/', badge: '36', color: '#4285f4' },
  { name: '掘金', url: 'https://juejin.cn/', badge: '掘', color: '#1e80ff' },
  { name: 'GitHub', url: 'https://github.com/', badge: 'G', color: '#57606a' },
  { name: 'Notion', url: 'https://www.notion.so/', badge: 'N', color: '#37352f' },
];
