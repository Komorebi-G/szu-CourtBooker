import { chromium } from 'playwright-core';
import { APP_URL, BASE_URL } from '../../shared/constants.js';
import { CoreHttpClient } from '../../shared/http-client-core.js';
import { SzuVenueApi } from '../../shared/api.js';
import { SessionExpiredError, RequestNotSentError } from '../../shared/errors.js';
import { parseSessionText } from '../../shared/session-format.js';

// Use the browser's CAS session to obtain fresh venue cookies in an isolated
// context. Never import another user's identity into the saved account.
export async function renewVenueSessionFromBrowser({ expectedUserId, port = process.platform === 'win32' ? 9335 : 9334,
  signal, deadline, timeoutMs,
  connect = (url, options) => chromium.connectOverCDP(url, options) } = {}) {
  if (![9334, 9335, 9336, 9337, 9338].includes(port)) throw new SessionExpiredError('浏览器连接信息无效，请重新登录学校账号');
  let browser, isolated;
  const controller = new AbortController();
  const expiresAt = Math.min(Number.isFinite(deadline) ? deadline : Infinity, Date.now() + (timeoutMs ?? 15000));
  const stop = () => controller.abort(new RequestNotSentError('登录恢复已停止或超过准备截止时间，未发送预约'));
  if (signal?.aborted || Date.now() >= expiresAt) stop();
  signal?.addEventListener('abort', stop, { once: true });
  const timer = setTimeout(stop, Math.max(1, expiresAt - Date.now()));
  const check = () => controller.signal.throwIfAborted();
  const bounded = async (operation) => {
    check();
    let abort;
    const canceled = new Promise((_resolve, reject) => {
      abort = () => reject(controller.signal.reason);
      controller.signal.addEventListener('abort', abort, { once: true });
    });
    try { return await Promise.race([Promise.resolve().then(operation), canceled]); }
    finally { controller.signal.removeEventListener('abort', abort); }
  };
  try {
    browser = await bounded(() => {
      const connection = connect(`http://127.0.0.1:${port}`, { timeout: Math.max(1, Math.min(3000, expiresAt - Date.now())) });
      Promise.resolve(connection).then((late) => { if (controller.signal.aborted) void late.close().catch(() => {}); }, () => {});
      return connection;
    });
    const source = browser.contexts()[0];
    const castgc = (await bounded(() => source.cookies('https://authserver.szu.edu.cn/authserver/login')))
      .find((cookie) => cookie.name === 'CASTGC' && cookie.domain === 'authserver.szu.edu.cn');
    if (!castgc) throw new SessionExpiredError('浏览器的统一认证会话不可用，请重新登录学校账号');
    const sourcePage = source.pages()[0];
    if (!sourcePage) throw new SessionExpiredError('专用浏览器没有打开的页面，请重新打开助手');
    const userAgent = await bounded(() => sourcePage.evaluate(() => navigator.userAgent));
    isolated = await bounded(() => browser.newContext({ userAgent }));
    await bounded(() => isolated.addCookies([castgc]));
    const page = await bounded(() => isolated.newPage());
    await bounded(() => page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: Math.max(1, expiresAt - Date.now()) }));
    if (!page.url().startsWith(BASE_URL)) throw new SessionExpiredError('统一认证已过期，请重新登录学校账号');
    const cookieUrl = new URL('modules/sportVenue/getOpeningRoom.do', BASE_URL).href;
    const cookies = (await bounded(() => isolated.cookies(cookieUrl))).filter((cookie) =>
      cookie.domain === 'ehall.szu.edu.cn' || cookie.domain === '.ehall.szu.edu.cn');
    let session;
    try { session = parseSessionText(JSON.stringify({ userAgent, cookies })); }
    catch { throw new SessionExpiredError('统一认证未能生成完整的场馆登录状态，请重新登录学校账号'); }
    session.source = 'browser-sso-renew';
    session.browserCdpPort = port;
    const client = new CoreHttpClient(session);
    const api = new SzuVenueApi(client);
    const requestOptions = { signal: controller.signal, deadline: expiresAt };
    const identity = await api.getIdentity(requestOptions);
    if (expectedUserId && identity.id !== expectedUserId) {
      throw new SessionExpiredError('浏览器统一认证的是另一个学校账号，原账号登录状态未改动');
    }
    await api.getAvailableDates(requestOptions);
    check();
    return { session: client.session, identity };
  } catch (error) {
    if (error instanceof SessionExpiredError || error.code === 'REQUEST_NOT_SENT') throw error;
    throw new SessionExpiredError('自动恢复场馆登录失败，请在账号管理中重新登录', { cause: error });
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', stop);
    const canceled = controller.signal.aborted;
    controller.abort();
    const cleanup = Promise.allSettled([isolated?.close(), browser?.close()]);
    if (canceled) void cleanup;
    else await cleanup;
  }
}
