// 验证审核建议 S1（热重载/禁用启用不重置计数，防绕过配额）+ S2（logs 倒序读不全量进内存）
const http = require('http');

const PORT = 8898;
const KEY_A = 'sk-fix-aaa';
const KEY_B = 'sk-fix-bbb';

function req(method, p, body, headers) {
  return new Promise((resolve) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const h = Object.assign({ 'content-type': 'application/json', 'content-length': payload ? Buffer.byteLength(payload) : 0 }, headers || {});
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers: h }, (res) => {
      let b = '';
      res.on('data', (c) => b += c);
      res.on('end', () => resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null }));
    });
    r.on('error', (e) => resolve({ status: 0, error: e.message }));
    if (payload) r.write(payload);
    r.end();
  });
}
function chat(key) {
  const body = { model: 'auto', messages: [{ role: 'user', content: 'hi' }] };
  return req('POST', '/v1/chat/completions', body, { authorization: 'Bearer ' + key });
}
async function getStats() {
  return (await req('GET', '/stats')).body;
}
async function getUser(name) {
  const s = await getStats();
  return s.users.find((u) => u.name === name) || null;
}
async function getDisabled(name) {
  const s = await getStats();
  return s.disabledUsers.find((u) => u.name === name) || null;
}
async function saveConfig(mutate) {
  const g = await req('GET', '/admin/api/config');
  const cfg = g.body.config;
  mutate(cfg);
  return req('PUT', '/admin/api/config', cfg);
}

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name, extra != null ? JSON.stringify(extra) : ''); }
}

(async () => {
  // S1 核心：验证「热重载/禁用/启用」都不重置计数（用相对增量断言，保证可重复运行）
  // 读初始计数 N0（可能因重复运行而 >0）
  let u0 = await getUser('修复用户A');
  const N0 = (u0 && u0.totalCalls) || 0;

  // 发 3 个请求 → N0+3
  await chat(KEY_A); await chat(KEY_A); await chat(KEY_A);
  let u = await getUser('修复用户A');
  ok('S1 初始发 3 个请求后 totalCalls=N0+3', u && u.totalCalls === N0 + 3, { N0, got: u && u.totalCalls });

  // S1-a：热重载（改无关字段 logLevel）后计数不重置
  await saveConfig((c) => { c.logLevel = 'debug'; });
  await chat(KEY_A); await chat(KEY_A);
  u = await getUser('修复用户A');
  ok('S1-a 热重载后 totalCalls=N0+5（不重置）', u && u.totalCalls === N0 + 5, u && u.totalCalls);
  ok('S1-a 热重载后 todayCalls=N0+5', u && u.todayCalls === N0 + 5, u && u.todayCalls);

  // S1-b：禁用 A → A 请求 401，B 不受影响，A 计数保留在 disabledUsers
  await saveConfig((c) => { c.accessKeys[KEY_A].enabled = false; });
  const rA401 = await chat(KEY_A);
  ok('S1-b 禁用后 A 请求 401', rA401.status === 401, rA401.status);
  const rB200 = await chat(KEY_B);
  ok('S1-b B 仍可用 200', rB200.status === 200, rB200.status);
  const d = await getDisabled('修复用户A');
  ok('S1-b 禁用后 A 计数保留 totalCalls=N0+5', d && d.totalCalls === N0 + 5, d && d.totalCalls);

  // S1-c：再启用 A → 计数恢复（不重置），继续累计
  await saveConfig((c) => { c.accessKeys[KEY_A].enabled = true; });
  u = await getUser('修复用户A');
  ok('S1-c 再启用后 totalCalls=N0+5（恢复不重置）', u && u.totalCalls === N0 + 5, u && u.totalCalls);
  const rA200 = await chat(KEY_A);
  ok('S1-c 再启用后 A 请求 200', rA200.status === 200, rA200.status);
  u = await getUser('修复用户A');
  ok('S1-c 再启用后继续累计 totalCalls=N0+6', u && u.totalCalls === N0 + 6, u && u.totalCalls);

  // S2：logs 倒序读——limit=2 应只返回 2 条，total 正确，倒序，truncated
  const logs = await req('GET', '/admin/api/logs?limit=2&days=2');
  const L = logs.body;
  ok('S2 logs 返回 entries 数 = limit(2)', L && L.entries && L.entries.length === 2, L && L.entries && L.entries.length);
  ok('S2 logs total >= 7', L && L.total >= 7, L && L.total);
  ok('S2 logs truncated=true', L && L.truncated === true, L && L.truncated);
  ok('S2 logs entries 倒序（ts 递减）', L.entries.length === 2 && L.entries[0].ts >= L.entries[1].ts, L.entries.map(e => e.ts));
  // S2：带 caller 过滤（URL 编码中文）——过滤后 total 应 <= 全量，且 entries 全匹配 callerName
  const logsF = await req('GET', '/admin/api/logs?limit=500&caller=' + encodeURIComponent('修复用户A'));
  ok('S2 caller 过滤后 total <= 全量 total', logsF.body.total <= L.total, logsF.body.total + ' vs ' + L.total);
  ok('S2 caller 过滤后 entries 全匹配 callerName', logsF.body.entries.every(e => e.callerName === '修复用户A'), logsF.body.entries.map(e => e.callerName));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
