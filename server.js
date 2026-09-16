'use strict';
/**
 * API Key 代理池 —— OpenAI 兼容协议
 *
 * 功能：
 *   1. 多平台（NVIDIA NIM / 商汤 SenseNova / 任意 OpenAI 兼容端点）统一入口
 *   2. 多 Key 轮询负载均衡
 *   3. 429 / 5xx / 超时 自动换 Key 重试，被限流的 Key 进入冷却期
 *   4. 每 Key 独立 RPM 滑动窗口 + 并发上限，从源头避免触发限流
 *   5. 无效 Key（401/403）自动永久下线
 *   6. 支持流式 SSE 透传
 *   7. 内置状态面板 GET / 与统计 GET /stats
 *
 * 零第三方依赖，Node.js >= 18（推荐 20+）
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const tls = require('node:tls');
const { Readable, Transform } = require('node:stream');

// ---------------------------------------------------------------- 配置加载

const ROOT = __dirname;
const CONFIG_PATH = process.env.POOL_CONFIG ? path.resolve(process.env.POOL_CONFIG) : path.join(ROOT, 'config.json');

const DEFAULT_CONFIG = {
  host: '127.0.0.1',
  port: 8787,
  proxyApiKey: '',          // 旧版单 Key 鉴权（兼容保留）
  accessKeys: {},           // 中转站模式：{ "分发给用户的Key": "用户名" 或 {name,rpm,daily} }
  requestTimeoutMs: 120000, // 单个上游请求总超时
  streamIdleTimeoutMs: 90000, // 流式响应最长无数据间隔
  maxAttempts: 8,           // 单次客户端请求最多尝试多少个 (模型, Key) 组合
  waitForSlotMs: 20000,     // 全部 Key 都在冷却/占满时，最多排队等待多久
  cooldownMs: 60000,        // 触发 429 后的基础冷却时长
  maxCooldownMs: 600000,    // 冷却时长上限（连续失败会指数退避）
  serverErrorCooldownMs: 8000, // 5xx 后的冷却时长
  strategy: 'round-robin',  // round-robin | least-used
  logLevel: 'info',         // debug | info | warn | error | silent
  adminToken: '',           // 操作台远程管理密码；留空 = 仅本机可管理
  collabTokens: {},         // 协同管理员：{ "token": "名字" } —— 可上传上游 Key / 生成分发 Key，不可改其他配置
  exposePassthrough: false, // /v1/models 是否列出 "平台名:__passthrough__" 占位项（默认关：它不可调用，客户端误选会报错）
  groupCooldownOn429: true, // 连坐冷却：同账号分组内任意一个 Key 触发 429，整组一起冷却（账号级限流，避免逐个白试）
  // —— 半开探测（half-open）——
  halfOpen: {
    enabled: true,          // 冷却/下线到期的 Key 先探活再回池，不直接拿真实请求试错
    probeIntervalMs: 15000, // 后台探活节拍（每隔多久扫一批到期 Key）
    probeTimeoutMs: 10000,  // 单次探活请求超时
    probeMaxPerTick: 2,     // 每个节拍最多并发探活几个 Key（避免探测风暴）
    reviveDead: true,       // 401/403 永久下线的 Key 是否允许周期探活自动复活（上游可能是临时风控）
    reviveDelayMs: 600000,  // 下线后等待多久才允许复活探活（默认 10 分钟，避免刚下线就狂打）
    probePath: 'models',    // 探活路径，相对 baseUrl，如 'models' → {baseUrl}/models；OpenAI 兼容上游基本都有
    failBackoffMs: 30000,   // 探活失败后多久再探（防止对已死 Key 高频探测）
  },
  // —— 模型级熔断 ——
  breaker: {
    enabled: true,          // 某模型连续多次「全部尝试失败」后熔断该模型一段时间，期间秒回 503 不反复试
    failThreshold: 3,       // 连续多少次完整请求全败后触发熔断
    openMs: 30000,          // 熔断窗口时长
    pruneTtlMs: 600000,     // 未达阈值的陈年失败计数多久后清理（防 BREAKER Map 无界增长）
  },
  defaults: { rpmPerKey: 35, maxConcurrencyPerKey: 2 },
  logRetentionDays: 7,      // 服务日志（logs/server-*.log）保留天数，超期自动清理
  usageRetentionDays: 90,   // 调用日志（logs/usage/*.jsonl）保留天数，超期自动清理
  // —— 监控告警（邮件通知）——
  alert: {
    enabled: true,          // 是否启用告警
    email: { to: '', from: '代理池监控', account: '', authCode: '' }, // account=发件账号（留空用 env QQ_EMAIL_ACCOUNT）；authCode=授权码（留空用 env QQ_EMAIL_AUTH_CODE）
    cooldownMs: 1800000,    // 同一告警主体的防抖间隔（30 分钟不重复发）
    allKeysDead: true,      // 全部 Key 永久下线时告警
    on429Streak: 5,         // 上游连续 429 达到该次数告警（0=关闭）
    onUserDailyExhausted: true, // 用户当日配额用尽时告警
  },
  providers: [],
  models: {},
};

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function deepMerge(base, patch) {
  const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof out[k] === 'object' && out[k] !== null && !Array.isArray(out[k])) {
      out[k] = deepMerge(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * 解析 key 值，返回 { value, group }
 * 支持写法：
 *   "nvapi-xxx"                 普通 Key
 *   "nvapi-xxx@账号A"            归入「账号A」分组（同一账号下的多个 Key 共享 RPM 配额）
 *   "env:NVIDIA_KEY_1"           从环境变量读取
 *   "env:NVIDIA_KEY_1@账号A"      环境变量 + 分组
 * 以 # 或 // 开头视为注释行，忽略
 */
function resolveKey(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s || s.startsWith('#') || s.startsWith('//')) return null;

  let group = null;
  let body = s;
  const at = s.lastIndexOf('@');
  if (at > 0) { group = s.slice(at + 1).trim() || null; body = s.slice(0, at).trim(); }

  let value = body;
  if (body.startsWith('env:')) {
    const name = body.slice(4).trim();
    value = (process.env[name] || '').trim();
    if (!value) return null;
  }
  if (!value) return null;
  return { value, group };
}

/** 统计滑动窗口内 60 秒的请求数，顺带清理过期数据 */
function windowCount(arr, now) {
  const cut = now - 60000;
  while (arr.length && arr[0] < cut) arr.shift();
  return arr.length;
}

function maskKey(k) {
  if (!k) return '(empty)';
  if (k.length <= 10) return k.slice(0, 2) + '***';
  return k.slice(0, 6) + '...' + k.slice(-4);
}

function joinUrl(base, p) {
  return String(base).replace(/\/+$/, '') + '/' + String(p || '').replace(/^\/+/, '');
}

// ---------------------------------------------------------------- 日志

let LOG_LEVEL = 'info';
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 90 };
const COLORS = {
  gray: '\x1b[90m', green: '\x1b[32m', yellow: '\x1b[33m',
  red: '\x1b[31m', cyan: '\x1b[36m', magenta: '\x1b[35m', reset: '\x1b[0m',
};

function log(level, msg, color) {
  if (LEVELS[level] < LEVELS[LOG_LEVEL]) return;
  const ts = new Date().toTimeString().slice(0, 8);
  const c = color ? COLORS[color] : '';
  console.log(`${COLORS.gray}${ts}${COLORS.reset} ${c}${level.toUpperCase().padEnd(5)}${COLORS.reset} ${msg}`);
  // 落盘（去 ANSI 颜色码、带完整时间戳）——fire-and-forget，失败不影响服务
  writeServerLog(`[${level.toUpperCase()}] ${stripAnsi(msg)}`);
}

// ---------------------------------------------------------------- 文件日志落盘

const LOG_DIR = path.join(ROOT, 'logs');
const USAGE_DIR = path.join(LOG_DIR, 'usage');
let curLogDate = '';   // 当前服务日志文件日期（跨天自动切文件）
let curUsageDate = ''; // 当前调用日志文件日期

