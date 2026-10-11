// Standalone Node script for Windows Task Scheduler. No app imports or writes.
import { readFile, writeFile, rename, appendFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';

const BASE = 'https://ehall.szu.edu.cn/qljfwapp/sys/lwSzuCgyy/';
const TERMINAL = ['expired', 'initially_expired', 'identity_mismatch', 'finished', 'stopped'];
export const fingerprint = (session) => createHash('sha256').update(JSON.stringify({
  userAgent: session.userAgent,
  cookies: [...session.cookies].sort((a, b) => `${a.name}|${a.domain}|${a.path}`.localeCompare(`${b.name}|${b.domain}|${b.path}`)),
})).digest('hex');
export const readJson = async (path) => JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
async function writeJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, path);
}

function cookieHeader(session, url, now) {
  const u = new URL(url);
  return session.cookies.filter((cookie) => {
    const domain = cookie.domain.replace(/^\./, '');
    const path = cookie.path || '/';
    return (u.hostname === domain || (cookie.domain.startsWith('.') && u.hostname.endsWith('.' + domain)))
      && (u.pathname === path || u.pathname.startsWith(path.endsWith('/') ? path : path + '/'))
      && (!cookie.secure || u.protocol === 'https:')
      && (cookie.expires == null || cookie.expires < 0 || cookie.expires > now / 1000);
  }).sort((a, b) => (b.path || '/').length - (a.path || '/').length)
    .map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
}

function loginUrl(value) {
  try {
    const u = new URL(value, BASE);
    return u.hostname === 'authserver.szu.edu.cn' && u.pathname.includes('/authserver/login');
  } catch { return false; }
}

