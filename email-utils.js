const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { getDb } = require('./database');

const ENCRYPTION_KEY = process.env.IMAGE_ENCRYPTION_KEY || 'love-diary-default-encryption-key-2024';
const KEY = crypto.createHash('sha256').update(ENCRYPTION_KEY).digest();
const IV_LENGTH = 16;
const ALGORITHM = 'aes-256-cbc';

const SMTP_CONFIG = {
  host: 'smtp.qq.com',
  port: 465,
  secure: true,
  auth: {
    user: '474112265@qq.com',
    pass: 'oxkepqzkqmlxbhic'
  }
};

const REMINDER_COOLDOWN = 3 * 60 * 1000;
const REMINDER_DELAY = 1 * 60 * 1000;
const TEST_MODE = process.env.EMAIL_TEST_MODE === 'true';

const emailLog = [];
const MAX_LOG_ENTRIES = 200;

const lastReminderSent = {};
const reminderWindowTracker = {};

let transporter = null;

function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport(SMTP_CONFIG);
  }
  return transporter;
}

function encryptEmail(email) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, KEY, iv);
  const encrypted = Buffer.concat([cipher.update(email, 'utf8'), cipher.final()]);
  return {
    encrypted: encrypted.toString('base64'),
    iv: iv.toString('base64')
  };
}

function decryptEmail(encrypted, ivBase64) {
  try {
    const iv = Buffer.from(ivBase64, 'base64');
    const encryptedBuf = Buffer.from(encrypted, 'base64');
    const decipher = crypto.createDecipheriv(ALGORITHM, KEY, iv);
    const decrypted = Buffer.concat([decipher.update(encryptedBuf), decipher.final()]);
    return decrypted.toString('utf8');
  } catch (e) {
    console.error('[邮箱] 解密失败:', e.message);
    return null;
  }
}

