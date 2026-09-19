// Harmless end-to-end scheduler probe. Its session path deliberately does not exist,
// so the worker must exit before making any request to the school.
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { NativeScheduler } from '../desktop/src/native-scheduler.js';
import { writeJson, readJson } from '../desktop/src/jobs.js';
import { sleep } from '../shared/utils.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const dir = await mkdtemp(join(tmpdir(), 'szu-scheduler-probe-'));
const id = randomUUID(), jobDir = join(dir, 'jobs', id);
await mkdir(jobDir, { recursive: true });
const scheduler = new NativeScheduler({ root, worker: join(root, 'src', 'dispatcher.js') });
await writeJson(join(jobDir, 'job.json'), { id, taskId: 'probe', mode: 'check', releaseAt: Date.now(),
  sessionPath: join(dir, 'deliberately-missing-session.json'), createdAt: new Date().toISOString(),
  config: { scheduler: { timeoutMs: 60000 }, targets: [] } });
await writeJson(join(jobDir, 'state.json'), { status: 'scheduled', logs: [], successes: [] });
try {
  await scheduler.register(id, dir, Date.now() + 10_000);
  console.log('已注册无网络请求的测试任务，等待系统启动执行器。');
  const deadline = Date.now() + 60_000;
  let state;
  while (Date.now() < deadline) {
    state = await readJson(join(jobDir, 'state.json'));
    if (state.finishedAt) break;
    await sleep(500);
  }
  if (state?.status !== 'error' || !state.error?.includes('deliberately-missing-session')) {
    throw new Error(`系统未按预期启动执行器：${JSON.stringify(state)}`);
  }
  console.log('验证通过：系统启动 → 独立执行器 → 错误日志落盘；未访问学校接口。');
  console.log(`测试日志：${jobDir}`);
} finally {
  await scheduler.remove(id);
  console.log('测试用系统定时项已移除。');
}
