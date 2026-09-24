import test from 'node:test';
import assert from 'node:assert/strict';
import { ForegroundExecution, validatePlan } from '../mobile/src/execution.js';
import { MobileStore } from '../mobile/src/store.js';
import { CoreHttpClient } from '../shared/http-client-core.js';
import { shanghaiDate, addDays } from '../shared/utils.js';
const metadata = { campusList: [{ XQDM: '1', XQDM_DISPLAY: '粤海校区' }],
  xmList: [{ XQDM: '1', XMDM: '001', XMMC: '羽毛球', DCFS: '1.0' }],
  packageVenueList: [{ SSXQ: '1', XM: '001', CGBM: 'v', CGMC: '运动广场东馆羽毛球场' }] };
function fixture() {
  let saved; const armed = [];
  const device = { async readState() { return { value: saved }; }, async writeState({ value }) { saved = value; },
    async setExecution(value) { armed.push(value.enabled); } };
  const store = new MobileStore(device);
  store.state.accounts = [{ id: 'a', name: '我', userId: 'A' }, { id: 'b', name: '舍友', userId: 'B' }];
  const calls = [];
  const createApi = async (account) => ({ client: { async flush() {} }, api: {
    async getIdentity() { return { id: account.userId, name: account.name }; },
    async getSportVenueData() { return metadata; }, async sampleServerOffset() { return 0; },
    async getOpeningRooms() { return [{ WID: 'court', CDMC: '1号场', CGBM: 'v' }]; },
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
test('手机多账号前台执行：成功落盘、请求串行、结束释放亮屏', async () => {
  const f = fixture(); let inFlight = 0, max = 0;
  f.runner.createApi = async (...args) => { const c = await f.createApi(...args); const original = c.api.book;
    c.api.book = async (input) => { max = Math.max(max, ++inFlight); await new Promise((r) => setTimeout(r, 5));
      const response = await original(input); inFlight--; return response; }; return c; };
  const result = await f.runner.start([f.plan, { ...f.plan, id: 'p2', accountId: 'b' }], 'now');
  assert.equal(result.status, 'success', JSON.stringify(result)); assert.equal(result.successes.length, 4); assert.equal(max, 1);
  assert.equal(f.saved().runs[0].successes.length, 4); assert.equal(f.saved().runs[0].inFlight, undefined);
  assert.deepEqual(f.armed, [true, false]); assert.ok(f.calls.some(([id]) => id === 'b'));
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
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
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
test('手机请求结果未知：停止整个批次，不盲目重试', async () => {
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
  assert.equal(result.status, 'success'); assert.equal(f.calls.length, 2);
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
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-09-20T12:00:00+08:00') });
  const f = fixture(); f.plan.date = addDays(shanghaiDate(), 1);
  let identities = 0;
  f.runner.createApi = async (...args) => { const c = await f.createApi(...args);
    const getIdentity = c.api.getIdentity; c.api.getIdentity = async () => { identities++; return getIdentity(); }; return c; };
  f.runner.changed = () => { if (f.runner.current?.status === 'waiting') f.runner.stop(); };
  const run = await f.runner.start([f.plan], 'release');
  assert.equal(identities, 1); assert.equal(f.calls.length, 0); assert.equal(run.status, 'stopped');
  assert.equal(run.items[0].status, 'stopped');
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
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
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
test('一个方案收尾异常，必须中止仍在等明天放号的其他方案', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-09-20T12:00:00+08:00') });
  const f = fixture(); f.plan.date = addDays(shanghaiDate(), 1);
  f.runner.createApi = async (account) => {
    const c = await f.createApi(account); let flushes = 0;
    if (account.id === 'a') {
      c.api.getOpeningRooms = async () => { throw new Error('目录查询失败'); };
      c.client.flush = async () => { if (++flushes > 1) throw new Error('会话落盘失败'); };
    }
    return c;
  };
  const work = f.runner.start([f.plan, { ...f.plan, id: 'other', accountId: 'b' }], 'release');
  let timer;
  const finished = await Promise.race([work.then(() => true), new Promise((r) => timer = setTimeout(() => r(false), 500))]);
  clearTimeout(timer);
  if (!finished) f.runner.stop();
  await work;
  assert.equal(finished, true, '一个方案失败后，批次仍在等待未来放号');
  assert.equal(f.calls.length, 0);
});
test('预约返回合法JSON但缺少业务结果时，停止整个多账号批次并保留待核对记录', async () => {
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
  assert.equal(submissions, 1); assert.equal(run.status, 'error'); assert.ok(run.inFlight);
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
  f.device.writeState = async (input) => {
    if (!failed && JSON.parse(input.value).runs[0]?.successes.length) { failed = true; throw new Error('模拟短暂存储故障'); }
    await write(input);
  };
  const run = await f.runner.start([f.plan, { ...f.plan, id: 'other', accountId: 'b' }], 'now');
  assert.equal(f.calls.length, 1); assert.equal(run.status, 'error'); assert.equal(run.successes.length, 1);
  const restored = new MobileStore(f.device); await restored.load();
  assert.equal(restored.state.runs[0].successes.length, 1);
  assert.equal(restored.state.runs[0].inFlight, undefined);
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
    c.api.book = async ({ room }) => { attempted.push(room.WID); return { code: room.WID === 'other' ? '0' : '1' }; }; return c; };
  const run = await f.runner.start([f.plan], 'now');
  assert.equal(run.status, 'success'); assert.deepEqual(attempted, ['court', 'other']);
  assert.equal(f.saved().runs[0].plans[0].includeOtherCourts, true);
});
