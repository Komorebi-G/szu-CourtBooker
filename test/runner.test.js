import assert from 'node:assert/strict';
import test from 'node:test';
import { runBooking } from '../shared/runner.js';
import { shanghaiDate } from '../shared/utils.js';

test('dry-run 验证执行计划但绝不调用下单接口', async () => {
  let bookCalls = 0;
  const api = {
    async getOpeningRooms() {
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
      return room.CDMC === '1号场' ? { code: '0', data: { DHID: 'order-1' } } : { code: '1' };
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
    api, client, config, targets, date: '2026-09-20', immediate: true, live: true, log() {},
  });
  assert.equal(result.ok, true);
  assert.equal(openingCalls, 1);
  assert.equal(catalogDate, shanghaiDate());
  assert.deepEqual(attempts, ['2号场', '1号场']);
});
