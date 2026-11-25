import git from 'isomorphic-git';
import {
  fs,
  ROOT,
  backupUserFiles,
  ensureDir,
  ensureStarterContent,
  localContentState,
  pathSize,
  readText,
  removePath,
  removeUserFiles,
  renamePath,
  writeBinary,
  writeText,
} from './storage';
import { GitBridgeError, canProxyGit, gitHttp } from './gitHttp';
import { invalidateAssetIndex, mergeAssetsIndexJson } from './assetIndex';
import { mergePrivacyJson } from './privacySync';
import { mergeKeysJson } from './keySync';
import { log } from './log';
import { t } from './i18n';

export type Provider = 'github' | 'gitee' | 'gitcode';

/** 平台展示顺序：GitCode 作为推荐项排第一，其次是 Gitee，GitHub 作为备选放在最后 */
export const PROVIDER_ORDER: Provider[] = ['gitcode', 'gitee', 'github'];

export interface ProviderInfo {
  label: string;
  /** 用户看到的网站地址（很多人不知道 Gitee / GitCode 到底是什么） */
  host: string;
  site: string;
  tokenUrl: string;
  /** 平台选择卡片上的一句话说明 */
  note: string;
}

export const PROVIDERS: Record<Provider, ProviderInfo> = {
  gitee: {
    label: 'Gitee',
    host: 'gitee.com',
    site: 'https://gitee.com',
    tokenUrl: 'https://gitee.com/profile/personal_access_tokens',
    note: '国内直连 · 私有仓库免费',
  },
  gitcode: {
    label: 'GitCode',
    host: 'gitcode.com',
    site: 'https://gitcode.com',
    tokenUrl: 'https://gitcode.com/setting/token-classic',
    note: '国内访问快 · 私有仓库免费',
  },
  github: {
    label: 'GitHub',
    host: 'github.com',
    site: 'https://github.com',
    // 直接打开经典令牌创建页并预勾选 repo + workflow：repo 用于同步笔记，
    // workflow 用于云端推送。细粒度令牌还要单独配仓库范围、Contents / Administration / Workflows 权限，不适合作为默认路径。
    tokenUrl: 'https://github.com/settings/tokens/new?scopes=repo,workflow&description=Glimnote',
    note: '全球通用 · 国内可能需要代理',
  },
};

export function providerLabel(provider: Provider) {
  return PROVIDERS[provider].label;
}

/**
 * 仓库设置页：自动改为私有失败时，引导用户自己到平台把可见性改成 Private。
 *
 * GitHub / Gitee 有稳定的设置页地址；GitCode 没有固定深链（只能从项目主页点「设置」），
 * 所以退回项目主页，让用户自己点一下。
 */
export function repoSettingsUrl(provider: Provider, owner: string, repo: string) {
  const who = encodeURIComponent(owner);
  const name = encodeURIComponent(repo);
  if (provider === 'github') return `https://github.com/${who}/${name}/settings`;
  if (provider === 'gitee') return `https://gitee.com/${who}/${name}/edit`;
  return `https://gitcode.com/${who}/${name}`;
}

/** 手动改私有的一句话指引：显示在失败提示里，配合上面的设置页链接 */
export function manualPrivateHint(provider: Provider, owner: string, repo: string) {
  const label = PROVIDERS[provider].label;
  if (provider === 'gitcode') {
    return t('打开 {label} 的 {owner}/{repo} 项目主页，点「设置」把「项目可见性」改为私有并保存，然后回来点「校验令牌」重新校验。', { label, owner, repo });
  }
  return t('打开 {label} 的仓库设置，把 {owner}/{repo} 的可见性改为 Private 并保存，然后回来点「校验令牌」重新校验。', { label, owner, repo });
}

export interface GitConfig {
  provider: Provider;
  owner: string;
  repo: string;
  branch: string;
  remember: boolean;
}

const CONFIG_KEY = 'glimnote.git.config';
const TOKEN_KEY = 'glimnote.git.token';
/** 新建仓库后待写入的说明文件：即使首次连接网络失败，下次连接也会补上 */
const README_SEED_KEY = 'glimnote.git.seedReadme';

/**
 * 自动提交节流。
 *
 * 本地文件仍然在停止输入 700ms 后立即落盘，但 Git 不再每次落盘就提交：
 * 一次连续写作里几十个 8 秒级的提交，会让仓库历史迅速膨胀——每个提交都要
 * 保存改动文件的整份新副本和新的目录树，而 Gitee 免费仓库只有 500MB。
 * 现在默认 60 分钟合并成一次提交，手动同步 / 退出前仍然立即提交。
 */
const COMMIT_INTERVAL_KEY = 'glimnote.commitInterval';
const LAST_COMMIT_KEY = 'glimnote.lastCommitAt';
export const COMMIT_INTERVAL_DEFAULT = 60;
export const COMMIT_INTERVAL_OPTIONS = [30, 60] as const;

export function loadCommitInterval(): number {
  const stored = localStorage.getItem(COMMIT_INTERVAL_KEY);
  if (stored === null) return COMMIT_INTERVAL_DEFAULT;
  const n = Number(stored);
  if (!Number.isFinite(n) || n <= 0) return COMMIT_INTERVAL_DEFAULT;
  return Math.min(1440, Math.max(1, Math.round(n)));
}

export function saveCommitInterval(minutes: number): number {
  const value = Math.min(1440, Math.max(1, Math.round(Number(minutes) || COMMIT_INTERVAL_DEFAULT)));
  localStorage.setItem(COMMIT_INTERVAL_KEY, String(value));
  return value;
}

