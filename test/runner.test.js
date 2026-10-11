import assert from 'node:assert/strict';
import test from 'node:test';
import { runBooking } from '../shared/runner.js';
import { addDays, shanghaiDate } from '../shared/utils.js';
import { BookingQuota } from '../shared/booking-quota.js';

test('共用执行器：首单结果未知后，共享名额队列内的同账号方案停止提交，其他账号仍可执行', async () => {
  const quota = new BookingQuota(), calls = [];
  let release;
  const hold = new Promise((resolve) => release = resolve);
  const execute = (time, account) => runBooking({
    api: {
      async getOpeningRooms() { return [{ WID: 'court', CGBM: 'v', CDMC: '1号场' }]; },
      async book() {
        calls.push([account, time]);
        if (account === 'same') { await hold; throw new Error('响应丢失'); }
        return { code: '0' };
      },
    },
    client: { async flush() {} },
    config: { scheduler: { timeoutMs: 1000, queryConcurrency: 1, pollIntervalMs: 10 }, booking: { taskConcurrency: 1 } },
    targets: [{ name: time, targetIndex: 0, campusCode: '1', sportCode: '001', modeCode: '1.0', times: [time], venues: [{ CGBM: 'v' }], courtNames: null }],
    date: addDays(shanghaiDate(), 1), immediate: true, live: true, log() {}, quota, quotaAccount: account,
  });
  const first = execute('19:00-20:00', 'same'), second = execute('20:00-21:00', 'same');
  // Both workers reach the quota queue before the first response is lost.
  await new Promise((resolve) => setImmediate(resolve)); release();
  const results = await Promise.all([first, second]);
  assert.deepEqual(calls, [['same', '19:00-20:00']]);
  for (const result of results) { assert.equal(result.ok, false); assert.match(result.error, /结果待确认/); }
  assert.equal((await execute('19:00-20:00', 'other')).ok, true);
});

test('dry-run 验证执行计划但绝不调用下单接口', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-09-20T10:00:00+08:00') });
  let bookCalls = 0;
  const catalogDates = [];
  const api = {
    async getOpeningRooms({ date }) {
      catalogDates.push(date);
      return [{
        WID: 'court-1', CGBM: 'venue-1', CDMC: '1号场', XMDM: '001', XQDM: '1', disabled: false,
      }];
    },
    async book() {
      bookCalls += 1;
      return { code: '0' };
    },
  };
  const client = { async flush() {} };
  const config = {
    scheduler: {
      timeoutMs: 1000, queryConcurrency: 1, pollIntervalMs: 10, pollJitterMs: 0,
    },
    booking: { maxSuccesses: 1, maxSuccessesPerTarget: 1 },
  };
  const targets = [{
    name: '测试', targetIndex: 0, campusCode: '1', sportCode: '001', modeCode: '1.0',
    times: ['19:00-20:00'], venues: [{ CGBM: 'venue-1', CGMC: '测试场馆' }], courtNames: null,
  }];
  const result = await runBooking({
    api, client, config, targets, date: '2026-09-20', immediate: true, live: false, log() {},
  });
  assert.equal(result.ok, true);
  assert.equal(result.rounds, 0);
  assert.equal(bookCalls, 0);
  assert.deepEqual(catalogDates, ['2026-09-20']);
});

test('正式运行只读取一次场地信息并按顺序直接预约', async () => {
  let openingCalls = 0;
  let catalogDate;
  const attempts = [];
  const api = {
    async getOpeningRooms(input) {
      openingCalls += 1;
      catalogDate = input.date;
      return [
        { WID: 'a', CGBM: 'venue-1', CDMC: '1号场', XMDM: '001', XQDM: '1', disabled: true },
        { WID: 'b', CGBM: 'venue-1', CDMC: '2号场', XMDM: '001', XQDM: '1', disabled: true },
      ];
    },
    async book({ room }) {
      attempts.push(room.CDMC);
      return room.CDMC === '1号场' ? { code: '0', data: { DHID: 'order-1' } } : { code: '1', msg: '已满' };
    },
  };
  const client = { async flush() {} };
  const config = {
    scheduler: { timeoutMs: 1000, queryConcurrency: 1, pollIntervalMs: 10, pollJitterMs: 0 },
    booking: {
      maxSuccesses: 1, maxSuccessesPerTarget: 1, executionMode: 'serial', taskConcurrency: 2,
    },
  };
  const targets = [{
    name: '测试', targetIndex: 0, campusCode: '1', sportCode: '001', modeCode: '1.0',
    times: ['19:00-20:00'], venues: [{ CGBM: 'venue-1', CGMC: '测试场馆' }],
    courtNames: ['2号场', '1号场'],
  }];
  const result = await runBooking({
    api, client, config, targets, date: addDays(shanghaiDate(), 1), immediate: true, live: true, log() {},
  });
  assert.equal(result.ok, true);
  assert.equal(openingCalls, 1);
  assert.equal(catalogDate, addDays(shanghaiDate(), 1));
  assert.deepEqual(attempts, ['2号场', '1号场']);
});

