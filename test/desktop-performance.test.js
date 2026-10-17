import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { LiveExecution } from '../desktop/src/execution.js';
import { DiagnosticJournal, readDiagnosticJournal } from '../desktop/src/diagnostics.js';
import { readJson, writeJson } from '../desktop/src/jobs.js';
import { addDays, shanghaiDate, sleep } from '../shared/utils.js';

const early = '19:00-20:00', late = '20:00-21:00';
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const metadata = {
  campusList: [{ XQDM: '1', XQDM_DISPLAY: '粤海校区' }],
  xmList: ['001', '002'].map((XMDM) => ({ XQDM: '1', XMDM, XMMC: XMDM, DCFS: '1.0' })),
  packageVenueList: [{ SSXQ: '1', XM: '001,002', CGBM: 'v', CGMC: '东馆' }],
};
const court = (id = 'A', sport = '001') => ({ WID: id, CDMC: id, CGBM: 'v', XMDM: sport, XQDM: '1' });

async function laboratory(t, { book, identity, rooms = (input) => [court('A', input.sportCode)] } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'szu-account-lanes-'));
  const calls = [];
  const live = new LiveExecution({ dataDir, createApi: async (_path, _signal, account) => ({
    client: { async flush() {} },
    api: {
      async getIdentity() { return await identity?.(account, _path) ?? { id: account, name: account }; },
      async getSportVenueData() { return metadata; },
      async getAllBookings() { return []; },
      async sampleServerOffset() { return 0; },
      async getAvailableDates() { return []; },
      async getOpeningRooms(input) { return rooms(input, account); },
      async book(input) {
        const call = { account, time: input.time, room: input.room, sport: input.room.XMDM };
        calls.push(call);
        input.onDispatch?.({ startedAt: Date.now() });
        return await book?.(input, call) ?? { code: '0', data: { DHID: `order-${calls.length}` } };
      },
    },
  }) });
  t.after(async () => { await live.close(); await rm(dataDir, { recursive: true, force: true }); });
  async function job(account, { times = [early], sport = '001', mode = 'now', releaseAt = Date.now(),
    courts = ['A'], alias = randomUUID() } = {}) {
    const dir = join(dataDir, 'jobs', randomUUID()); await mkdir(dir, { recursive: true });
    await writeJson(join(dir, 'job.json'), { mode, releaseAt, sessionPath: alias, accountId: alias,
      accountIdentityId: account, config: { targets: [{ name: account, campus: '1', sport, mode: '包场',
        date: addDays(shanghaiDate(), 1), venues: ['v'], courts, times, preferSameCourt: true }],
      scheduler: { timeoutMs: 3000, pollIntervalMs: 50, queryConcurrency: 2 }, booking: { taskConcurrency: 2 } } });
    await writeJson(join(dir, 'state.json'), { status: 'queued', logs: [], successes: [] });
    return dir;
  }
  return { live, calls, job };
}

test('桌面不同学校账号：账号 A 响应停滞时，账号 B 已提交并保存成功', { timeout: 4000 }, async (t) => {
  const entered = deferred(), response = deferred();
  t.after(() => response.resolve());
  const f = await laboratory(t, { book: async (_input, { account }) => {
    if (account === 'A') { entered.resolve(); await response.promise; }
  } });
  const a = await f.job('A'), b = await f.job('B');
  const first = f.live.start(a); await entered.promise;
  await f.live.start(b);
  assert.deepEqual(f.calls.map((call) => call.account), ['A', 'B']);
  assert.equal((await readJson(join(b, 'state.json'))).status, 'success');
  assert.ok(f.live.active.has(a), 'A 的响应仍未返回，B 不应等待它');
  response.resolve(); await first;
});