function stripAnsi(s) {
  return String(s).replace(/\x1b\[[0-9;]*m/g, '');
}

function dateStr(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function safeReaddir(dir) {
  try { return fs.readdirSync(dir); } catch (_) { return []; }
}

/** 清理过期日志：server-*.log 按 logRetentionDays，usage/*.jsonl 按 usageRetentionDays */
function cleanupLogs() {
  try {
    const now = Date.now();
    const logKeep = (CONFIG.logRetentionDays != null ? CONFIG.logRetentionDays : 7) * 86400000;
    for (const f of safeReaddir(LOG_DIR)) {
      if (!f.startsWith('server-') || !f.endsWith('.log')) continue;
      const fp = path.join(LOG_DIR, f);
      try { if (now - fs.statSync(fp).mtimeMs > logKeep) fs.unlinkSync(fp); } catch (_) {}
    }
    const usageKeep = (CONFIG.usageRetentionDays != null ? CONFIG.usageRetentionDays : 90) * 86400000;
    for (const f of safeReaddir(USAGE_DIR)) {
      if (!f.endsWith('.jsonl')) continue;
      const fp = path.join(USAGE_DIR, f);
      try { if (now - fs.statSync(fp).mtimeMs > usageKeep) fs.unlinkSync(fp); } catch (_) {}
    }
  } catch (_) { /* 清理失败不影响服务 */ }
}

/** 服务日志按天落盘到 logs/server-YYYY-MM-DD.log */
function writeServerLog(line) {
  try {
    const day = dateStr();
    if (day !== curLogDate) { curLogDate = day; cleanupLogs(); }
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFile(path.join(LOG_DIR, `server-${day}.log`), `${new Date().toISOString()} ${line}\n`, (err) => {
      if (err) console.error(`[log] 写日志失败: ${err.message}`);
    });
  } catch (_) { /* 落盘失败不影响服务 */ }
}

/** 调用日志按天追加到 logs/usage/YYYY-MM-DD.jsonl（每行一条脱敏 JSON） */
function logUsage(entry) {
  try {
    const day = dateStr();
    if (day !== curUsageDate) { curUsageDate = day; cleanupLogs(); }
    fs.mkdirSync(USAGE_DIR, { recursive: true });
    fs.appendFile(path.join(USAGE_DIR, `${day}.jsonl`), JSON.stringify(entry) + '\n', (err) => {
      if (err) console.error(`[usage] 写调用日志失败: ${err.message}`);
    });
  } catch (_) { /* 落盘失败不影响服务 */ }
}

/** 从非流式上游响应 body 解析 usage（OpenAI 兼容），失败返回 null */
function parseUsage(buf) {
  try {
    const u = JSON.parse(buf.toString('utf8')).usage;
    if (!u) return null;
    return {
      prompt: u.prompt_tokens != null ? u.prompt_tokens : null,
      completion: u.completion_tokens != null ? u.completion_tokens : null,
      total: u.total_tokens != null ? u.total_tokens : null,
    };
  } catch (_) { return null; }
}

/** 构造调用日志条目（统一脱敏，绝不存明文 token） */
function makeUsageEntry(req, extra) {
  const u = req.poolUserObj;
  return Object.assign({
    ts: Date.now(),
    caller: u ? u.idx : (req.poolUser || null),
    callerName: u ? u.name : null,
    model: null, provider: null, keyId: null,
    status: null, latencyMs: 0, tokens: null, stream: false, errorType: null,
  }, extra);
}

// ---------------------------------------------------------------- 监控告警（邮件）

const alertSent = new Map(); // kind -> lastSentAt（按主体防抖）
const alertLog = [];          // 最近告警记录（内存，供 /stats 展示），新在前
let allKeysDeadNotified = false; // 「全 Key 下线」边沿触发状态

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** 零依赖 SMTP 发信（node:tls 直连 smtp.qq.com:465，SMTPS + AUTH LOGIN）。
 *  返回 Promise<{ok, error}>，绝不 throw。MAIL FROM 固定用授权账号（QQ 强制），
 *  From 显示名与 Subject 中文走 RFC 2047 编码。 */
function sendMail(to, subject, html) {
  const emailCfg = (CONFIG.alert && CONFIG.alert.email) || {};
  // 优先用后台填的账号/授权码，回退到环境变量（兼容旧方式）
  const account = emailCfg.account || process.env.QQ_EMAIL_ACCOUNT;
  const authCode = emailCfg.authCode || process.env.QQ_EMAIL_AUTH_CODE;
  if (!account || !authCode) return Promise.resolve({ ok: false, error: '缺少发件账号/授权码（后台「全局设置→监控告警」填写，或设环境变量 QQ_EMAIL_ACCOUNT / QQ_EMAIL_AUTH_CODE）' });
  if (!to) return Promise.resolve({ ok: false, error: '未配置收件人 alert.email.to' });

  const host = 'smtp.qq.com', port = 465;
  const displayFrom = (CONFIG.alert && CONFIG.alert.email && CONFIG.alert.email.from) || '代理池监控';
  const rfc2047 = (s) => '=?UTF-8?B?' + Buffer.from(String(s), 'utf8').toString('base64') + '?=';
  const dotStuff = (s) => String(s).replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').map((l) => (l.startsWith('.') ? '.' + l : l)).join('\r\n');

  return new Promise((resolve) => {
    let sock = null;
    const timer = setTimeout(() => done({ ok: false, error: 'SMTP 超时' }), 30000);
    function done(r) { if (timer) clearTimeout(timer); try { sock && sock.end(); } catch (_) {} resolve(r); }

    try {
      sock = tls.connect({ host, port, servername: host }, () => {
        let buf = '';
        const waiters = [];
        const pump = () => {
          let i;
          while ((i = buf.indexOf('\r\n')) >= 0) {
            const line = buf.slice(0, i); buf = buf.slice(i + 2);
            if (line.length < 3) continue;
            if (line[3] === '-') continue; // 多行响应的中间行，忽略，只等终止行
            const w = waiters.shift();
            if (w) w(line.slice(0, 3) === w.expect);
          }
        };
        sock.on('data', (c) => { buf += c.toString('utf8'); pump(); });
        sock.on('error', (e) => done({ ok: false, error: e.message }));
        sock.on('close', () => done({ ok: false, error: 'SMTP 连接被关闭' }));

        const wait = (expect) => new Promise((res) => waiters.push({ expect, resolve: res }));
        const cmd = (line, expect) => { sock.write(line + '\r\n'); return wait(expect); };

        (async () => {
          if (!(await wait('220'))) return done({ ok: false, error: 'SMTP greeting 异常' });
          if (!(await cmd('EHLO localhost', '250'))) return done({ ok: false, error: 'EHLO 失败' });
          if (!(await cmd('AUTH LOGIN', '334'))) return done({ ok: false, error: '服务器不支持 AUTH LOGIN' });
          if (!(await cmd(Buffer.from(account, 'utf8').toString('base64'), '334'))) return done({ ok: false, error: '账号未被接受' });
          if (!(await cmd(Buffer.from(authCode, 'utf8').toString('base64'), '235'))) return done({ ok: false, error: '授权码校验失败（QQ 邮箱需填授权码，非登录密码）' });
          if (!(await cmd(`MAIL FROM:<${account}>`, '250'))) return done({ ok: false, error: 'MAIL FROM 被拒（需与授权账号一致）' });
          if (!(await cmd(`RCPT TO:<${to}>`, '250'))) return done({ ok: false, error: '收件人 ' + to + ' 被拒' });
          if (!(await cmd('DATA', '354'))) return done({ ok: false, error: 'DATA 未获许可' });

          const body = [
            `Date: ${new Date().toUTCString()}`,
            `From: ${rfc2047(displayFrom)} <${account}>`,
            `To: <${to}>`,
            `Subject: ${rfc2047(subject)}`,
            'MIME-Version: 1.0',
            'Content-Type: text/html; charset=UTF-8',
            'Content-Transfer-Encoding: base64',
            '',
            Buffer.from(dotStuff(html), 'utf8').toString('base64'),
            '.',
            '',
          ].join('\r\n');
          sock.write(body);
          if (!(await wait('250'))) return done({ ok: false, error: '邮件正文被拒' });
          sock.write('QUIT\r\n');
          return done({ ok: true });
        })().catch((e) => done({ ok: false, error: e.message }));
      });
      sock.on('error', (e) => done({ ok: false, error: e.message }));
    } catch (e) {
      done({ ok: false, error: e.message });
    }
  });
}

/** 统一告警入口：按主体防抖 + 记录 + 发信（fire-and-forget，不影响主流程） */
function notifyAlert(kind, title, detail) {
  const a = CONFIG.alert || {};
  if (a.enabled === false) return;
  const now = Date.now();
  const cooldown = a.cooldownMs != null ? a.cooldownMs : 1800000;
  if (now - (alertSent.get(kind) || 0) < cooldown) return; // 防抖：同主体冷却期内不重发
  alertSent.set(kind, now);

  const record = { kind, title, detail, at: now, sent: false, error: null };
  alertLog.unshift(record);
  if (alertLog.length > 50) alertLog.length = 50;

  const to = a.email && a.email.to;
  if (!to) {
    record.error = '未配置收件人 alert.email.to';
    log('warn', `[告警] ${title}（${kind}）未配置收件人，仅记录不发送`, 'yellow');
    return;
  }
  const html = `<div style="font-family:-apple-system,'Segoe UI','Microsoft YaHei',sans-serif;color:#1f2328">
    <h3 style="margin:0 0 8px;color:#dc2626">${escapeHtml(title)}</h3>
    <p style="margin:0 0 12px;line-height:1.6">${escapeHtml(detail)}</p>
    <p style="color:#9ca3af;font-size:12px;margin:0">触发时间：${new Date(now).toLocaleString('zh-CN', { hour12: false })}</p>
  </div>`;
  sendMail(to, `[代理池告警] ${title}`, html).then((r) => {
    record.sent = r.ok;
    record.error = r.ok ? null : r.error;
    log(r.ok ? 'info' : 'error', r.ok ? `告警已发送：${title}` : `告警发送失败：${r.error}`, r.ok ? 'green' : 'red');
  }).catch((e) => {
    record.error = e.message;
    log('error', `告警发送异常：${e.message}`, 'red');
  });
}

/** 「全部 Key 永久下线」边沿检测：从有可用 Key → 全 dead 才触发一次，有 Key 复活则复位 */
function checkAllKeysDead() {
  const a = CONFIG.alert || {};
  if (a.enabled === false || a.allKeysDead === false) return;
  const keys = POOL.snapshot();
  if (keys.length === 0) return; // 未配置 Key 不告警（配置阶段常见）
  const alive = keys.filter((k) => k.state !== 'dead').length;
  if (alive === 0 && !allKeysDeadNotified) {
    allKeysDeadNotified = true;
    notifyAlert('all_keys_dead', '所有上游 Key 已下线', `共 ${keys.length} 个 Key 全部永久下线（401/403），代理池已无法服务任何请求，请尽快检查上游凭证。`);
  } else if (alive > 0) {
    allKeysDeadNotified = false;
  }
}

// ---------------------------------------------------------------- Key 状态

class ApiKey {
  constructor(provider, value, index, group) {
    this.provider = provider;
    this.value = value;
    this.id = `${provider.name}#${index + 1}`;
    this.label = `${provider.name}#${index + 1} ${maskKey(value)}`;
    this.group = group || null; // 账号分组：同组 Key 共享 RPM 配额
    this.groupName = group ? group.name : null;
    this.inflight = 0;
    this.cooldownUntil = 0;
    this.failStreak = 0;
    this.dead = false;
    this.deadReason = null;
    this.window = []; // 请求时间戳，用于 per-key RPM 滑动窗口
    this.stats = { total: 0, ok: 0, fail: 0, limited: 0, lastLatencyMs: 0, lastError: null, lastOkAt: null };
    // —— 半开探测状态 ——
    this.pendingVerify = false; // 冷却已到期，但还没通过探活验证，暂不回池
    this.probing = false;       // 探活请求进行中（防重复探测）
    this.deadAt = 0;            // 下线时间戳（复活探活计时起点）
    this.lastProbeAt = 0;       // 上次探活时间（失败退避用）
    this.probeFailStreak = 0;
  }

  prune(now) {
    const cut = now - 60000;
    while (this.window.length && this.window[0] < cut) this.window.shift();
  }

  get rpmUsed() {
    return windowCount(this.window, Date.now());
  }

  get groupRpmUsed() {
    return this.group ? windowCount(this.group.window, Date.now()) : 0;
  }

  /** 组级冷却中（同组任一 Key 429 连坐） */
  get groupCooling() {
    return !!(this.group && this.group.cooldownUntil && this.group.cooldownUntil > Date.now());
  }

  usable(now) {
    if (this.dead) return false;
    if (this.group && this.group.cooldownUntil > now) return false; // 组连坐冷却
    if (this.cooldownUntil > now) return false;
    // 冷却到期但未探活通过 → 先不回池（仅当半开探活开启时生效；关闭则按旧逻辑直接可用）
    if (this.pendingVerify && CONFIG.halfOpen && CONFIG.halfOpen.enabled !== false) return false;
    const rpm = this.provider.rpmPerKey;
    if (rpm > 0 && windowCount(this.window, now) >= rpm) return false;
    if (this.group && this.group.limit > 0 && windowCount(this.group.window, now) >= this.group.limit) return false;
    if (this.provider.maxConcurrencyPerKey > 0 && this.inflight >= this.provider.maxConcurrencyPerKey) return false;
    return true;
  }

  /** 距离可用的等待时间（毫秒），0 表示立即可用 */
  waitMs(now) {
    if (this.dead) return Infinity;
    let w = 0;
    if (this.group && this.group.cooldownUntil > now) w = Math.max(w, this.group.cooldownUntil - now);
    if (this.cooldownUntil > now) w = Math.max(w, this.cooldownUntil - now);
    if (this.pendingVerify && w === 0 && CONFIG.halfOpen && CONFIG.halfOpen.enabled !== false) {
      // 冷却已到期、只差探活：乐观估计一个节拍内会完成
      w = Math.max(w, Math.min(5000, (CONFIG.halfOpen.probeIntervalMs || 15000)));
    }
    const rpm = this.provider.rpmPerKey;
    if (rpm > 0) {
      windowCount(this.window, now);
      if (this.window.length >= rpm) w = Math.max(w, this.window[0] + 60000 - now);
    }
    if (this.group && this.group.limit > 0) {
      windowCount(this.group.window, now);
      if (this.group.window.length >= this.group.limit) w = Math.max(w, this.group.window[0] + 60000 - now);
    }
    return w;
  }

  begin(now) {
    this.window.push(now);
    if (this.group) this.group.window.push(now);
    this.inflight++;
    this.stats.total++;
  }

  succeed(latencyMs) {
    this.inflight = Math.max(0, this.inflight - 1);
    this.failStreak = 0;
    this.failSince = 0;                                  // 一次成功即清零「连续失败起点」
    if (this.group) { this.group.failStreak = 0; this.group.failSince = 0; }
    this.pendingVerify = false; // 真实请求成功 = 最好的验证
    this.stats.ok++;
    this.stats.lastLatencyMs = latencyMs;
    this.stats.lastOkAt = Date.now();
  }

  fail(reason) {
    this.inflight = Math.max(0, this.inflight - 1);
    this.stats.fail++;
    this.stats.lastError = reason;
  }

  /** 429 限流：连坐冷却（同组一起凉）或单 Key 冷却，返回冷却毫秒 */
  rateLimit(retryAfterMs) {
    this.inflight = Math.max(0, this.inflight - 1);
    this.stats.limited++;
    const now = Date.now();
    const useGroup = this.provider.groupCooldownOn429 !== false && !!this.group;
    // 退避单元：连坐模式下用「组」累计连续失败，单 Key 模式用自身
    const unit = useGroup ? this.group : this;
    unit.failStreak = (unit.failStreak || 0) + 1;
    // 记录本轮连续失败的起点（成功即清零）——用于区分「瞬时抖动」与「真的额度用尽」
    if (!unit.failSince) unit.failSince = now;
    // 冷却时长（借鉴 llm-keypool：429 优先听上游 Retry-After；
    //   只有「连续多次 429 **且持续够久**」才判定额度用尽、冷却对齐重置周期——
    //   单纯连打几次 429 往往是瞬时 TPM 限流，几秒就恢复，不该冻结整组几小时；
    //   普通瞬时限流一律走指数退避）
    const resetMs = this.provider.cooldownResetMs || 0;
    const resetAfter = this.provider.cooldownResetAfter || 0;
    const spanMs = this.provider.cooldownResetSpanMs != null ? this.provider.cooldownResetSpanMs : 600000; // 默认要求持续 10 分钟
    const sustainedMs = now - unit.failSince;
    const quotaExhausted = resetMs > 0 && resetAfter > 0 && unit.failStreak >= resetAfter && sustainedMs >= spanMs;
    const base = retryAfterMs && retryAfterMs > 0
      ? Math.min(retryAfterMs, this.provider.maxCooldownMs) // S4：Retry-After 夹紧，防异常大值锁整组一天
      : (quotaExhausted
        ? resetMs
        : Math.min(this.provider.cooldownMs * Math.pow(2, unit.failStreak - 1), this.provider.maxCooldownMs));
    if (quotaExhausted) log('warn', `判定额度用尽（连续 ${unit.failStreak} 次 429，持续 ${Math.round(sustainedMs/60000)} 分钟）→ 冷却对齐重置周期`, 'yellow');
    const until = now + base;
    if (useGroup) {
      this.group.cooldownUntil = until; // 整组一起冷却
      log('debug', `组「${this.group.name}」连坐冷却 ${Math.round(base / 1000)}s（组内连续第 ${unit.failStreak} 次 429）`, 'gray');
    }
    this.cooldownUntil = until;
    if (CONFIG.halfOpen && CONFIG.halfOpen.enabled !== false) this.pendingVerify = true; // 冷却结束要探活才回池
    this.stats.lastError = '429';
    // 连续 429 告警（按平台防抖，避免每撞一次限流都发）
    const a = CONFIG.alert || {};
    if (a.enabled !== false && a.on429Streak > 0 && unit.failStreak >= a.on429Streak) {
      notifyAlert(`on429:${this.provider.name}`, `上游连续限流：${this.provider.name}`, `平台「${this.provider.name}」连续第 ${unit.failStreak} 次 429，可能额度耗尽或限流配置过严，请检查配额。`);
    }
    return base;
  }

  /** 5xx/超时/网络错误等暂时性故障的短冷却 */
  softCooldown(ms) {
    this.inflight = Math.max(0, this.inflight - 1);
    this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + (ms || 0));
    if (CONFIG.halfOpen && CONFIG.halfOpen.enabled !== false) this.pendingVerify = true;
  }

  kill(reason) {
    this.inflight = Math.max(0, this.inflight - 1);
    this.dead = true;
    this.deadReason = reason;
    this.deadAt = Date.now();
    this.pendingVerify = false;
    this.stats.fail++;
    this.stats.lastError = reason;
    checkAllKeysDead(); // 触发「全 Key 下线」边沿检测
  }

  snapshot(now) {
    const st = this.dead ? 'dead'
      : (this.group && this.group.cooldownUntil > now) ? 'cooling'
      : this.cooldownUntil > now ? 'cooling'
      : this.pendingVerify ? 'verify'
      : this.inflight > 0 ? 'busy' : 'ready';
    return {
      id: this.id,
      key: maskKey(this.value),
      provider: this.provider.name,
      group: this.groupName,
      state: st,
      cooldownRemainMs: Math.max(0, this.cooldownUntil - now),
      groupCooldownRemainMs: this.group ? Math.max(0, this.group.cooldownUntil - now) : 0,
      inflight: this.inflight,
      rpmUsed: this.rpmUsed,
      rpmLimit: this.provider.rpmPerKey,
      groupRpmUsed: this.groupRpmUsed,
      groupRpmLimit: this.group ? this.group.limit : 0,
      deadReason: this.deadReason,
      stats: this.stats,
    };
  }
}

// ---------------------------------------------------------------- 代理池

class Pool {
  constructor(cfg) {
    this.providers = new Map(); // name -> provider
    this.targetCursor = 0;
    this.applyConfig(cfg);
  }

  applyConfig(cfg) {
    const d = cfg.defaults || {};
    const prev = this.providers;
    const next = new Map();
    for (const p of cfg.providers || []) {
      if (!p || !p.name || !p.baseUrl) continue;
      const provider = {
        name: p.name,
        baseUrl: p.baseUrl,
        chatPath: p.chatPath || '/chat/completions',
        authHeader: p.authHeader || 'Authorization',
        authPrefix: p.authPrefix !== undefined ? p.authPrefix : 'Bearer ',
        extraHeaders: p.extraHeaders || {},
        // 有些 OpenAI 兼容上游（如 SenseNova）在中间 SSE 分片里发 finish_reason=""；
        // 严格协议转换器（如 CC Switch 的 Anthropic 适配层）只接受 null/省略，按平台显式开启归一化。
        normalizeEmptyFinishReason: p.normalizeEmptyFinishReason === true,
        rpmPerKey: p.rpmPerKey != null ? p.rpmPerKey : (d.rpmPerKey != null ? d.rpmPerKey : 0),
        rpmPerAccount: p.rpmPerAccount != null ? p.rpmPerAccount : (d.rpmPerAccount != null ? d.rpmPerAccount : 0),
        maxConcurrencyPerKey: p.maxConcurrencyPerKey != null ? p.maxConcurrencyPerKey : (d.maxConcurrencyPerKey != null ? d.maxConcurrencyPerKey : 0),
        requestTimeoutMs: p.requestTimeoutMs != null ? p.requestTimeoutMs : 0,
        cooldownMs: p.cooldownMs != null ? p.cooldownMs : cfg.cooldownMs,
        maxCooldownMs: p.maxCooldownMs != null ? p.maxCooldownMs : cfg.maxCooldownMs,
        serverErrorCooldownMs: p.serverErrorCooldownMs != null ? p.serverErrorCooldownMs : cfg.serverErrorCooldownMs,
        // 额度重置周期（借鉴 llm-keypool 的冷却回退策略）：连续 cooldownResetAfter 次 429
        // 且持续 cooldownResetSpanMs 以上，才判定额度用尽并对齐重置周期冷却
        cooldownResetMs: p.cooldownResetMs != null ? p.cooldownResetMs : 0,
        cooldownResetAfter: p.cooldownResetAfter != null ? p.cooldownResetAfter : 0,
        cooldownResetSpanMs: p.cooldownResetSpanMs != null ? p.cooldownResetSpanMs : 600000,
        probeTimeoutMs: p.probeTimeoutMs != null ? p.probeTimeoutMs : 0,   // 平台级探活超时覆盖
        probePath: p.probePath || '',                                       // 平台级探活/模型列表路径覆盖
        // 连坐冷却可平台级覆盖：p.groupCooldownOn429 ?? 全局（默认 true）
        groupCooldownOn429: p.groupCooldownOn429 != null ? p.groupCooldownOn429 : (cfg.groupCooldownOn429 !== false),
        keys: [],
        groups: new Map(),
        cursor: 0,
      };
      // 从 keys 数组或 keysFile 文件读取
      const oldP0 = prev.get(p.name);
      let rawKeys = Array.isArray(p.keys) ? p.keys.slice() : [];
      if (p.keysFile) {
        const fp = path.isAbsolute(p.keysFile) ? p.keysFile : path.join(ROOT, p.keysFile);
        try {
          const lines = fs.readFileSync(fp, 'utf8').split(/\r?\n/);
          for (const line of lines) {
            const t = line.trim();
            if (t && !t.startsWith('#')) rawKeys.push(t);
          }
        } catch (e) {
          log('warn', `${p.name}: 读取 keysFile 失败 ${fp} (${e.message})`, 'yellow');
        }
      }
      const parsed = rawKeys.map(resolveKey).filter(Boolean);

      // 账号分组：同一账号下的多个 Key 共享 RPM 配额（英伟达等平台限额是账号级而非 Key 级）
      const oldGroups = oldP0 ? oldP0.groups : new Map();
      for (const item of parsed) {
        if (!item.group || provider.groups.has(item.group)) continue;
        const g = oldGroups.get(item.group) || { name: item.group, window: [], limit: provider.rpmPerAccount, cooldownUntil: 0, failStreak: 0 };
        g.limit = provider.rpmPerAccount;
        provider.groups.set(item.group, g);
      }

      // 复用旧 Key 对象，保留统计与冷却状态
      const oldP = prev.get(p.name);
      const oldByValue = new Map((oldP ? oldP.keys : []).map((k) => [k.value, k]));
      provider.keys = parsed.map((item, i) => {
        const group = item.group ? provider.groups.get(item.group) : null;
        const existed = oldByValue.get(item.value);
        if (existed) {
          existed.provider = provider;
          existed.id = `${p.name}#${i + 1}`;
          existed.label = `${p.name}#${i + 1} ${maskKey(item.value)}`;
          existed.group = group;
          existed.groupName = group ? group.name : null;
          return existed;
        }
        return new ApiKey(provider, item.value, i, group);
      });
      if (oldP) provider.cursor = oldP.cursor || 0;

      next.set(p.name, provider);
      const alive = provider.keys.filter((k) => !k.dead).length;
      const grp = provider.groups.size ? ` 账号分组=${provider.groups.size}（每组 ${provider.rpmPerAccount || '不限'} RPM）` : '';
      log('info', `平台 ${COLORS.cyan}${p.name}${COLORS.reset} 载入 ${provider.keys.length} 个 Key（有效 ${alive}）RPM/Key=${provider.rpmPerKey || '不限'} 并发/Key=${provider.maxConcurrencyPerKey || '不限'}${grp}`, 'green');
    }
    this.providers = next;
  }

  allTargetsFor(modelName) {
    return this.providers.get(modelName);
  }

  /** 把客户端请求的 model 解析成候选 [{provider, model}] */
  resolveTargets(model) {
    const cfg = this.cfg || {};
    const models = cfg.models || {};
    // 1. provider:model 强制指定
    if (typeof model === 'string' && model.includes(':') && !model.includes('/')) {
      const [pn, ...rest] = model.split(':');
      const p = this.providers.get(pn);
      const mn = rest.join(':');
      if (p && mn) return [{ provider: p, model: mn }];
    }
    if (typeof model === 'string' && model.includes('@')) {
      const [mn, pn] = model.split('@');
      const p = this.providers.get(pn);
      if (p && mn) return [{ provider: p, model: mn }];
    }
    // 2. 别名表（下划线开头的是注释字段，跳过）
    if (typeof model === 'string' && !model.startsWith('_') && models[model]) {
      const list = models[model];
      const arr = Array.isArray(list) ? list : [list];
      const out = [];
      for (const t of arr) {
        if (typeof t === 'string') {
          // "provider/model" 简写
          const idx = t.indexOf('/');
          const p = this.providers.get(t.slice(0, idx));
          if (p) out.push({ provider: p, model: t.slice(idx + 1) });
        } else if (t && t.provider) {
          const p = this.providers.get(t.provider);
          if (p) out.push({ provider: p, model: t.model || model, fallback: !!t.fallback, cost: t.cost });
        }
      }
      if (out.length) return out;
    }
    // 3. 别名表里没有 -> 用原始 model 名打所有平台
    const out = [];
    for (const p of this.providers.values()) out.push({ provider: p, model });
    return out;
  }

  /** 轮询挑选一个可用的 (target, key)。返回 null 表示暂时全忙。
   *  标记 fallback:true 的候选属兜底梯队，只有主力候选全部不可用时才会启用，
   *  避免慢速上游（如冷启动 1~2 分钟的 NIM）在正常状态下被轮询分走流量。 */
  pick(targets, strategy) {
    const primary = [];
    const fb = [];
    for (const t of targets) (t.fallback ? fb : primary).push(t);
    if (fb.length && primary.length) {
      const r = this.pickFrom(primary, strategy);
      if (r) return r;
      return this.pickFrom(fb.concat(primary), strategy);
    }
    return this.pickFrom(targets, strategy);
  }

  /** 候选排序分数（越小越优先）——供 cost-first / latency-first 策略使用 */
  targetScore(target, strategy) {
    const p = target.provider;
    if (strategy === 'cost-first') {
      // 候选可标 cost（数字，越小越便宜）；没标 → 中性值 1
      const c = Number(target.cost);
      return Number.isFinite(c) && c >= 0 ? c : 1;
    }
    // latency-first：该平台已有实测延迟的 Key 取均值；没数据 → 中性默认值（避免新候选被当成最快）
    let sum = 0, cnt = 0;
    for (const k of p.keys) {
      const lat = k.stats && k.stats.lastLatencyMs;
      if (lat > 0) { sum += lat; cnt++; }
    }
    return cnt ? sum / cnt : 2000;
  }

  /** 在给定候选组内挑选，不含兜底分流逻辑。
   *  strategy: round-robin（默认，轮流）| least-used（最闲优先）
   *           | cost-first（省钱：优先便宜候选）| latency-first（快：优先实测延迟低的候选） */
  pickFrom(targets, strategy) {
    const now = Date.now();
    const ranked = (strategy === 'cost-first' || strategy === 'latency-first');
    const list = ranked
      ? targets.slice().sort((a, b) => this.targetScore(a, strategy) - this.targetScore(b, strategy))
      : targets;
    const n = list.length;
    for (let i = 0; i < n; i++) {
      const ti = ranked ? i : (this.targetCursor + i) % n;
      const target = list[ti];
      const p = target.provider;
      const keys = p.keys;
      const m = keys.length;
      if (m === 0) continue;

      let startAt = p.cursor % m;
      if (strategy === 'least-used') {
        let best = -1, bestScore = Infinity;
        for (let j = 0; j < m; j++) {
          const k = keys[j];
          if (!k.usable(now)) continue;
          const score = k.stats.total + k.inflight * 1000;
          if (score < bestScore) { bestScore = score; best = j; }
        }
        if (best >= 0) { startAt = best; }
        else continue;
      } else {
        let found = -1;
        for (let j = 0; j < m; j++) {
          if (keys[(p.cursor + j) % m].usable(now)) { found = (p.cursor + j) % m; break; }
        }
        if (found < 0) continue;
        startAt = found;
      }

      const key = keys[startAt];
      p.cursor = (startAt + 1) % m;
      if (!ranked) this.targetCursor = (ti + 1) % n;
      return { target, key };
    }
    return null;
  }

  /** 最近的可用等待时间（用于 503 提示） */
  minWaitMs(targets) {
    const now = Date.now();
    let min = Infinity;
    for (const t of targets) {
      for (const k of t.provider.keys) min = Math.min(min, k.waitMs(now));
    }
    return min;
  }

  totalKeys() {
    let n = 0;
    for (const p of this.providers.values()) n += p.keys.length;
    return n;
  }

  snapshot() {
    const now = Date.now();
    const keys = [];
    for (const p of this.providers.values()) for (const k of p.keys) keys.push(k.snapshot(now));
    return keys;
  }
}

// ---------------------------------------------------------------- 全局状态

let CONFIG = deepMerge(DEFAULT_CONFIG, {});
let POOL = new Pool(CONFIG);
POOL.cfg = CONFIG;

// ---------------------------------------------------------------- 调度增强：半开探活 + 模型级熔断

const BREAKER = new Map(); // model -> { failStreak, openUntil }
let probeTimer = null;
let probeRunning = false;

/** 冷却/下线到期的 Key 是否具备探活资格 */
function probeEligible(key, now) {
  if (key.probing) return false;
  const h = CONFIG.halfOpen || {};
  if (h.enabled === false) return false;
  if (key.dead) {
    // 401/403 永久下线 → 若允许复活且冷却等待期已过
    if (!h.reviveDead) return false;
    if (now - key.deadAt < (h.reviveDelayMs || 600000)) return false;
    return now - key.lastProbeAt >= (h.failBackoffMs || 30000); // 探活失败退避
  }
  if (!key.pendingVerify) return false;      // 只有「冷却到期待验证」的 Key 才探
  if (key.cooldownUntil > now) return false; // 还没冷却完
  return now - key.lastProbeAt >= 2000;      // 防同节拍重复探
}

/** 单 Key 探活：GET {baseUrl}/{probePath}，2xx=健康，401/403=判死，其余=继续冷却 */
async function probeKey(key) {
  const provider = key.provider;
  const h = CONFIG.halfOpen || {};
  const probePath = (provider.probePath || h.probePath || 'models').replace(/^\/+/, '');
  const url = joinUrl(provider.baseUrl, probePath);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), h.probeTimeoutMs || 10000);
  key.probing = true;
  try {
    const resp = await fetch(url, {
      method: 'GET',
      headers: { [provider.authHeader || 'Authorization']: (provider.authPrefix !== undefined ? provider.authPrefix : 'Bearer ') + key.value, accept: 'application/json' },
      signal: ac.signal,
    });
    if (resp.ok) {
      const wasDead = key.dead;
      key.dead = false; key.deadReason = null; key.deadAt = 0;
      key.cooldownUntil = 0; key.pendingVerify = false;
      key.failStreak = 0;
      // S3：只清自身，不动整组冷却——兄弟 Key 若刚 429，组冷却应自然到期，不能被一次探活提前解锁
      key.probeFailStreak = 0;
      log('info', `${wasDead ? '探活复活' : '探活通过回池'} ${key.label}`, 'green');
    } else if (resp.status === 401 || resp.status === 403) {
      key.kill(`探活 ${resp.status}`);
      log('warn', `探活判死 ${key.label}：${resp.status}`, 'yellow');
    } else if (resp.status === 404 || resp.status === 405) {
      // S2：上游不支持该探活路径 → 不继续空转冷却，放行回池，交给真实请求验证
      key.cooldownUntil = 0; key.pendingVerify = false;
      key.probeFailStreak = 0;
      log('warn', `探活路径不可用（HTTP ${resp.status}），跳过探活直接回池 ${key.label}`, 'yellow');
    } else {
      key.softCooldown(h.failBackoffMs || 30000);
      key.probeFailStreak++;
      if (key.probeFailStreak >= 3) {
        // 探活连续失败（探活端点慢/不通），不代表 Key 不能用 → 放回池交真实请求验证
        key.cooldownUntil = 0; key.pendingVerify = false;
        log('warn', `探活连续失败 ${key.probeFailStreak} 次（HTTP ${resp.status}），跳过探活直接回池 ${key.label}`, 'yellow');
      } else {
        log('warn', `探活未通过 ${key.label}：HTTP ${resp.status}，继续冷却`, 'yellow');
      }
    }
  } catch (e) {
    key.softCooldown(h.failBackoffMs || 30000);
    key.probeFailStreak++;
    if (key.probeFailStreak >= 3) {
      // 探活超时/网络错误：探活本身不可靠时不应永久扣住 Key，放回池由真实请求判定
      key.cooldownUntil = 0; key.pendingVerify = false;
      log('warn', `探活连续失败 ${key.probeFailStreak} 次（${e.message}），跳过探活直接回池 ${key.label}`, 'yellow');
    } else {
      log('warn', `探活失败 ${key.label}：${e.message}，继续冷却`, 'yellow');
    }
  } finally {
    key.lastProbeAt = Date.now();
    key.probing = false;
    clearTimeout(timer);
  }
}

