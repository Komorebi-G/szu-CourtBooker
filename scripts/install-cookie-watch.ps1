param(
  [Parameter(Mandatory=$true)][string]$SourceSession,
  [Parameter(Mandatory=$true)][string]$AccountMetadata,
  [Parameter(Mandatory=$true)][string]$ExpectedName,
  [string]$WatchRoot = "$env:LOCALAPPDATA\SZUCourtBooker\cookie-watch",
  [string]$NodePath = "$env:ProgramFiles\nodejs\node.exe",
  [int]$Hours = 48,
  [int]$IntervalMinutes = 5
)
$ErrorActionPreference = 'Stop'
if ($Hours -lt 1 -or $Hours -gt 168 -or $IntervalMinutes -lt 1 -or $IntervalMinutes -gt 60) { throw 'Invalid observation interval.' }
if (!(Test-Path -LiteralPath $NodePath)) { throw 'Windows Node executable is missing.' }
$account = Get-Content -LiteralPath $AccountMetadata -Raw -Encoding UTF8 | ConvertFrom-Json
if ($account.userName -ne $ExpectedName -or !$account.userId) { throw 'Stored account metadata does not match the requested owner.' }
$source = Get-Content -LiteralPath $SourceSession -Raw -Encoding UTF8 | ConvertFrom-Json
if (!$source.userAgent -or !$source.cookies) { throw 'Session format is invalid.' }
$runId = Get-Date -Format 'yyyyMMdd-HHmmss'
$runDir = Join-Path $WatchRoot $runId
$taskName = "SZUCookieWatch-$runId"
New-Item -ItemType Directory -Path $runDir -Force | Out-Null
# Keep credentials local to the current Windows user and SYSTEM.
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
& icacls.exe $runDir /inheritance:r /grant:r "*${sid}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not restrict experiment directory permissions.' }
$script = Join-Path $runDir 'cookie-watch.mjs'
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'cookie-watch.mjs') -Destination $script
$snapshot = Join-Path $runDir 'snapshot.session.json'
Copy-Item -LiteralPath $SourceSession -Destination $snapshot
$start = (Get-Date).AddMinutes($IntervalMinutes)
$end = $start.AddHours($Hours)
$configPath = Join-Path $runDir 'config.json'
@{ outputDir=$runDir; sourcePath=$SourceSession; snapshotPath=$snapshot;
   expected=@{name=$ExpectedName; id=$account.userId}; createdAt=(Get-Date).ToUniversalTime().ToString('o');
   sourceSavedAt=$source.savedAt; startsAt=$start.ToUniversalTime().ToString('o'); endsAt=$end.ToUniversalTime().ToString('o');
   intervalMinutes=$IntervalMinutes; taskName=$taskName } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $configPath -Encoding UTF8
# Compute the fingerprint in Node using exactly the monitor's canonical format.
$initialise = Join-Path $runDir 'initialise.mjs'
@'
import { readJson, fingerprint } from './cookie-watch.mjs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const path=process.argv[2], c=await readJson(path);
c.snapshotHash=fingerprint(await readJson(c.snapshotPath));
await writeFile(path,JSON.stringify(c,null,2)+'\n');
await writeFile(join(c.outputDir,'status.json'),JSON.stringify({status:'scheduled',checks:0,createdAt:c.createdAt,startsAt:c.startsAt,endsAt:c.endsAt},null,2)+'\n');
'@ | Set-Content -LiteralPath $initialise -Encoding UTF8
& $NodePath $initialise $configPath
if ($LASTEXITCODE -ne 0) { throw 'Could not initialise observation files.' }
$runner = Join-Path $runDir 'run-watch.ps1'
$nodeLiteral = "'" + $NodePath.Replace("'","''") + "'"
@"
`$ErrorActionPreference = 'Stop'
& $nodeLiteral (Join-Path `$PSScriptRoot 'cookie-watch.mjs') --config (Join-Path `$PSScriptRoot 'config.json') *> (Join-Path `$PSScriptRoot 'last-run.txt')
exit `$LASTEXITCODE
"@ | Set-Content -LiteralPath $runner -Encoding UTF8
$ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$action = New-ScheduledTaskAction -Execute $ps -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$runner`"" -WorkingDirectory $runDir
$trigger = New-ScheduledTaskTrigger -Once -At $start -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) -RepetitionDuration (New-TimeSpan -Hours $Hours)
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 2)
$principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
# Reinstalling should not leave multiple active probes extending the same session.
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'Read-only fixed-cookie observation; never books, logs in or updates the source session.' | Out-Null
Get-ScheduledTask -TaskName 'SZUCookieWatch-*' -ErrorAction SilentlyContinue | Where-Object { $_.TaskName -ne $taskName } | Disable-ScheduledTask | Out-Null
@{taskName=$taskName; outputDir=$runDir; configPath=$configPath; startsAt=$start.ToUniversalTime().ToString('o'); endsAt=$end.ToUniversalTime().ToString('o')} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $WatchRoot 'latest.json') -Encoding UTF8
# Deliberately do not Start-ScheduledTask or call the live probe during setup.
Get-Content -LiteralPath (Join-Path $WatchRoot 'latest.json') -Raw -Encoding UTF8
