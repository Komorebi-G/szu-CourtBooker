import { mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadSession, parseSessionText, saveSession } from './session.js';
import { exists, readJson, writeJson } from './jobs.js';
import { HttpClient } from './http-client.js';
import { SzuVenueApi } from '../../shared/api.js';
import { SessionExpiredError } from '../../shared/errors.js';

export class AccountStore {
  constructor({ dataDir, legacySessionPath, verifyIdentity, renewSession }) {
    Object.assign(this, { dataDir, legacySessionPath, renewSession });
    this.bindingQueue = Promise.resolve();
    this.revisions = new Map();
    this.verifyIdentity = verifyIdentity ?? (async (session, path, options = {}) => {
      const clientOptions = { priority: options.priority ?? 'background', expectedUserId: options.expectedUserId };
      const client = path ? await HttpClient.create({ ...clientOptions, sessionPath: path }) : new HttpClient(session, clientOptions);
      const api = new SzuVenueApi(client);
      const identity = await api.getIdentity(options);
      await api.getAvailableDates(options);
      if (path) await client.flush();
      return identity;
    });
  }
  dir(id) {
    if (id !== 'default' && !/^[a-f0-9-]{36}$/.test(id)) throw new Error('账号编号无效');
    return join(this.dataDir, 'accounts', id);
  }
  sessionPath(id = 'default') { return id === 'default' ? this.legacySessionPath : join(this.dir(id), 'session.json'); }
  async metadata(id = 'default') {
    const path = join(this.dir(id), 'account.json');
    if (id === 'default' && !await exists(path)) return { id, name: '我的账号' };
    const metadata = await readJson(path);
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || typeof metadata.name !== 'string') {
      throw new Error('账号备注记录格式异常');
    }
    return metadata;
  }
  async setMetadata(id, metadata) {
    await mkdir(this.dir(id), { recursive: true, mode: 0o700 });
    await writeJson(join(this.dir(id), 'account.json'), { ...metadata, id });
  }
  async summary(id = 'default') {
    const metadata = await this.metadata(id);
    const session = await loadSession(this.sessionPath(id)).catch(() => null);
    return { id, name: metadata.name, user: metadata.userName ?? null, userId: metadata.userId ?? null,
      exists: Boolean(session), valid: null,
      verifiedAt: metadata.verifiedAt, savedAt: session?.savedAt, cookieCount: session?.cookies.length ?? 0 };
  }
  async list() {
    const ids = await readdir(join(this.dataDir, 'accounts')).catch((error) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    return Promise.all(['default', ...ids.filter((id) => /^[a-f0-9-]{36}$/.test(id))].map(async (id) => {
      try { return await this.summary(id); }
      catch (error) {
        return { id, name: '待修复账号', user: null, userId: null, exists: await exists(this.sessionPath(id)),
          valid: false, corrupt: true, error: `账号记录无法读取（${error.code ?? '格式异常'}），原文件已保留；请清除登录后重新添加` };
      }
    }));
  }
  async create(name) {
    name = String(name ?? '').trim();
    if (!name || name.length > 40) throw new Error('账号备注需为 1 至 40 个字符');
    const id = randomUUID();
    await this.setMetadata(id, { name });
    return this.summary(id);
  }
  async import(id, text) {
    const revision = this.revisions.get(id) ?? 0;
    const metadata = await this.metadata(id);
    const session = parseSessionText(text);
    if (metadata.userId) {
      const identity = await this.verifyIdentity(session, undefined, { expectedUserId: metadata.userId });
      if (identity.id !== metadata.userId) throw new Error('导入的学校账号与此用户不一致，请新增账号后导入');
      await this.assertUnique(id, identity.id);
    }
    const work = this.bindingQueue.then(async () => {
      if ((this.revisions.get(id) ?? 0) !== revision) throw new Error('此账号的登录状态已变化，请重新导入');
      if (metadata.userId) await this.assertUnique(id, metadata.userId);
      await mkdir(this.dir(id), { recursive: true, mode: 0o700 });
      await saveSession(session, this.sessionPath(id));
      await this.setMetadata(id, { ...metadata, verifiedAt: null });
      this.revisions.set(id, revision + 1);
    });
    this.bindingQueue = work.catch(() => {}); await work;
    return this.summary(id);
  }
  async assertUnique(id, userId) {
    const other = (await this.list()).find((a) => a.id !== id && a.exists && a.userId === userId);
    if (other) throw new Error(`此学校账号已绑定“${other.name}”，请使用该用户；若是旧重复记录，请先清除其中一份登录`);
  }
  async inspectLogin(id, stagingPath) {
    const metadata = await this.metadata(id);
    const identity = await this.verifyIdentity(await loadSession(stagingPath), stagingPath, { expectedUserId: metadata.userId });
    if (metadata.userId && metadata.userId !== identity.id) throw new Error('登录身份与此用户不一致，原登录未改动');
    await this.assertUnique(id, identity.id);
    return identity;
  }
  async commitIdentity(id, identity, session, check = () => {}) {
    // Only the short binding commit is serialized. Slow school reads remain independent.
    const work = this.bindingQueue.then(async () => {
      const metadata = await this.metadata(id);
      if (metadata.userId && metadata.userId !== identity.id) throw new Error('当前登录与任务账号不一致，请恢复该用户的登录状态');
      await this.assertUnique(id, identity.id);
      check();
      if (session) await saveSession(session, this.sessionPath(id));
      await this.setMetadata(id, { ...metadata, userId: identity.id, userName: identity.name,
        verifiedAt: new Date().toISOString() });
      this.revisions.set(id, (this.revisions.get(id) ?? 0) + 1);
    });
    this.bindingQueue = work.catch(() => {}); return work;
  }
  async bindLogin(id, stagingPath, { check = () => {} } = {}) {
    const identity = await this.inspectLogin(id, stagingPath);
    await this.commitIdentity(id, identity, await loadSession(stagingPath), check);
    return this.summary(id);
  }
  async verify(id = 'default', options = {}) {
    const revision = this.revisions.get(id) ?? 0;
    const metadata = await this.metadata(id), path = this.sessionPath(id);
    let identity, renewedSession;
    try {
      try { identity = await this.verifyIdentity(await loadSession(path), path, { ...options, expectedUserId: metadata.userId }); }
      catch (error) {
        if (!(error instanceof SessionExpiredError) || !this.renewSession) throw error;
        if (!metadata.userId) throw new SessionExpiredError('尚未绑定学校身份，请点击浏览器登录并确认用户');
        const renewed = await this.renewSession(metadata.userId, (await loadSession(path)).browserCdpPort, options);
        if (renewed.identity.id !== metadata.userId) {
          throw new SessionExpiredError('浏览器统一认证的是另一个学校账号，原账号登录状态未改动');
        }
        renewedSession = renewed.session; identity = renewed.identity;
      }
      await this.commitIdentity(id, identity, renewedSession, () => {
        if ((this.revisions.get(id) ?? 0) !== revision) throw new Error('此账号的登录状态已变化，请重新验证');
        options.signal?.throwIfAborted();
        if (Number.isFinite(options.deadline) && Date.now() >= options.deadline) throw new Error('登录验证已超过准备截止时间');
      });
    } catch (error) {
      const cleanup = this.bindingQueue.then(async () => {
        if ((this.revisions.get(id) ?? 0) === revision) await this.setMetadata(id, { ...await this.metadata(id), verifiedAt: null });
      });
      this.bindingQueue = cleanup.catch(() => {}); await cleanup;
      throw error;
    }
    return { ...await this.summary(id), valid: true };
  }
  async export(id = 'default') {
    const metadata = await this.metadata(id);
    return { format: 'szu-court-session/v1', name: metadata.name,
      exportedAt: new Date().toISOString(), session: await loadSession(this.sessionPath(id)) };
  }
  async clear(id = 'default') {
    const work = this.bindingQueue.then(async () => {
      const metadata = await this.metadata(id).catch(() => ({ id, name: '待修复账号' }));
      await rm(this.sessionPath(id), { force: true });
      await this.setMetadata(id, { ...metadata, verifiedAt: null });
      this.revisions.set(id, (this.revisions.get(id) ?? 0) + 1);
    });
    this.bindingQueue = work.catch(() => {}); await work;
    return this.summary(id);
  }
}
