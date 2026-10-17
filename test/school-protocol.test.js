import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SzuVenueApi } from '../shared/api.js';
import { CoreHttpClient } from '../shared/http-client-core.js';
import { schoolBookingScope } from '../shared/booking-review.js';
import { SchoolQueryError, SessionExpiredError } from '../shared/errors.js';
import { classifyBookingResponse } from '../shared/booking-outcome.js';
import { createConnection } from '../mobile/src/school.js';
import { AccountStore } from '../desktop/src/accounts.js';
import { HttpClient } from '../desktop/src/http-client.js';
import { BookingQuota } from '../shared/booking-quota.js';

// Expected dates, ranges and cancellation semantics come from the archived
// school response and the school's myBooking.js, independently of this parser.
const fixture = JSON.parse(await readFile(new URL('./fixtures/school-orders-redacted.json', import.meta.url), 'utf8'));
const target = { sportCode: '001', sportName: '羽毛球' };
test('原始学校订单回放：原生取消码、完整日期范围与历史已完成订单', () => {
  assert.equal(fixture.rows.length, 8);
  const october12 = schoolBookingScope({ date: '2026-10-12', target, rows: fixture.rows });
  assert.deepEqual(october12.bookings.map(row => row.time), ['18:00-19:00', '19:00-20:00']);
  assert.deepEqual(october12.unresolved, []);
  assert.equal(schoolBookingScope({ date: '2026-10-06', target, rows: fixture.rows }).bookings.length, 3);
  for (const date of ['2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16']) {
    assert.deepEqual(schoolBookingScope({ date, target, rows: fixture.rows }), { bookings: [], unresolved: [] });
  }
});

test('所有只读查询保留学校业务码与原始拒绝理由，校时也不能吞掉过频响应', async () => {
  const api = new SzuVenueApi({ async post() { return { data: { code: '#E111080000000', msg: '操作过于频繁，请稍后再试！' } }; } });
  const input = { campusCode: '1', sportCode: '001', venueCode: 'v', time: '19:00-20:00', date: '2026-10-16' };
  for (const query of [() => api.getSportVenueData(), () => api.getAvailableDates(), () => api.getTimeList(input),
    () => api.getOpeningRooms(input), () => api.getAllBookings(), () => api.sampleServerClock()]) {
    await assert.rejects(query(), error => error instanceof SchoolQueryError && error.outcome.code === '#E111080000000'
      && error.outcome.scope === 'rate' && error.message.includes('操作过于频繁'));
  }
});

test('只读业务登录失效可进入恢复流程，明确提交拒绝仍作为已知业务结果', async () => {
  const data = { code: 'AUTH_EXPIRED', msg: '用户未登录，请重新登录' };
  const client = new CoreHttpClient({ cookies: [] }, { transport: async () => Response.json(data) });
  await assert.rejects(client.post('sportVenue/getRqList.do', {}, { abortInFlight: true }), SessionExpiredError);
  assert.deepEqual((await client.post('sportVenue/insertVenueBookingInfo.do')).data, data);
  assert.equal(classifyBookingResponse(data).kind, 'account');
});

test('明确 HTTP 429 是频率拒绝：HTML 正文不误报登录过期或未知订单，原始业务理由保留', async () => {
  for (const response of [() => new Response('<html>Too Many Requests</html>', { status: 429,
    headers: { 'content-type': 'text/html', 'retry-after': '2' } }),
    () => Response.json({ code: '#E111080000000', msg: '操作过于频繁，请稍后再试！' }, { status: 429 })]) {
    const client = new CoreHttpClient({ cookies: [] }, { transport: async () => response() });
    const api = new SzuVenueApi(client); api.identity = { id: 'local-test', name: '本地测试' };
    const result = await api.book({ date: '2026-10-16', time: '19:00-20:00', modeCode: '1.0',
      room: { WID: 'A', CGBM: 'v', XMDM: '001', XQDM: '1' } });
    assert.equal(classifyBookingResponse(result).scope, 'rate');
    assert.equal(result.requestTiming.httpStatus, 429);
    if (result.schoolCode) assert.equal(result.msg, '操作过于频繁，请稍后再试！');
    await assert.rejects(api.getAvailableDates(), error => error instanceof SchoolQueryError && error.outcome.scope === 'rate');
  }
});

