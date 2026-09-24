import { runBooking, bookingReleaseAt, validateExecutionStart } from '../../shared/runner.js';
import { resolveTargets } from '../../shared/planner.js';
import { PROJECTS } from '../../shared/projects.js';
import { BookingQuota } from '../../shared/booking-quota.js';
import { RequestNotSentError } from '../../shared/errors.js';
import { withBooking } from '../../shared/api.js';
import { shanghaiDate, addDays, splitTimeSlot, resolveDate } from '../../shared/utils.js';

export function validatePlan(plan) {
  const project = PROJECTS.find((p) => p.id === plan.project);
  if (!project) throw new Error('请选择体育项目');
  resolveDate(plan.date);
  if (plan.date < shanghaiDate() || plan.date > addDays(shanghaiDate(), 7)) throw new Error('日期须为今天至未来第七天');
  if (!plan.accountId) throw new Error('请选择账号');
  if (!Array.isArray(plan.times) || !plan.times.length) throw new Error('至少选择一个时段');
  plan.times.forEach(splitTimeSlot);
  if (!Array.isArray(plan.courts) || !plan.courts.length || plan.courts.some((c) => typeof c !== 'string' || !c.trim())) throw new Error('至少选择一个场地');
  if (!Number.isFinite(plan.intervalMs) || plan.intervalMs < 100 || plan.intervalMs > 3600000) throw new Error('间隔须为 0.1 至 3600 秒');
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
  async start(plans, mode) {
    if (this.active) throw new Error('已有执行正在运行，请先停止');
    if (!plans.length || !['now', 'release'].includes(mode)) throw new Error('请选择方案和执行方式');
    if (!this.isForeground()) throw new Error('请保持 App 在前台');
    const snapshot = structuredClone(plans);
    snapshot.forEach(validatePlan);
    snapshot.forEach((plan) => validateExecutionStart(mode, plan.date));
    const token = crypto.randomUUID();
    this.active = true; this.reason = null; this.controller = new AbortController();
    const signal = this.controller.signal;
    const run = { id: token, mode, status: 'preparing', startedAt: new Date().toISOString(),
      plans: snapshot, successes: [], logs: [], items: snapshot.map((p) => ({ id: p.id, name: p.name, status: 'preparing' })) };
    this.current = run;
    this.store.state.runs.unshift(run);
    let fatalError;
    const disableNative = () => this.device.setExecution({ token, enabled: false }).catch(() => {});
    const fail = (error) => {
      fatalError ??= error;
      run.error ||= error.message;
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
    const log = (level, message, details) => {
      run.logs.push({ time: new Date().toISOString(), level, message, details });
      run.logs = run.logs.slice(-300);
      logWrites = logWrites.then(persist); logWrites.catch(() => {});
    };
    let queue = Promise.resolve();
    const quota = new BookingQuota();
    const enqueue = (operation) => {
      const work = queue.then(() => {
        if (signal.aborted || !this.isForeground()) throw new RequestNotSentError('执行已停止或 App 已离开前台，未发送请求');
        return operation();
      });
      queue = work.catch(() => {}); return work;
    };
    try {
      await persist();
      signal.throwIfAborted();
      await this.device.setExecution({ token, enabled: true });
      signal.throwIfAborted();
      // Preflight ALL accounts before sending the first booking request.
      const clients = new Map(); const prepared = [];
      for (const plan of snapshot) {
        signal.throwIfAborted();
        if (!clients.has(plan.accountId)) {
          const account = this.store.state.accounts.find((a) => a.id === plan.accountId);
          if (!account) throw new Error('方案账号不存在');
          const connection = await this.createApi(account, token);
          signal.throwIfAborted();
          const identity = await connection.api.getIdentity();
          if (account.userId && identity.id !== account.userId) throw new Error(`${account.name} 的登录身份不匹配`);
          account.userId = identity.id; account.user = identity.name; account.verifiedAt = new Date().toISOString();
          await connection.client.flush(); await persist();
          signal.throwIfAborted();
          clients.set(plan.accountId, connection);
        }
        const { api, client } = clients.get(plan.accountId);
        const target = targetFor(plan);
        const config = { targets: [target], scheduler: { queryConcurrency: 2, pollIntervalMs: plan.intervalMs,
          pollJitterMs: 0, timeoutMs: plan.durationMs }, booking: { taskConcurrency: 1 } };
        const targets = resolveTargets(config, await api.getSportVenueData());
        prepared.push({ plan, api, client, config, targets });
      }
      signal.throwIfAborted();
      const outcomes = await Promise.allSettled(prepared.map(async ({ plan, api, client, config, targets }) => {
        try {
          const item = run.items.find((i) => i.id === plan.id);
          const wrapper = withBooking(api, (input) => enqueue(async () => {
            if (Date.now() > input.deadline) return { code: 'EXPIRED', msg: '执行窗口已结束' };
            // Persist intent before dispatch, but distinguish a cancelled intent from an unknown response.
            run.inFlight = { plan: plan.name, accountId: plan.accountId, date: input.date, time: input.time, court: input.room.CDMC };
            let dispatched = false, response;
            try {
              await persist(); signal.throwIfAborted();
              if (!this.isForeground()) { this.stop('background'); signal.throwIfAborted(); }
              if (Date.now() >= input.deadline) {
                delete run.inFlight; await persist();
                return { code: 'EXPIRED', msg: '执行窗口已结束' };
              }
              dispatched = true;
              response = await api.book(input);
              if (!response || Array.isArray(response) || typeof response.code !== 'string' || !response.code.trim()) {
                throw new Error('预约接口未返回明确业务结果');
              }
            } catch (error) {
              if (!dispatched || error.code === 'REQUEST_NOT_SENT') {
                delete run.inFlight;
                if (error.code === 'REQUEST_NOT_SENT' && !signal.aborted) fail(error);
                if (!dispatched) throw new RequestNotSentError(error.message, { cause: error });
                throw error;
              }
              fail(new Error('预约结果待确认，请到学校核对：' + error.message));
              throw error;
            }
            // Keep the global queue locked until the response is durable.
            if (response.code === '0') run.successes.push({ planId: plan.id, name: plan.name,
              accountId: plan.accountId, date: input.date, time: input.time, court: input.room.CDMC, orderId: response.data?.DHID });
            delete run.inFlight; await persist();
            return response;
          }));
          const result = await runBooking({ api: wrapper, client, config, targets, date: plan.date,
            quota, quotaAccount: this.store.state.accounts.find((a) => a.id === plan.accountId).userId,
            immediate: mode === 'now', releaseAtServer: mode === 'release' ? bookingReleaseAt(plan.date) : undefined,
            live: true, signal, log,
            onState: (status, details) => {
              Object.assign(item, details, { status });
              run.status = signal.aborted ? 'stopping' : run.items.some((i) => i.status === 'booking') ? 'booking'
                : run.items.some((i) => i.status === 'waiting') ? 'waiting' : 'preparing';
              this.changed();
            },
            onSuccess: async () => {} });
          item.status = result.stopped ? (fatalError ? 'error' : 'stopped') : result.ok ? 'success'
            : result.missed ? 'missed' : result.successes.length ? 'partial' : 'error';
          item.error = result.error || (fatalError && run.error);
          item.limited = result.limited;
          if (result.error) log('ERROR', `${plan.name}：${result.error}`);
          await persist(); return result;
        } catch (error) {
          // Do not leave sibling plans waiting for hours after one worker rejects.
          fail(error); throw error;
        }
      }));
      const failed = outcomes.find((o) => o.status === 'rejected');
      if (failed) throw failed.reason;
      if (run.inFlight) run.error ||= '有预约请求结果待确认，请核对学校“我的预约”，不要直接重试。';
      run.status = signal.aborted ? terminalStatus()
        : outcomes.every((o) => o.value.ok) ? 'success' : run.successes.length ? 'partial' : 'error';
    } catch (error) {
      run.status = signal.aborted ? terminalStatus() : 'error';
      run.error = run.error || error.message;
    } finally {
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
