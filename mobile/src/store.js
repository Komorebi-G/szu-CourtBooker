import { pendingExecutionRequests } from '../../shared/experience.js';
import { goalReached } from '../../shared/booking-goal.js';
import { reviewRequestMatches } from '../../shared/booking-review.js';
import { shanghaiDate } from '../../shared/utils.js';
export const freshState = () => ({ version: 1, accounts: [], plans: [], runs: [], catalogs: {} });
export function pendingMobileRequests(run) {
  return pendingExecutionRequests(run);
}

// Preserve the original execution outcome and request evidence. A school review
// adds a separate resolution; it never rewrites what happened during execution.
export function reviewedMobileRuns(runs, plan, review, { confirmedAbsent = false, confirmedAbsentIds = new Set() } = {}) {
  return runs.map((original) => {
    if (!original.finishedAt) return original;
    const requests = pendingMobileRequests(original).filter((request) => {
      const oldPlan = original.plans?.find((p) => request.planId ? p.id === request.planId : p.name === request.plan || p.name === request.name);
      return (request.accountId ?? oldPlan?.accountId) === plan.accountId && request.date === plan.date
        && (request.project ? request.project === plan.project : !oldPlan || oldPlan.project === plan.project);
    });
    const resolved = requests.flatMap((request) => {
      const schoolSlot = review.resolvedRequests?.find((resolved) => resolved.requestId === request.requestId)?.schoolSlot
        ?? review.booked.find((slot) => reviewRequestMatches(request, slot));
      if (schoolSlot) return [{ ...request, reviewedAt: review.checkedAt, reviewResult: 'booked', schoolSlot }];
      return confirmedAbsent || confirmedAbsentIds.has(request.requestId)
        ? [{ ...request, reviewedAt: review.checkedAt, reviewResult: 'absent', manuallyConfirmed: true }] : [];
    });
    const won = new Set(review.booked.filter((slot) => slot.matchesCourts).map((slot) => slot.time));
    const completedPlans = (original.plans ?? []).filter((p) => p.accountId === plan.accountId && p.date === plan.date
      && p.project === plan.project && p.id === plan.id && goalReached(p, won));
    if (!resolved.length && !completedPlans.length) return original;
    const run = structuredClone(original);
    run.reviewedRequests ??= {};
    for (const request of resolved) {
      run.reviewedRequests[request.requestId] = request;
      if (run.pendingRequests) delete run.pendingRequests[request.requestId];
      if ((run.inFlight?.requestId ?? 'legacy') === request.requestId) delete run.inFlight;
      if (request.reviewResult === 'booked') {
        const oldPlan = run.plans?.find((p) => request.planId ? p.id === request.planId : p.name === request.plan || p.name === request.name);
        const slot = request.schoolSlot;
        run.successes ??= [];
        if (!run.successes.some((success) => success.requestId === request.requestId
          || success.planId === (request.planId ?? oldPlan?.id) && reviewRequestMatches(success, slot))) {
          run.successes.push({ requestId: request.requestId, planId: request.planId ?? oldPlan?.id,
            accountId: request.accountId ?? oldPlan?.accountId, name: request.plan ?? oldPlan?.name,
            project: request.project ?? oldPlan?.project, date: slot.date, time: slot.time,
            courtId: slot.courtId, court: slot.court, venueCode: slot.venueCode, sportCode: slot.sportCode,
            campusCode: slot.campusCode, modeCode: slot.modeCode, confirmed: true, reviewedAt: review.checkedAt });
        }
      }
    }
    if (run.pendingRequests) {
      const first = Object.values(run.pendingRequests)[0];
      if (first) run.inFlight = first; else delete run.inFlight;
    }
    for (const item of run.items ?? []) if (completedPlans.some((p) => p.id === item.id)) {
      item.reviewedOutcome = 'success'; item.reviewedAt = review.checkedAt;
    } else if (resolved.some((request) => request.reviewResult === 'booked' && (request.planId === item.id
      || !request.planId && (request.plan === item.name || request.name === item.name)))) {
      item.reviewedOutcome = 'partial'; item.reviewedAt = review.checkedAt;
    } else if (resolved.some((request) => request.reviewResult === 'absent' && (request.planId === item.id
      || !request.planId && (request.plan === item.name || request.name === item.name)))
      && !pendingMobileRequests(run).some((request) => request.planId === item.id || !request.planId && request.plan === item.name)) {
      item.reviewedOutcome = run.successes?.some((success) => success.planId === item.id) ? 'partial' : 'no_result';
      item.reviewedAt = review.checkedAt;
    }
    if ((run.items ?? []).length && run.items.every((i) => i.status === 'success' || i.reviewedOutcome === 'success')) {
      run.reviewedOutcome = 'success'; run.reviewedAt = review.checkedAt;
    } else if (resolved.some((request) => request.reviewResult === 'booked')) {
      run.reviewedOutcome = 'partial'; run.reviewedAt = review.checkedAt;
    } else if (resolved.some((request) => request.reviewResult === 'absent') && !pendingMobileRequests(run).length) {
      run.reviewedOutcome = run.successes?.length ? 'partial' : 'no_result'; run.reviewedAt = review.checkedAt;
    }
    return run;
  });
}
export class MobileStore {
  constructor(device) { this.device = device; this.state = freshState(); this.pending = Promise.resolve(); }
  async load() {
    const { value, dispatchedRequests = {}, dispatchJournalAvailable = false } = await this.device.readState();
    if (!value && Object.keys(dispatchedRequests).length) throw new Error('发现预约发送记录，但主数据缺失。已停止加载，请先核对学校订单并保留本地数据');
    if (value) {
      const data = JSON.parse(value);
      if (data.version !== 1 || !Array.isArray(data.accounts) || !Array.isArray(data.plans) || !Array.isArray(data.runs)) {
        throw new Error('本地数据格式异常，已停止加载以免覆盖原数据');
      }
      this.state = { ...freshState(), ...data };
      for (const run of this.state.runs) if (run.dispatchJournalVersion === 1) run.dispatchJournalChecked = dispatchJournalAvailable;
      if (dispatchJournalAvailable) for (const [id, marker] of Object.entries(dispatchedRequests)) {
        const run = this.state.runs.find((entry) => entry.id === marker.runId)
          ?? this.state.runs.find((entry) => entry.pendingRequests?.[id] || entry.knownRequests?.[id]);
        if (!run) throw new Error('预约发送记录无法对应本地执行。已停止加载，请先核对学校订单并保留本地数据');
        if (run.reviewedRequests?.[id]) {
          if (run.pendingRequests) delete run.pendingRequests[id];
          if (run.inFlight?.requestId === id) delete run.inFlight;
          continue;
        }
        const stored = run.knownRequests?.[id] ?? run.pendingRequests?.[id];
        if (stored) for (const field of ['courtId', 'venueCode', 'sportCode', 'campusCode', 'modeCode',
          'accountId', 'accountIdentityId', 'date', 'time', 'planId']) {
          const old = stored[field], incoming = marker[field];
          const present = value => value !== undefined && value !== null && value !== '';
          if (present(old) && present(incoming) && (field === 'modeCode'
            ? Number(old) !== Number(incoming) : String(old) !== String(incoming))) {
            throw new Error(`预约发送记录与主数据的${field}不一致。已停止加载，请保留本地数据并核对学校订单`);
          }
          if (!present(old) && present(incoming)) stored[field] = incoming;
        }
        const known = run.knownRequests?.[id];
        if (known) {
          const success = run.successes?.find(entry => entry.requestId === id);
          if (success) for (const field of ['courtId', 'venueCode', 'sportCode', 'campusCode', 'modeCode']) {
            if (known[field] != null && success[field] == null) success[field] = known[field];
          }
          if (run.pendingRequests) delete run.pendingRequests[id];
          if (run.inFlight?.requestId === id) delete run.inFlight;
          if (known.code === '0' && !(run.successes ?? []).some((success) => success.requestId === id)) {
            run.successes ??= [];
            run.successes.push({ requestId: id, planId: known.planId, name: known.plan, accountId: known.accountId,
              date: known.date, time: known.time, court: known.court, courtId: known.courtId,
              venueCode: known.venueCode, sportCode: known.sportCode, campusCode: known.campusCode, modeCode: known.modeCode, orderId: known.orderId });
          }
        } else if (!run.pendingRequests?.[id]) {
          if (!marker.date || !marker.time || !marker.accountId) throw new Error('发现无法识别时段的预约发送记录。已停止加载，请先核对学校订单并保留本地数据');
          run.pendingRequests ??= {};
          run.pendingRequests[id] = { ...marker, state: 'unknown', orphaned: true, requestId: id };
        }
      }
      for (const run of this.state.runs) if (run.dispatchJournalVersion === 1 && dispatchJournalAvailable) {
        for (const [id, request] of Object.entries(run.pendingRequests ?? {})) {
          const marker = dispatchedRequests[id];
          if (marker) { request.state = 'unknown'; request.sentAt = new Date(marker.sentAt).toISOString(); }
          else if (request.state === 'prepared') delete run.pendingRequests[id];
        }
        const first = Object.values(run.pendingRequests ?? {})[0];
        if (first) run.inFlight = first; else delete run.inFlight;
      }
      for (const run of this.state.runs) if (!run.finishedAt) {
        run.status = 'interrupted'; run.error = pendingMobileRequests(run).length
          ? '上次执行已中断，有请求结果未确认，请查看学校预约。'
          : '上次执行已中断，可重新开始预约。';
        run.finishedAt = new Date().toISOString();
        for (const item of run.items ?? []) if (['preparing', 'waiting', 'booking', 'stopping'].includes(item.status)) {
          item.status = 'interrupted'; item.error = run.error;
        }
      }
      await this.save();
      // The native write has durably saved these responses and removed their
      // markers. Future snapshots no longer need the temporary response ledger.
      for (const run of this.state.runs) for (const id of Object.keys(run.knownRequests ?? {})) {
        if (!run.pendingRequests?.[id]) delete run.knownRequests[id];
      }
    }
    return this.state;
  }
  save() {
    // Catalog/cookie writes must wait for an edit's outcome before taking their
    // snapshot, or they could persist an edit whose own write failed.
    if (this.editing) return this.editing.catch(() => {}).then(() => this.save());
    const work = this.pending.catch(() => {}).then(async () => {
      if (!await this.compactHistory()) await this.device.writeState({ value: JSON.stringify(this.state) });
    });
    this.pending = work; return work;
  }
  async compactHistory() {
    // Archive resolved finished runs outside execution. Keep active/uncertain
    // requests and the latest result for each current plan in the hot state.
    if (this.state.runs.length <= 50 || this.state.runs.some((run) => !run.finishedAt) || !this.device.archiveRuns) return;
    const protectedRuns = new Set();
    for (const plan of this.state.plans.filter((plan) => plan.date >= shanghaiDate())) {
      const latest = this.state.runs.find((run) => run.plans?.some((old) => old.id === plan.id));
      if (latest) protectedRuns.add(latest.id);
    }
    const archive = this.state.runs.filter((run, index) => index >= 50 && run.finishedAt
      && !pendingMobileRequests(run).length && !protectedRuns.has(run.id));
    if (!archive.length) return;
    for (let i = 0; i < archive.length; i += 10) await this.device.archiveRuns({ runs: archive.slice(i, i + 10) });
    const ids = new Set(archive.map((run) => run.id));
    // Publish only after both the archive and new main-state snapshot are durable.
    const next = { ...this.state, runs: this.state.runs.filter((run) => !ids.has(run.id)),
      archivedRunCount: (this.state.archivedRunCount ?? 0) + archive.length };
    await this.device.writeState({ value: JSON.stringify(next) });
    this.state.runs = next.runs; this.state.archivedRunCount = next.archivedRunCount;
    return true;
  }
  // Publish edits only after the write succeeds; keep untouched references for
  // ongoing catalog/cookie responses. Execution snapshots still use save().
  async update(changes) {
    if (this.editing) throw new Error('正在保存，请稍候');
    const work = this.pending.catch(() => {}).then(async () => {
      const next = { ...this.state, ...changes };
      await this.device.writeState({ value: JSON.stringify(next) });
      this.state = next;
    });
    this.pending = this.editing = work;
    try { await work; }
    finally { this.editing = null; }
  }
}
