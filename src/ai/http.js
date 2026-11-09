import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { authorized, readJson, socketError } from '../http.js';
import { HttpError, isDatabaseUnavailable } from '../errors.js';
import { MAX_JSON_BYTES } from './config.js';
import { AiHttpError } from './errors.js';
import { completion, validateChat } from './validation.js';
import { sourceOptions } from './summary.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function send(response, status, body, headers = {}) {
  if (response.destroyed || response.writableEnded) return;
  const bytes = JSON.stringify(body);
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(bytes), 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', ...headers });
  response.end(bytes);
}

export function createAiHandler(repository, config, pause = delay) {
  const tokenHash = createHash('sha256').update(config.apiKey).digest();
  const keyHash = tokenHash.toString('hex');
  return async (request, response) => {
    let chatId;
    try {
      if (!authorized(request, tokenHash)) throw new AiHttpError(401, 'unauthorized');
      if (request.headers.origin) throw new AiHttpError(403, 'browser_access_disabled');
      const url = new URL(request.url, 'http://127.0.0.1');
      const jobId = url.pathname.startsWith('/ai/jobs/') ? url.pathname.slice('/ai/jobs/'.length) : null;
      const methods = url.pathname === '/ai/v1/chat/completions' ? ['POST']
        : url.pathname === '/ai/habit-summary' ? ['GET', 'POST'] : jobId && UUID.test(jobId) ? ['GET'] : null;
      if (!methods) throw new AiHttpError(404, 'not_found');
      if (!methods.includes(request.method)) {
        send(response, 405, { error: 'method_not_allowed' }, { Allow: methods.join(', ') });
        return;
      }
      await repository.rateLimit(keyHash);
      if (url.pathname === '/ai/habit-summary') {
        const options = sourceOptions(url, config.timezone, request.method === 'POST');
        if (request.method === 'GET') send(response, 200, await repository.readSummary(options.source));
        else {
          const result = await repository.submitSource(options, await readJson(request, MAX_JSON_BYTES));
          send(response, result.current ? 200 : 202, result);
        }
        return;
      }
      if (url.search) throw new AiHttpError(400, 'invalid_query');
      if (jobId) {
        const job = await repository.job(jobId);
        if (!job) throw new AiHttpError(404, 'not_found');
        // No raw payload, chat text, source snapshot or internal exception is exposed.
        send(response, 200, { jobId: job.id, state: job.state, error: job.error_code ?? null,
          createdAt: job.created_at, completedAt: job.completed_at ?? null,
          ...(job.kind === 'summary' && job.result ? { published: job.result.published } : {}) });
        return;
      }
      const payload = validateChat(await readJson(request, MAX_JSON_BYTES), config.maxTokens);
      const submitted = await repository.enqueueChat(payload);
      chatId = submitted.jobId;
      const deadline = Date.now() + config.queueWaitMs + config.maxAttempts * (config.loadTimeoutMs + config.generationTimeoutMs) + 10_000;
      while (!response.destroyed && !response.writableEnded) {
        const job = await repository.job(chatId);
        if (!job) throw new AiHttpError(503, 'job_unavailable', 10);
        if (job.state === 'succeeded' && job.result) { send(response, 200, completion(job.result, chatId)); return; }
        if (job.state === 'failed') {
          const status = ['queue_timeout', 'client_disconnected'].includes(job.error_code) ? 503
            : job.error_code === 'upstream_timeout' ? 504 : 502;
          throw new AiHttpError(status, job.error_code ?? 'generation_failed', 10);
        }
        if (Date.now() >= deadline) throw new AiHttpError(504, 'request_timeout', 10);
        await pause(300);
      }
    } catch (error) {
      const known = error instanceof HttpError;
      const unavailable = isDatabaseUnavailable(error);
      const status = known ? error.status : unavailable ? 503 : 500;
      // Repository/connection details never enter the public response or logger.
      if (!known) console.error('[ai-http] dependency_or_internal_error');
      send(response, status, { error: known ? error.error : unavailable ? 'service_unavailable' : 'internal_error' }, {
        Connection: 'close',
        ...(status === 401 ? { 'WWW-Authenticate': 'Bearer realm="ai"' } : {}),
        ...(error?.retryAfter ? { 'Retry-After': String(error.retryAfter) } : {}),
      });
    } finally {
      if (chatId) await repository.abandonChat(chatId).catch(() => console.error('[ai-http] cleanup_deferred'));
    }
  };
}

export function createAiServer(repository, config) {
  const handler = createAiHandler(repository, config);
  const server = createServer({ requestTimeout: 30_000, headersTimeout: 10_000, keepAliveTimeout: 5000 }, (request, response) => {
    request.on('error', () => {});
    response.on('error', () => {});
    void handler(request, response);
  });
  server.maxConnections = 128;
  server.on('clientError', (error, socket) => {
    if (error.code !== 'ECONNRESET') socketError(socket, error.code === 'HPE_HEADER_OVERFLOW' ? 431 : 400, 'Bad Request', 'invalid_request');
  });
  server.on('connect', (_request, socket) => socketError(socket, 405, 'Method Not Allowed', 'method_not_allowed'));
  return server;
}
