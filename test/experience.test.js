import { test } from 'node:test';
import assert from 'node:assert/strict';
import { friendlyDate, planExperience, repeatPlan, visiblePlans, selectionSummary, matchingMobileRun, pendingExecutionRequests, bookingTitle } from '../shared/experience.js';
const before = Date.parse('2026-10-01T12:00:00+08:00');
const after = Date.parse('2026-10-01T13:00:00+08:00');
const plan = { id: 'p', revision: 'old', name: '晚间排球', accountId: 'a', project: 'volleyball', date: '2026-10-02', times: ['19:00-20:00', '20:00-21:00'], courts: ['B', 'A'], courtLabels: { A: '一号场', B: '二号场' }, bookingGoal: 'consecutive', preferSameCourt: true, intervalMs: 100, durationMs: 120000 };
const account = { id: 'a', exists: true };
const state = (p = plan, options = {}) => planExperience(p, { now: before, account, ...options });
test('日期提示使用上海日期，在 UTC 前一天显示正确的今天和明天', () => {
  const midnight = Date.parse('2026-09-30T16:30:00Z');
  assert.match(friendlyDate('2026-10-01', midnight), /^今天/);
  assert.match(friendlyDate('2026-10-02', midnight), /^明天/);
});
test('启动提示区分当天倒计时、已放号与未来放号日', () => {
  assert.equal(state().action, '开始倒计时'); assert.equal(state().canStart, true);
  assert.equal(state(plan, { now: after }).action, '立即尝试');
  assert.equal(state({ ...plan, date: '2026-10-03' }).phase, 'future');
  assert.equal(state({ ...plan, date: '2026-10-03' }).canStart, false);
});
test('尚未连接的账号不能直接启动；上次验证不被视为当前仍有效', () => {
  assert.equal(state(plan, { account: undefined }).phase, 'login');
  assert.equal(state(plan, { account: { exists: false } }).canStart, false);
  assert.equal(state(plan, { account: { verifiedAt: '2025-01-01' } }).canStart, true);
});
test('所有候选时段已开始时隐藏在近期之外；仍有未来候选可启动', () => {
  assert.equal(state({ ...plan, date: '2026-10-01' }, { now: Date.parse('2026-10-01T20:00:00+08:00') }).phase, 'expired');
  assert.equal(state({ ...plan, date: '2026-10-01' }, { now: Date.parse('2026-10-01T19:30:00+08:00') }).canStart, true);
});
test('待确认订单始终保留在需处理列表，即使使用日期已经过去', () => {
  const ex = state({ ...plan, date: '2026-09-30' }, { run: { status: 'interrupted', pendingRequests: { r: {} } } });
  assert.equal(ex.phase, 'attention'); assert.equal(ex.canStart, false);
  assert.equal(visiblePlans([{ plan, experience: ex }], { filter: 'attention' }).length, 1);
});
test('配置检查成功不会伪装成预约成功；实际完成后不能直接重复启动', () => {
  assert.equal(state(plan, { run: { status: 'success', mode: 'check' } }).canStart, true);
  assert.equal(state(plan, { run: { status: 'success', mode: 'now' } }).phase, 'done');
  assert.equal(state(plan, { run: { status: 'success', mode: 'now' } }).canStart, false);
});
test('失败的只读检查仍可启动预约，不要求核对不存在的订单', () => {
  const ex = state(plan, { run: { mode: 'check', status: 'error' } });
  assert.equal(ex.phase, 'ready'); assert.equal(ex.action, '开始倒计时');
});
test('没有成功或未知请求的预约失败可直接重试，不被核对与重试入口困住', () => {
  for (const status of ['error', 'no_result', 'missed', 'interrupted']) {
    const ex = state(plan, { now: after, run: { mode: 'now', status, successes: [], pendingRequests: {} } });
    assert.equal(ex.phase, 'ready', status);
    assert.equal(ex.action, '立即尝试', status);
    assert.equal(ex.canStart, true, status);
  }
  assert.equal(state(plan, { run: { status: 'error', successes: [{ time: plan.times[0] }] } }).phase, 'attention');
});
test('成功一段后手动停止，以及学校名额已满，都显示核对入口', () => {
  assert.equal(state(plan, { run: { status: 'stopped', successes: [{ time: plan.times[0] }] } }).phase, 'attention');
  assert.equal(state(plan, { run: { status: 'limited', successes: [] } }).action, '核对与重试');
  assert.equal(state(plan, { run: { status: 'stopped', successes: [] } }).phase, 'ready');
});
test('近期列表排序先执行与待处理，历史仅在全部可見，并支持联合搜索和账号过滤', () => {
  const items = ['ready', 'expired', 'attention', 'active'].map((phase, i) => ({ plan: { ...plan, id: String(i) }, experience: { phase, active: phase === 'active' } }));
  assert.deepEqual(visiblePlans(items).map((i) => i.experience.phase), ['active', 'attention', 'ready']);
  assert.equal(visiblePlans(items, { filter: 'all', query: '二号场', accountId: 'a' }).length, 4);
  assert.equal(visiblePlans(items, { query: '羽毛球' }).length, 0);
});
test('复用方案清除旧执行身份与相邻场地锚点，深复制偏好并选择明天', () => {
  const original = { ...plan, date: '2026-09-20', sameCourtAnchor: { date: '2026-09-20', time: '19:00-20:00', court: 'A' }, startAt: 42 };
  const copy = repeatPlan(original, before);
  assert.equal(copy.date, '2026-10-02');
  for (const key of ['id', 'revision', 'sameCourtAnchor', 'startAt']) assert.equal(Object.hasOwn(copy, key), false);
  copy.courts.reverse(); copy.courtLabels.A = '其他';
  assert.deepEqual(original.courts, ['B', 'A']); assert.equal(original.courtLabels.A, '一号场');
});
test('复用仍在选择窗口内的未来日期，超出窗口则改为明天', () => {
  assert.equal(repeatPlan({ ...plan, date: '2026-10-07' }, before).date, '2026-10-07');
  assert.equal(repeatPlan({ ...plan, date: '2027-01-01' }, before).date, '2026-10-02');
});

