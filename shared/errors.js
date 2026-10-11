// Shared by desktop and mobile; no platform imports.
export class SessionExpiredError extends Error {}

export class RequestNotSentError extends Error {
  code = 'REQUEST_NOT_SENT';
}

export class HttpResponseError extends Error {
  constructor(status, path) {
    super(`HTTP ${status} ${path}`);
    this.status = status;
  }
}

export class SchoolQueryError extends Error {
  constructor(outcome) {
    super(outcome.message);
    this.outcome = outcome;
  }
}

export function isTransientQueryError(error) {
  return [408, 425, 429, 500, 502, 503, 504].includes(error.status)
    || ['TimeoutError', 'TypeError'].includes(error.name)
    || ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'NETWORK_ERROR'].includes(error.code)
    || ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN'].includes(error.cause?.code);
}
