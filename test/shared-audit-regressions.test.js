import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { HttpClient } from '../desktop/src/http-client.js';
import { saveSession } from '../desktop/src/session.js';
import { SzuVenueApi } from '../shared/api.js';
import { BookingQuota } from '../shared/booking-quota.js';
import { bookingGoal, goalReached, validateBookingGoal } from '../shared/booking-goal.js';
import { HttpResponseError } from '../shared/errors.js';
import { estimateServerClock } from '../shared/server-clock.js';
import { bookingReleaseAt, executionIntent, runBooking } from '../shared/runner.js';
import { addDays, shanghaiDate } from '../shared/utils.js';

const early = '19:00-20:00', late = '20:00-21:00';
const room = (id = 'A', venue = 'v') => ({ WID: id, CDMC: id, CGBM: venue, XMDM: '001', XQDM: '1' });
const target = (extra = {}) => ({ name: '测试', targetIndex: 0, campusCode: '1', sportCode: '001', modeCode: '1.0',
  venues: [{ CGBM: 'v' }], courtNames: ['A'], times: [early, late], ...extra });
const args = (api, extra = {}) => ({ api, client: { async flush() {} }, targets: [target()],
  date: addDays(shanghaiDate(), 1), live: true, immediate: true, log() {},
  config: { scheduler: { timeoutMs: 1000, pollIntervalMs: 10, pollJitterMs: 0, queryConcurrency: 4 }, booking: { taskConcurrency: 4 } },
  ...extra });

test('真实会话 FIFO：无预热时首选查询完成就提交，慢后段不能先占队列', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'court-first-post-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const sessionPath = join(dir, 'session.json'); await saveSession({ cookies: [], userAgent: 'test' }, sessionPath);
  const events = [];
  const client = await HttpClient.create({ sessionPath, transport: async (url, options) => {
    const form = new URLSearchParams(options.body);
    if (url.pathname.endsWith('getOpeningRoom.do')) {
      const time = `${form.get('KSSJ')}-${form.get('JSSJ')}`;
      events.push('query:' + time);
      if (time === late) await new Promise((resolve) => setTimeout(resolve, 80));
      return Response.json({ code: '0', datas: { getOpeningRoom: { rows: [room()] } } });
    }
    if (url.pathname.endsWith('insertVenueBookingInfo.do')) {
      events.push('book:' + form.get('KYYSJD')); return Response.json({ code: '0' });
    }
    throw new Error('测试禁止额外网络请求：' + url.pathname);
  } });
  const api = new SzuVenueApi(client); api.identity = { id: 'test', name: 'test' };
  api.sampleServerClock = undefined;
  const result = await runBooking(args(api, { client }));
  assert.equal(result.ok, true);
  assert.deepEqual(events, ['query:' + early, 'book:' + early, 'query:' + late, 'book:' + late]);
});

test('多个场馆：真正首选已出现就提交，后来慢场馆不挡首单', async () => {
  const events = [];
  const result = await runBooking(args({ async getOpeningRooms({ venueCode }) {
    events.push('query:' + venueCode); return [room(venueCode === 'v' ? 'A' : 'B', venueCode)];
  }, async book({ room }) { events.push('book:' + room.WID); return { code: '0' }; } },
  { targets: [target({ times: [early], venues: [{ CGBM: 'v' }, { CGBM: 'slow' }], courtNames: ['A', 'B'] })] }));
  assert.equal(result.ok, true); assert.deepEqual(events, ['query:v', 'book:A']);
});

test('多个场馆：不能因先读到次选A而抢在用户首选B之前提交', async () => {
  const events = [];
  const result = await runBooking(args({ async getOpeningRooms({ venueCode }) {
    events.push('query:' + venueCode); return [room(venueCode === 'v' ? 'A' : 'B', venueCode)];
  }, async book({ room }) { events.push('book:' + room.WID); return { code: '0' }; } },
  { targets: [target({ times: [early], venues: [{ CGBM: 'v' }, { CGBM: 'later' }], courtNames: ['B', 'A'] })] }));
  assert.equal(result.ok, true); assert.deepEqual(events, ['query:v', 'query:later', 'book:B']);
});

test('首选在首个场馆失败后，后续场馆仍可补充候选，本轮不重复提交首选', async () => {
  const calls = [];
  const result = await runBooking(args({ async getOpeningRooms({ venueCode }) { return [room(venueCode === 'v' ? 'A' : 'B', venueCode)]; },
    async book({ room }) { calls.push(room.WID); return { code: room.WID === 'B' ? '0' : '1', msg: '已满' }; }
  }, { targets: [target({ times: [early], venues: [{ CGBM: 'v' }, { CGBM: 'later' }], courtNames: ['A', 'B'] })] }));
  assert.equal(result.ok, true); assert.deepEqual(calls, ['A', 'B']);
});