test('个人可预约时段名额上限不能因包含“时段名额”而当成场地容量', () => {
  for (const message of ['个人可预约时段名额达到上限', '您今日可预约时段名额不足', '用户预约次数达到上限']) {
    assert.equal(classifyBookingResponse({ code: 'x', msg: message }).kind, 'account', message);
  }
  assert.equal(classifyBookingResponse({ code: 'x', msg: '当日场地人数达到上限' }).kind, 'retry');
});

test('手机新连接的首次身份查询也服从原学校账号冷却，其他账号不受影响', async () => {
  let calls = 0;
  const device = { async request() { calls++; return { status: 200, headers: {},
    body: 'USERID=\'B\';USER_INFO={"userName":"另一账号"};APP_TITLE=' }; } };
  const store = { async save() {} }, session = { cookies: [], userAgent: 'protocol-test' };
  const account = { id: 'a', userId: 'A', session };
  const original = createConnection(store, device, account);
  original.client.bindIdentity('A'); original.api.getRequestGate().reject('操作过于频繁，请稍后再试！');
  const fresh = createConnection(store, device, account);
  await assert.rejects(fresh.api.getIdentity({ deadline: Date.now() + 20 }), { code: 'REQUEST_NOT_SENT' });
  assert.equal(calls, 0, '冷却中的新连接不能先发送身份查询');
  const other = createConnection(store, device, { id: 'b', userId: 'B', session });
  assert.equal((await other.api.getIdentity()).id, 'B'); assert.equal(calls, 1);
});

test('桌面重新验证登录的首次查询也服从已绑定账号冷却', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'szu-cooldown-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const accounts = new AccountStore({ dataDir: dir, legacySessionPath: join(dir, 'session.json') });
  await accounts.import('default', 'MOD_AUTH_CAS=fake; _WEU=fake');
  const userId = crypto.randomUUID(); await accounts.setMetadata('default', { name: '冷却账号', userId });
  const original = new HttpClient({ cookies: [] }, { expectedUserId: userId });
  original.getRequestGate().reject('操作过于频繁，请稍后再试！');
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++;
    return new Response(`USERID='${userId}';USER_INFO={"userName":"测试账号"};APP_TITLE=`); });
  await assert.rejects(accounts.verify('default', { deadline: Date.now() + 20 }), { code: 'REQUEST_NOT_SENT' });
  assert.equal(calls, 0, '重新验证不能绕过同账号先前的拒绝冷却');
});

test('完整学校快照中的取消订单释放旧占用，本批次成功不被延迟列表抹去', () => {
  const quota = new BookingQuota(), key = quota.key('A', '001', '2026-10-12');
  const seedSnapshot = rows => quota.replaceSchoolBookings(key,
    schoolBookingScope({ date: '2026-10-12', target, rows }).bookings.map(slot => ({ time: slot.time,
      room: { WID: slot.courtId, CDMC: slot.court }, response: { code: '0' } })));
  seedSnapshot(fixture.rows); assert.equal(quota.remaining(key), 0);
  // This is the school's original cancelled row, paired with a locally
  // confirmed submission that a delayed school list has not included yet.
  quota.seed(key, '20:00-21:00', { room: { WID: 'local-success', CDMC: '本批次场地' }, response: { code: '0' } });
  seedSnapshot(fixture.rows.filter(row => row.YYZT === 'CG_QX'));
  assert.equal(quota.get(key, '18:00-19:00'), undefined);
  assert.equal(quota.get(key, '19:00-20:00'), undefined);
  assert.equal(quota.get(key, '20:00-21:00').room.WID, 'local-success');
  assert.equal(quota.remaining(key), 1);
});
