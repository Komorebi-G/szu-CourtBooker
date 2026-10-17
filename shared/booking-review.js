import { adjacent, goalReached } from './booking-goal.js';
import { resolveDate, splitTimeSlot } from './utils.js';
import { matchesCourtSelection } from './planner.js';

function validTime(time) {
  try { splitTimeSlot(time); return true; } catch { return false; }
}

const overlaps = (a, b) => validTime(a) && validTime(b)
  && a.split('-')[0] < b.split('-')[1] && b.split('-')[0] < a.split('-')[1];

export function reviewRequestMatches(request, slot) {
  if (request.date !== slot.date || request.time !== slot.time) return false;
  for (const [field, roomField] of [['venueCode', 'CGBM'], ['sportCode', 'XMDM'], ['campusCode', 'XQDM'], ['modeCode', 'YYLX']]) {
    const expected = request[field] ?? request.room?.[roomField], actual = slot[field];
    if (expected != null && expected !== '' && actual != null && actual !== ''
      && (field === 'modeCode' ? Number(expected) !== Number(actual) : String(expected) !== String(actual))) return false;
  }
  const courtId = request.courtId ?? request.room?.WID;
  if (courtId && slot.courtId) return String(courtId) === String(slot.courtId);
  const court = request.court ?? request.room?.CDMC;
  return Boolean(court && slot.court && court === slot.court);
}

function schoolSlot(row) {
  const text = (value) => String(value ?? '').trim();
  // The school's order list uses YYSJD as well as the booking form's separate
  // date/time fields. YYSJD may contain the date and seconds, not just HH:mm.
  const period = text(row.KYYSJD) || text(row.YYSJD);
  const dateText = (text(row.YYRQ) || text(row.YYKS) || text(row.YYSJD) || period).replaceAll('/', '-').slice(0, 10);
  let date = null;
  try { if (/^\d{4}-\d{2}-\d{2}$/.test(dateText)) date = resolveDate(dateText); }
  catch { /* Keep malformed dates unresolved. */ }
  const clock = (value) => /(?:^|[ T])(\d{2}:\d{2})(?::\d{2})?$/.exec(text(value))?.[1];
  const range = /^(?:\d{4}[-/]\d{2}[-/]\d{2}[ T])?(\d{2}:\d{2})(?::\d{2})?\s*[-~]\s*(?:\d{4}[-/]\d{2}[-/]\d{2}[ T])?(\d{2}:\d{2})(?::\d{2})?$/.exec(period);
  const time = range ? `${range[1]}-${range[2]}`
    : !period && clock(row.YYKS) && clock(row.YYJS) ? `${clock(row.YYKS)}-${clock(row.YYJS)}` : null;
  const statusCode = text(row.YYZT);
  const status = text(row.YYZT_DISPLAY) || text(row.DDZT_DISPLAY) || text(row.ZT_DISPLAY) || text(row.STATUS_DISPLAY);
  // Codes from the school's order response and myBooking.js. A translated
  // label must not turn a confirmed cancellation into an unknown active order.
  const nativeStatus = statusCode === 'CG_QX' ? 'cancelled' : ['CG_YY', 'CG_WC'].includes(statusCode) ? 'active' : null;
  const cancelled = nativeStatus ? nativeStatus === 'cancelled'
    : /^(已取消|取消|取消预约|预约取消|预约已取消|已退订|退订|已退款|退款|已失效|失效|已过期)$/.test(status);
  const active = nativeStatus ? nativeStatus === 'active'
    : /^(预约成功|已预约|待支付|未支付|已支付|待付款|已付款|预约中|已完成)$/.test(status);
  return { date, time, status, statusCode, cancelled, active, sportCode: row.XMDM, sportName: row.XMMC ?? row.XMDM_DISPLAY,
    courtId: row.CDWID, venueCode: row.CGBM ?? row.CGDM,
    campusCode: row.XQDM ?? row.XQWID, modeCode: row.YYLX,
    court: row.CDMC ?? row.CDWID_DISPLAY ?? '学校已约场地' };
}

// Scope includes every order that can occupy this account/project/day's quota,
// even when its time is not selected by the current plan.
export function schoolBookingScope({ date, target, rows }) {
  if (!Array.isArray(rows)) throw new Error('学校预约记录不完整，请重新核对');
  const bookings = [], unresolved = [];
  for (const row of rows) {
    const slot = schoolSlot(row);
    if (slot.date && slot.date !== date) continue;
    // A cancellation/refund request can still occupy quota. Only explicit
    // terminal states establish that the order is no longer active.
    if (slot.cancelled) continue;
    const sportKnown = (slot.sportCode != null && String(slot.sportCode).trim() !== '') || Boolean(slot.sportName);
    if (sportKnown && String(slot.sportCode) !== String(target.sportCode) && slot.sportName !== target.sportName) continue;
    if (slot.date === date && validTime(slot.time) && sportKnown && slot.active) {
      bookings.push(slot);
    } else {
      const issues = [!slot.date && '日期无法识别', !validTime(slot.time) && '时段无法识别',
        !sportKnown && '缺少项目', !slot.active && `预约状态“${slot.status || slot.statusCode || '空'}”无法识别`].filter(Boolean);
      unresolved.push({ ...slot, reason: `学校记录${issues.join('、')}，请人工核对` });
    }
  }
  return { bookings, unresolved };
}

