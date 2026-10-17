// Connect only to the dedicated Windows Edge instance. All API writes are mocked.
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
const uiOutput = process.env.SZU_UI_ARTIFACTS || 'output/playwright';
import { mkdir } from 'node:fs/promises';
import { addDays, shanghaiDate } from '../shared/utils.js';
import { PROJECTS } from '../shared/projects.js';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9334');
const context = await browser.newContext({ acceptDownloads: true });
const uiUrl = process.env.SZU_UI_URL || 'http://127.0.0.1:4173/';
await context.route('**/*', route => new URL(route.request().url()).origin === new URL(uiUrl).origin ? route.continue() : route.abort());
const page = await context.newPage();
const errors = [];
// Other CDP clients can dismiss native dialogs; capture the fake review confirmation in this isolated page.
await page.addInitScript(() => { window.uiConfirmations = []; window.confirm = (message) => { window.uiConfirmations.push(message); return true; }; });
page.on('pageerror', (error) => errors.push(error.message));
await page.clock.install({ time: new Date('2026-09-20T12:00:00+08:00') });
await page.clock.setSystemTime(new Date('2026-09-20T12:00:00+08:00'));
const date = '2026-09-21';
const startAt = Date.parse(`${addDays(date, -1)}T12:30:00+08:00`);
const config = { tasks: [{ id: 'seed', projectId: 'volleyball', projectLabel: '排球', name: '晚间排球', date,
  times: ['19:00-20:00', '20:00-21:00', '21:00-22:00'], courts: ['B', 'A', 'C'],
  courtLabels: { A: '1 号场', B: '2 号场', C: '3 号场' }, preferSameCourt: true,
  startAt, intervalMs: 1000, durationMs: 60000 }], projects: PROJECTS.map((p) => ({ id: p.id, label: p.label })) };
let jobs = [];
let failNextRun = false, firstBootstrap = true, offline = false, delayNextRun = false, releaseStart;
let revision = 1;
let auth = { status: 'idle', logs: [] };
const activeStatesForTest = (status) => ['queued', 'preparing', 'checking', 'waiting', 'booking', 'stopping'].includes(status);
const accounts = [{ id: 'default', name: '我的账号', exists: true, valid: true },
  { id: 'roommate', name: '舍友', exists: true, valid: true }];