test('倒计时前今日目录为空时，放号后按目标日期重读场地再预约', async () => {
  const date = addDays(shanghaiDate(), 1);
  const catalogDates = [], attempts = [], identityReads = [];
  const api = {
    async getOpeningRooms({ date: catalogDate }) {
      catalogDates.push(catalogDate);
      return catalogDate === date
        ? [{ WID: 'court-1', CGBM: 'venue-1', CDMC: '1号场', XMDM: '001', XQDM: '1' }]
        : [];
    },
    async sampleServerOffset() { return 0; },
    async getIdentity(options) { identityReads.push(options); return { id: 'user-1' }; },
    async book({ room }) { attempts.push(room.WID); return { code: '0' }; },
  };
  const result = await runBooking({
    api, client: { async flush() {} },
    config: { scheduler: { timeoutMs: 1000, queryConcurrency: 1, pollIntervalMs: 10 },
      booking: { taskConcurrency: 1 } },
    targets: [{ name: '测试', targetIndex: 0, campusCode: '1', sportCode: '001', modeCode: '1.0',
      times: ['19:00-20:00'], venues: [{ CGBM: 'venue-1' }], courtNames: ['court-1'] }],
    date, immediate: false, live: true, releaseAtServer: Date.now() + 30, log() {},
  });
  assert.equal(result.ok, true);
  assert.deepEqual(catalogDates, [date]);
  assert.equal(identityReads.length, 1); assert.equal(identityReads[0].refresh, true);
  assert.ok(Number.isFinite(identityReads[0].deadline));
  assert.deepEqual(attempts, ['court-1']);
});

test('首个候选时段无场地时，继续用后续时段读取场地目录', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-09-20T10:00:00+08:00') });
  const queried = [];
  const result = await runBooking({
    api: {
      async getOpeningRooms({ date, time }) {
        queried.push([date, time]);
        return time === '20:00-21:00'
          ? [{ WID: 'court-1', CGBM: 'venue-1', CDMC: '1号场' }] : [];
      },
    },
    client: { async flush() {} },
    config: { scheduler: { queryConcurrency: 1 }, booking: {} },
    targets: [{ name: '测试', targetIndex: 0, campusCode: '1', sportCode: '001', modeCode: '1.0',
      times: ['19:00-20:00', '20:00-21:00'], venues: [{ CGBM: 'venue-1' }], courtNames: ['court-1'] }],
    date: '2026-09-20', immediate: true, live: false, log() {},
  });
  assert.equal(result.ok, true);
  assert.deepEqual(queried, [['2026-09-20', '19:00-20:00'], ['2026-09-20', '20:00-21:00']]);
  assert.deepEqual(result.executionTasks.map((task) => task.rooms[0].WID), ['court-1', 'court-1']);
});

test('目标日期未放号时，检查配置可用今天其他开放时段识别场地', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-09-20T10:00:00+08:00') });
  const today = shanghaiDate(), targetDate = addDays(today, 2), queried = [];
  const result = await runBooking({
    api: {
      async getOpeningRooms({ date, time }) {
        queried.push([date, time]);
        return time === '14:00-15:00'
          ? [{ WID: 'court-1', CGBM: 'venue-1', CDMC: '1号场' }] : [];
      },
      async getTimeList({ date }) { assert.equal(date, today); return [{ CODE: '14:00-15:00' }]; },
    },
    client: { async flush() {} },
    config: { scheduler: { queryConcurrency: 1 }, booking: {} },
    targets: [{ name: '测试', targetIndex: 0, campusCode: '1', sportCode: '001', modeCode: '1.0',
      times: ['08:00-09:00'], venues: [{ CGBM: 'venue-1' }], courtNames: ['court-1'] }],
    date: targetDate, immediate: true, live: false, log() {},
  });
  assert.equal(result.ok, true);
  assert.deepEqual(queried, [[today, '08:00-09:00'], [today, '14:00-15:00']]);
});
