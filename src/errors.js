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
