import { SessionExpiredError } from './errors.js';
import { sleep } from './utils.js';

// A Date header has one-second resolution. Assuming it is generated during the
// request and truncates fractional seconds, its offset lies in this interval.
// This measures the HTTP server clock; a proxy/application clock can differ.
export function serverClockInterval(sample) {
  const { serverDateMs, startedAt, endedAt, age } = sample ?? {};
  if (age !== undefined && age !== null && age !== '' && (!/^\d+$/.test(String(age)) || Number(age) > 0)) {
    return { valid: false, reason: 'cached_response' };
  }
  if (!Number.isFinite(serverDateMs) || serverDateMs % 1000 !== 0) {
    return { valid: false, reason: 'missing_or_invalid_date' };
  }
  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt) || endedAt < startedAt) {
    return { valid: false, reason: 'invalid_request_timing' };
  }
  return { valid: true, lowerOffsetMs: serverDateMs - endedAt,
    upperOffsetMs: serverDateMs + 1000 - startedAt, rttMs: endedAt - startedAt };
}

export function intersectServerClockSamples(samples, { maxUncertaintyMs = 1000, priorEstimate } = {}) {
  const usedPrior = priorEstimate?.reliable === true && Number.isFinite(priorEstimate.lowerOffsetMs)
    && Number.isFinite(priorEstimate.upperOffsetMs) && priorEstimate.lowerOffsetMs < priorEstimate.upperOffsetMs;
  let lowerOffsetMs = usedPrior ? priorEstimate.lowerOffsetMs : -Infinity;
  let upperOffsetMs = usedPrior ? priorEstimate.upperOffsetMs : Infinity;
  for (const sample of samples) {
    const interval = serverClockInterval(sample);
    if (!interval.valid) return { reliable: false, offsetMs: 0, sampleCount: samples.length, reason: interval.reason };
    lowerOffsetMs = Math.max(lowerOffsetMs, interval.lowerOffsetMs);
    upperOffsetMs = Math.min(upperOffsetMs, interval.upperOffsetMs);
    if (lowerOffsetMs >= upperOffsetMs) {
      return { reliable: false, offsetMs: 0, sampleCount: samples.length, reason: 'conflicting_samples',
        ...(usedPrior ? { usedPrior: true } : {}) };
    }
  }
  const uncertaintyMs = upperOffsetMs - lowerOffsetMs;
  const enoughSamples = samples.length >= 2 || (usedPrior && samples.length >= 1);
  const reliable = enoughSamples && Number.isFinite(uncertaintyMs) && uncertaintyMs <= maxUncertaintyMs;
  return { reliable, offsetMs: reliable ? (lowerOffsetMs + upperOffsetMs) / 2 : 0,
    ...(samples.length ? { lowerOffsetMs, upperOffsetMs, uncertaintyMs,
      calibratedAt: samples.at(-1).endedAt, minRttMs: Math.min(...samples.map((sample) => sample.endedAt - sample.startedAt)) } : {}),
    sampleCount: samples.length, ...(usedPrior ? { usedPrior: true } : {}),
    ...(reliable ? {} : { reason: !enoughSamples ? 'insufficient_samples' : 'wide_uncertainty' }) };
}

