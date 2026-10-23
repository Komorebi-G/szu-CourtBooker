import test from 'node:test';
import assert from 'node:assert/strict';
import { ForegroundExecution } from '../mobile/src/execution.js';
import { MobileStore, pendingMobileRequests } from '../mobile/src/store.js';
import { createConnection } from '../mobile/src/school.js';
import { nativeTransport } from '../mobile/src/device.js';
import { CoreHttpClient } from '../shared/http-client-core.js';
import { RequestNotSentError } from '../shared/errors.js';

const NOW = Date.parse('2026-10-14T13:00:00+08:00');
const metadata = { campusList: [{ XQDM: '1', XQDM_DISPLAY: '粤海校区' }],
  xmList: [{ XQDM: '1', XMDM: '001', XMMC: '羽毛球', DCFS: '1.0' }],
  packageVenueList: [{ SSXQ: '1', XM: '001', CGBM: 'v', CGMC: '运动广场东馆羽毛球场' }] };
const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };
const delay = ms => new Promise(r => setTimeout(r, ms));
const knownCourt = { WID: 'C6', CDMC: 'C6', CGBM: 'v', XMDM: '001', XQDM: '1', CQBM: '' };
const cacheCourt = (f, rooms = [knownCourt]) => f.store.state.catalogs['a:badminton'] = { rooms };

// Exercise the production HTTP parser, native queue, school API, mobile store,
// quota and runner together. Only the native HTTP/device boundary is replaced.
function fixture(t, { onBook, onRooms, beforeNativeDispatch, rows = [], onWrite, readDelayMs = 0, bookDelayMs = 15,
  rateLimitBackoffMs = 1000 } = {}) {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const calls = [], books = [], snapshots = [], markers = {};
  let active = 0, maxActive = 0, enabled = false;
  const device = {
    async readState() { return { value: JSON.stringify(snapshots.at(-1)), dispatchedRequests: structuredClone(markers), dispatchJournalAvailable: true }; },
    async writeState({ value }) {
      const state = JSON.parse(value); snapshots.push(state);
      for (const id of Object.keys(markers)) if (state.runs.some(run => run.knownRequests?.[id]
        || run.successes.some(success => success.requestId === id))) delete markers[id];
      await onWrite?.(state);
    },
    async setExecution({ enabled: next }) { enabled = next; },
    async request(input) {
      const endpoint = new URL(input.url).pathname.split('/').at(-1);
      await beforeNativeDispatch?.(input);
      const form = Object.fromEntries(new URLSearchParams(input.body));
      const call = { endpoint, form, startedAt: performance.now(), requestId: input.requestId,
        deadlineMs: input.deadlineMs, at: Date.now() }; calls.push(call);
      let body;
      if (endpoint === 'insertVenueBookingInfo.do') {
        assert.equal(enabled, true, '停止后不能发送新订单');
        const durable = snapshots.at(-1).runs[0].pendingRequests[input.requestId];
        assert.ok(durable, '每个发出的请求都有已落盘的意图');
        markers[input.requestId] = { requestId: input.requestId, runId: input.token, sentAt: Date.now(),
          ...input.requestMetadata, accountId: input.accountId, date: form.YYRQ, time: form.KYYSJD,
          courtId: form.CDWID, venueCode: form.CGDM, sportCode: form.XMDM, campusCode: form.XQWID, modeCode: form.YYLX,
          accountIdentityId: form.YYRGH };
        books.push(call); maxActive = Math.max(maxActive, ++active);
        try { body = await (onBook ? onBook(call, books.length) : delay(bookDelayMs).then(() => ({ code: '0', data: { DHID: `order-${books.length}` } }))); }
        finally { active--; call.endedAt = performance.now(); }
      } else {
        if (readDelayMs) await delay(readDelayMs);
        if (endpoint === 'index.do') body = "USERID='A';USER_INFO={\"userName\":\"测试同学\"};APP_TITLE=";
        else if (endpoint === 'getSportVenueData.do') body = metadata;
        else if (endpoint === 'getRqList.do') body = ['2026-10-14', '2026-10-15'];
        else if (endpoint === 'myBookingInfo.do') body = { code: '0', datas: { myBookingInfo: { rows, totalSize: rows.length } } };
        else if (endpoint === 'getOpeningRoom.do') body = { code: '0', datas: { getOpeningRoom: { rows: onRooms ? await onRooms(call)
          : ['C6', 'C4'].map(id => ({ WID: id, CDMC: id, CGBM: 'v', XMDM: '001', XQDM: '1' })) } } };
        else throw new Error(`未预期的接口 ${endpoint}`);
        call.endedAt = performance.now();
      }
      return { status: 200, headers: { date: [new Date().toUTCString()] }, body: typeof body === 'string' ? body : JSON.stringify(body) };
    },
  };
  const store = new MobileStore(device);
  store.state.accounts = [{ id: 'a', name: '测试', userId: 'A', session: { cookies: [], userAgent: 'speed-test' } }];
  const plan = { id: 'p', name: '两段测试', project: 'badminton', accountId: 'a', date: '2026-10-15', bookingGoal: 'two',
    times: ['12:00-13:00', '13:00-14:00'], courts: ['C6'], preferSameCourt: false,
    includeOtherCourts: false, intervalMs: 100, durationMs: 1000 };
  const runner = new ForegroundExecution({ store, device, createApi: (account, token, options) => createConnection(store, device, account, token,
    { ...options, rateLimitBackoffMs }) });
  return { runner, store, plan, device, calls, books, snapshots, maxActive: () => maxActive };
}

