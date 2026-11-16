import { mimeOf } from '../assets';
import { readBinary } from '../storage';

/**
 * 编辑器里的本地图片不能直接用仓库路径当 src：
 * `/repo/...` 在网页端是 404，在 Electron 的 file:// 下也指不到仓库。
 * 旧版 CodeMirror 预览就是读二进制再换成 blob URL 显示的，这里把同一套做法
 * 抽出来给 TipTap 用：同一张图在一次会话里只读一次、只建一个 URL。
 */
const urls = new Map<string, string>();
const loading = new Map<string, Promise<string | null>>();

/** 已经解析好的图片地址（渲染 HTML 时同步取，避免先画一个裂图） */
export function cachedAssetUrl(abs: string): string | null {
  return urls.get(abs) || null;
}

/** 读取仓库内的图片并生成 blob URL；失败（附件缺失）返回 null */
export function loadAssetUrl(abs: string): Promise<string | null> {
  const cached = urls.get(abs);
  if (cached) return Promise.resolve(cached);
  const running = loading.get(abs);
  if (running) return running;

  const task = (async () => {
    try {
      const bytes = await readBinary(abs);
      const url = URL.createObjectURL(new Blob([bytes.slice().buffer as ArrayBuffer], { type: mimeOf(abs) }));
      urls.set(abs, url);
      return url;
    } catch {
      return null;
    } finally {
      loading.delete(abs);
    }
  })();
  loading.set(abs, task);
  return task;
}

/**
 * 把编辑区里还没取到地址的图片补上 src。
 * 图片节点先渲染成 `<img data-glimnote-asset="仓库绝对路径">`（没有 src，
 * 不会先闪一下裂图），这里异步换成 blob URL。
 */
export async function hydrateAssetImages(root: ParentNode): Promise<void> {
  const images = Array.from(root.querySelectorAll<HTMLImageElement>('img[data-glimnote-asset]'));
  await Promise.all(
    images.map(async (img) => {
      const abs = img.getAttribute('data-glimnote-asset');
      if (!abs || img.classList.contains('broken')) return;
      const url = cachedAssetUrl(abs) || (await loadAssetUrl(abs));
      if (!img.isConnected) return;
      if (url) {
        img.src = url;
        img.removeAttribute('data-glimnote-asset');
      } else {
        // 附件真的不在仓库里：标记一下，避免每次输入都重读一遍
        img.classList.add('broken');
        img.alt = `${img.alt || '图片'}（附件缺失）`;
      }
    }),
  );
}