// Five evenly spaced read-only requests cross a seconds boundary without a
// burst of polling. The intersection commonly narrows to ~250 ms plus RTT.
// Deadline and cancellation also bound adapters that ignore request options.
export async function estimateServerClock(api, { signal, deadline = Infinity, maxSamples = 5,
  intervalMs = 250, requestTimeoutMs = 1000, maxUncertaintyMs = 1000,
  priorEstimate, adaptiveBoundary = false, maxPriorAgeMs = 60_000,
  now = Date.now, pause = sleep } = {}) {
  const samples = [];
  const priorAge = now() - priorEstimate?.calibratedAt;
  const prior = priorEstimate?.reliable === true && priorAge >= 0 && priorAge <= maxPriorAgeMs
    && Number.isFinite(priorEstimate.lowerOffsetMs) && Number.isFinite(priorEstimate.upperOffsetMs)
    && priorEstimate.upperOffsetMs > priorEstimate.lowerOffsetMs
    && priorEstimate.upperOffsetMs - priorEstimate.lowerOffsetMs <= maxUncertaintyMs ? priorEstimate : undefined;
  const estimateOptions = { maxUncertaintyMs, priorEstimate: prior };
  let discardedPrior = false;
  const estimateCurrent = () => ({ ...intersectServerClockSamples(samples, estimateOptions),
    ...(discardedPrior ? { discardedPrior: true } : {}) });
  if (typeof api.sampleServerClock !== 'function') {
    return { reliable: false, offsetMs: 0, sampleCount: 0, reason: 'clock_sampling_unavailable' };
  }
  const count = Math.max(2, Math.min(6, Math.floor(Number(maxSamples) || 5)));
  const spacing = Math.max(100, Number(intervalMs) || 250);
  const timeout = Math.max(1, Number(requestTimeoutMs) || 1000);
  for (let i = 0; i < count; i++) {
    signal?.throwIfAborted();
    if (now() >= deadline) break;
    if (i > 0) {
      // Keep request start times apart; response latency already provides a gap.
      let nextStart = Math.max(now(), samples.at(-1).startedAt + spacing);
      const current = estimateCurrent();
      if (adaptiveBoundary && current.reliable) {
        // Aim message generation at the next whole server second. Each answer
        // then cuts one side of the interval, like binary search. Half the
        // shortest RTT is only a scheduling heuristic; the bounds themselves
        // still include the full RTT and require no symmetric network delay.
        const leadMs = current.minRttMs / 2;
        const nextSecond = Math.ceil((nextStart + current.offsetMs + leadMs) / 1000) * 1000;
        nextStart = nextSecond - current.offsetMs - leadMs;
      }
      const delay = Math.max(0, nextStart - now());
      if (now() + delay >= deadline) break;
      if (delay) await pause(delay, signal);
      signal?.throwIfAborted();
      if (now() >= deadline) break;
    }
    const sampleDeadline = Math.min(deadline, now() + timeout);
    const controller = new AbortController();
    let timer, abort;
    try {
      const ended = new Promise((_, reject) => {
        const fail = (reason) => { controller.abort(reason); reject(reason); };
        abort = () => fail(signal.reason ?? new DOMException('Aborted', 'AbortError'));
        signal?.addEventListener('abort', abort, { once: true });
        timer = setTimeout(() => fail(new DOMException('校时采样超时', 'TimeoutError')), Math.max(1, sampleDeadline - now()));
      });
      const sample = await Promise.race([
        api.sampleServerClock({ signal: controller.signal, deadline: sampleDeadline, timeoutMs: sampleDeadline - now() }), ended,
      ]);
      signal?.throwIfAborted();
      const interval = serverClockInterval(sample);
      if (!interval.valid) {
        const existing = estimateCurrent();
        return existing.reliable ? { ...existing, partial: true, sampleFailure: interval.reason }
          : { ...existing, reason: interval.reason };
      }
      samples.push(sample);
      let estimate = estimateCurrent();
      // A changed clock or HTTP node must not trap us in the old interval.
      // Discard that prior and require at least two mutually consistent fresh
      // samples before accepting the replacement.
      if (estimate.reason === 'conflicting_samples' && estimateOptions.priorEstimate) {
        estimateOptions.priorEstimate = undefined;
        discardedPrior = true;
        estimate = estimateCurrent();
      }
      if (['cached_response', 'missing_or_invalid_date', 'invalid_request_timing', 'conflicting_samples'].includes(estimate.reason)) {
        return estimate;
      }
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof SessionExpiredError) throw error;
      if (now() >= deadline || (sampleDeadline === deadline && error.name === 'TimeoutError')) {
        const estimate = estimateCurrent();
        return { ...estimate, ...(estimate.reliable ? { partial: true } : { reason: 'deadline' }) };
      }
      const estimate = estimateCurrent();
      return { ...estimate, partial: true, error: error.message,
        ...(estimate.reliable ? { sampleFailure: 'sample_failed' } : { reason: 'sample_failed' }) };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }
  const estimate = estimateCurrent();
  if (!estimate.reliable && now() >= deadline) estimate.reason = 'deadline';
  return estimate;
}