/** 扫一批到期 Key 探活（每节拍最多 probeMaxPerTick 个，防探测风暴） */
async function probeTick() {
  const h = CONFIG.halfOpen || {};
  if (h.enabled === false) return;
  const now = Date.now();
  const due = [];
  for (const p of POOL.providers.values()) {
    for (const k of p.keys) {
      if (probeEligible(k, now)) due.push(k);
      if (due.length >= (h.probeMaxPerTick || 2)) break;
    }
    if (due.length >= (h.probeMaxPerTick || 2)) break;
  }
  await Promise.all(due.map((k) => probeKey(k)));
}

function startProbeLoop() {
  const h = CONFIG.halfOpen || {};
  if (h.enabled === false) return;
  clearInterval(probeTimer);
  probeTimer = setInterval(() => { if (!probeRunning) { probeRunning = true; probeTick().finally(() => { probeRunning = false; }); } }, h.probeIntervalMs || 15000);
  // 启动后先跑一次
  setTimeout(() => { if (!probeRunning) { probeRunning = true; probeTick().finally(() => { probeRunning = false; }); } }, 3000);
}

/** 模型级熔断查询：返回 { open, retryAfterMs } */
function breakerCheck(model) {
  const b = BREAKER.get(model);
  if (!b || !b.openUntil) return { open: false };
  const remain = b.openUntil - Date.now();
  if (remain <= 0) { BREAKER.delete(model); return { open: false }; }
  return { open: true, retryAfterMs: remain };
}

/** S6：清理「已过期熔断」与「长时间未再失败、也没到阈值」的残留条目，防止 Map 无界增长 */
function breakerPrune(now) {
  const ttl = (CONFIG.breaker && CONFIG.breaker.pruneTtlMs) || 600000; // 10 分钟
  for (const [m, b] of BREAKER) {
    if (b.openUntil && b.openUntil <= now) BREAKER.delete(m);          // 熔断窗口已过
    else if (!b.openUntil && now - (b.seenAt || 0) > ttl) BREAKER.delete(m); // 未达阈值的陈年失败计数
  }
}

/** 一次完整请求全部失败 → 累计；达阈值打开熔断 */
function breakerFail(model) {
  const brk = CONFIG.breaker || {};
  if (!brk.enabled) return;
  const now = Date.now();
  breakerPrune(now);
  const b = BREAKER.get(model) || { failStreak: 0, openUntil: 0, seenAt: 0 };
  b.seenAt = now;
  if (b.openUntil > now) return; // 已在熔断中，不重复计
  b.failStreak++;
  if (b.failStreak >= (brk.failThreshold || 3)) {
    b.openUntil = now + (brk.openMs || 30000);
    b.failStreak = 0;
    log('warn', `模型「${model}」连续失败触发熔断 ${Math.round((brk.openMs || 30000) / 1000)}s`, 'red');
  }
  BREAKER.set(model, b);
}

/** 请求成功 → 关闭熔断 */
function breakerSuccess(model) {
  const b = BREAKER.get(model);
  if (!b) return;
  if (b.openUntil > Date.now()) log('info', `模型「${model}」熔断期请求成功，提前解除熔断`, 'green');
  BREAKER.delete(model);
}

// ---------------------------------------------------------------- 接入用户（中转站模式）

/**
 * accessKeys 格式：
 *   { "sk-user1": "同事A" }                                    简单备注
 *   { "sk-user1": { "name": "同事A", "rpm": 10, "daily": 200 } }  可限流：rpm=每分钟、daily=每天
 */
const accessUsers = new Map(); // token -> { name, rpm, daily, enabled, window, dailyCount, dailyDate, lastCallAt, totalCalls }
const disabledUsers = new Map(); // 被禁用的分发 Key：token -> { name, rpm, daily }（不参与鉴权，仅面板展示）

function resolveUserSpec(spec) {
  if (spec == null) return { name: '未命名', rpm: 0, daily: 0, enabled: true };
  if (typeof spec === 'string') return { name: spec || '未命名', rpm: 0, daily: 0, enabled: true };
  if (typeof spec === 'object' && !Array.isArray(spec)) {
    return {
      name: String(spec.name || '未命名'),
      rpm: Number(spec.rpm) > 0 ? Math.floor(Number(spec.rpm)) : 0,
      daily: Number(spec.daily) > 0 ? Math.floor(Number(spec.daily)) : 0,
      enabled: spec.enabled !== false, // 默认启用；显式 false 才禁用
    };
  }
  return { name: '未命名', rpm: 0, daily: 0, enabled: true };
}

function loadAccessUsers(accessKeys) {
  const prevAccess = new Map(accessUsers);     // 浅拷贝旧启用用户（含计数），clear 后仍可用
  const prevDisabled = new Map(disabledUsers); // 浅拷贝旧禁用用户（含计数）
  accessUsers.clear();
  disabledUsers.clear();
  let idx = 0;
  if (accessKeys && typeof accessKeys === 'object') {
    for (const [token, spec] of Object.entries(accessKeys)) {
      const t = String(token).trim();
      if (!t || t.startsWith('#') || t.startsWith('_')) continue;
      const specObj = resolveUserSpec(spec);
      // 旧计数：无论之前启用还是禁用都保留，杜绝「禁用→启用」或「热重载」重置计数绕过配额
      const old = prevAccess.get(t) || prevDisabled.get(t);
      if (specObj.enabled === false) {
        // 禁用 Key：不进入 accessUsers（调用 401），但把计数状态一并保留，再启用时恢复
        const base = old || { window: [], dailyCount: 0, dailyDate: '', lastCallAt: 0, totalCalls: 0 };
        const rec = Object.assign({}, base, specObj);
        delete rec.idx;
        disabledUsers.set(t, rec);
        continue;
      }
      const user = old || { window: [], dailyCount: 0, dailyDate: '', lastCallAt: 0, totalCalls: 0 };
      Object.assign(user, specObj);
      user.idx = ++idx; // 用于响应头 x-pool-user（ASCII 安全，中文不能进 HTTP 头）
      accessUsers.set(t, user);
    }
  }
  return accessUsers.size;
}

