// Exclusive operations preserve FIFO behavior. Independent operations can use
// both lanes, while a queued exclusive operation waits for them to finish.
export class RequestQueue {
  constructor({ concurrency = 2, after = () => {}, idle = () => {} } = {}) {
    Object.assign(this, { concurrency, after, idle });
    this.pending = []; this.running = 0; this.exclusive = false;
  }
  run(operation, { exclusive = true, group } = {}) {
    return new Promise((resolve, reject) => {
      this.pending.push({ operation, exclusive, group, resolve, reject }); this.drain();
    });
  }
  drain() {
    while (this.pending.length && this.running < this.concurrency) {
      const job = this.pending[0];
      const exclusive = typeof job.exclusive === 'function' ? job.exclusive() : job.exclusive;
      if (this.running && (this.exclusive || exclusive || this.group !== job.group)) return;
      this.pending.shift(); this.running++; this.exclusive = exclusive; this.group = job.group;
      let work;
      try { work = Promise.resolve(job.operation()); } catch (error) { work = Promise.reject(error); }
      work.then(job.resolve, job.reject);
      const release = () => {
        this.running--; if (!this.running) this.exclusive = false;
        this.drain(); if (!this.running && !this.pending.length) this.idle();
      };
      work.then(this.after, this.after).then(release, release);
      if (exclusive) return;
    }
  }
}