// Only explicit active school orders establish success. Unknown status/fields
// remain visible for manual review, never silently interpreted as an empty list.
export function reviewBookings({ plan, target, rows, pending = [], known = [], now }) {
  const { bookings: dailyBookings, unresolved } = schoolBookingScope({ date: plan.date, target, rows });
  const booked = [], blockedTimes = new Set(), dailyTimes = new Set();
  for (const slot of dailyBookings) {
    dailyTimes.add(slot.time);
    const overlapsSelected = plan.times.filter((time) => overlaps(time, slot.time));
    for (const time of overlapsSelected) blockedTimes.add(time);
    if (plan.times.includes(slot.time)) {
      const allowed = matchesCourtSelection({ ...target, venues: target.venues ?? [],
        includeOtherCourts: plan.includeOtherCourts, courtLabels: plan.courtLabels },
      { WID: slot.courtId, CDMC: slot.court, CGBM: slot.venueCode, XQDM: slot.campusCode, YYLX: slot.modeCode });
      booked.push({ ...slot, matchesCourts: Boolean(allowed) });
      if (!allowed) unresolved.push({ ...slot, reason: '学校已约场地与本方案选择不一致，此时段不能重复预约' });
    } else if (overlapsSelected.length) unresolved.push({ ...slot, reason: '学校已有预约与所选时段重叠，重叠候选已排除' });
  }
  const won = new Set(booked.filter((s) => s.matchesCourts).map((s) => s.time));
  const resolvedRequests = [];
  for (const request of [...pending, ...known]) {
    const matched = dailyBookings.find((slot) => reviewRequestMatches(request, slot));
    if (matched && pending.includes(request)) resolvedRequests.push({ ...request, reviewResult: 'booked', schoolSlot: matched });
    if (request.date === plan.date && !matched) {
      unresolved.push({ date: request.date, time: request.time, court: request.court ?? request.room?.CDMC,
        reason: '本地有成功或待确认记录，学校查询尚未对应确认；请核对是否已取消或仍在处理' });
    }
  }
  const reached = goalReached(plan, won);
  const dailyLimitReached = dailyTimes.size >= 2;
  const futureTimes = plan.times.filter((time) => now === undefined
    || Date.parse(`${plan.date}T${time.split('-')[0]}:00+08:00`) > now);
  let remainingTimes = reached || dailyLimitReached ? [] : futureTimes.filter((t) => !blockedTimes.has(t));
  if (plan.bookingGoal === 'consecutive' && won.size) remainingTimes = remainingTimes.filter((t) => [...won].some((w) => adjacent(w, t)));
  if (plan.bookingGoal === 'consecutive' && !won.size && (dailyTimes.size
    || !remainingTimes.some((a) => remainingTimes.some((b) => a !== b && adjacent(a, b))))) remainingTimes = [];
  const remainingGoal = won.size && plan.bookingGoal === 'consecutive' ? 'one'
    : plan.bookingGoal === 'one' || dailyTimes.size || remainingTimes.length === 1 ? 'one' : plan.bookingGoal ?? 'two';
  const sameCourtAnchor = plan.preferSameCourt ? [...booked].reverse().find((s) => s.matchesCourts && remainingTimes.some((t) => adjacent(t, s.time))) : undefined;
  // A copied plan may already carry the school-confirmed neighboring slot.
  const priorAnchor = plan.sameCourtAnchor && dailyBookings.some((slot) => {
    return reviewRequestMatches({ ...plan.sameCourtAnchor, date: plan.date }, slot);
  }) ? plan.sameCourtAnchor : undefined;
  return { booked, unresolved, resolvedRequests, remainingTimes, remainingGoal, sameCourtAnchor: sameCourtAnchor ?? priorAnchor,
    goalReached: reached, dailyLimitReached, dailyTimes: [...dailyTimes],
    reason: reached ? '预约目标已完成' : dailyLimitReached ? '学校已有两个时段，已达工具设置的该项目当天上限'
      : !futureTimes.length ? '候选时段已开始，核对完成后可复用到新日期'
        : !remainingTimes.length ? '没有可执行的剩余时段，请查看学校已有预约和本方案要求' : undefined,
    checkedAt: new Date().toISOString() };
}
