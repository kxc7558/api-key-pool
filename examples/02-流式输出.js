'use strict';
/**
 * 示例 2：流式输出（打字机效果）
 *
 * 运行：node examples/02-流式输出.js
 *
 * 代理池会把上游的 SSE 流原样透传，客户端这边按 OpenAI 的标准方式解析即可。
 */

const POOL = process.env.POOL_BASE || 'http://127.0.0.1:8787/v1';
// 中转站模式下要带分发 Key（config.json 的 accessKeys 里配置的那个）。
// 用环境变量 POOL_KEY 覆盖，或直接改下面这行的默认值。
const POOL_KEY = process.env.POOL_KEY || 'sk-pool-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';

async function main() {
  const resp = await fetch(`${POOL}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${POOL_KEY}` },
    body: JSON.stringify({
      model: 'auto',
      messages: [{ role: 'user', content: '写三句话介绍中通快运中转场的人事工作流程。' }],
      stream: true,          // 开启流式
      max_tokens: 300,
    }),
  });

  if (!resp.ok) {
    console.error(`HTTP ${resp.status}: ${await resp.text()}`);
    process.exit(1);
  }

  console.log('命中 Key:', resp.headers.get('x-pool-key'));
  console.log('\n回复：\n');

  // 逐块读取 SSE
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';   // 最后一行可能不完整，留到下一轮

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === '[DONE]') continue;

      try {
        const chunk = JSON.parse(payload);
        const d = chunk.choices?.[0]?.delta;
        // 思考模型可能流式输出 reasoning 而非 content，这里兜底
        const delta = (d && (d.content ?? d.reasoning ?? d.reasoning_content)) || '';
        if (delta) {
          process.stdout.write(delta);   // 打字机效果
          full += delta;
        }
      } catch (_) {
        // 忽略解析不了的心跳包
      }
    }
  }

  console.log(`\n\n共收到 ${full.length} 个字符`);
}

main().catch((e) => {
  console.error(`\n失败：${e.message}`);
  process.exit(1);
});
