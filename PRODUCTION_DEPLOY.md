# 经济评审管理系统 - 生产环境部署指南

## 一、服务器要求

### 最低配置
- **CPU**: 2核
- **内存**: 4GB
- **磁盘**: 20GB SSD
- **操作系统**: Ubuntu 20.04 LTS / CentOS 8+ / Debian 11+

### 推荐配置
- **CPU**: 4核
- **内存**: 8GB
- **磁盘**: 50GB SSD
- **操作系统**: Ubuntu 22.04 LTS

---

## 二、环境准备（服务器端）

### 1. 安装 Node.js
```bash
# Ubuntu/Debian
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# CentOS/RHEL
curl -fsSL https://rpm.nodesource.com/setup_18.x | sudo bash -
sudo yum install -y nodejs

# 验证安装
node --version   # v18.x.x
npm --version    # 9.x.x
```

### 2. 安装 MySQL 8.0
```bash
# Ubuntu/Debian
sudo apt update
sudo apt install mysql-server -y

# CentOS/RHEL
sudo yum install -y mysql-server
sudo systemctl start mysqld
sudo systemctl enable mysqld

# 安全初始化
sudo mysql_secure_installation
```

### 3. 安装 Nginx
```bash
sudo apt install nginx -y    # Ubuntu/Debian
sudo yum install nginx -y    # CentOS/RHEL

sudo systemctl start nginx
sudo systemctl enable nginx
```

### 4. 安装 PM2（进程管理器）
```bash
sudo npm install -g pm2
pm2 --version
```

### 5. 安装 Git
```bash
sudo apt install git -y    # Ubuntu/Debian
sudo yum install git -y    # CentOS/RHEL
```

### 6. 配置防火墙
```bash
# Ubuntu/Debian (UFW)
sudo ufw allow 22/tcp    # SSH
sudo ufw allow 80/tcp    # HTTP
sudo ufw allow 443/tcp   # HTTPS
sudo ufw enable

# CentOS/RHEL (firewalld)
sudo firewall-cmd --permanent --add-service=ssh
sudo firewall-cmd --permanent --add-service=http
sudo firewall-cmd --permanent --add-service=https
sudo firewall-cmd --reload
```

---

## 三、数据库配置

### 1. 登录 MySQL 并创建数据库
```bash
sudo mysql -u root -p
```

```sql
-- 创建数据库
CREATE DATABASE economic_review CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 创建应用用户（不要使用root）
CREATE USER 'review_app'@'localhost' IDENTIFIED BY 'YourStrongPassword123!';

-- 授权
GRANT ALL PRIVILEGES ON economic_review.* TO 'review_app'@'localhost';
FLUSH PRIVILEGES;
EXIT;
```

### 2. 导入表结构
```bash
mysql -u review_app -p economic_review < backend/db.sql
```

### 3. 验证数据
```bash
mysql -u review_app -p economic_review -e "SHOW TABLES;"
mysql -u review_app -p economic_review -e "SELECT username, role FROM users;"
```

---

## 四、代码修改（添加MySQL支持）

### 1. 安装MySQL驱动和相关依赖
```bash
cd backend
npm install mysql2 bcryptjs dotenv jsonwebtoken
npm install -D nodemon
```

### 2. 创建环境变量配置文件
```bash
cp .env.example .env
nano .env
```

编辑 `.env` 文件，填入实际配置：
```env
# 服务器配置
NODE_ENV=production
PORT=3000

# 数据库配置
DB_HOST=localhost
DB_PORT=3306
DB_USER=review_app
DB_PASSWORD=YourStrongPassword123!
DB_NAME=economic_review

# JWT配置
JWT_SECRET=your-production-secret-key-change-this-immediately
JWT_EXPIRES_IN=7d

# 文件上传配置
UPLOAD_DIR=/var/www/jingjipingshen/uploads
MAX_FILE_SIZE=52428800

# 前端地址（用于CORS）
FRONTEND_URL=https://your-domain.com
```

