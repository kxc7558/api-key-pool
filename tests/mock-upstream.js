'use strict';
/**
 * 模拟上游 API，用于验证代理池的调度/容错逻辑（不消耗真实额度）
 *
 * 鉴权约定（Authorization: Bearer <KEY>）：
 *   BAD1     -> chat/models 一律 401（无效 Key 自动下线）
 *   RATE1    -> chat 前 2 次 200，之后 429 + Retry-After:2（限流切换与冷却）
 *   RATE2    -> 同上（独立计数，供同组连坐测试）
 *   RATE2B   -> chat 前 2 次 200，之后 429 + Retry-After:1（半开探活回池测试）
 *   ALWAYS429-> chat/models 一律 429（模型级熔断测试）
 *   REVIVE1  -> chat 前 1 次 401，之后恢复 200；models 恒 200（模拟临时风控把 Key 误下线后恢复，探活可复活）
 *   SLOW1    -> chat 延迟 3 秒后 200（慢节点跳过）
 *   其余     -> chat 200 / models 200
 *
 * 探活路由：GET {baseUrl}/models 不消耗 chat 次数（真实上游 models 一般也不限 chat 配额）
 */
const http = require('node:http');

const PORT = Number(process.env.MOCK_PORT) || 8899;
const chatHits = new Map();

http.createServer((req, res) => {
  const url = req.url || '/';
  const auth = String(req.headers.authorization || '').replace(/^Bearer\s+/, '');
  const isChat = req.method === 'POST' && (url.includes('/chat/completions'));

  const send = (status, obj, extraHeaders = {}) => {
    const b = Buffer.from(JSON.stringify(obj), 'utf8');
    res.writeHead(status, Object.assign({ 'content-type': 'application/json', 'content-length': b.length }, extraHeaders));
    res.end(b);
  };

  // 测试辅助：重置计数（供专项验证脚本开头调用，保证从干净状态开始）
  if (req.method === 'POST' && url.includes('/__reset')) {
    chatHits.clear();
    return send(200, { ok: true });
  }

  // ---- 探活（GET models）：BAD1 401 / ALWAYS429 429 / REVIVE1 200（模拟风控解除） / 其余 200 ----
  if (req.method === 'GET' && (url.includes('/models'))) {
    if (auth === 'BAD1') return send(401, { error: { message: 'invalid api key', code: 'auth_error' } });
    if (auth === 'ALWAYS429' || String(auth).startsWith('ALWAYS429_')) return send(429, { error: { message: 'rate limited', code: 'rate_limit_error' } }, { 'retry-after': '2' });
    return send(200, { object: 'list', data: [{ id: 'mock-model', object: 'model', owned_by: 'mock' }] });
  }

  if (!isChat) return send(404, { error: { message: 'not found' } });

  // ---- chat 计数只统计 POST chat ----
  const n = (chatHits.get(auth) || 0) + 1;
  chatHits.set(auth, n);

  let chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (auth === 'BAD1') {
      return send(401, { error: { message: 'invalid api key', code: 'auth_error' } });
    }
    if (auth === 'REVIVE1' && n <= 1) {
      return send(401, { error: { message: 'temporary risk control', code: 'auth_error' } });
    }
    if ((auth === 'RATE1' || auth === 'RATE2') && n > 2) {
      return send(429, { error: { message: 'rate limited', code: 'rate_limit_error' } }, { 'retry-after': '2' });
    }
    if (auth === 'RATE2B' && n > 2) {
      return send(429, { error: { message: 'rate limited', code: 'rate_limit_error' } }, { 'retry-after': '1' });
    }
    if (auth === 'ALWAYS429' || String(auth).startsWith('ALWAYS429_')) {
      return send(429, { error: { message: 'rate limited', code: 'rate_limit_error' } });
    }
    // GONE1: 模拟上游模型下线（410 Gone）—— 验证代理池应换候选而不是把错误抛给客户端
    if (String(auth).startsWith('GONE1')) {
      return send(410, { type: 'about:blank', title: 'Gone', status: 410,
        detail: "The model 'xxx' has reached its end of life and is no longer available." });
    }
    if (auth === 'SLOW1') await new Promise((r) => setTimeout(r, 3000));

    const content = `[${auth} 第${n}次] 收到: ${JSON.stringify((body.messages || []).slice(-1)[0]?.content || '')}`;

    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      for (const piece of content.match(/.{1,6}/g) || []) {
        // EMPTY_FINISH 模拟 SenseNova 的非标准中间分片：finish_reason=""（而非 OpenAI 标准 null）
        const finishReason = auth === 'EMPTY_FINISH' ? '' : null;
        res.write(`data: ${JSON.stringify({ id: 'm', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: piece }, finish_reason: finishReason }] })}\n\n`);
        await new Promise((r) => setTimeout(r, 20));
      }
      res.write('data: [DONE]\n\n');
      return res.end();
    }

    send(200, {
      id: 'chatcmpl-mock', object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: body.model,
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
    });
  });
}).listen(PORT, '127.0.0.1', () => console.log(`mock upstream on http://127.0.0.1:${PORT}`));
