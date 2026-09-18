'use strict';
/* ============================================================
 * anthropic.js —— Anthropic Messages API ⇄ OpenAI Chat Completions
 *                （格式转换层，供 server.js 挂载）
 *
 * 为什么需要它：
 *   池子的调度/容错（轮询、429 换 Key、冷却、熔断、排队）全是围绕
 *   OpenAI 协议写的。Claude Code 这类客户端说的是 Anthropic Messages
 *   协议。与其把调度逻辑再写一遍，不如**在边界做转换**：
 *
 *     Anthropic 请求 ──toOpenAI()──▶ OpenAI 请求 ──(原有调度链路)──▶ 上游
 *     Anthropic 响应 ◀─jsonToAnthropic() / createStreamTranslator()── OpenAI 响应
 *
 *   于是池子的一切容错能力原封不动地作用于 Claude Code，客户端也就不用
 *   再挂一层 cc-switch 之类的转换代理（少一跳、少一个故障点）。
 *
 * 职责边界：
 *   - 本文件**不碰**任何调度/Key/网络逻辑，纯函数式转换
 *   - 不猜接口：转换规则按 Anthropic Messages API 官方结构实现
 * ============================================================ */

const crypto = require('node:crypto');
const { Transform } = require('node:stream');

/* ---------------------------------------------------------------- 常量 */

// 单张图片的 token 粗略折算（无法在不解码的情况下得知真实尺寸，
// 官方公式是 (宽×高)/750）。宁可略高也不要为 0——见 estimateInputTokens 的说明。
const IMAGE_TOKEN_ESTIMATE = 1200;

// 每条消息的结构开销（role 分隔符等），Anthropic 官方口径约 3~4 token
const PER_MESSAGE_OVERHEAD = 4;

/* ---------------------------------------------------------------- 工具 */

function newMessageId() {
  return 'msg_' + crypto.randomBytes(12).toString('hex');
}

function newToolId() {
  return 'toolu_' + crypto.randomBytes(10).toString('hex');
}

function safeParseJson(s) {
  if (typeof s !== 'string' || !s.trim()) return {};
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch (_) {
    return {};
  }
}

/** 把 content（字符串 or 块数组）统一成块数组 */
function blocksOf(content) {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  if (Array.isArray(content)) return content.filter((b) => b && typeof b === 'object');
  return [];
}

/** system 字段（字符串 or 块数组）→ 一段纯文本 */
function systemText(system) {
  if (!system) return '';
  if (typeof system === 'string') return system;
  return blocksOf(system).filter((b) => b.type === 'text').map((b) => b.text || '').join('\n\n');
}

/* ---------------------------------------------------------------- token 估算
 *
 * 为什么要估算：Anthropic 流式响应的 message_start 必须带 input_tokens。
 * 上游 OpenAI 流式接口默认**不返回** usage，如果这里填 0，下游 Cliente
 * （Claude Code 等）会认为上下文占用恒为 0 —— 直接后果是**永不触发自动压缩**，
 * 长会话会一头撞上上下文上限。（cc-switch 那类转换代理就踩过这个坑。）
 * 所以这里宁可给一个粗糙但非零、且量级正确的估算值。
 *
 * 精度说明：英文约 4 字符/token，中文约 1 字符/token，均按偏保守（偏高）取。
 * 若上游恰好返回了真实 usage，调用方会优先用真实值覆盖估算值。
 */

function estimateTokens(text) {
  if (!text) return 0;
  let ascii = 0, wide = 0, other = 0;
  for (const ch of String(text)) {
    const c = ch.codePointAt(0);
    if (c < 0x80) ascii++;
    else if (c >= 0x1f300) wide++;                                          // emoji / 符号
    else if ((c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7af) ||
             (c >= 0xf900 && c <= 0xfaff) || (c >= 0xff00 && c <= 0xffef)) wide++; // CJK
    else other++;
  }
  return Math.ceil(ascii / 4 + wide + other / 2);
}

