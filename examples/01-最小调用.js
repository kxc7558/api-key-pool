'use strict';
/**
 * 示例 1：最小调用 —— 验证代理池是否接通
 *
 * 运行：先启动代理池（start.bat），然后
 *   node examples/01-最小调用.js
 *
 * 零依赖，用 Node 原生 fetch。
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
      model: 'auto',                       // 用别名，代理池自动挑平台
      messages: [
        { role: 'system', content: '你是一个简洁的助手，回答不超过两句话。' },
        { role: 'user', content: '用一句话解释什么是 API 限流。' },
      ],
      max_tokens: 200,
      temperature: 0.7,
    }),
  });

  // 代理池在响应头里回传了调度信息，排查问题时很有用
  console.log('命中 Key   :', resp.headers.get('x-pool-key'));
  console.log('平台       :', resp.headers.get('x-pool-provider'));
  console.log('实际模型   :', resp.headers.get('x-pool-model'));
  console.log('第几次成功 :', resp.headers.get('x-pool-attempt'));

  if (!resp.ok) {
    const err = await resp.text();
    console.error(`\n调用失败 HTTP ${resp.status}\n${err}`);
    process.exit(1);
  }

  const data = await resp.json();
  const msg = data.choices[0].message;
  // 商汤等「思考模型」正文在 reasoning 字段、content 缺失，这里做兜底
  const text = msg.content ?? msg.reasoning ?? '';
  console.log('\n回复：', text);
  console.log('\n用量：', JSON.stringify(data.usage));
}

main().catch((e) => {
  console.error(`\n连不上代理池：${e.message}`);
  console.error('请先运行 start.bat 启动代理池，确认 http://127.0.0.1:8787/health 返回 ok');
  process.exit(1);
});
