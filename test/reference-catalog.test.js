import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCourtCatalog, readReferenceCatalog, referenceDates } from '../shared/catalog.js';
import { SzuVenueApi } from '../shared/api.js';
import { SchoolQueryError, SessionExpiredError, HttpResponseError } from '../shared/errors.js';
import { ReferenceCatalogStore } from '../desktop/src/catalogs.js';
import { runBooking } from '../shared/runner.js';
import { referenceCourtStatus, referenceCatalogHint } from '../shared/experience.js';

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
  const status = (id, date, times = [early]) => referenceCourtStatus(catalog, catalog.courts.find(c => c.id === id), date, times);
  assert.equal(status('A', today).state, 'unavailable');
  assert.equal(status('A', tomorrow).state, 'available');
  assert.equal(status('B', today).state, 'missing');
  assert.equal(status('B', tomorrow, [early, late]).state, 'partial');
  assert.equal(status('B', tomorrow, [late]).state, 'available', '按所选时段更新，不能沿用其他时段的空位');
  assert.match(referenceCatalogHint(catalog, today, [early]), /查询不可用：A.*当天未返回：B/);
});

test('场地全集保留历史场地，按确切日期提示历史不可用，不能拿周五结果判断周六', async () => {
  const at = Date.parse('2026-10-10T10:00:00+08:00');
  const cached = { date: today, times: [early], courts: [{ id: 'OLD', name: '历史4号场', venueCode: 'v' }], rooms: [room('OLD')],
    history: [{ date: today, time: early, venueCode: 'v', checkedAt: at, available: [], unavailable: ['OLD'] }] };
  const catalog = await reference({ async getTimeList() { return [{ CODE: early }]; },
    async getOpeningRooms() { throw new SchoolQueryError({ kind: 'wait', scope: 'release', message: '尚未放号' }); } }, { cached });
  const court = catalog.courts[0];
  assert.equal(referenceCourtStatus(catalog, court, today, [early]).state, 'history');
  assert.match(referenceCourtStatus(catalog, court, today, [early]).label, /历史当日查询不可用/);
  const saturday = referenceCourtStatus(catalog, court, tomorrow, [early]);
  assert.equal(saturday.state, 'history'); assert.equal(saturday.label, '仅历史目录');
  assert.match(saturday.detail, /2026-10-11 曾返回不可用/);
  assert.match(referenceCatalogHint(catalog, tomorrow, [early]), /未查完整，未查到不等于不可用/);
  assert.equal(catalog.views.length, 0, '失败查询不生成不可用或缺席证据');
});