function countdownFixture(t, options = {}) {
  const releaseAt = Date.parse('2026-10-14T12:30:00+08:00');
  let prepared;
  const f = fixture(t, { ...options, onWrite: async state => {
    await options.onWrite?.(state);
    const intents = Object.values(state.runs[0]?.pendingRequests ?? {});
    if (!prepared && Date.now() < releaseAt && intents.length === 2) {
      prepared = structuredClone(intents);
      t.mock.timers.setTime(releaseAt + 1);
    }
  } });
  t.mock.timers.setTime(releaseAt - 10000);
  return { ...f, releaseAt, prepared: () => prepared };
}

for (const preferSameCourt of [false, true]) test(`生产同账号串行恢复：同场偏好=${preferSameCourt}`, { timeout: 3000 }, async t => {
  const first = deferred(), release = deferred();
  const f = fixture(t, { onBook: async (_call, n) => { if (n === 1) { first.resolve(); await release.promise; } return { code: '0' }; } });
  const work = f.runner.start([{ ...f.plan, preferSameCourt }], 'now');
  await first.promise; await delay(25);
  assert.equal(f.books.length, 1, '前段学校响应未知时，不得发送后段');
  const restored = new MobileStore(f.device); await restored.load();
  assert.equal(pendingMobileRequests(restored.state.runs[0]).length, 1);
  assert.equal(pendingMobileRequests(restored.state.runs[0])[0].courtId, 'C6');
  release.resolve(); const run = await work;
  assert.equal(run.status, 'success'); assert.equal(f.maxActive(), 1); assert.equal(run.successes.length, 2);
  assert.deepEqual(pendingMobileRequests(run), []);
  assert.equal(f.calls.filter(c => c.endpoint === 'index.do').length, 1);
  assert.equal(f.calls.filter(c => c.endpoint === 'myBookingInfo.do').length, 1);
  assert.equal(f.snapshots.at(-1).runs[0].successes.length, 2);
});

test('任选一段：本时段先选场地、失败立即换场，成功后不发另一时段', async t => {
  const f = fixture(t, { onBook: async call => { await delay(8); return call.form.CDWID === 'C6' ? { code: '1', msg: '已满' } : { code: '0' }; } });
  const run = await f.runner.start([{ ...f.plan, bookingGoal: 'one', courts: ['C6', 'C4'] }], 'now');
  assert.equal(run.status, 'success'); assert.equal(f.maxActive(), 1);
  assert.deepEqual(f.books.map(c => [c.form.KYYSJD, c.form.CDWID]), [['12:00-13:00', 'C6'], ['12:00-13:00', 'C4']]);
});

test('多个场地且优先同场：首段换场成功后，次段首先尝试已成功场地', async t => {
  const f = fixture(t, { onBook: async call => { await delay(8); return call.form.CDWID === 'C6' ? { code: '1', msg: '已满' } : { code: '0' }; } });
  const run = await f.runner.start([{ ...f.plan, preferSameCourt: true, courts: ['C6', 'C4'] }], 'now');
  assert.equal(run.status, 'success'); assert.equal(f.maxActive(), 1);
  assert.deepEqual(f.books.map(c => [c.form.KYYSJD, c.form.CDWID]), [['12:00-13:00', 'C6'], ['12:00-13:00', 'C4'], ['13:00-14:00', 'C4']]);
});

test('学校已有一段：只花剩余一个名额，不并行争用最后的名额', async t => {
  const rows = [{ YYSJD: '2026-10-15 10:00~2026-10-15 11:00', YYZT: 'CG_YY', XMDM: '001', CDWID: 'C6', CDWID_DISPLAY: 'C6', CGDM: 'v', XQWID: '1', YYLX: '1.0' }];
  const f = fixture(t, { rows });
  const run = await f.runner.start([f.plan], 'now');
  assert.equal(f.books.length, 1); assert.equal(f.maxActive(), 1); assert.equal(run.successes.length, 1);
  assert.equal(run.items[0].limited, true);
});

test('重复方案同时启动：两个时段各发一次，其余方案复用同一订单', async t => {
  const f = fixture(t);
  const run = await f.runner.start([f.plan, { ...f.plan, id: 'duplicate' }], 'now');
  assert.equal(run.status, 'success'); assert.equal(f.books.length, 2);
  assert.deepEqual(f.books.map(c => c.form.KYYSJD).sort(), f.plan.times);
  assert.equal(new Set(run.successes.filter(s => !s.reused).map(s => s.requestId)).size, 2);
});

test('前段响应丢失：保留唯一未知请求，后段和重复启动都被阻止', { timeout: 3000 }, async t => {
  const first = deferred(), release = deferred();
  const f = fixture(t, { onBook: async () => { first.resolve(); await release.promise; throw new Error('响应丢失'); } });
  const work = f.runner.start([f.plan], 'now'); await first.promise; release.resolve(); const run = await work;
  assert.equal(f.books.length, 1); assert.equal(run.successes.length, 0);
  assert.deepEqual(pendingMobileRequests(run).map(r => r.time), ['12:00-13:00']);
  assert.deepEqual(pendingMobileRequests(f.snapshots.at(-1).runs[0]).map(r => r.time), ['12:00-13:00']);
  await assert.rejects(f.runner.start([f.plan], 'now'), /结果待确认/);
});

