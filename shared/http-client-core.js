import { BASE_URL } from './constants.js';
import { SessionExpiredError, RequestNotSentError, HttpResponseError } from './errors.js';
import { combineAbortSignals, timedAbortSignal } from './abort-signal.js';
export { SessionExpiredError } from './errors.js';

function parseSetCookie(header) {
  const [pair, ...attributes] = header.split(';');
  const separator = pair.indexOf('=');
  if (separator < 1) return null;
  const cookie = {
    name: pair.slice(0, separator).trim(),
    value: pair.slice(separator + 1).trim(),
    domain: 'ehall.szu.edu.cn',
    path: '/',
    expires: -1,
  };
  let maxAge;
  for (const attribute of attributes) {
    const [rawName, ...rawValue] = attribute.trim().split('=');
    const name = rawName.toLowerCase();
    const value = rawValue.join('=');
    if (name === 'path') cookie.path = value;
    if (name === 'domain') cookie.domain = value.replace(/^\./, '');
    if (name === 'expires' && Number.isFinite(Date.parse(value))) cookie.expires = Date.parse(value) / 1000;
    if (name === 'max-age' && /^-?\d+$/.test(value) && Number.isFinite(Number(value))) maxAge = Number(value);
  }
  // Max-Age takes precedence over Expires regardless of attribute order.
  if (maxAge !== undefined) cookie.expires = Date.now() / 1000 + Math.max(0, maxAge);
  return cookie;
}

export class CoreHttpClient {
  constructor(session, { transport = globalThis.fetch, save = async () => {}, timeoutMs = 5000 } = {}) {
    this.session = session;
    this.transport = transport;
    this.save = save;
    this.timeoutMs = timeoutMs;
    this.dirty = false;
    this.cookieRevision = 0;
    this.flushPending = Promise.resolve();
  }

  cookieHeader(url) {
    const parsed = new URL(url);
    const now = Date.now() / 1000;
    return this.session.cookies
      .filter((cookie) => {
        const domain = cookie.domain.replace(/^\./, '');
        const domainMatches = parsed.hostname === domain || parsed.hostname.endsWith(`.${domain}`);
        const path = cookie.path || '/';
        const pathMatches = parsed.pathname === path || (parsed.pathname.startsWith(path)
          && (path.endsWith('/') || parsed.pathname[path.length] === '/'));
        const alive = cookie.expires == null || cookie.expires < 0 || cookie.expires > now;
        return domainMatches && pathMatches && alive;
      })
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join('; ');
  }

  updateCookies(response) {
    const values = response.headers.getSetCookie?.() ?? [];
    for (const value of values) {
      const incoming = parseSetCookie(value);
      if (!incoming) continue;
      const index = this.session.cookies.findIndex(
        (cookie) => cookie.name === incoming.name
          && cookie.domain.replace(/^\./, '') === incoming.domain.replace(/^\./, '')
          && cookie.path === incoming.path,
      );
      if (index >= 0) this.session.cookies[index] = { ...this.session.cookies[index], ...incoming };
      else this.session.cookies.push(incoming);
      this.dirty = true;
      this.cookieRevision++;
    }
  }

  async request(path, { method = 'GET', form, expect = 'json', timeoutMs, deadlineMs, signal, onDispatch, beforeDispatch, abortInFlight = false, requestId, requestMetadata } = {}) {
    // Check again at actual dispatch: a desktop request may have waited for
    // another request to finish updating this account's cookies. In-flight
    // responses still use only the timeout signal so Stop cannot hide success.
    if (signal?.aborted) throw new RequestNotSentError('本次执行已停止，未发送请求');
    const url = new URL(path, BASE_URL);
    const headers = {
      accept: expect === 'json' ? '*/*' : 'text/html,application/xhtml+xml',
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      cookie: this.cookieHeader(url),
      origin: url.origin,
      referer: new URL('index.do', BASE_URL).href,
      'user-agent': this.session.userAgent,
      'x-requested-with': 'XMLHttpRequest',
    };
    let body;
    if (form !== undefined) {
      headers['content-type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
      body = new URLSearchParams(
        Object.entries(form).map(([key, value]) => [key, value == null ? '' : String(value)]),
      );
    }

    beforeDispatch?.();
    const startedAt = Date.now();
    if (Number.isFinite(deadlineMs) && startedAt >= deadlineMs) {
      throw new RequestNotSentError('执行窗口已结束，未发送请求');
    }
    // Read-only preparation must yield the account's connection before release.
    // A sent booking still waits for its response when Stop is pressed.
    const requestTimeoutMs = Math.max(1, Math.ceil(abortInFlight && Number.isFinite(deadlineMs)
      ? Math.min(timeoutMs ?? this.timeoutMs, deadlineMs - startedAt) : timeoutMs ?? this.timeoutMs));
    const timeout = timedAbortSignal(requestTimeoutMs);
    const combined = combineAbortSignals(abortInFlight ? [timeout.signal, signal] : [timeout.signal]);
    onDispatch?.({ startedAt });
    let response, text, endedAt;
    try { response = await this.transport(url, {
      method,
      headers,
      body,
      redirect: 'manual',
      deadlineMs,
      timeoutMs: requestTimeoutMs,
      abortInFlight,
      requestId,
      requestMetadata,
      beforeDispatch: () => {
        if (signal?.aborted) throw new RequestNotSentError('本次执行已停止，未发送请求');
        headers.cookie = this.cookieHeader(url); beforeDispatch?.();
      },
      signal: combined.signal,
    });
      endedAt = Date.now();
      this.updateCookies(response);
      text = await response.text();
    } finally { combined.dispose(); timeout.dispose(); }
    const contentType = response.headers.get('content-type') ?? '';

    if (response.status === 301 || response.status === 302 || response.status === 401) {
      throw new SessionExpiredError('登录态已失效，请重新登录并导入 Cookie');
    }
    // An HTML gateway outage is a network failure, not evidence of an expired login.
    if (!response.ok && response.status !== 403) throw new HttpResponseError(response.status, url.pathname);
    if (response.status === 403 || (expect === 'json' && contentType.includes('text/html'))) {
      throw new SessionExpiredError('请求被拒绝，登录态可能已失效，请重新导入 Cookie');
    }

    let data = text;
    if (expect === 'json') {
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(`接口没有返回 JSON：${url.pathname}`);
      }
    }
    return {
      data,
      status: response.status,
      date: response.headers.get('date'),
      age: response.headers.get('age'),
      startedAt,
      endedAt,
    };
  }

  get(path, options = {}) {
    return this.request(path, { ...options, method: 'GET' });
  }

  post(path, form = {}, options = {}) {
    return this.request(path, { ...options, method: 'POST', form });
  }

  flush() {
    // Serialize snapshots; a response arriving during a save must remain dirty.
    const work = this.flushPending.catch(() => {}).then(async () => {
      if (!this.dirty) return;
      const revision = this.cookieRevision;
      this.session.savedAt = new Date().toISOString();
      await this.save(structuredClone(this.session));
      if (revision === this.cookieRevision) this.dirty = false;
    });
    this.flushPending = work;
    return work;
  }
}
