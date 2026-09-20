import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const exec = promisify(execFile);
export const isWsl = process.platform === 'linux' && Boolean(process.env.WSL_DISTRO_NAME);
const ps = isWsl ? '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'
  : process.platform === 'win32' ? join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : 'powershell.exe';
const literal = (text) => `'${String(text).replaceAll("'", "''")}'`;
const taskName = (id) => `SZUCourtBooker-${id}`;
export function windowsArgument(value) {
  return `"${String(value).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`;
}
async function powershell(source) {
  return exec(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(`$ErrorActionPreference='Stop'; ${source}`, 'utf16le').toString('base64')],
  { timeout: 30_000, windowsHide: true });
}

// Only retained to remove timers created by older versions.
export class NativeScheduler {
  async remove(id) {
    if (process.platform === 'win32' || isWsl) {
      const name = literal(taskName(id));
      await powershell(`if (Get-ScheduledTask -TaskName ${name} -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName ${name} -Confirm:$false }`);
      return;
    }
    if (process.platform !== 'linux') return;
    const name = taskName(id).toLowerCase();
    const dir = join(homedir(), '.config', 'systemd', 'user');
    const timer = join(dir, `${name}.timer`), service = join(dir, `${name}.service`);
    const present = await Promise.all([timer, service].map((path) => access(path).then(() => true, () => false)));
    if (!present.some(Boolean)) return;
    await exec('systemctl', ['--user', 'disable', '--now', `${name}.timer`], { timeout: 15_000 });
    await rm(join(dir, `${name}.timer`), { force: true });
    await rm(join(dir, `${name}.service`), { force: true });
    await exec('systemctl', ['--user', 'daemon-reload'], { timeout: 15_000 });
  }
}
