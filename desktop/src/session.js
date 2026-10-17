import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { APP_URL, BASE_URL, DEFAULT_SESSION_FILE } from '../../shared/constants.js';
import { browserCdpPort } from '../../shared/browser-port.js';
import { parseSessionText } from '../../shared/session-format.js';
import { RequestNotSentError } from '../../shared/errors.js';
import { atomicWrite } from './atomic-file.js';

const saveQueues = new Map();

async function writeSession(session, absolute) {
  await atomicWrite(absolute, `${JSON.stringify(session, null, 2)}\n`);
}

function sessionTransaction(path, operation, { priority = 'normal', signal, cancellable = false } = {}) {
  if (signal?.aborted) return Promise.reject(new RequestNotSentError('本次操作已停止，未发送请求'));
  const absolute = resolve(path);
  let queue = saveQueues.get(absolute);
  if (!queue) { queue = { waiting: [], active: null }; saveQueues.set(absolute, queue); }
  return new Promise((resolveWork, rejectWork) => {
    const controller = new AbortController();
    const entry = { operation, priority, cancellable, controller, resolveWork, rejectWork };
    const abort = () => {
      controller.abort(signal?.reason);
      const index = queue.waiting.indexOf(entry);
      if (index >= 0) {
        queue.waiting.splice(index, 1);
        signal?.removeEventListener('abort', abort);
        rejectWork(new RequestNotSentError('本次操作已停止，未发送请求'));
      }
    };
    entry.cleanup = () => signal?.removeEventListener('abort', abort);
    if (signal?.aborted) { rejectWork(new RequestNotSentError('本次操作已停止，未发送请求')); return; }
    signal?.addEventListener('abort', abort, { once: true });
    queue.waiting.push(entry);
    // A directory/verification read may yield, but a sent booking or an atomic
    // cookie write must always finish before the next transaction starts.
    if (priority === 'critical' && queue.active?.priority === 'background' && queue.active.cancellable) {
      queue.active.controller.abort(new DOMException('预约执行优先，已取消后台查询', 'AbortError'));
    }
    const pump = () => {
      if (queue.active) return;
      if (!queue.waiting.length) { if (saveQueues.get(absolute) === queue) saveQueues.delete(absolute); return; }
      const critical = queue.waiting.findIndex((item) => item.priority === 'critical');
      const next = queue.waiting.splice(critical >= 0 ? critical : 0, 1)[0];
      queue.active = next;
      Promise.resolve().then(() => next.operation(absolute, next.controller.signal)).then(next.resolveWork, next.rejectWork)
        .finally(() => { next.cleanup(); queue.active = null; pump(); });
    };
    pump();
  });
}

export function saveSession(session, path = DEFAULT_SESSION_FILE) {
  const snapshot = structuredClone(session);
  return sessionTransaction(path, (absolute) => writeSession(snapshot, absolute));
}

// Requests and imports share one per-file queue. A response's refreshed cookies
// must be durable before another client reads and sends this account's session.
export function withSession(path, operation, options) {
  return sessionTransaction(path, async (absolute, signal) => operation(await loadSession(absolute),
    (session) => writeSession(session, absolute), signal), options);
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

export async function importSessionFromCdp(path = DEFAULT_SESSION_FILE, port = browserCdpPort()) {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
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
      browserCdpPort: port,
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
