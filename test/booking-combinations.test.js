import assert from 'node:assert/strict';
import test from 'node:test';
import { runBooking } from '../shared/runner.js';
import { SzuVenueApi } from '../shared/api.js';
import { HttpResponseError, SchoolQueryError } from '../shared/errors.js';
import { addDays, shanghaiDate } from '../shared/utils.js';

const rooms = ['A', 'B', 'C'].map((id) => ({ WID: id, CDMC: id, CGBM: 'v', XMDM: '001' }));
function fixture(overrides = {}) {
  const attempts = [], logs = [];
  const target = { name: '组合测试', targetIndex: 0, campusCode: '1', sportCode: '001', modeCode: '1.0',
    times: ['18:00-19:00', '19:00-20:00', '20:00-21:00'], venues: [{ CGBM: 'v' }],
    courtNames: ['A', 'B'], ...overrides };
  const api = { async getOpeningRooms() { return rooms; }, async book(input) {
    attempts.push([input.time, input.room.WID]); return { code: '0' };
  } };
  const args = { api, client: { async flush() {} }, targets: [target],
    date: addDays(shanghaiDate(), 1), immediate: true, live: true,
    config: { scheduler: { queryConcurrency: 4, timeoutMs: 1000, pollIntervalMs: 1 }, booking: { taskConcurrency: 4 } },
    log(level, message, details) { logs.push({ level, message, details }); } };
  return { args, api, target, attempts, logs };
}

for (const bookingGoal of ['one', 'consecutive', 'two']) {
for (const preferSameCourt of [false, true]) {
  for (const includeOtherCourts of [false, true]) {
    for (const concurrency of [1, 4]) {
      for (const blocked of ['empty', 'query_not_open', 'query_503', 'no_space', 'court_not_open']) {
        test(`前段${blocked}后两段可订：目标=${bookingGoal}、同场=${preferSameCourt}、其余=${includeOtherCourts}、并发=${concurrency}`, async () => {
          const f = fixture({ bookingGoal, preferSameCourt, includeOtherCourts });
          f.args.config.booking.taskConcurrency = concurrency;
          f.api.getOpeningRooms = async ({ time }) => {
            if (time === f.target.times[0]) {
              if (blocked === 'empty') return [];
              if (blocked === 'query_not_open') throw new SchoolQueryError({ kind: 'wait', message: '该时段暂不开放' });
              if (blocked === 'query_503') throw new HttpResponseError(503, '/catalog');
            }
            return rooms;
          };
          f.api.book = async ({ time, room }) => {
            f.attempts.push([time, room.WID]);
            return time === f.target.times[0]
              ? { code: '1', msg: blocked === 'court_not_open' ? '该场地尚未开放' : '没有空位' } : { code: '0' };
          };
          const result = await runBooking(f.args);
          assert.equal(result.successes.length, bookingGoal === 'one' ? 1 : 2, JSON.stringify(result));
          assert.ok(result.successes.every((s) => f.target.times.slice(1).includes(s.task.time)));
          assert.equal(result.ok, true);
          assert.equal(result.error, undefined);
          if (!includeOtherCourts) assert.ok(f.attempts.every(([, court]) => court !== 'C'));
          if (['empty', 'query_not_open', 'query_503'].includes(blocked)) {
            assert.ok(f.attempts.every(([time]) => time !== f.target.times[0]), '不能借用后段目录提交前段');
          }
        });
      }
    }
  }
}
}

test('连续两段不会订孤立候选，也不会在第一段成功后再订不相邻时段', async () => {
  const f = fixture({ bookingGoal: 'consecutive', times: ['16:00-17:00', '19:00-20:00', '20:00-21:00', '22:00-23:00'] });
  const result = await runBooking(f.args);
  assert.equal(result.ok, true);
  assert.deepEqual(f.attempts.map(([time]) => time), ['19:00-20:00', '20:00-21:00']);
});
for (const concurrency of [1, 4]) {
  test(`连续目标排除已过期的邻段，保留后面完整组合：并发=${concurrency}`, async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-01T18:05:00+08:00') });
    const f = fixture({ bookingGoal: 'consecutive', times: ['18:00-19:00', '19:00-20:00', '21:00-22:00', '22:00-23:00'] });
    f.args.date = shanghaiDate(); f.args.config.booking.taskConcurrency = concurrency;
    const result = await runBooking(f.args);
    assert.equal(result.ok, true);
    assert.deepEqual(f.attempts.map(([time]) => time), ['21:00-22:00', '22:00-23:00']);
    assert.ok(result.expiredTimes.includes('18:00-19:00'));
  });
}
test('连续目标的邻段在目录查询期间过期，真正提交前重新选择可行组合', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-01T17:59:59+08:00') });
  const f = fixture({ bookingGoal: 'consecutive', times: ['18:00-19:00', '19:00-20:00', '21:00-22:00', '22:00-23:00'] });
  f.args.date = shanghaiDate(); f.args.config.booking.taskConcurrency = 1;
  f.api.getOpeningRooms = async () => { t.mock.timers.tick(2000); return rooms; };
  f.args.config.scheduler.timeoutMs = 20000;
  assert.equal((await runBooking(f.args)).ok, true);
  assert.deepEqual(f.attempts.map(([time]) => time), ['21:00-22:00', '22:00-23:00']);
});
test('学校明确返回邻段过期后，连续目标不再提交被孤立的候选', async () => {
  const f = fixture({ bookingGoal: 'consecutive', times: ['18:00-19:00', '19:00-20:00', '21:00-22:00', '22:00-23:00'] });
  f.args.config.booking.taskConcurrency = 1;
  f.api.book = async ({ time, room }) => {
    f.attempts.push([time, room.WID]); return { code: time === '18:00-19:00' ? '1' : '0', msg: '时段已开始' };
  };
  assert.equal((await runBooking(f.args)).ok, true);
  assert.deepEqual(f.attempts.map(([time]) => time), ['18:00-19:00', '21:00-22:00', '22:00-23:00']);
});
test('中间有重叠但不连续的候选时，同场仍能找到真正首尾相接的成功时段', async () => {
  const f = fixture({ bookingGoal: 'consecutive', preferSameCourt: true, courtNames: ['A', 'B', 'C'],
    times: ['19:00-20:00', '19:30-20:30', '20:00-21:00'] });
  f.api.book = async ({ time, room }) => {
    f.attempts.push([time, room.WID]);
    return { code: time.startsWith('20:') || room.WID === 'C' ? '0' : '1', msg: '无空位' };
  };
  const result = await runBooking(f.args);
  assert.equal(result.ok, true);
  assert.deepEqual(result.successes.map((s) => s.task.room.WID), ['C', 'C']);
  assert.ok(!f.attempts.some(([time]) => time.startsWith('19:30')));
});

