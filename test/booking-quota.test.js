import { addDays, shanghaiDate } from '../shared/utils.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { BookingQuota } from '../shared/booking-quota.js';
import { runBooking } from '../shared/runner.js';

function fixture() {
  const calls = [];
  const room = { WID: 'A', CGBM: 'v', CDMC: 'A', XMDM: '001' };
  const target = { name: '测试', targetIndex: 0, campusCode: '1', sportCode: '001', modeCode: '1.0',
    times: ['15:00-16:00', '16:00-17:00', '17:00-18:00', '18:00-19:00'], venues: [{ CGBM: 'v' }], courtNames: ['A'] };
  const input = { api: { async getOpeningRooms() { return [room]; }, async book({ time }) { calls.push(time); return { code: '0' }; } },
    client: { async flush() {} }, config: { scheduler: { timeoutMs: 500, queryConcurrency: 1, pollIntervalMs: 100, pollJitterMs: 0 }, booking: { taskConcurrency: 4 } },
    targets: [target], date: addDays(shanghaiDate(), 1), immediate: true, live: true, log() {} };
  return { calls, input, room };
}
test('四个候选时段并发：成功两个就正常结束，不发第三单', async () => {
  const f = fixture(); const result = await runBooking(f.input);
  assert.equal(f.calls.length, 2); assert.equal(result.successes.length, 2);
  assert.equal(result.ok, true); assert.equal(result.limited, true); assert.equal(result.total, 4);
});
test('候选前两个失败仍尝试后面，不是简单截取前两个时段', async () => {
  const f = fixture();
  f.input.api.book = async ({ time }) => { f.calls.push(time); return { code: time < '17:00' ? '1' : '0', msg: '已满' }; };
  const result = await runBooking(f.input);
  assert.equal(result.ok, true); assert.deepEqual(result.successes.map((s) => s.task.time), ['17:00-18:00', '18:00-19:00']);
});
test('中断恢复：已有一个只订一个，已有两个不再提交', async () => {
  for (const count of [1, 2]) {
    const f = fixture();
    f.input.initialSuccesses = f.input.targets[0].times.slice(0, count).map((time) => ({ date: f.input.date, time, room: f.room }));
    const result = await runBooking(f.input);
    assert.equal(f.calls.length, 2 - count); assert.equal(result.ok, true); assert.equal(result.successes.length, 2);
  }
});
test('不同账号、项目、日期独立计数，失败不消耗名额', async () => {
  const quota = new BookingQuota(); let calls = 0;
  for (const key of [quota.key('a', '001', 'd1'), quota.key('b', '001', 'd1'), quota.key('a', '002', 'd1'), quota.key('a', '001', 'd2')]) {
    await quota.attempt(key, 't0', async () => ({ code: '1' }));
    const results = await Promise.all(['t1', 't2', 't3'].map((time) => quota.attempt(key, time, async () => { calls++; return { code: '0' }; })));
    assert.equal(results.filter((r) => r.code === '0').length, 2);
  }
  assert.equal(calls, 8);
});
test('同时执行的任务共享上限，新一轮不受已结束历史记录限制', async () => {
  const a = fixture(), b = fixture(), quota = new BookingQuota();
  b.input.targets[0].times = ['19:00-20:00', '20:00-21:00'];
  const results = await Promise.all([runBooking({ ...a.input, quota }), runBooking({ ...b.input, quota })]);
  assert.equal(a.calls.length + b.calls.length, 2);
  // Prompt per-slot queries may let each concurrent plan win one slot. Report
  // those plans as partial, while still enforcing the shared two-slot limit.
  assert.ok(results.every((r) => r.ok || r.limited));
  assert.equal(results.reduce((count, r) => count + r.successes.length, 0), 2);
  const fresh = fixture(); await runBooking(fresh.input); assert.equal(fresh.calls.length, 2);
});
