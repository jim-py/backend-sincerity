import { MAX_INPUT_BYTES, MAX_MESSAGES, MODEL } from './config.js';
import { AiHttpError } from './errors.js';

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function validateChat(value, maxTokens = 350) {
  const invalid = () => { throw new AiHttpError(400, 'invalid_request'); };
  if (!object(value) || Object.keys(value).some((key) => !['model', 'messages', 'stream', 'max_tokens'].includes(key))) invalid();
  if ('model' in value && value.model !== MODEL) throw new AiHttpError(400, 'unsupported_model');
  if ('stream' in value && value.stream !== false) throw new AiHttpError(400, 'stream_not_supported');
  const budget = value.max_tokens ?? maxTokens;
  if (('max_tokens' in value && value.max_tokens === null) || !Number.isInteger(budget) || budget < 1 || budget > maxTokens) invalid();
  if (!Array.isArray(value.messages) || value.messages.length < 1 || value.messages.length > MAX_MESSAGES) invalid();
  let bytes = 0;
  let hasUser = false;
  const messages = value.messages.map((message, index) => {
    if (!object(message) || Object.keys(message).length !== 2 || !('role' in message) || !('content' in message)) invalid();
    if (!['system', 'user', 'assistant'].includes(message.role) || (message.role === 'system' && index !== 0)) invalid();
    if (typeof message.content !== 'string' || message.content.trim() === ''
        || message.content.includes('\0') || !message.content.isWellFormed()) invalid();
    bytes += Buffer.byteLength(message.content, 'utf8');
    if (message.role === 'user') hasUser = true;
    return { role: message.role, content: message.content };
  });
  if (!hasUser || messages.at(-1).role !== 'user') invalid();
  if (bytes > MAX_INPUT_BYTES) throw new AiHttpError(400, 'context_budget_exceeded');
  return { messages, maxTokens: budget };
}

export function completion(result, jobId, now = Date.now()) {
  const response = {
    id: `chatcmpl-${jobId}`,
    object: 'chat.completion',
    created: Math.floor(now / 1000),
    model: MODEL,
    choices: [{ index: 0, message: { role: 'assistant', content: result.content }, finish_reason: result.finishReason }],
  };
  if (result.usage) response.usage = result.usage;
  return response;
}
