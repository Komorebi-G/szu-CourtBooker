import { mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadSession, parseSessionText, saveSession } from './session.js';
import { exists, readJson, writeJson } from './jobs.js';
import { HttpClient } from './http-client.js';
import { SzuVenueApi } from '../../shared/api.js';

export class AccountStore {
  constructor({ dataDir, legacySessionPath, verifyIdentity }) {
    Object.assign(this, { dataDir, legacySessionPath });
    this.verifyIdentity = verifyIdentity ?? (async (session, path) => {
      const client = path ? await HttpClient.create({ sessionPath: path }) : new HttpClient(session);
      const api = new SzuVenueApi(client);
      const identity = await api.getIdentity();
      await api.getAvailableDates();
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
    return readJson(path);
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
    return Promise.all(['default', ...ids.filter((id) => /^[a-f0-9-]{36}$/.test(id))].map((id) => this.summary(id)));
  }
  async create(name) {
    name = String(name ?? '').trim();
    if (!name || name.length > 40) throw new Error('账号备注需为 1 至 40 个字符');
    const id = randomUUID();
    await this.setMetadata(id, { name });
    return this.summary(id);
  }
  async import(id, text) {
    const metadata = await this.metadata(id);
    const session = parseSessionText(text);
    if (metadata.userId) {
      const identity = await this.verifyIdentity(session);
      if (identity.id !== metadata.userId) throw new Error('导入的学校账号与此用户不一致，请新增账号后导入');
    }
    await mkdir(this.dir(id), { recursive: true, mode: 0o700 });
    await saveSession(session, this.sessionPath(id));
    await this.setMetadata(id, { ...metadata, verifiedAt: null });
    return this.summary(id);
  }
  async verify(id = 'default') {
    const metadata = await this.metadata(id);
    const path = this.sessionPath(id);
    let identity;
    try {
      identity = await this.verifyIdentity(await loadSession(path), path);
      if (metadata.userId && metadata.userId !== identity.id) throw new Error('当前登录与任务账号不一致，请恢复该用户的登录状态');
    }
    catch (error) {
      await this.setMetadata(id, { ...metadata, verifiedAt: null });
      throw error;
    }
    await this.setMetadata(id, { ...metadata, userId: identity.id, userName: identity.name,
      verifiedAt: new Date().toISOString() });
    return { ...await this.summary(id), valid: true };
  }
  async export(id = 'default') {
    const metadata = await this.metadata(id);
    return { format: 'szu-court-session/v1', name: metadata.name,
      exportedAt: new Date().toISOString(), session: await loadSession(this.sessionPath(id)) };
  }
  async clear(id = 'default') {
    const metadata = await this.metadata(id);
    await rm(this.sessionPath(id), { force: true });
    await this.setMetadata(id, { ...metadata, verifiedAt: null });
    return this.summary(id);
  }
}
