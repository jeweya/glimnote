import { Buffer as NodeBuffer } from 'buffer';

/**
 * isomorphic-git 的浏览器构建直接引用全局 Buffer：
 * pkt-line、packfile、sha1 包装、index 读写都在用 `Buffer.from / Buffer.alloc / Buffer.concat`。
 * Vite 不会像 webpack 4 那样自动注入 Node 全局变量，所以第一次真正读写 Git 对象时就会抛
 * 「Buffer is not defined」，被上层统一包装成「客户端内部出错了，和令牌、仓库都无关」。
 *
 * 这里在应用入口最先执行，把 buffer 包的实现挂到 globalThis。
 * 若运行环境本身已提供（Node / 未来 Electron 注入），保持原样不覆盖。
 */
if (typeof (globalThis as { Buffer?: unknown }).Buffer === 'undefined') {
  (globalThis as { Buffer?: unknown }).Buffer = NodeBuffer;
}
