import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { JobStore, readJson, writeJson, exists } from '../desktop/src/jobs.js';
import { executeJob } from '../desktop/src/job-worker.js';
import { runDispatcher } from '../desktop/src/dispatcher.js';
import { LiveExecution, BookingQueue } from '../desktop/src/execution.js';
import { shanghaiDate, addDays, sleep } from '../shared/utils.js';
import { windowsArgument } from '../desktop/src/native-scheduler.js';
import { processOwner, matchesProcessOwner } from '../desktop/src/process-owner.js';
import { spawn } from 'node:child_process';

const metadata = { campusList: [{ XQDM: '1', XQDM_DISPLAY: '粤海校区' }],
  xmList: [{ XQDM: '1', XMDM: '001', XMMC: '羽毛球', DCFS: '1.0' }],
  packageVenueList: [{ SSXQ: '1', XM: '001', CGBM: 'v', CGMC: '东馆' }] };
async function fixture(mode = 'now') {
  const dataDir = await mkdtemp(join(tmpdir(), 'szu-job-test-'));
  const id = randomUUID(), dir = join(dataDir, 'jobs', id);
  await mkdir(dir, { recursive: true });
  const target = { id: 'task-1', name: '测试', project: 'badminton', enabled: true, date: addDays(shanghaiDate(), 1),
    campus: '粤海校区', sport: '羽毛球', mode: '包场', venues: ['东馆'], times: ['19:00-20:00'], courts: ['A'] };
  const job = { id, taskId: target.id, mode, releaseAt: Date.now(), sessionPath: 'unused', createdAt: new Date().toISOString(),
    config: { targets: [target], scheduler: { timeoutMs: 500, queryConcurrency: 1, pollIntervalMs: 10, pollJitterMs: 0 }, booking: { taskConcurrency: 2 } } };
  await writeJson(join(dir, 'job.json'), job);
  await writeJson(join(dir, 'state.json'), { status: 'scheduled', logs: [], successes: [] });
  let calls = 0;
  const api = { async getIdentity() {}, async sampleServerOffset() { return 0; }, async getAvailableDates() {}, async getSportVenueData() { return metadata; },
    async getAllBookings() { return []; },
    async getOpeningRooms() { return [{ WID: 'A', CDMC: 'A', CGBM: 'v' }]; },
    async book() { calls++; return { code: '0', data: { DHID: 'order-1' } }; } };
  const createApi = async () => ({ api, client: { async flush() {} } });
  const scheduler = { async remove() {}, async register() {} };
  const store = new JobStore({ dataDir, root: dataDir, scheduler });
  return { dataDir, dir, id, job, api, createApi, store, calls: () => calls };
}
test('新版拒绝系统定时创建，临场执行不注册系统任务', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-09-20T12:00:00+08:00') });
  const f = await fixture(); let starts = 0, registrations = 0;
  f.store.startJob = () => { starts++; };
  f.store.scheduler.register = async () => { registrations++; };
  const target = { ...f.job.config.targets[0], date: addDays(shanghaiDate(), 1) };
  await assert.rejects(f.store.create(target, f.job.config, 'schedule'), /已移除系统定时/);
  const job = await f.store.create(target, f.job.config, 'release');
  assert.equal(job.status, 'queued'); assert.equal(starts, 1); assert.equal(registrations, 0);
});
test('旧系统入口只清理定时，不访问学校；失败时仍先阻止旧任务', async () => {
  const f = await fixture('schedule'); let removals = 0;
  await runDispatcher(f.dataDir, { scheduler: { async remove() { removals++; } } });
  assert.equal(removals, 1); assert.equal(await exists(join(f.dir, 'stop')), true);
  await executeJob(f.dir, { createApi: () => { throw new Error('不得访问学校'); } });
  assert.equal((await f.store.get(f.id)).status, 'stopped'); assert.equal(f.calls(), 0);
  const bad = await fixture('schedule'); bad.store.scheduler.remove = async () => { throw new Error('权限不足'); };
  assert.match((await bad.store.retireSchedules())[0], /权限不足/);
  assert.equal(await exists(join(bad.dir, 'stop')), true);
  assert.equal(await exists(join(bad.dir, 'schedule-retired')), false);
});
test('中断任务和未经手动启动的任务都不自动执行，成功记录保留', async () => {
  const f = await fixture();
  await writeJson(join(f.dir, 'state.json'), { status: 'booking', pid: 99999999,
    startedAt: new Date().toISOString(), logs: [], successes: [{ time: '19:00-20:00', orderId: 'prior' }] });
  assert.equal((await f.store.get(f.id)).status, 'interrupted');
  await executeJob(f.dir, { manualStart: true, createApi: f.createApi });
  assert.equal(f.calls(), 0); assert.equal((await f.store.get(f.id)).successes.length, 1);
  const fresh = await fixture(); await executeJob(fresh.dir, { createApi: fresh.createApi });
  assert.equal(fresh.calls(), 0); assert.equal((await fresh.store.get(fresh.id)).status, 'stopped');
});
test('退出助手停止等待，不补跑；在途请求成功仍保存', async () => {
  for (const waiting of [true, false]) {
    const f = await fixture(waiting ? 'release' : 'now');
    f.job.releaseAt = waiting ? Date.now() + 60000 : Date.now();
    await writeJson(join(f.dir, 'job.json'), f.job);
    const live = new LiveExecution({ createApi: f.createApi });
    if (waiting) f.api.sampleServerOffset = async () => { void live.close(); return 0; };
    else f.api.book = async () => { void live.close(); await sleep(5); return { code: '0' }; };
    await live.start(f.dir);
    const state = await f.store.get(f.id);
    assert.equal(state.status, 'stopped'); assert.equal(state.successes.length, waiting ? 0 : 1);
    assert.throws(() => live.start(f.dir), /正在退出/);
  }
});
test('同一数据目录的不同助手不能各自发送；当前执行结束后释放锁', async () => {
  const f = await fixture('release'); f.job.releaseAt = Date.now() + 60_000;
  await writeJson(join(f.dir, 'job.json'), f.job);
  const first = new LiveExecution({ dataDir: f.dataDir, createApi: f.createApi });
  const second = new LiveExecution({ dataDir: f.dataDir, createApi: f.createApi });
  const work = first.start(f.dir);
  assert.equal(Number((await readFile(join(f.dataDir, 'dispatcher.lock'), 'utf8')).split('\n')[0]), process.pid);
  assert.throws(() => second.start(f.dir), /另一个助手实例/);
  await first.close(); await work;
  assert.equal(await exists(join(f.dataDir, 'dispatcher.lock')), false);
  await second.start(f.dir); // A finished record is still never replayed.
  assert.equal(f.calls(), 0);
});
test('崩溃遗留的空执行锁可释放，但不会因此恢复旧任务', async () => {
  const f = await fixture();
  const lock = join(f.dataDir, 'dispatcher.lock'); await writeFile(lock, '');
  await utimes(lock, new Date(0), new Date(0));
  const live = new LiveExecution({ dataDir: f.dataDir, createApi: f.createApi });
  await live.start(f.dir);
  assert.equal(f.calls(), 1); assert.equal(await exists(lock), false);
});
test('独立执行保存日志/结果，重复唤起不会再次下单', async () => {
  const f = await fixture();
  await executeJob(f.dir, { manualStart: true, createApi: f.createApi });
  await executeJob(f.dir, { manualStart: true, createApi: f.createApi });
  const state = await f.store.get(f.id);
  assert.equal(state.status, 'success'); assert.equal(state.successes[0].orderId, 'order-1');
  assert.ok(state.logs.some((line) => line.level === 'OK')); assert.equal(f.calls(), 1);
});
test('提前停止的任务即使被系统再次启动也不访问预约接口', async () => {
  const f = await fixture(); await f.store.stop(f.id);
  await executeJob(f.dir, { manualStart: true, createApi: async () => { throw new Error('should not reach API'); } });
  assert.equal((await f.store.get(f.id)).status, 'stopped'); assert.equal(f.calls(), 0);
});
test('执行使用任务指定的账号文件，身份改变时不下单', async () => {
  const f = await fixture();
  f.job.sessionPath = 'roommate-session.json'; f.job.accountIdentityId = 'roommate-id';
  await writeJson(join(f.dir, 'job.json'), f.job);
  f.api.getIdentity = async () => ({ id: 'wrong-user', name: '其他用户' });
  let usedPath;
  await executeJob(f.dir, { manualStart: true, createApi: async (path) => { usedPath = path; return f.createApi(); } });
  assert.equal(usedPath, 'roommate-session.json');
  assert.equal((await f.store.get(f.id)).status, 'error');
  assert.match((await f.store.get(f.id)).error, /登录身份/); assert.equal(f.calls(), 0);
});
test('停止正在提交的任务仍落盘成功结果', async () => {
  const f = await fixture();
  f.api.book = async () => { await writeFile(join(f.dir, 'stop'), 'stop'); await sleep(260); return { code: '0' }; };
  await executeJob(f.dir, { manualStart: true, createApi: f.createApi });
  const state = await f.store.get(f.id); assert.equal(state.status, 'stopped'); assert.equal(state.successes.length, 1);
});
test('桌面明确未发出的请求不保留待核对意图', async () => {
  const f = await fixture();
  f.api.book = async () => { throw Object.assign(new Error('执行窗口已结束，未发送请求'), { code: 'REQUEST_NOT_SENT' }); };
  await executeJob(f.dir, { manualStart: true, createApi: f.createApi });
  const state = await f.store.get(f.id);
  assert.deepEqual(state.pendingRequests, {});
  assert.match(state.error, /未发送/); assert.doesNotMatch(state.error, /待确认/);
});
test('桌面停止时在途请求超时，仍保留待核对记录和提示', async () => {
  const f = await fixture();
  f.api.book = async () => { await writeFile(join(f.dir, 'stop'), 'stop'); await sleep(260); throw new Error('timeout'); };
  await executeJob(f.dir, { manualStart: true, createApi: f.createApi });
  const state = await f.store.get(f.id);
  assert.equal(state.status, 'stopped'); assert.equal(Object.keys(state.pendingRequests).length, 1);
  assert.match(state.error, /待确认/);
});
test('桌面请求已记录意图但仍在全局队列中，停止后清除待核对标记', async () => {
  const f = await fixture(); const queue = new BookingQueue(); let release;
  const blocker = queue.run(() => new Promise((resolve) => { release = resolve; }));
  const original = f.api.book;
  await executeJob(f.dir, { manualStart: true, createApi: async (path, signal) => {
    signal.addEventListener('abort', () => release(), { once: true });
    f.api.book = async (input) => {
      await writeFile(join(f.dir, 'stop'), 'stop');
      return queue.run(() => original(input), signal);
    };
    return f.createApi();
  } });
  await blocker;
  const state = await f.store.get(f.id);
  assert.equal(f.calls(), 0); assert.equal(state.status, 'stopped');
  assert.deepEqual(state.pendingRequests, {}); assert.equal(state.error, undefined);
});
test('共享预约队列只允许一个请求在途，排队中取消不发出请求', async () => {
  const queue = new BookingQueue(); let inFlight = 0, max = 0, calls = 0;
  const controller = new AbortController();
  const operation = async () => { calls++; inFlight++; max = Math.max(max, inFlight); await sleep(10); inFlight--; };
  const works = [queue.run(operation), queue.run(operation, controller.signal), queue.run(operation)];
  controller.abort(); await Promise.allSettled(works);
  assert.equal(max, 1); assert.equal(calls, 2);
});
test('同一后台执行器接收多个任务并串行发出预约请求', async () => {
  const f = await fixture(); const id2 = randomUUID(), dir2 = join(f.dataDir, 'jobs', id2);
  await mkdir(dir2);
  await writeJson(join(dir2, 'job.json'), { ...f.job, id: id2, taskId: 'task-2', config: { ...f.job.config,
    targets: [{ ...f.job.config.targets[0], times: ['20:00-21:00'] }] } });
  await writeJson(join(dir2, 'state.json'), { status: 'scheduled', logs: [], successes: [] });
  let inFlight = 0, max = 0;
  f.api.book = async () => { inFlight++; max = Math.max(max, inFlight); await sleep(25); inFlight--; return { code: '0' }; };
  const live = new LiveExecution({ createApi: f.createApi });
  await Promise.all([live.start(f.dir), live.start(dir2)]);
  assert.equal(max, 1);
  assert.equal((await f.store.get(f.id)).status, 'success');
  assert.equal((await f.store.get(id2)).status, 'success');
  assert.equal(await exists(join(f.dataDir, 'dispatcher.lock')), false);
});
test('Windows参数仍正确引用带空格路径，供旧入口清理与诊断使用', () => {
  assert.equal(windowsArgument('a b'), '"a b"');
});
test('桌面并发任务同账号项目合计两个时段后正常完成', async () => {
  const f = await fixture(); const id2 = randomUUID(), dir2 = join(f.dataDir, 'jobs', id2);
  f.job.config.targets[0].times = ['17:00-18:00', '18:00-19:00'];
  await writeJson(join(f.dir, 'job.json'), f.job); await mkdir(dir2);
  await writeJson(join(dir2, 'job.json'), { ...f.job, id: id2, taskId: 'task-2', config: { ...f.job.config,
    targets: [{ ...f.job.config.targets[0], times: ['19:00-20:00', '20:00-21:00'] }] } });
  await writeJson(join(dir2, 'state.json'), { status: 'scheduled', logs: [], successes: [] });
  const live = new LiveExecution({ createApi: f.createApi });
  await Promise.all([live.start(f.dir), live.start(dir2)]);
  const states = await Promise.all([f.store.get(f.id), f.store.get(id2)]);
  assert.equal(f.calls(), 2); assert.ok(states.every((s) => ['success', 'partial', 'limited'].includes(s.status)));
  assert.equal(states.reduce((count, s) => count + s.successes.length, 0), 2);
  assert.ok(states.some((s) => s.limited));
});

