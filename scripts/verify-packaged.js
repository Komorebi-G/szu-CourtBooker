// Windows-only executable probe from WSL. Uses isolated data and fake credentials;
// the legacy entry only retires a fixture; no school requests or timer registration.
import assert from 'node:assert/strict';
import { mkdtemp, copyFile, readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, win32 } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright-core';
import { windowsArgument } from '../desktop/src/native-scheduler.js';
import { readJson, writeJson, exists } from '../desktop/src/jobs.js';
import { sleep, shanghaiDate, addDays } from '../shared/utils.js';

const exec = promisify(execFile);
const ps = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
const literal = (s) => `'${String(s).replaceAll("'", "''")}'`;
async function powershell(source) {
  return (await exec(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(`$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); ${source}`, 'utf16le').toString('base64')], { timeout: 30_000 })).stdout.trim();
}
const windowsTemp = await powershell('[System.IO.Path]::GetTempPath()');
const tempRoot = (await exec('wslpath', ['-u', windowsTemp])).stdout.trim();
const dir = await mkdtemp(join(tempRoot, 'szu-exe-probe-'));
const winDir = (await exec('wslpath', ['-w', dir])).stdout.trim();
const exe = win32.join(winDir, 'SZU-CourtBooker.exe');
const build = await readJson('dist/windows-build.json');
const home = win32.join(winDir, 'isolated data');
await copyFile('dist/SZU-CourtBooker.exe', join(dir, 'SZU-CourtBooker.exe'));
const bytes = await readFile(join(dir, 'SZU-CourtBooker.exe'));
assert.equal(bytes.readUInt16LE(bytes.readUInt32LE(0x3c) + 24 + 68), 2, 'GUI subsystem, no console');
const brand = JSON.parse(await powershell(`$v=[System.Diagnostics.FileVersionInfo]::GetVersionInfo(${literal(exe)}); @{ProductName=$v.ProductName; FileDescription=$v.FileDescription; OriginalFilename=$v.OriginalFilename; ProductVersion=$v.ProductVersion} | ConvertTo-Json -Compress`));
assert.equal(brand.ProductName, '深大场馆预约');
assert.equal(brand.FileDescription, '深大场馆预约');
assert.equal(brand.OriginalFilename, 'SZU-CourtBooker.exe');
assert.equal(brand.ProductVersion, [...build.version.split('.'), '0'].slice(0, 4).join('.'));
const start = async (args, wait = false) => powershell(`$env:PATH="$env:SystemRoot\\System32";
  $p=Start-Process -FilePath ${literal(exe)} -ArgumentList ${literal(['--home', home, ...args].map(windowsArgument).join(' '))} -PassThru ${wait ? '-Wait' : ''};
  ${wait ? 'if ($p.ExitCode -ne 0) { throw "Process failed: $($p.ExitCode)" };' : ''} $p.Id`);
