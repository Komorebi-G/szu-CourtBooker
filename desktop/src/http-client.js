import { DEFAULT_SESSION_FILE } from '../../shared/constants.js';
import { loadSession, saveSession, withSession } from './session.js';
import { CoreHttpClient } from '../../shared/http-client-core.js';
export { SessionExpiredError } from '../../shared/errors.js';

export class HttpClient extends CoreHttpClient {
  constructor(session, { sessionPath = DEFAULT_SESSION_FILE, timeoutMs = 5000, persistRequests = false } = {}) {
    super(session, { timeoutMs, save: (value) => saveSession(value, sessionPath) });
    this.sessionPath = sessionPath;
    this.persistRequests = persistRequests;
  }
  request(path, options) {
    if (!this.persistRequests) return super.request(path, options);
    return withSession(this.sessionPath, async (session, save) => {
      this.session = session;
      this.dirty = false;
      try { return await super.request(path, options); }
      finally {
        if (this.dirty) {
          this.session.savedAt = new Date().toISOString();
          await save(this.session);
          this.dirty = false;
        }
      }
    });
  }
  flush() {
    // Persistent requests commit inside their transaction, including error
    // responses. Never write a client's old snapshot over another response.
    return this.persistRequests ? Promise.resolve() : super.flush();
  }
  static async create(options = {}) {
    const sessionPath = options.sessionPath ?? DEFAULT_SESSION_FILE;
    return new HttpClient(await loadSession(sessionPath), { ...options, sessionPath, persistRequests: true });
  }
}
