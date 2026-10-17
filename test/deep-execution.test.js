import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { LiveExecution } from '../desktop/src/execution.js';
import { JobStore, writeJson, readJson, exists } from '../desktop/src/jobs.js';
import { executeJob } from '../desktop/src/job-worker.js';
import { CoreHttpClient } from '../shared/http-client-core.js';
import { SzuVenueApi } from '../shared/api.js';
import { HttpClient } from '../desktop/src/http-client.js';
import { saveSession, loadSession } from '../desktop/src/session.js';
import { shanghaiDate, addDays } from '../shared/utils.js';
import { readDiagnosticJournal } from '../desktop/src/diagnostics.js';
import { exportDiagnostics } from '../shared/diagnostics.js';
import { ReferenceCatalogStore } from '../desktop/src/catalogs.js';

// Before 12:30 tomorrow is still closed. Use today's future evening slots in
// that case, so these immediate HTTP tests never wait for the real noon release.
function bookableDate() {
  const today = shanghaiDate();
  return Date.now() < Date.parse(`${today}T12:30:00+08:00`) ? today : addDays(today, 1);
}

// Real HTTP sockets and real request parsing. Never contacts the school:
// only the transport destination is replaced, not the API/execution logic.
async function laboratory(t, { identity = () => 'A', submit, bookings = () => [],
  rooms = () => [{ WID: 'court', CDMC: 'A', CGBM: 'v', XMDM: '001', XQDM: '1' }] } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'szu-deep-'));
  const submissions = [], identityReads = [], bookingReads = [], roomReads = [];
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const form = new URLSearchParams(Buffer.concat(chunks).toString());
    const endpoint = req.url.split('/').at(-1);
    let result;
    if (endpoint === 'index.do') {
      const id = identity(identityReads.length); identityReads.push(id);
      if (!id) { res.writeHead(302, { location: 'https://auth.example/login' }); res.end(); return; }
      res.setHeader('content-type', 'text/html');
      res.end(`USERID='${id}';USER_INFO={"userName":"Test"};APP_TITLE='Test';`); return;
    }
    if (endpoint === 'getSportVenueData.do') result = {
      campusList: [{ XQDM: '1', XQDM_DISPLAY: '粤海校区' }],
      xmList: [{ XQDM: '1', XMDM: '001', XMMC: '羽毛球', DCFS: '1.0' }],
      packageVenueList: [{ SSXQ: '1', XM: '001', CGBM: 'v', CGMC: '东馆' }],
    };
    else if (endpoint === 'getOpeningRoom.do') {
      roomReads.push(Object.fromEntries(form));
      result = { code: '0', datas: { getOpeningRoom: { rows: rooms(roomReads.length) } } };
    }
    else if (endpoint === 'insertVenueBookingInfo.do') {
      submissions.push(Object.fromEntries(form));
      if (submit) {
        const handled = await submit({ req, res, form, number: submissions.length });
        if (handled) return;
      }
      result = { code: '0', data: { DHID: 'order-' + submissions.length } };
    } else if (endpoint === 'getRqList.do') result = [];
    else if (endpoint === 'myBookingInfo.do') {
      bookingReads.push(Object.fromEntries(form));
      const rows = bookings();
      result = { code: '0', datas: { myBookingInfo: { rows, totalSize: rows.length } } };
    }
    else { res.writeHead(404); res.end(); return; }
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(result));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const createApi = async () => {
    const client = new CoreHttpClient({ userAgent: 'local-test', cookies: [] }, {
      transport: (url, options) => fetch(new URL(new URL(url).pathname, origin), options),
    });
    return { client, api: new SzuVenueApi(client) };
  };
  const live = new LiveExecution({ dataDir, createApi });
  t.after(() => live.close());
  const store = new JobStore({ dataDir, execution: live, scheduler: { async remove() {} } });
  async function job(time = '19:00-20:00') {
    const id = randomUUID(), dir = store.path(id); await mkdir(dir, { recursive: true });
    await writeJson(join(dir, 'job.json'), { id, mode: 'now', taskId: id,
      sessionPath: 'unused', accountIdentityId: 'A', releaseAt: Date.now(), createdAt: new Date().toISOString(),
      config: { targets: [{ name: 'Test', date: bookableDate(), campus: '粤海校区', sport: '羽毛球',
        mode: '包场', venues: ['东馆'], courts: ['A'], times: [time] }],
      scheduler: { timeoutMs: 2000, queryConcurrency: 1, pollIntervalMs: 100 }, booking: { taskConcurrency: 1 } } });
    await writeJson(join(dir, 'state.json'), { status: 'queued', logs: [], successes: [] });
    return { id, dir };
  }
  return { dataDir, live, store, job, submissions, identityReads, bookingReads, roomReads, origin };
}

