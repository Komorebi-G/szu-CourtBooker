import test from 'node:test';
import assert from 'node:assert/strict';
import { bookingReleaseAt, runBooking, waitForRelease } from '../shared/runner.js';
import { sleep } from '../shared/utils.js';

function fixture(overrides = {}) {
  const attempts = [];
  const target = { name: '排球', project: 'volleyball', sport: '排球', targetIndex: 0,
    campusCode: '1', sportCode: '2', modeCode: '1.0', preferSameCourt: true,
    times: ['19:00-20:00', '20:00-21:00', '21:00-22:00'],
    venues: [{ CGBM: 'v' }], courtNames: ['A', 'B', 'C'], ...overrides };
  const api = { async getOpeningRooms() { return ['C', 'A', 'B'].map((id) => ({ WID: id, CDMC: id, CGBM: 'v' })); },
    async sampleServerOffset() { return 0; }, async getAvailableDates() {},
    async book({ time, room }) { attempts.push([time, room.WID]); return { code: '0' }; } };
  const args = { api, client: { async flush() {} },
    config: { scheduler: { queryConcurrency: 2, timeoutMs: 70, pollIntervalMs: 10, pollJitterMs: 0 },
      booking: { taskConcurrency: 4, maxSuccesses: 1, maxSuccessesPerTarget: 1 } },
    targets: [target], date: '2026-09-20', live: true, immediate: true, log() {} };
  return { args, api, attempts, target };
}
test('候选时段最多成功两个，不受旧一单上限影响', async () => {
  const { args, attempts } = fixture(); const result = await runBooking(args);
  assert.equal(result.successes.length, 2); assert.equal(result.ok, true); assert.equal(attempts.length, 2);
});
test('优先同场：A失败抢B，后一时段先B，再回原顺序；成功不退订', async () => {
  const { args, api, attempts } = fixture();
  api.book = async ({ room, time }) => {
    attempts.push([time, room.WID]);
    const preferred = { '19:00-20:00': 'B', '20:00-21:00': 'C', '21:00-22:00': 'C' };
    return { code: room.WID === preferred[time] ? '0' : '1' };
  };
  const result = await runBooking(args);
  assert.deepEqual(attempts.map(([time, court]) => `${time}:${court}`), [
    '19:00-20:00:A', '19:00-20:00:B', '20:00-21:00:B', '20:00-21:00:A', '20:00-21:00:C',
  ]); assert.equal(result.successes.length, 2);
});
test('未勾优先同场：各时段都从原优先级开始', async () => {
  const { args, api, attempts } = fixture({ preferSameCourt: false, times: ['19:00-20:00', '20:00-21:00'] });
  api.book = async ({ room, time }) => { attempts.push([time, room.WID]); return { code: room.WID === 'B' ? '0' : '1' }; };
  assert.equal((await runBooking(args)).successes.length, 2);
  for (const time of args.targets[0].times) assert.deepEqual(attempts.filter((a) => a[0] === time).map((a) => a[1]), ['A', 'B']);
});
test('前段未抢到，不阻塞后一时段；成功时段不会再次提交', async () => {
  const { args, api, attempts } = fixture({ times: ['19:00-20:00', '20:00-21:00'] });
  api.book = async ({ room, time }) => { attempts.push([time, room.WID]); return { code: time === '20:00-21:00' ? '0' : '1' }; };
  const result = await runBooking(args); assert.equal(result.successes.length, 1);
  assert.deepEqual(attempts.slice(0, 4), [['19:00-20:00', 'A'], ['19:00-20:00', 'B'], ['19:00-20:00', 'C'], ['20:00-21:00', 'A']]);
  assert.equal(attempts.filter((a) => a[0] === '20:00-21:00').length, 1);
});
test('时段不连续时不继承更早场地；时间按先后处理', async () => {
  const { args, api, attempts } = fixture({ times: ['21:00-22:00', '19:00-20:00'] });
  api.book = async ({ room, time }) => { attempts.push([time, room.WID]); return { code: room.WID === 'B' ? '0' : '1' }; };
  await runBooking(args);
  assert.deepEqual(attempts, [['19:00-20:00', 'A'], ['19:00-20:00', 'B'], ['21:00-22:00', 'A'], ['21:00-22:00', 'B']]);
});
test('未到设定时间绝不下单，即使保留旧 earlyStartMs', async () => {
  const { args, api } = fixture({ times: ['19:00-20:00'] });
  const release = Date.now() + 260;
  args.immediate = false; args.releaseAtServer = release; args.config.scheduler.earlyStartMs = 5000;
  api.book = async () => { assert.ok(Date.now() >= release); return { code: '0' }; };
  assert.equal((await runBooking(args)).ok, true);
});
test('等待中停止很快退出，零预约请求', async () => {
  const { args, attempts } = fixture(); const controller = new AbortController();
  const work = runBooking({ ...args, immediate: false, releaseAtServer: Date.now() + 60_000, signal: controller.signal });
  setTimeout(() => controller.abort(), 20);
  const result = await work; assert.equal(result.stopped, true); assert.equal(attempts.length, 0);
});
test('倒计时后登录已失效，停止并提示重新登录，不发预约', async () => {
  const { args, api, attempts } = fixture();
  api.getIdentity = async ({ refresh }) => { assert.equal(refresh, true); throw new Error('登录失效，请重新登录'); };
  const result = await runBooking({ ...args, immediate: false, releaseAtServer: Date.now() });
  assert.equal(attempts.length, 0); assert.match(result.error, /重新登录/);
});
test('请求已发出时停止，仍保存成功结果，不尝试下一时段', async () => {
  const { args, api, attempts } = fixture(); const controller = new AbortController();
  api.book = async ({ time, room }) => { attempts.push([time, room.WID]); controller.abort(); await sleep(5); return { code: '0' }; };
  const result = await runBooking({ ...args, signal: controller.signal });
  assert.equal(result.stopped, true); assert.equal(result.successes.length, 1); assert.equal(attempts.length, 1);
});
test('POST超时结果未知时停止，避免重复提交', async () => {
  const { args, api } = fixture(); let calls = 0;
  api.book = async () => { calls++; throw new Error('timeout'); };
  const result = await runBooking(args); assert.equal(calls, 1); assert.match(result.error, /结果待确认/);
});
test('并发候选已排队：首单结果未知后不得发送剩余时段', async () => {
  const { args, api } = fixture({ preferSameCourt: false }); let calls = 0;
  api.book = async () => { calls++; throw new Error('timeout'); };
  const result = await runBooking(args);
  assert.equal(calls, 1); assert.match(result.error, /结果待确认/);
});
test('停止发生在已发送请求期间，超时的核对提示不能丢失', async () => {
  const { args, api } = fixture(); const controller = new AbortController();
  api.book = async () => { controller.abort(); throw new Error('timeout'); };
  const result = await runBooking({ ...args, signal: controller.signal });
  assert.equal(result.stopped, true); assert.match(result.error, /结果待确认/);
});
test('明确未发送的请求保留真实原因，不误报结果未知', async () => {
  const { args, api } = fixture({ preferSameCourt: false }); let calls = 0;
  api.book = async () => { calls++; throw Object.assign(new Error('执行窗口已结束，未发送请求'), { code: 'REQUEST_NOT_SENT' }); };
  const result = await runBooking(args);
  assert.equal(calls, 1); assert.match(result.error, /未发送/); assert.doesNotMatch(result.error, /待确认/);
});
test('重复项目时段交给学校接口判断，执行器不按本地任务拦截', async () => {
  const { args, target, attempts } = fixture({ times: ['19:00-20:00'] });
  args.targets.push({ ...target, name: '第二个任务', targetIndex: 1 });
  const result = await runBooking(args);
  assert.equal(result.successes.length, 2); assert.equal(attempts.length, 2);
});
test('单个方案误填重复时段只执行一次，保留其他候选', async () => {
  const { args, attempts } = fixture({ preferSameCourt: false,
    times: ['19:00-20:00', '19:00-20:00', '20:00-21:00'] });
  const result = await runBooking(args);
  assert.equal(result.total, 2); assert.equal(result.successes.length, 2);
  assert.deepEqual(attempts.map(([time]) => time), ['19:00-20:00', '20:00-21:00']);
});
test('默认前一天12:30，闰月与跨月日期正确', () => {
  assert.equal(bookingReleaseAt('2028-03-01'), Date.parse('2028-02-29T12:30:00+08:00'));
});

