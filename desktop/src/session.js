import { chmod, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { APP_URL, BASE_URL, DEFAULT_SESSION_FILE } from '../../shared/constants.js';
import { parseSessionText } from '../../shared/session-format.js';

const saveQueues = new Map();

async function writeSession(session, absolute) {
  const temporary = `${absolute}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 });
    await chmod(temporary, 0o600);
    try {
      await rename(temporary, absolute);
    } catch (error) {
      if (!['EEXIST', 'EPERM'].includes(error.code)) throw error;
      await rm(absolute, { force: true });
      await rename(temporary, absolute);
    }
    await chmod(absolute, 0o600);
  } finally {
    await rm(temporary, { force: true });
  }
}

function sessionTransaction(path, operation) {
  const absolute = resolve(path);
  const previous = saveQueues.get(absolute) ?? Promise.resolve();
  const pending = previous.catch(() => {}).then(() => operation(absolute));
  saveQueues.set(absolute, pending);
  return pending.finally(() => {
    if (saveQueues.get(absolute) === pending) saveQueues.delete(absolute);
  });
}

export function saveSession(session, path = DEFAULT_SESSION_FILE) {
  const snapshot = structuredClone(session);
  return sessionTransaction(path, (absolute) => writeSession(snapshot, absolute));
}

// Requests and imports share one per-file queue. A response's refreshed cookies
// must be durable before another client reads and sends this account's session.
export function withSession(path, operation) {
  return sessionTransaction(path, async (absolute) => operation(await loadSession(absolute),
    (session) => writeSession(session, absolute)));
}

export async function loadSession(path = DEFAULT_SESSION_FILE) {
  let source;
  try {
    source = await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`缺少 ${path}；请在账号管理中登录或导入登录状态`);
    }
    throw error;
  }
  const session = JSON.parse(source);
  if (!Array.isArray(session.cookies) || !session.userAgent) {
    throw new Error(`${path} 格式无效，请重新导入登录态`);
  }
  return session;
}

export async function importSessionFromCdp(path = DEFAULT_SESSION_FILE) {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${process.platform === 'win32' ? 9335 : 9334}`);
  try {
    const context = browser.contexts()[0];
    if (!context) throw new Error('浏览器中没有可用的上下文');
    const pages = context.pages();
    const page = pages.find((item) => item.url().startsWith(BASE_URL))
      ?? pages.find((item) => item.url().includes('ehall.szu.edu.cn'));
    if (!page) {
      throw new Error(`浏览器中没有场馆预约页面，请先访问 ${APP_URL} 并完成登录`);
    }
    if (!page.url().startsWith(BASE_URL)) {
      throw new Error('当前仍在统一身份认证页，请完成登录后再导入');
    }

    const cookieUrl = new URL('modules/sportVenue/getOpeningRoom.do', BASE_URL).href;
    const cookies = (await context.cookies(cookieUrl)).filter(
      (cookie) => cookie.domain === 'ehall.szu.edu.cn' || cookie.domain === '.ehall.szu.edu.cn',
    );
    const required = ['MOD_AUTH_CAS', '_WEU'];
    const names = new Set(cookies.map((cookie) => cookie.name));
    const missing = required.filter((name) => !names.has(name));
    if (missing.length) throw new Error(`登录 Cookie 不完整：缺少 ${missing.join(', ')}`);

    const session = {
      version: 1,
      savedAt: new Date().toISOString(),
      source: 'browser-cdp',
      userAgent: await page.evaluate(() => navigator.userAgent),
      cookies,
    };
    await saveSession(session, path);
    return { path: resolve(path), cookieNames: cookies.map((cookie) => cookie.name) };
  } finally {
    await browser.close();
  }
}

// 保留旧名称，避免已有脚本失效。
export const importSessionFromEdge = importSessionFromCdp;

export { parseSessionText, sessionFromCurl } from '../../shared/session-format.js';

export async function importSessionFromCurl(curlText, path = DEFAULT_SESSION_FILE) {
  const session = parseSessionText(curlText);
  await saveSession(session, path);
  return { path: resolve(path), cookieNames: session.cookies.map((cookie) => cookie.name) };
}
