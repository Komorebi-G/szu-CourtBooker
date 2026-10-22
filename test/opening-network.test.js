import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HttpClient, fetchWithOneShotMutation } from '../desktop/src/http-client.js';
import { saveSession } from '../desktop/src/session.js';
import { SzuVenueApi } from '../shared/api.js';
import { runBooking } from '../shared/runner.js';

const releaseAt = Date.parse('2026-10-23T12:30:00+08:00');
const room = id => ({ WID: id, CDMC: id, CGBM: 'v', XMDM: '001', XQDM: '1' });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Keep school requests on real local sockets, including the production fetch
// adapter, parser, session persistence, account gate, quota and release runner.
async function fixture(t, { skewMs = 0, waitDelay = () => 20, queryDelayMs = 30,
  successDelayMs = 260, firstMessage, multipleSports = false, queryDisabled = false, queryLimit } = {}) {
  t.mock.timers.enable({ apis: ['Date'], now: releaseAt - 10000 });
  const trace = [], dispatches = []; let firstPostAt, active = 0, maximum = 0, rejected = 0, roomQueries = 0;
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const form = Object.fromEntries(new URLSearchParams(body));
    const endpoint = new URL(req.url, 'http://local').pathname.split('/').at(-1);
    const record = { endpoint, form, at: performance.now() }; trace.push(record);
    let data;
    if (endpoint === 'index.do') data = "USERID='local-user';USER_INFO={\"userName\":\"测试\"};APP_TITLE=";
    else if (endpoint === 'getOpeningRoom.do') {
      await delay(queryDelayMs);
      data = firstPostAt !== undefined && performance.now() < firstPostAt + skewMs && form.XMDM === '001'
        ? { code: '#E111080000000', msg: '该预约日期暂未开放预约' }
        : { code: '0', datas: { getOpeningRoom: { rows: [room('A'), room('B')].map(r => ({ ...r, XMDM: form.XMDM, disabled: queryDisabled })) } } };
      if (++roomQueries === queryLimit) t.mock.timers.setTime(releaseAt + 6001);
    } else if (endpoint === 'insertVenueBookingInfo.do') {
      firstPostAt ??= record.at;
      maximum = Math.max(maximum, ++active);
      res.once('finish', () => { active--; record.completedAt = performance.now(); });
      const closed = form.XMDM === '001' && record.at < firstPostAt + skewMs;
      if (closed || queryDisabled || firstMessage && rejected === 0) {
        data = { code: '#E111080000000', msg: firstMessage ?? '该预约日期暂未开放预约' };
        await delay(waitDelay(++rejected));
      } else { data = { code: '0' }; await delay(successDelayMs); }
    } else throw new Error(`Unexpected local endpoint: ${endpoint}`);
    res.writeHead(200, { 'content-type': typeof data === 'string' ? 'text/html' : 'application/json' });
    res.end(typeof data === 'string' ? data : JSON.stringify(data));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const dir = await mkdtemp(join(tmpdir(), 'court-opening-network-'));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const sessionPath = join(dir, 'session.json'); await saveSession({ cookies: [], userAgent: 'local-only' }, sessionPath);
  const client = await HttpClient.create({ sessionPath, transport: (url, options) => {
    if (url.pathname.endsWith('insertVenueBookingInfo.do')) dispatches.push(performance.now());
    return fetchWithOneShotMutation(url, options, (target, init) => fetch(new URL(new URL(target).pathname, origin), init));
  } });
  const api = new SzuVenueApi(client);
  // Isolate application opening skew from HTTP Date calibration, which has
  // separate socket and asymmetric-network coverage in the clock tests.
  api.sampleServerClock = undefined; api.sampleServerOffset = async () => 0;
  const target = { name: '本地网络场景', targetIndex: 0, campusCode: '1', sportCode: '001', modeCode: '1.0',
    times: ['19:00-20:00', '20:00-21:00'], venues: [{ CGBM: 'v' }], courtNames: ['A', 'B'], bookingGoal: 'two' };
  const targets = multipleSports ? [target, { ...target, targetIndex: 1, sportCode: '002' }] : [target];
  let intents = 0;
  const run = () => runBooking({ api, client, targets, date: '2026-10-24', immediate: false, live: true,
    releaseAtServer: releaseAt, log() {}, knownRooms: [room('A'), room('B'),
      ...(multipleSports ? [room('A'), room('B')].map(r => ({ ...r, WID: 'other-' + r.WID, XMDM: '002' })) : [])],
    config: { scheduler: { timeoutMs: 6000, pollIntervalMs: 80, pollJitterMs: 0, queryConcurrency: 1 }, booking: {} },
    onPreparedAttempt: async () => { if (++intents === 2) t.mock.timers.setTime(releaseAt + 1); } });
  return { run, trace, dispatches, maximum: () => maximum, firstPostAt: () => firstPostAt };
}

