/**
 * 恋爱记事簿 - Express HTTP 服务器主入口
 * 
 * 功能概述：
 * - RESTful API 路由（消息CRUD、相册管理、认证、长轮询）
 * - 图片上传与加密存储
 * - 缩略图生成服务
 * - CSRF 防护与安全头设置
 * - 登录速率限制
 * - CORS 跨域配置
 * 
 * API 端点总览：
 * POST   /api/login              用户登录
 * POST   /api/logout             用户登出
 * GET    /api/csrf-token          获取CSRF令牌
 * GET    /api/messages            获取消息列表
 * POST   /api/messages            发送消息
 * PUT    /api/messages/:id        编辑消息
 * DELETE /api/messages/:id        删除消息
 * GET    /api/messages/poll       长轮询新消息
 * POST   /api/messages/read       批量标记已读
 * GET    /api/messages/unread-count  获取未读数
 * POST   /api/upload              上传聊天图片
 * GET    /api/album               获取相册列表
 * POST   /api/album/upload        上传相册图片
 * DELETE /api/album/:id           删除相册图片
 * GET    /api/album/thumbnail/:id 获取缩略图
 * GET    /uploads/*               加密图片解密服务
 * GET    /album/*                 加密图片解密服务
 * GET    /*                       SPA前端路由兜底
 * 
 * @file Express应用服务器入口
 */

// ==================== 核心依赖引入 ====================

/** Express Web框架，用于构建HTTP API服务器 */
const express = require('express');

/** CORS中间件，处理跨域资源共享请求 */
const cors = require('cors');

/** Node.js路径工具模块，用于安全地拼接和规范化文件路径 */
const path = require('path');

/** Node.js文件系统模块，用于文件读写、目录操作等 */
const fs = require('fs');

/** Multer：Express的multipart/form-data文件上传处理库 */
const multer = require('multer');

/** Sharp：高性能图片处理库，用于缩略图生成 */
const sharp = require('sharp');

/** Node.js内置加密模块，用于生成随机文件名等 */
const crypto = require('crypto');

/** 自定义数据库连接模块，提供单例SQLite实例 */
const { getDb } = require('./database');

/** 自定义认证模块，提供登录、登出、Token校验等功能 */
const { authMiddleware, loginHandler, logoutHandler } = require('./auth');

/** 自定义图片加密模块，提供AES加解密、批量加密迁移等功能 */
const { encryptFile, streamDecryptedFile, streamDecryptedFileWithRange, encryptDirectory, getContentType, isEncrypted } = require('./image-crypto');

/** 自定义邮件工具模块，提供邮箱设置、邮件发送、提醒调度等功能 */
const { saveUserEmail, getUserEmail, sendReminderEmail, startReminderScheduler, getEmailLogs, isValidEmail } = require('./email-utils');

/** FFmpeg视频处理封装库，用于视频缩略图截取 */
const ffmpeg = require('fluent-ffmpeg');

/** 配置FFmpeg和FFprobe二进制路径（Windows必须显式指定） */
const os = require('os');
if (os.platform() === 'win32') {
  try {
    const { execSync } = require('child_process');
    const ffmpegPath = execSync('where.exe ffmpeg', { encoding: 'utf8' }).trim().split('\n')[0].trim();
    const ffprobePath = execSync('where.exe ffprobe', { encoding: 'utf8' }).trim().split('\n')[0].trim();
    if (ffmpegPath) ffmpeg.setFfmpegPath(ffmpegPath);
    if (ffprobePath) ffmpeg.setFfprobePath(ffprobePath);
    console.log(`✅ FFmpeg: ${ffmpegPath}`);
    console.log(`✅ FFprobe: ${ffprobePath}`);
  } catch (e) {
    console.warn('⚠️ 未找到FFmpeg/FFprobe，视频缩略图功能将不可用');
  }
}

/** 图片签名令牌HMAC密钥，独立于图片加密密钥 */
const IMAGE_TOKEN_HMAC_KEY = process.env.IMAGE_TOKEN_HMAC_KEY || 'love-diary-image-token-hmac-key-2024';

// ==================== 应用初始化与常量配置 ====================

/** Express应用实例 */
const app = express();

/** 服务监听端口，优先使用环境变量PORT，默认520 */
const PORT = process.env.PORT || 520;

// ==================== 存储目录初始化 ====================

/** 聊天消息中引用的上传图片存储目录 */
const uploadsDir = path.join(__dirname, 'data', 'uploads');

/** 相册照片存储目录 */
const albumDir = path.join(__dirname, 'data', 'album');

/** 缩略图缓存存储目录 */
const thumbnailDir = path.join(__dirname, 'data', 'thumbnails');

// 自动创建所有必需的数据存储目录（不存在时递归创建）
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}
if (!fs.existsSync(albumDir)) {
  fs.mkdirSync(albumDir, { recursive: true });
}
if (!fs.existsSync(thumbnailDir)) {
  fs.mkdirSync(thumbnailDir, { recursive: true });
}

// ==================== 文件上传配置 ====================

/**
 * 允许上传的图片文件扩展名白名单集合
 * @type {Set<string>}
 */
const ALLOWED_IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp']);

/**
 * 允许上传的视频文件扩展名白名单集合
 * @type {Set<string>}
 */
const ALLOWED_VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.mov', '.avi', '.mkv']);

/** 合并的媒体文件扩展名（图片+视频） */
const ALLOWED_MEDIA_EXTENSIONS = new Set([...ALLOWED_IMAGE_EXTENSIONS, ...ALLOWED_VIDEO_EXTENSIONS]);

/** 视频文件MIME类型白名单 */
const ALLOWED_VIDEO_MIME_TYPES = new Set([
  'video/mp4', 'video/webm', 'video/quicktime', 'video/x-msvideo',
  'video/x-matroska', 'video/avi'
]);

/**
 * 图片文件的Magic Bytes（文件头签名）映射表
 * 用于在服务端二次校验文件内容是否真实匹配声明的格式，
 * 防止攻击者通过修改扩展名绕过MIME类型检查。
 * 键为base64编码后的文件头前缀，值为对应的扩展名。
 * @type {Object<string, string>}
 */
const IMAGE_MAGIC_BYTES = {
  '/9j/': '.jpg',     // JPEG/JPG 的 base64 头标识
  'iVBOR': '.png',    // PNG 的 base64 头标识
  'R0lGOD': '.gif',   // GIF 的 base64 头标识
  'UklGR': '.webp',   // WebP 的 base64 头标识
  'Qk': '.bmp'        // BMP 的 base64 头标识
};

/**
 * 视频文件的Magic Bytes（文件头签名）映射表
 * 视频文件的Magic Bytes检测比图片更复杂，这里只做基础格式识别
 * @type {Object<string, string>}
 */
const VIDEO_MAGIC_BYTES = {
  'AAAA': '.mp4',     // MP4 ftyp box (base64 of 0x00000018/0x00000020)
  'AAAAF': '.mp4',    // MP4 ftyp variant
  '/1A': '.webm',     // WebM/MKV EBML header (1A 45 DF A3)
  'AAAAIG': '.mov',   // QuickTime MOV
  'RIFF': '.avi',     // AVI RIFF header
  'RIFFo': '.avi'     // AVI RIFF variant
};

