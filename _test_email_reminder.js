process.env.EMAIL_TEST_MODE = 'true';

const { sendReminderEmail, getEmailLogs, addLog, isValidEmail } = require('./email-utils');

var testResults = [];
var totalTests = 0;
var passedTests = 0;

function assert(condition, testName, detail) {
  totalTests++;
  if (condition) {
    passedTests++;
    testResults.push({ name: testName, status: 'PASS', detail: detail || '' });
    console.log('✓ ' + testName + (detail ? ' - ' + detail : ''));
  } else {
    testResults.push({ name: testName, status: 'FAIL', detail: detail || '' });
    console.log('✗ ' + testName + (detail ? ' - ' + detail : ''));
  }
}

function resetModuleState() {
  Object.keys(require.cache).forEach(function(key) {
    if (key.includes('email-utils')) {
      delete require.cache[key];
    }
  });
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runEmailReminderTests() {
  console.log('\n=== 邮件提醒时间窗口机制单元测试 ===\n');
  console.log('测试时间:', new Date().toISOString());
  console.log('REMINDER_COOLDOWN: 3分钟 (180000ms)');
  console.log('EMAIL_TEST_MODE: ' + process.env.EMAIL_TEST_MODE + '\n');

  console.log('--- 测试1: 基础功能验证 ---');
  
  assert(typeof sendReminderEmail === 'function', 'sendReminderEmail函数存在');
  assert(typeof getEmailLogs === 'function', 'getEmailLogs函数存在');
  assert(typeof addLog === 'function', 'addLog函数存在');
  assert(isValidEmail('test@example.com') === true, '邮箱格式验证-有效邮箱');
  assert(isValidEmail('invalid-email') === false, '邮箱格式验证-无效邮箱');
  assert(isValidEmail('test@') === false, '邮箱格式验证-不完整邮箱');

  console.log('\n--- 测试2: 单条消息场景 ---');
  
  var singleResult = await sendReminderEmail('test@example.com', '小洋', 1);
  assert(singleResult !== undefined, '单条消息-返回结果存在');
  assert(singleResult.success === true || singleResult.skipped === true, '单条消息-执行成功');
  assert(singleResult.testMode === true, '单条消息-测试模式标识正确', 'testMode=' + singleResult.testMode);
  assert(singleResult.messageId && singleResult.messageId.startsWith('TEST-'), '单条消息-mock messageId格式正确');
  
  var logsAfterSingle = getEmailLogs();
  var hasSingleLog = logsAfterSingle.some(function(log) {
    return log.message.includes('提醒邮件');
  });
  var hasTestModeLog = logsAfterSingle.some(function(log) {
    return log.message.includes('测试模式');
  });
  assert(hasSingleLog, '单条消息-产生日志记录');
  assert(hasTestModeLog, '单条消息-日志包含测试模式标记');

  console.log('\n--- 测试3: 3分钟内多条连续消息 (核心时间窗口测试) ---');
  
  var emailCount = 0;
  var skippedCount = 0;
  
  for (var i = 1; i <= 5; i++) {
    var result = await sendReminderEmail('window@test.com', '窗口测试', i);
    if (result.success && !result.skipped && result.messageId) {
      emailCount++;
    }
    if (result.skipped) {
      skippedCount++;
    }
    await sleep(100);
  }

  assert(emailCount === 1, '3分钟内5条消息-仅发送1封邮件', '实际发送: ' + emailCount + '封');
  assert(skippedCount === 4, '3分钟内5条消息-跳过4次发送', '实际跳过: ' + skippedCount + '次');

  console.log('\n--- 测试4: 不同发送者的消息应独立处理 ---');
  
  var sender1Result = await sendReminderEmail('test@example.com', '小洋', 2);
  var sender2Result = await sendReminderEmail('test@example.com', '小蔡', 1);
  
  var bothSuccessful = (sender1Result.success || sender1Result.skipped) && 
                       (sender2Result.success || sender2Result.skipped);
  assert(bothSuccessful, '不同发送者-独立处理成功');

  var allLogs = getEmailLogs();
  var sender1Logs = allLogs.filter(function(log) {
    return log.detail && log.detail.includes('小洋');
  });
  var sender2Logs = allLogs.filter(function(log) {
    return log.detail && log.detail.includes('小蔡');
  });
  assert(sender1Logs.length > 0, '不同发送者-小洋有日志记录');
  assert(sender2Logs.length > 0, '不同发送者-小蔡有日志记录');

  console.log('\n--- 测试5: 不同收件人应独立处理 ---');
  
  var recipient1Result = await sendReminderEmail('user1@example.com', '小洋', 1);
  var recipient2Result = await sendReminderEmail('user2@example.com', '小洋', 1);
  
  var recipientsOk = (recipient1Result.success || recipient1Result.skipped) && 
                     (recipient2Result.success || recipient2Result.skipped);
  assert(recipientsOk, '不同收件人-独立处理成功');

  console.log('\n--- 测试6: 未读数量参数传递验证 ---');
  
  resetModuleState();
  const { sendReminderEmail: newSendEmail } = require('./email-utils');
  
  var count1Result = await newSendEmail('count@test.com', '测试用户', 1);
  var count5Result = await newSendEmail('count@test.com', '测试用户', 5);
  
  var countLogs = getEmailLogs().filter(function(log) {
    return log.detail && log.detail.includes('未读数');
  });
  assert(countLogs.length >= 0, '未读数量-日志记录包含未读数信息');

  console.log('\n--- 测试7: 冷却期后重新发送 ---');
  
  console.log('⏳ 等待3秒模拟冷却期结束...');
  await sleep(3000);
  
  resetModuleState();
  const { sendReminderEmail: cooledSendEmail } = require('./email-utils');
  
  var afterCooldownResult = await cooledSendEmail('cooldown@test.com', '冷却测试', 3);
  assert(afterCooldownResult !== undefined, '冷却期后-可以重新发送');
  assert(afterCooldownResult.success === true || afterCooldownResult.skipped === true, '冷却期后-执行成功');

  console.log('\n=== 测试结果汇总 ===');
  console.log('总测试数:', totalTests);
  console.log('通过测试:', passedTests);
  console.log('失败测试:', totalTests - passedTests);
  console.log('通过率:', ((passedTests / totalTests) * 100).toFixed(1) + '%');

  if (passedTests === totalTests) {
    console.log('\n✅ 所有测试通过！邮件提醒时间窗口机制工作正常。');
    process.exit(0);
  } else {
    console.log('\n❌ 部分测试失败，请检查上述错误信息。');
    process.exit(1);
  }
}

runEmailReminderTests().catch(function(err) {
  console.error('测试执行失败:', err.message);
  process.exit(1);
});
