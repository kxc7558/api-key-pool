'use strict';
/* ============================================================
 * agent.js —— 数字员工的对话与执行（供 server.js 挂载）
 *
 * 定位：让"数字员工"不隐形——用户能在网页上和它对话，它用池子里的模型思考、
 *      用白名单命令干活，全程可见（每一步工具调用都推给前端）。
 *
 * 安全设计（关键）：
 *   1. 工具是**白名单**的：只允许跑 key-pool.js 的指定子命令，不允许任意 shell
 *   2. 参数**清洗 + 白名单**：未声明的参数直接丢弃，字符集受限
 *   3. 用 execFile（不经 shell）执行，杜绝命令注入
 *   4. 写操作默认关闭（配置里 allowWrite 开启后才放行，且仍是白名单内的）
 * ============================================================ */

const fs = require('fs');
const path = require('path');
const { execFile } = require('node:child_process');

const DEFAULT_AGENT = {
  enabled: true,
  model: 'auto',          // 用池子里的哪个别名当"大脑"
  base: '',               // 后端：CLI 连哪个池子（空 = CLI 默认=云端；可填本机或自建）
  maxTurns: 6,            // 最多几轮「思考→调工具」
  allowWrite: false,      // 是否允许写操作（默认只读）
  timeoutMs: 30000,       // 单条命令超时
};

/* ---------- 工具白名单 ---------- */
// params 里声明的才允许传；写操作标 write:true（受 allowWrite 控制）
const TOOLS = [
  { name: 'pool_status', desc: '查看代理池运行状态：Key 健康度、可用数、调度策略、是否熔断',
    cmd: ['status'], params: {} },
  { name: 'pool_keys', desc: '查看每个上游 Key 的明细：状态、并发、RPM、成功/失败/429、延迟',
    cmd: ['keys'], params: {} },
  { name: 'pool_health', desc: '健康检查：服务是否活着、各平台可用 Key 数',
    cmd: ['health'], params: {} },
  { name: 'pool_users', desc: '查看分发用户与今日用量、配额',
    cmd: ['users'], params: {} },
  { name: 'pool_models', desc: '查看模型别名结构（每个别名有哪些候选、哪个是兜底）；传 provider 可查该平台可选模型',
    cmd: ['models'], params: { provider: '平台名，如 sensenova' } },
  { name: 'pool_logs', desc: '查调用日志（可按天数和状态码筛）',
    cmd: ['logs'], params: { days: '天数 1-7', status: 'HTTP 状态码，如 503' } },
  { name: 'pool_usage', desc: '查用量趋势：按天/按用户/按模型的调用次数',
    cmd: ['usage'], params: { days: '天数 1-30' } },
  { name: 'pool_test', desc: '发一条真实测试消息，验证某个模型别名是否可用（会消耗一点额度）',
    cmd: ['test'], params: { model: '模型别名，如 auto', msg: '测试内容，可省' } },
  // —— 写操作（默认关闭）——
  { name: 'pool_backup', desc: '立即备份当前配置（写操作里最安全的一个）',
    cmd: ['backup'], params: {}, write: true },
  { name: 'pool_add_alias', desc: '给某个别名新增一个候选模型',
    cmd: ['add-alias'], params: { alias: '别名', spec: '平台:模型' }, write: true },
  { name: 'pool_set_strategy', desc: '切换调度策略：round-robin / least-used / latency-first（快优先）/ cost-first（省钱优先）',
    cmd: ['set-strategy'], params: { strategy: '策略名' }, write: true },
];

/* ---------- 参数清洗：字符集受限，杜绝注入 ---------- */
function cleanArg(v) {
  return String(v == null ? '' : v).replace(/[^\w一-龥.:\-/@]/g, '').slice(0, 80);
}

function buildCmd(tool, args, opts) {
  const cmd = [opts.cliPath, ...tool.cmd];
  for (const [k, v] of Object.entries(args || {})) {
    if (!tool.params || !(k in tool.params)) continue;    // 未声明的参数一律丢弃
    const val = cleanArg(v);
    if (val) cmd.push(`--${k}=${val}`);
  }
  cmd.push(`--base=${cleanArg(opts.base)}`);   // 后端：默认=员工所在的这个池子，可改配置指向别处
  return cmd;
}

