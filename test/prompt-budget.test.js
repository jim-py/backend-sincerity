import test from 'node:test';
import assert from 'node:assert/strict';
import { createAiHandler } from '../src/ai/http.js';
import { validateChat } from '../src/ai/validation.js';
import { createOllama } from '../src/ai/ollama.js';
import { MODEL } from '../src/ai/config.js';
import { PRODUCTIVUM_SYSTEM } from './fixtures/productivum-system.js';
import { config, request, response } from './helpers.js';

const statistics = {
  partial: true, comparison: null,
  habits: [{ name: 'Прогулка 🚶', scheduledDays: 7, completedDays: 5 }],
};
const payload = () => ({ stream: false, max_tokens: 512, messages: [
  { role: 'system', content: PRODUCTIVUM_SYSTEM },
  { role: 'user', content: JSON.stringify(statistics) },
] });

test('the supplied Productivum system prompt and JSON statistics pass without trimming or truncation', () => {
  assert.equal(Buffer.byteLength(PRODUCTIVUM_SYSTEM), 2183);
  const body = payload();
  assert.deepEqual(validateChat(body).messages, body.messages);
  assert.equal(validateChat(body).maxTokens, 512);
  // An explicitly configured old output limit remains effective.
  assert.throws(() => validateChat(body, 350), { error: 'invalid_request' });
});

test('shared 6 KiB input budget includes the whole system prompt and every user byte', () => {
  const remaining = 6 * 1024 - Buffer.byteLength(PRODUCTIVUM_SYSTEM);
  assert.equal(remaining, 3961);
  const body = payload(); body.max_tokens = 1024;
  body.messages[1].content = 'x'.repeat(remaining);
  assert.equal(validateChat(body, 1024).maxTokens, 1024);
  body.messages[1].content += 'x';
  assert.throws(() => validateChat(body, 1024), { error: 'context_budget_exceeded' });
  body.messages[1].content = 'x'.repeat(remaining - 3) + '🙂';
  assert.throws(() => validateChat(body, 1024), { error: 'context_budget_exceeded' });
  body.messages[1].content = '{}'; body.max_tokens = 1025;
  assert.throws(() => validateChat(body, 1024), { error: 'invalid_request' });
});

async function invoke(body, raw) {
  let stored;
  const synthetic = JSON.stringify({ summary: 'Синтетический ответ.', advice: 'Синтетический совет.' });
  const repo = {
    rateLimit: async () => {},
    enqueueChat: async (value) => { stored = value; return { jobId: '9a566fc2-2665-4dd4-8be3-048b36790ac1' }; },
    job: async () => ({ state: 'succeeded', result: { content: synthetic, finishReason: 'stop' } }),
    abandonChat: async () => {},
  };
  const res = response();
  await createAiHandler(repo, config)(request({ method: 'POST', url: '/ai/v1/chat/completions', raw: raw ?? Buffer.from(JSON.stringify(body)) }), res);
  assert.equal(res.status, 200);
  assert.deepEqual(stored.messages, body.messages);
  return res;
}

test('HTTP gateway accepts the real prompt as UTF-8 and escaped Unicode JSON with the same text', async () => {
  const body = payload();
  await invoke(body);
  const escaped = JSON.stringify(body).replace(/[^\x00-\x7f]/g, (char) => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0'));
  const res = await invoke(body, Buffer.from(escaped));
  assert.equal(typeof JSON.parse(res.json().choices[0].message.content).advice, 'string');
});

test('64 KiB wire budget carries heavily escaped input beyond the previous 32 KiB limit', async () => {
  const body = { messages: [{ role: 'user', content: 'x'.repeat(6 * 1024) }], max_tokens: 512 };
  const escaped = JSON.stringify(body).replaceAll('x', '\\u0078');
  assert.ok(Buffer.byteLength(escaped) > 32 * 1024);
  assert.ok(Buffer.byteLength(escaped) < 64 * 1024);
  await invoke(body, Buffer.from(escaped));
});

test('Ollama receives the larger context and preserves requested output caps and actual counter checks', async () => {
  const body = payload(); const validated = validateChat(body, 1024);
  const client = createOllama(config, async (_url, options) => {
    const value = JSON.parse(options.body);
    assert.equal(value.options.num_ctx, 8192);
    assert.equal(value.options.num_predict, 512);
    assert.deepEqual(value.messages, body.messages);
    return new Response(JSON.stringify({ model: MODEL, done: true, done_reason: 'stop',
      message: { role: 'assistant', content: '{"summary":"тест","advice":"тест"}' },
      prompt_eval_count: 8192 - 512, eval_count: 512 }));
  });
  assert.equal((await client.chat(validated)).usage.total_tokens, 8192);
  const overflow = createOllama(config, async () => new Response(JSON.stringify({ model: MODEL, done: true, done_reason: 'stop',
    message: { role: 'assistant', content: 'test' }, prompt_eval_count: 8192 - 512 + 1, eval_count: 1 })));
  await assert.rejects(overflow.chat(validated), { code: 'context_budget_exceeded', uncertain: false });
});