/** 上一次真正产生 Git 提交的时间（本机）；0 表示还没提交过 */
export function lastCommitAt(): number {
  const n = Number(localStorage.getItem(LAST_COMMIT_KEY));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** 下一次可以自动提交的时间；这是给界面显示倒计时用的 */
export function commitDueAt(): number {
  const last = lastCommitAt();
  return last ? last + loadCommitInterval() * 60000 : 0;
}

export function canCommitNow(force = false): boolean {
  if (force) return true;
  const last = lastCommitAt();
  return !last || Date.now() - last >= loadCommitInterval() * 60000;
}

function markCommitDone() {
  localStorage.setItem(LAST_COMMIT_KEY, String(Date.now()));
}

/**
 * 最近一次成功和仓库通信（fetch）的时间。
 *
 * 自动同步靠它限频：窗口反复获得焦点、定时器又被唤醒时，不会每次都发一次
 * fetch——Git 协议没有「先问一下有没有变化」的便宜接口，每次检查本身就是一次
 * 完整的上传包协商，平台会按拉取次数计。
 */
const LAST_SYNC_CHECK_KEY = 'glimnote.lastSyncCheckAt';

export function lastSyncCheckAt(): number {
  const n = Number(localStorage.getItem(LAST_SYNC_CHECK_KEY));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function markSyncCheckDone() {
  localStorage.setItem(LAST_SYNC_CHECK_KEY, String(Date.now()));
}

/** 历史被压缩过的标记文件。它跟着仓库走，各设备据此发现自己落后了一轮历史。 */
const EPOCH_FILE = '.glimnote/history-epoch';
const HISTORY_REWRITTEN_MESSAGE =
  '远端仓库的历史被压缩过，本机还停留在旧历史里。为避免把旧的大文件重新推回去，请先导出备份，再点「重新下载远端」。';

/** 这些目录只属于本机，或只是临时克隆区，绝不提交；.glimnote/local 里放系统应用这类本机数据 */
const LOCAL_ONLY_PREFIXES = [
  '.glimnote/logs',
  '.glimnote/history',
  '.glimnote/local',
  '.glimnote/reclone',
  '.glimnote/git-old',
];
function isLocalOnly(filepath: string) {
  return LOCAL_ONLY_PREFIXES.some((prefix) => filepath === prefix || filepath.startsWith(`${prefix}/`));
}

/**
 * isomorphic-git 判断「未跟踪文件是否被忽略」时，会把每一级父目录的 .gitignore 都读一遍；
 * 缺一个就是一次失败的读盘（主进程控制台会看到 fs:readFile 的 ENOENT）。
 * 历史快照目录往往有几百个文件，一次同步会重复探测同样的几个路径，
 * 这里把 .gitignore 的探测结果缓存几秒，命中时直接复用，不再来回走 IPC。
 */
const GITIGNORE_CACHE_MS = 5000;
const gitignoreCache = new Map<string, { at: number; value?: unknown; error?: Error }>();

const gitFs: any = {
  ...(fs as Record<string, unknown>),
  promises: {
    ...((fs as { promises?: Record<string, (...args: unknown[]) => Promise<unknown>> }).promises || {}),
    readFile: async (path: string, opts?: unknown) => {
      if (!/(?:^|\/)\.gitignore$/.test(path)) return (fs as any).promises.readFile(path, opts);
      const hit = gitignoreCache.get(path);
      if (hit && Date.now() - hit.at < GITIGNORE_CACHE_MS) {
        if (hit.error) throw hit.error;
        return hit.value;
      }
      try {
        const value = await (fs as any).promises.readFile(path, opts);
        gitignoreCache.set(path, { at: Date.now(), value });
        return value;
      } catch (e) {
        if ((e as { code?: string })?.code === 'ENOENT')
          gitignoreCache.set(path, { at: Date.now(), error: e as Error });
        throw e;
      }
    },
  },
};

function seedKey(cfg: GitConfig) {
  return `${cfg.provider}:${cfg.owner}/${cfg.repo}`;
}

export function markSeedReadme(cfg: GitConfig) {
  localStorage.setItem(README_SEED_KEY, seedKey(cfg));
}

/** 新建仓库的首页说明：介绍这仓库是干什么的，而不是平台默认的一行仓库名 */
function repoReadme(cfg: GitConfig) {
  return `# 萤光笔记

这是 \`${cfg.owner}/${cfg.repo}\`，由 **萤光笔记** 自动创建，用来存放你的 Markdown 笔记。
笔记就是普通文件，随时可以用任何编辑器打开，删掉应用也不会丢。

## 这个笔记应用能做什么

- **本地优先**：写作时先保存到本机，断网也能继续写，联网后自动补齐
- **多端同步**：Windows 桌面端与网页版共用这一个私有仓库
- **版本历史**：每次同步都是一次 Git 提交，可以回到任意时间点
- **组织与查找**：笔记本、标签、全文搜索、回收站
- **待办清单**：任务与笔记分开管理，支持状态与时间筛选
- **数据属于你**：仓库是私有的，内容不经过任何中间服务器

## 目录说明

| 目录 | 内容 |
|---|---|
| \`notes/\` | 所有笔记，一篇一个 \`.md\`，子目录就是笔记本 |
| \`tasks/\` | 待办任务 |
| \`assets/\` | 图片等附件，按年月分目录 |
| \`home/\` | 首页分组与快捷入口配置，换电脑同步后自动出现 |
| \`apps/\` | AI 小应用，一个应用一个目录 |
| \`.glimnote/\` | 应用配置与模板 |

## 请注意

- 请保持这个仓库为 **Private**。笔记内容不加密，公开仓库在连接时会被提示改为私有；不确认就不会连接。
- 日志与本地历史快照只留在你的设备上，不会提交到这里。
- 这个文件由应用初始化，你可以按自己的需要修改。
`;
}

export const defaultConfig: GitConfig = {
  // 新用户优先 GitCode：国内访问快、注册简单、私有仓库免费；Gitee / GitHub 仍是可选项
  provider: 'gitcode',
  owner: '',
  repo: 'my-notes',
  branch: 'main',
  remember: false,
};

/**
 * 校验一份配置（可能来自 localStorage，也可能来自 userData 里的 JSON）。
 * 字段缺失或平台不认识就当没配置，免得坏文件把同步卡在半路。
 */
export function normalizeConfig(raw: unknown): GitConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const provider = o.provider;
  if (provider !== 'gitee' && provider !== 'gitcode' && provider !== 'github') return null;
  const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const owner = text(o.owner);
  const repo = text(o.repo);
  if (!owner || !repo) return null;
  return {
    provider,
    owner,
    repo,
    branch: text(o.branch) || defaultConfig.branch,
    remember: Boolean(o.remember),
  };
}

export function loadConfig(): GitConfig | null {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    return raw ? normalizeConfig(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export function saveConfig(cfg: GitConfig | null) {
  if (!cfg) localStorage.removeItem(CONFIG_KEY);
  else localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
}

export function loadToken() {
  return sessionStorage.getItem(TOKEN_KEY) || '';
}

export function saveToken(token: string) {
  if (token) sessionStorage.setItem(TOKEN_KEY, token);
  else sessionStorage.removeItem(TOKEN_KEY);
}

/**
 * GitHub 对 .github/workflows/ 下的文件有额外权限要求：经典令牌要 workflow scope，
 * 细粒度令牌要把 Workflows 设为读写。缺权限时 receive-pack 仍返回 HTTP 200，
 * 只在 ref 状态里写一句拒绝，isomorphic-git 会把它当普通错误抛出来。
 */
const WORKFLOW_SCOPE_FAILURE =
  /refusing to allow.*workflow|without [`'"]?workflows?[`'"]? (?:scope|permission)|workflows? (?:scope|permission)/i;

/** 这次失败是不是「令牌没有 workflow 权限」；界面上要据此给出绕过云端推送的恢复入口 */
export function isWorkflowScopeFailure(raw: unknown): boolean {
  return WORKFLOW_SCOPE_FAILURE.test(String(raw || ''));
}

/**
 * 底层 Git 报错一律转成中文、可执行的说法。
 * 用户看到「Failed to create remote at origin…」这种英文只会更慌，也完全不知道该做什么。
 */
export function friendlyGitMessage(raw: string, action: 'connect' | 'sync' = 'sync'): string {
  const msg = String(raw || '');
  if (WORKFLOW_SCOPE_FAILURE.test(msg)) {
    return t('令牌缺少 workflow 权限，GitHub 不允许它创建或修改云端推送的工作流，导致笔记同步也被拦住。请到令牌设置里补上：经典令牌勾选 workflow，细粒度令牌把 Workflows 设为读写；保存后再同步一次。不想开云端推送的话，可在同步设置里一键关闭并恢复同步。');
  }
  if (/already exists.*remote|remote.*already exists/i.test(msg)) {
    return t('仓库地址没有更新成功。请再点一次；如果还是不行，先断开同步，再重新校验令牌连接。');
  }
  if (/not-fast-forward|non-fast-forward|rejected/i.test(msg)) {
    return t('仓库刚被其他设备更新过，再点一次同步就会自动合并。');
  }
  if (/ENOTFOUND|ETIMEDOUT|Failed to fetch|NetworkError|load failed|network error/i.test(msg)) {
    return action === 'connect'
      ? t('网络不通，没能连上仓库。检查网络后再点一次，仓库没建好也不会重复创建。')
      : t('网络不通，改动已保存在本地，联网后会自动补同步。');
  }
  if (/401|403|authentication|permission|AUTH_INVALID/i.test(msg)) {
    return t('令牌没有权限访问这个仓库。请确认令牌未过期，且具备仓库读写权限。');
  }
  if (/404|not found|could not find/i.test(msg)) {
    return t('远端仓库不存在或令牌看不到它。请先点「校验令牌」确认仓库地址。');
  }
  // 仓库里已经有同名文件、内容和本地不同：isomorphic-git 直接拒绝覆盖，用户看到的是一句英文
  if (/CheckoutConflict|would be overwritten|conflicts? with/i.test(msg)) {
    return action === 'connect'
      ? t('仓库里已有同名文件，内容和本地这份不一样，所以没有直接覆盖。建议在设置底部改用「下载仓库覆盖本地」（会先备份本地笔记），或先把本地笔记改名再连接。')
      : t('仓库和本地都有同名文件且内容不同，已保留两份，请打开「冲突副本」合并。');
  }
  if (/MissingName|MissingEmail|Author|author/i.test(msg)) {
    return t('提交缺少作者信息。请再试一次；如果反复出现，导出诊断日志发给开发者。');
  }
  if (/unmerged|UnmergedPaths|not fully merged/i.test(msg)) {
    return t('还有未合并的文件，先在仓库目录里处理完冲突，再点一次同步。');
  }
  if (/RemoteCapability|does not support|UnknownTransport/i.test(msg)) {
    return t('这个仓库的 Git 服务返回了无法识别的响应，请确认仓库地址是 https 开头、没有被重定向到登录页。');
  }
  // 客户端自己的代码出错时，别再让用户怀疑令牌或仓库
  if (/Cannot read propert|is not a function|is not defined|undefined is not/i.test(msg)) {
    return t('客户端内部出错了，和令牌、仓库都无关。请把下面的技术细节发给开发者。');
  }
  if (/EACCES|EPERM|ENOSPC|EBUSY/i.test(msg)) {
    return t('本地笔记目录不可写（可能被其他程序占用、磁盘已满或没有权限）。到「设置 → 常规 → 笔记存储位置」点「打开」确认这个文件夹能正常写入后再试。');
  }
  return action === 'connect'
    ? t('连接没有成功。请检查仓库是否已创建、令牌是否有读写权限，然后再点一次。')
    : t('同步没有成功。请检查网络和令牌权限，稍后再试；本地内容不会丢。');
}

/** 给用户一句可复制的技术细节：出错时先看清是什么错，再决定怎么修 */
export function errorDetail(e: unknown): string {
  const err = e as {
    name?: string;
    code?: string | number;
    message?: string;
    statusCode?: number;
    cause?: string;
  } | null;
  if (!err) return '';
  // 我们自己的 GitError 已经翻译成中文了，真正有价值的是它裹着的原始报错
  if (e instanceof GitError) {
    const cause = String(e.cause || '')
      .replace(/\s+/g, ' ')
      .trim();
    return cause ? (cause.length > 180 ? `${cause.slice(0, 180)}…` : cause) : '';
  }
  const name = err.name && err.name !== 'Error' ? err.name : '';
  const code = err.code !== undefined && err.code !== '' && err.code !== 0 ? String(err.code) : '';
  const status = err.statusCode ? `HTTP ${err.statusCode}` : '';
  const msg = String(err.message || '')
    .replace(/\s+/g, ' ')
    .trim();
  const head = [name, code && !name.includes(code) ? code : '', status].filter(Boolean).join(' · ');
  const body = msg.length > 160 ? `${msg.slice(0, 160)}…` : msg;
  return [head, body].filter(Boolean).join('：');
}

export class GitError extends Error {
  code: string;
  /** 原始报错（英文/错误码），只在「技术细节」里给用户看，主文案保持中文 */
  cause?: string;
  constructor(code: string, message: string, cause?: string) {
    super(message);
    this.code = code;
    this.cause = cause;
  }
}

const NETWORK_FAILURE =
  /ENOTFOUND|ETIMEDOUT|Failed to fetch|NetworkError|load failed|network error|ECONNRESET|ECONNREFUSED|ERR_NETWORK/i;

/**
 * 把「连不上」拆成不同原因：真的断网、浏览器跨域拦下、数据超限。
 * 401 在浏览器里也会表现为 Failed to fetch，如果一律说「网络不通」，用户会一直重试却永远失败。
 */
function networkFailure(e: unknown, provider: Provider, action: 'connect' | 'sync'): GitError | null {
  if (e instanceof GitBridgeError) {
    const cause = `${e.code}${e.message ? ` · ${e.message}` : ''}`;
    if (e.code === 'NETWORK') {
      return new GitError(
        'NETWORK',
        action === 'connect'
          ? '网络不通，没能连上仓库。检查网络后再试一次；已经建好的仓库不会重复创建。'
          : '网络不通，改动已保存在本地，联网后会自动补同步。',
        cause,
      );
    }
    return new GitError('UNKNOWN', e.message, cause);
  }
  const msg = String((e as { message?: string } | null)?.message || e || '');
  if (!NETWORK_FAILURE.test(msg)) return null;
  if (!canProxyGit()) {
    return new GitError(
      'CORS_BLOCKED',
      `浏览器不允许网页直接访问 ${providerLabel(provider)} 的 Git 接口（跨域限制），所以网页版无法同步云端。请改用桌面客户端连接这个仓库；网页版仍可本地写作，笔记都保存在这台电脑上。`,
    );
  }
  return new GitError(
    'NETWORK',
    action === 'connect'
      ? '网络不通，没能连上仓库。检查网络后再试一次；已经建好的仓库不会重复创建。'
      : '网络不通，改动已保存在本地，联网后会自动补同步。',
  );
}

/** 401/403 时说清楚是哪个权限没给，而不是让用户猜令牌哪里错了 */
function authFailure(cfg: GitConfig, action: 'connect' | 'sync', raw?: string) {
  const scope =
    cfg.provider === 'gitee'
      ? '勾选 projects（项目）权限'
      : cfg.provider === 'gitcode'
        ? '勾选仓库读写权限'
        : '勾选 repo（经典令牌）权限';
  return new GitError(
    'AUTH_FORBIDDEN',
    action === 'connect'
      ? `令牌没有读写 ${cfg.owner}/${cfg.repo} 的权限。请确认令牌未过期、${scope}，然后再点一次「校验令牌」。`
      : `令牌没有读写仓库的权限。请到设置里重新校验令牌，并确认${scope}。`,
    raw,
  );
}

const API = {
  github: 'https://api.github.com',
  gitee: 'https://gitee.com/api/v5',
  // GitCode 的 API 沿用 Gitee v5 的形状：access_token 查询参数 + /user、/user/repos
  gitcode: 'https://api.gitcode.com/api/v5',
};

/** 平台在错误响应里通常会写清哪个参数不对，截一段给「技术细节」用 */
async function errorBody(res: Response) {
  try {
    const text = (await res.text()).trim();
    return text.length > 300 ? `${text.slice(0, 300)}…` : text;
  } catch {
    return '';
  }
}

async function gh(path: string, token: string, init: RequestInit = {}) {
  const res = await fetch(`${API.github}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  if (res.status === 401) throw new GitError('AUTH_INVALID', 'Token 无效或已过期');
  if (res.status === 403) throw new GitError('AUTH_FORBIDDEN', 'Token 权限不足', await errorBody(res));
  if (res.status === 404)
    throw new GitError('REPO_NOT_FOUND', '找不到该仓库，或 Token 没有访问权限', await errorBody(res));
  if (res.status === 422)
    throw new GitError('UNKNOWN', '仓库名称已被占用或不合法，请换一个名称。', await errorBody(res));
  if (!res.ok) throw new GitError('UNKNOWN', `请求失败（${res.status}）`, await errorBody(res));
  return res.json();
}

/** Gitee 与 GitCode 共用 v5 API 形状，只有域名不同 */
async function v5(provider: 'gitee' | 'gitcode', path: string, token: string, init: RequestInit = {}) {
  const sep = path.includes('?') ? '&' : '?';
  const res = await fetch(`${API[provider]}${path}${sep}access_token=${encodeURIComponent(token)}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  if (res.status === 401) throw new GitError('AUTH_INVALID', 'Token 无效或已过期');
  if (res.status === 403) throw new GitError('AUTH_FORBIDDEN', 'Token 权限不足', await errorBody(res));
  if (res.status === 404) throw new GitError('REPO_NOT_FOUND', '找不到该仓库', await errorBody(res));
  if (res.status === 422)
    throw new GitError('UNKNOWN', '仓库名称已被占用或不合法，请换一个名称。', await errorBody(res));
  if (!res.ok) throw new GitError('UNKNOWN', `请求失败（${res.status}）`, await errorBody(res));
  return res.json();
}

export async function verifyToken(provider: Provider, token: string): Promise<string> {
  try {
    if (provider === 'github') {
      const u = await gh('/user', token);
      return u.login;
    }
    const u = await v5(provider, '/user', token);
    return u.login || u.username || u.name;
  } catch (e) {
    if (e instanceof GitError) throw e;
    throw new GitError('NETWORK', '网络不可达，请检查网络或稍后重试');
  }
}

/**
 * 开启云端推送前预检 workflow 权限。
 *
 * 经典令牌的 scope 会出现在 `x-oauth-scopes` 响应头里，缺 workflow 可以提前拦住，
 * 免得等第一次同步被 GitHub 拒绝才发现。细粒度令牌不返回 scope 列表（只有权限集合），
 * 这里只能返回 null 表示「无法判断」，由同步失败时的提示和恢复入口兜底。
 */
export interface WorkflowPermissionCheck {
  /** true/false；null 表示无法判断（细粒度令牌或查询失败） */
  allowed: boolean | null;
  /** 经典令牌实际返回的 scope 列表；无法判断时为空 */
  scopes: string[];
}

export async function checkGitHubWorkflowPermission(token: string): Promise<WorkflowPermissionCheck> {
  const unknown: WorkflowPermissionCheck = { allowed: null, scopes: [] };
  if (!token) return unknown;
  // 只有经典令牌（ghp_，以及早期的 40 位十六进制令牌）才有 OAuth scope 可查。
  // 细粒度令牌（github_pat_）和 App/OAuth 令牌（gho_/ghu_/ghs_）没有这个响应头，
  // 直接当「无法判断」，避免被其它头信息误判成缺权限。
  if (!token.startsWith('ghp_') && !/^[0-9a-f]{40}$/i.test(token)) return unknown;
  // 代理或弱网下这个请求可能拖很久，界面不能一直像卡住一样；超时就当「无法判断」，
  // 正常开启，真缺权限时由推送失败的提示兜底。
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(`${API.github}/user`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
      // 刚在 GitHub 上改过权限时别拿浏览器缓存里的旧响应头
      cache: 'no-store',
      signal: ctrl.signal,
    });
    if (!res.ok) return unknown;
    const scopes = (res.headers.get('x-oauth-scopes') || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    // 没有 scope 头通常是细粒度令牌或 GitHub App 令牌，无法预检
    if (!scopes.length) return unknown;
    const allowed = scopes.includes('workflow');
    // 只记录权限名，不记录令牌本身；排查「明明补了权限却还提示缺失」时能看出应用读到的是哪一份
    log('sync', 'info', `workflow 权限预检 · scopes=${scopes.join(',')} · ${allowed ? '有' : '缺'} workflow`);
    return { allowed, scopes };
  } catch {
    return unknown;
  } finally {
    clearTimeout(timer);
  }
}

export async function getRepo(provider: Provider, token: string, owner: string, repo: string) {
  try {
    const data =
      provider === 'github'
        ? await gh(`/repos/${owner}/${repo}`, token)
        : await v5(provider, `/repos/${owner}/${repo}`, token);
    return {
      private: Boolean(data.private),
      defaultBranch: data.default_branch || data.default_branch_name || 'main',
      sizeKb: data.size || 0,
    };
  } catch (e) {
    if (e instanceof GitError) throw e;
    throw new GitError('NETWORK', '网络不可达');
  }
}

/**
 * 把已存在的公开仓库改为私有。
 *
 * 三个平台都是 `PATCH /repos/{owner}/{repo}`，但入参编码并不统一：
 * GitHub 只认 JSON；Gitee 的文档按表单参数写（`private=true`），部分账号只回 400；
 * GitCode 有的接口只认 JSON。所以按「表单 → JSON → 纯查询参数」依次尝试，
 * 只有 400 / 405 / 415 / 422 这种「参数格式不对」才换下一种，401/403/404 直接给结论。
 *
 * GitHub 需要令牌带 Administration 写权限（classic 是 repo），Gitee / GitCode 需要是仓库管理员。
 */
export async function setRepoPrivate(provider: Provider, token: string, owner: string, repo: string): Promise<boolean> {
  const base = `${API[provider]}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const query = provider === 'github' ? '' : `?access_token=${encodeURIComponent(token)}`;
  const authHeaders: Record<string, string> =
    provider === 'github'
      ? { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' }
      : { Accept: 'application/json' };
  const form = new URLSearchParams({ access_token: token, name: repo, private: 'true' }).toString();

  const shapes: Array<{ url: string; headers: Record<string, string>; body?: string }> =
    provider === 'github'
      ? [
          {
            url: `${base}`,
            headers: { ...authHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({ private: true }),
          },
        ]
      : [
          {
            url: `${base}${query}`,
            headers: { ...authHeaders, 'Content-Type': 'application/x-www-form-urlencoded' },
            body: form,
          },
          {
            url: `${base}${query}`,
            headers: { ...authHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({ private: true }),
          },
          { url: `${base}${query}&private=true`, headers: authHeaders },
        ];

  let status = 0;
  let detail = '';
  for (const shape of shapes) {
    let res: Response;
    try {
      res = await fetch(shape.url, { method: 'PATCH', headers: shape.headers, body: shape.body });
    } catch (e) {
      throw new GitError('NETWORK', '网络不通，没能修改仓库设置。请联网后重试。', String((e as Error)?.message || e));
    }
    if (res.ok) {
      const data = await res.json().catch(() => null);
      return Boolean(data?.private ?? true);
    }
    detail = await errorBody(res);
    status = res.status;
    if (status === 401) {
      throw new GitError('AUTH_INVALID', '令牌无效或已过期，请重新校验令牌后再试。', detail);
    }
    if (status === 403) {
      throw new GitError(
        'REPO_PRIVATE_DENIED',
        '令牌没有修改仓库设置的权限，所以没能自动改为私有。可以换一个带仓库管理权限的令牌再试。',
        detail,
      );
    }
    if (status === 404) {
      throw new GitError('REPO_NOT_FOUND', '找不到这个仓库，或令牌看不到它。请确认仓库名与令牌权限。', detail);
    }
    if (![400, 405, 415, 422].includes(status)) break;
  }

  throw new GitError('REPO_PRIVATE_FAILED', `改为私有失败（平台返回 ${status}）。`, detail);
}

export async function createRepo(provider: Provider, token: string, repo: string) {
  if (provider === 'github') {
    return gh('/user/repos', token, {
      method: 'POST',
      body: JSON.stringify({ name: repo, private: true, auto_init: true, description: '萤光笔记仓库' }),
    });
  }
  return v5(provider, '/user/repos', token, {
    method: 'POST',
    body: JSON.stringify({ name: repo, private: true, auto_init: true, description: '萤光笔记仓库' }),
  });
}

export function remoteUrl(cfg: GitConfig) {
  const host = PROVIDERS[cfg.provider].host;
  return `https://${host}/${cfg.owner}/${cfg.repo}.git`;
}

function auth(cfg: GitConfig, token: string, login: string) {
  return {
    username: cfg.provider === 'github' ? 'x-access-token' : login,
    password: token,
  };
}

export async function ensureRepo(cfg: GitConfig) {
  // 分支名留空会让 git.init / fetch 在发出任何网络请求之前就失败，这类本地错误最难猜
  const branch = (cfg.branch || '').trim() || 'main';
  if (branch !== cfg.branch) cfg = { ...cfg, branch };
  await ensureDir(ROOT);
  let inited = false;
  try {
    await git.resolveRef({ fs, dir: ROOT, ref: 'HEAD' });
    inited = true;
  } catch {
    inited = false;
  }
  log('git', 'info', `本地仓库${inited ? '已存在' : '还没有 .git，准备初始化'} · 分支 ${branch}`);
  if (!inited) {
    try {
      await git.init({ fs, dir: ROOT, defaultBranch: branch });
    } catch (e) {
      const msg = String((e as Error)?.message || e);
      log('git', 'error', `git.init 失败 · ${msg}`);
      throw new GitError(
        'UNKNOWN',
        `本地仓库初始化失败（${msg}），和令牌、网络无关。请确认「设置 → 常规 → 笔记存储位置」里的文件夹可写。`,
        msg,
      );
    }
  }
  // 每次都以当前配置为准：用户改过仓库名 / 换过平台后，旧的 origin 必须被覆盖，
  // 否则 isomorphic-git 会抛「Failed to create remote at origin because it already exists」。
  try {
    await git.addRemote({ fs, dir: ROOT, remote: 'origin', url: remoteUrl(cfg), force: true });
  } catch (e) {
    const msg = String((e as Error)?.message || e);
    log('git', 'error', `addRemote 失败 · ${msg}`);
    throw new GitError('UNKNOWN', `写入远程地址失败（${msg}），请检查本地仓库目录是否可写。`, msg);
  }
  log('git', 'info', `远程地址 ${remoteUrl(cfg)}`);
  return inited ? 'existing' : 'initialized';
}

/**
 * 让本机当前分支和配置里的分支名对齐。
 *
 * 同一个本地仓库换过平台 / 换过账号时很容易遇到：Gitee 默认 master，GitCode 默认 main，
 * 本地 .git 还停在旧分支名上，而 merge / push 都盯着 cfg.branch。这时 refs/heads/main
 * 根本不存在，isomorphic-git 抛出的错误和「同名文件冲突」完全没有关系，用户只会更迷茫。
 * 分支指向同一个 HEAD 时直接切过去；同名分支已有别的历史，就先留一个备份分支再覆盖。
 */
async function alignLocalBranch(branch: string): Promise<boolean> {
  const headOid = await git.resolveRef({ fs, dir: ROOT, ref: 'HEAD' }).catch(() => null);
  if (!headOid) return false;
  const current = await git.currentBranch({ fs, dir: ROOT, fullname: false }).catch(() => undefined);
  if (current === branch) return false;
  const existing = await git.resolveRef({ fs, dir: ROOT, ref: `refs/heads/${branch}` }).catch(() => null);
  if (existing && existing !== headOid) {
    const now = new Date();
    const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
    await git.branch({ fs, dir: ROOT, ref: `glimnote-backup/${branch}-${stamp}`, object: existing }).catch(() => {});
  }
  await git.branch({ fs, dir: ROOT, ref: branch, object: headOid, checkout: true, force: true });
  log('git', 'info', `本机分支 ${current || '(未知)'} 与配置不一致，已对齐到 ${branch}`);
  return true;
}

async function stageAll() {
  const matrix = await git.statusMatrix({ fs: gitFs, dir: ROOT });
  const changes = matrix.filter(([, head, work, stage]) => !(head === 1 && work === 1 && stage === 1));
  let staged = 0;

  for (const [filepath] of changes) {
    // 日志、本地历史快照、临时克隆区只属于这台设备，不提交到仓库
    if (isLocalOnly(filepath)) continue;
    const st = matrix.find(([f]) => f === filepath);
    if (!st) continue;
    if (st[2] === 0) {
      try {
        await git.remove({ fs, dir: ROOT, filepath });
      } catch {
        /* file may already be gone */
      }
    } else {
      await git.add({ fs, dir: ROOT, filepath });
    }
    staged += 1;
  }
  return staged;
}

/** 有没有值得提交的改动（本机日志 / 历史快照不算） */
async function hasChanges() {
  const matrix = await git.statusMatrix({ fs: gitFs, dir: ROOT });
  return matrix.some(
    ([filepath, head, work, stage]) => !isLocalOnly(filepath) && !(head === 1 && work === 1 && stage === 1),
  );
}

interface WorktreeAudit {
  /** HEAD 里参与同步的已跟踪文件总数 */
  total: number;
  /** 仓库里有、磁盘上却不见了的文件（相对路径） */
  missing: string[];
}

/**
 * 对照 HEAD 检查工作区，找出被「弄丢」的已跟踪文件。
 * 用 statusMatrix 一次扫完：同步流程本来就要算它，额外成本很低；
 * 逐个文件 exists 在几百篇笔记时会变成几百次 IPC 往返。
 */
async function auditWorktree(): Promise<WorktreeAudit> {
  try {
    const matrix = await git.statusMatrix({ fs: gitFs, dir: ROOT });
    const tracked = matrix.filter(([filepath]) => !isLocalOnly(filepath));
    const missing = tracked.filter(([, head, work]) => head === 1 && work === 0).map(([filepath]) => filepath);
    return { total: tracked.filter(([, head]) => head === 1).length, missing };
  } catch {
    // 还没有提交（首次连接）就没有可比对的基线
    return { total: 0, missing: [] };
  }
}

/**
 * 工作区是否像被重置过：超过一半的已跟踪文件同时消失。
 *
 * 正常删除笔记会先进回收站，清空回收站也只影响 .trash；都不该让半数以上
 * 的仓库文件同时不见。只有重装 / 换目录 / 被清空之后重新播种示例数据才会这样。
 */
function looksReset(audit: WorktreeAudit) {
  if (audit.total < 8 || audit.missing.length < 8) return false;
  const ratio = audit.missing.length / audit.total;
  if (ratio < 0.5) return false;
  // 只在 notes/ 里删掉一堆笔记，更像用户主动清理；整片消失才会横跨多个顶层目录。
  // 两种情况都放过会误伤正常删除，所以要么几乎全没（≥90%），要么跨 ≥3 个目录。
  const dirs = new Set(audit.missing.map((p) => p.split('/')[0]));
  return ratio >= 0.9 || dirs.size >= 3;
}

/**
 * 把缺失的已跟踪文件按 HEAD 里的内容写回磁盘。
 *
 * 只补文件，不删任何本地后加的内容；更不会调用 commitAll —— 否则「缺文件」
 * 会被 stageAll 当成删除提交，正好是我们要避免的事故。
 */
async function restoreMissingTracked(files: string[]) {
  if (!files.length) return;
  try {
    await git.checkout({ fs, dir: ROOT, ref: 'HEAD', filepaths: files, force: true });
    return;
  } catch {
    /* 逐个 blob 写回，兼容 checkout 在同一分支上的边界情况 */
  }
  const headOid = await git.resolveRef({ fs, dir: ROOT, ref: 'HEAD' }).catch(() => null);
  if (!headOid) return;
  for (const filepath of files) {
    try {
      const { blob } = await git.readBlob({ fs, dir: ROOT, oid: headOid, filepath });
      await writeBinary(`${ROOT}/${filepath}`, blob);
    } catch {
      /* 单个文件补不回来不阻断其它文件 */
    }
  }
}

async function commitAll(message: string) {
  const staged = await stageAll();
  if (!staged) return null;
  const oid = await git.commit({
    fs,
    dir: ROOT,
    message,
    author: { name: '萤光笔记', email: 'glimnote@local' },
  });
  markCommitDone();
  return oid;
}

async function epochOf(oid: string | null): Promise<string | null> {
  if (!oid) return null;
  try {
    const { blob } = await git.readBlob({ fs, dir: ROOT, oid, filepath: EPOCH_FILE });
    return new TextDecoder().decode(blob).trim() || null;
  } catch {
    return null;
  }
}

async function localEpoch(): Promise<string | null> {
  try {
    const text = await readText(`${ROOT}/${EPOCH_FILE}`);
    return text.trim() || null;
  } catch {
    return null;
  }
}

/**
 * 远端历史被压缩后，旧设备如果照常 merge，会把旧提交（连同里面的大文件）重新接回去。
 * 提交里带一个 epoch 标记：远端有标记、本机标记不同，就直接让用户重新下载，而不是悄悄合并。
 */
async function assertHistoryEpoch(remoteOid: string | null) {
  const remote = await epochOf(remoteOid);
  if (!remote) return;
  const local = await localEpoch();
  if (local !== remote) {
    throw new GitError('HISTORY_REWRITTEN', HISTORY_REWRITTEN_MESSAGE);
  }
}

export interface RepoSize {
  notes: number;
  assets: number;
  git: number;
  files: number;
}

/** 设置页的仓库体检：当前笔记、附件与 .git 历史各占多少 */
export async function repoSize(): Promise<RepoSize> {
  const [notes, assets, gitDir] = await Promise.all([
    pathSize(`${ROOT}/notes`),
    pathSize(`${ROOT}/assets`),
    pathSize(`${ROOT}/.git`),
  ]);
  return {
    notes: notes.bytes,
    assets: assets.bytes,
    git: gitDir.bytes,
    files: notes.files + assets.files + gitDir.files,
  };
}

interface ConflictCopy {
  path: string;
  /** 两边都改过的非文本文件（图片、附件），写副本时要按原始字节读回 */
  binary?: boolean;
}

/**
 * 两台设备改到同一篇笔记时的处理：本地版本保留在原路径，
 * 远端版本另存为「冲突副本」，两边内容都不丢，交给用户合并。
 *
 * keepOurs 只在用户明确选择「保留本机」时打开：连图片 / 附件也采用本机版本，
 * 否则这类文件会让 merge 直接失败、把人卡在错误提示上。
 *
 * 注意：isomorphic-git 传给 mergeDriver 的 path 只有文件名（basename），
 * 没有 notes/ 这样的目录，所以冲突路径统一靠 detectConflicts() 另外找。
 */
function mergeDriverFactory(keepOurs = false) {
  return ({ contents, path }: { contents: string[]; path: string }) => {
    const [, ours, theirs] = contents;
    // 这里的 mergedText 会被当成 UTF-8 写成 blob；二进制文件可能被转码，
    // 合并完成后会用本机 HEAD 里的原始字节覆盖回来，所以这里只需让合并继续。
    if (keepOurs || path.endsWith('.md')) return { cleanMerge: true, mergedText: ours };
    // 隐私锁文件两边都改过时按时间戳自动合并，避免为几把锁生成冲突副本
    if (path === 'privacy.json') {
      const merged = mergePrivacyJson(ours, theirs);
      if (merged) return { cleanMerge: true, mergedText: merged };
    }
    // 密钥文件同理：两台设备各改各的时按时间戳取新，避免冲突副本里反而留下旧密钥
    if (path === 'keys.json') {
      const merged = mergeKeysJson(ours, theirs);
      if (merged) return { cleanMerge: true, mergedText: merged };
    }
    // 资源登记表：两台设备各自上传 / 删除图片时按条目合并，避免为一张 JSON 生成冲突副本
    if (path === 'assets-index.json') {
      const merged = mergeAssetsIndexJson(ours, theirs);
      if (merged) return { cleanMerge: true, mergedText: merged };
    }
    return { cleanMerge: false, mergedText: '' };
  };
}

/**
 * 预演一次合并，拿到所有冲突文件的完整路径。
 *
 * mergeDriver 只给 basename，写「冲突副本」却必须知道它原来在哪个目录；
 * dry-run 既不写对象也不动工作区，出错信息里带着完整 filepaths，正好拿来用。
 */
async function detectConflicts(ours: string, theirs: string): Promise<Set<string>> {
  try {
    await git.merge({
      fs,
      dir: ROOT,
      ours,
      theirs,
      author: { name: '萤光笔记', email: 'glimnote@local' },
      allowUnrelatedHistories: true,
      dryRun: true,
      mergeDriver: () => ({ cleanMerge: false, mergedText: '' }),
    });
    return new Set();
  } catch (e) {
    const data = (e as { data?: { filepaths?: string[]; bothModified?: string[] } } | null)?.data;
    if (Array.isArray(data?.filepaths)) return new Set(data.filepaths);
    // 不是冲突类错误（例如历史不相关但没开 allowUnrelatedHistories）就交给后面的真实合并报错
    return new Set();
  }
}

/** 把这些路径分成「笔记冲突副本」和「二进制冲突副本」；远端已删除的文件跳过 */
async function describeConflicts(paths: Set<string>, remoteOid: string | null): Promise<ConflictCopy[]> {
  const list: ConflictCopy[] = [];
  for (const path of paths) {
    if (path.startsWith('.git/')) continue;
    let remoteExists = false;
    if (remoteOid) {
      remoteExists = await git
        .readBlob({ fs, dir: ROOT, oid: remoteOid, filepath: path })
        .then(() => true)
        .catch(() => false);
    }
    // 远端都删掉了就没有「远端版本」可留，直接沿用本机
    if (!remoteExists) continue;
    list.push(path.endsWith('.md') ? { path } : { path, binary: true });
  }
  return list;
}

function conflictCopyPath(path: string, seen: Set<string>) {
  const now = new Date();
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
  const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
  const name = path.slice(dir.length);
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let candidate = `${dir}${stem} (冲突副本 ${stamp})${ext}`;
  let i = 2;
  while (seen.has(candidate)) candidate = `${dir}${stem} (冲突副本 ${stamp}-${i++})${ext}`;
  seen.add(candidate);
  return candidate;
}

function markTitle(text: string) {
  return text.replace(/^---\n([\s\S]*?)\n---/, (_block, yaml: string) => {
    const next = yaml.replace(/^title:(.*)$/m, (line) => `${line}（冲突副本）`);
    return `---\n${next}\n---`;
  });
}

async function writeConflictCopies(conflicts: ConflictCopy[], remoteOid: string | null): Promise<string[]> {
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const c of conflicts) {
    if (!remoteOid) continue;
    const target = conflictCopyPath(c.path, seen);
    try {
      // 统一从远端提交里取版本：笔记保留 frontmatter 并标上「冲突副本」，
      // 图片 / 附件按原始字节写回，不经过文本转码。
      const { blob } = await git.readBlob({ fs, dir: ROOT, oid: remoteOid, filepath: c.path });
      if (c.binary) await writeBinary(`${ROOT}/${target}`, blob);
      else await writeText(`${ROOT}/${target}`, markTitle(new TextDecoder().decode(blob)));
    } catch {
      // 单个文件读不到（例如远端已删除）就跳过，不影响其它冲突副本
      continue;
    }
    paths.push(target);
  }
  return paths;
}

/** 保留本机时，把二进制冲突文件按合并前的本地提交原样写回，抵消合并过程中的 UTF-8 转码 */
async function restoreBinaryFromHead(files: string[], headOid: string | null) {
  if (!headOid || !files.length) return;
  for (const filepath of files) {
    try {
      const { blob } = await git.readBlob({ fs, dir: ROOT, oid: headOid, filepath });
      await writeBinary(`${ROOT}/${filepath}`, blob);
    } catch {
      /* 单个文件还原失败不阻断连接 */
    }
  }
}

export interface SyncResult {
  pulled: number;
  pushed: boolean;
  commit: string | null;
  /** 本次保存的冲突副本（相对仓库根的路径） */
  conflicts: string[];
  /** 改动已经写进本地文件，但还没到自动提交的时间 */
  deferred?: boolean;
}

export interface ConnectOptions {
  /**
   * 首次连接（本机还没有任何提交）而远端已有内容时的选择：
   * - merge：两边都保留，同名文件生成冲突副本
   * - adopt-remote：备份本机内容后用远端覆盖
   * 不传时由 connect 自行判断：只有示例数据就直接采用远端，有用户内容则抛 FIRST_CONNECT_CHOICE。
   */
  firstConnect?: 'merge' | 'adopt-remote';
  /**
   * 本地工作区缺少大量已跟踪文件（目录被重置 / 重装后只剩示例）时的选择：
   * - restore：按本地历史把缺失文件写回磁盘（推荐）
   * - keep：用户确认保持现状，本次连接会把缺失文件当成删除提交
   * 不传时抛 WORKTREE_RESET，由界面明确询问，绝不默认推送大量删除。
   */
  worktreeReset?: 'restore' | 'keep';
  /**
   * 两边都有改动、自动合并失败时的选择：
   * - keep-local：本机版本保留在原路径，远端版本另存为冲突副本，然后继续推送
   * 不传时抛 MERGE_CONFLICT，由界面让用户明确选择，绝不只丢一句错误。
   */
  mergeConflict?: 'keep-local';
}

/**
 * 远端是不是「刚建好的空仓库」。
 *
 * 平台建仓默认带 auto_init，远端会有一条只含 README 的初始提交。如果把它当成
 * 「远端已经有内容」，首次同步就会按旧逻辑清掉本机全部安装示例再检出远端，
 * 结果新仓库里一个笔记本、一篇示例笔记都没有（左侧空白）。
 * 这里只看有没有真正的笔记内容目录；没有就保留示例，并随首次提交一起推上去。
 */
const REMOTE_CONTENT_PREFIXES = ['notes/', 'tasks/', 'ideas/', 'home/', 'apps/', 'assets/', '.glimnote/'];

async function remoteLooksEmpty(oid: string): Promise<boolean> {
  try {
    const files = await git.listFiles({ fs, dir: ROOT, ref: oid });
    return !files.some((file) => REMOTE_CONTENT_PREFIXES.some((prefix) => file.startsWith(prefix)));
  } catch {
    // 读不到文件列表时按「有内容」处理：宁可多问一次，也不要误删本机内容
    return false;
  }
}

export async function connect(cfg: GitConfig, token: string, login: string, options: ConnectOptions = {}) {
  try {
    await ensureRepo(cfg);
  } catch (e) {
    if (e instanceof GitError) throw e;
    // 本地仓库初始化 / 改写 origin 失败的报错原来会一路裸奔到界面，只剩一句「连接没有成功」
    const msg = String((e as Error)?.message || e);
    throw new GitError('UNKNOWN', friendlyGitMessage(msg, 'connect'), msg);
  }
  const pendingReadme = localStorage.getItem(README_SEED_KEY) === seedKey(cfg);
  const onAuth = () => auth(cfg, token, login);

  try {
    await git.fetch({ fs, http: gitHttp, dir: ROOT, remote: 'origin', ref: cfg.branch, singleBranch: true, onAuth });
  } catch (e: any) {
    if (e instanceof GitError) throw e;
    const net = networkFailure(e, cfg.provider, 'connect');
    if (net) throw net;
    const msg = String(e?.message || e);
    if (/401|403|authentication|permission|authorization|授权/i.test(msg)) throw authFailure(cfg, 'connect', msg);
    throw new GitError('UNKNOWN', friendlyGitMessage(msg, 'connect'), msg);
  }

  const remoteOid = await git.resolveRef({ fs, dir: ROOT, ref: `refs/remotes/origin/${cfg.branch}` }).catch(() => null);
  let localOid = await git.resolveRef({ fs, dir: ROOT, ref: 'HEAD' }).catch(() => null);

  // 换平台 / 换账号后分支名常常对不上（Gitee 默认 master，GitCode 默认 main）。
  // 先把本机分支对齐到配置里的名字，后面的 merge、push 才盯得上同一个 ref。
  if (localOid) {
    try {
      await alignLocalBranch(cfg.branch);
    } catch (e) {
      const msg = String((e as Error)?.message || e);
      log('git', 'warn', `对齐本机分支失败 · ${msg}`);
      throw new GitError('UNKNOWN', '没能把本机笔记切换到仓库使用的分支，请重试一次连接。', msg);
    }
  }

  // 本机 .git 里还有历史，但工作区已经只剩零星文件（重装、换目录、被清空后
  // 重新播种）。这时 HEAD 可能和远端完全相同，不会触发 merge，后面的
  // commitAll 会把「少掉的文件」当成删除提交并推送，等于整片覆盖云端数据。
  // 所以连接前必须对照 HEAD 审一次工作区，缺得太多就先停下来让用户选择。
  if (localOid && remoteOid) {
    const audit = await auditWorktree();
    if (looksReset(audit)) {
      if (!options.worktreeReset) {
        throw new GitError(
          'WORKTREE_RESET',
          `本地笔记目录缺少 ${audit.missing.length}/${audit.total} 个仓库里已有的文件。直接连接会把它们当成删除提交到云端，请先选择恢复方式。`,
        );
      }
      if (options.worktreeReset === 'restore') {
        const state = await localContentState().catch(() => null);
        const all = state ? [...state.seedFiles, ...state.userFiles] : [];
        const backup = all.length ? await backupUserFiles(all, 'reset') : '';
        await restoreMissingTracked(audit.missing);
        log(
          'sync',
          'info',
          `本地缺少 ${audit.missing.length} 个已跟踪文件，已按本地历史恢复${backup ? `（恢复前内容已备份到 ${backup}）` : ''}`,
        );
      } else {
        log('sync', 'warn', `用户确认保持现状：本次连接会把缺失的 ${audit.missing.length} 个文件从仓库删除`);
      }
    }
  }

  // 首次连接一台新电脑时，本机通常已经有一批安装示例。远端如果已经有内容，
  // 不能把这些示例当成用户笔记推上去（会在别人的仓库里多出几篇假的「周报」）。
  // 但用户真正写过的东西也不能被当成示例：只有「文件指纹和安装时完全一致」才动。
  if (remoteOid && !localOid) {
    const state = await localContentState().catch(() => null);
    const remoteEmpty = await remoteLooksEmpty(remoteOid);
    if (remoteEmpty) {
      // 平台建仓默认 auto_init，远端只有一条 README 提交。这时本机的默认笔记本
      // 和示例笔记就是用户看到的第一屏内容，保留下来随下面的首次提交推上去。
      const restored = await ensureStarterContent().catch(() => false);
      log(
        'sync',
        'info',
        restored
          ? '远端是刚建好的空仓库，本机默认笔记之前被清空了，已补回并准备首次推送'
          : '远端是刚建好的空仓库，保留本机默认笔记本与示例笔记，首次提交会一并推送',
      );
    } else if (state?.known && state.pristine) {
      if (state.seedFiles.length) {
        const backup = await backupUserFiles(state.seedFiles, 'seed');
        await removeUserFiles(state.seedFiles);
        log('sync', 'info', `本机只有安装示例，已备份到 ${backup} 并改用远端仓库内容`);
      }
    } else if (state && state.userFiles.length) {
      if (!options.firstConnect) {
        throw new GitError(
          'FIRST_CONNECT_CHOICE',
          '远端仓库里已经有笔记，本机也有自己的内容。请选择「合并两边」或「用仓库覆盖本地」。',
        );
      }
      if (options.firstConnect === 'adopt-remote') {
        const all = [...state.seedFiles, ...state.userFiles];
        const backup = await backupUserFiles(all, 'remote');
        await removeUserFiles(all);
        log('sync', 'info', `首次连接选择用远端覆盖本机，本机内容已备份到 ${backup}`);
      } else if (options.firstConnect === 'merge') {
        // 合并需要两边都有提交：先把本机内容提交成一条本地提交，再和远端做
        // 无关历史的合并，同名文件仍走冲突副本，不会直接覆盖任何一边。
        await commitAll('chore: 连接前保存本机笔记');
        localOid = await git.resolveRef({ fs, dir: ROOT, ref: 'HEAD' }).catch(() => null);
        log('sync', 'info', '首次连接选择合并两边，已先提交本机笔记');
      }
    }
  }

  let conflictPaths: string[] = [];
  if (remoteOid && localOid && remoteOid !== localOid) {
    await assertHistoryEpoch(remoteOid);

    // merge 需要一个干净的工作区：本地刚写完还没提交的改动会以 checkout 冲突的
    // 形式让合并失败，看起来却像「同名文件冲突」。先收进一条本地提交，和 sync 保持一致。
    const preCommit = await commitAll('chore: 连接前保存本机笔记');
    if (preCommit) {
      localOid = await git.resolveRef({ fs, dir: ROOT, ref: 'HEAD' }).catch(() => null);
      log('sync', 'info', '连接前已先提交本机改动，避免合并时工作区不干净');
    }

    // 先预演一次拿到完整冲突路径（mergeDriver 只给文件名，不够拼出冲突副本的位置）
    const conflictedPaths = await detectConflicts(cfg.branch, `origin/${cfg.branch}`);

    const mergeOnce = (keepOurs: boolean) =>
      git.merge({
        fs,
        dir: ROOT,
        ours: cfg.branch,
        theirs: `origin/${cfg.branch}`,
        author: { name: '萤光笔记', email: 'glimnote@local' },
        allowUnrelatedHistories: true,
        mergeDriver: mergeDriverFactory(keepOurs),
      });

    try {
      await mergeOnce(false);
    } catch (e) {
      if (e instanceof GitError) throw e;
      const detail = String((e as Error)?.message || e);
      if (options.mergeConflict === 'keep-local') {
        // 用户选择保留本机：重来一次，冲突文件全部采用本机版本，远端版本写成冲突副本，
        // 这样图片 / 附件这类没法自动合并的文件也不会再把整次连接卡死。
        try {
          await mergeOnce(true);
        } catch (again) {
          // 这里不再弹回同一个选择框：保留本机都走不通，说明不是普通同名冲突，
          // 直接把「改用覆盖 / 手动处理」说清楚，避免用户在同一个弹窗里反复点。
          throw new GitError(
            'CONFLICT',
            '合并仍然没能完成。请改用「用仓库覆盖本地（先自动备份）」或手动处理。',
            String((again as Error)?.message || again),
          );
        }
      } else {
        // 单独的错误码：界面据此弹出二选一，而不是只留一句「请自己处理」。
        throw new GitError(
          'MERGE_CONFLICT',
          '连接时两边都有改动，其中有文件无法自动合并。本机改动已经保存成提交，请选择保留本机，或用仓库覆盖本地。',
          detail,
        );
      }
    }

    // isomorphic-git 的 merge 只更新分支指针和索引，不写工作区；不 checkout 的话，
    // 仓库里拉下来的笔记不会出现在磁盘上，下一次保存还会把它们当成删除推回去。
    try {
      await git.checkout({ fs, dir: ROOT, ref: cfg.branch, force: true });
    } catch (e) {
      throw new GitError(
        'UNKNOWN',
        '合并已完成，但把仓库内容写入本地文件夹时失败。请再点一次连接。',
        String((e as Error)?.message || e),
      );
    }
    if (conflictedPaths.size) {
      const copies = await describeConflicts(conflictedPaths, remoteOid);
      const binaryPaths = copies.filter((c) => c.binary).map((c) => c.path);
      if (binaryPaths.length) await restoreBinaryFromHead(binaryPaths, localOid);
      if (copies.length) conflictPaths = await writeConflictCopies(copies, remoteOid);
    }
  } else if (remoteOid && !localOid) {
    try {
      await git.checkout({ fs, dir: ROOT, ref: cfg.branch });
    } catch (e) {
      const msg = String((e as Error)?.message || e);
      if (/conflict|overwritten/i.test(msg)) {
        // 单独一个错误码，界面据此弹出「强制覆盖 / 手动处理」的选择框，
        // 而不是把这段说明当成一行状态文字；用户需要明确二选一才能继续。
        throw new GitError('CHECKOUT_CONFLICT', '仓库里已经有同名文件，而且内容和本地不一样，所以没有直接覆盖。');
      }
      throw new GitError('UNKNOWN', friendlyGitMessage(msg, 'connect'), msg);
    }
  }

  // 合并之后再写，避免和平台 auto_init 生成的默认 README 撞成冲突副本
  if (pendingReadme) {
    await writeText(`${ROOT}/README.md`, repoReadme(cfg));
  }

  const commit = await commitAll('chore: 连接笔记仓库');
  try {
    await git.push({ fs, http: gitHttp, dir: ROOT, remote: 'origin', ref: cfg.branch, onAuth });
  } catch (e: any) {
    if (e instanceof GitError) throw e;
    const msg = String(e?.message || e);
    if (/not-fast-forward|rejected/i.test(msg)) {
      throw new GitError('CONFLICT', '仓库刚被其他设备更新，请重试连接');
    }
    // 细粒度令牌的 Workflows 权限缺失也会带 permission 字样，先单独识别，别笼统归成「令牌没权限」
    if (WORKFLOW_SCOPE_FAILURE.test(msg)) throw new GitError('AUTH_FORBIDDEN', friendlyGitMessage(msg, 'connect'), msg);
    if (/401|403|authentication|permission|authorization|授权/i.test(msg)) throw authFailure(cfg, 'connect', msg);
    const net = networkFailure(e, cfg.provider, 'connect');
    if (net) throw net;
    throw new GitError('UNKNOWN', friendlyGitMessage(msg, 'connect'), msg);
  }
  localStorage.setItem('glimnote.git.connected', '1');
  // 推送成功才算真正初始化完成；失败时保留标记，下次连接继续补写
  if (pendingReadme) localStorage.removeItem(README_SEED_KEY);
  return { commit, conflicts: conflictPaths };
}

export async function sync(
  cfg: GitConfig,
  token: string,
  login: string,
  message: string,
  opts: { force?: boolean } = {},
): Promise<SyncResult> {
  await ensureRepo(cfg);
  const onAuth = () => auth(cfg, token, login);

  let pulled = 0;
  const conflictPaths: string[] = [];
  try {
    await git.fetch({ fs, http: gitHttp, dir: ROOT, remote: 'origin', ref: cfg.branch, singleBranch: true, onAuth });
    // fetch 成功就算「刚看过远端」：接下来无论推不推，都隔一会儿再检查
    markSyncCheckDone();
    const remoteOid = await git
      .resolveRef({ fs, dir: ROOT, ref: `refs/remotes/origin/${cfg.branch}` })
      .catch(() => null);
    const localOid = await git.resolveRef({ fs, dir: ROOT, ref: 'HEAD' }).catch(() => null);
    const diverged = Boolean(remoteOid && localOid && remoteOid !== localOid);

    // 换过平台 / 账号后本机分支名可能还停在旧名字，和配置对不上时先对齐
    if (localOid) await alignLocalBranch(cfg.branch);

    // 同样的保险：自动同步前先看工作区是不是被整片清空了。
    // 缺的文件在 HEAD 里都有，直接补回来即可，绝不能把它们提交成删除。
    if (localOid) {
      const audit = await auditWorktree();
      if (looksReset(audit)) {
        await restoreMissingTracked(audit.missing);
        log('sync', 'warn', `检测到本地缺少 ${audit.missing.length} 个已跟踪文件，已从本地历史恢复，未向仓库提交删除`);
      }
    }

    // 先确认两边还是同一段历史，再决定能不能合并
    if (diverged) await assertHistoryEpoch(remoteOid);

    let commit: string | null = null;
    let merged = false;

    if (diverged) {
      // 远端有更新时必须先提交本地改动，否则 merge 没有干净的起点
      const preCommit = await commitAll(message);
      const conflictedPaths = await detectConflicts(cfg.branch, `origin/${cfg.branch}`);

      try {
        await git.merge({
          fs,
          dir: ROOT,
          ours: cfg.branch,
          theirs: `origin/${cfg.branch}`,
          author: { name: '萤光笔记', email: 'glimnote@local' },
          allowUnrelatedHistories: true,
          mergeDriver: mergeDriverFactory(),
        });
        pulled = 1;
        merged = true;
        // merge 不会把远端版本写进工作区，必须 checkout 一次，否则拉下来的笔记不可见，
        // 下一次保存还会把它们当成「本地删除」推回仓库。
        await git.checkout({ fs, dir: ROOT, ref: cfg.branch, force: true });
        if (conflictedPaths.size) {
          const copies = await describeConflicts(conflictedPaths, remoteOid);
          if (copies.length) {
            conflictPaths.push(...(await writeConflictCopies(copies, remoteOid)));
            await commitAll(`merge: 保留 ${copies.length} 份冲突副本`);
          }
        }
        commit = preCommit;
      } catch (e: any) {
        if (e instanceof GitError) throw e;
        throw new GitError('CONFLICT', '检测到冲突：另一台设备也修改了同样的内容，请稍后手动处理');
      }
    } else if (remoteOid && !localOid) {
      // 新工作区第一次同步：本机通常只有安装示例。远端已经有笔记时，示例要清掉、
      // 改用远端内容；远端只是刚建好的空仓库（只有平台 auto_init 的 README）时，
      // 示例就是用户看到的第一批默认笔记本和笔记，必须保留并随首次提交推上去。
      const state = await localContentState().catch(() => null);
      const pristineOnly = Boolean(state?.known && state.pristine);
      const remoteEmpty = await remoteLooksEmpty(remoteOid);
      if (!remoteEmpty && pristineOnly && state && state.seedFiles.length) {
        const backup = await backupUserFiles(state.seedFiles, 'seed');
        await removeUserFiles(state.seedFiles);
        log('sync', 'info', `新工作区仅有安装示例，已备份到 ${backup} 并改用远端仓库内容`);
      }
      await git.checkout({ fs, dir: ROOT, ref: cfg.branch, force: pristineOnly && !remoteEmpty });
      if (remoteEmpty) {
        // 旧版首次同步把示例删掉后，repo.json 还在，bootstrap 不会再播种；
        // 这里补一次，已存在的笔记不受影响（只在 notes/ 为空时生效）。
        const restored = await ensureStarterContent().catch(() => false);
        if (restored) log('sync', 'info', '这个工作区之前被清空了，已补回默认笔记本与示例笔记');
        // checkout 只会写回 README 这类远端已有文件，本地示例仍是未跟踪状态；
        // 提交一次，让远端仓库也拥有默认笔记本和示例笔记。
        commit = await commitAll(message);
        if (commit) log('sync', 'info', '远端是刚建好的空仓库，已把默认笔记本与示例笔记提交上去');
      }
      merged = true;
    } else {
      const dirty = await hasChanges();
      if (dirty && !opts.force && !canCommitNow()) {
        log('sync', 'info', `提交已节流：距上次提交不足 ${loadCommitInterval()} 分钟，改动留在本地`);
        return { pulled: 0, pushed: false, commit: null, conflicts: [], deferred: true };
      }
      if (dirty) commit = await commitAll(message);
    }

    // 既没有新提交，也没有远端变化：不必再发一次 push 请求
    if (!commit && !merged && remoteOid === localOid) {
      return { pulled: 0, pushed: false, commit: null, conflicts: [] };
    }

    let pushed = false;
    try {
      const res = await git.push({ fs, http: gitHttp, dir: ROOT, remote: 'origin', ref: cfg.branch, onAuth });
      pushed = !res.error;
    } catch (e: any) {
      if (String(e?.message || '').includes('not-fast-forward')) {
        await git.fetch({ fs, http: gitHttp, dir: ROOT, remote: 'origin', ref: cfg.branch, onAuth });
        const retryRemoteOid = await git
          .resolveRef({ fs, dir: ROOT, ref: `refs/remotes/origin/${cfg.branch}` })
          .catch(() => null);
        const retryConflicted = await detectConflicts(cfg.branch, `origin/${cfg.branch}`);
        await git.merge({
          fs,
          dir: ROOT,
          ours: cfg.branch,
          theirs: `origin/${cfg.branch}`,
          author: { name: '萤光笔记', email: 'glimnote@local' },
          mergeDriver: mergeDriverFactory(),
        });
        await git.checkout({ fs, dir: ROOT, ref: cfg.branch, force: true });
        if (retryConflicted.size) {
          const copies = await describeConflicts(retryConflicted, retryRemoteOid);
          if (copies.length) {
            conflictPaths.push(...(await writeConflictCopies(copies, retryRemoteOid)));
            await commitAll(`merge: 保留 ${copies.length} 份冲突副本`);
          }
        }
        const res = await git.push({ fs, http: gitHttp, dir: ROOT, remote: 'origin', ref: cfg.branch, onAuth });
        pushed = !res.error;
      } else {
        throw e;
      }
    }
    // checkout / 合并会改写工作区，assets/ 可能有增删：下次打开存储管理时重新对账
    invalidateAssetIndex();
    return { pulled, pushed, commit: commit || null, conflicts: conflictPaths };
  } catch (e: any) {
    if (e instanceof GitError) throw e;
    const net = networkFailure(e, cfg.provider, 'sync');
    if (net) throw net;
    const msg = String(e?.message || e);
    // 工作流权限是账号配置问题，重试再多次也不会自己好，必须交给用户去改令牌
    if (WORKFLOW_SCOPE_FAILURE.test(msg)) throw new GitError('AUTH_FORBIDDEN', friendlyGitMessage(msg, 'sync'), msg);
    if (/401|authentication|authorization|授权/i.test(msg)) throw authFailure(cfg, 'sync', msg);
    throw new GitError('UNKNOWN', friendlyGitMessage(msg, 'sync'), msg);
  }
}

/**
 * 压缩仓库历史：把当前内容做成一个没有父提交的「快照」，强制推上去。
 *
 * Git 的历史只增不减，旧的大文件即使删掉也还留在 .git 里。Gitee 免费仓库只有 500MB，
 * 长期自动提交加上图片附件很容易顶满。这里保留当前完整内容，丢弃远端可见的历史；
 * 本机每篇笔记的 40 份历史快照不受影响，其他设备需要重新下载远端。
 */
export async function compactHistory(cfg: GitConfig, token: string, login: string) {
  await ensureRepo(cfg);
  // 压缩会强制推送、覆盖远端历史。先把另一台设备已经推上来的内容合并进来，
  // 否则它们会在这次强制推送里被直接冲掉（本地历史被重写时 sync 会先抛错拦住）。
  await sync(cfg, token, login, `note: 压缩前同步 ${new Date().toLocaleString('zh-CN', { hour12: false })}`, {
    force: true,
  });
  const onAuth = () => auth(cfg, token, login);
  const oldOid = await git.resolveRef({ fs, dir: ROOT, ref: 'HEAD' }).catch(() => null);

  // 写入新的 epoch：其他设备看到标记不同，就知道历史已经被重写
  await writeText(`${ROOT}/${EPOCH_FILE}`, String(Date.now()));
  await stageAll();

  let oid: string | null = null;
  try {
    oid = await git.commit({
      fs,
      dir: ROOT,
      message: `chore: 压缩仓库历史 ${new Date().toLocaleString('zh-CN', { hour12: false })}`,
      parent: [],
      author: { name: '萤光笔记', email: 'glimnote@local' },
    });
    const res = await git.push({
      fs,
      http: gitHttp,
      dir: ROOT,
      remote: 'origin',
      ref: cfg.branch,
      onAuth,
      force: true,
    });
    if (res.error) throw new Error(String(res.error));
    markCommitDone();
    log('git', 'info', `仓库历史已压缩 · ${oldOid ? oldOid.slice(0, 7) : '无'} → ${oid.slice(0, 7)}`);
    return { oid, oldOid };
  } catch (e: any) {
    // 推送失败就把本地 HEAD 放回去，避免留下「本地是新历史、远端是旧历史」的半截状态
    if (oid && oldOid) {
      await git
        .writeRef({ fs, dir: ROOT, ref: `refs/heads/${cfg.branch}`, value: oldOid, force: true })
        .catch(() => {});
    }
    if (e instanceof GitError) throw e;
    const net = networkFailure(e, cfg.provider, 'sync');
    if (net) throw net;
    const msg = String(e?.message || e);
    if (/401|403|authentication|authorization|权限|授权/i.test(msg)) throw authFailure(cfg, 'sync', msg);
    throw new GitError('UNKNOWN', friendlyGitMessage(msg, 'sync'), msg);
  }
}

/**
 * 令牌没有 workflow 权限时，GitHub 会拒绝任何包含 .github/workflows/ 变更的推送，
 * 云端推送的工作流文件会把整条笔记同步一起卡住。云端推送是可选功能，不能拖累核心功能：
 * 以远端当前提交为父提交，把工作区现状重新提交一次（丢掉尚未上传的自动提交记录），
 * 新提交里已经移除了工作流文件，普通推送就能通过。远端已有的笔记内容不受影响。
 *
 * 调用前必须先关闭云端推送，否则下次同步前的摘要刷新会把工作流文件又写回来。
 */
export async function resyncWithoutWorkflow(
  cfg: GitConfig,
  token: string,
  login: string,
  message: string,
): Promise<SyncResult> {
  await ensureRepo(cfg);
  const onAuth = () => auth(cfg, token, login);
  try {
    await git.fetch({ fs, http: gitHttp, dir: ROOT, remote: 'origin', ref: cfg.branch, singleBranch: true, onAuth });
    const remoteOid = await git
      .resolveRef({ fs, dir: ROOT, ref: `refs/remotes/origin/${cfg.branch}` })
      .catch(() => null);
    if (!remoteOid) {
      throw new GitError('UNKNOWN', '还没能从远端取到可用的基点，请先正常同步一次再试。');
    }
    // 本应用只会在仓库里生成这两个工作流文件，先把它们彻底移出工作区
    for (const filepath of ['.github/workflows/glimnote-push.yml', '.gitcode/workflows/glimnote-push.yml']) {
      await removePath(`${ROOT}/${filepath}`).catch(() => {});
    }
    await stageAll();
    const oid = await git.commit({
      fs,
      dir: ROOT,
      message,
      parent: [remoteOid],
      author: { name: '萤光笔记', email: 'glimnote@local' },
    });
    const res = await git.push({ fs, http: gitHttp, dir: ROOT, remote: 'origin', ref: cfg.branch, onAuth });
    if (res.error) throw new Error(String(res.error));
    markCommitDone();
    // 工作区、暂存区都对齐到新提交，避免还残留旧历史的索引状态
    await git.checkout({ fs, dir: ROOT, ref: cfg.branch, force: true });
    log('git', 'info', `已移除云端推送工作流并重新提交 · ${oid.slice(0, 7)}`);
    return { pulled: 0, pushed: true, commit: oid, conflicts: [] };
  } catch (e: any) {
    if (e instanceof GitError) throw e;
    const net = networkFailure(e, cfg.provider, 'sync');
    if (net) throw net;
    const msg = String(e?.message || e);
    if (WORKFLOW_SCOPE_FAILURE.test(msg)) throw new GitError('AUTH_FORBIDDEN', friendlyGitMessage(msg, 'sync'), msg);
    if (/401|403|authentication|authorization|权限|授权/i.test(msg)) throw authFailure(cfg, 'sync', msg);
    throw new GitError('UNKNOWN', friendlyGitMessage(msg, 'sync'), msg);
  }
}

/**
 * 历史被压缩后，旧设备重新克隆远端。只替换 .git，工作区里的笔记文件保留，
 * 随后 force checkout 把远端版本对齐过来；未推送的本地改动建议先导出 ZIP（界面会做）。
 */
export async function resetFromRemote(cfg: GitConfig, token: string, login: string) {
  await ensureRepo(cfg);
  const tmp = `${ROOT}/.glimnote/reclone`;
  const old = `${ROOT}/.glimnote/git-old`;
  await ensureDir(`${ROOT}/.glimnote`);
  await removePath(tmp).catch(() => {});
  await removePath(old).catch(() => {});

  try {
    await git.clone({
      fs,
      http: gitHttp,
      dir: tmp,
      url: remoteUrl(cfg),
      ref: cfg.branch,
      singleBranch: true,
      depth: 50,
      onAuth: () => auth(cfg, token, login),
      onAuthFailure: () => {
        throw new GitError('AUTH_INVALID', '仓库认证失败，请重新授权');
      },
    });
  } catch (e: any) {
    await removePath(tmp).catch(() => {});
    if (e instanceof GitError) throw e;
    const net = networkFailure(e, cfg.provider, 'sync');
    if (net) throw net;
    const msg = String(e?.message || e);
    if (/401|403|authentication|authorization|授权/i.test(msg)) throw authFailure(cfg, 'sync', msg);
    throw new GitError('UNKNOWN', friendlyGitMessage(msg, 'sync'), msg);
  }

  // 先把旧 .git 换到一边，新 .git 放进去失败时还能换回来
  await renamePath(`${ROOT}/.git`, old);
  try {
    await renamePath(`${tmp}/.git`, `${ROOT}/.git`);
  } catch (e) {
    await renamePath(old, `${ROOT}/.git`).catch(() => {});
    throw new GitError('UNKNOWN', '替换本地 Git 缓存失败，原缓存已恢复。请重试一次。', String(e));
  }
  await removePath(old).catch(() => {});
  await removePath(tmp).catch(() => {});
  localStorage.removeItem(LAST_COMMIT_KEY);

  try {
    await git.checkout({ fs, dir: ROOT, ref: cfg.branch, force: true });
  } catch (e: any) {
    throw new GitError(
      'UNKNOWN',
      '仓库缓存已经重新下载，但工作区对齐失败。请重新打开应用或再点一次「重新下载远端」。',
      String(e?.message || e),
    );
  }
  log('git', 'info', `已重新下载远端仓库 · ${cfg.owner}/${cfg.repo}@${cfg.branch}`);
}