/** 估算一次请求的输入 token（传入的是**已转换好的 OpenAI 请求体**） */
function estimateInputTokens(body) {
  let n = 0;
  for (const m of body.messages || []) {
    if (!m) continue;
    n += PER_MESSAGE_OVERHEAD;
    const c = m.content;
    if (typeof c === 'string') n += estimateTokens(c);
    else if (Array.isArray(c)) {
      for (const p of c) {
        if (!p) continue;
        if (p.type === 'text') n += estimateTokens(p.text);
        else if (p.type === 'image_url') n += IMAGE_TOKEN_ESTIMATE;
        else n += estimateTokens(JSON.stringify(p));
      }
    }
    if (m.tool_calls) n += estimateTokens(JSON.stringify(m.tool_calls));
  }
  if (Array.isArray(body.tools) && body.tools.length) n += estimateTokens(JSON.stringify(body.tools)) + 12;
  return Math.max(1, n);
}

/* ---------------------------------------------------------------- 请求转换 */

function imageToUrl(source) {
  if (!source || typeof source !== 'object') return null;
  if (source.type === 'base64' && source.data) {
    return `data:${source.media_type || 'image/png'};base64,${source.data}`;
  }
  if (source.type === 'url' && source.url) return source.url;
  return null; // file_id 等类型无法映射到 OpenAI，忽略
}

/** tool_result 的 content（字符串 or 块数组）→ 一段纯文本 */
function toolResultText(block) {
  const c = block.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    const parts = [];
    for (const b of c) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'text') parts.push(b.text || '');
      else if (b.type === 'image') parts.push('[图片]'); // OpenAI tool 消息只收文本
      else parts.push(JSON.stringify(b));
    }
    return parts.join('\n');
  }
  return '';
}

function mapToolChoice(tc) {
  if (!tc || typeof tc !== 'object') return undefined;
  if (tc.type === 'auto') return 'auto';
  if (tc.type === 'any') return 'required';              // Anthropic:any ≈ OpenAI:required
  if (tc.type === 'none') return 'none';
  if (tc.type === 'tool' && tc.name) return { type: 'function', function: { name: tc.name } };
  return undefined;
}

/**
 * Anthropic Messages 请求 → OpenAI Chat Completions 请求。
 * 返回 { body, meta }；meta 供响应转换回填 model / id / 输入 token 估算。
 * 输入非法时以 { error } 形式返回（调用方转成 400）。
 */
function toOpenAI(anth) {
  if (!anth || typeof anth !== 'object') return { error: '请求体不是合法 JSON 对象' };
  if (!anth.model) return { error: '缺少 model 字段' };
  if (!Array.isArray(anth.messages) || !anth.messages.length) return { error: 'messages 不能为空' };

  const messages = [];
  const sys = systemText(anth.system);
  if (sys) messages.push({ role: 'system', content: sys });

  for (const m of anth.messages) {
    if (!m || typeof m !== 'object') continue;

    if (m.role === 'assistant') {
      const texts = [];
      const toolCalls = [];
      for (const b of blocksOf(m.content)) {
        if (b.type === 'text') texts.push(b.text || '');
        else if (b.type === 'tool_use') {
          toolCalls.push({
            id: b.id || newToolId(),
            type: 'function',
            function: { name: b.name || '', arguments: JSON.stringify(b.input == null ? {} : b.input) },
          });
        }
        // thinking / redacted_thinking：OpenAI 侧没有对应字段，丢弃
      }
      if (!texts.length && !toolCalls.length) continue; // 只有思考块的空消息，跳过
      const msg = { role: 'assistant', content: texts.join('') || null };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      messages.push(msg);
      continue;
    }

    // user（Anthropic 的 user 消息里也可能夹着 tool_result）
    const parts = [];
    const toolMsgs = [];
    for (const b of blocksOf(m.content)) {
      if (b.type === 'text') parts.push({ type: 'text', text: b.text || '' });
      else if (b.type === 'image') {
        const url = imageToUrl(b.source);
        if (url) parts.push({ type: 'image_url', image_url: { url } });
      } else if (b.type === 'tool_result') {
        toolMsgs.push({ role: 'tool', tool_call_id: b.tool_use_id || '', content: toolResultText(b) });
      }
      // document 等类型暂不支持映射，忽略
    }
    // tool 消息必须紧跟发起调用的 assistant 消息，所以排在 user 文本之前
    for (const t of toolMsgs) messages.push(t);
    if (parts.length === 1 && parts[0].type === 'text') messages.push({ role: 'user', content: parts[0].text });
    else if (parts.length) messages.push({ role: 'user', content: parts });
    else if (!toolMsgs.length) messages.push({ role: 'user', content: '' });
  }

  const body = { model: anth.model, messages };

  // 参数映射：只搬 OpenAI 侧认得的，Anthropic 专有字段（thinking / anthropic_beta /
  // mcp_servers / container 等）一概不带——带上会让部分上游直接 400。
  if (anth.max_tokens != null) body.max_tokens = anth.max_tokens;
  if (anth.temperature != null) body.temperature = anth.temperature;
  if (anth.top_p != null) body.top_p = anth.top_p;
  if (Array.isArray(anth.stop_sequences) && anth.stop_sequences.length) body.stop = anth.stop_sequences;
  if (anth.metadata && anth.metadata.user_id) body.user = String(anth.metadata.user_id).slice(0, 64);
  if (anth.stream) body.stream = true;

  // 工具：只搬「自定义工具」（有 input_schema 的）。Anthropic 的服务端工具
  // （computer_20250124 / web_search 等，type 是版本号、没有 input_schema）
  // 在 OpenAI 侧没有对应物，带上只会污染工具表。
  const tools = (Array.isArray(anth.tools) ? anth.tools : [])
    .filter((t) => t && typeof t === 'object' && t.name && t.input_schema)
    .map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description || '',
        parameters: t.input_schema && typeof t.input_schema === 'object' ? t.input_schema : { type: 'object', properties: {} },
      },
    }));
  if (tools.length) {
    body.tools = tools;
    const choice = mapToolChoice(anth.tool_choice);
    if (choice !== undefined) body.tool_choice = choice;
  }

  return {
    body,
    meta: {
      model: anth.model,
      messageId: newMessageId(),
      inputTokens: estimateInputTokens(body),
      stream: !!anth.stream,
    },
  };
}