/** 「今日」按北京时间（UTC+8）计算——避免 UTC 0 点（北京早 8 点）就重置每日配额 */
function quotaDayKey(now) {
  return new Date(now + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/** 限流检查并记账。返回 { ok } 或 { ok:false, retryAfterSec, reason } */
function userQuotaCheck(user, now) {
  const day = quotaDayKey(now);
  if (user.dailyDate !== day) { user.dailyDate = day; user.dailyCount = 0; }
  if (user.rpm > 0) {
    const cut = now - 60000;
    while (user.window.length && user.window[0] < cut) user.window.shift();
    if (user.window.length >= user.rpm) {
      const retryAfterSec = Math.max(1, Math.ceil((user.window[0] + 60000 - now) / 1000));
      return { ok: false, retryAfterSec, reason: `每分钟限 ${user.rpm} 次，请稍后再试` };
    }
  }
  if (user.daily > 0 && user.dailyCount >= user.daily) {
    // 用户当日配额用尽告警（按用户 idx 防抖，A 用尽不阻塞 B 告警）
    const a = CONFIG.alert || {};
    if (a.enabled !== false && a.onUserDailyExhausted !== false) {
      notifyAlert(`daily_exhausted:${user.idx || user.name}`, `用户额度用尽：${user.name}`, `用户「${user.name}」今日已用 ${user.dailyCount}/${user.daily} 次，配额用尽，后续请求将返回 429。`);
    }
    return { ok: false, retryAfterSec: 3600, reason: `今日限 ${user.daily} 次，已用尽` };
  }
  user.window.push(now);
  user.dailyCount++;
  user.totalCalls++;
  user.lastCallAt = now;
  return { ok: true };
}

/** 分发的 Key 脱敏显示：sk-abc…xyz */
function maskAccessToken(t) {
  if (t.length <= 10) return `${t.slice(0, 3)}…`;
  return `${t.slice(0, 7)}…${t.slice(-4)}`;
}

function reloadConfig() {
  const raw = readJson(CONFIG_PATH);
  CONFIG = deepMerge(DEFAULT_CONFIG, raw);
  LOG_LEVEL = CONFIG.logLevel || 'info';
  POOL.cfg = CONFIG;
  POOL.applyConfig(CONFIG);
  const n = loadAccessUsers(CONFIG.accessKeys);
  // 热重载后半开参数可能变化：重启探活循环（启停跟随 enabled 开关）
  if (CONFIG.halfOpen && CONFIG.halfOpen.enabled !== false) startProbeLoop();
  else if (probeTimer) { clearInterval(probeTimer); probeTimer = null; }
  if (CONFIG.proxyApiKey || n > 0) log('info', `鉴权已开启：分发 Key ${n} 个${CONFIG.proxyApiKey ? ' + 旧版单 Key' : ''}`, 'green');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, Math.max(0, ms)));
}

// ---------------------------------------------------------------- HTTP 工具

function readBody(req, limitBytes = 32 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// 非流式上游响应体大小上限（64MB）：超限返回 502，防止异常上游拖垮内存
const MAX_UPSTREAM_BODY = 64 * 1024 * 1024;

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-length', 'content-encoding',
]);

/**
 * HTTP 头的值必须是 Latin-1。含中文等非 ASCII 字符时 Node 的 fetch 会直接抛
 * "Cannot convert argument to a ByteString"，所以转发前先筛掉。
 */
function isHeaderSafe(v) {
  const s = Array.isArray(v) ? v.join(', ') : String(v);
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 255) return false;
  return true;
}

function buildUpstreamHeaders(clientHeaders, provider, keyValue, isStream) {
  const h = {
    'content-type': 'application/json',
    accept: isStream ? 'text/event-stream' : 'application/json',
  };
  for (const [k, v] of Object.entries(provider.extraHeaders || {})) h[k] = v;
  // 透传客户端的 x- 开头自定义头与 user-agent
  for (const [k, v] of Object.entries(clientHeaders)) {
    const lk = k.toLowerCase();
    if (HOP_BY_HOP.has(lk)) continue;
    if (lk === 'authorization' || lk === 'content-type' || lk === 'host' || lk === 'accept' || lk === 'accept-encoding') continue;
    if (lk.startsWith('x-') && isHeaderSafe(v)) h[k] = v;
  }
  if (provider.authHeader) h[provider.authHeader] = (provider.authPrefix || '') + keyValue;
  return h;
}

function buildResponseHeaders(upstream, slot, attemptNo, userName) {
  const out = {};
  upstream.headers.forEach((v, k) => {
    const lk = k.toLowerCase();
    if (HOP_BY_HOP.has(lk)) return;
    if (lk === 'content-type' || lk === 'cache-control' || lk.startsWith('x-') || lk === 'retry-after') out[k] = v;
  });
  if (!out['content-type']) out['content-type'] = 'application/json; charset=utf-8';
  out['x-powered-by'] = 'api-key-pool';
  if (slot) {
    out['x-pool-key'] = slot.key.id;
    out['x-pool-provider'] = slot.target.provider.name;
    out['x-pool-model'] = slot.target.model;
    out['x-pool-attempt'] = String(attemptNo || 1);
  }
  if (userName) out['x-pool-user'] = String(userName);
  return out;
}

function sendJson(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj, null, 2), 'utf8');
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length });
  res.end(body);
}

function parseRetryAfter(resp) {
  const v = resp.headers.get('retry-after');
  if (!v) return 0;
  const sec = Number(v);
  if (!Number.isNaN(sec)) return sec * 1000;
  const d = Date.parse(v);
  if (!Number.isNaN(d)) return Math.max(0, d - Date.now());
  return 0;
}

// ---------------------------------------------------------------- 核心转发

/**
 * 尝试一次上游调用。
 * 返回 { kind: 'ok', resp } 表示已拿到可返回客户端的响应（尚未读取 body）
 *      { kind: 'retry' } 表示应换 Key 重试
 *      { kind: 'fatal', status, body } 表示应直接返回给客户端，不重试
 */
async function attempt(slot, bodyObj, isStream, clientHeaders, abortSignal) {
  const provider = slot.target.provider;
  const url = joinUrl(provider.baseUrl, provider.chatPath);
  const t0 = Date.now();
  const now = Date.now();
  slot.key.begin(now);

  const ac = new AbortController();
  const onAbort = () => ac.abort();
  if (abortSignal) {
    if (abortSignal.aborted) ac.abort();
    else abortSignal.addEventListener('abort', onAbort, { once: true });
  }
  const timeoutMs = provider.requestTimeoutMs > 0 ? provider.requestTimeoutMs : CONFIG.requestTimeoutMs;
  const timer = setTimeout(() => ac.abort(new Error('timeout')), timeoutMs);

  const payload = Object.assign({}, bodyObj, { model: slot.target.model, stream: !!isStream });

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: buildUpstreamHeaders(clientHeaders, provider, slot.key.value, isStream),
      body: JSON.stringify(payload),
      signal: ac.signal,
      redirect: 'follow',
    });
    clearTimeout(timer);
    if (abortSignal) abortSignal.removeEventListener('abort', onAbort);

    const latency = Date.now() - t0;

    if (resp.ok) {
      slot.key.succeed(latency);
      log('info', `${COLORS.green}200${COLORS.reset} ${slot.key.label} -> ${slot.target.model} ${latency}ms`, '');
      return { kind: 'ok', resp, latency };
    }

    const status = resp.status;
    const text = await resp.text().catch(() => '');

    if (status === 429) {
      const wait = slot.key.rateLimit(parseRetryAfter(resp));
      const streak = (slot.key.provider.groupCooldownOn429 !== false && slot.key.group) ? slot.key.group.failStreak : slot.key.failStreak;
      log('warn', `429 限流 ${slot.key.label} -> 冷却 ${Math.round(wait / 1000)}s（连续第 ${streak} 次），换 Key`, 'yellow');
      return { kind: 'retry', status, text };
    }
    if (status === 401 || status === 403) {
      slot.key.kill(`${status} ${text.slice(0, 120)}`);
      log('error', `${status} Key 无效，已永久下线 ${slot.key.label}`, 'red');
      return { kind: 'retry', status, text };
    }
    if (status >= 500 || status === 408 || status === 409) {
      slot.key.softCooldown(provider.serverErrorCooldownMs);
      slot.key.fail(`${status}`);
      log('warn', `${status} 上游故障 ${slot.key.label}，换 Key`, 'yellow');
      return { kind: 'retry', status, text };
    }
    // 其他 4xx：请求本身有问题，换 Key 也没用
    slot.key.fail(`${status} ${text.slice(0, 80)}`);
    log('warn', `${status} 客户端错误，不重试 ${slot.key.label}: ${text.slice(0, 200)}`, 'yellow');
    return { kind: 'fatal', status, text };
  } catch (err) {
    clearTimeout(timer);
    if (abortSignal) abortSignal.removeEventListener('abort', onAbort);
    const latency = Date.now() - t0;
    if (err && err.name === 'AbortError') {
      if (abortSignal && abortSignal.aborted) {
        slot.key.fail('client-abort');
        return { kind: 'client-abort' };
      }
      slot.key.softCooldown(provider.serverErrorCooldownMs);
      slot.key.fail(`timeout ${latency}ms`);
      log('warn', `超时 ${slot.key.label} ${latency}ms，换 Key`, 'yellow');
      return { kind: 'retry', status: 504, text: `upstream timeout after ${latency}ms` };
    }
    slot.key.softCooldown(provider.serverErrorCooldownMs);
    slot.key.fail(err.message);
    log('warn', `网络错误 ${slot.key.label}: ${err.message}，换 Key`, 'yellow');
    return { kind: 'retry', status: 502, text: err.message };
  }
}

function normalizeSseLine(line) {
  if (!line.startsWith('data: ') || line === 'data: [DONE]') return line;
  try {
    const event = JSON.parse(line.slice(6));
    let changed = false;
    for (const choice of event.choices || []) {
      if (choice && choice.finish_reason === '') {
        choice.finish_reason = null;
        changed = true;
      }
    }
    return changed ? `data: ${JSON.stringify(event)}` : line;
  } catch (_) {
    return line; // 非 JSON SSE 事件原样透传
  }
}

/**
 * 将非标准 SSE 的 finish_reason="" 归一为 OpenAI 标准 null。
 * 逐行缓冲以处理 TCP/Fetch chunk 恰好切在 SSE 行中间的情况；非 data 行及 [DONE] 不改。
 */
function createFinishReasonNormalizer() {
  let pending = '';
  return new Transform({
    transform(chunk, _encoding, callback) {
      pending += chunk.toString('utf8');
      let newline;
      while ((newline = pending.indexOf('\n')) >= 0) {
        const raw = pending.slice(0, newline + 1);
        pending = pending.slice(newline + 1);
        const line = raw.endsWith('\r\n') ? raw.slice(0, -2) : raw.slice(0, -1);
        const ending = raw.endsWith('\r\n') ? '\r\n' : '\n';
        this.push(`${normalizeSseLine(line)}${ending}`);
      }
      callback();
    },
    flush(callback) {
      if (pending) this.push(normalizeSseLine(pending));
      callback();
    },
  });
}

/** 把上游响应转发给客户端（流式 / 非流式统一处理）。返回 { usage } 供调用日志记 token（流式拿不到，为 null） */
async function relay(resp, res, isStream, abortSignal, slot, attemptNo, userName) {
  const headers = buildResponseHeaders(resp, slot, attemptNo, userName);
  if (isStream) {
    res.writeHead(resp.status, headers);
    const upstreamStream = Readable.fromWeb(resp.body);
    const nodeStream = slot.target.provider.normalizeEmptyFinishReason
      ? upstreamStream.pipe(createFinishReasonNormalizer())
      : upstreamStream;
    const destroyStreams = () => {
      upstreamStream.destroy();
      if (nodeStream !== upstreamStream) nodeStream.destroy();
    };
    let idleTimer = setTimeout(() => destroyStreams(), CONFIG.streamIdleTimeoutMs);
    const reset = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => destroyStreams(), CONFIG.streamIdleTimeoutMs); };
    nodeStream.on('data', reset);
    await new Promise((resolve) => {
      let done = false;
      const finish = () => { if (done) return; done = true; clearTimeout(idleTimer); resolve(); };
      nodeStream.on('end', finish);
      nodeStream.on('close', finish);
      nodeStream.on('error', () => { try { res.end(); } catch (_) {} finish(); });
      if (abortSignal) abortSignal.addEventListener('abort', destroyStreams, { once: true });
      nodeStream.pipe(res);
      res.on('close', destroyStreams);
    });
    return { usage: null };
  }
  const buf = Buffer.from(await resp.arrayBuffer());
  // 非流式上游响应大小上限：防异常上游返回超大 body 拖垮内存
  if (buf.length > MAX_UPSTREAM_BODY) {
    log('warn', `上游响应过大 ${buf.length} 字节 > ${MAX_UPSTREAM_BODY}，已截断返回 502`, 'yellow');
    sendJson(res, 502, { error: { message: `上游响应过大（${buf.length} 字节）`, type: 'upstream_too_large' } });
    return { usage: null };
  }
  headers['content-length'] = buf.length;
  res.writeHead(resp.status, headers);
  res.end(buf);
  return { usage: parseUsage(buf) };
}

// ---------------------------------------------------------------- 请求处理

