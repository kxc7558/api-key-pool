'use strict';
/** 端到端验证：401下线 / 429冷却切换 / 轮询分散 / 流式透传 / 并发 */
const BASE = 'http://127.0.0.1:8890';
const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', C = '\x1b[36m', X = '\x1b[0m';
let pass = 0, fail = 0;

function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ${G}PASS${X} ${name}${detail ? '  ' + detail : ''}`); }
  else { fail++; console.log(`  ${R}FAIL${X} ${name}  ${detail || ''}`); }
}

async function call(opts = {}) {
  const r = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: opts.text || 'ping' }], stream: !!opts.stream, max_tokens: 32 }),
  });
  return {
    status: r.status,
    key: r.headers.get('x-pool-key'),
    provider: r.headers.get('x-pool-provider'),
    attempt: Number(r.headers.get('x-pool-attempt') || 0),
    text: await r.text(),
  };
}

(async () => {
  console.log(`\n${C}端到端验证（代理池 ${BASE}）${X}\n`);

  console.log('[1] 无效 Key 自动下线 —— BAD1 应被跳过并永久标记为 dead');
  const r1 = await call();
  check('请求成功', r1.status === 200, `HTTP ${r1.status} 命中 ${r1.key} 第${r1.attempt}次尝试`);
  check('没用无效 Key BAD1', r1.key !== 'mockA#1', `实际命中 ${r1.key}`);
  const st1 = await (await fetch(`${BASE}/stats`)).json();
  const bad = st1.keys.find((k) => k.id === 'mockA#1');
  check('BAD1 状态为 dead', bad && bad.state === 'dead', bad ? `state=${bad.state} reason=${(bad.deadReason || '').slice(0, 40)}` : '未找到');

  console.log('\n[2] 轮询分散 —— 10 次串行调用应落到多个 Key');
  const used = new Map();
  for (let i = 0; i < 10; i++) {
    const r = await call({ text: `第${i}次` });
    if (r.status === 200) used.set(r.key, (used.get(r.key) || 0) + 1);
  }
  check('覆盖 3 个以上 Key', used.size >= 3, [...used.entries()].map(([k, v]) => `${k}:${v}`).join('  '));

  console.log('\n[3] 429 限流切换 —— RATE1 前 2 次成功后开始 429，应自动换 Key 而不是报错');
  const results = [];
  for (let i = 0; i < 8; i++) results.push(await call({ text: `压测${i}` }));
  const okCount = results.filter((r) => r.status === 200).length;
  check('全部 8 次都拿到 200（靠换 Key 兜住）', okCount === 8, `成功 ${okCount}/8`);
  const st3 = await (await fetch(`${BASE}/stats`)).json();
  const rate = st3.keys.find((k) => k.id === 'mockB#1');
  check('RATE1 触发过限流并进入冷却/记录', rate && rate.stats.limited > 0, `limited=${rate ? rate.stats.limited : '?'} state=${rate ? rate.state : '?'}`);

  console.log('\n[4] 并发 20 —— 检验并发承载与排队');
  const t0 = Date.now();
  const conc = await Promise.all(Array.from({ length: 20 }, (_, i) => call({ text: `并发${i}` })));
  const okC = conc.filter((r) => r.status === 200).length;
  check('并发 20 全部成功', okC === 20, `成功 ${okC}/20 用时 ${Date.now() - t0}ms`);

  console.log('\n[5] 流式 SSE 透传');
  const s = await call({ stream: true, text: '流式测试' });
  const chunkCount = (s.text.match(/^data: /gm) || []).length;
  check('返回 200 且为 SSE', s.status === 200 && s.text.includes('data:'), `HTTP ${s.status} 分片 ${chunkCount} 命中 ${s.key}`);
  check('SSE 以 [DONE] 结束', s.text.includes('[DONE]'), '');

  console.log('\n[6] 模型强制指定语法 "provider:model"');
  const forced = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'mockB:mock-model', messages: [{ role: 'user', content: 'x' }] }),
  });
  check('强制走 mockB', forced.headers.get('x-pool-provider') === 'mockB', `provider=${forced.headers.get('x-pool-provider')} key=${forced.headers.get('x-pool-key')}`);
  await forced.text();

  console.log('\n[7] 同一账号共享配额 —— mockC 两个 Key 同组，组限额 2 次/分钟');
  const g1 = await fetch(`${BASE}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'grouped', messages: [{ role: 'user', content: 'g1' }] }) });
  const g2 = await fetch(`${BASE}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'grouped', messages: [{ role: 'user', content: 'g2' }] }) });
  await g1.text(); await g2.text();
  const g1k = g1.headers.get('x-pool-key'), g2k = g2.headers.get('x-pool-key');
  check('前 2 次成功且落在不同 Key', g1.status === 200 && g2.status === 200 && g1k !== g2k, `${g1k} / ${g2k}`);
  const g3 = await fetch(`${BASE}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'grouped', messages: [{ role: 'user', content: 'g3' }] }) });
  const g3b = await g3.json();
  check('第 3 次因组配额耗尽被挡住（返回 503 而非硬打上游）', g3.status === 503, `HTTP ${g3.status} ${JSON.stringify(g3b.error?.message || '')}`);
  const stg = await (await fetch(`${BASE}/stats`)).json();
  const c1 = stg.keys.find((k) => k.id === 'mockC#1');
  const c2 = stg.keys.find((k) => k.id === 'mockC#2');
  check('两个 Key 共享同一个账号组计数', c1 && c2 && c1.groupRpmUsed === c2.groupRpmUsed && c1.group === 'grp1', `group=${c1?.group} 组计数 C1=${c1?.groupRpmUsed} C2=${c2?.groupRpmUsed}/限2`);

  console.log('\n[8] 统计面板');
  const fin = await (await fetch(`${BASE}/stats`)).json();
  console.log(`  总 Key ${fin.summary.total} · 可用 ${fin.summary.ready} · 冷却 ${fin.summary.cooling} · 下线 ${fin.summary.dead} · 成功 ${fin.summary.ok} · 429 ${fin.summary.limited}`);
  check('累计成功数 > 30', fin.summary.ok > 30, `ok=${fin.summary.ok}`);

  console.log(`\n${fail === 0 ? G + '全部通过' : R + '存在失败'}  ${pass} passed, ${fail} failed${X}\n`);
  process.exit(fail === 0 ? 0 : 1);
})();
