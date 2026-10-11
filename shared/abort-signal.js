// Android WebView 109 supports AbortController but not AbortSignal.any().
// Release listeners once a composed operation finishes or is cancelled.
export function combineAbortSignals(signals) {
  const sources = signals.filter(Boolean);
  const controller = new AbortController();
  const listeners = [];
  const dispose = () => {
    for (const [signal, listener] of listeners) signal.removeEventListener('abort', listener);
    listeners.length = 0;
  };
  for (const signal of sources) {
    if (signal.aborted) { controller.abort(signal.reason); dispose(); break; }
    const listener = () => { controller.abort(signal.reason); dispose(); };
    signal.addEventListener('abort', listener, { once: true });
    listeners.push([signal, listener]);
  }
  return { signal: controller.signal, dispose };
}

export function timedAbortSignal(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('请求超时', 'TimeoutError')), timeoutMs);
  timer.unref?.();
  return { signal: controller.signal, dispose: () => clearTimeout(timer) };
}
