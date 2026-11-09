import { Readable } from 'node:stream';

export const KEY = 'unit-test-key-that-is-never-a-production-secret';
export const config = { apiKey: KEY, timezone: 'UTC', queueLimit: 8, rateLimit: 6,
  queueWaitMs: 120_000, loadTimeoutMs: 600_000, generationTimeoutMs: 300_000,
  maxAttempts: 2, maxTokens: 350 };

export function request({ method = 'GET', url = '/ai/habit-summary', body, raw, headers = {}, token = KEY, chunks } = {}) {
  const bytes = raw ?? (body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body)));
  const req = Readable.from(chunks ?? [bytes]);
  req.method = method;
  req.url = url;
  req.headers = { ...(body === undefined && raw === undefined ? {} : { 'content-type': 'application/json' }),
    ...(token === null ? {} : { authorization: `Bearer ${token}` }), ...headers };
  req.headersDistinct = Object.fromEntries(Object.entries(req.headers).map(([key, value]) => [key, [value]]));
  return req;
}

export function response() {
  let resolve;
  return {
    done: new Promise((value) => { resolve = value; }),
    destroyed: false, writableEnded: false, headers: {}, status: null, body: '',
    setHeader(key, value) { this.headers[key] = value; },
    writeHead(status, headers = {}) { this.status = status; Object.assign(this.headers, headers); },
    end(body = '') { this.body = String(body); this.writableEnded = true; resolve(); },
    on() {},
    json() { return JSON.parse(this.body); },
  };
}
