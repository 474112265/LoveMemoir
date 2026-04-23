/**
 * 图片加密/解密模块
 * 
 * 功能概述：
 * - 使用 AES-256-CBC 对称加密算法对磁盘上的图片文件进行加密存储
 * - 读取时流式解密，不落盘明文（内存中解密后直接发送给客户端）
 * - 支持批量目录加密迁移
 * - 提供加密状态检测和MIME类型映射
 * 
 * 安全设计：
 * - 每个文件使用随机IV（初始化向量），相同内容每次加密结果不同
 * - 密钥通过环境变量配置，生产环境必须设置 IMAGE_ENCRYPTION_KEY
 * - IV与密文拼接存储，解密时自动分离
 * 
 * 数据格式：
 * 加密后的文件 = [IV(16字节)] + [AES-CBC加密数据]
 * 
 * @file 图片文件的加密存储与流式解密服务
 */

/** Node.js 内置加密模块，提供AES加解密能力 */
const crypto = require('crypto');

/** Node.js 文件系统模块 */
const fs = require('fs');

/** Node.js 路径处理模块 */
const path = require('path');

// ==================== 加密配置常量 ====================

/**
 * AES加密主密钥来源：优先从环境变量读取，否则使用默认值
 * 
 * ⚠️ 生产环境安全警告：
 * 默认密钥仅用于开发/测试环境。
 * 部署到生产服务器时必须设置 IMAGE_ENCRYPTION_KEY 环境变量，
 * 使用强随机密码（至少32字符）替换默认值。
 * 若 NODE_ENV=production 且未设置环境变量，服务将拒绝启动。
 */
const DEFAULT_KEY = 'love-diary-2024-aes256-secret-key';
const ENCRYPTION_KEY = process.env.IMAGE_ENCRYPTION_KEY || DEFAULT_KEY;

if (process.env.NODE_ENV === 'production' && !process.env.IMAGE_ENCRYPTION_KEY) {
  console.error('❌ 安全错误: 生产环境必须设置 IMAGE_ENCRYPTION_KEY 环境变量！');
  console.error('   请执行: export IMAGE_ENCRYPTION_KEY=<你的强随机密钥>');
  process.exit(1);
}

if (!process.env.IMAGE_ENCRYPTION_KEY) {
  console.warn('⚠️ 警告: 使用默认加密密钥，仅限开发环境！生产环境请设置 IMAGE_ENCRYPTION_KEY 环境变量');
}

/** AES对称加密算法选择：CBC模式（需要IV） */
const ALGORITHM = 'aes-256-cbc';

/** 初始化向量(IV)固定长度：AES标准规定为16字节(128位) */
const IV_LENGTH = 16;

/**
 * 从字符串密钥派生32字节AES密钥
 * 
 * 使用SHA-256哈希将任意长度的密钥字符串转换为固定的32字节，
 * 确保符合AES-256的密钥长度要求。
 * 
 * @param {string} keyStr - 密钥原始字符串
 * @returns {Buffer} 32字节的派生密钥Buffer
 */
function deriveKey(keyStr) {
  return crypto.createHash('sha256').update(keyStr).digest();
}

/** 从配置密钥派生的最终AES加密密钥（32字节） */
const KEY = deriveKey(ENCRYPTION_KEY);

// ==================== Buffer级别加解密 ====================

/**
 * 对内存中的Buffer数据进行AES-256-CBC加密
 * 
 * 加密流程：
 * 1. 生成16字节随机IV（确保相同数据每次加密结果不同）
 * 2. 创建Cipher实例并执行加密运算
 * 3. 将IV拼接到密文前面（格式: IV + ciphertext）
 * 
 * 返回格式说明：
 * 前16字节是IV，后续字节是加密后的密文数据。
 * 解密时需要先提取前16字节作为IV。
 * 
 * @param {Buffer} buffer - 待加密的原始数据Buffer（如图片二进制数据）
 * @returns {Buffer} 加密后数据（前16字节=IV，后续=AES密文）
 */
function encryptBuffer(buffer) {
  // 生成随机初始化向量
  const iv = crypto.randomBytes(IV_LENGTH);
  
  // 创建加密器实例并执行加密
  const cipher = crypto.createCipheriv(ALGORITHM, KEY, iv);
  const encrypted = Buffer.concat([cipher.update(buffer), cipher.final()]);
  
  // 将IV拼接到密文前端，解密时用于恢复加密器状态
  return Buffer.concat([iv, encrypted]);
}

