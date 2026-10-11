import { DEFAULT_SESSION_FILE } from '../../shared/constants.js';
import { loadSession, saveSession, withSession } from './session.js';
import { CoreHttpClient } from '../../shared/http-client-core.js';
import { SessionExpiredError, RequestNotSentError } from '../../shared/errors.js';
export { SessionExpiredError } from '../../shared/errors.js';

export class HttpClient extends CoreHttpClient {
  constructor(session, { sessionPath = DEFAULT_SESSION_FILE, timeoutMs = 5000, persistRequests = false,
    renewSession, expectedUserId, transport, priority = 'normal' } = {}) {
    super(session, { timeoutMs, transport, save: (value) => saveSession(value, sessionPath) });
    this.sessionPath = sessionPath;
    this.persistRequests = persistRequests;
    this.renewSession = renewSession;
    this.expectedUserId = expectedUserId;
    this.priority = priority;
  }
  async request(path, options = {}) {
    if (!this.persistRequests) return super.request(path, options);
    const send = () => withSession(this.sessionPath, async (session, save, queueSignal) => {
      this.session = session;
      this.dirty = false;
      let requestResult;
      try { requestResult = await super.request(path, { ...options,
        signal: options.abortInFlight ? queueSignal : options.signal }); return requestResult; }
      finally {
        if (this.dirty) {
          this.session.savedAt = new Date().toISOString();
          try { await save(this.session); }
          catch (error) {
            // Cookie persistence must stop later requests, but cannot erase a
            // business response that the school already returned.
            if (requestResult) error.requestResult = requestResult;
            throw error;
          }
          this.dirty = false;
        }
      }
    }, { priority: options.priority ?? this.priority, signal: options.signal, cancellable: options.abortInFlight });
    try { return await send(); }
    catch (error) {
      // The identity GET is read-only. Never replay a booking POST after a
      // redirect or network error, because its result may be unknown.
      if (!(error instanceof SessionExpiredError) || path !== 'index.do'
        || options.method !== 'GET' || !this.renewSession || options.signal?.aborted) throw error;
      const failedSession = JSON.stringify(this.session);
      await withSession(this.sessionPath, async (current, save, queueSignal) => {
        // A concurrent identity check may have recovered this file already.
        // Do not overwrite newer cookies with a stale browser recovery.
        if (JSON.stringify(current) !== failedSession) return;
        const expiresAt = Math.min(Number.isFinite(options.deadlineMs) ? options.deadlineMs : Infinity,
          Date.now() + (options.timeoutMs ?? 15000));
        const controller = new AbortController();
        const cancel = () => controller.abort(new RequestNotSentError('登录恢复已停止或超过准备截止时间，未发送预约'));
        const check = () => {
          if (queueSignal.aborted || Date.now() >= expiresAt) cancel();
          controller.signal.throwIfAborted();
        };
        queueSignal.addEventListener('abort', cancel, { once: true });
        const timer = setTimeout(cancel, Math.max(1, expiresAt - Date.now()));
        try {
          check();
          const canceled = new Promise((_resolve, reject) => controller.signal.addEventListener('abort',
            () => reject(controller.signal.reason), { once: true }));
          const recovery = Promise.resolve().then(() => this.renewSession(this.expectedUserId, current.browserCdpPort,
            { signal: controller.signal, deadline: expiresAt, timeoutMs: options.timeoutMs }));
          const renewed = await Promise.race([recovery, canceled]);
          check();
          if (this.expectedUserId && renewed.identity.id !== this.expectedUserId) {
            throw new SessionExpiredError('浏览器统一认证的是另一个学校账号，原账号登录状态未改动');
          }
          await save(renewed.session);
          check();
        } finally { clearTimeout(timer); queueSignal.removeEventListener('abort', cancel); }
      }, { priority: options.priority ?? this.priority, signal: options.signal, cancellable: true });
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