test('桌面同学校账号不同本地标签：另一个项目也要等待当前 POST 的可靠结果', { timeout: 4000 }, async (t) => {
  const entered = deferred(), response = deferred(), siblingReady = deferred();
  let a;
  t.after(() => response.resolve());
  const f = await laboratory(t, {
    rooms: (input) => { if (input.sportCode === '002') siblingReady.resolve(); return [court('A', input.sportCode)]; },
    book: async (_input, { sport }) => {
      if (sport === '001') { entered.resolve(); await response.promise; }
      else assert.equal((await readJson(join(a, 'state.json'))).successes.length, 1,
        '下一 POST 发出前，前一单明确成功已经可靠保存');
    },
  });
  a = await f.job('same-user'); const b = await f.job('same-user', { sport: '002', times: [late] });
  const first = f.live.start(a); await entered.promise;
  const second = f.live.start(b); await siblingReady.promise; await sleep(30);
  assert.equal(f.calls.length, 1, '真实身份相同的 POST 不应因本地账号标签不同而并发');
  response.resolve(); await Promise.all([first, second]);
  assert.deepEqual(f.calls.map((call) => call.sport), ['001', '002']);
  assert.equal((await readJson(join(a, 'state.json'))).successes.length, 1);
  assert.equal((await readJson(join(b, 'state.json'))).successes.length, 1);
});

test('桌面账号 A 首单未知：停止 A 的其他项目，账号 B 仍能保存首单并提交后一时段', { timeout: 4000 }, async (t) => {
  const aEntered = deferred(), aResponse = deferred(), siblingReady = deferred();
  const bEntered = deferred(), bResponse = deferred();
  t.after(() => { aResponse.resolve(); bResponse.resolve(); });
  const f = await laboratory(t, {
    rooms: (input, account) => {
      if (account === 'A' && input.sportCode === '002') siblingReady.resolve();
      return [court('A', input.sportCode)];
    },
    book: async (_input, { account, time }) => {
      if (account === 'A') { aEntered.resolve(); await aResponse.promise; throw new Error('受控响应丢失'); }
      if (time === early) { bEntered.resolve(); await bResponse.promise; }
    },
  });
  const a = await f.job('A'), sibling = await f.job('A', { sport: '002', times: [late] });
  const b = await f.job('B', { times: [early, late] });
  const first = f.live.start(a); await aEntered.promise;
  const otherA = f.live.start(sibling); await siblingReady.promise;
  const otherB = f.live.start(b); await bEntered.promise;
  aResponse.resolve(); await Promise.all([first, otherA]);
  assert.equal(f.live.active.get(b).controller.signal.aborted, false);
  assert.equal(f.calls.filter((call) => call.account === 'A').length, 1);
  assert.equal(Object.keys((await readJson(join(a, 'state.json'))).pendingRequests).length, 1);
  assert.deepEqual((await readJson(join(sibling, 'state.json'))).pendingRequests, {});
  bResponse.resolve(); await otherB;
  assert.deepEqual(f.calls.filter((call) => call.account === 'B').map((call) => call.time), [early, late]);
  assert.equal((await readJson(join(b, 'state.json'))).successes.length, 2);
});

test('桌面账号 A 结果保存失败：停止正在准备的账号 B，保留 A 的已知成功', { timeout: 4000 }, async (t) => {
  const aEntered = deferred(), aResponse = deferred(), bReady = deferred(), bRooms = deferred();
  t.after(() => { aResponse.resolve(); bRooms.resolve(); });
  const f = await laboratory(t, {
    rooms: async (input, account) => {
      if (account === 'B') { bReady.resolve(); await bRooms.promise; }
      return [court('A', input.sportCode)];
    },
    book: async (_input, { account }) => {
      if (account === 'A') { aEntered.resolve(); await aResponse.promise; }
    },
  });
  const a = await f.job('A'), b = await f.job('B');
  const first = f.live.start(a); await aEntered.promise;
  const other = f.live.start(b); await bReady.promise;
  await rename(join(a, 'state.json'), join(a, 'state.before-failure.json'));
  await mkdir(join(a, 'state.json'));
  aResponse.resolve(); await Promise.allSettled([first]);
  assert.equal(f.live.active.get(b).controller.signal.aborted, true);
  bRooms.resolve(); await other;
  assert.deepEqual(f.calls.map((call) => call.account), ['A']);
  assert.equal(f.live.failures.get(a).executionState.successes.length, 1);
  assert.equal(f.live.failures.get(a).executionState.metrics.successes, 1);
  assert.equal(f.live.failures.get(a).executionState.metrics.unknown, 0);
  assert.equal(f.live.failures.get(a).executionState.slots[0].lastOutcome, 'success');
  assert.match((await readJson(join(b, 'state.json'))).error, /保存异常/);
});

