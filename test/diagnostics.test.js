import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDiagnostics, recordDiagnostic, exportDiagnostics } from '../shared/diagnostics.js';
import { DiagnosticJournal, readDiagnosticJournal } from '../desktop/src/diagnostics.js';
import { CoreHttpClient } from '../shared/http-client-core.js';
import { HttpResponseError, SessionExpiredError } from '../shared/errors.js';

test('长执行即使界面日志截断，参数、总计和每时段最后结果仍保留，导出明确列出缺失数量', () => {
  const diagnostics = createDiagnostics({ platform: 'android', plans: [{ date: '2026-10-01', times: ['19:00-20:00'],
    courts: ['A', 'B'], preferSameCourt: true, includeOtherCourts: false }] });
  const logs = [];
  for (let i = 0; i < 600; i++) {
    logs.push(recordDiagnostic(diagnostics, 'WARN', '无空位', { event: 'booking_response', planId: 'p',
      date: '2026-10-01', time: '19:00-20:00', outcome: 'retry', durationMs: 42 }));
    if (logs.length > 300) { logs.shift(); diagnostics.uiEventsDropped++; }
  }
  const output = exportDiagnostics({ id: 'run', diagnostics, logs });
  assert.equal(output.events.length, 300); assert.equal(output.missingEvents, 300);
  assert.equal(output.diagnostics.counts.booking_response, 600);
  assert.equal(Object.values(output.diagnostics.slotSummaries)[0].attempts, 600);
  assert.deepEqual(output.diagnostics.plans[0].courts, ['A', 'B']);
});

test('导出不包含会话、Cookie、学校身份或订单号，也清除异常文本中的凭据', () => {
  const diagnostics = createDiagnostics({ plans: [{ accountId: 'private-account', times: ['19:00-20:00'],
    session: { cookies: [{ value: 'cookie-secret' }] } }] });
  const entry = recordDiagnostic(diagnostics, 'ERROR', 'Cookie: _WEU=inline-secret', {
    event: 'booking_error', headers: { authorization: 'header-secret' },
    response: { data: { DHID: 'private-order', YYRGH: 'private-student' } },
    message: '请求失败 MOD_AUTH_CAS=ticket-secret; https://example.test/?ticket=url-secret',
  });
  const output = JSON.stringify(exportDiagnostics({ diagnostics, logs: [entry],
    successes: [{ accountId: 'private-account', orderId: 'private-order', time: '19:00-20:00', court: 'A' }],
    pendingRequests: { userId: 'private-student', time: '20:00-21:00' } }));
  for (const secret of ['private-account', 'cookie-secret', 'inline-secret', 'header-secret', 'private-order', 'private-student', 'ticket-secret', 'url-secret']) {
    assert.ok(!output.includes(secret), secret);
  }
  assert.ok(output.includes('19:00-20:00')); assert.ok(output.includes('[已移除]'));
});
test('参数保留匿名账号分组，维护时仍能识别哪些方案共享名额', () => {
  const diagnostics = createDiagnostics({ plans: [{ accountId: 'private-a' }, { accountId: 'private-b' }, { accountId: 'private-a' }] });
  assert.deepEqual(diagnostics.plans.map((p) => p.accountRef), ['user-1', 'user-2', 'user-1']);
  assert.ok(!JSON.stringify(diagnostics).includes('private-a'));
});

test('桌面追加日志保留早期事件，容量封顶后与近期记录合并，进程中断的半行仍可读取', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'court-journal-'));
  try {
    const journal = new DiagnosticJournal(dir, 500);
    const diagnostics = createDiagnostics(); const tail = [];
    for (let i = 0; i < 10; i++) {
      const entry = recordDiagnostic(diagnostics, 'INFO', '事件' + i, { event: 'test_event' });
      const saved = await journal.append(entry);
      if (!saved) diagnostics.journalTruncated = true;
      tail.push(entry); if (tail.length > 2) tail.shift();
    }
    const content = await readFile(journal.path);
    assert.ok(content.length <= 500); assert.equal(diagnostics.journalTruncated, true);
    await appendFile(journal.path, '{"sequence":');
    const events = await readDiagnosticJournal(dir);
    assert.equal(events[0].sequence, 1);
    const output = exportDiagnostics({ diagnostics, logs: tail }, events);
    assert.equal(output.events[0].sequence, 1); assert.equal(output.events.at(-1).sequence, 10);
    assert.ok(output.missingEvents > 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('手机多方案各自保留结束统计，不被最后完成的方案覆盖', () => {
  const diagnostics = createDiagnostics();
  recordDiagnostic(diagnostics, 'SUMMARY', '统计', { event: 'execution_summary', planId: 'a', attempts: 2 });
  recordDiagnostic(diagnostics, 'SUMMARY', '统计', { event: 'execution_summary', planId: 'b', attempts: 3 });
  assert.equal(diagnostics.summaries.a.attempts, 2); assert.equal(diagnostics.summaries.b.attempts, 3);
});

test('诊断前半段保留首单与各阶段耗时，保存事件不增加提交次数或覆盖业务结果', () => {
  const diagnostics = createDiagnostics(), key = { planId: 'p', date: '2026-10-15', time: '12:00-13:00' };
  recordDiagnostic(diagnostics, 'REQUEST', '派发', { ...key, event: 'booking_dispatch', sentAt: diagnostics.startedAtMs + 154 });
  recordDiagnostic(diagnostics, 'INFO', '保存', { ...key, event: 'booking_persistence', durationMs: 23 });
  recordDiagnostic(diagnostics, 'OK', '成功', { ...key, event: 'booking_response', outcome: 'success', durationMs: 950,
    transportQueueMs: 15, nativeQueueMs: 2, dispatchPreparationMs: 7, networkDurationMs: 910, headersDurationMs: 850 });
  recordDiagnostic(diagnostics, 'INFO', '保存', { ...key, event: 'booking_persistence', durationMs: 11 });
  const slot = Object.values(diagnostics.slotSummaries)[0];
  assert.equal(diagnostics.firstDispatchElapsedMs, 154); assert.equal(slot.attempts, 1); assert.equal(slot.lastOutcome, 'success');
  assert.equal(slot.lastPersistenceMs, 11); assert.equal(slot.lastTransportQueueMs, 15);
  assert.equal(slot.lastNativeQueueMs, 2); assert.equal(slot.lastDispatchPreparationMs, 7); assert.equal(slot.lastNetworkDurationMs, 910);
  assert.equal(slot.lastHeadersDurationMs, 850);
});

test('HTML网关503仍是可重试网络故障，登录重定向仍是身份失效', async () => {
  for (const status of [503, 302]) {
    const client = new CoreHttpClient({ cookies: [], userAgent: 'test' }, { transport: async () => ({
      status, ok: false, headers: { get: () => 'text/html', getSetCookie: () => [] }, text: async () => '<html>gateway</html>',
    }) });
    await assert.rejects(client.post('sportVenue/getRqList.do'), status === 503 ? HttpResponseError : SessionExpiredError);
  }
});
