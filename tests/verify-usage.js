// 验证 Phase 1：调用日志 + 日志落盘轮转（针对 8893 测试池）
// 用法：node tests/verify-usage.js
'use strict';
const http = require('http');

const BASE = { host: '127.0.0.1', port: 8893 };
const results = [];
let seq = 0;

function req(method, path, headers, body) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = { method, path, host: BASE.host, port: BASE.port, headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}) };
    if (data) opts.headers['Content-Length'] = Buffer.byteLength(data);
    const r = http.request(opts, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => resolve({ status: res.statusCode, body: buf.slice(0, 400) }));
    });
    r.on('error', (e) => resolve({ status: -1, body: String(e.message) }));
    if (data) r.write(data);
    r.end();
  });
}

async function main() {
  // 1. 正常请求（mockA / MOCK-A2 返回 200 + usage）
  let r = await req('POST', '/v1/chat/completions', { Authorization: 'Bearer sk-test-aaa' }, { model: 'auto', messages: [{ role: 'user', content: 'hi' }] });
  results.push(['正常请求 sk-test-aaa/auto', r.status]);
  console.log('[1] 正常请求 ->', r.status, '| body:', r.body);

  // 2. 无效 Key（auth_fail）
  r = await req('POST', '/v1/chat/completions', { Authorization: 'Bearer sk-bad-key' }, { model: 'auto', messages: [{ role: 'user', content: 'hi' }] });
  results.push(['无效Key auth_fail', r.status]);
  console.log('[2] 无效Key ->', r.status, '| body:', r.body);

  // 3. stuck 模型连续打，触发熔断（failThreshold=2）-> 第三次起应 circuit_open
  for (let i = 1; i <= 4; i++) {
    r = await req('POST', '/v1/chat/completions', { Authorization: 'Bearer sk-test-aaa' }, { model: 'stuck', messages: [{ role: 'user', content: 'hi' }] });
    results.push([`stuck 第${i}次`, r.status]);
    console.log(`[3.${i}] stuck ->`, r.status, '| body:', r.body);
  }

  console.log('\n=== 汇总 ===');
  for (const [name, status] of results) console.log(`  ${name}: ${status}`);
}

main().catch((e) => { console.error('FAIL', e); process.exit(1); });
