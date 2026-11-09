import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rmdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRelay } from '../src/ai/relay.js';
import { createOllama } from '../src/ai/ollama.js';
import { ollamaResponseLimit } from '../src/ai/limits.js';
import { MODEL } from '../src/ai/config.js';
import { validateChat } from '../src/ai/validation.js';

test('metadata budget is independent from generated response budget', () => {
  assert.equal(ollamaResponseLimit('/api/show'), 1024 * 1024);
  assert.equal(ollamaResponseLimit('/api/chat'), 64 * 1024);
  assert.equal(ollamaResponseLimit('/api/version'), 64 * 1024);
});

test('native relay carries large metadata and escaped input but still rejects oversized generation', async () => {
  const directory = process.platform === 'win32' ? null : await mkdtemp(join(tmpdir(), 'iskrenne-relay-'));
  const prefix = directory ? join(directory, 'test') : '\\\\.\\pipe\\iskrenne-test-' + randomUUID();
  const upstreamPath = prefix + '-up';
  const relayPath = prefix + '-relay';
  let chatInputBytes = 0;
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      if (req.url === '/api/chat') chatInputBytes = Buffer.concat(chunks).length;
      const body = req.url === '/api/version' ? { version: 'synthetic-test' }
        : req.url === '/api/show' ? { capabilities: ['completion'], template: 'x'.repeat(96 * 1024) }
          : { model: MODEL, done: true, done_reason: 'stop', message: { role: 'assistant',
            content: chatInputBytes > 32 * 1024 ? 'small reply' : 'x'.repeat(96 * 1024) } };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  });
  const relay = createRelay((options, callback) => http.request({ ...options, socketPath: upstreamPath }, callback));
  try {
    upstream.listen(upstreamPath); await once(upstream, 'listening');
    relay.listen(relayPath); await once(relay, 'listening');
    const client = createOllama({ socketPath: relayPath, generationTimeoutMs: 5000 });
    assert.deepEqual(await client.inspect(), { version: 'synthetic-test' });
    const escapedInput = validateChat({ messages: [{ role: 'user', content: '\u0001'.repeat(6 * 1024) }], max_tokens: 512 });
    assert.equal((await client.chat(escapedInput)).content, 'small reply');
    assert.ok(chatInputBytes > 32 * 1024);
    await assert.rejects(client.chat({ messages: [{ role: 'user', content: 'synthetic' }], maxTokens: 100 }), { uncertain: true });
  } finally {
    for (const server of [relay, upstream]) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    if (directory) {
      for (const path of [upstreamPath, relayPath]) await unlink(path).catch((error) => { if (error.code !== 'ENOENT') throw error; });
      await rmdir(directory);
    }
  }
});
