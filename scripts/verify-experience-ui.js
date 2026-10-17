// Windows Edge only. Isolated pages, fake accounts, school traffic blocked.
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
const uiOutput = process.env.SZU_UI_ARTIFACTS || 'output/playwright';
import { mkdir } from 'node:fs/promises';
import { PROJECTS } from '../shared/projects.js';
const [desktopUrl, mobileUrl] = process.argv.slice(2);
if (!desktopUrl || !mobileUrl) throw new Error('传入桌面与手机的本地预览 URL');
for (const url of [desktopUrl, mobileUrl]) if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) throw new Error('只允许本地预览');
const browser = await chromium.connectOverCDP('http://127.0.0.1:9334');
const context = await browser.newContext();
const pages = [], errors = [];
const base = { accountId: 'a', projectId: 'volleyball', project: 'volleyball', projectLabel: '排球', date: '2026-10-02', times: ['19:00-20:00', '20:00-21:00'], courts: ['B', 'A'], courtLabels: { A: '一号场', B: '二号场' }, bookingGoal: 'consecutive', preferSameCourt: true, includeOtherCourts: true, intervalMs: 100, durationMs: 120000 };
const plans = [
  { ...base, id: 'ready', name: '晚间排球' },
  { ...base, id: 'future', name: '周末排球', date: '2026-10-04', accountId: 'b' },
  { ...base, id: 'old', name: '上次的选择', date: '2026-09-30', sameCourtAnchor: { date: '2026-09-30', time: '18:00-19:00', court: '一号场' } },
  { ...base, id: 'pending', name: '需要核对', date: '2026-09-30' },
];
const accounts = [{ id: 'a', name: '我的账号', exists: true, user: '测试同学' }, { id: 'b', name: '搭档', exists: true }];
async function pageFor(url, width) {
  const page = await context.newPage(); pages.push(page);
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width, height: 900 });
  await page.clock.install({ time: new Date('2026-10-01T12:00:00+08:00') });
  await page.clock.setSystemTime(new Date('2026-10-01T12:00:00+08:00'));
  await page.route('**/*', (r) => new URL(r.request().url()).origin === new URL(url).origin ? r.continue() : r.abort());
  return page;
}
try {
  await mkdir(uiOutput, { recursive: true });
  const desktop = await pageFor(desktopUrl, 1360);
  const config = { tasks: structuredClone(plans), projects: PROJECTS };
  const jobs = [{ id: 'pending-job', taskId: 'pending', status: 'interrupted', createdAt: '2026-09-30T05:00:00Z', target: plans[3], successes: [], pendingRequests: { r: { date: '2026-09-30', time: '19:00-20:00' } } }];
  const writes = [];
  await desktop.route('**/api/**', async (route) => {
    const req = route.request(), path = new URL(req.url()).pathname;
    let data = { ok: true };
    if (req.method() !== 'GET') writes.push({ path, body: req.postDataJSON() });
    if (path === '/api/bootstrap') data = { ...data, config, jobs, accounts, serverDate: '2026-10-01' };
    else if (path === '/api/jobs') data.jobs = jobs;
    else if (path.endsWith('/catalog')) data = { ...data, date: '2026-10-01', dates: ['2026-10-01', '2026-10-02'],
      times: base.times.map((value) => ({ value })), courts: [{ id: 'A', name: '一号场' }, { id: 'B', name: '二号场' }] };
    else if (path.endsWith('/times')) data = { ...data, date: '2026-10-01', times: base.times.map((value) => ({ value })) };
    else if (path.endsWith('/courts')) data = { ...data, date: '2026-10-01', courts: [{ id: 'A', name: '一号场' }, { id: 'B', name: '二号场' }] };
    else if (path === '/api/tasks') { const input = req.postDataJSON(); config.tasks.push({ ...input, id: 'copy', projectLabel: '排球' }); data = { ...data, config, taskId: 'copy' }; }
    await route.fulfill({ json: data });
  });
  await desktop.goto(desktopUrl);
  await desktop.locator('[data-task=ready]').waitFor();
  assert.equal(await desktop.locator('[data-task=old]').count(), 0);
  assert.equal(await desktop.locator('[data-task=pending] .primary').textContent(), '核对与重试');
  assert.equal(await desktop.locator('[data-task=future] .primary').isDisabled(), true);
  await desktop.locator('#taskTools > summary').click();
  await desktop.locator('#taskSearch').fill('二号场'); assert.equal(await desktop.locator('[data-task]').count(), 3);
  await desktop.locator('#accountFilter').selectOption('b'); assert.equal(await desktop.locator('[data-task]').count(), 1);
  await desktop.locator('#accountFilter').selectOption(''); await desktop.locator('#taskSearch').fill('');
  assert.match(await desktop.locator('[data-task=ready] .plan-brief').innerText(), /二号场.*一号场/, '完整场地顺序直接可见');
  assert.ok((await desktop.locator('[data-task=ready]').boundingBox()).height < 290, '桌面卡片保持紧凑');
  const menu = desktop.locator('[data-task=ready] .more-actions');
  await menu.locator('summary').click(); await menu.locator('summary').click();
  assert.equal(await menu.evaluate((d) => d.open), false, '再次点击收起菜单');
  await menu.locator('summary').click();
  await menu.getByRole('button', { name: '换日期再约', exact: true }).waitFor();
  await desktop.keyboard.press('Escape');
  assert.equal(await menu.evaluate((d) => d.open), false);
  await menu.locator('summary').click(); await desktop.locator('#taskSearch').click();
  assert.equal(await menu.evaluate((d) => d.open), false, '点击外部收起操作菜单');
  await desktop.screenshot({ path: `${uiOutput}/workspace-desktop.png`, fullPage: true });
  await desktop.locator('[data-filter=all]').click();
  await desktop.locator('[data-task=old] [data-action=copy]').first().click();
  assert.equal(await desktop.locator('#taskDate').inputValue(), '2026-10-02');
  assert.equal(await desktop.locator('#taskAccount').inputValue(), 'a');
  assert.equal(await desktop.locator('#bookingGoal').inputValue(), 'consecutive');
  await desktop.waitForFunction(() => document.querySelector('#selectionSummary').textContent.includes('2 个场地'));
  assert.equal(writes.length, 0, '复用打开编辑器不能保存或执行');
  await desktop.locator('#saveTaskButton').click();
  await desktop.locator('#confirmDialog [data-close]').first().click();
  await desktop.locator('[data-task=copy]').waitFor();
  assert.equal(writes.length, 1); assert.equal(writes[0].path, '/api/tasks');
  assert.deepEqual(writes[0].body.courts, ['B', 'A']); assert.equal(writes[0].body.sameCourtAnchor, undefined);
  assert.equal(config.tasks.find((p) => p.id === 'old').date, '2026-09-30');
  await desktop.locator('[data-filter=recent]').click();
  await desktop.clock.setSystemTime(new Date('2026-10-01T12:31:00+08:00'));
  await desktop.locator('[data-task=ready] [data-action=run]').getByText('开始预约', { exact: true }).waitFor();
  await desktop.setViewportSize({ width: 390, height: 844 });
  assert.equal(await desktop.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await desktop.screenshot({ path: `${uiOutput}/workspace-desktop-narrow.png`, fullPage: true });

  const mobile = await pageFor(mobileUrl, 390);
  const snapshot = { version: 1, accounts: accounts.map((a) => ({ ...a, session: { userAgent: 'ui-test', cookies: [] } })), plans: structuredClone(plans), runs: [{ id: 'pending-run', startedAt: '2026-09-30T05:00:00Z', finishedAt: '2026-09-30T06:00:00Z', status: 'interrupted', plans: [plans[3]], items: [{ id: 'pending', name: '需要核对', status: 'interrupted' }], inFlight: { planId: 'pending', plan: '需要核对', date: '2026-09-30', time: '19:00-20:00' }, successes: [], logs: [] }], catalogs: { 'a:volleyball': { date: '2026-10-01', times: base.times, courts: [{ id: 'A', name: '一号场' }, { id: 'B', name: '二号场' }] } } };
  await mobile.addInitScript((s) => localStorage.setItem('szu-mobile-v1', JSON.stringify(s)), snapshot);
  await mobile.goto(mobileUrl);
  await mobile.locator('[data-plan=ready]').waitFor();
  assert.equal(await mobile.locator('[data-plan=old]').count(), 0);
  assert.equal(await mobile.locator('[data-plan=future] .plan-primary').isDisabled(), true);
  assert.equal(await mobile.locator('#batchBar').isVisible(), false);
  await mobile.locator('[data-plan=ready] [data-start]').click();
  assert.equal(await mobile.locator('#confirmDialog').evaluate((d) => d.open), true);
  assert.match(await mobile.locator('#confirmPlans').textContent(), /排球.*10月02日/);
  assert.ok(!(await mobile.locator('#confirmPlans').textContent()).includes('10月04日'));
  assert.match(await mobile.locator('#confirmTiming').innerText(), /12:30/);
  assert.equal(await mobile.locator('input[name=mode]').count(), 0);
  await mobile.locator('#confirmDialog [data-close]').first().click();
  assert.equal((await mobile.evaluate(() => JSON.parse(localStorage.getItem('szu-mobile-v1')))).runs.length, 1);
  assert.ok((await mobile.locator('[data-plan=ready]').boundingBox()).height < 285, '手机卡片保持紧凑');
  assert.match(await mobile.locator('[data-plan=ready] .plan-brief').innerText(), /二号场.*一号场/);
  await mobile.locator('#planTools > summary').click();
  await mobile.locator('#planSearch').fill('排球');
  await mobile.locator('#planSearch').fill('');
  await mobile.screenshot({ path: `${uiOutput}/workspace-mobile.png`, fullPage: true });
  const mobileMenu = mobile.locator('[data-plan=ready] .more-actions');
  await mobileMenu.locator('summary').click(); await mobileMenu.locator('summary').click();
  assert.equal(await mobileMenu.evaluate((d) => d.open), false, '手机再次点击必须收起菜单');
  await mobileMenu.locator('summary').focus(); await mobile.keyboard.press('Enter');
  assert.equal(await mobileMenu.evaluate((d) => d.open), true);
  await mobile.keyboard.press('Escape'); assert.equal(await mobileMenu.evaluate((d) => d.open), false);
  await mobile.locator('[data-filter=all]').click(); await mobile.locator('[data-plan=old] [data-copy]').first().click();
  assert.equal(await mobile.locator('#planDate').inputValue(), '2026-10-02');
  assert.equal(await mobile.locator('#planDialog').evaluate((d) => d.scrollTop), 0, '复用打开时回到日期选择');
  assert.equal(await mobile.evaluate(() => document.activeElement.id), 'planTitle', '打开方案不自动唤起手机键盘');
  assert.equal(await mobile.evaluate(() => getComputedStyle(document.documentElement).overflowY), 'hidden', '弹窗期间不滚动背景');
  assert.equal(await mobile.locator('#bookingGoal').inputValue(), 'consecutive');
  assert.deepEqual(await mobile.locator('#sequence [data-move]').evaluateAll((els) => els.map((e) => e.dataset.move)), ['0', '0', '1', '1']);
  await mobile.locator('#savePlanButton').click();
  await mobile.locator('#confirmDialog [data-close]').first().click();
  const saved = await mobile.evaluate(() => JSON.parse(localStorage.getItem('szu-mobile-v1')));
  assert.equal(saved.plans.length, 5); assert.equal(saved.runs.length, 1);
  assert.equal(saved.plans.at(-1).sameCourtAnchor, undefined); assert.deepEqual(saved.plans.at(-1).courts, ['B', 'A']);
  assert.equal(saved.plans.find((p) => p.id === 'old').date, '2026-09-30');
  await mobile.locator('[data-tab=results]').click(); assert.equal(await mobile.locator('#batchBar').isVisible(), false);
  await mobile.locator('[data-tab=plans]').click(); await mobile.locator('[data-filter=recent]').click();
  await mobile.locator('#planSearch').fill('周末'); assert.equal(await mobile.locator('[data-plan]').count(), 1);
  await mobile.locator('#planSearch').fill('');
  for (const width of [320, 390, 768]) { await mobile.setViewportSize({ width, height: 844 }); assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${width}px 无横向溢出`); }
  const normal = await pageFor(mobileUrl, 390);
  const normalState = { ...saved, runs: [{ id: 'past-use', status: 'success', startedAt: '2026-09-30T04:00:00Z', finishedAt: '2026-09-30T05:00:00Z', plans: [], items: [], successes: [], logs: [] }], plans: saved.plans.filter((p) => p.date >= '2026-10-02') };
  await normal.addInitScript((state) => localStorage.setItem('szu-mobile-v1', JSON.stringify(state)), normalState);
  await normal.goto(mobileUrl);
  await normal.locator('[data-plan=ready]').waitFor();
  assert.equal(await normal.locator('.mobile-overview').isVisible(), false, '正常状态不展示重复概览');
  await normal.screenshot({ path: `${uiOutput}/clean-mobile-normal.png` });
  await normal.locator('#newPlan').click();
  await normal.locator('#planProject').selectOption('volleyball');
  await normal.locator('[data-time="19:00-20:00"]').click(); await normal.locator('[data-court="A"]').click();
  assert.equal(await normal.locator('#bookingGoal').inputValue(), 'one');
  await normal.locator('#planOptions > summary').click();
  await normal.locator('#planName').fill('保存失败回归');
  await normal.evaluate(() => {
    const setItem = Storage.prototype.setItem;
    window.failPlanSave = true;
    Storage.prototype.setItem = function (key, value) {
      if (key === 'szu-mobile-v1' && window.failPlanSave) throw new Error('模拟空间不足');
      return setItem.call(this, key, value);
    };
  });
  await normal.locator('#savePlanButton').click();
  await normal.getByText('模拟空间不足', { exact: true }).waitFor();
  assert.equal(await normal.locator('#planDialog').evaluate((d) => d.open), true, '保存失败保留表单');
  assert.equal(await normal.locator('#plans h3').getByText('保存失败回归', { exact: true }).count(), 0, '保存失败不能留下未落盘的方案');
  await normal.evaluate(() => {
    window.failPlanSave = false;
    const form = document.querySelector('#planForm'); form.requestSubmit(); form.requestSubmit();
  });
  await normal.waitForFunction(() => !document.querySelector('#planDialog').open);
  const retried = await normal.evaluate(() => JSON.parse(localStorage.getItem('szu-mobile-v1')));
  assert.equal(retried.plans.length, normalState.plans.length + 1, '连续提交只能保存一份');
  assert.equal(retried.plans.filter((p) => p.name === '保存失败回归').length, 1);
  assert.deepEqual(errors, []);
  console.log('清爽布局验收通过：卡片密度、完整场地直接可见、菜单键盘/外部关闭、正常状态隐藏概览；两端筛选/搜索、账号筛选、未来日期禁启动、历史复用清除旧锚点、过期待核对保留、12:30预约确认、手机单方案确认、320/390/768px布局。学校请求全部拦截。');
} finally { await Promise.allSettled(pages.map((p) => p.close())); await context.close(); await browser.close(); }