async function saveCourtStructure(f) {
  await new ReferenceCatalogStore(f.dataDir).read({ accountId: 'default', dates: [shanghaiDate()],
    target: { campusCode: '1', sportCode: '001', modeCode: '1.0', venues: [{ CGBM: 'v' }], times: ['19:00-20:00'] },
    api: { async getTimeList() { return [{ CODE: '19:00-20:00' }]; }, async getOpeningRooms() {
      return [{ WID: 'court', CDMC: 'A', CGBM: 'v', XMDM: '001', XQDM: '1', disabled: true, text: '旧日期已满' }];
    } } });
}

test('真实 HTTP：桌面固定场地倒计时使用已保存结构，到点无需等待空位查询', { timeout: 8000 }, async t => {
  const f = await laboratory(t, { rooms: () => [] });
  await saveCourtStructure(f);
  const job = await f.job(), saved = await readJson(join(job.dir, 'job.json'));
  saved.mode = 'release'; saved.releaseAt = Date.now() + 1800;
  await writeJson(join(job.dir, 'job.json'), saved);
  await f.live.start(job.dir);
  const state = await f.store.get(job.id);
  assert.equal(state.status, 'success', state.error);
  assert.equal(f.roomReads.length, 0, '固定场地结构只为倒计时首单省去查询');
  assert.deepEqual(f.submissions.map(form => [form.CDWID, form.KYYSJD, form.YYRGH]), [['court', '19:00-20:00', 'A']]);
  assert.equal(f.bookingReads[0].pageSize, '500', '临近放号以已支持的大分页减少准备请求');
});

test('真实 HTTP：桌面立即捡漏不把保存的场地结构当空位，全满时零提交', async t => {
  const f = await laboratory(t, { rooms: n => [{ WID: 'court', CDMC: 'A', CGBM: 'v', XMDM: '001', XQDM: '1', disabled: n === 1 }] });
  await saveCourtStructure(f);
  const job = await f.job(); await f.live.start(job.dir);
  assert.equal((await f.store.get(job.id)).status, 'success');
  assert.equal(f.roomReads.length, 2); assert.equal(f.submissions.length, 1);
});

