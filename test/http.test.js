import test from 'node:test';
import assert from 'node:assert/strict';
import { createAiHandler } from '../src/ai/http.js';
import { createHttpServer } from '../src/http.js';
import { AiHttpError } from '../src/ai/errors.js';
import { DatabaseUnavailableError } from '../src/errors.js';
import { config, request, response } from './helpers.js';

const id = '9a566fc2-2665-4dd4-8be3-048b36790ac1';

function repository() {
  return {
    rateLimit: async () => {},
    readSummary: async () => ({ report: null, current: false, state: 'empty' }),
    submitSource: async (options, data) => ({ state: 'queued', jobId: id, current: false, received: [options, data] }),
    enqueueChat: async () => ({ jobId: id }),
    job: async () => ({ id, state: 'succeeded', kind: 'chat', result: { content: 'Ответ', finishReason: 'stop' } }),
    abandonChat: async () => {},
  };
}

async function invoke(options, repo = repository()) {
  const res = response();
  await createAiHandler(repo, config, async () => {})(request(options), res);
  return res;
}

test('every AI route requires the separate token and rejects browser origins', async () => {
  const repo = repository();
  repo.rateLimit = async () => { assert.fail('unauthorised request reached database'); };
  for (const token of [null, 'wrong-token', 'stories-admin-token']) assert.equal((await invoke({ token }, repo)).status, 401);
  assert.equal((await invoke({ headers: { origin: 'https://unconfigured.example' } }, repo)).status, 403);
  const duplicate = request(); duplicate.headersDistinct.authorization.push(duplicate.headers.authorization);
  const res = response(); await createAiHandler(repo, config)(duplicate, res);
  assert.equal(res.status, 401);
});

test('routing uses only the documented AI paths and exact Allow values', async () => {
  assert.equal((await invoke({ url: '/health' })).status, 404);
  const wrong = await invoke({ method: 'PUT' });
  assert.equal(wrong.status, 405);
  assert.equal(wrong.headers.Allow, 'GET, POST');
  assert.equal((await invoke({ method: 'GET', url: '/ai/v1/chat/completions' })).headers.Allow, 'POST');
  assert.equal((await invoke({ url: '/ai/jobs/invalid' })).status, 404);
});

test('GET reads saved state without enqueueing or calling model; jobs never expose payload/result text', async () => {
  const repo = repository();
  repo.enqueueChat = repo.submitSource = async () => assert.fail('GET triggered generation');
  assert.equal((await invoke({}, repo)).json().state, 'empty');
  const job = (await invoke({ url: `/ai/jobs/${id}` }, repo)).json();
  assert.equal(job.state, 'succeeded');
  assert.equal('result' in job, false);
  assert.equal('payload' in job, false);
});

test('summary accepts arbitrary bounded JSON, scalar and null, with explicit integration source', async () => {
  for (const body of [{ any: [true, 3] }, [1, 2], null, 'value', 42]) {
    const res = await invoke({ method: 'POST', url: '/ai/habit-summary?source=tracker&timezone=Europe/Moscow', body });
    assert.equal(res.status, 202);
    assert.deepEqual(res.json().received[1], body);
  }
  const repo = repository(); repo.submitSource = async () => ({ current: true, report: { title: 'Готово' } });
  assert.equal((await invoke({ method: 'POST', body: {} }, repo)).status, 200);
});

test('JSON parsing limits Content-Type, UTF8, bytes and malformed syntax before submission', async () => {
  const repo = repository(); repo.submitSource = async () => assert.fail('invalid body persisted');
  for (const [options, status] of [
    [{ raw: Buffer.from('{bad') }, 400],
    [{ body: {}, headers: { 'content-type': 'text/plain' } }, 415],
    [{ body: {}, headers: { 'content-encoding': 'gzip' } }, 415],
    [{ raw: Buffer.from([0xff]) }, 400],
    [{ raw: Buffer.from('x'.repeat(32 * 1024 + 1)) }, 413],
    [{ chunks: [Buffer.alloc(20 * 1024), Buffer.alloc(20 * 1024)], headers: { 'content-type': 'application/json' } }, 413],
    [{ raw: Buffer.from('{}'), headers: { 'content-length': String(32 * 1024 + 1) } }, 413],
  ]) assert.equal((await invoke({ method: 'POST', ...options }, repo)).status, status);
});

test('chat stays synchronous, sanitises failures, and retires ephemeral content after replying', async () => {
  const repo = repository(); let retired = false;
  repo.abandonChat = async (value) => { assert.equal(value, id); retired = true; };
  const ok = await invoke({ method: 'POST', url: '/ai/v1/chat/completions', body: { messages: [{ role: 'user', content: 'Привет' }] } }, repo);
  assert.equal(ok.status, 200);
  assert.equal(ok.json().choices[0].message.content, 'Ответ');
  assert.equal(retired, true);
  for (const [error, status, code] of [[new AiHttpError(429, 'queue_full', 10), 429, 'queue_full'],
    [new DatabaseUnavailableError(), 503, 'service_unavailable'], [new Error('secret SQL'), 500, 'internal_error']]) {
    repo.readSummary = async () => { throw error; };
    const failed = await invoke({}, repo);
    assert.equal(failed.status, status); assert.equal(failed.json().error, code);
    assert.equal(failed.body.includes('secret'), false);
    if (status === 429) assert.equal(failed.headers['Retry-After'], '10');
  }
});

test('stories GET/POST/DELETE behaviour is preserved using mocked storage without listening on a port', async () => {
  let rows = [];
  const store = { random: async () => rows[0] ?? null, create: async (value) => rows.push(value),
    deleteMatching: async (value) => { const before = rows.length; rows = rows.filter((row) => row !== value); return before - rows.length; } };
  const server = createHttpServer(store, config.apiKey);
  async function call(options = {}) {
    const res = response();
    server.emit('request', request({ url: '/stories', ...options }), res);
    await res.done;
    return res;
  }
  assert.equal((await call({ token: null })).status, 204);
  const text = 'я'.repeat(300);
  for (let i = 0; i < 2; i++) assert.equal((await call({ method: 'POST', body: { content: ` ${text}\n` }, token: null })).status, 201);
  const get = await call(); assert.equal(get.status, 200); assert.equal(get.body, text);
  assert.equal(get.headers['Cache-Control'], 'no-store');
  assert.equal((await call({ method: 'DELETE', body: { content: text }, token: null })).status, 401);
  assert.equal((await call({ method: 'DELETE', body: { content: text } })).status, 204);
  assert.equal(rows.length, 0);
  assert.equal((await call({ method: 'PATCH' })).headers.Allow, 'GET, POST, DELETE');
  server.close();
});
