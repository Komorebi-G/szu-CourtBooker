import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { addDays, shanghaiDate } from '../shared/utils.js';

test('Web任务允许重叠/并发修改/非法参数/账号导入导出；不访问学校', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'szu-api-test-'));
  const config = join(dir, 'config.yaml'); await writeFile(config, 'targets: []\n');
  const child = spawn(process.execPath, ['src/web-server.js', '--port', '0', '--no-open'], {
    cwd: resolve('.'), env: { ...process.env, WEB_HOST: '127.0.0.1', SZU_CONFIG: config,
      SZU_DATA: join(dir, 'data'), SZU_SESSION: join(dir, 'no-session.json') }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill());
  let output = '';
  const url = await new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk) => { output += chunk; const match = /http:\/\/127.0.0.1:\d+/.exec(output); if (match) resolve(match[0]); });
    child.once('error', reject); child.once('exit', (code) => reject(new Error(`server exited ${code}`)));
  });
  const request = async (path, method = 'GET', data, extraHeaders = {}) => {
    const response = await fetch(url + path, { method, headers: { 'content-type': 'application/json', ...extraHeaders }, body: data ? JSON.stringify(data) : undefined });
    return { status: response.status, data: await response.json() };
  };
  const body = { name: 'A', projectId: 'badminton', date: addDays(shanghaiDate(), 2), times: ['15:00-16:00'],
    courts: ['B', 'A'], courtLabels: { A: 'A场', B: 'B场' }, preferSameCourt: true,
    startAt: Date.now() + 60_000, intervalMs: 100, durationMs: 60000 };
  const saved = await request('/api/tasks', 'POST', body); assert.equal(saved.status, 201);
  assert.deepEqual(saved.data.config.tasks[0].courts, ['B', 'A']);
  assert.equal(saved.data.config.tasks[0].preferSameCourt, true);
  const before = await readFile(config, 'utf8');
  const invalid = await request(`/api/tasks/${saved.data.taskId}`, 'PUT', { ...body, intervalMs: -1 });
  assert.equal(invalid.status, 400); assert.equal(await readFile(config, 'utf8'), before);
  const overlap = await request('/api/tasks', 'POST', { ...body, name: 'B', times: ['15:30-16:30'] });
  assert.equal(overlap.status, 201);
  const future = await request('/api/tasks', 'POST', { ...body, date: addDays(shanghaiDate(), 8) });
  assert.equal(future.status, 400);
  const concurrent = await Promise.all(['16:00-17:00', '17:00-18:00'].map((time) => request('/api/tasks', 'POST', { ...body, times: [time] })));
  assert.ok(concurrent.every((response) => response.status === 201));
  assert.equal((await request('/api/bootstrap')).data.config.tasks.length, 4);
  const account = (await request('/api/accounts', 'POST', { name: '舍友' })).data.account;
  const credential = 'MOD_AUTH_CAS=test-roommate; _WEU=test-weu';
  assert.equal((await request(`/api/accounts/${account.id}/import`, 'POST', { text: credential })).status, 200);
  const publicAccounts = (await request('/api/accounts')).data.accounts;
  assert.equal(publicAccounts.find((a) => a.id === account.id).exists, true);
  assert.ok(!JSON.stringify(publicAccounts).includes('test-roommate'));
  const exported = (await request(`/api/accounts/${account.id}/export`, 'POST', {})).data;
  assert.equal(exported.format, 'szu-court-session/v1');
  assert.equal(exported.session.cookies[0].value, 'test-roommate');
  assert.equal((await request('/api/tasks', 'POST', { ...body, accountId: account.id })).status, 201);
  const crossSite = await request(`/api/tasks/${saved.data.taskId}`, 'DELETE', undefined, { origin: 'https://evil.example' });
  assert.equal(crossSite.status, 400);
  assert.equal((await request(`/api/tasks/${saved.data.taskId}/run`, 'POST', { mode: 'schedule' })).status, 400);
  assert.equal((await request(`/api/tasks/${saved.data.taskId}`, 'DELETE')).status, 200);
  const stopped = once(child, 'exit'); child.kill(); await stopped;
});
