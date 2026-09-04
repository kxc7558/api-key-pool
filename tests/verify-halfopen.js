'use strict';
/**
 * 专项验证（config.halfopen.json / 端口 8892）：
 *  [C] 半开探活回池：RATE2B 429 冷却结束后不直接回池，先 GET /models 探活通过才可用
 *  [D] 死 Key 复活：REVIVE1 前 2 次 chat 401 被下线，探活 /models 200 → 自动复活
 */
const BASE = 'http://127.0.0.1:8892';
const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', C = '\x1b[36m', X = '\x1b[0m';
let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ${G}PASS${X} ${name}${detail ? '  ' + detail : ''}`); }
  else { fail++; console.log(`  ${R}FAIL${X} ${name}  ${detail || ''}`); }
}
async function chat(model, text) {
  const r = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: text || 'ping' }], max_tokens: 32 }),
  });
  const body = await r.json().catch(() => ({}));
  return { status: r.status, key: r.headers.get('x-pool-key'), type: body.error?.type, body };
}
const stats = async () => (await (await fetch(`${BASE}/stats`)).json());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitState(keyId, expectStates, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const st = await stats();
    const k = st.keys.find((x) => x.id === keyId);
    if (k && expectStates.includes(k.state)) return k;
    await sleep(150);
  }
  const st = await stats();
  return st.keys.find((x) => x.id === keyId);
}

(async () => {
  console.log(`\n${C}专项验证：半开探活回池 + 死 Key 复活（${BASE}）${X}\n`);
  // 重置 mock 计数，保证 RATE2B / REVIVE1 从干净状态开始
  await fetch('http://127.0.0.1:8899/__reset', { method: 'POST' });

  console.log('[C] 半开探活 —— Key 撞 429 进入冷却后，应由探活放行回池（不直接拿真实请求试错）');
  // 循环调用直到 RATE2B 处于冷却（不依赖池游标/累计状态；冷却窗口 1s，循环要够快）
  let rate2b = null;
  for (let i = 1; i <= 30; i++) {
    await chat('hb', `w${i}`);
    rate2b = (await stats()).keys.find((k) => k.id === 'hb#1');
    if (rate2b && rate2b.state === 'cooling') break;
  }
  check('RATE2B 已进入冷却（429 被记录）', rate2b && rate2b.state === 'cooling', `state=${rate2b ? rate2b.state : '?'} limited=${rate2b ? rate2b.stats.limited : '?'}`);
  const totalBefore = rate2b ? rate2b.stats.total : 0;

  // 冷却到期 + 探活节拍后应回到可用（探活 GET /models 通过才回池）
  const after = await waitState('hb#1', ['ready', 'busy'], 5000);
  check('冷却结束后经探活回到可用（ready/busy）', !!after && (after.state === 'ready' || after.state === 'busy'), `state=${after ? after.state : '不存在'}`);
  const st2 = await stats();
  const r2 = st2.keys.find((k) => k.id === 'hb#1');
  check('探活未消耗 chat 次数（回池期间 total 不增长）', r2 && r2.stats.total === totalBefore, `total ${totalBefore} → ${r2 ? r2.stats.total : '?'}`);

  console.log('\n[D] 死 Key 复活 —— REVIVE1 chat 首次 401 被下线，探活通过后自动复活');
  const d1 = await chat('rev', 'd1');   // 第一次 401 → key 下线
  let stD = await stats();
  let rev1 = stD.keys.find((k) => k.id === 'rev#1');
  // 401 下线可能已被探活快速复活（reviveDelayMs=1s 很激进），因此断言「曾被下线(fail≥1)」而非此刻 state
  check('REVIVE1 曾被 401 下线（fail≥1）', rev1 && rev1.stats.fail >= 1, `fail=${rev1 ? rev1.stats.fail : '?'} state=${rev1 ? rev1.state : '?'}`);
  // 等 reviveDelayMs 1s + 探活节拍 → /models 200 → 复活为 ready
  const revAfter = await waitState('rev#1', ['ready', 'busy'], 4000);
  check('探活复活为可用', !!revAfter && revAfter.state !== 'dead', `state=${revAfter ? revAfter.state : '不存在'}`);
  // 复活后真实调用（第 2 次 chat 起）应 200 出文
  const d3 = await chat('rev', 'd3-after-revive');
  check('复活后请求成功', d3.status === 200, `HTTP ${d3.status} key=${d3.key} type=${d3.type || '-'}`);

  const fin = await stats();
  const okKeys = fin.keys.filter((k) => k.state === 'ready').length;
  console.log(`  最终状态：ready=${okKeys} cooling=${fin.summary.cooling} dead=${fin.summary.dead} verify=${fin.summary.verify || 0}`);

  console.log(`\n${fail === 0 ? G + '全部通过' : R + '存在失败'}  ${pass} passed, ${fail} failed${X}\n`);
  process.exit(fail === 0 ? 0 : 1);
})();
