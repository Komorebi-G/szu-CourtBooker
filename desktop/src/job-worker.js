import { open, rm, stat, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exists, readJson, writeJson } from './jobs.js';
import { HttpClient } from './http-client.js';
import { SzuVenueApi } from '../../shared/api.js';
import { resolveTargets } from '../../shared/planner.js';
import { runBooking } from '../../shared/runner.js';
import { RECOVERY_GRACE_MS, withinRecoveryWindow, reconcilePending } from './recovery.js';

export async function executeJob(dir, { quota, createApi = async (path) => {
  const client = await HttpClient.create({ sessionPath: path });
  return { client, api: new SzuVenueApi(client) };
} } = {}) {
  // A live owner may never be replayed. A dead owner can resume within the
  // fixed grace window; successful slots and request intents survive crashes.
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
  await lock.writeFile(String(process.pid)); await lock.close();
  const job = await readJson(join(dir, 'job.json'));
  const prior = await readJson(join(dir, 'state.json'));
  if (prior.finishedAt && prior.status !== 'interrupted') { await rm(lockPath, { force: true }); return; }
  if (prior.pid && prior.pid !== process.pid) {
    try { process.kill(prior.pid, 0); await rm(lockPath, { force: true }); return; } catch (e) { if (e.code !== 'ESRCH') throw e; }
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
    pending.catch((error) => { persistenceError = error; controller.abort(); });
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
  let interrupted = false;
  const terminate = () => { interrupted = true; controller.abort(); };
  process.once('SIGTERM', terminate);
  process.once('SIGINT', terminate);
  try {
    await stop();
    signal.throwIfAborted();
    await persist();
    if (job.mode === 'schedule' && !withinRecoveryWindow(job)) {
      state.status = 'missed';
      state.error = '超过开始时间后 30 分钟，未补跑预约';
      return;
    }
    const { client, api } = await createApi(job.sessionPath, signal);
    const identity = await api.getIdentity();
    if (job.accountIdentityId && identity.id !== job.accountIdentityId) throw new Error('登录身份与安排时选择的用户不一致，已停止预约');
    log('INFO', `使用账号：${job.accountName ?? '我的账号'}${identity?.name ? `（${identity.name}）` : ''}`);
    signal.throwIfAborted();
    const metadata = await api.getSportVenueData();
    signal.throwIfAborted();
    let targets = resolveTargets(job.config, metadata);
    state.quotaScope = { account: identity?.id ?? job.accountIdentityId ?? job.sessionPath,
      sport: targets[0].sportCode, date: job.config.targets[0].date };
    if (resumed && !prior.recoveryVersion && prior.status === 'booking') {
      throw new Error('旧版中断记录缺少请求状态，请核对学校预约后手动安排剩余时段');
    }
    const blocked = new Set();
    for (const [key, request] of Object.entries(state.pendingRequests)) {
      if (state.successes.some((s) => s.date === request.date && s.time === request.time)) { delete state.pendingRequests[key]; continue; }
      const confirmed = await reconcilePending(api, request);
      if (confirmed) { state.successes.push(confirmed); delete state.pendingRequests[key]; log('OK', `已核对中断前预约：${confirmed.time} ${confirmed.court}`); }
      else { blocked.add(request.time); log('WARN', `中断请求暂无法确认，跳过 ${request.time}，请到学校核对；其余时段继续`); }
    }
    await persist();
    targets = targets.map((t) => ({ ...t, times: t.times.filter((time) => !blocked.has(time)) })).filter((t) => t.times.length);
    if (!targets.length) throw new Error('剩余时段均有结果待确认的请求，请到学校核对');
    if (resumed) log('INFO', `恢复第 ${state.attempt} 次执行，保留 ${state.successes.length} 个成功时段，重新计算持续时间`);
    const wrapper = Object.create(api);
    wrapper.book = async (input) => {
      const key = `${input.date}|${input.time}`;
      state.pendingRequests[key] = { date: input.date, time: input.time, room: input.room, sentAt: new Date().toISOString() };
      await persist(); signal.throwIfAborted();
      const response = await api.book(input);
      if (response.code === '0') state.successes.push({ date: input.date, time: input.time,
        court: input.room.CDMC, room: input.room, orderId: response.data?.DHID });
      delete state.pendingRequests[key]; await persist();
      return response;
    };
    const result = await runBooking({ api: wrapper, client, config: job.config, targets,
      date: job.config.targets[0].date, immediate: job.mode === 'now', live: job.mode !== 'check',
      releaseAtServer: job.releaseAt, signal, log,
      initialSuccesses: state.successes, resetDurationOnStart: true,
      quota, quotaAccount: identity?.id ?? job.accountIdentityId ?? job.sessionPath,
      latestStartAt: job.mode === 'schedule' ? job.releaseAt + RECOVERY_GRACE_MS : Infinity,
      onState: (status, details) => { Object.assign(state, details, { status }); void persist(); },
    });
    state.total = result.total;
    state.limited = result.limited;
    state.error = blocked.size ? '部分中断请求结果待确认，已跳过这些时段，请核对学校预约' : result.error;
    state.status = signal.aborted ? 'stopped' : result.missed ? 'missed' : result.ok ? 'success'
      : result.successes.length ? 'partial' : 'error';
    if (blocked.size && state.status === 'success') state.status = 'partial';
    if (persistenceError) throw persistenceError;
  } catch (error) {
    state.status = signal.aborted && !persistenceError ? 'stopped' : 'error';
    state.error = state.status === 'stopped' ? null : error.message;
    if (state.error) state.logs.push({ time: new Date().toISOString(), level: 'ERROR', message: state.error });
  } finally {
    clearInterval(timer);
    process.removeListener('SIGTERM', terminate);
    process.removeListener('SIGINT', terminate);
    state.finishedAt = new Date().toISOString();
    if (interrupted && job.mode === 'schedule') { state.status = 'interrupted'; state.error = '执行被中断，将在30分钟恢复窗口内重启剩余时段'; }
    if (state.status === 'stopped') state.logs.push({ time: state.finishedAt, level: 'INFO', message: '已停止，已成功的预约保留' });
    await pending.catch(() => {});
    await writeJson(join(dir, 'state.json'), state);
    await rm(lockPath, { force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  executeJob(resolve(process.argv[2])).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
