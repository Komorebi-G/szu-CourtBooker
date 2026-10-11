import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { shanghaiDate } from '../shared/utils.js';

test('真实管理服务：慢预检可取消且不创建执行；只读核对生成剩余建议并保留未知记录', { timeout: 12000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'court-web-preflight-'));
  const mock = join(dir, 'mock-school.mjs'), date = shanghaiDate();
  await writeFile(mock, `
let first = true;
globalThis.fetch = async (url, options) => {
  const path = new URL(url).pathname;
  if (!new URL(url).hostname.endsWith('szu.edu.cn')) throw new Error('Unexpected outbound request');
  if (path.endsWith('/index.do')) {
    if (first) { first = false; process.send({ event: 'identity_waiting' }); await new Promise((r) => process.once('message', r)); }
    const id = options.headers.cookie.includes('fake-fast') ? 'fast-user' : 'test-user';
    return new Response("USERID='" + id + "';USER_INFO={\\"userName\\":\\"测试用户\\"};APP_TITLE=", { headers: { 'content-type': 'text/html' } });
  }
  let data;
  if (path.endsWith('/getRqList.do')) data = [];
  else if (path.endsWith('/getTimeList.do')) data = ['19:00-20:00', '20:00-21:00'].map((CODE) => ({ CODE }));
  else if (path.endsWith('/getSportVenueData.do')) data = {
    campusList: [{ XQDM: '1', XQDM_DISPLAY: '粤海校区' }], xmList: [{ XQDM: '1', XMDM: '001', XMMC: '羽毛球', DCFS: '1.0' }],
    packageVenueList: [{ SSXQ: '1', XM: '001', CGBM: 'v', CGMC: '运动广场东馆羽毛球场' }]
  };
  else if (path.endsWith('/myBookingInfo.do')) data = { code: '0', datas: { myBookingInfo: { totalSize: 1, rows: [
    { YYRQ: ${JSON.stringify(date)}, KYYSJD: '19:00-20:00', XMDM: '001', YYZT_DISPLAY: '待支付', CDWID: 'C', CDMC: 'C场' }
  ] } } };
  else if (path.endsWith('/getOpeningRoom.do')) data = { code: '0', datas: { getOpeningRoom: { rows: [
    { WID: 'C', CGBM: 'v', CDMC: 'C场', XMDM: '001' }
  ] } } };
  else { process.send({ event: 'unexpected', path }); throw new Error('Unexpected school endpoint'); }
  return new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
};
`);
  const config = join(dir, 'config.yaml'), dataDir = join(dir, 'data');
  await writeFile(config, 'targets: []\n');
  const child = spawn(process.execPath, ['--import', pathToFileURL(mock).href, 'src/web-server.js', '--port', '0', '--no-open'],
    { cwd: resolve('.'), env: { ...process.env, WEB_HOST: '127.0.0.1', SZU_CONFIG: config, SZU_DATA: dataDir,
      SZU_SESSION: join(dir, 'session.json') }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  t.after(async () => { child.kill(); await rm(dir, { recursive: true, force: true }); });
  let output = '', errors = ''; const unexpected = [];
  child.stderr.on('data', (value) => errors += value);
  child.on('message', (message) => { if (message.event === 'unexpected') unexpected.push(message.path); });
  const base = await new Promise((resolve, reject) => {
    child.stdout.on('data', (value) => { output += value; const url = /http:\/\/127.0.0.1:\d+/.exec(output); if (url) resolve(url[0]); });
    child.once('error', reject); child.once('exit', (code) => reject(new Error(`Server exited ${code}: ${errors}`)));
  });
  const api = async (path, method = 'GET', body) => {
    const response = await fetch(base + path, { method, signal: AbortSignal.timeout(4000),
      headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  assert.equal((await api('/api/accounts/default/import', 'POST', { text: 'MOD_AUTH_CAS=fake; _WEU=fake' })).status, 200);
  const saved = await api('/api/tasks', 'POST', { projectId: 'badminton', date, name: '核对测试',
    times: ['19:00-20:00', '20:00-21:00'], courts: ['A', 'C'], courtLabels: { A: 'A场', C: 'C场' }, bookingGoal: 'consecutive',
    preferSameCourt: true, intervalMs: 100, durationMs: 60000 });
  assert.equal(saved.status, 201); const taskId = saved.data.taskId, token = randomUUID();
  const gate = once(child, 'message');
  const starting = api(`/api/tasks/${taskId}/run`, 'POST', { mode: 'check', startToken: token });
  assert.equal((await gate)[0].event, 'identity_waiting');
  const fastAccount = (await api('/api/accounts', 'POST', { name: '正常账号' })).data.account;
  await api(`/api/accounts/${fastAccount.id}/import`, 'POST', { text: 'MOD_AUTH_CAS=fake-fast; _WEU=fake' });
  const fastTask = await api('/api/tasks', 'POST', { ...saved.data.config.tasks[0], projectId: 'badminton', accountId: fastAccount.id, name: '独立预检' });
  assert.equal(fastTask.status, 201, '慢预检不能锁住方案保存');
  const fastRun = await api(`/api/tasks/${fastTask.data.taskId}/run`, 'POST', { mode: 'check', startToken: randomUUID() });
  assert.equal(fastRun.status, 202, '慢账号仍在等待时，其他账号应已经完成启动预检');
  assert.equal((await api('/api/starts/cancel', 'POST', { token })).status, 200, '取消必须越过正在等待的预检请求');
  child.send({ event: 'release' });
  const cancelled = await starting;
  assert.equal(cancelled.status, 400); assert.match(cancelled.data.error, /启动已取消/);
  assert.ok((await api('/api/jobs')).data.jobs.every((j) => j.taskId !== taskId));
  const preCancelled = randomUUID();
  await api('/api/starts/cancel', 'POST', { token: preCancelled });
  assert.match((await api(`/api/tasks/${taskId}/run`, 'POST', { mode: 'check', startToken: preCancelled })).data.error, /启动已取消/);
  const historyId = randomUUID(), jobDir = join(dataDir, 'jobs', historyId);
  await mkdir(jobDir, { recursive: true });
  await writeFile(join(jobDir, 'job.json'), JSON.stringify({ mode: 'now', accountId: 'default', accountIdentityId: 'test-user',
    config: { targets: [{ project: 'badminton', date, sport: '羽毛球', campus: '粤海校区', mode: '包场' }] } }));
  const pending = { status: 'interrupted', successes: [], logs: [], pendingRequests: { unknown: { date, time: '20:00-21:00', room: { CDMC: 'C场' } } } };
  await writeFile(join(jobDir, 'state.json'), JSON.stringify(pending));
  const before = await readFile(config, 'utf8'), result = await api(`/api/tasks/${taskId}/review`);
  assert.equal(result.status, 200, JSON.stringify(result));
  assert.deepEqual(result.data.review.remainingTimes, ['20:00-21:00']);
  assert.equal(result.data.review.remainingGoal, 'one');
  assert.equal(result.data.review.sameCourtAnchor.court, 'C场');
  assert.equal(result.data.review.unresolved.length, 1);
  assert.equal(await readFile(config, 'utf8'), before, '核对只给建议，不能自行创建或修改方案');
  assert.deepEqual(JSON.parse(await readFile(join(jobDir, 'state.json'), 'utf8')), pending);
  const matchedId = randomUUID(), matchedDir = join(dataDir, 'jobs', matchedId);
  await mkdir(matchedDir, { recursive: true });
  await writeFile(join(matchedDir, 'job.json'), JSON.stringify({ mode: 'now', taskId, accountId: 'default', accountIdentityId: 'test-user',
    config: { targets: [{ ...saved.data.config.tasks[0], project: 'badminton', date, sport: '羽毛球', campus: '粤海校区',
      mode: '包场', bookingGoal: 'one', times: ['19:00-20:00'] }] } }));
  await writeFile(join(matchedDir, 'state.json'), JSON.stringify({ status: 'interrupted', error: '未知响应', successes: [],
    logs: [{ message: '原始审计事件' }], pendingRequests: { matched: { date, time: '19:00-20:00', room: { WID: 'C', CDMC: '旧名称' } } } }));
  const checked = await api(`/api/tasks/${taskId}/review`);
  assert.equal(checked.status, 200, JSON.stringify(checked));
  const matchedState = JSON.parse(await readFile(join(matchedDir, 'state.json'), 'utf8'));
  assert.deepEqual(matchedState.pendingRequests, {});
  assert.equal(matchedState.reviewedOutcome, 'success');
  assert.equal(matchedState.reviewedRequests.matched.room.CDMC, '旧名称', '按稳定场地编号核对，原始请求仍保留');
  assert.equal(matchedState.statusBeforeReview, 'interrupted');
  const summaries = (await api('/api/jobs')).data.jobs;
  assert.equal(summaries.find((job) => job.id === matchedId).logs, undefined, '日常轮询不返回历史日志');
  assert.equal((await api(`/api/jobs/${matchedId}`)).data.job.logs[0].message, '原始审计事件', '详情按需读取');
  const blocked = await api(`/api/tasks/${taskId}/run`, 'POST', { mode: 'now', confirm: 'SUBMIT', startToken: randomUUID() });
  assert.equal(blocked.status, 400); assert.match(blocked.data.error, /结果待确认/);
  assert.equal((await api(`/api/tasks/${taskId}/review`, 'POST', { reviewToken: checked.data.review.reviewToken, confirm: 'INVALID' })).status, 400);
  const acknowledged = await api(`/api/tasks/${taskId}/review`, 'POST', { reviewToken: checked.data.review.reviewToken, confirm: 'NO_PENDING_ORDER' });
  assert.equal(acknowledged.status, 200, JSON.stringify(acknowledged));
  const resolved = JSON.parse(await readFile(join(jobDir, 'state.json'), 'utf8'));
  assert.deepEqual(resolved.pendingRequests, {});
  assert.equal(resolved.reviewedRequests.unknown.review.reviewResult, 'absent');
  assert.equal(await readFile(config, 'utf8'), before, '核对与确认不能改动预约方案');
  const wrongCourtId = randomUUID(), wrongCourtDir = join(dataDir, 'jobs', wrongCourtId);
  await mkdir(wrongCourtDir, { recursive: true });
  const originalJob = JSON.parse(await readFile(join(matchedDir, 'job.json'), 'utf8'));
  await writeFile(join(wrongCourtDir, 'job.json'), JSON.stringify({ ...originalJob,
    config: { targets: [{ ...originalJob.config.targets[0], courts: ['A'], courtLabels: { A: 'A场' } }] } }));
  await writeFile(join(wrongCourtDir, 'state.json'), JSON.stringify({ status: 'error', successes: [], logs: [], pendingRequests: {} }));
  assert.equal((await api(`/api/tasks/${taskId}/review`)).status, 200);
  assert.equal(JSON.parse(await readFile(join(wrongCourtDir, 'state.json'), 'utf8')).reviewedOutcome, undefined,
    '当前方案允许C场，不能据此把原来只要A场的执行标为完成');
  const corruptId = randomUUID(), corruptDir = join(dataDir, 'jobs', corruptId);
  await mkdir(corruptDir, { recursive: true });
  await writeFile(join(corruptDir, 'job.json'), JSON.stringify(originalJob));
  await writeFile(join(corruptDir, 'state.json'), '{broken');
  const corruptRun = await api(`/api/tasks/${taskId}/run`, 'POST', { mode: 'auto', confirm: 'SUBMIT', startToken: randomUUID() });
  assert.equal(corruptRun.status, 400); assert.match(corruptRun.data.error, /结果待确认/);
  const corruptReview = await api(`/api/tasks/${taskId}/review`);
  assert.equal(corruptReview.status, 200, JSON.stringify(corruptReview));
  assert.ok(corruptReview.data.review.unresolved.some((record) => record.court === '本地执行记录损坏'));
  assert.equal((await api(`/api/tasks/${taskId}/review`, 'POST', { reviewToken: corruptReview.data.review.reviewToken, confirm: 'NO_PENDING_ORDER' })).status, 200);
  const recovered = JSON.parse(await readFile(join(corruptDir, 'state.json'), 'utf8'));
  assert.equal(recovered.requiresReview, false); assert.deepEqual(recovered.successes, []);
  assert.equal(await readFile(join(corruptDir, recovered.recovery.preservedFiles[0]), 'utf8'), '{broken', '恢复后原损坏文件仍保留');
  const changed = await api(`/api/tasks/${taskId}`, 'PUT', { ...saved.data.config.tasks[0], projectId: 'badminton',
    times: ['20:00-21:00'], courts: ['A'], bookingGoal: 'one' });
  assert.equal(changed.status, 200);
  const oldReview = await api(`/api/tasks/${taskId}/review?jobId=${matchedId}`);
  assert.equal(oldReview.status, 200, JSON.stringify(oldReview));
  assert.deepEqual(oldReview.data.plan.times, ['19:00-20:00'], '历史核对使用原执行快照，不能套用编辑后的时段');
  assert.equal(oldReview.data.review.goalReached, true);
  assert.deepEqual(unexpected, [], '未调用预约接口，学校接口全由本地模拟');
});
