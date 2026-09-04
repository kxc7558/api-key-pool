'use strict';
/**
 * 示例 3：手写笔记 / 截图 → 结构化 JSON
 *
 * 用商汤 SenseNova 的多模态能力（图像理解 + OCR + 版式分析），
 * 把一张手写笔记照片转成可直接入库的结构化数据。
 *
 * 用法：
 *   node examples/03-手写笔记转结构化数据.js "D:/笔记/2026-09-01 面试记录.jpg"
 *   node examples/03-手写笔记转结构化数据.js 图片路径 输出.json
 *
 * 想换提取字段，改下面的 SCHEMA 和 PROMPT 即可。
 */

const fs = require('node:fs');
const path = require('node:path');

const POOL = process.env.POOL_BASE || 'http://127.0.0.1:8787/v1';
// 中转站模式下要带分发 Key（config.json 的 accessKeys 里配置的那个）。
// 用环境变量 POOL_KEY 覆盖，或直接改下面这行的默认值。
const POOL_KEY = process.env.POOL_KEY || 'sk-pool-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';

// 用 Kimi K3（三款里唯一支持图片输入的，多模态 OCR/版式分析强）。
// 想换成纯文本模型可改 "pro" 或 "flash"，但那些不支持图片输入。
const MODEL = 'kimi';

// 想提取什么字段，在这里定义
const SCHEMA = {
  日期: '笔记上的日期，格式 YYYY-MM-DD，没有就 null',
  姓名: '涉及的人员姓名，没有就 null',
  岗位: '应聘或涉及的岗位（如电叉司机、装卸工），没有就 null',
  事项类型: '从 面试/入职/离职/催岗/代办离职/其他 中选一个',
  要点: '笔记核心内容的简明摘要，一到两句话',
  待办事项: '需要后续跟进的动作，数组形式，没有就空数组',
};

const PROMPT = `你是一个人事资料数字化助手。请识别这张手写笔记图片，提取信息并只输出 JSON，不要任何解释文字、不要 markdown 代码块标记。

输出格式：
${JSON.stringify(SCHEMA, null, 2)}

要求：
1. 严格按上面的键名输出，值为 null 时写 null，不要编造。
2. 字迹潦草时以能辨认的部分为准，不确定的字段写 null，并在"备注"里说明。
3. 日期统一转成 YYYY-MM-DD；只有月日时年份用 ${new Date().getFullYear()}。
4. 只输出 JSON。`;

const MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp',
};

/** 从模型回复里抠出 JSON（它有时会自作主张加说明文字或代码块） */
function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error(`没找到 JSON，模型原样返回：\n${text}`);
  return JSON.parse(raw.slice(start, end + 1));
}

async function main() {
  const imagePath = process.argv[2];
  const outPath = process.argv[3];

  if (!imagePath) {
    console.error('用法：node examples/03-手写笔记转结构化数据.js <图片路径> [输出.json]');
    process.exit(1);
  }
  if (!fs.existsSync(imagePath)) {
    console.error(`找不到图片：${imagePath}`);
    process.exit(1);
  }

  const ext = path.extname(imagePath).toLowerCase();
  const mime = MIME[ext];
  if (!mime) {
    console.error(`不支持的图片格式 ${ext}，支持：${Object.keys(MIME).join(' ')}`);
    process.exit(1);
  }

  const sizeMb = fs.statSync(imagePath).size / 1024 / 1024;
  if (sizeMb > 8) console.warn(`警告：图片 ${sizeMb.toFixed(1)}MB，可能超出平台限制，建议先压缩`);

  const dataUrl = `data:${mime};base64,${fs.readFileSync(imagePath).toString('base64')}`;
  console.log(`读取 ${path.basename(imagePath)}（${sizeMb.toFixed(2)}MB），识别中...\n`);

  const resp = await fetch(`${POOL}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${POOL_KEY}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: dataUrl } },
          { type: 'text', text: PROMPT },
        ],
      }],
      max_tokens: 1000,
      temperature: 0,      // 结构化提取要稳定，不要随机性
    }),
  });

  const text = await resp.text();
  if (!resp.ok) {
    console.error(`HTTP ${resp.status}\n${text.slice(0, 800)}`);
    process.exit(1);
  }

  console.log('命中 Key:', resp.headers.get('x-pool-key'), '| 实际模型:', resp.headers.get('x-pool-model'), '\n');

  const msg = JSON.parse(text).choices[0].message;
  // 思考模型正文可能在 reasoning 字段，兜底取
  const raw = msg.content ?? msg.reasoning ?? '';
  const data = extractJson(raw);

  console.log(JSON.stringify(data, null, 2));

  if (outPath) {
    fs.writeFileSync(outPath, JSON.stringify(data, null, 2), 'utf8');
    console.log(`\n已保存到 ${outPath}`);
  }
}

main().catch((e) => {
  console.error(`\n失败：${e.message}`);
  process.exit(1);
});
