import { open, rm, stat, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exists, readJson, writeJson } from './jobs.js';
import { HttpClient } from './http-client.js';
import { SzuVenueApi, withBooking } from '../../shared/api.js';
import { resolveTargets } from '../../shared/planner.js';
import { runBooking } from '../../shared/runner.js';
import { RequestNotSentError } from '../../shared/errors.js';

export async function executeJob(dir, options = {}) {
  // A live owner may never be replayed. Interrupted work is kept for review,
  // but only a newly confirmed execution may send requests.
  const lockPath = join(dir, 'run.lock');
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const owner = Number(await readFile(lockPath, 'utf8'));
    if (owner) { try { process.kill(owner, 0); return; } catch (e) { if (e.code !== 'ESRCH') return; } }
    else if (Date.now() - (await stat(lockPath)).mtimeMs < 10_000) return;
    await rm(lockPath, { force: true });
    try { lock = await open(lockPath, 'wx', 0o600); } catch (e) { if (e.code === 'EEXIST') return; throw e; }
  }
  try {
    await lock.writeFile(String(process.pid)); await lock.close();
    return await executeOwnedJob(dir, options);
  } finally {
    await lock.close().catch(() => {});
    await rm(lockPath, { force: true });
  }
}

async function executeOwnedJob(dir, { quota, manualStart = false, stopSignal,
  submit = (operation) => operation(), onFatal = () => {}, createApi = async (path) => {
  const client = await HttpClient.create({ sessionPath: path });
  return { client, api: new SzuVenueApi(client) };
} } = {}) {
  const job = await readJson(join(dir, 'job.json'));
  const prior = await readJson(join(dir, 'state.json'));
  if (prior.finishedAt && prior.status !== 'interrupted') return;
  if (prior.pid && prior.pid !== process.pid) {
    try { process.kill(prior.pid, 0); return; } catch (e) { if (e.code !== 'ESRCH') throw e; }
  }
  const resumed = Boolean(prior.startedAt);
  const state = { ...prior, status: job.mode === 'check' ? 'checking' : 'preparing', pid: process.pid,
    startedAt: prior.startedAt ?? new Date().toISOString(), resumedAt: resumed ? new Date().toISOString() : undefined,
    attempt: (prior.attempt ?? 0) + 1, recoveryVersion: 1,
    logs: prior.logs ?? [], successes: prior.successes ?? [], pendingRequests: prior.pendingRequests ?? {} };
  delete state.finishedAt; delete state.error;
  const controller = new AbortController();
  const { signal } = controller;
  let pending = Promise.resolve();
  let persistenceError;
  const persist = () => {
    const snapshot = structuredClone(state);
    pending = pending.then(() => writeJson(join(dir, 'state.json'), snapshot));
    // Surface storage failures and stop subsequent booking requests.
    pending.catch((error) => { persistenceError = error; controller.abort(); onFatal(error); });
    return pending;
  };
  const log = (level, message, details) => {
    state.logs.push({ time: new Date().toISOString(), level, message, details });
    if (state.logs.length > 500) state.logs.shift();
    void persist();
  };
  const stop = async () => {
    if (await exists(join(dir, 'stop'))) { state.status = 'stopping'; controller.abort(); }
  };
  const timer = setInterval(() => { void stop().catch(() => controller.abort()); }, 200);
  const terminate = () => controller.abort(stopSignal.reason);
  stopSignal?.addEventListener('abort', terminate, { once: true });
  if (stopSignal?.aborted) terminate();
  try {
    await stop();
    signal.throwIfAborted();
    await persist();
    if (!manualStart || job.mode === 'schedule' || resumed) {
      state.status = 'stopped';
      state.error = '自动定时与中断补跑已停用，请验证登录后手动开始新的执行';
      return;
    }
    const { client, api } = await createApi(job.sessionPath, signal, job.accountIdentityId);
    const identity = await api.getIdentity();
    if (job.accountIdentityId && identity.id !== job.accountIdentityId) throw new Error('登录身份与安排时选择的用户不一致，已停止预约');
    log('INFO', `使用账号：${job.accountName ?? '我的账号'}${identity?.name ? `（${identity.name}）` : ''}`);
    signal.throwIfAborted();
    const metadata = await api.getSportVenueData();
    signal.throwIfAborted();
    const targets = resolveTargets(job.config, metadata);
    state.quotaScope = { account: identity?.id ?? job.accountIdentityId ?? job.sessionPath,
      sport: targets[0].sportCode, date: job.config.targets[0].date };
    const wrapper = withBooking(api, (input) => submit(async () => {
      if (signal.aborted) throw new RequestNotSentError('本次执行已停止，未发送请求');
      if (Date.now() >= input.deadline) return { code: 'EXPIRED', msg: '执行窗口已结束' };
      const key = `${input.date}|${input.time}`;
      state.pendingRequests[key] = { date: input.date, time: input.time, room: input.room, sentAt: new Date().toISOString() };
      let dispatched = false, response;
      try {
        await persist();
        await stop();
        signal.throwIfAborted();
        if (Date.now() >= input.deadline) {
          delete state.pendingRequests[key]; await persist();
          return { code: 'EXPIRED', msg: '执行窗口已结束' };
        }
        dispatched = true;
        response = await api.book(input);
      } catch (error) {
        if (!dispatched || error.code === 'REQUEST_NOT_SENT') {
          delete state.pendingRequests[key]; await persist();
        }
        if (!dispatched) throw new RequestNotSentError(error.message, { cause: error });
        throw error;
      }
      if (response.code === '0') state.successes.push({ date: input.date, time: input.time,
        court: input.room.CDMC, room: input.room, orderId: response.data?.DHID });
      delete state.pendingRequests[key]; await persist();
      return response;
    }, signal));
    const result = await runBooking({ api: wrapper, client, config: job.config, targets,
      date: job.config.targets[0].date, immediate: job.mode === 'now', live: job.mode !== 'check',
      releaseAtServer: job.releaseAt, signal, log,
      resetDurationOnStart: job.mode === 'now',
      quota, quotaAccount: identity?.id ?? job.accountIdentityId ?? job.sessionPath,
      onState: (status, details) => { Object.assign(state, details, { status }); void persist(); },
    });
    state.total = result.total;
    state.limited = result.limited;
    const halted = signal.reason?.code === 'EXECUTION_HALTED';
    state.error = result.error || (halted ? signal.reason.message : undefined);
    state.status = halted ? 'error' : signal.aborted ? 'stopped' : result.missed ? 'missed' : result.ok ? 'success'
      : result.successes.length ? 'partial' : 'error';
    if (persistenceError) throw persistenceError;
  } catch (error) {
    state.status = signal.aborted && !persistenceError && signal.reason?.code !== 'EXECUTION_HALTED' ? 'stopped' : 'error';
    state.error = state.status === 'stopped' ? null : error.message;
    if (state.error) state.logs.push({ time: new Date().toISOString(), level: 'ERROR', message: state.error });
  } finally {
    clearInterval(timer);
    stopSignal?.removeEventListener('abort', terminate);
    state.finishedAt = new Date().toISOString();
    if (state.status === 'stopped') state.logs.push({ time: state.finishedAt, level: 'INFO', message: '已停止，已成功的预约保留' });
    await pending.catch(() => {});
    try { await writeJson(join(dir, 'state.json'), state); }
    catch (error) {
      // Keep the known response available to the manager even if disk is full.
      error.executionState = { ...structuredClone(state), status: 'error', error: `执行记录保存失败：${error.message}` };
      throw error;
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  executeJob(resolve(process.argv[2])).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