test('全局未放号只暂停当前轮，下轮重新从首选开始，不浪费其他时段提交', async () => {
  const calls = [];
  const result = await runBooking(args({ async getOpeningRooms() { return [room()]; }, async book({ time }) {
    calls.push(time); return calls.length === 1 ? { code: '1', msg: '预约时间未到' } : { code: '0' };
  } }));
  assert.equal(result.ok, true); assert.deepEqual(calls, [early, early, late]);
  assert.equal(result.metrics.wait, 1);
});

test('预约核对 503 可在准备截止前重试，成功后才允许提交', async () => {
  let reads = 0, posts = 0;
  const result = await runBooking(args({ async getOpeningRooms() { return [room()]; }, async book() { posts++; return { code: '0' }; } }, {
    targets: [target({ times: [early], bookingGoal: 'one' })],
    loadSchoolBookings: async () => { if (++reads === 1) throw new HttpResponseError(503, '/orders'); return []; }
  }));
  assert.equal(result.ok, true); assert.equal(reads, 2); assert.equal(posts, 1);
});

test('核对失败的重试有次数和截止限制，未知业务数据不能按网络故障重试', async () => {
  for (const [timeoutMs, expectedReads, makeError] of [
    [1000, 3, () => new HttpResponseError(503, '/orders')],
    [80, 1, () => new HttpResponseError(503, '/orders')],
    [1000, 1, () => new Error('学校记录格式异常')],
  ]) {
    let reads = 0, posts = 0;
    const input = args({ async getOpeningRooms() { return [room()]; }, async book() { posts++; return { code: '0' }; } }, {
      targets: [target({ times: [early], bookingGoal: 'one' })], loadSchoolBookings: async () => { reads++; throw makeError(); }
    });
    input.config.scheduler.timeoutMs = timeoutMs;
    const result = await runBooking(input);
    assert.equal(result.ok, false); assert.equal(reads, expectedReads); assert.equal(posts, 0);
  }
});

test('同作用域并行核对共享一次重试过程，取消期间不发下一次只读查询', async () => {
  const quota = new BookingQuota(); let reads = 0;
  const load = async () => { if (++reads === 1) throw new HttpResponseError(503, '/orders'); return 'ok'; };
  const first = quota.prepare('scope', load, { retryDelayMs: 1 });
  assert.equal(quota.prepare('scope', load), first);
  assert.equal(await first, 'ok'); assert.equal(reads, 2); assert.equal(quota.error('scope'), undefined);
  const controller = new AbortController(); let cancelledReads = 0;
  const cancelled = quota.prepare('cancelled', async () => { cancelledReads++; throw new HttpResponseError(503, '/orders'); },
    { signal: controller.signal, onRetry: () => controller.abort() });
  await assert.rejects(cancelled, { name: 'AbortError' }); assert.equal(cancelledReads, 1);
});

test('显式任意两段要求两个不同候选，旧单段与核对后的单段保持一段目标', () => {
  for (const times of [[early], [early, early]]) {
    assert.throws(() => validateBookingGoal({ times, bookingGoal: 'two' }), /两个不同/);
    assert.equal(goalReached({ times, bookingGoal: 'two' }, new Set([early])), false);
    assert.equal(validateBookingGoal({ times }), 'one');
    assert.equal(bookingGoal({ times }), 'one');
    assert.equal(goalReached({ times }, new Set([early])), true);
  }
  assert.equal(validateBookingGoal({ times: [early], bookingGoal: 'one' }), 'one');
});

test('任意两段不能只有重叠候选；有不重叠组合即可执行，任选一段允许重叠备选', async () => {
  const overlapping = ['15:00-16:00', '15:30-16:30', '15:45-16:45'];
  assert.throws(() => validateBookingGoal({ times: overlapping, bookingGoal: 'two' }), /互不重叠/);
  assert.equal(validateBookingGoal({ times: overlapping, bookingGoal: 'one' }), 'one');
  assert.equal(validateBookingGoal({ times: ['15:00-16:00', '16:00-17:00'], bookingGoal: 'two' }), 'two');
  let queries = 0; const calls = [];
  const api = { async getOpeningRooms() { queries++; return [room()]; },
    async book({ time }) { calls.push(time); return { code: '0' }; } };
  const rejected = await runBooking(args(api, { targets: [target({ bookingGoal: 'two', times: overlapping })] }));
  assert.equal(rejected.ok, false); assert.match(rejected.error, /互不重叠/); assert.equal(queries, 0); assert.equal(calls.length, 0);
  const reachable = await runBooking(args(api, { targets: [target({ bookingGoal: 'two', times: [...overlapping, '17:00-18:00'] })] }));
  assert.equal(reachable.ok, true); assert.deepEqual(calls, ['15:00-16:00', '17:00-18:00']);
});

