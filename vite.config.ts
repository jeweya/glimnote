import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import pkg from './package.json';

export default defineConfig({
  // 相对路径：同一份 dist 既能部署到网页根路径，也能被 Electron 以 file:// 加载
  base: './',
  plugins: [react()],
  // 版本号只认 package.json：关于面板、诊断信息都从这里取，发版时不用再改代码
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  // 端口固定 5174：被占用时直接报错而不是悄悄换端口，免得 Electron 的 wait-on 等错地方
  server: { port: 5174, host: true, strictPort: true },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return undefined;
          // prettier 只在点「格式化」时才用到：返回 undefined 让 Rollup 保持动态 import 的分块，
          // 否则会被并进 vendor，一打开笔记就多下载 1MB 多
          if (/node_modules\/prettier\//.test(id)) return undefined;
          if (/node_modules\/(react|react-dom|scheduler)\//.test(id)) return 'react';
          if (id.includes('@codemirror') || id.includes('@lezer')) return 'editor';
          if (id.includes('isomorphic-git') || id.includes('lightning-fs')) return 'git';
          // 必须锚定在 node_modules/marked/ 上：lucide 的 book-marked.js 路径里也含
          // "marked"，被误分进 markdown 块会让 vendor 与 markdown 互相 import，
          // 生产包启动时直接报 "Cannot access 'createLucideIcon' before initialization"
          if (/node_modules\/(marked|dompurify)\//.test(id)) return 'markdown';
          return 'vendor';
        },
      },
    },
  },
  // lightning-fs 的入口是 CJS（module 字段指向 src/index.js，没有默认导出），
  // 必须让 Vite 预打包成 ESM，否则 `npm run dev` 会报 "does not provide an export named 'default'"。
  optimizeDeps: { include: ['@isomorphic-git/lightning-fs'] },
});
