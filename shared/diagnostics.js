// Diagnostic exports never include account sessions, request forms, or headers.
const privateKey = /^(cookies?|session|sessionPath|headers|body|authorization|password|userAgent|userId|accountIdentityId|accountId|accountName|userName|orderId|DHID|YYRGH|YYRXM)$/i;
export function diagnosticValue(value, depth = 0) {
  if (depth > 8) return '[省略]';
  if (typeof value === 'string') return value
    .replace(/\b(MOD_AUTH_CAS|_WEU|JSESSIONID)\s*=\s*[^;\s]+/gi, '$1=[已移除]')
    .replace(/\b(Cookie|Authorization)\s*:\s*[^\r\n]+/gi, '$1: [已移除]')
    .replace(/([?&](?:ticket|token|access_token|password)=)[^&#\s]+/gi, '$1[已移除]')
    .replace(/\b\d{8,}\b/g, '[编号已移除]').slice(0, 1500);
  if (Array.isArray(value)) return value.slice(0, 128).map((item) => diagnosticValue(item, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !privateKey.test(key)).map(([key, item]) => [key, diagnosticValue(item, depth + 1)]));
  return value;
}

export function createDiagnostics({ mode, plans, platform, runtime, buildId } = {}) {
  const accounts = new Map();
  const snapshot = plans?.map((plan) => {
    const id = plan.accountId ?? 'current';
    if (!accounts.has(id)) accounts.set(id, `user-${accounts.size + 1}`);
    return { ...plan, accountRef: accounts.get(id) };
  });
  return { schemaVersion: 1, engineVersion: 'slot-scoped-v2', platform, runtime, buildId, mode,
    plans: diagnosticValue(snapshot), events: 0, uiEventsDropped: 0,
    journalTruncated: false, counts: {}, slotSummaries: {}, summaries: {} };
}

export function recordDiagnostic(diagnostics, level, message, details) {
  const entry = { sequence: ++diagnostics.events, time: new Date().toISOString(), level,
    message: /^使用账号：/.test(message) ? '使用选定账号（身份已验证）' : diagnosticValue(message),
    details: diagnosticValue(details) };
  const event = details?.event;
  if (event) diagnostics.counts[event] = (diagnostics.counts[event] ?? 0) + 1;
  if (event === 'execution_summary') diagnostics.summaries[details.planId ?? 'current'] = diagnosticValue(details);
  if (['booking_response', 'booking_error', 'catalog_query'].includes(event)) {
    const key = JSON.stringify([details.planId ?? details.targetIndex, details.date, details.time]);
    const slot = diagnostics.slotSummaries[key] ??= { planId: details.planId, targetIndex: details.targetIndex,
      date: details.date, time: details.time, queries: 0, attempts: 0 };
    if (event === 'catalog_query') slot.queries++;
    else slot.attempts++;
    Object.assign(slot, { lastOutcome: details.outcome, lastMessage: diagnosticValue(details.message),
      lastCourt: details.court, lastDurationMs: details.durationMs });
  }
  return entry;
}

export function exportDiagnostics(record, journal = []) {
  const logs = new Map([...journal, ...(record.logs ?? [])].map((entry, index) =>
    [entry.sequence ?? `legacy-${index}`, diagnosticValue(entry)]));
  const events = [...logs.values()].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
  return { format: 'szu-court-diagnostics/v1', exportedAt: new Date().toISOString(),
    executionId: record.id, status: record.status, startedAt: record.startedAt, finishedAt: record.finishedAt,
    error: diagnosticValue(record.error), diagnostics: diagnosticValue(record.diagnostics),
    successes: diagnosticValue(record.successes ?? []),
    pendingRequests: diagnosticValue(record.pendingRequests ?? record.inFlight),
    retainedEvents: events.length, missingEvents: Math.max(0, (record.diagnostics?.events ?? events.length) - events.length), events };
}
