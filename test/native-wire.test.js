import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { nativeTransport } from '../mobile/src/device.js';
import { BASE_URL } from '../shared/constants.js';
import { HttpClient } from '../desktop/src/http-client.js';
import { saveSession } from '../desktop/src/session.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoreHttpClient } from '../shared/http-client-core.js';
import { SzuVenueApi } from '../shared/api.js';
import { serverClockInterval } from '../shared/server-clock.js';

test('独立 HTTP 接收端观测：同账号完整响应前没有第二个 POST，不同账号仍可执行', async t => {
  const active = new Map(), maximum = new Map(), trace = [];
  let globalActive = 0, globalMaximum = 0;
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    const user = request.headers.cookie;
    active.set(user, (active.get(user) ?? 0) + 1);
    maximum.set(user, Math.max(maximum.get(user) ?? 0, active.get(user)));
    globalMaximum = Math.max(globalMaximum, ++globalActive);
    const record = { user, method: request.method, path: request.url, body, receivedAt: performance.now() }; trace.push(record);
    response.on('finish', () => { record.completedAt = performance.now(); active.set(user, active.get(user) - 1); globalActive--; });
    // Send headers and body separately: releasing at headers would be visible
    // as overlapping requests at this independent receiving socket.
    response.writeHead(200, { 'content-type': 'application/json' }); response.write('{"code":"0",');
    setTimeout(() => response.end('"msg":"成功"}'), 80);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const device = { async request(input) {
    const remote = new URL(input.url);
    assert.equal(remote.origin, 'https://ehall.szu.edu.cn');
    const response = await fetch(origin + remote.pathname, { method: input.method, headers: input.headers, body: input.body });
    return { status: response.status, headers: {}, body: await response.text() };
  } };
  const a = nativeTransport(device, null, 'a', { parallelQueries: true, parallelRequests: true, parallelBookings: true });
  const alias = nativeTransport(device, null, 'alias-a', { parallelQueries: true });
  a.bindIdentity('same-user-a'); alias.bindIdentity('same-user-a');
  const b = nativeTransport(device, null, 'b', { parallelQueries: true });
  const url = BASE_URL + 'sportVenue/insertVenueBookingInfo.do';
  const send = (transport, user, time) => transport(url, { method: 'POST', headers: { cookie: user },
    body: new URLSearchParams({ KYYSJD: time }), intervalMs: 30 });
  await Promise.all([send(a, 'fake-a', '19:00-20:00'), send(alias, 'fake-a', '20:00-21:00'),
    send(b, 'fake-b', '19:00-20:00'), send(b, 'fake-b', '20:00-21:00')]);
  assert.equal(trace.length, 4); assert.equal(maximum.get('fake-a'), 1); assert.equal(maximum.get('fake-b'), 1);
  assert.equal(globalMaximum, 2);
  for (const user of ['fake-a', 'fake-b']) {
    const requests = trace.filter(record => record.user === user);
    assert.ok(requests[1].receivedAt >= requests[0].completedAt, '后段实际到达接收端的时间必须晚于前段完整响应');
    assert.deepEqual(requests.map(record => new URLSearchParams(record.body).get('KYYSJD')), ['19:00-20:00', '20:00-21:00']);
  }
});