/** 合并的媒体文件Magic Bytes（图片+视频） */
const MEDIA_MAGIC_BYTES = { ...IMAGE_MAGIC_BYTES, ...VIDEO_MAGIC_BYTES };

/**
 * Multer聊天媒体上传存储配置
 * 
 * 支持图片和视频文件上传
 * 文件命名规则：img_时间戳_随机hex.扩展名
 */
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_MEDIA_EXTENSIONS.has(ext)) {
      return cb(new Error('不支持的媒体格式'));
    }
    const prefix = ALLOWED_IMAGE_EXTENSIONS.has(ext) ? 'img' : 'video';
    const name = `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}${ext}`;
    cb(null, name);
  }
});

/** 配置好的Multer聊天媒体上传中间件实例 */
const upload = multer({
  storage,
  limits: { fileSize: Infinity },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const isImage = ALLOWED_IMAGE_EXTENSIONS.has(ext);
    const isVideo = ALLOWED_VIDEO_EXTENSIONS.has(ext);
    if (!isImage && !isVideo) {
      return cb(new Error('不支持的媒体格式'));
    }
    if (!file.mimetype.startsWith('image/') && !ALLOWED_VIDEO_MIME_TYPES.has(file.mimetype)) {
      return cb(new Error('只允许上传图片或视频文件'));
    }
    cb(null, true);
  }
});

/**
 * Multer相册媒体上传存储配置
 * 支持图片和视频文件上传，存储到 albumDir
 */
const albumStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, albumDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_MEDIA_EXTENSIONS.has(ext)) {
      return cb(new Error('不支持的媒体格式'));
    }
    const prefix = ALLOWED_IMAGE_EXTENSIONS.has(ext) ? 'album' : 'album_video';
    const name = `${prefix}_${Date.now()}_${crypto.randomBytes(6).toString('hex')}${ext}`;
    cb(null, name);
  }
});

/** 配置好的Multer相册媒体上传中间件实例 */
const albumUpload = multer({
  storage: albumStorage,
  limits: { fileSize: Infinity },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const isImage = ALLOWED_IMAGE_EXTENSIONS.has(ext);
    const isVideo = ALLOWED_VIDEO_EXTENSIONS.has(ext);
    if (!isImage && !isVideo) {
      return cb(new Error('不支持的媒体格式'));
    }
    if (!file.mimetype.startsWith('image/') && !ALLOWED_VIDEO_MIME_TYPES.has(file.mimetype)) {
      return cb(new Error('只允许上传图片或视频文件'));
    }
    cb(null, true);
  }
});

// ==================== 安全机制 ====================

/** CSRF令牌请求头名称 */
const CSRF_TOKEN_HEADER = 'x-csrf-token';

/**
 * 内存中的CSRF令牌存储
 * 结构: Map<token_string, { userId: number, createdAt: number }>
 * 生产环境建议替换为Redis等外部存储
 * @type {Map<string, Object>}
 */
const csrfTokenStore = new Map();

// ========== 登录速率限制 ==========

/**
 * 各IP地址的登录尝试记录
 * 结构: Map<ip_string, { count: number, firstAttempt: number }>
 * @type {Map<string, Object>}
 */
const loginAttempts = new Map();

/** 允许的最大连续登录失败次数 */
const LOGIN_MAX_ATTEMPTS = 10;

/** 速率限制的时间窗口长度（毫秒），5分钟内超过上限则锁定 */
const LOGIN_WINDOW_MS = 5 * 60 * 1000;

/**
 * 检查指定IP是否被允许继续尝试登录
 * 
 * 规则：
 * - 无记录 → 创建记录，允许
 * - 记录超出窗口期 → 重置计数器，允许
 * - 未超窗口但已达上限 → 拒绝
 * - 未超窗口且未达上限 → 递增计数，允许
 * 
 * @param {string} ip - 客户端IP地址
 * @returns {boolean} true表示允许登录；false表示应拒绝
 */
function checkLoginRate(ip) {
  const record = loginAttempts.get(ip);
  if (!record) {
    loginAttempts.set(ip, { count: 1, firstAttempt: Date.now() });
    return true;
  }
  // 时间窗口过期则重置
  if (Date.now() - record.firstAttempt > LOGIN_WINDOW_MS) {
    loginAttempts.set(ip, { count: 1, firstAttempt: Date.now() });
    return true;
  }
  // 达到次数上限则拒绝
  if (record.count >= LOGIN_MAX_ATTEMPTS) {
    return false;
  }
  record.count++;
  return true;
}

/**
 * 清除指定IP的登录尝试记录
 * 通常在登录成功后调用以重置该IP的安全状态
 * 
 * @param {string} ip - 要清除记录的客户端IP地址
 * @returns {void}
 */
function resetLoginRate(ip) {
  loginAttempts.delete(ip);
}

// ========== Token 过期清理 ==========

/** Token最大有效期（毫秒）：7天 */
const TOKEN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 清理过期的认证Token记录
 * 删除创建时间超过7天的旧token条目，
 * 定期执行以避免auth_tokens表无限增长。
 * 
 * @returns {void}
 */
function cleanExpiredTokens() {
  try {
    const db = getDb();
    db.prepare(`DELETE FROM auth_tokens WHERE created_at < datetime('now', '-7 days')`).run();
  } catch (e) {
    console.error('清理过期token失败:', e);
  }
}

// 每小时自动执行一次Token清理任务
setInterval(cleanExpiredTokens, 60 * 60 * 1000);

/**
 * 为指定用户生成新的CSRF令牌
 * 
 * 同时执行过期令牌清理（删除24小时前的旧令牌）。
 * 
 * @param {number} userId - 关联的用户ID
 * @returns {string} 生成的CSRF令牌字符串
 */
function generateCsrfToken(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  csrfTokenStore.set(token, { userId, createdAt: Date.now() });

  // 清理过期的CSRF令牌（超过24小时）
  for (const [key, val] of csrfTokenStore) {
    if (Date.now() - val.createdAt > 24 * 60 * 60 * 1000) {
      csrfTokenStore.delete(key);
    }
  }

  return token;
}

/**
 * Express CSRF验证中间件
 * 
 * 对所有非GET请求进行CSRF令牌校验：
 * - 从请求头x-csrf-token提取令牌
 * - 验证令牌存在且有效
 * - 校验令牌关联的用户ID与当前用户一致（防跨用户伪造）
 * 
 * GET/HEAD/OPTIONS方法被视为安全方法，跳过CSRF验证。
 * 
 * @param {import('express').Request} req - Express请求对象
 * @param {import('express').Response} res - Express响应对象
 * @param {Function} next - Express next函数
 * @returns {void}
 */
