/**
 * 密钥的云端同步（默认关闭）。
 *
 * 默认情况下，七牛 AK/SK 和 AI 的 API Key 只写在本机 localStorage，
 * 换设备就要重新填。开启对应开关后，密钥会明文写进仓库的
 * `.glimnote/keys.json`，跟着 Git 提交同步到其它设备。
 *
 * 开关只控制「要不要上传」：仓库里已有的密钥始终会自动导入本机，
 * 关掉开关不会删除仓库里的内容，也不会阻止接收。
 *
 * 风险由界面负责提示：仓库必须是私有的，而且密钥一旦提交过，
 * 即使后来删掉，旧提交的历史里仍然能翻出来。
 */
import { META_DIR, readText, writeText } from './storage';
import { AI_KEY_AT, loadAiKey, saveAiKey } from './ai';
import { QINIU_CONFIG_AT, readQiniuConfig, saveQiniuConfig, type QiniuConfig } from './qiniu';

export const KEYS_FILE = `${META_DIR}/keys.json`;
const AI_TOGGLE = 'glimnote.ai.keySync';
const QINIU_TOGGLE = 'glimnote.qiniu.keySync';
export const KEY_SYNC_EVENT = 'glimnote:keys-applied';

type Feature = 'ai' | 'qiniu';

interface AiEntry {
  key: string;
  at: string;
}

interface QiniuEntry extends QiniuConfig {
  at: string;
}

interface RemoteKeys {
  v: 1;
  ai?: AiEntry;
  qiniu?: QiniuEntry;
  updatedAt?: string;
}

const toggleKey = (feature: Feature) => (feature === 'ai' ? AI_TOGGLE : QINIU_TOGGLE);
const atKey = (feature: Feature) => (feature === 'ai' ? AI_KEY_AT : QINIU_CONFIG_AT);

export function keySyncEnabled(feature: Feature) {
  return localStorage.getItem(toggleKey(feature)) === '1';
}

export function setKeySyncEnabled(feature: Feature, on: boolean) {
  localStorage.setItem(toggleKey(feature), on ? '1' : '0');
  if (on) {
    // 本机已经有密钥、却没有时间戳时补一个，避免第一次同步被仓库里的旧值盖掉
    const has = feature === 'ai' ? Boolean(loadAiKey()) : Boolean(readQiniuConfig());
    if (has && !localStorage.getItem(atKey(feature))) {
      localStorage.setItem(atKey(feature), new Date().toISOString());
    }
  }
}

function qiniuConfigOf(entry: QiniuEntry | undefined | null): QiniuConfig | null {
  if (!entry) return null;
  const accessKey = String(entry.accessKey ?? '').trim();
  const secretKey = String(entry.secretKey ?? '').trim();
  const bucket = String(entry.bucket ?? '').trim();
  const domain = String(entry.domain ?? '').trim();
  if (!accessKey || !secretKey || !bucket || !domain) return null;
  return { accessKey, secretKey, bucket, domain };
}

function parseRemote(raw: string): RemoteKeys | null {
  try {
    const rec = JSON.parse(raw) as Record<string, unknown>;
    if (!rec || rec.v !== 1) return null;
    const out: RemoteKeys = { v: 1 };
    const ai = rec.ai as Partial<AiEntry> | undefined;
    if (ai && typeof ai.key === 'string' && ai.key.trim() && typeof ai.at === 'string') {
      out.ai = { key: ai.key.trim(), at: ai.at };
    }
    const qiniu = rec.qiniu as Partial<QiniuEntry> | undefined;
    const cfg = qiniuConfigOf(qiniu ? ({ ...qiniu, at: String(qiniu.at ?? '') } as QiniuEntry) : null);
    if (cfg && qiniu && typeof qiniu.at === 'string') {
      out.qiniu = { ...cfg, at: qiniu.at };
    }
    if (typeof rec.updatedAt === 'string') out.updatedAt = rec.updatedAt;
    return out;
  } catch {
    return null;
  }
}

async function readRemote(): Promise<RemoteKeys | null> {
  try {
    return parseRemote(await readText(KEYS_FILE));
  } catch {
    return null;
  }
}

function localAiEntry(): AiEntry | null {
  const key = loadAiKey();
  if (!key) return null;
  return { key, at: localStorage.getItem(AI_KEY_AT) || '' };
}

function localQiniuEntry(): QiniuEntry | null {
  // 开关只管「新文件存哪」，密钥同步按配置本身判断
  const cfg = readQiniuConfig();
  if (!cfg) return null;
  return { ...cfg, at: localStorage.getItem(QINIU_CONFIG_AT) || '' };
}

function sameQiniu(a: QiniuConfig | null, b: QiniuConfig | null) {
  if (!a || !b) return a === b;
  return a.accessKey === b.accessKey && a.secretKey === b.secretKey && a.bucket === b.bucket && a.domain === b.domain;
}

