import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// base: '/' —— 构建产物用绝对路径引用资源。
//   应用用的是 BrowserRouter（存在 /chapter/:n 这类深链）：若用相对路径 './'，
//   在 /chapter/3 上直接打开或刷新会把资源解析到 /chapter/assets/… 而 404 白屏。
//   所以生产构建必须是绝对根路径（由 nginx 托管在站点根目录）。
// server.proxy  —— 开发时把 /api 转发到本地 FastAPI 后端，前端无需处理 CORS
// preview.proxy —— 一键本机部署（scripts/deploy-local.sh）复用同一转发规则
const API_TARGET = 'http://127.0.0.1:8000'

export default defineConfig({
  base: '/',
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: API_TARGET,
        changeOrigin: true,
      },
    },
  },
  preview: {
    proxy: {
      '/api': {
        target: API_TARGET,
        changeOrigin: true,
      },
    },
  },
})
