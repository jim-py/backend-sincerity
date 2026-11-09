import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Readable } from 'node:stream';
import { createRelay } from '../src/ai/relay.js';
import { socketFetch } from '../src/ai/socket-fetch.js';
import { loadAiConfig } from '../src/ai/config.js';
import { KEY } from './helpers.js';

function response() {
  const res = new PassThrough();
  res.body = '';
  res.headersSent = false;
  res.writeHead = (status) => { res.status = status; res.headersSent = true; };
  res.on('data', (data) => { res.body += data; });
  res.done = new Promise((resolve) => res.once('close', resolve));
  return res;
}

test('Docker config supports explicit container bind/socket without accepting arbitrary destinations', () => {
  const env = { AI_SERVICE_KEY: KEY, PGHOST: 'postgres', PGDATABASE: 'test', PGUSER: 'test', PGPASSWORD: 'test' };
  assert.equal(loadAiConfig(env).host, '127.0.0.1');
  const docker = loadAiConfig({ ...env, AI_BIND_HOST: '0.0.0.0', OLLAMA_SOCKET_PATH: '/run/ollama-relay/ollama.sock' });
  assert.equal(docker.host, '0.0.0.0');
  assert.equal(docker.database.host, 'postgres');
  for (const bad of [{ AI_BIND_HOST: '10.0.0.1' }, { OLLAMA_SOCKET_PATH: '/tmp/arbitrary.sock' }]) {
    assert.throws(() => loadAiConfig({ ...env, ...bad }));
  }
});

test('Unix transport passes body and cancellation signal without TCP fallback', async () => {
  const controller = new AbortController();
  const transport = socketFetch('/run/ollama-relay/ollama.sock', (options, callback) => {
    assert.equal(options.socketPath, '/run/ollama-relay/ollama.sock');
    assert.equal(options.path, '/api/chat');
    assert.equal(options.signal, controller.signal);
    const outgoing = new EventEmitter();
    outgoing.end = (body) => {
      assert.equal(body, '{"synthetic":true}');
      const incoming = Readable.from([Buffer.from('{"done":true}')]);
      incoming.statusCode = 200; incoming.headers = {};
      callback(incoming);
    };
    return outgoing;
  });
  const res = await transport('http://127.0.0.1:11434/api/chat', {
    method: 'POST', headers: {}, body: '{"synthetic":true}', signal: controller.signal,
  });
  assert.deepEqual(await res.json(), { done: true });
  await assert.rejects(transport('http://other-host/api/chat', {}));
});

test('relay forwards only fixed Ollama routes and never forwards caller credentials', async () => {
  let calls = 0;
  const server = createRelay((options, callback) => {
    calls++;
    assert.equal(options.host, '127.0.0.1'); assert.equal(options.port, 11434);
    assert.equal(options.headers.authorization, undefined);
    const upstream = new EventEmitter();
    upstream.destroy = () => {};
    upstream.end = (bytes) => {
      assert.equal(bytes.toString(), '{"messages":[]}');
      const incoming = Readable.from([Buffer.from('{"done":true}')]); incoming.statusCode = 200;
      callback(incoming);
    };
    return upstream;
  });
  const res = response();
  const req = Readable.from([Buffer.from('{"messages":[]}')]); req.method = 'POST'; req.url = '/api/chat';
  server.emit('request', req, res); await res.done;
  assert.equal(res.status, 200); assert.equal(calls, 1);
  for (const [url, method, status] of [['/api/pull', 'POST', 404], ['/api/chat?url=other', 'POST', 404], ['/api/chat', 'GET', 405]]) {
    const rejected = response();
    const request = Readable.from([]); request.url = url; request.method = method;
    server.emit('request', request, rejected); await rejected.done;
    assert.equal(rejected.status, status);
  }
  assert.equal(calls, 1); server.close();
});

test('relay bounds input and treats an ambiguous upstream disconnect as a broken transport', async () => {
  const large = createRelay(() => assert.fail('oversized body reached Ollama'));
  const req = Readable.from([Buffer.alloc(64 * 1024 + 1)]); req.method = 'POST'; req.url = '/api/chat';
  const res = response(); large.emit('request', req, res); await res.done;
  assert.equal(res.status, 413); large.close();
  for (const [code, status] of [['ECONNREFUSED', 503], ['ECONNRESET', undefined]]) {
    const server = createRelay(() => {
      const outgoing = new EventEmitter(); outgoing.destroy = () => {};
      outgoing.end = () => queueMicrotask(() => outgoing.emit('error', Object.assign(new Error('private'), { code })));
      return outgoing;
    });
    const request = Readable.from([]); request.method = 'POST'; request.url = '/api/chat';
    const result = response(); server.emit('request', request, result); await result.done;
    assert.equal(result.status, status); assert.equal(result.body.includes('private'), false); server.close();
  }
});