test('前段在途时停止：继续收取其明确响应，后段不发送', { timeout: 3000 }, async t => {
  const first = deferred(), release = deferred();
  const f = fixture(t, { onBook: async () => { first.resolve(); await release.promise; return { code: '0' }; } });
  const work = f.runner.start([f.plan], 'now');
  await first.promise; f.runner.stop(); release.resolve(); const run = await work;
  assert.equal(f.books.length, 1); assert.equal(run.successes.length, 1); assert.equal(run.status, 'stopped');
  assert.deepEqual(pendingMobileRequests(run), []);
  assert.equal(f.snapshots.at(-1).runs[0].successes.length, 1);
});

test('放号前两段意图均落盘，到点按序复用，不为第二段补写意图', { timeout: 3000 }, async t => {
  const releaseAt = Date.parse('2026-10-14T12:30:00+08:00'); let preparedIds;
  const f = fixture(t, { onWrite: state => {
    const prepared = Object.values(state.runs[0]?.pendingRequests ?? {}).filter(r => r.state === 'prepared');
    if (!preparedIds && Date.now() < releaseAt && prepared.length === 2) {
      preparedIds = prepared.map(r => r.requestId); t.mock.timers.setTime(releaseAt + 1);
    }
  } });
  t.mock.timers.setTime(releaseAt - 10000);
  const run = await f.runner.start([f.plan], 'release');
  assert.equal(run.status, 'success'); assert.equal(f.maxActive(), 1);
  assert.deepEqual(f.books.map(b => b.requestId).sort(), preparedIds.sort());
});

test('任意两段多个候选：优先两条互不重叠链路，失败后补候选，成功两段即停', async t => {
  const f = fixture(t, { onBook: async call => { await delay(10);
    return call.form.KYYSJD === '12:00-13:00' ? { code: '1', msg: '已满' } : { code: '0' }; } });
  const run = await f.runner.start([{ ...f.plan, times: [...f.plan.times, '14:00-15:00', '15:00-16:00'] }], 'now');
  assert.equal(run.status, 'success'); assert.equal(f.maxActive(), 1); assert.equal(f.books.length, 3);
  assert.deepEqual(run.successes.map(s => s.time).sort(), ['13:00-14:00', '14:00-15:00']);
});

test('候选有部分重叠：成功后跳过冲突候选，只提交兼容的第二段', async t => {
  const f = fixture(t);
  const run = await f.runner.start([{ ...f.plan, times: ['12:00-13:00', '12:30-13:30', '13:00-14:00'] }], 'now');
  assert.equal(run.status, 'success'); assert.equal(f.maxActive(), 1);
  assert.deepEqual(f.books.map(c => c.form.KYYSJD), f.plan.times);
});

test('连续两段多个候选：跳过无相邻候选的孤立时段，顺序提交相邻一对', async t => {
  const f = fixture(t);
  const run = await f.runner.start([{ ...f.plan, bookingGoal: 'consecutive', times: ['12:00-13:00', '14:00-15:00', '15:00-16:00'] }], 'now');
  assert.equal(run.status, 'success'); assert.equal(f.maxActive(), 1);
  assert.deepEqual(f.books.map(c => c.form.KYYSJD).sort(), ['14:00-15:00', '15:00-16:00']);
});

test('连续目标后段暂满：只重查相邻后段，不发送不相邻的第三段', { timeout: 4000 }, async t => {
  let middleCalls = 0;
  const f = fixture(t, { onBook: async call => {
    if (call.form.KYYSJD === '12:00-13:00') return { code: '0' };
    if (call.form.KYYSJD === '13:00-14:00') return ++middleCalls === 1 ? { code: '1', msg: '已满' } : { code: '0' };
    assert.fail('不相邻的第三段不应发送');
  } });
  const run = await f.runner.start([{ ...f.plan, durationMs: 5000, bookingGoal: 'consecutive', times: [...f.plan.times, '14:00-15:00'] }], 'now');
  assert.equal(run.status, 'success'); assert.equal(f.books.length, 3); assert.equal(f.maxActive(), 1);
  assert.deepEqual(run.successes.map(s => s.time).sort(), f.plan.times);
});

test('传输诊断的派发时间在真正出队时记录，排队不计入学校响应耗时', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const entered = deferred(), release = deferred(), dispatched = [];
  let sends = 0;
  const transport = nativeTransport({ async request() {
    if (++sends === 1) { entered.resolve(); await release.promise; }
    return { status: 200, headers: {}, body: '{}' };
  } });
  const client = new CoreHttpClient({ cookies: [], userAgent: 'test' }, { transport });
  const first = client.post('sportVenue/getRqList.do'); await entered.promise;
  const second = client.post('sportVenue/getRqList.do', {}, { onDispatch: event => dispatched.push(event) });
  assert.equal(dispatched.length, 0, '入队时不误报已经发出');
  t.mock.timers.setTime(NOW + 250); release.resolve(); await first;
  const response = await second;
  assert.deepEqual(dispatched, [{ startedAt: NOW + 250 }]);
  assert.equal(response.queueMs, 250); assert.equal(response.endedAt - response.startedAt, 0);
});