test('进程编号仍存活但启动身份不符时，历史状态和锁均按中断处理', async () => {
  const f = await fixture();
  await writeJson(join(f.dir, 'state.json'), { status: 'booking', pid: process.pid,
    processIdentity: `${processOwner.identity}-old`, logs: [], successes: [] });
  assert.equal((await f.store.get(f.id)).status, 'interrupted');
  await writeFile(join(f.dataDir, 'dispatcher.lock'), `${process.pid}\n${processOwner.identity}-old\nstale`);
  await writeFile(join(f.dir, 'run.lock'), `${process.pid}\n${processOwner.identity}-old\nstale`);
  const live = new LiveExecution({ dataDir: f.dataDir, createApi: f.createApi });
  await live.start(f.dir);
  assert.equal(f.calls(), 1);
  assert.equal(await exists(join(f.dataDir, 'dispatcher.lock')), false);
});

test('首单意图预写后进程崩溃，发送标记使核对仍能识别未知提交', async () => {
  const f = await fixture();
  const requestId = '2026-10-12|19:00-20:00';
  const prepared = { date: '2026-10-12', time: '19:00-20:00', preparedAt: new Date().toISOString(), room: { WID: 'A' } };
  await writeJson(join(f.dir, 'state.json'), { status: 'booking', pid: 99999999, logs: [], successes: [],
    pendingRequests: { [requestId]: prepared } });
  await writeJson(join(f.dir, 'dispatch.json'), { pendingRequests: { [requestId]: { ...prepared, sentAt: new Date().toISOString() } } });
  assert.ok((await f.store.get(f.id)).pendingRequests[requestId].sentAt);
  const summary = (await f.store.list({ summary: true }))[0];
  assert.ok(summary.pendingRequests[requestId].sentAt);
  await f.store.recordReview(f.id, { resolvedRequests: [{ requestId, outcome: 'school_order_matched' }], reviewedOutcome: 'success' });
  const state = await f.store.get(f.id);
  assert.deepEqual(state.pendingRequests, {}); assert.equal(state.status, 'success');
  assert.ok(state.reviewedRequests[requestId].sentAt);
  assert.equal(await exists(join(f.dir, 'dispatch.json')), false);
});

