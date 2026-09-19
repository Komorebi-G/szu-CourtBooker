const shanghaiFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const shanghaiTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  hour12: false,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  fractionalSecondDigits: 3,
});

export function shanghaiDate(epochMs = Date.now()) {
  return shanghaiFormatter.format(new Date(epochMs));
}

export function addDays(date, days) {
  const [year, month, day] = date.split('-').map(Number);
  const value = new Date(Date.UTC(year, month - 1, day + days));
  return value.toISOString().slice(0, 10);
}

export function resolveDate(value, nowMs = Date.now()) {
  if (value === 'today') return shanghaiDate(nowMs);
  if (value === 'tomorrow') return addDays(shanghaiDate(nowMs), 1);
  if (/^\d{4}-\d{2}-\d{2}$/.test(value ?? '') && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value) return value;
  throw new Error(`无效日期：${value}；请使用 today、tomorrow 或 YYYY-MM-DD`);
}

export function releaseEpoch(date, time) {
  resolveDate(date);
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?$/.test(time ?? '')) {
    throw new Error(`无效放号时间：${time}`);
  }
  return Date.parse(`${date}T${time}+08:00`);
}

export function formatShanghai(epochMs = Date.now()) {
  return shanghaiTimeFormatter.format(new Date(epochMs)).replaceAll('/', '-');
}

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason ?? new DOMException('Aborted', 'AbortError')); return; }
    const abort = () => { clearTimeout(timer); reject(signal.reason ?? new DOMException('Aborted', 'AbortError')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, Math.max(0, ms));
    signal?.addEventListener('abort', abort, { once: true });
  });
}

export async function mapLimit(values, limit, mapper) {
  const items = Array.from(values);
  const results = new Array(items.length);
  let cursor = 0;
  let failure;

  async function worker() {
    while (!failure && cursor < items.length) {
      const index = cursor++;
      try { results[index] = await mapper(items[index], index); }
      catch (error) { failure ??= error; }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker),
  );
  if (failure) throw failure;
  return results;
}

export function splitTimeSlot(value) {
  const match = /^((?:[01]\d|2[0-3]):[0-5]\d)-((?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value ?? '');
  if (!match) throw new Error(`无效时间段：${value}；格式应为 HH:mm-HH:mm`);
  if (match[1] >= match[2]) throw new Error(`时间段结束必须晚于开始：${value}`);
  return { start: match[1], end: match[2] };
}

export function createLogger(stream = process.stdout) {
  return (level, message, details) => {
    const suffix = details === undefined ? '' : ` ${JSON.stringify(details)}`;
    stream.write(`[${formatShanghai()}] ${level.padEnd(5)} ${message}${suffix}\n`);
  };
}
