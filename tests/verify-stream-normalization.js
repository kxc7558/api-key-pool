'use strict';

const BASE = 'http://127.0.0.1:8890';

async function main() {
  const response = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'empty-finish',
      stream: true,
      messages: [{ role: 'user', content: 'stream normalization test' }],
    }),
  });

  if (!response.ok) throw new Error(`expected HTTP 200, got ${response.status}`);
  const text = await response.text();
  const chunks = text.split(/\r?\n/)
    .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map((line) => JSON.parse(line.slice(6)));
  const finishReasons = chunks.map((chunk) => chunk.choices?.[0]?.finish_reason);

  if (chunks.length === 0) throw new Error('expected SSE JSON chunks');
  if (finishReasons.some((reason) => reason === '')) {
    throw new Error(`empty finish_reason leaked through proxy: ${JSON.stringify(finishReasons)}`);
  }
  if (finishReasons.some((reason) => reason !== null)) {
    throw new Error(`expected normalized null finish_reason values: ${JSON.stringify(finishReasons)}`);
  }
  if (!text.includes('data: [DONE]')) throw new Error('expected [DONE] terminator');

  console.log(`PASS normalized ${chunks.length} non-final SSE chunks to null finish_reason`);
}

main().catch((error) => {
  console.error(`FAIL ${error.message}`);
  process.exitCode = 1;
});