export function classify(status, headers, text, kind, expected) {
  if (status === 401) return { status: 'auth_rejected', reason: 'http_401' };
  if ([301, 302, 303, 307, 308].includes(status)) {
    return loginUrl(headers.get('location')) ? { status: 'auth_rejected', reason: 'login_redirect' }
      : { status: 'unknown', reason: 'unexpected_redirect' };
  }
  // A 403 may be a gateway/access policy issue, not an expired session.
  if (status !== 200) return { status: 'unknown', reason: `http_${status}` };
  if (/<input\b[^>]*type\s*=\s*["']password["']/i.test(text) && /authserver|casLoginForm|统一身份认证/.test(text)) {
    return { status: 'auth_rejected', reason: 'login_page' };
  }
  let data;
  try { data = JSON.parse(text); } catch {}
  // The school's loaded BH_UTILS code treats loginURL as an authentication redirect.
  if (data && typeof data.loginURL === 'string' && loginUrl(data.loginURL)) {
    return { status: 'auth_rejected', reason: 'json_login_url' };
  }
  if (kind === 'identity') {
    const id = /\bUSERID\s*=\s*['"]([^'"]+)['"]/.exec(text)?.[1];
    const info = /\bUSER_INFO\s*=\s*(\{.*?\})\s*;\s*APP_TITLE\s*=/s.exec(text)?.[1];
    let name;
    try { name = JSON.parse(info).userName; } catch {}
    if (!id || !name) return { status: 'unknown', reason: 'unrecognized_identity_page' };
    if (name !== expected.name || (expected.id && id !== expected.id)) return { status: 'identity_mismatch', reason: 'different_account' };
    return { status: 'valid', reason: 'identity_matches' };
  }
  // This read-only date endpoint is not an order/booking endpoint.
  if (!Array.isArray(data)) return { status: 'unknown', reason: 'unrecognized_date_response' };
  return { status: 'valid', reason: 'identity_and_dates_valid' };
}

export async function probe(session, expected, { transport = fetch, now = Date.now() } = {}) {
  let cookieUpdatesOffered = false;
  for (const [path, method, kind] of [['index.do', 'GET', 'identity'], ['sportVenue/getRqList.do', 'POST', 'dates']]) {
    const url = BASE + path;
    let response, text;
    try {
      response = await transport(url, { method, redirect: 'manual', signal: AbortSignal.timeout(15000),
        headers: { cookie: cookieHeader(session, url, now), 'user-agent': session.userAgent,
          'x-requested-with': 'XMLHttpRequest', referer: BASE + 'index.do', origin: new URL(BASE).origin,
          'cache-control': 'no-cache', ...(method === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
        ...(method === 'POST' ? { body: '' } : {}) });
      cookieUpdatesOffered ||= response.headers.has('set-cookie');
      text = await response.text();
    } catch { return { status: 'unknown', reason: 'network_or_timeout', cookieUpdatesOffered }; }
    const result = classify(response.status, response.headers, text, kind, expected);
    if (result.status !== 'valid') return { ...result, cookieUpdatesOffered };
  }
  return { status: 'valid', reason: 'identity_and_dates_valid', cookieUpdatesOffered };
}

export function advance(prior, result, at) {
  const state = { ...prior, checks: (prior.checks || 0) + 1, lastCheckAt: at, lastResult: result,
    rejectionCount: 0, firstRejectionAt: null };
  if (result.status === 'valid') {
    state.status = 'valid'; state.firstValidAt ||= at; state.lastValidAt = at;
  } else if (result.status === 'auth_rejected') {
    const consecutive = prior.lastResult?.status === 'auth_rejected'
      && Date.parse(at) - Date.parse(prior.lastCheckAt) <= 30 * 60_000;
    state.rejectionCount = consecutive ? prior.rejectionCount + 1 : 1;
    state.firstRejectionAt = consecutive ? prior.firstRejectionAt : at;
    state.status = state.rejectionCount >= 2 ? (state.lastValidAt ? 'expired' : 'initially_expired') : 'suspected_expired';
    if (state.rejectionCount >= 2) {
      state.confirmedAt = at;
      state.expiryWindow = { after: state.lastValidAt || null, by: state.firstRejectionAt };
    }
  } else state.status = result.status;
  return state;
}

export async function check(configPath, { transport = fetch, now = Date.now() } = {}) {
  const config = await readJson(configPath);
  const statusPath = join(config.outputDir, 'status.json');
  let state = await readJson(statusPath);
  if (TERMINAL.includes(state.status)) return state;
  if (await readFile(join(config.outputDir, 'STOP')).then(() => true, () => false)) {
    state.status = 'stopped'; await writeJson(statusPath, state); return state;
  }
  if (now >= Date.parse(config.endsAt)) {
    state.status = 'finished'; await writeJson(statusPath, state); return state;
  }
  // Each invocation reads the same frozen file; it never reloads live credentials
  // into the experiment or applies Set-Cookie. Originals are never written.
  const snapshot = await readJson(config.snapshotPath);
  if (fingerprint(snapshot) !== config.snapshotHash) throw new Error('实验快照已变更，请重新创建实验');
  try {
    if (fingerprint(await readJson(config.sourcePath)) !== config.snapshotHash) state.sourceChangedAt ||= new Date(now).toISOString();
  } catch { state.sourceUnavailableAt ||= new Date(now).toISOString(); }
  const result = await probe(snapshot, config.expected, { transport, now });
  const at = new Date(now).toISOString();
  const gapMs = state.lastCheckAt ? now - Date.parse(state.lastCheckAt) : undefined;
  state = advance(state, result, at);
  await appendFile(join(config.outputDir, 'events.jsonl'), JSON.stringify({ at, ...result,
    sourceChanged: Boolean(state.sourceChangedAt), gapMs }) + '\n', { mode: 0o600 });
  await writeJson(statusPath, state);
  return state;
}

export function report(state) {
  const labels = { scheduled: '已安排，尚未检查', valid: '最近一次检查有效', unknown: '无法判定（网络或响应异常）',
    suspected_expired: '疑似失效，等待下一次确认', expired: '已确认失效', initially_expired: '首次观测时已失效，无法确定起点',
    identity_mismatch: '账号不匹配，已停止', finished: '观察窗口已结束', stopped: '已停止' };
  const time = (value) => value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '尚无';
  return `${labels[state.status] || state.status}\n检查次数：${state.checks || 0}\n最后检查：${time(state.lastCheckAt)}\n最后有效：${time(state.lastValidAt)}\n首次明确拒绝：${time(state.firstRejectionAt)}\n确认失效：${time(state.confirmedAt)}\n原登录文件变更：${time(state.sourceChangedAt)}\n以上均为北京时间；超过计划间隔未更新时，旧结果不能代表当前有效。`;
}

async function main() {
  const { values } = parseArgs({ options: { config: { type: 'string' }, report: { type: 'boolean' }, stop: { type: 'boolean' } } });
  if (!values.config) throw new Error('用法：node cookie-watch.mjs --config <config.json> [--report|--stop]');
  const config = await readJson(values.config);
  if (values.stop) await writeFile(join(config.outputDir, 'STOP'), new Date().toISOString(), { mode: 0o600 });
  const state = values.report || values.stop ? await readJson(join(config.outputDir, 'status.json')) : await check(values.config);
  console.log(values.stop ? '已写入停止标记，后续定时触发不会访问学校。' : report(state));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error('Cookie 监测执行失败，请检查任务配置与本地文件；未输出登录数据。'); process.exitCode = 1; });
}