test('历史场地当天未返回时仍保留可选，并同时给出当天查询与历史来源', async () => {
  const yesterday = '2026-10-10', at = Date.parse(yesterday + 'T09:00:00+08:00');
  const catalog = await reference({ async getTimeList() { return [{ CODE: early }]; }, async getOpeningRooms() { return [room('A')]; } },
    { cached: { times: [early], courts: [{ id: 'OLD', name: '历史4号场', venueCode: 'v' }], rooms: [room('OLD')],
      history: [{ date: yesterday, time: early, venueCode: 'v', checkedAt: at, available: ['OLD'], unavailable: [] }] } });
  assert.deepEqual(catalog.courts.map(court => court.id), ['A', 'OLD']);
  const status = referenceCourtStatus(catalog, catalog.courts[1], today, [early]);
  assert.equal(status.state, 'missing'); assert.equal(status.historical, true);
  assert.match(status.detail, /未返回.*历史.*2026-10-10 曾有可用时段/);
  const pending = referenceCourtStatus(catalog, { id: '4号排球场（包场）', pendingName: true }, tomorrow, [early]);
  assert.equal(pending.label, '等待目标日期查询确认'); assert.equal(pending.historical, false);
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

test('参考目录始终优先查询所选日期并合并今天明天，不受放号时间限制', (t) => {
  t.mock.timers.setTime(Date.parse(today + 'T12:00:00+08:00'));
  assert.deepEqual(referenceDates('2026-10-13'), ['2026-10-13', today, tomorrow]);
  assert.deepEqual(referenceDates(tomorrow), [tomorrow, today]);
  assert.deepEqual(referenceDates(today), [today, tomorrow]);
  t.mock.timers.setTime(Date.parse(today + 'T12:30:00+08:00'));
  assert.deepEqual(referenceDates('2026-10-13'), ['2026-10-13', today, tomorrow]);
  assert.deepEqual(referenceDates(tomorrow), [tomorrow, today]);
});

test('周五放号前，今天只返回部分包场场地，明天周末独有场地仍可首次发现并保存', async (t) => {
  const friday = '2026-10-23', saturday = '2026-10-24';
  t.mock.timers.setTime(Date.parse(friday + 'T10:00:00+08:00'));
  const { dir } = await cacheFixture(t), calls = [];
  const store = new ReferenceCatalogStore(dir);
  const catalog = await store.read({ accountId: 'a', target, times: [], dates: referenceDates(saturday), api: {
    async getTimeList({ date, modeCode }) {
      assert.equal(modeCode, '1.0');
      return (date === saturday ? [early, late] : [early]).map(CODE => ({ CODE }));
    },
    async getOpeningRooms({ date, time, modeCode }) {
      calls.push([date, time]); assert.equal(modeCode, '1.0');
      return date === saturday && time === late ? [room('WEEKEND')] : [room('WEEKDAY')];
    },
  } });
  assert.equal(catalog.date, saturday);
  assert.deepEqual(catalog.dates, [saturday, friday]);
  assert.deepEqual(catalog.courts.map(c => c.id).sort(), ['WEEKDAY', 'WEEKEND']);
  assert.deepEqual(catalog.times, [early, late]);
  assert.deepEqual(calls, [[saturday, early], [saturday, late], [friday, early], [friday, late]]);
  assert.deepEqual((await new ReferenceCatalogStore(dir).cachedRooms({ accountId: 'a', target })).map(r => r.WID).sort(),
    ['WEEKDAY', 'WEEKEND'], '周中缺少的场地必须能在冷启动时发现，重开后仍保留');
  const persisted = JSON.parse(await readFile(join(store.dir, (await readdir(store.dir))[0]), 'utf8'));
  assert.equal(persisted.views, undefined); assert.equal(persisted.history.length, 4);
});

test('所选周末在后天时仍直接查询，不依赖今天明天或已有周末缓存', async (t) => {
  const thursday = '2026-10-22', friday = '2026-10-23', saturday = '2026-10-24', dates = [];
  t.mock.timers.setTime(Date.parse(thursday + 'T10:00:00+08:00'));
  const catalog = await readReferenceCatalog({ target, times: [], dates: referenceDates(saturday), api: {
    async getTimeList() { return [{ CODE: early }]; },
    async getOpeningRooms({ date }) { dates.push(date); return [room(date === saturday ? 'WEEKEND' : 'WEEKDAY')]; },
  } });
  assert.deepEqual(dates, [saturday, thursday, friday]);
  assert.deepEqual(catalog.courts.map(c => c.id).sort(), ['WEEKDAY', 'WEEKEND']);
});

test('目标日期明确未开放时仍展示其他日期参考；只读检查不因此提前提交', async (t) => {
  const friday = '2026-10-23', saturday = '2026-10-24', queries = [];
  t.mock.timers.setTime(Date.parse(friday + 'T10:00:00+08:00'));
  const api = { async getTimeList({ date }) {
    if (date === saturday) throw new SchoolQueryError({ kind: 'wait', scope: 'release', message: '该预约日期暂未开放预约' });
    return [{ CODE: early }];
  }, async getOpeningRooms({ date }) {
    queries.push(date);
    if (date === saturday) throw new SchoolQueryError({ kind: 'wait', scope: 'release', message: '该预约日期暂未开放预约' });
    return [room('A')];
  }, async book() { assert.fail('读取周末目录和检查配置均不得提前下单'); } };
  const catalog = await readReferenceCatalog({ api, target, dates: referenceDates(saturday), times: [] });
  assert.deepEqual(queries, [saturday, friday]);
  assert.deepEqual(catalog.courts.map(c => c.id), ['A']); assert.equal(catalog.partial, true);
  const result = await runBooking({ api, client: { async flush() {} }, date: saturday, live: false, immediate: true, log() {},
    targets: [{ ...target, courtNames: ['A'] }], config: { scheduler: { queryConcurrency: 1 }, booking: {} } });
  assert.equal(result.ok, true); assert.equal(result.successes.length, 0);
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
