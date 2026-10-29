import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { MIMEType, TextDecoder } from 'node:util';
import { DatabaseUnavailableError, HttpError } from './errors.js';
import { MAX_JSON_BYTES, normalizedContent } from './validation.js';

const ALLOW = 'GET, POST, DELETE';
const METHODS = new Set(['GET', 'POST', 'DELETE']);
const hash = (value) => createHash('sha256').update(value).digest();

function isStories(url) {
  return typeof url === 'string' && url.split('?')[0] === '/stories';
}

function jsonError(response, status, error) {
  if (response.destroyed || response.writableEnded) return;
  const body = JSON.stringify({ error });
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'Connection': 'close', // Flush the error without reading an unbounded/rejected body.
    ...(status === 405 ? { Allow: ALLOW } : {}),
    ...(status === 401 ? { 'WWW-Authenticate': 'Bearer realm="stories"' } : {}),
  });
  response.end(body);
}

function requireJson(request) {
  if ((request.headersDistinct['content-type']?.length ?? 0) !== 1) {
    throw new HttpError(415, 'unsupported_media_type');
  }
  let type;
  try { type = new MIMEType(request.headers['content-type']); }
  catch { throw new HttpError(415, 'unsupported_media_type'); }
  const charset = type.params.get('charset')?.toLowerCase();
  if (type.essence !== 'application/json' || (charset && charset !== 'utf-8' && charset !== 'utf8')
      || (request.headers['content-encoding'] ?? 'identity').toLowerCase() !== 'identity') {
    throw new HttpError(415, 'unsupported_media_type');
  }
}

async function readJson(request) {
  requireJson(request);
  if (Number(request.headers['content-length'] ?? 0) > MAX_JSON_BYTES) {
    throw new HttpError(413, 'payload_too_large');
  }
  const bytes = await new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    function cleanup() {
      request.off('data', onData);
      request.off('end', onEnd);
      request.off('error', onError);
      request.off('aborted', onError);
    }
    function onError() {
      cleanup();
      reject(new HttpError(400, 'invalid_request'));
    }
    function onData(chunk) {
      total += chunk.length; // Bytes, not characters; covers chunked transfer too.
      if (total > MAX_JSON_BYTES) {
        cleanup();
        request.pause();
        reject(new HttpError(413, 'payload_too_large'));
      } else chunks.push(chunk);
    }
    function onEnd() { cleanup(); resolve(Buffer.concat(chunks, total)); }
    request.on('data', onData);
    request.once('end', onEnd);
    request.once('error', onError);
    request.once('aborted', onError);
  });
  try {
    // No lossy UTF-8 decoding before validation.
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new HttpError(400, 'invalid_request');
  }
}

function authorized(request, tokenHash) {
  const values = request.headersDistinct.authorization;
  if (!values || values.length !== 1) return false;
  const match = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/i.exec(values[0]);
  return match !== null && timingSafeEqual(hash(match[1]), tokenHash);
}

function socketError(socket, status, reason, error, extra = '') {
  if (!socket.writable) return;
  const body = JSON.stringify({ error });
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nCache-Control: no-store\r\nConnection: close\r\n${extra}\r\n${body}`);
}

export function createHttpServer(store, adminToken) {
  const tokenHash = hash(adminToken);
  const server = createServer({ requestTimeout: 30_000, headersTimeout: 10_000, keepAliveTimeout: 5_000 }, (request, response) => {
    // A peer disconnecting after an early rejection must not produce an unhandled error.
    request.on('error', () => {});
    response.on('error', () => {});
    void (async () => {
      if (!isStories(request.url)) throw new HttpError(404, 'not_found');
      if (!METHODS.has(request.method)) throw new HttpError(405, 'method_not_allowed');
      if (request.method === 'DELETE' && !authorized(request, tokenHash)) {
        throw new HttpError(401, 'unauthorized');
      }
      response.setHeader('Cache-Control', 'no-store');
      if (request.method === 'GET') {
        const content = await store.random();
        if (content === null) { response.writeHead(204); response.end(); }
        else {
          response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': Buffer.byteLength(content) });
          response.end(content);
        }
        return;
      }
      const content = normalizedContent(await readJson(request));
      if (request.method === 'POST') {
        await store.create(content);
        response.writeHead(201);
        response.end();
      } else {
        const deleted = await store.deleteMatching(content);
        if (deleted === 0) throw new HttpError(404, 'not_found');
        response.writeHead(204);
        response.end();
      }
    })().catch((error) => {
      if (error instanceof HttpError) jsonError(response, error.status, error.error);
      else if (error instanceof DatabaseUnavailableError) {
        console.error('[request] database_unavailable');
        jsonError(response, 503, 'service_unavailable');
      } else {
        console.error('[request] internal_error');
        jsonError(response, 500, 'internal_error');
      }
    });
  });
  // Protocol errors are also static JSON; never log error.rawPacket or headers.
  server.on('clientError', (error, socket) => {
    if (error.code === 'ECONNRESET') return;
    if (error.code === 'HPE_HEADER_OVERFLOW') socketError(socket, 431, 'Request Header Fields Too Large', 'invalid_request');
    else if (error.code === 'ERR_HTTP_REQUEST_TIMEOUT') socketError(socket, 408, 'Request Timeout', 'request_timeout');
    else socketError(socket, 400, 'Bad Request', 'invalid_request');
  });
  // CONNECT is emitted separately by Node, but is still an unsupported method.
  server.on('connect', (request, socket) => {
    if (isStories(request.url)) socketError(socket, 405, 'Method Not Allowed', 'method_not_allowed', `Allow: ${ALLOW}\r\n`);
    else socketError(socket, 404, 'Not Found', 'not_found');
  });
  return server;
}