const id = randomUUID(), taskName = `SZUCourtBooker-${id}`;
let serverPid;
const base = 'http://127.0.0.1:4191';
async function api(path, method = 'GET', body) {
  const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(3000) });
  const result = await response.json();
  assert.ok(response.ok, JSON.stringify(result)); return result;
}
try {
  await start(['--diagnostics', win32.join(winDir, 'diagnostics.json')], true);
  const diagnostics = await readJson(join(dir, 'diagnostics.json'));
  assert.equal(diagnostics.packaged, true); assert.equal(diagnostics.base, home);
  assert.equal(win32.basename(diagnostics.appRoot), build.buildId);
  const appRoot = (await exec('wslpath', ['-u', diagnostics.appRoot])).stdout.trim();
  for (const file of ['shared/runner.js', 'shared/request-gate.js', 'shared/api.js', 'shared/http-client-core.js',
    'shared/booking-quota.js', 'shared/booking-goal.js', 'shared/booking-outcome.js', 'shared/booking-review.js',
    'desktop/src/atomic-file.js', 'desktop/src/job-worker.js', 'desktop/src/execution.js',
    'desktop/src/http-client.js', 'desktop/src/accounts.js', 'desktop/src/web-server.js', 'desktop/src/catalogs.js']) {
    assert.ok((await readFile(join(appRoot, file))).equals(await readFile(file)), `实际 EXE 应包含本次修复：${file}`);
  }
  console.log('通过：独立文件夹、PATH 无 Node/npm、运行时自包含、GUI 子系统。');
  serverPid = Number(await start(['--no-open', '--tray', '--port', '4191']));
  let bootstrap;
  for (let attempt = 0; attempt < 40; attempt++) {
    try { bootstrap = await api('/api/bootstrap'); break; } catch { await sleep(250); }
  }
  assert.equal(bootstrap?.app, 'szu-court-booker'); assert.equal(bootstrap.config.tasks.length, 0);
  assert.equal(bootstrap.accounts.length, 1); assert.equal(bootstrap.accounts[0].exists, false);
  assert.equal(await powershell(`(Get-Process -Id ${serverPid}).MainWindowHandle`), '0');
  let trayPid = 0;
  for (let attempt = 0; attempt < 30 && !trayPid; attempt++) {
    trayPid = Number(await powershell(`$p=Get-CimInstance Win32_Process -Filter 'ParentProcessId = ${serverPid}' | Where-Object { $_.Name -eq 'powershell.exe' } | Select-Object -First 1; if($p){$p.ProcessId}else{0}`));
    if (!trayPid) await sleep(200);
  }
  assert.ok(trayPid > 0, 'GUI EXE should expose a Windows tray process');
  const { account } = await api('/api/accounts', 'POST', { name: '打包测试账号' });
  await api(`/api/accounts/${account.id}/import`, 'POST', { text: 'MOD_AUTH_CAS=fake-packaging-only; _WEU=fake' });
  const exported = await api(`/api/accounts/${account.id}/export`, 'POST', {});
  assert.equal(exported.session.cookies.find((c) => c.name === 'MOD_AUTH_CAS').value, 'fake-packaging-only');
  assert.equal((await api('/api/bootstrap')).accounts[0].exists, false, 'default account not overwritten');
  const plan = { projectId: 'badminton', accountId: account.id, date: addDays(shanghaiDate(), 1),
    times: ['19:00-20:00', '20:00-21:00'], courts: ['A'], preferSameCourt: true, includeOtherCourts: false,
    bookingGoal: 'consecutive', intervalMs: 100, durationMs: 120000 };
  const saved = await api('/api/tasks', 'POST', plan);
  assert.equal(saved.config.tasks[0].bookingGoal, 'consecutive');
  const changed = await api(`/api/tasks/${saved.taskId}`, 'PUT', { ...plan, bookingGoal: 'one' });
  assert.notEqual(changed.config.tasks[0].revision, saved.config.tasks[0].revision);
  // View the actual packaged Windows server. Only catalog reads are mocked;
  // account/task storage and the served HTML/JS/CSS come from the executable.
  const output = process.env.SZU_UI_ARTIFACTS || '/tmp/courtbooker-packaged-ui';
  await mkdir(output, { recursive: true });
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9334');
  const context = await browser.newContext();
  try {
    await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
    const page = await context.newPage();
    await page.route('**/api/projects/*/catalog?*', route => route.fulfill({ json: { ok: true,
      times: plan.times.map(value => ({ value })), courts: [{ id: 'A', name: '一号场' }] } }));
    await page.setViewportSize({ width: 1360, height: 950 });
    await page.goto(base);
    const row = page.locator(`[data-task="${saved.taskId}"]`);
    await row.waitFor();
    assert.equal(await row.locator('h3').innerText(), '羽毛球');
    await page.screenshot({ path: join(output, 'packaged-desktop.png') });
    await row.locator('.more-actions summary').click();
    await row.locator('[data-action=edit]').click();
    await page.locator('[data-time="19:00-20:00"]').waitFor();
    assert.equal(await page.locator('#bookingGoal').inputValue(), 'one');
    assert.equal(await page.locator('#taskOptions').evaluate(element => element.open), false);
    await page.screenshot({ path: join(output, 'packaged-desktop-editor.png') });
    await page.locator('[data-close=task]').first().click();
    assert.equal((await api('/api/bootstrap')).config.tasks[0].revision, changed.config.tasks[0].revision);
  } finally { await context.close(); await browser.close(); }
  const cancelledStart = randomUUID(); await api('/api/starts/cancel', 'POST', { token: cancelledStart });
  const data = join(dir, 'isolated data', 'data'), jobDir = join(data, 'jobs', id);
  await mkdir(jobDir, { recursive: true });
  await writeJson(join(jobDir, 'job.json'), { id, taskId: 'packaged-probe', mode: 'schedule', releaseAt: Date.now(),
    sessionPath: win32.join(home, 'deliberately-missing-session.json'), createdAt: new Date().toISOString(),
    config: { scheduler: { timeoutMs: 60000 }, targets: [] } });
  await writeJson(join(jobDir, 'state.json'), { status: 'scheduled', logs: [], successes: [] });
  await writeFile(join(jobDir, 'events.ndjson'), JSON.stringify({ sequence: 1, level: 'PLAN', message: '打包诊断测试' }) + '\n');
  const diagnostic = await api(`/api/jobs/${id}/diagnostics`);
  assert.equal(diagnostic.format, 'szu-court-diagnostics/v1');
  assert.equal(diagnostic.events[0].message, '打包诊断测试');
  await api('/api/app/quit', 'POST', {});
  await sleep(1000);
  assert.equal(await powershell(`if (Get-Process -Id ${serverPid} -ErrorAction SilentlyContinue) { 'running' } else { 'exited' }`), 'exited');
  for (let attempt = 0; attempt < 30; attempt++) {
    if (await powershell(`if (Get-Process -Id ${trayPid} -ErrorAction SilentlyContinue) { 'running' } else { 'exited' }`) === 'exited') break;
    await sleep(200);
  }
  assert.equal(await powershell(`if (Get-Process -Id ${trayPid} -ErrorAction SilentlyContinue) { 'running' } else { 'exited' }`), 'exited');
  serverPid = null;
  await start([win32.join(diagnostics.appRoot, 'src', 'dispatcher.js'), win32.join(home, 'data')], true);
  assert.equal(await exists(join(jobDir, 'stop')), true);
  assert.equal(await exists(join(jobDir, 'schedule-retired')), true);
  console.log(`通过：多账号导入导出、预约目标/方案版本、取消入口、诊断日志导出、退出助手、旧定时入口停用；未访问学校接口。\n测试资料：${dir}`);
} finally {
  await powershell(`if (Get-ScheduledTask -TaskName ${literal(taskName)} -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName ${literal(taskName)} -Confirm:$false }`);
  if (serverPid) await powershell(`Stop-Process -Id ${serverPid} -ErrorAction SilentlyContinue`);
}
