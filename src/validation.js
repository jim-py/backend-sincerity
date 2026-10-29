import { HttpError } from './errors.js';

export const MAX_JSON_BYTES = 128 * 1024;

export function normalizedContent(document) {
  if (document === null || typeof document !== 'object' || Array.isArray(document)
      || Object.keys(document).length !== 1 || !Object.hasOwn(document, 'content')
      || typeof document.content !== 'string') {
    throw new HttpError(400, 'invalid_request');
  }
  const original = document.content;
  // Reject NUL and escaped unpaired surrogates before pg can replace/encode them.
  if (original.includes('\0') || !original.isWellFormed()) {
    throw new HttpError(400, 'invalid_request');
  }
  // Unicode whitespace at the edges only. U+FEFF is also treated as edge whitespace.
  const content = original.replace(/^[\p{White_Space}\uFEFF]+|[\p{White_Space}\uFEFF]+$/gu, '');
  const codePoints = Array.from(content).length;
  if (codePoints < 300 || codePoints > 10_000) {
    throw new HttpError(400, 'invalid_request');
  }
  return content;
}