test('末次网络或无效 Date 不抹掉此前有效校时交集', async () => {
  for (const invalid of [false, true]) {
    let now = 10010, calls = 0;
    const estimate = await estimateServerClock({ async sampleServerClock() {
      calls++;
      if (calls === 5 && !invalid) throw new TypeError('network');
      const startedAt = now; now += 40;
      return { startedAt, endedAt: now, serverDateMs: calls === 5 && invalid ? NaN : Math.floor((startedAt + 30020) / 1000) * 1000 };
    } }, { now: () => now, pause: async (ms) => { now += ms; } });
    assert.equal(estimate.reliable, true); assert.equal(estimate.partial, true); assert.equal(estimate.sampleCount, 4);
    assert.ok(estimate.lowerOffsetMs <= 30000 && estimate.upperOffsetMs > 30000);
    assert.equal(estimate.sampleFailure, invalid ? 'missing_or_invalid_date' : 'sample_failed');
  }
});

test('本机快30秒误选立即模式时仍等待学校放号，执行窗口不提前耗尽', async (t) => {
  const date = '2026-10-12', release = bookingReleaseAt(date), localStart = release + 5000;
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: localStart });
  assert.equal(executionIntent('auto', date).mode, 'now');
  const calls = [], clockSamples = [];
  const api = { async sampleServerClock() {
    const startedAt = Date.now(); clockSamples.push(startedAt);
    return { startedAt, endedAt: startedAt + 20, serverDateMs: Math.floor((startedAt - 30000) / 1000) * 1000 };
  }, async getOpeningRooms() { return [room()]; }, async getIdentity() { return { id: 'test' }; },
  async book() { calls.push(Date.now()); return Date.now() - 30000 < release ? { code: '1', msg: '预约时间未到' } : { code: '0' }; } };
  const controller = new AbortController();
  const input = args(api, { date, targets: [target({ times: [early], bookingGoal: 'one' })], signal: controller.signal,
    releaseAtServer: executionIntent('auto', date).releaseAt });
  input.config.scheduler.timeoutMs = 20000;
  let settled = false; const work = runBooking(input).finally(() => { settled = true; });
  for (let elapsed = 0; elapsed <= 40000 && !settled; elapsed += 100) {
    await nextTurn(); t.mock.timers.tick(100);
  }
  if (!settled) { controller.abort(); await nextTurn(); }
  const result = await work;
  assert.equal(result.ok, true, JSON.stringify(result)); assert.ok(clockSamples.length >= 5);
  assert.ok(calls[0] >= localStart + 24000, '校时后才进入实际放号附近');
  assert.ok(calls.at(-1) - 30000 >= release, '至少一单在学校真正放号后成功');
});

test('场地缺失项目和校区时使用查询参数，明确不一致时禁止提交', async () => {
  let rows = [{ WID: 'A', CDMC: 'A', CGBM: 'v' }];
  const api = new SzuVenueApi({ async post() { return { data: { code: '0', datas: { getOpeningRoom: { rows } } } }; } });
  const input = { campusCode: '1', sportCode: '001', venueCode: 'v', modeCode: '1.0', time: early, date: '2026-10-12' };
  assert.deepEqual(await api.getOpeningRooms(input), [room()]);
  rows = [{ ...room(), XQDM: 1 }];
  assert.deepEqual(await api.getOpeningRooms(input), [room()]);
  for (const extra of [{ XMDM: 'other' }, { XQDM: 'other' }, { XMDM: '' }, { XQDM: '' }]) {
    rows = [{ WID: 'A', CDMC: 'A', CGBM: 'v', ...extra }]; await assert.rejects(api.getOpeningRooms(input), /项目或校区/);
  }
});

