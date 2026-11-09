import { HttpError } from '../errors.js';

export class AiHttpError extends HttpError {
  constructor(status, code, retryAfter = undefined) {
    super(status, code);
    this.retryAfter = retryAfter;
  }
}

export class OllamaError extends Error {
  constructor(code, { uncertain = false, retryable = false } = {}) {
    super(code);
    this.code = code;
    this.uncertain = uncertain;
    this.retryable = retryable;
  }
}
