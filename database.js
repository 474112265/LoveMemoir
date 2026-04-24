/**
 * SQLite 数据库管理模块
 * 
 * 功能概述：
 * - 使用 better-sqlite3 驱动管理 SQLite 数据库连接
 * - 单例模式管理数据库实例（懒加载）
 * - 自动创建和迁移数据表结构
 * - 初始化默认用户账号
 * 
 * 数据表说明：
 * - messages: 消息记录表（支持文本/图片类型、已读状态）
 * - users: 用户账号表（存储用户名、密码哈希、显示名称）
 * - photos: 相册照片表（记录上传的图片文件信息）
 * - auth_tokens: 认证令牌表（关联用户ID与Token字符串）
 * 
 * @file 数据库初始化与连接管理
 */

/** SQLite3 数据库驱动 */
const Database = require('better-sqlite3');

/** Node.js 路径处理模块，用于构建数据库文件路径 */
const path = require('path');

/** Node.js 内置加密模块，用于生成随机密码 */
const crypto = require('crypto');

/** 密码哈希函数引用 */
const { hashPassword } = require('./crypto-utils');

/** 数据库文件完整路径，存放在data子目录下 */
const dbPath = path.join(__dirname, 'data', 'love-diary.db');

/** 数据库单例实例，首次调用getDb()时初始化 */
let db;

/**
 * 获取数据库连接实例（单例模式）
 * 
 * 采用懒加载策略：仅在首次调用时执行以下操作：
 * 1. 检查并自动创建data目录（如不存在）
 * 2. 创建或打开SQLite数据库文件
 * 3. 配置WAL日志模式以提升并发读写性能
 * 4. 启用外键约束确保数据完整性
 * 5. 执行表结构初始化和迁移
 * 
 * 后续调用直接返回已存在的db实例。
 * 
 * @returns {Database} better-sqlite3 的 Database 实例对象
 */
function getDb() {
  if (!db) {
    // 确保数据目录存在
    const fs = require('fs');
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    
    // 创建/打开数据库连接
    db = new Database(dbPath);
    
    // 启用WAL模式：提升并发读性能，减少写锁竞争
    db.pragma('journal_mode = WAL');
    
    // 启用外键约束：确保关联数据的完整性
    db.pragma('foreign_keys = ON');
    
    // 初始化所有数据表结构
    initTables();
  }
  return db;
}

/**
 * 初始化数据库表结构和种子数据
 * 
 * 执行内容：
 * 1. CREATE TABLE IF NOT EXISTS 创建四张核心业务表
 * 2. ALTER TABLE 迁移旧版本缺失的列字段（兼容性升级）
 * 3. 初始化默认用户账号（小洋和小蔡）
 * 4. 自动修复用户显示名称和密码格式
 * 
 * 所有DDL操作使用IF NOT EXISTS确保幂等性，
 * ALTER操作使用try-catch包裹避免重复添加时报错。
 * 
 * @returns {void}
 */
function initTables() {
  // ==================== 核心表定义 ====================
  
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      sender TEXT NOT NULL,
      message_type TEXT DEFAULT 'text',
      image_url TEXT DEFAULT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      display_name TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS photos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL,
      original_name TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      file_path TEXT NOT NULL,
      uploaded_by TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS auth_tokens (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
  `);

  // ==================== 兼容性迁移 ====================
  
  // 为messages表逐步添加新列（支持旧版本数据库平滑升级）
  try {
    db.exec(`ALTER TABLE messages ADD COLUMN message_type TEXT DEFAULT 'text'`);
  } catch (e) {} // 列已存在时忽略错误
  try {
    db.exec(`ALTER TABLE messages ADD COLUMN image_url TEXT DEFAULT NULL`);
  } catch (e) {}
  try {
    db.exec(`ALTER TABLE messages ADD COLUMN is_read INTEGER DEFAULT 0`);
  } catch (e) {}
  try {
    db.exec(`ALTER TABLE messages ADD COLUMN read_at DATETIME`);
  } catch (e) {}
  try {
    db.exec(`ALTER TABLE messages ADD COLUMN reply_to_id INTEGER DEFAULT NULL`);
  } catch (e) {}
  try {
    db.exec(`ALTER TABLE messages ADD COLUMN reply_preview TEXT DEFAULT NULL`);
  } catch (e) {}
  try {
    db.exec(`ALTER TABLE photos ADD COLUMN media_type TEXT DEFAULT 'image'`);
  } catch (e) {}
  try {
    db.exec(`ALTER TABLE photos ADD COLUMN sort_order INTEGER DEFAULT 0`);
  } catch (e) {}
  try {
    db.exec(`ALTER TABLE users ADD COLUMN email_encrypted TEXT DEFAULT NULL`);
  } catch (e) {}
  try {
    db.exec(`ALTER TABLE users ADD COLUMN email_iv TEXT DEFAULT NULL`);
  } catch (e) {}

  // ==================== 种子数据初始化 ====================
  
  const existingUsers = db.prepare('SELECT COUNT(*) as count FROM users').get();
  if (existingUsers.count === 0) {
    // 首次部署：创建两个默认用户账号
    const insertUser = db.prepare(
      'INSERT INTO users (username, password, display_name) VALUES (?, ?, ?)'
    );
    insertUser.run('xiaozhong', hashPassword('love0815'), '小洋');
    insertUser.run('xiaocai', hashPassword('love0815'), '小蔡');
  } else {
    // 已有数据：更新显示名称为中文昵称
    const updateDisplayName = db.prepare(
      'UPDATE users SET display_name = ? WHERE username = ?'
    );
    updateDisplayName.run('小洋', 'xiaozhong');

    // 将旧版明文密码迁移为PBKDF2哈希格式
    const users = db.prepare('SELECT id, password FROM users').all();
    const updateUserPassword = db.prepare(
      'UPDATE users SET password = ? WHERE id = ?'
    );
    users.forEach(user => {
      if (!user.password.includes(':')) {
        console.warn(`⚠️ 用户ID ${user.id} 的密码为旧版明文格式，无法自动迁移，请手动重置密码`);
        updateUserPassword.run(hashPassword(crypto.randomBytes(32).toString('hex')), user.id);
      }
    });
  }
}

module.exports = { getDb };
