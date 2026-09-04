// 验证 Phase 2：中转站面板（日志/用量接口 + 分发 Key 启用禁用）
// 前置：mock-upstream.js 跑在 8899；服务跑在 8894（POOL_CONFIG=tests/config.panel.json）
// 用法：node tests/verify-panel.js
'use strict';
const http = require('http');

const BASE = { host: '127.0.0.1', port: 8894 };

function req(method, path, headers, body) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = { method, path, host: BASE.host, port: BASE.port, headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}) };
    if (data) opts.headers['Content-Length'] = Buffer.byteLength(data);
    const r = http.request(opts, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        let j = null; try { j = JSON.parse(buf); } catch (_) {}
        resolve({ status: res.statusCode, data: j, raw: buf.slice(0, 300) });
      });
    });
    r.on('error', (e) => resolve({ status: -1, data: null, raw: String(e.message) }));
    if (data) r.write(data);
    r.end();
  });
}

async function main() {
  console.log('=== 1. 正常调用 sk-panel-aaa ===');
  let r = await req('POST', '/v1/chat/completions', { Authorization: 'Bearer sk-panel-aaa' }, { model: 'auto', messages: [{ role: 'user', content: 'hi' }] });
  console.log('   ->', r.status);

  console.log('=== 2. 被禁用 Key sk-panel-ccc（期望 401）===');
  r = await req('POST', '/v1/chat/completions', { Authorization: 'Bearer sk-panel-ccc' }, { model: 'auto', messages: [{ role: 'user', content: 'hi' }] });
  console.log('   ->', r.status, '|', r.raw);

  console.log('=== 3. 无效 Key（期望 401 auth_fail）===');
  r = await req('POST', '/v1/chat/completions', { Authorization: 'Bearer sk-bad' }, { model: 'auto', messages: [{ role: 'user', content: 'hi' }] });
  console.log('   ->', r.status);

  console.log('=== 4. /stats 检查 disabledUsers + users.enabled ===');
  r = await req('GET', '/stats');
  if (r.data) {
    console.log('   users:', (r.data.users || []).map(u => `${u.name}(enabled=${u.enabled})`).join(', '));
    console.log('   disabledUsers:', (r.data.disabledUsers || []).map(u => u.name).join(', ') || '(空)');
  } else console.log('   raw:', r.raw);

  console.log('=== 5. /admin/api/logs ===');
  r = await req('GET', '/admin/api/logs?days=2&limit=10');
  if (r.data) {
    console.log('   total:', r.data.total, '| days:', r.data.days, '| returned:', r.data.entries.length);
    for (const e of r.data.entries.slice(0, 5)) console.log(`     ${new Date(e.ts).toISOString()} ${e.callerName||'-'} ${e.model||'-'} ${e.status} ${e.errorType||''} tokens=${e.tokens?e.tokens.total:'-'}`);
  } else console.log('   raw:', r.raw);

  console.log('=== 6. /admin/api/logs 按用户过滤 (面板用户A) ===');
  r = await req('GET', '/admin/api/logs?caller=' + encodeURIComponent('面板用户A') + '&days=2&limit=10');
  if (r.data) console.log('   total:', r.data.total, '| all-callerName==面板用户A:', r.data.entries.every(e => e.callerName === '面板用户A'));

  console.log('=== 7. /admin/api/logs 按状态过滤 (401) ===');
  r = await req('GET', '/admin/api/logs?status=401&days=2&limit=10');
  if (r.data) console.log('   total:', r.data.total, '| all-status==401:', r.data.entries.every(e => e.status === 401));

  console.log('=== 8. /admin/api/usage ===');
  r = await req('GET', '/admin/api/usage?days=7');
  if (r.data) {
    console.log('   totalCalls:', r.data.totalCalls, '| days:', r.data.days, '| today:', r.data.today);
    console.log('   byCaller:', (r.data.byCaller || []).map(c => `${c.name}:${c.calls}`).join(', '));
    console.log('   byModel:', (r.data.byModel || []).map(m => `${m.model}:${m.calls}`).join(', '));
    console.log('   daily buckets:', (r.data.daily || []).map(d => `${d.date}:${d.calls}`).join(', '));
    console.log('   hours:', (r.data.hours || []).map(h => `${h.hour}时:${h.calls}`).join(', '));
  } else console.log('   raw:', r.raw);

  console.log('=== 9. /admin/api/usage 按用户过滤 (面板用户A) ===');
  r = await req('GET', '/admin/api/usage?caller=' + encodeURIComponent('面板用户A') + '&days=7');
  if (r.data) console.log('   totalCalls:', r.data.totalCalls, '| byCaller:', (r.data.byCaller || []).map(c => c.name).join(', '));

  console.log('\n=== 完成 ===');
}

main().catch((e) => { console.error('FAIL', e); process.exit(1); });
