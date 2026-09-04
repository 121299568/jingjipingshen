# 经济评审管理系统 - Docker 一键部署

## 简介

本项目使用 Docker Compose 一键部署，无需手动安装 Node.js、MySQL 等环境。

## 系统要求

- Docker Desktop (Windows/Mac) 或 Docker Engine (Linux)
- 至少 4GB 内存
- 至少 10GB 磁盘空间

## 快速开始

### 步骤 1: 克隆项目
```bash
git clone https://github.com/121299568/jingjipingshen.git
cd jingjipingshen
```

### 步骤 2: 启动服务
```bash
docker-compose up -d
```

### 步骤 3: 访问系统
- 前端界面: http://localhost:3000
- API 文档: http://localhost:3001/api/docs
- 数据库管理: http://localhost:8080 (phpMyAdmin)

默认账号: admin / admin123

---

## 目录结构

```
jingjipingshen/
├── docker-compose.yml      # Docker 编排文件
├── backend/                # 后端服务
│   ├── Dockerfile          # 后端容器配置
│   ├── server.js           # Express 应用
│   └── package.json        # Node.js 依赖
├── frontend/              # 前端应用
│   ├── Dockerfile          # 前端容器配置
│   ├── index.html          # 主页面
│   └── app.js             # JavaScript 逻辑
├── mysql/                 # MySQL 数据持久化
│   └── data/              # 数据文件目录
└── redis/                 # Redis 数据持久化
    └── data/              # 数据文件目录
```

---

## Docker Compose 配置详解

### 服务列表

| 服务名 | 端口 | 说明 |
|--------|------|------|
| web | 3000 | 前端静态服务器 |
| api | 3001 | 后端 API 服务 |
| mysql | 3306 | MySQL 数据库 |
| redis | 6379 | Redis 缓存 |
| phpmyadmin | 8080 | 数据库管理界面 |

### 环境变量

创建 `.env` 文件：
```env
# MySQL 配置
MYSQL_ROOT_PASSWORD=RootPass123!
MYSQL_DATABASE=economic_review
MYSQL_USER=review_user
MYSQL_PASSWORD=ReviewPass123!

# Redis 配置
REDIS_PASSWORD=RedisPass123!

# JWT 配置
JWT_SECRET=your-secret-key-change-in-production
JWT_EXPIRES_IN=7d

# 应用配置
NODE_ENV=production
API_PORT=3001
FRONTEND_PORT=3000
```

---

## 本地开发模式

### 方式一：使用 Docker（推荐）

```bash
# 启动所有服务
docker-compose up -d

# 查看日志
docker-compose logs -f api

# 停止服务
docker-compose down

# 重启服务
docker-compose restart
```

### 方式二：本地开发（需要安装 Node.js）

#### 后端开发
```bash
cd backend
npm install
npm run dev
```

#### 前端开发
```bash
cd frontend
npm install
npm run dev
```

---

## 数据库初始化

### 首次启动
Docker Compose 会自动执行数据库初始化脚本。

### 手动导入（如需重置）
```bash
# 进入 MySQL 容器
docker exec -it jingjipingshen-mysql-1 mysql -u root -p

# 导入 SQL
source /docker-entrypoint-initdb.d/db.sql;
```

### 备份数据库
```bash
# 备份
docker exec jingjipingshen-mysql-1 mysqldump -u root -p economic_review > backup_$(date +%Y%m%d).sql

# 恢复
cat backup_20240101.sql | docker exec -i jingjipingshen-mysql-1 mysql -u root -p economic_review
```

---

## 常用命令

### 查看服务状态
```bash
docker-compose ps
```

### 查看实时日志
```bash
docker-compose logs -f
```

### 进入容器 shell
```bash
# 进入后端容器
docker exec -it jingjipingshen-api-1 sh

# 进入 MySQL 容器
docker exec -it jingjipingshen-mysql-1 bash
```

### 清理资源
```bash
# 停止并删除容器
docker-compose down

# 删除数据卷（谨慎使用！）
docker-compose down -v
```

---

## 生产环境部署

### 1. 修改环境变量
编辑 `docker-compose.yml`，将开发配置改为生产配置：
- 关闭调试模式
- 启用 HTTPS
- 设置强密码
- 配置域名

### 2. 使用 SSL 证书
```yaml
services:
  nginx:
    image: nginx:latest
    ports:
      - "443:443"
    volumes:
      - ./certbot/conf:/etc/letsencrypt
      - ./certbot/www:/var/www/certbot
```

### 3. 配置反向代理
```nginx
server {
    listen 443 ssl;
    server_name your-domain.com;
    
    ssl_certificate /etc/letsencrypt/live/your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;
    
    location / {
        proxy_pass http://web:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
    
    location /api {
        proxy_pass http://api:3001;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

---

## 故障排查

### Q1: 容器启动失败
```bash
# 查看日志
docker-compose logs api
docker-compose logs mysql

# 检查端口占用
netstat -ano | findstr :3001
netstat -ano | findstr :3306
```

### Q2: 数据库连接失败
```bash
# 检查 MySQL 是否就绪
docker exec jingjipingshen-mysql-1 mysql -u root -p -e "SHOW DATABASES;"

# 检查环境变量
docker-compose config
```

### Q3: API 返回 500 错误
```bash
# 查看后端日志
docker-compose logs -f api

# 检查数据库连接
docker exec jingjipingshen-api-1 node -e "console.log(process.env.DATABASE_URL)"
```

### Q4: 前端无法访问 API
```bash
# 检查 CORS 配置
# 确保后端 server.js 中启用了 cors()
app.use(cors({
  origin: 'http://localhost:3000',
  credentials: true
}));
```

---

## 性能调优

### MySQL 优化
在 `mysql/my.cnf` 中添加：
```ini
[mysqld]
innodb_buffer_pool_size = 1G
query_cache_size = 64M
max_connections = 200
```

### Redis 优化
在 `redis/redis.conf` 中添加：
```conf
maxmemory 512mb
maxmemory-policy allkeys-lru
```

### Node.js 优化
```javascript
// 启用集群模式
const cluster = require('cluster');
const numCPUs = require('os').cpus().length;

if (cluster.isPrimary) {
  for (let i = 0; i < numCPUs; i++) {
    cluster.fork();
  }
} else {
  require('./server');
}
```

---

## 监控与维护

### 健康检查
```yaml
services:
  api:
    healthcheck:
      test: ["CMD", "wget", "--quiet", "--tries=1", "--spider", "http://localhost:3001/health"]
      interval: 30s
      timeout: 10s
      retries: 3
```

### 日志轮转
```yaml
services:
  api:
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"
```

### 自动备份
```yaml
services:
  backup:
    image: mysql:8.0
    cron: "0 2 * * *"
    command: mysqldump -h mysql -u root -p${MYSQL_ROOT_PASSWORD} economic_review > /backup/backup_$(date +\%Y\%m\%d).sql
    volumes:
      - ./backups:/backup
```

---

## 版本升级

### 更新代码
```bash
git pull origin main
docker-compose down
docker-compose build --no-cache
docker-compose up -d
```

### 数据库迁移
```bash
# 备份当前数据
docker exec jingjipingshen-mysql-1 mysqldump -u root -p economic_review > backup_before_upgrade.sql

# 执行迁移脚本
docker exec -i jingjipingshen-mysql-1 mysql -u root -p economic_review < migrations/v2.sql
```

---

## 联系支持

- GitHub Issues: https://github.com/121299568/jingjipingshen/issues
- 邮箱: support@example.com
