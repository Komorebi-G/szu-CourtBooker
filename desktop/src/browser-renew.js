import { chromium } from 'playwright-core';
import { APP_URL, BASE_URL } from '../../shared/constants.js';
import { CoreHttpClient } from '../../shared/http-client-core.js';
import { SzuVenueApi } from '../../shared/api.js';
import { SessionExpiredError } from '../../shared/errors.js';
import { parseSessionText } from '../../shared/session-format.js';

// Use the browser's CAS session to obtain fresh venue cookies in an isolated
// context. Never import another user's identity into the saved account.
export async function renewVenueSessionFromBrowser({ expectedUserId, port = process.platform === 'win32' ? 9335 : 9334,
  connect = (url) => chromium.connectOverCDP(url, { timeout: 3000 }) } = {}) {
  let browser, isolated;
  try {
    browser = await connect(`http://127.0.0.1:${port}`);
    const source = browser.contexts()[0];
    const castgc = (await source.cookies('https://authserver.szu.edu.cn/authserver/login'))
      .find((cookie) => cookie.name === 'CASTGC' && cookie.domain === 'authserver.szu.edu.cn');
    if (!castgc) throw new SessionExpiredError('浏览器的统一认证会话不可用，请重新登录学校账号');
    const sourcePage = source.pages()[0];
    if (!sourcePage) throw new SessionExpiredError('专用浏览器没有打开的页面，请重新打开助手');
    const userAgent = await sourcePage.evaluate(() => navigator.userAgent);
    isolated = await browser.newContext({ userAgent });
    await isolated.addCookies([castgc]);
    const page = await isolated.newPage();
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });
    if (!page.url().startsWith(BASE_URL)) throw new SessionExpiredError('统一认证已过期，请重新登录学校账号');
    const cookieUrl = new URL('modules/sportVenue/getOpeningRoom.do', BASE_URL).href;
    const cookies = (await isolated.cookies(cookieUrl)).filter((cookie) =>
      cookie.domain === 'ehall.szu.edu.cn' || cookie.domain === '.ehall.szu.edu.cn');
    let session;
    try { session = parseSessionText(JSON.stringify({ userAgent, cookies })); }
    catch { throw new SessionExpiredError('统一认证未能生成完整的场馆登录状态，请重新登录学校账号'); }
    session.source = 'browser-sso-renew';
    const client = new CoreHttpClient(session);
    const api = new SzuVenueApi(client);
    const identity = await api.getIdentity();
    if (expectedUserId && identity.id !== expectedUserId) {
      throw new SessionExpiredError('浏览器统一认证的是另一个学校账号，原账号登录状态未改动');
    }
    await api.getAvailableDates();
    return { session: client.session, identity };
  } catch (error) {
    if (error instanceof SessionExpiredError) throw error;
    throw new SessionExpiredError('自动恢复场馆登录失败，请在账号管理中重新登录', { cause: error });
  } finally {
    await isolated?.close().catch(() => {});
    await browser?.close().catch(() => {});
  }
}
