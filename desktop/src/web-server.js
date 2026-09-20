#!/usr/bin/env node
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { DEFAULT_CONFIG_FILE, DEFAULT_SESSION_FILE } from '../../shared/constants.js';
import { loadConfig, saveConfig } from './config.js';
import { SzuVenueApi } from '../../shared/api.js';
import { HttpClient } from './http-client.js';
import { resolveTargets } from '../../shared/planner.js';
import { PROJECTS, getProject, projectForTarget } from '../../shared/projects.js';
import { defaultTargetDate, bookingReleaseAt, validateExecutionStart } from '../../shared/runner.js';
import { LiveExecution } from './execution.js';
import { JobStore, JOB_ACTIVE } from './jobs.js';
import { NativeScheduler } from './native-scheduler.js';
import { loadSession } from './session.js';
import { AccountStore } from './accounts.js';
import { managerIdentity, startManagerServer } from './manager-server.js';
import { addDays, resolveDate, shanghaiDate, splitTimeSlot } from '../../shared/utils.js';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const webRoot = join(root, 'desktop', 'web');
const configPath = resolve(process.env.SZU_CONFIG || join(root, DEFAULT_CONFIG_FILE));
const sessionPath = resolve(process.env.SZU_SESSION || join(root, DEFAULT_SESSION_FILE));
// A fresh clone has no personal config; never overwrite an existing one.
await writeFile(configPath, 'targets: []\n', { flag: 'wx', mode: 0o600 }).catch((error) => {
  if (error.code !== 'EEXIST') throw error;
});
const args = process.argv.slice(2);
const portFlag = args.indexOf('--port');
const port = Number(portFlag >= 0 ? args[portFlag + 1] : process.env.PORT || 4173);
const isWsl = process.platform === 'linux' && Boolean(process.env.WSL_DISTRO_NAME);
// WSL 必须监听所有虚拟网卡，Windows 宿主才能通过 localhost 转发访问。
// 普通 Windows/macOS/Linux 仍只监听回环地址。
const host = process.env.WEB_HOST || (isWsl ? '0.0.0.0' : '127.0.0.1');
const shouldOpen = !args.includes('--no-open');

const authState = { status: 'idle', logs: [], startedAt: null, finishedAt: null };
const scheduler = new NativeScheduler();
const dataDir = resolve(process.env.SZU_DATA || join(root, '.data'));
const execution = new LiveExecution({ dataDir });
const jobs = new JobStore({ sessionPath, scheduler, execution, startJob: (dir) => { execution.start(dir); },
  dataDir });
let legacyCleanup = Promise.resolve([]);
const accounts = new AccountStore({ dataDir: jobs.dataDir, legacySessionPath: sessionPath });
let authChild = null;
// Fail at startup with a useful diagnostic rather than serving a blank 404 page.
for (const name of ['index.html', 'app.js', 'styles.css']) {
  const content = await readFile(join(webRoot, name));
  if (!content.length) throw new Error(`界面资源为空：${name}，请重新安装当前版本`);
}
const identity = await managerIdentity(root, [configPath, sessionPath, jobs.dataDir], process.env.SZU_BUILD_ID);

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

function json(response, statusCode, data) {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(`${JSON.stringify(data)}\n`);
}

function errorJson(response, error, statusCode = 400) {
  json(response, statusCode, { ok: false, error: error.message || String(error) });
}

async function bodyJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 2_000_000) throw new Error('请求内容过大');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('请求内容不是有效 JSON');
  }
}

function appendLog(state, level, message, details) {
  state.logs.push({
    time: new Date().toISOString(),
    level,
    message,
    details: details ?? null,
  });
  if (state.logs.length > 200) state.logs.splice(0, state.logs.length - 200);
}

async function sessionSummary({ verify = false, accountId = 'default' } = {}) {
  return verify ? accounts.verify(accountId) : accounts.summary(accountId);
}

function publicConfig(config) {
  return {
    scheduler: config.scheduler,
    booking: config.booking,
    tasks: config.targets.map((target, index) => {
      const project = projectForTarget(target);
      return {
        id: target.id ?? String(index),
        accountId: target.accountId ?? 'default',
        date: target.date ?? defaultTargetDate(config),
        preferSameCourt: target.preferSameCourt ?? project?.id === 'volleyball',
        releaseAt: bookingReleaseAt(target.date ?? defaultTargetDate(config)),
        intervalMs: target.intervalMs ?? 100,
        durationMs: target.durationMs ?? 60_000,
        name: target.name,
        projectId: project?.id ?? target.project ?? '',
        projectLabel: project?.label ?? target.sport,
        times: target.times,
        enabled: target.enabled !== false,
        courts: target.courts ?? config.courtPreferences?.[project?.id] ?? ['*'],
        courtLabels: target.courtLabels ?? {},
      };
    }),
    projects: PROJECTS.map((project) => ({
      id: project.id,
      label: project.label,
      preference: config.courtPreferences?.[project.id] ?? ['*'],
    })),
  };
}

