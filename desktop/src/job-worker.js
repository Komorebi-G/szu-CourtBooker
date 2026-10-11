import { executionStatus } from '../../shared/booking-outcome.js';
import { open, rm, stat, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exists, readJson, writeJson } from './jobs.js';
import { HttpClient } from './http-client.js';
import { SzuVenueApi, withBooking } from '../../shared/api.js';
import { resolveTargets } from '../../shared/planner.js';
import { runBooking } from '../../shared/runner.js';
import { RequestNotSentError } from '../../shared/errors.js';
import { BookingQuota } from '../../shared/booking-quota.js';
import { createDiagnostics, recordDiagnostic } from '../../shared/diagnostics.js';
import { DiagnosticJournal } from './diagnostics.js';
import { isProcessOwner, processLockToken, processOwner } from './process-owner.js';
import { randomUUID } from 'node:crypto';

export async function executeJob(dir, options = {}) {
  // A live owner may never be replayed. Interrupted work is kept for review,
  // but only a newly confirmed execution may send requests.
  const lockPath = join(dir, 'run.lock');
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const value = await readFile(lockPath, 'utf8');
    const owner = Number(value.split('\n')[0]);
    if (owner && isProcessOwner(value, { startedAt: (await stat(lockPath)).mtimeMs })) return;
    if (!owner && Date.now() - (await stat(lockPath)).mtimeMs < 10_000) return;
    await rm(lockPath, { force: true });
    try { lock = await open(lockPath, 'wx', 0o600); } catch (e) { if (e.code === 'EEXIST') return; throw e; }
  }
  try {
    await lock.writeFile(processLockToken()); await lock.close();
    return await executeOwnedJob(dir, options);
  } finally {
    await lock.close().catch(() => {});
    await rm(lockPath, { force: true });
  }
}