test('连续两段只成功一段时保留成功并显示部分成功，不能填入不相邻候选', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const f = fixture({ bookingGoal: 'consecutive', times: ['19:00-20:00', '20:00-21:00', '22:00-23:00'] });
  f.api.book = async ({ time, room }) => {
    f.attempts.push([time, room.WID]);
    if (time.startsWith('19:')) return { code: '0' };
    t.mock.timers.tick(1100); return { code: '1', msg: '无空位' };
  };
  const result = await runBooking(f.args);
  assert.equal(result.ok, false); assert.equal(result.successes.length, 1);
  assert.ok(!f.attempts.some(([time]) => time.startsWith('22:')));
});

test('剩余方案携带学校已确认的相邻场地，优先C失败再回A', async () => {
  const f = fixture({ bookingGoal: 'one', preferSameCourt: true, courtNames: ['A', 'B', 'C'], times: ['20:00-21:00'] });
  f.target.sameCourtAnchor = { date: f.args.date, time: '19:00-20:00', court: 'C' };
  f.api.book = async ({ time, room }) => { f.attempts.push([time, room.WID]); return { code: room.WID === 'A' ? '0' : '1', msg: '无空位' }; };
  assert.equal((await runBooking(f.args)).ok, true);
  assert.deepEqual(f.attempts.map(([, court]) => court), ['C', 'A']);
});
test('不同场馆存在同名场地时，剩余方案优先使用已确认的场地ID', async () => {
  const f = fixture({ bookingGoal: 'one', preferSameCourt: true, courtNames: ['A', 'C'], times: ['20:00-21:00'] });
  f.target.sameCourtAnchor = { date: f.args.date, time: '19:00-20:00', court: '同名场', courtId: 'C' };
  f.api.getOpeningRooms = async () => rooms.map((room) => ({ ...room, CDMC: '同名场' }));
  const result = await runBooking(f.args);
  assert.equal(result.ok, true); assert.equal(f.attempts[0][1], 'C');
});

test('共享成功的场地不符合另一方案的选择时不能当作该方案完成', async () => {
  const f = fixture({ bookingGoal: 'one', times: ['19:00-20:00'], courtNames: ['A'] });
  f.args.targets.push({ ...f.target, targetIndex: 1, name: '仅B', courtNames: ['B'] });
  const result = await runBooking(f.args);
  assert.equal(f.attempts.length, 1); assert.equal(result.successes.length, 1);
  assert.equal(result.ok, false); assert.ok(result.slots.some((s) => s.status === 'conflict'));
});

for (const includeOtherCourts of [false, true]) {
  test(`前段抢到靠后C，后段A也可订仍先C；C失败回A→B：其余=${includeOtherCourts}`, async () => {
    for (const cFails of [false, true]) {
      const f = fixture({ preferSameCourt: true, includeOtherCourts, courtNames: ['A', 'B', 'C'],
        times: ['19:00-20:00', '20:00-21:00'] });
      f.api.book = async ({ time, room }) => {
        f.attempts.push([time, room.WID]);
        const success = time.startsWith('19:') ? room.WID === 'C' : cFails ? room.WID === 'B' : true;
        return { code: success ? '0' : '1', msg: '无空位' };
      };
      const result = await runBooking(f.args);
      assert.equal(result.successes.length, 2);
      assert.deepEqual(f.attempts.filter(([time]) => time.startsWith('20:')).map(([, r]) => r), cFails ? ['C', 'A', 'B'] : ['C']);
      assert.ok(f.logs.some((l) => l.details?.reason === 'same_court' && l.details.neighborTime === '19:00-20:00'));
    }
  });
}

