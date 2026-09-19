// Connect only to the dedicated Windows Edge instance. All API writes are mocked.
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { addDays, shanghaiDate } from '../shared/utils.js';
import { PROJECTS } from '../shared/projects.js';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9334');
const page = await browser.contexts()[0].newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const date = addDays(shanghaiDate(), 2);
const startAt = Date.parse(`${addDays(date, -1)}T12:30:00+08:00`);
const config = { tasks: [{ id: 'seed', projectId: 'volleyball', projectLabel: '排球', name: '晚间排球', date,
  times: ['19:00-20:00', '20:00-21:00', '21:00-22:00'], courts: ['B', 'A', 'C'],
  courtLabels: { A: '1 号场', B: '2 号场', C: '3 号场' }, preferSameCourt: true,
  startAt, intervalMs: 1000, durationMs: 60000 }], projects: PROJECTS.map((p) => ({ id: p.id, label: p.label })) };
let jobs = [];
const accounts = [{ id: 'default', name: '我的账号', exists: true, valid: true },
  { id: 'roommate', name: '舍友', exists: true, valid: true }];
const writes = [];
await page.route('**/api/**', async (route) => {
  const request = route.request(); const path = new URL(request.url()).pathname;
  let data = { ok: true };
  if (request.method() !== 'GET') writes.push({ path, body: request.postDataJSON() });
  if (path === '/api/bootstrap') data = { ...data, config, jobs, accounts, session: { exists: true, valid: true, user: '测试账号' }, serverDate: shanghaiDate(), scheduler: 'Windows 任务计划程序' };
  else if (path.endsWith('/export')) data = { format: 'szu-court-session/v1', session: { cookies: [{ name: 'MOD_AUTH_CAS', value: 'fake-ui-test' }] } };
  else if (path === '/api/jobs') data.jobs = jobs;
  else if (path.endsWith('/times')) data = { ...data, date: shanghaiDate(), times: ['15:00-16:00', '16:00-17:00', '19:00-20:00', '20:00-21:00'].map((value) => ({ value })) };
  else if (path.endsWith('/courts')) {
    const badminton = path.includes('badminton');
    await new Promise((resolve) => setTimeout(resolve, badminton ? 300 : 10));
    data.courts = ['A', 'B', 'C'].map((id, index) => ({ id, name: `${badminton ? '羽毛球' : '排球'} ${index + 1} 号场`, venue: '运动广场' }));
  } else if (path === '/api/tasks' && request.method() === 'POST') {
    const input = request.postDataJSON(); const task = { ...input, id: 'new-task', projectLabel: PROJECTS.find((p) => p.id === input.projectId).label };
    config.tasks.push(task); data = { ...data, config, taskId: task.id };
  } else if (path.endsWith('/run')) {
    const input = request.postDataJSON(); const taskId = path.split('/')[3];
    const job = { id: '11111111-1111-1111-1111-111111111111', taskId, mode: input.mode, status: input.mode === 'check' ? 'success' : 'scheduled', createdAt: new Date().toISOString(), releaseAt: startAt,
      successes: [], logs: [{ time: new Date().toISOString(), level: 'CHECK', message: '检查通过，未下单' }] };
    jobs = [job]; data = { ...data, config, job };
  } else if (path.endsWith('/stop')) { jobs[0].status = 'stopped'; data.job = jobs[0]; }
  await route.fulfill({ json: data });
});
try {
  await page.setViewportSize({ width: 1360, height: 950 });
  await page.goto('http://127.0.0.1:4173/');
  await page.getByRole('heading', { name: '晚间排球' }).waitFor();
  await page.getByRole('button', { name: '＋ 新建任务' }).click();
  await page.locator('#taskAccount').selectOption('roommate');
  await page.locator('#taskProject').selectOption('volleyball');
  await page.getByRole('button', { name: '清空选择' }).click();
  await page.getByRole('button', { name: '关闭任务编辑' }).click();
  assert.equal(await page.locator('#taskDialog').evaluate((el) => el.open), false);
  assert.equal(writes.length, 0, '关闭不提交表单');
  await page.getByRole('button', { name: '＋ 新建任务' }).click();
  await page.locator('#taskAccount').selectOption('roommate');
  await page.locator('#taskProject').selectOption('volleyball');
  await page.getByRole('button', { name: '排球 1 号场', exact: true }).waitFor();
  await page.waitForTimeout(350);
  assert.equal(await page.getByRole('button', { name: '羽毛球 1 号场', exact: true }).count(), 0, '旧请求不得覆盖新项目');
  assert.equal(await page.locator('#preferSameCourt').isChecked(), true);
  await page.getByRole('button', { name: '排球 2 号场', exact: true }).click();
  await page.getByRole('button', { name: '排球 1 号场', exact: true }).click();
  assert.equal(await page.locator('[data-court="B"] .court-order').textContent(), '1');
  assert.equal(await page.locator('[data-court="A"] .court-order').textContent(), '2');
  const colors = await page.locator('[data-court="B"] .court-order').evaluate((el) => ({ fg: getComputedStyle(el).color, bg: getComputedStyle(el).backgroundColor }));
  assert.notEqual(colors.fg, colors.bg);
  await page.locator('#taskDate').selectOption(date);
  await page.locator('#taskName').fill('周日双打');
  await page.getByRole('button', { name: '15:00-16:00', exact: true }).click();
  await page.getByRole('button', { name: '16:00-17:00', exact: true }).click();
  await page.locator('#taskInterval').fill('30');
  await page.locator('#taskDuration').fill('120');
  await mkdir('output/playwright', { recursive: true });
  await page.screenshot({ path: 'output/playwright/task-editor-desktop.png', fullPage: true });
  await page.getByRole('button', { name: '保存草稿', exact: true }).click();
  await page.getByRole('heading', { name: '周日双打' }).waitFor();
  const saved = writes.find((w) => w.path === '/api/tasks').body;
  assert.deepEqual(saved.courts, ['B', 'A']); assert.equal(saved.intervalMs, 30_000); assert.equal(saved.durationMs, 7_200_000);
  assert.equal(saved.accountId, 'roommate');
  const row = page.locator('[data-task="new-task"]');
  await row.getByRole('button', { name: '安排定时' }).click();
  assert.match(await page.locator('#confirmSummary').textContent(), /30 秒/);
  assert.match(await page.locator('#confirmSummary').textContent(), /舍友/);
  await page.getByRole('button', { name: '确认安排', exact: true }).click();
  await row.getByRole('button', { name: '停止并取消定时' }).waitFor();
  await page.screenshot({ path: 'output/playwright/tasks-desktop.png', fullPage: true });
  await row.getByRole('button', { name: '停止并取消定时' }).click();
  await page.waitForFunction(() => document.querySelector('[data-task="new-task"] .badge')?.textContent === '已停止');
  await row.getByRole('button', { name: '日志', exact: true }).click();
  await page.getByText('检查通过，未下单', { exact: false }).waitFor();
  await page.getByRole('button', { name: '关闭日志' }).click();
  jobs[0].status = 'success'; jobs[0].successes = [{ date, time: '15:00-16:00', court: 'A' }];
  await page.waitForFunction(() => document.querySelector('[data-task="new-task"] .badge')?.textContent === '已完成');
  assert.equal(await row.getByRole('button', { name: '安排定时' }).isEnabled(), true, '历史成功不阻止重新安排');
  await page.locator('#sessionButton').click();
  await page.locator('#authAccount').selectOption('roommate');
  await page.locator('#showAccountButton').click();
  await page.waitForFunction(() => document.querySelector('#loginJsonExport').value.includes('fake-ui-test'));
  assert.ok(writes.some((w) => w.path === '/api/accounts/roommate/export'));
  await page.screenshot({ path: 'output/playwright/accounts-desktop.png', fullPage: true });
  await page.locator('#authAccount').selectOption('default');
  assert.equal(await page.locator('#loginJsonExport').isVisible(), false);
  await page.locator('#authDialog [data-close]').click();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: 'output/playwright/tasks-mobile.png', fullPage: true });
  await page.getByRole('button', { name: '＋ 新建任务' }).click();
  await page.getByRole('button', { name: '羽毛球 1 号场', exact: true }).waitFor();
  await page.getByRole('button', { name: '羽毛球 2 号场', exact: true }).click();
  await page.getByRole('button', { name: '羽毛球 1 号场', exact: true }).click();
  await page.locator('#courtSequence').scrollIntoViewIfNeeded();
  assert.ok(await page.locator('#taskDialog').evaluate((el) => el.scrollWidth <= el.clientWidth));
  await page.screenshot({ path: 'output/playwright/task-editor-mobile.png' });
  await page.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(await page.locator('#taskDialog').evaluate((el) => el.open), false);
  assert.deepEqual(errors, []);
  console.log('Edge UI通过：关闭/取消、项目切换隔离、场地编号、账号选择与完整JSON查看、历史成功可重试、定时确认、停止、日志与390px手机布局；所有写操作均被模拟。');
} finally { await page.close(); await browser.close(); }
