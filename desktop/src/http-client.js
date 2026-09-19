import { DEFAULT_SESSION_FILE } from '../../shared/constants.js';
import { loadSession, saveSession } from './session.js';
import { CoreHttpClient } from '../../shared/http-client-core.js';
export { SessionExpiredError } from '../../shared/errors.js';

export class HttpClient extends CoreHttpClient {
  constructor(session, { sessionPath = DEFAULT_SESSION_FILE, timeoutMs = 5000 } = {}) {
    super(session, { timeoutMs, save: (value) => saveSession(value, sessionPath) });
    this.sessionPath = sessionPath;
  }
  static async create(options = {}) {
    const sessionPath = options.sessionPath ?? DEFAULT_SESSION_FILE;
    return new HttpClient(await loadSession(sessionPath), { ...options, sessionPath });
  }
}