test('历史轮询摘要省略大日志并复用未变化记录，状态变更会刷新缓存', async (t) => {
  const f = await fixture();
  await writeJson(join(f.dir, 'state.json'), { status: 'success', successes: [{ orderId: 'known' }],
    logs: Array.from({ length: 500 }, (_, index) => ({ message: `event ${index}`, details: { payload: 'x'.repeat(1000) } })),
    diagnostics: { events: ['x'.repeat(1000)] } });
  const first = (await f.store.list({ summary: true }))[0];
  assert.equal(first.logs, undefined); assert.equal(first.diagnostics, undefined); assert.equal(first.logCount, 500);
  assert.ok(JSON.stringify(first).length < 2000);
  const parse = t.mock.method(JSON, 'parse');
  await f.store.list({ summary: true });
  assert.equal(parse.mock.callCount(), 0, '未变化的历史不应每次读取解析完整日志');
  await writeJson(join(f.dir, 'state.json'), { status: 'partial', successes: [{ orderId: 'known' }], logs: [] });
  assert.equal((await f.store.list({ summary: true }))[0].status, 'partial');
  assert.ok(parse.mock.callCount() >= 2);
});

test('未知预约不能靠删除历史隐藏，确认核对后可删除', async () => {
  const f = await fixture(), requestId = '2026-10-12|19:00-20:00';
  await writeJson(join(f.dir, 'state.json'), { status: 'error', logs: [], successes: [], pendingRequests: {
    [requestId]: { date: '2026-10-12', time: '19:00-20:00', sentAt: new Date().toISOString() } } });
  await assert.rejects(f.store.remove(f.id), /待确认.*核对/);
  assert.equal(await exists(join(f.dir, 'state.json')), true);
  await f.store.recordReview(f.id, { resolvedRequests: [{ requestId, outcome: 'confirmed_no_order' }] });
  await f.store.remove(f.id);
  assert.equal(await exists(f.dir), false);
});

