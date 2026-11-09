import { createServer, request as httpRequest } from 'node:http';
import { lstat, unlink, chmod } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { pathToFileURL } from 'node:url';

export const SOCKET = '/run/ollama-relay/ollama.sock';
const ROUTES = new Map([['/api/version', 'GET'], ['/api/show', 'POST'], ['/api/chat', 'POST']]);
const NOT_SENT = new Set(['ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH']);

export function createRelay(connect = httpRequest) {
  const server = createServer({ requestTimeout: 30_000, headersTimeout: 10_000 }, (req, res) => {
    req.on('error', () => {});
    res.on('error', () => {});
    const error = (status) => {
      if (!res.destroyed && !res.headersSent) {
        res.writeHead(status, { 'Content-Type': 'application/json', Connection: 'close' });
        res.end('{"error":"relay_unavailable"}');
      } else res.destroy();
    };
    if (!ROUTES.has(req.url)) { error(404); return; }
    if (ROUTES.get(req.url) !== req.method) { error(405); return; }
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 32 * 1024) { req.pause(); error(413); }
      else chunks.push(chunk);
    });
    req.on('end', () => {
      if (res.writableEnded || res.destroyed) return;
      const upstream = connect({ host: '127.0.0.1', port: 11434, path: req.url,
        method: req.method, headers: { 'Content-Type': 'application/json', 'Content-Length': size } }, (incoming) => {
        res.writeHead(incoming.statusCode, { 'Content-Type': 'application/json' });
        let bytes = 0;
        incoming.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes > 64 * 1024) { upstream.destroy(); res.destroy(); }
        });
        incoming.on('error', () => res.destroy());
        incoming.pipe(res);
      });
      upstream.on('error', (failure) => {
        // Only a refused/unroutable connection proves no generation was sent.
        // Other failures must reach the worker as an uncertain transport error.
        if (NOT_SENT.has(failure.code)) error(503);
        else res.destroy();
      });
      res.on('close', () => upstream.destroy());
      upstream.end(Buffer.concat(chunks, size));
    });
  });
  server.maxConnections = 16;
  server.on('clientError', (_error, socket) => socket.destroy());
  return server;
}

async function removeStaleSocket() {
  try {
    const stat = await lstat(SOCKET);
    if (!stat.isSocket()) throw new Error('Unexpected socket path');
  } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  const active = await new Promise((resolve, reject) => {
    const connection = createConnection(SOCKET);
    connection.once('connect', () => { connection.destroy(); resolve(true); });
    connection.once('error', (error) => {
      if (['ECONNREFUSED', 'ENOENT'].includes(error.code)) resolve(false);
      else reject(error);
    });
  });
  if (active) throw new Error('Relay already running');
  await unlink(SOCKET).catch((error) => { if (error.code !== 'ENOENT') throw error; });
}

async function main() {
  await removeStaleSocket();
  const server = createRelay();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(SOCKET, resolve); });
  await chmod(SOCKET, 0o600);
  console.info('[ollama-relay] unix_socket_ready');
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    server.close(() => { process.exitCode = 0; });
    server.closeIdleConnections();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('[ollama-relay] startup_failed'); process.exitCode = 1; });
}