function samePayload(a: RemoteKeys, b: RemoteKeys | null) {
  if (!b) return false;
  const aiSame = (a.ai?.key || '') === (b.ai?.key || '') && (a.ai?.at || '') === (b.ai?.at || '');
  const aq = a.qiniu;
  const bq = b.qiniu;
  const qiniuSame =
    (!aq && !bq) ||
    Boolean(
      aq &&
        bq &&
        aq.at === bq.at &&
        aq.accessKey === bq.accessKey &&
        aq.secretKey === bq.secretKey &&
        aq.bucket === bq.bucket &&
        aq.domain === bq.domain,
    );
  return aiSame && qiniuSame;
}

async function run(): Promise<void> {
  const aiOn = keySyncEnabled('ai');
  const qiniuOn = keySyncEnabled('qiniu');
  const remote = await readRemote();

  let imported = false;

  // 仓库里的记录更新时总是拉回本机，不需要先打开开关；时间相同则以本机为准
  if (remote?.ai && remote.ai.at > (localStorage.getItem(AI_KEY_AT) || '')) {
    if (loadAiKey() !== remote.ai.key) {
      saveAiKey(remote.ai.key);
      imported = true;
    }
  }
  if (remote?.qiniu && remote.qiniu.at > (localStorage.getItem(QINIU_CONFIG_AT) || '')) {
    const cfg = qiniuConfigOf(remote.qiniu);
    if (cfg && !sameQiniu(readQiniuConfig(), cfg)) {
      saveQiniuConfig(cfg);
      imported = true;
    }
  }

  // 开关只决定这项要不要上传；关着时仓库里的旧条目原样保留，不删除
  const ai = aiOn ? localAiEntry() ?? remote?.ai : remote?.ai;
  const qiniu = qiniuOn ? localQiniuEntry() ?? remote?.qiniu : remote?.qiniu;

  const next: RemoteKeys = {
    v: 1,
    ...(ai ? { ai } : {}),
    ...(qiniu ? { qiniu } : {}),
  };

  // 两个开关都关着、仓库里也还没有文件时，不凭空建一个空文件
  if (aiOn || qiniuOn || remote) {
    if (!samePayload(next, remote)) {
      next.updatedAt = new Date().toISOString();
      try {
        await writeText(KEYS_FILE, JSON.stringify(next, null, 2));
      } catch (e) {
        // 写不进去时保留本机密钥；下一次同步再试
        console.warn('write key sync file failed', e);
        return;
      }
    }
  }

  if (imported) window.dispatchEvent(new CustomEvent(KEY_SYNC_EVENT));
}

let running: Promise<void> | null = null;

/** 立即对齐一次仓库与本机的密钥；多次调用复用同一次执行 */
export function syncKeysNow(): Promise<void> {
  if (running) return running;
  running = run().finally(() => {
    running = null;
  });
  return running;
}

/**
 * 用户在设置里主动清除某一项密钥时，把它从仓库文件中移除；另一项仍然保留。
 * 注意：关闭上传开关不会走这里，仓库里的记录会原样保留。
 */
export async function removeSyncedKey(feature: Feature): Promise<void> {
  const remote = await readRemote();
  if (!remote) return;
  const has = feature === 'ai' ? remote.ai : remote.qiniu;
  if (!has) return;
  const next: RemoteKeys = { v: 1, updatedAt: new Date().toISOString() };
  if (feature !== 'ai' && remote.ai) next.ai = remote.ai;
  if (feature !== 'qiniu' && remote.qiniu) next.qiniu = remote.qiniu;
  await writeText(KEYS_FILE, JSON.stringify(next, null, 2));
}

/**
 * 供 Git 合并驱动使用：两台设备同时改过 keys.json 时，按各自的时间戳合成，
 * 而不是生成冲突副本。返回 null 表示不是本模块认识的格式。
 */
export function mergeKeysJson(ours: string, theirs: string): string | null {
  const a = parseRemote(ours);
  const b = parseRemote(theirs);
  if (!a || !b) return null;

  const pickAi = (x?: AiEntry, y?: AiEntry) => {
    if (!x) return y;
    if (!y) return x;
    return y.at > x.at ? y : x;
  };
  const pickQiniu = (x?: QiniuEntry, y?: QiniuEntry) => {
    if (!x) return y;
    if (!y) return x;
    return y.at > x.at ? y : x;
  };

  const ai = pickAi(a.ai, b.ai);
  const qiniu = pickQiniu(a.qiniu, b.qiniu);
  return JSON.stringify(
    { v: 1, ...(ai ? { ai } : {}), ...(qiniu ? { qiniu } : {}), updatedAt: new Date().toISOString() },
    null,
    2,
  );
}
