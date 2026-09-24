// Runs only against the dedicated Windows Edge. All credentials/catalogs are fake.
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { shanghaiDate } from '../shared/utils.js';
const url = process.argv[2];
if (!url) throw new Error('传入已启动的 mobile/www 预览 URL');
const browser = await chromium.connectOverCDP('http://127.0.0.1:9334');
const page = await browser.contexts()[0].newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
await page.addInitScript((date) => {
  localStorage.setItem('szu-mobile-v1', JSON.stringify({ version: 1, accounts: [{ id: 'a', name: '界面测试账号', userId: 'test-a', user: '测试同学',
    session: { userAgent: 'test', cookies: [{ name: 'MOD_AUTH_CAS', value: 'fake', domain: 'ehall.szu.edu.cn', path: '/' }, { name: '_WEU', value: 'fake', domain: 'ehall.szu.edu.cn', path: '/' }] } }],
    plans: [], runs: [], catalogs: { 'a:volleyball': { date, times: ['19:00-20:00', '20:00-21:00'],
      courts: [{ id: 'A', name: '排球 1 号场' }, { id: 'B', name: '排球 2 号场' }] } } }));
}, shanghaiDate());
try {
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto(url);
  await page.locator('#newPlan').click(); await page.locator('#planProject').selectOption('volleyball');
  assert.equal(await page.locator('#interval').inputValue(), '0.1');
  await page.getByRole('button', { name: '关闭方案' }).click(); assert.equal(await page.locator('#planDialog').evaluate((el) => el.open), false);
  await page.locator('#newPlan').click(); await page.locator('#planProject').selectOption('volleyball');
  assert.equal(await page.locator('#planName').inputValue(), '');
  await page.locator('[data-time="19:00-20:00"]').click(); await page.locator('[data-time="20:00-21:00"]').click();
  await page.locator('[data-court="B"]').click(); await page.locator('[data-court="A"]').click();
  assert.equal(await page.locator('[data-court="B"] .court-order').textContent(), '1');
  assert.equal(await page.locator('#sameCourt').isChecked(), true);
  await mkdir('output/playwright', { recursive: true });
  await page.locator('#sequence').scrollIntoViewIfNeeded(); await page.screenshot({ path: 'output/playwright/mobile-app-editor.png' });
  await page.getByRole('button', { name: '保存方案', exact: true }).click();
  const state = await page.evaluate(() => JSON.parse(localStorage.getItem('szu-mobile-v1')));
  assert.equal(state.plans.length, 1); assert.equal(state.runs.length, 0);
  assert.match(state.plans[0].name, /排球 19:00-20:00/);
  assert.deepEqual(state.plans[0].courts, ['B', 'A']);
  assert.equal(await page.locator('.open-source-note a').getAttribute('href'), 'https://github.com/Komorebi-G/szu-CourtBooker');
  await page.locator('#begin').click(); await page.locator('input[value="now"]').check();
  assert.match(await page.locator('#confirmPlans').textContent(), /界面测试账号/);
  await page.locator('#confirmStart').click(); await page.getByText('网页预览不能执行，请安装 APK', { exact: true }).waitFor();
  await page.getByRole('button', { name: '关闭确认' }).click();
  await page.screenshot({ path: 'output/playwright/mobile-app-plans.png' });
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
  await page.screenshot({ path: 'output/playwright/mobile-app-login.png' });
  await page.locator('#loginDialog [data-close]').first().click();
  assert.equal((await page.evaluate(() => JSON.parse(localStorage.getItem('szu-mobile-v1')))).accounts.length, 1);
  assert.deepEqual(errors, []);
  console.log('手机界面通过：关闭、同场选项、场地顺序、默认0.1秒、保存不执行、执行确认、账号导出、学校登录入口/取消/重新登录、390px布局；没有学校请求。');
} finally { await page.close(); await browser.close(); }
