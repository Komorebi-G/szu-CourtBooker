import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { importSessionFromCurl, loadSession, saveSession } from '../desktop/src/session.js';
import { HttpClient } from '../desktop/src/http-client.js';

async function withSessionPath(run) {
  const directory = await mkdtemp(join(tmpdir(), 'court-booker-session-'));
  const path = join(directory, '.session.json');
  try {
    return await run(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('从 Chromium 风格 cURL 导入 Cookie', async () => withSessionPath(async (path) => {
  await importSessionFromCurl(`curl 'https://ehall.szu.edu.cn/qljfwapp/sys/lwSzuCgyy/modules/sportVenue/getOpeningRoom.do' \\
    -H 'cookie: MOD_AUTH_CAS=auth-value; _WEU=weu-value; route=route-value' \\
    -H 'user-agent: Mozilla/5.0 Chromium Test'`, path);
  const session = await loadSession(path);
  assert.equal(session.userAgent, 'Mozilla/5.0 Chromium Test');
  assert.deepEqual(session.cookies.map((cookie) => cookie.name), ['MOD_AUTH_CAS', '_WEU', 'route']);
  assert.equal(session.cookies.find((cookie) => cookie.name === '_WEU').path, '/qljfwapp/');
}));

test('从 Firefox 风格 --cookie 导入 Cookie', async () => withSessionPath(async (path) => {
  await importSessionFromCurl(`curl 'https://ehall.szu.edu.cn/' \\
    --cookie 'MOD_AUTH_CAS=auth-value; _WEU=weu-value' \\
    --user-agent 'Mozilla/5.0 Firefox Test'`, path);
  const session = await loadSession(path);
  assert.equal(session.userAgent, 'Mozilla/5.0 Firefox Test');
  assert.equal(session.cookies.length, 2);
}));

test('并发刷新登录态时仍原子写入有效文件', async () => {
  await withSessionPath(async (path) => {
    const base = { version: 1, userAgent: 'test', cookies: [] };
    await Promise.all([
      saveSession({ ...base, savedAt: 'first' }, path),
      saveSession({ ...base, savedAt: 'second' }, path),
      saveSession({ ...base, savedAt: 'third' }, path),
    ]);
    assert.equal(JSON.parse(await readFile(path, 'utf8')).savedAt, 'third');
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  });
});

test('关键预约抢先于排队后台读取，并取消已在途的只读后台查询', async () => withSessionPath(async (path) => {
  await saveSession({ userAgent: 'test', cookies: [] }, path);
  let backgroundEntered, criticalEntered;
  const waiting = new Promise((resolve) => backgroundEntered = resolve), dispatched = new Promise((resolve) => criticalEntered = resolve);
  const calls = [];
  const transport = async (url, options) => {
    const name = url.pathname.split('/').at(-1); calls.push(name);
    if (name === 'slow.do') {
      backgroundEntered(); await new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
    }
    if (name === 'book.do') criticalEntered();
    return new Response(JSON.stringify({ code: '0' }), { headers: { 'content-type': 'application/json' } });
  };
  const background = await HttpClient.create({ sessionPath: path, priority: 'background', transport });
  const critical = await HttpClient.create({ sessionPath: path, priority: 'critical', transport });
  const slow = background.post('slow.do', {}, { abortInFlight: true }).catch((error) => error);
  await waiting;
  const queued = background.post('later.do', {}, { abortInFlight: true });
  const booking = critical.post('book.do', {});
  await dispatched; await Promise.all([slow, queued, booking]);
  assert.deepEqual(calls, ['slow.do', 'book.do', 'later.do']);
}));

test('关键请求不得中断已发出的后台标记预约，排队取消不会发送', async () => withSessionPath(async (path) => {
  await saveSession({ userAgent: 'test', cookies: [] }, path);
  let release, entered;
  const response = new Promise((resolve) => release = resolve), waiting = new Promise((resolve) => entered = resolve), calls = [];
  const transport = async (url, options) => {
    calls.push(url.pathname.split('/').at(-1));
    if (calls.length === 1) { entered(); await response; assert.equal(options.signal.aborted, false); }
    return new Response(JSON.stringify({ code: '0' }), { headers: { 'content-type': 'application/json' } });
  };
  const first = await HttpClient.create({ sessionPath: path, priority: 'background', transport });
  const next = await HttpClient.create({ sessionPath: path, priority: 'critical', transport });
  const booked = first.post('first-book.do', {}); await waiting;
  const controller = new AbortController();
  const canceled = next.post('cancel.do', {}, { signal: controller.signal });
  const rejected = assert.rejects(canceled, { code: 'REQUEST_NOT_SENT' });
  controller.abort(); release();
  await Promise.all([booked, rejected]); assert.deepEqual(calls, ['first-book.do']);
}));
