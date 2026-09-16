#!/usr/bin/env node
'use strict';
/* ============================================================
 * api-key-pool 操作 CLI（零依赖，node 18+）
 *
 * 设计原则：
 *   1. 只读命令 → 直接执行
 *   2. 低风险写（加用户/加别名/改策略）→ 自动备份后执行
 *   3. 高风险写（删平台/删用户/删别名）→ 必须显式 --yes，否则拒绝
 *      （分级授权在代码里强制，不靠调用方自觉）
 *   4. 所有写操作先备份配置到 ~/.api-key-pool-backups/
 *
 * 用法：node pool.js <命令> [参数] [--base=URL] [--token=TOKEN]
 * ============================================================ */

const fs = require('fs');
const path = require('path');
const os = require('os');

const argv = process.argv.slice(2);
const cmd = argv[0];
const flags = {};
const pos = [];
for (const a of argv.slice(1)) {
  if (a.startsWith('--')) { const i = a.indexOf('='); if (i > 0) flags[a.slice(2, i)] = a.slice(i + 1); else flags[a.slice(2)] = true; }
  else pos.push(a);
}

const BASE = (flags.base || process.env.POOL_BASE || 'http://124.221.231.32:8787').replace(/\/+$/, '');
// 默认取「本 CLI 所属项目」的 config.json —— 本机(Windows)与云端(Linux)都成立，
// 不能写死绝对路径，否则换台机器就取不到 adminToken（云端踩过）
const CFG_PATH = flags.config || process.env.POOL_CONFIG
  || path.join(__dirname, '..', 'config.json');
const BACKUP_DIR = path.join(os.homedir(), '.api-key-pool-backups');

/* ---------- 输出 ---------- */
const P = (...a) => console.log(...a);
const die = (m) => { console.error('错误: ' + m); process.exit(1); };

/* ---------- 凭证 ---------- */
function adminToken() {
  if (flags.token) return flags.token;
  if (process.env.POOL_ADMIN_TOKEN) return process.env.POOL_ADMIN_TOKEN;
  try {
    const c = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
    if (c.adminToken) return c.adminToken;
  } catch (_) {}
  die('拿不到 adminToken：请给 --token=xxx 或设 POOL_ADMIN_TOKEN，或确认 --config 指向的 config.json 里配了 adminToken');
}

/* ---------- 登录（cookie 会话） ---------- */
let COOKIE = '';
async function login() {
  if (COOKIE) return;
  const cr = await fetch(BASE + '/api/auth/captcha');
  const cid = cr.headers.get('x-captcha-id');
  const svg = await cr.text();
  // 验证码是 SVG <text>（注意：这也是它防不住脚本的原因）
  const text = [...svg.matchAll(/<text[^>]*>([^<])<\/text>/g)].map((m) => m[1]).join('');
  const lr = await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'admin', password: adminToken(), captchaId: cid, captchaText: text }),
  });
  const d = await lr.json().catch(() => ({}));
  if (lr.status !== 200) die(`登录失败(${lr.status})：${(d.error && d.error.message) || ''}`);
  const sc = lr.headers.getSetCookie ? lr.headers.getSetCookie() : [];
  COOKIE = sc.length ? sc[0].split(';')[0] : '';
  if (!COOKIE) die('登录成功但未拿到会话 cookie');
}
const H = (json) => Object.assign({ cookie: COOKIE }, json ? { 'content-type': 'application/json' } : {});
async function get(p) { await login(); const r = await fetch(BASE + p, { headers: H() }); return { status: r.status, data: await r.json().catch(() => null) }; }
async function put(p, body) { await login(); const r = await fetch(BASE + p, { method: 'PUT', headers: H(true), body: JSON.stringify(body) }); return { status: r.status, data: await r.json().catch(() => null) }; }
async function post(p, body) { await login(); const r = await fetch(BASE + p, { method: 'POST', headers: H(true), body: JSON.stringify(body) }); return { status: r.status, data: await r.json().catch(() => null) }; }

