import { executionStatus, classifyBookingResponse } from '../../shared/booking-outcome.js';
import { runBooking, executionIntent } from '../../shared/runner.js';
import { resolveTargets } from '../../shared/planner.js';
import { PROJECTS } from '../../shared/projects.js';
import { BookingQuota } from '../../shared/booking-quota.js';
import { RequestNotSentError } from '../../shared/errors.js';
import { withBooking } from '../../shared/api.js';
import { createDiagnostics, recordDiagnostic } from '../../shared/diagnostics.js';
import { shanghaiDate, addDays, splitTimeSlot, resolveDate } from '../../shared/utils.js';
import { validateBookingGoal } from '../../shared/booking-goal.js';
import { RequestQueue } from '../../shared/request-queue.js';
import { combineAbortSignals } from '../../shared/abort-signal.js';
import { pendingMobileRequests } from './store.js';

export function validatePlan(plan) {
  const project = PROJECTS.find((p) => p.id === plan.project);
  if (!project) throw new Error('请选择体育项目');
  resolveDate(plan.date);
  if (plan.date < shanghaiDate() || plan.date > addDays(shanghaiDate(), 7)) throw new Error('日期须为今天至未来第七天');
  if (!plan.accountId) throw new Error('请选择账号');
  if (!Array.isArray(plan.times) || !plan.times.length) throw new Error('至少选择一个时段');
  plan.times.forEach(splitTimeSlot);
  validateBookingGoal(plan);
  for (const key of ['preferSameCourt', 'includeOtherCourts']) {
    if (plan[key] !== undefined && typeof plan[key] !== 'boolean') throw new Error('场地偏好选项须为开关值');
  }
  if (!Array.isArray(plan.courts) || !plan.courts.length || plan.courts.some((c) => typeof c !== 'string' || !c.trim())) throw new Error('至少选择一个场地');
  if (!Number.isFinite(plan.intervalMs) || plan.intervalMs < 80 || plan.intervalMs > 3600000) throw new Error('间隔须为 0.08 至 3600 秒');
  if (!Number.isFinite(plan.durationMs) || plan.durationMs < 1000 || plan.durationMs > 86400000) throw new Error('最长持续时间须为 1 秒至 24 小时');
  return { ...plan, name: plan.name?.trim() || `${plan.date} ${project.label} ${plan.times[0]}` };
}
export function targetFor(plan) {
  const project = PROJECTS.find((p) => p.id === plan.project);
  return { ...project, ...plan, enabled: true };
}
export class ForegroundExecution {
  constructor({ store, device, createApi, changed = () => {}, isForeground = () => true }) {
    Object.assign(this, { store, device, createApi, changed, isForeground });
    this.active = false;
  }
  async start(plans, mode = 'auto', { confirmedAt = Date.now(), preflightErrors = {} } = {}) {
    if (this.active) throw new Error('已有执行正在运行，请先停止');
    if (!plans.length || !['now', 'release', 'auto'].includes(mode)) throw new Error('请选择方案和执行方式');
    if (!this.isForeground()) throw new Error('请保持 App 在前台');
    const snapshot = structuredClone(plans);
    snapshot.forEach(validatePlan);
    for (const plan of snapshot) {
      if (this.store.state.runs.some((previous) => pendingMobileRequests(previous).some((request) => {
        const account = this.store.state.accounts.find((a) => a.id === plan.accountId);
        const priorAccount = this.store.state.accounts.find((a) => a.id === request.accountId);
        const matchingAccount = request.accountId === plan.accountId || account?.userId
          && (account.userId === priorAccount?.userId || account.userId === request.accountIdentityId);
        return matchingAccount && request.date === plan.date;
      }))) throw new Error('此账号和日期仍有请求结果待确认，请先核对学校预约');
    }
    const intents = new Map(); const intentErrors = new Map();
    for (const plan of snapshot) {
      try { intents.set(plan.id, executionIntent(mode, plan.date, { confirmedAt, durationMs: plan.durationMs })); }
      catch (error) { intentErrors.set(plan.id, error); }
    }
    const token = crypto.randomUUID();
    this.active = true; this.reason = null; this.controller = new AbortController();
    const signal = this.controller.signal;
    const run = { id: token, mode, status: 'preparing', dispatchJournalVersion: 1, startedAt: new Date().toISOString(),
      plans: snapshot, successes: [], pendingRequests: {}, logs: [], items: snapshot.map((p) => ({ id: p.id, name: p.name, status: 'preparing' })) };
    run.diagnostics = createDiagnostics({ mode, plans: snapshot, platform: 'android',
      buildId: typeof __COURT_BUILD_ID__ === 'undefined' ? 'source' : __COURT_BUILD_ID__,
      runtime: typeof __COURT_VERSION__ === 'undefined' ? 'source' : __COURT_VERSION__ });
    this.current = run;
    this.store.state.runs.unshift(run);
    let fatalError;
    const disableNative = () => this.device.setExecution({ token, enabled: false }).catch(() => {});
    const fail = (error) => {
      fatalError ??= error;
      run.error = fatalError.message;
      this.controller.abort(error);
      void disableNative();
    };
    const terminalStatus = () => fatalError ? 'error' : this.reason === 'background' ? 'interrupted' : 'stopped';
    // Keep bounded history, but never silently delete successful/uncertain runs.
    const persist = async () => {
      this.changed();
      try { await this.store.save(); } catch (error) { fail(new Error('本地记录保存失败：' + error.message)); throw error; }
    };
    let logWrites = Promise.resolve();
    let logTimer, renderTimer;
    const log = (level, message, details) => {
      run.logs.push(recordDiagnostic(run.diagnostics, level, message, details));
      if (run.logs.length > 300) run.diagnostics.uiEventsDropped++;
      run.logs = run.logs.slice(-300);
      if (!logTimer) logTimer = setTimeout(() => {
        logTimer = null; logWrites = logWrites.then(persist); logWrites.catch(() => {});
      }, 200);
    };
    const queues = new Map(), accountScopes = new Map(), preparedIntents = new Map();
    const quota = new BookingQuota();
    const accountScope = (userId) => {
      if (!accountScopes.has(userId)) {
        const controller = new AbortController();
        const combined = combineAbortSignals([signal, controller.signal]);
        accountScopes.set(userId, { controller, ...combined });
      }
      return accountScopes.get(userId);
    };
    const failAccount = (scope, error) => {
      scope.error ??= error;
      run.error ||= error.message;
      scope.controller.abort(error);
    };
    const syncInFlight = () => {
      const first = Object.values(run.pendingRequests)[0];
      if (first) run.inFlight = first; else delete run.inFlight;
    };
    const forgetIntent = (id) => { delete run.pendingRequests[id]; syncInFlight(); };
    const clearPreparedSlot = (key) => {
      const prepared = preparedIntents.get(key);
      if (!prepared) return;
      forgetIntent(prepared.id); preparedIntents.delete(key);
    };
    const clearPrepared = (planId) => {
      for (const [key, prepared] of preparedIntents) if (prepared.planId === planId) clearPreparedSlot(key);
    };
    const fingerprint = (input) => JSON.stringify([input.date, input.time, input.modeCode,
      input.room.WID, input.room.CGBM, input.room.CQBM ?? '', input.room.XMDM, input.room.XQDM]);
    const rememberIntent = (plan, input, state) => {
      const id = crypto.randomUUID();
      run.pendingRequests[id] = { requestId: id, planId: plan.id, plan: plan.name, project: plan.project, accountId: plan.accountId,
        accountIdentityId: this.store.state.accounts.find((account) => account.id === plan.accountId)?.userId,
        date: input.date, time: input.time, court: input.room.CDMC, courtId: input.room.WID,
        venueCode: input.room.CGBM, sportCode: input.room.XMDM, campusCode: input.room.XQDM, modeCode: input.modeCode, state, preparedAt: new Date().toISOString() };
      syncInFlight(); return id;
    };
    const enqueue = (userId, scope, operation) => {
      if (!queues.has(userId)) queues.set(userId, new RequestQueue());
      return queues.get(userId).run(() => {
        if (scope.signal.aborted || !this.isForeground()) throw new RequestNotSentError('执行已停止或 App 已离开前台，未发送请求');
        return operation();
      });
    };
    try {
      await persist();
      signal.throwIfAborted();
      await this.device.setExecution({ token, enabled: true });
      signal.throwIfAborted();
      // Each account prepares independently; a slow login cannot hold ready plans.
      const clients = new Map();
      const outcomes = await Promise.allSettled(snapshot.map(async (plan) => {
        const item = run.items.find((i) => i.id === plan.id);
        let api, client, config, targets, scope, userId;
        try {
          signal.throwIfAborted();
          if (intentErrors.has(plan.id)) throw intentErrors.get(plan.id);
          item.mode = intents.get(plan.id).mode;
          if (preflightErrors[plan.accountId]) throw new Error(preflightErrors[plan.accountId]);
          if (!clients.has(plan.accountId)) clients.set(plan.accountId, (async () => {
            const account = this.store.state.accounts.find((a) => a.id === plan.accountId);
            if (!account) throw new Error('方案账号不存在');
            const connection = await this.createApi(account, token, { parallelQueries: true });
            signal.throwIfAborted();
            const intent = intents.get(plan.id), remaining = intent.releaseAt - Date.now();
            const deadline = intent.mode === 'release' && remaining > 100
              ? intent.releaseAt - Math.min(3000, remaining - 100) : Date.now() + plan.durationMs;
            const identity = await connection.api.getIdentity({ signal, deadline });
            signal.throwIfAborted();
            if (account.userId && identity.id !== account.userId) throw new Error(`${account.name} 的登录身份不匹配`);
            if (this.store.state.accounts.some((a) => a.id !== account.id && a.userId === identity.id)) {
              throw new Error('此学校账号已绑定其他用户，请使用原用户的方案');
            }
            account.userId = identity.id; account.user = identity.name; account.verifiedAt = new Date().toISOString();
            await connection.client.flush(); await persist();
            signal.throwIfAborted();
            return { ...connection, userId: identity.id, metadata: await connection.api.getSportVenueData({ signal, deadline }) };
          })());
          const connection = await clients.get(plan.accountId);
          signal.throwIfAborted();
          ({ api, client } = connection);
          userId = connection.userId; scope = accountScope(userId);
          scope.signal.throwIfAborted();
          const target = targetFor(plan);
          config = { targets: [target], scheduler: { queryConcurrency: 2, pollIntervalMs: plan.intervalMs,
            pollJitterMs: 0, timeoutMs: plan.durationMs }, booking: { reuseRecentIdentity: true } };
          targets = resolveTargets(config, connection.metadata);
        } catch (error) {
          item.status = signal.aborted ? terminalStatus() : 'error'; item.error = scope?.error?.message ?? error.message;
          log('ERROR', `${plan.name}：${error.message}`);
          await persist();
          return;
        }
        try {
          const wrapper = withBooking(api, (input) => enqueue(userId, scope, async () => {
            if (Date.now() > input.deadline) return { code: 'EXPIRED', msg: '执行窗口已结束' };
            // Persist intent before dispatch, but distinguish a cancelled intent from an unknown response.
            const preparedKey = `${plan.id}|${input.time}`;
            const prepared = preparedIntents.get(preparedKey);
            const ready = prepared?.fingerprint === fingerprint(input);
            if (!ready) clearPreparedSlot(preparedKey);
            const id = ready ? prepared.id : rememberIntent(plan, input, 'prepared');
            preparedIntents.delete(preparedKey);
            let dispatched = false, response;
            try {
              // A matched first candidate was already durable before release.
              if (!ready) await persist();
              scope.signal.throwIfAborted();
              if (!this.isForeground()) { this.stop('background'); scope.signal.throwIfAborted(); }
              if (Date.now() >= input.deadline) {
                forgetIntent(id); await persist();
                return { code: 'EXPIRED', msg: '执行窗口已结束' };
              }
              input.beforeDispatch?.();
              run.pendingRequests[id].state = 'in_flight';
              run.pendingRequests[id].sentAt = new Date().toISOString();
              dispatched = true;
              response = await api.book({ ...input, requestId: id,
                requestMetadata: { planId: plan.id, plan: plan.name, project: plan.project, accountId: plan.accountId } });
              if (!response || Array.isArray(response) || typeof response.code !== 'string' || !response.code.trim()) {
                throw new Error('预约接口未返回明确业务结果');
              }
            } catch (error) {
              if (!dispatched || error.code === 'REQUEST_NOT_SENT') {
                forgetIntent(id);
                if (error.code === 'REQUEST_NOT_SENT' && Date.now() >= input.deadline) {
                  error.bookingResponse = { code: 'EXPIRED', msg: '执行窗口已结束' };
                }
                if (error.code === 'REQUEST_NOT_SENT' && !error.bookingResponse && !scope.signal.aborted) failAccount(scope, error);
                if (!dispatched && error.code !== 'REQUEST_NOT_SENT') throw new RequestNotSentError(error.message, { cause: error });
                throw error;
              }
              run.pendingRequests[id].state = 'unknown';
              failAccount(scope, new Error('预约结果待确认，请到学校核对：' + error.message));
              throw error;
            }
            // Keep this account's queue locked until the response is durable.
            const outcome = classifyBookingResponse(response);
            if (['account', 'rejected'].includes(outcome.kind)) quota.stop(quota.key(userId, input.room.XMDM, input.date), outcome.message);
            if (response.persistenceError) fail(new Error('本地记录保存失败：' + response.persistenceError));
            run.knownRequests ??= {};
            run.knownRequests[id] = { ...run.pendingRequests[id], code: response.code, message: response.msg,
              orderId: response.data?.DHID, resolvedAt: new Date().toISOString() };
            if (response.code === '0') run.successes.push({ requestId: id, planId: plan.id, name: plan.name,
              accountId: plan.accountId, project: plan.project, date: input.date, time: input.time,
              court: input.room.CDMC, courtId: input.room.WID, venueCode: input.room.CGBM,
              sportCode: input.room.XMDM, campusCode: input.room.XQDM, modeCode: input.modeCode, orderId: response.data?.DHID });
            forgetIntent(id);
            const savingAt = Date.now();
            try {
              await persist(); delete run.knownRequests[id];
              log('INFO', '预约响应已保存', { event: 'booking_persistence', requestId: input.requestId,
                planId: plan.id, date: input.date, time: input.time, durationMs: Date.now() - savingAt });
            }
            catch (error) {
              // The school response is known even when saving it fails.
              return { ...response, persistenceError: response.persistenceError ?? error.message };
            }
            return response;
          }));
          const result = await runBooking({ api: wrapper, client, config, targets, date: plan.date,
            quota, quotaAccount: userId,
            loadSchoolBookings: (options) => api.getAllBookings({ ...options, pageSize: 500 }),
            immediate: intents.get(plan.id).mode === 'now',
            releaseAtServer: intents.get(plan.id).mode === 'release' ? intents.get(plan.id).releaseAt : undefined,
            live: true, signal: scope.signal, log: (level, message, details) => log(level, message, { ...details, planId: plan.id }),
            onPreparedAttempt: async (input) => {
              scope.signal.throwIfAborted();
              const key = `${plan.id}|${input.time}`;
              clearPreparedSlot(key);
              const id = rememberIntent(plan, input, 'prepared');
              preparedIntents.set(key, { id, planId: plan.id, fingerprint: fingerprint(input) });
              await persist(); scope.signal.throwIfAborted();
            },
            onState: (status, details) => {
              Object.assign(item, details, { status });
              run.status = signal.aborted ? 'stopping' : run.items.some((i) => i.status === 'booking') ? 'booking'
                : run.items.some((i) => i.status === 'waiting') ? 'waiting' : 'preparing';
              // Let the ready first request reach transport before rebuilding the UI.
              if (status === 'booking') {
                if (!renderTimer) renderTimer = setTimeout(() => { renderTimer = null; this.changed(); }, 0);
              } else this.changed();
            },
            onSuccess: async (success) => {
              if (success.reused && !run.successes.some((s) => s.planId === plan.id && s.time === success.task.time)) {
                run.successes.push({ planId: plan.id, name: plan.name, accountId: plan.accountId, date: plan.date,
                  time: success.task.time, court: success.task.room.CDMC, courtId: success.task.room.WID,
                  venueCode: success.task.room.CGBM, sportCode: success.task.room.XMDM, campusCode: success.task.room.XQDM,
                  modeCode: success.task.target.modeCode, orderId: success.response.data?.DHID, reused: true, school: success.school });
                await persist();
              }
            } });
          if (result.persistenceError) fail(new Error('本地记录保存失败：' + result.persistenceError));
          item.status = result.stopped && (fatalError || scope.error) ? 'error' : executionStatus(result);
          item.expiredTimes = result.expiredTimes;
          item.slots = result.slots;
          item.metrics = result.metrics;
          item.error = result.error || scope.error?.message || (fatalError && run.error);
          item.limited = result.limited;
          clearPrepared(plan.id);
          if (result.error) log('ERROR', `${plan.name}：${result.error}`);
          await persist(); return result;
        } catch (error) {
          failAccount(scope, error);
          item.status = 'error'; item.error = scope.error.message;
          clearPrepared(plan.id);
          log('ERROR', `${plan.name}：${item.error}`);
          await persist();
        }
      }));
      const failed = outcomes.find((o) => o.status === 'rejected');
      if (failed) throw failed.reason;
      if (Object.keys(run.pendingRequests).length) run.error ||= '有预约请求结果待确认，请核对学校“我的预约”，不要直接重试。';
      run.status = signal.aborted ? terminalStatus()
        : run.items.every((i) => i.status === 'success') ? 'success'
        : run.successes.length ? 'partial' : run.items.some((i) => i.status === 'error') ? 'error'
        : run.items.every((i) => i.status === 'limited') ? 'limited'
        : run.items.every((i) => i.status === 'missed') ? 'missed'
        : run.items.every((i) => i.status === 'expired') ? 'expired' : 'no_result';

    } catch (error) {
      run.status = signal.aborted ? terminalStatus() : 'error';
      run.error = run.error || error.message;
    } finally {
      clearTimeout(logTimer);
      clearTimeout(renderTimer);
      for (const scope of accountScopes.values()) scope.dispose();
      for (const key of [...preparedIntents.keys()]) clearPreparedSlot(key);
      // A preflight failure/stop must not leave individual plans showing "preparing" forever.
      for (const item of run.items) if (['preparing', 'waiting', 'booking'].includes(item.status)) {
        item.status = signal.aborted && !fatalError ? 'stopped' : 'error';
        item.error = run.error;
      }
      run.finishedAt = new Date().toISOString();
      if (this.reason === 'background' && !fatalError) run.error = '离开前台，本次已中断；返回后不会自动续跑。已发出但无结果的请求请到学校核对。';
      await logWrites.catch(() => {});
      if (fatalError) run.status = 'error';
      try { await this.store.save(); }
      catch (error) { fail(new Error('本地记录保存失败：' + error.message)); run.status = 'error'; throw error; }
      finally { await this.device.setExecution({ token, enabled: false }).catch(() => {}); this.active = false; this.changed(); }
    }
    return run;
  }
  stop(reason = 'user') {
    if (!this.active) return;
    this.reason = reason; this.current.status = 'stopping'; this.controller.abort();
    // Invalidate native queued requests and read retries immediately, not after they finish.
    this.device.setExecution({ token: this.current.id, enabled: false }).catch(() => {});
    this.changed();
  }
}
