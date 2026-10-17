import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { runBooking } from '../shared/runner.js';
import { BookingQuota } from '../shared/booking-quota.js';
import { RequestGate } from '../shared/request-gate.js';
import { classifyBookingResponse } from '../shared/booking-outcome.js';
import { CoreHttpClient } from '../shared/http-client-core.js';
import { SzuVenueApi } from '../shared/api.js';
import { SessionExpiredError, SchoolQueryError } from '../shared/errors.js';
import { nativeTransport } from '../mobile/src/device.js';
import { MobileStore, pendingMobileRequests } from '../mobile/src/store.js';
import { reviewBookings, reviewRequestMatches } from '../shared/booking-review.js';
import { HttpClient } from '../desktop/src/http-client.js';
import { saveSession, parseSessionText } from '../desktop/src/session.js';
import { executeJob } from '../desktop/src/job-worker.js';
import { writeJson, readJson } from '../desktop/src/jobs.js';
import { browserCdpPort } from '../shared/browser-port.js';

const NOW = Date.parse('2026-10-15T13:00:00+08:00'), date = '2026-10-16', time = '19:00-20:00';
const room = (id = 'A', extra = {}) => ({ WID: id, CDMC: id, CGBM: 'v', XMDM: '001', XQDM: '1', ...extra });
const target = { name: '测试', targetIndex: 0, campusCode: '1', sportCode: '001', modeCode: '1.0',
  times: [time], venues: [{ CGBM: 'v' }], courtNames: ['A', 'B'], bookingGoal: 'one' };
const args = (api, extra = {}) => ({ api, client: { async flush() {} }, targets: [target], date,
  immediate: true, live: true, log() {}, config: { scheduler: { timeoutMs: 5000, pollIntervalMs: 100,
    pollJitterMs: 0, queryConcurrency: 1 }, booking: {} }, ...extra });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function drive(t, work, controller) {
  let done = false; work.finally(() => { done = true; });
  for (let i = 0; i < 100 && !done; i++) { await nextTurn(); t.mock.timers.tick(100); }
  if (!done) controller.abort();
  return work;
}

test('满员目录持续查询期间零提交，名额释放后才提交', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: NOW });
  const controller = new AbortController(), posts = [], states = []; let queries = 0;
  const quota = new BookingQuota(); quota.requestGate('current').now = () => Date.now();
  const result = await drive(t, runBooking(args({ async getOpeningRooms() {
    queries++; return [room('A', { disabled: queries < 3 })];
  }, async book(input) { posts.push({ at: Date.now(), queries, id: input.room.WID }); return { code: '0' }; } },
  { quota, signal: controller.signal, onState: (_state, details) => states.push(details) })), controller);
  assert.equal(result.ok, true); assert.equal(queries, 3); assert.equal(posts.length, 1);
  assert.equal(posts[0].queries, 3); assert.ok(posts[0].at < NOW + 2000, '满员目录不得强加数秒等待而错过释放');
  assert.ok(states.some(state => state.activity === 'waiting_vacancy'));
});

test('提交返回满员后，下轮不得沿用仍未刷新过的空位', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: NOW });
  const controller = new AbortController(), events = []; let queries = 0;
  const quota = new BookingQuota(); quota.requestGate('current').now = () => Date.now();
  const result = await drive(t, runBooking(args({ async getOpeningRooms() {
    events.push('query'); queries++; return [room('A', { disabled: queries > 1 })];
  }, async book() { events.push('post'); return { code: '1', msg: '场地已满' }; } }, { quota, signal: controller.signal })), controller);
  assert.equal(result.ok, false); assert.equal(result.error, undefined);
  assert.equal(events.filter(event => event === 'post').length, 1); assert.ok(queries >= 2);
});

test('频率拒绝发生在目录回调中，冷却后仍从 A 开始，不能落到 B', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: NOW });
  const controller = new AbortController(), posts = [];
  const quota = new BookingQuota(); quota.requestGate('current').now = () => Date.now();
  const result = await drive(t, runBooking(args({ async getOpeningRooms() { return [room(), room('B')]; },
    async book({ room }) { posts.push(room.WID); return posts.length === 1
      ? { code: '#E111080000000', msg: '操作过于频繁，请稍后再试！' } : { code: '0' }; }
  }, { quota, signal: controller.signal })), controller);
  assert.equal(result.ok, true); assert.deepEqual(posts, ['A', 'A']);
});

