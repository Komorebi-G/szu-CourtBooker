import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBooking } from '../shared/runner.js';
import { BookingQuota } from '../shared/booking-quota.js';
import { SchoolQueryError } from '../shared/errors.js';
import { reviewBookings } from '../shared/booking-review.js';
import { SzuVenueApi } from '../shared/api.js';
import { HttpClient } from '../desktop/src/http-client.js';
import { saveSession, withSession } from '../desktop/src/session.js';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { addDays, shanghaiDate } from '../shared/utils.js';

const date = '2026-10-12', early = '19:00-20:00', late = '20:00-21:00';
const room = (id = 'A') => ({ WID: id, CDMC: id, CGBM: 'v', XMDM: '001', XQDM: '1' });
const target = (extra = {}) => ({ name: '测试', targetIndex: 0, campusCode: '1', sportCode: '001', sportName: '羽毛球',
  modeCode: '1.0', venues: [{ CGBM: 'v' }], courtNames: ['A'], times: [early, late], ...extra });
const row = (time, extra = {}) => ({ YYRQ: date, KYYSJD: time, XMDM: '001', YYZT_DISPLAY: '已支付', CDWID: 'A', CDMC: 'A', ...extra });
const args = (api, t = target(), extra = {}) => ({ api, client: { async flush() {} }, targets: [t], date, live: true,
  immediate: true, log() {}, config: { scheduler: { timeoutMs: 1000, pollIntervalMs: 100, pollJitterMs: 0, queryConcurrency: 3 },
    booking: { taskConcurrency: 3 } }, ...extra });
test.beforeEach((t) => t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-11T18:00:00+08:00') }));

test('连续目标和剩余名额：用独立的可行组合检查各候选集合、已有预约及并发度', async () => {
  const slots = ['18:00-19:00', early, late, '22:00-23:00'];
  const activeCases = [[], ['17:00-18:00'], [early], ['22:00-23:00'], ['18:00-19:00', early], ['18:00-19:00', late]];
  const minutes = (clock) => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3));
  const touches = (a, b) => minutes(a.split('-')[1]) === minutes(b.split('-')[0])
    || minutes(b.split('-')[1]) === minutes(a.split('-')[0]);
  for (let mask = 1; mask < 16; mask++) {
    const candidates = slots.filter((_, i) => mask & (1 << i));
    if (!candidates.some((a) => candidates.some((b) => a !== b && touches(a, b)))) continue;
    for (const active of activeCases) for (const concurrency of [1, 3]) {
      const submitted = [];
      const result = await runBooking(args({ async getOpeningRooms() { return [room()]; },
        async book({ time, beforeDispatch }) { beforeDispatch(); submitted.push(time); return { code: '0' }; } },
      target({ times: candidates, bookingGoal: 'consecutive' }), {
        loadSchoolBookings: async () => active.map((time) => row(time)),
        config: { scheduler: { timeoutMs: 1000, queryConcurrency: concurrency, pollIntervalMs: 100 }, booking: { taskConcurrency: concurrency } }
      }));
      const feasible = candidates.some((a) => candidates.some((b) => a !== b && touches(a, b)
        && active.length + Number(!active.includes(a)) + Number(!active.includes(b)) <= 2));
      const context = JSON.stringify({ candidates, active, concurrency });
      assert.equal(result.ok, feasible, context);
      assert.ok(active.length + submitted.length <= 2, context);
      assert.equal(new Set(submitted).size, submitted.length, context);
      assert.ok(submitted.every((time) => !active.includes(time)), context);
      if (!feasible) assert.equal(submitted.length, 0, '目标已不可达时不能花掉仅剩的名额：' + context);
    }
  }
});

