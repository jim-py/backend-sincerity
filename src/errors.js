export class HttpError extends Error {
  constructor(status, error) {
    super(error);
    this.status = status;
    this.error = error;
  }
}

export class DatabaseUnavailableError extends Error {
  constructor() {
    super('Database unavailable');
  }
}

const CONNECTION_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN',
  'EHOSTUNREACH', 'ENETUNREACH', '57P01', '57P02', '57P03', '57014',
]);

export function isDatabaseUnavailable(error) {
  if (!error || typeof error !== 'object') return false;
  return error instanceof DatabaseUnavailableError || CONNECTION_CODES.has(error.code)
    || error.code?.startsWith('08') || error.code?.startsWith('53')
    || ['Connection terminated unexpectedly', 'Connection terminated',
      'timeout exceeded when trying to connect', 'Connection terminated due to connection timeout'].includes(error.message);
}