function validateCsrfToken(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    return next();
  }

  const csrfToken = req.headers[CSRF_TOKEN_HEADER];
  if (!csrfToken) {
    return res.status(403).json({ error: '缺少CSRF令牌' });
  }

  let record = csrfTokenStore.get(csrfToken);
  if (!record) {
    const { validateCsrfToken: authValidateCsrfToken } = require('./auth');
    const userId = req.user ? req.user.id : null;
    if (!authValidateCsrfToken(csrfToken, userId)) {
      return res.status(403).json({ error: '无效的CSRF令牌' });
    }
  } else {
    if (Date.now() - record.createdAt > 24 * 60 * 60 * 1000) {
      csrfTokenStore.delete(csrfToken);
      return res.status(403).json({ error: 'CSRF令牌已过期' });
    }
    if (req.user && record.userId !== null && record.userId !== req.user.id) {
      return res.status(403).json({ error: 'CSRF令牌与用户不匹配' });
    }
  }

  next();
}

/**
 * 安全响应头设置中间件
 * 
 * 设置以下安全相关HTTP响应头：
 * - X-Content-Type-Options: nosniff → 防止浏览器MIME嗅探
 * - X-Frame-Options: DENY → 禁止页面被嵌入iframe（防点击劫持）
 * - X-XSS-Protection: 启用浏览器XSS过滤器
 * - Referrer-Policy: strict-origin-when-cross-origin → 控制Referer泄露
 * - Content-Security-Policy: 严格的内容来源策略
 * - Permissions-Policy: 禁止访问摄像头/麦克风/地理位置
 * - Cross-Origin-Opener-Policy: same-origin → 隔离跨源窗口
 * - 移除 X-Powered-By 头（隐藏技术栈信息）
 * 
 * 注意：故意不设置 Cross-Origin-Resource-Policy，
 * 否则会阻止同源的加密图片正常加载。
 * 
 * @param {import('express').Request} req - Express请求对象
 * @param {import('express').Response} res - Express响应对象
 * @param {Function} next - Express next函数
 * @returns {void}
 */
function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'");
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  res.removeHeader('X-Powered-By');
  next();
}

// ==================== 全局中间件注册 ====================

app.use(securityHeaders);

app.use(cors({
  origin: (origin, callback) => {
    // 无origin头的请求（如直接浏览器地址栏访问）放行
    if (!origin) return callback(null, true);

    // 白名单：仅允许特定域名跨域访问API
    const allowed = ['http://106.52.180.78', 'http://localhost:520', 'http://127.0.0.1:520'];
    if (allowed.some(o => origin.startsWith(o))) {
      callback(null, true);
    } else {
      // 不抛异常，只记录日志，仍然拒绝（同源请求不受影响）
      console.warn(`CORS: 拒绝来源 ${origin}`);
      callback(null, false);
    }
  },
  credentials: true // 允许携带Cookie/Authorization凭据
}));

// JSON请求体解析中间件（限制1MB防止DoS攻击）
app.use(express.json({ limit: '1mb' }));

// 静态文件服务中间件（禁止访问隐藏文件如.gitignore等）
app.use(express.static(path.join(__dirname, 'public'), { dotfiles: 'deny' }));

// ==================== API 路由定义 ====================

// ---------- 认证相关路由 ----------

/**
 * POST /api/login
 * 用户登录接口，带速率限制中间件防护暴力破解
 */
app.post('/api/login', (req, res, next) => {
  const ip = req.ip || req.connection.remoteAddress;
  if (!checkLoginRate(ip)) {
    return res.status(429).json({ error: '登录尝试过多，请5分钟后再试' });
  }
  next();
}, loginHandler);

/**
 * POST /api/logout
 * 用户登出接口，使当前Token失效
 */
app.post('/api/logout', authMiddleware, logoutHandler);

/**
 * GET /api/csrf-token
 * 获取CSRF令牌，供后续POST/PUT/DELETE请求携带
 */
app.get('/api/csrf-token', authMiddleware, (req, res) => {
  const token = generateCsrfToken(req.user.id);
  res.json({ csrfToken: token });
});

/**
 * GET /api/image-token
 * 生成短期图片访问签名令牌
 * 
 * 安全设计：
 * - 替代直接在URL query中传递长期Bearer Token
 * - 签名令牌有效期仅5分钟，大幅缩小泄露窗口
 * - 绑定用户ID，防止跨用户使用
 * - 使用HMAC-SHA256签名，无法伪造
 */
app.get('/api/image-token', authMiddleware, (req, res) => {
  const expiresAt = Date.now() + 5 * 60 * 1000;
  const userId = req.user.id;
  const payload = `${userId}:${expiresAt}`;
  const signature = crypto.createHmac('sha256', IMAGE_TOKEN_HMAC_KEY).update(payload).digest('hex');
  const imageToken = Buffer.from(`${payload}:${signature}`).toString('base64url');
  res.json({ imageToken, expiresAt });
});

// ---------- 消息 CRUD 路由 ----------

/**
 * GET /api/messages?limit=50&before=123
 * 获取消息列表（分页支持，按时间倒序返回后反转）
 * 
 * 查询参数：
 * - limit: 返回数量限制（默认50，范围1~200）
 * - before: 分页游标（返回ID小于此值的消息）
 */
app.get('/api/messages', authMiddleware, (req, res) => {
  try {
    const db = getDb();
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const before = req.query.before ? Number(req.query.before) : null;

    let query = 'SELECT * FROM messages';
    const params = [];

    // 支持基于ID的分页游标
    if (before) {
      query += ' WHERE id < ?';
      params.push(before);
    }

    query += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit);

    const messages = db.prepare(query).all(...params);
    res.json(messages.reverse()); // 反转为正序（旧→新）返回给前端
  } catch (err) {
    console.error('获取消息失败:', err);
    res.status(500).json({ error: '获取消息失败' });
  }
});

/**
 * POST /api/messages/read
 * 批量标记消息为已读状态
 * 
 * 请求体：{ message_ids: [1, 2, 3, ...] }
 * 只更新 is_read=0 的消息，避免重复更新
 */
app.post('/api/messages/read', authMiddleware, validateCsrfToken, (req, res) => {
  try {
    const { message_ids } = req.body;
    if (!Array.isArray(message_ids) || message_ids.length === 0) {
      return res.status(400).json({ error: '消息ID列表不能为空' });
    }

    // 过滤并规范化ID（确保为正整数）
    const validIds = message_ids.filter(id => Number(id) > 0).map(id => Number(id));
    if (validIds.length === 0) {
      return res.status(400).json({ error: '无效的消息ID' });
    }

    const db = getDb();

    // 使用IN子句批量更新，WHERE条件确保幂等性
    const placeholders = validIds.map(() => '?').join(',');
    const result = db.prepare(
      `UPDATE messages SET is_read = 1, read_at = CURRENT_TIMESTAMP WHERE id IN (${placeholders}) AND is_read = 0`
    ).run(...validIds);

    res.json({
      updated: result.changes,
      message_ids: validIds,
      read_at: new Date().toISOString()
    });
  } catch (err) {
    console.error('标记已读失败:', err);
    res.status(500).json({ error: '标记已读失败' });
  }
});

/**
 * GET /api/messages/unread-count
 * 获取当前用户的未读消息总数
 */
