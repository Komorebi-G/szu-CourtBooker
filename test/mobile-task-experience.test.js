import test from 'node:test';
import assert from 'node:assert/strict';
import { mobileTaskExperience } from '../mobile/src/task-experience.js';

const plan = { id: 'p', name: '羽毛球', date: '2026-10-14', times: ['12:00-13:00', '13:00-14:00'] };
const options = { now: Date.parse('2026-10-13T20:00:00+08:00'), account: { id: 'a' } };
test('安卓同一任务失败可重新预约、部分成功可继续预约，不生成剩余任务', () => {
  const failure = mobileTaskExperience(plan, { ...options, run: { mode: 'auto', status: 'error', successes: [] } });
  assert.equal(failure.action, '重新预约'); assert.equal(failure.canStart, true); assert.equal(failure.primary, 'start');
  const partial = mobileTaskExperience(plan, { ...options, run: { mode: 'auto', status: 'partial', successes: [{ time: plan.times[0] }] } });
  assert.equal(partial.action, '继续预约'); assert.equal(partial.badge, '部分成功'); assert.equal(partial.canStart, true);
  assert.doesNotMatch(partial.hint, /核对|生成|剩余预约/);
});
test('安卓成功任务查看结果；真正未知的已发请求禁止再次提交', () => {
  const success = mobileTaskExperience(plan, { ...options, run: { mode: 'auto', status: 'success' } });
  assert.equal(success.action, '查看结果'); assert.equal(success.canStart, false);
  const pending = mobileTaskExperience(plan, { ...options, run: { status: 'interrupted',
    pendingRequests: { unknown: { date: plan.date, time: plan.times[0], state: 'unknown' } } } });
  assert.equal(pending.badge, '结果未确认'); assert.equal(pending.action, '查看结果'); assert.equal(pending.canStart, false);
});
test('安卓过期复用、未来禁用和缺少账号仍遵守执行边界', () => {
  assert.equal(mobileTaskExperience(plan, { ...options, now: Date.parse('2026-10-15T08:00:00+08:00') }).primary, 'copy');
  const future = mobileTaskExperience(plan, { ...options, now: Date.parse('2026-10-12T20:00:00+08:00') });
  assert.equal(future.phase, 'future'); assert.equal(future.canStart, false);
  assert.equal(mobileTaskExperience(plan, { ...options, account: undefined }).primary, 'login');
});