for (const skewMs of [60, 220, 900]) test(`真实HTTP：应用比校时晚开闸${skewMs}ms，首选探测有预算且完整响应前不发后段`, { timeout: 7000 }, async t => {
  const f = await fixture(t, { skewMs, waitDelay: n => n % 2 ? 20 : 180 });
  const result = await f.run();
  assert.equal(result.ok, true); assert.equal(result.successes.length, 2); assert.equal(f.maximum(), 1);
  for (const success of result.successes) {
    const timing = success.response.requestTiming;
    assert.ok(timing.headersDurationMs >= 0 && timing.headersDurationMs <= timing.durationMs);
  }
  const posts = f.trace.filter(r => r.endpoint === 'insertVenueBookingInfo.do');
  const early = posts.filter(r => r.at < f.firstPostAt() + skewMs);
  assert.ok(early.length <= 2, '整日未开放期间最多两次缓存POST，其后只读探测');
  assert.ok(early.every(r => r.form.KYYSJD === '19:00-20:00' && r.form.CDWID === 'A'));
  for (let i = 1; i < posts.length; i++) {
    assert.ok(posts[i].at >= posts[i - 1].completedAt, '前一单完整响应后才提交');
    assert.ok(f.dispatches[i] - f.dispatches[i - 1] >= 79,
      `客户端起始间隔应满足80ms（1ms定时精度容差），实测${f.dispatches[i] - f.dispatches[i - 1]}ms`);
  }
  const queries = f.trace.filter(r => r.endpoint === 'getOpeningRoom.do');
  if (skewMs === 60) assert.equal(queries.length, 0, '一次额外探测已开闸，无需插入GET');
  else assert.ok(queries.length >= 1, '第二次仍未开放后转只读等待');
  assert.ok(queries.filter(r => r.at + 30 < f.firstPostAt() + skewMs).every(r => r.form.KSSJ === '19:00'),
    '日期未开放的查询不再重复探测后段');
  t.diagnostic(`开闸偏差${skewMs}ms；POST ${posts.length}次；查询${queries.length}次；首次成功起点+${posts[early.length].at - f.firstPostAt()}ms；客户端/接收端首间隔${f.dispatches[1] - f.dispatches[0]}/${posts[1].at - posts[0].at}ms`);
});

test('真实HTTP：缓存满员后目录仍全满，正常间隔查询而非零等待自旋', async t => {
  const f = await fixture(t, { firstMessage: '场地满员', queryDisabled: true, queryLimit: 5 });
  const result = await f.run(); assert.equal(result.successes.length, 0);
  const queries = f.trace.filter(r => r.endpoint === 'getOpeningRoom.do');
  assert.equal(queries.length, 5);
  // Two slots may be read in the same round. Re-reading the same slot must
  // include the polling wait as well as completed HTTP responses.
  const firstSlot = queries.filter(r => r.form.KSSJ === '19:00');
  for (let i = 1; i < firstSlot.length; i++) assert.ok(firstSlot[i].at - firstSlot[i - 1].at >= 100,
    `空位查询不能残留refresh_required而空转，实测${firstSlot[i].at - firstSlot[i - 1].at}ms`);
});

test('真实HTTP：某项目未开闸不挡住同账号已开放项目，也不把等待放在账号锁内', { timeout: 7000 }, async t => {
  const f = await fixture(t, { skewMs: 900, multipleSports: true, successDelayMs: 20 });
  const result = await f.run(); assert.equal(result.ok, true); assert.equal(result.successes.length, 4);
  const other = f.trace.find(r => r.endpoint === 'insertVenueBookingInfo.do' && r.form.XMDM === '002');
  assert.ok(other.at < f.firstPostAt() + 900, '已开放项目在首项目开闸前就得到提交机会');
  assert.equal(f.maximum(), 1);
});

for (const message of ['该场地未开放', '场地满员']) test(`真实HTTP：相同业务码返回“${message}”时重新查询空位，不按日期未开放重发首选`, async t => {
  const f = await fixture(t, { firstMessage: message });
  const result = await f.run(); assert.equal(result.ok, true);
  const actions = f.trace.filter(r => ['insertVenueBookingInfo.do', 'getOpeningRoom.do'].includes(r.endpoint));
  assert.deepEqual(actions.slice(0, 3).map(r => [r.endpoint, r.form.CDWID]),
    [['insertVenueBookingInfo.do', 'A'], ['getOpeningRoom.do', undefined], ['insertVenueBookingInfo.do', 'B']]);
});