async function executeOwnedJob(dir, { quota = new BookingQuota(), manualStart = false, stopSignal, referenceReader,
  submit = (operation) => operation(), onFatal = () => {}, onIdentity = () => {}, createApi = async (path) => {
  const client = await HttpClient.create({ sessionPath: path });
  return { client, api: new SzuVenueApi(client) };
} } = {}) {
  const job = await readJson(join(dir, 'job.json'));
  const prior = await readJson(join(dir, 'state.json'));
  if (prior.finishedAt && prior.status !== 'interrupted') return;
  if (prior.pid && prior.pid !== process.pid && isProcessOwner({ pid: prior.pid, identity: prior.processIdentity, startedAt: prior.startedAt })) return;
  const resumed = Boolean(prior.startedAt);
  const state = { ...prior, status: job.mode === 'check' ? 'checking' : 'preparing', pid: process.pid, processIdentity: processOwner.identity,
    startedAt: prior.startedAt ?? new Date().toISOString(), resumedAt: resumed ? new Date().toISOString() : undefined,
    attempt: (prior.attempt ?? 0) + 1, recoveryVersion: 1, dispatchJournalVersion: 1,
    logs: prior.logs ?? [], successes: prior.successes ?? [], pendingRequests: prior.pendingRequests ?? {} };
  state.diagnostics = prior.diagnostics ?? createDiagnostics({ mode: job.mode, plans: job.config.targets,
    platform: 'desktop', runtime: process.version, buildId: process.env.SZU_BUILD_ID });
  const journal = new DiagnosticJournal(dir);
  delete state.finishedAt; delete state.error;
  const controller = new AbortController();
  const { signal } = controller;
  let pending = Promise.resolve();
  let journalPending = Promise.resolve();
  let persistenceError;
  let logPersistTimer;
  let preparedAttempt;
  const storageFailed = (error) => {
    if (persistenceError) return;
    persistenceError = error; controller.abort(); onFatal(error);
  };
  const persist = (durable = false) => {
    const snapshot = structuredClone(state);
    pending = pending.then(() => writeJson(join(dir, 'state.json'), snapshot, { durable }));
    // Surface storage failures and stop subsequent booking requests.
    pending.catch(storageFailed);
    return pending;
  };
  const log = (level, message, details) => {
    const entry = recordDiagnostic(state.diagnostics, level, message, details);
    state.logs.push(entry);
    if (state.logs.length > 500) { state.logs.shift(); state.diagnostics.uiEventsDropped++; }
    journalPending = journalPending.then(async () => {
      if (!await journal.append(entry)) state.diagnostics.journalTruncated = true;
    });
    journalPending.catch(storageFailed);
    // Append each event, but coalesce UI snapshots. The dispatch and response
    // boundaries below still await an immediate durable state write.
    if (!logPersistTimer) logPersistTimer = setTimeout(() => { logPersistTimer = null; void persist(); }, 200);
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
    const identity = await api.getIdentity({ signal });
    if (job.accountIdentityId && identity.id !== job.accountIdentityId) throw new Error('登录身份与安排时选择的用户不一致，已停止预约');
    const account = identity?.id ?? job.accountIdentityId ?? job.sessionPath;
    onIdentity(account);
    log('INFO', `使用账号：${job.accountName ?? '我的账号'}${identity?.name ? `（${identity.name}）` : ''}`);
    signal.throwIfAborted();
    const metadata = await api.getSportVenueData({ signal });
    signal.throwIfAborted();
    const targets = resolveTargets(job.config, metadata);
    state.quotaScope = { account,
      sport: targets[0].sportCode, date: job.config.targets[0].date };
    // Compare every POST field: a refreshed catalog or a changed candidate
    // needs its own durable intent. Clock refinements only change the local
    // deadline, which is checked again immediately before dispatch.
    const attemptSignature = (input) => JSON.stringify([input.date, input.time, input.modeCode,
      input.room.WID, input.room.CGBM, input.room.XMDM, input.room.XQDM, input.room.CQBM ?? '']);
    const onPreparedAttempt = async (input) => {
      signal.throwIfAborted();
      const key = `${input.date}|${input.time}`;
      if (preparedAttempt && state.pendingRequests[preparedAttempt.key] === preparedAttempt.intent) {
        delete state.pendingRequests[preparedAttempt.key];
      }
      const intent = { date: input.date, time: input.time, modeCode: input.modeCode,
        attemptId: randomUUID(), room: structuredClone(input.room), deadline: input.deadline, preparedAt: new Date().toISOString() };
      state.pendingRequests[key] = intent;
      preparedAttempt = { key, signature: attemptSignature(input), intent, durable: persist() };
      await preparedAttempt.durable;
      signal.throwIfAborted();
    };
    const wrapper = withBooking(api, (input) => submit(async () => {
      if (signal.aborted) throw new RequestNotSentError('本次执行已停止，未发送请求');
      if (Date.now() >= input.deadline) return { code: 'EXPIRED', msg: '执行窗口已结束' };
      const key = `${input.date}|${input.time}`;
      const prepared = preparedAttempt?.signature === attemptSignature(input)
        && state.pendingRequests[key] === preparedAttempt.intent ? preparedAttempt : null;
      if (preparedAttempt && !prepared && state.pendingRequests[preparedAttempt.key] === preparedAttempt.intent) {
        delete state.pendingRequests[preparedAttempt.key];
      }
      preparedAttempt = undefined;
      state.pendingRequests[key] = { ...(prepared?.intent ?? {}), date: input.date, time: input.time,
        attemptId: prepared?.intent.attemptId ?? randomUUID(),
        modeCode: input.modeCode, room: structuredClone(input.room), deadline: input.deadline,
        sentAt: new Date().toISOString() };
      let dispatched = false, response;
      try {
        // The first release-time request can use the intent already written
        // during warmup. Logs and UI snapshots are outside this dispatch path.
        await (prepared ? prepared.durable : persist());
        await stop();
        signal.throwIfAborted();
        if (Date.now() >= input.deadline) {
          delete state.pendingRequests[key]; await persist();
          return { code: 'EXPIRED', msg: '执行窗口已结束' };
        }
        input.beforeDispatch?.();
        // The prewritten intent does not prove dispatch. Persist a compact
        // marker before sending so a crash cannot reload it as "never sent".
        await writeJson(join(dir, 'dispatch.json'), { pendingRequests: { [key]: state.pendingRequests[key] } }, { durable: true });
        signal.throwIfAborted();
        if (Date.now() >= input.deadline) throw new RequestNotSentError('执行窗口已结束，未发送请求');
        dispatched = true;
        response = await api.book(input);
      } catch (error) {
        if (!dispatched || error.code === 'REQUEST_NOT_SENT') {
          state.completedRequests ??= {};
          state.completedRequests[key] = { attemptId: state.pendingRequests[key]?.attemptId, outcome: 'not_sent',
            respondedAt: new Date().toISOString() };
          delete state.pendingRequests[key];
          try { await persist(true); await rm(join(dir, 'dispatch.json'), { force: true }); }
          catch (saveError) {
            storageFailed(saveError);
            throw new RequestNotSentError(`请求未发送，执行记录保存失败：${saveError.message}`, { cause: saveError });
          }
        }
        if (!dispatched && error.code !== 'REQUEST_NOT_SENT') throw new RequestNotSentError(error.message, { cause: error });
        throw error;
      }
      if (response.code === '0') state.successes.push({ date: input.date, time: input.time,
        court: input.room.CDMC, room: input.room, orderId: response.data?.DHID });
      state.completedRequests ??= {};
      state.completedRequests[key] = { attemptId: state.pendingRequests[key].attemptId, code: response.code,
        message: response.msg, respondedAt: new Date().toISOString() };
      delete state.pendingRequests[key];
      try { await persist(true); await rm(join(dir, 'dispatch.json'), { force: true }); }
      catch (error) {
        // The school response remains authoritative even when this process
        // cannot save it. Stop subsequent submissions and let the runner record
        // the known success/rejection before the final in-memory failure report.
        response = { ...response, persistenceError: `执行记录保存失败：${error.message}` };
      }
      if (response.persistenceError) {
        // Stop before releasing this account's submission queue. Another plan may
        // already be waiting here with the same account/project/date.
        const scope = quota.key(state.quotaScope.account, input.room.XMDM ?? targets[0].sportCode, input.date);
        quota.stop(scope, `登录状态保存失败，已停止此账号项目的提交：${response.persistenceError}`);
      }
      return response;
    }, signal, account));
    const result = await runBooking({ api: wrapper, client, config: job.config, targets,
      date: job.config.targets[0].date, immediate: job.mode === 'now', live: job.mode !== 'check',
      releaseAtServer: job.mode === 'release' ? job.releaseAt : undefined, signal, log,
      onPreparedAttempt,
      resetDurationOnStart: job.mode === 'now',
      quota, quotaAccount: account,
      loadSchoolBookings: (options) => api.getAllBookings(options),
      readReference: referenceReader ? (input) => referenceReader({ ...input, accountId: job.accountId ?? 'default' }) : undefined,
      onSuccess: async (success) => {
        if (success.reused && !state.successes.some((s) => s.date === success.task.date && s.time === success.task.time)) {
          state.successes.push({ date: success.task.date, time: success.task.time, court: success.task.room.CDMC,
            room: success.task.room, orderId: success.response.data?.DHID, reused: true, school: success.school });
          await persist();
        }
      },
      onState: (status, details) => { Object.assign(state, details, { status }); void persist(); },
    });
    state.total = result.total;
    state.limited = result.limited;
    state.expiredTimes = result.expiredTimes;
    state.slots = result.slots;
    state.metrics = result.metrics;
    const halted = signal.reason?.code === 'EXECUTION_HALTED';
    state.error = result.error || (halted ? signal.reason.message : undefined);
    state.status = halted ? 'error' : signal.aborted ? 'stopped' : executionStatus(result);
    if (persistenceError) throw persistenceError;
  } catch (error) {
    state.status = signal.aborted && !persistenceError && signal.reason?.code !== 'EXECUTION_HALTED' ? 'stopped' : 'error';
    state.error = state.status === 'stopped' ? null : error.message;
    if (state.error) log('ERROR', state.error, { event: 'execution_error' });
  } finally {
    clearInterval(timer);
    clearTimeout(logPersistTimer);
    stopSignal?.removeEventListener('abort', terminate);
    state.finishedAt = new Date().toISOString();
    if (state.status === 'stopped') log('INFO', '已停止，已成功的预约保留', { event: 'execution_stopped' });
    clearTimeout(logPersistTimer);
    // An unused warmup intent was never submitted. A consumed intent stays in
    // pendingRequests on unknown outcomes so interruption remains reviewable.
    if (preparedAttempt && state.pendingRequests[preparedAttempt.key] === preparedAttempt.intent) {
      delete state.pendingRequests[preparedAttempt.key];
    }
    await Promise.allSettled([pending, journalPending]);
    if (persistenceError) {
      state.status = 'error';
      state.error = `执行记录保存失败：${persistenceError.message}`;
    }
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
