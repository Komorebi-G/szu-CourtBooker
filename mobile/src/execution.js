import { runBooking, bookingReleaseAt } from '../../shared/runner.js';
import { resolveTargets } from '../../shared/planner.js';
import { PROJECTS } from '../../shared/projects.js';
import { BookingQuota } from '../../shared/booking-quota.js';
import { shanghaiDate, addDays, splitTimeSlot, resolveDate } from '../../shared/utils.js';

export function validatePlan(plan) {
  if (!PROJECTS.some((p) => p.id === plan.project)) throw new Error('请选择体育项目');
  resolveDate(plan.date);
  if (plan.date < shanghaiDate() || plan.date > addDays(shanghaiDate(), 7)) throw new Error('日期须为今天至未来第七天');
  if (!plan.accountId || !plan.name?.trim()) throw new Error('请选择账号并填写方案名称');
  if (!Array.isArray(plan.times) || !plan.times.length) throw new Error('至少选择一个时段');
  plan.times.forEach(splitTimeSlot);
  if (!Array.isArray(plan.courts) || !plan.courts.length || plan.courts.some((c) => typeof c !== 'string' || !c.trim())) throw new Error('至少选择一个场地');
  if (!Number.isFinite(plan.intervalMs) || plan.intervalMs < 100 || plan.intervalMs > 3600000) throw new Error('间隔须为 0.1 至 3600 秒');
  if (!Number.isFinite(plan.durationMs) || plan.durationMs < 1000 || plan.durationMs > 86400000) throw new Error('最长持续时间须为 1 秒至 24 小时');
  return plan;
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
    if (mode === 'release' && snapshot.some((p) => bookingReleaseAt(p.date) <= Date.now())) throw new Error('存在已放号日期，请选择“立即尝试”或调整方案');
    const token = crypto.randomUUID();
    this.active = true; this.reason = null; this.controller = new AbortController();
    const signal = this.controller.signal;
    const run = { id: token, mode, status: 'preparing', startedAt: new Date().toISOString(),
      plans: snapshot, successes: [], logs: [], items: snapshot.map((p) => ({ id: p.id, name: p.name, status: 'preparing' })) };
    this.current = run;
    this.store.state.runs.unshift(run);
    // Keep bounded history, but never silently delete successful/uncertain runs.
    const persist = async () => {
      this.changed();
      try { await this.store.save(); } catch (error) { this.controller.abort(); throw error; }
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
      const work = queue.then(() => { signal.throwIfAborted(); if (!this.isForeground()) throw new Error('App 已离开前台'); return operation(); });
      queue = work.catch(() => {}); return work;
    };
    try {
      await persist();
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
          const identity = await connection.api.getIdentity();
          if (account.userId && identity.id !== account.userId) throw new Error(`${account.name} 的登录身份不匹配`);
          account.userId = identity.id; account.user = identity.name; account.verifiedAt = new Date().toISOString();
          await connection.client.flush(); await persist();
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
        const item = run.items.find((i) => i.id === plan.id);
        const wrapper = Object.create(api);
        wrapper.book = (input) => enqueue(async () => {
          if (Date.now() > input.deadline) return { code: 'EXPIRED', msg: '执行窗口已结束' };
          // Persist the intent before sending: a crash must leave an explicit unknown result.
          run.inFlight = { plan: plan.name, accountId: plan.accountId, date: input.date, time: input.time, court: input.room.CDMC };
          await persist(); signal.throwIfAborted();
          let response;
          try { response = await api.book(input); }
          catch (error) {
            run.error = '预约结果待确认，请到学校核对：' + error.message;
            this.controller.abort(); throw error;
          }
          // Commit success before releasing the global queue, so a different
          // task cannot overwrite the persisted in-flight request marker.
          if (response.code === '0') run.successes.push({ planId: plan.id, name: plan.name,
            accountId: plan.accountId, date: input.date, time: input.time, court: input.room.CDMC, orderId: response.data?.DHID });
          delete run.inFlight; await persist();
          return response;
        });
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
        item.status = result.stopped ? 'stopped' : result.ok ? 'success' : result.missed ? 'missed' : 'error';
        item.error = result.error;
        item.limited = result.limited;
        if (result.error) log('ERROR', `${plan.name}：${result.error}`);
        await persist(); return result;
      }));
      const failed = outcomes.find((o) => o.status === 'rejected');
      if (failed) throw failed.reason;
      if (run.inFlight) run.error = '有预约请求结果待确认，请核对学校“我的预约”，不要直接重试。';
      run.status = signal.aborted ? (this.reason === 'background' ? 'interrupted' : 'stopped')
        : outcomes.every((o) => o.value.ok) ? 'success' : run.successes.length ? 'partial' : 'error';
    } catch (error) {
      run.status = signal.aborted ? (this.reason === 'background' ? 'interrupted' : 'stopped') : 'error';
      run.error = error.message;
    } finally {
      run.finishedAt = new Date().toISOString();
      if (this.reason === 'background') run.error = '离开前台，本次已中断；返回后不会自动续跑。已发出但无结果的请求请到学校核对。';
      await logWrites.catch(() => {});
      try { await this.store.save(); }
      finally { await this.device.setExecution({ token, enabled: false }).catch(() => {}); this.active = false; this.changed(); }
    }
    return run;
  }
  stop(reason = 'user') {
    if (!this.active) return;
    this.reason = reason; this.current.status = 'stopping'; this.controller.abort(); this.changed();
  }
}