### 3. 修改 server.js（核心改动）

**步骤A：添加MySQL连接配置**

在 `server.js` 头部添加：
```javascript
require('dotenv').config();
const mysql = require('mysql2/promise');

// 创建连接池
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  charset: 'utf8mb4'
});

// 测试数据库连接
async function testDbConnection() {
  try {
    const connection = await pool.getConnection();
    console.log('✓ MySQL数据库连接成功');
    connection.release();
  } catch (error) {
    console.error('✗ MySQL数据库连接失败:', error.message);
    process.exit(1);
  }
}
testDbConnection();
```

**步骤B：替换数据访问层**

将所有 `store.xxx` 的内存操作改为数据库查询。例如：

```javascript
// 原代码：const projects = filterByDept(store, 'projects', user);
// 新代码：
const [projects] = await pool.execute(
  'SELECT * FROM projects WHERE biz_department = ? ORDER BY created_at DESC',
  [user.business_dept]
);
```

**关键API改造示例：**

```javascript
// 用户登录
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  
  try {
    // 查询用户
    const [users] = await pool.execute(
      'SELECT * FROM users WHERE username = ? AND is_active = TRUE',
      [username]
    );
    
    if (users.length === 0) {
      return res.status(401).json({ error: '用户名或密码错误' });
    }
    
    const user = users[0];
    
    // 验证密码
    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(401).json({ error: '用户名或密码错误' });
    }
    
    // 生成JWT
    const token = signToken(user);
    
    res.json({ token, user });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 获取项目列表
app.get('/api/projects', auth(), async (req, res) => {
  try {
    const user = req.user;
    let sql = 'SELECT * FROM projects WHERE 1=1';
    const params = [];
    
    // 非管理员只能看本事业部
    if (user.role !== 'admin') {
      sql += ' AND biz_department = ?';
      params.push(user.business_dept);
    }
    
    sql += ' ORDER BY created_at DESC';
    
    const [projects] = await pool.execute(sql, params);
    res.json(projects);
  } catch (error) {
    console.error('Get projects error:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});
```

**步骤C：封装数据库工具模块**

新建 `backend/db.js`：
```javascript
const mysql = require('mysql2/promise');
require('dotenv').config();

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  charset: 'utf8mb4'
});

module.exports = {
  query: async (sql, params = []) => {
    const [results] = await pool.execute(sql, params);
    return results;
  },
  getOne: async (sql, params = []) => {
    const results = await pool.execute(sql, params);
    return results[0] || null;
  },
  insert: async (sql, params = []) => {
    const [result] = await pool.execute(sql, params);
    return result.insertId;
  },
  update: async (sql, params = []) => {
    const [result] = await pool.execute(sql, params);
    return result.affectedRows;
  },
  delete: async (sql, params = []) => {
    const [result] = await pool.execute(sql, params);
    return result.affectedRows;
  }
};
```

### 4. 更新 package.json
```json
{
  "dependencies": {
    "express": "^4.18.2",
    "cors": "^2.8.5",
    "multer": "^1.4.5-lts.1",
    "xlsx": "^0.18.5",
    "jsonwebtoken": "^9.0.0",
    "bcryptjs": "^2.4.3",
    "mysql2": "^3.6.0",
    "dotenv": "^16.3.1",
    "archiver": "^5.3.1"
  },
  "scripts": {
    "start": "node server.js",
    "dev": "nodemon server.js"
  },
  "devDependencies": {
    "nodemon": "^3.0.1"
  }
}
```

---

## 五、迁移现有数据

### 运行迁移脚本
```bash
cd backend
node migrate.js
```

迁移脚本会：
1. 读取 `data/store.json` 中的现有数据
2. 插入到MySQL数据库中
3. 处理重复数据的冲突

### 验证迁移结果
```bash
mysql -u review_app -p economic_review -e "
SELECT COUNT(*) as users FROM users;
SELECT COUNT(*) as projects FROM projects;
SELECT COUNT(*) as sessions FROM review_sessions;
SELECT COUNT(*) as files FROM project_files;
"
```

