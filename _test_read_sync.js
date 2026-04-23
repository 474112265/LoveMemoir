var http = require('http');

function request(method, path, body, token, csrfToken) {
  return new Promise(function(resolve, reject) {
    var bodyStr = body ? JSON.stringify(body) : '';
    var opts = {
      hostname: 'localhost',
      port: 520,
      path: path,
      method: method,
      headers: { 'Content-Type': 'application/json' }
    };
    if (bodyStr) opts.headers['Content-Length'] = Buffer.byteLength(bodyStr);
    if (token) opts.headers['Authorization'] = 'Bearer ' + token;
    if (csrfToken) opts.headers['x-csrf-token'] = csrfToken;

    var req = http.request(opts, function(res) {
      var d = '';
      res.on('data', function(c) { d += c; });
      res.on('end', function() {
        try { resolve({ status: res.statusCode, data: JSON.parse(d) }); }
        catch(e) { resolve({ status: res.statusCode, data: d }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, function() { req.destroy(new Error('timeout')); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function pollRequest(token, afterId, lastReadCheck) {
  return new Promise(function(resolve, reject) {
    var path = '/api/messages/poll?after_id=' + afterId + '&timeout=3000';
    if (lastReadCheck) path += '&last_read_check=' + encodeURIComponent(lastReadCheck);
    var opts = {
      hostname: 'localhost',
      port: 520,
      path: path,
      method: 'GET',
      headers: { 'Authorization': 'Bearer ' + token }
    };
    var req = http.request(opts, function(res) {
      var d = '';
      res.on('data', function(c) { d += c; });
      res.on('end', function() {
        try { resolve({ status: res.statusCode, data: JSON.parse(d) }); }
        catch(e) { resolve({ status: res.statusCode, data: d }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, function() { req.destroy(new Error('timeout')); });
    req.end();
  });
}

function isoToSqlite(isoStr) {
  if (!isoStr) return '';
  return isoStr.replace('T', ' ').replace(/\.\d+Z$/, '').replace(/Z$/, '');
}

async function runTests() {
  console.log('=== 实时已读状态同步集成测试 ===\n');

  var login1 = await request('POST', '/api/login', { username: 'xiaozhong', password: 'love1314' });
  var token1 = login1.data.token;
  console.log('[1] 小洋登录:', login1.status === 200 ? 'PASS' : 'FAIL');

  var login2 = await request('POST', '/api/login', { username: 'xiaocai', password: 'love1314' });
  var token2 = login2.data.token;
  console.log('[2] 小蔡登录:', login2.status === 200 ? 'PASS' : 'FAIL');

  console.log('\n--- 测试A: ISO→SQLite时间戳转换 ---');
  var testConversions = [
    { input: '2026-04-22T05:07:24.123Z', expected: '2026-04-22 05:07:24' },
    { input: '2026-04-22T12:30:00Z', expected: '2026-04-22 12:30:00' },
    { input: '2026-04-22T12:30:00', expected: '2026-04-22 12:30:00' },
    { input: '', expected: '' }
  ];
  var allPass = true;
  testConversions.forEach(function(tc) {
    var result = isoToSqlite(tc.input);
    var pass = result === tc.expected;
    if (!pass) allPass = false;
    console.log('  ' + JSON.stringify(tc.input) + ' => "' + result + '" ' + (pass ? 'PASS' : 'FAIL expected="' + tc.expected + '"'));
  });
  console.log('[3] 时间戳转换:', allPass ? 'PASS' : 'FAIL');

  console.log('\n--- 测试B: 发送新消息(未读) ---');
  var csrfRes1 = await request('GET', '/api/csrf-token', null, token1);
  var csrf1 = csrfRes1.data.csrfToken;
  console.log('[4] 获取CSRF token:', csrf1 ? 'PASS' : 'FAIL');

  var sendRes = await request('POST', '/api/messages', {
    content: '测试已读同步消息_' + Date.now(),
    sender: '小洋'
  }, token1, csrf1);
  console.log('[5] 发送消息:', sendRes.status === 200 ? 'PASS' : 'FAIL', 'id=' + (sendRes.data.id || ''));

  var newMsgId = sendRes.data.id;

  console.log('\n--- 测试C: 验证新消息为未读 ---');
  var msgsCheck = await request('GET', '/api/messages?limit=5', null, token1);
  var newMsg = msgsCheck.data.find(function(m) { return m.id === newMsgId; });
  if (newMsg) {
    console.log('[6] 新消息is_read=' + newMsg.is_read + ', read_at=' + newMsg.read_at);
    console.log('[7] 新消息为未读:', newMsg.is_read === 0 ? 'PASS' : 'FAIL');
  } else {
    console.log('[6-7] 找不到新消息: FAIL');
  }

  console.log('\n--- 测试D: 小蔡标记消息为已读 ---');
  var csrfRes2 = await request('GET', '/api/csrf-token', null, token2);
  var csrf2 = csrfRes2.data.csrfToken;
  console.log('[8] 获取CSRF token2:', csrf2 ? 'PASS' : 'FAIL');

  var markRes = await request('POST', '/api/messages/read', {
    message_ids: [newMsgId]
  }, token2, csrf2);
  console.log('[9] 标记已读:', markRes.status === 200 ? 'PASS' : 'FAIL');
  console.log('  updated=' + markRes.data.updated + ', read_at=' + markRes.data.read_at);

  var markReadAt = markRes.data.read_at;
  var markSqliteTime = isoToSqlite(markReadAt);
  console.log('[10] read_at转换: ' + markReadAt + ' => ' + markSqliteTime);

  console.log('\n--- 测试E: 小洋长轮询检测已读变化(带last_read_check) ---');
  await new Promise(function(r) { setTimeout(r, 1500); });

  var lastId = msgsCheck.data[msgsCheck.data.length - 1].id;
  var pollRes = await pollRequest(token1, lastId, markReadAt);
  console.log('[11] 长轮询响应:', pollRes.status === 200 ? 'PASS' : 'FAIL');
  console.log('  server_time:', pollRes.data.server_time || '缺失');
  console.log('  read_changes:', pollRes.data.read_changes ? JSON.stringify(pollRes.data.read_changes) : 'null');

  if (pollRes.data.read_changes && pollRes.data.read_changes.length > 0) {
    var found = pollRes.data.read_changes.some(function(c) {
      return c.id === newMsgId && c.is_read === 1;
    });
    console.log('[12] 检测到目标消息已读变化:', found ? 'PASS' : 'FAIL');
  } else {
    console.log('[12] 检测到目标消息已读变化: FAIL (无read_changes返回)');
  }

  console.log('\n--- 测试F: 无last_read_check时检测最近已读变化 ---');
  var pollRes2 = await pollRequest(token1, lastId, '');
  console.log('[13] 无last_read_check轮询:', pollRes2.status === 200 ? 'PASS' : 'FAIL');
  if (pollRes2.data.read_changes && pollRes2.data.read_changes.length > 0) {
    var found2 = pollRes2.data.read_changes.some(function(c) {
      return c.id === newMsgId && c.is_read === 1;
    });
    console.log('[14] 检测到最近已读变化:', found2 ? 'PASS' : 'FAIL');
  } else {
    console.log('[14] 检测到最近已读变化: FAIL (无read_changes)');
  }

  console.log('\n--- 测试G: server_time字段 ---');
  console.log('[15] server_time存在:', pollRes.data.server_time ? 'PASS' : 'FAIL');
  if (pollRes.data.server_time) {
    var st = new Date(pollRes.data.server_time);
    console.log('[16] server_time可解析:', !isNaN(st.getTime()) ? 'PASS' : 'FAIL');
  }

  console.log('\n--- 测试H: 完整链路验证(发送→标记已读→轮询检测) ---');
  var csrf3 = (await request('GET', '/api/csrf-token', null, token1)).data.csrfToken;
  var sendRes2 = await request('POST', '/api/messages', {
    content: '完整链路测试_' + Date.now(),
    sender: '小洋'
  }, token1, csrf3);
  var msgId2 = sendRes2.data.id;
  console.log('[17] 发送第二条消息:', sendRes2.status === 200 ? 'PASS' : 'FAIL', 'id=' + msgId2);

  var beforeMark = new Date().toISOString();
  await new Promise(function(r) { setTimeout(r, 500); });

  var csrf4 = (await request('GET', '/api/csrf-token', null, token2)).data.csrfToken;
  var markRes2 = await request('POST', '/api/messages/read', {
    message_ids: [msgId2]
  }, token2, csrf4);
  console.log('[18] 标记第二条已读:', markRes2.status === 200 ? 'PASS' : 'FAIL');

  await new Promise(function(r) { setTimeout(r, 1500); });

  var msgsAfter = await request('GET', '/api/messages?limit=5', null, token1);
  var msg2After = msgsAfter.data.find(function(m) { return m.id === msgId2; });
  if (msg2After) {
    console.log('[19] 第二条消息最终状态: is_read=' + msg2After.is_read + ', read_at=' + msg2After.read_at);
    console.log('[20] 消息已正确标记已读:', msg2After.is_read === 1 ? 'PASS' : 'FAIL');
  } else {
    console.log('[19-20] 找不到第二条消息: FAIL');
  }

  var pollRes3 = await pollRequest(token1, msgsAfter.data[msgsAfter.data.length - 1].id, beforeMark);
  if (pollRes3.data.read_changes && pollRes3.data.read_changes.length > 0) {
    var found3 = pollRes3.data.read_changes.some(function(c) {
      return c.id === msgId2 && c.is_read === 1;
    });
    console.log('[21] 长轮询检测到第二条已读:', found3 ? 'PASS' : 'FAIL');
  } else {
    console.log('[21] 长轮询检测到第二条已读: FAIL (无read_changes)');
  }

  console.log('\n=== 所有集成测试完成 ===');
}

runTests().catch(function(e) { console.error('测试异常:', e.message); });
