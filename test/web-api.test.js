import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { request as nodeHttpRequest } from 'node:http';
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
  const module = await fetch(url + '/experience.js');
  assert.equal(module.status, 200); assert.match(module.headers.get('content-type'), /javascript/);
  assert.match(await module.text(), /export function planExperience/);
  assert.equal((await fetch(url + '/shared/experience.js')).status, 404, '只显式提供界面模块，不暴露 shared 目录');
  const request = async (path, method = 'GET', data, extraHeaders = {}) => {
    const response = await fetch(url + path, { method, headers: { 'content-type': 'application/json', ...extraHeaders }, body: data ? JSON.stringify(data) : undefined });
    return { status: response.status, data: await response.json() };
  };
  const body = { name: 'A', projectId: 'badminton', date: addDays(shanghaiDate(), 2), times: ['15:00-16:00'],
    courts: ['B', 'A'], courtLabels: { A: 'A场', B: 'B场' }, preferSameCourt: true,
    startAt: Date.now() + 60_000, intervalMs: 100, durationMs: 60000 };
  const saved = await request('/api/tasks', 'POST', body); assert.equal(saved.status, 201);
  const fallbackTask = await request(`/api/tasks/${saved.data.taskId}`, 'PUT', { ...body, includeOtherCourts: true });
  assert.equal(fallbackTask.data.config.tasks[0].includeOtherCourts, true);
  assert.equal((await request(`/api/tasks/${saved.data.taskId}`, 'PUT', { ...body, includeOtherCourts: 'true' })).status, 400);
  assert.equal(saved.data.config.tasks[0].startAt, undefined, '旧自定义定时不再用于执行');
  const legacyStart = await request(`/api/tasks/${saved.data.taskId}/run`, 'POST', { mode: 'schedule', confirm: 'SUBMIT' });
  assert.equal(legacyStart.status, 400); assert.match(legacyStart.data.error, /已移除系统定时/);
  const earlyStart = await request(`/api/tasks/${saved.data.taskId}/run`, 'POST', { mode: 'release', confirm: 'SUBMIT' });
  assert.equal(earlyStart.status, 400); assert.match(earlyStart.data.error, /放号当天/);
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
  const diagnosticId = randomUUID(), jobDir = join(dir, 'data', 'jobs', diagnosticId);
  await mkdir(jobDir, { recursive: true });
  await writeFile(join(jobDir, 'job.json'), JSON.stringify({ mode: 'now', config: { targets: [] } }));
  await writeFile(join(jobDir, 'state.json'), JSON.stringify({ status: 'success', successes: [{ time: '19:00-20:00', orderId: 'private-order' }],
    diagnostics: { events: 2 }, logs: [{ sequence: 2, level: 'OK', message: '成功' }] }));
  await writeFile(join(jobDir, 'events.ndjson'), JSON.stringify({ sequence: 1, level: 'PLAN', message: '规则已保存' }) + '\n');
  const diagnostic = await request(`/api/jobs/${diagnosticId}/diagnostics`);
  assert.equal(diagnostic.status, 200); assert.equal(diagnostic.data.format, 'szu-court-diagnostics/v1');
  assert.deepEqual(diagnostic.data.events.map((entry) => entry.sequence), [1, 2]);
  assert.equal(diagnostic.data.missingEvents, 0);
  assert.ok(!JSON.stringify(diagnostic.data).includes('private-order'));
  const account = (await request('/api/accounts', 'POST', { name: '舍友' })).data.account;
  const credential = 'MOD_AUTH_CAS=test-roommate; _WEU=test-weu';
  assert.equal((await request(`/api/accounts/${account.id}/import`, 'POST', { text: credential })).status, 200);
  const publicAccounts = (await request('/api/accounts')).data.accounts;
  assert.equal(publicAccounts.find((a) => a.id === account.id).exists, true);
  assert.ok(!JSON.stringify(publicAccounts).includes('test-roommate'));
  const exported = (await request(`/api/accounts/${account.id}/export`, 'POST', {})).data;
  assert.equal(exported.format, 'szu-court-session/v1');
  assert.equal(exported.session.cookies[0].value, 'test-roommate');
  const rawRequest = (path, headers = {}, method = 'GET') => new Promise((resolve, reject) => {
    const req = nodeHttpRequest(url, { path, method, headers }, (response) => {
      let body = ''; response.on('data', (chunk) => body += chunk);
      response.on('end', () => resolve({ status: response.statusCode, data: JSON.parse(body) }));
    });
    req.on('error', reject); req.end();
  });
  const rebound = await rawRequest(`/api/accounts/${account.id}/export`,
    { host: 'attacker.invalid:4173', origin: 'http://attacker.invalid:4173' }, 'POST');
  assert.equal(rebound.status, 403, '外部域名不能通过伪造一致的Host/Origin导出登录');
  assert.ok(!JSON.stringify(rebound.data).includes('test-roommate'));
  assert.equal((await rawRequest('/api/health', { host: 'attacker.invalid:4173' })).status, 403);
  assert.equal((await rawRequest('/api/health', { host: '%' })).status, 400,
    '畸形Host返回错误，不能让URL解析的未捕获异常结束助手进程');
  assert.equal((await rawRequest('http://attacker.invalid/api/health')).status, 400);
  assert.equal((await request('/api/health')).status, 200);
  assert.equal(child.exitCode, null);
  assert.equal((await request('/api/tasks', 'POST', { ...body, accountId: account.id })).status, 201);
  const crossSite = await request(`/api/tasks/${saved.data.taskId}`, 'DELETE', undefined, { origin: 'https://evil.example' });
  assert.equal(crossSite.status, 400);
  assert.equal((await request(`/api/tasks/${saved.data.taskId}/run`, 'POST', { mode: 'schedule' })).status, 400);
  assert.equal((await request(`/api/tasks/${saved.data.taskId}`, 'DELETE')).status, 200);
  const stopped = once(child, 'exit'); child.kill(); await stopped;
});