test('桌面尚未识别身份的坏任务：不会停止账号 B 已发出的预约', { timeout: 4000 }, async (t) => {
  const entered = deferred(), response = deferred();
  t.after(() => response.resolve());
  const f = await laboratory(t, { book: async () => { entered.resolve(); await response.promise; } });
  const b = await f.job('B'), broken = await f.job('unknown');
  const work = f.live.start(b); await entered.promise;
  await rm(join(broken, 'job.json'));
  await assert.rejects(f.live.start(broken), { code: 'ENOENT' });
  assert.equal(f.live.active.get(b).controller.signal.aborted, false);
  response.resolve(); await work;
  assert.equal((await readJson(join(b, 'state.json'))).status, 'success');
});

test('桌面慢诊断日志：持久预约意图和 POST 不等追加日志，结束时仍写完全部事件', { timeout: 4000 }, async (t) => {
  const logStarted = deferred(), logResponse = deferred(), submitted = deferred();
  const append = DiagnosticJournal.prototype.append;
  t.mock.method(DiagnosticJournal.prototype, 'append', async function (entry) {
    logStarted.resolve(); await logResponse.promise; return append.call(this, entry);
  });
  t.after(() => logResponse.resolve());
  const f = await laboratory(t, { book: async () => submitted.resolve() });
  const dir = await f.job('A'), work = f.live.start(dir);
  await logStarted.promise; await submitted.promise;
  const saved = await readJson(join(dir, 'state.json'));
  assert.equal(Object.keys(saved.pendingRequests).length, 1, '发单前仍有持久化预约意图');
  logResponse.resolve(); await work;
  const events = await readDiagnosticJournal(dir);
  assert.ok(events.some((entry) => entry.details?.event === 'booking_request'));
  assert.ok(events.some((entry) => entry.details?.event === 'booking_response'));
  assert.ok(events.some((entry) => entry.details?.event === 'execution_summary'));
});

async function waitForPrepared(dir, releaseAt) {
  while (Date.now() < releaseAt) {
    const state = await readJson(join(dir, 'state.json'));
    const intent = Object.values(state.pendingRequests ?? {})[0];
    if (intent?.preparedAt) return intent;
    await sleep(5);
  }
  assert.fail('应在放号前写完首单意图');
}

for (const changeCandidate of [false, true]) {
  test(`桌面预写首单意图：${changeCandidate ? '候选变化必须重新持久化' : '匹配候选到点复用已写意图'}`, { timeout: 4000 }, async (t) => {
    const selected = court();
    let dir, observed;
    const f = await laboratory(t, { rooms: () => [selected], book: async (input) => {
      observed = Object.values((await readJson(join(dir, 'state.json'))).pendingRequests)[0];
      assert.equal(observed.room.WID, input.room.WID);
      assert.equal(observed.modeCode, input.modeCode);
      assert.equal(observed.time, input.time);
      const marker = await readJson(join(dir, 'dispatch.json'));
      const dispatched = Object.values(marker.pendingRequests)[0];
      assert.equal(dispatched.room.WID, input.room.WID);
      assert.ok(dispatched.sentAt, '预写意图复用时仍必须先持久化小型发送标记');
    } });
    const releaseAt = Date.now() + 800;
    dir = await f.job('A', { mode: 'release', releaseAt, courts: ['A', 'B'] });
    const work = f.live.start(dir);
    const prepared = await waitForPrepared(dir, releaseAt);
    assert.equal(prepared.room.WID, 'A'); assert.equal(f.calls.length, 0);
    if (changeCandidate) { selected.WID = 'B'; selected.CDMC = 'B'; }
    await work;
    assert.equal(f.calls.length, 1);
    if (changeCandidate) assert.ok(observed.sentAt, '变化的候选需要完成本次意图写入后才发单');
    else {
      assert.equal(observed.preparedAt, prepared.preparedAt);
      assert.equal(observed.sentAt, undefined, '匹配首单无需到点再写一遍发送状态');
    }
    assert.deepEqual((await readJson(join(dir, 'state.json'))).pendingRequests, {});
  });
}

test('桌面放号前停止：预写但从未提交的首单意图应清除', { timeout: 4000 }, async (t) => {
  const f = await laboratory(t);
  const releaseAt = Date.now() + 800, dir = await f.job('A', { mode: 'release', releaseAt });
  const work = f.live.start(dir); await waitForPrepared(dir, releaseAt);
  f.live.stop(dir); await work;
  const state = await readJson(join(dir, 'state.json'));
  assert.equal(f.calls.length, 0); assert.equal(state.status, 'stopped');
  assert.deepEqual(state.pendingRequests, {});
});