/**
 * 对加密的Buffer数据进行AES-256-CBC解密
 * 
 * 解密流程：
 * 1. 从输入数据的前16字节提取IV
 * 2. 剩余部分为加密数据
 * 3. 创建Decipher实例执行解密运算
 * 
 * 输入要求：必须是 encryptBuffer 的输出格式（IV+ciphertext）。
 * 若输入数据不是有效的加密数据或IV错误，将抛出异常。
 * 
 * @param {Buffer} buffer - 加密后的数据（格式: [IV(16B)] + [ciphertext]）
 * @returns {Buffer} 解密后的原始数据；若解密失败则抛出异常
 */
function decryptBuffer(buffer) {
  // 分离IV（前16字节）和密文（剩余部分）
  const iv = buffer.subarray(0, IV_LENGTH);
  const encryptedData = buffer.subarray(IV_LENGTH);
  
  // 创建解密器实例并执行解密
  const decipher = crypto.createDecipheriv(ALGORITHM, KEY, iv);
  return Buffer.concat([decipher.update(encryptedData), decipher.final()]);
}

// ==================== 文件级别操作 ====================

/**
 * 加密指定路径的文件（原地覆盖写入）
 * 
 * 操作步骤：
 * 1. 同步读取整个文件到内存
 * 2. 调用encryptBuffer进行加密
 * 3. 将加密结果写回原文件路径（覆盖原文件）
 * 
 * 适用场景：首次部署时的图片加密迁移、新上传图片的即时加密。
 * 注意：大文件会占用较多内存（整个文件读入）。
 * 
 * @param {string} filePath - 要加密的文件绝对/相对路径
 * @returns {boolean} true表示加密成功；false表示失败（异常被内部捕获）
 */
function encryptFile(filePath) {
  try {
    const buffer = fs.readFileSync(filePath);
    const encrypted = encryptBuffer(buffer);
    fs.writeFileSync(filePath, encrypted);
    return true;
  } catch (e) {
    console.error(`加密文件失败 ${filePath}:`, e.message);
    return false;
  }
}

/**
 * 读取并解密文件内容到内存Buffer
 * 
 * 与streamDecryptedFile的区别：此函数返回完整Buffer给调用者，
 * 适用于需要对解密数据进行二次处理的场景。
 * 
 * @param {string} filePath - 已加密文件的路径
 * @returns {Buffer|null} 解密后的原始数据；读取或解密失败返回null
 */
function decryptFileToBuffer(filePath) {
  try {
    const buffer = fs.readFileSync(filePath);
    return decryptBuffer(buffer);
  } catch (e) {
    console.error(`解密文件失败 ${filePath}:`, e.message);
    return null;
  }
}

/**
 * 流式解密文件并将结果直接写入HTTP响应
 * 
 * 设计目的：避免在服务端内存中同时持有大量图片数据的解密缓冲区。
 * 当前实现为同步读取+解密+发送，对于超大文件可考虑改为真正的流式管道。
 * 
 * 设置的响应头：
 * - Content-Type: 根据文件扩展名确定的MIME类型
 * - Content-Length: 解密后数据的精确字节数
 * - Cache-Control: private, no-store（禁止缓存敏感数据）
 * 
 * @param {string} filePath - 已加密文件的磁盘路径
 * @param {import('http').ServerResponse} res - Express响应对象，用于输出解密数据
 * @param {string} contentType - 响应的MIME类型（如'image/jpeg'）
 * @returns {boolean} true表示成功发送；false表示解密过程出错
 */
function streamDecryptedFile(filePath, res, contentType) {
  try {
    const buffer = fs.readFileSync(filePath);
    const decrypted = decryptBuffer(buffer);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', decrypted.length);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Accept-Ranges', 'bytes');
    res.end(decrypted);
    return true;
  } catch (e) {
    console.error(`流式解密失败 ${filePath}:`, e.message);
    return false;
  }
}

/**
 * 支持HTTP Range请求的流式解密（用于视频渐进式加载/seek）
 *
 * 浏览器播放视频时会发送Range头（如 "bytes=0-1023"）实现：
 * - 渐进式加载：先下载前几MB即可开始播放，同时后台继续缓冲
 * - Seek跳转：用户拖动进度条时只请求需要的字节范围
 *
 * 实现方式：先完整解密到内存，再根据Range头截取对应字节段返回。
 * 对于超大文件可后续优化为真正的流式分块解密。
 *
 * @param {string} filePath - 加密文件路径
 * @param {import('http').ServerResponse} res - Express响应对象
 * @param {string} contentType - MIME类型
 * @returns {boolean} 是否成功处理
 */
