import { sleep } from './utils.js';
import { RequestNotSentError } from './errors.js';
import { classifyBookingResponse } from './booking-outcome.js';
import { RequestQueue } from './request-queue.js';

// One school's account shares its cooldown across queries, slots and plans.
// This gate schedules a dispatch; it never replays a request.
export class RequestGate {
  constructor({ backoffMs = 1000, maxBackoffMs = 30000, now = () => performance.now() } = {}) {
    Object.assign(this, { backoffMs, maxBackoffMs, now });
    this.cooldownUntil = 0; this.cooldownDeadline = -Infinity;
    this.lastDispatchAt = -Infinity; this.failures = 0; this.rejectedAt = -Infinity;
    this.mutations = new RequestQueue();
  }
  runMutation(operation) { return this.mutations.run(operation); }
  absorb(other) {
    if (!other || other === this) return;
    if (other.cooldownDeadline > this.cooldownDeadline) {
      this.cooldownDeadline = other.cooldownDeadline; this.cooldownUntil = other.cooldownUntil;
    }
    this.lastDispatchAt = Math.max(this.lastDispatchAt, other.lastDispatchAt);
    if (other.rejectedAt > this.rejectedAt) {
      this.rejectedAt = other.rejectedAt; this.failures = other.failures; this.message = other.message;
    }
  }
  reject(message, retryAfterMs = 0) {
    const now = this.now();
    this.failures = now - this.rejectedAt < 60000 ? this.failures + 1 : 1;
    this.rejectedAt = now; this.message = message;
    const delay = Math.max(retryAfterMs, Math.min(this.maxBackoffMs, this.backoffMs * 2 ** Math.min(8, this.failures - 1)));
    this.cooldownDeadline = Math.max(this.cooldownDeadline, now + delay);
    this.cooldownUntil = Date.now() + this.remainingMs();
    return delay;
  }
  remainingMs() { return Math.max(0, this.cooldownDeadline - this.now()); }
  observe(data, { status, retryAfter, mutation = false } = {}) {
    let outcome;
    if (typeof data?.code === 'string' && data.code.trim()) outcome = classifyBookingResponse(data);
    if (status === 429 || ['rate', 'server'].includes(outcome?.scope)) {
      const seconds = Number(retryAfter);
      const hint = retryAfter ? Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000
        : Math.max(0, Date.parse(retryAfter) - Date.now()) || 0 : 0;
      return this.reject(outcome?.message || '学校限制请求频率（HTTP 429）', hint);
    }
    // A successful query must not reset a series of rejected booking attempts.
    if (mutation && outcome && ['success', 'retry', 'wait'].includes(outcome.kind)) this.failures = 0;
    return 0;
  }
  async wait({ signal, deadline = Infinity, intervalMs = 0, reserve = true, onWait = () => {} } = {}) {
    let reported;
    while (true) {
      if (signal?.aborted) throw new RequestNotSentError('本次操作已停止，未发送请求');
      const now = Date.now();
      if (now >= deadline) throw new RequestNotSentError('执行窗口已结束，未发送请求');
      const delay = Math.max(this.remainingMs(), reserve ? this.lastDispatchAt + intervalMs - this.now() : 0);
      if (delay <= 0) {
        if (reserve) this.lastDispatchAt = this.now();
        return;
      }
      if (this.remainingMs() > 0 && reported !== this.cooldownUntil) {
        reported = this.cooldownUntil;
        onWait({ activity: 'cooldown', retryAt: this.cooldownUntil, message: this.message });
      }
      try { await sleep(Math.min(delay, deadline - now), signal); }
      catch (error) { if (signal?.aborted) throw new RequestNotSentError('本次操作已停止，未发送请求'); throw error; }
    }
  }
}