/* ---------- 配置读写（含备份） ---------- */
async function loadCfg() {
  const r = await get('/admin/api/config');
  if (r.status !== 200 || !r.data || !r.data.config) die('读取配置失败（HTTP ' + r.status + '）');
  return r.data.config;
}
function backup(cfg, tag) {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const f = path.join(BACKUP_DIR, `config-${tag}-${Date.now()}.json`);
    fs.writeFileSync(f, JSON.stringify(cfg, null, 2), 'utf8');
    return f;
  } catch (_) { return ''; }
}
async function saveCfg(cfg, tag, summary) {
  const f = backup(cfg, tag);
  const r = await put('/admin/api/config', cfg);
  if (r.status !== 200) die(`保存失败(${r.status})：${(r.data && r.data.error && r.data.error.message) || ''}`);
  P(`[已保存] ${summary}`);
  if (f) P(`[备份] ${f}`);
  if (r.data && r.data.warnings && r.data.warnings.length) P('[提醒] ' + r.data.warnings.join('；'));
}
function needYes(what) {
  if (flags.yes) return;
  die(`「${what}」属高风险操作，需显式确认：加 --yes 重跑（这是分级授权的强制要求）`);
}

/* ---------- 命令实现 ---------- */
const CMD = {};

CMD.help = () => P(`
api-key-pool 操作 CLI  —— 目标: ${BASE}

只读:
  status                     运行状态总览（Key 健康/调用统计/策略）
  keys                       上游 Key 明细表
  users                      分发用户与用量
  logs [--days=2] [--status=503] [--caller=名]
  usage [--days=7]           用量趋势（按天/按模型/按用户）
  models [--provider=名]     模型别名；带 --provider 则列该平台可选模型
  test [--model=auto] [--msg=文字]   发一条真实测试消息
  health                     健康检查

低风险写（自动备份）:
  add-user <名字> [--rpm=10] [--daily=300]
  add-alias <别名> <平台>:<模型> [--fallback] [--cost=1]
  set-strategy <round-robin|least-used|latency-first|cost-first>

高风险写（必须加 --yes）:
  del-user <Key或用户名>
  del-alias <别名>
  del-candidate <别名> <平台>:<模型>    从别名里移除一个候选（模型下线时用）
  del-provider <平台名>

配置:
  backup                     立即备份当前配置
  restore <文件>             从备份文件恢复（需 --yes）

通用: --base=URL  --token=TOKEN  --config=路径
`);

CMD.status = async () => {
  const r = await get('/stats');
  if (r.status !== 200) die('读取失败 HTTP ' + r.status);
  const s = r.data.summary, sc = r.data.scheduler || {};
  P(`服务     ${BASE}`);
  P(`Key      ${s.total} 个（可用 ${s.ready} / 忙碌 ${s.busy} / 冷却 ${s.cooling} / 待探活 ${s.verify} / 下线 ${s.dead}）`);
  P(`累计     成功 ${s.ok} / 失败 ${s.fail} / 429 ${s.limited}`);
  P(`策略     ${sc.strategy}（半开探活=${sc.halfOpen} 熔断=${sc.breakerEnabled} 连坐冷却=${sc.groupCooldownOn429}）`);
  P(`运行     ${Math.floor((r.data.uptimeSec || 0) / 60)} 分钟`);
  if ((r.data.breakers || []).length) P(`熔断中   ${r.data.breakers.map((b) => b.model).join(', ')}`);
  if ((r.data.alerts || []).length) P(`最近告警 ${r.data.alerts.length} 条（最近：${r.data.alerts[0].title}）`);
};