function streamDecryptedFileWithRange(filePath, res, req, contentType) {
  try {
    const buffer = fs.readFileSync(filePath);
    const decrypted = decryptBuffer(buffer);
    const fileSize = decrypted.length;

    const rangeHeader = req.headers.range;
    if (!rangeHeader) {
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Length', fileSize);
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Cache-Control', 'private, no-store');
      res.end(decrypted);
      return true;
    }

    const parts = rangeHeader.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10) || 0;
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunkSize = end - start + 1;

    if (start >= fileSize) {
      res.writeHead(416, {
        'Content-Range': `bytes */${fileSize}`,
        'Content-Type': contentType
      });
      res.end();
      return true;
    }

    const chunk = decrypted.subarray(start, end + 1);

    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': contentType,
      'Cache-Control': 'private, no-store'
    });
    res.end(chunk);
    return true;
  } catch (e) {
    console.error(`Range流式解密失败 ${filePath}:`, e.message);
    return false;
  }
}

// ==================== 状态检测 ====================

/**
 * 检测指定文件是否已加密
 * 
 * 判断逻辑：
 * 1. 文件大小 < 17字节（IV 16字节 + 至少1字节数据）→ 必然未加密
 * 2. 尝试对文件内容执行decryptBuffer操作
 *    - 成功 → 文件已被正确加密
 *    - 抛出异常 → 文件未加密或损坏
 * 
 * 此方法会实际尝试解密操作，因此对大文件有一定性能开销。
 * 
 * @param {string} filePath - 待检测的文件路径
 * @returns {boolean} true表示文件已加密且可正常解密；false表示未加密或无法解密
 */
function isEncrypted(filePath) {
  try {
    const buffer = fs.readFileSync(filePath);
    if (buffer.length < IV_LENGTH + 1) return false; // 太小不可能是加密文件
    
    // 实际尝试解密来判断是否为有效加密文件
    try {
      decryptBuffer(buffer);
      return true; // 解密成功说明确实是加密文件
    } catch {
      return false; // 解密失败说明不是本系统加密的文件
    }
  } catch {
    return false; // 文件读取失败也视为未加密
  }
}

// ==================== 批量操作 ====================

/**
 * 加密指定目录下所有未加密的图片文件
 * 
 * 遍历目录中的所有文件（非递归），跳过子目录，
 * 对每个普通文件检查是否已加密：
 * - 已加密 → 跳过（skipped计数+1）
 * - 未加密 → 执行encryptFile加密（encrypted/failed计数+1）
 * 
 * 适用场景：应用启动时执行一次性加密迁移，
 *           将旧版明文图片全部转为加密存储。
 * 
 * @param {string} dirPath - 要扫描的目标目录路径
 * @returns {{ total: number, encrypted: number, skipped: number, failed: number }}
 *   统计结果对象：
 *   - total: 目录中文件总数
 *   - encrypted: 本次成功加密的文件数
 *   - skipped: 已经是加密状态跳过的文件数
 *   - failed: 加密过程中出错的文件数
 */
function encryptDirectory(dirPath) {
  const result = { total: 0, encrypted: 0, skipped: 0, failed: 0 };
  
  // 目录不存在则直接返回空结果
  if (!fs.existsSync(dirPath)) return result;

  const files = fs.readdirSync(dirPath);
  for (const file of files) {
    const filePath = path.join(dirPath, file);
    const stat = fs.statSync(filePath);
    
    // 只处理普通文件，跳过子目录
    if (!stat.isFile()) continue;

    result.total++;
    
    // 检查是否已经加密
    if (isEncrypted(filePath)) {
      result.skipped++;
      continue;
    }

    // 执行加密操作
    if (encryptFile(filePath)) {
      result.encrypted++;
    } else {
      result.failed++;
    }
  }
  
  return result;
}

// ==================== 辅助函数 ====================

/**
 * 根据文件扩展名获取对应的 MIME 类型
 * 
 * 映射表覆盖常见图片格式：
 * - .jpg/.jpeg → image/jpeg
 * - .png → image/png
 * - .gif → image/gif
 * - .webp → image/webp
 * - .bmp → image/bmp
 * 
 * 未识别的扩展名返回通用的二进制流类型。
 * 
 * @param {string} ext - 文件扩展名（含点号，如".jpg"）
 * @returns {string} 对应的MIME类型字符串；未知类型返回'application/octet-stream'
 */
function getContentType(ext) {
  const types = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mov': 'video/quicktime',
    '.avi': 'video/x-msvideo',
    '.mkv': 'video/x-matroska'
  };
  return types[ext.toLowerCase()] || 'application/octet-stream';
}

module.exports = {
  encryptBuffer,
  decryptBuffer,
  encryptFile,
  decryptFileToBuffer,
  streamDecryptedFile,
  streamDecryptedFileWithRange,
  isEncrypted,
  encryptDirectory,
  getContentType
};
