import { mkdir, readFile, writeFile, rename, readdir, access } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { bookingReleaseAt } from '../../shared/runner.js';
import { withinRecoveryWindow } from './recovery.js';

export const JOB_ACTIVE = ['scheduled', 'preparing', 'checking', 'waiting', 'booking', 'stopping'];
export async function writeJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(temporary, path);
}
export const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
export const exists = async (path) => access(path).then(() => true, () => false);

export class JobStore {
  constructor({ dataDir, root, worker, sessionPath, scheduler }) {
    Object.assign(this, { dataDir, root, worker, sessionPath, scheduler });
  }
  path(id) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('任务记录编号无效');
    return join(this.dataDir, 'jobs', id);
  }
  async get(id) {
    const dir = this.path(id);
    const job = await readJson(join(dir, 'job.json'));
    const state = await readJson(join(dir, 'state.json'));
    const stopped = await exists(join(dir, 'stop'));
    if (stopped && JOB_ACTIVE.includes(state.status)) state.status = state.pid ? 'stopping' : 'stopped';
    if (state.pid && JOB_ACTIVE.includes(state.status)) {
      let alive = true;
      try { process.kill(state.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
      if (!alive) {
        state.status = stopped ? 'stopped' : job.mode === 'schedule' && withinRecoveryWindow(job) ? 'scheduled' : 'interrupted';
        state.error = stopped ? null : state.status === 'scheduled' ? '执行已中断，等待恢复剩余时段' : '执行程序已退出，超过恢复窗口；请核对学校预约记录';
      }
    }
    if (state.status === 'scheduled' && !withinRecoveryWindow(job)) {
      state.status = 'missed';
      state.error = '超过开始时间后 30 分钟，未补跑预约';
    }
    return { id, mode: job.mode, taskId: job.taskId, releaseAt: job.releaseAt, createdAt: job.createdAt,
      accountId: job.accountId ?? 'default', accountName: job.accountName ?? '我的账号', target: job.config.targets[0], ...state };
  }
  async list() {
    const ids = await readdir(join(this.dataDir, 'jobs')).catch((error) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    return Promise.all(ids.filter((id) => /^[a-f0-9-]{36}$/.test(id)).map((id) => this.get(id)));
  }
  async launchDispatcher() {
    const child = spawn(process.execPath, [this.worker, this.dataDir], {
      cwd: this.root, detached: true, stdio: 'ignore', windowsHide: true,
    });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
  }
  async resumeDue() {
    const recoverable = (await this.list()).some((job) => job.mode === 'schedule'
      && ['scheduled', 'interrupted'].includes(job.status) && withinRecoveryWindow(job)
      && job.releaseAt <= Date.now() + 120_000);
    if (recoverable) await this.launchDispatcher();
  }
  async create(target, config, mode, account = {}) {
    if (!['schedule', 'now', 'check'].includes(mode)) throw new Error('无效执行方式');
    const releaseAt = mode === 'schedule' ? (target.startAt ?? bookingReleaseAt(target.date)) : Date.now();
    if (mode === 'schedule' && releaseAt <= Date.now()) throw new Error('开始时间已过，请修改时间或选择“立即预约”');
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
    await writeJson(join(dir, 'state.json'), { status: 'scheduled', logs: [], successes: [] });
    try {
      if (mode === 'schedule') {
        await this.scheduler.register(id, this.dataDir, Math.max(Date.now() + 5000, releaseAt - 120_000));
      } else {
        await this.launchDispatcher();
      }
    } catch (error) {
      await writeFile(join(dir, 'stop'), 'registration failed', { mode: 0o600 });
      let cleanupError = '';
      if (mode === 'schedule') {
        try { await this.scheduler.remove(id); } catch (cleanup) { cleanupError = `；定时项清理失败：${cleanup.message}`; }
      }
      await writeJson(join(dir, 'state.json'), { status: 'error', logs: [], successes: [],
        error: `未能安排任务：${error.message}${cleanupError}` });
      throw new Error(`未能安排任务：${error.message}${cleanupError}`);
    }
    return this.get(id);
  }
  async stop(id) {
    const job = await this.get(id);
    await writeFile(join(this.path(id), 'stop'), 'user requested stop', { mode: 0o600 });
    if (job.mode === 'schedule') await this.scheduler.remove(id);
    return this.get(id);
  }
  async remove(id) {
    const job = await this.stop(id);
    if (JOB_ACTIVE.includes(job.status)) throw new Error('正在等待已发出的请求返回，请稍后删除');
    const trash = join(this.dataDir, 'trash');
    await mkdir(trash, { recursive: true, mode: 0o700 });
    await rename(this.path(id), join(trash, id));
  }
}