/** 后端地址：配置填了用配置的；没填就查**员工自己所在的这个池子**（本机服务查本机、云端服务查云端） */
function effectiveBase(cfg, opts) {
  return (cfg && cfg.base) ? cfg.base : (opts.ownBase || '');
}

/** 给人看的命令串（去掉 node 可执行路径，前端"过程可见"用） */
function displayCmd(cmd) {
  return cmd.slice(1).join(' ');
}

/** 执行一条已构造好的命令，返回 { out, failed } —— 用 execFile 不经 shell，杜绝命令注入 */
function runCmd(cmd, opts) {
  return new Promise((resolve) => {
    execFile(process.execPath, cmd, { cwd: opts.projectRoot, timeout: opts.timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const out = (stdout || '').trim();
        const errOut = (stderr || '').trim();
        if (err && !out) resolve({ out: `[命令失败] ${errOut || err.message}`.slice(0, 8000), failed: true });
        else resolve({ out: (out + (errOut ? '\n' + errOut : '')).slice(0, 8000), failed: !!err });
      });
  });
}

/* ---------- 员工的 system prompt：读项目里的 agent 定义 ---------- */
function loadSystemPrompt(projectRoot) {
  const candidates = [
    path.join(projectRoot, '.claude', 'agents', 'key-pool-operator.md'),
    path.join(projectRoot, '.claude', 'agents', 'agent.md'),
  ];
  for (const p of candidates) {
    try {
      const md = fs.readFileSync(p, 'utf8');
      // 去掉 frontmatter，只留正文当人格设定
      const body = md.replace(/^---[\s\S]*?---\s*/, '');
      return `你是这台 API Key 代理池的专属数字员工。下面是你的工作手册，按它行事。\n\n`
        + `重要：你能调用工具去**实际查看**系统状态（不要凭空猜测）。需要数据时先调工具，拿到结果再回答。\n`
        + `回答要简短、具体、可核对；不要罗列尝试过程。\n\n---\n\n${body}`;
    } catch (_) { /* 试下一个 */ }
  }
  return '你是 API Key 代理池的数字员工。用工具查看真实状态后简短回答。';
}