async function createApi(accountId = 'default') {
  await accounts.metadata(accountId);
  const client = await HttpClient.create({ sessionPath: accounts.sessionPath(accountId) });
  return { client, api: new SzuVenueApi(client) };
}

function representativeTarget(config, project) {
  return config.targets.find((target) => projectForTarget(target)?.id === project.id) ?? {
    name: project.label,
    project: project.id,
    enabled: true,
    campus: project.campus,
    sport: project.sport,
    mode: project.mode,
    venues: project.venues,
    times: ['19:00-20:00'],
  };
}

async function resolvedProject(config, projectId, api) {
  const project = getProject(projectId);
  if (!project) throw new Error('未知项目');
  const metadata = await api.getSportVenueData();
  const target = { ...representativeTarget(config, project), enabled: true, project: project.id };
  return resolveTargets({ ...config, targets: [target] }, metadata)[0];
}

async function projectTimes(projectId, dateValue, accountId) {
  const config = await loadConfig(configPath);
  const { client, api } = await createApi(accountId);
  const target = await resolvedProject(config, projectId, api);
  const date = resolveDate(dateValue ?? 'today');
  const values = await api.getTimeList({
    campusCode: target.campusCode,
    date,
    modeCode: target.modeCode,
    sportCode: target.sportCode,
  });
  await client.flush();
  return { date, times: values.map((item) => ({ value: item.CODE, note: item.text })) };
}

async function projectCourts(projectId, dateValue, timeValue, accountId) {
  const config = await loadConfig(configPath);
  const { client, api } = await createApi(accountId);
  const target = await resolvedProject(config, projectId, api);
  const date = resolveDate(dateValue ?? 'today');
  const time = timeValue ?? target.times[0] ?? '19:00-20:00';
  const rows = [];
  for (const venue of target.venues) {
    const rooms = await api.getOpeningRooms({
      campusCode: target.campusCode,
      sportCode: target.sportCode,
      modeCode: target.modeCode,
      venueCode: venue.CGBM,
      date,
      time,
    });
    for (const room of rooms) {
      if (rows.some((item) => item.id === room.WID)) continue;
      rows.push({
        id: room.WID,
        name: room.CDMC,
        venue: venue.CGMC,
        note: room.text || '',
      });
    }
  }
  await client.flush();
  const preference = config.courtPreferences?.[projectId] ?? ['*'];
  return { date, time, preference, courts: rows };
}

function taskFromBody(input, current) {
  const project = getProject(input.projectId);
  if (!project) throw new Error('请选择有效项目');
  const times = Array.isArray(input.times)
    ? [...new Set(input.times.filter((value) => /^\d{2}:\d{2}-\d{2}:\d{2}$/.test(value)))]
    : [];
  if (times.length === 0) throw new Error('至少选择一个时间段');
  times.forEach(splitTimeSlot);
  const courts = input.courts ?? current?.courts ?? ['*'];
  if (!Array.isArray(courts) || courts.length === 0 || courts.some((court) => typeof court !== 'string' || !court.trim())) {
    throw new Error('请选择场地，或选择全部场地');
  }
  const date = resolveDate(input.date);
  if (date < shanghaiDate() || date > addDays(shanghaiDate(), 7)) throw new Error('请选择今天至未来第七天的日期');
  if (typeof input.preferSameCourt !== 'boolean') throw new Error('请选择是否优先同一场地');
  const intervalMs = Number(input.intervalMs);
  const durationMs = Number(input.durationMs);
  if (!Number.isFinite(intervalMs) || intervalMs < 100 || intervalMs > 3_600_000) throw new Error('重试间隔须在 0.1 秒至 1 小时之间');
  if (!Number.isFinite(durationMs) || durationMs < 1000 || durationMs > 86_400_000) throw new Error('持续时间须在 1 秒至 24 小时之间');
  return {
    ...Object.fromEntries(Object.entries(current ?? {}).filter(([key]) => key !== 'startAt')),
    id: current?.id ?? randomUUID(),
    accountId: input.accountId ?? current?.accountId ?? 'default',
    date,
    intervalMs, durationMs,
    preferSameCourt: input.preferSameCourt,
    name: String(input.name || `${project.label}预约`).trim(),
    project: project.id,
    enabled: input.enabled !== false,
    campus: project.campus,
    sport: project.sport,
    mode: project.mode,
    venues: project.venues,
    times: times.sort(),
    courts: courts.includes('*') ? ['*'] : [...new Set(courts)],
    courtLabels: Object.fromEntries(Object.entries(input.courtLabels ?? current?.courtLabels ?? {})
      .filter(([id, name]) => courts.includes(id) && typeof name === 'string').map(([id, name]) => [id, name.slice(0, 100)])),
  };
}

