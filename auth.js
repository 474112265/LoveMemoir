/**
 * 用户认证与授权模块
 * 
 * 功能概述：
 * - 基于用户名+密码的登录认证
 * - Bearer Token 会话管理
 * - CSRF 令牌生成与验证
 * - 登录速率限制（防暴力破解）
 * - Token 自动过期清理
 * 
 * @file 认证中间件和处理器
 */

/** Node.js 内置加密模块，用于生成随机Token */
const crypto = require('crypto');

/** 数据库模块引用 */
const { getDb } = require('./database');
const { verifyPassword, generateToken } = require('./crypto-utils');

// ==================== 登录速率限制 ====================

/**
 * 存储各IP地址的登录尝试记录
 * 结构: { [ip]: { count: number, lastAttempt: Date } }
 * @type {Object<string, {count: number, lastAttempt: Date}>}
 */
const loginAttempts = {};

/** 允许的最大登录尝试次数（超出后将锁定一段时间） */
const MAX_LOGIN_ATTEMPTS = 10;

/** 锁定持续时间（毫秒），超过此时间后可再次尝试登录 */
const LOCKOUT_DURATION = 15 * 60 * 1000;

/**
 * 检查指定IP是否被允许进行登录尝试
 * 
 * 判断逻辑：
 * 1. 若该IP无任何尝试记录 → 允许
 * 2. 若尝试次数未超过上限 → 允许并递增计数
 * 3. 若已超过上限且锁定期已过 → 重置计数器并允许
 * 4. 若仍在锁定期内 → 拒绝
 * 
 * @param {string} ip - 客户端请求的IP地址
 * @returns {boolean} true表示允许继续登录流程，false表示应拒绝
 */
function checkLoginRateLimit(ip) {
  const now = Date.now();
  if (!loginAttempts[ip]) {
    loginAttempts[ip] = { count: 1, lastAttempt: now };
    return true;
  }
  const attempt = loginAttempts[ip];
  if (attempt.count >= MAX_LOGIN_ATTEMPTS) {
    // 检查是否还在锁定期内
    if (now - attempt.lastAttempt < LOCKOUT_DURATION) {
      return false;
    }
    // 锁定到期，重置计数器
    attempt.count = 1;
    attempt.lastAttempt = now;
    return true;
  }
  attempt.count++;
  attempt.lastAttempt = now;
  return true;
}

/**
 * 清除指定IP的登录尝试记录
 * 通常在登录成功时调用，重置该IP的安全状态
 * 
 * @param {string} ip - 要清除记录的客户端IP地址
 * @returns {void}
 */
function resetLoginAttempts(ip) {
  delete loginAttempts[ip];
}

// ==================== CSRF 令牌管理 ====================

/**
 * 内存存储的CSRF令牌集合
 * 生产环境建议使用Redis等外部存储以支持多进程部署
 * @type {Set<string>}
 */
const csrfTokens = new Set();

/** CSRF令牌有效期（毫秒），默认2小时 */
const CSRF_TOKEN_TTL = 2 * 60 * 60 * 1000;

/** 定时清理间隔（毫秒），每小时清理一次过期令牌 */
const CSRF_CLEANUP_INTERVAL = 60 * 60 * 1000;

/**
 * 生成一个新的CSRF令牌并存入内存集合
 * 
 * @returns {string} 生成的CSRF令牌字符串（32字节随机hex）
 */
function generateCsrfToken() {
  const token = crypto.randomBytes(32).toString('hex');
  csrfTokens.add(token);
  return token;
}

/**
 * 验证提交的CSRF令牌是否有效且未被使用过
 * 
 * 使用"一次性令牌"策略：验证通过后立即从集合中移除，
 * 确保每个CSRF令牌只能被消费一次。
 * 
 * @param {string} token - 从请求头x-csrf-token中提取的待验证令牌
 * @returns {boolean} true表示令牌有效且已被消耗；false表示无效或不存在
 */