test('后段只在前段响应持久化完成后发送，慢保存不会产生第二个在途请求', { timeout: 3000 }, async t => {
  const saving = deferred(), entered = deferred(); let heldSave = false;
  const f = fixture(t, { onWrite: async state => {
    if (!heldSave && state.runs[0]?.successes.length === 1) { heldSave = true; entered.resolve(); await saving.promise; }
  } });
  const work = f.runner.start([f.plan], 'now'); await entered.promise; await delay(30);
  assert.equal(f.books.length, 1); saving.resolve();
  const run = await work; assert.equal(run.status, 'success'); assert.equal(f.maxActive(), 1);
  assert.ok(f.books[1].startedAt >= f.books[0].endedAt);
});

test('学校明确频率拒绝：账号退避后继续原任务，不当作永久失败或未知订单', { timeout: 3000 }, async t => {
  const f = fixture(t, { rateLimitBackoffMs: 20, onBook: async (_call, n) =>
    n === 1 ? { code: '#E111080000000', msg: '操作过于频繁，请稍后再试！' } : { code: '0' } });
  const run = await f.runner.start([f.plan], 'now');
  assert.equal(run.status, 'success'); assert.equal(run.successes.length, 2); assert.equal(f.books.length, 3);
  assert.equal(f.maxActive(), 1); assert.deepEqual(pendingMobileRequests(run), []);
  assert.ok(f.books[1].startedAt - f.books[0].endedAt >= 10, '已有排队请求也须让出冷却时间');
  assert.deepEqual(f.books.filter(c => c.form.KYYSJD === '12:00-13:00').map(c => c.form.CDWID), ['C6', 'C6']);
});

test('连续频率拒绝：两次恢复仍被拒绝就结束账号自动提交，重复方案不能接着刷', { timeout: 4000 }, async t => {
  const f = fixture(t, { rateLimitBackoffMs: 15, onBook: async () =>
    ({ code: '#E111080000000', msg: '操作过于频繁，请稍后再试！' }) });
  const run = await f.runner.start([f.plan, { ...f.plan, id: 'sibling', times: ['14:00-15:00', '15:00-16:00'] }], 'now');
  assert.equal(f.books.length, 3); assert.equal(f.maxActive(), 1);
  assert.equal(run.status, 'error'); assert.match(run.items[0].error, /连续 3 次频率拒绝/);
  assert.ok(run.items.every(item => /操作过于频繁/.test(item.error)));
  assert.equal(run.successes.length, 0); assert.deepEqual(pendingMobileRequests(run), []);
});

test('连续频率拒绝的退避跨空闲队列递增，成功后重置', async () => {
  let reject = true;
  const transport = nativeTransport({ async request() { return { status: 200, headers: {},
    body: JSON.stringify(reject ? { code: '#E111080000000', msg: '操作过于频繁，请稍后再试！' } : { code: '0' }) }; }
  }, null, 'a', { rateLimitBackoffMs: 15 });
  const url = 'https://ehall.szu.edu.cn/qljfwapp/sys/lwSzuCgyy/sportVenue/insertVenueBookingInfo.do';
  for (const expected of [15, 30, 60]) {
    const response = await transport(url, { method: 'POST', headers: {} });
    assert.equal(response.cooldownMs, expected); await delay(80);
  }
  reject = false; assert.equal((await transport(url, { method: 'POST', headers: {} })).cooldownMs, 0);
  await delay(5); reject = true;
  assert.equal((await transport(url, { method: 'POST', headers: {} })).cooldownMs, 15);
  await delay(20);
});

test('立即捡漏即使有固定场地缓存，也查询实时空位并核对学校订单', async t => {
  const f = fixture(t); cacheCourt(f, [{ ...knownCourt, disabled: true, text: '旧日期已满' }]);
  const run = await f.runner.start([f.plan], 'now');
  assert.equal(run.status, 'success'); assert.equal(f.books.length, 2); assert.equal(f.maxActive(), 1);
  assert.equal(f.calls.filter(c => c.endpoint === 'getOpeningRoom.do').length, 2);
  const check = f.calls.find(c => c.endpoint === 'myBookingInfo.do');
  assert.ok(check.endedAt <= f.books[0].startedAt, '缓存不能绕过当天订单与名额核对');
  assert.ok(f.books.every(c => c.form.CDWID === 'C6' && c.form.CGDM === 'v' && c.form.XMDM === '001' && c.form.XQWID === '1'));
});

for (const field of ['CGBM', 'XMDM', 'XQDM', 'WID']) test(`固定场地缓存 ${field} 不匹配时，回到学校查询，不拼错预约参数`, async t => {
  const f = fixture(t); cacheCourt(f, [{ ...knownCourt, [field]: 'wrong', ...(field === 'WID' ? { CDMC: 'wrong' } : {}) }]);
  const run = await f.runner.start([f.plan], 'now');
  assert.equal(run.status, 'success'); assert.equal(f.calls.filter(c => c.endpoint === 'getOpeningRoom.do').length, 2);
  assert.ok(f.books.every(c => c.form.CDWID === 'C6' && c.form.CGDM === 'v'));
});

