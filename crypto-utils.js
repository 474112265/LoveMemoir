/**
 * 密码哈希与Token生成工具模块
 * 
 * 功能概述：
 * - 使用 PBKDF2-SHA512 算法进行密码安全哈希
 * - 生成加密安全的随机认证令牌
 * - 恒定时间比较防止时序攻击
 * 
 * 安全参数说明：
 * - 迭代次数 100,000 次（符合 OWASP 推荐标准）
 * - 盐值长度 16 字节（128位随机数）
 * - 密钥长度 64 字节（SHA-512 输出）
 * 
 * @file 加密工具函数
 */

/** Node.js 内置加密模块 */
const crypto = require('crypto');

// ==================== PBKDF2 算法常量 ====================

/** PBKDF2 哈希迭代次数，越高越安全但计算越慢 */
const PBKDF2_ITERATIONS = 100000;

/** 随机盐值字节长度 */
const SALT_LENGTH = 16;

/** 派生密钥的字节长度（与SHA-512输出一致） */
const KEY_LENGTH = 64;

/** 哈希算法选择：SHA-512 提供高强度安全性 */
const DIGEST = 'sha512';

/**
 * 对明文密码进行安全哈希处理
 * 
 * 使用 PBKDF2（Password-Based Key Derivation Function 2）算法：
 * 1. 生成随机盐值（每次调用不同，防止彩虹表攻击）
 * 2. 将密码+盐值进行100,000次SHA-512迭代运算
 * 3. 将盐值和派生密钥拼接为"盐值:密钥"格式存储
 * 
 * 存储格式说明：
 * 格式为 "salt:derivedKey"，其中salt和key均为hex编码字符串。
 * 冒号分隔符用于verifyPassword函数解析。
 * 
 * @param {string} password - 用户输入的原始明文密码
 * @returns {string} 格式化的哈希字符串（"hex_salt:hex_derived_key"）
 */
function hashPassword(password) {
  // 生成16字节的随机盐值并转为hex字符串
  const salt = crypto.randomBytes(SALT_LENGTH).toString('hex');
  
  // 执行PBKDF2推导：password + salt → 100000次迭代 → 64字节密钥
  const derivedKey = crypto.pbkdf2Sync(
    password,
    salt,
    PBKDF2_ITERATIONS,
    KEY_LENGTH,
    DIGEST
  ).toString('hex');
  
  // 返回 "盐值:密钥" 组合格式用于存储
  return `${salt}:${derivedKey}`;
}

/**
 * 验证用户输入的密码是否与存储的哈希匹配
 * 
 * 验证流程：
 * 1. 从存储的哈希中解析出盐值和预期密钥
 * 2. 用相同参数重新计算用户密码的PBKDF2哈希
 * 3. 使用 timingSafeEqual 进行恒定时间比较（防时序攻击）
 * 
 * 安全特性：
 * - timingSafeEqual 防止攻击者通过响应时间差异猜测正确字符
 * - 不含":"分隔符的旧格式哈希直接判定为无效
 * 
 * @param {string} password - 待验证的用户输入密码
 * @param {string} storedHash - 数据库中存储的格式化哈希字符串
 * @returns {boolean} true表示密码匹配；false表示不匹配或格式错误
 */
function verifyPassword(password, storedHash) {
  // 兼容性检查：旧版哈希不含冒号分隔符，直接拒绝
  if (!storedHash.includes(':')) return false;
  
  // 解析存储的"盐值:密钥"格式
  const [salt, key] = storedHash.split(':');
  
  // 使用相同参数重新计算哈希
  const derivedKey = crypto.pbkdf2Sync(
    password,
    salt,
    PBKDF2_ITERATIONS,
    KEY_LENGTH,
    DIGEST
  ).toString('hex');
  
  // 恒定时间比较：无论是否匹配都消耗相同的CPU时间
  return crypto.timingSafeEqual(
    Buffer.from(key, 'hex'),
    Buffer.from(derivedKey, 'hex')
  );
}

/**
 * 生成加密安全的随机认证令牌
 * 
 * 生成32字节（256位）随机数据并转为hex字符串，
 * 用于Bearer Token认证。碰撞概率极低（2^256空间）。
 * 
 * @returns {string} 64字符长度的hex编码随机令牌字符串
 */
function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

module.exports = {
  hashPassword,
  verifyPassword,
  generateToken
};