test('目录业务频率拒绝会暂停查询，冷却后重新读取，不冒充无空位或永久失败', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: NOW });
  const controller = new AbortController(), queries = [], posts = [];
  const quota = new BookingQuota(); quota.requestGate('current').now = () => Date.now();
  const result = await drive(t, runBooking(args({ async getOpeningRooms() {
    queries.push(Date.now());
    if (queries.length === 1) throw new SchoolQueryError({ kind: 'retry', scope: 'rate', message: '操作过于频繁', code: 'RATE' });
    return [room()];
  }, async book() { posts.push(Date.now()); return { code: '0' }; } }, { quota, signal: controller.signal })), controller);
  assert.equal(result.ok, true); assert.equal(queries.length, 2); assert.equal(posts.length, 1);
  assert.ok(queries[1] - queries[0] >= 1000); assert.equal(result.metrics.queryFailures, 1);
});

test('长时间捡漏重新核验身份和订单，手机外新增订单后不再浪费名额', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: NOW });
  const controller = new AbortController(); let identities = 0, orders = 0, posts = 0, done = false;
  const quota = new BookingQuota(); quota.requestGate('current').now = () => Date.now();
  const input = args({ async getIdentity() { identities++; return { id: 'a' }; },
    async getOpeningRooms() { return [room('A', { disabled: true })]; }, async book() { posts++; return { code: '0' }; }
  }, { quota, signal: controller.signal, loadSchoolBookings: async () => ++orders === 1 ? [] : [
    { YYRQ: date, KYYSJD: time, CDWID: 'A', CDMC: 'A', XMDM: '001', YYZT: 'CG_YY' }
  ] });
  input.config.scheduler.timeoutMs = 60000;
  const work = runBooking(input).finally(() => { done = true; });
  for (let i = 0; i < 50 && !done; i++) { await nextTurn(); t.mock.timers.tick(1000); }
  if (!done) controller.abort();
  const result = await work;
  assert.equal(result.ok, true); assert.equal(orders, 2); assert.equal(identities, 1); assert.equal(posts, 0);
  assert.equal(result.successes[0].school, true);
});

test('传输共用账号冷却：查询成功不重置拒绝次数，业务码不能单独决定原因', async () => {
  const calls = []; let n = 0;
  const device = { async request(input) { calls.push(performance.now()); return { status: 200, headers: {},
    body: JSON.stringify(input.url.includes('getRqList') ? [] : ++n <= 2
      ? { code: '#E111080000000', msg: '操作过于频繁' } : { code: '0' }) }; } };
  const first = nativeTransport(device, null, 'alias-a', { rateLimitBackoffMs: 30 });
  const second = nativeTransport(device, null, 'alias-b', { rateLimitBackoffMs: 30 });
  first.bindIdentity('same-user'); second.bindIdentity('same-user');
  const post = 'https://ehall.szu.edu.cn/qljfwapp/sys/lwSzuCgyy/sportVenue/insertVenueBookingInfo.do';
  const query = post.replace('insertVenueBookingInfo', 'getRqList');
  const options = { method: 'POST', headers: {} };
  assert.equal((await first(post, options)).cooldownMs, 30);
  await second(query, options);
  assert.ok(calls[1] - calls[0] >= 25);
  assert.equal((await second(post, options)).cooldownMs, 60);
  await first(query, options); assert.ok(calls[3] - calls[2] >= 55);
  assert.equal((await first(post, options)).cooldownMs, 0);
  assert.equal(classifyBookingResponse({ code: '#E111080000000', msg: '场地满员' }).scope, undefined);
  assert.equal(classifyBookingResponse({ code: '#E111080000000', msg: '原因未公开' }).kind, 'rejected');
});

test('共享调度遵守每次提交间隔、Retry-After、停止和截止，冷却不自动重发', async () => {
  const gate = new RequestGate({ backoffMs: 10, maxBackoffMs: 100 });
  await gate.wait(); const first = performance.now();
  await gate.wait({ intervalMs: 35 }); assert.ok(performance.now() - first >= 30);
  gate.observe({}, { status: 429, retryAfter: '0.1' }); assert.ok(gate.remainingMs() >= 95);
  const controller = new AbortController();
  const waiting = gate.wait({ signal: controller.signal }); controller.abort();
  await assert.rejects(waiting, { code: 'REQUEST_NOT_SENT' });
  await assert.rejects(gate.wait({ deadline: Date.now() + 10 }), { code: 'REQUEST_NOT_SENT' });
});

test('桌面不同会话文件绑定同一身份后，查询也遵守该账号频率冷却', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'szu-gate-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const calls = [], transport = async url => { calls.push(performance.now()); return Response.json(
    url.pathname.includes('insertVenueBookingInfo') ? { code: 'r', msg: '操作过于频繁' } : []); };
  const a = new HttpClient({ cookies: [] }, { sessionPath: join(dir, 'a'), transport });
  const b = new HttpClient({ cookies: [] }, { sessionPath: join(dir, 'b'), transport });
  const user = `gate-${crypto.randomUUID()}`; a.bindIdentity(user); b.bindIdentity(user);
  a.getRequestGate().backoffMs = 35;
  await a.post('sportVenue/insertVenueBookingInfo.do'); await b.post('sportVenue/getRqList.do');
  assert.ok(calls[1] - calls[0] >= 30);
});

