FROM node:18-alpine

WORKDIR /app

# 安装依赖
COPY package*.json ./
RUN npm ci --only=production && npm cache clean --force

# 复制应用代码
COPY . .

# 创建上传目录
RUN mkdir -p uploads

# 暴露端口（与 server.js 默认 PORT=3000 及 render.yaml 对齐）
EXPOSE 3000

# 启动应用
CMD ["node", "server.js"]
