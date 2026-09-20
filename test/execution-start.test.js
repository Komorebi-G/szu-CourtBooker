import test from 'node:test';
import assert from 'node:assert/strict';
import { validateExecutionStart } from '../shared/runner.js';
import { SzuVenueApi } from '../shared/api.js';
import { SessionExpiredError } from '../shared/errors.js';

test('仅放号当天可启动倒计时，之前只保存方案，过点明确切立即尝试', () => {
  const before = Date.parse('2026-09-20T12:00:00+08:00');
  const release = Date.parse('2026-09-20T12:30:00+08:00');
  assert.equal(validateExecutionStart('release', '2026-09-21', before), release);
  assert.throws(() => validateExecutionStart('release', '2026-09-22', before), /放号当天/);
  assert.throws(() => validateExecutionStart('release', '2026-09-21', release), /立即尝试/);
  assert.throws(() => validateExecutionStart('now', '2026-09-21', before), /尚未放号/);
  assert.equal(validateExecutionStart('now', '2026-09-21', release), release);
  assert.throws(() => validateExecutionStart('schedule', '2026-09-21', before), /已移除系统定时/);
});

test('倒计时后核验绕过身份缓存；服务端身份变更时拒绝继续', async () => {
  let calls = 0, id = 'student';
  const api = new SzuVenueApi({ async get() {
    calls++;
    return { data: `USERID='${id}';USER_INFO={"userName":"测试"};APP_TITLE='预约';` };
  } });
  await api.getIdentity(); await api.getIdentity(); assert.equal(calls, 1);
  await api.getIdentity({ refresh: true }); assert.equal(calls, 2);
  id = 'other';
  await assert.rejects(api.getIdentity({ refresh: true }), SessionExpiredError);
  assert.equal(api.identity.id, 'student');
});
