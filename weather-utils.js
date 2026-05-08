const https = require('https');
const nodemailer = require('nodemailer');
const { getDb } = require('./database');
const { getUserEmail, addLog } = require('./email-utils');

const SMTP_CONFIG = {
  host: 'smtp.qq.com',
  port: 465,
  secure: true,
  auth: {
    user: '474112265@qq.com',
    pass: 'oxkepqzkqmlxbhic'
  }
};

const FREE_WEATHER_API = 'https://api.open-meteo.com/v1/forecast';

let transporter = null;

function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport(SMTP_CONFIG);
  }
  return transporter;
}

async function fetchWeather(lat, lng) {
  return new Promise((resolve, reject) => {
    const url = `${FREE_WEATHER_API}?latitude=${lat}&longitude=${lng}&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=1`;

    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed);
        } catch (e) {
          reject(new Error('天气数据解析失败: ' + e.message));
        }
      });
    }).on('error', reject);
  });
}

function getWeatherInfo(weatherCode) {
  const code = Number(weatherCode);
  if (code === 0) return { desc: '晴', icon: '☀️', type: 'sunny' };
  if (code === 1) return { desc: '大部晴朗', icon: '🌤️', type: 'sunny' };
  if (code === 2) return { desc: '多云', icon: '⛅', type: 'cloudy' };
  if (code === 3) return { desc: '阴天', icon: '☁️', type: 'cloudy' };
  if ([45, 48].includes(code)) return { desc: '雾', icon: '🌫️', type: 'fog' };
  if ([51, 53, 55].includes(code)) return { desc: '毛毛雨', icon: '🌦️', type: 'drizzle' };
  if ([56, 57].includes(code)) return { desc: '冻毛毛雨', icon: '🌧️', type: 'rain' };
  if ([61, 63, 65].includes(code)) return { desc: '雨', icon: '🌧️', type: 'rain' };
  if ([66, 67].includes(code)) return { desc: '冻雨', icon: '🌧️', type: 'rain' };
  if ([71, 73, 75].includes(code)) return { desc: '雪', icon: '❄️', type: 'snow' };
  if (code === 77) return { desc: '雪粒', icon: '🌨️', type: 'snow' };
  if ([80, 81, 82].includes(code)) return { desc: '阵雨', icon: '🌦️', type: 'rain' };
  if ([85, 86].includes(code)) return { desc: '阵雪', icon: '🌨️', type: 'snow' };
  if (code === 95) return { desc: '雷暴', icon: '⛈️', type: 'thunderstorm' };
  if ([96, 99].includes(code)) return { desc: '雷暴冰雹', icon: '⛈️', type: 'thunderstorm' };
  return { desc: '未知', icon: '🌈', type: 'unknown' };
}

function generateWeatherReminders(weatherInfo, tempMax, tempMin, precipitationProb) {
  const reminders = [];
  const { type, desc } = weatherInfo;

  if (['rain', 'drizzle'].includes(type) || precipitationProb >= 60) {
    reminders.push('宝宝，今天可能会下雨，记得带伞哦！☔');
  }

  if (type === 'snow') {
    reminders.push('宝宝，今天会下雪，出门注意安全，记得保暖哦！❄️');
  }

  if (tempMax >= 35) {
    reminders.push('宝宝，今天太阳很晒，记得防晒哦，不要中暑了！🥵');
  } else if (tempMax >= 30) {
    reminders.push('宝宝，今天天气比较热，注意防暑降温哦！☀️');
  }

  if (tempMin <= 0) {
    reminders.push('宝宝，今天天气很冷，记得多穿衣保暖，不要着凉了哦！🧣');
  } else if (tempMin <= 5) {
    reminders.push('宝宝，今天天气变冷了，记得多穿点衣服，别冻着了！🧥');
  } else if (tempMax <= 15 && tempMin <= 10) {
    reminders.push('宝宝，今天有点凉，记得添件外套哦！🍂');
  }

  if (type === 'thunderstorm') {
    reminders.push('宝宝，今天有雷暴天气，尽量待在室内，注意安全！⚡');
  }

  if (type === 'fog') {
    reminders.push('宝宝，今天有雾，出门注意安全，开车要慢一点哦！🌫️');
  }

  if (reminders.length === 0) {
    if (type === 'sunny') {
      reminders.push('宝宝，今天天气不错，心情也要美美的哦！☀️');
    } else {
      reminders.push('宝宝，今天天气' + desc + '，照顾好自己哦！💕');
    }
  }

  return reminders;
}

