#!/usr/bin/env node
import { referenceDates } from '../../shared/catalog.js';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, rm, stat } from 'node:fs/promises';
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
import { defaultTargetDate, bookingReleaseAt, executionIntent } from '../../shared/runner.js';
import { LiveExecution } from './execution.js';
import { ReferenceCatalogStore } from './catalogs.js';
import { JobStore, JOB_ACTIVE } from './jobs.js';
import { NativeScheduler } from './native-scheduler.js';
import { loadSession } from './session.js';
import { AccountStore } from './accounts.js';
import { renewVenueSessionFromBrowser } from './browser-renew.js';
import { managerIdentity, startManagerServer } from './manager-server.js';
import { startTray } from './tray.js';
import { exportDiagnostics } from '../../shared/diagnostics.js';
import { readDiagnosticJournal } from './diagnostics.js';
import { validateBookingGoal } from '../../shared/booking-goal.js';
import { reviewBookings } from '../../shared/booking-review.js';
import { pendingExecutionRequests } from '../../shared/experience.js';
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
const catalogs = new ReferenceCatalogStore(dataDir);
const renewSession = (expectedUserId, port, options = {}) => renewVenueSessionFromBrowser({ expectedUserId, port, ...options });
const execution = new LiveExecution({ dataDir, renewSession, referenceReader: (input) => catalogs.read(input) });
const jobs = new JobStore({ sessionPath, scheduler, execution, startJob: (dir) => { execution.start(dir); },
  dataDir });
let legacyCleanup = Promise.resolve([]);
const accounts = new AccountStore({ dataDir: jobs.dataDir, legacySessionPath: sessionPath, renewSession });
let authChild = null;
let cancelAuthentication = null;
let pendingLogin = null;
const starts = new Map();
const accountChanges = new Set();
const reviews = new Map();
function startEntry(token) {
  if (!/^[a-f0-9-]{36}$/.test(token)) throw new Error('启动请求编号无效');
  for (const [id, entry] of starts) if (Date.now() - entry.createdAt > 3600000) starts.delete(id);
  if (!starts.has(token)) starts.set(token, { createdAt: Date.now(), cancelled: false });
  return starts.get(token);
}
// Fail at startup with a useful diagnostic rather than serving a blank 404 page.
for (const name of ['index.html', 'app.js', 'styles.css']) {
  const content = await readFile(join(webRoot, name));
  if (!content.length) throw new Error(`界面资源为空：${name}，请重新安装当前版本`);
}
if (!(await readFile(join(root, 'shared', 'experience.js'))).length) throw new Error('界面资源为空：experience.js，请重新安装当前版本');
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
        revision: target.revision ?? null,
        bookingGoal: target.bookingGoal ?? (new Set(target.times).size === 1 ? 'one' : 'two'),
        sameCourtAnchor: target.sameCourtAnchor,
        accountId: target.accountId ?? 'default',
        date: target.date ?? defaultTargetDate(config),
        preferSameCourt: target.preferSameCourt ?? project?.id === 'volleyball',
        includeOtherCourts: target.includeOtherCourts ?? false,
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
  const metadata = await accounts.metadata(accountId);
  const client = await HttpClient.create({ sessionPath: accounts.sessionPath(accountId), priority: 'background',
    expectedUserId: metadata.userId });
  return { client, api: new SzuVenueApi(client) };
}

function representativeTarget(config, project) {
  return {
    name: project.label,
    project: project.id,
    enabled: true,
    campus: project.campus,
    sport: project.sport,
    mode: project.mode,
    venues: project.venues,
    times: [], courts: ['*'],
  };
}

async function resolvedProject(config, projectId, api, options = {}) {
  const project = getProject(projectId);
  if (!project) throw new Error('未知项目');
  const metadata = await api.getSportVenueData(options);
  const target = { ...representativeTarget(config, project), enabled: true, project: project.id };
  return resolveTargets({ ...config, targets: [target] }, metadata)[0];
}