test('同名缓存不唯一时仍查询学校；允许其余场地时不把缓存截成一个场地', async t => {
  const f = fixture(t, { onBook: async call => call.form.CDWID === 'C6' ? { code: '1', msg: '已满' } : { code: '0' } });
  cacheCourt(f, [knownCourt, { ...knownCourt, WID: 'other-id' }]);
  const run = await f.runner.start([{ ...f.plan, bookingGoal: 'one', times: [f.plan.times[0]], includeOtherCourts: true }], 'now');
  assert.equal(run.status, 'success'); assert.equal(f.calls.filter(c => c.endpoint === 'getOpeningRoom.do').length, 1);
  assert.deepEqual(f.books.map(c => c.form.CDWID), ['C6', 'C4']);
});

test('名称匹配两个缓存场地时不直接拼表单，而是重新查询消除歧义', async t => {
  const f = fixture(t); cacheCourt(f, [knownCourt, { ...knownCourt, WID: 'same-name-another-id' }]);
  const run = await f.runner.start([f.plan], 'now');
  assert.equal(run.status, 'success'); assert.equal(f.calls.filter(c => c.endpoint === 'getOpeningRoom.do').length, 2);
});

test('原生拆分耗时进入预约诊断，额外原生字段不进入导出', async t => {
  const f = fixture(t), request = f.device.request.bind(f.device);
  f.device.request = async input => ({ ...await request(input), timing: { nativeQueueMs: 7, dispatchPreparationMs: 11,
    networkDurationMs: 31, networkStartedAt: NOW + 18, networkEndedAt: NOW + 49, privateNativeExtra: '不要导出' } });
  const run = await f.runner.start([f.plan], 'now');
  const responses = run.logs.filter(e => e.details?.event === 'booking_response');
  assert.equal(responses.length, 2);
  for (const entry of responses) {
    assert.equal(entry.details.nativeQueueMs, 7); assert.equal(entry.details.dispatchPreparationMs, 11);
    assert.equal(entry.details.networkDurationMs, 31); assert.equal(entry.details.privateNativeExtra, undefined);
  }
});

test('固定场地缓存不能绕过学校已用名额，已有一段只新增一段', async t => {
  const f = fixture(t, { rows: [{ YYSJD: '2026-10-15 10:00~2026-10-15 11:00', YYZT: 'CG_YY', XMDM: '001', CDWID: 'C6', CDWID_DISPLAY: 'C6' }] });
  cacheCourt(f); const run = await f.runner.start([f.plan], 'now');
  assert.equal(f.books.length, 1); assert.equal(run.successes.length, 1); assert.equal(run.items[0].limited, true);
  assert.ok(f.calls.some(c => c.endpoint === 'getOpeningRoom.do'));
});

test('固定场地先查目标日期再准备两段：到点不补查、不补写意图，正式请求仍串行', async t => {
  const releaseAt = Date.parse('2026-10-14T12:30:00+08:00'); let prepared;
  const f = fixture(t, { onWrite: state => {
    const intents = Object.values(state.runs[0]?.pendingRequests ?? {});
    if (!prepared && Date.now() < releaseAt && intents.length === 2) {
      prepared = intents.map(r => r.requestId); t.mock.timers.setTime(releaseAt + 1);
    }
  } });
  cacheCourt(f); t.mock.timers.setTime(releaseAt - 10000);
  const run = await f.runner.start([f.plan], 'release');
  assert.equal(run.status, 'success'); assert.equal(f.maxActive(), 1);
  const queries = f.calls.filter(c => c.endpoint === 'getOpeningRoom.do');
  assert.equal(queries.length, 2); assert.ok(queries.every(c => c.at < releaseAt));
  assert.deepEqual(f.books.map(c => c.requestId).sort(), prepared.sort());
});

for (const unavailable of [false, true]) test(`手机倒计时：历史有场地，目标时段${unavailable ? '明确不可用' : '不存在'}时零预约请求`, async t => {
  const releaseAt = Date.parse('2026-10-14T12:30:00+08:00'); let queries = 0;
  const f = fixture(t, { onRooms: call => {
    assert.equal(call.form.YYRQ, '2026-10-15'); assert.equal(call.form.KSSJ, '12:00');
    if (++queries === 1) t.mock.timers.setTime(releaseAt + 1);
    if (queries >= 3) t.mock.timers.setTime(releaseAt + 1001);
    return unavailable ? [{ ...knownCourt, disabled: true }] : [{ ...knownCourt, WID: 'other', CDMC: 'other' }];
  } });
  cacheCourt(f); t.mock.timers.setTime(releaseAt - 10000);
  const run = await f.runner.start([{ ...f.plan, times: ['12:00-13:00'], bookingGoal: 'one' }], 'release');
  assert.ok(queries >= 2); assert.equal(f.books.length, 0); assert.equal(run.successes.length, 0);
  assert.deepEqual(pendingMobileRequests(run), []);
});