async function handleChat(req, res, bodyObj) {
  const tStart = Date.now();
  const model = bodyObj && bodyObj.model;
  if (!model) return sendJson(res, 400, { error: { message: '缺少 model 字段', type: 'invalid_request_error' } });

  // 模型级熔断：该模型近期连续全败 → 秒回 503，不再反复试错 / 傻等排队
  const brk = breakerCheck(model);
  if (brk.open) {
    logUsage(makeUsageEntry(req, { model, status: 503, latencyMs: Date.now() - tStart, errorType: 'circuit_open' }));
    res.setHeader('retry-after', String(Math.ceil(brk.retryAfterMs / 1000)));
    return sendJson(res, 503, {
      error: {
        message: `模型「${model}」正处熔断窗口（近期连续失败），请 ${Math.ceil(brk.retryAfterMs / 1000)} 秒后重试`,
        type: 'circuit_open',
        retryAfterMs: Math.ceil(brk.retryAfterMs),
      },
    });
  }

  const targets = POOL.resolveTargets(model);
  if (!targets.length) {
    logUsage(makeUsageEntry(req, { model, status: 400, latencyMs: Date.now() - tStart, errorType: 'no_target' }));
    return sendJson(res, 400, { error: { message: `未配置任何可用平台，请检查 config.json 的 providers`, type: 'invalid_request_error' } });
  }

  const isStream = !!bodyObj.stream;
  const maxAttempts = Math.max(1, CONFIG.maxAttempts, targets.length);
  const deadline = Date.now() + CONFIG.waitForSlotMs;

  const clientAbort = new AbortController();
  let aborted = false;
  req.on('aborted', () => { aborted = true; clientAbort.abort(); });
  res.on('close', () => { if (!res.writableFinished) { aborted = true; clientAbort.abort(); } });

  const errors = [];
  let waited = false;

  for (let i = 1; i <= maxAttempts; i++) {
    if (aborted) return;

    let slot = POOL.pick(targets, CONFIG.strategy);
    if (!slot) {
      // 全部 Key 都不可用。区分两种情况：
      // - 冷却/额度用尽/待探活：waitMs 给出明确的等待时长，可能远超排队预算——等不到就别傻等，快速失败（503 会带 retry-after）；
      // - 忙碌中（inflight 占满）：waitMs 为 0，短等待轮询即可，等流式请求释放。
      // 降级兜底（借鉴 one-api 的 ignoreFirstPriority）：主力长时间等不到时，主动降级到 fallback 候选，
      //   而不是干等到超时——保可用性优先（兜底慢但能回，总比 503 强）。
      const fbTargets = targets.filter((t) => t.fallback);
      const tryPick = () => POOL.pick(targets, CONFIG.strategy);
      const tryFallback = () => (fbTargets.length ? POOL.pickFrom(fbTargets, CONFIG.strategy) : null);

      const minWait = POOL.minWaitMs(targets);
      const remain = deadline - Date.now();
      if (Number.isFinite(minWait) && minWait > 0) {
        if (minWait > remain) {
          // 主力预算内等不到：先降级试兜底，兜底也没有才快速失败
          slot = tryFallback();
          if (slot) log('warn', `主力近期无法恢复，降级到兜底：${slot.key.label}`, 'yellow');
          if (!slot) break;
        } else {
          if (!waited) { log('warn', `所有 Key 均不可用，最近约 ${Math.ceil(minWait / 1000)}s 后可恢复，等待 ${Math.ceil(minWait / 1000)}s`, 'yellow'); waited = true; }
          await sleep(Math.min(minWait, remain));
          if (aborted) return;
          slot = tryPick();
        }
      } else {
        if (!waited) { log('warn', `所有 Key 均忙，进入排队等待（最长 ${CONFIG.waitForSlotMs / 1000}s）`, 'yellow'); waited = true; }
        // 等待期间促发一次探活（若队列里有「冷却到期待验证」的 Key，让它们尽快回池）
        if (CONFIG.halfOpen && CONFIG.halfOpen.enabled !== false && !probeRunning) {
          probeRunning = true;
          probeTick().finally(() => { probeRunning = false; });
        }
        const degradeAt = Date.now() + (CONFIG.waitForSlotMs >> 1); // 排队预算过半还没等到 → 降级兜底
        while (!slot && Date.now() < deadline) {
          await sleep(120);
          if (aborted) return;
          slot = tryPick();
          if (!slot && Date.now() >= degradeAt) {
            slot = tryFallback();
            if (slot) log('warn', `主力排队 ${Math.ceil((Date.now() - (deadline - CONFIG.waitForSlotMs)) / 1000)}s 未释放，降级到兜底：${slot.key.label}`, 'yellow');
          }
        }
      }
      if (!slot) break;
      log('info', `等到可用 Key：${slot.key.label}`, 'green');
    }

    const r = await attempt(slot, bodyObj, isStream, req.headers, clientAbort.signal);

    if (r.kind === 'ok') {
      breakerSuccess(model);
      const rel = await relay(r.resp, res, isStream, clientAbort.signal, slot, i, req.poolUser);
      logUsage(makeUsageEntry(req, {
        model, provider: slot.target.provider.name, keyId: slot.key.id,
        status: r.resp.status, latencyMs: Date.now() - tStart, tokens: rel.usage, stream: isStream,
      }));
      return;
    }
    if (r.kind === 'client-abort') {
      logUsage(makeUsageEntry(req, { model, status: null, latencyMs: Date.now() - tStart, stream: isStream, errorType: 'client_abort' }));
      return;
    }
    if (r.kind === 'fatal') {
      logUsage(makeUsageEntry(req, {
        model, provider: slot.target.provider.name, keyId: slot.key.id,
        status: r.status, latencyMs: Date.now() - tStart, stream: isStream, errorType: 'fatal',
      }));
      res.writeHead(r.status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(r.text || '');
      return;
    }
    errors.push({ attempt: i, key: slot.key.id, provider: slot.target.provider.name, status: r.status, error: String(r.text || '').slice(0, 300) });
  }

  // 只有真实发生过上游尝试（errors 非空）且全部失败，才累计熔断；纯排队超时（没打出去一次）不算是模型故障
  if (errors.length > 0) {
    breakerFail(model);
  } else if (CONFIG.halfOpen && CONFIG.halfOpen.enabled !== false && !probeRunning) {
    probeRunning = true;
    probeTick().finally(() => { probeRunning = false; });
  }

  const wait = POOL.minWaitMs(targets);
  const candidateKeys = targets.reduce((s, t) => s + t.provider.keys.length, 0);
  const msg = POOL.totalKeys() === 0
    ? 'config.json 里没有配置任何 API Key'
    : `model「${model}」对应的 ${candidateKeys} 个 Key 全部不可用（限流冷却中 / 并发占满 / 配额用完 / 待探活）`;
  log('error', `${msg}（model=${model}）`, 'red');
  logUsage(makeUsageEntry(req, {
    model, status: 503, latencyMs: Date.now() - tStart, stream: isStream,
    errorType: errors.length > 0 ? 'no_available_key' : 'queue_timeout',
  }));
  sendJson(res, 503, {
    error: {
      message: msg,
      type: 'no_available_key',
      retryAfterMs: Number.isFinite(wait) ? Math.ceil(wait) : null,
      attempts: errors,
    },
  });
}

async function handleModels(req, res) {
  const list = [];
  const seen = new Set();
  for (const [alias, targets] of Object.entries(CONFIG.models || {})) {
    if (seen.has(alias) || alias.startsWith('_')) continue; // 下划线开头的是注释字段
    seen.add(alias);
    list.push({ id: alias, object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'api-key-pool', pool_targets: (Array.isArray(targets) ? targets : [targets]).map((t) => (typeof t === 'string' ? t : `${t.provider}:${t.model}`)) });
  }
  if (CONFIG.exposePassthrough) {
    for (const p of POOL.providers.values()) list.push({ id: `${p.name}:__passthrough__`, object: 'model', created: 0, owned_by: 'api-key-pool' });
  }
  sendJson(res, 200, { object: 'list', data: list });
}

function handleStats(res) {
  const keys = POOL.snapshot();
  const summary = { total: keys.length, ready: 0, busy: 0, cooling: 0, verify: 0, dead: 0, ok: 0, fail: 0, limited: 0 };
  for (const k of keys) {
    summary[k.state]++;
    summary.ok += k.stats.ok;
    summary.fail += k.stats.fail;
    summary.limited += k.stats.limited;
  }
  const users = [...accessUsers.entries()].map(([token, u]) => ({
    key: maskAccessToken(token),
    name: u.name,
    rpm: u.rpm || null,
    daily: u.daily || null,
    enabled: true,
    todayCalls: u.dailyCount,
    totalCalls: u.totalCalls,
    lastCallAt: u.lastCallAt || null,
  }));
  const disabled = [...disabledUsers.entries()].map(([token, u]) => ({
    key: maskAccessToken(token),
    name: u.name,
    rpm: u.rpm || null,
    daily: u.daily || null,
    enabled: false,
    todayCalls: u.dailyCount || 0,
    totalCalls: u.totalCalls || 0,
    lastCallAt: u.lastCallAt || null,
  }));
  const breakers = [...BREAKER.entries()].map(([model, b]) => ({
    model,
    openRemainMs: b.openUntil ? Math.max(0, b.openUntil - Date.now()) : 0,
  })).filter((b) => b.openRemainMs > 0);
  const breaker = CONFIG.breaker || {};
  sendJson(res, 200, {
    uptimeSec: Math.floor(process.uptime()),
    summary, keys, users, disabledUsers: disabled,
    breakers,
    alerts: alertLog.slice(0, 20).map((a) => ({ kind: a.kind, title: a.title, detail: a.detail, at: a.at, sent: a.sent, error: a.error })),
    scheduler: {
      strategy: CONFIG.strategy,
      halfOpen: (CONFIG.halfOpen || {}).enabled !== false,
      breakerEnabled: breaker.enabled !== false,
      breakerFailThreshold: breaker.failThreshold,
      groupCooldownOn429: CONFIG.groupCooldownOn429 !== false,
    },
  });
}

function handleDashboard(res) {
  const keys = POOL.snapshot();
  const rows = keys.map((k) => {
    let color, label;
    if (k.state === 'ready') { color = '#16a34a'; label = '可用'; }
    else if (k.state === 'busy') { color = '#2563eb'; label = '忙碌'; }
    else if (k.state === 'verify') { color = '#7c3aed'; label = '待探活'; }
    else if (k.state === 'cooling') { color = '#d97706'; label = `冷却 ${Math.ceil(k.cooldownRemainMs / 1000)}s`; if (k.groupCooldownRemainMs > k.cooldownRemainMs) label += `(组 ${Math.ceil(k.groupCooldownRemainMs / 1000)}s)`; }
    else { color = '#dc2626'; label = k.deadReason && k.deadReason.includes('探活') ? '待复活' : '已下线'; }
    const rpm = k.group
      ? `${k.groupRpmUsed}/${k.groupRpmLimit || '∞'} (组)`
      : `${k.rpmUsed}/${k.rpmLimit || '∞'}`;
    return `<tr>
      <td><code>${k.id}</code></td>
      <td><code>${k.key}</code></td>
      <td>${k.group ? `<code>${k.group}</code>` : '-'}</td>
      <td><span class="dot" style="background:${color}"></span>${label}</td>
      <td>${k.inflight}</td>
      <td>${rpm}</td>
      <td>${k.stats.ok}</td>
      <td>${k.stats.fail}</td>
      <td>${k.stats.limited}</td>
      <td>${k.stats.lastLatencyMs || '-'}</td>
      <td class="err">${(k.deadReason || k.stats.lastError || '').toString().slice(0, 60)}</td>
    </tr>`;
  }).join('');

  const userRows = accessUsers.size ? [...accessUsers.entries()].map(([token, u]) => {
    const last = u.lastCallAt ? new Date(u.lastCallAt).toLocaleTimeString('zh-CN', { hour12: false }) : '-';
    const dailyTxt = u.daily ? `${u.dailyCount}/${u.daily}` : `${u.dailyCount}`;
    return `<tr>
      <td><code>${maskAccessToken(token)}</code></td>
      <td>${u.name}</td>
      <td>${u.rpm || '∞'}/min</td>
      <td>${dailyTxt}${u.daily ? '' : '（不限）'}</td>
      <td>${u.totalCalls}</td>
      <td>${last}</td>
    </tr>`;
  }).join('') : '';

  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta http-equiv="refresh" content="5">
<title>API Key 代理池 · 状态</title>
<style>
  body{font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;background:#f7f8fa;color:#1f2328;margin:0;padding:32px}
  h1{font-size:20px;margin:0 0 4px}
  .sub{color:#6b7280;font-size:13px;margin-bottom:20px}
  .cards{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:24px}
  .card{background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:14px 18px;min-width:110px}
  .card b{display:block;font-size:22px;margin-top:4px}
  table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #e5e7eb;border-radius:10px;overflow:hidden;font-size:13px}
  th,td{padding:9px 12px;text-align:left;border-bottom:1px solid #f0f1f3}
  th{background:#fafbfc;font-weight:600;color:#4b5563}
  tr:last-child td{border-bottom:none}
  .dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;vertical-align:middle}
  code{font-family:ui-monospace,Consolas,monospace;font-size:12px}
  .err{color:#9ca3af;max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .tip{margin-top:18px;font-size:12px;color:#6b7280;line-height:1.7}
</style></head><body>
<h1>API Key 代理池 · 运行状态</h1>
<div class="sub">监听 <code>http://${CONFIG.host}:${CONFIG.port}</code> · 运行 ${Math.floor(process.uptime())}s · 页面每 5 秒自动刷新</div>
<div class="cards">
  <div class="card">Key 总数<b>${keys.length}</b></div>
  <div class="card">可用<b style="color:#16a34a">${keys.filter(k=>k.state==='ready').length}</b></div>
  <div class="card">冷却中<b style="color:#d97706">${keys.filter(k=>k.state==='cooling').length}</b></div>
  <div class="card">待探活<b style="color:#7c3aed">${keys.filter(k=>k.state==='verify').length}</b></div>
  <div class="card">已下线<b style="color:#dc2626">${keys.filter(k=>k.state==='dead').length}</b></div>
  <div class="card">成功<b style="color:#16a34a">${keys.reduce((s,k)=>s+k.stats.ok,0)}</b></div>
  <div class="card">限流次数<b style="color:#d97706">${keys.reduce((s,k)=>s+k.stats.limited,0)}</b></div>
</div>
${(() => { const bks = [...BREAKER.entries()].map(([m, b]) => ({ m, r: b.openUntil ? Math.max(0, b.openUntil - Date.now()) : 0 })).filter((x) => x.r > 0); return bks.length ? `<div class="cards"><div class="card">熔断中模型<b style="color:#dc2626">${bks.length}</b></div>${bks.slice(0, 4).map((x) => `<div class="card" style="min-width:150px">${x.m}<b style="font-size:14px;color:#d97706">${Math.ceil(x.r / 1000)}s 后重试</b></div>`).join('')}</div>` : ''; })()}
<table><thead><tr><th>Key</th><th>值</th><th>账号组</th><th>状态</th><th>并发</th><th>RPM(60s)</th><th>成功</th><th>失败</th><th>429</th><th>最近耗时(ms)</th><th>最近错误</th></tr></thead>
<tbody>${rows || '<tr><td colspan="11">尚未配置 Key</td></tr>'}</tbody></table>
${userRows ? `<h2 style="font-size:15px;margin:24px 0 8px">接入用户（${accessUsers.size}）</h2>
<table><thead><tr><th>分发的 Key</th><th>用户</th><th>RPM 限制</th><th>今日用量</th><th>累计调用</th><th>最近调用</th></tr></thead>
<tbody>${userRows}</tbody></table>` : ''}
<div class="tip">
  调用地址：<code>http://${CONFIG.host}:${CONFIG.port}/v1/chat/completions</code>（OpenAI SDK 只需改 base_url）<br>
  统计接口：<code>/stats</code> · 健康检查：<code>/health</code> · 修改 config.json 保存后自动热重载${accessUsers.size ? '<br>中转鉴权已开启，调用方需携带 <code>Authorization: Bearer &lt;分发 Key&gt;</code>' : ''}
</div>
</body></html>`;
  const buf = Buffer.from(html, 'utf8');
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': buf.length });
  res.end(buf);
}

// ---------------------------------------------------------------- 管理操作台

function isLoopbackReq(req) {
  const ra = req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : '';
  return ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1';
}

/**
 * 判断浏览器来源（Origin 头）是否可信，用于防 DNS rebinding / 恶意网页窃取本机配置。
 * - 无 Origin（Node/curl 等非浏览器客户端）：放行
 * - 本机来源（127.0.0.1 / localhost / ::1）：放行（操作台同源 fetch）
 * - 外部来源：仅当 Origin 的主机名与浏览器实际访问的 Host 一致（正常远程管理）才放行
 */
function isTrustedOrigin(origin, reqHost) {
  if (!origin) return true;
  try {
    const o = new URL(String(origin));
    const local = ['127.0.0.1', 'localhost', '::1'];
    if (local.includes(o.hostname.toLowerCase())) return true;
    if (reqHost) {
      const hh = String(reqHost).toLowerCase().replace(/:\d+$/, '');
      return o.hostname.toLowerCase() === hh;
    }
    return false;
  } catch (_) {
    return false;
  }
}

/** 管理接口鉴权：未设 adminToken 时仅本机可访问；设了则需 Bearer adminToken（本机/远程一律）。
 *  网页登录（cookie 会话）的 admin/collab 角色同样放行——管理台从门户跳转过来时无 Bearer 头。 */
function adminAllowed(req) {
  const t = CONFIG.adminToken;
  if (!t) return isLoopbackReq(req);
  if (extractBearer(req) === t) return true;
  // cookie 会话角色:admin 全过;collab 只过 collab 专用接口(在路由层再细分)
  const cur = currentUser(req);
  if (cur && (cur.user.role === 'admin')) return true;
  return false;
}

/** 从请求里提取 Bearer token（无前缀也接受，与 adminAllowed 一致） */
function extractBearer(req) {
  const auth = String(req.headers.authorization || '');
  return auth.startsWith('Bearer ') ? auth.slice(7).trim() : auth.trim();
}

/** 协同管理员：collabTokens 里登记的 token。可上传上游 Key、生成分发 Key，不可改其他配置。
 *  网页登录的 collab 角色用户(cookie 会话)拥有同等权限。 */
function resolveCollab(req) {
  const viaSession = (() => {
    const cur = currentUser(req);
    return (cur && cur.user.role === 'collab') ? { token: '(session)', name: cur.user.name.replace(/^collab:/, '') } : null;
  })();
  if (viaSession) return viaSession;
  const collab = CONFIG.collabTokens;
  if (!collab || typeof collab !== 'object' || Array.isArray(collab)) return null;
  const t = extractBearer(req);
  if (!t) return null;
  const name = collab[t];
  if (!name) return null;
  return { token: t, name: String(name) };
}

function genRandomToken(len = 32) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

/**
 * 协同管理员接口（受限写操作，管理员接口不受影响）：
 *   POST /admin/api/collab/keys        { provider, keys: [...] }        往指定平台追加上游 Key
 *   POST /admin/api/collab/accessKeys  { name, rpm?, daily?, count? }   生成分发 Key（默认 1 个）
 * 只允许操作白名单字段；写盘后走同一套原子写+热重载。
 */
async function handleCollabApi(req, res, url, collab) {
  const action = url.pathname.replace(/^\/admin\/api\/collab\//, '');
  // 读取当前盘上配置（不走内存 CONFIG，避免和操作台并发保存互相覆盖）
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    return sendJson(res, 500, { error: { message: '读取配置失败：' + e.message, type: 'internal_error' } });
  }
  if (!raw.accessKeys || typeof raw.accessKeys !== 'object') raw.accessKeys = {};

  const save = () => {
    const json = JSON.stringify(raw, null, 2);
    const tmp = CONFIG_PATH + '.tmp';
    fs.writeFileSync(tmp, json, 'utf8');
    try { fs.renameSync(tmp, CONFIG_PATH); }
    catch (e) { fs.writeFileSync(CONFIG_PATH, json, 'utf8'); try { fs.unlinkSync(tmp); } catch (_) {} }
    reloadConfig();
  };

  if (req.method === 'POST' && action === 'keys') {
    const body = JSON.parse((await readBody(req, 1024 * 1024)).toString('utf8') || '{}');
    const providerName = String(body.provider || '').trim();
    const keys = Array.isArray(body.keys) ? body.keys.map((k) => String(k).trim()).filter(Boolean) : [];
    if (!providerName || !keys.length) return sendJson(res, 400, { error: { message: '需要 provider 和 keys 数组', type: 'invalid_request_error' } });
    const p = (raw.providers || []).find((x) => x && x.name === providerName);
    if (!p) return sendJson(res, 404, { error: { message: `平台「${providerName}」不存在`, type: 'not_found' } });
    if (!Array.isArray(p.keys)) p.keys = [];
    const existing = new Set(p.keys.map((k) => k.split('@')[0]));
    const added = [], skipped = [];
    for (const k of keys) {
      const base = k.split('@')[0];
      if (existing.has(base)) { skipped.push(base.slice(0, 8) + '…'); continue; }
      p.keys.push(k); existing.add(base); added.push(base.slice(0, 8) + '…');
    }
    if (added.length) save();
    log('info', `协同管理员「${collab.name}」向 ${providerName} 追加 ${added.length} 个上游 Key（跳过重复 ${skipped.length}）`, 'magenta');
    return sendJson(res, 200, { ok: true, added: added.length, skipped: skipped.length, providerKeys: p.keys.length });
  }

  if (req.method === 'POST' && action === 'accessKeys') {
    const body = JSON.parse((await readBody(req, 1024 * 1024)).toString('utf8') || '{}');
    const count = Math.min(Math.max(parseInt(body.count, 10) || 1, 1), 20);
    const name = String(body.name || '协同用户').slice(0, 40);
    const rpm = Math.min(Math.max(parseInt(body.rpm, 10) || 10, 1), 600);
    const daily = Math.min(Math.max(parseInt(body.daily, 10) || 300, 1), 100000);
    const created = [];
    for (let i = 0; i < count; i++) {
      const key = 'sk-pool-' + genRandomToken();
      const finalName = count > 1 ? `${name}${i + 1}` : name;
      raw.accessKeys[key] = { name: finalName, rpm, daily };
      created.push({ key, name: finalName, rpm, daily });
      // 记录创建者，供协同管理员之后查看自己发的 Key（网页会话身份记在 collab:名字 下）
      const creatorKey = collab.token === '(session)' ? collab.name : collab.token;
      if (creatorKey !== '(admin)') {
        if (!COLLAB_CREATED.has(creatorKey)) COLLAB_CREATED.set(creatorKey, []);
        COLLAB_CREATED.get(creatorKey).push(key);
      }
    }
    save();
    log('info', `协同管理员「${collab.name}」创建 ${count} 个分发 Key（${name}，${rpm}RPM/日${daily}）`, 'magenta');
    return sendJson(res, 200, { ok: true, created });
  }

  return sendJson(res, 404, { error: { message: `协同管理不支持的操作 ${action}`, type: 'not_found' } });
}

function handleAdminPage(res) {
  const fp = path.join(ROOT, 'admin.html');
  let buf;
  try {
    buf = fs.readFileSync(fp);
  } catch (e) {
    return sendJson(res, 500, { error: { message: 'admin.html 缺失：' + e.message, type: 'internal_error' } });
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': buf.length });
  res.end(buf);
}

// ---------------------------------------------------------------- 用户账号体系（网站地基）

const crypto = require('node:crypto');
const USERS_PATH = path.join(ROOT, 'users.json');
const USERS = { byName: new Map(), byId: new Map() };        // name -> user, id -> user
const SESSIONS = new Map();                                  // sid -> { userId, name, role, createdAt }
const CAPTCHAS = new Map();                                  // cid -> { text, expiresAt }
const AUTH_FAILS = new Map();                                // key(ip:name) -> { count, until } 登录失败限流
const REGISTER_HITS = new Map();                             // ip -> [时间戳] 注册频率限制
const COLLAB_CREATED = new Map();                            // collabToken -> [accessKey...]（协同管理员创建的分发 Key 记录）
const COOKIE_NAME = 'akp_session';
const AUTH_FAIL_LIMIT = 5;                                   // 同一 IP+账号 连续失败次数上限
const AUTH_LOCK_MS = 5 * 60000;                              // 超限锁定 5 分钟

/** 登录/注册失败限流：验证码是 SVG 文本、可被脚本解析，真正的防爆破靠这里 */
function authRateKey(req, name){
  const ip = (req.socket && req.socket.remoteAddress) || 'unknown';
  return ip + ':' + String(name || '').slice(0, 32);
}
function authRateBlocked(key){
  const rec = AUTH_FAILS.get(key);
  if (rec && rec.until > Date.now()) return Math.ceil((rec.until - Date.now()) / 1000);
  return 0;
}
function authRateFail(key){
  const rec = AUTH_FAILS.get(key) || { count: 0, until: 0 };
  rec.count += 1;
  if (rec.count >= AUTH_FAIL_LIMIT) { rec.until = Date.now() + AUTH_LOCK_MS; rec.count = 0; }
  AUTH_FAILS.set(key, rec);
}
function authRateReset(key){ AUTH_FAILS.delete(key); }

function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 32).toString('hex');
  return { salt, hash };
}
function verifyPassword(password, salt, expectHash) {
  try {
    const h = crypto.scryptSync(String(password), salt, 32).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(expectHash, 'hex'));
  } catch (_) { return false; }
}
function loadUsers() {
  try {
    const arr = JSON.parse(fs.readFileSync(USERS_PATH, 'utf8'));
    for (const u of arr) { USERS.byName.set(u.name, u); USERS.byId.set(u.id, u); }
    if (arr.length) log('info', `用户账号已载入：${arr.length} 个`, 'green');
  } catch (_) { /* 首次启动无用户文件 */ }
  ensureDefaultAdmin();
}
/** 预设管理员：无 admin 账号时自动创建(默认密码在下方,登录后会提示修改) */
const DEFAULT_ADMIN_PASSWORD = 'Admin@2026';
function ensureDefaultAdmin() {
  if (USERS.byName.has('admin')) return;
  const { salt, hash } = hashPassword(DEFAULT_ADMIN_PASSWORD);
  const user = { id: crypto.randomBytes(8).toString('hex'), name: 'admin', salt, hash, role: 'admin', mustChangePassword: true, createdAt: Date.now() };
  USERS.byName.set('admin', user); USERS.byId.set(user.id, user); saveUsers();
  log('warn', `已创建预设管理员 admin(默认密码见部署记录,请登录后立即修改)`, 'yellow');
}
/** 用户改密码 */
function changePassword(user, newPassword) {
  if (!newPassword || String(newPassword).length < 6) return false;
  const { salt, hash } = hashPassword(newPassword);
  user.salt = salt; user.hash = hash; user.mustChangePassword = false;
  saveUsers();
  return true;
}
function saveUsers() {
  fs.writeFileSync(USERS_PATH, JSON.stringify([...USERS.byId.values()], null, 2), 'utf8');
}
loadUsers();

/** 每 5 分钟清理过期会话与验证码 */
setInterval(() => {
  const now = Date.now();
  for (const [sid, s] of SESSIONS) if (now - s.createdAt > 7 * 86400000) SESSIONS.delete(sid);
  for (const [cid, c] of CAPTCHAS) if (c.expiresAt < now) CAPTCHAS.delete(cid);
  for (const [k, rec] of AUTH_FAILS) if (rec.until && rec.until < now && !rec.count) AUTH_FAILS.delete(k);
  for (const [ip, hits] of REGISTER_HITS) {
    const keep = hits.filter(t => now - t < 3600000);
    if (keep.length) REGISTER_HITS.set(ip, keep); else REGISTER_HITS.delete(ip);
  }
}, 5 * 60000);

function parseCookies(req) {
  const out = {};
  const raw = String(req.headers.cookie || '');
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function currentUser(req) {
  const sid = parseCookies(req)[COOKIE_NAME];
  if (!sid) return null;
  const s = SESSIONS.get(sid);
  if (!s) return null;
  const u = USERS.byId.get(s.userId);
  if (!u) return null;
  return { sid, user: u };
}

/** SVG 图形验证码（零依赖：噪声线 + 随机旋转缩放的 text 元素，参照 svg-captcha 的思路） */
function makeCaptcha() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉易混淆的 I/1/O/0
  let text = '';
  for (let i = 0; i < 4; i++) text += chars[Math.floor(Math.random() * chars.length)];
  const W = 132, H = 44;
  let paths = '';
  for (let i = 0; i < 4; i++) {
    const x = 14 + i * 28 + Math.floor(Math.random() * 8);
    const y = 30 + Math.floor(Math.random() * 6);
    const rot = Math.floor(Math.random() * 40) - 20;
    const size = 24 + Math.floor(Math.random() * 8);
    const g = 90 + Math.floor(Math.random() * 120);
    paths += `<text x="${x}" y="${y}" font-size="${size}" fill="rgb(${g},${g},${g})" transform="rotate(${rot} ${x} ${y})" font-family="Arial,Georgia,serif" font-weight="bold">${text[i]}</text>`;
  }
  for (let i = 0; i < 4; i++) {
    const g = 120 + Math.floor(Math.random() * 100);
    paths += `<path d="M${Math.random() * 20} ${Math.random() * H} C${W / 3} ${Math.random() * H},${W * 2 / 3} ${Math.random() * H},${W - Math.random() * 20} ${Math.random() * H}" stroke="rgb(${g},${g},${g})" fill="none"/>`;
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0,0,${W},${H}"><rect width="100%" height="100%" fill="#f2f3f7"/>${paths}</svg>`;
  return { text, svg };
}

function handleStaticFile(res, file, type) {
  const fp = path.join(ROOT, file);
  let buf;
  try { buf = fs.readFileSync(fp); } catch (e) { return sendJson(res, 404, { error: { message: `${file} 缺失`, type: 'not_found' } }); }
  res.writeHead(200, { 'content-type': type + '; charset=utf-8', 'content-length': buf.length, 'cache-control': 'no-cache' });
  res.end(buf);
}

function handleAuthApi(req, res, p) {
  return (async () => {
    let body = {};
    if (req.method === 'POST') {
      try { body = JSON.parse((await readBody(req, 512 * 1024)).toString('utf8') || '{}'); } catch (_) { body = {}; }
    }

    if (p === '/api/auth/captcha' && req.method === 'GET') {
      const cid = crypto.randomBytes(12).toString('hex');
      const { text, svg } = makeCaptcha();
      CAPTCHAS.set(cid, { text: text.toLowerCase(), expiresAt: Date.now() + 5 * 60000 });
      res.writeHead(200, { 'content-type': 'image/svg+xml; charset=utf-8', 'x-captcha-id': cid, 'cache-control': 'no-store' });
      return res.end(svg);
    }

    if (p === '/api/auth/register' && req.method === 'POST') {
      const { name, password, captchaId, captchaText } = body;
      // 注册频率限制：同一 IP 每小时最多 5 次成功注册（防批量刷账号）
      const ip = (req.socket && req.socket.remoteAddress) || 'unknown';
      const now = Date.now();
      const hits = (REGISTER_HITS.get(ip) || []).filter(t => now - t < 3600000);
      if (hits.length >= 5) { REGISTER_HITS.set(ip, hits); return sendJson(res, 429, { error: { message: '注册过于频繁，请稍后再试', type: 'rate_limit_error' } }); }
      if (!name || String(name).length < 2 || String(name).length > 24) return sendJson(res, 400, { error: { message: '用户名需 2~24 个字符', type: 'invalid_request_error' } });
      if (!/^[a-zA-Z0-9_一-龥]+$/.test(name)) return sendJson(res, 400, { error: { message: '用户名只能包含中英文、数字、下划线', type: 'invalid_request_error' } });
      if (!password || String(password).length < 6) return sendJson(res, 400, { error: { message: '密码至少 6 位', type: 'invalid_request_error' } });
      const cap = CAPTCHAS.get(String(captchaId || ''));
      if (!cap || cap.expiresAt < Date.now()) return sendJson(res, 400, { error: { message: '验证码已过期，请刷新', type: 'captcha_error' } });
      if (String(captchaText || '').toLowerCase() !== cap.text) { CAPTCHAS.delete(String(captchaId || '')); return sendJson(res, 400, { error: { message: '验证码错误', type: 'captcha_error' } }); }
      CAPTCHAS.delete(String(captchaId || ''));
      if (USERS.byName.has(name)) return sendJson(res, 409, { error: { message: '用户名已存在', type: 'conflict' } });
      const { salt, hash } = hashPassword(password);
      const user = { id: crypto.randomBytes(8).toString('hex'), name, salt, hash, role: 'user', createdAt: Date.now() };
      USERS.byName.set(name, user); USERS.byId.set(user.id, user); saveUsers();
      hits.push(now); REGISTER_HITS.set(ip, hits);
      const sid = crypto.randomBytes(16).toString('hex');
      SESSIONS.set(sid, { userId: user.id, name: user.name, role: user.role, createdAt: Date.now() });
      log('info', `新用户注册：${name}`, 'green');
      res.setHeader('set-cookie', `${COOKIE_NAME}=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`);
      return sendJson(res, 200, { ok: true, name: user.name, role: user.role });
    }

    if (p === '/api/auth/login' && req.method === 'POST') {
      const { name, password, captchaId, captchaText } = body;
      const rlKey = authRateKey(req, name);
      const blockedSec = authRateBlocked(rlKey);
      if (blockedSec > 0) {
        res.setHeader('retry-after', String(blockedSec));
        return sendJson(res, 429, { error: { message: `尝试过于频繁，请 ${Math.ceil(blockedSec/60)} 分钟后再试`, type: 'rate_limit_error' } });
      }
      const cap = CAPTCHAS.get(String(captchaId || ''));
      if (!cap || cap.expiresAt < Date.now()) return sendJson(res, 400, { error: { message: '验证码已过期，请刷新', type: 'captcha_error' } });
      if (String(captchaText || '').toLowerCase() !== cap.text) { CAPTCHAS.delete(String(captchaId || '')); authRateFail(rlKey); return sendJson(res, 400, { error: { message: '验证码错误', type: 'captcha_error' } }); }
      CAPTCHAS.delete(String(captchaId || ''));

      // 管理员/协同管理员登录：password 即 adminToken / collab token。
      // 首次用 token 登录会自动建立同名角色账号（密码=该token），之后也可在门户改密码。
      const collabCfg = CONFIG.collabTokens || {};
      const isAdminToken = CONFIG.adminToken && password === CONFIG.adminToken;
      const collabName = collabCfg[password];
      if (isAdminToken || collabName) {
        const role = isAdminToken ? 'admin' : 'collab';
        const uname = isAdminToken ? 'admin' : 'collab:' + collabName;
        let user = USERS.byName.get(uname);
        if (!user) {
          const { salt, hash } = hashPassword(password);
          user = { id: crypto.randomBytes(8).toString('hex'), name: uname, salt, hash, role, createdAt: Date.now() };
          USERS.byName.set(uname, user); USERS.byId.set(user.id, user); saveUsers();
          log('info', `角色账号自动建立：${uname}（${role}）`, 'magenta');
        }
        if (!verifyPassword(password, user.salt, user.hash)) {
          // token 变过：同步更新该角色账号的密码哈希
          const { salt, hash } = hashPassword(password);
          user.salt = salt; user.hash = hash; saveUsers();
        }
        authRateReset(rlKey);
        const sid = crypto.randomBytes(16).toString('hex');
        SESSIONS.set(sid, { userId: user.id, name: user.name, role: user.role, createdAt: Date.now() });
        res.setHeader('set-cookie', `${COOKIE_NAME}=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`);
        return sendJson(res, 200, { ok: true, name: user.name, role: user.role });
      }

      const user = USERS.byName.get(String(name || ''));
      if (!user || !verifyPassword(password, user.salt, user.hash)) {
        authRateFail(rlKey);
        return sendJson(res, 401, { error: { message: '用户名或密码错误', type: 'auth_error' } });
      }
      authRateReset(rlKey);
      const sid = crypto.randomBytes(16).toString('hex');
      SESSIONS.set(sid, { userId: user.id, name: user.name, role: user.role, createdAt: Date.now() });
      res.setHeader('set-cookie', `${COOKIE_NAME}=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`);
      return sendJson(res, 200, { ok: true, name: user.name, role: user.role });
    }

    if (p === '/api/auth/logout' && req.method === 'POST') {
      const sid = parseCookies(req)[COOKIE_NAME];
      if (sid) SESSIONS.delete(sid);
      res.setHeader('set-cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
      return sendJson(res, 200, { ok: true });
    }

    if (p === '/api/auth/me' && req.method === 'GET') {
      const cur = currentUser(req);
      if (!cur) return sendJson(res, 401, { error: { message: '未登录', type: 'auth_error' } });
      return sendJson(res, 200, { name: cur.user.name, role: cur.user.role, createdAt: cur.user.createdAt, mustChangePassword: !!cur.user.mustChangePassword });
    }

    // 修改自己的密码(登录后)
    if (p === '/api/auth/password' && req.method === 'POST') {
      const cur = currentUser(req);
      if (!cur) return sendJson(res, 401, { error: { message: '未登录', type: 'auth_error' } });
      const { oldPassword, newPassword } = body;
      if (!verifyPassword(oldPassword, cur.user.salt, cur.user.hash)) return sendJson(res, 400, { error: { message: '旧密码错误', type: 'auth_error' } });
      if (!newPassword || String(newPassword).length < 6) return sendJson(res, 400, { error: { message: '新密码至少 6 位', type: 'invalid_request_error' } });
      changePassword(cur.user, newPassword);
      log('info', `用户 ${cur.user.name} 已修改密码`, 'green');
      return sendJson(res, 200, { ok: true });
    }

    // 登录用户：查看自己的分发 Key 与用量（按用户名与 accessKeys 里的 name 匹配）
    if (p === '/api/portal/mykeys' && req.method === 'GET') {
      const cur = currentUser(req);
      if (!cur) return sendJson(res, 401, { error: { message: '未登录', type: 'auth_error' } });
      const mine = [];
      for (const [token, spec] of Object.entries(CONFIG.accessKeys || {})) {
        const name = typeof spec === 'string' ? spec : (spec && spec.name) || '';
        const mask = token.slice(0, 11) + '…' + token.slice(-4);
        if (name === cur.user.name) {
          const full = typeof spec === 'object' ? spec : {};
          mine.push({ keyMasked: mask, key: token, name, rpm: full.rpm || 0, daily: full.daily || 0 });
        }
      }
      const u = [...(accessUsers.values())].find((x) => x.name === cur.user.name);
      const usage = u ? { today: u.dailyCount, total: u.totalCalls, lastCallAt: u.lastCallAt } : { today: 0, total: 0, lastCallAt: null };
      // 近 7 天逐日用量 + 模型分布（读调用日志，按 callerName 匹配）
      let daily = [], byModel = [], recent = [];
      try {
        const days = readUsageEntries(7);
        const mineEntries = days.filter((e) => (e.callerName || '') === cur.user.name);
        const dayMap = new Map();
        const modelMap = new Map();
        for (const e of mineEntries) {
          const day = new Date(e.ts + 8 * 3600000).toISOString().slice(0, 10);
          if (!dayMap.has(day)) dayMap.set(day, { date: day, calls: 0, ok: 0, fail: 0 });
          const dd = dayMap.get(day); dd.calls++;
          if (e.status != null && e.status < 400) dd.ok++; else if (e.status != null) dd.fail++;
          if (e.model) {
            if (!modelMap.has(e.model)) modelMap.set(e.model, { model: e.model, calls: 0, ok: 0, fail: 0 });
            const mm = modelMap.get(e.model); mm.calls++;
            if (e.status != null && e.status < 400) mm.ok++; else if (e.status != null) mm.fail++;
          }
        }
        daily = [...dayMap.values()].sort((a, b) => (a.date < b.date ? -1 : 1)).slice(-7);
        byModel = [...modelMap.values()].sort((a, b) => b.calls - a.calls);
        recent = mineEntries.slice(-20).reverse().map((e) => ({
          ts: e.ts, model: e.model, status: e.status, latencyMs: e.latencyMs, stream: e.stream, errorType: e.errorType || null,
        }));
      } catch (_) { /* 日志读失败不挡门户 */ }
      return sendJson(res, 200, { keys: mine, usage, daily, byModel, recent });
    }

    return sendJson(res, 404, { error: { message: `不支持的认证路由 ${p}`, type: 'not_found' } });
  })();
}

function handleAdminGetConfig(res) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    return sendJson(res, 500, { error: { message: '读取配置失败：' + e.message, type: 'internal_error' } });
  }
  // 脱敏：授权码不返回明文，用哨兵 __SET__ 表示「已设置」，前端据此显示且保存时保留旧值
  if (raw && raw.alert && raw.alert.email && raw.alert.email.authCode) {
    raw.alert.email.authCode = '__SET__';
  }
  sendJson(res, 200, {
    path: CONFIG_PATH,
    config: raw,
    runtime: { host: CONFIG.host, port: CONFIG.port, adminTokenSet: !!CONFIG.adminToken, uptimeSec: Math.floor(process.uptime()) },
  });
}

/** 校验并规范化提交上来的配置（就地修改 obj，返回 void） */
function sanitizeConfig(obj, warnings) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('配置必须是 JSON 对象');
  if (!Array.isArray(obj.providers)) throw new Error('providers 必须是数组');
  obj.providers = obj.providers.filter((p) => {
    if (!p || typeof p !== 'object') { warnings.push('已忽略一个无效的 provider 条目'); return false; }
    if (!p.name || !p.baseUrl) { warnings.push('已忽略缺 name/baseUrl 的 provider'); return false; }
    if (!Array.isArray(p.keys)) p.keys = [];
    p.keys = p.keys.map((k) => String(k).trim()).filter((k) => k && !k.startsWith('#'));
    return true;
  });
  if (obj.models == null) obj.models = {};
  if (typeof obj.models !== 'object' || Array.isArray(obj.models)) throw new Error('models 必须是对象');
  if (obj.accessKeys == null) obj.accessKeys = {};
  if (typeof obj.accessKeys !== 'object' || Array.isArray(obj.accessKeys)) throw new Error('accessKeys 必须是对象');
  if (obj.defaults == null) obj.defaults = {};
  return obj;
}

async function handleAdminSaveConfig(req, res) {
  const body = await readBody(req, 2 * 1024 * 1024);
  let obj;
  try {
    obj = JSON.parse(body.toString('utf8'));
  } catch (e) {
    return sendJson(res, 400, { error: { message: '请求体不是合法 JSON', type: 'invalid_request_error' } });
  }
  const warnings = [];
  try {
    sanitizeConfig(obj, warnings);
  } catch (e) {
    return sendJson(res, 400, { error: { message: '配置校验失败：' + e.message, type: 'invalid_request_error' } });
  }
  // 授权码脱敏保留：前端传回 __SET__（未改）或空值时，保留磁盘旧授权码；否则用新值
  let oldCode = '';
  try {
    const oldRaw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    oldCode = (oldRaw && oldRaw.alert && oldRaw.alert.email && oldRaw.alert.email.authCode) || '';
  } catch (_) {}
  const newCode = obj.alert && obj.alert.email ? obj.alert.email.authCode : undefined;
  if (newCode === '__SET__' || newCode === '' || newCode == null) {
    if (oldCode) {
      if (!obj.alert) obj.alert = {};
      if (!obj.alert.email) obj.alert.email = {};
      obj.alert.email.authCode = oldCode;
    }
  } else if (typeof newCode === 'string') {
    obj.alert.email.authCode = newCode.trim();
  }
  const json = JSON.stringify(obj, null, 2);
  const tmp = CONFIG_PATH + '.tmp';
  try {
    fs.writeFileSync(tmp, json, 'utf8');
    try {
      fs.renameSync(tmp, CONFIG_PATH);
    } catch (e) {
      // Windows 上 rename 可能不覆盖已存在文件，退回直接写
      fs.writeFileSync(CONFIG_PATH, json, 'utf8');
      try { fs.unlinkSync(tmp); } catch (_) {}
    }
  } catch (e) {
    return sendJson(res, 500, { error: { message: '写入配置失败：' + e.message, type: 'internal_error' } });
  }
  try {
    reloadConfig();
  } catch (e) {
    return sendJson(res, 500, { error: { message: '配置已保存但重载失败：' + e.message, type: 'internal_error' } });
  }
  log('info', `操作台已保存配置：${POOL.providers.size} 平台 / ${POOL.totalKeys()} Key / ${accessUsers.size} 用户`, 'magenta');
  sendJson(res, 200, {
    ok: true,
    warnings,
    applied: { providers: POOL.providers.size, keys: POOL.totalKeys(), users: accessUsers.size },
    adminTokenSet: !!CONFIG.adminToken,
  });
}

// ---------------------------------------------------------------- 调用日志 / 用量接口（只读）

/** 读近 days 天（含今天）的 usage JSONL，合并返回按 ts 升序的条目数组。
 *  文件名与写入端同用 dateStr()（本地时区），保证读写一致。若未来部署到非 UTC+8 服务器，
 *  需连同写入端一起改为显式 +8 偏移（quotaDayKey 已是 +8）。 */
function readUsageEntries(days) {
  const list = [];
  const now = Date.now();
  for (let i = 0; i < days; i++) {
    const ds = dateStr(new Date(now - i * 86400000));
    const fp = path.join(USAGE_DIR, `${ds}.jsonl`);
    let txt;
    try { txt = fs.readFileSync(fp, 'utf8'); } catch (_) { continue; }
    for (const line of txt.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      try { list.push(JSON.parse(s)); } catch (_) { /* 跳过坏行 */ }
    }
  }
  return list;
}

/** 倒序读取调用日志：从最新日期文件往回扫，边读边过滤，内存只保留 limit 条。
 *  total 仍全量统计（扫到所有匹配行但不保留对象），entries 按 ts 降序。 */
function readUsageLogs(days, filter, limit) {
  const now = Date.now();
  const matched = [];
  let total = 0;
  for (let i = 0; i < days; i++) {
    const ds = dateStr(new Date(now - i * 86400000));
    const fp = path.join(USAGE_DIR, `${ds}.jsonl`);
    let txt;
    try { txt = fs.readFileSync(fp, 'utf8'); } catch (_) { continue; }
    const lines = txt.split('\n');
    // 文件内按追加序（时间升序），倒序遍历先拿最新
    for (let j = lines.length - 1; j >= 0; j--) {
      const s = lines[j].trim();
      if (!s) continue;
      let e;
      try { e = JSON.parse(s); } catch (_) { continue; }
      if (!filter(e)) continue;
      total++;
      if (matched.length < limit) matched.push(e);
    }
  }
  matched.sort((a, b) => (b.ts || 0) - (a.ts || 0)); // limit 条内精确排序，成本可忽略
  return { entries: matched, total };
}

/** GET /admin/api/provider-models?provider=xxx[&refresh=1]
 *  用该平台的一个可用 Key 调上游 /models，返回模型 ID 列表（供前端下拉选择，防手填错模型名）。
 *  结果缓存 1 小时；上游不提供 /models 或超时时返回 ok:false，前端降级为手填。 */
const MODEL_LIST_CACHE = new Map();   // provider -> { models, fetchedAt, error }
async function handleProviderModels(res, url) {
  const name = String(url.searchParams.get('provider') || '');
  const force = url.searchParams.get('refresh') === '1';
  const p = POOL.providers.get(name);
  if (!p) return sendJson(res, 404, { ok: false, error: `平台「${name}」不存在`, models: [] });
  const cached = MODEL_LIST_CACHE.get(name);
  const ttl = cached && cached.error ? 5 * 60000 : 3600000;   // 失败缓存 5 分钟(便于重试),成功缓存 1 小时
  if (cached && !force && Date.now() - cached.fetchedAt < ttl) {
    return sendJson(res, 200, {
      ok: !cached.error, cached: true, models: cached.models,
      error: cached.error || undefined, fetchedAt: cached.fetchedAt,
    });
  }
  // 依次尝试最多 3 个 Key（首个可能无效/被限流，不能只试一个就放弃）
  const candidates = (p.keys || []).filter((k) => !k.dead);
  if (!candidates.length) candidates.push(...(p.keys || []));
  if (!candidates.length) return sendJson(res, 200, { ok: false, error: '该平台没有配置 Key', models: [] });
  const probePath = (p.probePath || (CONFIG.halfOpen && CONFIG.halfOpen.probePath) || 'models').replace(/^\/+/, '');
  const target = joinUrl(p.baseUrl, probePath);
  const timeoutMs = p.probeTimeoutMs || 15000;
  let lastErr = '未知错误';
  for (const key of candidates.slice(0, 3)) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    const t0 = Date.now();
    try {
      const resp = await fetch(target, {
        method: 'GET',
        headers: { [p.authHeader || 'Authorization']: (p.authPrefix !== undefined ? p.authPrefix : 'Bearer ') + key.value, accept: 'application/json' },
        signal: ac.signal,
      });
      clearTimeout(timer);
      if (resp.status === 401 || resp.status === 403) { lastErr = `HTTP ${resp.status}（该 Key 无效）`; continue; }
      if (!resp.ok) { lastErr = `上游返回 HTTP ${resp.status}`; continue; }
      const data = await resp.json().catch(() => null);
      const arr = (data && Array.isArray(data.data)) ? data.data : (Array.isArray(data) ? data : []);
      const models = arr.map((m) => (typeof m === 'string' ? m : (m && (m.id || m.name)) || '')).filter(Boolean).sort();
      if (!models.length) { lastErr = '上游未返回模型列表（该平台可能不提供 /models）'; continue; }
      MODEL_LIST_CACHE.set(name, { models, fetchedAt: Date.now() });
      log('info', `已拉取 ${name} 的模型列表：${models.length} 个（${Date.now() - t0}ms）`, 'gray');
      return sendJson(res, 200, { ok: true, cached: false, models, ms: Date.now() - t0 });
    } catch (e) {
      clearTimeout(timer);
      lastErr = e && e.name === 'AbortError' ? `拉取超时（${timeoutMs}ms）` : (e.message || '请求失败');
    }
  }
  MODEL_LIST_CACHE.set(name, { models: [], fetchedAt: Date.now(), error: lastErr });
  log('warn', `拉取 ${name} 模型列表失败：${lastErr}`, 'yellow');
  return sendJson(res, 200, { ok: false, error: lastErr, models: [] });
}

/** GET /admin/api/logs：筛选 + 倒序分页返回调用日志（已脱敏），不全量读内存 */
function handleAdminLogs(res, url) {
  const q = url.searchParams;
  let days = parseInt(q.get('days'), 10); if (!(days >= 1)) days = 2;
  days = Math.min(days, 7); // 最多读 7 天文件，面板够用
  let limit = parseInt(q.get('limit'), 10); if (!(limit >= 1)) limit = 100;
  limit = Math.min(limit, 500);
  const caller = (q.get('caller') || '').trim();
  const model = (q.get('model') || '').trim();
  const status = (q.get('status') || '').trim();
  const errorType = (q.get('errorType') || '').trim();

  const filter = (e) =>
    (!caller || String(e.caller) === caller || e.callerName === caller) &&
    (!model || e.model === model) &&
    (!status || String(e.status) === status) &&
    (!errorType || e.errorType === errorType);

  const { entries, total } = readUsageLogs(days, filter, limit);
  sendJson(res, 200, { entries, total, days, truncated: total > limit });
}

/** GET /admin/api/usage：按天/当天小时/主体/模型聚合用量（次数 + token） */
function handleAdminUsage(res, url) {
  const q = url.searchParams;
  let days = parseInt(q.get('days'), 10); if (!(days >= 1)) days = 7;
  const maxDays = CONFIG.usageRetentionDays != null ? CONFIG.usageRetentionDays : 90;
  days = Math.min(days, maxDays); // P1：趋势天数夹到 usageRetentionDays，避免读到已清理的窗口
  const caller = (q.get('caller') || '').trim();

  let entries = readUsageEntries(days);
  if (caller) entries = entries.filter((e) => String(e.caller) === caller || e.callerName === caller);

  const mk = (d, h) => ({ date: d, hour: h, calls: 0, ok: 0, fail: 0, prompt: 0, completion: 0, total: 0 });
  const tally = (b, e) => {
    b.calls++;
    const st = e.status;
    if (st != null && st < 400) b.ok++; else if (st != null) b.fail++;
    if (e.tokens) { b.prompt += e.tokens.prompt || 0; b.completion += e.tokens.completion || 0; b.total += e.tokens.total || 0; }
  };

  const dailyMap = new Map();
  const today = dateStr();
  const hourMap = new Map();
  for (const e of entries) {
    const d = dateStr(new Date(e.ts));
    if (!dailyMap.has(d)) dailyMap.set(d, mk(d, null));
    tally(dailyMap.get(d), e);
    if (d === today) {
      const h = new Date(e.ts).getHours();
      if (!hourMap.has(h)) hourMap.set(h, mk(d, h));
      tally(hourMap.get(h), e);
    }
  }
  const daily = [...dailyMap.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
  const hours = [...hourMap.values()].sort((a, b) => a.hour - b.hour);

  const callerMap = new Map();
  const modelMap = new Map();
  for (const e of entries) {
    const cn = e.callerName || (e.caller != null ? `#${e.caller}` : '未知');
    if (!callerMap.has(cn)) callerMap.set(cn, { name: cn, calls: 0, ok: 0, fail: 0, total: 0 });
    const c = callerMap.get(cn);
    c.calls++;
    const st = e.status; if (st != null && st < 400) c.ok++; else if (st != null) c.fail++;
    if (e.tokens) c.total += e.tokens.total || 0;

    if (e.model) {
      if (!modelMap.has(e.model)) modelMap.set(e.model, { model: e.model, calls: 0, ok: 0, fail: 0, total: 0 });
      const m = modelMap.get(e.model);
      m.calls++;
      if (st != null && st < 400) m.ok++; else if (st != null) m.fail++;
      if (e.tokens) m.total += e.tokens.total || 0;
    }
  }
  const byCaller = [...callerMap.values()].sort((a, b) => b.calls - a.calls);
  const byModel = [...modelMap.values()].sort((a, b) => b.calls - a.calls);

  sendJson(res, 200, {
    days, today, totalCalls: entries.length,
    daily, hours, byCaller, byModel,
    callers: [...callerMap.keys()],
    models: [...modelMap.keys()],
  });
}

// ---------------------------------------------------------------- 服务器

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname.replace(/\/+$/, '') || '/';

  try {
    // CORS 预检：仅代理接口（/v1/*）放行跨域——中转站客户端 SDK 需要；
    // 管理/统计/仪表盘接口不返回 CORS 头，浏览器跨站 JS 读不到响应（防配置与 Key 被恶意网页窃取）
    if (req.method === 'OPTIONS') {
      const isProxy = p === '/v1/chat/completions' || p === '/chat/completions' || p === '/v1/models' || p === '/models';
      if (isProxy) {
        res.writeHead(204, {
          'access-control-allow-origin': '*',
          'access-control-allow-headers': '*',
          'access-control-allow-methods': 'GET,POST,OPTIONS',
        });
      } else {
        const origin = String(req.headers.origin || '');
        if (origin && !isTrustedOrigin(origin, req.headers.host)) {
          return sendJson(res, 403, { error: { message: '跨站来源被拒绝', type: 'forbidden' } });
        }
        res.writeHead(204);
      }
      return res.end();
    }

    // 代理接口鉴权（中转站模式）
    const isProxyPath = p === '/v1/chat/completions' || p === '/chat/completions' || p === '/v1/models' || p === '/models';
    if (isProxyPath) {
      const auth = String(req.headers.authorization || '');
      const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
      if (accessUsers.size > 0) {
        // 多用户分发 Key 模式
        const user = accessUsers.get(token);
        if (!user) {
          logUsage({ ts: Date.now(), caller: null, callerName: null, model: null, provider: null, keyId: null, status: 401, latencyMs: 0, tokens: null, stream: false, errorType: 'auth_fail' });
          return sendJson(res, 401, { error: { message: '无效的访问 Key', type: 'auth_error' } });
        }
        req.poolUser = 'user-' + user.idx; // HTTP 头只允许 Latin-1，中文名不进 header
        req.poolUserObj = user;            // 调用日志取 callerName 用
        // 仅对话请求记配额；/v1/models 等只做鉴权，不消耗用户的 RPM/每日次数
        if (p === '/v1/chat/completions' || p === '/chat/completions') {
          const q = userQuotaCheck(user, Date.now());
          if (!q.ok) {
            logUsage(makeUsageEntry(req, { status: 429, latencyMs: 0, errorType: 'quota_exceeded' }));
            res.setHeader('retry-after', String(q.retryAfterSec));
            return sendJson(res, 429, { error: { message: `请求过于频繁：${q.reason}`, type: 'rate_limit_error' } });
          }
        }
      } else if (CONFIG.proxyApiKey) {
        // 旧版单 Key 模式
        if (token !== CONFIG.proxyApiKey) {
          logUsage({ ts: Date.now(), caller: null, callerName: null, model: null, provider: null, keyId: null, status: 401, latencyMs: 0, tokens: null, stream: false, errorType: 'auth_fail' });
          return sendJson(res, 401, { error: { message: '代理鉴权失败', type: 'auth_error' } });
        }
      }
    }

    // 管理/统计/仪表盘路径：拒绝带「非可信来源」Origin 的浏览器请求（防 DNS rebinding 窃取配置与统计）
    const originHdr = String(req.headers.origin || '');
    if (!isProxyPath && originHdr && !isTrustedOrigin(originHdr, req.headers.host)) {
      return sendJson(res, 403, { error: { message: '跨站来源被拒绝', type: 'forbidden' } });
    }

    // SPA 网站地基(new-api 式:单页应用,hash 路由,页面+API 同端口)
    if (['/', '/app', '/console', '/login', '/register'].includes(p) && req.method === 'GET') return handleStaticFile(res, 'app.html', 'text/html');
    if (p === '/app.js' && req.method === 'GET') return handleStaticFile(res, 'app.js', 'application/javascript');
    // 旧页面路径 → SPA 对应 hash 路由(301 兼容旧链接)
    const redirects = { '/admin': '/app#/console/dashboard', '/admin/': '/app#/console/dashboard', '/portal': '/app#/console/profile', '/home': '/app#/', '/dashboard': '/app#/console/dashboard' };
    if (redirects[p] && req.method === 'GET') { res.writeHead(301, { location: redirects[p] }); return res.end(); }
    if (p === '/dashboard' && req.method === 'GET') {
      if (CONFIG.adminToken && !adminAllowed(req)) return sendJson(res, 401, { needAuth: true, error: { message: '管理鉴权失败', type: 'auth_error' } });
      return handleDashboard(res);
    }
    // 用户认证 API（/api/auth/* 与 /api/portal/*）
    if (p.startsWith('/api/auth/') || p === '/api/portal/mykeys') {
      return await handleAuthApi(req, res, p);
    }
    if (p === '/health') return sendJson(res, 200, { status: 'ok', keys: POOL.totalKeys(), uptimeSec: Math.floor(process.uptime()) });
    if (p === '/stats' && req.method === 'GET') {
      if (CONFIG.adminToken && !adminAllowed(req)) return sendJson(res, 401, { needAuth: true, error: { message: '管理鉴权失败', type: 'auth_error' } });
      return handleStats(res);
    }
    if (p === '/v1/models' && req.method === 'GET') return await handleModels(req, res);

    // 管理操作台
    if (p === '/admin' || p === '/admin/') return handleAdminPage(res);
    if (p === '/admin/api/config') {
      if (!adminAllowed(req)) return sendJson(res, 401, { needAuth: true, error: { message: CONFIG.adminToken ? '管理密码错误' : '操作台仅限本机访问（或先设置 adminToken 开启远程管理）', type: 'auth_error' } });
      if (req.method === 'GET') return handleAdminGetConfig(res);
      if (req.method === 'PUT') return await handleAdminSaveConfig(req, res);
    }
    if (p === '/admin/api/provider-models' && req.method === 'GET') {
      if (!adminAllowed(req)) return sendJson(res, 401, { needAuth: true, error: { message: '管理鉴权失败', type: 'auth_error' } });
      return await handleProviderModels(res, url);
    }
    if (p === '/admin/api/logs' && req.method === 'GET') {
      if (!adminAllowed(req)) return sendJson(res, 401, { needAuth: true, error: { message: CONFIG.adminToken ? '管理密码错误' : '操作台仅限本机访问（或先设置 adminToken 开启远程管理）', type: 'auth_error' } });
      return handleAdminLogs(res, url);
    }
    if (p === '/admin/api/usage' && req.method === 'GET') {
      if (!adminAllowed(req)) return sendJson(res, 401, { needAuth: true, error: { message: CONFIG.adminToken ? '管理密码错误' : '操作台仅限本机访问（或先设置 adminToken 开启远程管理）', type: 'auth_error' } });
      return handleAdminUsage(res, url);
    }

    // 协同管理员接口：collabTokens 登记的 token 专用（管理员 token 也可调用）
    if (p.startsWith('/admin/api/collab/')) {
      let collab = resolveCollab(req);
      if (!collab && adminAllowed(req)) collab = { token: '(admin)', name: '管理员' };
      if (!collab) return sendJson(res, 401, { needAuth: true, error: { message: '需要协同管理员 token 或 adminToken', type: 'auth_error' } });
      if (p === '/admin/api/collab/whoami' && req.method === 'GET') {
        const providers = (POOL.providers instanceof Map)
          ? [...POOL.providers.values()].map((pr) => ({ name: pr.name, keyCount: pr.keys.length }))
          : [];
        return sendJson(res, 200, { ok: true, name: collab.name, role: collab.token === '(admin)' ? 'admin' : 'collab', providers });
      }
      // 协同管理员：列出自己创建的分发 Key（按创建记录；管理员/网页会话则列出全部）
      if (p === '/admin/api/collab/listAccessKeys' && req.method === 'GET') {
        let list = [];
        if (collab.token === '(admin)') {
          list = Object.entries(CONFIG.accessKeys || {}).map(([token, spec]) => {
            const o = typeof spec === 'object' ? spec : { name: String(spec) };
            return { key: token, name: o.name || '', rpm: o.rpm || 0, daily: o.daily || 0 };
          });
        } else if (collab.token === '(session)') {
          // 网页登录的协同管理员:看与自己 collab:名字 同源的 Key(名字匹配)
          const myName = collab.name;
          list = Object.entries(CONFIG.accessKeys || {})
            .filter(([token, spec]) => {
              const o = typeof spec === 'object' ? spec : { name: String(spec) };
              return (COLLAB_CREATED.get(myName) || []).includes(token) || o.name === myName;
            })
            .map(([token, spec]) => {
              const o = typeof spec === 'object' ? spec : { name: String(spec) };
              return { key: token, name: o.name || '', rpm: o.rpm || 0, daily: o.daily || 0 };
            });
        } else {
          const rec = COLLAB_CREATED.get(collab.token) || [];
          list = rec.map((k) => {
            const spec = (CONFIG.accessKeys || {})[k];
            const o = typeof spec === 'object' ? spec : { name: '' };
            return { key: k, name: o.name || '', rpm: o.rpm || 0, daily: o.daily || 0, stillExists: !!spec };
          });
        }
        const withUsage = list.map((k) => {
          const u = [...(accessUsers.values())].find((x) => x.name === k.name);
          return Object.assign(k, { today: u ? u.dailyCount : 0, total: u ? u.totalCalls : 0 });
        });
        return sendJson(res, 200, { ok: true, keys: withUsage });
      }
      return await handleCollabApi(req, res, url, collab);
    }

    if ((p === '/v1/chat/completions' || p === '/chat/completions') && req.method === 'POST') {
      const raw = await readBody(req);
      let bodyObj;
      try {
        bodyObj = JSON.parse(raw.toString('utf8'));
      } catch (e) {
        return sendJson(res, 400, { error: { message: '请求体不是合法 JSON', type: 'invalid_request_error' } });
      }
      return await handleChat(req, res, bodyObj);
    }

    return sendJson(res, 404, { error: { message: `不支持的路由 ${p}`, type: 'not_found' } });
  } catch (err) {
    log('error', `服务内部错误: ${err && err.stack ? err.stack : err}`, 'red');
    if (!res.headersSent) sendJson(res, 500, { error: { message: String(err && err.message || err), type: 'internal_error' } });
    else res.end();
  }
});

// ---------------------------------------------------------------- 启动

function banner() {
  const keys = POOL.totalKeys();
  console.log('');
  console.log(`${COLORS.cyan}  API Key 代理池${COLORS.reset}  零依赖 · OpenAI 兼容`);
  console.log('');
  console.log(`  监听地址   http://${CONFIG.host}:${CONFIG.port}`);
  console.log(`  接入地址   ${COLORS.green}http://${CONFIG.host}:${CONFIG.port}/v1${COLORS.reset}   (OpenAI SDK 填 base_url)`);
  console.log(`  状态面板   http://${CONFIG.host}:${CONFIG.port}/`);
  console.log(`  管理操作台  http://${CONFIG.host}:${CONFIG.port}/admin`);
  console.log(`  Key 总数   ${keys > 0 ? COLORS.green + keys : COLORS.red + '0（未配置！）'}${COLORS.reset}`);
  console.log('');
  if (keys === 0) {
    console.log(`${COLORS.yellow}  还没有配置 Key —— 打开 config.json，把 nvapi-xxx / sk-xxx 填进 providers[].keys 数组，保存即自动生效。${COLORS.reset}`);
    console.log('');
  }
}

let watcherTimer = null;
function watchConfig() {
  try {
    fs.watch(CONFIG_PATH, () => {
      clearTimeout(watcherTimer);
      watcherTimer = setTimeout(() => {
        try {
          reloadConfig();
          log('info', 'config.json 已变更，配置热重载完成', 'magenta');
        } catch (e) {
          log('error', `config.json 解析失败：${e.message}（继续使用旧配置）`, 'red');
        }
      }, 300);
    });
    log('debug', '已开启 config.json 热重载监听', 'gray');
  } catch (e) {
    log('warn', `无法监听 config.json：${e.message}`, 'yellow');
  }
}

function main() {
  try {
    reloadConfig();
  } catch (e) {
    console.error(`读取 config.json 失败：${e.message}`);
    process.exit(1);
  }
  server.listen(CONFIG.port, CONFIG.host, () => {
    cleanupLogs(); // 启动即清理一次过期日志（服务日志 7 天 / 调用日志 90 天）
    banner();
    log('info', `服务已启动，策略=${CONFIG.strategy}，最大尝试=${CONFIG.maxAttempts}`, 'green');
    if (CONFIG.halfOpen && CONFIG.halfOpen.enabled !== false) {
      startProbeLoop();
      log('info', `半开探活已开启（节拍 ${(CONFIG.halfOpen.probeIntervalMs || 15000) / 1000}s，复活下线 Key=${CONFIG.halfOpen.reviveDead !== false}）`, 'green');
    }
    if (CONFIG.breaker && CONFIG.breaker.enabled !== false) {
      log('info', `模型熔断已开启（连续 ${CONFIG.breaker.failThreshold} 次全败 → 熔断 ${Math.round((CONFIG.breaker.openMs || 30000) / 1000)}s）`, 'green');
    }
    const isLoopback = CONFIG.host === '127.0.0.1' || CONFIG.host === 'localhost' || CONFIG.host === '::1';
    if (!isLoopback && accessUsers.size === 0 && !CONFIG.proxyApiKey) {
      log('warn', '⚠⚠⚠ 监听在 ' + CONFIG.host + ' 但未配置任何访问鉴权！任何人都能调用你的代理池消耗额度，建议配置 accessKeys（config.json 顶部）', 'red');
    } else if (!isLoopback) {
      log('info', `中转站模式已就绪：局域网/公网可访问（分发 Key ${accessUsers.size} 个）`, 'green');
    } else if (accessUsers.size > 0) {
      log('info', '已配置分发 Key，但监听在本机，局域网/公网还访问不到 —— 把 host 改为 0.0.0.0 并重启', 'yellow');
    }
    watchConfig();
  });
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.error(`${COLORS.red}端口 ${CONFIG.port} 已被占用。${COLORS.reset}\n先运行 stop.bat 关掉旧进程，或改 config.json 里的 port。`);
    } else {
      console.error(`服务错误：${e.message}`);
    }
    process.exit(1);
  });
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 70000;

  // 兜底：任何漏网的异常只记录、不退出，保证代理池常驻
  process.on('uncaughtException', (e) => {
    log('error', `未捕获异常（服务继续运行）：${e && e.stack ? e.stack : e}`, 'red');
  });
  process.on('unhandledRejection', (e) => {
    log('error', `未处理的 Promise 拒绝（服务继续运行）：${e && e.stack ? e.stack : e}`, 'red');
  });

  process.on('SIGINT', () => { console.log('\n已停止。'); process.exit(0); });
}

if (require.main === module) main();

module.exports = { main, Pool, ApiKey };