CMD.keys = async () => {
  const r = await get('/stats');
  if (r.status !== 200) die('读取失败');
  P('Key             平台        组      状态      并发 RPM(60s)  成功 失败 429  延迟');
  for (const k of r.data.keys) {
    const st = k.state === 'ready' ? '可用' : k.state === 'cooling' ? `冷却${Math.ceil(k.cooldownRemainMs / 1000)}s` : k.state;
    P(`${(k.id || '').padEnd(15)} ${(k.provider || '').padEnd(11)} ${(k.group || '-').padEnd(7)} ${String(st).padEnd(8)} ${String(k.inflight).padEnd(4)} ${String(k.rpmUsed + '/' + (k.rpmLimit || '∞')).padEnd(11)} ${String(k.stats.ok).padEnd(4)} ${String(k.stats.fail).padEnd(4)} ${String(k.stats.limited).padEnd(4)} ${k.stats.lastLatencyMs || '-'}`);
  }
};

CMD.users = async () => {
  const r = await get('/stats');
  if (r.status !== 200) die('读取失败');
  const us = r.data.users || [];
  if (!us.length) return P('（没有配置分发用户）');
  P('用户            今日/配额      累计    最近调用');
  for (const u of us) {
    const q = u.daily ? `${u.todayCalls}/${u.daily}` : `${u.todayCalls}/不限`;
    P(`${(u.name || '').padEnd(15)} ${q.padEnd(14)} ${String(u.totalCalls).padEnd(7)} ${u.lastCallAt ? new Date(u.lastCallAt).toLocaleString('zh-CN', { hour12: false }) : '-'}`);
  }
};

CMD.logs = async () => {
  const q = new URLSearchParams({ days: flags.days || 2, limit: flags.limit || 30 });
  if (flags.status) q.set('status', flags.status);
  if (flags.caller) q.set('caller', flags.caller);
  const r = await get('/admin/api/logs?' + q);
  if (r.status !== 200) die('读取失败 HTTP ' + r.status);
  P(`共 ${r.data.total} 条，显示最近 ${(r.data.entries || []).length} 条`);
  for (const e of (r.data.entries || [])) {
    const t = new Date(e.ts).toLocaleString('zh-CN', { hour12: false });
    P(`${t}  ${String(e.status == null ? '中断' : e.status).padEnd(5)} ${(e.model || '-').padEnd(8)} ${(e.callerName || '-').padEnd(12)} ${(e.provider || '-').padEnd(10)} ${e.latencyMs || 0}ms ${e.errorType || ''}`);
  }
};

CMD.usage = async () => {
  const q = new URLSearchParams({ days: flags.days || 7 });
  if (flags.caller) q.set('caller', flags.caller);
  const r = await get('/admin/api/usage?' + q);
  if (r.status !== 200) die('读取失败 HTTP ' + r.status);
  const d = r.data;
  P(`近 ${d.days} 天：共 ${d.totalCalls} 次调用`);
  P('\n按天:');
  for (const x of (d.daily || [])) P(`  ${x.date}  ${String(x.calls).padStart(4)} 次  (成功 ${x.ok} / 失败 ${x.fail})`);
  if ((d.byCaller || []).length) { P('\n按用户:'); for (const c of d.byCaller) P(`  ${String(c.name).padEnd(14)} ${c.calls} 次`); }
  if ((d.byModel || []).length) { P('\n按模型:'); for (const m of d.byModel) P(`  ${String(m.model).padEnd(22)} ${m.calls} 次`); }
};

CMD.models = async () => {
  const cfg = await loadCfg();
  if (flags.provider) {
    const r = await get('/admin/api/provider-models?provider=' + encodeURIComponent(flags.provider));
    const d = r.data || {};
    if (!d.ok) return P(`平台「${flags.provider}」模型列表不可用：${d.error}（该平台需手填模型名）`);
    P(`平台「${flags.provider}」可用模型（${d.models.length} 个）${d.cached ? ' [缓存]' : ''}:`);
    for (const m of d.models) P('  ' + m);
    return;
  }
  P('模型别名（客户端 model 填这些）:');
  for (const [alias, cands] of Object.entries(cfg.models || {})) {
    if (alias.startsWith('_')) continue;
    P(`  ${alias}:`);
    for (const t of (Array.isArray(cands) ? cands : [cands])) {
      const parts = [t.provider + ':' + t.model];
      if (t.fallback) parts.push('[兜底]');
      if (t.cost != null) parts.push('[cost=' + t.cost + ']');
      P('     - ' + parts.join(' '));
    }
  }
};