test('真实 HTTP：已有一段时，并发桌面任务共享最后一个名额，只查询一次学校记录', async (t) => {
  const f = await laboratory(t, { bookings: () => [{ YYRQ: bookableDate(), KYYSJD: '18:00-19:00',
    XMDM: '001', YYZT_DISPLAY: '已支付', CDWID: 'court', CDMC: 'A' }] });
  const a = await f.job(), b = await f.job('20:00-21:00');
  await Promise.all([f.live.start(a.dir), f.live.start(b.dir)]);
  assert.equal(f.submissions.length, 1); assert.equal(f.bookingReads.length, 1);
  const states = await Promise.all([f.store.get(a.id), f.store.get(b.id)]);
  assert.ok(states.some((s) => s.status === 'success')); assert.ok(states.some((s) => s.status === 'limited'));
});
test('真实 HTTP：学校已有两个未选时段，桌面执行不再提交', async (t) => {
  const f = await laboratory(t, { bookings: () => ['17:00-18:00', '18:00-19:00'].map((time) => ({
    YYRQ: bookableDate(), KYYSJD: time, XMDM: '001', YYZT_DISPLAY: '已支付', CDWID: 'court', CDMC: 'A',
  })) });
  const job = await f.job(); await f.live.start(job.dir);
  assert.equal(f.submissions.length, 0); assert.equal((await f.store.get(job.id)).status, 'limited');
});
test('真实 HTTP：学校已有预约与候选部分重叠，不重复提交', async (t) => {
  const f = await laboratory(t, { bookings: () => [{ YYRQ: bookableDate(), KYYSJD: '19:30-20:30',
    XMDM: '001', YYZT_DISPLAY: '已支付', CDWID: 'court', CDMC: 'A' }] });
  const a = await f.job(), b = await f.job('20:00-21:00');
  await Promise.all([f.live.start(a.dir), f.live.start(b.dir)]);
  assert.equal(f.submissions.length, 0);
  for (const job of [a, b]) assert.match((await f.store.get(job.id)).error, /重叠/);
});
test('真实 HTTP：学校订单未知时桌面停止预约，保留核对原因', async (t) => {
  const f = await laboratory(t, { bookings: () => [{ YYRQ: bookableDate(), KYYSJD: '19:30-20:30',
    XMDM: '001', YYZT_DISPLAY: '未知状态' }] });
  const job = await f.job(); await f.live.start(job.dir);
  assert.equal(f.submissions.length, 0); assert.match((await f.store.get(job.id)).error, /人工核对/);
});
test('真实 HTTP：桌面首单收到账号冻结，释放名额队列前阻止兄弟任务', async (t) => {
  const f = await laboratory(t, { submit: async ({ res }) => {
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ code: '1', msg: '账号冻结' })); return true;
  } });
  const a = await f.job(), b = await f.job('20:00-21:00');
  await Promise.all([f.live.start(a.dir), f.live.start(b.dir)]);
  assert.equal(f.submissions.length, 1);
  for (const job of [a, b]) assert.match((await f.store.get(job.id)).error, /账号冻结/);
});

test('真实 HTTP 链路：校时期间身份改变时，放号前复验阻止提交', async (t) => {
  const f = await laboratory(t, { identity: (n) => n === 0 ? 'A' : 'B' });
  const job = await f.job(); await f.live.start(job.dir);
  assert.deepEqual(f.identityReads, ['A', 'B']);
  assert.deepEqual(f.submissions, []);
  assert.match((await f.store.get(job.id)).error, /身份已改变/);
});

test('真实 HTTP 链路：启动和临近提交复验共享身份缓存，正式下单不再读身份', async (t) => {
  const f = await laboratory(t);
  const job = await f.job(); await f.live.start(job.dir);
  assert.deepEqual(f.identityReads, ['A', 'A'], '启动与准备复验各读一次，正式 POST 使用已验证缓存');
  assert.deepEqual(f.submissions.map((form) => form.YYRGH), ['A']);
  const state = await f.store.get(job.id);
  const journal = await readDiagnosticJournal(job.dir);
  const request = journal.find((e) => e.details?.event === 'booking_request');
  const dispatched = journal.find((e) => e.details?.event === 'booking_dispatch');
  const response = journal.find((e) => e.details?.event === 'booking_response');
  assert.equal(request.details.requestId, dispatched.details.requestId);
  assert.equal(request.details.requestId, response.details.requestId);
  assert.equal(response.details.httpStatus, 200);
  assert.equal(response.details.code, '0');
  assert.ok(dispatched.details.dispatchDelayMs >= 0);
  assert.equal(state.metrics.dispatched, 1);
  const exported = exportDiagnostics(state, journal);
  assert.equal(exported.missingEvents, 0);
  assert.ok(!JSON.stringify(exported).includes('order-1'));
});

test('立即模式的本机确认时间不得被当作学校放号时间再等待', { timeout: 5000 }, async (t) => {
  const f = await laboratory(t), job = await f.job();
  const record = await readJson(join(job.dir, 'job.json'));
  // An ahead local clock can persist a confirmation timestamp later than the
  // real school release. Now mode must derive release from the booking date.
  record.releaseAt = Date.now() + 60000; await writeJson(join(job.dir, 'job.json'), record);
  await f.live.start(job.dir);
  assert.equal(f.submissions.length, 1);
});