app.get('/api/messages/unread-count', authMiddleware, (req, res) => {
  try {
    const db = getDb();
    const count = db.prepare('SELECT COUNT(*) as unread FROM messages WHERE is_read = 0').get();
    res.json({ unread_count: count.unread });
  } catch (err) {
    console.error('获取未读数失败:', err);
    res.status(500).json({ error: '获取未读数失败' });
  }
});

/**
 * GET /api/messages/poll?after_id=0&timeout=25000&last_read_check=
 * 长轮询接口：客户端保持连接等待新消息或已读变化
 * 
 * 工作原理：
 * - 服务端最长保持连接25秒（可配，最大30秒）
 * - 每1秒查询一次是否有新消息或已读状态变化
 * - 有变化立即返回，无变化则在超时后返回空结果
 * - 客户端收到响应后立即发起新的长轮询请求
 * 
 * 查询参数：
 * - after_id: 增量拉取起点（获取ID大于此值的消息）
 * - timeout: 最长等待毫秒数（默认25s，最大30s）
 * - last_read_check: 上次已读检查基准时间（ISO字符串）
 */
app.get('/api/messages/poll', authMiddleware, (req, res) => {
  try {
    const db = getDb();
    const afterId = Number(req.query.after_id) || 0;
    const lastReadCheck = req.query.last_read_check || '';
    const timeout = Math.min(Number(req.query.timeout) || 25000, 30000); // 上限30s
    const startTime = Date.now();
    let finished = false;

    // 连接断开时的清理回调
    const cleanup = () => { finished = true; };
    req.on('close', cleanup);

    /**
     * ISO日期字符串转SQLite兼容格式
     * 将 "2024-01-15T08:30:00.000Z" 转换为 "2024-01-15 08:30:00"
     * 
     * @param {string} isoStr - ISO 8601 格式日期字符串
     * @returns {string} SQLite DATETIME 兼容格式
     */
    function isoToSqlite(isoStr) {
      if (!isoStr) return '';
      return isoStr.replace('T', ' ').replace(/\.\d+Z$/, '').replace(/Z$/, '');
    }

    /**
     * 轮询检查函数：查询新消息和已读状态变化
     * 通过setTimeout实现每秒一次的定时查询循环
     */
    function checkNewMessages() {
      if (finished || res.headersSent) return;

      try {
        // 查询增量新消息（ID大于after_id的消息）
        const newMessages = db.prepare(
          'SELECT * FROM messages WHERE id > ? ORDER BY created_at ASC'
        ).all(afterId);

        let readChanges = null;

        // 查询自上次检查以来的已读状态变化
        if (lastReadCheck) {
          const sqliteTime = isoToSqlite(lastReadCheck);
          const changedReads = db.prepare(
            'SELECT id, is_read, read_at FROM messages WHERE is_read = 1 AND read_at IS NOT NULL AND read_at >= ? ORDER BY read_at ASC'
          ).all(sqliteTime);
          if (changedReads.length > 0) {
            readChanges = changedReads;
          }
        } else {
          // 首次轮询：查找最近30秒内的已读变化
          const changedReads = db.prepare(
            "SELECT id, is_read, read_at FROM messages WHERE is_read = 1 AND read_at IS NOT NULL AND read_at > datetime('now', '-30 seconds') ORDER BY read_at ASC"
          ).all();
          if (changedReads.length > 0) {
            readChanges = changedReads;
          }
        }

        // 有新数据或超时 → 返回响应
        if (newMessages.length > 0 || readChanges) {
          if (!finished && !res.headersSent) {
            return res.json({
              new_messages: newMessages,
              read_changes: readChanges,
              server_time: new Date().toISOString()
            });
          }
          return;
        }

        // 超时 → 返回空结果（客户端会立即重新发起轮询）
        if (Date.now() - startTime >= timeout) {
          if (!finished && !res.headersSent) {
            return res.json({ new_messages: [], read_changes: null, server_time: new Date().toISOString() });
          }
          return;
        }

        // 无变化且未超时 → 1秒后再查
        setTimeout(checkNewMessages, 1000);
      } catch (err) {
        console.error('长轮询查询失败:', err);
        if (!finished && !res.headersSent) {
          res.status(500).json({ error: '查询消息失败' });
        }
      }
    }

    checkNewMessages();
  } catch (err) {
    console.error('长轮询初始化失败:', err);
    res.status(500).json({ error: '长轮询失败' });
  }
});

/**
 * POST /api/messages
 * 发送新消息（文本或图片类型）
 * 
 * 请求体：
 * - content: 消息内容（text类型必填，image类型可选）
 * - sender: 发送者身份（"小洋"或"小蔡"）
 * - message_type: 消息类型（"text"或"image"，默认"text"）
 * - image_url: 图片URL（image类型必填）
 */
app.post('/api/messages', authMiddleware, validateCsrfToken, (req, res) => {
  try {
    const { content, sender, message_type, image_url, reply_to_id, reply_preview } = req.body;

    // 发送者身份白名单校验
    if (!sender || !['小洋', '小蔡'].includes(sender)) {
      return res.status(400).json({ error: '发送者身份无效' });
    }

    const type = message_type || 'text';

    // 文本消息校验
    if (type === 'text') {
      if (!content || !content.trim()) {
        return res.status(400).json({ error: '消息内容不能为空' });
      }
      if (content.length > 5000) {
        return res.status(400).json({ error: '消息内容过长' });
      }
    }

    // 图片消息校验
    if (type === 'image') {
      if (!image_url) {
        return res.status(400).json({ error: '图片地址不能为空' });
      }
      if (!isValidImageUrl(image_url)) {
        return res.status(400).json({ error: '图片地址不合法' });
      }
    }

    // 回复消息校验
    let finalReplyToId = null;
    let finalReplyPreview = null;
    if (reply_to_id) {
      const replyId = Number(reply_to_id);
      if (!isNaN(replyId) && replyId > 0) {
        const db = getDb();
        const replyMsg = db.prepare('SELECT id, content, sender, message_type, image_url FROM messages WHERE id = ?').get(replyId);
        if (replyMsg) {
          finalReplyToId = replyId;
          if (reply_preview) {
            finalReplyPreview = String(reply_preview).substring(0, 200);
          } else {
            if (replyMsg.message_type === 'image' && replyMsg.image_url) {
              finalReplyPreview = '📷 图片';
            } else {
              finalReplyPreview = replyMsg.content ? replyMsg.content.substring(0, 80) : '';
            }
          }
        }
      }
    }

    const db = getDb();
    const result = db.prepare(
      'INSERT INTO messages (content, sender, message_type, image_url, reply_to_id, reply_preview) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(content || '', sender, type, image_url || null, finalReplyToId, finalReplyPreview);

    // 返回完整的新消息记录（含自动生成的id和时间戳）
    const message = db.prepare('SELECT * FROM messages WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(message);
  } catch (err) {
    console.error('发送消息失败:', err);
    res.status(500).json({ error: '发送消息失败' });
  }
});

/**
 * 校验图片URL是否合法且安全
 * 
 * 安全校验规则：
 * 1. 必须是字符串且非空
 * 2. 长度不超过500字符
 * 3. 必须以 /uploads/ 开头（相对路径）
 * 4. 经path.normalize处理后不含 ".."（防路径穿越）
 * 5. 文件名必须符合命名规范 img_时间戳_随机hex.扩展名
 * 
 * @param {string} url - 待校验的图片URL路径
 * @returns {boolean} true表示URL合法安全；false表示非法
 */
function isValidImageUrl(url) {
  if (!url || typeof url !== 'string') return false;
  if (url.length > 500) return false;
  if (!url.startsWith('/uploads/')) return false;
  const normalized = path.normalize(url);
  if (normalized.includes('..')) return false;
  const filename = path.basename(url);
  if (!filename.match(/^img_\d+_[a-f0-9]+\.\w+$/)) return false;
  return true;
}

/**
 * POST /api/upload
 * 上传聊天消息中的图片
 * 
 * 流程：
 * 1. Multer接收文件并存入uploadsDir
 * 2. 校验文件Magic Bytes确认内容真实为图片
 * 3. 对文件执行AES加密（原地覆盖）
 * 4. 返回加密后的图片访问URL
 */
app.post('/api/upload', authMiddleware, validateCsrfToken, upload.single('image'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: '请选择文件' });
    }

    const filePath = req.file.path;
    const ext = path.extname(req.file.originalname).toLowerCase();
    const isVideo = ALLOWED_VIDEO_EXTENSIONS.has(ext);

    try {
      const buffer = fs.readFileSync(filePath);
      const base64Head = buffer.toString('base64', 0, Math.min(buffer.length, 8));

      let validMagic = false;
      for (const [magic] of Object.entries(MEDIA_MAGIC_BYTES)) {
        if (base64Head.startsWith(magic)) {
          validMagic = true;
          break;
        }
      }

      if (!validMagic) {
        fs.unlinkSync(filePath);
        return res.status(400).json({ error: '文件内容与格式不匹配' });
      }

      if (!encryptFile(filePath)) {
        fs.unlinkSync(filePath);
        return res.status(500).json({ error: '文件加密失败' });
      }

      const mediaUrl = `/uploads/${req.file.filename}`;
      res.json({ url: mediaUrl, media_type: isVideo ? 'video' : 'image' });
    } catch (readErr) {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
      res.status(500).json({ error: '文件处理失败' });
    }
  } catch (err) {
    console.error('上传文件失败:', err);
    res.status(500).json({ error: '上传文件失败' });
  }
});