test('目录查询账号异常阻止同作用域并发方案，其他账号继续执行', async () => {
  const quota = new BookingQuota(); let release; const firstDone = new Promise((resolve) => release = resolve), calls = [];
  const denied = runBooking(args({ async getOpeningRooms() { throw new SchoolQueryError({ kind: 'account', message: '账号冻结' }); } },
    target({ times: [early] }), { quota, loadSchoolBookings: async () => [] })).then((result) => { release(); return result; });
  const sibling = runBooking(args({ async getOpeningRooms() { await firstDone; return [room()]; },
    async book() { calls.push('同账号'); return { code: '0' }; } }, target({ times: [late] }), { quota, loadSchoolBookings: async () => [] }));
  const other = runBooking(args({ async getOpeningRooms() { return [room()]; }, async book() { calls.push('其他账号'); return { code: '0' }; } },
    target({ times: [late] }), { quota, quotaAccount: 'other', loadSchoolBookings: async () => [] }));
  const results = await Promise.all([denied, sibling, other]);
  assert.match(results[0].error, /冻结/); assert.match(results[1].error, /冻结/);
  assert.equal(results[2].ok, true); assert.deepEqual(calls, ['其他账号']);
});

test('已经排入HTTP会话队列的预约，传输前再次检查作用域停止状态', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'court-dispatch-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'session.json'); await saveSession({ userAgent: 'test', cookies: [] }, path);
  let unlock, entered, queued;
  const hold = new Promise((resolve) => unlock = resolve), lockEntered = new Promise((resolve) => entered = resolve);
  const waitingToSend = new Promise((resolve) => queued = resolve), sends = [];
  const lock = withSession(path, async () => { entered(); await hold; }); await lockEntered;
  const client = await HttpClient.create({ sessionPath: path, transport: async () => {
    sends.push('sent'); return new Response(JSON.stringify({ code: '0' }), { headers: { 'content-type': 'application/json' } });
  } });
  const api = new SzuVenueApi(client); api.identity = { id: 'test', name: '测试' }; api.getOpeningRooms = async () => [room()];
  api.sampleServerClock = undefined; // This fixture isolates the booking dispatch guard.
  const quota = new BookingQuota(), key = quota.key('current', '001', date);
  const work = runBooking(args(api, target({ times: [early] }), { client, quota, loadSchoolBookings: async () => [],
    log(_level, _message, details) { if (details?.event === 'booking_request') queued(); } }));
  await waitingToSend; quota.stop(key, '账号冻结'); unlock(); await lock;
  const result = await work;
  assert.deepEqual(sends, []); assert.equal(result.metrics.dispatched, 0); assert.match(result.error, /账号冻结/);
});

test('一个项目的订单无法确认，不阻止同一调用里其他项目的有效方案', async () => {
  const calls = [];
  const result = await runBooking(args({ async getOpeningRooms({ sportCode }) { return [{ ...room(), XMDM: sportCode }]; },
    async book({ room }) { calls.push(room.XMDM); return { code: '0' }; } }, target({ times: [early] }), {
    targets: [target({ times: [early] }), target({ targetIndex: 1, sportCode: '002', sportName: '排球', times: [late] })],
    loadSchoolBookings: async () => [row('17:00-18:00', { YYZT_DISPLAY: '未知状态' })]
  }));
  assert.deepEqual(calls, ['002']); assert.equal(result.successes.length, 1); assert.match(result.error, /人工核对/);
});

test('无关作用域仍在执行时，新启动的已结束作用域重新查询学校订单', async () => {
  const quota = new BookingQuota(); let release, entered; const hold = new Promise((resolve) => release = resolve), busy = new Promise((resolve) => entered = resolve);
  const other = runBooking(args({ async getOpeningRooms() { entered(); await hold; return [room()]; }, async book() { return { code: '0' }; } },
    target({ sportCode: '002', times: [early] }), { quota }));
  await busy;
  let reads = 0, submits = 0;
  const input = args({ async getOpeningRooms() { return [room()]; }, async book() { submits++; return { code: '0' }; } },
    target({ times: [early] }), { quota, loadSchoolBookings: async () => ++reads === 1 ? [row('17:00-18:00'), row('18:00-19:00')] : [] });
  assert.equal((await runBooking(input)).limited, true);
  assert.equal((await runBooking(input)).ok, true);
  assert.equal(reads, 2); assert.equal(submits, 1); release(); await other;
});