test('桌面独立接收端：同学校账号的不同会话文件也不能重叠发送预约 POST', async t => {
  const trace = []; let active = 0, maximum = 0;
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* Consume request before measuring the complete response. */ }
    maximum = Math.max(maximum, ++active);
    const record = { receivedAt: performance.now() }; trace.push(record);
    response.on('finish', () => { active--; record.completedAt = performance.now(); });
    response.writeHead(200, { 'content-type': 'application/json' }); response.write('{"code":');
    setTimeout(() => response.end('"0"}'), 80);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const dir = await mkdtemp(join(tmpdir(), 'court-wire-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const origin = `http://127.0.0.1:${server.address().port}`, user = crypto.randomUUID();
  const clients = await Promise.all(['a', 'alias-a'].map(async alias => {
    const sessionPath = join(dir, alias + '.json'); await saveSession({ cookies: [], userAgent: 'local-receiver' }, sessionPath);
    return HttpClient.create({ sessionPath, expectedUserId: user, transport: (url, options) => {
      assert.equal(url.origin, 'https://ehall.szu.edu.cn');
      return fetch(origin + url.pathname, options);
    } });
  }));
  await Promise.all(clients.map(client => client.post('sportVenue/insertVenueBookingInfo.do', {})));
  assert.equal(trace.length, 2); assert.equal(maximum, 1);
  assert.ok(trace[1].receivedAt >= trace[0].completedAt);
});

for (const platform of ['native', 'desktop']) test(`${platform} 独立接收端：快速响应时按80毫秒起始间隔串行提交`, async t => {
  const trace = []; let active = 0, maximum = 0;
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    if (request.url.endsWith('insertVenueBookingInfo.do')) {
      maximum = Math.max(maximum, ++active);
      const record = { receivedAt: performance.now(), sequence: new URLSearchParams(body).get('sequence') }; trace.push(record);
      response.on('finish', () => { active--; record.completedAt = performance.now(); });
    }
    response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"code":"0"}');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const relay = (url, options) => {
    const remote = new URL(url); assert.equal(remote.origin, 'https://ehall.szu.edu.cn');
    return fetch(origin + remote.pathname, options);
  };
  let send;
  if (platform === 'native') {
    const transport = nativeTransport({ async request(input) {
      const response = await relay(input.url, { method: input.method, body: input.body });
      return { status: response.status, headers: {}, body: await response.text() };
    } }, null, crypto.randomUUID());
    send = async (path, intervalMs, sequence) => {
      const response = await transport(BASE_URL + path, { method: 'POST', headers: {},
        body: new URLSearchParams({ sequence }), intervalMs });
      await response.text();
    };
  } else {
    const client = new HttpClient({ cookies: [] }, { sessionPath: join(tmpdir(), crypto.randomUUID()), transport: relay });
    send = (path, intervalMs, sequence) => client.post(path, { sequence }, { intervalMs });
  }
  // Warm the local connection so first-connection setup does not distort the
  // independently observed arrival gaps. These are local pacing measurements.
  await send('sportVenue/getRqList.do', 0, 'warmup');
  await Promise.all([0, 1, 2, 3].map(sequence => send('sportVenue/insertVenueBookingInfo.do', 80, sequence)));
  assert.equal(trace.length, 4); assert.equal(maximum, 1);
  assert.deepEqual(trace.map(record => record.sequence), ['0', '1', '2', '3']);
  const gaps = trace.slice(1).map((record, index) => {
    assert.ok(record.receivedAt >= trace[index].completedAt, '完整响应前不得发送下一单');
    return record.receivedAt - trace[index].receivedAt;
  });
  for (const gap of gaps) {
    assert.ok(gap >= 70 && gap < 140, `设置80ms的本地到达间隔为${gap.toFixed(1)}ms，允许10ms提前与60ms调度误差`);
  }
  t.diagnostic(`本地接收端测得起始间隔 ${gaps.map(gap => gap.toFixed(1)).join(' / ')}ms（设置80ms）`);
});

for (const platform of ['native', 'desktop']) test(`${platform} 独立接收端：查询不重启提交间隔，慢前单后立即衔接后单`, async t => {
  const trace = [];
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* Read the request body. */ }
    const mutation = request.url.endsWith('insertVenueBookingInfo.do');
    const record = { mutation, receivedAt: performance.now() }; trace.push(record);
    response.on('finish', () => { record.completedAt = performance.now(); });
    response.writeHead(200, { 'content-type': 'application/json' }); response.write('{"code":');
    setTimeout(() => response.end('"0"}'), mutation ? 300 : 160);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const relay = (url, options) => {
    const remote = new URL(url); assert.equal(remote.origin, 'https://ehall.szu.edu.cn');
    return fetch(origin + remote.pathname, options);
  };
  let send;
  if (platform === 'native') {
    const transport = nativeTransport({ async request(input) {
      const response = await relay(input.url, { method: input.method, body: input.body });
      return { status: response.status, headers: {}, body: await response.text() };
    } }, null, crypto.randomUUID(), { parallelQueries: true });
    send = async (path, intervalMs) => { const response = await transport(BASE_URL + path,
      { method: 'POST', headers: {}, intervalMs }); await response.text(); };
  } else {
    const client = new HttpClient({ cookies: [] }, { sessionPath: join(tmpdir(), crypto.randomUUID()), transport: relay });
    send = (path, intervalMs) => client.post(path, {}, { intervalMs });
  }
  // A large configured interval makes an accidental reset distinguishable from
  // OS scheduling noise. The response + next query already exceed that interval.
  const query = 'sportVenue/getRqList.do', post = 'sportVenue/insertVenueBookingInfo.do';
  await send(query, 0); await send(post, 400); await send(query, 0); await send(post, 400);
  assert.deepEqual(trace.map(item => item.mutation), [false, true, false, true]);
  for (const i of [1, 3]) assert.ok(trace[i].receivedAt - trace[i - 1].completedAt < 200,
    '查询返回后应尽快提交，不能额外等完整提交间隔');
  assert.ok(trace[3].receivedAt - trace[1].receivedAt >= 400, '两次提交的实际起始间隔仍须满足设置');
});

