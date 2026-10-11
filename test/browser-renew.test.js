import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HttpClient } from '../desktop/src/http-client.js';
import { loadSession, parseSessionText, saveSession } from '../desktop/src/session.js';
import { SessionExpiredError } from '../shared/errors.js';
import { renewVenueSessionFromBrowser } from '../desktop/src/browser-renew.js';

test('只读身份检查可自动恢复场馆会话，预约 POST 不自动重放', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'szu-browser-renew-'));
  const path = join(dir, 'session.json');
  await saveSession({ ...parseSessionText('MOD_AUTH_CAS=old; _WEU=old'), browserCdpPort: 9336 }, path);
  let renewals = 0; const calls = [];
  const client = await HttpClient.create({ sessionPath: path, expectedUserId: 'A',
    renewSession: async (_userId, port) => { assert.equal(port, 9336); renewals++; return {
      identity: { id: 'A', name: '用户A' }, session: parseSessionText('MOD_AUTH_CAS=new; _WEU=new'),
    }; },
    transport: async (url, options) => {
      calls.push({ path: url.pathname, cookie: options.headers.cookie });
      const expired = options.headers.cookie.includes('MOD_AUTH_CAS=old') || url.pathname.includes('insertVenueBookingInfo');
      return { status: expired ? 302 : 200, ok: !expired,
        headers: { get: () => 'text/html', getSetCookie: () => [] }, text: async () => 'identity page' };
    },
  });
  assert.equal((await client.get('index.do', { expect: 'text' })).data, 'identity page');
  assert.equal(renewals, 1); assert.equal(calls.length, 2);
  assert.match(calls[1].cookie, /MOD_AUTH_CAS=new/);
  assert.equal((await loadSession(path)).cookies[0].value, 'new');
  await assert.rejects(client.post('sportVenue/insertVenueBookingInfo.do', {}), SessionExpiredError);
  assert.equal(renewals, 1); assert.equal(calls.length, 3);
});
test('执行中自动恢复遇到另一个账号时不替换会话', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'szu-browser-wrong-user-'));
  const path = join(dir, 'session.json');
  await saveSession(parseSessionText('MOD_AUTH_CAS=old; _WEU=old'), path);
  const client = await HttpClient.create({ sessionPath: path, expectedUserId: 'A',
    renewSession: async () => ({ identity: { id: 'B', name: '用户B' },
      session: parseSessionText('MOD_AUTH_CAS=B; _WEU=B') }),
    transport: async () => ({ status: 302, ok: false,
      headers: { get: () => null, getSetCookie: () => [] }, text: async () => '' }),
  });
  await assert.rejects(client.get('index.do', { expect: 'text' }), /另一个学校账号/);
  assert.equal((await loadSession(path)).cookies[0].value, 'old');
});

test('自动续登遵守准备截止时间，慢回调不得事后覆盖登录', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'szu-browser-renew-deadline-')), path = join(dir, 'session.json');
  await saveSession(parseSessionText('MOD_AUTH_CAS=old; _WEU=old'), path);
  let released, observed;
  const late = new Promise((resolve) => released = resolve);
  const client = await HttpClient.create({ sessionPath: path, expectedUserId: 'A',
    renewSession: async (_id, _port, options) => { observed = options; await late;
      return { identity: { id: 'A' }, session: parseSessionText('MOD_AUTH_CAS=new; _WEU=new') }; },
    transport: async () => ({ status: 302, ok: false, headers: { get: () => null, getSetCookie: () => [] }, text: async () => '' }),
  });
  const deadline = Date.now() + 200;
  await assert.rejects(client.get('index.do', { expect: 'text', deadlineMs: deadline }), { code: 'REQUEST_NOT_SENT' });
  assert.equal(observed.deadline, deadline); assert.equal(observed.signal.aborted, true);
  released(); await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal((await loadSession(path)).cookies[0].value, 'old');
});

test('浏览器续登连接未完成时也可取消，迟到连接会自行释放', async () => {
  const controller = new AbortController(); let resolveConnection, connected, closed = false;
  const called = new Promise((resolve) => connected = resolve);
  const work = renewVenueSessionFromBrowser({ port: 9334, signal: controller.signal,
    connect: async () => { connected(); return new Promise((resolve) => resolveConnection = resolve); } });
  await called; controller.abort();
  await assert.rejects(work, { code: 'REQUEST_NOT_SENT' });
  resolveConnection({ async close() { closed = true; } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, true);
});

test('后台浏览器续登让位于关键预约，迟到恢复不能覆盖新响应的 Cookie', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'szu-browser-renew-priority-')), path = join(dir, 'session.json');
  await saveSession(parseSessionText('MOD_AUTH_CAS=old; _WEU=old'), path);
  let release, entered;
  const response = new Promise((resolve) => release = resolve), waiting = new Promise((resolve) => entered = resolve);
  const transport = async (url) => {
    if (url.pathname.endsWith('index.do')) return new Response('', { status: 302 });
    return new Response(JSON.stringify({ code: '0' }), { headers: { 'content-type': 'application/json',
      'set-cookie': '_WEU=from-booking; Path=/qljfwapp/' } });
  };
  const background = await HttpClient.create({ sessionPath: path, priority: 'background', transport, expectedUserId: 'A',
    renewSession: async () => { entered(); await response;
      return { identity: { id: 'A' }, session: parseSessionText('MOD_AUTH_CAS=browser; _WEU=browser') }; } });
  const checking = background.get('index.do', { expect: 'text', abortInFlight: true });
  const canceled = assert.rejects(checking, { code: 'REQUEST_NOT_SENT' });
  await waiting;
  const critical = await HttpClient.create({ sessionPath: path, priority: 'critical', transport });
  await critical.post('sportVenue/insertVenueBookingInfo.do', {}); await canceled;
  release(); await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await loadSession(path)).cookies.find((cookie) => cookie.name === '_WEU').value, 'from-booking');
});