test('真实倒计时：启动验证成功但放号前会话失效时，重新核验必须阻止提交', { timeout: 10000 }, async (t) => {
  const f = await laboratory(t, { identity: (n) => n === 0 ? 'A' : null });
  const job = await f.job();
  const config = await readJson(join(job.dir, 'job.json'));
  await writeJson(join(job.dir, 'job.json'), { ...config, mode: 'release', releaseAt: Date.now() + 800 });
  await f.live.start(job.dir);
  assert.deepEqual(f.identityReads, ['A', null]);
  assert.equal(f.submissions.length, 0);
  const state = await f.store.get(job.id);
  assert.equal(state.status, 'error'); assert.match(state.error, /登录态已失效/);
});

test('真实 HTTP 断线：学校已收到首单但响应丢失，其他任务不得继续提交', async (t) => {
  const f = await laboratory(t, { submit: async ({ res, number }) => {
    if (number === 1) { res.destroy(); return true; }
  } });
  const a = await f.job(), b = await f.job('20:00-21:00');
  await Promise.allSettled([f.live.start(a.dir), f.live.start(b.dir)]);
  assert.equal(f.submissions.length, 1, '首单结果未知后仍向学校发送了后续任务');
  const states = await Promise.all([f.store.get(a.id), f.store.get(b.id)]);
  assert.ok(states.some((state) => Object.keys(state.pendingRequests).length === 1));
  const failedJob = [a, b][states.findIndex((state) => Object.keys(state.pendingRequests).length === 1)];
  const journal = await readDiagnosticJournal(failedJob.dir);
  const failed = journal.find((e) => e.details?.event === 'booking_error');
  assert.equal(failed.details.outcome, 'unknown');
  assert.equal(failed.details.requestId, journal.find((e) => e.details?.event === 'booking_dispatch').details.requestId);
});

test('真实文件故障：成功响应落盘失败时，不继续其他任务', async (t) => {
  let jobDir;
  let releaseResponse;
  const secondStarted = new Promise((resolve) => { releaseResponse = resolve; });
  const f = await laboratory(t, { submit: async ({ number }) => {
    if (number === 1) {
      await secondStarted;
      // Intent is already on disk. Make the next atomic rename fail.
      const state = join(jobDir, 'state.json');
      await rename(state, state + '.before-failure'); await mkdir(state);
    }
  } });
  const a = await f.job(), b = await f.job('20:00-21:00'); jobDir = a.dir;
  // Start the second job only once the first request is already in the server.
  const first = f.live.start(a.dir);
  while (!f.submissions.length) await new Promise((resolve) => setTimeout(resolve, 2));
  const second = f.live.start(b.dir); releaseResponse();
  await Promise.allSettled([first, second]);
  assert.equal(f.submissions.length, 1, '结果无法落盘时，后续任务仍在下单');
  const visible = await f.store.get(a.id);
  assert.equal(visible.status, 'error'); assert.equal(visible.successes.length, 1);
  assert.match(visible.error, /保存失败/);
  const previous = await readJson(join(a.dir, 'state.json.before-failure'));
  assert.equal(Object.keys(previous.pendingRequests).length, 1, '最后的持久记录须保留待核对意图');
});

