import { mkdir, readFile, writeFile, rename, readdir, access, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { validateExecutionStart } from '../../shared/runner.js';

export const JOB_ACTIVE = ['scheduled', 'queued', 'preparing', 'checking', 'waiting', 'booking', 'stopping'];
export async function writeJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }).catch(() => {}); }
}
export const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
export const exists = async (path) => access(path).then(() => true, () => false);

export class JobStore {
  constructor({ dataDir, root, worker, sessionPath, scheduler, startJob, execution }) {
    Object.assign(this, { dataDir, root, worker, sessionPath, scheduler, startJob, execution });
  }
  path(id) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('任务记录编号无效');
    return join(this.dataDir, 'jobs', id);
  }
  async get(id) {
    const dir = this.path(id);
    const job = await readJson(join(dir, 'job.json'));
    const failure = this.execution?.failures.get(dir);
    const state = failure?.executionState ? structuredClone(failure.executionState) : await readJson(join(dir, 'state.json'));
    const stopped = await exists(join(dir, 'stop'));
    if (stopped && JOB_ACTIVE.includes(state.status)) state.status = state.pid ? 'stopping' : 'stopped';
    if (state.pid && JOB_ACTIVE.includes(state.status)) {
      let alive = true;
      try { process.kill(state.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
      if (state.pid === process.pid && this.execution && !this.execution.active.has(dir)) alive = false;
      if (!alive) {
        state.status = stopped ? 'stopped' : 'interrupted';
        state.error = stopped ? null : '上次执行已中断，不会自动重跑；请核对学校预约后重新登录并启动剩余时段';
      }
    }
    return { id, mode: job.mode, taskId: job.taskId, releaseAt: job.releaseAt, createdAt: job.createdAt,
      accountId: job.accountId ?? 'default', accountName: job.accountName ?? '我的账号', target: job.config.targets[0], ...state };
  }
  async list() {
    const ids = await readdir(join(this.dataDir, 'jobs')).catch((error) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    return Promise.all(ids.filter((id) => /^[a-f0-9-]{36}$/.test(id)).map((id) => this.inspect(id)));
  }
  async inspect(id) {
    try { return await this.get(id); }
    catch (error) {
      const job = await readJson(join(this.path(id), 'job.json')).catch(() => ({}));
      return { id, mode: job?.mode, taskId: job?.taskId, createdAt: job?.createdAt ?? new Date(0).toISOString(),
        status: 'corrupt', successes: [], logs: [],
        error: `本地执行记录无法读取（${error.code ?? '格式异常'}），原文件已保留；请先核对学校预约` };
    }
  }
  async retireSchedules() {
    const errors = [];
    for (const job of await this.list()) {
      if ((job.mode !== 'schedule' && job.status !== 'corrupt') || await exists(join(this.path(job.id), 'schedule-retired'))) continue;
      try {
        // Write stop before OS cleanup, so even an old worker will not submit.
        await writeFile(join(this.path(job.id), 'stop'), 'legacy execution disabled', { mode: 0o600 });
        await this.scheduler.remove(job.id);
        await writeFile(join(this.path(job.id), 'schedule-retired'), 'disabled', { mode: 0o600 });
      } catch (error) { errors.push(`旧定时项清理失败：${error.message}；请在历史记录中停止或删除后重试`); }
    }
    return errors;
  }
  async create(target, config, mode, account = {}) {
    const releaseAt = validateExecutionStart(mode, target.date);
    if (!this.startJob) throw new Error('请在预约助手内手动启动本次执行');
    const id = randomUUID();
    const dir = this.path(id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const job = { id, taskId: target.id, mode, releaseAt, sessionPath: account.sessionPath ?? this.sessionPath,
      accountId: target.accountId ?? 'default', accountName: account.name ?? '我的账号', accountIdentityId: account.userId,
      createdAt: new Date().toISOString(), config: { ...config,
        scheduler: { ...config.scheduler, pollIntervalMs: target.intervalMs ?? 100,
          pollJitterMs: 0, timeoutMs: target.durationMs ?? 60_000 },
        targets: [{ ...target, enabled: true }] } };
    await writeJson(join(dir, 'job.json'), job);
    await writeJson(join(dir, 'state.json'), { status: 'queued', pid: process.pid, logs: [], successes: [] });
    try {
      this.startJob(dir);
    } catch (error) {
      await writeFile(join(dir, 'stop'), 'start failed', { mode: 0o600 });
      await writeJson(join(dir, 'state.json'), { status: 'error', logs: [], successes: [],
        error: `未能启动：${error.message}`, finishedAt: new Date().toISOString() });
      throw new Error(`未能启动：${error.message}`);
    }
    return this.get(id);
  }
  async stop(id) {
    this.execution?.stop(this.path(id));
    const job = await this.inspect(id);
    await writeFile(join(this.path(id), 'stop'), 'user requested stop', { mode: 0o600 });
    if (job.mode === 'schedule' || job.status === 'corrupt') await this.scheduler.remove(id);
    return this.inspect(id);
  }
  async remove(id) {
    const job = await this.stop(id);
    if (this.execution?.active.has(this.path(id)) || JOB_ACTIVE.includes(job.status)) throw new Error('正在等待已发出的请求返回，请稍后删除');
    if (job.status === 'corrupt') {
      const lock = await readFile(join(this.path(id), 'run.lock'), 'utf8').catch((error) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (lock !== null) {
        const pid = Number(lock);
        let alive = true;
        if (Number.isSafeInteger(pid) && pid > 0) {
          try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
        }
        if (alive) throw new Error('记录损坏且执行锁尚未释放，请先停止正在运行的助手');
      }
    }
    const trash = join(this.dataDir, 'trash');
    await mkdir(trash, { recursive: true, mode: 0o700 });
    await rename(this.path(id), join(trash, id));
  }
}
