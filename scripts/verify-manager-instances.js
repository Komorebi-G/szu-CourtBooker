// WSL -> Windows EXE integration probe. Isolated profiles, no browser, no school requests.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, readFile, rename, rm } from 'node:fs/promises';
import { join, win32 } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { windowsArgument } from '../desktop/src/native-scheduler.js';
const exec = promisify(execFile);
const ps = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
const quote = (s) => `'${String(s).replaceAll("'", "''")}'`;
async function powershell(source) {
  return (await exec(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(`$ErrorActionPreference='Stop'; ${source}`, 'utf16le').toString('base64')], { timeout: 30000 })).stdout.trim();
}
const convert = async (flag, path) => (await exec('wslpath', [flag, path])).stdout.trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const temp = await convert('-u', await powershell('[System.IO.Path]::GetTempPath()'));
const dir = await mkdtemp(join(temp, 'court-manager-probe-'));
const winDir = await convert('-w', dir);
const pids = [];
async function start(exe, home, args, wait = false) {
  const pid = Number(await powershell(`$p=Start-Process -FilePath ${quote(exe)} -ArgumentList ${quote(['--home', home, ...args].map(windowsArgument).join(' '))} -PassThru ${wait ? '-Wait' : ''}; ${wait ? 'if($p.ExitCode -ne 0){throw "EXE failed"};' : ''} $p.Id`));
  if (!wait) pids.push(pid);
  return pid;
}
async function get(port, path) {
  // Exercise Windows localhost directly; WSL forwarding is a separate moving part.
  const url = `http://127.0.0.1:${port}${path}`;
  const code = `const r=await fetch(${JSON.stringify(url)},{signal:AbortSignal.timeout(1200)}); console.log(JSON.stringify({status:r.status,body:await r.text()}));`;
  const result = JSON.parse((await exec('/mnt/c/Program Files/nodejs/node.exe', ['--input-type=module', '-e', code], { timeout: 4000 })).stdout);
  return { status: result.status, ok: result.status >= 200 && result.status < 300, json: async () => JSON.parse(result.body) };
}
async function listeningPort(pid) {
  return Number(await powershell(`$p=Get-NetTCPConnection -OwningProcess ${pid} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if($p){$p.LocalPort}else{'0'}`));
}
async function until(check, label) {
  for (let i = 0; i < 100; i++) { try { const value = await check(); if (value) return value; } catch {} await sleep(150); }
  throw new Error('等待失败：' + label);
}
try {
  for (const sub of ['old', 'new-a', 'new-b']) await mkdir(join(dir, sub));
  await copyFile('.build/SZU-CourtBooker-before-manager-fix.exe', join(dir, 'old/app.exe'));
  for (const sub of ['new-a', 'new-b']) await copyFile('dist/SZU-CourtBooker.exe', join(dir, sub, 'app.exe'));
  const old = win32.join(winDir, 'old/app.exe'), a = win32.join(winDir, 'new-a/app.exe'), b = win32.join(winDir, 'new-b/app.exe');
  const home = win32.join(winDir, 'profile-a'), homeB = win32.join(winDir, 'profile-b');
  const port = Number(await powershell('$l=[System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback,0);$l.Start();$p=$l.LocalEndpoint.Port;$l.Stop();$p'));
  console.log('测试端口：' + port);
  await start(old, home, ['--diagnostics', win32.join(winDir, 'old.json')], true);
  const oldRoot = await convert('-u', JSON.parse(await readFile(join(dir, 'old.json'), 'utf8')).appRoot);
  await start(old, home, ['--no-open', '--port', String(port)]);
  await until(async () => (await get(port, '/api/bootstrap')).ok, '旧EXE启动');
  await rename(join(oldRoot, 'desktop/web/index.html'), join(oldRoot, 'desktop/web/index.html.hidden'));
  const broken = await get(port, '/'); assert.equal(broken.status, 404); assert.equal((await broken.json()).error, '页面不存在');
  const currentPid = await start(a, home, ['--no-open', '--port', String(port)]);
  const current = await until(async () => {
    const p = await listeningPort(currentPid); if (!p) return null;
    const response = await get(p, '/api/health');
    if (response.ok) return { port: p, data: await response.json() };
  }, '新版绕过旧进程');
  assert.equal((await get(current.port, '/')).status, 200);
  assert.equal((await get(port, '/')).status, 404, '旧进程保持原状');
  console.log('通过：复现旧EXE API正常但页面404，新EXE另选端口显示正常页面。');
  const second = await start(b, home, ['--no-open', '--port', String(port)]);
  await until(async () => (await powershell(`if(Get-Process -Id ${second} -ErrorAction SilentlyContinue){'running'}else{'exited'}`)) === 'exited', '不同位置副本复用后退出');
  assert.equal((await get(current.port, '/')).status, 200);
  console.log('通过：另一个文件夹的同版EXE复用健康实例，不启动第二个管理服务。');
  const separatePid = await start(b, homeB, ['--no-open', '--port', String(current.port)]);
  const separate = await until(async () => {
    const p = await listeningPort(separatePid); if (!p) return null;
    const response = await get(p, '/api/health'); if (!response.ok) return null;
    const data = await response.json(); return data.profile !== current.data.profile && data.build === current.data.build;
  }, '不同数据目录分开');
  assert.equal(separate, true); console.log('通过：不同数据目录不会误连到前一个实例。');
  await start(a, home, ['--diagnostics', win32.join(winDir, 'new.json')], true);
  const newRoot = await convert('-u', JSON.parse(await readFile(join(dir, 'new.json'), 'utf8')).appRoot);
  await rm(join(newRoot, 'desktop/web/index.html'));
  assert.equal((await get(current.port, '/')).status, 404);
  const repair = await start(b, home, ['--no-open', '--port', String(port)]);
  await until(async () => (await get(current.port, '/')).status === 200, '损坏缓存修复');
  await until(async () => (await powershell(`if(Get-Process -Id ${repair} -ErrorAction SilentlyContinue){'running'}else{'exited'}`)) === 'exited', '修复后复用');
  console.log('通过：.ready仍在但页面丢失时，EXE自动修复缓存并复用原实例。');
  const homeC = win32.join(winDir, 'profile-concurrent');
  const pair = await Promise.all([start(a, homeC, ['--no-open', '--port', String(port)]), start(b, homeC, ['--no-open', '--port', String(port)])]);
  await until(async () => (await powershell(`@(Get-Process | Where-Object { $_.Id -in @(${pair.join(',')}) }).Count`)) === '1', '同时启动两份只保留一个实例');
  const survivor = Number(await powershell(`Get-Process | Where-Object { $_.Id -in @(${pair.join(',')}) } | Select-Object -First 1 -ExpandProperty Id`));
  const live = await until(async () => { const p = await listeningPort(survivor); if (!p) return null; const r = await get(p, '/api/health'); return r.ok ? r.json() : null; }, '并发启动留下的实例健康');
  assert.equal(live.build, current.data.build); assert.notEqual(live.profile, current.data.profile);
  assert.equal(await readFile(join(dir, 'profile-concurrent', 'startup.log'), 'utf8').catch(() => ''), '');
  console.log('通过：同一空数据目录同时启动两份EXE，只保留一个健康管理实例，启动无错误。');
} catch (error) {
  for (const name of ['profile-a', 'profile-b', 'profile-concurrent']) {
    const log = await readFile(join(dir, name, 'startup.log'), 'utf8').catch(() => '');
    if (log) console.error(name + ': ' + log);
  }
  console.error(await powershell(`Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like ${quote(winDir + '*')} } | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress`).catch(() => ''));
  throw error;
} finally {
  await powershell(`Get-Process | Where-Object { $_.Path -and $_.Path.StartsWith(${quote(winDir + win32.sep)}, [System.StringComparison]::OrdinalIgnoreCase) } | Stop-Process -Force`).catch(() => {});
  await sleep(200);
  await rm(dir, { recursive: true, force: true });
}