/* ---------------------------------------------------------------- 响应转换 */

function mapStopReason(finish, hasToolUse) {
  if (hasToolUse || finish === 'tool_calls' || finish === 'function_call') return 'tool_use';
  if (finish === 'length' || finish === 'max_tokens') return 'max_tokens';
  return 'end_turn';
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

/** OpenAI 非流式响应体 → Anthropic Messages 响应体 */
function jsonToAnthropic(oai, meta) {
  const choice = (oai && oai.choices && oai.choices[0]) || {};
  const msg = choice.message || {};

  let text = '';
  if (typeof msg.content === 'string') text = msg.content;
  else if (Array.isArray(msg.content)) {
    text = msg.content.map((p) => (p && typeof p === 'object' && p.type === 'text' ? p.text || '' : '')).join('');
  }

  const content = [];
  if (text) content.push({ type: 'text', text });
  let hasToolUse = false;
  for (const tc of msg.tool_calls || []) {
    if (!tc) continue;
    hasToolUse = true;
    const fn = tc.function || {};
    content.push({ type: 'tool_use', id: tc.id || newToolId(), name: fn.name || '', input: safeParseJson(fn.arguments) });
  }
  // Anthropic 不允许 content 为空数组
  if (!content.length) content.push({ type: 'text', text: '' });

  const u = (oai && oai.usage) || {};
  return {
    id: (meta && meta.messageId) || newMessageId(),
    type: 'message',
    role: 'assistant',
    model: (meta && meta.model) || oai.model || '',
    content,
    stop_reason: mapStopReason(choice.finish_reason, hasToolUse),
    stop_sequence: null,
    usage: {
      input_tokens: num(u.prompt_tokens) != null ? u.prompt_tokens : (meta && meta.inputTokens) || 0,
      output_tokens: num(u.completion_tokens) != null ? u.completion_tokens : estimateTokens(text),
    },
  };
}

/* ---------------------------------------------------------------- 流式转换 */

function sseEvent(name, obj) {
  return `event: ${name}\ndata: ${JSON.stringify(obj)}\n\n`;
}

/**
 * OpenAI SSE 流 → Anthropic SSE 流（Transform）。
 *
 * 事件序列（Anthropic 规范）：
 *   message_start → (content_block_start → content_block_delta* → content_block_stop)*
 *                 → message_delta → message_stop
 *
 * 与 OpenAI 的差异逐条处理：
 *   - OpenAI 的 delta.reasoning_content（思考）在 Anthropic 侧没有可回放的等价物
 *     （thinking 块需要签名），**丢弃**——这也正合用户预期：不希望在界面上狂跳 Thinking
 *   - OpenAI 的 tool_calls 是「按 index 分片累积」的，要转成 Anthropic 的
 *     content_block_start(tool_use) + 一串 input_json_delta
 *   - Anthropic 每个 content_block 必须先 start 再 delta 再 stop，块之间不能交叉
 */
function createStreamTranslator(meta) {
  const state = {
    started: false,
    blockIndex: -1,
    open: null,              // null | { kind:'text' } | { kind:'tool', tcIndex }
    tcBufferedArgs: new Map(), // tcIndex -> 已到但 name 还没到的参数分片
    stopReason: null,
    sawToolUse: false,
    outText: '',
    realUsage: null,
    failed: false,
    finished: false,
  };
  let pending = '';

  function start(stream) {
    if (state.started) return;
    state.started = true;
    stream.push(sseEvent('message_start', {
      type: 'message_start',
      message: {
        id: meta.messageId, type: 'message', role: 'assistant', model: meta.model,
        content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: meta.inputTokens, output_tokens: 0 },
      },
    }));
  }

  function closeBlock(stream) {
    if (!state.open) return;
    stream.push(sseEvent('content_block_stop', { type: 'content_block_stop', index: state.blockIndex }));
    state.open = null;
  }

  function openText(stream) {
    if (state.open && state.open.kind === 'text') return;
    closeBlock(stream);
    state.blockIndex++;
    state.open = { kind: 'text' };
    stream.push(sseEvent('content_block_start', {
      type: 'content_block_start', index: state.blockIndex,
      content_block: { type: 'text', text: '' },
    }));
  }

  function openTool(stream, tcIndex, id, name) {
    closeBlock(stream);
    state.blockIndex++;
    state.open = { kind: 'tool', tcIndex };
    state.sawToolUse = true;
    stream.push(sseEvent('content_block_start', {
      type: 'content_block_start', index: state.blockIndex,
      content_block: { type: 'tool_use', id: id || newToolId(), name: name || '', input: {} },
    }));
  }

  function emitToolArgs(stream, tcIndex, argsChunk) {
    // name 还没到就先攒着：Anthropic 的 content_block_start 必须一次把 name 报全，开早了没法补
    if (!state.open || state.open.kind !== 'tool' || state.open.tcIndex !== tcIndex) {
      state.tcBufferedArgs.set(tcIndex, (state.tcBufferedArgs.get(tcIndex) || '') + argsChunk);
      return;
    }
    stream.push(sseEvent('content_block_delta', {
      type: 'content_block_delta', index: state.blockIndex,
      delta: { type: 'input_json_delta', partial_json: argsChunk },
    }));
  }

  function finish(stream) {
    if (state.finished || state.failed) return;
    state.finished = true;
    start(stream);    // 上游一个分片都没发就结束的情况：至少给客户端一个完整的空消息
    closeBlock(stream);
    const outTokens = num(state.realUsage && state.realUsage.completion_tokens) != null
      ? state.realUsage.completion_tokens
      : estimateTokens(state.outText);
    stream.push(sseEvent('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: state.stopReason || (state.sawToolUse ? 'tool_use' : 'end_turn'), stop_sequence: null },
      usage: { output_tokens: outTokens },
    }));
    stream.push(sseEvent('message_stop', { type: 'message_stop' }));
  }

  function fail(stream, type, message) {
    if (state.finished || state.failed) return;
    state.failed = true;
    stream.push(sseEvent('error', { type: 'error', error: { type: type || 'api_error', message: message || '上游返回错误' } }));
  }

  function handleEvent(stream, evt) {
    if (!evt || typeof evt !== 'object') return;

    // 上游中途报错（OpenAI 流里以 {"error":{...}} 形式出现）
    if (evt.error && !evt.choices) {
      const e = evt.error;
      return fail(stream, mapErrorType(e.type || e.code), e.message || '上游返回错误');
    }
    if (evt.usage) state.realUsage = evt.usage;

    for (const ch of evt.choices || []) {
      if (!ch) continue;
      const d = ch.delta || {};

      if (typeof d.content === 'string' && d.content.length) {
        start(stream);
        openText(stream);
        state.outText += d.content;
        stream.push(sseEvent('content_block_delta', {
          type: 'content_block_delta', index: state.blockIndex,
          delta: { type: 'text_delta', text: d.content },
        }));
      }
      // d.reasoning_content / d.reasoning：丢弃（见函数头说明）

      if (Array.isArray(d.tool_calls) && d.tool_calls.length) {
        start(stream);
        for (const tc of d.tool_calls) {
          if (!tc) continue;
          const idx = Number.isInteger(tc.index) ? tc.index : 0;
          const fn = tc.function || {};
          const args = typeof fn.arguments === 'string' ? fn.arguments : '';
          const isOpen = state.open && state.open.kind === 'tool' && state.open.tcIndex === idx;

          if (!isOpen) {
            // 只在拿到 name 时才开块；否则先把参数攒起来等 name
            if (fn.name) {
              openTool(stream, idx, tc.id, fn.name);
              const buffered = state.tcBufferedArgs.get(idx);
              if (buffered) {
                state.tcBufferedArgs.delete(idx);
                emitToolArgs(stream, idx, buffered);
              }
            } else if (args) {
              state.tcBufferedArgs.set(idx, (state.tcBufferedArgs.get(idx) || '') + args);
              continue;
            } else {
              continue;
            }
          }
          if (args) emitToolArgs(stream, idx, args);
        }
      }

      if (ch.finish_reason) state.stopReason = mapStopReason(ch.finish_reason, state.sawToolUse);
    }
  }

  function processLine(stream, line) {
    const t = line.trim();
    if (!t.startsWith('data:')) return;   // 忽略 event: / 注释 / 心跳
    const payload = t.slice(5).trim();
    if (payload === '[DONE]') return finish(stream);
    if (state.finished || state.failed) return;
    try {
      handleEvent(stream, JSON.parse(payload));
    } catch (_) {
      // 非 JSON 的 data 行：忽略（不猜内容）
    }
  }

  return new Transform({
    transform(chunk, _enc, cb) {
      pending += chunk.toString('utf8');
      let nl;
      while ((nl = pending.indexOf('\n')) >= 0) {
        const raw = pending.slice(0, nl);
        pending = pending.slice(nl + 1);
        processLine(this, raw.endsWith('\r') ? raw.slice(0, -1) : raw);
      }
      cb();
    },
    flush(cb) {
      if (pending) processLine(this, pending.replace(/\r$/, ''));
      finish(this);
      cb();
    },
  });
}