for (const includeOtherCourts of [false, true]) test(`倒计时多场地先核对目标时段，缓存反序和旧满员不影响首选；允许其余=${includeOtherCourts}`, async t => {
  const f = countdownFixture(t);
  cacheCourt(f, ['C4', 'C6'].map(id => ({ ...knownCourt, WID: id, CDMC: id, disabled: true, text: '旧日期已满' })));
  const run = await f.runner.start([{ ...f.plan, courts: ['C6', 'C4'], includeOtherCourts, durationMs: 10000 }], 'release');
  assert.equal(run.status, 'success'); assert.equal(f.maxActive(), 1);
  const queries = f.calls.filter(c => c.endpoint === 'getOpeningRoom.do');
  assert.equal(queries.length, 2); assert.ok(queries.every(c => c.at < f.releaseAt));
  assert.deepEqual(f.books.map(c => [c.form.KYYSJD, c.form.CDWID]), [['12:00-13:00', 'C6'], ['13:00-14:00', 'C6']]);
  assert.ok(f.books.every(c => c.at >= f.releaseAt && c.deadlineMs === run.items[0].releaseAt + 2000));
  assert.ok(f.books[1].startedAt >= f.books[0].endedAt);
  assert.deepEqual(f.books.map(c => c.requestId), f.prepared().map(r => r.requestId), '两段复用放号前已落盘的对应意图');
  assert.deepEqual(pendingMobileRequests(run), []);
});

test('缓存首选已满后先查空位再换场，同场后段动态改为成功场地并重写意图', async t => {
  const f = countdownFixture(t, { onBook: async call => call.form.CDWID === 'C6'
    ? { code: '1', msg: '已满' } : { code: '0' } });
  cacheCourt(f, ['C4', 'C6'].map(id => ({ ...knownCourt, WID: id, CDMC: id })));
  const run = await f.runner.start([{ ...f.plan, courts: ['C6', 'C4'], preferSameCourt: true }], 'release');
  assert.equal(run.status, 'success'); assert.equal(f.maxActive(), 1);
  assert.deepEqual(f.books.map(c => [c.form.KYYSJD, c.form.CDWID]), [
    ['12:00-13:00', 'C6'], ['12:00-13:00', 'C4'], ['13:00-14:00', 'C4'],
  ]);
  const relevant = f.calls.filter(c => c.at >= f.releaseAt && ['getOpeningRoom.do', 'insertVenueBookingInfo.do'].includes(c.endpoint));
  assert.deepEqual(relevant.map(c => c.endpoint), [
    'insertVenueBookingInfo.do', 'getOpeningRoom.do', 'insertVenueBookingInfo.do', 'insertVenueBookingInfo.do',
  ], '已核对的首选只直提一次；重新查询仍列出 C6 时也不立即重复已经失败的请求');
  assert.equal(relevant[1].form.KSSJ, '12:00', '只重查失败时段，后段仍可用缓存选择同场');
  const original = f.prepared().find(r => r.time === '13:00-14:00'), second = f.books.at(-1);
  assert.equal(original.courtId, 'C6'); assert.notEqual(second.requestId, original.requestId);
  const snapshot = f.snapshots.find(state => state.runs[0].pendingRequests[second.requestId]);
  assert.equal(snapshot.runs[0].pendingRequests[second.requestId].courtId, second.form.CDWID);
  assert.deepEqual(pendingMobileRequests(run), []);
});

for (const invalid of ['incomplete', 'ambiguous']) test(`倒计时多场地缓存${invalid}时先查询，不跳过未知首选或猜同名场地`, async t => {
  const f = countdownFixture(t);
  const courts = invalid === 'incomplete' ? ['C6', 'C4'] : ['同名首选', 'C4'];
  cacheCourt(f, invalid === 'incomplete'
    ? [knownCourt]
    : [{ ...knownCourt, CDMC: '同名首选' }, { ...knownCourt, WID: 'other-C6', CDMC: '同名首选' },
      { ...knownCourt, WID: 'C4', CDMC: 'C4' }]);
  const run = await f.runner.start([{ ...f.plan, courts }], 'release');
  assert.equal(run.status, 'success'); assert.equal(f.maxActive(), 1);
  const queries = f.calls.filter(c => c.endpoint === 'getOpeningRoom.do');
  assert.equal(queries.length, 2);
  assert.ok(f.calls.indexOf(queries[0]) < f.calls.indexOf(f.books[0]), '失效缓存不能直接拼预约表单');
  assert.ok(queries.every(c => c.at < f.releaseAt), '有准备时间时提前查询，而非等到放号才发现缓存不可用');
  assert.ok(f.books.every(c => c.form.CDWID === (invalid === 'incomplete' ? 'C6' : 'C4')));
});

test('允许其他场地的首段回退到未缓存场地后，后段先查目录保持同场偏好', async t => {
  const f = countdownFixture(t, { onBook: async call => call.form.CDWID === 'C2'
    ? { code: '0' } : { code: '1', msg: '已满' },
  onRooms: call => (call.at < f.releaseAt && call.form.KSSJ === '13:00' ? ['C6', 'C4'] : ['C6', 'C4', 'C2'])
    .map(id => ({ ...knownCourt, WID: id, CDMC: id })) });
  cacheCourt(f, ['C6', 'C4'].map(id => ({ ...knownCourt, WID: id, CDMC: id })));
  const run = await f.runner.start([{ ...f.plan, courts: ['C6', 'C4'], includeOtherCourts: true, preferSameCourt: true }], 'release');
  assert.equal(run.status, 'success'); assert.equal(f.maxActive(), 1);
  assert.deepEqual(f.books.map(c => [c.form.KYYSJD, c.form.CDWID]), [
    ['12:00-13:00', 'C6'], ['12:00-13:00', 'C4'], ['12:00-13:00', 'C2'], ['13:00-14:00', 'C2'],
  ]);
  assert.deepEqual(f.calls.filter(c => c.at >= f.releaseAt && c.endpoint === 'getOpeningRoom.do').map(c => c.form.KSSJ), ['12:00', '13:00']);
  const secondQuery = f.calls.find(c => c.at >= f.releaseAt && c.endpoint === 'getOpeningRoom.do' && c.form.KSSJ === '13:00');
  assert.ok(f.calls.indexOf(secondQuery) > f.calls.indexOf(f.books[2]));
  assert.ok(f.calls.indexOf(secondQuery) < f.calls.indexOf(f.books[3]), '未缓存的同场优先于原配置第一项');
  assert.deepEqual(pendingMobileRequests(run), []);
});

