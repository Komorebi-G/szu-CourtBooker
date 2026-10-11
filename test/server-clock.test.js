import test from 'node:test';
import assert from 'node:assert/strict';
import { SzuVenueApi } from '../shared/api.js';
import { SessionExpiredError } from '../shared/errors.js';
import { serverClockInterval, intersectServerClockSamples, estimateServerClock } from '../shared/server-clock.js';

const sample = (startedAt, endedAt, serverDateMs, extra = {}) => ({ startedAt, endedAt, serverDateMs, ...extra });

test('秒级 Date 的时钟偏差范围包含完整 RTT 和一秒量化误差', () => {
  const interval = serverClockInterval(sample(10010, 10170, 10000));
  assert.deepEqual(interval, { valid: true, lowerOffsetMs: -170, upperOffsetMs: 990, rttMs: 160 });
});

test('跨秒样本交集收窄不确定性，不假设上下行延迟对称', () => {
  const samples = [sample(10010, 10050, 10000), sample(10260, 10280, 10000),
    sample(10510, 10540, 10000), sample(10760, 10810, 11000), sample(11010, 11090, 11000)];
  const estimate = intersectServerClockSamples(samples);
  assert.equal(estimate.reliable, true);
  assert.equal(estimate.lowerOffsetMs, 190);
  assert.equal(estimate.upperOffsetMs, 490);
  assert.equal(estimate.offsetMs, 340);
  assert.equal(estimate.uncertaintyMs, 300);
  // A +320 ms server clock producing a header at any point of these
  // asymmetric request windows satisfies every interval.
  assert.ok(estimate.lowerOffsetMs <= 320 && estimate.upperOffsetMs > 320);
});

test('缺少 Date、无效时间、缓存和矛盾样本显式回退', () => {
  for (const [value, reason] of [[sample(0, 10, NaN), 'missing_or_invalid_date'],
    [sample(10, 5, 0), 'invalid_request_timing'], [sample(0, 10, 0, { age: '1' }), 'cached_response'],
    [sample(0, 10, 0, { age: '-1' }), 'cached_response']]) {
    const estimate = intersectServerClockSamples([value]);
    assert.equal(estimate.reliable, false);
    assert.equal(estimate.reason, reason);
    assert.equal(estimate.offsetMs, 0);
  }
  const cachedDate = intersectServerClockSamples([sample(0, 10, 0), sample(1200, 1210, 0)]);
  assert.equal(cachedDate.reason, 'conflicting_samples');
  assert.equal(cachedDate.reliable, false);
  assert.equal(intersectServerClockSamples([sample(0, 3000, 0), sample(200, 3200, 0)]).reason, 'wide_uncertainty');
});

test('单次采样不能宣称完成校时；Age:0 可正常用于交集', () => {
  assert.equal(intersectServerClockSamples([sample(0, 10, 0)]).reason, 'insufficient_samples');
  assert.equal(intersectServerClockSamples([sample(0, 10, 0, { age: '0' }), sample(250, 270, 0)]).reliable, true);
});

function simulatedClock({ start = 10010, offsetMs = 320, rttMs = 40, generationDelayMs = rttMs / 2 } = {}) {
  let localNow = start;
  const calls = [], waits = [];
  return { calls, waits, now: () => localNow,
    pause: async (ms) => { waits.push(ms); localNow += ms; },
    api: { async sampleServerClock(options) {
      calls.push({ at: localNow, options });
      const startedAt = localNow;
      const serverDateMs = Math.floor((startedAt + offsetMs + generationDelayMs) / 1000) * 1000;
      localNow += rttMs;
      return sample(startedAt, localNow, serverDateMs);
    } } };
}

test('默认五次采样间隔不小于 250 ms，跨秒获得可解释的范围', async () => {
  const clock = simulatedClock();
  const estimate = await estimateServerClock(clock.api, { now: clock.now, pause: clock.pause });
  assert.equal(clock.calls.length, 5);
  assert.deepEqual(clock.calls.map(({ at }) => at), [10010, 10260, 10510, 10760, 11010]);
  assert.equal(estimate.reliable, true);
  assert.equal(estimate.uncertaintyMs, 290);
  assert.ok(estimate.lowerOffsetMs <= 320 && estimate.upperOffsetMs > 320);
  assert.ok(clock.calls.every(({ options }) => options.timeoutMs <= 1000 && options.signal instanceof AbortSignal));
});

