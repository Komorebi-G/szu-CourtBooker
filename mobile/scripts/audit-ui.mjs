import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
const uiUrl = process.argv[2];
if (!uiUrl || !['localhost', '127.0.0.1'].includes(new URL(uiUrl).hostname)) throw new Error('请传入已启动的本地手机界面 URL');
const browser = await chromium.connectOverCDP('http://127.0.0.1:9334');
const ownedPages = new Set();
const context = await browser.newContext();
const checks = [];
const errors = [];
const metadata = { campusList: [{ XQDM: '1', XQDM_DISPLAY: '粤海校区' }], xmList: [{ XQDM: '1', XMDM: '001', XMMC: '羽毛球', DCFS: '1.0' }], packageVenueList: [{ SSXQ: '1', XM: '001', CGBM: 'v', CGMC: '运动广场东馆羽毛球场' }] };
async function scenario(mode) {
  const page = await context.newPage(); ownedPages.add(page);
  await page.setViewportSize({ width: 390, height: 844 });
  page.on('pageerror', (e) => errors.push(e.message));
  const fixedDate = '2026-10-02';
  const fixedNow = new Date(`2026-10-01T${mode === 'wait' ? '12:00' : '13:00'}:00+08:00`);
  await page.clock.install({ time: fixedNow });
  await page.clock.setSystemTime(fixedNow);
  // Only localhost UI assets are permitted. No real school traffic or credentials.
  await page.route('**/*', (route) => new URL(route.request().url()).origin === new URL(uiUrl).origin ? route.continue() : route.abort());
  await page.addInitScript(({ mode, metadata, date }) => {
    const state = { version: 1, accounts: [{ id: 'a', name: '模拟账号', userId: 'A', user: '测试同学', session: { userAgent: 'audit', cookies: [] } }], plans: [], runs: [], catalogs: {} };
    window.audit = { mode, state, date, requests: [], enabled: false, callbacks: {}, failed: false };
    window.androidBridge = {};
    window.Capacitor = {
      PluginHeaders: [{ name: 'CourtDevice', methods: [
        ...['readState', 'writeState', 'setExecution', 'request', 'copy'].map((name) => ({ name, rtype: 'promise' })),
        { name: 'addListener', rtype: 'callback' }, { name: 'removeListener', rtype: 'callback' },
      ] }],
      nativeCallback: async (_plugin, method, options, callback) => {
        if (method === 'addListener') window.audit.callbacks[options.eventName] = callback;
        return 'listener';
      },
      nativePromise: async (_plugin, method, options) => {
        const a = window.audit;
        if (method === 'readState') return { value: JSON.stringify(a.state) };
        if (method === 'writeState') {
          const snapshot = JSON.parse(options.value);
          if (mode === 'storagefail' && snapshot.runs[0]?.finishedAt) { a.failed = true; throw new Error('模拟存储已满'); }
          a.state = snapshot; return {};
        }
        if (method === 'setExecution') { a.enabled = options.enabled; return {}; }
        if (method !== 'request') return {};
        a.requests.push(options);
        const path = new URL(options.url).pathname;
        let body;
        if (path.endsWith('/index.do')) body = "USERID='A';USER_INFO={\"userName\":\"测试同学\"};APP_TITLE=";
        else if (path.endsWith('/myBookingInfo.do')) body = JSON.stringify({ code: '0', datas: { myBookingInfo: { rows: [], totalSize: 0 } } });
        else if (path.endsWith('/getSportVenueData.do')) body = JSON.stringify(metadata);
        else if (path.endsWith('/getOpeningRoom.do')) body = JSON.stringify({ code: '0', datas: { getOpeningRoom: { rows: [{ WID: 'other', CDMC: '2号场', CGBM: 'v', XMDM: '001', XQDM: '1' }, { WID: 'court', CDMC: '1号场', CGBM: 'v', XMDM: '001', XQDM: '1' }] } } });
        else if (path.endsWith('/insertVenueBookingInfo.do')) body = mode === 'malformed' ? '{}' : mode === 'priority' && new URLSearchParams(options.body).get('CDWID') === 'court' ? JSON.stringify({ code: '1', msg: '满场' }) : JSON.stringify({ code: '0', data: { DHID: 'simulated-order' } });
        else body = '[]';
        return { status: 200, headers: {}, body };
      },
    };
  }, { mode, metadata, date: fixedDate });
  await page.goto(uiUrl);
  await page.getByRole('button', { name: '＋ 新建', exact: true }).click();
  await page.locator('#planName').fill('深查模拟方案');
  await page.locator('#planDate').selectOption(fixedDate);
  await page.getByText('手动添加时段', { exact: true }).click();
  await page.locator('#timeStart').fill('15:00'); await page.locator('#timeEnd').fill('16:00');
  await page.getByRole('button', { name: '添加', exact: true }).click();
  assert.equal(await page.locator('#includeOtherCourts').isChecked(), false);
  if (mode === 'priority') {
    await page.locator('#loadCatalog').click();
    await page.locator('[data-court=court]').click();
    await page.locator('#includeOtherCourts').check();
  } else await page.getByRole('button', { name: '按学校顺序全部尝试', exact: true }).click();
  await page.getByRole('button', { name: '保存方案', exact: true }).click();
  assert.equal(await page.evaluate(() => audit.state.plans.length), 1);
  if (mode === 'priority') {
    await page.getByRole('button', { name: '编辑', exact: true }).click();
    assert.equal(await page.locator('#includeOtherCourts').isChecked(), true);
    await page.screenshot({ path: 'output/playwright/deep-priority-option.png', fullPage: true });
    await page.getByRole('button', { name: '保存方案', exact: true }).click();
  }
  await page.getByRole('button', { name: '执行所选', exact: true }).click();
  assert.match(await page.locator('#confirmPlans').innerText(), /放号.*北京时间/);
  if (mode !== 'wait') await page.locator('input[name=mode][value=now]').check();
  await page.locator('#confirmStart').click();
  if (mode === 'wait') {
    await page.waitForFunction(() => document.querySelector('#liveStatus').textContent.includes('倒计时'));
    assert.equal(await page.evaluate(() => audit.requests.filter((r) => r.url.includes('insertVenueBookingInfo')).length), 0);
    await page.screenshot({ path: 'output/playwright/deep-wait.png', fullPage: true });
    await page.getByRole('button', { name: '停止执行', exact: true }).click();
    await page.waitForFunction(() => audit.state.runs[0]?.finishedAt && !audit.enabled);
    assert.equal(await page.evaluate(() => audit.state.runs[0].status), 'stopped');
  } else if (mode === 'storagefail') {
    await page.waitForFunction(() => audit.failed && !audit.enabled);
    assert.match(await page.locator('#toast').innerText(), /存储已满/);
    assert.match(await page.locator('#runs').innerText(), /执行失败/);
  } else {
    await page.waitForFunction(() => audit.state.runs[0]?.finishedAt && !audit.enabled);
    const run = await page.evaluate(() => audit.state.runs[0]);
    assert.equal(run.status, mode === 'malformed' ? 'error' : 'success');
    assert.equal(await page.evaluate(() => audit.requests.filter((r) => r.url.includes('insertVenueBookingInfo')).length), mode === 'priority' ? 2 : 1);
    if (mode === 'priority') assert.deepEqual(await page.evaluate(() => audit.requests.filter((r) => r.url.includes('insertVenueBookingInfo')).map((r) => new URLSearchParams(r.body).get('CDWID'))), ['court', 'other']);
    const booking = await page.evaluate(() => audit.requests.find((r) => r.url.includes('insertVenueBookingInfo')));
    assert.ok(Number.isFinite(booking.deadlineMs));
    if (mode === 'malformed') assert.ok(run.inFlight);
    await page.screenshot({ path: `output/playwright/deep-${mode}.png`, fullPage: true });
    await page.getByRole('button', { name: '方案', exact: true }).click();
    const primary = page.locator('#plans .plan-primary');
    assert.equal(await primary.textContent(), mode === 'malformed' ? '核对与重试' : '查看结果');
    assert.equal(await page.locator('[data-select]').isDisabled(), true);
    await page.locator('#plans .more-actions summary').click();
    await page.getByRole('button', { name: '再约一次', exact: true }).click();
    assert.equal(await page.locator('#planDate').inputValue(), fixedDate);
    assert.equal(await page.evaluate(() => audit.state.runs.length), 1);
    assert.equal(await page.locator('#plans .more-actions[open]').count(), 0, '复用打开弹窗后收起背景菜单');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#planDialog').evaluate((d) => d.open), false, '一次 Esc 关闭复用编辑器');
    assert.equal(await page.locator('#confirmDialog').evaluate((el) => el.open), false);
  }
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  checks.push(mode); await page.close(); ownedPages.delete(page);
}
try {
  for (const mode of ['wait', 'success', 'malformed', 'storagefail', 'priority']) await scenario(mode);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ checks, pageErrors: errors, realSchoolRequests: 0 }));
  await context.close(); await browser.close();
} catch (error) {
  console.error(error);
  await Promise.allSettled([...ownedPages].map((page) => page.close()));
  await context.close(); await browser.close(); process.exitCode = 1;
}
