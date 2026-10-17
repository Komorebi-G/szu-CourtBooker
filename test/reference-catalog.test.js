import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCourtCatalog, readReferenceCatalog, referenceDates } from '../shared/catalog.js';
import { SzuVenueApi } from '../shared/api.js';
import { SchoolQueryError, SessionExpiredError, HttpResponseError } from '../shared/errors.js';
import { ReferenceCatalogStore } from '../desktop/src/catalogs.js';
import { runBooking } from '../shared/runner.js';

const today = '2026-10-11', tomorrow = '2026-10-12';
const early = '19:00-20:00', late = '20:00-21:00';
const room = (id, extra = {}) => ({ WID: id, CDMC: id, CGBM: 'v', XMDM: '001', XQDM: '1', ...extra });
const target = { name: '测试', targetIndex: 0, campusCode: '1', sportCode: '001', modeCode: '1.0',
  venues: [{ CGBM: 'v', CGMC: '东馆' }], courtNames: null, times: [early] };
const reference = (api, extra = {}) => readReferenceCatalog({ api, target, dates: [today, tomorrow], times: [], ...extra });
test.beforeEach((t) => t.mock.timers.enable({ apis: ['Date'], now: Date.parse(today + 'T18:00:00+08:00') }));

test('参考目录合并各日期、时段：今天部分满员不丢掉明天独有场地和时段', async () => {
  const calls = [];
  const catalog = await reference({
    async getTimeList({ date }) { return (date === today ? [early] : [early, late]).map((CODE) => ({ CODE })); },
    async getOpeningRooms({ date, time }) { calls.push([date, time]);
      return date === today ? [room('A', { disabled: true, text: '已满' })] : time === early ? [room('A')] : [room('B')]; }
  }, { target: { ...target, courtNames: ['B', 'A'] } });
  assert.deepEqual(catalog.times, [early, late]);
  assert.deepEqual(catalog.courts.map((c) => c.id), ['B', 'A']);
  assert.deepEqual(catalog.dates, [today, tomorrow]);
  assert.ok(calls.some(([date, time]) => date === tomorrow && time === late));
  assert.equal(catalog.reference, true);
  assert.equal(catalog.roomsByTime, undefined, '参考目录不能伪装成实时空位视图');
});

for (const error of [new SchoolQueryError({ kind: 'wait', message: '该时段未开放' }), new HttpResponseError(503, '/catalog')]) {
  test(`参考首段不可用后继续其他时段与日期：${error.message}`, async () => {
    const catalog = await reference({ async getTimeList() { return [early, late].map((CODE) => ({ CODE })); },
      async getOpeningRooms({ date, time }) { if (date === today && time === early) throw error;
        return [room(date === today ? 'A' : 'B')]; } });
    assert.deepEqual(catalog.courts.map((c) => c.id), ['A', 'B']);
    assert.equal(catalog.partial, true); assert.equal(catalog.issues[0].date, today);
  });
}

test('时段查询明确未开放后使用其他日期已知时段，空时段列表不会凭空查询19点', async () => {
  const calls = [];
  const catalog = await reference({ async getTimeList({ date }) {
    if (date === today) throw new SchoolQueryError({ kind: 'wait', message: '未开放' });
    return [{ CODE: late }];
  }, async getOpeningRooms({ date, time }) { calls.push([date, time]); return [room('A')]; } });
  assert.deepEqual(calls, [[today, late], [tomorrow, late]]); assert.deepEqual(catalog.times, [late]);
  const empty = await reference({ async getTimeList() { return []; }, async getOpeningRooms() { throw new Error('不得虚构时段'); } });
  assert.deepEqual(empty.courts, []); assert.deepEqual(empty.times, []);
});

