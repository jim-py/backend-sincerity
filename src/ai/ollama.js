import { TextDecoder } from 'node:util';
import { CONTEXT_SIZE, MODEL, OLLAMA_URL } from './config.js';
import { OllamaError } from './errors.js';
import { socketFetch } from './socket-fetch.js';

const RESPONSE_LIMIT = 64 * 1024;
const NOT_SENT = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH']);

// Every exception is sanitised here. Neither upstream error bodies nor prompts leave this module.
export function createOllama(config, fetchImpl = config.socketPath ? socketFetch(config.socketPath) : globalThis.fetch) {
  async function request(path, body, timeoutMs, { generation = false } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(`${OLLAMA_URL}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'error', signal: controller.signal,
      });
      const reader = response.body.getReader();
      const chunks = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > RESPONSE_LIMIT) {
          controller.abort();
          await reader.cancel().catch(() => {});
          throw new OllamaError('upstream_response_too_large', { uncertain: generation });
        }
        chunks.push(value);
      }
      if (!response.ok) {
        throw new OllamaError('upstream_rejected', { retryable: [429, 500, 502, 503, 504].includes(response.status) });
      }
      try {
        const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, total)));
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object required');
        return value;
      }
      catch { throw new OllamaError('invalid_upstream_response', { uncertain: generation }); }
    } catch (error) {
      if (error instanceof OllamaError) throw error;
      const notSent = NOT_SENT.has(error?.cause?.code);
      throw new OllamaError(controller.signal.aborted ? 'upstream_timeout' : 'upstream_unavailable', {
        uncertain: generation && !notSent, retryable: notSent,
      });
    } finally { clearTimeout(timer); }
  }

  function body(messages, maxTokens) {
    return { model: MODEL, messages, stream: false, think: false, keep_alive: '30m',
      options: { temperature: 0.2, num_ctx: CONTEXT_SIZE, num_predict: maxTokens } };
  }

  return {
    async inspect() {
      const version = await request('/api/version', undefined, 10_000);
      const model = await request('/api/show', { model: MODEL }, 10_000);
      if (typeof version.version !== 'string' || !Array.isArray(model.capabilities)
          || !model.capabilities.includes('completion')) throw new OllamaError('unsupported_ollama');
      // Older versions do not advertise supported think values. A non-generating load
      // validates think:false; an explicit advertisement excluding false is rejected.
      if (model.thinking?.values && !model.thinking.values.includes(false)) throw new OllamaError('unsupported_think_setting');
      return { version: version.version.replace(/[^0-9A-Za-z.+-]/g, '').slice(0, 60) };
    },
    async load() {
      const value = await request('/api/chat', body([], config.maxTokens), config.loadTimeoutMs, { generation: true });
      if (value.done !== true || value.model !== MODEL || !['load', 'stop'].includes(value.done_reason)) {
        throw new OllamaError('invalid_load_response', { uncertain: value.done !== true });
      }
    },
    async chat(payload) {
      const value = await request('/api/chat', {
        ...body(payload.messages, payload.maxTokens), ...(payload.schema ? { format: payload.schema } : {}),
      }, config.generationTimeoutMs, { generation: true });
      const uncertain = value.done !== true;
      if (uncertain || value.model !== MODEL || value.message?.role !== 'assistant'
          || typeof value.message.content !== 'string' || value.message.content.trim() === ''
          || !value.message.content.isWellFormed() || value.message.content.includes('\0')
          || Buffer.byteLength(value.message.content) > 16 * 1024 || value.message.tool_calls?.length
          || !['stop', 'length'].includes(value.done_reason)) {
        throw new OllamaError('invalid_upstream_response', { uncertain });
      }
      const prompt = value.prompt_eval_count;
      const output = value.eval_count;
      const counts = Number.isSafeInteger(prompt) && prompt >= 0 && Number.isSafeInteger(output) && output >= 0;
      if (counts && (prompt + payload.maxTokens > CONTEXT_SIZE || output > payload.maxTokens)) {
        throw new OllamaError('context_budget_exceeded');
      }
      return { content: value.message.content, finishReason: value.done_reason === 'length' ? 'length' : 'stop',
        ...(counts ? { usage: { prompt_tokens: prompt, completion_tokens: output, total_tokens: prompt + output } } : {}) };
    },
  };
}