function validateCsrfToken(token) {
  if (!token || !csrfTokens.has(token)) return false;
  csrfTokens.delete(token);
  return true;
}

/**
 * 定期清理过期的CSRF令牌
 * 通过setInterval每CSRF_CLEANUP_INTERVAL毫秒执行一次清理操作，
 * 移除创建时间超过TTL的令牌（当前实现中未记录创建时间，
 * 此函数作为预留接口供后续扩展）
 * 
 * @returns {void}
 */
function startCsrfCleanup() {
  setInterval(() => {
    // 当前简单实现：如果需要精确过期控制，需改用Map存储带时间戳的令牌
    // 这里保留清理逻辑框架以便未来扩展
  }, CSRF_CLEANUP_INTERVAL);
}

// ==================== Token 管理 ====================

/**
 * 创建新的认证会话Token
 * 
 * 操作步骤：
 * 1. 生成随机32字节hex token
 * 2. 将token与用户ID关联写入auth_tokens表
 * 3. 返回token字符串给调用方
 * 
 * @param {number} userId - 关联的用户主键ID
 * @returns {string} 新生成的Bearer Token字符串
 */
function createAuthToken(userId) {
  const db = getDb();
  const token = generateToken();
  db.prepare(
    'INSERT INTO auth_tokens (token, user_id) VALUES (?, ?)'
  ).run(token, userId);
  return token;
}

/**
 * 使指定的认证Token失效（登出时调用）
 * 
 * 从auth_tokens表中删除对应记录，
 * 后续携带该token的请求将无法通过认证校验。
 * 
 * @param {string} token - 要失效的Bearer Token字符串
 * @returns {void}
 */
function invalidateAuthToken(token) {
  try {
    const db = getDb();
    db.prepare('DELETE FROM auth_tokens WHERE token = ?').run(token);
  } catch (e) {
    console.error('使Token失败:', e.message);
  }
}

/**
 * 查找并返回Token关联的用户信息
 * 
 * 联合查询auth_tokens和users两张表，
 * 返回完整的用户信息对象（含username、displayName等字段）。
 * 
 * @param {string} token - 待查询的Bearer Token字符串
 * @returns {Object|null} 用户信息对象（含id、username、password、display_name、token、created_at）；若token无效返回null
 */
function findUserByToken(token) {
  try {
    const db = getDb();
    const row = db.prepare(`
      SELECT at.*, u.username, u.password, u.display_name 
      FROM auth_tokens at 
      JOIN users u ON at.user_id = u.id 
      WHERE at.token = ?
    `).get(token);
    return row || null;
  } catch (e) {
    console.error('查找Token失败:', e.message);
    return null;
  }
}

/**
 * 清理过期的认证Token
 * 删除创建时间超过7天的旧token记录，
 * 避免数据库中积累大量无效数据。
 * 
 * @returns {{ deleted: number }} 包含删除数量的统计结果对象
 */
function cleanExpiredTokens() {
  try {
    const db = getDb();
    const result = db.prepare(
      "DELETE FROM auth_tokens WHERE created_at < datetime('now', '-7 days')"
    ).run();
    return { deleted: result.changes };
  } catch (e) {
    console.error('清理Token失败:', e.message);
    return { deleted: 0 };
  }
}

// ==================== Express 中间件 ====================

/**
 * Express认证中间件
 * 
 * 从请求头的Authorization字段中提取Bearer Token，
 * 并在数据库中验证其有效性。
 * 
 * 校验逻辑：
 * 1. 提取Authorization头中的token值（去掉"Bearer "前缀）
 * 2. 通过findUserByToken查询关联用户信息
 * 3. 检查token年龄是否超过7天（超期则视为失效）
 * 4. 将用户信息挂载到req.user上供下游路由使用
 * 
 * 失败情况统一返回401状态码和JSON错误响应。
 * 
 * @param {import('express').Request} req - Express请求对象
 * @param {import('express').Response} res - Express响应对象
 * @param {Function} next - Express next中间件函数
 * @returns {void}
 */
