'use strict';
/**
 * 配置体检工具 —— 填完 Key 后跑一遍，提前发现配置问题
 *
 *   node check-config.js          只做静态检查（不联网、不消耗额度）
 *   node check-config.js --live   额外真实调用每个 Key 验证是否可用（消耗极少量额度）
 *
 * 退出码：0 = 无错误；1 = 有错误
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = __dirname;
const CONFIG_PATH = process.env.POOL_CONFIG
  ? path.resolve(process.env.POOL_CONFIG)
  : path.join(ROOT, 'config.json');

const C = {
  g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', c: '\x1b[36m', dim: '\x1b[90m', b: '\x1b[1m', x: '\x1b[0m',
};

const issues = [];
const ok = (m) => issues.push({ level: 'ok', m });
const warn = (m) => issues.push({ level: 'warn', m });
const bad = (m) => issues.push({ level: 'error', m });

const KEY_HINTS = [
  { match: /nvapi-/i, name: '英伟达 NIM', url: 'https://build.nvidia.com' },
  { match: /^sk-/i, name: '商汤 SenseNova', url: 'https://platform.sensenova.cn' },
];

function mask(k) {
  if (!k || k.length <= 10) return k;
  return k.slice(0, 6) + '...' + k.slice(-4);
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    bad(`找不到配置文件 ${CONFIG_PATH}`);
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    bad(`config.json 不是合法 JSON：${e.message}`);
    return null;
  }
}

function staticCheck(cfg) {
  // 基础项
  const host = cfg.host || '127.0.0.1';
  const port = Number(cfg.port) || 8787;
  const hasAuth = cfg.accessKeys && Object.keys(cfg.accessKeys).some((k) => !k.startsWith('#') && !k.startsWith('_'));
  if (host === '0.0.0.0' && !cfg.proxyApiKey && !hasAuth) {
    warn('监听地址是 0.0.0.0（局域网可访问）但没设 proxyApiKey 也没配 accessKeys，任何人都能用你的 Key —— 强烈建议配置 accessKeys 或 proxyApiKey');
  } else if (host === '127.0.0.1') {
    ok(`监听 ${host}:${port}，仅本机可访问`);
  } else if (host === '0.0.0.0') {
    ok(`监听 0.0.0.0（中转站模式），已配置鉴权`);
  }
  if (port < 1024 || port > 65535) bad(`端口 ${port} 不合法`);

  // accessKeys（中转站分发 Key）
  if (cfg.accessKeys && typeof cfg.accessKeys === 'object') {
    const real = Object.entries(cfg.accessKeys).filter(([k]) => !k.startsWith('#') && !k.startsWith('_'));
    if (real.length) {
      const tokens = new Set();
      for (const [token, spec] of real) {
        if (tokens.has(token)) bad(`accessKeys 里有重复的 Key：${token.slice(0, 8)}…`);
        tokens.add(token);
        if (typeof spec === 'object' && spec !== null) {
          if (spec.rpm != null && (Number(spec.rpm) <= 0 || !Number.isInteger(Number(spec.rpm)))) warn(`accessKeys 用户 ${spec.name || token.slice(0, 8)}… 的 rpm 应填正整数`);
          if (spec.daily != null && (Number(spec.daily) <= 0 || !Number.isInteger(Number(spec.daily)))) warn(`accessKeys 用户 ${spec.name || token.slice(0, 8)}… 的 daily 应填正整数`);
        }
      }
      ok(`中转鉴权：已配置 ${real.length} 个分发 Key（会校验 Authorization）`);
    } else {
      ok('未配置 accessKeys —— 不校验调用方身份（仅建议在本机模式使用）');
    }
  }

  const defaults = cfg.defaults || {};
  const providers = (cfg.providers || []).filter((p) => p && p.name);
  if (!providers.length) {
    bad('providers 是空的 —— 至少要配置一个平台');
    return { providers: [], defaultModel: new Map() };
  }

  // 每个平台
  const allValues = new Map();
  for (const p of providers) {
    const rpmKey = p.rpmPerKey != null ? p.rpmPerKey : defaults.rpmPerKey;
    const rpmAcc = p.rpmPerAccount != null ? p.rpmPerAccount : defaults.rpmPerAccount;
    const conc = p.maxConcurrencyPerKey != null ? p.maxConcurrencyPerKey : defaults.maxConcurrencyPerKey;

    if (!p.baseUrl) { bad(`平台 ${p.name} 缺少 baseUrl`); continue; }
    if (!/^https?:\/\//i.test(p.baseUrl)) warn(`平台 ${p.name} 的 baseUrl 不像合法地址：${p.baseUrl}`);

    // 收集 Key
    let rawKeys = Array.isArray(p.keys) ? p.keys.slice() : [];
    if (p.keysFile) {
      const fp = path.isAbsolute(p.keysFile) ? p.keysFile : path.join(ROOT, p.keysFile);
      try {
        for (const line of fs.readFileSync(fp, 'utf8').split(/\r?\n/)) {
          const t = line.trim();
          if (t && !t.startsWith('#')) rawKeys.push(t);
        }
      } catch (e) {
        bad(`平台 ${p.name} 的 keysFile 读不到：${fp}`);
      }
    }
    rawKeys = rawKeys.map((s) => String(s).trim()).filter((s) => s && !s.startsWith('#') && !s.startsWith('//'));

    const parsed = rawKeys.map((s) => {
      let group = null, body = s;
      const at = s.lastIndexOf('@');
      if (at > 0) { group = s.slice(at + 1).trim(); body = s.slice(0, at).trim(); }
      let value = body;
      if (body.startsWith('env:')) {
        value = (process.env[body.slice(4).trim()] || '').trim();
        if (!value) return { value: null, group, raw: s, missingEnv: body.slice(4).trim() };
      }
      return { value, group, raw: s };
    });

    const missingEnv = parsed.filter((k) => k.missingEnv);
    if (missingEnv.length) {
      bad(`平台 ${p.name} 有 ${missingEnv.length} 个 Key 用了环境变量但未取到值：${missingEnv.map((k) => k.missingEnv).join(', ')}`);
    }
    const keys = parsed.filter((k) => k.value);

    if (!keys.length) {
      warn(`平台 ${p.name} 没有配置 Key —— 不影响其他平台，模型降级链会自动跳过它`);
      continue;
    }
    ok(`平台 ${p.name}：${keys.length} 个 Key，${p.baseUrl}`);

    // 重复检查
    const seen = new Map();
    for (const k of keys) {
      if (seen.has(k.value)) warn(`平台 ${p.name} 有重复 Key：${mask(k.value)}（第 ${seen.get(k.value)} 和当前位置）`);
      else seen.set(k.value, keys.indexOf(k) + 1);

      const g = allValues.get(k.value);
      if (g && g !== p.name) warn(`Key ${mask(k.value)} 同时出现在 ${g} 和 ${p.name}，可能填错了`);
      allValues.set(k.value, p.name);
    }

    // Key 格式提示
    const hint = KEY_HINTS.find((h) => keys.every((k) => h.match.test(k.value)));
    if (hint) ok(`平台 ${p.name} 的 Key 格式符合「${hint.name}」`);
    else if (keys.some((k) => /nvapi-/i.test(k.value))) warn(`平台 ${p.name} 的 Key 格式不统一，请确认没粘串行`);
    else if (!/^https?:\/\/127\.0\.0\.1/i.test(p.baseUrl)) {
      warn(`平台 ${p.name} 的 Key 前缀不是 nvapi- 或 sk-，如果这是自搭/其他平台请忽略`);
    }

    // 同账号分组检查
    const grouped = keys.filter((k) => k.group);
    const ungrouped = keys.filter((k) => !k.group);
    if (keys.length > 1 && grouped.length === 0 && rpmAcc > 0) {
      warn(`平台 ${p.name} 设了 rpmPerAccount=${rpmAcc}，但没有任何 Key 带 @账号标签，账号级限流不会生效`);
    }
    if (grouped.length > 0 && ungrouped.length > 0) {
      warn(`平台 ${p.name} 有 ${grouped.length} 个 Key 分组、${ungrouped.length} 个没分组，未分组的会独立计数，确认这是你想要的`);
    }
    if (grouped.length > 0) {
      const groups = new Map();
      for (const k of grouped) groups.set(k.group, (groups.get(k.group) || 0) + 1);
      const multi = [...groups.entries()].filter(([, n]) => n > 1);
      if (multi.length) {
        ok(`平台 ${p.name} 账号分组：${[...groups.entries()].map(([g, n]) => `${g}(${n})`).join(' ')}${rpmAcc ? `，每组 ${rpmAcc} RPM` : ''}`);
      }
      if (rpmAcc <= 0 && multi.length) {
        warn(`平台 ${p.name} 存在同账号多 Key（${multi.map(([g]) => g).join(',')}），但 rpmPerAccount=0 —— 同账号不会叠加额度，建议设 rpmPerAccount`);
      }
    }

    // 限流参数合理性
    if (rpmKey > 0 && rpmAcc > 0) warn(`平台 ${p.name} 同时设了 rpmPerKey=${rpmKey} 和 rpmPerAccount=${rpmAcc}，两者都会生效（取更严的），确认是有意为之`);
    if (rpmKey === 0 && rpmAcc === 0 && keys.length > 1) {
      warn(`平台 ${p.name} 没设任何 RPM 上限，全靠撞上 429 再切换 —— 建议设 rpmPerKey 主动限流，体验更稳`);
    }
    if (/nvidia/i.test(p.name) && rpmKey > 40) {
      warn(`平台 ${p.name} 的 rpmPerKey=${rpmKey} 超过英伟达免费额度（约 40 RPM/账号），容易撞限流`);
    }
    if (conc === 0 && keys.length > 1) {
      warn(`平台 ${p.name} 没设 maxConcurrencyPerKey，高并发时可能一个 Key 同时压好几个请求`);
    }
  }

  // 模型别名检查
  const providerNames = new Set(providers.map((p) => p.name));
  const defaultModel = new Map();
  let aliasCount = 0;
  for (const [alias, targets] of Object.entries(cfg.models || {})) {
    if (alias.startsWith('_')) continue;
    aliasCount++;
    const arr = Array.isArray(targets) ? targets : [targets];
    for (const t of arr) {
      const t2 = typeof t === 'string'
        ? { provider: t.slice(0, t.indexOf('/')), model: t.slice(t.indexOf('/') + 1) }
        : t;
      if (!t2 || !t2.provider) { bad(`别名 ${alias} 的配置缺少 provider 字段`); continue; }
      if (!providerNames.has(t2.provider)) bad(`别名 ${alias} 引用了不存在的平台「${t2.provider}」，可用平台：${[...providerNames].join(', ')}`);
      if (!defaultModel.has(t2.provider)) defaultModel.set(t2.provider, t2.model);
    }
  }
  if (aliasCount === 0) warn('models 里没有配置任何模型别名，调用时必须写平台原生模型名');
  else ok(`模型别名 ${aliasCount} 个：${Object.keys(cfg.models || {}).filter((k) => !k.startsWith('_')).join(' / ')}`);

  return { providers, defaultModel };
}

async function liveCheck(providers, defaultModel) {
  console.log(`\n${C.c}${C.b}── 实盘验证（会真实调用，每个 Key 消耗 1 次请求）${'─'.repeat(18)}${C.x}\n`);

  const tasks = [];
  for (const p of providers) {
    const model = defaultModel.get(p.name);
    if (!model) { warn(`平台 ${p.name} 没有可用于测试的模型（在 models 里给它配一个别名即可）`); continue; }
    let rawKeys = Array.isArray(p.keys) ? p.keys.slice() : [];
    if (p.keysFile) {
      const fp = path.isAbsolute(p.keysFile) ? p.keysFile : path.join(ROOT, p.keysFile);
      try { for (const line of fs.readFileSync(fp, 'utf8').split(/\r?\n/)) { const t = line.trim(); if (t && !t.startsWith('#')) rawKeys.push(t); } } catch (_) {}
    }
    const keys = rawKeys.map((s) => String(s).trim()).filter((s) => s && !s.startsWith('#')).map((s) => {
      const at = s.lastIndexOf('@');
      if (at > 0) return { value: s.slice(0, at).trim(), group: s.slice(at + 1).trim() };
      if (s.startsWith('env:')) return { value: (process.env[s.slice(4).trim()] || '').trim(), group: null };
      return { value: s, group: null };
    }).filter((k) => k.value);

    for (const k of keys) tasks.push({ provider: p, key: k, model });
  }

  if (!tasks.length) return;

  const url = (p) => String(p.baseUrl).replace(/\/+$/, '') + '/' + String(p.chatPath || '/chat/completions').replace(/^\/+/, '');

  let idx = 0;
  const results = [];
  const CONC = 4;
  async function worker() {
    while (idx < tasks.length) {
      const t = tasks[idx++];
      const t0 = Date.now();
      try {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), 30000);
        const resp = await fetch(url(t.provider), {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `${t.provider.authPrefix !== undefined ? t.provider.authPrefix : 'Bearer '}${t.key.value}`,
          },
          body: JSON.stringify({ model: t.model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 16, stream: false }),
          signal: ac.signal,
        });
        clearTimeout(timer);
        await resp.text();
        results.push({ ...t, status: resp.status, ms: Date.now() - t0 });
      } catch (e) {
        results.push({ ...t, status: 0, ms: Date.now() - t0, err: e.message });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONC, tasks.length) }, worker));

  results.sort((a, b) => `${a.provider.name}#${a.key.value}`.localeCompare(`${b.provider.name}#${b.key.value}`));
  let alive = 0;
  for (const r of results) {
    const tag = `${r.provider.name} ${mask(r.key.value)}${r.key.group ? ` @${r.key.group}` : ''}`;
    if (r.status === 200) {
      alive++;
      console.log(`  ${C.g}✓ 可用${C.x}   ${tag.padEnd(40)} ${r.ms}ms`);
    } else if (r.status === 401 || r.status === 403) {
      bad(`Key ${tag} 返回 ${r.status}（无效/过期/被吊销），请更换`);
      console.log(`  ${C.r}✗ ${r.status}${C.x}     ${tag.padEnd(40)} ${r.ms}ms`);
    } else if (r.status === 429) {
      warn(`Key ${tag} 返回 429（额度用尽或正在限流），稍后会自动恢复`);
      console.log(`  ${C.y}! 429${C.x}     ${tag.padEnd(40)} ${r.ms}ms`);
    } else if (r.status === 404) {
      bad(`平台 ${r.provider.name} 返回 404 —— baseUrl 或模型名不对（模型 ${r.model}）`);
      console.log(`  ${C.r}✗ 404${C.x}     ${tag.padEnd(40)} ${r.ms}ms`);
    } else {
      warn(`Key ${tag} 返回 ${r.status || r.err}`);
      console.log(`  ${C.y}! ${r.status || r.err}${C.x}     ${tag.padEnd(40)} ${r.ms}ms`);
    }
  }
  console.log(`\n  可用 ${C.g}${alive}${C.x} / 共 ${results.length} 个 Key`);
  if (alive === 0 && results.length) bad('没有一个 Key 能用，请检查 Key 是否正确、平台是否可访问');
}

(async () => {
  console.log(`\n${C.b}配置体检${C.x}  ${CONFIG_PATH}\n`);

  const cfg = loadConfig();
  if (!cfg) { report(); return; }

  const { providers, defaultModel } = staticCheck(cfg);

  console.log(`${C.c}${C.b}── 静态检查${'─'.repeat(44)}${C.x}\n`);
  for (const i of issues.filter((x) => x.level !== 'warn')) {
    console.log(`  ${i.level === 'ok' ? C.g + '✓' : C.r + '✗'}${C.x} ${i.m}`);
  }

  if (process.argv.includes('--live')) {
    await liveCheck(providers, defaultModel);
  } else {
    console.log(`\n  ${C.dim}加 --live 参数可真实调用每个 Key 验证可用性（消耗极少量额度）${C.x}`);
  }

  report();
})();

function report() {
  const warnings = issues.filter((x) => x.level === 'warn');
  const errors = issues.filter((x) => x.level === 'error');
  console.log(`\n${C.c}${C.b}── 结论${'─'.repeat(46)}${C.x}`);
  if (warnings.length) {
    console.log(`\n  ${C.y}提示 ${warnings.length} 条${C.x}`);
    for (const w of warnings) console.log(`    ${C.y}·${C.x} ${w.m}`);
  }
  if (errors.length) {
    console.log(`\n  ${C.r}错误 ${errors.length} 条${C.x}（必须修好才能正常用）`);
    for (const e of errors) console.log(`    ${C.r}·${C.x} ${e.m}`);
  }
  if (!errors.length && !warnings.length) console.log(`\n  ${C.g}配置没问题，可以启动服务了。${C.x}`);
  console.log('');
  process.exit(errors.length ? 1 : 0);
}