function getWeatherEmailTemplate(userName, weatherInfo, tempMax, tempMin, precipitationProb, humidity, windSpeed, locationName) {
  const reminders = generateWeatherReminders(weatherInfo, tempMax, tempMin, precipitationProb);
  const reminderHtml = reminders.map(r => `<p style="margin:0 0 8px;font-size:16px;color:#be185d;font-weight:600;line-height:1.6;">${r}</p>`).join('');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>💕 恋爱记事簿 - 每日天气提醒</title>
</head>
<body style="margin:0;padding:0;background:#fdf2f8;font-family:'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#fdf2f8;min-height:100vh;">
<tr><td align="center" style="padding:40px 16px;">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:20px;overflow:hidden;box-shadow:0 4px 24px rgba(244,114,182,0.12);">

<tr><td style="background:linear-gradient(135deg,#fce7f3,#fbcfe8);padding:32px 24px;text-align:center;">
<div style="font-size:48px;margin-bottom:8px;">${weatherInfo.icon}</div>
<h1 style="margin:0;color:#be185d;font-size:22px;font-weight:600;letter-spacing:0.5px;">恋爱记事簿</h1>
<p style="margin:8px 0 0;color:#9d174d;font-size:14px;opacity:0.8;">今日天气提醒 · ${locationName || '你的城市'}</p>
</td></tr>

<tr><td style="padding:28px;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#fdf2f8;border-radius:12px;margin-bottom:20px;">
<tr>
<td style="padding:16px;text-align:center;width:33%;">
<div style="font-size:28px;margin-bottom:4px;">🌡️</div>
<div style="font-size:13px;color:#9d174d;">温度</div>
<div style="font-size:16px;color:#be185d;font-weight:600;">${tempMin}°~${tempMax}°C</div>
</td>
<td style="padding:16px;text-align:center;width:33%;">
<div style="font-size:28px;margin-bottom:4px;">💧</div>
<div style="font-size:13px;color:#9d174d;">湿度</div>
<div style="font-size:16px;color:#be185d;font-weight:600;">${humidity}%</div>
</td>
<td style="padding:16px;text-align:center;width:33%;">
<div style="font-size:28px;margin-bottom:4px;">💨</div>
<div style="font-size:13px;color:#9d174d;">风速</div>
<div style="font-size:16px;color:#be185d;font-weight:600;">${windSpeed}km/h</div>
</td>
</tr>
</table>

<div style="background:#fff1f2;border-radius:12px;padding:20px;margin-bottom:20px;border-left:4px solid #f472b6;">
<p style="margin:0 0 10px;font-size:14px;color:#9d174d;font-weight:500;">今日天气：${weatherInfo.icon} ${weatherInfo.desc}${precipitationProb > 0 ? ' · 降水概率 ' + precipitationProb + '%' : ''}</p>
${reminderHtml}
</div>

<p style="margin:0;font-size:14px;color:#6b7280;line-height:1.8;">新的一天开始啦，记得吃早餐，照顾好自己哦～💕</p>
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

async function sendWeatherEmail(toEmail, userName, lat, lng, locationName) {
  try {
    const weatherData = await fetchWeather(lat, lng);
    const current = weatherData.current || {};
    const daily = weatherData.daily || {};

    const weatherCode = current.weather_code !== undefined ? current.weather_code : (daily.weather_code ? daily.weather_code[0] : 0);
    const weatherInfo = getWeatherInfo(weatherCode);
    const tempMax = daily.temperature_2m_max ? Math.round(daily.temperature_2m_max[0]) : '--';
    const tempMin = daily.temperature_2m_min ? Math.round(daily.temperature_2m_min[0]) : '--';
    const precipitationProb = daily.precipitation_probability_max ? daily.precipitation_probability_max[0] : 0;
    const humidity = current.relative_humidity_2m || '--';
    const windSpeed = current.wind_speed_10m ? Math.round(current.wind_speed_10m) : '--';

    const transport = getTransporter();
    const info = await transport.sendMail({
      from: '"💕 恋爱记事簿" <474112265@qq.com>',
      to: toEmail,
      subject: `${weatherInfo.icon} 宝宝，今日天气提醒～`,
      html: getWeatherEmailTemplate(userName, weatherInfo, tempMax, tempMin, precipitationProb, humidity, windSpeed, locationName)
    });

    addLog('success', '天气提醒邮件发送成功', `收件人: ${toEmail.substring(0, 3)}***, 天气: ${weatherInfo.desc}`);
    return { success: true, messageId: info.messageId };
  } catch (err) {
    addLog('error', '天气提醒邮件发送失败', err.message);
    return { success: false, error: err.message };
  }
}

async function sendDailyWeatherReminders() {
  const db = getDb();
  const users = db.prepare(
    'SELECT id, display_name, email_encrypted, email_iv, location_lat, location_lng, location_name FROM users WHERE weather_reminder = 1 AND location_lat IS NOT NULL AND email_encrypted IS NOT NULL'
  ).all();

  if (users.length === 0) {
    addLog('info', '天气提醒：无符合条件的用户', '');
    return;
  }

  for (const user of users) {
    try {
      const email = getUserEmail(user.id);
      if (!email) continue;

      await sendWeatherEmail(email, user.display_name, user.location_lat, user.location_lng, user.location_name);
    } catch (err) {
      addLog('error', `天气提醒发送失败(用户:${user.display_name})`, err.message);
    }
  }
}

function startWeatherScheduler() {
  function scheduleNext() {
    const now = new Date();
    const target = new Date(now);
    target.setHours(8, 0, 0, 0);
    if (now >= target) {
      target.setDate(target.getDate() + 1);
    }
    const delay = target.getTime() - now.getTime();

    addLog('info', '天气提醒调度器已启动', `下次发送: ${target.toLocaleString('zh-CN')}`);

    setTimeout(async () => {
      try {
        await sendDailyWeatherReminders();
      } catch (err) {
        addLog('error', '天气提醒调度执行异常', err.message);
      }
      scheduleNext();
    }, delay);
  }

  scheduleNext();
}

function saveUserLocation(userId, lat, lng, name) {
  const db = getDb();
  db.prepare('UPDATE users SET location_lat = ?, location_lng = ?, location_name = ? WHERE id = ?')
    .run(lat, lng, name, userId);
  addLog('info', '用户位置已保存', `userId: ${userId}, 位置: ${name}`);
  return { success: true };
}

function getUserLocation(userId) {
  const db = getDb();
  const user = db.prepare('SELECT location_lat, location_lng, location_name FROM users WHERE id = ?').get(userId);
  if (!user || user.location_lat === null) {
    return null;
  }
  return {
    lat: user.location_lat,
    lng: user.location_lng,
    name: user.location_name || ''
  };
}

function saveWeatherReminder(userId, enabled) {
  const db = getDb();
  db.prepare('UPDATE users SET weather_reminder = ? WHERE id = ?').run(enabled ? 1 : 0, userId);
  addLog('info', '天气提醒设置已更新', `userId: ${userId}, 状态: ${enabled ? '开启' : '关闭'}`);
  return { success: true };
}

function getWeatherReminder(userId) {
  const db = getDb();
  const user = db.prepare('SELECT weather_reminder FROM users WHERE id = ?').get(userId);
  return user ? !!user.weather_reminder : false;
}

module.exports = {
  fetchWeather,
  getWeatherInfo,
  generateWeatherReminders,
  sendWeatherEmail,
  sendDailyWeatherReminders,
  startWeatherScheduler,
  saveUserLocation,
  getUserLocation,
  saveWeatherReminderSetting: saveWeatherReminder,
  getWeatherReminderSetting: getWeatherReminder
};
