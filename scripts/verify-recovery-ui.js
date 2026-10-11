// Actual Windows Edge rendering and interactions; school traffic is blocked.
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { PROJECTS } from '../shared/projects.js';

const [desktopUrl, mobileUrl] = process.argv.slice(2);
for (const url of [desktopUrl, mobileUrl]) if (!url || !['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) throw new Error('传入两端本地预览地址');
const output = process.env.SZU_UI_ARTIFACTS || '/tmp/courtbooker-recovery-ui';
await mkdir(output, { recursive: true });
const browser = await chromium.connectOverCDP('http://127.0.0.1:9334');
const context = await browser.newContext();
const errors = [];
const plan = { id: 'p', name: '恢复流程', accountId: 'a', project: 'volleyball', projectId: 'volleyball', projectLabel: '排球',
  date: '2026-10-12', bookingGoal: 'one', times: ['19:00-20:00'], courts: ['A'], courtLabels: { A: '1号场' },
  preferSameCourt: false, includeOtherCourts: false, intervalMs: 100, durationMs: 120000 };
const accounts = [{ id: 'a', name: '测试账号', exists: true, userId: 'fake-a', user: '测试同学' }];
const catalog = { date: '2026-10-11', dates: ['2026-10-11'], times: ['19:00-20:00', '20:00-21:00'], courts: [{ id: 'A', name: '1号场', venue: '排球馆' }] };
async function pageAt(url) {
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.clock.install({ time: new Date('2026-10-11T12:29:50+08:00') });
  await page.addInitScript(() => { window.confirm = () => true; });
  await page.route('**/*', (route) => new URL(route.request().url()).origin === new URL(url).origin ? route.continue() : route.abort());
  return page;
}
try {
  const desktop = await pageAt(desktopUrl);
  let job = { id: 'j', taskId: 'p', mode: 'release', createdAt: '2026-10-11T04:29:00Z', status: 'waiting', target: plan,
    releaseAt: Date.parse('2026-10-11T12:30:00+08:00'), successes: [], logs: [], pendingRequests: { r: {
      date: plan.date, time: plan.times[0], room: { WID: 'A', CDMC: '1号场' }, preparedAt: '2026-10-11T04:29:45Z' } } };
  let tasks = [plan], saves = 0;
  await desktop.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    let data = { ok: true };
    if (path === '/api/bootstrap') data = { ...data, config: { tasks, projects: PROJECTS }, jobs: [job], accounts, serverDate: '2026-10-11' };
    else if (path === '/api/jobs') data.jobs = [job];
    else if (path === '/api/jobs/j') data.job = job;
    else if (path.endsWith('/catalog')) data = { ...data, ...catalog, times: catalog.times.map((value) => ({ value })) };
    else if (path.endsWith('/review')) {
      job = { ...job, status: 'success', statusBeforeReview: 'interrupted', reviewedOutcome: 'success', pendingRequests: {},
        successes: [{ date: plan.date, time: plan.times[0], court: '1号场' }] };
      data = { ...data, jobs: [job], plan, review: { booked: [{ time: plan.times[0], court: '1号场' }], unresolved: [], remainingTimes: [], goalReached: true, reason: '预约目标已完成' } };
    } else if (path === '/api/tasks' && route.request().method() === 'POST') {
      saves++; const saved = { ...route.request().postDataJSON(), id: 'new' }; tasks = [...tasks, saved];
      data = { ...data, taskId: 'new', config: { tasks, projects: PROJECTS } };
    }
    await route.fulfill({ json: data });
  });
  await desktop.goto(desktopUrl);
  const card = desktop.locator('[data-task=p]'); await card.waitFor();
  assert.ok(!(await card.textContent()).includes('请求结果待确认'));
  await card.getByRole('button', { name: '查看进度', exact: true }).click();
  assert.ok(!(await desktop.locator('#logResult').textContent()).includes('待核对'));
  await desktop.locator('[data-close=log]').first().click();
  await desktop.screenshot({ path: `${output}/prepared-desktop.png` });
  await desktop.locator('#addTaskButton').click(); await desktop.locator('#taskProject').selectOption('volleyball');
  await desktop.locator('[data-time="19:00-20:00"]').click(); await desktop.locator('[data-court=A]').click();
  await desktop.getByRole('button', { name: '保存方案', exact: true }).click();
  assert.match(await desktop.locator('#taskError').textContent(), /两个候选时段/); assert.equal(saves, 0);
  await desktop.locator('[data-time="20:00-21:00"]').click();
  await desktop.getByRole('button', { name: '保存方案', exact: true }).click();
  await desktop.waitForFunction(() => !document.querySelector('#taskDialog').open); assert.equal(saves, 1);
  job = { ...job, status: 'booking', pendingRequests: { r: { ...job.pendingRequests.r, sentAt: '2026-10-11T04:30:00Z' } } };
  await desktop.clock.setSystemTime(new Date('2026-10-11T12:30:01+08:00'));
  await card.getByText('请求已发送，等待学校响应。', { exact: true }).waitFor();
  assert.equal(await card.locator('.task-error').count(), 0, '正常在途请求不显示异常告警');
  job.status = 'interrupted';
  await card.getByRole('button', { name: '核对与重试', exact: true }).click();
  await card.getByRole('button', { name: '查看结果', exact: true }).waitFor();
  assert.ok(!(await card.textContent()).includes('请求结果待确认'));
  await desktop.screenshot({ path: `${output}/reviewed-desktop.png` });

  const mobile = await pageAt(mobileUrl);
  await mobile.addInitScript((snapshot) => localStorage.setItem('szu-mobile-v1', JSON.stringify(snapshot)), {
    version: 1, plans: [], runs: [], accounts: accounts.map((account) => ({ ...account, session: { userAgent: 'test', cookies: [] } })), catalogs: { 'a:volleyball': catalog },
  });
  await mobile.goto(mobileUrl); await mobile.locator('#overviewAction').click();
  await mobile.locator('#planProject').selectOption('volleyball');
  await mobile.locator('[data-time="19:00-20:00"]').click(); await mobile.locator('[data-court=A]').click();
  await mobile.getByRole('button', { name: '保存方案', exact: true }).click();
  assert.match(await mobile.locator('#planError').textContent(), /两个/);
  assert.equal(await mobile.locator('#planDialog').evaluate((dialog) => dialog.open), true);
  await mobile.locator('#bookingGoal').selectOption('one');
  await mobile.getByRole('button', { name: '保存方案', exact: true }).click();
  await mobile.waitForFunction(() => !document.querySelector('#planDialog').open);
  assert.equal((await mobile.evaluate(() => JSON.parse(localStorage.getItem('szu-mobile-v1')))).plans[0].bookingGoal, 'one');
  await mobile.screenshot({ path: `${output}/single-mobile.png` });

  const historical = await pageAt(mobileUrl);
  const oldPlan = { ...plan, date: '2026-10-10', name: '原执行方案', project: 'volleyball' };
  const archive = { id: 'archived', status: 'success', mode: 'auto', startedAt: '2026-10-08T04:00:00Z', finishedAt: '2026-10-08T05:00:00Z',
    plans: [{ ...oldPlan, id: 'archived-plan', name: '归档历史' }], items: [], successes: [], logs: [{ time: '2026-10-08T04:00:00Z', level: 'INFO', message: '归档日志原文' }] };
  await historical.addInitScript(({ plan, oldPlan, accounts, archive }) => {
    localStorage.setItem('szu-mobile-v1', JSON.stringify({ version: 1, plans: [{ ...plan, name: '修改后的方案' }],
      accounts: accounts.map((account) => ({ ...account, session: { userAgent: 'test', cookies: [] } })), catalogs: {}, archivedRunCount: 1,
      runs: [{ id: 'old-run', status: 'interrupted', mode: 'auto', startedAt: '2026-10-09T04:30:00Z', finishedAt: '2026-10-09T04:31:00Z',
        plans: [oldPlan], items: [{ id: oldPlan.id, name: oldPlan.name, status: 'interrupted' }], successes: [], logs: [],
        pendingRequests: { unknown: { planId: oldPlan.id, plan: oldPlan.name, accountId: 'a', date: oldPlan.date, time: oldPlan.times[0], court: '1号场' } } }] }));
    localStorage.setItem(`szu-mobile-run:${Date.parse(archive.startedAt)}-${archive.id}`, JSON.stringify(archive));
  }, { plan, oldPlan, accounts, archive });
  await historical.goto(mobileUrl); await historical.locator('[data-plan=p]').waitFor();
  assert.match(await historical.locator('[data-plan=p]').textContent(), /可启动/, '旧日期未知记录不冒充修改后的当前方案结果');
  await historical.locator('[data-tab=results]').click();
  await historical.getByRole('button', { name: '核对此次执行', exact: true }).click();
  await historical.getByText('网页预览不能连接学校，请在手机 App 中核对', { exact: true }).waitFor();
  await historical.locator('#loadHistory').click();
  await historical.getByRole('heading', { name: '归档历史', exact: true }).waitFor();
  await historical.locator('[data-log=archived] summary').click();
  assert.match(await historical.locator('[data-log=archived] .run-logs').textContent(), /归档日志原文/);
  await historical.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await historical.screenshot({ path: `${output}/history-mobile.png` });
  assert.equal(await historical.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  const unsupported = await pageAt(new URL('unsupported-webview.html', mobileUrl).href);
  await unsupported.goto(new URL('unsupported-webview.html', mobileUrl).href);
  await unsupported.getByRole('heading', { name: '请先更新系统网页组件' }).waitFor();
  await unsupported.screenshot({ path: `${output}/unsupported-mobile.png` });
  assert.deepEqual(errors, []);
  console.log('恢复界面通过：预备/在途/订单核对状态、两端目标校验、原执行核对入口、历史分页与展开日志、旧WebView提示；Windows Edge实际画面，学校请求全部拦截。');
} finally { await context.close(); await browser.close(); }