const writes = [];
await page.route('**/api/**', async (route) => {
  const request = route.request(); const path = new URL(request.url()).pathname;
  let data = { ok: true };
  if (offline && ['/api/jobs', '/api/bootstrap'].includes(path)) return route.fulfill({ status: 503, json: { ok: false, error: '模拟断线' } });
  if (path === '/api/bootstrap' && firstBootstrap) { firstBootstrap = false; return route.fulfill({ status: 503, json: { ok: false, error: '首次加载失败' } }); }
  if (request.method() !== 'GET') writes.push({ path, body: request.postDataJSON() });
  if (path === '/api/bootstrap') data = { ...data, config, jobs, accounts, session: { exists: true, valid: true, user: '测试账号' }, serverDate: '2026-09-20', scheduler: 'Windows 任务计划程序' };
  else if (path.endsWith('/export')) data = { format: 'szu-court-session/v1', session: { cookies: [{ name: 'MOD_AUTH_CAS', value: 'fake-ui-test' }] } };
  else if (path === '/api/jobs') data.jobs = jobs;
  else if (path === '/api/accounts') data.accounts = accounts;
  else if (path === '/api/auth/status') data = { ...data, accounts, auth };
  else if (path === '/api/auth/start') { auth = { status: 'awaiting_identity', logs: [{ message: '检测到测试同学（学号尾号 1234），请确认绑定' }] }; data.auth = auth; }
  else if (path === '/api/auth/bind') { auth = { status: 'success', logs: [{ message: '绑定完成' }] }; data.accounts = accounts; }
  else if (path === '/api/starts/cancel') { if (releaseStart) { releaseStart(); releaseStart = null; } }
  else if (path.endsWith('/review')) { const task = config.tasks.find((t) => t.id === path.split('/')[3]); data.review = { booked: [{ time: task.times[0], court: '2 号场' }], unresolved: [], remainingTimes: task.times.slice(1), remainingGoal: 'one', sameCourtAnchor: { date: task.date, time: task.times[0], court: '2 号场' } }; }
  else if (path.endsWith('/diagnostics')) data = { format: 'szu-court-diagnostics/v1', events: [], diagnostics: { events: 0 } };
  else if (path.endsWith('/times')) data = { ...data, date: shanghaiDate(), times: ['15:00-16:00', '16:00-17:00', '19:00-20:00', '20:00-21:00'].map((value) => ({ value })) };
  else if (path.endsWith('/courts') || path.endsWith('/catalog')) {
    const badminton = path.includes('badminton');
    await new Promise((resolve) => setTimeout(resolve, badminton ? 300 : 10));
    data.date = '2026-09-20';
    data.dates = ['2026-09-20'];
    data.times = ['15:00-16:00', '16:00-17:00', '19:00-20:00', '20:00-21:00'].map((value) => ({ value }));
    data.courts = ['A', 'B', 'C'].map((id, index) => ({ id, name: `${badminton ? '羽毛球' : '排球'} ${index + 1} 号场`, venue: '运动广场' }));
  } else if (path === '/api/tasks' && request.method() === 'POST') {
    const input = request.postDataJSON(); const task = { ...input, revision: String(revision++), id: config.tasks.some((t) => t.id === 'new-task') ? 'remaining-task' : 'new-task', projectLabel: PROJECTS.find((p) => p.id === input.projectId).label };
    config.tasks.push(task); data = { ...data, config, taskId: task.id };
  } else if (/^\/api\/tasks\/[^/]+$/.test(path) && request.method() === 'PUT') {
    const task = config.tasks.find((t) => t.id === path.split('/')[3]); Object.assign(task, request.postDataJSON(), { revision: String(revision++) }); data = { ...data, config, taskId: task.id };
  } else if (path.endsWith('/run')) {
    if (delayNextRun) { delayNextRun = false; await new Promise((r) => releaseStart = r); return route.fulfill({ status: 400, json: { ok: false, error: '启动已取消' } }); }
    if (failNextRun) {
      failNextRun = false;
      return route.fulfill({ status: 400, json: { ok: false, error: '登录态已失效，请重新登录' } });
    }
    const input = request.postDataJSON(); const taskId = path.split('/')[3];
    const job = { id: '11111111-1111-1111-1111-111111111111', taskId, mode: input.mode, status: input.mode === 'check' ? 'success' : 'waiting', createdAt: new Date().toISOString(), releaseAt: startAt,
      target: { ...config.tasks.find((t) => t.id === taskId), project: config.tasks.find((t) => t.id === taskId).projectId }, successes: [], logs: [{ time: new Date().toISOString(), level: 'CHECK', message: '检查通过，未下单' }] };
    jobs = [job, ...jobs]; data = { ...data, config, job };
  } else if (path.endsWith('/stop')) { jobs[0].status = 'stopped'; data.job = jobs[0]; }
  await route.fulfill({ json: data });
});
try {
  await page.setViewportSize({ width: 1360, height: 950 });
  await page.goto(uiUrl);
  await page.getByRole('heading', { name: '晚间排球', level: 3 }).waitFor();
  await page.locator('#addTaskButton').click();
  await page.locator('#taskAccount').selectOption('roommate');
  await page.locator('#taskProject').selectOption('volleyball');
  await page.locator('#allCourts').click();
  await page.getByRole('button', { name: '关闭任务编辑' }).click();
  assert.equal(await page.locator('#taskDialog').evaluate((el) => el.open), false);
  assert.equal(writes.length, 0, '关闭不提交表单');
  await page.locator('#addTaskButton').click();
  await page.locator('#taskAccount').selectOption('roommate');
  await page.locator('#taskProject').selectOption('volleyball');
  await page.getByRole('button', { name: '排球 1 号场', exact: true }).waitFor();
  assert.equal(await page.locator('#timeNote').textContent(), '');
  await page.waitForTimeout(350);
  assert.equal(await page.getByRole('button', { name: '羽毛球 1 号场', exact: true }).count(), 0, '旧请求不得覆盖新项目');
  assert.equal(await page.locator('#preferSameCourt').isChecked(), true);
  await page.locator('#taskOptions > summary').click();
  await page.locator('#includeOtherCourts').check();
  await page.getByRole('button', { name: '排球 2 号场', exact: true }).click();
  await page.getByRole('button', { name: '排球 1 号场', exact: true }).click();
  assert.equal(await page.locator('[data-court="B"] .court-order').textContent(), '1');
  assert.equal(await page.locator('[data-court="A"] .court-order').textContent(), '2');
  await page.locator('#orderSettings > summary').click();
  await page.getByRole('button', { name: '上移 排球 1 号场', exact: true }).click();
  assert.equal(await page.locator('[data-court="A"] .court-order').textContent(), '1');
  await page.getByRole('button', { name: '下移 排球 1 号场', exact: true }).click();
  await page.locator('#bookingGoal').selectOption('consecutive');
  const colors = await page.locator('[data-court="B"] .court-order').evaluate((el) => ({ fg: getComputedStyle(el).color, bg: getComputedStyle(el).backgroundColor }));
  assert.notEqual(colors.fg, colors.bg);
  await page.locator('#taskDate').selectOption(date);
  await page.locator('#taskName').fill('周日双打');
  await page.getByRole('button', { name: '15:00-16:00', exact: true }).click();
  await page.getByRole('button', { name: '16:00-17:00', exact: true }).click();
  await page.locator('#taskInterval').fill('30');
  await page.locator('#taskDuration').fill('120');
  await mkdir(uiOutput, { recursive: true });
  await page.screenshot({ path: `${uiOutput}/task-editor-desktop.png`, fullPage: true });
  await page.locator('#saveTaskButton').click();
  await page.getByRole('heading', { name: '周日双打', level: 3 }).waitFor();
  const saved = writes.find((w) => w.path === '/api/tasks').body;
  assert.deepEqual(saved.courts, ['B', 'A']); assert.equal(saved.intervalMs, 30_000); assert.equal(saved.durationMs, 7_200_000);
  assert.equal(saved.accountId, 'roommate');
  assert.equal(saved.includeOtherCourts, true); assert.equal(saved.bookingGoal, 'consecutive');
  const row = page.locator('[data-task="new-task"]');
  assert.match(await page.locator('#confirmSummary').textContent(), /12:30/);
  assert.match(await page.locator('#confirmSummary').textContent(), /舍友/);
  assert.equal(await page.locator('#taskStart').count(), 0);
  await page.locator('#confirmRunButton').click();
  assert.equal(writes.find((w) => w.path.endsWith('/run')).body.mode, 'auto');
  await row.getByRole('button', { name: '停止本次执行' }).waitFor();
  await page.screenshot({ path: `${uiOutput}/tasks-desktop.png`, fullPage: true });
  const beforeDisconnect = await row.locator('[data-countdown]').textContent();
  offline = true; await page.locator('#connectionError').waitFor();
  await page.waitForTimeout(1200);
  assert.notEqual(await row.locator('[data-countdown]').textContent(), beforeDisconnect);
  assert.match(await row.locator('[data-countdown]').textContent(), /本地估算/);
  assert.match(await page.locator('#connectionError').textContent(), /缓存状态/);
  await page.locator('#reconnectButton').click(); offline = false;
  await page.waitForFunction(() => document.querySelector('#connectionError').hidden);
  await row.getByRole('button', { name: '停止本次执行' }).click();
  await page.waitForFunction(() => document.querySelector('[data-task="new-task"] .badge')?.textContent === '已停止');
  await row.locator('.more-actions summary').click();
  await row.getByRole('button', { name: '预约记录', exact: true }).click();
  await page.getByText('检查通过，未下单', { exact: false }).waitFor();
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出诊断记录', exact: true }).click();
  assert.match((await downloaded).suggestedFilename(), /^szu-diagnostics-/);
  await page.getByRole('button', { name: '关闭日志' }).click();
  jobs[0].status = 'success'; jobs[0].successes = [{ date, time: '15:00-16:00', court: 'A' }];
  await page.waitForFunction(() => document.querySelector('[data-task="new-task"] .badge')?.textContent === '已完成');
  assert.equal(await row.getByRole('button', { name: '查看结果', exact: true }).isEnabled(), true);
  assert.equal(await row.getByRole('button', { name: '开始预约', exact: true }).count(), 0, '成功后优先核对结果，通过复用安排下一场');
  jobs[0].status = 'stopped';
  await row.getByRole('button', { name: '核对与重试', exact: true }).waitFor();
  jobs[0].successes = [];
  await row.getByRole('button', { name: '开始预约', exact: true }).waitFor();
  failNextRun = true;
  await row.getByRole('button', { name: '开始预约', exact: true }).click();
  await page.locator('#confirmRunButton').click();
  await page.locator('#confirmLoginButton').waitFor();
  assert.match(await page.locator('#confirmError').textContent(), /登录态已失效/);
  await page.locator('#confirmLoginButton').click();
  assert.equal(await page.locator('#authAccount').inputValue(), 'roommate');
  await page.getByRole('button', { name: '关闭登录', exact: true }).click();
  await page.locator('#sessionButton').click();
  await page.locator('#authAccount').selectOption('roommate');
  await page.getByText('登录文件与账号工具', { exact: true }).click();
  await page.locator('#showAccountButton').click();
  await page.waitForFunction(() => document.querySelector('#loginJsonExport').value.includes('fake-ui-test'));
  assert.ok(writes.some((w) => w.path === '/api/accounts/roommate/export'));
  await page.screenshot({ path: `${uiOutput}/accounts-desktop.png`, fullPage: true });
  await page.locator('#authAccount').selectOption('default');
  assert.equal(await page.locator('#loginJsonExport').isVisible(), false);
  await page.getByRole('button', { name: '关闭登录', exact: true }).click();
  jobs.push({ id: '22222222-2222-2222-2222-222222222222', status: 'corrupt', successes: [], logs: [],
    createdAt: new Date().toISOString(), error: '本地执行记录无法读取' });
  await page.locator('#recordError').waitFor();
  assert.match(await page.locator('#recordError').textContent(), /1 条本地记录无法读取/);
  assert.equal(await row.getByRole('button', { name: '开始预约', exact: true }).isEnabled(), true);
  jobs[0].status = 'success';
  jobs[0].successes = [{ date, time: '15:00-16:00', court: 'A' }];
  await row.getByRole('button', { name: '查看结果', exact: true }).waitFor();
  // A configuration check must not hide a real reservation on the same plan.
  jobs.unshift({ ...structuredClone(jobs[0]), id: 'check-history', mode: 'check', successes: [] });
  await page.waitForFunction(() => document.querySelector('[data-task="new-task"]').textContent.includes('最近检查：通过'));
  assert.equal(await row.locator('.badge').textContent(), '已完成');
  assert.match(await row.textContent(), /已约到 1 段/);
  jobs.find((j) => j.mode !== 'check' && j.taskId === 'new-task').status = 'stopped';
  jobs.find((j) => j.mode !== 'check' && j.taskId === 'new-task').successes = [];
  await row.getByRole('button', { name: '开始预约', exact: true }).waitFor();
  delayNextRun = true;
  await row.getByRole('button', { name: '开始预约', exact: true }).click();
  await page.locator('#confirmRunButton').click();
  await page.getByRole('button', { name: '关闭确认' }).click();
  await page.waitForFunction(() => !document.querySelector('#confirmRunButton').disabled);
  assert.ok(writes.some((w) => w.path === '/api/starts/cancel'));
  assert.equal(jobs.filter((j) => activeStatesForTest(j.status)).length, 0);
  await row.locator('.more-actions summary').click();
  await row.getByRole('button', { name: '修改预约', exact: true }).click();
  await page.locator('#taskDate').selectOption(addDays(date, 1));
  await page.locator('#saveTaskButton').click();
  await page.waitForFunction(() => document.querySelector('[data-task="new-task"] .badge').textContent === '未开始');
  assert.ok(!(await row.textContent()).includes('已约到 1 段'));
  await page.locator('#sessionButton').click();
  await page.locator('#authAccount').selectOption('roommate');
  await page.locator('#startAuthButton').click();
  await page.locator('#bindIdentityButton').waitFor();
  assert.match(await page.locator('#authProgress').textContent(), /尾号 1234/);
  assert.equal(await page.locator('#authAccount').isDisabled(), true);
  await page.locator('#bindIdentityButton').click();
  await page.waitForFunction(() => document.querySelector('#bindIdentityButton').hidden);
  assert.ok(writes.some((w) => w.path === '/api/auth/bind'));
  await page.getByRole('button', { name: '关闭登录', exact: true }).click();
  const changedTask = config.tasks.find(task => task.id === 'new-task');
  await page.clock.setSystemTime(new Date('2026-09-21T12:00:00+08:00'));
  jobs.unshift({ id: 'interrupted-current', taskId: changedTask.id, mode: 'auto', status: 'interrupted', createdAt: new Date().toISOString(), target: structuredClone(changedTask), successes: [], logs: [] });
  await row.getByRole('button', { name: '核对与重试', exact: true }).click();
  await page.locator('[data-task="remaining-task"]').waitFor();
  assert.ok((await page.evaluate(() => window.uiConfirmations)).some((message) => message.includes('生成一份新的剩余预约')));
  const remaining = config.tasks.find((t) => t.id === 'remaining-task');
  assert.deepEqual(remaining.times, ['16:00-17:00']); assert.equal(remaining.bookingGoal, 'one');
  assert.equal(remaining.sameCourtAnchor.court, '2 号场');
  assert.equal(config.tasks.find((t) => t.id === 'new-task').times.length, 2);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: `${uiOutput}/tasks-mobile.png`, fullPage: true });
  await page.locator('#addTaskButton').click();
  await page.getByRole('button', { name: '羽毛球 1 号场', exact: true }).waitFor();
  await page.getByRole('button', { name: '羽毛球 2 号场', exact: true }).click();
  await page.getByRole('button', { name: '羽毛球 1 号场', exact: true }).click();
  await page.locator('#taskOptions > summary').click();
  await page.locator('#orderSettings > summary').click();
  await page.locator('#courtSequence').scrollIntoViewIfNeeded();
  assert.ok(await page.locator('#taskDialog').evaluate((el) => el.scrollWidth <= el.clientWidth));
  await page.screenshot({ path: `${uiOutput}/task-editor-mobile.png` });
  await page.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(await page.locator('#taskDialog').evaluate((el) => el.open), false);
  assert.deepEqual(errors, []);
  console.log('Edge UI通过：首次重连、断线独立倒计时、关闭确认取消启动、方案版本隔离、检查不遮住成功、身份确认绑定、重排/预约目标/目录刷新、剩余方案、诊断导出和390px布局；所有学校与写操作均被模拟。');
} catch (error) { console.error({ pageErrors: errors, body: (await page.locator('body').innerText()).slice(0, 2200) }); throw error; } finally { await page.close(); await context.close(); await browser.close(); }