/* ---------------------------------------------------------------- 错误 */

function mapErrorType(t) {
  switch (String(t || '')) {
    case 'invalid_request_error': return 'invalid_request_error';
    case 'authentication_error': case 'auth_error': case 'permission_error': return 'authentication_error';
    case 'rate_limit_error': case 'rate_limit_exceeded': return 'rate_limit_error';
    case 'overloaded_error': case 'server_error': return 'overloaded_error';
    case 'not_found_error': return 'not_found_error';
    case 'timeout': return 'timeout_error';
    default: return 'api_error';
  }
}

/** 按 Anthropic 的错误格式回给客户端 */
function sendError(res, status, message, type, extraHeaders) {
  const body = Buffer.from(JSON.stringify({
    type: 'error',
    error: { type: mapErrorType(type), message: String(message == null ? '' : message) },
  }), 'utf8');
  const headers = Object.assign({ 'content-type': 'application/json; charset=utf-8', 'content-length': body.length }, extraHeaders || {});
  if (res.headersSent) { try { res.end(); } catch (_) {} return; }
  res.writeHead(status, headers);
  res.end(body);
}

module.exports = {
  toOpenAI,
  jsonToAnthropic,
  createStreamTranslator,
  sendError,
  mapErrorType,
  estimateTokens,
  estimateInputTokens,
  newMessageId,
};
