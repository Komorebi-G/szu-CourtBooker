// Count this batch and freshly confirmed school orders. Local history alone
// cannot establish occupancy: those orders may have been cancelled at school.
import { sleep, splitTimeSlot } from './utils.js';
import { isTransientQueryError } from './errors.js';

export class BookingQuota {
  constructor() {
    this.slots = new Map(); this.queues = new Map(); this.booked = new Map();
    this.errors = new Map(); this.preparations = new Map();
    this.users = new Map(); this.usedScopes = new Set();
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
  remaining(key) { return Math.max(0, 2 - (this.slots.get(key)?.size ?? 0)); }
  full(key) { return this.remaining(key) === 0; }
  open(key) {
    // An unrelated waiting plan must not keep a finished scope's old orders or
    // rejection cached for a later manual start. Only overlapping runs share it.
    if (!this.users.get(key) && this.usedScopes.has(key)) {
      for (const map of [this.slots, this.booked, this.errors, this.preparations, this.queues]) map.delete(key);
    }
    this.usedScopes.add(key);
    this.users.set(key, (this.users.get(key) ?? 0) + 1);
    return () => this.users.set(key, this.users.get(key) - 1);
  }
  error(key) { return this.errors.get(key); }
  stop(key, message) { if (!this.errors.has(key)) this.errors.set(key, message); }
  conflict(key, time) {
    for (const other of this.slots.get(key) ?? []) {
      if (other === time) continue;
      try {
        const a = splitTimeSlot(time), b = splitTimeSlot(other);
        if (a.start < b.end && b.start < a.end) return other;
      } catch { /* Older callers may use opaque slot keys. */ }
    }
  }
  prepare(key, load, { signal, deadline = Infinity, maxAttempts = 3, retryDelayMs = 150,
    onRetry = () => {} } = {}) {
    if (!this.preparations.has(key)) {
      const work = Promise.resolve().then(async () => {
        for (let attempt = 1; ; attempt++) {
          signal?.throwIfAborted();
          try { return await load(); }
          catch (error) {
            signal?.throwIfAborted();
            const delay = retryDelayMs * attempt;
            if (!isTransientQueryError(error) || attempt >= maxAttempts || Date.now() + delay >= deadline) throw error;
            onRetry({ attempt, delayMs: delay, message: error.message });
            await sleep(delay, signal);
          }
        }
      }).catch((error) => {
        this.stop(key, error.message); throw error;
      });
      this.preparations.set(key, work);
    }
    return this.preparations.get(key);
  }
  async attempt(key, time, operation) {
    // Check inside the per-account/project/day queue, not before enqueueing:
    // simultaneous tasks must not both consume the final available slot.
    const work = (this.queues.get(key) ?? Promise.resolve()).then(async () => {
      if (this.error(key)) return { code: 'LOCAL_ACCOUNT_STOPPED', msg: this.error(key) };
      if (this.slots.get(key)?.has(time)) return { code: 'LOCAL_SLOT_BOOKED', msg: '此时段已在本批次预约成功', existing: this.get(key, time) };
      const conflict = this.conflict(key, time);
      if (conflict) return { code: 'LOCAL_SLOT_CONFLICT', msg: `已有预约 ${conflict} 与此候选重叠，不重复提交` };
      if (this.full(key)) return { code: 'LOCAL_DAILY_LIMIT', msg: '已成功两个时段，停止该项目当天的尝试' };
      const response = await operation();
      if (response.code === '0') this.seed(key, time);
      return response;
    });
    this.queues.set(key, work.catch(() => {}));
    return work;
  }
}
