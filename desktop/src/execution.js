import { executeJob } from './job-worker.js';
import { HttpClient } from './http-client.js';
import { SzuVenueApi } from '../../shared/api.js';
import { BookingQuota } from '../../shared/booking-quota.js';
import { RequestNotSentError } from '../../shared/errors.js';
import { ReferenceCatalogStore } from './catalogs.js';
import { openSync, closeSync, readFileSync, writeFileSync, unlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isProcessOwner, processLockToken } from './process-owner.js';

export class BookingQueue {
  pending = Promise.resolve();
  run(operation, signal) {
    const work = this.pending.then(() => {
      if (signal?.aborted) throw new RequestNotSentError('本次执行已停止，未发送请求');
      return operation();
    });
    this.pending = work.catch(() => {});
    return work;
  }
}

// Only explicit starts in this manager process may execute. No detached worker,
// OS timer, or startup scan can replay a saved job.
export class LiveExecution {
  active = new Map();
  queues = new Map();
  haltedAccounts = new Map();
  quota = new BookingQuota();
  closing = false;
  failures = new Map();
  startSequence = 0;
  constructor({ dataDir, createApi, renewSession, referenceReader } = {}) {
    this.createApi = createApi ?? (async (path, _signal, expectedUserId) => {
      const client = await HttpClient.create({ sessionPath: path, expectedUserId, renewSession, priority: 'critical' });
      return { client, api: new SzuVenueApi(client) };
    });
    this.dataDir = dataDir;
    const catalogs = dataDir ? new ReferenceCatalogStore(dataDir) : null;
    this.referenceReader = referenceReader ?? (catalogs ? (input) => catalogs.read(input) : undefined);
  }
  claim() {
    if (!this.dataDir || this.lockToken) return;
    // Also respects the old dispatcher's lock until its in-flight work ends.
    const path = join(this.dataDir, 'dispatcher.lock');
    for (let attempt = 0; attempt < 3; attempt++) {
      let file;
      try { file = openSync(path, 'wx', 0o600); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        let value;
        try { value = readFileSync(path, 'utf8'); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        const pid = Number(value.split('\n')[0]);
        if (!Number.isSafeInteger(pid) || pid <= 0) {
          try {
            if (Date.now() - statSync(path).mtimeMs > 10_000 && readFileSync(path, 'utf8') === value) {
              unlinkSync(path); continue;
            }
          } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
          throw new Error('另一个助手正在启动执行，请稍后重试');
        }
        let lockStartedAt;
        try { lockStartedAt = statSync(path).mtimeMs; }
        catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        if (!isProcessOwner(value, { startedAt: lockStartedAt })) {
          try { if (readFileSync(path, 'utf8') === value) unlinkSync(path); } catch (e) { if (e.code !== 'ENOENT') throw e; }
          continue;
        }
        throw new Error('另一个助手实例正在执行，请先停止那边的执行后重试');
      }
      // Keep the legacy numeric format so an older dispatcher sees a live owner.
      const token = processLockToken();
      try { writeFileSync(file, token); } finally { closeSync(file); }
      this.lockToken = token;
      return;
    }
    throw new Error('无法取得执行锁，请稍后重试');
  }
  release() {
    if (!this.lockToken) return;
    const path = join(this.dataDir, 'dispatcher.lock');
    try { if (readFileSync(path, 'utf8') === this.lockToken) unlinkSync(path); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    finally { this.lockToken = null; }
  }
  start(dir) {
    if (this.closing) throw new Error('程序正在退出，请重新打开后启动');
    if (this.active.has(dir)) throw new Error('本次执行已启动');
    this.claim();
    if (!this.active.size) {
      this.quota = new BookingQuota();
      this.queues.clear();
      this.haltedAccounts.clear();
    }
    const controller = new AbortController();
    const sequence = ++this.startSequence;
    const work = executeJob(dir, { manualStart: true, stopSignal: controller.signal, quota: this.quota,
      createApi: this.createApi,
      referenceReader: this.referenceReader,
      onFatal: (error) => this.halt(error),
      onIdentity: (account) => {
        const entry = this.active.get(dir);
        if (entry) entry.account = account;
        const reason = this.haltedAccounts.get(account);
        if (reason && sequence <= reason.stopThrough) controller.abort(reason);
      },
      submit: (operation, signal, account) => this.queueFor(account).run(async () => {
        try { return await operation(); }
        catch (error) {
          if (error.code !== 'REQUEST_NOT_SENT') this.haltAccount(account, error);
          throw error;
        }
      }, signal),
    }).catch((error) => {
      // Runtime persistence failures already call onFatal. A final save can
      // fail outside that queue and carries the known response in this field.
      // Initialization failures have not submitted anything and are local to
      // this job, including jobs whose school identity is not known yet.
      if (error.executionState) this.halt(error);
      this.failures.set(dir, error);
      throw error;
    }).finally(() => {
      const account = this.active.get(dir)?.account;
      this.active.delete(dir);
      const halt = this.haltedAccounts.get(account);
      if (account && ![...this.active.values()].some((entry) => entry.account === account
        || (!entry.account && halt && entry.sequence <= halt.stopThrough))) {
        this.haltedAccounts.delete(account);
        this.queues.delete(account);
      }
      if (!this.active.size) this.release();
    });
    this.active.set(dir, { controller, work, sequence });
    work.catch((error) => console.error('本次执行失败：' + error.message));
    return work;
  }
  queueFor(account) {
    if (!this.queues.has(account)) this.queues.set(account, new BookingQueue());
    return this.queues.get(account);
  }
  haltAccount(account, error) {
    const reason = Object.assign(new Error(`此账号的执行已停止：预约结果待确认，请核对学校预约。${error.message}`), {
      code: 'EXECUTION_HALTED',
      stopThrough: this.startSequence,
    });
    this.haltedAccounts.set(account, reason);
    for (const entry of this.active.values()) if (entry.account === account) entry.controller.abort(reason);
  }
  halt(error) {
    const reason = Object.assign(new Error(`本次执行已停止：请求结果或本地保存异常，请核对学校预约。${error.message}`), {
      code: 'EXECUTION_HALTED',
    });
    for (const { controller } of this.active.values()) controller.abort(reason);
  }
  stop(dir) {
    this.active.get(dir)?.controller.abort();
  }
  async close() {
    this.closing = true;
    const entries = [...this.active.values()];
    for (const { controller } of entries) controller.abort();
    await Promise.allSettled(entries.map(({ work }) => work));
  }
}
