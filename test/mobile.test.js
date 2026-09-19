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
  const plan = { id: 'p', name: '羽毛球', project: 'badminton', accountId: 'a', date: addDays(shanghaiDate(), 1),
    times: ['15:00-16:00', '16:00-17:00'], courts: ['court'], intervalMs: 250, durationMs: 1000, preferSameCourt: true };
  const runner = new ForegroundExecution({ store, device, createApi });
  return { runner, device, store, plan, calls, armed, createApi, saved: () => JSON.parse(saved) };
}
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
  const f = fixture(); f.store.state.runs.push({ id: 'crashed', status: 'booking', successes: [{ time: '15:00-16:00' }], inFlight: { time: '16:00-17:00' } });
  await f.store.save(); const restored = new MobileStore(f.device); await restored.load();
  assert.equal(restored.state.runs[0].status, 'interrupted'); assert.equal(restored.state.runs[0].successes.length, 1);
  assert.ok(restored.state.runs[0].inFlight); assert.equal(f.calls.length, 0);
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
