import { resolveDate, splitTimeSlot } from './utils.js';
export const GOAL_LABELS = { one: '任选一段', consecutive: '连续两段', two: '任意两段' };
export function bookingGoal(plan) {
  // Old single-slot plans predate the goal selector and mean one slot. An
  // explicitly selected two-slot goal must never silently shrink to one.
  return plan.bookingGoal ?? (new Set(plan.times).size === 1 ? 'one' : 'two');
}
export function adjacent(a, b) {
  return a.split('-')[1] === b.split('-')[0] || b.split('-')[1] === a.split('-')[0];
}
export function validateBookingGoal(plan) {
  if (plan.sameCourtAnchor !== undefined && plan.sameCourtAnchor !== null) {
    const anchor = plan.sameCourtAnchor;
    if (typeof anchor !== 'object' || Array.isArray(anchor) || anchor.date !== plan.date
      || typeof anchor.court !== 'string' || !anchor.court.trim() || anchor.court.length > 100) {
      throw new Error('已约相邻场地信息无效，请重新核对学校预约');
    }
    resolveDate(anchor.date); splitTimeSlot(anchor.time);
  }
  const goal = bookingGoal(plan);
  if (!Object.hasOwn(GOAL_LABELS, goal)) throw new Error('请选择有效的预约目标');
  if (goal === 'two' && new Set(plan.times).size < 2) throw new Error('任意两段需要至少选择两个不同的时段');
  if (goal === 'two') {
    const slots = [...new Set(plan.times)].map(splitTimeSlot);
    if (!slots.some((a, i) => slots.some((b, j) => i !== j && (a.end <= b.start || b.end <= a.start)))) {
      throw new Error('任意两段需要至少选择一组互不重叠的时段');
    }
  }
  if (goal === 'consecutive' && !plan.times.some((a) => plan.times.some((b) => a !== b && adjacent(a, b)))) {
    throw new Error('连续两段需要至少选择一组首尾相接的时段');
  }
  return goal;
}
export function goalReached(target, won) {
  const times = [...won];
  const goal = bookingGoal(target);
  if (goal === 'one') return times.length >= 1;
  if (goal === 'consecutive') return times.some((a) => times.some((b) => a !== b && adjacent(a, b)));
  return times.length >= 2;
}
export function goalAllows(target, won, time, eligibleTimes = target.times) {
  if (goalReached(target, won)) return false;
  if (bookingGoal(target) !== 'consecutive') return true;
  const candidates = won.size ? [...won] : eligibleTimes;
  return candidates.some((other) => other !== time && adjacent(other, time));
}