async function projectCatalog(projectId, dateValue, accountId, signal) {
  const config = await loadConfig(configPath);
  const { client, api } = await createApi(accountId);
  try {
    const deadline = Date.now() + 45000;
    const target = await resolvedProject(config, projectId, api, { signal, deadline });
    const reference = await catalogs.read({ api, target, accountId,
      dates: referenceDates(resolveDate(dateValue ?? 'today')), times: [], signal, deadline });
    return { date: reference.date, dates: reference.dates, cached: reference.cached, partial: reference.partial,
      issues: reference.issues, preference: config.courtPreferences?.[projectId] ?? ['*'],
      times: reference.times.map((value) => ({ value })), courts: reference.courts };
  } finally { await client.flush(); }
}

function taskFromBody(input, current) {
  const project = getProject(input.projectId);
  if (!project) throw new Error('请选择有效项目');
  const times = Array.isArray(input.times)
    ? [...new Set(input.times.filter((value) => /^\d{2}:\d{2}-\d{2}:\d{2}$/.test(value)))]
    : [];
  if (times.length === 0) throw new Error('至少选择一个时间段');
  times.forEach(splitTimeSlot);
  const bookingGoal = validateBookingGoal({ times, bookingGoal: input.bookingGoal ?? current?.bookingGoal });
  const courts = input.courts ?? current?.courts ?? ['*'];
  if (!Array.isArray(courts) || courts.length === 0 || courts.some((court) => typeof court !== 'string' || !court.trim())) {
    throw new Error('请选择场地，或选择全部场地');
  }
  const date = resolveDate(input.date);
  validateBookingGoal({ times, bookingGoal, date, sameCourtAnchor: input.sameCourtAnchor });
  if (date < shanghaiDate() || date > addDays(shanghaiDate(), 7)) throw new Error('请选择今天至未来第七天的日期');
  if (typeof input.preferSameCourt !== 'boolean') throw new Error('请选择是否优先同一场地');
  if (input.includeOtherCourts !== undefined && typeof input.includeOtherCourts !== 'boolean') throw new Error('其余场地选项须为开关值');
  const intervalMs = Number(input.intervalMs);
  const durationMs = Number(input.durationMs);
  if (!Number.isFinite(intervalMs) || intervalMs < 100 || intervalMs > 3_600_000) throw new Error('重试间隔须在 0.1 秒至 1 小时之间');
  if (!Number.isFinite(durationMs) || durationMs < 1000 || durationMs > 86_400_000) throw new Error('持续时间须在 1 秒至 24 小时之间');
  return {
    ...Object.fromEntries(Object.entries(current ?? {}).filter(([key]) => key !== 'startAt')),
    id: current?.id ?? randomUUID(),
    revision: randomUUID(),
    bookingGoal,
    sameCourtAnchor: input.sameCourtAnchor ?? (current?.date === date && current?.project === project.id
      && current?.accountId === input.accountId ? current.sameCourtAnchor : undefined),
    accountId: input.accountId ?? current?.accountId ?? 'default',
    date,
    intervalMs, durationMs,
    preferSameCourt: input.preferSameCourt,
    includeOtherCourts: input.includeOtherCourts ?? current?.includeOtherCourts ?? false,
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

async function startAuthentication(accountId = 'default', browser = 'edge') {
  if (!['edge', 'chrome', 'brave', 'chromium'].includes(browser)) throw new Error('不支持所选浏览器');
  const metadata = await accounts.metadata(accountId);
  await mkdir(accounts.dir(accountId), { recursive: true, mode: 0o700 });
  if (authChild) throw new Error('登录引导已经在运行');
  if (pendingLogin) { await rm(pendingLogin.path, { force: true }); pendingLogin = null; }
  delete authState.detectedIdentity;
  authState.accountId = accountId;
  authState.status = 'running';
  authState.startedAt = new Date().toISOString();
  authState.finishedAt = null;
  authState.logs = [];
  const script = join(root, 'scripts', 'auth.js');
  const stagingPath = `${accounts.sessionPath(accountId)}.login-${randomUUID()}`;
  const child = spawn(process.execPath, [script], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, SZU_SESSION: accounts.sessionPath(accountId), SZU_AUTH_STAGING: stagingPath,
      SZU_EXPECTED_USER_ID: metadata.userId ?? '', SZU_AUTH_CONFIRM_IDENTITY: '1', SZU_BROWSER: browser } });
  authChild = child;
  let cancelled = false;
  cancelAuthentication = () => {
    if (cancelled) return;
    cancelled = true;
    authState.status = 'cancelling';
    appendLog(authState, 'INFO', '正在取消登录……');
    child.kill('SIGTERM');
  };
  const consume = (chunk) => {
    for (const line of chunk.toString('utf8').split(/\r?\n/).filter(Boolean)) {
      appendLog(authState, 'INFO', line);
    }
  };
  const cleanupStaging = async () => {
    try { await rm(stagingPath, { force: true }); }
    catch (error) { appendLog(authState, 'ERROR', `清理临时登录文件失败：${error.message}`); }
  };
  child.stdout.on('data', consume);
  child.stderr.on('data', consume);
  child.once('error', async (error) => {
    await cleanupStaging();
    authState.status = 'error';
    authState.finishedAt = new Date().toISOString();
    appendLog(authState, 'ERROR', error.message);
    if (authChild === child) { authChild = null; cancelAuthentication = null; }
  });
  child.once('exit', async (code) => {
    if (authChild !== child) return;
    cancelAuthentication = null;
    if (cancelled) {
      authState.status = 'cancelled';
      appendLog(authState, 'INFO', '登录已取消，可重新选择浏览器');
    } else if (code === 0) {
      authState.status = 'verifying';
      appendLog(authState, 'INFO', '正在核对学校身份，原登录尚未替换……');
      try {
        const identity = await accounts.inspectLogin(accountId, stagingPath);
        if (metadata.userId) {
          const summary = await accounts.bindLogin(accountId, stagingPath);
          authState.status = 'success'; appendLog(authState, 'OK', '已连接：' + summary.user);
        } else {
          pendingLogin = { accountId, path: stagingPath };
          authState.status = 'awaiting_identity';
          authState.detectedIdentity = { name: identity.name, suffix: String(identity.id).slice(-4) };
          appendLog(authState, 'INFO', `检测到 ${identity.name}（学号尾号 ${String(identity.id).slice(-4)}）。请确认这是要绑定的用户；换号请先在学校页面退出当前身份。`);
        }
      }
      catch (error) { authState.status = 'error'; appendLog(authState, 'ERROR', error.message); }
    } else authState.status = 'error';
    if (!pendingLogin || pendingLogin.path !== stagingPath) await cleanupStaging();
    authState.finishedAt = new Date().toISOString();
    if (authChild === child) { authChild = null; cancelAuthentication = null; }
  });
}


