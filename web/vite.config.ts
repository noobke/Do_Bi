import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// base: '/' —— 构建产物用绝对路径引用资源。
//   应用用的是 BrowserRouter（存在 /chapter/:n 这类深链）：若用相对路径 './'，
//   在 /chapter/3 上直接打开或刷新会把资源解析到 /chapter/assets/… 而 404 白屏。
//   Capacitor 以 https://localhost/ 为源提供页面，绝对路径同样正确。
//
// 说明：后端不再是 FastAPI 服务，而是同包内的本地核心（src/api/core/*），
//   请求经 client.ts 直接分发到内存/浏览器存储，因此不再需要 dev proxy。
export default defineConfig({
  base: '/',
  plugins: [react()],
})