test('校时同样修正时段开始边界：本机快30秒不提前跳过，慢30秒不提交已开始时段', async (t) => {
  for (const offsetMs of [-30000, 30000]) {
    const date = '2026-10-12', slotStart = Date.parse(`${date}T19:00:00+08:00`);
    const localStart = slotStart + (offsetMs < 0 ? 10000 : -10000);
    t.mock.timers.reset(); t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: localStart });
    const calls = [];
    const api = { async sampleServerClock() {
      const startedAt = Date.now(); return { startedAt, endedAt: startedAt + 20,
        serverDateMs: Math.floor((startedAt + offsetMs) / 1000) * 1000 };
    }, async getIdentity() {}, async getOpeningRooms() { return [room()]; },
    async book({ deadline }) { calls.push({ at: Date.now(), deadline }); return { code: '0' }; } };
    const controller = new AbortController();
    let settled = false;
    const work = runBooking(args(api, { date, signal: controller.signal,
      targets: [target({ times: [early], bookingGoal: 'one' })] })).finally(() => { settled = true; });
    for (let elapsed = 0; elapsed < 5000 && !settled; elapsed += 100) { await nextTurn(); t.mock.timers.tick(100); }
    if (!settled) { controller.abort(); await nextTurn(); }
    const result = await work;
    if (offsetMs < 0) {
      assert.equal(result.ok, true); assert.equal(calls.length, 1);
      assert.ok(calls[0].deadline > slotStart, 'POST截止应换算到快30秒的本机时钟');
    } else { assert.equal(result.expired, true); assert.equal(calls.length, 0); }
  }
});

test('正式提交前参数或身份校验失败明确属于未发送，身份读取继承取消与截止', async () => {
  let calls = 0, passed;
  const api = new SzuVenueApi({ async get(_path, options) { passed = options; throw new TypeError('identity network'); }, async post() { calls++; } });
  const input = { date: '2026-10-12', time: early, room: room(), modeCode: '1.0', deadline: Date.now() + 500,
    signal: new AbortController().signal, requestId: 'test' };
  await assert.rejects(api.book({ ...input, room: { WID: 'A' } }), { code: 'REQUEST_NOT_SENT' });
  await assert.rejects(api.book(input), { code: 'REQUEST_NOT_SENT' });
  assert.equal(calls, 0); assert.equal(passed.signal, input.signal); assert.equal(passed.deadlineMs, input.deadline);
});

test('分页部分重叠也不能当作完整学校订单，仅比较整页不足以发现缺记录', async () => {
  const a = { YYRQ: '2026-10-12', KYYSJD: early, XMDM: '001', YYZT_DISPLAY: '已支付' };
  const b = { ...a, KYYSJD: late }, c = { ...a, KYYSJD: '21:00-22:00' };
  const api = new SzuVenueApi({ async post(_path, form) {
    return { data: { code: '0', datas: { myBookingInfo: { totalSize: 4, rows: form.pageNumber === 1 ? [a, b] : [b, c] } } } };
  } });
  await assert.rejects(api.getAllBookings(), /重复返回预约记录/);
});

test('最后 Cookie 保存失败仍返回学校已知成功与统计，不降成未知或丢掉停止标记', async () => {
  for (const stopAfterResponse of [false, true]) {
    const controller = new AbortController();
    const result = await runBooking(args({ async getOpeningRooms() { return [room()]; }, async book() {
      if (stopAfterResponse) controller.abort(); return { code: '0', data: { DHID: 'known-order' } };
    } }, { signal: controller.signal, targets: [target({ times: [early], bookingGoal: 'one' })],
      client: { async flush() { throw new Error('disk full'); } } }));
    assert.equal(result.ok, false); assert.equal(result.successes.length, 1);
    assert.equal(result.successes[0].response.data.DHID, 'known-order');
    assert.equal(result.metrics.successes, 1); assert.equal(result.metrics.unknown, 0);
    assert.equal(Boolean(result.stopped), stopAfterResponse); assert.equal(result.persistenceError, 'disk full');
    assert.match(result.error, /登录状态保存失败/); assert.doesNotMatch(result.error, /结果待确认/);
  }
});

test('学校已约邻段只有场地名称时，同场偏好用唯一匹配名称，不猜同名场馆', async () => {
  for (const ambiguous of [false, true]) {
    const calls = [];
    const result = await runBooking(args({ async getOpeningRooms({ venueCode }) {
      return venueCode === 'v' ? [room('A'), room('C')] : [room('other-C', 'other')].map((r) => ({ ...r, CDMC: 'C' }));
    }, async book({ room }) { calls.push(room.WID); return { code: '0' }; } }, {
      targets: [target({ preferSameCourt: true, courtNames: ['A', 'C'], includeOtherCourts: true,
        venues: ambiguous ? [{ CGBM: 'v' }, { CGBM: 'other' }] : [{ CGBM: 'v' }] })],
      loadSchoolBookings: async () => [{ YYRQ: addDays(shanghaiDate(), 1), KYYSJD: early, XMDM: '001', YYZT_DISPLAY: '已支付', CDMC: 'C' }]
    }));
    assert.equal(result.ok, true); assert.deepEqual(calls, [ambiguous ? 'A' : 'C']);
  }
});
