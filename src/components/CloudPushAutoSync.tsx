import { useEffect, useState } from 'react';
import { useApp } from '../store/app';
import { cachedCloudPushConfig, readCloudPushConfig, type CloudPushConfig } from '../lib/cloudPush';
import { log } from '../lib/log';

/** 北京时间固定 UTC+8，不用跟随系统时区 */
const UTC_OFFSET = 8 * 3600 * 1000;
/** 推送前 10 分钟、2 分钟各同步一次：第一次赶在流水线启动前，第二次捡起这期间的改动 */
const LEADS = [10 * 60 * 1000, 2 * 60 * 1000];

/** 下一次「每天 N 点」的 UTC 毫秒（按北京时间） */
function nextPushAt(now: number, time: string) {
  const [hh, mm] = time.split(':').map((n) => Number(n));
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return 0;
  const sh = new Date(now + UTC_OFFSET);
  let target =
    Date.UTC(sh.getUTCFullYear(), sh.getUTCMonth(), sh.getUTCDate(), hh, mm) - UTC_OFFSET;
  if (target <= now) target += 86400 * 1000;
  return target;
}

/**
 * 云端推送前的自动同步。
 *
 * 每日摘要来自仓库里的 digest.json，只有同步上传后云端才看得到。
 * 推送前强制同步一次，可以把已完成、已删除、改过日期的任务从摘要里刷掉，
 * 避免「早上已经做完了，8 点云端还在提醒」。
 *
 * 只在主窗口挂载；应用没开、锁屏、断网或睡眠时不会执行，
 * 这时云端就按最后一次成功同步的状态推送，属于已知限制。
 */
export function CloudPushAutoSync() {
  const gitCfg = useApp((s) => s.cfg);
  const token = useApp((s) => s.token);
  const [cloud, setCloud] = useState<CloudPushConfig>(() => cachedCloudPushConfig());

  useEffect(() => {
    void readCloudPushConfig().catch(() => {});
    const onCfg = () => setCloud(cachedCloudPushConfig());
    window.addEventListener('glimnote:cloud-push-changed', onCfg);
    return () => window.removeEventListener('glimnote:cloud-push-changed', onCfg);
  }, []);

  useEffect(() => {
    // 云端推送只支持 GitHub；其他平台即使留着旧配置也不再定时同步
    if (!gitCfg || gitCfg.provider !== 'github' || !token || !cloud.enabled) return;
    let timer = 0;
    let stopped = false;

    const schedule = () => {
      if (stopped) return;
      const now = Date.now();
      const pushAt = nextPushAt(now, cloud.time);
      if (!pushAt) return;
      // 已经错过今天的前两个点就排到明天；不要把睡眠唤醒后的补同步也算进去
      const points = LEADS.map((lead) => pushAt - lead).filter((at) => at > now + 500);
      const at = points[0] ?? nextPushAt(pushAt + 1000, cloud.time) - LEADS[0];

      timer = window.setTimeout(async () => {
        if (stopped) return;
        // 睡过头、已经过了推送时间：今天再同步也赶不上这次流水线，直接排下一天
        if (Date.now() <= pushAt && !useApp.getState().locked) {
          try {
            log('sync', 'info', '云端推送前自动同步');
            await useApp.getState().syncNow(true);
          } catch (e) {
            log('sync', 'warn', `云端推送前自动同步失败：${(e as Error).message || '未知原因'}`);
          }
        }
        schedule();
      }, Math.max(1000, at - now));
    };

    schedule();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [gitCfg, token, cloud.enabled, cloud.time]);

  return null;
}