test('学校订单只有名称时，核对与执行按保存标签一致识别；已知不同ID不能靠同名冒充', async () => {
  for (const courtId of [undefined, 'other-id']) {
    const t = target({ courtNames: ['court-A'], courtLabels: { 'court-A': 'A' }, campusCode: '1', modeCode: '1.0' }),
      rows = [row(early, { CDWID: courtId, XQDM: 1, YYLX: 1 })], calls = [];
    const review = reviewBookings({ plan: { ...t, date, courts: ['court-A'] }, target: t, rows });
    const result = await runBooking(args({ async getOpeningRooms() { return [room('court-A')]; },
      async book({ time }) { calls.push(time); return { code: '0' }; } }, t, { loadSchoolBookings: async () => rows }));
    assert.equal(review.booked[0].matchesCourts, !courtId);
    assert.equal(result.successes.some((s) => s.reused), !courtId);
    assert.ok(!calls.includes(early)); assert.ok(calls.includes(late));
  }
});

test('同场锚点只参考当前学校有效订单，已取消订单不改变用户顺序', async () => {
  for (const status of ['已支付', '已取消']) {
    const calls = [], anchorTime = '18:00-19:00';
    const t = target({ times: [early], bookingGoal: 'one', courtNames: ['A', 'C'], preferSameCourt: true,
      sameCourtAnchor: { date, time: anchorTime, court: 'C', courtId: 'C' } });
    const result = await runBooking(args({ async getOpeningRooms() { return [room('A'), room('C')]; },
      async book({ room }) { calls.push(room.WID); return { code: '0' }; } }, t,
    { loadSchoolBookings: async () => [row(anchorTime, { YYZT_DISPLAY: status, CDWID: 'C', CDMC: 'C' })] }));
    assert.equal(result.ok, true); assert.deepEqual(calls, [status === '已支付' ? 'C' : 'A']);
  }
});

test('临近放号完成只读准备，首选请求到点发出，不再等放号后重新读取目录', async (t) => {
  const now = Date.parse('2026-10-11T12:29:50+08:00');
  t.mock.timers.reset(); t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now });
  const releaseAt = now + 10_000, events = [];
  const api = { async sampleServerOffset() { return 0; },
    async getIdentity() { events.push(['identity', Date.now()]); },
    async getOpeningRooms({ date: queriedDate }) { assert.equal(queriedDate, date); events.push(['rooms', Date.now()]); return [room('A'), room('B')]; },
    async book({ room, beforeDispatch }) { beforeDispatch(); events.push(['book:' + room.WID, Date.now()]); return { code: '0' }; } };
  const work = runBooking(args(api, target({ times: [early], courtNames: ['A', 'B'] }), { immediate: false, releaseAtServer: releaseAt,
    loadSchoolBookings: async () => { events.push(['orders', Date.now()]); return []; } }));
  await nextTurn(); t.mock.timers.tick(80); await nextTurn(); t.mock.timers.tick(80); await nextTurn();
  t.mock.timers.tick(4840); await nextTurn();
  assert.deepEqual(events.map(([type]) => type), ['identity', 'orders', 'rooms']);
  assert.ok(events.every(([, at]) => at < releaseAt));
  t.mock.timers.tick(5000); await nextTurn();
  assert.equal((await work).ok, true);
  assert.deepEqual(events.filter(([type]) => type.startsWith('book:')), [['book:A', releaseAt]]);
  assert.equal(events.filter(([type]) => type === 'rooms').length, 1);
});

