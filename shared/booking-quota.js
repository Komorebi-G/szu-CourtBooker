// Only this execution batch and explicitly recovered successes count. Historical
// finished jobs may have been cancelled at school and must not block a new run.
export class BookingQuota {
  constructor() { this.slots = new Map(); this.queues = new Map(); }
  key(account, sport, date) { return JSON.stringify([account, sport, date]); }
  seed(key, time) {
    if (!this.slots.has(key)) this.slots.set(key, new Set());
    this.slots.get(key).add(time);
  }
  full(key) { return (this.slots.get(key)?.size ?? 0) >= 2; }
  async attempt(key, time, operation) {
    // Check inside the per-account/project/day queue, not before enqueueing:
    // simultaneous tasks must not both consume the final available slot.
    const work = (this.queues.get(key) ?? Promise.resolve()).then(async () => {
      if (this.full(key)) return { code: 'LOCAL_DAILY_LIMIT', msg: '已成功两个时段，停止该项目当天的尝试' };
      const response = await operation();
      if (response.code === '0') this.seed(key, time);
      return response;
    });
    this.queues.set(key, work.catch(() => {}));
    return work;
  }
}
