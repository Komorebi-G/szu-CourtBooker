import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Keep the Windows GUI executable reachable after its browser tab is closed.
// The tray process only asks the manager to shut down; it never kills a live booking request.
export function trayScript(url, ownerPid) {
  return `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$script:baseUrl = '${url.replaceAll("'", "''")}'
$script:ownerPid = ${ownerPid}
$script:context = New-Object System.Windows.Forms.ApplicationContext
$script:icon = New-Object System.Windows.Forms.NotifyIcon
$script:brandIcon = [System.Drawing.Icon]::new('${fileURLToPath(new URL('../web/icon.ico', import.meta.url)).replaceAll("'", "''")}')
$script:icon.Icon = $script:brandIcon
$script:icon.Text = '深大场馆预约（右键退出）'
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$open = $menu.Items.Add('打开管理页面')
$quit = $menu.Items.Add('退出并停止执行')
$open.Add_Click({ Start-Process $script:baseUrl })
$script:icon.Add_DoubleClick({ Start-Process $script:baseUrl })
$quit.Add_Click({
  $answer = [System.Windows.Forms.MessageBox]::Show('停止全部执行并退出应用？会等待已发出的请求返回。', '深大场馆预约', 'YesNo', 'Question')
  if ($answer -ne [System.Windows.Forms.DialogResult]::Yes) { return }
  try {
    Invoke-WebRequest -Uri ($script:baseUrl + '/api/app/quit') -Method Post -UseBasicParsing -TimeoutSec 120 | Out-Null
    $script:icon.Visible = $false
    $script:context.ExitThread()
  } catch {
    [System.Windows.Forms.MessageBox]::Show('退出失败：' + $_.Exception.Message, '深大场馆预约') | Out-Null
  }
})
$script:icon.ContextMenuStrip = $menu
$script:icon.Visible = $true
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 1000
$timer.Add_Tick({
  if (-not (Get-Process -Id $script:ownerPid -ErrorAction SilentlyContinue)) {
    $script:icon.Visible = $false
    $script:context.ExitThread()
  }
})
$timer.Start()
try { [System.Windows.Forms.Application]::Run($script:context) }
finally { $timer.Stop(); $timer.Dispose(); $script:icon.Dispose(); $script:brandIcon.Dispose(); $menu.Dispose() }
`;
}

export function startTray(url, ownerPid = process.pid) {
  if (process.platform !== 'win32') return null;
  const script = trayScript(url, ownerPid);
  const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const child = spawn(powershell, ['-NoLogo', '-NoProfile', '-STA', '-WindowStyle', 'Hidden',
    '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
  { windowsHide: true, stdio: 'ignore' });
  child.on('error', (error) => console.error(`托盘启动失败：${error.message}`));
  child.unref();
  return child;
}
