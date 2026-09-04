'use strict';
/**
 * 代理池自检脚本
 * 用法：
 *   node test.js                    默认：健康检查 + 单次调用 + 12 并发 + 流式
 *   node test.js 30                 自定义并发数
 *   node test.js 12 pro             指定 model 别名
 *   POOL_BASE=http://1.2.3.4:8787 node test.js
 *   POOL_KEY=sk-pool-xxx node test.js   中转站模式下指定分发 Key
 */

const BASE = process.env.POOL_BASE || 'http://127.0.0.1:8787';
const CONCURRENCY = Number(process.argv[2]) || 12;
const MODEL = process.argv[3] || 'auto';
// 中转站模式下要带分发 Key（config.json 的 accessKeys）。用环境变量 POOL_KEY 传入，避免仓库里留明文 Key。
const POOL_KEY = process.env.POOL_KEY || '';
// 设了 adminToken 后 /stats 需要管理鉴权：POOL_ADMIN_TOKEN 可选
const ADMIN_TOKEN = process.env.POOL_ADMIN_TOKEN || '';

const C = {
  g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', c: '\x1b[36m', dim: '\x1b[90m', b: '\x1b[1m', x: '\x1b[0m',
};

function hr(t) { console.log(`\n${C.c}${C.b}── ${t} ${'─'.repeat(Math.max(0, 56 - t.length))}${C.x}`); }

async function post(body, isStream = false) {
  const t0 = Date.now();
  const headers = { 'content-type': 'application/json', accept: isStream ? 'text/event-stream' : 'application/json' };
  if (POOL_KEY) headers['authorization'] = `Bearer ${POOL_KEY}`;
  const resp = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const key = resp.headers.get('x-pool-key');
  const provider = resp.headers.get('x-pool-provider');
  const attempt = resp.headers.get('x-pool-attempt');
  let text = '';
  if (isStream && resp.ok) {
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let chunks = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks++;
      text += dec.decode(value, { stream: true });
    }
    text = `收到 ${chunks} 个 SSE 分片`;
  } else {
    text = await resp.text();
  }
  return { status: resp.status, key, provider, attempt, text, ms: Date.now() - t0 };
}

function brief(text) {
  try {
    const j = JSON.parse(text);
    if (j.error) return `ERR: ${JSON.stringify(j.error.message || j.error).slice(0, 120)}`;
    const c = j.choices && j.choices[0];
    const m = c && c.message;
    const d = c && c.delta;
    const txt = (m && (m.content ?? m.reasoning)) || (d && (d.content ?? d.reasoning ?? d.reasoning_content)) || '';
    return String(txt).replace(/\s+/g, ' ').slice(0, 90);
  } catch (_) {
    return text.replace(/\s+/g, ' ').slice(0, 120);
  }
}

(async () => {
  console.log(`${C.b}API Key 代理池 · 自检${C.x}  目标 ${BASE}  并发 ${CONCURRENCY}  model=${MODEL}`);

  hr('1. 健康检查');
  try {
    const r = await fetch(`${BASE}/health`);
    const j = await r.json();
    console.log(`状态 ${r.status === 200 ? C.g + 'OK' + C.x : C.r + 'FAIL' + C.x}  Key 总数=${j.keys}  已运行 ${j.uptimeSec}s`);
    if (j.keys === 0) {
      console.log(`${C.y}提示：config.json 里还没有可用 Key，后面的调用会全部返回 503，属正常现象。${C.x}`);
    }
  } catch (e) {
    console.log(`${C.r}连不上 ${BASE} —— 请先运行 start.bat 启动服务${C.x}`);
    process.exit(1);
  }

  hr('2. 单次调用');
  const one = await post({
    model: MODEL,
    messages: [{ role: 'user', content: '用一句话介绍你自己' }],
    max_tokens: 64,
  });
  console.log(`HTTP ${one.status}  命中 ${C.g}${one.key || '-'}${C.x} (${one.provider || '-'})  第 ${one.attempt} 次尝试  ${one.ms}ms`);
  console.log(`回复：${brief(one.text)}`);

  hr(`3. 并发 ${CONCURRENCY} 次（验证是否分散到多个 Key）`);
  const tasks = [];
  for (let i = 0; i < CONCURRENCY; i++) {
    tasks.push(post({
      model: MODEL,
      messages: [{ role: 'user', content: `第 ${i + 1} 个请求：只回复数字 ${i + 1}` }],
      max_tokens: 16,
    }));
  }
  const t0 = Date.now();
  const results = await Promise.all(tasks);
  const total = Date.now() - t0;

  const byKey = new Map();
  let ok = 0, fail = 0;
  for (const r of results) {
    if (r.status === 200) ok++; else fail++;
    const k = r.key || `HTTP${r.status}`;
    const e = byKey.get(k) || { n: 0, ms: 0, err: 0 };
    e.n++; e.ms += r.ms; if (r.status !== 200) e.err++;
    byKey.set(k, e);
  }
  for (const [k, v] of [...byKey.entries()].sort((a, b) => b[1].n - a[1].n)) {
    const pct = Math.round((v.n / CONCURRENCY) * 100);
    const bar = '█'.repeat(Math.max(1, Math.round(pct / 4)));
    console.log(`  ${k.padEnd(16)} ${String(v.n).padStart(3)} 次 ${C.c}${bar}${C.x} 均 ${Math.round(v.ms / v.n)}ms${v.err ? C.r + ` 失败${v.err}` + C.x : ''}`);
  }
  console.log(`\n  成功 ${C.g}${ok}${C.x} / 失败 ${fail ? C.r + fail + C.x : '0'}   总耗时 ${total}ms   实际吞吐 ${Math.round((CONCURRENCY / total) * 60000)} 次/分钟`);
  if (ok > 0 && byKey.size === 1) {
    console.log(`${C.y}  注意：所有请求都打在同一个 Key 上。若只有 1 个 Key 属正常；若配了多个，检查是否有 Key 处于冷却/下线状态（看状态面板）。${C.x}`);
  }

  hr('4. 流式（SSE）');
  const s = await post({
    model: MODEL,
    messages: [{ role: 'user', content: '数到 10' }],
    max_tokens: 64,
    stream: true,
  });
  console.log(`HTTP ${s.status}  命中 ${s.key || '-'}  ${s.ms}ms  ${brief(s.text)}`);

  hr('5. Key 状态汇总');
  try {
    const statsHeaders = {};
    if (ADMIN_TOKEN) statsHeaders['authorization'] = 'Bearer ' + ADMIN_TOKEN;
    const r = await fetch(`${BASE}/stats`, { headers: statsHeaders });
    const j = await r.json();
    const sm = j.summary;
    console.log(`  可用 ${C.g}${sm.ready}${C.x} · 忙碌 ${sm.busy} · 冷却 ${C.y}${sm.cooling}${C.x} · 下线 ${C.r}${sm.dead}${C.x}   成功 ${sm.ok} · 失败 ${sm.fail} · 触发限流 ${C.y}${sm.limited}${C.x}`);
    console.log(`\n  打开状态面板看实时情况：${C.c}${BASE}/${C.x}`);
  } catch (e) {
    console.log(`读取统计失败：${e.message}`);
  }
  console.log('');
})();