test('损坏状态仍保留账号和日期，明确核对恢复前不能删除；恢复保存原文件', async () => {
  const f = await fixture();
  f.job.accountIdentityId = 'school-account-A'; await writeJson(join(f.dir, 'job.json'), f.job);
  const original = '{"status":"booking",'; await writeFile(join(f.dir, 'state.json'), original);
  const corrupt = await f.store.inspect(f.id);
  assert.equal(corrupt.requiresReview, true); assert.equal(corrupt.accountIdentityId, 'school-account-A');
  assert.equal(corrupt.target.date, f.job.config.targets[0].date);
  await assert.rejects(f.store.remove(f.id), /损坏.*核对/);
  await f.store.recordReview(f.id, { acknowledgeCorrupt: true });
  const restored = await f.store.get(f.id);
  assert.equal(restored.requiresReview, false); assert.equal(restored.successes.length, 0);
  assert.equal(await readFile(join(f.dir, restored.recovery.preservedFiles[0]), 'utf8'), original);
});

test('旧 Windows PID 记录通过实际命令和创建时间识别进程复用', () => {
  const owner = { pid: 42, startedAt: '2026-10-11T10:00:00Z' };
  assert.equal(matchesProcessOwner(owner, { commandLine: 'node.exe unrelated.js', createdAt: '2026-10-11T09:00:00Z' }), false);
  assert.equal(matchesProcessOwner(owner, { commandLine: 'C:\\apps\\SZU-CourtBooker.exe', createdAt: '2026-10-11T11:00:00Z' }), false);
  assert.equal(matchesProcessOwner(owner, { commandLine: 'C:\\apps\\SZU-CourtBooker.exe', createdAt: '2026-10-11T09:00:00Z' }), true);
});

