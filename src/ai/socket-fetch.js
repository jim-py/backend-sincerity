import { request } from 'node:http';
import { Readable } from 'node:stream';

// A fixed local Unix socket replaces TCP transport only; Ollama URL/path and
// response bounds/timeout validation remain in the existing client.
export function socketFetch(socketPath, connect = request) {
  return (url, options) => new Promise((resolve, reject) => {
    const target = new URL(url);
    if (target.origin !== 'http://127.0.0.1:11434') {
      reject(new Error('Unsupported relay target'));
      return;
    }
    const outgoing = connect({ socketPath, path: target.pathname, method: options.method,
      headers: options.headers, signal: options.signal }, (incoming) => {
      // IncomingMessage errors propagate through the Web stream to the caller.
      resolve(new Response(Readable.toWeb(incoming), { status: incoming.statusCode,
        headers: { 'Content-Type': incoming.headers['content-type'] ?? 'application/json' } }));
    });
    outgoing.on('error', reject);
    outgoing.end(options.body);
  });
}
