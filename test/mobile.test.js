import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ForegroundExecution, validatePlan } from '../mobile/src/execution.js';
import { MobileStore, pendingMobileRequests, reviewedMobileRuns } from '../mobile/src/store.js';
import { CoreHttpClient } from '../shared/http-client-core.js';
import { shanghaiDate, addDays } from '../shared/utils.js';
import { reviewBookings } from '../shared/booking-review.js';
import { nativeTransport } from '../mobile/src/device.js';
import { createConnection, readCatalog } from '../mobile/src/school.js';
import { RequestNotSentError } from '../shared/errors.js';
beforeEach((t) => t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-01T13:00:00+08:00') }));
const metadata = { campusList: [{ XQDM: '1', XQDM_DISPLAY: '粤海校区' }],
  xmList: [{ XQDM: '1', XMDM: '001', XMMC: '羽毛球', DCFS: '1.0' }],
  packageVenueList: [{ SSXQ: '1', XM: '001', CGBM: 'v', CGMC: '运动广场东馆羽毛球场' }] };
test('手机方案、账号或日志写入失败时恢复原数据；恢复写入后可正常重试', async () => {
  let fail = true, saved;
  const store = new MobileStore({ async writeState({ value }) {
    if (fail) throw new Error('磁盘已满'); saved = JSON.parse(value);
  } });
  store.state.plans = [{ id: 'original' }];
  store.state.accounts = [{ id: 'account' }];
  store.state.runs = [{ id: 'result' }];
  const original = store.state;
  for (const key of ['plans', 'accounts', 'runs']) {
    await assert.rejects(store.update({ [key]: [] }), /磁盘已满/);
    assert.equal(store.state, original);
    assert.equal(store.state[key].length, 1);
  }
  fail = false;
  await store.update({ plans: [...store.state.plans, { id: 'new' }] });
  assert.deepEqual(saved.plans.map((p) => p.id), ['original', 'new']);
  assert.equal(store.state.accounts, original.accounts, '未修改的账号引用应保留，避免丢失正在更新的 Cookie');
});
test('编辑失败期间的目录保存不能把未保存的方案写回磁盘', async () => {
  let entered, rejectEdit, saved, writes = 0;
  const writing = new Promise((resolve) => entered = resolve);
  const store = new MobileStore({ async writeState({ value }) {
    if (++writes === 1) { entered(); await new Promise((_, reject) => rejectEdit = reject); }
    saved = JSON.parse(value);
  } });
  store.state.plans = [{ id: 'original' }];
  const edit = store.update({ plans: [{ id: 'uncommitted' }] });
  const rejected = assert.rejects(edit, /磁盘已满/);
  await writing;
  store.state.catalogs.latest = { date: '2026-10-01' };
  const catalogSave = store.save();
  await assert.rejects(store.update({ plans: [] }), /正在保存/);
  rejectEdit(new Error('磁盘已满')); await rejected; await catalogSave;
  assert.deepEqual(saved.plans, [{ id: 'original' }]);
  assert.equal(saved.catalogs.latest.date, '2026-10-01');
  assert.equal(store.state.plans[0].id, 'original');
});
function fixture() {
  let saved; const armed = [];
  const device = { async readState() { return { value: saved }; }, async writeState({ value }) { saved = value; },
    async setExecution(value) { armed.push(value.enabled); } };
  const store = new MobileStore(device);
  store.state.accounts = [{ id: 'a', name: '我', userId: 'A' }, { id: 'b', name: '舍友', userId: 'B' }];
  const calls = [];
  const createApi = async (account) => ({ client: { async flush() {} }, api: {
    async getAllBookings() { return []; },
    async getIdentity() { return { id: account.userId, name: account.name }; },
    async getSportVenueData() { return metadata; }, async sampleServerOffset() { return 0; },
    async getOpeningRooms() { return [{ WID: 'court', CDMC: '1号场', CGBM: 'v', XMDM: '001', XQDM: '1' }]; },
    async book({ time }) { calls.push([account.id, time]); return { code: '0', data: { DHID: 'order' } }; },
  } });
  const plan = { id: 'p', name: '羽毛球', project: 'badminton', accountId: 'a', date: shanghaiDate(),
    times: ['15:00-16:00', '16:00-17:00'], courts: ['court'], intervalMs: 250, durationMs: 1000, preferSameCourt: true };
  const runner = new ForegroundExecution({ store, device, createApi });
  return { runner, device, store, plan, calls, armed, createApi, saved: () => JSON.parse(saved) };
}
test('新建方案可留空名称，保存时生成可识别的默认名称', () => {
  const { plan } = fixture();
  const saved = validatePlan({ ...plan, name: '  ' });
  assert.equal(saved.name, `${plan.date} 羽毛球 ${plan.times[0]}`);
  assert.equal(plan.name, '羽毛球');
});
test('手机多账号前台执行：各账号同时发单、成功落盘、结束释放亮屏', async () => {
  const f = fixture(); let inFlight = 0, max = 0;
  f.runner.createApi = async (...args) => { const c = await f.createApi(...args); const original = c.api.book;
    c.api.book = async (input) => { max = Math.max(max, ++inFlight); await new Promise((r) => setTimeout(r, 5));
      const response = await original(input); inFlight--; return response; }; return c; };
  const result = await f.runner.start([f.plan, { ...f.plan, id: 'p2', accountId: 'b' }], 'now');
  assert.equal(result.status, 'success', JSON.stringify(result)); assert.equal(result.successes.length, 4); assert.equal(max, 2);
  assert.equal(f.saved().runs[0].successes.length, 4); assert.equal(f.saved().runs[0].inFlight, undefined);
  assert.deepEqual(f.saved().runs[0].pendingRequests, {});
  assert.deepEqual(f.armed, [true, false]); assert.ok(f.calls.some(([id]) => id === 'b'));
});
test('账号 A 的预约响应未返回时，账号 B 仍完成两个时段', { timeout: 3000 }, async () => {
  const f = fixture(); let releaseA, enteredA, completedB;
  const waitingA = new Promise((resolve) => enteredA = resolve);
  const bookedB = new Promise((resolve) => completedB = resolve);
  f.runner.createApi = async (account) => {
    const c = await f.createApi(account), book = c.api.book;
    c.api.book = async (input) => {
      if (account.id === 'a' && input.time === f.plan.times[0]) {
        enteredA(); await new Promise((resolve) => releaseA = resolve);
      }
      const response = await book(input);
      if (account.id === 'b' && input.time === f.plan.times[1]) completedB();
      return response;
    };
    return c;
  };
  const work = f.runner.start([f.plan, { ...f.plan, id: 'other', accountId: 'b' }], 'now');
  await waitingA; await bookedB;
  assert.equal(f.calls.filter(([account]) => account === 'a').length, 0);
  assert.equal(f.calls.filter(([account]) => account === 'b').length, 2);
  releaseA(); const run = await work;
  assert.equal(run.status, 'success');
});
function withVolleyball(c) {
  c.api.getSportVenueData = async () => ({ ...metadata,
    xmList: [...metadata.xmList, { XQDM: '1', XMDM: '002', XMMC: '排球', DCFS: '1.0' }],
    packageVenueList: [...metadata.packageVenueList, { SSXQ: '1', XM: '002', CGBM: 'vv', CGMC: '西馆排球场（包场）' }] });
  c.api.getOpeningRooms = async ({ sportCode, venueCode }) => [{ WID: 'court', CDMC: '1号场', CGBM: venueCode, XMDM: sportCode }];
  return c;
}
test('同一真实账号的不同体育项目也不能并行提交', async () => {
  const f = fixture(); let active = 0, max = 0;
  f.runner.createApi = async (account) => {
    const c = withVolleyball(await f.createApi(account)), book = c.api.book;
    c.api.book = async (input) => {
      max = Math.max(max, ++active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      const response = await book(input); active--; return response;
    };
    return c;
  };
  const run = await f.runner.start([f.plan, { ...f.plan, id: 'volley', project: 'volleyball' }], 'now');
  assert.equal(run.status, 'success'); assert.equal(f.calls.length, 4); assert.equal(max, 1);
});
test('账号 A 的未知响应停止其不同项目与后续时段，账号 B 继续成功', async () => {
  const f = fixture(); let aCalls = 0;
  f.runner.createApi = async (account) => {
    const c = withVolleyball(await f.createApi(account));
    if (account.id === 'a') c.api.book = async () => { aCalls++; throw new Error('响应断开'); };
    return c;
  };
  const run = await f.runner.start([f.plan, { ...f.plan, id: 'volley', project: 'volleyball' },
    { ...f.plan, id: 'other', accountId: 'b' }], 'now');
  assert.equal(aCalls, 1); assert.equal(f.calls.length, 2);
  assert.deepEqual(run.items.map((item) => item.status), ['error', 'error', 'success']);
  assert.equal(run.status, 'partial'); assert.match(run.error, /待确认/);
  assert.equal(pendingMobileRequests(f.saved().runs[0]).length, 1);
  assert.equal(pendingMobileRequests(f.saved().runs[0])[0].accountId, 'a');
});
test('两账号同时在途的意图完整落盘；恢复和一成一败后都保留正确记录', { timeout: 3000 }, async () => {
  const f = fixture(); let bothEntered, release;
  const both = new Promise((resolve) => bothEntered = resolve), gate = new Promise((resolve) => release = resolve);
  let entered = 0;
  f.runner.createApi = async (account) => {
    const c = await f.createApi(account), book = c.api.book;
    c.api.book = async (input) => {
      assert.ok(Object.values(f.saved().runs[0].pendingRequests).some((record) => record.accountId === account.id), '发单前自己的意图必须已落盘');
      if (++entered === 2) bothEntered();
      await gate;
      if (account.id === 'b') throw new Error('响应丢失');
      return book(input);
    };
    return c;
  };
  const one = { ...f.plan, times: [f.plan.times[0]], bookingGoal: 'one' };
  const work = f.runner.start([one, { ...one, id: 'other', accountId: 'b' }], 'now');
  await both;
  const before = f.saved();
  assert.deepEqual(Object.values(before.runs[0].pendingRequests).map((record) => record.accountId).sort(), ['a', 'b']);
  let recovered;
  const restored = new MobileStore({ async readState() { return { value: JSON.stringify(before) }; },
    async writeState({ value }) { recovered = JSON.parse(value); } });
  await restored.load();
  assert.equal(recovered.runs[0].status, 'interrupted'); assert.equal(pendingMobileRequests(recovered.runs[0]).length, 2);
  release(); const run = await work;
  assert.equal(run.successes.length, 1); assert.equal(run.successes[0].accountId, 'a');
  assert.equal(pendingMobileRequests(run).length, 1); assert.equal(run.inFlight.accountId, 'b');
  assert.equal(pendingMobileRequests(f.saved().runs[0])[0].state, 'unknown');
});
test('一个账号登录失效，不阻止其他账号的方案执行', async () => {
  const f = fixture();
  f.runner.createApi = async (account) => {
    const connection = await f.createApi(account);
    if (account.id === 'b') connection.api.getIdentity = async () => { throw new Error('B 登录失效'); };
    return connection;
  };
  const run = await f.runner.start([f.plan, { ...f.plan, id: 'p2', accountId: 'b' }], 'now');
  assert.equal(f.calls.length, 2);
  assert.deepEqual(run.items.map((item) => item.status), ['success', 'error']);
  assert.equal(run.status, 'partial');
});
test('慢账号仍在预检时，正常账号已经提交；同账号多个方案只预检一次', { timeout: 3000 }, async (t) => {
  t.mock.timers.setTime(Date.parse('2026-09-30T13:00:00+08:00'));
  const f = fixture(); let release, entered, booked, checks = 0;
  const waiting = new Promise((r) => entered = r), sent = new Promise((r) => booked = r);
  f.runner.createApi = async (account) => {
    const c = await f.createApi(account), identity = c.api.getIdentity, book = c.api.book;
    c.api.getIdentity = async () => {
      if (account.id === 'b') { entered(); await new Promise((r) => release = r); }
      else checks++;
      return identity();
    };
    c.api.book = async (input) => { const response = await book(input); booked(); return response; };
    return c;
  };
  const plans = [f.plan, { ...f.plan, id: 'same', times: [f.plan.times[0]], bookingGoal: 'one' }, { ...f.plan, id: 'slow', accountId: 'b' }];
  const work = f.runner.start(plans, 'now');
  await waiting; await sent;
  assert.ok(f.calls.some(([id]) => id === 'a')); assert.ok(!f.calls.some(([id]) => id === 'b'));
  assert.equal(checks, 1);
  release(); const run = await work;
  assert.equal(run.status, 'success'); assert.equal(f.calls.length, 4);
});
test('批次中一个方案错过放号窗口，其他已开放方案继续执行', async (t) => {
  const confirmedAt = Date.parse('2026-09-27T12:29:59+08:00');
  t.mock.timers.setTime(Date.parse('2026-09-27T12:30:02+08:00'));
  const f = fixture(); f.plan.date = shanghaiDate();
  const missed = { ...f.plan, id: 'missed', accountId: 'b', date: addDays(shanghaiDate(), 1) };
  const run = await f.runner.start([f.plan, missed], 'auto', { confirmedAt });
  assert.equal(run.status, 'partial');
  assert.deepEqual(run.items.map((item) => item.status), ['success', 'error']);
  assert.match(run.items[1].error, /错过本次执行窗口/);
  assert.deepEqual(f.calls.map(([account]) => account), ['a', 'a']);
});
test('手机切后台：不再发后续请求；在途成功仍保存；重开不自动继续', async () => {
  const f = fixture();
  f.runner.createApi = async (...args) => { const c = await f.createApi(...args); const original = c.api.book;
    c.api.book = async (input) => { f.runner.stop('background'); return original(input); }; return c; };
  await f.runner.start([f.plan], 'now');
  assert.equal(f.calls.length, 1); assert.equal(f.saved().runs[0].status, 'interrupted');
  assert.equal(f.saved().runs[0].successes.length, 1);
  const restored = new MobileStore(f.device); await restored.load(); assert.equal(f.calls.length, 1);
});
test('手机进程被杀恢复为中断，不丢成功和未知请求', async () => {
  const f = fixture(); f.store.state.runs.push({ id: 'crashed', status: 'booking', successes: [{ time: '15:00-16:00' }], inFlight: { time: '16:00-17:00' },
    items: [{ id: 'done', status: 'success' }, { id: 'pending', status: 'booking' }] });
  await f.store.save(); const restored = new MobileStore(f.device); await restored.load();
  assert.equal(restored.state.runs[0].status, 'interrupted'); assert.equal(restored.state.runs[0].successes.length, 1);
  assert.ok(restored.state.runs[0].inFlight); assert.equal(f.calls.length, 0);
  assert.deepEqual(restored.state.runs[0].items.map((item) => item.status), ['success', 'interrupted']);
});
test('手机仅部分时段成功，方案和批次均显示部分成功', async (t) => {
  t.mock.timers.setTime(Date.now());
  const f = fixture();
  f.runner.createApi = async (...args) => { const c = await f.createApi(...args);
    c.api.book = async ({ time }) => {
      if (time === f.plan.times[0]) return { code: '0' };
      t.mock.timers.tick(1100); return { code: '1', msg: '无空位' };
    }; return c; };
  const run = await f.runner.start([f.plan], 'now');
  assert.equal(run.status, 'partial'); assert.equal(run.items[0].status, 'partial');
  assert.equal(f.saved().runs[0].successes.length, 1);
});
test('手机请求结果未知：停止该账号，不盲目重试', async () => {
  const f = fixture(); let calls = 0;
  f.runner.createApi = async (...args) => { const c = await f.createApi(...args); c.api.book = async () => { calls++; throw new Error('timeout'); }; return c; };
  const run = await f.runner.start([f.plan], 'now');
  assert.equal(calls, 1); assert.match(run.error, /待确认/); assert.ok(f.saved().runs[0].inFlight);
});
test('共用网络层携带独立Cookie并保存响应更新', async () => {
  let sent, saved;
  const session = { userAgent: 'test', cookies: [{ name: '_WEU', value: 'A', domain: 'ehall.szu.edu.cn', path: '/qljfwapp/' }] };
  const client = new CoreHttpClient(session, { transport: async (url, options) => { sent = options.headers.cookie;
    return { status: 200, ok: true, headers: { get: () => null, getSetCookie: () => ['_WEU=B; Path=/qljfwapp/; Domain=ehall.szu.edu.cn'] }, text: async () => '{"ok":true}' }; }, save: async (value) => { saved = structuredClone(value); } });
  await client.post('test', {}); await client.flush(); assert.equal(sent, '_WEU=A'); assert.equal(saved.cookies[0].value, 'B');
});
test('手机允许0.1秒间隔，同账号多个方案合计两个时段即完成', async () => {
  const f = fixture(); f.plan.intervalMs = 100; validatePlan(f.plan);
  const result = await f.runner.start([f.plan, { ...f.plan, id: 'p2', times: ['17:00-18:00', '18:00-19:00'] }], 'now');
  assert.equal(result.status, 'partial'); assert.equal(f.calls.length, 2);
  assert.equal(result.successes.length, 2); assert.ok(result.items.some((i) => i.limited));
});

test('前置网络失败结束所有方案状态，不残留准备中，也不提交预约', async () => {
  const f = fixture();
  f.runner.createApi = async () => { throw new Error('学校接口网络请求失败'); };
  const run = await f.runner.start([f.plan], 'now');
  assert.equal(run.status, 'error'); assert.equal(run.items[0].status, 'error');
  assert.match(run.items[0].error, /网络/); assert.equal(f.calls.length, 0);
});
test('用户停止立即撤销原生执行令牌，前置请求结束后不再预约', async () => {
  const f = fixture(); let release, entered;
  const waiting = new Promise((r) => entered = r);
  f.runner.createApi = async (...args) => {
    entered(); await new Promise((r) => release = r); return f.createApi(...args);
  };
  const work = f.runner.start([f.plan], 'now'); await waiting;
  f.runner.stop(); assert.deepEqual(f.armed, [true, false]);
  release(); const run = await work;
  assert.equal(run.status, 'stopped'); assert.equal(run.items[0].status, 'stopped'); assert.equal(f.calls.length, 0);
});
test('未来放号任务点击后先校验身份，但停止等待前不会下单', async (t) => {
  t.mock.timers.setTime(Date.parse('2026-09-20T12:00:00+08:00'));
  const f = fixture(); f.plan.date = addDays(shanghaiDate(), 1);
  let identities = 0;
  f.runner.createApi = async (...args) => { const c = await f.createApi(...args);
    const getIdentity = c.api.getIdentity; c.api.getIdentity = async () => { identities++; return getIdentity(); }; return c; };
  f.runner.changed = () => { if (f.runner.current?.status === 'waiting') f.runner.stop(); };
  const run = await f.runner.start([f.plan], 'release');
  assert.equal(identities, 1); assert.equal(f.calls.length, 0); assert.equal(run.status, 'stopped');
  assert.equal(run.items[0].status, 'stopped');
});
test('放号前首单意图已保存，到点发单前不再等待状态写盘或界面刷新', { timeout: 3000 }, async (t) => {
  const releaseAt = Date.parse('2026-10-01T12:30:00+08:00');
  t.mock.timers.setTime(releaseAt - 1000);
  const f = fixture(); f.plan.date = addDays(shanghaiDate(), 1);
  f.plan.times = [f.plan.times[0]]; f.plan.bookingGoal = 'one';
  const write = f.device.writeState; let prepared = false, sent = false, releaseWrites = 0, rendersBeforeSend = 0;
  f.runner.changed = () => {
    if (f.runner.current?.status === 'booking' && !sent) rendersBeforeSend++;
  };
  f.device.writeState = async (input) => {
    if (Date.now() >= releaseAt && !sent) releaseWrites++;
    await write(input);
    if (!prepared && Object.values(JSON.parse(input.value).runs[0].pendingRequests).some((record) => record.state === 'prepared')) {
      prepared = true; t.mock.timers.setTime(releaseAt);
    }
  };
  f.runner.createApi = async (account) => {
    const c = await f.createApi(account), book = c.api.book;
    c.api.book = async (input) => {
      assert.equal(prepared, true, '首单意图应在放号前已落盘');
      assert.equal(Object.values(f.saved().runs[0].pendingRequests).length, 1);
      sent = true; return book(input);
    };
    return c;
  };
  const run = await f.runner.start([f.plan], 'release');
  assert.equal(run.status, 'success'); assert.equal(f.calls.length, 1);
  assert.equal(releaseWrites, 0); assert.equal(rendersBeforeSend, 0);
  assert.deepEqual(run.pendingRequests, {});
});
test('放号前意图保存期间停止，不留下未发出预约的待核对标记', { timeout: 3000 }, async (t) => {
  t.mock.timers.setTime(Date.parse('2026-10-01T12:29:59+08:00'));
  const f = fixture(); f.plan.date = addDays(shanghaiDate(), 1);
  const write = f.device.writeState; let prepared = false;
  f.device.writeState = async (input) => {
    await write(input);
    if (!prepared && Object.values(JSON.parse(input.value).runs[0].pendingRequests).some((record) => record.state === 'prepared')) {
      prepared = true; f.runner.stop();
    }
  };
  const run = await f.runner.start([f.plan], 'release');
  assert.equal(prepared, true); assert.equal(run.status, 'stopped'); assert.equal(f.calls.length, 0);
  assert.deepEqual(run.pendingRequests, {}); assert.equal(run.inFlight, undefined);
  assert.deepEqual(f.saved().runs[0].pendingRequests, {});
});
test('同账号重叠方案已提前准备，其他方案成功后清除未发出的准备意图', { timeout: 3000 }, async (t) => {
  const releaseAt = Date.parse('2026-10-01T12:30:00+08:00');
  t.mock.timers.setTime(releaseAt - 1000);
  const f = fixture(); f.plan.date = addDays(shanghaiDate(), 1);
  const one = { ...f.plan, times: [f.plan.times[0]], bookingGoal: 'one' };
  const write = f.device.writeState; let preparedBoth = false;
  f.device.writeState = async (input) => {
    await write(input);
    if (Object.values(JSON.parse(input.value).runs[0].pendingRequests).length === 2) {
      preparedBoth = true; t.mock.timers.setTime(releaseAt);
    }
  };
  const run = await f.runner.start([one, { ...one, id: 'same', name: '同账号方案' }], 'release');
  assert.equal(preparedBoth, true); assert.equal(run.status, 'success'); assert.equal(f.calls.length, 1);
  assert.equal(run.successes.length, 2); assert.ok(run.successes.some((success) => success.reused));
  assert.deepEqual(run.pendingRequests, {}); assert.equal(run.inFlight, undefined);
});

// Fault injection at the actual persistence/dispatch boundaries, not just API stubs.
test('停止发生在首次落盘期间，不应随后重新启用原生执行', async () => {
  const f = fixture(); const write = f.device.writeState; let stopped = false;
  f.device.writeState = async (input) => { if (!stopped) { stopped = true; f.runner.stop(); } await write(input); };
  await f.runner.start([f.plan], 'now');
  assert.equal(f.armed.includes(true), false); assert.equal(f.calls.length, 0);
});
test('停止发生在提交意图落盘期间：未发单，不应遗留结果未知标记', async () => {
  const f = fixture(); const write = f.device.writeState; let stopped = false;
  f.device.writeState = async (input) => {
    if (!stopped && JSON.parse(input.value).runs[0]?.inFlight) { stopped = true; f.runner.stop(); }
    await write(input);
  };
  const run = await f.runner.start([f.plan], 'now');
  assert.equal(f.calls.length, 0); assert.equal(run.inFlight, undefined);
  assert.equal(f.saved().runs[0].inFlight, undefined);
});
test('提交意图落盘耗尽执行窗口后，不应再发预约', async (t) => {
  t.mock.timers.setTime(Date.now());
  const f = fixture(); const write = f.device.writeState; let delayed = false;
  f.device.writeState = async (input) => {
    if (!delayed && JSON.parse(input.value).runs[0]?.inFlight) { delayed = true; t.mock.timers.tick(1100); }
    await write(input);
  };
  const run = await f.runner.start([f.plan], 'now');
  assert.equal(f.calls.length, 0); assert.equal(run.inFlight, undefined);
});
test('异步日志写盘失败必须显示存储错误，不能只显示已停止', async () => {
  const f = fixture(); const write = f.device.writeState; let failed = false;
  f.device.writeState = async (input) => {
    if (!failed && JSON.parse(input.value).runs[0]?.logs.length) { failed = true; throw new Error('模拟磁盘写入失败'); }
    await write(input);
  };
  const run = await f.runner.start([f.plan], 'now');
  assert.equal(run.status, 'error'); assert.match(run.error, /磁盘写入失败/);
  assert.equal(f.calls.length, 0); assert.equal(f.runner.active, false);
});
test('共享存储失败必须中止仍在等放号的其他方案', async (t) => {
  t.mock.timers.setTime(Date.parse('2026-09-20T12:00:00+08:00'));
  const f = fixture(); f.plan.date = addDays(shanghaiDate(), 1);
  const save = f.store.save.bind(f.store);
  f.store.save = async () => {
    if (f.store.state.runs[0]?.logs.some((line) => line.details?.event === 'clock_estimate')) {
      throw new Error('会话落盘失败');
    }
    return save();
  };
  const work = f.runner.start([f.plan, { ...f.plan, id: 'other', accountId: 'b' }], 'release');
  let timer;
  const finished = await Promise.race([work.then(() => true, () => true),
    new Promise((r) => timer = setTimeout(() => r(false), 500))]);
  clearTimeout(timer);
  if (!finished) f.runner.stop();
  await work.catch(() => {});
  assert.equal(finished, true, '共享存储失败后，批次仍在等待未来放号');
  assert.equal(f.calls.length, 0);
});
test('各账号预约返回合法JSON但缺少业务结果时，各自停止并保留全部待核对记录', async () => {
  const { SzuVenueApi } = await import('../shared/api.js');
  const f = fixture(); let submissions = 0;
  f.runner.createApi = async (account) => {
    const c = await f.createApi(account);
    const actual = new SzuVenueApi(new CoreHttpClient({ userAgent: 'test', cookies: [] }, {
      transport: async () => { submissions++; return {
        ok: true, status: 200, headers: { get: () => null, getSetCookie: () => [] }, text: async () => '{}',
      }; },
    }));
    actual.identity = { id: account.userId, name: account.name };
    c.api.book = (input) => actual.book(input); return c;
  };
  const run = await f.runner.start([f.plan, { ...f.plan, id: 'other', accountId: 'b' }], 'now');
  assert.equal(submissions, 2); assert.equal(run.status, 'error'); assert.ok(run.inFlight);
  assert.deepEqual(pendingMobileRequests(f.saved().runs[0]).map((r) => r.accountId).sort(), ['a', 'b']);
  assert.match(run.error, /待确认|核对/);
});
test('落盘时又收到新Cookie，下一次flush必须保存最新会话', async () => {
  let release, entered; const saving = new Promise((r) => entered = r); const saved = [];
  const client = new CoreHttpClient({ cookies: [] }, { save: async (session) => {
    saved.push(structuredClone(session));
    if (saved.length === 1) { entered(); await new Promise((r) => release = r); }
  } });
  const cookie = (value) => ({ headers: { getSetCookie: () => [`_WEU=${value}; Path=/qljfwapp/`] } });
  client.updateCookies(cookie('old'));
  const first = client.flush(); await saving;
  client.updateCookies(cookie('new')); release(); await first; await client.flush();
  assert.equal(saved.at(-1).cookies[0].value, 'new');
});

test('预约成功后的第一次落盘失败：保留成功结果，停止其他账号，恢复后仍可查看', async () => {
  const f = fixture(); const write = f.device.writeState; let failed = false;
  let releaseB, failure;
  const storageFailed = new Promise((resolve) => failure = resolve);
  f.runner.createApi = async (account) => {
    if (account.id === 'b') await new Promise((resolve) => releaseB = resolve);
    return f.createApi(account);
  };
  f.device.writeState = async (input) => {
    if (!failed && JSON.parse(input.value).runs[0]?.successes.length) { failed = true; failure(); throw new Error('模拟短暂存储故障'); }
    await write(input);
  };
  const work = f.runner.start([f.plan, { ...f.plan, id: 'other', accountId: 'b' }], 'now');
  await storageFailed;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.runner.controller.signal.aborted, true);
  releaseB(); const run = await work;
  assert.equal(f.calls.length, 1); assert.equal(run.status, 'error'); assert.equal(run.successes.length, 1);
  assert.equal(run.items[0].metrics.unknown, 0, '本地保存失败不能把已收到的学校成功响应归为未知');
  const restored = new MobileStore(f.device); await restored.load();
  assert.equal(restored.state.runs[0].successes.length, 1);
  assert.equal(restored.state.runs[0].inFlight, undefined);
});
test('明确成功响应携带保存失败时，保留成功并停止同账号其他项目', async () => {
  const f = fixture(); let calls = 0;
  f.runner.createApi = async (account) => {
    const c = withVolleyball(await f.createApi(account));
    c.api.book = async () => { calls++; return { code: '0', data: { DHID: 'known-order' }, persistenceError: '会话保存失败' }; };
    return c;
  };
  const run = await f.runner.start([f.plan, { ...f.plan, id: 'volley', project: 'volleyball' }], 'now');
  assert.equal(calls, 1); assert.equal(run.status, 'error'); assert.match(run.error, /会话保存失败/);
  assert.equal(run.successes.length, 1); assert.equal(run.successes[0].orderId, 'known-order');
  assert.deepEqual(run.pendingRequests, {}); assert.equal(run.items[0].metrics.unknown, 0);
});
test('最终落盘持续失败：释放执行锁和亮屏，并在内存保留失败及成功订单', async () => {
  const f = fixture(); const write = f.device.writeState;
  f.device.writeState = async (input) => {
    if (JSON.parse(input.value).runs[0]?.finishedAt) throw new Error('模拟存储已满');
    await write(input);
  };
  await assert.rejects(f.runner.start([f.plan], 'now'), /存储已满/);
  assert.equal(f.runner.active, false); assert.equal(f.armed.at(-1), false);
  assert.equal(f.runner.current.status, 'error'); assert.equal(f.runner.current.successes.length, 2);
});
test('原生明确拒绝未发送的请求，不应归类为预约结果未知', async () => {
  const f = fixture();
  f.runner.createApi = async (...args) => { const c = await f.createApi(...args);
    c.api.book = async () => { const e = new Error('执行窗口已结束，未发送请求'); e.code = 'REQUEST_NOT_SENT'; throw e; }; return c; };
  const run = await f.runner.start([f.plan], 'now');
  assert.equal(run.inFlight, undefined); assert.match(run.error, /未发送/); assert.doesNotMatch(run.error, /待确认/);
});

test('手机保存的剩余场地开关传入执行器，优先所选，再补其他场地', async () => {
  const f = fixture(); f.plan.includeOtherCourts = true; f.plan.times = ['15:00-16:00'];
  const attempted = [];
  f.runner.createApi = async (...args) => { const c = await f.createApi(...args);
    c.api.getOpeningRooms = async () => [{ WID: 'other', CDMC: '其他场', CGBM: 'v' }, { WID: 'court', CDMC: '优先场', CGBM: 'v' }];
    c.api.book = async ({ room }) => { attempted.push(room.WID); return { code: room.WID === 'other' ? '0' : '1', msg: '已满' }; }; return c; };
  const run = await f.runner.start([f.plan], 'now');
  assert.equal(run.status, 'success'); assert.deepEqual(attempted, ['court', 'other']);
  assert.equal(f.saved().runs[0].plans[0].includeOtherCourts, true);
});

test('学校已有一段，同时执行两份剩余方案只能再提交一段，共享核对只查询一次', async () => {
  const f = fixture(); let queries = 0;
  const rows = [{ YYRQ: f.plan.date, KYYSJD: '14:00-15:00', XMDM: '001', YYZT_DISPLAY: '已支付', CDWID: 'court', CDMC: '1号场' }];
  const reviewed = reviewBookings({ plan: f.plan, target: { sportCode: '001', courtNames: ['court'] }, rows });
  const copies = reviewed.remainingTimes.map((time, index) => ({ ...f.plan, id: `copy-${index}`, times: [time], bookingGoal: reviewed.remainingGoal }));
  f.runner.createApi = async (...args) => { const c = await f.createApi(...args);
    c.api.getAllBookings = async () => { queries++; return rows; }; return c; };
  const run = await f.runner.start(copies, 'now');
  assert.equal(queries, 1); assert.equal(f.calls.length, 1);
  assert.equal(run.successes.length, 1); assert.ok(run.items.some((i) => i.status === 'limited'));
});
test('重新执行会重新查学校占用，已取消的旧订单不占名额', async () => {
  const f = fixture(); let queries = 0;
  f.store.state.runs.push({ successes: [{ accountId: 'a', date: f.plan.date, time: '14:00-15:00' }], finishedAt: 'old' });
  f.runner.createApi = async (...args) => { const c = await f.createApi(...args);
    c.api.getAllBookings = async () => { queries++; return [{ YYRQ: f.plan.date, KYYSJD: '14:00-15:00', XMDM: '001', YYZT_DISPLAY: '已取消' }]; }; return c; };
  const run = await f.runner.start([f.plan], 'now');
  assert.equal(run.status, 'success'); assert.equal(f.calls.length, 2); assert.equal(queries, 1);
});
test('学校已有相同候选时段直接复用，并只补一段', async () => {
  const f = fixture();
  f.runner.createApi = async (...args) => { const c = await f.createApi(...args);
    c.api.getAllBookings = async () => [{ YYRQ: f.plan.date, KYYSJD: f.plan.times[0], XMDM: '001', YYZT_DISPLAY: '已支付', CDWID: 'court', CDMC: '1号场' }]; return c; };
  const run = await f.runner.start([f.plan], 'now');
  assert.equal(run.status, 'success'); assert.deepEqual(f.calls.map(([, time]) => time), [f.plan.times[1]]);
  assert.equal(run.successes.length, 2); assert.equal(run.successes[0].reused, true);
  assert.equal(run.successes[0].school, true);
});
test('连续目标的前段已开始但学校确认已约到，仍可只补相邻后一段', async (t) => {
  t.mock.timers.setTime(Date.parse('2026-10-01T18:05:00+08:00'));
  const f = fixture(); f.plan.bookingGoal = 'consecutive'; f.plan.times = ['18:00-19:00', '19:00-20:00'];
  f.runner.createApi = async (...args) => { const c = await f.createApi(...args);
    c.api.getAllBookings = async () => [{ YYRQ: f.plan.date, KYYSJD: f.plan.times[0], XMDM: '001', YYZT_DISPLAY: '已支付', CDWID: 'court', CDMC: '1号场' }]; return c; };
  const run = await f.runner.start([f.plan], 'now');
  assert.equal(run.status, 'success'); assert.deepEqual(f.calls.map(([, time]) => time), [f.plan.times[1]]);
  assert.deepEqual(run.items[0].expiredTimes, []);
});
test('学校核对失败只停止对应账号的方案，其他账号仍可预约', async () => {
  const f = fixture();
  f.runner.createApi = async (account) => { const c = await f.createApi(account);
    if (account.id === 'a') c.api.getAllBookings = async () => { throw new Error('学校查询失败'); }; return c; };
  const run = await f.runner.start([f.plan, { ...f.plan, id: 'other', accountId: 'b' }], 'now');
  assert.deepEqual(f.calls.map(([id]) => id), ['b', 'b']);
  assert.deepEqual(run.items.map((i) => i.status), ['error', 'success']);
});
test('学校未知订单与候选重叠时不提交，不能把未知当成空订单', async () => {
  const f = fixture();
  f.runner.createApi = async (...args) => { const c = await f.createApi(...args);
    c.api.getAllBookings = async () => [{ YYRQ: f.plan.date, KYYSJD: '15:30-16:30', XMDM: '001', YYZT_DISPLAY: '未知状态' }]; return c; };
  const run = await f.runner.start([f.plan], 'now');
  assert.equal(run.status, 'error'); assert.match(run.items[0].error, /人工核对/); assert.equal(f.calls.length, 0);
});
test('账号业务拒绝先阻止同账号排队方案，其他账号继续', async () => {
  const f = fixture();
  f.runner.createApi = async (account) => { const c = await f.createApi(account), book = c.api.book;
    c.api.book = async (input) => { const response = await book(input);
      return account.id === 'a' ? { code: '1', msg: '账号冻结' } : response; }; return c; };
  const run = await f.runner.start([{ ...f.plan, times: [f.plan.times[0]] },
    { ...f.plan, id: 'sibling', times: [f.plan.times[1]] }, { ...f.plan, id: 'other', accountId: 'b' }], 'now');
  assert.equal(f.calls.filter(([id]) => id === 'a').length, 1);
  assert.equal(f.calls.filter(([id]) => id === 'b').length, 2);
  assert.deepEqual(run.items.map((i) => i.status), ['error', 'error', 'success']);
  assert.ok(run.items.slice(0, 2).every((i) => i.error.includes('账号冻结')));
});

test('手机放号准备耗尽窗口时，批次保留已错过状态', async (t) => {
  t.mock.timers.setTime(Date.parse('2026-10-01T12:29:59+08:00'));
  const f = fixture(); f.plan.date = addDays(shanghaiDate(), 1); let samples = 0;
  f.runner.createApi = async (...args) => { const c = await f.createApi(...args);
    c.api.sampleServerOffset = async () => { if (++samples === 3) t.mock.timers.setTime(Date.parse('2026-10-01T12:30:02+08:00')); return 0; };
    return c;
  };
  const run = await f.runner.start([f.plan], 'release');
  assert.equal(run.items[0].status, 'missed'); assert.equal(run.status, 'missed'); assert.equal(f.calls.length, 0);
});

test('原生传输按账号跨连接串行，其他账号仍可并行', async () => {
  const held = []; const calls = [];
  const device = { async request({ url }) { calls.push(url); await new Promise((resolve) => held.push(resolve));
    return { status: 200, headers: {}, body: '{}' }; } };
  const a1 = nativeTransport(device, null, 'a'), a2 = nativeTransport(device, 'run', 'a');
  const b = nativeTransport(device, 'run', 'b');
  const options = { method: 'GET', headers: {} };
  const first = a1('first', options), second = a2('second', options), other = b('other', options);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(calls, ['first', 'other']);
  held.splice(0).forEach((resolve) => resolve()); await first; await other;
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(calls, ['first', 'other', 'second']); held.shift()(); await second;
});

test('同账号查询返回拒绝后，原生队列中的预约出队必须复核 guard', async () => {
  let release, entered, sends = 0, blocked = false;
  const started = new Promise((resolve) => entered = resolve);
  const device = { async request() { sends++; entered(); await new Promise((resolve) => release = resolve);
    return { status: 200, headers: {}, body: JSON.stringify({ code: '1', msg: '账号冻结' }) }; }, async writeState() {} };
  const store = new MobileStore(device), account = { id: 'a', session: { cookies: [], userAgent: 'test' } };
  const reading = createConnection(store, device, account), booking = createConnection(store, device, account, 'run');
  booking.api.identity = { id: 'A', name: '同学甲' };
  const query = reading.api.getOpeningRooms({ campusCode: '1', sportCode: '001', modeCode: '1.0', date: shanghaiDate(), time: '19:00-20:00' })
    .catch((error) => { assert.match(error.message, /冻结/); blocked = true; });
  await started;
  const book = booking.api.book({ date: shanghaiDate(), modeCode: '1.0', time: '19:00-20:00', room: { WID: 'court', CGBM: 'v', XMDM: '001', XQDM: '1' },
    beforeDispatch: () => { if (blocked) throw new RequestNotSentError('账号已停止'); } });
  const rejected = assert.rejects(book, /账号已停止/);
  release(); await query; await rejected;
  assert.equal(sends, 1);
});

test('原生请求排队期间耗尽截止时间，出队不调用设备', async (t) => {
  const held = []; let sends = 0;
  const device = { async request() { sends++; await new Promise((resolve) => held.push(resolve)); return { status: 200, headers: {}, body: '{}' }; } };
  const transport = nativeTransport(device, 'run', 'a'), options = { method: 'GET', headers: {} };
  const first = transport('first', options); await new Promise((resolve) => setTimeout(resolve, 5));
  const queued = transport('queued', { ...options, deadlineMs: Date.now() + 1 });
  const failed = assert.rejects(queued, /执行窗口已结束/);
  t.mock.timers.setTime(Date.now() + 2); held.shift()(); await first; await failed; assert.equal(sends, 1);
});

test('同账号原生队列出队时使用上一请求刷新后的Cookie', async () => {
  let entered, release; const started = new Promise((resolve) => entered = resolve); const cookies = [];
  const device = { async writeState() {}, async request({ headers }) {
    cookies.push(headers.cookie);
    if (cookies.length === 1) { entered(); await new Promise((resolve) => release = resolve); }
    return { status: 200, headers: { 'Set-Cookie': ['_WEU=new; Path=/'] }, body: '{}' };
  } };
  const store = new MobileStore(device), account = { id: 'a', session: { userAgent: 'test',
    cookies: [{ name: '_WEU', value: 'old', domain: 'ehall.szu.edu.cn', path: '/' }] } };
  const first = createConnection(store, device, account), second = createConnection(store, device, account, 'run');
  const reading = first.client.post('sportVenue/getRqList.do'); await started;
  const next = second.client.post('sportVenue/getRqList.do'); release(); await reading; await next;
  assert.deepEqual(cookies, ['_WEU=old', '_WEU=new']);
});

test('停止发生在原生账号队列等待期间，不调用设备提交预约', async () => {
  let entered, release, sends = 0; const started = new Promise((resolve) => entered = resolve);
  const device = { async writeState() {}, async request() {
    sends++; entered(); await new Promise((resolve) => release = resolve);
    return { status: 200, headers: {}, body: '{}' };
  } };
  const store = new MobileStore(device), account = { id: 'a', session: { userAgent: 'test', cookies: [] } };
  const connection = createConnection(store, device, account, 'run'); connection.api.identity = { id: 'A', name: '同学甲' };
  const reading = connection.client.post('sportVenue/getRqList.do'); await started;
  const controller = new AbortController();
  const booking = connection.api.book({ date: shanghaiDate(), modeCode: '1.0', time: '19:00-20:00', room: { WID: 'court', CGBM: 'v', XMDM: '001', XQDM: '1' },
    signal: controller.signal, beforeDispatch: () => { if (controller.signal.aborted) throw new RequestNotSentError('本次执行已停止'); } });
  // book() first awaits its cached identity before entering the transport queue.
  await Promise.resolve(); await Promise.resolve(); controller.abort();
  const rejected = assert.rejects(booking, /已停止/); release(); await reading; await rejected; assert.equal(sends, 1);
});

test('手机较早目录刷新晚返回时，保留较晚刷新已保存的场地', async () => {
  let release, entered, blocked = false, saved;
  const started = new Promise((resolve) => entered = resolve);
  const device = { async writeState({ value }) { saved = JSON.parse(value); }, async request({ url, headers }) {
    const court = headers['user-agent']; let data;
    if (url.endsWith('index.do')) data = 'USERID=\'A\';USER_INFO={"userName":"同学甲"};APP_TITLE=';
    else if (url.endsWith('getSportVenueData.do')) data = metadata;
    else if (url.endsWith('getTimeList.do')) data = [{ CODE: '19:00-20:00' }];
    else if (url.endsWith('getOpeningRoom.do')) {
      if (court === 'first' && !blocked) { blocked = true; entered(); await new Promise((resolve) => release = resolve); }
      data = { code: '0', datas: { getOpeningRoom: { rows: [{ WID: court, CDMC: court, CGBM: 'v' }] } } };
    } else throw new Error('未预期接口');
    return { status: 200, headers: {}, body: typeof data === 'string' ? data : JSON.stringify(data) };
  } };
  const store = new MobileStore(device), account = { id: 'a', userId: 'A', session: { userAgent: 'first', cookies: [] } };
  store.state.accounts = [account];
  const older = readCatalog(store, device, account, 'badminton'); await started;
  // Different devices model callers that finish independently of a queued connection.
  const secondDevice = { ...device }; account.session = { userAgent: 'second', cookies: [] };
  await readCatalog(store, secondDevice, account, 'badminton'); release(); const merged = await older;
  assert.deepEqual(new Set(merged.courts.map((court) => court.id)), new Set(['first', 'second']));
  assert.deepEqual(new Set(saved.catalogs['a:badminton'].courts.map((court) => court.id)), new Set(['first', 'second']));
});

test('旧 WebView 没有 AbortSignal.any/timeout 时，多账号执行及停止信号仍可工作', async () => {
  const any = AbortSignal.any, timeout = AbortSignal.timeout;
  try {
    AbortSignal.any = undefined; AbortSignal.timeout = undefined;
    const f = fixture();
    const run = await f.runner.start([f.plan, { ...f.plan, id: 'other', accountId: 'b' }], 'now');
    assert.equal(run.status, 'success'); assert.equal(f.calls.length, 4);
    const controller = new AbortController();
    const client = new CoreHttpClient({ cookies: [], userAgent: 'test' }, { transport: async (_url, options) => {
      controller.abort(new Error('取消旧 WebView 查询')); throw options.signal.reason;
    } });
    await assert.rejects(client.get('index.do', { signal: controller.signal, abortInFlight: true }), /取消旧 WebView/);
  } finally { AbortSignal.any = any; AbortSignal.timeout = timeout; }
});

test('原生发送日志区分崩溃前已发预约和未发预备意图；旧版记录仍保守待核对', async () => {
  const data = { version: 1, accounts: [], plans: [], catalogs: {}, runs: [
    { id: 'new', status: 'waiting', dispatchJournalVersion: 1, pendingRequests: {
      sent: { requestId: 'sent', state: 'prepared', time: '15:00-16:00' },
      unsent: { requestId: 'unsent', state: 'prepared', time: '16:00-17:00' } } },
    { id: 'legacy', status: 'waiting', pendingRequests: { old: { requestId: 'old', state: 'prepared' } } },
  ] };
  const store = new MobileStore({ async readState() { return { value: JSON.stringify(data), dispatchJournalAvailable: true,
    dispatchedRequests: { sent: { sentAt: Date.now() } } }; }, async writeState() {} });
  await store.load();
  assert.deepEqual(pendingMobileRequests(store.state.runs[0]).map((request) => request.requestId), ['sent']);
  assert.equal(store.state.runs[0].pendingRequests.sent.state, 'unknown');
  assert.ok(store.state.runs[0].pendingRequests.sent.sentAt);
  assert.equal(pendingMobileRequests(store.state.runs[1]).length, 1);
});

test('未核实的历史预约阻止同账号同日项目再次执行，其他账号可继续', async () => {
  const f = fixture();
  f.store.state.runs.push({ id: 'old', finishedAt: 'old', status: 'error', plans: [f.plan], successes: [],
    pendingRequests: { unknown: { requestId: 'unknown', planId: f.plan.id, accountId: 'a', date: f.plan.date, time: f.plan.times[0] } } });
  await assert.rejects(f.runner.start([f.plan], 'now'), /先核对/);
  assert.equal(f.runner.active, false); assert.equal(f.armed.length, 0); assert.equal(f.calls.length, 0);
  const run = await f.runner.start([{ ...f.plan, id: 'other', accountId: 'b' }], 'now');
  assert.equal(run.status, 'success'); assert.ok(f.calls.every(([account]) => account === 'b'));
});

test('学校核对只归档精确匹配的未知请求，保留原始错误和未匹配请求', () => {
  const f = fixture(); const plan = { ...f.plan, bookingGoal: 'one' };
  const run = { id: 'old', finishedAt: 'old', status: 'error', error: '网络断开', plans: [plan], successes: [], items: [{ id: plan.id, status: 'error' }],
    pendingRequests: { matched: { requestId: 'matched', planId: plan.id, accountId: 'a', date: plan.date, time: plan.times[0], court: '1号场' },
      unmatched: { requestId: 'unmatched', planId: plan.id, accountId: 'a', date: plan.date, time: plan.times[1], court: '2号场' } } };
  const review = { checkedAt: new Date().toISOString(), booked: [{ date: plan.date, time: plan.times[0], court: '1号场', matchesCourts: true }] };
  const [result] = reviewedMobileRuns([run], plan, review);
  assert.equal(result.reviewedRequests.matched.reviewResult, 'booked');
  assert.deepEqual(pendingMobileRequests(result).map((request) => request.requestId), ['unmatched']);
  assert.equal(result.status, 'error'); assert.equal(result.error, '网络断开');
  assert.equal(result.items[0].reviewedOutcome, 'success');
  assert.equal(run.reviewedRequests, undefined, '原状态须等到保存成功才发布');
});

test('学校查不到的请求必须经人工明确确认后才能归档为无订单', () => {
  const f = fixture(); const run = { id: 'old', status: 'error', finishedAt: 'old', plans: [f.plan], items: [],
    pendingRequests: { unknown: { requestId: 'unknown', planId: f.plan.id, accountId: 'a', date: f.plan.date, time: f.plan.times[0], court: '1号场' } } };
  const review = { booked: [], checkedAt: new Date().toISOString() };
  assert.equal(pendingMobileRequests(reviewedMobileRuns([run], f.plan, review)[0]).length, 1);
  const [confirmed] = reviewedMobileRuns([run], f.plan, review, { confirmedAbsent: true });
  assert.equal(pendingMobileRequests(confirmed).length, 0);
  assert.equal(confirmed.reviewedRequests.unknown.reviewResult, 'absent');
  assert.equal(confirmed.reviewedRequests.unknown.manuallyConfirmed, true);
});

test('历史归档缩小执行主状态，同时保留未知请求和当前方案最新结果', async () => {
  const archived = []; let saved;
  const store = new MobileStore({ async archiveRuns({ runs }) { archived.push(...structuredClone(runs)); },
    async writeState({ value }) { saved = JSON.parse(value); } });
  store.state.runs = Array.from({ length: 90 }, (_, index) => ({ id: String(index), status: 'success', finishedAt: 'old',
    startedAt: new Date(Date.now() - index * 1000).toISOString(), plans: [], successes: [{ orderId: `order-${index}` }], logs: ['preserved'] }));
  store.state.runs[89].pendingRequests = { unknown: { state: 'unknown' } };
  store.state.plans = [{ id: 'current', date: shanghaiDate() }]; store.state.runs[88].plans = [{ id: 'current' }];
  await store.save();
  assert.equal(archived.length, 38); assert.equal(saved.runs.length, 52);
  assert.ok(saved.runs.some((run) => run.id === '89')); assert.ok(saved.runs.some((run) => run.id === '88'));
  assert.deepEqual(archived[0].logs, ['preserved']); assert.equal(saved.archivedRunCount, 38);
});

test('归档或主状态保存失败不能丢失内存中的历史记录；活跃执行不归档', async () => {
  let failArchive = true, failWrite = true, archives = 0;
  const store = new MobileStore({ async archiveRuns() { archives++; if (failArchive) throw new Error('归档失败'); },
    async writeState() { if (failWrite) throw new Error('主状态失败'); } });
  store.state.runs = Array.from({ length: 60 }, (_, index) => ({ id: String(index), status: 'success', finishedAt: 'old', plans: [] }));
  await assert.rejects(store.save(), /归档失败/); assert.equal(store.state.runs.length, 60);
  failArchive = false; await assert.rejects(store.save(), /主状态失败/); assert.equal(store.state.runs.length, 60);
  failWrite = false; store.state.runs[0].finishedAt = undefined; const before = archives;
  await store.save(); assert.equal(archives, before); assert.equal(store.state.runs.length, 60);
});

test('取消目录在途查询通过原生请求 ID 释放账号队列，随后预约无需等待旧超时', async () => {
  let entered, rejectRead, cancelled, sends = 0;
  const started = new Promise((resolve) => entered = resolve);
  const device = { async request({ requestId }) {
    if (++sends === 1) { entered(requestId); await new Promise((_, reject) => rejectRead = reject); }
    return { status: 200, headers: {}, body: '{}' };
  }, async cancelRequest({ requestId }) { cancelled = requestId; rejectRead(new RequestNotSentError('已取消查询')); } };
  const transport = nativeTransport(device, null, 'a'); const controller = new AbortController();
  const reading = transport('query', { method: 'POST', headers: {}, abortInFlight: true, signal: controller.signal });
  const failed = assert.rejects(reading, /已取消查询/); const readId = await started;
  const booking = transport('booking', { method: 'POST', headers: {}, deadlineMs: Date.now() + 1000 });
  controller.abort(); await failed; await booking;
  assert.equal(cancelled, readId); assert.equal(sends, 2);
});

test('发送后的预约不会因取消信号调用原生 cancelRequest', async () => {
  let cancellations = 0; const controller = new AbortController();
  const transport = nativeTransport({ async request() { controller.abort(); return { status: 200, headers: {}, body: '{"code":"0"}' }; },
    async cancelRequest() { cancellations++; } }, 'run', 'a');
  const response = await transport('booking', { method: 'POST', headers: {}, signal: controller.signal, abortInFlight: false });
  assert.equal(await response.text(), '{"code":"0"}'); assert.equal(cancellations, 0);
});

test('手机最初身份预检继承停止信号，不需等默认网络超时才结束', async () => {
  const f = fixture(); let entered; const started = new Promise((resolve) => entered = resolve);
  f.runner.createApi = async (...args) => { const connection = await f.createApi(...args);
    connection.api.getIdentity = ({ signal, deadline }) => {
      assert.ok(deadline > Date.now()); entered();
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    }; return connection;
  };
  const work = f.runner.start([f.plan], 'now'); await started; f.runner.stop();
  const run = await work; assert.equal(run.status, 'stopped'); assert.equal(f.calls.length, 0); assert.equal(f.runner.active, false);
});

test('学校核对能解决同项目旧方案中当前方案未选的时段，包括目标已完成后的人工确认', () => {
  const f = fixture(); const plan = { ...f.plan, times: [f.plan.times[0]], bookingGoal: 'one' };
  const request = { requestId: 'outside', planId: f.plan.id, accountId: 'a', date: f.plan.date, time: f.plan.times[1], court: '1号场' };
  const run = { id: 'old', finishedAt: 'old', status: 'error', plans: [f.plan], items: [], pendingRequests: { outside: request } };
  const review = { goalReached: true, remainingTimes: [], checkedAt: new Date().toISOString(), booked: [],
    resolvedRequests: [{ ...request, schoolSlot: { date: f.plan.date, time: request.time, court: '1号场' } }] };
  const [matched] = reviewedMobileRuns([run], plan, review);
  assert.equal(pendingMobileRequests(matched).length, 0); assert.equal(matched.reviewedRequests.outside.reviewResult, 'booked');
  const [absent] = reviewedMobileRuns([run], plan, { ...review, resolvedRequests: [] }, { confirmedAbsent: true });
  assert.equal(pendingMobileRequests(absent).length, 0); assert.equal(absent.reviewedRequests.outside.reviewResult, 'absent');
});

test('已知成功或拒绝落盘后发送标记未清理，恢复不能把已知结果重新归类未知', async () => {
  const f = fixture(); let saved;
  const known = (requestId, code, time) => ({ requestId, code, planId: f.plan.id, plan: f.plan.name,
    accountId: 'a', date: f.plan.date, time, court: '1号场', orderId: code === '0' ? 'known-order' : undefined });
  const data = { version: 1, accounts: f.store.state.accounts, plans: [f.plan], catalogs: {}, runs: [{ id: 'run', status: 'booking',
    dispatchJournalVersion: 1, plans: [f.plan], items: [{ id: f.plan.id, status: 'booking' }], successes: [], logs: [],
    knownRequests: { success: known('success', '0', f.plan.times[0]), rejected: known('rejected', '1', f.plan.times[1]) }, pendingRequests: {} }] };
  const store = new MobileStore({ async readState() { return { value: JSON.stringify(data), dispatchJournalAvailable: true,
    dispatchedRequests: { success: { runId: 'run', sentAt: Date.now() }, rejected: { runId: 'run', sentAt: Date.now() } } }; },
    async writeState({ value }) { saved = JSON.parse(value); } });
  await store.load(); assert.equal(pendingMobileRequests(store.state.runs[0]).length, 0);
  assert.equal(store.state.runs[0].successes[0].orderId, 'known-order');
  assert.equal(saved.runs[0].knownRequests.rejected.code, '1', '发送标记清理前必须持久保留明确拒绝证据');
  assert.deepEqual(store.state.runs[0].knownRequests, {}, '清理确认后不累积临时响应账本');
});

test('孤立发送标记恢复为待核对请求；主数据缺失时禁止覆盖并重新预约', async () => {
  const f = fixture(); const marker = { requestId: 'orphan', runId: 'run', accountId: 'a', planId: f.plan.id, project: f.plan.project,
    date: f.plan.date, time: f.plan.times[0], courtId: 'court', sentAt: Date.now() };
  const data = { ...f.store.state, runs: [{ id: 'run', status: 'booking', dispatchJournalVersion: 1, plans: [f.plan],
    pendingRequests: {}, successes: [], logs: [], items: [] }] };
  const store = new MobileStore({ async readState() { return { value: JSON.stringify(data), dispatchJournalAvailable: true,
    dispatchedRequests: { orphan: marker } }; }, async writeState() {} });
  await store.load(); assert.equal(pendingMobileRequests(store.state.runs[0])[0].orphaned, true);
  const runner = new ForegroundExecution({ store, device: f.device, createApi: f.createApi });
  await assert.rejects(runner.start([{ ...f.plan, project: 'volleyball' }], 'now'), /先核对/);
  let wrote = false;
  const missing = new MobileStore({ async readState() { return { value: null, dispatchedRequests: { orphan: marker } }; },
    async writeState() { wrote = true; } });
  await assert.rejects(missing.load(), /主数据缺失/); assert.equal(wrote, false);
});

test('真实学校 API 适配器把恢复用的请求标识与方案元数据传到原生层', async () => {
  let dispatched;
  const device = { async writeState() {}, async request(input) {
    dispatched = input; return { status: 200, headers: {}, body: '{"code":"0","data":{"DHID":"order"}}' };
  } };
  const store = new MobileStore(device), account = { id: 'a', session: { cookies: [], userAgent: 'test' } };
  const connection = createConnection(store, device, account, crypto.randomUUID());
  connection.api.identity = { id: 'A', name: '同学甲' };
  const requestId = crypto.randomUUID(), requestMetadata = { planId: 'p', plan: '方案甲', project: 'badminton', accountId: 'a' };
  await connection.api.book({ date: shanghaiDate(), time: '15:00-16:00', modeCode: '1.0', requestId, requestMetadata,
    room: { WID: 'court', CGBM: 'v', XMDM: '001', XQDM: '1', CDMC: '1号场' } });
  assert.equal(dispatched.requestId, requestId); assert.deepEqual(dispatched.requestMetadata, requestMetadata);
  assert.equal(dispatched.accountId, 'a'); assert.equal(new URLSearchParams(dispatched.body).get('YYRQ'), shanghaiDate());
});