test('旧 PID-only 记录被无关真实进程复用时，不应卡住停止和执行锁', async (t) => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => child.kill());
  const f = await fixture();
  await writeJson(join(f.dir, 'state.json'), { status: 'booking', pid: child.pid, logs: [], successes: [] });
  assert.equal((await f.store.get(f.id)).status, 'interrupted');
  await writeFile(join(f.dataDir, 'dispatcher.lock'), String(child.pid));
  await writeFile(join(f.dir, 'run.lock'), String(child.pid));
  const live = new LiveExecution({ dataDir: f.dataDir, createApi: f.createApi });
  await live.start(f.dir);
  assert.equal(f.calls(), 1); process.kill(child.pid, 0);
});

test('核对状态已保存但发送标记尚未清除时，摘要不能重新显示已核实请求', async () => {
  const f = await fixture(), requestId = '2026-10-12|19:00-20:00';
  const intent = { date: '2026-10-12', time: '19:00-20:00', sentAt: new Date().toISOString() };
  await writeJson(join(f.dir, 'state.json'), { status: 'error', logs: [], successes: [], pendingRequests: {},
    reviewedRequests: { [requestId]: { ...intent, checkedAt: new Date().toISOString() } } });
  await writeJson(join(f.dir, 'dispatch.json'), { pendingRequests: { [requestId]: intent } });
  assert.deepEqual((await f.store.get(f.id)).pendingRequests, {});
  assert.deepEqual((await f.store.list({ summary: true }))[0].pendingRequests, {});
});

