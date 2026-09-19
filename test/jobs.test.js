import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { JobStore, readJson, writeJson, exists } from '../desktop/src/jobs.js';
import { executeJob } from '../desktop/src/job-worker.js';
import { runDispatcher, BookingQueue } from '../desktop/src/dispatcher.js';
import { sleep } from '../shared/utils.js';
import { windowsArgument, windowsRegistration } from '../desktop/src/native-scheduler.js';

const metadata = { campusList: [{ XQDM: '1', XQDM_DISPLAY: '粤海校区' }],
  xmList: [{ XQDM: '1', XMDM: '001', XMMC: '羽毛球', DCFS: '1.0' }],
  packageVenueList: [{ SSXQ: '1', XM: '001', CGBM: 'v', CGMC: '东馆' }] };
async function fixture(mode = 'now') {
  const dataDir = await mkdtemp(join(tmpdir(), 'szu-job-test-'));
  const id = randomUUID(), dir = join(dataDir, 'jobs', id);
  await mkdir(dir, { recursive: true });
  const target = { id: 'task-1', name: '测试', project: 'badminton', enabled: true, date: '2026-09-20',
    campus: '粤海校区', sport: '羽毛球', mode: '包场', venues: ['东馆'], times: ['19:00-20:00'], courts: ['A'] };
  const job = { id, taskId: target.id, mode, releaseAt: Date.now(), sessionPath: 'unused', createdAt: new Date().toISOString(),
    config: { targets: [target], scheduler: { timeoutMs: 500, queryConcurrency: 1, pollIntervalMs: 10, pollJitterMs: 0 }, booking: { taskConcurrency: 2 } } };
  await writeJson(join(dir, 'job.json'), job);
  await writeJson(join(dir, 'state.json'), { status: 'scheduled', logs: [], successes: [] });
  let calls = 0;
  const api = { async getIdentity() {}, async sampleServerOffset() { return 0; }, async getAvailableDates() {}, async getSportVenueData() { return metadata; },
    async getOpeningRooms() { return [{ WID: 'A', CDMC: 'A', CGBM: 'v' }]; },
    async book() { calls++; return { code: '0', data: { DHID: 'order-1' } }; } };
  const createApi = async () => ({ api, client: { async flush() {} } });
  const scheduler = { async remove() {}, async register() {} };
  const store = new JobStore({ dataDir, root: dataDir, scheduler });
  return { dataDir, dir, id, job, api, createApi, store, calls: () => calls };
}
test('独立执行保存日志/结果，重复唤起不会再次下单', async () => {
  const f = await fixture();
  await executeJob(f.dir, { createApi: f.createApi });
  await executeJob(f.dir, { createApi: f.createApi });
  const state = await f.store.get(f.id);
  assert.equal(state.status, 'success'); assert.equal(state.successes[0].orderId, 'order-1');
  assert.ok(state.logs.some((line) => line.level === 'OK')); assert.equal(f.calls(), 1);
});
test('提前停止的任务即使被系统再次启动也不访问预约接口', async () => {
  const f = await fixture(); await f.store.stop(f.id);
  await executeJob(f.dir, { createApi: async () => { throw new Error('should not reach API'); } });
  assert.equal((await f.store.get(f.id)).status, 'stopped'); assert.equal(f.calls(), 0);
});
test('执行使用任务指定的账号文件，身份改变时不下单', async () => {
  const f = await fixture();
  f.job.sessionPath = 'roommate-session.json'; f.job.accountIdentityId = 'roommate-id';
  await writeJson(join(f.dir, 'job.json'), f.job);
  f.api.getIdentity = async () => ({ id: 'wrong-user', name: '其他用户' });
  let usedPath;
  await executeJob(f.dir, { createApi: async (path) => { usedPath = path; return f.createApi(); } });
  assert.equal(usedPath, 'roommate-session.json');
  assert.equal((await f.store.get(f.id)).status, 'error');
  assert.match((await f.store.get(f.id)).error, /登录身份/); assert.equal(f.calls(), 0);
});
test('错过执行窗口不补交；删除记录移入回收目录', async () => {
  const f = await fixture('schedule'); f.job.releaseAt = Date.now() - 31 * 60_000;
  await writeJson(join(f.dir, 'job.json'), f.job);
  await executeJob(f.dir, { createApi: f.createApi });
  assert.equal((await f.store.get(f.id)).status, 'missed'); assert.equal(f.calls(), 0);
  await f.store.remove(f.id);
  assert.equal(await exists(f.dir), false);
  assert.equal(await exists(join(f.dataDir, 'trash', f.id, 'state.json')), true);
});
test('停止正在提交的任务仍落盘成功结果', async () => {
  const f = await fixture();
  f.api.book = async () => { await writeFile(join(f.dir, 'stop'), 'stop'); await sleep(260); return { code: '0' }; };
  await executeJob(f.dir, { createApi: f.createApi });
  const state = await f.store.get(f.id); assert.equal(state.status, 'stopped'); assert.equal(state.successes.length, 1);
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
  await Promise.all([runDispatcher(f.dataDir, { createApi: f.createApi, idleMs: 10 }),
    runDispatcher(f.dataDir, { createApi: f.createApi, idleMs: 10 })]);
  assert.equal(max, 1);
  assert.equal((await f.store.get(f.id)).status, 'success');
  assert.equal((await f.store.get(id2)).status, 'success');
  assert.equal(await exists(join(f.dataDir, 'dispatcher.lock')), false);
});
test('Windows注册设置定时唤醒、不因电池暂停、最小权限且正确引用路径', () => {
  const script = windowsRegistration({ id: randomUUID(), at: Date.now() + 1000,
    executable: 'C:\\Program Files\\node.exe', args: ['C:\\a b\\worker.js', "C:\\user's files\\data"], cwd: 'C:\\a b' });
  assert.match(script, /WakeToRun/); assert.match(script, /LogonType Interactive/);
  assert.match(script, /New-ScheduledTaskTrigger -AtLogOn/);
  assert.match(script, /DontStopIfGoingOnBatteries/); assert.match(script, /user''s files/);
  assert.equal(windowsArgument('a b'), '"a b"');
});
test('迟到15分钟仍可启动，并从实际开始获得完整持续时间', async () => {
  const f = await fixture('schedule'); f.job.releaseAt = Date.now() - 15 * 60000;
  await writeJson(join(f.dir, 'job.json'), f.job);
  const started = Date.now();
  await executeJob(f.dir, { createApi: f.createApi });
  const state = await f.store.get(f.id);
  assert.equal(state.status, 'success'); assert.equal(f.calls(), 1);
  assert.ok(state.deadline >= started + f.job.config.scheduler.timeoutMs);
});
test('重启恢复跳过已成功时段，保留同场优先；终态不重跑', async () => {
  const f = await fixture('schedule'); f.job.releaseAt = Date.now() - 60000;
  f.job.config.targets[0].times = ['19:00-20:00', '20:00-21:00']; f.job.config.targets[0].preferSameCourt = true;
  await writeJson(join(f.dir, 'job.json'), f.job);
  await writeJson(join(f.dir, 'state.json'), { status: 'booking', recoveryVersion: 1, pid: 99999999,
    startedAt: new Date(Date.now() - 60000).toISOString(), attempt: 1, logs: [],
    successes: [{ date: f.job.config.targets[0].date, time: '19:00-20:00', court: 'A', room: { WID: 'A', CDMC: 'A', CGBM: 'v' }, orderId: 'prior' }] });
  const times = []; f.api.book = async ({ time }) => { times.push(time); return { code: '0' }; };
  await executeJob(f.dir, { createApi: f.createApi });
  await executeJob(f.dir, { createApi: f.createApi });
  assert.deepEqual(times, ['20:00-21:00']); const state = await f.store.get(f.id);
  assert.equal(state.successes.length, 2); assert.equal(state.attempt, 2); assert.equal(state.status, 'success');
});
test('中断请求先核对学校有效订单；不重复提交', async () => {
  const f = await fixture('schedule'); f.job.releaseAt = Date.now() - 60000;
  await writeJson(join(f.dir, 'job.json'), f.job);
  const date = f.job.config.targets[0].date;
  await writeJson(join(f.dir, 'state.json'), { status: 'booking', recoveryVersion: 1, pid: 99999999,
    startedAt: new Date().toISOString(), logs: [], successes: [], pendingRequests: { key: {
      date, time: '19:00-20:00', room: { WID: 'A', CDMC: 'A', XMDM: '001' } } } });
  f.api.getBookings = async () => ({ rows: [{ CDWID: 'A', XMDM: '001', YYSJD: `${date} 19:00~${date} 20:00`, YYZT_DISPLAY: '已预约', DHID: 'recovered' }], totalSize: 1 });
  await executeJob(f.dir, { createApi: f.createApi });
  const state = await f.store.get(f.id); assert.equal(state.status, 'success');
  assert.equal(state.successes[0].orderId, 'recovered'); assert.equal(f.calls(), 0);
});
test('桌面并发任务同账号项目合计两个时段后正常完成', async () => {
  const f = await fixture(); const id2 = randomUUID(), dir2 = join(f.dataDir, 'jobs', id2);
  f.job.config.targets[0].times = ['17:00-18:00', '18:00-19:00'];
  await writeJson(join(f.dir, 'job.json'), f.job); await mkdir(dir2);
  await writeJson(join(dir2, 'job.json'), { ...f.job, id: id2, taskId: 'task-2', config: { ...f.job.config,
    targets: [{ ...f.job.config.targets[0], times: ['19:00-20:00', '20:00-21:00'] }] } });
  await writeJson(join(dir2, 'state.json'), { status: 'scheduled', logs: [], successes: [] });
  await runDispatcher(f.dataDir, { createApi: f.createApi, idleMs: 10 });
  const states = await Promise.all([f.store.get(f.id), f.store.get(id2)]);
  assert.equal(f.calls(), 2); assert.ok(states.every((s) => s.status === 'success'));
  assert.ok(states.some((s) => s.limited));
});
test('桌面恢复两个已成功时段：其余候选不再提交', async () => {
  const f = await fixture('schedule'); f.job.releaseAt = Date.now() - 60000;
  f.job.config.targets[0].times = ['17:00-18:00', '18:00-19:00', '19:00-20:00'];
  await writeJson(join(f.dir, 'job.json'), f.job);
  await writeJson(join(f.dir, 'state.json'), { status: 'booking', recoveryVersion: 1, pid: 99999999,
    startedAt: new Date().toISOString(), logs: [], successes: ['17:00-18:00', '18:00-19:00'].map((time) => ({
      date: f.job.config.targets[0].date, time, room: { WID: 'A', CDMC: 'A', CGBM: 'v', XMDM: '001' } })) });
  await runDispatcher(f.dataDir, { createApi: f.createApi, idleMs: 10 });
  const state = await f.store.get(f.id);
  assert.equal(state.status, 'success'); assert.equal(state.limited, true); assert.equal(f.calls(), 0);
});