---

## 六、部署步骤

### 1. 上传代码到服务器
```bash
# 方式一：Git克隆（推荐）
git clone https://github.com/121299568/jingjipingshen.git
cd jingjipingshen

# 方式二：SCP上传
scp -r backend/ frontend/ user@server:/var/www/jingjipingshen/
```

### 2. 安装依赖
```bash
cd backend
npm install --production
```

### 3. 创建目录结构
```bash
sudo mkdir -p /var/www/jingjipingshen/uploads
sudo chown -R $USER:$USER /var/www/jingjipingshen
```

### 4. 配置环境变量
```bash
cp .env.example .env
nano .env  # 编辑配置
```

### 5. 启动服务
```bash
# 使用PM2启动
pm2 start server.js --name jingjipingshen-api

# 查看状态
pm2 status

# 查看日志
pm2 logs jingjipingshen-api

# 设置开机自启
pm2 save
pm2 startup
```

---

## 七、Nginx反向代理配置

### 1. 创建Nginx配置文件
```bash
sudo nano /etc/nginx/sites-available/jingjipingshen
```

配置内容：
```nginx
server {
    listen 80;
    server_name your-domain.com www.your-domain.com;
    
    # 重定向到HTTPS
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name your-domain.com www.your-domain.com;
    
    # SSL证书路径（使用Let's Encrypt）
    ssl_certificate /etc/letsencrypt/live/your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;
    
    # 根目录
    root /var/www/jingjipingshen/frontend;
    index index.html;
    
    # 静态文件缓存
    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }
    
    # 前端路由（SPA支持）
    location / {
        try_files $uri $uri/ /index.html;
    }
    
    # API代理
    location /api {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        
        # 超时设置
        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
    }
    
    # 文件上传
    location /uploads {
        alias /var/www/jingjipingshen/backend/uploads;
        expires 30d;
        add_header Cache-Control "public";
    }
    
    # 文件大小限制
    client_max_body_size 50M;
    
    # Gzip压缩
    gzip on;
    gzip_vary on;
    gzip_min_length 1024;
    gzip_types text/plain text/css text/xml text/javascript application/x-javascript application/xml+rss application/json;
    
    # 安全头
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
}
```

### 2. 启用配置
```bash
sudo ln -s /etc/nginx/sites-available/jingjipingshen /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx
```

---

## 八、SSL证书配置（Let's Encrypt）

### 1. 安装Certbot
```bash
sudo apt install certbot python3-certbot-nginx -y    # Ubuntu/Debian
sudo yum install certbot python3-certbot-nginx -y    # CentOS/RHEL
```

### 2. 获取证书
```bash
sudo certbot --nginx -d your-domain.com -d www.your-domain.com
```

### 3. 自动续期
```bash
# 测试续期
sudo certbot renew --dry-run

# Certbot会自动添加定时任务
sudo crontab -l | grep certbot
```

---

## 九、备份策略

### 1. 数据库备份脚本
创建 `/usr/local/bin/backup-db.sh`：
```bash
#!/bin/bash
DATE=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR="/var/backups/mysql"
DB_NAME="economic_review"
DB_USER="review_app"
DB_PASS="YourStrongPassword123!"

mkdir -p $BACKUP_DIR
mysqldump -u $DB_USER -p$DB_PASS $DB_NAME > $BACKUP_DIR/$DB_NAME_$DATE.sql
find $BACKUP_DIR -name "*.sql" -mtime +30 -delete  # 保留30天
```

执行：
```bash
sudo chmod +x /usr/local/bin/backup-db.sh
echo "0 2 * * * /usr/local/bin/backup-db.sh" | crontab -
```

### 2. 文件备份
```bash
# 备份上传文件
tar -czf /var/backups/uploads_$(date +%Y%m%d).tar.gz /var/www/jingjipingshen/uploads
```

---

