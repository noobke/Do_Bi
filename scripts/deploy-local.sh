#!/usr/bin/env bash
# Do_Bi 一键部署（本机原生，不需要 Docker）
#
#   ./scripts/deploy-local.sh
#
# 做什么：装后端依赖 → 装前端依赖 → 构建前端 → 启动后端 → 用 Vite preview
# 托管 dist 并把 /api 同源反代到后端（规则见 web/vite.config.ts 的 preview.proxy）。
# 前端：http://127.0.0.1:4173   后端健康检查：http://127.0.0.1:8000/api/health
# 按 Ctrl+C 同时停止前后端。
#
# 前置：本机已安装 uv（Python 包管理器）、Node.js 18+ 与 npm。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "错误：未找到 $1。$2" >&2
    exit 1
  }
}
need uv "安装： curl -LsSf https://astral.sh/uv/install.sh | sh"
need npm "安装： https://nodejs.org（Node 18+）"
need curl "一般系统自带；缺失请先安装 curl"

if [ ! -f server/.env ]; then
  cp server/.env.example server/.env
  echo "已生成 server/.env（来自 .env.example）"
  echo "  → 填入至少一个模型密钥后，生成类接口才可用：$ROOT/server/.env"
fi

API_PORT=8000
WEB_PORT="${DOBI_WEB_PORT:-4173}"

echo "[1/4] 安装后端依赖…"
(cd server && uv sync)

echo "[2/4] 安装前端依赖…"
(cd web && npm ci)

echo "[3/4] 构建前端…"
(cd web && npm run build)

echo "[4/4] 启动后端…"
cleanup() {
  if [ -n "${API_PID:-}" ] && kill -0 "$API_PID" 2>/dev/null; then
    kill "$API_PID" 2>/dev/null || true
    wait "$API_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

(cd server && uv run dobi serve --host 127.0.0.1 --port "$API_PORT") &
API_PID=$!

# 等后端起来再放行前端，避免首屏 /api 全 502。
# 先判进程存活再看健康检查：端口被别的进程占用时后端会立刻退出，
# 若反过来先查健康检查，会被那个「别人家的 8000」误导而继续启动。
READY=0
for _ in $(seq 1 40); do
  if ! kill -0 "$API_PID" 2>/dev/null; then
    echo "错误：后端进程已退出（端口 ${API_PORT} 可能已被占用）。请检查上面的日志。" >&2
    exit 1
  fi
  if curl -fsS "http://127.0.0.1:${API_PORT}/api/health" >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 0.5
done
if [ "$READY" -ne 1 ]; then
  echo "错误：等待后端就绪超时（http://127.0.0.1:${API_PORT}/api/health）。" >&2
  exit 1
fi

echo
echo "后端： http://127.0.0.1:${API_PORT}/api/health"
echo "前端： http://127.0.0.1:${WEB_PORT}"
echo "按 Ctrl+C 停止（会同时结束后端）。"
echo

cd web && npm run preview -- --host 127.0.0.1 --port "$WEB_PORT"
