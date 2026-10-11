import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { classify, probe, advance, check, fingerprint, readJson } from '../scripts/cookie-watch.mjs';

const session = { userAgent: 'test', cookies: [{ name: '_WEU', value: 'secret-test-only', domain: 'ehall.szu.edu.cn', path: '/qljfwapp/', expires: -1 }] };
const expected = { name: 'Test', id: 'A' };
const identity = `USERID='A';USER_INFO={"userName":"Test"};APP_TITLE='Venue';`;
const login = 'https://authserver.szu.edu.cn/authserver/login?service=test';

test('Cookie 观察不把网关 403、500 或陌生 HTML 当作过期；识别官方 loginURL', () => {
  for (const status of [403, 500, 502]) assert.equal(classify(status, new Headers(), '', 'identity', expected).status, 'unknown');
  assert.equal(classify(200, new Headers(), '<html>Maintenance</html>', 'identity', expected).status, 'unknown');
  assert.equal(classify(200, new Headers(), JSON.stringify({ loginURL: login }), 'dates', expected).status, 'auth_rejected');
  assert.equal(classify(302, new Headers({ location: login }), '', 'identity', expected).status, 'auth_rejected');
  assert.equal(classify(302, new Headers({ location: 'https://other.example/' }), '', 'identity', expected).status, 'unknown');
  assert.equal(classify(200, new Headers(), identity, 'identity', { name: 'Other' }).status, 'identity_mismatch');
});

test('Cookie 观察跨午夜给出失效区间，连续两次确认；断网和长时间休眠打断确认', () => {
  let s = advance({}, { status: 'valid' }, '2026-09-20T15:55:00Z');
  s = advance(s, { status: 'auth_rejected' }, '2026-09-20T16:00:00Z');
  assert.equal(s.status, 'suspected_expired');
  const done = advance(s, { status: 'auth_rejected' }, '2026-09-20T16:05:00Z');
  assert.equal(done.status, 'expired');
  assert.deepEqual(done.expiryWindow, { after: '2026-09-20T15:55:00Z', by: '2026-09-20T16:00:00Z' });
  assert.equal(advance(s, { status: 'auth_rejected' }, '2026-09-21T01:00:00Z').status, 'suspected_expired');
  s = advance(s, { status: 'unknown' }, '2026-09-20T16:05:00Z');
  assert.equal(advance(s, { status: 'auth_rejected' }, '2026-09-20T16:10:00Z').status, 'suspected_expired');
});

test('真实 HTTP：探针只读身份与日期，不使用 Set-Cookie，不跟随登录跳转', async (t) => {
  let reject = false;
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ path: req.url, cookie: req.headers.cookie, method: req.method });
    if (reject) { res.writeHead(302, { location: login }); res.end(); return; }
    res.setHeader('set-cookie', '_WEU=rotated; Path=/qljfwapp/');
    res.end(req.url.endsWith('/index.do') ? identity : '[]');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const transport = (url, options) => fetch(new URL(new URL(url).pathname, `http://127.0.0.1:${server.address().port}`), options);
  assert.equal((await probe(session, expected, { transport })).status, 'valid');
  assert.deepEqual(requests.map((r) => r.method), ['GET', 'POST']);
  assert.ok(requests[1].path.endsWith('/sportVenue/getRqList.do'));
  assert.ok(requests.every((r) => r.cookie === '_WEU=secret-test-only'));
  reject = true;
  assert.equal((await probe(session, expected, { transport })).status, 'auth_rejected');
  assert.equal(requests.length, 3);
});

test('定时单次执行保留快照、标记源文件变更、不泄露 Cookie；失效后停止访问', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'szu-cookie-watch-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const sourcePath = join(dir, 'source.json'), snapshotPath = join(dir, 'snapshot.json'), configPath = join(dir, 'config.json');
  const put = (p, v) => writeFile(p, JSON.stringify(v));
  await put(sourcePath, session); await put(snapshotPath, session);
  await put(join(dir, 'status.json'), { status: 'scheduled' });
  await put(configPath, { outputDir: dir, sourcePath, snapshotPath, expected, snapshotHash: fingerprint(session), endsAt: '2030-01-01T00:00:00Z' });
  let expired = false, calls = 0;
  const transport = async (url) => {
    calls++;
    return expired ? new Response('', { status: 302, headers: { location: login } }) : new Response(url.endsWith('index.do') ? identity : '[]');
  };
  const run = (minute) => check(configPath, { transport, now: Date.parse(`2026-09-20T16:${minute}:00Z`) });
  await run('00');
  await put(sourcePath, { ...session, cookies: [] }); expired = true;
  await run('05'); const result = await run('10');
  assert.equal(result.status, 'expired'); assert.equal(result.sourceChangedAt, '2026-09-20T16:05:00.000Z');
  await run('15'); assert.equal(calls, 4);
  assert.equal((await readJson(sourcePath)).cookies.length, 0);
  assert.equal(fingerprint(await readJson(snapshotPath)), fingerprint(session));
  for (const name of ['events.jsonl', 'status.json']) assert.ok(!(await readFile(join(dir, name), 'utf8')).includes('secret-test-only'));
  const events = (await readFile(join(dir, 'events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(events[1].gapMs, 300000);
});

test('已到期、停止标记均不触发网络；首次即失效不会伪造最后有效时间', async (t) => {
  let s = advance({}, { status: 'auth_rejected' }, '2026-09-20T16:00:00Z');
  s = advance(s, { status: 'auth_rejected' }, '2026-09-20T16:05:00Z');
  assert.equal(s.status, 'initially_expired'); assert.equal(s.expiryWindow.after, null);
  const dir = await mkdtemp(join(tmpdir(), 'szu-cookie-stop-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const configPath = join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify({ outputDir: dir, endsAt: '2020-01-01T00:00:00Z' }));
  await writeFile(join(dir, 'status.json'), '{"status":"scheduled"}');
  assert.equal((await check(configPath, { transport: () => assert.fail('不得访问网络') })).status, 'finished');
  await writeFile(join(dir, 'status.json'), '{"status":"scheduled"}'); await writeFile(join(dir, 'STOP'), 'stop');
  assert.equal((await check(configPath, { transport: () => assert.fail('不得访问网络') })).status, 'stopped');
});