async function startAuthentication(accountId = 'default') {
  const metadata = await accounts.metadata(accountId);
  await mkdir(accounts.dir(accountId), { recursive: true, mode: 0o700 });
  if (authChild) throw new Error('登录引导已经在运行');
  authState.accountId = accountId;
  authState.status = 'running';
  authState.startedAt = new Date().toISOString();
  authState.finishedAt = null;
  authState.logs = [];
  const script = join(root, 'scripts', 'auth.js');
  authChild = spawn(process.execPath, [script], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, SZU_SESSION: accounts.sessionPath(accountId), SZU_EXPECTED_USER_ID: metadata.userId ?? '' } });
  const consume = (chunk) => {
    for (const line of chunk.toString('utf8').split(/\r?\n/).filter(Boolean)) {
      appendLog(authState, 'INFO', line);
    }
  };
  authChild.stdout.on('data', consume);
  authChild.stderr.on('data', consume);
  authChild.once('error', (error) => {
    authState.status = 'error';
    authState.finishedAt = new Date().toISOString();
    appendLog(authState, 'ERROR', error.message);
    authChild = null;
  });
  authChild.once('exit', async (code) => {
    authState.status = code === 0 ? 'success' : 'error';
    authState.finishedAt = new Date().toISOString();
    if (code === 0) {
      try { const summary = await accounts.verify(accountId); appendLog(authState, 'OK', '已连接：' + summary.user); }
      catch (error) { authState.status = 'error'; appendLog(authState, 'ERROR', error.message); }
    }
    authChild = null;
  });
}


async function ensureAccountIdle(id) {
  if (authChild && authState.accountId === id) throw new Error('此账号正在登录，请等待登录结束');
  if ((await jobs.list()).some((job) => job.accountId === id && ['queued', 'preparing', 'checking', 'waiting', 'booking', 'stopping'].includes(job.status))) {
    throw new Error('此账号正在执行任务，请先停止后再替换登录');
  }
}