// ========== 图片解密中间件（替代 express.static）==========
// 图片在磁盘上加密存储，必须通过认证才能解密访问

/**
 * 加密图片服务中间件工厂函数
 * 
 * 替代传统的 express.static 中间件，
 * 因为所有图片都以AES加密形式存储在磁盘上，
 * 无法通过静态文件服务直接提供。
 * 
 * 此中间件的工作流程：
 * 1. 提取并验证Bearer Token（支持header和query两种方式）
 * 2. 解析请求路径映射到实际文件路径
 * 3. 路径穿越安全校验（防止../越权访问）
 * 4. 流式解密文件并通过HTTP响应发送给客户端
 * 
 * @param {string} baseDir - 图片文件的基础目录（如 uploadsDir 或 albumDir）
 * @returns {Function} Express中间件函数
 */
function serveEncryptedImage(baseDir) {
  return (req, res, next) => {
    let authenticated = false;

    let authToken = req.headers['authorization']?.replace('Bearer ', '');
    
    if (authToken) {
      try {
        const db = getDb();
        const tokenRecord = db.prepare(`
          SELECT at.*, u.username, u.display_name 
          FROM auth_tokens at 
          JOIN users u ON at.user_id = u.id 
          WHERE at.token = ?
        `).get(authToken);

        if (tokenRecord) {
          const tokenAge = Date.now() - new Date(tokenRecord.created_at + 'Z').getTime();
          if (tokenAge <= 7 * 24 * 60 * 60 * 1000) {
            authenticated = true;
          }
        }
      } catch (e) {}
    }

    if (!authenticated && req.query.token) {
      try {
        const queryToken = req.query.token;
        
        const db = getDb();
        const tokenRecord = db.prepare(`
          SELECT at.*, u.username, u.display_name 
          FROM auth_tokens at 
          JOIN users u ON at.user_id = u.id 
          WHERE at.token = ?
        `).get(queryToken);

        if (tokenRecord) {
          const tokenAge = Date.now() - new Date(tokenRecord.created_at + 'Z').getTime();
          if (tokenAge <= 7 * 24 * 60 * 60 * 1000) {
            authenticated = true;
          }
        }

        if (!authenticated) {
          const decoded = Buffer.from(queryToken, 'base64url').toString('utf8');
          const parts = decoded.split(':');
          if (parts.length === 3) {
            const [userIdStr, expiresStr, signature] = parts;
            const payload = `${userIdStr}:${expiresStr}`;
            const expectedSig = crypto.createHmac('sha256', IMAGE_TOKEN_HMAC_KEY).update(payload).digest('hex');
            if (crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSig))) {
              const expiresAt = Number(expiresStr);
              if (Date.now() <= expiresAt) {
                authenticated = true;
              }
            }
          }
        }
      } catch (e) {}
    }

    if (!authenticated) {
      return res.status(401).send('Unauthorized');
    }

    const requestedFile = path.join(baseDir, req.path);
    const resolvedPath = path.resolve(requestedFile);
    const resolvedBase = path.resolve(baseDir);

    if (!resolvedPath.startsWith(resolvedBase)) {
      return res.status(403).send('Forbidden');
    }

    if (!fs.existsSync(resolvedPath)) {
      return res.status(404).send('Not found');
    }

    const ext = path.extname(req.path).toLowerCase();
    const contentType = getContentType(ext);
    const isVideoFile = ALLOWED_VIDEO_EXTENSIONS.has(ext);

    if (isVideoFile) {
      if (!streamDecryptedFileWithRange(resolvedPath, res, req, contentType)) {
        return res.status(500).send('Decryption failed');
      }
    } else {
      if (!streamDecryptedFile(resolvedPath, res, contentType)) {
        return res.status(500).send('Decryption failed');
      }
    }
  };
}

// 注册加密图片服务中间件到对应路由
app.use('/uploads', serveEncryptedImage(uploadsDir));

/**
 * GET /api/album/thumbnail/:id
 * 获取指定照片的缩略图（支持query参数token认证）
 * 
 * 必须在 app.use('/album', ...) 之前注册，否则会被 serveEncryptedImage 中间件先拦截
 */