test('可选剩余场地：每轮先选定顺序，再学校顺序，重复目录不重复提交', async () => {
  const { args, api, attempts } = fixture({ courtNames: ['B', 'A'], includeOtherCourts: true, times: ['19:00-20:00'], preferSameCourt: false });
  api.getOpeningRooms = async () => ['D', 'A', 'B', 'C', 'D'].map((id) => ({ WID: id, CDMC: id, CGBM: 'v' }));
  api.book = async ({ time, room }) => { attempts.push([time, room.WID]); return { code: attempts.length === 8 ? '0' : '1' }; };
  const result = await runBooking(args);
  assert.equal(result.ok, true);
  assert.deepEqual(attempts.map((a) => a[1]), ['B', 'A', 'D', 'C', 'B', 'A', 'D', 'C']);
});
test('关闭剩余场地：未选的场地始终不尝试，兼容旧方案', async () => {
  for (const includeOtherCourts of [undefined, false]) {
    const { args, api, attempts } = fixture({ courtNames: ['B', 'A'], includeOtherCourts, times: ['19:00-20:00'] });
    api.book = async ({ time, room }) => { attempts.push([time, room.WID]); return { code: attempts.length === 4 ? '0' : '1' }; };
    assert.equal((await runBooking(args)).ok, true);
    assert.deepEqual(attempts.map((a) => a[1]), ['B', 'A', 'B', 'A']);
  }
});
test('剩余场地成功后，同场优先仍能用于相邻时段', async () => {
  const { args, api, attempts } = fixture({ courtNames: ['B'], includeOtherCourts: true, times: ['19:00-20:00', '20:00-21:00'] });
  api.book = async ({ time, room }) => { attempts.push([time, room.WID]); return { code: room.WID === 'C' ? '0' : '1' }; };
  assert.equal((await runBooking(args)).ok, true);
  assert.deepEqual(attempts.map((a) => a[1]), ['B', 'C', 'C']);
});