test('倒计时多场地缓存遇到过频先退避再查询，保留原首选且不盲扫备选', { timeout: 3000 }, async t => {
  const f = countdownFixture(t, { rateLimitBackoffMs: 20, onBook: async (_call, n) => n === 1
    ? { code: '#E111080000000', msg: '操作过于频繁，请稍后再试！' } : { code: '0' } });
  cacheCourt(f, ['C6', 'C4'].map(id => ({ ...knownCourt, WID: id, CDMC: id })));
  const run = await f.runner.start([{ ...f.plan, courts: ['C6', 'C4'] }], 'release');
  assert.equal(run.status, 'success'); assert.equal(f.maxActive(), 1);
  assert.deepEqual(f.books.map(c => [c.form.KYYSJD, c.form.CDWID]), [
    ['12:00-13:00', 'C6'], ['12:00-13:00', 'C6'], ['13:00-14:00', 'C6'],
  ]);
  const queries = f.calls.filter(c => c.at >= f.releaseAt && c.endpoint === 'getOpeningRoom.do');
  assert.equal(queries.length, 1);
  assert.ok(queries[0].startedAt - f.books[0].endedAt >= 10, '实时刷新也不能抢在账号冷却结束前发送');
  assert.deepEqual(pendingMobileRequests(run), []);
});

test('倒计时多场地缓存首单响应未知时保留唯一待核对请求，不查空位或发送备选', async t => {
  const f = countdownFixture(t, { onBook: async () => { throw new Error('已发送，响应连接中断'); } });
  cacheCourt(f, ['C6', 'C4'].map(id => ({ ...knownCourt, WID: id, CDMC: id })));
  const run = await f.runner.start([{ ...f.plan, courts: ['C6', 'C4'] }], 'release');
  assert.equal(run.status, 'error'); assert.equal(f.books.length, 1); assert.equal(f.books[0].form.CDWID, 'C6');
  assert.equal(f.calls.filter(c => c.at >= f.releaseAt && c.endpoint === 'getOpeningRoom.do').length, 0);
  assert.equal(run.items[0].metrics.unknown, 1);
  assert.equal(pendingMobileRequests(run).length, 1);
  assert.equal(pendingMobileRequests(run)[0].courtId, 'C6');
});

for (const vacancy of [true, false]) test(`固定缓存首段响应跨过快速窗口：第二段重新查询，空位=${vacancy}`, { timeout: 4000 }, async t => {
  const releaseAt = Date.parse('2026-10-14T12:30:00+08:00'); let prepared = false;
  const f = fixture(t, { onWrite: state => {
    if (!prepared && Date.now() < releaseAt && Object.keys(state.runs[0]?.pendingRequests ?? {}).length === 2) {
      prepared = true; t.mock.timers.setTime(releaseAt + 1);
    }
  }, onBook: async (_call, n) => {
    if (n === 1) t.mock.timers.setTime(releaseAt + 2500);
    return { code: '0' };
  }, onRooms: call => {
    if (Date.now() < releaseAt) return [knownCourt];
    assert.equal(call.form.KSSJ, '13:00', '首段在途成功保留，只重读第二段');
    if (!vacancy) f.runner.stop();
    return [{ ...knownCourt, disabled: !vacancy }];
  } });
  cacheCourt(f); t.mock.timers.setTime(releaseAt - 10000);
  const run = await f.runner.start([{ ...f.plan, durationMs: 10000 }], 'release');
  assert.equal(f.calls.filter(call => call.at >= releaseAt && call.endpoint === 'getOpeningRoom.do').length, 1);
  assert.equal(f.books.length, vacancy ? 2 : 1); assert.equal(run.successes.length, vacancy ? 2 : 1);
  assert.equal(f.books[0].deadlineMs, run.items[0].releaseAt + 2000, '校时后的快速窗口截止传递到原生实际派发');
  if (vacancy) assert.equal(f.books[1].deadlineMs, run.items[0].deadline, '查询过的空位使用正常执行窗口');
  assert.equal(run.status, vacancy ? 'success' : 'stopped');
  assert.deepEqual(pendingMobileRequests(run), []);
});

