import { Capacitor, registerPlugin } from '@capacitor/core';
import { RequestNotSentError } from '../../shared/errors.js';
import { RequestQueue } from '../../shared/request-queue.js';
import { RequestGate } from '../../shared/request-gate.js';
export const native = Capacitor.isNativePlatform();
const plugin = registerPlugin('CourtDevice');
export const device = native ? plugin : {
  async login() { throw new Error('请在 Android App 中使用学校登录；网页预览可以导入 JSON'); },
  async readState() { return { value: localStorage.getItem('szu-mobile-v1') }; },
  async writeState({ value }) { localStorage.setItem('szu-mobile-v1', value); },
  async archiveRuns({ runs }) {
    for (const run of runs) localStorage.setItem(`szu-mobile-run:${Date.parse(run.startedAt)}-${run.id}`, JSON.stringify(run));
  },
  async readRunArchives({ before = '', limit = 20 } = {}) {
    const keys = Object.keys(localStorage).filter((key) => key.startsWith('szu-mobile-run:')).sort().reverse();
    const chosen = keys.filter((key) => !before || key.slice(15) < before).slice(0, limit);
    return { runs: chosen.map((key) => JSON.parse(localStorage.getItem(key))),
      cursor: chosen.at(-1)?.slice(15) ?? '', count: keys.length, hasMore: keys.filter((key) => !before || key.slice(15) < before).length > chosen.length };
  },
  async request() { throw new Error('网页仅用于界面预览。请安装 Android APK 连接学校。'); },
  async cancelRequest() {},
  async setExecution() { throw new Error('请在 Android App 内执行预约'); },
  async copy({ text }) { await navigator.clipboard.writeText(text); },
  async saveText({ text, fileName }) {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = fileName; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return { cancelled: false };
  },
  async addListener() { return { remove() {} }; },
};

// Preserve individual Set-Cookie headers; no shared WebView cookie jar.
const requestQueues = new WeakMap();
const accountGates = new WeakMap();
// A posted task lets the caller finish interpreting the response before the
// account's next dispatch, without the minimum delay of setTimeout(0).
let responseChannel, responseTasks = [];
function afterResponse() {
  if (!responseChannel) {
    responseChannel = new MessageChannel();
    responseChannel.port1.onmessage = () => {
      responseTasks.shift()?.();
      if (!responseTasks.length) { responseChannel.port1.unref?.(); responseChannel.port2.unref?.(); }
    };
    responseChannel.port1.unref?.(); responseChannel.port2.unref?.();
  }
  return new Promise((resolve) => {
    responseTasks.push(resolve); responseChannel.port1.ref?.(); responseChannel.port2.ref?.(); responseChannel.port2.postMessage(null);
  });
}
export function nativeTransport(device, token = null, accountId = token ?? 'unbound', {
  parallelQueries = false, rateLimitBackoffMs = 1000 } = {}) {
  if (!requestQueues.has(device)) requestQueues.set(device, new Map());
  if (!accountGates.has(device)) accountGates.set(device, new Map());
  const queues = requestQueues.get(device), gates = accountGates.get(device);
  const gateFor = (key) => {
    if (!gates.has(key)) gates.set(key, new RequestGate({ backoffMs: rateLimitBackoffMs }));
    return gates.get(key);
  };
  let accountKey = `local:${accountId}`, gate = gateFor(accountKey);
  const transport = async (url, options) => {
    const queuedAt = Date.now();
    if (!queues.has(accountKey)) {
      const key = accountKey;
      const queue = new RequestQueue({ after: afterResponse, idle: () => {
        if (queues.get(key) === queue) queues.delete(key);
      } });
      queues.set(key, queue);
    }
    const queue = queues.get(accountKey);
    const mutation = /\/(?:insertVenueBookingInfo|cancelSelectBookingInfo)\.do(?:\?|$)/.test(String(url));
    return queue.run(async () => {
      await gate.wait({ signal: options.dispatchSignal, deadline: options.deadlineMs,
        intervalMs: options.intervalMs, reserve: mutation, onWait: options.onWait });
      options.beforeDispatch?.();
      if (options.signal?.aborted && options.abortInFlight) throw new RequestNotSentError('准备请求已取消，未发送请求');
      if (Number.isFinite(options.deadlineMs) && Date.now() >= options.deadlineMs) {
        throw new RequestNotSentError('执行窗口已结束，未发送请求');
      }
      const requestId = options.requestId ?? crypto.randomUUID();
      const cancel = () => { void Promise.resolve(device.cancelRequest?.({ requestId })).catch(() => {}); };
      if (options.abortInFlight) options.signal?.addEventListener('abort', cancel, { once: true });
      let result;
      const startedAt = Date.now();
      options.onDispatch?.({ startedAt });
      try { result = await device.request({ url: String(url), method: options.method, requestId, accountId, requestMetadata: options.requestMetadata,
        headers: options.headers, body: options.body?.toString(), token, deadlineMs: options.deadlineMs, timeoutMs: options.timeoutMs ?? 8000 }); }
      finally { options.signal?.removeEventListener('abort', cancel); }
      const endedAt = Date.now();
      const values = Object.fromEntries(Object.entries(result.headers).map(([key, value]) => [key.toLowerCase(), value]));
      const nativeTiming = Object.fromEntries(['nativeQueueMs', 'dispatchPreparationMs', 'networkStartedAt', 'networkEndedAt', 'networkDurationMs']
        .filter(key => Number.isFinite(result.timing?.[key]) && result.timing[key] >= 0).map(key => [key, result.timing[key]]));
      // Native durable marking happens after the JS reservation. Anchor the
      // next interval to the observed network phase, so slow preparation cannot
      // make two very fast POSTs reach the school closer than configured.
      // A full response longer than the interval still needs no extra wait.
      if (mutation && nativeTiming.networkDurationMs !== undefined) {
        gate.lastDispatchAt = Math.max(gate.lastDispatchAt, gate.now() - nativeTiming.networkDurationMs);
      }
      let parsed;
      try { parsed = JSON.parse(result.body); } catch { /* Caller handles unknown responses. */ }
      const cooldownMs = gate.observe(parsed, { status: result.status, retryAfter: values['retry-after']?.join(', '), mutation });
      return { status: result.status, ok: result.status >= 200 && result.status < 300, startedAt, endedAt,
        queueMs: startedAt - queuedAt,
        ...(Object.keys(nativeTiming).length ? { nativeTiming } : {}),
        cooldownMs, dispatchSignal: options.dispatchSignal,
        headers: { get: (name) => values[name.toLowerCase()]?.join(', ') ?? null,
          getSetCookie: () => values['set-cookie'] ?? [] }, text: async () => result.body };
    }, { exclusive: mutation || !parallelQueries });
  };
  transport.handlesDispatch = true;
  transport.getRequestGate = () => gate;
  transport.bindIdentity = (id) => {
    accountKey = `user:${id}`;
    const shared = gateFor(accountKey); shared.absorb(gate); gate = shared;
  };
  return transport;
}
