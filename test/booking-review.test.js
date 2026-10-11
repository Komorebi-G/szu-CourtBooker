import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewBookings, schoolBookingScope } from '../shared/booking-review.js';
import { validateBookingGoal } from '../shared/booking-goal.js';
import { SzuVenueApi } from '../shared/api.js';

const plan = { date: '2026-10-01', bookingGoal: 'two', times: ['19:00-20:00', '20:00-21:00', '21:00-22:00'],
  courts: ['A', 'C'], courtLabels: { A: 'A场', C: 'C场' }, preferSameCourt: true };
const target = { sportCode: '001', sportName: '羽毛球', courtNames: ['A', 'C'] };
const row = (time = '19:00-20:00', extra = {}) => ({ YYRQ: plan.date, KYYSJD: time,
  XMDM: '001', YYZT_DISPLAY: '待支付', CDWID: 'C', CDMC: 'C场', ...extra });
const review = (rows, overrides = {}) => reviewBookings({ plan, target, rows, ...overrides });

test('核对确认成功后仅保存剩余候选，目标降为一段，并保留相邻C场偏好', () => {
  const result = review([row()]);
  assert.deepEqual(result.remainingTimes, plan.times.slice(1));
  assert.equal(result.remainingGoal, 'one'); assert.equal(result.sameCourtAnchor.court, 'C场');
  assert.equal(result.unresolved.length, 0);
});
test('连续目标的剩余方案只能选择已约时段的相邻时段', () => {
  const result = review([row('20:00-21:00')], { plan: { ...plan, bookingGoal: 'consecutive' } });
  assert.deepEqual(result.remainingTimes, ['19:00-20:00', '21:00-22:00']);
  assert.equal(result.remainingGoal, 'one');
});
test('两个不相邻的成功不能算连续目标完成，但已达日上限不能再提交', () => {
  const result = review([row(), row('21:00-22:00')], { plan: { ...plan, bookingGoal: 'consecutive' } });
  assert.equal(result.goalReached, false); assert.equal(result.dailyLimitReached, true);
  assert.deepEqual(result.remainingTimes, []);
});
test('取消记录不会被算作成功；未知状态和未对应的未知提交必须人工核对', () => {
  const result = review([row(undefined, { YYZT_DISPLAY: '已取消' }), row('20:00-21:00', { YYZT_DISPLAY: '处理中未知状态' })],
    { pending: [{ date: plan.date, time: plan.times[0], court: 'C场' }] });
  assert.equal(result.booked.length, 0); assert.equal(result.unresolved.length, 2);
  assert.deepEqual(result.remainingTimes, plan.times);
});
test('取消或退款处理中、失败及未取消不能当成已经释放名额', () => {
  for (const status of ['取消申请中', '取消失败', '退款中', '退款失败', '未取消', '失效处理中']) {
    const result = schoolBookingScope({ date: plan.date, target, rows: [row(undefined, { YYZT_DISPLAY: status })] });
    assert.equal(result.unresolved.length, 1, status);
  }
  const result = review([row(undefined, { YYZT_DISPLAY: ' 已支付 ' })]);
  assert.equal(result.booked.length, 1, '学校状态的空白字符不改变含义');
});
test('缺少项目/日期/场地身份的记录不能凭空确认目标完成', () => {
  const result = review([row(undefined, { XMDM: undefined }), row('20:00-21:00', { YYRQ: undefined }),
    row('21:00-22:00', { CDWID: undefined, CDMC: undefined })]);
  assert.equal(result.goalReached, false); assert.equal(result.unresolved.length, 3);
  assert.ok(!result.remainingTimes.includes('21:00-22:00'), '明确已有订单的时段仍不能重复提交');
});
test('已有场地不符合本方案时不能冒充完成，也不能重复订同一时段', () => {
  const result = review([row(undefined, { CDWID: 'B', CDMC: 'B场' })], { plan: { ...plan, bookingGoal: 'one' } });
  assert.equal(result.goalReached, false); assert.deepEqual(result.remainingTimes, plan.times.slice(1));
  assert.match(result.unresolved[0].reason, /不一致/);
});
test('同项目同日其他时段的订单也占用上限，不同日期与项目不干扰', () => {
  const result = review([row('17:00-18:00'), row(undefined, { XMDM: '002' }), row(undefined, { YYRQ: '2026-10-02' })]);
  assert.deepEqual(result.remainingTimes, plan.times); assert.equal(result.remainingGoal, 'one');
  assert.equal(result.dailyTimes.length, 1);
});
test('已有订单与手填候选部分重叠时排除冲突候选', () => {
  const result = review([row('19:30-20:30')]);
  assert.deepEqual(result.remainingTimes, ['21:00-22:00']); assert.match(result.unresolved[0].reason, /重叠/);
});
test('未知学校订单与候选部分重叠时必须提示核对，不能因时间不完全相同漏掉', () => {
  const result = review([row('19:30-20:30', { YYZT_DISPLAY: '处理中未知状态' })]);
  assert.equal(result.unresolved.length, 1);
  assert.equal(result.unresolved[0].time, '19:30-20:30');
  assert.equal(result.booked.length, 0);
});
test('未知及本地待确认的未选时段也可能占名额，不能静默忽略', () => {
  const result = review([row('17:00-18:00', { YYZT_DISPLAY: '未知状态' })], {
    pending: [{ date: plan.date, time: '18:30-19:30', court: 'C场' }],
    known: [{ date: plan.date, time: '16:00-17:00', court: 'C场' }],
  });
  assert.deepEqual(result.unresolved.map((s) => s.time), ['17:00-18:00', '18:30-19:30', '16:00-17:00']);
});
test('学校已确认的未选时段能对应本地记录，不留下虚假的待核对项', () => {
  const result = review([row('17:00-18:00')], { known: [{ date: plan.date, time: '17:00-18:00', court: 'C场' }] });
  assert.equal(result.unresolved.length, 0);
  assert.equal(result.remainingGoal, 'one');
});
test('核对按稳定场地编号匹配请求，名称变化不影响确认，不同场地不能误消除未知记录', () => {
  const pending = [
    { requestId: 'confirmed', date: plan.date, time: '19:00-20:00', room: { WID: 'C', CDMC: '旧C名称' } },
    { requestId: 'unknown', date: plan.date, time: '19:00-20:00', room: { WID: 'A', CDMC: 'C场' } },
  ];
  const result = review([row()], { pending });
  assert.deepEqual(result.resolvedRequests.map((r) => r.requestId), ['confirmed']);
  assert.equal(result.unresolved.length, 1);
});
test('空项目、非法日期和非法时段保留为未知，其他日期和项目不干扰', () => {
  const result = schoolBookingScope({ date: plan.date, target, rows: [
    row('17:00-18:00', { XMDM: null }), row('25:00-26:00'), row(undefined, { YYRQ: '2026-02-30' }),
    row(undefined, { YYRQ: '2026-10-02' }), row(undefined, { XMDM: '002' }),
  ] });
  assert.equal(result.bookings.length, 0); assert.equal(result.unresolved.length, 3);
});
test('核对任选一段已成功时不再生成剩余方案', () => {
  const result = review([row()], { plan: { ...plan, bookingGoal: 'one' } });
  assert.equal(result.goalReached, true); assert.deepEqual(result.remainingTimes, []);
});
test('核对历史执行只解除未知记录，不生成过期剩余方案；当天只保留尚未开始的候选', () => {
  const expired = review([], { now: Date.parse('2026-10-02T00:00:00+08:00') });
  assert.deepEqual(expired.remainingTimes, []); assert.match(expired.reason, /已开始/);
  const partial = review([], { now: Date.parse('2026-10-01T20:00:00+08:00') });
  assert.deepEqual(partial.remainingTimes, ['21:00-22:00']); assert.equal(partial.remainingGoal, 'one');
});
test('目标和相邻场地信息须校验，连续两段必须有可行候选', () => {
  assert.throws(() => validateBookingGoal({ ...plan, bookingGoal: 'invalid' }), /有效/);
  assert.throws(() => validateBookingGoal({ ...plan, bookingGoal: 'consecutive', times: [plan.times[0], plan.times[2]] }), /首尾相接/);
  assert.throws(() => validateBookingGoal({ ...plan, sameCourtAnchor: { date: '2026-10-02', time: plan.times[0], court: 'C场' } }), /无效/);
});
test('学校查询缺少业务结果/分页字段时绝不能默认空订单', async () => {
  for (const data of [{}, { code: '1', datas: { myBookingInfo: { rows: [], totalSize: 0 } } },
    ...[undefined, null, ''].map((totalSize) => ({ datas: { myBookingInfo: { rows: [], totalSize } } }))]) {
    const api = new SzuVenueApi({ async post() { return { data }; } });
    await assert.rejects(api.getAllBookings(), /不能据此认定/);
  }
});
test('学校分页完整读取；重复页、数量变化和缺页都报错', async () => {
  const apiFor = (pages) => new SzuVenueApi({ async post(_, form) {
    return { data: { code: '0', datas: { myBookingInfo: pages[form.pageNumber - 1] } } };
  } });
  assert.equal((await apiFor([{ rows: [row()], totalSize: 2 }, { rows: [row('20:00-21:00')], totalSize: 2 }]).getAllBookings()).length, 2);
  await assert.rejects(apiFor([{ rows: [row()], totalSize: 2 }, { rows: [row()], totalSize: 2 }]).getAllBookings(), /重复返回/);
  await assert.rejects(apiFor([{ rows: [row()], totalSize: 2 }, { rows: [row('20:00-21:00')], totalSize: 3 }]).getAllBookings(), /发生变化/);
  await assert.rejects(apiFor([{ rows: [row()], totalSize: 2 }, { rows: [], totalSize: 2 }]).getAllBookings(), /不完整/);
});
