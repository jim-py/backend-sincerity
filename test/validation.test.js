import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { loadAiConfig, MODEL } from '../src/ai/config.js';
import { validateChat, completion } from '../src/ai/validation.js';
import { KEY } from './helpers.js';

const env = { AI_SERVICE_KEY: KEY, ADMIN_TOKEN: 'stories-test-token', PGHOST: 'postgres', PGDATABASE: 'test', PGUSER: 'test', PGPASSWORD: 'test-only' };
const valid = () => ({ messages: [{ role: 'user', content: 'Привет 👋' }] });

test('AI configuration fails closed, preserves the stories default, and reserves occupied ports', () => {
  assert.equal(loadAiConfig(env).port, 3012);
  assert.equal(loadAiConfig(env).maxTokens, 512);
  assert.equal(loadAiConfig({ ...env, AI_MAX_TOKENS: '1024' }).maxTokens, 1024);
  assert.equal(loadAiConfig({ ...env, AI_MAX_TOKENS: '350' }).maxTokens, 350);
  assert.equal(loadConfig(env).port, 3010);
  for (const patch of [{ AI_SERVICE_KEY: '' }, { AI_SERVICE_KEY: env.ADMIN_TOKEN }, { PGHOST: '' },
    { AI_PORT: '3011' }, { AI_PORT: '3010' }, { AI_TIMEZONE: 'wrong' }, { AI_MAX_TOKENS: '1025' }, { AI_MAX_ATTEMPTS: '0' }]) {
    assert.throws(() => loadAiConfig({ ...env, ...patch }));
  }
});

test('chat accepts only documented text messages and fixed model', () => {
  assert.deepEqual(validateChat({ ...valid(), model: MODEL, stream: false, max_tokens: 1 }), { ...valid(), maxTokens: 1 });
  for (const patch of [{ stream: true }, { stream: null }, { model: 'other' }, { tools: [] }, { options: {} },
    { url: 'http://elsewhere' }, { temperature: 1 }, { max_tokens: 513 }, { max_tokens: 0 }, { max_tokens: null }]) {
    assert.throws(() => validateChat({ ...valid(), ...patch }));
  }
});

test('chat rejects excessive messages, byte budgets, malformed Unicode and hidden fields', () => {
  for (const messages of [[], Array(9).fill({ role: 'user', content: 'x' }), [{ role: 'tool', content: 'x' }],
    [{ role: 'assistant', content: 'x' }], [{ role: 'user', content: '' }], [{ role: 'user', content: '\0' }],
    [{ role: 'user', content: '\ud800' }], [{ role: 'user', content: 'x', images: [] }],
    [{ role: 'user', content: '🙂'.repeat(1537) }], [{ role: 'user', content: 'x' }, { role: 'system', content: 'x' }]]) {
    assert.throws(() => validateChat({ messages }));
  }
  assert.equal(validateChat({ messages: [{ role: 'user', content: '🙂'.repeat(1536) }] }).messages.length, 1);
});

test('completion uses server metadata and never invents usage counters', () => {
  const value = completion({ content: 'Ответ', finishReason: 'stop' }, 'id', 100_000);
  assert.equal(value.created, 100);
  assert.equal(value.model, MODEL);
  assert.equal(value.object, 'chat.completion');
  assert.equal('usage' in value, false);
});