function addLog(type, message, detail) {
  const entry = {
    time: new Date().toISOString(),
    type,
    message,
    detail: detail || ''
  };
  emailLog.unshift(entry);
  if (emailLog.length > MAX_LOG_ENTRIES) {
    emailLog.length = MAX_LOG_ENTRIES;
  }
  if (type === 'error') {
    console.error(`[邮箱] ${message}`, detail || '');
  } else {
    console.log(`[邮箱] ${message}`, detail || '');
  }
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function getEmailTemplate(senderName, unreadCount = 1) {
  const messageText = unreadCount > 1 
    ? `宝宝，你还有${unreadCount}条消息没有回复我呢！` 
    : '宝宝，你还有新的消息没有回复我呢！';
  
  const detailText = unreadCount > 1 
    ? `你的另一半给你发了${unreadCount}条消息，正在等你回复哦～快去看看吧！💌`
    : '你的另一半正在等你回复哦～快去看看吧！💌';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>💕 恋爱记事簿 - 新消息提醒</title>
</head>
<body style="margin:0;padding:0;background:#fdf2f8;font-family:'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#fdf2f8;min-height:100vh;">
<tr><td align="center" style="padding:40px 16px;">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:20px;overflow:hidden;box-shadow:0 4px 24px rgba(244,114,182,0.12);">

<tr><td style="background:linear-gradient(135deg,#fce7f3,#fbcfe8);padding:32px 24px;text-align:center;">
<div style="font-size:48px;margin-bottom:8px;">💕</div>
<h1 style="margin:0;color:#be185d;font-size:22px;font-weight:600;letter-spacing:0.5px;">恋爱记事簿</h1>
<p style="margin:8px 0 0;color:#9d174d;font-size:14px;opacity:0.8;">记录我们的甜蜜时光</p>
</td></tr>

<tr><td style="padding:32px 28px;">
<div style="background:#fdf2f8;border-radius:12px;padding:20px;margin-bottom:24px;border-left:4px solid #f472b6;">
<p style="margin:0 0 8px;font-size:14px;color:#9d174d;font-weight:500;">${senderName} 给你发了新消息</p>
<p style="margin:0;font-size:18px;color:#be185d;font-weight:600;line-height:1.6;">${messageText}</p>
</div>
<p style="margin:0 0 24px;font-size:14px;color:#6b7280;line-height:1.8;">${detailText}</p>
<table width="100%" cellpadding="0" cellspacing="0">
<tr><td align="center">
<a href="http://106.52.180.78:520/" style="display:inline-block;background:linear-gradient(135deg,#ec4899,#f472b6);color:#ffffff;text-decoration:none;padding:14px 40px;border-radius:50px;font-size:16px;font-weight:600;letter-spacing:0.5px;box-shadow:0 4px 12px rgba(236,72,153,0.3);">💕 去回复Ta</a>
</td></tr>
</table>
</td></tr>

<tr><td style="background:#fdf2f8;padding:20px 28px;text-align:center;">
<p style="margin:0;font-size:12px;color:#9ca3af;line-height:1.6;">此邮件由恋爱记事簿自动发送<br>💕 愿你们的爱情甜蜜长久 💕</p>
</td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}

async function saveUserEmail(userId, email) {
  const db = getDb();
  if (!email || email.trim() === '') {
    db.prepare('UPDATE users SET email_encrypted = NULL, email_iv = NULL WHERE id = ?').run(userId);
    addLog('info', '用户邮箱已清除', `userId: ${userId}`);
    return { success: true, email: '' };
  }

  if (!isValidEmail(email)) {
    return { success: false, error: '邮箱格式不正确' };
  }

  const { encrypted, iv } = encryptEmail(email.trim().toLowerCase());
  db.prepare('UPDATE users SET email_encrypted = ?, email_iv = ? WHERE id = ?').run(encrypted, iv, userId);
  addLog('info', '用户邮箱已保存', `userId: ${userId}`);
  return { success: true, email: email.trim().toLowerCase() };
}

function getUserEmail(userId) {
  const db = getDb();
  const user = db.prepare('SELECT email_encrypted, email_iv FROM users WHERE id = ?').get(userId);
  if (!user || !user.email_encrypted || !user.email_iv) {
    return null;
  }
  return decryptEmail(user.email_encrypted, user.email_iv);
}

async function sendReminderEmail(toEmail, senderName, unreadCount = 1) {
  const cooldownKey = `${toEmail}_${senderName}`;
  const now = Date.now();

  if (lastReminderSent[cooldownKey] && (now - lastReminderSent[cooldownKey]) < REMINDER_COOLDOWN) {
    addLog('info', '邮件冷却中，跳过发送', `收件人: ${toEmail.substring(0, 3)}***, 发送者: ${senderName}`);
    return { success: true, skipped: true };
  }

  try {
    if (TEST_MODE) {
      const mockMessageId = `TEST-${Date.now()}-${Math.random().toString(36).substr(2, 9)}@mock`;
      lastReminderSent[cooldownKey] = now;
      addLog('success', '[测试模式] 提醒邮件发送成功（模拟）', `收件人: ${toEmail.substring(0, 3)}***, 发送者: ${senderName}, 未读数: ${unreadCount}, messageId: ${mockMessageId}`);
      return { success: true, messageId: mockMessageId, testMode: true };
    }

    const transport = getTransporter();
    const info = await transport.sendMail({
      from: '"💕 恋爱记事簿" <474112265@qq.com>',
      to: toEmail,
      subject: unreadCount > 1 
        ? `💕 宝宝，你有${unreadCount}条新消息未回复哦～` 
        : '💕 宝宝，你有新的消息未回复哦～',
      html: getEmailTemplate(senderName, unreadCount)
    });

    lastReminderSent[cooldownKey] = now;
    addLog('success', '提醒邮件发送成功', `收件人: ${toEmail.substring(0, 3)}***, 发送者: ${senderName}, 未读数: ${unreadCount}, messageId: ${info.messageId}`);
    return { success: true, messageId: info.messageId };
  } catch (err) {
    addLog('error', '提醒邮件发送失败', err.message);
    return { success: false, error: err.message };
  }
}

function checkUnreadReminders() {
  const db = getDb();
  const delayThreshold = new Date(Date.now() - REMINDER_DELAY).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '').replace(/Z$/, '');

  const unreadMessages = db.prepare(
    `SELECT m.id, m.sender, m.created_at, m.is_read,
            u.id as receiver_id, u.display_name as receiver_name
     FROM messages m
     CROSS JOIN users u
     WHERE m.is_read = 0
       AND m.created_at <= ?
       AND u.display_name != m.sender
     ORDER BY m.created_at ASC`
  ).all(delayThreshold);

  if (unreadMessages.length === 0) return;

  const reminderMap = {};
  unreadMessages.forEach(msg => {
    const key = `${msg.receiver_id}_${msg.sender}`;
    if (!reminderMap[key]) {
      reminderMap[key] = {
        receiverId: msg.receiver_id,
        receiverName: msg.receiver_name,
        senderName: msg.sender,
        messageIds: [msg.id],
        earliestTime: msg.created_at,
        latestTime: msg.created_at,
        count: 1
      };
    } else {
      reminderMap[key].messageIds.push(msg.id);
      reminderMap[key].latestTime = msg.created_at;
      reminderMap[key].count++;
    }
  });

  Object.values(reminderMap).forEach(async (reminder) => {
    const email = getUserEmail(reminder.receiverId);
    if (!email) return;

    const stillUnread = db.prepare(
      `SELECT COUNT(*) as count, MAX(created_at) as latest_time 
       FROM messages 
       WHERE is_read = 0 AND sender = ?`
    ).get(reminder.senderName);

    if (stillUnread.count === 0) return;

    const trackerKey = `${email}_${reminder.senderName}`;
    const lastTrackedTime = reminderWindowTracker[trackerKey];

    const currentTime = new Date(reminder.latestTime).getTime();
    const lastTrackedTimestamp = lastTrackedTime ? new Date(lastTrackedTime).getTime() : 0;

    if (lastTrackedTime && currentTime <= lastTrackedTimestamp) {
      addLog('info', '时间窗口内，跳过提醒', `发送者: ${reminder.senderName}, 上次追踪时间: ${lastTrackedTime}, 当前最新: ${reminder.latestTime}`);
      return;
    }

    await sendReminderEmail(email, reminder.senderName, stillUnread.count);

    reminderWindowTracker[trackerKey] = reminder.latestTime;
    addLog('info', '更新时间窗口追踪', `发送者: ${reminder.senderName}, 追踪至: ${reminder.latestTime}`);
  });
}

function startReminderScheduler() {
  setInterval(checkUnreadReminders, 60 * 1000);
  addLog('info', '邮件提醒调度器已启动', '每60秒检查一次');
}

function getEmailLogs(limit) {
  return emailLog.slice(0, limit || 50);
}

module.exports = {
  saveUserEmail,
  getUserEmail,
  sendReminderEmail,
  startReminderScheduler,
  getEmailLogs,
  isValidEmail,
  encryptEmail,
  decryptEmail,
  addLog
};
