import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const exec = promisify(execFile);
export const isWsl = process.platform === 'linux' && Boolean(process.env.WSL_DISTRO_NAME);
const ps = isWsl ? '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe' : 'powershell.exe';
const literal = (text) => `'${String(text).replaceAll("'", "''")}'`;
const taskName = (id) => `SZUCourtBooker-${id}`;
export function windowsArgument(value) {
  return `"${String(value).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`;
}
export function systemdArgument(value) {
  return `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%').replaceAll('$', '$$').replaceAll('\n', '\\n')}"`;
}
async function powershell(source) {
  return exec(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(`$ErrorActionPreference='Stop'; ${source}`, 'utf16le').toString('base64')],
  { timeout: 30_000, windowsHide: true });
}

export function windowsRegistration({ id, at, executable, args, cwd }) {
  const name = literal(taskName(id));
  return `$action=New-ScheduledTaskAction -Execute ${literal(executable)} -Argument ${literal(args.map(windowsArgument).join(' '))}${cwd ? ` -WorkingDirectory ${literal(cwd)}` : ''};
$at=[DateTimeOffset]::Parse(${literal(new Date(at).toISOString())}).LocalDateTime;
$trigger=New-ScheduledTaskTrigger -Once -At $at;
$logon=New-ScheduledTaskTrigger -AtLogOn -User ([Security.Principal.WindowsIdentity]::GetCurrent().Name);
$settings=New-ScheduledTaskSettingsSet -WakeToRun -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero);
$principal=New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited;
Register-ScheduledTask -TaskName ${name} -Action $action -Trigger @($trigger,$logon) -Settings $settings -Principal $principal -Description '深圳大学场馆预约；30分钟内恢复未完成时段；停止和删除请在预约助手中操作' | Out-Null;
$task=Get-ScheduledTask -TaskName ${name};
if (-not $task.Settings.WakeToRun) { throw '定时唤醒设置未生效' };`;
}

export class NativeScheduler {
  constructor({ root, worker }) { this.root = root; this.worker = worker; }
  get description() {
    return process.platform === 'win32' || isWsl
      ? 'Windows 任务计划程序 · 已登录用户 · 请求休眠唤醒'
      : 'Linux systemd 用户定时器 · 需保持登录和唤醒';
  }
  async register(id, jobDir, at) {
    if (process.platform === 'win32' || isWsl) {
      // WSL's command-line parser differs from CommandLineToArgvW. Let PowerShell
      // pass native argument values rather than hand-quoting the Linux command.
      const wslCommand = `& 'C:\\Windows\\System32\\wsl.exe' ${['-d', process.env.WSL_DISTRO_NAME,
        '--cd', this.root, '--exec', process.execPath, this.worker, jobDir].map(literal).join(' ')}; exit $LASTEXITCODE`;
      const nativeCommand = `Start-Process -FilePath ${literal(process.execPath)} -ArgumentList ${literal([this.worker, jobDir].map(windowsArgument).join(' '))} -WindowStyle Hidden -Wait`;
      const executable = process.env.SZU_PACKAGED === '1' && !isWsl ? process.execPath
        : 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
      const args = process.env.SZU_PACKAGED === '1' && !isWsl ? ['--home', process.env.SZU_HOME, this.worker, jobDir]
        : ['-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand',
          Buffer.from(isWsl ? wslCommand : nativeCommand, 'utf16le').toString('base64')];
      await powershell(windowsRegistration({ id, at, executable, args, cwd: isWsl ? null : this.root }));
      return;
    }
    if (process.platform !== 'linux') throw new Error('当前系统暂不支持持久定时，可使用立即预约');
    const dir = join(homedir(), '.config', 'systemd', 'user');
    await mkdir(dir, { recursive: true });
    const name = taskName(id).toLowerCase();
    const calendar = new Date(at).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
    await writeFile(join(dir, `${name}.service`), `[Unit]\nDescription=SZU Court Booker\n[Service]\nType=oneshot\nExecStart=${[process.execPath, this.worker, jobDir].map(systemdArgument).join(' ')}\nTimeoutStartSec=infinity\n`, { mode: 0o600 });
    await writeFile(join(dir, `${name}.timer`), `[Unit]\nDescription=SZU Court Booker schedule\n[Timer]\nOnCalendar=${calendar}\nOnStartupSec=15s\nPersistent=true\nAccuracySec=1s\n[Install]\nWantedBy=timers.target\n`, { mode: 0o600 });
    await exec('systemctl', ['--user', 'daemon-reload'], { timeout: 15_000 });
    await exec('systemctl', ['--user', 'enable', '--now', `${name}.timer`], { timeout: 15_000 });
  }
  async remove(id) {
    if (process.platform === 'win32' || isWsl) {
      const name = literal(taskName(id));
      await powershell(`if (Get-ScheduledTask -TaskName ${name} -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName ${name} -Confirm:$false }`);
      return;
    }
    if (process.platform !== 'linux') return;
    const name = taskName(id).toLowerCase();
    const dir = join(homedir(), '.config', 'systemd', 'user');
    await exec('systemctl', ['--user', 'disable', '--now', `${name}.timer`], { timeout: 15_000 });
    await rm(join(dir, `${name}.timer`), { force: true });
    await rm(join(dir, `${name}.service`), { force: true });
    await exec('systemctl', ['--user', 'daemon-reload'], { timeout: 15_000 });
  }
}