test('明确未到放号时，下轮从首选A开始；单个场地未开放仍可以试B', async () => {
  for (const message of ['未到放号时间', '预约时间未到', '该场地未开放']) {
    const calls = [];
    const result = await runBooking(args({ async getOpeningRooms() { return [room('A'), room('B')]; },
      async book({ room }) { calls.push(room.WID); return { code: calls.length === 1 ? '1' : '0', msg: message }; }
    }, target({ times: [early], courtNames: ['A', 'B'] })));
    assert.equal(result.ok, true); assert.deepEqual(calls, message === '该场地未开放' ? ['A', 'B'] : ['A', 'A']);
  }
});

test('多候选放号时，提前读取后续目录，首单及第二单到点后无需查询排队', { timeout: 3000 }, async (t) => {
  t.mock.timers.reset();
  const dir = await mkdtemp(join(tmpdir(), 'court-release-priority-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'session.json'); await saveSession({ userAgent: 'test', cookies: [] }, path);
  const releaseAt = Date.now() + 400, events = [], targetDate = addDays(shanghaiDate(), 1);
  const client = await HttpClient.create({ sessionPath: path, transport: async (url, options) => {
    const json = (data) => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
    if (url.pathname.endsWith('index.do')) {
      return new Response("USERID='test';USER_INFO={\"userName\":\"测试\"};APP_TITLE='test';",
        { headers: { 'content-type': 'text/html' } });
    }
    const form = new URLSearchParams(options.body);
    if (url.pathname.endsWith('getOpeningRoom.do')) {
      const time = `${form.get('KSSJ')}-${form.get('JSSJ')}`;
      events.push({ type: 'query', time, at: Date.now() });
      if (time === late) await new Promise((resolve) => setTimeout(resolve, 60));
      return json({ code: '0', datas: { getOpeningRoom: { rows: [room()] } } });
    }
    if (url.pathname.endsWith('insertVenueBookingInfo.do')) {
      events.push({ type: 'book', time: form.get('KYYSJD'), at: Date.now() });
      return json({ code: '0' });
    }
    throw new Error(`不应调用其他学校接口：${url.pathname}`);
  } });
  const api = new SzuVenueApi(client); api.sampleServerClock = undefined; api.sampleServerOffset = async () => 0;
  const result = await runBooking(args(api, target({ preferSameCourt: false }), {
    client, date: targetDate, immediate: false, releaseAtServer: releaseAt, loadSchoolBookings: async () => []
  }));
  assert.equal(result.ok, true);
  assert.deepEqual(events.map(({ type, time }) => [type, time]), [
    ['query', early], ['query', late], ['book', early], ['book', late]
  ]);
  assert.ok(events[0].at < releaseAt, '首段目录应在放号前读完');
  assert.ok(events[1].at < releaseAt, '后段目录也应在放号前读完');
  assert.ok(events[2].at >= releaseAt, '预约只能到点发送');
  assert.equal(events.filter((event) => event.type === 'query' && event.time === early).length, 1);
});

test('已获得明确业务结果但登录状态保存失败时，保留成功或拒绝并停止作用域，不重发', async () => {
  for (const code of ['0', '1']) {
    const calls = [];
    const result = await runBooking(args({ async getOpeningRooms() { return [room('A'), room('B')]; },
      async book({ time, room, beforeDispatch }) {
        beforeDispatch(); calls.push([time, room.WID]);
        return { code, msg: code === '1' ? '已满' : undefined, persistenceError: '磁盘写入失败' };
      } }, target({ courtNames: ['A', 'B'], preferSameCourt: false }), { loadSchoolBookings: async () => [] }));
    assert.deepEqual(calls, [[early, 'A']]);
    assert.equal(result.ok, false);
    assert.equal(result.successes.length, code === '0' ? 1 : 0);
    assert.equal(result.metrics.unknown, 0);
    assert.equal(result.slots[0].lastOutcome, code === '0' ? 'success' : 'retry');
    assert.match(result.error, /登录状态保存失败.*磁盘写入失败/);
    assert.doesNotMatch(result.error, /待确认/);
  }
});
