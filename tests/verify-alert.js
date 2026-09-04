// 验证 Phase 3：监控告警（三个触发点 + 防抖）
// 前置：mock-upstream.js 跑在 8899；告警池 8895（config.alert.json）、全死池 8896（config.alert-dead.json）
// 用法：node tests/verify-alert.js
'use strict';
const http = require('http');

function req(port, method, path, headers, body) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = { method, path, host: '127.0.0.1', port, headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}) };
    if (data) opts.headers['Content-Length'] = Buffer.byteLength(data);
    const r = http.request(opts, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => { let j = null; try { j = JSON.parse(buf); } catch (_) {} resolve({ status: res.statusCode, data: j }); });
    });
    r.on('error', (e) => resolve({ status: -1, data: null, error: e.message }));
    if (data) r.write(data);
    r.end();
  });
}
const chat = (port, auth, model) => req(port, 'POST', '/v1/chat/completions', { Authorization: 'Bearer ' + auth }, { model, messages: [{ role: 'user', content: 'hi' }] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // ============ 池1（8895）：on429Streak + daily_exhausted + 防抖 ============
  console.log('=== A. 连续 429 告警（on429Streak=1）===');
  let r = await chat(8895, 'sk-alert-aaa', 'stuck');
  console.log('   stuck 第1次 ->', r.status);
  await sleep(100);
  r = await chat(8895, 'sk-alert-aaa', 'stuck');
  console.log('   stuck 第2次 ->', r.status, '（应在冷却期内不重复告警）');

  console.log('=== B. 用户每日配额用尽（daily=2）===');
  for (let i = 1; i <= 3; i++) {
    r = await chat(8895, 'sk-alert-aaa', 'auto');
    console.log(`   auto 第${i}次 ->`, r.status);
  }

  await sleep(200);
  let s = await req(8895, 'GET', '/stats');
  const alerts = (s.data && s.data.alerts) || [];
  console.log('=== 池1 告警记录（' + alerts.length + ' 条）===');
  for (const a of alerts) console.log(`   [${a.kind}] ${a.title} | sent=${a.sent} | ${a.error || ''}`);

  const hasOn429 = alerts.some((a) => a.kind === 'on429:stuckP');
  const hasDaily = alerts.some((a) => a.kind.startsWith('daily_exhausted:'));
  const on429Count = alerts.filter((a) => a.kind === 'on429:stuckP').length;
  console.log('\n   校验：on429 告警存在=' + hasOn429 + '，daily 告警存在=' + hasDaily + '，on429 防抖(仅1条)=' + (on429Count === 1));

  // ============ 池2（8896）：全部 Key 下线 ============
  console.log('\n=== C. 全部 Key 下线（BAD1 → 401 → kill）===');
  r = await chat(8896, 'any', 'auto');
  console.log('   bad 调用 ->', r.status);
  await sleep(200);
  s = await req(8896, 'GET', '/stats');
  const alerts2 = (s.data && s.data.alerts) || [];
  console.log('   池2 告警记录：');
  for (const a of alerts2) console.log(`   [${a.kind}] ${a.title}`);
  const hasAllDead = alerts2.some((a) => a.kind === 'all_keys_dead');

  const pass = hasOn429 && hasDaily && (on429Count === 1) && hasAllDead;
  console.log('\n=== ' + (pass ? 'ALL PASS' : 'FAIL') + ' ===');
  process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error('FAIL', e); process.exit(1); });