CMD.test = async () => {
  const cfg = await loadCfg();
  const keys = Object.keys(cfg.accessKeys || {});
  const useKey = keys[0];
  if (!useKey) die('没有配置分发 Key，无法测试');
  const model = flags.model || 'auto';
  const msg = flags.msg || '回复:ok';
  const t0 = Date.now();
  const r = await fetch(BASE + '/v1/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + useKey },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: msg }], max_tokens: flags.maxtokens || 512 }),
  });
  const d = await r.json().catch(() => ({}));
  const ms = Date.now() - t0;
  if (r.status !== 200) return P(`[失败] HTTP ${r.status} ${JSON.stringify(d.error || d).slice(0, 200)} (${ms}ms)`);
  const c = (d.choices || [{}])[0];
  P(`[成功] ${ms}ms  model=${d.model || model}  finish=${c.finish_reason}`);
  P('回复: ' + String((c.message || {}).content || '(空——思考模型需把 max_tokens 调大)').slice(0, 200));
};

CMD.health = async () => { const r = await get('/health'); P(JSON.stringify(r.data)); };

/* ---- 低风险写 ---- */
CMD['add-user'] = async () => {
  const name = pos[0]; if (!name) die('用法: add-user <名字> [--rpm=10] [--daily=300]');
  const cfg = await loadCfg();
  const key = 'sk-pool-' + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
  const rpm = Number(flags.rpm || 10), daily = Number(flags.daily || 300);
  cfg.accessKeys = cfg.accessKeys || {};
  cfg.accessKeys[key] = { name, rpm, daily };
  await saveCfg(cfg, 'add-user', `新增分发用户「${name}」${rpm}RPM/日${daily}`);
  P(`[Key] ${key}`);
  P('（把地址 ' + BASE + '/v1 和这个 Key 发给使用者；名称与注册用户名一致时对方能在个人中心看到自己的用量）');
};

CMD['add-alias'] = async () => {
  const alias = pos[0], target = pos[1];
  if (!alias || !target || !target.includes(':')) die('用法: add-alias <别名> <平台>:<模型> [--fallback] [--cost=1]');
  const [provider, ...rest] = target.split(':');
  const model = rest.join(':');
  const cfg = await loadCfg();
  if (!(cfg.providers || []).some((p) => p.name === provider)) die(`平台「${provider}」不存在。现有：${(cfg.providers || []).map((p) => p.name).join(', ')}`);
  cfg.models = cfg.models || {};
  const entry = { provider, model };
  if (flags.fallback) entry.fallback = true;
  if (flags.cost != null) entry.cost = Number(flags.cost);
  const arr = Array.isArray(cfg.models[alias]) ? cfg.models[alias] : (cfg.models[alias] ? [cfg.models[alias]] : []);
  arr.push(entry);
  cfg.models[alias] = arr;
  await saveCfg(cfg, 'add-alias', `别名「${alias}」新增候选 ${provider}:${model}${flags.fallback ? ' [兜底]' : ''}`);
};

CMD['set-strategy'] = async () => {
  const s = pos[0];
  const valid = ['round-robin', 'least-used', 'latency-first', 'cost-first'];
  if (!valid.includes(s)) die(`策略必须是 ${valid.join(' | ')}`);
  const cfg = await loadCfg();
  const old = cfg.strategy;
  cfg.strategy = s;
  await saveCfg(cfg, 'set-strategy', `调度策略 ${old} → ${s}`);
  const r = await get('/stats');
  P(`[生效确认] stats.scheduler.strategy = ${r.data.scheduler.strategy}`);
};

