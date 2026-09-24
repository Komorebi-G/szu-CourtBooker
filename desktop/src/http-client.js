import { DEFAULT_SESSION_FILE } from '../../shared/constants.js';
import { loadSession, saveSession, withSession } from './session.js';
import { CoreHttpClient } from '../../shared/http-client-core.js';
import { SessionExpiredError } from '../../shared/errors.js';
export { SessionExpiredError } from '../../shared/errors.js';

export class HttpClient extends CoreHttpClient {
  constructor(session, { sessionPath = DEFAULT_SESSION_FILE, timeoutMs = 5000, persistRequests = false,
    renewSession, expectedUserId, transport } = {}) {
    super(session, { timeoutMs, transport, save: (value) => saveSession(value, sessionPath) });
    this.sessionPath = sessionPath;
    this.persistRequests = persistRequests;
    this.renewSession = renewSession;
    this.expectedUserId = expectedUserId;
  }
  async request(path, options = {}) {
    if (!this.persistRequests) return super.request(path, options);
    const send = () => withSession(this.sessionPath, async (session, save) => {
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
    try { return await send(); }
    catch (error) {
      // The identity GET is read-only. Never replay a booking POST after a
      // redirect or network error, because its result may be unknown.
      if (!(error instanceof SessionExpiredError) || path !== 'index.do'
        || options.method !== 'GET' || !this.renewSession || options.signal?.aborted) throw error;
      const renewed = await this.renewSession(this.expectedUserId);
      if (this.expectedUserId && renewed.identity.id !== this.expectedUserId) {
        throw new SessionExpiredError('浏览器统一认证的是另一个学校账号，原账号登录状态未改动');
      }
      await saveSession(renewed.session, this.sessionPath);
      return send();
    }
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