test('原生准备耗时不冒充网络间隔：实际网络调用间隔满足设置且接收端收到两单', async t => {
  const received = [], networkStarts = [];
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* Consume body. */ }
    received.push(performance.now());
    setTimeout(() => { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"code":"0"}'); }, 20);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`; let calls = 0;
  const transport = nativeTransport({ async request(input) {
    if (++calls === 1) await new Promise(resolve => setTimeout(resolve, 200));
    const remote = new URL(input.url); assert.equal(remote.origin, 'https://ehall.szu.edu.cn');
    const startedAt = performance.now();
    networkStarts.push(startedAt);
    const response = await fetch(origin + remote.pathname, { method: input.method });
    const body = await response.text();
    return { status: response.status, headers: {}, body, timing: { networkDurationMs: performance.now() - startedAt } };
  } });
  const send = () => transport(BASE_URL + 'sportVenue/insertVenueBookingInfo.do', { method: 'POST', headers: {}, intervalMs: 100 });
  await send(); await send();
  assert.equal(received.length, 2);
  assert.ok(networkStarts[1] - networkStarts[0] >= 99, '发送前保存再慢，也不能把两次真正的网络调用挤到同一个短窗口');
  assert.ok(received[1] - received[0] < 400, '只补足设定间隔，不能强加数秒等待');
  t.diagnostic(`网络调用间隔 ${(networkStarts[1] - networkStarts[0]).toFixed(1)}ms；本地到达间隔 ${(received[1] - received[0]).toFixed(1)}ms（设置100ms，首次准备200ms；冷连接和网络抖动可压缩到达间隔）`);
});

for (const platform of ['native', 'desktop']) test(`${platform} 本地慢正文：校时使用响应头到达时间，原生桥接延迟不冒充网络RTT`, async t => {
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* Consume the request. */ }
    response.writeHead(200, { date: new Date().toUTCString(), 'content-type': 'application/json' });
    response.flushHeaders();
    setTimeout(() => response.end('[]'), 180);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const relay = (url, options) => {
    const remote = new URL(url); assert.equal(remote.origin, 'https://ehall.szu.edu.cn');
    return fetch(origin + remote.pathname, options);
  };
  let transport = relay, physical;
  if (platform === 'native') transport = nativeTransport({ async request(input) {
    await new Promise(resolve => setTimeout(resolve, 50));
    const networkStartedAt = Date.now(), started = performance.now();
    const response = await relay(input.url, { method: input.method, body: input.body });
    const networkHeadersEndedAt = Date.now(), body = await response.text();
    physical = { networkStartedAt, networkHeadersEndedAt, networkEndedAt: Date.now(), networkDurationMs: performance.now() - started };
    await new Promise(resolve => setTimeout(resolve, 50));
    return { status: response.status, headers: { date: [response.headers.get('date')] }, body, timing: physical };
  } }, null, crypto.randomUUID());
  const api = new SzuVenueApi(new CoreHttpClient({ cookies: [] }, { transport }));
  const before = Date.now(), sample = await api.sampleServerClock(), returnedAt = Date.now();
  assert.ok(sample.endedAt - sample.headersEndedAt >= 140, '完整正文仍被等待读取，但不扩大响应头采样区间');
  const interval = serverClockInterval(sample), old = serverClockInterval({ ...sample, headersEndedAt: undefined });
  assert.equal(interval.valid, true);
  assert.ok(interval.lowerOffsetMs <= 0 && interval.upperOffsetMs > 0, '同机服务器与客户端的真实零偏差位于保守区间内');
  assert.ok(interval.lowerOffsetMs - old.lowerOffsetMs >= 140);
  if (physical) {
    assert.equal(sample.startedAt, physical.networkStartedAt); assert.equal(sample.headersEndedAt, physical.networkHeadersEndedAt);
    assert.equal(sample.endedAt, physical.networkEndedAt);
    assert.ok(sample.startedAt - before >= 40 && returnedAt - sample.endedAt >= 40);
    assert.equal(interval.rttMs, physical.networkHeadersEndedAt - physical.networkStartedAt);
  }
});