/* ---- 高风险写（需 --yes） ---- */
CMD['del-user'] = async () => {
  const who = pos[0]; if (!who) die('用法: del-user <Key或用户名> [--yes]');
  const cfg = await loadCfg();
  const hit = Object.keys(cfg.accessKeys || {}).find((k) => k === who || (cfg.accessKeys[k] && cfg.accessKeys[k].name === who));
  if (!hit) die('找不到该分发 Key 或用户名');
  const nm = (cfg.accessKeys[hit] && cfg.accessKeys[hit].name) || '';
  needYes(`删除分发用户「${nm || hit}」`);
  delete cfg.accessKeys[hit];
  await saveCfg(cfg, 'del-user', `已删除分发用户「${nm || hit}」`);
};

CMD['del-alias'] = async () => {
  const alias = pos[0]; if (!alias) die('用法: del-alias <别名> [--yes]');
  const cfg = await loadCfg();
  if (!cfg.models || cfg.models[alias] === undefined) die('找不到该别名');
  needYes(`删除模型别名「${alias}」`);
  delete cfg.models[alias];
  await saveCfg(cfg, 'del-alias', `已删除别名「${alias}」`);
};

CMD['del-candidate'] = async () => {
  const alias = pos[0], spec = pos[1];
  if (!alias || !spec || !spec.includes(':')) die('用法: del-candidate <别名> <平台>:<模型> [--yes]');
  const [provider, ...rest] = spec.split(':');
  const model = rest.join(':');
  const cfg = await loadCfg();
  const arr = cfg.models && cfg.models[alias];
  if (!arr) die(`找不到别名「${alias}」`);
  const list = Array.isArray(arr) ? arr.slice() : [arr];
  const idx = list.findIndex((t) => (t.provider || '') === provider && (t.model || '') === model);
  if (idx < 0) die(`别名「${alias}」里没有候选「${spec}」。现有：${list.map((t) => t.provider + ':' + t.model).join(', ')}`);
  if (list.length <= 1) die('只剩这一个候选了——要整个删请用 del-alias');
  needYes(`从别名「${alias}」移除候选「${spec}」`);
  list.splice(idx, 1);
  cfg.models[alias] = list;
  await saveCfg(cfg, 'del-candidate', `别名「${alias}」已移除候选 ${spec}`);
  P(`剩余候选：${list.map((t) => t.provider + ':' + t.model + (t.fallback ? '[兜底]' : '')).join(', ')}`);
};

CMD['del-provider'] = async () => {
  const name = pos[0]; if (!name) die('用法: del-provider <平台名> [--yes]');
  const cfg = await loadCfg();
  const idx = (cfg.providers || []).findIndex((p) => p.name === name);
  if (idx < 0) die('找不到该平台');
  const nKeys = (cfg.providers[idx].keys || []).length;
  const usedBy = Object.entries(cfg.models || {}).filter(([, c]) => (Array.isArray(c) ? c : [c]).some((t) => t && t.provider === name)).map(([a]) => a);
  needYes(`删除平台「${name}」（含 ${nKeys} 个 Key${usedBy.length ? '，且被别名 ' + usedBy.join('/') + ' 引用' : ''}）`);
  cfg.providers.splice(idx, 1);
  await saveCfg(cfg, 'del-provider', `已删除平台「${name}」`);
};

/* ---- 配置备份/恢复 ---- */
CMD.backup = async () => {
  const cfg = await loadCfg();
  const f = backup(cfg, 'manual');
  P(f ? '[已备份] ' + f : '[失败] 写入备份目录失败');
};

CMD.restore = async () => {
  const f = pos[0]; if (!f) die('用法: restore <备份文件> [--yes]');
  if (!fs.existsSync(f)) die('备份文件不存在: ' + f);
  needYes(`用 ${f} 覆盖当前配置`);
  const cfg = JSON.parse(fs.readFileSync(f, 'utf8'));
  await saveCfg(cfg, 'restore', '已从备份恢复配置');
};

/* ---------- 入口 ---------- */
(async () => {
  if (!cmd || !CMD[cmd]) { CMD.help(); process.exit(cmd ? 1 : 0); }
  try { await CMD[cmd](); }
  catch (e) { die(e && e.message ? e.message : String(e)); }
})();
