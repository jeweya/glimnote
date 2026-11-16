/**
 * 系统应用入口在当前电脑上是否还找得到。
 *
 * 入口里存的是绝对路径；换电脑、卸载、改安装目录都会让它失效。
 * 这里把所有路径一次性交给主进程 stat 一遍，得到「未关联」的路径集合，
 * 首页和浮窗据此画标记。浏览器里没有主进程，一律当作已关联，
 * 免得把整屏入口都标成失效。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { desktop } from '../lib/desktop';
import type { HomeEntry } from '../lib/home';

function sameSet(a: Set<string>, b: Set<string>) {
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

export function useSystemAppStatus(entries: Record<string, HomeEntry>) {
  const paths = useMemo(() => {
    const set = new Set<string>();
    for (const entry of Object.values(entries)) {
      if (entry.type === 'system' && entry.target) set.add(entry.target);
    }
    // 排序后当成依赖使用：只是顺序变了不需要重新检查
    return [...set].sort();
  }, [entries]);
  const pathsKey = paths.join('\n');

  const [missing, setMissing] = useState<Set<string>>(() => new Set());
  const [checking, setChecking] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const api = desktop()?.systemAppStatus;
    if (!api || !paths.length) {
      setMissing((prev) => (prev.size ? new Set() : prev));
      return;
    }
    let alive = true;
    setChecking(true);
    void api(paths)
      .then((existing) => {
        if (!alive) return;
        const found = new Set(existing);
        const next = new Set(paths.filter((path) => !found.has(path)));
        setMissing((prev) => (sameSet(prev, next) ? prev : next));
      })
      .catch(() => {
        // 查不了就当作已关联：宁可点开时再提示，也别满屏误标
        if (alive) setMissing((prev) => (prev.size ? new Set() : prev));
      })
      .finally(() => {
        if (alive) setChecking(false);
      });
    return () => {
      alive = false;
    };
    // pathsKey 覆盖 paths 的内容变化；数组引用变了但内容没变时不重复检查
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathsKey, tick]);

  /** 这个入口的目标是否已经不在本机 */
  const missingOf = useCallback(
    (entry: HomeEntry) => entry.type === 'system' && Boolean(entry.target) && missing.has(entry.target || ''),
    [missing],
  );

  /** 手动重新检查（用户刚装好程序、或手动选过之后） */
  const refresh = useCallback(() => setTick((n) => n + 1), []);

  return { missing, missingOf, checking, refresh };
}
