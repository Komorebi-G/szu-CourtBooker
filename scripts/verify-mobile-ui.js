// Runs only against the dedicated Windows Edge. All credentials/catalogs are fake.
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const url = process.argv[2];
if (!url) throw new Error('传入已启动的 mobile/www 预览 URL');
const artifacts = process.env.SZU_UI_ARTIFACTS ?? join(tmpdir(), 'courtbooker-mobile-ui');
const browser = await chromium.connectOverCDP('http://127.0.0.1:9334');
const context = await browser.newContext({ acceptDownloads: true });
await context.route('**/*', (route) => new URL(route.request().url()).origin === new URL(url).origin
  ? route.continue() : route.abort());
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
await page.clock.install({ time: new Date('2026-09-30T12:00:00+08:00') });
await page.clock.setSystemTime(new Date('2026-09-30T12:00:00+08:00'));
await page.addInitScript((date) => {
  localStorage.setItem('szu-mobile-v1', JSON.stringify({ version: 1, accounts: [{ id: 'a', name: '界面测试账号', userId: 'test-a', user: '测试同学',
    session: { userAgent: 'test', cookies: [{ name: 'MOD_AUTH_CAS', value: 'fake', domain: 'ehall.szu.edu.cn', path: '/' }, { name: '_WEU', value: 'fake', domain: 'ehall.szu.edu.cn', path: '/' }] } }],
    plans: [], runs: [{ id: 'diagnostic-ui', mode: 'now', status: 'partial', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
      plans: [{ name: '诊断测试' }], successes: [{ time: '19:00-20:00', court: '1号场', accountId: 'a', date, orderId: 'fake-private-order' }],
      items: [], logs: [], diagnostics: { events: 0 } }], catalogs: { 'a:volleyball': { date, times: ['19:00-20:00', '20:00-21:00'],
      courts: [{ id: 'A', name: '排球 1 号场' }, { id: 'B', name: '排球 2 号场' }] } } }));
}, '2026-09-30');
try {
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto(url);
  assert.equal(await page.locator('#newPlan').isVisible(), false, '首个方案使用首次引导入口');
  await page.locator('#overviewAction').click(); await page.locator('#planProject').selectOption('volleyball');
  assert.equal(await page.locator('#interval').inputValue(), '0.1');
  await page.getByRole('button', { name: '关闭方案' }).click(); assert.equal(await page.locator('#planDialog').evaluate((el) => el.open), false);
  await page.locator('#overviewAction').click(); await page.locator('#planProject').selectOption('volleyball');
  assert.equal(await page.locator('#planName').inputValue(), '');
  await page.locator('[data-time="19:00-20:00"]').click(); await page.locator('[data-time="20:00-21:00"]').click();
  await page.locator('[data-court="B"]').click(); await page.locator('[data-court="A"]').click();
  assert.equal(await page.locator('[data-court="B"] .court-order').textContent(), '1');
  assert.equal(await page.locator('#sameCourt').isChecked(), true);
  await page.getByRole('button', { name: '上移 排球 1 号场', exact: true }).click();
  assert.equal(await page.locator('[data-court="A"] .court-order').textContent(), '1');
  await page.getByRole('button', { name: '下移 排球 1 号场', exact: true }).click();
  await page.locator('#bookingGoal').selectOption('consecutive');
  await page.getByText('重试设置', { exact: true }).click();
  await page.getByRole('button', { name: '慢速捡漏设置', exact: true }).click();
  assert.equal(await page.locator('#interval').inputValue(), '30');
  await page.getByRole('button', { name: '放号抢场设置', exact: true }).click();
  assert.equal(await page.locator('#interval').inputValue(), '0.1');
  await mkdir(artifacts, { recursive: true });
  await page.locator('#sequence').scrollIntoViewIfNeeded(); await page.screenshot({ path: join(artifacts, 'mobile-app-editor.png') });
  await page.getByRole('button', { name: '保存方案', exact: true }).click();
  const state = await page.evaluate(() => JSON.parse(localStorage.getItem('szu-mobile-v1')));
  assert.equal(state.plans.length, 1); assert.equal(state.runs.length, 1);
  assert.match(state.plans[0].name, /排球 19:00-20:00/);
  assert.deepEqual(state.plans[0].courts, ['B', 'A']); assert.equal(state.plans[0].bookingGoal, 'consecutive');
  assert.equal(await page.locator('.open-source-note a').getAttribute('href'), 'https://github.com/Komorebi-G/szu-CourtBooker');
  assert.equal(await page.locator('[data-select]').isChecked(), false, '保存不应自动选择批量执行');
  await page.locator('[data-select]').check(); await page.locator('#begin').click();
  assert.equal(await page.locator('input[value="auto"]').isChecked(), true);
  assert.equal(await page.locator('input[value="now"]').isDisabled(), true);
  assert.match(await page.locator('#confirmPlans').textContent(), /界面测试账号/);
  await page.locator('#confirmStart').click(); await page.getByText('网页预览不能执行，请安装 APK', { exact: true }).waitFor();
  await page.getByRole('button', { name: '关闭确认' }).click();
  await page.screenshot({ path: join(artifacts, 'mobile-app-plans.png') });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.locator('[data-tab="accounts"]').click(); await page.locator('[data-export="a"]').click();
  assert.match(await page.locator('#exportText').inputValue(), /MOD_AUTH_CAS/);
  await page.locator('#textDialog [data-close]').first().click();
  await page.locator('#schoolLogin').click();
  await page.locator('#openSchoolLogin').click();
  await page.getByText('请在 Android App 中使用学校登录；网页预览可以导入 JSON', { exact: true }).waitFor();
  await page.locator('#loginDialog [data-close]').first().click();
  await page.locator('[data-relogin="a"]').click();
  assert.match(await page.locator('#loginHint').textContent(), /不会改动原记录/);
  await page.screenshot({ path: join(artifacts, 'mobile-app-login.png') });
  await page.locator('#loginDialog [data-close]').first().click();
  assert.equal((await page.evaluate(() => JSON.parse(localStorage.getItem('szu-mobile-v1')))).accounts.length, 1);
  await page.locator('[data-tab="results"]').click();
  await page.locator('[data-run-export="diagnostic-ui"]').click();
  const diagnosticText = await page.locator('#exportText').inputValue();
  assert.match(diagnosticText, /szu-court-diagnostics\/v1/);
  assert.ok(!diagnosticText.includes('fake-private-order'));
  await page.locator('#textDialog [data-close]').first().click();
  const expired = { ...state, plans: state.plans.map((p) => ({ ...p, date: '2026-09-29' })) };
  await page.addInitScript((snapshot) => localStorage.setItem('szu-mobile-v1', JSON.stringify(snapshot)), expired);
  await page.reload();
  await page.locator('[data-filter=all]').click();
  await page.locator('[data-edit]').click();
  assert.equal(await page.locator('#planDate').inputValue(), '2026-09-29', '过期日期不能静默改成明天');
  await page.getByRole('button', { name: '保存方案', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#planError').textContent.includes('日期须为'));
  await page.getByRole('button', { name: '关闭方案' }).click();
  assert.deepEqual(errors, []);
  console.log('手机界面通过：同场、重排、连续目标、重试预设、保存不执行、执行确认、脱敏诊断/账号导出、登录入口、过期日期保留及390px布局；没有学校请求。');
} finally { await page.close(); await context.close(); await browser.close(); }