test('后段先约到C，下一轮补前段也先C；关闭同场则从A开始', async () => {
  for (const preferSameCourt of [false, true]) {
    const f = fixture({ preferSameCourt, courtNames: ['A', 'B', 'C'], times: ['19:00-20:00', '20:00-21:00'] });
    let laterBooked = false;
    f.api.book = async ({ time, room }) => {
      f.attempts.push([time, room.WID]);
      if (time.startsWith('20:') && room.WID === 'C') { laterBooked = true; return { code: '0' }; }
      return { code: time.startsWith('19:') && laterBooked ? '0' : '1', msg: '无空位' };
    };
    // Serial lanes here make the release of the earlier slot deterministic.
    f.args.config.booking.taskConcurrency = 1;
    f.args.config.scheduler.timeoutMs = 3000;
    const result = await runBooking(f.args);
    assert.equal(result.successes.length, 2);
    assert.equal(result.successes.find((s) => s.task.time.startsWith('19:')).task.room.WID, preferSameCourt ? 'C' : 'A');
    assert.equal(f.attempts.filter(([time]) => time.startsWith('20:')).length, 3, '已成功的后段不能重发');
  }
});

test('同场C不开放时仍尝试A，单一场地的未开放不能跳过整个时段', async () => {
  const f = fixture({ preferSameCourt: true, courtNames: ['A', 'B', 'C'], times: ['19:00-20:00', '20:00-21:00'] });
  f.api.book = async ({ time, room }) => {
    f.attempts.push([time, room.WID]);
    if (time.startsWith('19:')) return { code: room.WID === 'C' ? '0' : '1', msg: '满场' };
    return { code: room.WID === 'C' ? '1' : '0', msg: '该场地未开放' };
  };
  assert.equal((await runBooking(f.args)).successes.length, 2);
  assert.deepEqual(f.attempts.slice(-2), [['20:00-21:00', 'C'], ['20:00-21:00', 'A']]);
});

test('不同场馆的目录局部未开放，不影响同一时段另一场馆', async () => {
  const f = fixture({ times: ['19:00-20:00'], venues: [{ CGBM: 'closed' }, { CGBM: 'v' }] });
  f.api.getOpeningRooms = async ({ venueCode }) => {
    if (venueCode === 'closed') throw new SchoolQueryError({ kind: 'wait', message: '场馆暂不开放' });
    return rooms;
  };
  assert.equal((await runBooking(f.args)).successes.length, 1);
});

test('前段目录503后下一轮恢复，后段先成功，最终补齐两段', async () => {
  const f = fixture({ preferSameCourt: true, times: ['19:00-20:00', '20:00-21:00'] });
  f.args.config.scheduler.timeoutMs = 3000;
  let queries = 0;
  f.api.getOpeningRooms = async ({ time }) => {
    if (time.startsWith('19:') && ++queries === 1) throw new HttpResponseError(503, '/catalog');
    return rooms;
  };
  const result = await runBooking(f.args);
  assert.equal(result.successes.length, 2); assert.equal(result.metrics.queryFailures, 1);
  assert.equal(f.attempts[0][0], '20:00-21:00');
});

test('前段已经可订时先提交，再查询后段，慢候选不阻塞第一单', async () => {
  const f = fixture({ preferSameCourt: true, times: ['19:00-20:00', '20:00-21:00'] });
  const events = [];
  f.api.getOpeningRooms = async ({ time }) => { events.push('query:' + time); return rooms; };
  f.api.book = async ({ time }) => { events.push('book:' + time); return { code: '0' }; };
  await runBooking(f.args);
  assert.deepEqual(events, ['query:19:00-20:00', 'book:19:00-20:00', 'query:20:00-21:00', 'book:20:00-21:00']);
});

test('学校查询未开放按业务文字分类；未知拒绝和身份异常仍停止', async () => {
  for (const [msg, kind] of [['该时段不开放', 'wait'], ['无空位', 'retry'], ['账号冻结', 'account'], ['需要人工处理', 'rejected']]) {
    const api = new SzuVenueApi({ async post() { return { data: { code: '1', msg } }; } });
    await assert.rejects(api.getOpeningRooms({ time: '19:00-20:00' }), (error) => error.outcome.kind === kind);
  }
});

test('其余场地成功后，相邻后一段先同场；日志准确区分其余场地与同场', async () => {
  const f = fixture({ preferSameCourt: true, includeOtherCourts: true, courtNames: ['A'],
    times: ['19:00-20:00', '20:00-21:00'] });
  f.api.book = async ({ time, room }) => { f.attempts.push([time, room.WID]); return { code: room.WID === 'C' ? '0' : '1', msg: '无空位' }; };
  assert.equal((await runBooking(f.args)).successes.length, 2);
  const cRequests = f.logs.filter((l) => l.details?.event === 'booking_request' && l.details.court === 'C');
  assert.deepEqual(cRequests.map((l) => l.details.reason), ['other_court', 'same_court']);
});