for (const code of ['0', '1']) {
  test(`真实 HTTP 与会话文件故障：明确${code === '0' ? '成功' : '满员'}响应不能被 Cookie 保存错误覆盖`, async (t) => {
    let sessionPath, bothReady, reads = 0;
    const roomsReady = new Promise((resolve) => { bothReady = resolve; });
    const f = await laboratory(t, { submit: async ({ res }) => {
      // Both plans have finished their read-only preparation. The first
      // mutation receives a definite result and rotates its session cookie.
      await rename(sessionPath, sessionPath + '.before-failure'); await mkdir(sessionPath);
      res.setHeader('content-type', 'application/json');
      res.setHeader('set-cookie', 'ticket=fresh; Path=/');
      res.end(JSON.stringify(code === '0' ? { code, data: { DHID: 'known-success' } } : { code, msg: '场地满员' }));
      return true;
    } });
    sessionPath = join(f.dataDir, 'session.json');
    await saveSession({ userAgent: 'test', cookies: [] }, sessionPath);
    f.live.createApi = async () => {
      const client = await HttpClient.create({ sessionPath, transport: (url, options) =>
        fetch(new URL(new URL(url).pathname, f.origin), options) });
      const api = new SzuVenueApi(client), readRooms = api.getOpeningRooms.bind(api);
      api.getOpeningRooms = async (input) => {
        const rows = await readRooms(input);
        if (++reads === 2) bothReady();
        await roomsReady; return rows;
      };
      return { client, api };
    };
    const a = await f.job(), b = await f.job('20:00-21:00');
    await Promise.all([f.live.start(a.dir), f.live.start(b.dir)]);
    assert.equal(f.submissions.length, 1, 'Cookie 保存失败后仍发送了兄弟方案');
    const states = await Promise.all([f.store.get(a.id), f.store.get(b.id)]);
    for (const state of states) {
      assert.equal(state.status, state.successes.length ? 'partial' : 'error'); assert.match(state.error, /登录状态保存失败/);
      assert.deepEqual(state.pendingRequests, {}); assert.equal(state.metrics.unknown, 0);
    }
    const successes = states.flatMap((state) => state.successes);
    assert.equal(successes.length, code === '0' ? 1 : 0);
    if (code === '0') assert.equal(successes[0].orderId, 'known-success');
    const requestJournal = await readDiagnosticJournal([a, b][states.findIndex((state) => state.metrics.dispatched)].dir);
    assert.equal(requestJournal.find((entry) => entry.details?.event === 'booking_response').details.code, code);
  });
}

test('会话保存失败附带畸形业务响应，仍不能建立已知预约结果', async () => {
  const failure = Object.assign(new Error('disk failure'), { requestResult: { data: {}, status: 200, startedAt: Date.now() } });
  const api = new SzuVenueApi({ async post() { throw failure; } });
  api.identity = { id: 'A', name: 'Test' };
  await assert.rejects(api.book({ date: '2026-10-12', time: '19:00-20:00', modeCode: '1.0',
    room: { WID: 'court', CGBM: 'v', XMDM: '001', XQDM: '1' } }), /结果待确认/);
});

test('直接桌面执行没有共享 quota 时，保留成功并停止同方案的后续时段', async (t) => {
  const f = await laboratory(t);
  const job = await f.job(), config = await readJson(join(job.dir, 'job.json'));
  config.config.targets[0].times.push('20:00-21:00');
  await writeJson(join(job.dir, 'job.json'), config);
  let submissions = 0;
  const createApi = async () => {
    const client = new CoreHttpClient({ userAgent: 'test', cookies: [] }, {
      transport: (url, options) => fetch(new URL(new URL(url).pathname, f.origin), options),
    });
    const api = new SzuVenueApi(client);
    api.book = async () => { submissions++; return { code: '0', data: { DHID: 'known-direct' }, persistenceError: 'disk failure' }; };
    return { client, api };
  };
  await executeJob(job.dir, { manualStart: true, createApi });
  const state = await readJson(join(job.dir, 'state.json'));
  assert.equal(submissions, 1); assert.equal(state.successes[0].orderId, 'known-direct');
  assert.deepEqual(state.pendingRequests, {}); assert.match(state.error, /登录状态保存失败/);
});

test('半写入记录不应阻断所有任务列表和旧定时清理', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'szu-torn-record-'));
  const id = randomUUID(), dir = join(dataDir, 'jobs', id); await mkdir(dir, { recursive: true });
  await writeJson(join(dir, 'job.json'), { id, mode: 'schedule', config: { targets: [] } });
  // Simulates a crash between the two initial file writes.
  const store = new JobStore({ dataDir, scheduler: { async remove() {} } });
  const rows = await store.list();
  assert.equal(rows.length, 1); assert.equal(rows[0].status, 'corrupt');
  await assert.rejects(executeJob(dir), { code: 'ENOENT' });
  assert.equal(await exists(join(dir, 'run.lock')), false, '初始记录读取失败不能留下执行锁');
  await store.retireSchedules();
  assert.equal(await readFile(join(dir, 'stop'), 'utf8').then(Boolean), true);
  await writeFile(join(dir, 'run.lock'), String(process.pid));
  await assert.rejects(store.remove(id), /记录损坏.*核对/);
  await assert.rejects(store.recordReview(id, { acknowledgeCorrupt: true }), /执行锁尚未释放/);
  await rm(join(dir, 'run.lock'));
  await store.recordReview(id, { acknowledgeCorrupt: true });
  await store.remove(id);
  assert.equal(await exists(dir), false);
  assert.equal(await exists(join(dataDir, 'trash', id, 'job.json')), true, '损坏记录也应能归档删除，并保留原文件');
});