test('两端默认名称不重复运动标签，复用自动名称不保留旧日期', () => {
  const p = { ...plan, projectLabel: '排球', name: '排球预约' };
  assert.equal(bookingTitle(p, '排球'), '排球');
  const old = { ...p, date: '2026-09-20', name: '2026-09-20 排球 19:00-20:00' };
  assert.equal(bookingTitle(old, '排球'), '排球');
  assert.equal(repeatPlan(old, before).name, '');
  assert.equal(repeatPlan({ ...old, name: '我的晚间排球' }, before).name, '我的晚间排球');
});
test('表单汇总即时区分未选时间、未选场地和连续目标不可达', () => {
  assert.equal(selectionSummary([], ['*']).valid, false);
  assert.equal(selectionSummary(plan.times, []).valid, false);
  assert.equal(selectionSummary(['19:00-20:00', '21:00-22:00'], ['A'], 'consecutive').valid, false);
  assert.equal(selectionSummary(plan.times, ['*'], 'consecutive').valid, true);
});
test('手机结果匹配包含日期、账号、偏好和执行设置，不复用旧修改结果', () => {
  const run = { id: 'r', startedAt: '2026-10-01', status: 'success', plans: [plan], items: [{ id: 'p', status: 'partial' }], successes: [{ planId: 'p', time: '19:00-20:00' }] };
  assert.equal(matchingMobileRun(plan, [run]).status, 'partial');
  assert.equal(matchingMobileRun({ ...plan, preferSameCourt: false }, [run]), null);
  assert.equal(matchingMobileRun({ ...plan, intervalMs: 1000 }, [run]), null);
  assert.equal(matchingMobileRun({ ...plan, date: '2026-10-03' }, [run]), null);
});
test('手机分配待核对请求和单方案状态，避免把其他方案错误归到已完成方案', () => {
  const other = { ...plan, id: 'other', name: '其他方案' };
  const run = { startedAt: '2026-10-01', status: 'partial', plans: [plan, other], items: [{ id: 'p', status: 'success' }, { id: 'other', status: 'error' }], inFlight: { planId: 'other' }, successes: [{ planId: 'p' }, { planId: 'other' }] };
  const result = matchingMobileRun(plan, [run]);
  assert.equal(result.status, 'success'); assert.equal(result.inFlight, null); assert.equal(result.successes.length, 1);
});

test('预备意图在正常倒计时中不告警，中断后的旧意图仍须核对', () => {
  const prepared = { date: plan.date, time: plan.times[0], preparedAt: '2026-10-01T04:29:45Z' };
  assert.equal(state(plan, { run: { status: 'waiting', pendingRequests: { first: prepared } } }).pending, false);
  assert.equal(state(plan, { run: { status: 'interrupted', pendingRequests: { first: prepared } } }).pending, true);
  assert.equal(state(plan, { run: { status: 'waiting', pendingRequests: { first: { ...prepared, sentAt: '2026-10-01T04:30:00Z' } } } }).pending, true);
});

test('学校核对完成后显示结果入口，原执行状态仍可留在审计记录', () => {
  const run = { status: 'interrupted', error: '原请求网络中断', reviewedOutcome: 'success', pendingRequests: {} };
  assert.equal(state(plan, { run }).phase, 'done');
  assert.equal(run.status, 'interrupted');
  assert.equal(state(plan, { run: { ...run, pendingRequests: { other: { time: '21:00-22:00' } } } }).phase, 'attention');
});

test('任意两段不能以一个或重复候选时段满足表单目标', () => {
  assert.equal(selectionSummary([plan.times[0]], ['A'], 'two').valid, false);
  assert.equal(selectionSummary([plan.times[0], plan.times[0]], ['A'], 'two').valid, false);
  assert.equal(selectionSummary(plan.times, ['A'], 'two').valid, true);
  assert.equal(selectionSummary(['19:00-20:00', '19:30-20:30'], ['A'], 'two').valid, false);
});

test('已核实请求不再告警，未匹配请求仍保留并提供稳定编号', () => {
  const run = { status: 'interrupted', pendingRequests: { resolved: {}, other: {} }, reviewedRequests: { resolved: {} } };
  assert.deepEqual(pendingExecutionRequests(run).map((r) => r.requestId), ['other']);
});
