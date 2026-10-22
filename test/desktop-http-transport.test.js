import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpClient } from '../desktop/src/http-client.js';
import { loadSession, saveSession } from '../desktop/src/session.js';

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
async function localClient(t, respond) {
  const dir = await mkdtemp(join(tmpdir(), 'szu-desktop-transport-'));
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const request = { path: new URL(req.url, 'http://localhost').pathname, body,
      headers: req.headers, socket: req.socket };
    requests.push(request); await respond(req, res, request, requests.length);
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(async () => {
    server.closeAllConnections(); await new Promise(done => server.close(done));
    await rm(dir, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const fetch = globalThis.fetch;
  // Exercise the production default adapter. Replace only the destination
  // below it; every request still crosses a real local HTTP socket.
  t.mock.method(globalThis, 'fetch', (url, options) => fetch(new URL(new URL(url).pathname, origin), options));
  const sessionPath = join(dir, 'session.json');
  await saveSession({ cookies: [], userAgent: 'local-desktop-transport-test' }, sessionPath);
  const client = await HttpClient.create({ sessionPath });
  return { client, requests, sessionPath };
}

for (const endpoint of ['insertVenueBookingInfo', 'cancelSelectBookingInfo']) {
  for (const status of [421, 503]) test(`桌面真实 HTTP ${status}：${endpoint} 仅发送一次并保留原响应`, async t => {
    const f = await localClient(t, (_req, res, _request, count) => {
      res.writeHead(count === 1 ? status : 200, { 'content-type': 'application/json',
        'retry-after': '0', 'set-cookie': '_WEU=original-response; Path=/' });
      res.end(JSON.stringify(count === 1 ? { code: String(status), msg: '原始拒绝' } : { code: '0' }));
    });
    await assert.rejects(f.client.post(`sportVenue/${endpoint}.do`, { name: '测试同学', WID: 'court A' }),
      error => error.status === status);
    assert.equal(f.requests.length, 1, '传输层不得隐藏拒绝并重发提交');
    assert.equal(f.requests[0].body, new URLSearchParams({ name: '测试同学', WID: 'court A' }).toString());
    assert.equal(Number(f.requests[0].headers['content-length']), Buffer.byteLength(f.requests[0].body));
    assert.equal(f.requests[0].headers['transfer-encoding'], undefined);
    assert.equal((await loadSession(f.sessionPath)).cookies.find(cookie => cookie.name === '_WEU').value, 'original-response');
  });
}

test('桌面真实 HTTP：只读 POST 仍可由 fetch 从 421 恢复', async t => {
  const f = await localClient(t, (_req, res, _request, count) => {
    res.writeHead(count === 1 ? 421 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(count === 1 ? { code: '421' } : []));
  });
  assert.deepEqual((await f.client.post('sportVenue/getRqList.do', { sample: 'read-only' })).data, []);
  assert.equal(f.requests.length, 2);
  assert.deepEqual(f.requests.map(request => request.body), ['sample=read-only', 'sample=read-only']);
});

test('桌面真实 HTTP：完整正文和 Cookie 保存后才发后一单，复用连接', { timeout: 4000 }, async t => {
  const firstHeaders = deferred(), firstBody = deferred();
  t.after(() => firstBody.resolve());
  const f = await localClient(t, async (_req, res, _request, count) => {
    res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': `_WEU=response-${count}; Path=/` });
    res.write('{"code":"0","data":');
    if (count === 1) { firstHeaders.resolve(); await firstBody.promise; }
    res.end(JSON.stringify({ DHID: `order-${count}` }) + '}');
  });
  const first = f.client.post('sportVenue/insertVenueBookingInfo.do', { time: '19:00-20:00' });
  await firstHeaders.promise;
  const second = f.client.post('sportVenue/insertVenueBookingInfo.do', { time: '20:00-21:00' });
  assert.equal(f.requests.length, 1);
  firstBody.resolve();
  assert.equal((await first).data.data.DHID, 'order-1');
  assert.equal((await second).data.data.DHID, 'order-2');
  assert.equal(f.requests.length, 2);
  assert.match(f.requests[1].headers.cookie, /_WEU=response-1/);
  assert.equal(f.requests[0].socket, f.requests[1].socket, '一次性表单不应关闭可复用连接');
  assert.equal((await loadSession(f.sessionPath)).cookies.find(cookie => cookie.name === '_WEU').value, 'response-2');
});

test('桌面真实 HTTP：预约正文截断时不重发', async t => {
  const f = await localClient(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': '100' });
    res.write('{"code":'); res.socket.destroy();
  });
  await assert.rejects(f.client.post('sportVenue/insertVenueBookingInfo.do', { WID: 'court' }));
  assert.equal(f.requests.length, 1);
});