app.get('/api/album/thumbnail/:id', async (req, res) => {
  try {
    let authenticated = false;

    let authToken = req.headers['authorization']?.replace('Bearer ', '');
    if (authToken) {
      try {
        const db = getDb();
        const tokenRecord = db.prepare(`
          SELECT at.*, u.username, u.display_name 
          FROM auth_tokens at 
          JOIN users u ON at.user_id = u.id 
          WHERE at.token = ?
        `).get(authToken);

        if (tokenRecord) {
          const tokenAge = Date.now() - new Date(tokenRecord.created_at + 'Z').getTime();
          if (tokenAge <= 7 * 24 * 60 * 60 * 1000) {
            authenticated = true;
          }
        }
      } catch (e) {}
    }

    if (!authenticated && req.query.token) {
      try {
        const queryToken = req.query.token;

        const db = getDb();
        const tokenRecord = db.prepare(`
          SELECT at.*, u.username, u.display_name 
          FROM auth_tokens at 
          JOIN users u ON at.user_id = u.id 
          WHERE at.token = ?
        `).get(queryToken);

        if (tokenRecord) {
          const tokenAge = Date.now() - new Date(tokenRecord.created_at + 'Z').getTime();
          if (tokenAge <= 7 * 24 * 60 * 60 * 1000) {
            authenticated = true;
          }
        }

        if (!authenticated) {
          const decoded = Buffer.from(queryToken, 'base64url').toString('utf8');
          const parts = decoded.split(':');
          if (parts.length === 3) {
            const [userIdStr, expiresStr, signature] = parts;
            const payload = `${userIdStr}:${expiresStr}`;
            const expectedSig = crypto.createHmac('sha256', IMAGE_TOKEN_HMAC_KEY).update(payload).digest('hex');
            if (crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSig))) {
              const expiresAt = Number(expiresStr);
              if (Date.now() <= expiresAt) {
                authenticated = true;
              }
            }
          }
        }
      } catch (e) {}
    }

    if (!authenticated) {
      return res.status(401).send('Unauthorized');
    }

    const photoId = Number(req.params.id);
    if (isNaN(photoId) || photoId <= 0) {
      return res.status(400).json({ error: '无效的图片ID' });
    }

    const db = getDb();
    const photo = db.prepare('SELECT filename FROM photos WHERE id = ?').get(photoId);
    if (!photo) {
      return res.status(404).json({ error: '图片不存在' });
    }

    const filename = photo.filename;
    if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
      return res.status(400).json({ error: '无效的文件名' });
    }

    const thumbBuffer = await generateThumbnail(filename);
    if (thumbBuffer) {
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Cache-Control', 'private, max-age=86400');
      res.setHeader('Content-Length', thumbBuffer.length);
      res.end(thumbBuffer);
    } else {
      const ext = path.extname(filename).toLowerCase();
      const isVideo = ALLOWED_VIDEO_EXTENSIONS.has(ext);

      if (isVideo) {
        console.warn(`⚠️ 视频缩略图生成失败，返回占位图: ${filename}`);
        const placeholderPng = Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAMgAAABkCAYAAADDhn8LAAAACXBIWXMAAAsTAAALEwEAmpwYAAAA' +
          'GXRFWHRTb2Z0d2FyZQBBZG9iZSBJbWFnZVJlYWR5ccllPAAAAyJpVFh0WE1MOmNvbS5hZG9i' +
          'ZS54bXAAAAAAADw/eHBhY2tldCBiZWdpbj0i77u/IiBpZD0iVzVNME1wQ2VoaUh6cmVTek5U' +
          'Y3prYzlkIj8+IDx4OnhtcG1ldGEgeG1sbnM6eD0iYWRvYmU6bnM6bWV0YS8iIHg6eG1wdGs9' +
          'IkFkb2JlIFhNUCBDb3JlIDUuMy1jMDExIdY03JTVFIgIGVuZCB0aXR0aCBwaW5nLmNvcHku' +
          'cG9ziZGFFakNDvUUMAAAGASURBVHja7NixAcAgDAgFXsG+v0xBaZGbcqoRBO0d/AAAAAElF' +
          'TkSuQmCC',
          'base64'
        );
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'private, max-age=300');
        res.end(placeholderPng);
      } else {
        console.warn(`⚠️ 图片缩略图生成失败，返回原图: ${filename}`);
        const sourcePath = path.join(albumDir, filename);
        const contentType = getContentType(ext);
        return streamDecryptedFile(sourcePath, res, contentType);
      }
    }
  } catch (err) {
    console.error('获取缩略图失败:', err);
    res.status(500).json({ error: '获取缩略图失败' });
  }
});

app.use('/album', serveEncryptedImage(albumDir));

// ========== 相册 API ==========

/**
 * 为相册中的加密文件（图片/视频）生成缩略图
 *
 * 处理流程：
 * 1. 检查缓存目录是否已有该文件的加密缩略图
 * 2. 若有缓存且能正确解密，直接返回解密后的Buffer（避免重复计算）
 * 3. 若无缓存或缓存失效：
 *    a. 读取相册目录下的加密文件到内存
 *    b. 使用 AES-CBC 解密得到明文数据Buffer
 *    c. 图片：用 sharp 库将图片缩放到 300×300（cover裁切模式），输出JPEG格式
 *    d. 视频：用 ffmpeg 在第1秒处截取帧 → sharp 压缩为 300×300 JPEG
 * 4. 加密缩略图并写入缓存目录
 *
 * @async
 * @param {string} filename - 相册中的加密文件名
 * @returns {Promise<Buffer|null>} 缩略图的明文Buffer；失败返回null
 */
async function generateThumbnail(filename) {
  const sourcePath = path.join(albumDir, filename);
  if (!fs.existsSync(sourcePath)) return null;

  const thumbFilename = `thumb_${filename}`;
  const thumbPath = path.join(thumbnailDir, thumbFilename);
  const ext = path.extname(filename).toLowerCase();
  const isVideo = ALLOWED_VIDEO_EXTENSIONS.has(ext);

  try {
    const { decryptBuffer, encryptBuffer, isEncrypted } = require('./image-crypto');

    if (fs.existsSync(thumbPath)) {
      const thumbBuffer = fs.readFileSync(thumbPath);
      if (isEncrypted(thumbPath)) {
        const decryptedThumb = decryptBuffer(thumbBuffer);
        if (decryptedThumb) return decryptedThumb;
      } else {
        return thumbBuffer;
      }
    }

    const encryptedBuffer = fs.readFileSync(sourcePath);
    const decryptedBuffer = decryptBuffer(encryptedBuffer);
    if (!decryptedBuffer) return null;

    let thumbBuffer;

    if (isVideo) {
      thumbBuffer = await new Promise((resolve, reject) => {
        const ts = Date.now();
        const rnd = crypto.randomBytes(4).toString('hex');
        const tempVideoPath = path.join(thumbnailDir, `temp_video_${ts}_${rnd}${ext}`);
        const frameFilename = `temp_frame_${ts}_${rnd}.png`;
        const framePath = path.join(thumbnailDir, frameFilename);
        let settled = false;
        let ffmpegProc = null;

        function cleanup() {
          try { if (fs.existsSync(tempVideoPath)) fs.unlinkSync(tempVideoPath); } catch (_) {}
          try { if (fs.existsSync(framePath)) fs.unlinkSync(framePath); } catch (_) {}
        }

        const timeout = setTimeout(() => {
          if (settled) return;
          settled = true;
          try { if (ffmpegProc) ffmpegProc.kill('SIGKILL'); } catch (_) {}
          cleanup();
          reject(new Error('视频缩略图生成超时（30秒）'));
        }, 30000);

        try {
          fs.writeFileSync(tempVideoPath, decryptedBuffer);

          ffmpegProc = ffmpeg(tempVideoPath)
            .inputOptions('-ss', '00:00:01')
            .outputOptions([
              '-vframes', '1',
              '-vf', 'scale=300:-2',
              '-pix_fmt', 'rgb24',
              '-f', 'image2'
            ])
            .output(framePath)
            .on('end', async () => {
              if (settled) return;
              clearTimeout(timeout);
              try {
                if (!fs.existsSync(framePath)) {
                  settled = true;
                  cleanup();
                  return reject(new Error('ffmpeg未生成帧文件'));
                }
                const frameBuffer = await sharp(framePath)
                  .resize(300, 300, { fit: 'cover', position: 'center' })
                  .jpeg({ quality: 70 })
                  .toBuffer();
                settled = true;
                cleanup();
                resolve(frameBuffer);
              } catch (sharpErr) {
                settled = true;
                cleanup();
                reject(sharpErr);
              }
            })
            .on('error', (err) => {
              if (settled) return;
              settled = true;
              clearTimeout(timeout);
              cleanup();
              reject(err);
            })
            .run();
        } catch (setupErr) {
          settled = true;
          clearTimeout(timeout);
          cleanup();
          reject(setupErr);
        }
      });
    } else {
      thumbBuffer = await sharp(decryptedBuffer)
        .resize(300, 300, { fit: 'cover', position: 'center' })
        .jpeg({ quality: 70 })
        .toBuffer();
    }

    const encryptedThumb = encryptBuffer(thumbBuffer);
    fs.writeFileSync(thumbPath, encryptedThumb);

    return thumbBuffer;
  } catch (err) {
    console.error(`生成缩略图失败 ${filename}:`, err.message);
    return null;
  }
}

