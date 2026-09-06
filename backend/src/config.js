/**
 * 统一配置中心
 *
 * 原则：所有敏感配置必须来自环境变量，代码里不留任何硬编码密钥/口令。
 * 生产环境（NODE_ENV=production）启动时做强制校验，缺关键配置直接拒绝启动，
 * 避免"配了但没生效"这种静默失败。
 */
require('dotenv').config();

const path = require('path');

const NODE_ENV = process.env.NODE_ENV || 'development';
const isProd = NODE_ENV === 'production';

function required(name, fallback) {
  const v = process.env[name];
  if (v !== undefined && v !== '') return v;
  if (isProd && fallback === undefined) {
    throw new Error(`[config] 生产环境必须配置环境变量 ${name}`);
  }
  return fallback;
}

function bool(name, fallback) {
  const v = (process.env[name] || '').toLowerCase();
  if (v === 'true' || v === '1') return true;
  if (v === 'false' || v === '0') return false;
  return fallback;
}

// 生成一个随机密钥，仅用于开发环境，避免开发者把示例值带到生产
function devSecret() {
  const s = process.env.JWT_SECRET;
  if (s) return s;
  if (isProd) {
    throw new Error('[config] 生产环境必须配置 JWT_SECRET（建议 openssl rand -base64 48）');
  }
  console.warn('[config] ⚠ 未配置 JWT_SECRET，已生成临时随机密钥（重启后所有登录态失效）。生产环境必须显式配置！');
  return require('crypto').randomBytes(48).toString('base64');
}

const config = {
  env: NODE_ENV,
  isProd,
  port: parseInt(process.env.PORT || '3000', 10),

  // 安全
  jwtSecret: devSecret(),
  jwtExpiresIn: parseInt(process.env.JWT_EXPIRES_IN || '28800', 10), // 默认 8 小时（秒）
  bcryptRounds: parseInt(process.env.BCRYPT_ROUNDS || '12', 10),

  // CORS：生产必须指定来源，逗号分隔；不配则只允许同源
  corsOrigins: (process.env.CORS_ORIGINS || '')
    .split(',').map(s => s.trim()).filter(Boolean),

  // 文件
  maxFileSizeMB: parseInt(process.env.MAX_FILE_SIZE_MB || '50', 10),
  uploadDir: process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads'),
  dataDir: process.env.DATA_DIR || path.join(__dirname, '..', 'data'),

  // 数据层驱动：json | mysql
  dbDriver: (process.env.DB_DRIVER || 'json').toLowerCase(),
  db: {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '3306', 10),
    user: process.env.DB_USER || 'review_app',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'economic_review',
    charset: 'utf8mb4'
  },

  // 首次启动是否用默认账号初始化（生产环境建议关掉，改用 migrate.js 导入）
  seedDefaults: bool('SEED_DEFAULT_USERS', !isProd),

  // 登录限流
  loginRateWindowMs: parseInt(process.env.LOGIN_RATE_WINDOW_MS || '900000', 10), // 15 分钟
  loginRateMax: parseInt(process.env.LOGIN_RATE_MAX || '20', 10)
};

module.exports = config;
