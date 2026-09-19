// Windows-only executable probe from WSL. Uses isolated data and fake credentials;
// the scheduled worker intentionally fails before accessing the school network.
import assert from 'node:assert/strict';
import { mkdtemp, copyFile, readFile, mkdir } from 'node:fs/promises';
import { join, win32 } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { windowsArgument, windowsRegistration } from '../desktop/src/native-scheduler.js';
import { readJson, writeJson } from '../desktop/src/jobs.js';
import { sleep } from '../shared/utils.js';

const exec = promisify(execFile);
const ps = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
const literal = (s) => `'${String(s).replaceAll("'", "''")}'`;
async function powershell(source) {
  return (await exec(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(`$ErrorActionPreference='Stop'; ${source}`, 'utf16le').toString('base64')], { timeout: 30_000 })).stdout.trim();
}
const windowsTemp = await powershell('[System.IO.Path]::GetTempPath()');
const tempRoot = (await exec('wslpath', ['-u', windowsTemp])).stdout.trim();
const dir = await mkdtemp(join(tempRoot, 'szu-exe-probe-'));
const winDir = (await exec('wslpath', ['-w', dir])).stdout.trim();
const exe = win32.join(winDir, 'SZU-CourtBooker.exe');
const home = win32.join(winDir, 'isolated data');
await copyFile('dist/SZU-CourtBooker.exe', join(dir, 'SZU-CourtBooker.exe'));
const bytes = await readFile(join(dir, 'SZU-CourtBooker.exe'));
assert.equal(bytes.readUInt16LE(bytes.readUInt32LE(0x3c) + 24 + 68), 2, 'GUI subsystem, no console');
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
  console.log('通过：独立文件夹、PATH 无 Node/npm、运行时自包含、GUI 子系统。');
  serverPid = Number(await start(['--no-open', '--port', '4191']));
  let bootstrap;
  for (let attempt = 0; attempt < 40; attempt++) {
    try { bootstrap = await api('/api/bootstrap'); break; } catch { await sleep(250); }
  }
  assert.equal(bootstrap?.app, 'szu-court-booker'); assert.equal(bootstrap.config.tasks.length, 0);
  assert.equal(bootstrap.accounts.length, 1); assert.equal(bootstrap.accounts[0].exists, false);
  assert.equal(await powershell(`(Get-Process -Id ${serverPid}).MainWindowHandle`), '0');
  const { account } = await api('/api/accounts', 'POST', { name: '打包测试账号' });
  await api(`/api/accounts/${account.id}/import`, 'POST', { text: 'MOD_AUTH_CAS=fake-packaging-only; _WEU=fake' });
  const exported = await api(`/api/accounts/${account.id}/export`, 'POST', {});
  assert.equal(exported.session.cookies.find((c) => c.name === 'MOD_AUTH_CAS').value, 'fake-packaging-only');
  assert.equal((await api('/api/bootstrap')).accounts[0].exists, false, 'default account not overwritten');
  const data = join(dir, 'isolated data', 'data'), jobDir = join(data, 'jobs', id);
  await mkdir(jobDir, { recursive: true });
  await writeJson(join(jobDir, 'job.json'), { id, taskId: 'packaged-probe', mode: 'check', releaseAt: Date.now(),
    sessionPath: win32.join(home, 'deliberately-missing-session.json'), createdAt: new Date().toISOString(),
    config: { scheduler: { timeoutMs: 60000 }, targets: [] } });
  await writeJson(join(jobDir, 'state.json'), { status: 'scheduled', logs: [], successes: [] });
  await powershell(windowsRegistration({ id, at: Date.now() + 10_000, executable: exe,
    args: ['--home', home, win32.join(diagnostics.appRoot, 'src', 'dispatcher.js'), win32.join(home, 'data')], cwd: winDir }));
  await api('/api/app/quit', 'POST', {});
  await sleep(1000);
  assert.equal(await powershell(`if (Get-Process -Id ${serverPid} -ErrorAction SilentlyContinue) { 'running' } else { 'exited' }`), 'exited');
  serverPid = null;
  console.log('通过：多账号导入/导出；已退出管理服务，等待 Windows 定时唤起 exe。');
  let state;
  for (let attempt = 0; attempt < 100; attempt++) {
    state = await readJson(join(jobDir, 'state.json'));
    if (state.finishedAt) break;
    await sleep(500);
  }
  assert.equal(state.status, 'error'); assert.match(state.error, /deliberately-missing-session/);
  assert.ok(state.logs.length > 0);
  console.log(`通过：管理服务退出后，系统启动独立 exe → 执行器 → 日志落盘；未访问学校接口。\n测试资料：${dir}`);
} finally {
  await powershell(`if (Get-ScheduledTask -TaskName ${literal(taskName)} -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName ${literal(taskName)} -Confirm:$false }`);
  if (serverPid) await powershell(`Stop-Process -Id ${serverPid} -ErrorAction SilentlyContinue`);
}