test('所有当前目录为空时保留历史结构；身份异常、畸形响应不能被缓存遮住', async () => {
  const cached = { date: '2026-10-10', times: [early], courts: [{ id: 'A', name: 'A' }], rooms: [room('A')] };
  const calls = [];
  const catalog = await reference({ async getTimeList() { return []; }, async getOpeningRooms({ date, time }) {
    calls.push([date, time]); return [];
  } }, { cached });
  assert.deepEqual(calls, [[today, early], [tomorrow, early]]);
  assert.deepEqual(catalog.courts.map((c) => c.id), ['A']); assert.deepEqual(catalog.times, [early]);
  assert.equal(catalog.cached, true); assert.deepEqual(catalog.dates, []);
  for (const error of [new SessionExpiredError('登录失效'), new Error('场地接口响应格式异常')]) {
    await assert.rejects(reference({ async getTimeList() { return [{ CODE: early }]; }, async getOpeningRooms() { throw error; } }, { cached }),
      (actual) => actual === error);
  }
  await assert.rejects(reference({ async getTimeList() { return [{ CODE: '坏时段' }]; } }, { cached }), /包含无效时段/);
});

test('跨日期先汇总时段并补查组合，列表省略的时段也能发现独有场地', async () => {
  const calls = [];
  const catalog = await reference({ async getTimeList({ date }) {
    return [{ CODE: date === today ? early : late }];
  }, async getOpeningRooms({ date, time }) {
    calls.push([date, time]);
    return [room(date === today ? time === early ? 'A' : 'C' : time === early ? 'D' : 'B')];
  } });
  assert.deepEqual(calls, [[today, early], [today, late], [tomorrow, early], [tomorrow, late]]);
  assert.deepEqual(catalog.courts.map((court) => court.id).sort(), ['A', 'B', 'C', 'D']);
  assert.deepEqual(catalog.times, [early, late]); assert.equal(catalog.partial, false);
});

test('有效历史时段和显式时段参与重新发现，无效历史时段不成为查询', async () => {
  const calls = [];
  const catalog = await reference({ async getTimeList() { return []; }, async getOpeningRooms({ date, time }) {
    calls.push([date, time]); return [room(time === early ? 'NEW' : 'EXPLICIT')];
  } }, { times: [late], cached: { date: '2026-10-10', times: ['无效', early],
    courts: [{ id: 'OLD', name: 'OLD' }], rooms: [room('OLD')] } });
  assert.deepEqual(calls, [[today, early], [today, late], [tomorrow, early], [tomorrow, late]]);
  assert.deepEqual(catalog.courts.map((court) => court.id).sort(), ['EXPLICIT', 'NEW', 'OLD']);
  assert.deepEqual(catalog.times, [early, late]); assert.equal(catalog.cached, true);
});

test('参考查询到期保留已读结构，不再发后续请求；取消仍立即退出', async (t) => {
  const calls = [];
  const catalog = await reference({ async getTimeList() { return [early, late].map((CODE) => ({ CODE })); },
    async getOpeningRooms({ date, time }) { calls.push([date, time]); t.mock.timers.tick(200); return [room('A')]; }
  }, { deadline: Date.now() + 100 });
  assert.deepEqual(calls, [[today, early]]); assert.deepEqual(catalog.courts.map((c) => c.id), ['A']); assert.equal(catalog.partial, true);
  const controller = new AbortController();
  await assert.rejects(reference({ async getTimeList() { controller.abort(); return []; } }, { signal: controller.signal }), /abort/i);
});

test('参考日期只包含已放号的日期，未来计划不提前查询未开放日期', (t) => {
  t.mock.timers.setTime(Date.parse(today + 'T12:00:00+08:00'));
  assert.deepEqual(referenceDates('2026-10-13'), [today]);
  t.mock.timers.setTime(Date.parse(today + 'T12:30:00+08:00'));
  assert.deepEqual(referenceDates('2026-10-13'), [today, tomorrow]);
  assert.deepEqual(referenceDates(tomorrow), [tomorrow, today]);
});