async function taskJobs(taskId) {
  return (await jobs.list()).filter((job) => job.taskId === taskId);
}
async function ensureEditable(taskId) {
  if ((await taskJobs(taskId)).some((job) => JOB_ACTIVE.includes(job.status))) {
    throw new Error('请先停止本次执行');
  }
}
function normalizeTargets(config) {
  // Freeze legacy relative dates and identifiers at the first deliberate edit.
  config.targets.forEach((target) => {
    target.id ??= randomUUID();
    target.accountId ??= 'default';
    target.date ??= defaultTargetDate(config);
    target.courts ??= config.courtPreferences?.[projectForTarget(target)?.id] ?? ['*'];
    target.preferSameCourt ??= projectForTarget(target)?.id === 'volleyball';
  });
}
function findTask(config, id) {
  const index = config.targets.findIndex((target, index) => (target.id ?? String(index)) === id);
  if (index < 0) throw new Error('任务不存在，请刷新页面');
  return index;
}
async function handleApi(request, response, url) {
  const method = request.method ?? 'GET';
  if (method === 'GET' && url.pathname === '/api/health') return json(response, 200, { ...identity, ready: true });
  if (method === 'GET' && url.pathname === '/api/bootstrap') {
    return json(response, 200, { ok: true, app: 'szu-court-booker', config: publicConfig(await loadConfig(configPath)),
      session: await sessionSummary(), accounts: await accounts.list(), auth: authState, jobs: await jobs.list(),
      serverDate: shanghaiDate(), executionMode: 'manual', legacyCleanupErrors: await legacyCleanup });
  }
  if (method === 'GET' && url.pathname === '/api/jobs') {
    return json(response, 200, { ok: true, jobs: await jobs.list() });
  }
  const jobMatch = /^\/api\/jobs\/([a-f0-9-]+)(?:\/(stop))?$/.exec(url.pathname);
  if (jobMatch) {
    if (method === 'POST' && jobMatch[2]) {
      execution.stop(jobs.path(jobMatch[1]));
      return json(response, 200, { ok: true, job: await jobs.stop(jobMatch[1]) });
    }
    if (method === 'DELETE') { await jobs.remove(jobMatch[1]); return json(response, 200, { ok: true }); }
  }

  if (method === 'POST' && url.pathname === '/api/app/quit') {
    if (authChild) throw new Error('登录引导正在运行，请完成后再退出');
    await execution.close();
    json(response, 200, { ok: true });
    setTimeout(() => { server.close(); server.closeAllConnections(); }, 100);
    return;
  }
  if (url.pathname === '/api/accounts') {
    if (method === 'GET') return json(response, 200, { ok: true, accounts: await accounts.list() });
    if (method === 'POST') {
      const input = await bodyJson(request);
      const account = await accounts.create(input.name);
      return json(response, 201, { ok: true, account, accounts: await accounts.list() });
    }
  }
  const accountMatch = /^\/api\/accounts\/([a-z0-9-]+)\/(import|export|verify|session)$/.exec(url.pathname);
  if (accountMatch) {
    const [, id, action] = accountMatch;
    if (method === 'POST' && action === 'export') {
      return json(response, 200, await accounts.export(id));
    }
    if (['import', 'session'].includes(action)) await ensureAccountIdle(id);
    if (method === 'POST' && action === 'import') {
      const input = await bodyJson(request);
      const account = await accounts.import(id, String(input.text ?? ''));
      return json(response, 200, { ok: true, account, accounts: await accounts.list() });
    }
    if (method === 'POST' && action === 'verify') {
      return json(response, 200, { ok: true, account: await accounts.verify(id), accounts: await accounts.list() });
    }
    if (method === 'DELETE' && action === 'session') {
      return json(response, 200, { ok: true, account: await accounts.clear(id), accounts: await accounts.list() });
    }
  }
  if (method === 'POST' && url.pathname === '/api/session/verify') {
    return json(response, 200, { ok: true, session: await accounts.verify() });
  }
  if (method === 'POST' && url.pathname === '/api/auth/start') {
    const input = await bodyJson(request);
    await ensureAccountIdle(input.accountId ?? 'default');
    await startAuthentication(input.accountId ?? 'default');
    return json(response, 202, { ok: true, auth: authState });
  }
  if (method === 'GET' && url.pathname === '/api/auth/status') {
    return json(response, 200, { ok: true, auth: authState, session: await accounts.summary(authState.accountId),
      accounts: await accounts.list() });
  }
  if (method === 'POST' && url.pathname === '/api/tasks') {
    const config = await loadConfig(configPath);
    const target = taskFromBody(await bodyJson(request));
    normalizeTargets(config);
    await accounts.metadata(target.accountId);
    config.targets.push(target);
    await saveConfig(config, configPath);
    return json(response, 201, { ok: true, taskId: target.id, config: publicConfig(config) });
  }
  const taskMatch = /^\/api\/tasks\/([a-z0-9-]+)(?:\/(run))?$/.exec(url.pathname);
  if (taskMatch) {
    const config = await loadConfig(configPath);
    const index = findTask(config, taskMatch[1]);
    const old = config.targets[index];
    await ensureEditable(old.id ?? String(index));
    if (taskMatch[2] && method === 'POST') {
      await legacyCleanup;
      const input = await bodyJson(request);
      if (execution.closing) throw new Error('程序正在退出');
      validateExecutionStart(input.mode, old.date ?? defaultTargetDate(config));
      if (input.mode !== 'check' && input.confirm !== 'SUBMIT') throw new Error('请明确确认提交真实预约');
      normalizeTargets(config);
      const target = config.targets[index];
      if (target.date < shanghaiDate() || target.date > addDays(shanghaiDate(), 7)) throw new Error('预约日期已过期或超出未来七天，请编辑日期');
      if (input.mode === 'now') {
        if (target.times.some((time) => Date.parse(target.date + 'T' + time.split('-')[0] + ':00+08:00') <= Date.now())) {
          throw new Error('有时段已经开始，请编辑任务移除已过期时段');
        }
      }
      await loadSession(accounts.sessionPath(target.accountId));
      const account = await accounts.verify(target.accountId);
      await saveConfig(config, configPath);
      const job = await jobs.create(target, config, input.mode, { ...account, sessionPath: accounts.sessionPath(target.accountId) });
      return json(response, 202, { ok: true, job, config: publicConfig(config) });
    }
    if (method === 'PUT') {
      const target = taskFromBody(await bodyJson(request), old);
      normalizeTargets(config);
      config.targets[index] = target;
      await accounts.metadata(target.accountId);
      await saveConfig(config, configPath);
      return json(response, 200, { ok: true, taskId: target.id, config: publicConfig(config) });
    }
    if (method === 'DELETE') {
      for (const job of await taskJobs(old.id ?? String(index))) await jobs.remove(job.id);
      config.targets.splice(index, 1);
      normalizeTargets(config);
      await saveConfig(config, configPath);
      return json(response, 200, { ok: true, config: publicConfig(config) });
    }
  }
  const catalogMatch = /^\/api\/projects\/([^/]+)\/(courts|times)$/.exec(url.pathname);
  if (catalogMatch && method === 'GET') {
    const id = decodeURIComponent(catalogMatch[1]);
    const data = catalogMatch[2] === 'courts' ? await projectCourts(id, undefined, undefined, url.searchParams.get('accountId') ?? 'default')
      : await projectTimes(id, undefined, url.searchParams.get('accountId') ?? 'default');
    return json(response, 200, { ok: true, ...data });
  }
  return json(response, 404, { ok: false, error: '接口不存在' });
}

