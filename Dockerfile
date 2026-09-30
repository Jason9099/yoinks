# yoinks 网页版 Docker 镜像
FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist

# 运行配置（均可用环境变量覆盖）
ENV PORT=3000 \
    HOST=0.0.0.0
# 公网部署务必设置访问密码：
# ENV YOINKS_PASSWORD=your-secret-password

EXPOSE 3000
CMD ["node", "dist/web/server.js"]