test('检查配置和编辑器使用同一参考日期策略，今天空而明天有场地时检查通过', async () => {
  const api = { async getTimeList() { return [{ CODE: early }]; },
    async getOpeningRooms({ date }) { return date === today ? [] : [room('A')]; }, async book() { throw new Error('检查不得下单'); } };
  const result = await runBooking({ api, client: { async flush() {} }, date: '2026-10-13', live: false, immediate: true, log() {},
    targets: [{ ...target, courtNames: ['A'] }], config: { scheduler: { queryConcurrency: 1 }, booking: {} } });
  assert.equal(result.ok, true); assert.equal(result.successes.length, 0);
});

test('学校时段业务拒绝保留分类，不冒充空目录', async () => {
  const api = new SzuVenueApi({ async post() { return { data: { code: '1', msg: '未开放' } }; } });
  await assert.rejects(api.getTimeList({}), (error) => error instanceof SchoolQueryError && error.outcome.kind === 'wait');
});

test('放号准备查询后续场馆时，超时随剩余窗口缩短', async (t) => {
  const start = Date.now(), budgets = [];
  await readCourtCatalog({ api: { async getOpeningRooms({ venueCode, timeoutMs }) {
    budgets.push([venueCode, timeoutMs]); t.mock.timers.setTime(start + 700);
    return [room(venueCode, { CGBM: venueCode })];
  } }, target: { ...target, venues: [{ CGBM: 'v' }, { CGBM: 'w' }] }, date: tomorrow,
  deadline: start + 1000, timeoutMs: 1000, partialOnDeadline: true });
  assert.deepEqual(budgets, [['v', 1000], ['w', 300]]);
});

async function cacheFixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'court-reference-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, input: { target, times: [], dates: [today], accountId: 'a' } };
}
test('桌面重开后保留结构、按账号隔离；缓存不包含满员等旧空位状态', async (t) => {
  const { dir, input } = await cacheFixture(t);
  await new ReferenceCatalogStore(dir).read({ ...input, api: { async getTimeList() { return [{ CODE: early }]; },
    async getOpeningRooms() { return [room('A', { disabled: true, text: '满员' })]; } } });
  const store = new ReferenceCatalogStore(dir), api = { async getTimeList() { return []; }, async getOpeningRooms() { return []; } };
  const cached = await store.read({ ...input, api });
  assert.deepEqual(cached.courts.map((c) => c.id), ['A']); assert.equal(cached.cached, true);
  assert.equal(cached.rooms[0].disabled, undefined); assert.equal(cached.rooms[0].text, undefined);
  assert.deepEqual((await store.read({ ...input, api, accountId: 'b' })).courts, []);
  const structure = await store.cachedRooms(input);
  assert.deepEqual(structure, [room('A')]);
  assert.deepEqual(await store.cachedRooms({ ...input, accountId: 'b' }), []);
  for (const changes of [{ sportCode: '002' }, { modeCode: '2.0' }, { campusCode: '2' }, { venues: [{ CGBM: 'w' }] }]) {
    assert.deepEqual(await store.cachedRooms({ ...input, target: { ...target, ...changes } }), []);
  }
});

test('不同日期同时刷新同一参考目录，不互相覆盖读到的新场地', async (t) => {
  const { dir, input } = await cacheFixture(t), store = new ReferenceCatalogStore(dir);
  let ready, releaseA, entered = 0;
  const both = new Promise((resolve) => ready = resolve), waitA = new Promise((resolve) => releaseA = resolve);
  const api = { async getTimeList() { if (++entered === 2) ready(); await both; return [{ CODE: early }]; },
    async getOpeningRooms({ date }) { if (date === today) await waitA; return [room(date === today ? 'A' : 'B')]; } };
  const a = store.read({ ...input, api }), b = store.read({ ...input, api, dates: [tomorrow] });
  await b; releaseA(); await a;
  const result = await new ReferenceCatalogStore(dir).read({ ...input, api: { async getTimeList() { return []; }, async getOpeningRooms() { return []; } } });
  assert.deepEqual(result.courts.map((c) => c.id).sort(), ['A', 'B']);
});
