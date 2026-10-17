// Real Windows Edge rendering; isolated contexts and fake native/API responses.
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { PROJECTS } from '../shared/projects.js';
const [desktopUrl, mobileUrl] = process.argv.slice(2);
for (const url of [desktopUrl, mobileUrl]) if (!url || !['localhost', '127.0.0.1'].includes(new URL(url).hostname)) throw new Error('传入两端的本地预览地址');
const output = process.env.SZU_UI_ARTIFACTS || '/tmp/courtbooker-simple-booking';
await mkdir(output, { recursive: true });
const browser = await chromium.connectOverCDP('http://127.0.0.1:9334');
const context = await browser.newContext();
const errors = [];
const times = ['12:00-13:00', '13:00-14:00', '19:00-20:00', '20:00-21:00', '21:00-22:00'];
async function pageFor(url, width = 390) {
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => { void dialog.accept().catch(error => errors.push(error.message)); });
  await page.setViewportSize({ width, height: 844 });
  await page.clock.install({ time: new Date('2026-10-11T12:00:00+08:00') });
  await page.clock.setSystemTime(new Date('2026-10-11T12:00:00+08:00'));
  await page.route('**/*', route => new URL(route.request().url()).origin === new URL(url).origin ? route.continue() : route.abort());
  return page;
}
try {
  const mobile = await pageFor(mobileUrl);
  await mobile.addInitScript(({ times }) => {
    window.androidBridge = {};
    const state = { version: 1, accounts: [], plans: [], runs: [], catalogs: {} };
    window.bookingAudit = { state, calls: [], loginCount: 0, loginOptions: [], failSave: false, failCatalog: false, enabled: false, schoolRows: [] };
    window.Capacitor = {
      PluginHeaders: [{ name: 'CourtDevice', methods: ['readState', 'writeState', 'request', 'login', 'setExecution', 'copy', 'saveText', 'cancelRequest'].map(name => ({ name, rtype: 'promise' })).concat([{ name: 'addListener', rtype: 'callback' }, { name: 'removeListener', rtype: 'callback' }]) }],
      nativeCallback: () => 'listener',
      nativePromise: async (_plugin, method, options) => {
        const audit = window.bookingAudit;
        if (method === 'readState') return { value: JSON.stringify(audit.state) };
        if (method === 'writeState') { const next = JSON.parse(options.value); if (audit.failSave && next.plans.length > audit.state.plans.length) throw new Error('模拟空间不足'); audit.state = next; return {}; }
        if (method === 'login') {
          audit.loginCount++; audit.loginOptions.push(options);
          if (audit.cancelLogin) { audit.cancelLogin = false; throw new Error('已取消登录，原账号未改动'); }
          return { cookie: 'MOD_AUTH_CAS=fake; _WEU=fake', userAgent: 'Windows Edge native-flow fixture' };
        }
        if (method === 'setExecution') { audit.enabled = options.enabled; return {}; }
        if (method === 'copy') { audit.clipboard = options.text; return {}; }
        if (method === 'saveText') {
          if (audit.cancelSave) return { cancelled: true };
          if (audit.failExport) throw new Error('模拟保存失败');
          audit.savedText = options.text; return { cancelled: false };
        }
        if (method !== 'request') return {};
        audit.calls.push(options);
        const path = new URL(options.url).pathname, form = new URLSearchParams(options.body);
        let body;
        if (path.endsWith('/index.do')) {
          if (audit.holdIdentity) await new Promise(resolve => audit.releaseIdentity = resolve);
          if (audit.expireNextIdentity) { audit.expireNextIdentity = false; return { status: 302, headers: {}, body: '' }; }
          body = "USERID='A';USER_INFO={\"userName\":\"测试同学\"};APP_TITLE=";
        }
        else if (path.endsWith('/getRqList.do')) body = JSON.stringify(['2026-10-11', '2026-10-12']);
        else if (path.endsWith('/getSportVenueData.do')) body = JSON.stringify({ campusList: [{ XQDM: '1', XQDM_DISPLAY: '粤海校区' }], xmList: [{ XQDM: '1', XMDM: '001', XMMC: '羽毛球', DCFS: '1.0' }, { XQDM: '1', XMDM: '002', XMMC: '排球', DCFS: '1.0' }], packageVenueList: [{ SSXQ: '1', XM: '001', CGBM: 'v', CGMC: '运动广场东馆羽毛球场' }, { SSXQ: '1', XM: '002', CGBM: 'vv', CGMC: '西馆排球场（包场）' }] });
        else if (path.endsWith('/getTimeList.do')) { if (audit.failCatalog) throw new Error('模拟网络不可用'); body = JSON.stringify(times.map(CODE => ({ CODE }))); }
        else if (path.endsWith('/getOpeningRoom.do')) body = JSON.stringify({ code: '0', datas: { getOpeningRoom: { rows: [{ WID: 'A', CDMC: '一号场', disabled: audit.fullCourts === true, CGBM: form.get('CGBM') || (form.get('XMDM') === '002' ? 'vv' : 'v'), XMDM: form.get('XMDM'), XQDM: '1' }, { WID: 'B', CDMC: '二号场', disabled: audit.fullCourts === true, CGBM: form.get('CGBM') || (form.get('XMDM') === '002' ? 'vv' : 'v'), XMDM: form.get('XMDM'), XQDM: '1' }] } } });
        else if (path.endsWith('/myBookingInfo.do')) body = JSON.stringify({ code: '0', datas: { myBookingInfo: { rows: audit.schoolRows, totalSize: audit.schoolRows.length } } });
        else if (path.endsWith('/insertVenueBookingInfo.do')) {
          if (audit.unknownNextBooking) { audit.unknownNextBooking = false; throw new Error('模拟提交后连接中断'); }
          if (audit.rateNextBooking || audit.rateAlways) { audit.rateNextBooking = false;
            body = JSON.stringify({ code: '#E111080000000', msg: '操作过于频繁，请稍后再试！' });
          } else body = JSON.stringify(audit.rejectSecond && form.get('KYYSJD') === '13:00-14:00'
            ? { code: '1', msg: '模拟账号限制，停止本次预约' } : { code: '0', data: { DHID: 'fake-order' } });
        }
        else body = '[]';
        return { status: 200, headers: {}, body };
      },
    };
  }, { times });
  await mobile.goto(mobileUrl);
  await mobile.locator('#overviewAction').waitFor();
  await mobile.screenshot({ path: `${output}/simple-first-use.png` });
  await mobile.locator('#overviewAction').click();
  await mobile.locator('[data-time="19:00-20:00"]').waitFor();
  assert.equal(await mobile.evaluate(() => bookingAudit.loginCount), 1, '首次登录直接打开学校登录，成功后进入预约编辑');
  assert.equal(await mobile.locator('#planOptions').evaluate(element => element.open), false);
  assert.equal(await mobile.locator('#planAccountField').isVisible(), false);
  assert.equal(await mobile.locator('#allCourts').getAttribute('aria-pressed'), 'true');
  assert.equal(await mobile.locator('#loadCatalog').isVisible(), false, '可选项自动加载，无需用户读取目录');
  await mobile.locator('[data-time="19:00-20:00"]').click();
  await mobile.locator('#savePlanButton').click();
  await mobile.locator('#confirmDialog').waitFor();
  assert.match(await mobile.locator('#confirmTiming').innerText(), /12:30/);
  assert.equal(await mobile.locator('input[name=mode]').count(), 0);
  assert.equal(await mobile.evaluate(() => bookingAudit.state.plans[0].bookingGoal), 'one', '选一个时段即可，不需要调整目标');
  assert.deepEqual(await mobile.evaluate(() => bookingAudit.state.plans[0].courts), ['*']);
  assert.equal(await mobile.evaluate(() => bookingAudit.calls.filter(call => call.url.includes('insertVenueBookingInfo')).length), 0, '进入确认页不会预约');
  await mobile.screenshot({ path: `${output}/simple-confirm.png` });
  await mobile.locator('#confirmStart').click();
  await mobile.waitForFunction(() => bookingAudit.state.runs[0]?.items[0]?.status === 'waiting');
  assert.equal(await mobile.evaluate(() => bookingAudit.state.runs[0].mode), 'auto');
  assert.equal(await mobile.evaluate(() => bookingAudit.calls.filter(call => call.url.includes('insertVenueBookingInfo')).length), 0, '放号前自动等待');
  await mobile.locator('#stop').click();
  await mobile.waitForFunction(() => bookingAudit.state.runs[0]?.finishedAt && !bookingAudit.enabled);
  await mobile.clock.setSystemTime(new Date('2026-10-11T13:00:00+08:00'));
  await mobile.locator('[data-tab=plans]').click();
  await mobile.locator('[data-start]').first().click();
  assert.match(await mobile.locator('#confirmTiming').innerText(), /立即/);
  await mobile.locator('#confirmStart').click();
  await mobile.waitForFunction(() => bookingAudit.state.runs[0]?.status === 'success' && bookingAudit.state.runs[0].finishedAt);
  assert.equal(await mobile.evaluate(() => bookingAudit.calls.filter(call => call.url.includes('insertVenueBookingInfo')).length), 1, '已开放时自动立即预约，仍只提交所选的一个时段');
  await mobile.clock.setSystemTime(new Date('2026-10-11T12:00:00+08:00'));
  await mobile.locator('[data-tab=plans]').click();
  assert.equal(await mobile.locator('[data-select]').count(), 0, '普通预约卡片不出现批量复选框');
  await mobile.locator('#newPlan').click();
  await mobile.locator('[data-time="19:00-20:00"]').waitFor();
  await mobile.locator('[data-time="19:00-20:00"]').click();
  await mobile.locator('[data-time="20:00-21:00"]').click();
  await mobile.locator('[data-time="21:00-22:00"]').click();
  assert.equal(await mobile.locator('#times [aria-pressed=true]').count(), 2);
  await mobile.evaluate(() => bookingAudit.failSave = true);
  await mobile.locator('#savePlanButton').click();
  await mobile.getByText('模拟空间不足', { exact: true }).waitFor();
  assert.equal(await mobile.locator('#planDialog').evaluate(element => element.open), true);
  assert.equal(await mobile.evaluate(() => bookingAudit.state.plans.length), 1, '保存失败保留表单，不能留下虚假的预约');
  await mobile.evaluate(() => bookingAudit.failSave = false);
  await mobile.locator('#planDate').selectOption('2026-10-14');
  await mobile.locator('#savePlanButton').click();
  await mobile.waitForFunction(() => !document.querySelector('#planDialog').open);
  assert.equal(await mobile.locator('#confirmDialog').evaluate(element => element.open), false, '未来开放日只保存');
  assert.equal(await mobile.evaluate(() => bookingAudit.state.plans[1].bookingGoal), 'two');
  await mobile.locator('#planTools > summary').click(); await mobile.locator('#batchSelect').click();
  assert.equal(await mobile.locator('[data-select]').count(), 2, '批量选择只在用户主动进入后出现');
  await mobile.locator('#planTools > summary').click(); await mobile.locator('#endBatch').click();
  assert.equal(await mobile.locator('[data-select]').count(), 0);
  await mobile.locator('#planTools > summary').click();
  await mobile.screenshot({ path: `${output}/simple-mobile-list.png` });
  await mobile.locator('#newPlan').click();
  await mobile.locator('[data-time="19:00-20:00"]').waitFor();
  await mobile.screenshot({ path: `${output}/simple-mobile-editor.png` });
  await mobile.locator('[data-close=plan]').first().click();
  for (const width of [320, 390, 768]) {
    await mobile.setViewportSize({ width, height: 844 });
    await mobile.screenshot({ path: `${output}/simple-mobile-${width}.png` });
    assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false);
  }
  console.log('手机：首次登录直接进入编辑、自动加载、单/双时段默认目标、默认不限场地、确认前不提交、自动等待/停止、未来只保存、保存失败保留输入、批量主动进入及小屏画面。');

  await mobile.setViewportSize({ width: 390, height: 844 });
  await mobile.locator('[data-tab=accounts]').click();
  const beforeCheckLogins = await mobile.evaluate(() => { bookingAudit.holdIdentity = true; return bookingAudit.loginCount; });
  await mobile.locator('[data-verify]').first().click();
  await mobile.getByRole('button', { name: '检查中…', exact: true }).waitFor();
  assert.equal(await mobile.locator('[data-verify]').first().getAttribute('aria-busy'), 'true');
  await mobile.waitForFunction(() => typeof bookingAudit.releaseIdentity === 'function');
  await mobile.evaluate(() => { bookingAudit.holdIdentity = false; bookingAudit.releaseIdentity(); });
  await mobile.getByText('刚刚检查，登录正常', { exact: true }).waitFor();
  assert.equal(await mobile.evaluate(() => bookingAudit.loginCount), beforeCheckLogins, '有效登录直接检查并返回，不打开学校窗口');
  await mobile.screenshot({ path: `${output}/android-account-check.png` });
  await mobile.evaluate(() => { bookingAudit.expireNextIdentity = true; });
  const previousLogins = await mobile.evaluate(() => bookingAudit.loginCount);
  let recoveryConfirmations = 0;
  const countConfirmation = () => recoveryConfirmations++;
  mobile.on('dialog', countConfirmation);
  await mobile.locator('[data-verify]').first().click();
  await mobile.waitForFunction(before => bookingAudit.loginCount === before + 1 && !document.querySelector('[data-verify]').disabled, previousLogins);
  await mobile.getByText('登录正常：测试同学', { exact: true }).waitFor();
  mobile.off('dialog', countConfirmation);
  assert.equal(await mobile.evaluate(() => bookingAudit.loginCount), previousLogins + 1);
  assert.equal(recoveryConfirmations, 0, '已绑定账号自动恢复后直接提示成功，无需再次确认身份');
  const savedAccount = await mobile.evaluate(() => JSON.stringify(bookingAudit.state.accounts));
  await mobile.evaluate(() => { bookingAudit.cancelLogin = true; });
  await mobile.locator('#accounts .more-actions > summary').first().click();
  await mobile.locator('[data-relogin]').first().click();
  await mobile.getByText('已取消登录', { exact: true }).waitFor();
  assert.equal(await mobile.locator('#loginDialog').evaluate(dialog => dialog.open), false, '取消学校窗口直接回到账号页');
  assert.equal(await mobile.evaluate(() => JSON.stringify(bookingAudit.state.accounts)), savedAccount);
  assert.equal(await mobile.evaluate(() => bookingAudit.loginOptions.at(-1).fresh), true, '显式重新登录应允许换号，避免反复自动抓到旧会话');

  await mobile.clock.setSystemTime(new Date('2026-10-13T20:00:00+08:00'));
  await mobile.locator('[data-tab=plans]').click();
  await mobile.locator('#newPlan').click();
  await mobile.locator('#planDate').selectOption('2026-10-14');
  await mobile.locator('[data-time="12:00-13:00"]').click();
  await mobile.locator('[data-time="13:00-14:00"]').click();
  await mobile.locator('[data-court="A"]').click();
  await mobile.locator('#savePlanButton').click();
  const scenarioId = await mobile.evaluate(() => bookingAudit.state.plans.at(-1).id);
  const scenarioCard = mobile.locator(`[data-plan="${scenarioId}"]`);
  await mobile.evaluate(() => { bookingAudit.schoolRows = [{ YYRQ: '2026-10-14', YYSJD: '12:00-13:00', XMDM: '001', YYZT: '新状态' }]; });
  const previousSends = await mobile.evaluate(() => bookingAudit.calls.filter(call => call.url.includes('insertVenueBookingInfo')).length);
  await mobile.locator('#confirmStart').click();
  await mobile.waitForFunction(() => bookingAudit.state.runs[0]?.status === 'error' && bookingAudit.state.runs[0].finishedAt);
  assert.equal(await mobile.evaluate(() => bookingAudit.calls.filter(call => call.url.includes('insertVenueBookingInfo')).length), previousSends);
  await mobile.locator('[data-tab=plans]').click();
  await scenarioCard.getByRole('button', { name: '重新预约', exact: true }).waitFor();
  assert.equal(await scenarioCard.getByRole('button', { name: '核对与重试', exact: true }).count(), 0, '预约前失败且未发请求可直接重试');
  assert.doesNotMatch(await mobile.locator('#toast').innerText(), /付款/, '零成功不提示付款');
  await mobile.screenshot({ path: `${output}/android-preflight-retry.png` });
  await mobile.evaluate(() => { bookingAudit.schoolRows = [
    { YYSJD: '2026-10-12 12:00~2026-10-12 13:00', XMDM: '001', XMDM_DISPLAY: '羽毛球', YYZT: 'CG_WC', YYZT_DISPLAY: '已完成' },
  ]; });
  await scenarioCard.getByRole('button', { name: '重新预约', exact: true }).click();
  await mobile.locator('#confirmStart').click();
  await mobile.waitForFunction(() => bookingAudit.state.runs[0]?.status === 'success' && bookingAudit.state.runs[0].finishedAt);
  const bookedSlots = await mobile.evaluate(() => bookingAudit.calls.filter(call => call.url.includes('insertVenueBookingInfo')).slice(-2)
    .map(call => { const form = new URLSearchParams(call.body); return [form.get('YYRQ'), form.get('KYYSJD')]; }));
  assert.deepEqual(bookedSlots, [['2026-10-14', '12:00-13:00'], ['2026-10-14', '13:00-14:00']]);
  assert.ok(await mobile.evaluate(() => (bookingAudit.state.runs[0].diagnostics.counts.catalog_query ?? 0) >= 2),
    '固定场地的立即捡漏仍须查询每个时段的实时空位');
  assert.equal(await mobile.evaluate(() => bookingAudit.state.plans.length), 3, '失败后重试原预约，不要求另建重复方案');
  await mobile.screenshot({ path: `${output}/android-oct14-two-slots.png` });
  await mobile.evaluate(() => {
    bookingAudit.schoolRows.push(...['12:00-13:00', '13:00-14:00'].map(time => ({
      YYSJD: '2026-10-14 ' + time.split('-')[0] + '~2026-10-14 ' + time.split('-')[1],
      XMDM: '001', YYZT: 'CG_YY', YYZT_DISPLAY: '已预约', VERIFY_TYPE: 'YY_YZF', CDWID: 'A', CDWID_DISPLAY: '一号场',
    })));
  });
  await mobile.locator('[data-tab=plans]').click();
  await scenarioCard.getByRole('button', { name: '查看结果', exact: true }).click();
  assert.equal(await mobile.locator('[data-run-refresh], [data-run-review]').count(), 0, '明确成功的任务只查看结果，不增加核对步骤');
  assert.equal(await mobile.evaluate(() => bookingAudit.state.plans.length), 3);
  await mobile.screenshot({ path: `${output}/android-completed-result.png` });

  // Run a separate mock date: first slot succeeds, second is explicitly rejected.
  await mobile.clock.setSystemTime(new Date('2026-10-14T20:00:00+08:00'));
  await mobile.locator('[data-tab=plans]').click(); await mobile.locator('#newPlan').click();
  await mobile.locator('#planDate').selectOption('2026-10-15');
  await mobile.locator('[data-time="12:00-13:00"]').click(); await mobile.locator('[data-time="13:00-14:00"]').click();
  await mobile.locator('#savePlanButton').click();
  const partialId = await mobile.evaluate(() => { bookingAudit.rejectSecond = true; return bookingAudit.state.plans.at(-1).id; });
  await mobile.locator('#confirmStart').click();
  await mobile.waitForFunction(() => bookingAudit.state.runs[0]?.status === 'partial' && bookingAudit.state.runs[0].finishedAt && !bookingAudit.enabled);
  await mobile.locator('[data-tab=plans]').click();
  const partialCard = mobile.locator(`[data-plan="${partialId}"]`);
  await partialCard.getByRole('button', { name: '继续预约', exact: true }).waitFor();
  await mobile.screenshot({ path: `${output}/android-partial-continue.png` });
  const beforePartial = await mobile.evaluate(() => {
    bookingAudit.rejectSecond = false;
    bookingAudit.rateNextBooking = true;
    bookingAudit.schoolRows.push({ YYSJD: '2026-10-15 12:00~2026-10-15 13:00', XMDM: '001', YYZT: 'CG_YY', CDWID: 'A', CDWID_DISPLAY: '一号场' });
    return bookingAudit.calls.filter(call => call.url.includes('insertVenueBookingInfo')).length;
  });
  let retryPrompts = 0; const countRetryPrompt = () => retryPrompts++; mobile.on('dialog', countRetryPrompt);
  await partialCard.getByRole('button', { name: '继续预约', exact: true }).click(); await mobile.locator('#confirmStart').click();
  await mobile.waitForFunction(() => bookingAudit.state.runs[0]?.status === 'success' && bookingAudit.state.runs[0].finishedAt && !bookingAudit.enabled);
  mobile.off('dialog', countRetryPrompt); assert.equal(retryPrompts, 0, '部分成功可直接在原任务继续，无需手动核对确认');
  const continued = await mobile.evaluate(before => bookingAudit.calls.filter(call => call.url.includes('insertVenueBookingInfo')).slice(before)
    .map(call => new URLSearchParams(call.body).get('KYYSJD')), beforePartial);
  assert.deepEqual(continued, ['13:00-14:00', '13:00-14:00'], '跳过学校已有第一段，第二段明确过频拒绝后在原任务退避重试');
  assert.equal(await mobile.evaluate(() => bookingAudit.state.plans.length), 4, '继续预约不创建剩余任务');
  assert.equal(await mobile.evaluate(() => Object.keys(bookingAudit.state.runs[0].pendingRequests).length), 0, '明确过频拒绝不制造未知请求');
  assert.equal(await mobile.evaluate(() => bookingAudit.state.runs[0].logs.filter(e => e.details?.event === 'booking_response' && e.details?.message?.includes('操作过于频繁')).length), 1);
  await mobile.screenshot({ path: `${output}/android-rate-retry-success.png` });

  // A sent request with a missing response remains distinct from ordinary failure.
  await mobile.clock.setSystemTime(new Date('2026-10-15T20:00:00+08:00'));
  await mobile.locator('[data-tab=plans]').click(); await mobile.locator('#newPlan').click();
  await mobile.locator('#planDate').selectOption('2026-10-16'); await mobile.locator('[data-time="12:00-13:00"]').click();
  await mobile.locator('#savePlanButton').click(); await mobile.evaluate(() => { bookingAudit.unknownNextBooking = true; });
  await mobile.locator('#confirmStart').click();
  await mobile.waitForFunction(() => bookingAudit.state.runs[0]?.finishedAt && Object.keys(bookingAudit.state.runs[0].pendingRequests).length === 1 && !bookingAudit.enabled);
  const unknownRun = await mobile.evaluate(() => bookingAudit.state.runs[0].id);
  await mobile.evaluate(() => { bookingAudit.schoolRows.push({ YYSJD: '2026-10-16 12:00~2026-10-16 13:00', XMDM: '001', YYZT: 'CG_YY', CDWID: 'A', CDWID_DISPLAY: '一号场' }); });
  await mobile.locator(`[data-run-refresh="${unknownRun}"]`).click();
  await mobile.waitForFunction(() => bookingAudit.state.runs[0]?.reviewedOutcome === 'success');
  const recoveredCard = mobile.locator(`[data-run="${unknownRun}"]`);
  assert.match(await recoveredCard.innerText(), /12:00-13:00.*一号场/s);
  assert.equal(await recoveredCard.locator('[data-run-refresh]').count(), 0);
  await mobile.screenshot({ path: `${output}/android-unknown-result-resolved.png` });
  await mobile.locator('[data-tab=plans]').click(); await mobile.locator('#newPlan').click();
  await mobile.locator('#planDate').selectOption('2026-10-16'); await mobile.locator('[data-time="13:00-14:00"]').click();
  await mobile.locator('#savePlanButton').click(); await mobile.evaluate(() => { bookingAudit.unknownNextBooking = true; });
  await mobile.locator('#confirmStart').click();
  await mobile.waitForFunction(() => bookingAudit.state.runs[0]?.finishedAt && Object.keys(bookingAudit.state.runs[0].pendingRequests).length === 1 && !bookingAudit.enabled);
  const absentRun = await mobile.evaluate(() => bookingAudit.state.runs[0].id);
  await mobile.locator('[data-tab=plans]').click(); await mobile.locator('#newPlan').click();
  await mobile.locator('#planDate').selectOption('2026-10-16'); await mobile.locator('[data-time="19:00-20:00"]').click();
  await mobile.locator('#savePlanButton').click();
  const beforeBlocked = await mobile.evaluate(() => bookingAudit.state.runs.length);
  await mobile.locator('#confirmStart').click(); await mobile.locator('#confirmError').getByText(/结果待确认/).waitFor();
  assert.equal(await mobile.locator('#confirmDialog').evaluate(dialog => dialog.open), true, '启动校验失败保留确认页和具体原因');
  assert.equal(await mobile.evaluate(() => bookingAudit.state.runs.length), beforeBlocked, '启动前被拦截不能制造一次执行记录');
  await mobile.locator('#confirmDialog [data-close]').first().click(); await mobile.locator('[data-tab=results]').click();
  const absentCard = mobile.locator(`[data-run="${absentRun}"]`);
  await absentCard.locator('[data-run-refresh]').click(); await mobile.getByText('结果仍未明确，请在学校“我的预约”查看。', { exact: true }).waitFor();
  assert.equal(await mobile.evaluate(() => Object.keys(bookingAudit.state.runs[0].pendingRequests).length), 1, '查询没有找到订单不能自动判定未提交');
  await absentCard.locator('.more-actions > summary').click(); await absentCard.locator('[data-run-absent]').click();
  await mobile.waitForFunction(() => Object.keys(bookingAudit.state.runs[0].pendingRequests).length === 0);
  assert.equal(await mobile.evaluate(() => Object.values(bookingAudit.state.runs[0].reviewedRequests)[0].manuallyConfirmed), true);
  await absentCard.getByText('已确认未预约', { exact: true }).waitFor();
  assert.doesNotMatch(await absentCard.innerText(), /结果待确认|发生错误/);
  await mobile.screenshot({ path: `${output}/android-manual-absence-resolved.png` });
  await absentCard.locator('.more-actions > summary').click(); await absentCard.locator('[data-run-export]').click();
  await mobile.locator('#copyText').click(); await mobile.locator('#textStatus').getByText(/复制成功/).waitFor();
  assert.equal(await mobile.evaluate(() => bookingAudit.clipboard), await mobile.locator('#exportText').inputValue());
  await mobile.evaluate(() => { bookingAudit.cancelSave = true; }); await mobile.locator('#saveText').click();
  await mobile.locator('#textStatus').getByText('已取消保存，内容仍保留。', { exact: true }).waitFor();
  await mobile.evaluate(() => { bookingAudit.cancelSave = false; bookingAudit.failExport = true; });
  await mobile.locator('#saveText').click(); await mobile.locator('#textStatus').getByText('保存失败：模拟保存失败', { exact: true }).waitFor();
  await mobile.evaluate(() => { bookingAudit.failExport = false; }); await mobile.locator('#saveText').click();
  await mobile.locator('#textStatus').getByText('文件已保存，包含完整诊断日志。', { exact: true }).waitFor();
  assert.equal(await mobile.evaluate(() => bookingAudit.savedText), await mobile.locator('#exportText').inputValue());
  await mobile.screenshot({ path: `${output}/android-native-export-feedback.png` });
  console.log('安卓回归：检查登录失效后自动恢复同一账号；订单字段错误不发单且可直接重试；14日羽毛球12-13、13-14兼容取消/历史订单，两段成功并保存。原生网络和登录使用模拟响应。');

  await mobile.locator('#textDialog [data-close]').first().click();
  await mobile.locator('[data-tab=plans]').click(); await mobile.locator('#newPlan').click();
  await mobile.locator('#planDate').selectOption('2026-10-16'); await mobile.locator('[data-time="19:00-20:00"]').click();
  await mobile.locator('#savePlanButton').click();
  const beforeVacancy = await mobile.evaluate(() => { bookingAudit.fullCourts = true;
    return bookingAudit.calls.filter(call => call.url.includes('insertVenueBookingInfo')).length; });
  await mobile.locator('#confirmStart').click();
  await mobile.locator('#liveStatus').getByText(/暂无可预约空位/).waitFor();
  await mobile.screenshot({ path: `${output}/android-waiting-vacancy.png` });
  assert.equal(await mobile.evaluate(() => bookingAudit.calls.filter(call => call.url.includes('insertVenueBookingInfo')).length), beforeVacancy);
  await mobile.evaluate(() => { bookingAudit.fullCourts = false; });
  await mobile.waitForFunction(() => bookingAudit.state.runs[0]?.status === 'success' && bookingAudit.state.runs[0].finishedAt);
  assert.equal(await mobile.evaluate(() => bookingAudit.calls.filter(call => call.url.includes('insertVenueBookingInfo')).length), beforeVacancy + 1);
  await mobile.locator('[data-tab=plans]').click(); await mobile.locator('#newPlan').click();
  await mobile.locator('#planDate').selectOption('2026-10-16'); await mobile.locator('[data-time="20:00-21:00"]').click();
  await mobile.locator('#savePlanButton').click(); await mobile.evaluate(() => { bookingAudit.rateNextBooking = true; });
  await mobile.locator('#confirmStart').click();
  await mobile.locator('#liveStatus').getByText(/学校限制请求，等待重试/).waitFor();
  await mobile.screenshot({ path: `${output}/android-account-cooldown.png` });
  await mobile.waitForFunction(() => bookingAudit.state.runs[0]?.status === 'success' && bookingAudit.state.runs[0].finishedAt);
  assert.equal(await mobile.evaluate(() => Object.keys(bookingAudit.state.runs[0].pendingRequests).length), 0);
  console.log('Edge 界面检查（模拟学校响应）：全满显示等待且零提交，释放空位后继续；过频显示等待秒数并继续原任务。');

  await mobile.locator('[data-tab=plans]').click(); await mobile.locator('#newPlan').click();
  await mobile.locator('#planDate').selectOption('2026-10-16'); await mobile.locator('[data-time="21:00-22:00"]').click();
  await mobile.locator('#savePlanButton').click();
  const beforeRateStop = await mobile.evaluate(() => { bookingAudit.rateAlways = true;
    return bookingAudit.calls.filter(call => call.url.includes('insertVenueBookingInfo')).length; });
  await mobile.locator('#confirmStart').click();
  await mobile.waitForFunction(() => bookingAudit.state.runs[0]?.status === 'error' && bookingAudit.state.runs[0].finishedAt && !bookingAudit.enabled);
  assert.equal(await mobile.evaluate(() => bookingAudit.calls.filter(call => call.url.includes('insertVenueBookingInfo')).length), beforeRateStop + 3);
  assert.equal(await mobile.evaluate(() => Object.keys(bookingAudit.state.runs[0].pendingRequests).length), 0);
  const rateRun = await mobile.evaluate(() => bookingAudit.state.runs[0].id);
  const rateCard = mobile.locator(`[data-run="${rateRun}"]`);
  assert.match(await rateCard.innerText(), /操作过于频繁/);
  assert.equal(await rateCard.locator('[data-run-refresh]').count(), 0, '明确拒绝不能冒充未知订单并要求刷新结果');
  await mobile.screenshot({ path: `${output}/android-sustained-rate-stopped.png` });
  console.log('Edge 界面检查（模拟学校响应）：持续频率拒绝三次后结束本轮，保留原话，没有未知订单或继续刷单。');

  const desktop = await pageFor(desktopUrl, 1360);
  const config = { projects: PROJECTS, tasks: [] }, accounts = [{ id: 'default', name: '学校账号', exists: false }], writes = [];
  let loggedIn = false;
  await desktop.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    let data = { ok: true };
    if (path === '/api/bootstrap') data = { ...data, config, accounts, jobs: [], serverDate: '2026-10-11' };
    else if (path === '/api/auth/start') { loggedIn = true; accounts[0].exists = true; accounts[0].user = '测试同学'; }
    else if (path === '/api/auth/status') data = { ...data, accounts, auth: { status: loggedIn ? 'success' : 'idle', logs: [] } };
    else if (path === '/api/accounts') data.accounts = accounts;
    else if (path === '/api/jobs') data.jobs = [];
    else if (path.endsWith('/catalog')) data = { ...data, date: '2026-10-11', times: times.map(value => ({ value })), courts: [{ id: 'A', name: '一号场' }, { id: 'B', name: '二号场' }] };
    else if (path === '/api/tasks' && request.method() === 'POST') { const input = request.postDataJSON(); writes.push(input); const projectLabel = PROJECTS.find(project => project.id === input.projectId).label; const task = { ...input, id: `p${writes.length}`, projectLabel, name: input.name || `${projectLabel}预约` }; config.tasks.push(task); data = { ...data, config, taskId: task.id }; }
    await route.fulfill({ json: data });
  });
  await desktop.goto(desktopUrl);
  await desktop.locator('#nextStepButton').click();
  await desktop.locator('[data-time="19:00-20:00"]').waitFor();
  assert.equal(await desktop.locator('#taskOptions').evaluate(element => element.open), false);
  assert.equal(await desktop.locator('#taskAccountField').isVisible(), false);
  await desktop.locator('[data-time="19:00-20:00"]').click();
  await desktop.screenshot({ path: `${output}/simple-desktop-editor.png` });
  await desktop.locator('#saveTaskButton').click();
  await desktop.locator('#confirmDialog').waitFor();
  assert.equal(writes.length, 1); assert.equal(writes[0].bookingGoal, 'one'); assert.deepEqual(writes[0].courts, ['*']);
  await desktop.locator('[data-close=confirm]').first().click();
  assert.equal(await desktop.locator('[data-task=p1] h3').innerText(), '羽毛球');
  assert.equal(await desktop.locator('[data-task=p1] .project-tag').count(), 0, '真实默认名称不会重复显示运动标签');
  await desktop.screenshot({ path: `${output}/simple-desktop-list.png` });
  await desktop.locator('#addTaskButton').click();
  await desktop.locator('#taskDate').selectOption('2026-10-14');
  await desktop.locator('[data-time="19:00-20:00"]').click();
  await desktop.locator('#saveTaskButton').click();
  await desktop.waitForFunction(() => !document.querySelector('#taskDialog').open);
  assert.equal(await desktop.locator('#confirmDialog').evaluate(element => element.open), false);
  assert.equal(writes.length, 2);
  for (const width of [320, 390]) { await desktop.setViewportSize({ width, height: 844 }); await desktop.screenshot({ path: `${output}/simple-desktop-${width}.png` }); assert.equal(await desktop.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false); }
  assert.deepEqual(errors, []);
  console.log('桌面：首次登录直接进入编辑、默认单时段与不限场地、保存后直接确认、未来只保存、精简卡片及窄屏；学校网络全部拦截。');
} catch (error) {
  for (const [index, page] of context.pages().entries()) await page.screenshot({ path: `${output}/simple-failure-${index}.png`, timeout: 3000 }).catch(() => {});
  throw error;
} finally { await context.close(); await browser.close(); }