test('原生排队时间不占用网络超时，学校响应正文读取计入总耗时', async () => {
  let release, entered;
  const held = new Promise(resolve => release = resolve), ready = new Promise(resolve => entered = resolve);
  let sends = 0;
  const client = new CoreHttpClient({ cookies: [] }, { transport: nativeTransport({ async request() {
    if (++sends === 1) { entered(); await held; }
    return { status: 200, headers: {}, body: '[]' };
  } }) });
  const first = client.post('sportVenue/getRqList.do'); await ready;
  const second = client.post('sportVenue/getRqList.do', {}, { timeoutMs: 10 });
  await delay(50); release(); await first; assert.deepEqual((await second).data, []);
  const bodyClient = new CoreHttpClient({ cookies: [] }, { transport: async () => ({ status: 200, ok: true,
    headers: new Headers(), async text() { await delay(40); return '[]'; } }) });
  const response = await bodyClient.post('sportVenue/getRqList.do');
  assert.ok(response.endedAt - response.headersEndedAt >= 35);
});

test('业务归因区分个人限额、场地容量、已被他人预约、暂时繁忙和未知拒绝', () => {
  for (const message of ['场地人数达到上限', '当日场地容量达到上限', '时段容量达到上限', '该场地已被其他人预约', '该时段名额不足']) {
    assert.equal(classifyBookingResponse({ code: 'x', msg: message }).kind, 'retry', message);
  }
  for (const message of ['您今日预约次数达到上限', '每天最多预约，不能超过上限', '账户已冻结']) {
    assert.equal(classifyBookingResponse({ code: 'x', msg: message }).kind, 'account', message);
  }
  assert.equal(classifyBookingResponse({ code: 'x', msg: '系统繁忙，请稍后再试' }).scope, 'server');
  assert.equal(classifyBookingResponse({ code: 'x', msg: '达到未知规则上限' }).kind, 'rejected');
});

test('可信学校 JSON loginURL 识别为登录失效，查询保留业务码和原话', async () => {
  const client = new CoreHttpClient({ cookies: [] }, { transport: async () => Response.json({ loginURL:
    'https://authserver.szu.edu.cn/authserver/login?service=https%3A%2F%2Fehall.szu.edu.cn' }) });
  await assert.rejects(new SzuVenueApi(client).getAvailableDates(), SessionExpiredError);
  const untrusted = new CoreHttpClient({ cookies: [] }, { transport: async () => Response.json({ loginURL: 'https://example.org/login' }) });
  await assert.rejects(new SzuVenueApi(untrusted).getAvailableDates(), error => !(error instanceof SessionExpiredError));
  const api = new SzuVenueApi({ async post() { return { data: { code: '#FAIL', msg: '学校原始原因' } }; } });
  await assert.rejects(api.getAllBookings(), error => error instanceof SchoolQueryError
    && error.outcome.code === '#FAIL' && error.message.includes('学校原始原因'));
});

test('只读日期接口 JSON 登录跳转可续登，提交仍禁止自动重放', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'szu-login-json-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'session.json'); await saveSession(parseSessionText('MOD_AUTH_CAS=old; _WEU=old'), path);
  let renewals = 0, posts = 0;
  const client = await HttpClient.create({ sessionPath: path, renewSession: async () => {
    renewals++; return { identity: { id: 'a' }, session: parseSessionText('MOD_AUTH_CAS=new; _WEU=new') };
  }, transport: async (url, options) => {
    const mutation = url.pathname.includes('insertVenueBookingInfo'); if (mutation) posts++;
    return Response.json(mutation || options.headers.cookie.includes('=old')
      ? { loginURL: 'https://authserver.szu.edu.cn/authserver/login' } : [date]);
  } });
  assert.deepEqual(await new SzuVenueApi(client).getAvailableDates(), [date]); assert.equal(renewals, 1);
  await assert.rejects(client.post('sportVenue/insertVenueBookingInfo.do'), SessionExpiredError);
  assert.equal(posts, 1); assert.equal(renewals, 1);
});

test('订单分页重复 WID 即使支付状态改变，也不能证明完整', async () => {
  const api = new SzuVenueApi({ async post(_path, form) { return { data: { code: '0', datas: { myBookingInfo: {
    totalSize: 4, rows: form.pageNumber === 1 ? [{ WID: 'a' }, { WID: 'b', YYZT: 'CG_YY' }]
      : [{ WID: 'b', YYZT: 'CG_WC' }, { WID: 'c' }] } } } }; } });
  await assert.rejects(api.getAllBookings(), /重复返回预约记录/);
});