## 十、监控与维护

### 1. PM2监控
```bash
# 查看实时监控
pm2 monit

# 查看内存使用
pm2 show jingjipingshen-api

# 查看系统资源
pm2 ecosystem
```

### 2. 日志管理
```bash
# 查看应用日志
pm2 logs jingjipingshen-api --lines 100

# 配置日志轮转
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 7
```

### 3. 健康检查
```bash
# 检查服务状态
curl -I https://your-domain.com/api/health

# 检查数据库连接
mysql -u review_app -p -e "SELECT 1;"

# 检查Nginx状态
sudo systemctl status nginx
```

---

## 十一、安全检查清单

- [ ] 修改默认管理员密码
- [ ] 设置强密码的数据库用户
- [ ] 配置防火墙（仅开放80/443端口）
- [ ] 启用HTTPS证书
- [ ] 设置定期备份
- [ ] 配置日志轮转
- [ ] 禁用不必要的服务
- [ ] 更新系统和依赖包
- [ ] 配置fail2ban防暴力破解
- [ ] 测试恢复流程

### 安装fail2ban
```bash
sudo apt install fail2ban -y

# 创建配置文件
sudo nano /etc/fail2ban/jail.local
```

内容：
```ini
[DEFAULT]
bantime = 3600
findtime = 600
maxretry = 5

[nginx-http-auth]
enabled = true
port = http,https
filter = nginx-http-auth
logpath = /var/log/nginx/error.log
```

```bash
sudo systemctl restart fail2ban
sudo systemctl enable fail2ban
```

---

## 十二、故障排查

### 问题1：数据库连接失败
```bash
# 检查MySQL服务
sudo systemctl status mysql

# 检查防火墙
sudo ufw status

# 检查用户权限
mysql -u review_app -p
```

### 问题2：PM2进程频繁崩溃
```bash
# 查看详细日志
pm2 logs jingjipingshen-api --err

# 重启服务
pm2 restart jingjipingshen-api

# 查看系统资源
htop
df -h
free -m
```

### 问题3：Nginx返回502错误
```bash
# 检查后端是否运行
pm2 status

# 检查端口占用
netstat -tlnp | grep 3000

# 重启Nginx
sudo systemctl restart nginx
```

### 问题4：文件上传失败
```bash
# 检查目录权限
ls -la /var/www/jingjipingshen/uploads

# 修改权限
sudo chmod -R 755 /var/www/jingjipingshen/uploads
```

---

## 十三、性能优化建议

### 1. MySQL优化
编辑 `/etc/mysql/mysql.conf.d/mysqld.cnf`：
```ini
[mysqld]
innodb_buffer_pool_size = 1G
query_cache_type = 1
query_cache_size = 64M
max_connections = 200
```

重启MySQL：
```bash
sudo systemctl restart mysql
```

### 2. Nginx优化
编辑 `/etc/nginx/nginx.conf`：
```nginx
worker_processes auto;
worker_connections 1024;

sendfile on;
tcp_nopush on;
tcp_nodelay on;
keepalive_timeout 65;
types_hash_max_size 2048;
```

### 3. Node.js集群模式
修改 `server.js` 启用多进程：
```javascript
const cluster = require('cluster');
const os = require('os');

if (cluster.isPrimary) {
  const numCPUs = os.cpus().length;
  console.log(`Primary ${process.pid} is running`);
  console.log(`Forking ${numCPUs} workers...`);
  
  for (let i = 0; i < numCPUs; i++) {
    cluster.fork();
  }
  
  cluster.on('exit', (worker, code, signal) => {
    console.log(`Worker ${worker.process.pid} died. Restarting...`);
    cluster.fork();
  });
} else {
  require('./server');
}
```

---

## 十四、联系支持

- GitHub Issues: https://github.com/121299568/jingjipingshen/issues
- 文档：README.md
- 部署指南：PRODUCTION_DEPLOY.md
- 业务逻辑：BUSINESS_LOGIC.md
