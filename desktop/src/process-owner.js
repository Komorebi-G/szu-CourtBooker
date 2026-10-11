import { readFileSync } from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { win32 } from 'node:path';

const exec = promisify(execFile);
const powershell = win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const powershellOptions = { windowsHide: true, timeout: 3000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] };
const windowsProjection = "@{pid=$_.ProcessId;identity=('windows:'+$_.CreationDate.ToUniversalTime().Ticks);createdAt=$_.CreationDate.ToUniversalTime().ToString('o');commandLine=$_.CommandLine}";
const courtCommand = /(?:SZU-CourtBooker\.exe|CourtBooker|court-booker|(?:desktop[\\/]src|src)[\\/](?:job-worker|dispatcher|web-server)\.js)/i;

function processDetails(pid) {
  try {
    if (process.platform === 'linux') {
      const contents = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const fields = contents.slice(contents.lastIndexOf(') ') + 2).split(' ');
      const bootTime = Number(/^btime (\d+)$/m.exec(readFileSync('/proc/stat', 'utf8'))?.[1]);
      return { pid, identity: `linux:${readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()}:${fields[19]}`,
        createdAt: Number.isFinite(bootTime) ? new Date(bootTime * 1000 + Number(fields[19]) * 10).toISOString() : undefined,
        commandLine: readFileSync(`/proc/${pid}/cmdline`, 'utf8') };
    }
    if (process.platform === 'win32') {
      return JSON.parse(execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command',
        `Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' -ErrorAction Stop | ForEach-Object { ${windowsProjection} } | ConvertTo-Json -Compress`], powershellOptions));
    }
  } catch {}
  return null;
}

const ownDetails = processDetails(process.pid);
const ownIdentity = ownDetails?.identity ?? null;
export const processOwner = { pid: process.pid, identity: ownIdentity, token: randomUUID() };
export const processLockToken = () => `${processOwner.pid}\n${processOwner.identity ?? ''}\n${processOwner.token}`;

function parseOwner(owner) {
  return typeof owner === 'string' ? { pid: Number(owner.split('\n')[0]), identity: owner.split('\n')[1] || null } : owner;
}

export function matchesProcessOwner(value, details, { allowLegacy = true, startedAt } = {}) {
  if (value.identity) return details === null || details?.identity === value.identity;
  if (!allowLegacy) return false;
  if (details === null || !details?.commandLine) return true;
  const recorded = value.startedAt ?? startedAt;
  const recordedAt = typeof recorded === 'number' ? recorded : Date.parse(recorded);
  const createdAt = Date.parse(details.createdAt);
  if (Number.isFinite(recordedAt) && Number.isFinite(createdAt) && createdAt > recordedAt + 1000) return false;
  return courtCommand.test(details.commandLine);
}

export function isProcessOwner(owner, options) {
  const value = parseOwner(owner);
  if (!Number.isSafeInteger(value?.pid) || value.pid <= 0) return false;
  try { process.kill(value.pid, 0); } catch (error) { if (error.code === 'ESRCH') return false; }
  if (value.pid === process.pid) {
    if (value.identity) return value.identity === ownIdentity;
    const recorded = value.startedAt ?? options?.startedAt;
    const recordedAt = typeof recorded === 'number' ? recorded : Date.parse(recorded);
    if (Number.isFinite(recordedAt) && Date.parse(ownDetails?.createdAt) > recordedAt + 1000) return false;
    return true;
  }
  return matchesProcessOwner(value, processDetails(value.pid), options);
}

let census, censusAt = 0, censusPending;
async function windowsProcesses() {
  if (census && Date.now() - censusAt < 2000) return census;
  if (!censusPending) censusPending = exec(powershell, ['-NoProfile', '-NonInteractive', '-Command',
    `@(Get-CimInstance Win32_Process -ErrorAction Stop | ForEach-Object { ${windowsProjection} }) | ConvertTo-Json -Compress`], powershellOptions)
    .then(({ stdout }) => {
      const values = JSON.parse(stdout); census = new Map((Array.isArray(values) ? values : [values]).map((value) => [value.pid, value]));
      censusAt = Date.now(); return census;
    }).catch(() => null).finally(() => { censusPending = null; });
  return censusPending;
}

export async function isProcessOwnerAsync(owner, options) {
  const value = parseOwner(owner);
  if (process.platform !== 'win32' || value?.pid === process.pid) return isProcessOwner(owner, options);
  if (!Number.isSafeInteger(value?.pid) || value.pid <= 0) return false;
  try { process.kill(value.pid, 0); } catch (error) { if (error.code === 'ESRCH') return false; }
  const processes = await windowsProcesses();
  return processes === null ? true : processes.has(value.pid) && matchesProcessOwner(value, processes.get(value.pid), options);
}