const prior = { reliable: true, lowerOffsetMs: 190, upperOffsetMs: 490, offsetMs: 340,
  uncertaintyMs: 300, calibratedAt: 10000, minRttMs: 40, sampleCount: 5 };

test('相同三次请求以已有范围瞄准秒跳变，误差由 300 ms 缩至 105 ms', async () => {
  const fixed = simulatedClock(), adaptive = simulatedClock();
  const options = { maxSamples: 3, intervalMs: 150, priorEstimate: prior };
  const fixedEstimate = await estimateServerClock(fixed.api, { ...options, now: fixed.now, pause: fixed.pause });
  const adaptiveEstimate = await estimateServerClock(adaptive.api, { ...options, adaptiveBoundary: true,
    now: adaptive.now, pause: adaptive.pause });
  assert.equal(fixed.calls.length, 3);
  assert.equal(adaptive.calls.length, 3);
  assert.equal(fixedEstimate.uncertaintyMs, 300);
  assert.equal(adaptiveEstimate.uncertaintyMs, 105);
  assert.equal(adaptiveEstimate.usedPrior, true);
  assert.ok(adaptiveEstimate.lowerOffsetMs <= 320 && adaptiveEstimate.upperOffsetMs > 320);
  assert.deepEqual(adaptive.calls.map(({ at }) => at), [10010, 10640, 11705]);
  assert.ok(adaptive.now() < 12700, '三个边界请求可在临近放号的截止时间内完成');
});

test('边界取样即使上下行延迟完全不对称，区间仍包含真实偏差', async () => {
  for (const generationDelayMs of [0, 100]) {
    const clock = simulatedClock({ rttMs: 100, generationDelayMs });
    const estimate = await estimateServerClock(clock.api, { maxSamples: 3, intervalMs: 150, priorEstimate: prior,
      adaptiveBoundary: true, now: clock.now, pause: clock.pause });
    assert.equal(estimate.reliable, true);
    assert.ok(estimate.lowerOffsetMs <= 320 && estimate.upperOffsetMs > 320);
    assert.ok(estimate.uncertaintyMs < prior.uncertaintyMs);
  }
});

test('超过一分钟的旧校时不会参与新范围交集', async () => {
  const clock = simulatedClock({ start: 80010 });
  const estimate = await estimateServerClock(clock.api, { maxSamples: 3, intervalMs: 150,
    // Contradictory bounds prove ignoring the old seed, beyond checking metadata.
    priorEstimate: { ...prior, lowerOffsetMs: 5000, upperOffsetMs: 5100 }, adaptiveBoundary: true,
    now: clock.now, pause: clock.pause });
  assert.equal(estimate.reliable, true);
  assert.equal(estimate.usedPrior, undefined);
  assert.ok(estimate.lowerOffsetMs <= 320 && estimate.upperOffsetMs > 320);
});

test('新 Date 与旧校时矛盾时丢弃旧范围并用新样本重建，截止后不伪造样本', async () => {
  const clock = simulatedClock();
  const conflict = await estimateServerClock(clock.api, { priorEstimate: { ...prior, lowerOffsetMs: 5000, upperOffsetMs: 5100 },
    adaptiveBoundary: true, now: clock.now, pause: clock.pause });
  assert.equal(conflict.reliable, true);
  assert.equal(conflict.discardedPrior, true);
  assert.equal(conflict.usedPrior, undefined);
  assert.ok(conflict.lowerOffsetMs <= 320 && conflict.upperOffsetMs > 320);
  assert.equal(clock.calls.length, 5);
  const expired = simulatedClock();
  const deadline = await estimateServerClock(expired.api, { priorEstimate: prior, adaptiveBoundary: true,
    deadline: expired.now(), now: expired.now, pause: expired.pause });
  assert.equal(deadline.reliable, false);
  assert.equal(deadline.reason, 'deadline');
  assert.equal(expired.calls.length, 0);
  const limited = simulatedClock();
  const partial = await estimateServerClock(limited.api, { priorEstimate: prior, adaptiveBoundary: true,
    deadline: 10500, now: limited.now, pause: limited.pause });
  assert.equal(limited.calls.length, 1);
  assert.equal(partial.reliable, true);
  assert.equal(partial.calibratedAt, 10050);
  assert.ok(limited.now() < 10500);
});

