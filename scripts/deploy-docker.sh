#!/usr/bin/env bash
# Do_Bi 一键部署（Docker Compose）
#
#   ./scripts/deploy-docker.sh          启动 / 更新（构建镜像并后台运行）
#   ./scripts/deploy-docker.sh logs     跟踪日志
#   ./scripts/deploy-docker.sh down     停止并移除容器
#
# 前置：本机已安装 Docker（含 docker compose v2）。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if ! command -v docker >/dev/null 2>&1; then
  echo "错误：未找到 docker。请先安装 Docker Desktop（macOS/Windows）或 Docker Engine（Linux）。" >&2
  exit 1
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "错误：未找到 docker compose（v2）。旧版 docker-compose 不受支持。" >&2
  exit 1
fi

# server/.env 是后端唯一读取密钥的位置；首次部署从模板生成，避免被挂成目录
if [ ! -f server/.env ]; then
  cp server/.env.example server/.env
  echo "已生成 server/.env（来自 .env.example）"
  echo "  → 填入至少一个模型密钥后，生成类接口才可用：$ROOT/server/.env"
  echo "  → 也可以启动后在「设置 → 模型服务」页面里填写。"
fi

PORT="${DOBI_WEB_PORT:-8080}"

case "${1:-up}" in
  up)
    docker compose up -d --build
    echo
    echo "已启动。访问： http://localhost:${PORT}"
    echo "跟踪日志： $0 logs"
    echo "停止服务： $0 down"
    ;;
  logs)
    docker compose logs -f
    ;;
  down)
    docker compose down
    ;;
  *)
    echo "用法： $0 [up|logs|down]" >&2
    exit 1
    ;;
esac