test('真实 HTTP 更新 Cookie：同账号的另一个客户端必须使用已刷新的会话，不能覆盖回旧值', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'szu-cookie-rotation-'));
  const path = join(dir, 'session.json');
  await saveSession({ userAgent: 'test', cookies: [{ name: 'ticket', value: 'old', domain: 'ehall.szu.edu.cn', path: '/' }] }, path);
  const received = [];
  const server = createServer((req, res) => {
    received.push(req.headers.cookie);
    if (received.length === 1) res.setHeader('set-cookie', 'ticket=fresh; Path=/');
    else res.setHeader('set-cookie', 'route=second; Path=/');
    res.end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const [a, b] = await Promise.all([HttpClient.create({ sessionPath: path }), HttpClient.create({ sessionPath: path })]);
  for (const client of [a, b]) client.transport = (_url, options) => fetch(`http://127.0.0.1:${server.address().port}`, options);
  await a.get('index.do');
  await b.get('index.do');
  await a.flush(); await b.flush();
  assert.match(received[1], /ticket=fresh/, '另一执行客户端仍在发送旧 Cookie');
  assert.equal((await loadSession(path)).cookies.find((cookie) => cookie.name === 'ticket').value, 'fresh');
});

test('真实会话排队：等待同账号其他请求期间停止，队列解锁后也不得发送预约', { timeout: 10000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'szu-cookie-stop-'));
  const path = join(dir, 'session.json');
  await saveSession({ userAgent: 'test', cookies: [] }, path);
  let unblock, accepted;
  const blocked = new Promise((resolve) => { unblock = resolve; });
  const started = new Promise((resolve) => { accepted = resolve; });
  const received = [];
  const server = createServer(async (req, res) => {
    received.push(req.url);
    if (req.url.endsWith('index.do')) { accepted(); await blocked; }
    res.end('{"code":"0"}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { unblock(); server.closeAllConnections(); server.close(); });
  const [a, b] = await Promise.all([HttpClient.create({ sessionPath: path }), HttpClient.create({ sessionPath: path })]);
  for (const client of [a, b]) client.transport = (url, options) => fetch(new URL(new URL(url).pathname, `http://127.0.0.1:${server.address().port}`), options);
  const first = a.get('index.do'); await started;
  const api = new SzuVenueApi(b); api.identity = { id: 'A', name: 'Test' };
  const controller = new AbortController();
  const booking = api.book({ date: shanghaiDate(), modeCode: '1.0', room: {}, time: '19:00-20:00', signal: controller.signal });
  controller.abort(); unblock();
  await assert.rejects(booking, { code: 'REQUEST_NOT_SENT' }); await first;
  assert.equal(received.length, 1);
});

async function manager(t, dataDir, { preload = '' } = {}) {
  const config = join(dataDir, 'config.yaml'); await writeFile(config, 'targets: []\n');
  const loader = join(dataDir, 'observer.mjs'); await writeFile(loader, preload);
  const child = spawn(process.execPath, ['--import', loader, 'src/web-server.js', '--port', '0', '--no-open'], {
    env: { ...process.env, WEB_HOST: '127.0.0.1', SZU_CONFIG: config, SZU_DATA: dataDir,
      SZU_SESSION: join(dataDir, 'no-credentials.json') }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '', errors = '';
  child.stderr.on('data', (chunk) => { errors += chunk; });
  child.stdout.on('data', (chunk) => { output += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const ended = once(child, 'exit'); child.kill('SIGKILL'); await ended; }
  });
  const url = await new Promise((resolve, reject) => {
    child.stdout.on('data', () => { const match = /http:\/\/127.0.0.1:\d+/.exec(output); if (match) resolve(match[0]); });
    child.once('error', reject); child.once('exit', () => reject(new Error(errors)));
  });
  return { child, url, output: () => output };
}

test('真实管理进程：未完成的慢请求不能挡住停止；跨站停止仍被拒绝', { timeout: 10000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'szu-manager-stop-'));
  const app = await manager(t, dir, { preload: `
    import http from 'node:http'; import { syncBuiltinESMExports } from 'node:module';
    const create = http.createServer;
    http.createServer = (...args) => { const server = create(...args);
      server.on('request', (req) => { if (req.headers['x-test-body']) console.log('BODY_RECEIVED'); }); return server; };
    syncBuiltinESMExports();
    globalThis.fetch = () => { throw new Error('测试禁止外部网络'); };
  ` });
  const id = randomUUID(), jobDir = join(dir, 'jobs', id); await mkdir(jobDir, { recursive: true });
  await writeJson(join(jobDir, 'job.json'), { id, mode: 'now', config: { targets: [] } });
  await writeJson(join(jobDir, 'state.json'), { status: 'error', logs: [], successes: [] });
  const blocked = httpRequest(app.url + '/api/accounts', { method: 'POST', headers: {
    'content-type': 'application/json', 'transfer-encoding': 'chunked', 'x-test-body': 'hold',
  } });
  blocked.on('error', () => {}); t.after(() => blocked.destroy());
  blocked.write('{"name":'); // No closing JSON or EOF: handler remains blocked.
  while (!app.output().includes('BODY_RECEIVED')) await new Promise((resolve) => setTimeout(resolve, 5));
  const forbidden = await fetch(`${app.url}/api/jobs/${id}/stop`, { method: 'POST', headers: { origin: 'https://evil.example' } });
  assert.equal(forbidden.status, 400);
  const stopped = await fetch(`${app.url}/api/jobs/${id}/stop`, { method: 'POST', signal: AbortSignal.timeout(1500) });
  assert.equal(stopped.status, 200);
  assert.equal(await readFile(join(jobDir, 'stop'), 'utf8').then(Boolean), true);
  blocked.end('"temporary"}');
});

