# syntax=docker/dockerfile:1
# 前端镜像：多阶段构建 —— Node 出 dist，再由 nginx 托管并把 /api 同源反代到后端容器。

FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