/**
 * GET /api/album
 * 获取相册照片列表
 *
 * 返回每张照片的信息及访问URL（含缩略图URL）。
 * 按 sort_order 升序排列（用户自定义排序），sort_order 相同则按 created_at 降序。
 */
app.get('/api/album', authMiddleware, (req, res) => {
  try {
    const db = getDb();
    const photos = db.prepare(
      'SELECT id, filename, original_name, file_size, uploaded_by, created_at, media_type, sort_order FROM photos ORDER BY sort_order ASC, created_at DESC'
    ).all();
    // 为每张照片附加访问URL和缩略图URL
    res.json(photos.map(p => ({
      ...p,
      url: `/album/${p.filename}`,
      thumbnail_url: `/api/album/thumbnail/${p.id}`
    })));
  } catch (err) {
    console.error('获取相册失败:', err);
    res.status(500).json({ error: '获取相册失败' });
  }
});

/**
 * POST /api/album/upload
 * 上传相册照片（支持多张，20MB限制，保留原始质量）
 * 
 * 与聊天图片上传的区别：
 * - 存储到独立的albumDir目录
 * - 文件大小上限20MB（保留原始分辨率）
 * - 同时向photos表插入元数据记录
 */
app.post('/api/album/upload', authMiddleware, validateCsrfToken, albumUpload.single('image'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: '请选择文件' });
    }

    const filePath = req.file.path;
    const ext = path.extname(req.file.originalname).toLowerCase();
    const isVideo = ALLOWED_VIDEO_EXTENSIONS.has(ext);
    const mediaType = isVideo ? 'video' : 'image';

    const buffer = fs.readFileSync(filePath);
    const base64Head = buffer.toString('base64', 0, Math.min(buffer.length, 8));

    let validMagic = false;
    for (const [magic] of Object.entries(MEDIA_MAGIC_BYTES)) {
      if (base64Head.startsWith(magic)) {
        validMagic = true;
        break;
      }
    }

    if (!validMagic) {
      fs.unlinkSync(filePath);
      return res.status(400).json({ error: '文件内容与格式不匹配' });
    }

    if (!encryptFile(filePath)) {
      fs.unlinkSync(filePath);
      return res.status(500).json({ error: '文件加密失败' });
    }

    const db = getDb();
    const uploadedBy = req.user.display_name || 'Unknown';

    db.prepare(
      `INSERT INTO photos (filename, original_name, file_size, file_path, uploaded_by, media_type) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(req.file.filename, req.file.originalname, req.file.size, req.file.path, uploadedBy, mediaType);

    const photo = db.prepare(
      'SELECT id, filename, original_name, file_size, uploaded_by, created_at, media_type FROM photos WHERE id = ?'
    ).get(db.prepare('SELECT last_insert_rowid() as id').get().id);

    res.status(201).json({
      ...photo,
      url: `/album/${photo.filename}`,
      media_type: mediaType
    });
  } catch (err) {
    console.error('上传相册媒体失败:', err);
    res.status(500).json({ error: '上传相册图片失败' });
  }
});

/**
 * DELETE /api/album/:id
 * 删除指定的相册照片
 * 
 * 操作包括：
 * 1. 校验photo ID合法性
 * 2. 查询照片记录获取文件名
 * 3. 路径穿越安全校验
 * 4. 删除磁盘上的加密图片文件
 * 5. 删除对应的缩略图缓存文件
 * 6. 删除数据库记录
 */
app.delete('/api/album/:id', authMiddleware, validateCsrfToken, (req, res) => {
  try {
    const photoId = Number(req.params.id);
    if (isNaN(photoId) || photoId <= 0) {
      return res.status(400).json({ error: '无效的图片ID' });
    }

    const db = getDb();
    const photo = db.prepare('SELECT * FROM photos WHERE id = ?').get(photoId);
    if (!photo) {
      return res.status(404).json({ error: '图片不存在' });
    }

    // 文件名校验：防止路径穿越攻击
    const filename = photo.filename;
    if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
      return res.status(400).json({ error: '无效的文件名' });
    }

    // 删除加密的原图文件（双重路径安全校验）
    const filePath = path.join(albumDir, filename);
    if (!filePath.startsWith(path.resolve(albumDir))) {
      return res.status(400).json({ error: '非法的文件路径' });
    }
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    // 同步删除对应的缩略图缓存
    const thumbFilename = `thumb_${filename}`;
    const thumbPath = path.join(thumbnailDir, thumbFilename);
    if (fs.existsSync(thumbPath)) {
      fs.unlinkSync(thumbPath);
    }

    // 删除数据库记录
    db.prepare('DELETE FROM photos WHERE id = ?').run(photoId);
    res.json({ message: '图片已删除' });
  } catch (err) {
    console.error('删除相册图片失败:', err);
    res.status(500).json({ error: '删除相册图片失败' });
  }
});

/**
 * PUT /api/album/reorder
 * 批量更新相册照片的排序顺序
 *
 * 请求体格式: { "orders": [{ "id": 1, "sort_order": 0 }, { "id": 2, "sort_order": 1 }] }
 * 使用事务确保原子性，一次性更新所有照片的排序值。
 */
app.put('/api/album/reorder', authMiddleware, validateCsrfToken, (req, res) => {
  try {
    const { orders } = req.body;

    if (!Array.isArray(orders) || orders.length === 0) {
      return res.status(400).json({ error: '无效的排序数据' });
    }

    for (const item of orders) {
      if (typeof item.id !== 'number' || typeof item.sort_order !== 'number') {
        return res.status(400).json({ error: '排序数据格式错误' });
      }
    }

    const db = getDb();

    const updateOrder = db.prepare(
      'UPDATE photos SET sort_order = ? WHERE id = ?'
    );

    const updateMany = db.transaction((items) => {
      for (const item of items) {
        updateOrder.run(item.sort_order, item.id);
      }
    });

    updateMany(orders);

    res.json({ message: '排序已保存', updated: orders.length });
  } catch (err) {
    console.error('更新相册排序失败:', err);
    res.status(500).json({ error: '更新相册排序失败' });
  }
});

// ==================== 邮箱设置 API ====================

/**
 * GET /api/email
 * 获取当前用户的邮箱设置
 */
app.get('/api/email', authMiddleware, (req, res) => {
  try {
    const email = getUserEmail(req.user.user_id);
    res.json({ email: email || '' });
  } catch (err) {
    console.error('获取邮箱设置失败:', err);
    res.status(500).json({ error: '获取邮箱设置失败' });
  }
});

/**
 * POST /api/email
 * 保存当前用户的邮箱设置
 * 
 * 请求体：{ email: string }
 */
app.post('/api/email', authMiddleware, validateCsrfToken, async (req, res) => {
  try {
    const { email } = req.body;
    const result = await saveUserEmail(req.user.user_id, email || '');
    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }
    res.json({ success: true, email: result.email });
  } catch (err) {
    console.error('保存邮箱设置失败:', err);
    res.status(500).json({ error: '保存邮箱设置失败' });
  }
});

/**
 * POST /api/email/test
 * 发送测试邮件到当前用户设置的邮箱
 */
app.post('/api/email/test', authMiddleware, validateCsrfToken, async (req, res) => {
  try {
    const email = getUserEmail(req.user.user_id);
    if (!email) {
      return res.status(400).json({ error: '请先设置邮箱地址' });
    }
    const result = await sendReminderEmail(email, req.user.display_name);
    if (result.success) {
      res.json({ success: true, message: result.skipped ? '邮件冷却中，请稍后再试' : '测试邮件已发送' });
    } else {
      res.status(500).json({ error: '邮件发送失败: ' + result.error });
    }
  } catch (err) {
    console.error('发送测试邮件失败:', err);
    res.status(500).json({ error: '发送测试邮件失败' });
  }
});

/**
 * GET /api/email/logs
 * 获取邮件发送日志
 */
app.get('/api/email/logs', authMiddleware, (req, res) => {
  try {
    const logs = getEmailLogs(50);
    res.json(logs);
  } catch (err) {
    console.error('获取邮件日志失败:', err);
    res.status(500).json({ error: '获取邮件日志失败' });
  }
});

/**
 * PUT /api/messages/:id
 * 编辑消息内容
 * 
 * 仅更新content字段和updated_at时间戳。
 * 不允许修改发送者身份或消息类型。
 */
app.put('/api/messages/:id', authMiddleware, validateCsrfToken, (req, res) => {
  try {
    const { id } = req.params;
    const { content } = req.body;

    if (!content || !content.trim()) {
      return res.status(400).json({ error: '消息内容不能为空' });
    }

    if (content.length > 5000) {
      return res.status(400).json({ error: '消息内容过长' });
    }

    const msgId = Number(id);
    if (isNaN(msgId) || msgId <= 0) {
      return res.status(400).json({ error: '无效的消息ID' });
    }

    const db = getDb();
    const existing = db.prepare('SELECT * FROM messages WHERE id = ?').get(msgId);
    if (!existing) {
      return res.status(404).json({ error: '消息不存在' });
    }

    // 更新消息内容和最后修改时间
    db.prepare(
      'UPDATE messages SET content = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
    ).run(content.trim(), msgId);

    // 返回更新后的完整消息记录
    const message = db.prepare('SELECT * FROM messages WHERE id = ?').get(msgId);
    res.json(message);
  } catch (err) {
    console.error('编辑消息失败:', err);
    res.status(500).json({ error: '编辑消息失败' });
  }
});

/**
 * DELETE /api/messages/:id
 * 删除指定消息及其关联的上传图片文件
 * 
 * 如果消息类型为image且有有效的图片URL，
 * 会同步删除uploads目录下的对应加密图片文件。
 */
app.delete('/api/messages/:id', authMiddleware, validateCsrfToken, (req, res) => {
  try {
    const { id } = req.params;
    const msgId = Number(id);

    if (isNaN(msgId) || msgId <= 0) {
      return res.status(400).json({ error: '无效的消息ID' });
    }

    const db = getDb();
    const existing = db.prepare('SELECT * FROM messages WHERE id = ?').get(msgId);
    if (!existing) {
      return res.status(404).json({ error: '消息不存在' });
    }

    // 如果消息包含图片附件，同时删除物理文件
    if (existing.image_url && isValidImageUrl(existing.image_url)) {
      const imagePath = path.join(uploadsDir, path.basename(existing.image_url));
      // 路径安全校验：确保目标路径在uploads目录内
      if (!path.resolve(imagePath).startsWith(path.resolve(uploadsDir))) {
        return res.status(400).json({ error: '非法的文件路径' });
      }
      if (fs.existsSync(imagePath)) {
        fs.unlinkSync(imagePath);
      }
    }

    // 从数据库删除消息记录
    db.prepare('DELETE FROM messages WHERE id = ?').run(msgId);
    res.json({ message: '消息已删除' });
  } catch (err) {
    console.error('删除消息失败:', err);
    res.status(500).json({ error: '删除消息失败' });
  }
});

// ========== SPA 前端路由兜底 ==========

/**
 * GET /*
 * SPA（Single Page Application）前端路由兜底
 * 所有未被上述API路由匹配的GET请求都返回 index.html，
 * 由前端Vue Router处理客户端路由。
 */
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ==================== 服务器启动 ====================

/**
 * 启动HTTP服务器并执行初始化任务
 * 
 * 启动时执行的初始化操作：
 * 1. 对uploads和album目录中的图片执行加密迁移
 *    （首次部署时将明文图片转为AES加密存储）
 * 2. 输出加密迁移统计日志
 * 3. 打印服务启动成功信息
 */
app.listen(PORT, () => {
  try {
    // 加密迁移：uploads目录
    const uploadsResult = encryptDirectory(uploadsDir);
    if (uploadsResult.encrypted > 0) {
      console.log(`🔒 uploads 目录加密完成: ${uploadsResult.encrypted} 张已加密, ${uploadsResult.skipped} 张已跳过`);
    }
    
    // 加密迁移：album目录
    const albumResult = encryptDirectory(albumDir);
    if (albumResult.encrypted > 0) {
      console.log(`🔒 album 目录加密完成: ${albumResult.encrypted} 张已加密, ${albumResult.skipped} 张已跳过`);
    }
    
    if (uploadsResult.encrypted === 0 && albumResult.encrypted === 0) {
      console.log('🔒 所有图片已加密，无需迁移');
    }
  } catch (e) {
    console.error('图片加密迁移失败:', e);
  }

  startReminderScheduler();

  console.log(`💕 恋爱记事簿服务已启动: http://localhost:${PORT}`);
});
