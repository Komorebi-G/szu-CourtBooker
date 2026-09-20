// Compatibility entry for old OS tasks: retire them, never submit bookings.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JobStore } from './jobs.js';
import { NativeScheduler } from './native-scheduler.js';
export { BookingQueue } from './execution.js';

export async function runDispatcher(dataDir, { scheduler = new NativeScheduler({}) } = {}) {
  const store = new JobStore({ dataDir, scheduler });
  const errors = await store.retireSchedules();
  for (const error of errors) console.error(error);
  console.log('系统定时已停用。请打开预约助手，验证登录后手动开始本次执行。');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runDispatcher(resolve(process.argv[2])).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
