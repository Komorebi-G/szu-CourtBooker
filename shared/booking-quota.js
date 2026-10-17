// Count this batch and freshly confirmed school orders. Local history alone
// cannot establish occupancy: those orders may have been cancelled at school.
import { sleep, splitTimeSlot } from './utils.js';
import { isTransientQueryError } from './errors.js';
import { RequestQueue } from './request-queue.js';
import { RequestGate } from './request-gate.js';

export class BookingQuota {
  constructor({ onAccountStop = () => {} } = {}) {
    this.onAccountStop = onAccountStop;
    this.slots = new Map(); this.queues = new Map(); this.booked = new Map();
    this.errors = new Map(); this.preparations = new Map();
    this.users = new Map(); this.usedScopes = new Set();
    this.inFlight = new Map();
    this.requestGates = new Map();
    this.accountErrors = new Map(); this.rateRejections = new Map();
  }
  requestGate(account) {
    if (!this.requestGates.has(account)) this.requestGates.set(account, new RequestGate());
    return this.requestGates.get(account);
  }
  key(account, sport, date) { return JSON.stringify([account, sport, date]); }
  seed(key, time, success) {
    if (!this.slots.has(key)) this.slots.set(key, new Set());
    this.slots.get(key).add(time);
    if (success) {
      if (!this.booked.has(key)) this.booked.set(key, new Map());
      this.booked.get(key).set(time, success);
    }
  }
  get(key, time) { return this.booked.get(key)?.get(time); }
  replaceSchoolBookings(key, bookings) {
    // A later complete school snapshot replaces earlier school observations.
    // Keep this batch's confirmed submissions even if school listing lags.
    for (const [time, success] of this.booked.get(key) ?? []) {
      if (!success.school) continue;
      this.booked.get(key).delete(time); this.slots.get(key)?.delete(time);
    }
    for (const { time, ...success } of bookings) {
      if (!this.get(key, time)) this.seed(key, time, { ...success, school: true });
    }
  }
  remaining(key) { return Math.max(0, 2 - (this.slots.get(key)?.size ?? 0)); }
  full(key) { return this.remaining(key) === 0; }
  pending(key) { return [...this.inFlight.get(key) ?? []]; }
  open(key) {
    // An unrelated waiting plan must not keep a finished scope's old orders or
    // rejection cached for a later manual start. Only overlapping runs share it.
    if (!this.users.get(key) && this.usedScopes.has(key)) {
      for (const map of [this.slots, this.booked, this.errors, this.preparations, this.inFlight]) map.delete(key);
    }
    this.usedScopes.add(key);
    this.users.set(key, (this.users.get(key) ?? 0) + 1);
    return () => this.users.set(key, this.users.get(key) - 1);
  }
  account(key) {
    try { const parts = JSON.parse(key); if (Array.isArray(parts) && parts.length === 3) return parts[0]; }
    catch { /* Opaque scope keys used by older callers are their own account. */ }
    return key;
  }
  error(key) { return this.accountErrors.get(this.account(key)) ?? this.errors.get(key); }
  stop(key, message) { if (!this.errors.has(key)) this.errors.set(key, message); }
  stopAccount(account, message) {
    if (!this.accountErrors.has(account)) { this.accountErrors.set(account, message); this.onAccountStop(account, message); }
  }
  resetAccount(account) { this.accountErrors.delete(account); this.rateRejections.delete(account); }
  observeOutcome(account, outcome) {
    if (outcome.scope === 'rate') {
      const count = (this.rateRejections.get(account) ?? 0) + 1;
      this.rateRejections.set(account, count);
      // This is a client retry budget, not a claimed school threshold. Two
      // recovery attempts distinguish a transient refusal from sustained ones;
      // continuing indefinitely already produced 115 rejected real submissions.
      if (count >= 3) this.stopAccount(account,
        `学校连续拒绝请求：${outcome.message}。已结束此账号本轮自动预约（连续 ${count} 次频率拒绝），请确认学校入口恢复后再启动`);
    } else if (outcome.kind === 'success' || ['retry', 'wait'].includes(outcome.kind) && !['rate', 'server'].includes(outcome.scope)) {
      this.rateRejections.delete(account);
    } else if (['account', 'rejected'].includes(outcome.kind)) this.stopAccount(account, outcome.message);
    return this.rateRejections.get(account) ?? 0;
  }
  conflict(key, time, inFlight = false) {
    for (const other of (inFlight ? this.inFlight : this.slots).get(key) ?? []) {
      if (other === time) continue;
      try {
        const a = splitTimeSlot(time), b = splitTimeSlot(other);
        if (a.start < b.end && b.start < a.end) return other;
      } catch { /* Older callers may use opaque slot keys. */ }
    }
  }
  prepare(key, load, { signal, deadline = Infinity, maxAttempts = 3, retryDelayMs = 150, maxAgeMs = Infinity,
    onRetry = () => {} } = {}) {
    const options = { signal, deadline, maxAttempts, retryDelayMs, maxAgeMs, onRetry };
    const previous = this.preparations.get(key);
    if (previous?.checkedAt !== undefined && Date.now() - previous.checkedAt >= maxAgeMs) this.preparations.delete(key);
    if (!this.preparations.has(key)) {
      const preparation = { signal };
      const work = Promise.resolve().then(async () => {
        for (let attempt = 1; ; attempt++) {
          signal?.throwIfAborted();
          try { const result = await load(); preparation.checkedAt = Date.now(); return result; }
          catch (error) {
            signal?.throwIfAborted();
            const delay = retryDelayMs * attempt;
            if (!isTransientQueryError(error) || attempt >= maxAttempts || Date.now() + delay >= deadline) throw error;
            onRetry({ attempt, delayMs: delay, message: error.message });
            await sleep(delay, signal);
          }
        }
      }).catch((error) => {
        // Cancelling this read-only check stops its owner, not other plans.
        if (signal?.aborted) {
          if (this.preparations.get(key) === preparation) this.preparations.delete(key);
        } else this.stop(key, error.message);
        throw error;
      });
      preparation.work = work;
      this.preparations.set(key, preparation);
    }
    const preparation = this.preparations.get(key);
    return preparation.work.catch((error) => {
      signal?.throwIfAborted();
      if (preparation.signal?.aborted && !this.error(key)) return this.prepare(key, load, options);
      throw error;
    });
  }
  async attempt(key, time, operation) {
    // Submission is exclusive per real school account, across sports/dates.
    // Check quota after dequeueing. No caller option may enable double POSTs.
    const account = this.account(key);
    if (!this.queues.has(account)) this.queues.set(account, new RequestQueue());
    return this.queues.get(account).run(async () => {
      if (this.error(key)) return { code: 'LOCAL_ACCOUNT_STOPPED', msg: this.error(key) };
      if (this.slots.get(key)?.has(time)) return { code: 'LOCAL_SLOT_BOOKED', msg: '此时段已在本批次预约成功', existing: this.get(key, time) };
      const conflict = this.conflict(key, time);
      if (conflict) return { code: 'LOCAL_SLOT_CONFLICT', msg: `已有预约 ${conflict} 与此候选重叠，不重复提交` };
      if (this.full(key)) return { code: 'LOCAL_DAILY_LIMIT', msg: '已成功两个时段，停止该项目当天的尝试' };
      if (!this.inFlight.has(key)) this.inFlight.set(key, new Set());
      this.inFlight.get(key).add(time);
      try {
        const response = await operation();
        if (response.code === '0') this.seed(key, time);
        return response;
      } finally { this.inFlight.get(key).delete(time); }
    });
  }
}