async function ensureAccountIdle(id, allowPending = false, ownsChange = false) {
  if (!ownsChange && accountChanges.has(id)) throw new Error('此账号正在替换登录，请等待操作完成');
  if ([...starts.values()].some((entry) => entry.preparing && entry.accountId === id)) throw new Error('此账号正在验证启动，请先取消并等待验证结束');
  if (authChild && authState.accountId === id) throw new Error('此账号正在登录，请等待登录结束');
  if (!allowPending && pendingLogin?.accountId === id) throw new Error('请先确认或取消待绑定的学校身份');
  if ((await jobs.list({ summary: true })).some((job) => job.accountId === id && JOB_ACTIVE.includes(job.status))) {
    throw new Error('此账号正在执行任务，请先停止后再替换登录');
  }
}

async function taskJobs(taskId) {
  return (await jobs.list({ summary: true })).filter((job) => job.taskId === taskId);
}
async function withIdleAccount(id, operation) {
  if (accountChanges.has(id)) throw new Error('此账号正在核对或更新登录，请等待操作完成');
  accountChanges.add(id);
  try { await ensureAccountIdle(id, false, true); return await operation(); } finally { accountChanges.delete(id); }
}
async function ensureEditable(taskId) {
  if ([...starts.values()].some((entry) => entry.preparing && !entry.cancelled && entry.taskId === taskId)) throw new Error('此方案正在验证启动，请先取消启动');
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
      session: await sessionSummary(), accounts: await accounts.list(), auth: authState, jobs: await jobs.list({ summary: true }),
      serverDate: shanghaiDate(), executionMode: 'manual', legacyCleanupErrors: await legacyCleanup });
  }
  if (method === 'GET' && url.pathname === '/api/jobs') {
    return json(response, 200, { ok: true, jobs: await jobs.list({ summary: true }) });
  }
  if (method === 'POST' && url.pathname === '/api/starts/cancel') {
    const entry = startEntry((await bodyJson(request)).token);
    entry.cancelled = true;
    entry.controller?.abort(new Error('启动已取消，方案仍保留'));
    if (entry.jobId) await jobs.stop(entry.jobId);
    return json(response, 200, { ok: true });
  }
  const jobMatch = /^\/api\/jobs\/([a-f0-9-]+)(?:\/(stop|diagnostics))?$/.exec(url.pathname);
  if (jobMatch) {
    if (method === 'GET' && !jobMatch[2]) return json(response, 200, { ok: true, job: await jobs.get(jobMatch[1]) });
    if (method === 'GET' && jobMatch[2] === 'diagnostics') {
      const id = jobMatch[1];
      return json(response, 200, exportDiagnostics(await jobs.get(id), await readDiagnosticJournal(jobs.path(id))));
    }
    if (method === 'POST' && jobMatch[2] === 'stop') {
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
      return withIdleAccount(id, async () => {
        const account = await accounts.import(id, String(input.text ?? ''));
        return json(response, 200, { ok: true, account, accounts: await accounts.list() });
      });
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
    await startAuthentication(input.accountId ?? 'default', input.browser ?? 'edge');
    return json(response, 202, { ok: true, auth: authState });
  }
  if (method === 'POST' && url.pathname === '/api/auth/cancel') {
    if (pendingLogin) {
      if (pendingLogin.committing) throw new Error('身份绑定已进入保存阶段，请等待完成；如需撤销，可清除此用户登录');
      await rm(pendingLogin.path, { force: true }); pendingLogin = null;
      authState.status = 'cancelled'; delete authState.detectedIdentity;
      return json(response, 200, { ok: true, auth: authState });
    }
    if (!cancelAuthentication) throw new Error('当前没有正在进行的浏览器登录');
    cancelAuthentication();
    return json(response, 202, { ok: true, auth: authState });
  }
  if (method === 'POST' && url.pathname === '/api/auth/bind') {
    if (!pendingLogin) throw new Error('没有待确认的学校身份，请重新登录');
    const candidate = pendingLogin;
    await ensureAccountIdle(candidate.accountId, true);
    authState.status = 'binding';
    try {
      const summary = await accounts.bindLogin(candidate.accountId, candidate.path, { check: () => {
        if (pendingLogin !== candidate) throw new Error('身份绑定已取消，原登录未改动');
        candidate.committing = true;
      } });
      await rm(candidate.path, { force: true });
      if (pendingLogin === candidate) pendingLogin = null;
      authState.status = 'success'; delete authState.detectedIdentity;
      appendLog(authState, 'OK', '已绑定：' + summary.user);
      return json(response, 200, { ok: true, auth: authState, accounts: await accounts.list() });
    } catch (error) {
      if (pendingLogin === candidate) { candidate.committing = false; authState.status = 'awaiting_identity'; appendLog(authState, 'ERROR', error.message); }
      else await rm(candidate.path, { force: true });
      throw error;
    }
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
  const taskMatch = /^\/api\/tasks\/([a-z0-9-]+)(?:\/(run|review))?$/.exec(url.pathname);
  if (taskMatch) {
    const config = await loadConfig(configPath);
    const index = findTask(config, taskMatch[1]);
    let old = config.targets[index];
    if (taskMatch[2] === 'review' && method === 'POST') {
      const input = await bodyJson(request), entry = reviews.get(input.reviewToken);
      if (!entry || entry.taskId !== taskMatch[1] || Date.now() - entry.createdAt > 300000) throw new Error('核对结果已过期，请重新查询学校预约');
      if (entry.jobId) {
        const historical = await jobs.get(entry.jobId);
        if (historical.taskId !== taskMatch[1]) throw new Error('执行记录与方案不一致');
        old = { ...historical.target, accountId: historical.accountId };
      }
      if (input.confirm !== 'NO_PENDING_ORDER') throw new Error('请先人工确认未对应的请求没有订单或在途请求');
      return withIdleAccount(old.accountId ?? 'default', async () => {
        if (JSON.stringify(old) !== entry.snapshot) throw new Error('方案已修改，请重新核对');
        const account = await accounts.summary(old.accountId ?? 'default');
        if (account.userId !== entry.accountIdentityId) throw new Error('学校身份已改变，请重新核对');
        for (const job of entry.history) {
          const unresolved = pendingExecutionRequests(job).filter((r) => r.date === old.date && !entry.resolved.has(`${job.id}|${r.requestId}`));
          if (unresolved.length || job.requiresReview) await jobs.recordReview(job.id, { checkedAt: entry.checkedAt, acknowledgeCorrupt: Boolean(job.requiresReview),
            resolvedRequests: unresolved.map((r) => ({ ...r, reviewResult: 'absent', manual: true })) });
        }
        reviews.delete(input.reviewToken);
        return json(response, 200, { ok: true, jobs: await jobs.list({ summary: true }) });
      });
    }
    if (taskMatch[2] === 'review' && method === 'GET') {
      const reviewJobId = url.searchParams.get('jobId');
      if (reviewJobId) {
        const historical = await jobs.get(reviewJobId);
        if (historical.taskId !== taskMatch[1]) throw new Error('执行记录与方案不一致');
        old = { ...historical.target, accountId: historical.accountId };
      }
      return withIdleAccount(old.accountId ?? 'default', async () => {
        const account = await accounts.verify(old.accountId ?? 'default');
        const { api, client } = await createApi(old.accountId ?? 'default');
        try {
        const metadata = await api.getSportVenueData();
        const target = resolveTargets({ ...config, targets: [old] }, metadata)[0];
        const history = (await jobs.list({ summary: true })).filter((j) => j.mode !== 'check'
          && (j.accountIdentityId ? j.accountIdentityId === account.userId : j.accountId === old.accountId)
          && projectForTarget(j.target ?? {})?.id === projectForTarget(old)?.id);
        const pending = history.flatMap((j) => [
          ...pendingExecutionRequests(j).map((r) => ({ ...r, jobId: j.id })),
          ...(j.requiresReview ? [{ jobId: j.id, requestId: 'corrupt-record', date: j.target?.date ?? old.date,
            corrupt: true, court: '本地执行记录损坏' }] : []),
        ]);
        const known = history.flatMap((j) => j.successes ?? []);
        const rows = await api.getAllBookings();
        if (!reviewJobId) {
          const latest = await loadConfig(configPath);
          if (JSON.stringify(latest.targets[findTask(latest, taskMatch[1])]) !== JSON.stringify(old)) throw new Error('核对期间方案已修改，请重新核对');
        }
        const review = reviewBookings({ plan: old, target, rows, pending, known, now: Date.now() });
        for (const job of history) {
          const resolvedRequests = review.resolvedRequests.filter((r) => r.jobId === job.id);
          const original = job.target;
          let originalReview;
          if (original && Array.isArray(original.times) && original.times.length && original.date === old.date) {
            const originalTarget = resolveTargets({ ...config, targets: [{ ...old, ...original }] }, metadata)[0];
            originalReview = reviewBookings({ plan: original, target: originalTarget, rows, now: Date.now() });
          }
          if (!job.requiresReview && (resolvedRequests.length || originalReview?.goalReached)) await jobs.recordReview(job.id, {
            checkedAt: review.checkedAt, resolvedRequests, reviewedOutcome: originalReview?.goalReached ? 'success' : undefined });
        }
        const reviewToken = randomUUID();
        for (const [token, prior] of reviews) if (Date.now() - prior.createdAt > 300000) reviews.delete(token);
        reviews.set(reviewToken, { taskId: taskMatch[1], jobId: reviewJobId, snapshot: JSON.stringify(old), accountIdentityId: account.userId,
          createdAt: Date.now(), checkedAt: review.checkedAt, history,
          resolved: new Set(review.resolvedRequests.map((r) => `${r.jobId}|${r.requestId}`)) });
        return json(response, 200, { ok: true, plan: publicConfig({ ...config, targets: [old] }).tasks[0],
          review: { ...review, reviewToken }, jobs: await jobs.list({ summary: true }) });
        } finally { await client.flush(); }
      });
    }
    await ensureEditable(old.id ?? String(index));
    if (taskMatch[2] === 'run' && method === 'POST') {
      const input = await bodyJson(request);
      const entry = startEntry(input.startToken ?? randomUUID());
      if (entry.taskId && entry.taskId !== (old.id ?? String(index))) throw new Error('启动请求已用于另一个方案，请重新确认启动');
      if (entry.jobId) return json(response, 200, { ok: true, job: await jobs.inspect(entry.jobId), config: publicConfig(config) });
      if (entry.used) throw new Error(entry.error || '此启动请求已在处理，请等待执行结果');
      entry.used = true;
      entry.taskId = old.id ?? String(index); entry.accountId = old.accountId ?? 'default'; entry.preparing = true;
      entry.controller = new AbortController();
      const snapshot = JSON.stringify(old);
      const checkStart = () => {
        if (entry.cancelled || entry.controller.signal.aborted || execution.closing) throw new Error('启动已取消，方案仍保留');
      };
      try {
        checkStart(); await legacyCleanup;
        const confirmedAt = Date.now();
        executionIntent(input.mode, old.date ?? defaultTargetDate(config), { confirmedAt });
        if (input.mode !== 'check' && input.confirm !== 'SUBMIT') throw new Error('请明确确认提交真实预约');
        const date = old.date ?? defaultTargetDate(config);
        if (date < shanghaiDate() || date > addDays(shanghaiDate(), 7)) throw new Error('预约日期已过期或超出未来七天，请编辑日期');
        if (accountChanges.has(entry.accountId) || (authChild && authState.accountId === entry.accountId) || pendingLogin?.accountId === entry.accountId) throw new Error('此账号正在更新登录，请先完成或取消登录操作');
        await loadSession(accounts.sessionPath(entry.accountId));
        const account = await accounts.verify(entry.accountId, { priority: 'critical', signal: entry.controller.signal, deadline: Date.now() + 15000 });
        checkStart();
        const commit = mutationQueue.then(async () => {
          checkStart();
          const latest = await loadConfig(configPath), taskIndex = findTask(latest, entry.taskId);
          if (JSON.stringify(latest.targets[taskIndex]) !== snapshot) throw new Error('验证期间方案已修改，请重新确认启动');
          if ((await taskJobs(entry.taskId)).some((job) => JOB_ACTIVE.includes(job.status))) throw new Error('此方案已有执行正在运行');
          if (accountChanges.has(entry.accountId)) throw new Error('此账号正在更新登录，请等待完成');
          if (input.mode !== 'check' && (await jobs.list({ summary: true })).some((job) =>
            (job.accountIdentityId ? job.accountIdentityId === account.userId : job.accountId === entry.accountId)
            && !JOB_ACTIVE.includes(job.status) && (pendingExecutionRequests(job).some((r) => r.date === date)
              || (job.requiresReview && (!job.target?.date || job.target.date === date))))) {
            throw new Error('此账号当天有预约结果待确认，请先核对学校预约并确认未对应请求');
          }
          normalizeTargets(latest);
          await saveConfig(latest, configPath); checkStart();
          const target = latest.targets[taskIndex];
          const job = await jobs.create(target, latest, input.mode, { ...account, confirmedAt, sessionPath: accounts.sessionPath(target.accountId) });
          entry.jobId = job.id;
          if (entry.cancelled) { await jobs.stop(job.id); throw new Error('启动已取消，已请求停止执行'); }
          return { ok: true, job, config: publicConfig(latest) };
        });
        mutationQueue = commit.catch(() => {});
        return json(response, 202, await commit);
      } catch (error) {
        if (entry.cancelled || entry.controller.signal.aborted) error = new Error('启动已取消，方案仍保留');
        entry.error = error.message; throw error;
      }
      finally { entry.preparing = false; }
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
  const catalogMatch = /^\/api\/projects\/([^/]+)\/(catalog|courts|times)$/.exec(url.pathname);
  if (catalogMatch && method === 'GET') {
    const id = decodeURIComponent(catalogMatch[1]);
    const controller = new AbortController();
    const closed = () => { if (!response.writableFinished) controller.abort(new Error('目录窗口已关闭')); };
    response.once('close', closed);
    let data;
    try { data = await projectCatalog(id, url.searchParams.get('date') ?? undefined, url.searchParams.get('accountId') ?? 'default', controller.signal); }
    finally { response.removeListener('close', closed); }
    return json(response, 200, { ok: true, ...data });
  }
  return json(response, 404, { ok: false, error: '接口不存在' });
}

async function serveStatic(response, url) {
  const pathname = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
  const file = pathname === '/experience.js' ? join(root, 'shared', 'experience.js') : resolve(webRoot, `.${pathname}`);
  if (pathname !== '/experience.js' && file !== webRoot && !file.startsWith(`${webRoot}${sep}`)) {
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
    if (pathname === '/index.html') process.emit('szu-ui-opened');
  } catch {
    json(response, 404, { ok: false, error: '页面不存在' });
  }
}

let mutationQueue = Promise.resolve();
const server = createServer(async (request, response) => {
  try {
    const authority = new URL(`http://${request.headers.host || 'localhost'}`);
    if (authority.username || authority.password || authority.pathname !== '/' || authority.search || authority.hash) {
      throw new Error('请求地址无效');
    }
    // Comparing Origin to an unchecked Host lets a rebinding site define its
    // own trusted origin, including for credential exports. Validate the host
    // before serving either the page or its API.
    const allowedHost = ['localhost', '127.0.0.1', '[::1]'].includes(authority.hostname)
      || (!['0.0.0.0', '::'].includes(host) && authority.hostname === host);
    if (!allowedHost) return json(response, 403, { ok: false, error: '请通过本机地址访问助手' });
    const url = new URL(request.url ?? '/', authority.origin);
    if (url.origin !== authority.origin) throw new Error('请求地址与本机服务不一致');
    if (url.pathname.startsWith('/api/')) {
      // Serialize read-modify-write operations so simultaneous tabs cannot lose updates.
      if (request.method === 'GET') await handleApi(request, response, url);
      else {
        const origin = request.headers.origin;
        if (origin && origin !== url.origin) throw new Error('不接受其他网站发起的修改请求');
        // A slow login/start request must never hold Stop/Exit behind it.
        if (request.method === 'POST' && (url.pathname === '/api/app/quit'
          || url.pathname === '/api/starts/cancel' || url.pathname === '/api/auth/cancel'
          || /^\/api\/tasks\/[a-z0-9-]+\/run$/.test(url.pathname)
          || /^\/api\/accounts\/[a-z0-9-]+\/(verify|import)$/.test(url.pathname)
          || url.pathname === '/api/auth/bind'
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
    const child = spawn(process.execPath, [helper, 'preview', url], { detached: true, stdio: 'ignore' });
    child.on('error', (error) => console.error(`浏览器未打开：${error.message}；请手动访问 ${url}`));
    child.on('exit', (code) => { if (code) console.error(`浏览器启动失败（${code}）；请手动访问 ${url}`); });
    child.unref();
    return;
  }
  if (process.platform === 'win32') {
    const helper = join(root, 'scripts', 'open-login.js');
    const child = spawn(process.execPath, [helper, url], { detached: true, stdio: 'ignore', windowsHide: true });
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
  process.env.SZU_SERVER_REUSED = reused ? '1' : '0';
  console.log(`深大场馆预约${reused ? '已在运行' : '已启动'}：${url}`);
  if (!reused) {
    console.log('Cookie 和配置只保存在本机。按 Ctrl+C 停止。');
    legacyCleanup = jobs.retireSchedules().catch((error) => [`旧定时项清理失败：${error.message}`]);
    const shutdown = async () => {
      await execution.close();
      server.close(); server.closeAllConnections();
    };
    process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
    if (process.env.SZU_PACKAGED === '1' && (shouldOpen || args.includes('--tray'))) startTray(url);
  }
  if (shouldOpen) openBrowser(url);
} catch (error) {
  console.error(error.message);
  throw error; // SEA bootstrap records the failure in startup.log for GUI executables.
}