test('固定缓存在原生队列中跨过快速窗口：明确未发送，回查空位后继续', { timeout: 4000 }, async t => {
  const releaseAt = Date.parse('2026-10-14T12:30:00+08:00'); let preparedId, expired = false, deferredId;
  const f = fixture(t, { onWrite: state => {
    const intents = Object.values(state.runs[0]?.pendingRequests ?? {});
    if (!preparedId && Date.now() < releaseAt && intents.length === 1) {
      preparedId = intents[0].requestId; t.mock.timers.setTime(releaseAt + 1);
    }
  }, beforeNativeDispatch: input => {
    if (!expired && input.url.endsWith('insertVenueBookingInfo.do')) {
      expired = true; deferredId = input.requestId;
      assert.equal(input.deadlineMs, f.runner.current.items[0].releaseAt + 2000);
      t.mock.timers.setTime(input.deadlineMs);
      throw new RequestNotSentError('原生队列等待后已超过派发截止时间，未发送');
    }
  } });
  cacheCourt(f); t.mock.timers.setTime(releaseAt - 10000);
  const run = await f.runner.start([{ ...f.plan, times: [f.plan.times[0]], bookingGoal: 'one', durationMs: 10000 }], 'release');
  assert.equal(run.status, 'success', JSON.stringify(run)); assert.equal(f.books.length, 1);
  assert.equal(deferredId, preparedId); assert.notEqual(f.books[0].requestId, deferredId);
  assert.equal(f.calls.filter(call => call.at >= releaseAt && call.endpoint === 'getOpeningRoom.do').length, 1);
  assert.equal(run.items[0].metrics.unknown, 0); assert.deepEqual(pendingMobileRequests(run), []);
  assert.equal(Object.keys(f.snapshots.at(-1).runs[0].pendingRequests).length, 0);
});

test('快速窗口内已发送但跨窗口后响应丢失：保留未知订单，不能重发', { timeout: 4000 }, async t => {
  const releaseAt = Date.parse('2026-10-14T12:30:00+08:00'); let prepared = false;
  const f = fixture(t, { onWrite: state => {
    if (!prepared && Date.now() < releaseAt && Object.keys(state.runs[0]?.pendingRequests ?? {}).length === 1) {
      prepared = true; t.mock.timers.setTime(releaseAt + 1);
    }
  }, onBook: async () => {
    t.mock.timers.setTime(releaseAt + 2500); throw new Error('已经发送，响应连接中断');
  } });
  cacheCourt(f); t.mock.timers.setTime(releaseAt - 10000);
  const run = await f.runner.start([{ ...f.plan, times: [f.plan.times[0]], bookingGoal: 'one', durationMs: 10000 }], 'release');
  assert.equal(f.books.length, 1); assert.equal(run.items[0].metrics.unknown, 1);
  assert.equal(pendingMobileRequests(run).length, 1); assert.equal(run.status, 'error');
  assert.equal(f.calls.filter(call => call.at >= releaseAt && call.endpoint === 'getOpeningRoom.do').length, 0, '未知提交不进入空位重试');
});

for (const firstCourtFull of [false, true]) test(`多场地同场偏好：两段意图提前准备，首选已满=${firstCourtFull} 时仍绑定正确场地`, async t => {
  const releaseAt = Date.parse('2026-10-14T12:30:00+08:00'); let prepared;
  const f = fixture(t, { onWrite: state => {
    const intents = Object.values(state.runs[0]?.pendingRequests ?? {});
    if (!prepared && Date.now() < releaseAt && intents.length === 2) {
      prepared = intents.map(r => ({ id: r.requestId, time: r.time })); t.mock.timers.setTime(releaseAt + 1);
    }
  }, onBook: async call => firstCourtFull && call.form.CDWID === 'C6' ? { code: '1', msg: '已满' } : { code: '0' } });
  t.mock.timers.setTime(releaseAt - 10000);
  const run = await f.runner.start([{ ...f.plan, preferSameCourt: true, courts: ['C6', 'C4'] }], 'release');
  assert.equal(run.status, 'success'); assert.equal(f.maxActive(), 1);
  assert.ok(run.successes.every(s => s.court === (firstCourtFull ? 'C4' : 'C6')));
  assert.deepEqual(pendingMobileRequests(run), []);
  const last = f.books.at(-1), original = prepared.find(p => p.time === '13:00-14:00');
  if (firstCourtFull) assert.notEqual(last.requestId, original.id, '首段换场后不沿用次段的旧场地意图');
  else assert.equal(last.requestId, original.id, '首选成功时第二段无需新写意图');
});

test('首选时段满员后继续其他候选，成功两段即停', { timeout: 3000 }, async t => {
  const f = fixture(t, { onBook: async call => ({ code: call.form.KYYSJD === '12:00-13:00' ? '1' : '0', msg: '已满' }) });
  const run = await f.runner.start([{ ...f.plan, times: [...f.plan.times, '14:00-15:00', '15:00-16:00'] }], 'now');
  assert.equal(run.status, 'success'); assert.equal(f.books.length, 3); assert.equal(f.maxActive(), 1);
  assert.deepEqual(run.successes.map(s => s.time), ['13:00-14:00', '14:00-15:00']);
});

test('首段可订时，后段慢目录不得拖住第一单', { timeout: 3000 }, async t => {
  const secondQuery = deferred(), release = deferred();
  const f = fixture(t, { onRooms: async call => {
    if (call.form.KSSJ === '13:00') { secondQuery.resolve(); await release.promise; }
    return [knownCourt];
  } });
  const work = f.runner.start([f.plan], 'now'); await secondQuery.promise;
  assert.equal(f.books.length, 1, '后段查询进入等待时，首单应已经发送并保存');
  assert.equal(f.snapshots.at(-1).runs[0].successes.length, 1);
  release.resolve(); assert.equal((await work).status, 'success');
});
