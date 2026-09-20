// Shared by desktop and mobile; no platform imports.
export class SessionExpiredError extends Error {}

export class RequestNotSentError extends Error {
  code = 'REQUEST_NOT_SENT';
}