test('明确业务响应已保存而发送标记残留时不误报未知，后续不同尝试仍保留', async () => {
  for (const code of ['0', '1']) {
    const f = await fixture(), key = '2026-10-12|19:00-20:00', attemptId = randomUUID();
    const intent = { attemptId, date: '2026-10-12', time: '19:00-20:00', sentAt: new Date().toISOString() };
    await writeJson(join(f.dir, 'state.json'), { status: 'error', logs: [], successes: [], pendingRequests: {},
      completedRequests: { [key]: { attemptId, code, message: code === '1' ? '已满' : undefined } } });
    await writeJson(join(f.dir, 'dispatch.json'), { pendingRequests: { [key]: intent } });
    assert.deepEqual((await f.store.get(f.id)).pendingRequests, {});
    assert.deepEqual((await f.store.list({ summary: true }))[0].pendingRequests, {});
    await writeJson(join(f.dir, 'dispatch.json'), { pendingRequests: { [key]: { ...intent, attemptId: randomUUID() } } });
    assert.equal(Object.keys((await f.store.list({ summary: true }))[0].pendingRequests).length, 1);
  }
});

test('旧 PID-only 执行锁即使碰巧等于当前进程编号，也通过创建时间释放', async () => {
  const f = await fixture(), path = join(f.dataDir, 'dispatcher.lock');
  await writeFile(path, String(process.pid)); await utimes(path, new Date(0), new Date(0));
  const live = new LiveExecution({ dataDir: f.dataDir, createApi: f.createApi });
  await live.start(f.dir); assert.equal(f.calls(), 1);
});
