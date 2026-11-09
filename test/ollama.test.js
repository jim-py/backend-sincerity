import test from 'node:test';
import assert from 'node:assert/strict';
import { createOllama } from '../src/ai/ollama.js';
import { MODEL } from '../src/ai/config.js';
import { config } from './helpers.js';

const reply = (patch = {}) => ({ model: MODEL, done: true, done_reason: 'stop',
  message: { role: 'assistant', content: 'Ответ' }, prompt_eval_count: 100, eval_count: 10, ...patch });
const payload = { messages: [{ role: 'user', content: 'Привет' }], maxTokens: 350 };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });

test('Ollama request fixes URL/model/limits and maps actual usage without forwarding service keys', async () => {
  const client = createOllama(config, async (url, options) => {
    assert.equal(url, 'http://127.0.0.1:11434/api/chat');
    const body = JSON.parse(options.body);
    assert.equal(body.model, MODEL);
    assert.equal(body.stream, false);
    assert.equal(body.think, false);
    assert.equal(body.keep_alive, '30m');
    assert.deepEqual(body.options, { temperature: 0.2, num_ctx: 4096, num_predict: 350 });
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(options.redirect, 'error');
    return json(reply());
  });
  assert.deepEqual((await client.chat(payload)).usage, { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 });
});

test('empty chat preloads model and structured chat passes server schema', async () => {
  const schema = { type: 'object' };
  const bodies = [];
  const client = createOllama(config, async (_url, options) => {
    const body = JSON.parse(options.body); bodies.push(body);
    return json(body.messages.length ? reply() : reply({ done_reason: 'load', message: { role: 'assistant', content: '' } }));
  });
  await client.load();
  await client.chat({ ...payload, schema });
  assert.deepEqual(bodies[0].messages, []);
  assert.deepEqual(bodies[1].format, schema);
});

test('metadata inspection checks installed model without downloading or generating', async () => {
  const urls = [];
  const client = createOllama(config, async (url) => {
    urls.push(url);
    return json(url.endsWith('/version') ? { version: '0.99.0' } : { capabilities: ['completion'], thinking: { values: [true, false] } });
  });
  assert.equal((await client.inspect()).version, '0.99.0');
  assert.equal(urls.length, 2);
  const bad = createOllama(config, async (url) => json(url.endsWith('/version') ? { version: '1' } : { capabilities: [] }));
  await assert.rejects(bad.inspect(), { code: 'unsupported_ollama' });
});

test('upstream errors are sanitised and bounded; uncertain responses do not permit another generation', async () => {
  const badResponses = [json({ secret: 'do-not-leak' }, 503), new Response('broken'), json(null), json([]),
    json(reply({ done: false })), new Response('x'.repeat(70 * 1024))];
  for (const response of badResponses) {
    const client = createOllama(config, async () => response);
    await assert.rejects(client.chat(payload), (error) => !error.message.includes('do-not-leak'));
  }
  await assert.rejects(createOllama(config, async () => json(reply({ done: false }))).chat(payload), { uncertain: true });
  await assert.rejects(createOllama(config, async () => json(reply({ eval_count: 351 }))).chat(payload), { code: 'context_budget_exceeded', uncertain: false });
});

test('timeout and connection refusal have distinct cancellation certainty', async () => {
  const timed = createOllama({ ...config, generationTimeoutMs: 5 }, async (_url, { signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(new Error('private connection details')), { once: true });
  }));
  await assert.rejects(timed.chat(payload), { code: 'upstream_timeout', uncertain: true });
  const refused = createOllama(config, async () => { throw new Error('private', { cause: { code: 'ECONNREFUSED' } }); });
  await assert.rejects(refused.chat(payload), { uncertain: false, retryable: true });
});