/* ---------- 创建 agent 处理器 ---------- */
function createAgent(opts) {
  const { getConfig, log, poolBase, internalKey } = opts;
  let systemPrompt = loadSystemPrompt(opts.projectRoot);

  function agentCfg() {
    const c = (getConfig() || {}).agent || {};
    return Object.assign({}, DEFAULT_AGENT, c);
  }

  /** 调池子（OpenAI 兼容）：非流式，返回 { content, toolCalls, raw } */
  async function callPool({ model, messages, tools }) {
    const body = { model, messages, max_tokens: 2048 };
    if (tools && tools.length) { body.tools = tools; body.tool_choice = 'auto'; }
    const resp = await fetch(`${poolBase}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${internalKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180000),
    });
    const text = await resp.text();
    if (!resp.ok) return { error: `池子返回 HTTP ${resp.status}：${text.slice(0, 300)}` };
    let d; try { d = JSON.parse(text); } catch (_) { return { error: '池子返回非 JSON' }; }
    if (d.error) return { error: `池子错误：${JSON.stringify(d.error).slice(0, 300)}` };
    const m = ((d.choices || [{}])[0] || {}).message || {};
    return { content: m.content || '', toolCalls: m.tool_calls || [], raw: m, model: d.model };
  }

  /** 池子忙/限流时重试几次——员工对话不该因为一次 429 就哑掉 */
  async function callPoolWithRetry(req, tries = 3) {
    let last;
    for (let i = 0; i < tries; i++) {
      last = await callPool(req);
      if (!last.error) return last;
      const busy = /HTTP 503|HTTP 429|no_available_key|queue_timeout|全部不可用/.test(last.error);
      if (busy && i < tries - 1) {
        log('warn', `[数字员工] 池子忙，${3 * (i + 1)}s 后重试（第 ${i + 1} 次）`, 'yellow');
        await new Promise((r) => setTimeout(r, 3000 * (i + 1)));
        continue;
      }
      break;
    }
    return last;
  }

  /** 处理一次对话（SSE 流式把「思考 / 工具调用 / 最终回答」都推给前端） */
  async function handleChat(req, res, body) {
    const cfg = agentCfg();
    if (!cfg.enabled) { res.writeHead(403); return res.end('员工对话未启用'); }
    const history = Array.isArray(body.history) ? body.history.slice(-12) : [];
    const userMsg = String(body.message || '').slice(0, 4000);

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache', connection: 'keep-alive',
    });
    const send = (obj) => { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch (_) {} };

    const collected = [];   // 收集工具结果：万一后面模型不可用，直接把它们交给用户，不让用户白等
    const messages = [{ role: 'system', content: systemPrompt }];
    for (const h of history) {
      if (h && (h.role === 'user' || h.role === 'assistant') && h.content) {
        messages.push({ role: h.role, content: String(h.content).slice(0, 4000) });
      }
    }
    messages.push({ role: 'user', content: userMsg });

    const tools = TOOLS.filter((t) => !t.write || cfg.allowWrite).map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.desc,
        parameters: {
          type: 'object',
          properties: Object.fromEntries(Object.entries(t.params).map(([k, v]) => [k, { type: 'string', description: v }])),
          required: [],
        },
      },
    }));

    try {
      for (let turn = 0; turn < cfg.maxTurns; turn++) {
        send({ type: 'thinking', turn: turn + 1 });
        const out = await callPoolWithRetry({ model: cfg.model, messages, tools });
        if (out.error) {
          send({ type: 'error', text: out.error });
          if (collected.length) {
            send({ type: 'text', text: '（模型暂时不可用或限流，先把已经查到的结果直接贴给你）\n\n' + collected.join('\n\n---\n\n') });
          }
          break;
        }

        if (out.toolCalls && out.toolCalls.length) {
          messages.push(out.raw);
          for (const tc of out.toolCalls) {
            const name = (tc.function && tc.function.name) || '';
            let args = {};
            try { args = JSON.parse((tc.function && tc.function.arguments) || '{}'); } catch (_) {}
            const tool = TOOLS.find((t) => t.name === name);
            if (!tool) {
              messages.push({ role: 'tool', tool_call_id: tc.id, content: `不允许的工具「${name}」` });
              send({ type: 'tool', name, args, result: '不在白名单内，已拒绝' });
              continue;
            }
            if (tool.write && !cfg.allowWrite) {
              messages.push({ role: 'tool', tool_call_id: tc.id, content: '写操作当前被禁用（需在员工设置里开启）' });
              send({ type: 'tool', name, args, result: '写操作已禁用' });
              continue;
            }
            if (typeof out.content === 'string' && out.content.trim()) send({ type: 'text', text: out.content });
            const cmd = buildCmd(tool, args, { cliPath: opts.cliPath, base: effectiveBase(cfg, opts) });
            const shown = displayCmd(cmd);
            send({ type: 'tool', name, args, cmd: shown, status: 'running' });
            log('info', `[数字员工] 执行：${shown}`, 'gray');
            const { out: result, failed } = await runCmd(cmd, { projectRoot: opts.projectRoot, timeoutMs: cfg.timeoutMs });
            messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
            collected.push(`**${name}**\n\`\`\`\n${result.slice(0, 3000)}\n\`\`\``);
            send({ type: 'tool', name, args, cmd: shown, result: result.slice(0, 4000), failed, status: 'done' });
          }
          continue;
        }

        send({ type: 'text', text: out.content || '(员工没有返回内容)' });
        send({ type: 'done', model: out.model });
        return res.end();
      }
      // 轮数用尽
      send({ type: 'text', text: '（已达到最大工具调用轮数，先给你上面的结果）' });
      send({ type: 'done' });
      return res.end();
    } catch (e) {
      send({ type: 'error', text: `员工执行出错：${e.message}` });
      return res.end();
    }
  }

  return {
    handleChat,
    agentCfg,
    TOOLS,
    effectiveBase: () => effectiveBase(agentCfg(), opts),
    reloadPrompt: () => { systemPrompt = loadSystemPrompt(opts.projectRoot); },
  };
}

module.exports = { createAgent, DEFAULT_AGENT, TOOLS };
