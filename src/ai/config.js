import { ConfigurationError, databaseConfig, port, required } from '../config.js';

export const MODEL = 'qwen3.5:35b-a3b-q4_K_M';
export const OLLAMA_URL = 'http://127.0.0.1:11434';
export const CONTEXT_SIZE = 8192;
export const CONTEXT_RESERVE = 1024;
export const MAX_JSON_BYTES = 64 * 1024;
export const MAX_INPUT_BYTES = 6 * 1024;
export const DEFAULT_MAX_TOKENS = 512;
export const MAX_OUTPUT_TOKENS = 1024;
export const MAX_MESSAGES = 8;

function integer(env, name, fallback, min, max) {
  const raw = env[name] ?? String(fallback);
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new ConfigurationError(`${name} must be an integer from ${min} to ${max}.`);
  }
  return value;
}

export function loadAiConfig(env = process.env) {
  const apiKey = required(env, 'AI_SERVICE_KEY');
  if (!/^[A-Za-z0-9._~-]{32,256}$/.test(apiKey) || apiKey === env.ADMIN_TOKEN) {
    throw new ConfigurationError('AI_SERVICE_KEY must be a separate random token of 32–256 characters.');
  }
  const listenPort = port(env.AI_PORT ?? '3012', 'AI_PORT');
  if ([3010, 3011, 11434].includes(listenPort)) {
    throw new ConfigurationError('AI_PORT must not replace ports 3010, 3011 or 11434.');
  }
  const timezone = env.AI_TIMEZONE ?? 'UTC';
  const host = env.AI_BIND_HOST ?? '127.0.0.1';
  if (!['127.0.0.1', '0.0.0.0'].includes(host)) throw new ConfigurationError('AI_BIND_HOST must be 127.0.0.1 or 0.0.0.0.');
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }).format(); }
  catch { throw new ConfigurationError('AI_TIMEZONE must be an IANA timezone.'); }
  return {
    apiKey,
    port: listenPort,
    host,
    socketPath: env.OLLAMA_SOCKET_PATH ? requiredSocket(env.OLLAMA_SOCKET_PATH) : undefined,
    timezone,
    database: databaseConfig(env),
    maxTokens: integer(env, 'AI_MAX_TOKENS', DEFAULT_MAX_TOKENS, 1, MAX_OUTPUT_TOKENS),
    queueLimit: integer(env, 'AI_QUEUE_LIMIT', 8, 1, 100),
    queueWaitMs: integer(env, 'AI_QUEUE_WAIT_MS', 120_000, 1000, 300_000),
    loadTimeoutMs: integer(env, 'AI_LOAD_TIMEOUT_MS', 600_000, 1000, 3_600_000),
    generationTimeoutMs: integer(env, 'AI_GENERATION_TIMEOUT_MS', 300_000, 1000, 3_600_000),
    rateLimit: integer(env, 'AI_REQUESTS_PER_MINUTE', 6, 1, 600),
    maxAttempts: integer(env, 'AI_MAX_ATTEMPTS', 2, 1, 3),
  };
}

function requiredSocket(value) {
  if (value !== '/run/ollama-relay/ollama.sock') throw new ConfigurationError('OLLAMA_SOCKET_PATH must be /run/ollama-relay/ollama.sock.');
  return value;
}