test('已到截止时间不发请求，无法完成下一间隔时保留有效的部分估计', async () => {
  const expired = simulatedClock();
  assert.equal((await estimateServerClock(expired.api, { deadline: expired.now(), now: expired.now, pause: expired.pause })).reason, 'deadline');
  assert.equal(expired.calls.length, 0);
  const clock = simulatedClock();
  const estimate = await estimateServerClock(clock.api, { deadline: 10600, now: clock.now, pause: clock.pause });
  assert.equal(clock.calls.length, 3);
  assert.equal(estimate.reliable, true);
  assert.ok(clock.calls.every(({ options }) => options.deadline <= 10600));
});

test('deadline 限制不响应的适配器，不等待默认网络超时', async () => {
  const start = Date.now();
  const api = { sampleServerClock: async () => new Promise(() => {}) };
  const estimate = await estimateServerClock(api, { deadline: start + 20, requestTimeoutMs: 1000 });
  assert.equal(estimate.reliable, false);
  assert.equal(estimate.reason, 'deadline');
  assert.ok(Date.now() - start < 500);
});

test('在途校时取消立即传播并取消底层只读请求', async () => {
  const controller = new AbortController();
  const stopped = new Error('停止本次执行');
  let requestSignal;
  const pending = estimateServerClock({ sampleServerClock: async ({ signal }) => {
    requestSignal = signal;
    return new Promise(() => {});
  } }, { signal: controller.signal });
  controller.abort(stopped);
  await assert.rejects(pending, (error) => error === stopped);
  assert.equal(requestSignal.aborted, true);
});

test('校时失败可回退，登录失效仍由执行器处理', async () => {
  const network = await estimateServerClock({ sampleServerClock: async () => { throw new TypeError('network'); } });
  assert.equal(network.reliable, false);
  assert.equal(network.reason, 'sample_failed');
  const expired = new SessionExpiredError('session');
  await assert.rejects(estimateServerClock({ sampleServerClock: async () => { throw expired; } }), (error) => error === expired);
});

test('API 校时传递取消和截止时间，旧偏差接口不再把缺少 Date 伪装成零偏差', async () => {
  let options;
  const api = new SzuVenueApi({ post: async (_path, _form, passed) => {
    options = passed;
    return { date: 'Thu, 01 Oct 2026 04:00:00 GMT', startedAt: 100, endedAt: 200, age: '0' };
  } });
  const deadline = Date.now() + 500;
  const signal = new AbortController().signal;
  const value = await api.sampleServerClock({ signal, deadline, timeoutMs: 1000 });
  assert.equal(value.serverDateMs, Date.parse('2026-10-01T04:00:00Z'));
  assert.equal(options.signal, signal);
  assert.equal(options.deadlineMs, deadline);
  assert.equal(options.abortInFlight, true);
  assert.ok(options.timeoutMs > 0 && options.timeoutMs <= 500);
  assert.equal(value.age, '0');
  api.client.post = async () => ({ startedAt: 100, endedAt: 200 });
  await assert.rejects(api.sampleServerOffset(), /missing_or_invalid_date/);
});

test('API 截止/取消后不派发任何校时请求', async () => {
  let calls = 0;
  const api = new SzuVenueApi({ post: async () => { calls++; } });
  await assert.rejects(api.sampleServerClock({ deadline: Date.now() }), { name: 'TimeoutError' });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(api.sampleServerClock({ signal: controller.signal }), { name: 'AbortError' });
  assert.equal(calls, 0);
});
