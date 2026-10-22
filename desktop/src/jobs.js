import { mkdir, readFile, writeFile, rename, readdir, access, rm, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { executionIntent } from '../../shared/runner.js';
import { isProcessOwnerAsync, processOwner } from './process-owner.js';
import { pendingExecutionRequests } from '../../shared/experience.js';
import { atomicWrite } from './atomic-file.js';

export const JOB_ACTIVE = ['scheduled', 'queued', 'preparing', 'checking', 'waiting', 'booking', 'stopping'];
export async function writeJson(path, value, { durable = false } = {}) {
  await atomicWrite(path, JSON.stringify(value, null, 2), { durable });
}
export const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
export const exists = async (path) => access(path).then(() => true, () => false);

export class JobStore {
  summaryCache = new Map();
  constructor({ dataDir, root, worker, sessionPath, scheduler, startJob, execution }) {
    Object.assign(this, { dataDir, root, worker, sessionPath, scheduler, startJob, execution });
  }
  path(id) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('任务记录编号无效');
    return join(this.dataDir, 'jobs', id);
  }
  async get(id, { summary = false } = {}) {
    const dir = this.path(id);
    const paths = ['job.json', 'state.json', 'dispatch.json'].map((file) => join(dir, file));
    let job, state;
    const failure = this.execution?.failures.get(dir);
    if (summary && !failure?.executionState) {
      const stats = await Promise.all(paths.map((path) => stat(path).catch((error) => { if (error.code === 'ENOENT' && path === paths[2]) return null; throw error; })));
      const signature = stats.map((value) => value ? `${value.ino}:${value.size}:${value.mtimeMs}:${value.ctimeMs}` : '-').join('|');
      let cached = this.summaryCache.get(id);
      if (cached?.signature !== signature) {
        [job, state] = await Promise.all(paths.slice(0, 2).map(readJson));
        const dispatch = stats[2] ? await readJson(paths[2]).catch((error) => { if (error.code === 'ENOENT') return {}; throw error; }) : {};
        state.pendingRequests = mergedRequests(state, dispatch);
        state.dispatchJournalChecked = true;
        cached = { signature, job, state: compactState(state) }; this.summaryCache.set(id, cached);
      }
      job = cached.job; state = { ...cached.state };
    } else {
      job = await readJson(paths[0]);
      state = failure?.executionState ? (summary ? compactState(failure.executionState) : structuredClone(failure.executionState)) : await readJson(paths[1]);
      if (!failure?.executionState) {
        const dispatch = await readJson(paths[2]).catch((error) => { if (error.code === 'ENOENT') return {}; throw error; });
        state.pendingRequests = mergedRequests(state, dispatch);
        state.dispatchJournalChecked = true;
      }
      if (summary) state = compactState(state);
    }
    const stopped = await exists(join(dir, 'stop'));
    if (stopped && JOB_ACTIVE.includes(state.status)) state.status = state.pid ? 'stopping' : 'stopped';
    if (state.pid && JOB_ACTIVE.includes(state.status)) {
      let alive = await isProcessOwnerAsync({ pid: state.pid, identity: state.processIdentity, startedAt: state.startedAt ?? job.createdAt });
      if (state.pid === process.pid && this.execution && !this.execution.active.has(dir)) alive = false;
      if (!alive) {
        state.status = stopped ? 'stopped' : 'interrupted';
        state.error = stopped ? null : '上次执行已中断，不会自动重跑；请核对学校预约后重新登录并启动剩余时段';
      }
    }
    return { id, mode: job.mode, taskId: job.taskId, releaseAt: job.releaseAt, createdAt: job.createdAt,
      accountId: job.accountId ?? 'default', accountIdentityId: job.accountIdentityId,
      accountName: job.accountName ?? '我的账号', target: job.config.targets[0], ...state };
  }
  async list(options = {}) {
    const ids = await readdir(join(this.dataDir, 'jobs')).catch((error) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    const validIds = ids.filter((id) => /^[a-f0-9-]{36}$/.test(id));
    for (const id of this.summaryCache.keys()) if (!validIds.includes(id)) this.summaryCache.delete(id);
    return Promise.all(validIds.map((id) => this.inspect(id, options)));
  }
  async inspect(id, options) {
    try { return await this.get(id, options); }
    catch (error) {
      const job = await readJson(join(this.path(id), 'job.json')).catch(() => ({}));
      return { id, mode: job?.mode, taskId: job?.taskId, createdAt: job?.createdAt ?? new Date(0).toISOString(),
        accountId: job?.accountId ?? 'default', accountIdentityId: job?.accountIdentityId,
        accountName: job?.accountName ?? '我的账号', target: job?.config?.targets?.[0],
        status: 'corrupt', requiresReview: true, successes: [], logs: [],
        error: `本地执行记录无法读取（${error.code ?? '格式异常'}），原文件已保留；请先核对学校预约` };
    }
  }
  async recordReview(id, { checkedAt = new Date().toISOString(), resolvedRequests = [], reviewedOutcome, acknowledgeCorrupt = false } = {}) {
    const dir = this.path(id);
    if (this.execution?.active.has(dir)) throw new Error('执行仍在运行，请停止并等待请求返回后再核对');
    const lock = await readFile(join(dir, 'run.lock'), 'utf8').catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
    if (lock !== null && (await isProcessOwnerAsync(lock, { startedAt: (await stat(join(dir, 'run.lock'))).mtimeMs })
      || (!Number(lock.split('\n')[0]) && Date.now() - (await stat(join(dir, 'run.lock'))).mtimeMs < 10000))) {
      throw new Error('执行锁尚未释放，请停止正在运行的助手并等待请求返回后再核对');
    }
    let state, dispatch;
    const preserved = [];
    const readReviewRecord = async (file, optional = false) => {
      try { return await readJson(join(dir, file)); }
      catch (error) {
        if (optional && error.code === 'ENOENT') return {};
        if (!acknowledgeCorrupt) throw error;
        const original = await readFile(join(dir, file)).catch((readError) => { if (readError.code === 'ENOENT') return null; throw readError; });
        if (original !== null) {
          const backup = `${file}.corrupt-${randomUUID()}`;
          await writeFile(join(dir, backup), original, { flag: 'wx', mode: 0o600 }); preserved.push(backup);
        }
        return {};
      }
    };
    state = await readReviewRecord('state.json'); dispatch = await readReviewRecord('dispatch.json', true);
    if (acknowledgeCorrupt) {
      state = { status: 'interrupted', logs: [], successes: [], ...state, requiresReview: false,
        recoveredAt: checkedAt, recovery: { ...(state.recovery ?? {}), checkedAt, preservedFiles: preserved } };
    }
    state.pendingRequests = mergedRequests(state, dispatch);
    state.reviewedRequests ??= {};
    const ids = resolvedRequests.map((value) => typeof value === 'string' ? value : value.requestId);
    for (let index = 0; index < ids.length; index++) {
      const requestId = ids[index], original = state.pendingRequests[requestId];
      const resolution = resolvedRequests[index];
      if (original && resolution?.reviewResult === 'booked' && resolution.schoolSlot) {
        const slot = resolution.schoolSlot;
        state.successes ??= [];
        if (!state.successes.some((success) => success.date === slot.date && success.time === slot.time)) {
          state.successes.push({ date: slot.date, time: slot.time, court: slot.court, confirmed: true,
            room: { ...original.room, WID: slot.courtId ?? original.room?.WID, CDMC: slot.court,
              XMDM: slot.sportCode ?? original.room?.XMDM, CGBM: slot.venueCode ?? original.room?.CGBM,
              XQDM: slot.campusCode ?? original.room?.XQDM }, reviewedAt: checkedAt });
        }
      }
      if (original) {
        state.reviewedRequests[requestId] = { ...original, checkedAt,
          review: typeof resolvedRequests[index] === 'object' ? resolvedRequests[index] : { requestId } };
        delete state.pendingRequests[requestId];
      }
      if (state.inFlight && (state.inFlight.requestId === requestId || requestId === `${state.inFlight.date}|${state.inFlight.time}`)) {
        state.reviewedRequests[requestId] ??= { ...state.inFlight, checkedAt };
        delete state.inFlight;
      }
    }
    state.reviewedAt = checkedAt;
    if (reviewedOutcome) state.reviewedOutcome = reviewedOutcome;
    if (reviewedOutcome && !Object.keys(state.pendingRequests).length && !state.inFlight) {
      state.statusBeforeReview ??= state.status; state.status = reviewedOutcome;
      state.errorBeforeReview ??= state.error; delete state.error;
    }
    await writeJson(join(dir, 'state.json'), state, { durable: true });
    const markerRequests = { ...dispatch.pendingRequests };
    for (const requestId of ids) delete markerRequests[requestId];
    if (Object.keys(markerRequests).length) await writeJson(join(dir, 'dispatch.json'), { pendingRequests: markerRequests }, { durable: true });
    else await rm(join(dir, 'dispatch.json'), { force: true });
    const failure = this.execution?.failures.get(dir);
    if (failure?.executionState) failure.executionState = structuredClone(state);
    this.summaryCache.delete(id);
    return this.get(id);
  }
  async retireSchedules() {
    const errors = [];
    for (const job of await this.list()) {
      if ((job.mode !== 'schedule' && job.status !== 'corrupt') || await exists(join(this.path(job.id), 'schedule-retired'))) continue;
      try {
        // Write stop before OS cleanup, so even an old worker will not submit.
        await writeFile(join(this.path(job.id), 'stop'), 'legacy execution disabled', { mode: 0o600 });
        await this.scheduler.remove(job.id);
        await writeFile(join(this.path(job.id), 'schedule-retired'), 'disabled', { mode: 0o600 });
      } catch (error) { errors.push(`旧定时项清理失败：${error.message}；请在历史记录中停止或删除后重试`); }
    }
    return errors;
  }
  async create(target, config, mode, account = {}) {
    const intent = executionIntent(mode, target.date, { confirmedAt: account.confirmedAt, durationMs: target.durationMs ?? 60000 });
    const releaseAt = intent.releaseAt; mode = intent.mode;
    if (!this.startJob) throw new Error('请在预约助手内手动启动本次执行');
    const id = randomUUID();
    const dir = this.path(id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const job = { id, taskId: target.id, mode, releaseAt, sessionPath: account.sessionPath ?? this.sessionPath,
      accountId: target.accountId ?? 'default', accountName: account.name ?? '我的账号', accountIdentityId: account.userId,
      createdAt: new Date().toISOString(), config: { ...config,
        scheduler: { ...config.scheduler, pollIntervalMs: target.intervalMs ?? 80,
          pollJitterMs: 0, timeoutMs: target.durationMs ?? 60_000 },
        targets: [{ ...target, enabled: true }] } };
    await writeJson(join(dir, 'job.json'), job);
    await writeJson(join(dir, 'state.json'), { status: 'queued', pid: process.pid, processIdentity: processOwner.identity, logs: [], successes: [] });
    try {
      this.startJob(dir);
    } catch (error) {
      await writeFile(join(dir, 'stop'), 'start failed', { mode: 0o600 });
      await writeJson(join(dir, 'state.json'), { status: 'error', logs: [], successes: [],
        error: `未能启动：${error.message}`, finishedAt: new Date().toISOString() });
      throw new Error(`未能启动：${error.message}`);
    }
    return this.get(id);
  }
  async stop(id) {
    this.execution?.stop(this.path(id));
    const job = await this.inspect(id);
    await writeFile(join(this.path(id), 'stop'), 'user requested stop', { mode: 0o600 });
    if (job.mode === 'schedule' || job.status === 'corrupt') await this.scheduler.remove(id);
    return this.inspect(id);
  }
  async remove(id) {
    const job = await this.stop(id);
    if (this.execution?.active.has(this.path(id)) || JOB_ACTIVE.includes(job.status)) throw new Error('正在等待已发出的请求返回，请稍后删除');
    if (pendingExecutionRequests(job).length) throw new Error('此执行还有预约结果待确认，请先核对学校预约并确认结果后再删除');
    if (job.requiresReview) throw new Error('此执行记录损坏，请先核对学校预约并确认结果后再删除');
    if (job.status === 'corrupt') {
      const lock = await readFile(join(this.path(id), 'run.lock'), 'utf8').catch((error) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (lock !== null) {
        const alive = await isProcessOwnerAsync(lock, { startedAt: (await stat(join(this.path(id), 'run.lock'))).mtimeMs });
        if (alive) throw new Error('记录损坏且执行锁尚未释放，请先停止正在运行的助手');
      }
    }
    const trash = join(this.dataDir, 'trash');
    await mkdir(trash, { recursive: true, mode: 0o700 });
    await rename(this.path(id), join(trash, id));
  }
}

function compactState(state) {
  const { logs, diagnostics, reviewedRequests, completedRequests, ...summary } = state;
  return { ...summary, logCount: logs?.length ?? state.logCount ?? 0, lastEvent: logs?.at(-1) ? {
    at: logs.at(-1).at, level: logs.at(-1).level, message: logs.at(-1).message } : state.lastEvent };
}

function mergedRequests(state, dispatch) {
  return Object.fromEntries(Object.entries({ ...state.pendingRequests, ...dispatch.pendingRequests })
    .filter(([id, request]) => !state.reviewedRequests?.[id]
      && !(request.attemptId && state.completedRequests?.[id]?.attemptId === request.attemptId)));
}