async function serveStatic(response, url) {
  const pathname = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
  const file = resolve(webRoot, `.${pathname}`);
  if (file !== webRoot && !file.startsWith(`${webRoot}${sep}`)) {
    return json(response, 403, { ok: false, error: '禁止访问' });
  }
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error('not file');
    const content = await readFile(file);
    response.writeHead(200, {
      'content-type': mimeTypes[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    response.end(content);
  } catch {
    json(response, 404, { ok: false, error: '页面不存在' });
  }
}

let mutationQueue = Promise.resolve();
const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host || `${host}:${port}`}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      // Serialize read-modify-write operations so simultaneous tabs cannot lose updates.
      if (request.method === 'GET') await handleApi(request, response, url);
      else {
        const origin = request.headers.origin;
        if (origin && origin !== url.origin) throw new Error('不接受其他网站发起的修改请求');
        // A slow login/start request must never hold Stop/Exit behind it.
        if (request.method === 'POST' && (url.pathname === '/api/app/quit'
          || /^\/api\/jobs\/[a-f0-9-]+\/stop$/.test(url.pathname))) {
          await handleApi(request, response, url);
          return;
        }
        const pending = mutationQueue.then(() => handleApi(request, response, url));
        mutationQueue = pending.catch(() => {});
        await pending;
      }
    }
    else await serveStatic(response, url);
  } catch (error) {
    errorJson(response, error);
  }
});

function openBrowser(url) {
  if (isWsl) {
    const helper = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'skills/wsl-windows-edge/scripts/edge.mjs');
    const child = spawn(process.execPath, [helper, 'open', url], { detached: true, stdio: 'ignore' });
    child.on('error', (error) => console.error(`浏览器未打开：${error.message}；请手动访问 ${url}`));
    child.unref();
    return;
  }
  if (process.platform === 'win32') {
    const child = spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', (error) => console.error(`浏览器未打开：${error.message}`));
    child.unref();
    return;
  }
  const command = process.platform === 'darwin' ? 'open' : 'xdg-open';
  const child = spawn(command, [url], { detached: true, stdio: 'ignore' });
  child.on('error', (error) => console.error(`浏览器未打开：${error.message}；请手动访问 ${url}`));
  child.unref();
}

try {
  const { url, reused } = await startManagerServer(server, { port, host, identity });
  console.log(`场馆预约助手${reused ? '已在运行' : '已启动'}：${url}`);
  if (!reused) {
    console.log('Cookie 和配置只保存在本机。按 Ctrl+C 停止。');
    legacyCleanup = jobs.retireSchedules().catch((error) => [`旧定时项清理失败：${error.message}`]);
    const shutdown = async () => {
      await execution.close();
      server.close(); server.closeAllConnections();
    };
    process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
  }
  if (shouldOpen) openBrowser(url);
} catch (error) {
  console.error(error.message);
  throw error; // SEA bootstrap records the failure in startup.log for GUI executables.
}
