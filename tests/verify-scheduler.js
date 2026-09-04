'use strict';
/**
 * 专项验证（config.scheduler.json / 端口 8891）：
 *  [A] 连坐冷却：RATE2@acc 429 触发后，同组 OK1 一起冷却，不再被白试
 *  [B] 模型熔断：ALWAYS429 连续失败 → 熔断窗口内秒回 circuit_open
 *  [C] 排队超时不熔断：并发占满（无 429）连续排队超时 → breakers 应为空（B1 修复回归）
 */
const BASE = 'http://127.0.0.1:8891';
const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', C = '\x1b[36m', X = '\x1b[0m';
let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ${G}PASS${X} ${name}${detail ? '  ' + detail : ''}`); }
  else { fail++; console.log(`  ${R}FAIL${X} ${name}  ${detail || ''}`); }
}
async function chat(model, text) {
  const t0 = Date.now();
  const r = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: text || 'ping' }], max_tokens: 32 }),
  });
  const body = await r.json().catch(() => ({}));
  return { status: r.status, type: body.error?.type, ms: Date.now() - t0, body };
}
const stats = async () => (await (await fetch(`${BASE}/stats`)).json());

(async () => {
  console.log(`\n${C}专项验证：连坐冷却 + 模型熔断（${BASE}）${X}\n`);
  // 重置 mock 计数，保证 RATE2「前 2 次 200」前提成立
  await fetch('http://127.0.0.1:8899/__reset', { method: 'POST' });

  console.log('[A] 连坐冷却 —— 同组一个 Key 撞 429，另一个应连坐冷却、不被白试');
  // 连打到出现一次 503（说明 429 触发后整组冷却、无可用 Key）
  let r503 = null;
  for (let i = 1; i <= 12 && !r503; i++) {
    const r = await chat('grp', `w${i}`);
    if (r.status === 503) r503 = r;
  }
  check('触发 429 后整组冷却返回 503', !!r503, r503 ? `HTTP ${r503.status} ${r503.type || ''} ${r503.ms}ms` : '12 次内未出现 503');
  if (r503) {
    const attempts = (r503.body?.error?.attempts) || [];
    check('503 的 attempts 只有触发的 Key（未白试同组兄弟）', attempts.length === 1, JSON.stringify(attempts.map(a => a.key)));
    check('429 记录在触发 Key 上', attempts[0] && attempts[0].status === 429, attempts[0] ? `status=${attempts[0].status} key=${attempts[0].key}` : '');
  }
  const stA = await stats();
  const ok1a = stA.keys.find((k) => k.id === 'grpA#2');
  check('同组兄弟 Key 进入组冷却', ok1a && (ok1a.state === 'cooling' || ok1a.groupCooldownRemainMs > 0), ok1a ? `state=${ok1a.state} 组冷却剩 ${Math.ceil(ok1a.groupCooldownRemainMs / 1000)}s` : '?');
  console.log(`  等组冷却过后组内 Key 才恢复`);

  // 等组冷却结束（retry-after 2s + 缓冲），再发一次应 200
  await new Promise((r) => setTimeout(r, 3200));
  const rec = await chat('grp', 'after-cooldown');
  check('组冷却结束后恢复可用', rec.status === 200, `HTTP ${rec.status} ${rec.ms}ms`);

  console.log('\n[B] 模型熔断 —— ALWAYS429 连续失败，第 3 次应秒回 circuit_open');
  const b1 = await chat('stuck', 'b1');
  const b2 = await chat('stuck', 'b2');
  check('前两次失败返回 503（no_available_key）', b1.status === 503 && b2.status === 503, `b1=${b1.status}(${b1.type}) b2=${b2.status}(${b2.type})`);
  const b3 = await chat('stuck', 'b3');
  check('第 3 次被熔断拦截（circuit_open）', b3.type === 'circuit_open', `HTTP ${b3.status} type=${b3.type} ${b3.ms}ms`);
  check('熔断拦截是秒回（<300ms，未去上游试错）', b3.ms < 300, `${b3.ms}ms`);
  check('熔断响应带 retryAfterMs', b3.body?.error?.retryAfterMs > 0, `retryAfterMs=${b3.body?.error?.retryAfterMs}`);

  // 等熔断窗口（2.5s）过去，再发一次 → 允许试探（仍 503 no_available_key，但不再 circuit_open）
  await new Promise((r) => setTimeout(r, 3000));
  const b4 = await chat('stuck', 'b4');
  check('熔断窗口到期后自动放行试探（不再是 circuit_open）', b4.type !== 'circuit_open', `HTTP ${b4.status} type=${b4.type}`);

  console.log('\n[C] 排队超时不熔断 —— 并发占满（无 429）连续排队超时不应触发熔断');
  // busyP 并发=1、SLOW1 处理 3s：先占住唯一 Key，后续请求只能排队 800ms 超时（零上游尝试）
  const occ = chat('busy', 'occupy');
  await new Promise((r) => setTimeout(r, 150)); // 等占位请求完成 pick+begin（inflight=1）
  const qs = [];
  for (let i = 1; i <= 3; i++) qs.push(await chat('busy', `q${i}`));
  check('排队超时返回 503（no_available_key）', qs.every((r) => r.status === 503), qs.map((r) => r.status).join(','));
  check('排队超时无上游尝试（attempts 为空）', qs.every((r) => (r.body?.error?.attempts || []).length === 0), qs.map((r) => (r.body?.error?.attempts || []).length).join(','));
  const stC = await stats();
  check('连续排队超时不触发模型熔断（breakers 为空）', (stC.breakers || []).length === 0, `breakers=${JSON.stringify(stC.breakers)}`);
  await occ; // 收尾占位请求

  const fin = await stats();
  console.log(`  熔断模型：${JSON.stringify(fin.breakers || [])}`);

  console.log(`\n${fail === 0 ? G + '全部通过' : R + '存在失败'}  ${pass} passed, ${fail} failed${X}\n`);
  process.exit(fail === 0 ? 0 : 1);
})();
