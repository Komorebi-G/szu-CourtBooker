import assert from 'node:assert/strict';
import test from 'node:test';
import { readCourtCatalog } from '../shared/catalog.js';
import { classifyBookingResponse, executionStatus } from '../shared/booking-outcome.js';
import { SzuVenueApi } from '../shared/api.js';
import { BookingQuota } from '../shared/booking-quota.js';
import { executionIntent, runBooking } from '../shared/runner.js';
import { addDays, shanghaiDate } from '../shared/utils.js';

const target = (overrides = {}) => ({ name: '测试', targetIndex: 0, campusCode: '1', sportCode: '001',
  modeCode: '1.0', venues: [{ CGBM: 'v', CGMC: '东馆' }], courtNames: ['A', 'B'],
  times: ['19:00-20:00', '20:00-21:00'], ...overrides });
const room = (id) => ({ WID: id, CDMC: id, CGBM: 'v', XMDM: '001', XQDM: '1' });
const fixture = (api, overrides = {}) => ({ api, client: { async flush() {} },
  config: { scheduler: { queryConcurrency: 1, timeoutMs: 500, pollIntervalMs: 2, pollJitterMs: 0 },
    booking: { taskConcurrency: 1 } }, targets: [target(overrides)], date: addDays(shanghaiDate(), 1),
  immediate: true, live: true, log() {} });

test('跨时段合并场地并恢复用户优先级', async () => {
  const catalog = await readCourtCatalog({ target: target(), date: shanghaiDate(),
    api: { async getOpeningRooms({ time }) { return time.startsWith('19:') ? [room('B')] : [room('A'), room('B')]; } } });
  assert.deepEqual(catalog.rooms.map((r) => r.WID), ['A', 'B']);
  assert.deepEqual(catalog.roomsByTime['19:00-20:00'].map((r) => r.WID), ['B']);
  assert.deepEqual(catalog.roomsByTime['20:00-21:00'].map((r) => r.WID), ['A', 'B']);
});

test('目录查询中停止，不继续发送下一个时段', async () => {
  const controller = new AbortController(); let calls = 0;
  await assert.rejects(readCourtCatalog({ target: target(), date: shanghaiDate(), signal: controller.signal,
    api: { async getOpeningRooms() { calls++; controller.abort(); return []; } } }), /abort/i);
  assert.equal(calls, 1);
});

test('学校返回成功码但缺少场地数组，不能当作空目录', async () => {
  const api = new SzuVenueApi({ async post() { return { data: { code: '0' } }; } });
  await assert.rejects(api.getOpeningRooms({ date: shanghaiDate(), time: '19:00-20:00' }), /场地接口响应格式异常/);
});

test('空目录恢复后才尝试预约', async () => {
  let queries = 0, submitted = 0;
  const args = fixture({ async getOpeningRooms() { return ++queries <= 2 ? [] : [room('A')]; },
    async book() { submitted++; return { code: '0' }; } }, { times: ['19:00-20:00'] });
  const result = await runBooking(args);
  assert.equal(result.ok, true); assert.equal(submitted, 1); assert.ok(queries >= 3);
});

test('单个时段过期后不下单，其他时段继续', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-09-27T19:00:01+08:00') });
  const attempts = [];
  const args = fixture({ async getOpeningRooms() { return [room('A')]; },
    async book({ time }) { attempts.push(time); return { code: '0' }; } }, { courtNames: ['A'] });
  args.date = '2026-09-27';
  assert.equal((await runBooking(args)).successes.length, 1);
  assert.deepEqual(attempts, ['20:00-21:00']);
});

test('排队期间时段过期后不再提交，且显示部分成功', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-09-27T19:59:59+08:00') });
  const attempts = [];
  const args = fixture({ async getOpeningRooms() { return [room('A')]; },
    async book({ time }) { attempts.push(time); t.mock.timers.tick(3_601_000); return { code: '0' }; } },
  { times: ['20:00-21:00', '21:00-22:00'], courtNames: ['A'] });
  args.date = '2026-09-27'; args.config.scheduler.timeoutMs = 7_200_000;
  const result = await runBooking(args);
  assert.deepEqual(attempts, ['20:00-21:00']);
  assert.deepEqual(result.expiredTimes, ['21:00-22:00']);
  assert.equal(executionStatus(result), 'partial');
});

test('全部候选时段过期时不读目录、不下单并显示过期', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-09-27T21:00:01+08:00') });
  let queries = 0;
  const args = fixture({ async getOpeningRooms() { queries++; return [room('A')]; },
    async book() { throw new Error('不得下单'); } }, { times: ['19:00-20:00'], courtNames: ['A'] });
  args.date = '2026-09-27';
  const result = await runBooking(args);
  assert.equal(queries, 0);
  assert.equal(executionStatus(result), 'expired');
});

test('共享上限跳过的方案零成功，状态不是成功', async () => {
  const quota = new BookingQuota(); const args = fixture({ async getOpeningRooms() { return [room('A')]; },
    async book() { throw new Error('不得下单'); } }, { times: ['19:00-20:00'], courtNames: ['A'] });
  const key = quota.key('current', '001', args.date);
  quota.seed(key, '17:00-18:00'); quota.seed(key, '18:00-19:00');
  const result = await runBooking({ ...args, quota });
  assert.equal(result.ok, false); assert.equal(result.limited, true);
  assert.equal(executionStatus(result), 'limited');
});

test('明确业务拒绝分类，未知拒绝停止而不是不断重试', async () => {
  assert.equal(classifyBookingResponse({ code: '1', msg: '满场' }).kind, 'retry');
  assert.equal(classifyBookingResponse({ code: '1', msg: '时段已开始' }).kind, 'expired');
  assert.equal(classifyBookingResponse({ code: '1', msg: '账号冻结' }).kind, 'account');
  assert.equal(classifyBookingResponse({ code: '1', msg: '请人工处理' }).kind, 'rejected');
  let submissions = 0;
  const args = fixture({ async getOpeningRooms() { return [room('A')]; },
    async book() { submissions++; return { code: '1', msg: '请人工处理' }; } },
  { times: ['19:00-20:00'], courtNames: ['A'] });
  const result = await runBooking(args);
  assert.equal(submissions, 1); assert.match(result.error, /人工处理/);
});

test('确认后跨过放号时间，仍保留本次执行意图', () => {
  const before = Date.parse('2026-09-27T12:29:59+08:00');
  const after = Date.parse('2026-09-27T12:30:01+08:00');
  assert.equal(executionIntent('release', '2026-09-28', { confirmedAt: before, now: after,
    durationMs: 60000 }).mode, 'release');
  assert.throws(() => executionIntent('release', '2026-09-28', { confirmedAt: before,
    now: after + 60000, durationMs: 60000 }), /错过/);
  assert.equal(executionIntent('auto', '2026-09-28', { confirmedAt: before, now: after }).mode, 'release');
  assert.equal(executionIntent('auto', '2026-09-27', { confirmedAt: before, now: after }).mode, 'now');
});
