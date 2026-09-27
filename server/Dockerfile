# syntax=docker/dockerfile:1
# 后端镜像：**只出 API，不做静态托管**（见 dobi/main.py 顶部说明）。
# 前端由 web 容器（nginx）托管，并把 /api 同源反代到本服务的 8000 端口。

FROM python:3.12-slim

# uv：官方静态二进制，装依赖比 pip 快很多
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/

ENV PYTHONUNBUFFERED=1 \
    UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/app/.venv \
    PATH=/app/.venv/bin:$PATH

WORKDIR /app

# 先只装依赖：改动业务代码时不必重装，充分利用层缓存
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

COPY dobi ./dobi
COPY config ./config
RUN uv sync --frozen --no-dev

EXPOSE 8000

# 容器内必须监听 0.0.0.0；.env 里的 DOBI_HOST=127.0.0.1 只适合本机直跑
CMD ["dobi", "serve", "--host", "0.0.0.0", "--port", "8000"]
