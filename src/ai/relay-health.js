import { createConnection } from 'node:net';
const socket = createConnection('/run/ollama-relay/ollama.sock');
socket.setTimeout(2000);
socket.once('connect', () => { socket.destroy(); });
socket.once('error', () => { process.exitCode = 1; });
socket.once('timeout', () => { socket.destroy(); process.exitCode = 1; });
