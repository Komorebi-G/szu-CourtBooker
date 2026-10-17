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

test('停止共享学校核对的发起预约，不连带停止另一个预约', async () => {
  const first = fixture(), second = fixture(), quota = new BookingQuota(), controller = new AbortController();
  let started;
  const querying = new Promise(resolve => { started = resolve; });
  const stopped = runBooking({ ...first.input, quota, signal: controller.signal,
    loadSchoolBookings: ({ signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      started();
    }) });
  await querying;
  let freshQueries = 0;
  const continued = runBooking({ ...second.input, quota, loadSchoolBookings: async () => { freshQueries++; return []; } });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort(new Error('仅停止第一个预约'));
  const [a, b] = await Promise.all([stopped, continued]);
  assert.equal(a.stopped, true);
  assert.equal(first.calls.length, 0);
  assert.equal(b.ok, true);
  assert.equal(second.calls.length, 2);
  assert.equal(freshQueries, 1);
});

test('共享订单核对的业务错误仍停止作用域，不被其他预约重试绕过', async () => {
  const quota = new BookingQuota(); let queries = 0;
  const load = async () => { queries++; throw new Error('学校订单状态未知'); };
  const outcomes = await Promise.allSettled([quota.prepare('scope', load), quota.prepare('scope', load)]);
  assert.ok(outcomes.every(result => result.status === 'rejected'));
  assert.equal(queries, 1);
  assert.equal(quota.error('scope'), '学校订单状态未知');
});

const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };

test('旧并发参数不能启用双单：首单完整返回后才发次单，成功两段不发第三单', async () => {
  const quota = new BookingQuota(), release = deferred(); let sent = 0;
  const work = ['12:00-13:00', '13:00-14:00', '14:00-15:00'].map(time => quota.attempt('scope', time,
    async () => { sent++; await release.promise; return { code: '0' }; }, { parallel: true }));
  assert.equal(sent, 1); release.resolve();
  assert.deepEqual((await Promise.all(work)).map(r => r.code), ['0', '0', 'LOCAL_DAILY_LIMIT']);
  assert.equal(sent, 2);
});

for (const next of ['12:00-13:00', '12:30-13:30']) test(`在途时段 ${next} 重复或重叠，不同时发出`, async () => {
  const quota = new BookingQuota(), release = deferred(); let sent = 0;
  const first = quota.attempt('scope', '12:00-13:00', async () => { sent++; await release.promise; return { code: '0' }; }, { parallel: true });
  const second = quota.attempt('scope', next, async () => { sent++; return { code: '0' }; }, { parallel: true });
  assert.equal(sent, 1); release.resolve(); await first;
  assert.match((await second).code, /^LOCAL_SLOT_(BOOKED|CONFLICT)$/); assert.equal(sent, 1);
});

test('首单失败后按序补候选：第二单在途时第三单仍等待', async () => {
  const quota = new BookingQuota(), first = deferred(), second = deferred(); let sent = 0;
  const work = ['12:00-13:00', '13:00-14:00', '14:00-15:00'].map((time, i) => quota.attempt('scope', time,
    async () => { sent++; if (i === 0) { await first.promise; return { code: '1' }; }
      if (i === 1) await second.promise; return { code: '0' }; }, { parallel: true }));
  assert.equal(sent, 1); first.resolve(); await work[0];
  await new Promise(r => setImmediate(r)); assert.equal(sent, 2);
  second.resolve(); assert.deepEqual((await Promise.all(work)).map(r => r.code), ['1', '0', '0']);
  assert.equal(quota.remaining('scope'), 0);
});

test('同一学校账号跨项目与日期共享串行队列，不同账号可同时发送', async () => {
  const quota = new BookingQuota(), release = deferred(), sent = [];
  const keys = [quota.key('A', '001', 'd1'), quota.key('A', '002', 'd1'),
    quota.key('A', '001', 'd2'), quota.key('B', '001', 'd1')];
  const work = keys.map((key, i) => quota.attempt(key, '12:00-13:00', async () => {
    sent.push(i); if (!i) await release.promise; return { code: '0' };
  }, { parallel: true }));
  assert.deepEqual(sent, [0, 3]); release.resolve(); await Promise.all(work);
  assert.deepEqual(sent, [0, 3, 1, 2]);
});

test('持续频率拒绝耗尽自动恢复次数后，账号跨日期与项目停止；成功查询不代替提交恢复', async () => {
  const quota = new BookingQuota(), key = quota.key('A', '001', 'd1');
  for (let i = 1; i <= 3; i++) {
    quota.observeOutcome('A', { kind: 'retry', scope: 'rate', message: '操作过于频繁，请稍后再试！' });
    assert.equal(Boolean(quota.error(key)), i === 3);
  }
  let sent = 0;
  for (const other of [key, quota.key('A', '002', 'd2')]) {
    const response = await quota.attempt(other, '13:00-14:00', async () => { sent++; return { code: '0' }; });
    assert.equal(response.code, 'LOCAL_ACCOUNT_STOPPED'); assert.match(response.msg, /操作过于频繁/);
  }
  assert.equal(sent, 0);
  assert.equal((await quota.attempt(quota.key('B', '001', 'd1'), '13:00-14:00', async () => ({ code: '0' }))).code, '0');
});
