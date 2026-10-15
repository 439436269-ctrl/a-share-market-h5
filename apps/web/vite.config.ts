import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

const resolvePath = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // 直接指向源码：workspace 包免构建，改共享层代码 Vite 立即热更
      '@stock/market-core': resolvePath('../../packages/market-core/src/index.ts'),
      '@stock/market-client': resolvePath('../../packages/market-client/src/index.ts'),
      '@': resolvePath('./src'),
    },
  },
  optimizeDeps: {
    exclude: ['@stock/market-core', '@stock/market-client'],
  },
  server: {
    port: 5173,
    host: true,
    // /api 与 /ws 都代理到 BFF —— 同源之后前端不需要任何 CORS 配置
    proxy: {
      '/api': { target: 'http://localhost:8787', changeOrigin: true },
      '/ws': { target: 'ws://localhost:8787', ws: true },
    },
  },
  // 打包后预览同样需要代理，否则 preview 模式下 API 会 404
  preview: {
    port: 4173,
    proxy: {
      '/api': { target: 'http://localhost:8787', changeOrigin: true },
      '/ws': { target: 'ws://localhost:8787', ws: true },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
