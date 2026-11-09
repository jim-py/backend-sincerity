import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorker } from '../src/ai/worker.js';
import { OllamaError } from '../src/ai/errors.js';
import { summarySpec } from '../src/ai/summary.js';
import { config } from './helpers.js';

function queue(jobs) {
  let locked = false; let blocked = false;
  const results = [];
  return {
    results,
    async claim() {
      if (locked || blocked || !jobs.length) return null;
      locked = true;
      const job = jobs.shift();
      return { job,
        finish: async (result) => results.push({ ok: true, result }),
        fail: async (error) => { blocked = error.uncertain; results.push({ ok: false, error }); },
        release: async () => { locked = false; },
      };
    },
  };
}
const job = () => ({ kind: 'chat', payload: { messages: [{ role: 'user', content: 'hello' }], maxTokens: 350 } });

test('workers retain shared slot through loading and generation, then reuse warm model', async () => {
  const repo = queue([job(), job()]);
  let release; const gate = new Promise((resolve) => { release = resolve; });
  let loads = 0; let calls = 0;
  const ollama = { inspect: async () => {}, load: async () => { loads++; },
    chat: async () => { calls++; await gate; return { content: 'ok', finishReason: 'stop' }; } };
  const a = createWorker(repo, ollama, config);
  const b = createWorker(repo, ollama, config);
  const first = a.once();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await b.once(), false);
  assert.equal(calls, 1); assert.equal(loads, 1);
  release(); await first;
  await a.once();
  assert.equal(calls, 2); assert.equal(loads, 1);
});

test('uncertain timeout blocks following model calls instead of releasing generation safety barrier', async () => {
  const repo = queue([job(), job()]);
  const ollama = { inspect: async () => {}, load: async () => {}, chat: async () => { throw new OllamaError('upstream_timeout', { uncertain: true }); } };
  const worker = createWorker(repo, ollama, config);
  await worker.once();
  assert.equal(repo.results[0].error.uncertain, true);
  assert.equal(await worker.once(), false);
});

test('summary stores only validated server-fact text and a backend UTC timestamp', async () => {
  const source = { data: { a: 1 }, language: 'ru' };
  const schema = summarySpec(source).schema;
  const value = Object.fromEntries(['title', 'summary', 'advice'].map((key) => [key, schema.properties[key].enum[0]]));
  const repo = queue([{ kind: 'summary', payload: { source } }]);
  await createWorker(repo, { inspect: async () => {}, load: async () => {},
    chat: async () => ({ content: JSON.stringify(value), finishReason: 'stop' }) }, config,
  () => new Date('2026-11-09T00:00:00Z')).once();
  assert.equal(repo.results[0].result.generatedAt, '2026-11-09T00:00:00.000Z');
});

test('invalid/truncated model summaries fail with bounded-retry classification and do not publish', async () => {
  for (const response of [{ content: '{}', finishReason: 'stop' }, { content: '{', finishReason: 'length' }]) {
    const repo = queue([{ kind: 'summary', payload: { source: { data: [], language: 'ru' } } }]);
    await createWorker(repo, { inspect: async () => {}, load: async () => {}, chat: async () => response }, config).once();
    assert.equal(repo.results[0].ok, false);
    assert.equal(repo.results[0].error.retryable, true);
    assert.equal(repo.results[0].error.uncertain, false);
  }
});
