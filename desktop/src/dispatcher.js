import { open, readFile, readdir, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { executeJob } from './job-worker.js';
import { readJson, exists } from './jobs.js';
import { HttpClient } from './http-client.js';
import { SzuVenueApi } from '../../shared/api.js';
import { sleep } from '../../shared/utils.js';
import { BookingQuota } from '../../shared/booking-quota.js';
import { withinRecoveryWindow } from './recovery.js';

// Share one request queue across every task. A queued request rechecks cancellation.
export class BookingQueue {
  pending = Promise.resolve();
  run(operation, signal) {
    const result = this.pending.then(() => { signal?.throwIfAborted(); return operation(); });
    this.pending = result.catch(() => {});
    return result;
  }
}

export async function runDispatcher(dataDir, { createApi, idleMs = 1500 } = {}) {
  const lockPath = join(dataDir, 'dispatcher.lock');
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let pid;
    try { pid = Number(await readFile(lockPath, 'utf8')); } catch { return; }
    if (pid > 0) {
      try { process.kill(pid, 0); return; } catch (error) { if (error.code !== 'ESRCH') return; }
    } else if (Date.now() - (await stat(lockPath)).mtimeMs < 10_000) return;
    await rm(lockPath, { force: true });
    try { lock = await open(lockPath, 'wx', 0o600); } catch (error) { if (error.code === 'EEXIST') return; throw error; }
  }
  await lock.writeFile(String(process.pid));
  await lock.close();
  const queue = new BookingQueue();
  const active = new Map();
  let quota = new BookingQuota();
  let shuttingDown = false;
  const shutdown = () => { shuttingDown = true; };
  process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);
  let idleSince = Date.now();
  const sharedApi = async (path, signal) => {
    // Reload credentials for each job so tomorrow's plan sees a renewed login.
    const { client, api } = createApi ? await createApi(path) : await HttpClient.create({ sessionPath: path })
      .then((client) => ({ client, api: new SzuVenueApi(client) }));
    const wrapper = Object.create(api);
    wrapper.book = (input) => queue.run(() => Date.now() > input.deadline
      ? { code: 'EXPIRED', msg: '执行窗口已结束' } : api.book(input), signal);
    return { client, api: wrapper };
  };
  try {
    while (!shuttingDown) {
      if (!active.size) quota = new BookingQuota();
      let pending = false;
      const ready = [];
      const ids = await readdir(join(dataDir, 'jobs'));
      for (const id of ids.filter((id) => /^[a-f0-9-]{36}$/.test(id))) {
        if (active.has(id)) continue;
        const dir = join(dataDir, 'jobs', id);
        try {
          if (await exists(join(dir, 'stop'))) continue;
          const job = await readJson(join(dir, 'job.json'));
          const state = await readJson(join(dir, 'state.json'));
          if (state.finishedAt && state.status !== 'interrupted') continue;
          if (state.status !== 'scheduled' && job.mode !== 'schedule') continue;
          pending = true;
          if (job.releaseAt - Date.now() > 120_000) continue;
          ready.push({ id, dir });
          // Restore every known success before any recovered job starts sending.
          // Finished history is deliberately excluded by the checks above.
          if (job.mode === 'schedule' && withinRecoveryWindow(job)) {
            for (const success of state.successes ?? []) {
              const sport = state.quotaScope?.sport ?? success.sportCode ?? success.room?.XMDM;
              if (sport) quota.seed(quota.key(state.quotaScope?.account ?? job.accountIdentityId ?? job.sessionPath,
                sport, success.date), success.time);
            }
          }
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      for (const { id, dir } of ready) {
        const work = executeJob(dir, { createApi: sharedApi, quota }).catch((error) => console.error(id, error.message))
          .finally(() => active.delete(id));
        active.set(id, work);
      }
      if (active.size || pending) idleSince = Date.now();
      if (Date.now() - idleSince >= idleMs) break;
      await sleep(300);
    }
  } finally {
    await Promise.allSettled(active.values());
    process.removeListener('SIGTERM', shutdown); process.removeListener('SIGINT', shutdown);
    await rm(lockPath, { force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runDispatcher(resolve(process.argv[2])).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