test('原生发送记录合并稳定场地 ID，不能把同名 B 误认成未知请求 A 成功', async () => {
  const id = crypto.randomUUID(), runId = crypto.randomUUID();
  const state = { version: 1, accounts: [], plans: [], runs: [{ id: runId, status: 'booking', dispatchJournalVersion: 1,
    pendingRequests: { [id]: { requestId: id, date, time, court: '同名场', accountId: 'a', state: 'in_flight' } }, successes: [] }] };
  const marker = { runId, requestId: id, date, time, courtId: 'A', venueCode: 'v', sportCode: '001', campusCode: '1', modeCode: '1.0', accountId: 'a', sentAt: NOW };
  const device = { async readState() { return { value: JSON.stringify(state), dispatchedRequests: { [id]: marker }, dispatchJournalAvailable: true }; }, async writeState() {} };
  const store = new MobileStore(device); await store.load();
  const pending = pendingMobileRequests(store.state.runs[0]); assert.equal(pending[0].courtId, 'A');
  const review = reviewBookings({ plan: { date, times: [time], courts: ['*'], bookingGoal: 'one' }, target: { ...target, courtNames: null }, pending,
    rows: [{ YYRQ: date, KYYSJD: time, CDWID: 'B', CDMC: '同名场', XMDM: '001', YYZT: 'CG_YY' }] });
  assert.equal(review.resolvedRequests.length, 0); assert.ok(review.unresolved.length);
  state.runs[0].pendingRequests[id].courtId = 'CONFLICT';
  await assert.rejects(new MobileStore(device).load(), /不一致/);
  assert.equal(reviewRequestMatches({ date, time, courtId: 'A', venueCode: 'v' }, { date, time, courtId: 'A', venueCode: 'other' }), false);
});

test('桌面两段预热分别保留，到点都复用原意图', async t => {
  const releaseAt = Date.parse('2026-10-15T12:30:00+08:00');
  t.mock.timers.enable({ apis: ['Date'], now: releaseAt - 10000 });
  const dir = await mkdtemp(join(tmpdir(), 'szu-prewarm-')); t.after(() => rm(dir, { recursive: true, force: true }));
  await writeJson(join(dir, 'job.json'), { id: crypto.randomUUID(), mode: 'release', releaseAt,
    sessionPath: 'unused', config: { targets: [{ ...target, date, campus: '粤海校区', sport: '羽毛球', mode: '包场',
      venues: ['东馆'], courts: ['A'], times: [time, '20:00-21:00'], bookingGoal: 'two' }],
    scheduler: { timeoutMs: 5000, pollIntervalMs: 100, queryConcurrency: 1 }, booking: {} } });
  await writeJson(join(dir, 'state.json'), { logs: [], successes: [] });
  const prepared = {}, sent = {}; const controller = new AbortController();
  const api = { async getIdentity() { return { id: 'user' }; }, async sampleServerOffset() { return 0; },
    async getSportVenueData() { return { campusList: [{ XQDM: '1', XQDM_DISPLAY: '粤海校区' }],
      xmList: [{ XQDM: '1', XMDM: '001', XMMC: '羽毛球', DCFS: '1.0' }],
      packageVenueList: [{ SSXQ: '1', XM: '001', CGBM: 'v', CGMC: '东馆' }] }; },
    async getAllBookings() { return []; }, async getOpeningRooms() { return [room()]; },
    async book(input) { sent[input.time] = (await readJson(join(dir, 'state.json'))).pendingRequests[`${date}|${input.time}`].attemptId;
      return { code: '0' }; } };
  const work = executeJob(dir, { manualStart: true, stopSignal: controller.signal,
    createApi: async () => ({ api, client: { async flush() {} } }) });
  let stopped = false; work.finally(() => { stopped = true; });
  for (let i = 0; i < 300 && !Object.keys(prepared).length && !stopped; i++) {
    const state = await readJson(join(dir, 'state.json'));
    const intents = Object.values(state.pendingRequests ?? {});
    if (intents.length === 2) for (const intent of intents) prepared[intent.time] = intent.attemptId;
    else await delay(5);
  }
  if (Object.keys(prepared).length === 2) t.mock.timers.setTime(releaseAt + 1); else controller.abort();
  await work;
  assert.equal(Object.keys(prepared).length, 2); assert.deepEqual(sent, prepared);
  assert.equal((await readJson(join(dir, 'state.json'))).status, 'success');
});

test('人工登录入口使用可见 Edge 和统一 9335 端口', async () => {
  assert.equal(browserCdpPort('edge', 'linux', true), 9335);
  const launcher = await readFile(new URL('../scripts/open-login.js', import.meta.url), 'utf8');
  assert.match(launcher, /edgeScript, 'preview', url/);
});
