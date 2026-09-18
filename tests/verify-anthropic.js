'use strict';
/**
 * 验证 Anthropic Messages 协议支持（/v1/messages 与 /v1/messages/count_tokens）
 *
 * 两部分：
 *   A. 纯函数单测 —— anthropic.js 的请求/响应转换（不起服务，不联网）
 *   B. 端到端    —— 起真服务 + mock 上游，验证协议形状、流式事件序列、鉴权、以及
 *                   OpenAI 老路径没被改坏
 *
 * 前置：
 *   node tests/mock-upstream.js                                    # 8899
 *   POOL_CONFIG=tests/config.anthropic.json node server.js         # 8891
 */
const BASE = 'http://127.0.0.1:8891';
const KEY = 'sk-pool-test-anthropic-0001';
const A = require('../anthropic');

const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', C = '\x1b[36m', X = '\x1b[0m';
let pass = 0, fail = 0;

function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ${G}PASS${X} ${name}${detail ? '  ' + detail : ''}`); }
  else { fail++; console.log(`  ${R}FAIL${X} ${name}  ${detail || ''}`); }
}

/** 解析 Anthropic SSE 文本 → [{event, data}] */
function parseSse(text) {
  const out = [];
  for (const block of text.split('\n\n')) {
    if (!block.trim()) continue;
    let ev = null, data = null;
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) ev = line.slice(6).trim();
      else if (line.startsWith('data:')) data = line.slice(5).trim();
    }
    if (ev && data) { try { out.push({ event: ev, data: JSON.parse(data) }); } catch (_) { out.push({ event: ev, data: null }); } }
  }
  return out;
}

async function messages(body, { token = KEY, useAuthHeader = false, stream = false } = {}) {
  const headers = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' };
  if (useAuthHeader) headers.authorization = 'Bearer ' + token;
  else headers['x-api-key'] = token;
  const r = await fetch(`${BASE}/v1/messages`, { method: 'POST', headers, body: JSON.stringify(Object.assign({ stream }, body)) });
  const text = await r.text();
  return { status: r.status, headers: r.headers, text, json: (() => { try { return JSON.parse(text); } catch (_) { return null; } })() };
}

(async () => {
  /* ============================================================ A. 转换单测 */
  console.log(`\n${C}A. anthropic.js 转换单测（纯函数）${X}\n`);

  console.log('[A1] 请求转换：system / 多模态 / tool_result / tool_choice');
  const conv = A.toOpenAI({
    model: 'auto',
    max_tokens: 1024,
    system: [{ type: 'text', text: '你是助手' }],
    messages: [
      { role: 'user', content: [{ type: 'text', text: '北京天气' }] },
      { role: 'assistant', content: [
        { type: 'thinking', thinking: '先想想', signature: 'sig' },
        { type: 'text', text: '我查一下' },
        { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: '北京' } },
      ] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: '晴 25 度' }] },
        { type: 'text', text: '谢谢' },
      ] },
    ],
    tools: [{ name: 'get_weather', description: '查天气', input_schema: { type: 'object', properties: { city: { type: 'string' } } } }],
    tool_choice: { type: 'auto' },
    stop_sequences: ['\n\n'],
    metadata: { user_id: 'u1' },
  });
  const b = conv.body;
  check('无转换错误', !conv.error, conv.error || '');
  check('system 提取为首条 system 消息', b.messages[0].role === 'system' && b.messages[0].content === '你是助手');
  check('assistant 的 thinking 块被丢弃、text 保留', b.messages[2].content === '我查一下', JSON.stringify(b.messages[2].content));
  check('tool_use 转成 tool_calls 且 arguments 是 JSON 字符串',
    Array.isArray(b.messages[2].tool_calls) && b.messages[2].tool_calls[0].function.name === 'get_weather' &&
    JSON.stringify(JSON.parse(b.messages[2].tool_calls[0].function.arguments)) === JSON.stringify({ city: '北京' }));
  check('tool_result 转成 role:tool 且排在 user 文本之前',
    b.messages[3].role === 'tool' && b.messages[3].tool_call_id === 'toolu_1' && b.messages[3].content === '晴 25 度' &&
    b.messages[4].role === 'user' && b.messages[4].content === '谢谢');
  check('tools 转成 OpenAI function 形态', b.tools && b.tools[0].type === 'function' && b.tools[0].function.parameters.type === 'object');
  check('tool_choice:auto 透传', b.tool_choice === 'auto');
  check('stop_sequences → stop', JSON.stringify(b.stop) === JSON.stringify(['\n\n']));
  check('metadata.user_id → user', b.user === 'u1');
  check('Anthropic 专有字段未泄漏给上游', !('thinking' in b) && !('anthropic_version' in b) && !('system' in b));

  console.log('\n[A2] tool_choice:any → required，服务端工具被过滤');
  const conv2 = A.toOpenAI({
    model: 'm', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }],
    tool_choice: { type: 'any' },
    tools: [
      { name: 'custom1', input_schema: { type: 'object' } },
      { type: 'computer_20250124', name: 'computer', display_width_px: 1024 },
    ],
  });
  check('any → required', conv2.body.tool_choice === 'required');
  check('只有 1 个自定义工具进 tools（服务端工具被剔除）', conv2.body.tools.length === 1 && conv2.body.tools[0].function.name === 'custom1');

  console.log('\n[A3] 输入 token 估算：必须非零且量级合理');
  const est = A.estimateInputTokens({ messages: [{ role: 'user', content: '你好世界，这是一段中文测试' }] });
  check('中文估算非零', est > 0, `est=${est}`);
  check('中文估算量级合理（约 1 字 1 token）', est >= 8 && est <= 30, `est=${est}`);
  check('英文估算约 4 字符/token', Math.abs(A.estimateTokens('abcdefghijklmnop') - 4) <= 1, `est=${A.estimateTokens('abcdefghijklmnop')}`);

  console.log('\n[A4] 非流式响应转换');
  const j = A.jsonToAnthropic({
    id: 'x', model: 'auto',
    choices: [{ index: 0, message: { role: 'assistant', content: '你好' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 12, completion_tokens: 3 },
  }, { model: 'auto', messageId: 'msg_test', inputTokens: 99 });
  check('结构正确', j.type === 'message' && j.role === 'assistant' && j.id === 'msg_test' && j.model === 'auto');
  check('文本块正确', j.content.length === 1 && j.content[0].type === 'text' && j.content[0].text === '你好');
  check('stop_reason=end_turn', j.stop_reason === 'end_turn');
  check('usage 用上游真实值', j.usage.input_tokens === 12 && j.usage.output_tokens === 3);

  /* ============================================================ B. 端到端 */
  console.log(`\n${C}B. 端到端（代理池 ${BASE}）${X}\n`);

  console.log('[B1] 非流式 /v1/messages（x-api-key 鉴权）');
  const r1 = await messages({ model: 'auto', max_tokens: 64, messages: [{ role: 'user', content: '你好' }] });
  check('HTTP 200', r1.status === 200, `HTTP ${r1.status} ${r1.text.slice(0, 120)}`);
  check('响应是 Anthropic 结构', r1.json && r1.json.type === 'message' && Array.isArray(r1.json.content));
  check('content 有 text 块', r1.json && r1.json.content[0] && r1.json.content[0].type === 'text');
  check('stop_reason 合法', r1.json && r1.json.stop_reason === 'end_turn');
  check('usage 是 input_tokens/output_tokens 命名', r1.json && r1.json.usage && r1.json.usage.input_tokens > 0 && typeof r1.json.usage.output_tokens === 'number');

  console.log('\n[B2] Authorization: Bearer 也认（同一个分发 Key 两种客户端通用）');
  const r2 = await messages({ model: 'auto', max_tokens: 64, messages: [{ role: 'user', content: '你好' }] }, { useAuthHeader: true });
  check('HTTP 200', r2.status === 200, `HTTP ${r2.status}`);

  console.log('\n[B3] 无效 Key → 401 且错误体是 Anthropic 格式');
  const r3 = await messages({ model: 'auto', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] }, { token: 'sk-bad' });
  check('HTTP 401', r3.status === 401, `HTTP ${r3.status}`);
  check('错误体 type=error（不是 OpenAI 的 error.message 裸结构）', r3.json && r3.json.type === 'error' && r3.json.error && r3.json.error.message, r3.text.slice(0, 160));
  check('错误类型是 authentication_error', r3.json && r3.json.error && r3.json.error.type === 'authentication_error', r3.json && r3.json.error && r3.json.error.type);

  console.log('\n[B4] 流式事件序列（Anthropic 规范）');
  const s4 = await messages({ model: 'auto', max_tokens: 64, messages: [{ role: 'user', content: '你好' }] }, { stream: true });
  check('HTTP 200', s4.status === 200);
  const ev4 = parseSse(s4.text);
  const names4 = ev4.map((e) => e.event);
  check('首事件是 message_start', names4[0] === 'message_start', names4.join(' → '));
  check('末事件是 message_stop', names4[names4.length - 1] === 'message_stop');
  check('有 message_delta 在 message_stop 之前', names4[names4.length - 2] === 'message_delta');
  check('有 text 块的 start/delta/stop 三件套',
    names4.includes('content_block_start') && names4.includes('content_block_delta') && names4.includes('content_block_stop'));
  check('没有暴露 OpenAI 的 [DONE]', !s4.text.includes('[DONE]'));
  const ms4 = ev4.find((e) => e.event === 'message_start');
  check('message_start 带非零 input_tokens（关键：为 0 会让客户端永不自动压缩）',
    ms4 && ms4.data.message.usage.input_tokens > 0, ms4 ? `input_tokens=${ms4.data.message.usage.input_tokens}` : '');
  const md4 = ev4.find((e) => e.event === 'message_delta');
  check('message_delta 带 stop_reason 与 output_tokens', md4 && md4.data.delta.stop_reason && typeof md4.data.usage.output_tokens === 'number');
  const text4 = ev4.filter((e) => e.event === 'content_block_delta' && e.data.delta.type === 'text_delta').map((e) => e.data.delta.text).join('');
  check('正文拼回完整的一句话', text4.includes('收到') && text4.length > 5, JSON.stringify(text4.slice(0, 60)));
  const idx4 = ev4.filter((e) => e.event === 'content_block_delta').map((e) => e.data.index);
  check('所有 delta 的 index 一致（同一块内）', new Set(idx4).size === 1, `indexes=${[...new Set(idx4)].join(',')}`);

  console.log('\n[B5] 思考分片（reasoning_content）必须被丢掉，不能变成 thinking 块');
  const s5 = await messages({ model: 'reason', max_tokens: 64, messages: [{ role: 'user', content: '你好' }] }, { stream: true });
  const ev5 = parseSse(s5.text);
  check('HTTP 200', s5.status === 200);
  check('没有 thinking 类型的 content_block', !ev5.some((e) => e.event === 'content_block_start' && e.data.content_block.type === 'thinking'));
  check('没有 thinking_delta', !ev5.some((e) => e.event === 'content_block_delta' && e.data.delta.type === 'thinking_delta'));
  const text5 = ev5.filter((e) => e.event === 'content_block_delta' && e.data.delta.type === 'text_delta').map((e) => e.data.delta.text).join('');
  check('正文完整（思考被丢、正文没被切碎）', text5 === '你好，世界', JSON.stringify(text5));

  console.log('\n[B6] 工具调用：流式 → tool_use 块 + input_json_delta');
  const s6 = await messages({ model: 'tool', max_tokens: 64, messages: [{ role: 'user', content: '北京天气' }], tools: [{ name: 'get_weather', description: '查天气', input_schema: { type: 'object', properties: { city: { type: 'string' } } } }] }, { stream: true });
  const ev6 = parseSse(s6.text);
  const toolStart = ev6.find((e) => e.event === 'content_block_start' && e.data.content_block.type === 'tool_use');
  check('HTTP 200', s6.status === 200, s6.text.slice(0, 160));
  check('出现 tool_use 块', !!toolStart, toolStart ? JSON.stringify(toolStart.data.content_block) : '未找到');
  check('tool_use 带 id 与 name', toolStart && toolStart.data.content_block.id && toolStart.data.content_block.name === 'get_weather');
  const partial = ev6.filter((e) => e.event === 'content_block_delta' && e.data.delta.type === 'input_json_delta').map((e) => e.data.delta.partial_json).join('');
  check('input_json_delta 拼回完整合法 JSON',
    (() => { try { return JSON.stringify(JSON.parse(partial)) === '{"city":"北京","unit":"celsius"}'; } catch (_) { return false; } })(), partial);
  const md6 = ev6.find((e) => e.event === 'message_delta');
  check('stop_reason=tool_use', md6 && md6.data.delta.stop_reason === 'tool_use', md6 && md6.data.delta.stop_reason);
  const stop6 = ev6.filter((e) => e.event === 'content_block_stop');
  check('每个开过的块都关了', stop6.length === ev6.filter((e) => e.event === 'content_block_start').length, `start=${ev6.filter((e) => e.event === 'content_block_start').length} stop=${stop6.length}`);

  console.log('\n[B7] 工具调用：非流式 → content 里的 tool_use.input 是对象');
  const r7 = await messages({ model: 'tool', max_tokens: 64, messages: [{ role: 'user', content: '北京天气' }], tools: [{ name: 'get_weather', input_schema: { type: 'object' } }] });
  const tu = r7.json && r7.json.content.find((c) => c.type === 'tool_use');
  check('HTTP 200', r7.status === 200);
  check('有 tool_use 块', !!tu);
  check('input 已解析成对象', tu && typeof tu.input === 'object' && tu.input.city === '北京', tu ? JSON.stringify(tu.input) : '');
  check('stop_reason=tool_use', r7.json && r7.json.stop_reason === 'tool_use');

  console.log('\n[B8] count_tokens（本地估算，不打上游）');
  const ct = await fetch(`${BASE}/v1/messages/count_tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: '你好，请用中文回答我这个问题' }] }),
  });
  const ctj = await ct.json();
  check('HTTP 200', ct.status === 200, JSON.stringify(ctj).slice(0, 120));
  check('返回 input_tokens 且非零', typeof ctj.input_tokens === 'number' && ctj.input_tokens > 0, `input_tokens=${ctj.input_tokens}`);

  console.log('\n[B9] 回归：OpenAI 老路径没被改坏');
  const ro = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + KEY },
    body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: '你好' }], max_tokens: 32 }),
  });
  const roj = await ro.json();
  check('HTTP 200', ro.status === 200);
  check('仍是 OpenAI 结构（choices/message/content）', roj.object === 'chat.completion' && roj.choices[0].message.role === 'assistant');
  check('工具块没串到 OpenAI 路径', !Array.isArray(roj.choices[0].message.content));

  const ro401 = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer sk-bad' },
    body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'x' }] }),
  });
  const ro401j = await ro401.json();
  check('OpenAI 路径 401 仍是 OpenAI 错误格式', ro401.status === 401 && ro401j.error && !ro401j.type, JSON.stringify(ro401j));

  console.log('\n[B10] /v1/models 按协议返回对应结构');
  const mo = await (await fetch(`${BASE}/v1/models`, { headers: { authorization: 'Bearer ' + KEY } })).json();
  check('OpenAI 侧是 {object:list,data:[]}', mo.object === 'list' && Array.isArray(mo.data));
  const ma = await (await fetch(`${BASE}/v1/models`, { headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01' } })).json();
  check('Anthropic 侧是 {data:[{type:model,display_name}],has_more}',
    Array.isArray(ma.data) && ma.data[0] && ma.data[0].type === 'model' && 'display_name' in ma.data[0] && 'has_more' in ma, JSON.stringify(ma).slice(0, 140));

  console.log('\n[B11] 上游真实 usage 优先于本地估算（非流式）');
  check('用上游 prompt_tokens（mock 返回 5）', r1.json.usage.input_tokens === 5, `input_tokens=${r1.json && r1.json.usage.input_tokens}`);

  console.log(`\n${pass + fail} 项：${G}${pass} 通过${X}${fail ? `，${R}${fail} 失败${X}` : ''}\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(`${R}验证脚本异常${X}`, e); process.exit(2); });
