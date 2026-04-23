var http = require('http');

function request(method, path, body, token) {
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

    var req = http.request(opts, function(res) {
      var d = '';
      res.on('data', function(c) { d += c; });
      res.on('end', function() {
        try { resolve({ status: res.statusCode, data: JSON.parse(d) }); }
        catch(e) { resolve({ status: res.statusCode, data: d }); }
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function runTests() {
  console.log('=== 已读/未读功能修复验证 ===\n');

  var login1 = await request('POST', '/api/login', { username: 'xiaozhong', password: 'love1314' });
  var token1 = login1.data.token;
  console.log('[1] 小洋登录:', login1.status === 200 ? 'PASS' : 'FAIL');

  var login2 = await request('POST', '/api/login', { username: 'xiaocai', password: 'love1314' });
  var token2 = login2.data.token;
  console.log('[2] 小蔡登录:', login2.status === 200 ? 'PASS' : 'FAIL');

  var unreadBefore = await request('GET', '/api/messages/unread-count', null, token1);
  console.log('[3] 未读计数API:', unreadBefore.status === 200 ? 'PASS' : 'FAIL', 'count=' + (unreadBefore.data.unread_count || 0));

  var msgs = await request('GET', '/api/messages?limit=5', null, token1);
  console.log('[4] 消息列表API:', msgs.status === 200 ? 'PASS' : 'FAIL', 'count=' + (msgs.data.length || 0));

  if (msgs.data.length > 0) {
    var firstMsg = msgs.data[0];
    console.log('[5] 消息含is_read字段:', firstMsg.hasOwnProperty('is_read') ? 'PASS' : 'FAIL', 'is_read=' + firstMsg.is_read);
    console.log('[6] 消息含read_at字段:', firstMsg.hasOwnProperty('read_at') ? 'PASS' : 'FAIL', 'read_at=' + firstMsg.read_at);
  }

  var unreadMsgs = msgs.data.filter(function(m) { return m.is_read === 0; });
  if (unreadMsgs.length > 0) {
    var markResult = await request('POST', '/api/messages/read', { message_ids: [unreadMsgs[0].id] }, token1);
    console.log('[7] 标记已读API:', markResult.status === 200 ? 'PASS' : 'FAIL', 'updated=' + (markResult.data.updated || 0));
    console.log('[8] 返回read_at时间戳:', markResult.data.read_at ? 'PASS' : 'FAIL', 'read_at=' + markResult.data.read_at);

    if (markResult.data.read_at) {
      var readAtStr = markResult.data.read_at;
      var hasT = readAtStr.includes('T');
      console.log('[9] read_at含时区T:', hasT ? 'PASS (ISO格式)' : 'WARN (SQLite格式)');
    }
  } else {
    console.log('[7-9] 跳过: 无未读消息可标记');
  }

  var unreadAfter = await request('GET', '/api/messages/unread-count', null, token1);
  console.log('[10] 标记后未读计数:', unreadAfter.status === 200 ? 'PASS' : 'FAIL', 'count=' + (unreadAfter.data.unread_count || 0));

  console.log('\n=== formatReadTime 日期解析验证 ===');
  function formatReadTime(dateStr) {
    if (!dateStr) return '';
    var date;
    if (typeof dateStr === 'string' && dateStr.includes('T')) {
      date = new Date(dateStr);
    } else {
      date = new Date(dateStr + 'Z');
    }
    if (isNaN(date.getTime())) return '';
    var hm = String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0');
    return hm;
  }

  var testCases = [
    { input: '2026-04-22T10:30:00.000Z', desc: 'ISO格式含T' },
    { input: '2026-04-22 10:30:00', desc: 'SQLite格式无T' },
    { input: null, desc: 'null值' },
    { input: undefined, desc: 'undefined值' },
    { input: '', desc: '空字符串' },
    { input: '2026-04-22T10:30:00', desc: 'ISO格式无Z' }
  ];

  testCases.forEach(function(tc) {
    var result = formatReadTime(tc.input);
    var hasNaN = result.includes('NaN');
    console.log('  ' + tc.desc + ': input=' + JSON.stringify(tc.input) + ' => output="' + result + '" ' + (hasNaN ? 'FAIL (NaN!)' : 'PASS'));
  });

  console.log('\n=== 所有测试完成 ===');
}

runTests().catch(function(e) { console.error('测试异常:', e.message); });