test('真实进程被杀：在途意图保留，重开管理服务不会再次提交', { timeout: 10000 }, async (t) => {
  let received;
  const submitted = new Promise((resolve) => { received = resolve; });
  const f = await laboratory(t, { submit: async () => { received(); return true; } });
  const job = await f.job();
  const script = `
    import { LiveExecution } from ${JSON.stringify(new URL('../desktop/src/execution.js', import.meta.url).href)};
    import { CoreHttpClient } from ${JSON.stringify(new URL('../shared/http-client-core.js', import.meta.url).href)};
    import { SzuVenueApi } from ${JSON.stringify(new URL('../shared/api.js', import.meta.url).href)};
    const live = new LiveExecution({ dataDir: ${JSON.stringify(f.dataDir)}, createApi: async () => {
      const client = new CoreHttpClient({ cookies: [], userAgent: 'test' }, {
        transport: (url, options) => fetch(new URL(new URL(url).pathname, ${JSON.stringify(f.origin)}), options),
      }); return { client, api: new SzuVenueApi(client) };
    } });
    await live.start(${JSON.stringify(job.dir)});
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  await submitted;
  const other = await f.job('20:00-21:00');
  assert.throws(() => f.live.start(other.dir), /另一个助手实例/, '独立进程仍在执行时不能另开提交');
  const ended = once(child, 'exit'); child.kill('SIGKILL'); await ended;
  const saved = await readJson(join(job.dir, 'state.json'));
  assert.equal(Object.keys(saved.pendingRequests).length, 1);
  const app = await manager(t, f.dataDir, { preload: `globalThis.fetch = () => { throw new Error('禁止重开后访问学校'); };` });
  const bootstrap = await fetch(app.url + '/api/bootstrap').then((r) => r.json());
  const restored = bootstrap.jobs.find((entry) => entry.id === job.id);
  assert.equal(restored.status, 'interrupted');
  assert.equal(Object.keys(restored.pendingRequests).length, 1);
  assert.equal(f.submissions.length, 1);
});