test('桌面旧账号错误结束后，新执行不被无关账号的长执行拦住', { timeout: 4000 }, async (t) => {
  const aEntered = deferred(), aResponse = deferred(), bEntered = deferred(), bResponse = deferred();
  let failA = true;
  t.after(() => { aResponse.resolve(); bResponse.resolve(); });
  const f = await laboratory(t, { book: async (_input, { account }) => {
    if (account === 'A' && failA) { aEntered.resolve(); await aResponse.promise; throw new Error('响应丢失'); }
    if (account === 'B') { bEntered.resolve(); await bResponse.promise; }
  } });
  const firstA = await f.job('A'), b = await f.job('B');
  const failed = f.live.start(firstA); await aEntered.promise;
  const waiting = f.live.start(b); await bEntered.promise;
  aResponse.resolve(); await failed;
  assert.equal(f.live.haltedAccounts.has('A'), false);
  failA = false;
  const fresh = await f.job('A', { times: [late] });
  await f.live.start(fresh);
  assert.equal((await readJson(join(fresh, 'state.json'))).successes.length, 1);
  assert.ok(f.live.active.has(b)); bResponse.resolve(); await waiting;
});

test('旧同账号方案尚未读到身份时，也不能越过本轮未知结果停止标记', { timeout: 4000 }, async (t) => {
  const entered = deferred(), response = deferred(), identityEntered = deferred(), identityResponse = deferred();
  t.after(() => { response.resolve(); identityResponse.resolve(); });
  const f = await laboratory(t, { identity: async (account, path) => {
    if (path === 'slow-identity') { identityEntered.resolve(); await identityResponse.promise; }
    return { id: account, name: account };
  }, book: async (_input, { sport }) => {
    if (sport === '001') { entered.resolve(); await response.promise; throw new Error('响应丢失'); }
  } });
  const first = await f.job('A'), sibling = await f.job('A', { sport: '002', times: [late], alias: 'slow-identity' });
  const work = f.live.start(first); await entered.promise;
  const other = f.live.start(sibling); await identityEntered.promise;
  response.resolve(); await work; identityResponse.resolve(); await other;
  assert.equal(f.calls.length, 1);
  assert.match((await readJson(join(sibling, 'state.json'))).error, /待确认/);
});

test('学校明确冻结账号后，仍在核对身份的旧跨项目方案不能绕过停止状态', { timeout: 4000 }, async t => {
  const entered = deferred(), response = deferred(), identityEntered = deferred(), identityResponse = deferred();
  t.after(() => { response.resolve(); identityResponse.resolve(); });
  const f = await laboratory(t, { identity: async (account, path) => {
    if (path === 'slow-identity') { identityEntered.resolve(); await identityResponse.promise; }
    return { id: account, name: account };
  }, book: async () => { entered.resolve(); await response.promise; return { code: '1', msg: '账号冻结' }; } });
  const first = await f.job('A'), sibling = await f.job('A', { sport: '002', times: [late], alias: 'slow-identity' });
  const work = f.live.start(first); await entered.promise;
  const other = f.live.start(sibling); await identityEntered.promise;
  response.resolve(); await work; identityResponse.resolve(); await other;
  assert.equal(f.calls.length, 1);
  assert.match((await readJson(join(sibling, 'state.json'))).error, /账号冻结/);
  assert.deepEqual((await readJson(join(first, 'state.json'))).pendingRequests, {});
});

test('发单前意图保存失败，不把确定未发送的预约计为未知结果', { timeout: 4000 }, async (t) => {
  let dir, broken = false;
  const f = await laboratory(t, { rooms: async () => {
    if (!broken) {
      broken = true; await rename(join(dir, 'state.json'), join(dir, 'before-save-failure.json'));
      await mkdir(join(dir, 'state.json'));
    }
    return [court()];
  } });
  dir = await f.job('A'); await Promise.allSettled([f.live.start(dir)]);
  assert.equal(f.calls.length, 0);
  const state = f.live.failures.get(dir).executionState;
  assert.equal(state.metrics.unknown, 0); assert.deepEqual(state.pendingRequests, {});
});