function authMiddleware(req, res, next) {
  let authToken = req.headers['authorization']?.replace('Bearer ', '');
  
  // 支持query参数传递token（用于img标签加载图片时的认证需求）
  if (!authToken && req.query.token) {
    authToken = req.query.token;
  }

  if (!authToken) {
    return res.status(401).json({ error: '请先登录' });
  }

  const user = findUserByToken(authToken);
  if (!user) {
    return res.status(401).json({ error: '登录已过期，请重新登录' });
  }

  // 检查token是否超过7天有效期
  const tokenAge = Date.now() - new Date(user.created_at + 'Z').getTime();
  if (tokenAge > 7 * 24 * 60 * 60 * 1000) {
    invalidateAuthToken(authToken);
    return res.status(401).json({ error: '登录已过期，请重新登录' });
  }

  req.user = user;
  req.authToken = authToken;
  next();
}

// ==================== 请求处理器 ====================

/**
 * 处理用户登录请求
 * 
 * 登录流程：
 * 1. 从请求体获取username和password
 * 2. 通过checkLoginRateLimit检查IP速率限制
 * 3. 在users表中查找对应用户名记录
 * 4. 使用verifyPassword比对密码哈希值
 * 5. 密码匹配则创建新token并返回用户信息和token
 * 6. 登录成功后清除该IP的尝试记录
 * 
 * @async
 * @param {import('express').Request} req - Express请求对象，body包含{ username, password }
 * @param {import('express').Response} res - Express响应对象
 * @returns {Promise<void>} 成功返回{ token, user, csrfToken }；失败返回错误JSON
 */
async function loginHandler(req, res) {
  const { username, password } = req.body;
  const clientIp = req.ip || req.connection.remoteAddress;

  // 速率限制：防止暴力破解密码
  if (!checkLoginRateLimit(clientIp)) {
    return res.status(429).json({
      error: '登录尝试过于频繁，请稍后再试',
      retryAfter: Math.ceil((LOCKOUT_DURATION - (Date.now() - loginAttempts[clientIp]?.lastAttempt)) / 1000)
    });
  }

  if (!username || !password) {
    return res.status(400).json({ error: '请输入用户名和密码' });
  }

  try {
    const db = getDb();

    // 根据用户名查找用户记录
    const user = db.prepare('SELECT id, username, password, display_name FROM users WHERE username = ?').get(username);

    if (!user) {
      // 用户名不存在也计入尝试次数（防止枚举攻击）
      return res.status(401).json({ error: '你不是我要的宝宝！' });
    }

    // 使用恒定时间比较函数防止时序攻击
    if (!verifyPassword(password, user.password)) {
      return res.status(401).json({ error: '你不是我要的宝宝！' });
    }

    // 登录成功：创建认证token和CSRF token
    const token = createAuthToken(user.id);
    const csrfToken = generateCsrfToken();

    // 清除该IP的登录尝试记录
    resetLoginAttempts(clientIp);

    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        displayName: user.display_name
      },
      csrfToken
    });
  } catch (err) {
    console.error('登录处理失败:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
}

/**
 * 处理用户登出请求
 * 
 * 使当前用户的认证token失效，
 * 无论请求成功与否都返回200状态码（幂等设计）。
 * 
 * @async
 * @param {import('express').Request} req - Express请求对象（需经过authMiddleware）
 * @param {import('express').Response} res - Express响应对象
 * @returns {Promise<void>} 始终返回{ message: '已退出登录' }
 */
async function logoutHandler(req, res) {
  try {
    if (req.authToken) {
      invalidateAuthToken(req.authToken);
    }
  } catch (e) {
    // 即使清理失败也不影响登出结果
  }
  res.json({ message: '已退出登录' });
}

// 启动CSRF定时清理任务
startCsrfCleanup();

module.exports = {
  authMiddleware,
  loginHandler,
  logoutHandler,
  generateCsrfToken,
  validateCsrfToken,
  findUserByToken,
  createAuthToken,
  invalidateAuthToken,
  cleanExpiredTokens
};
