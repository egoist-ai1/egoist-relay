param([Parameter(Mandatory)][string]$MetadataPath,[Parameter(Mandatory)][string]$ExpectedExecutable)
$ErrorActionPreference='Stop'
try {
  $bridgeInfo=Get-Content -LiteralPath $MetadataPath -Raw | ConvertFrom-Json
  $bridgeApp=Get-CimInstance Win32_Process -Filter ("ProcessId = " + [int]$bridgeInfo.appPid)
  $bridgeHelper=Get-CimInstance Win32_Process -Filter ("ProcessId = " + [int]$bridgeInfo.helperPid)
  if(-not $bridgeApp -or -not $bridgeHelper){throw 'BRIDGE_PROCESS_EXITED'}
  if([IO.Path]::GetFullPath([string]$bridgeApp.ExecutablePath) -ine [IO.Path]::GetFullPath($ExpectedExecutable) -or
     [IO.Path]::GetFullPath([string]$bridgeInfo.executablePath) -ine [IO.Path]::GetFullPath($ExpectedExecutable)){throw 'BRIDGE_EXECUTABLE_MISMATCH'}
  $bridgeStarted=([DateTimeOffset]$bridgeApp.CreationDate).ToUnixTimeMilliseconds()
  if([math]::Abs($bridgeStarted-[long]$bridgeInfo.appStartedAt) -gt 2){throw 'BRIDGE_PROCESS_CHANGED'}
  if($bridgeHelper.Name -ine 'node.exe' -or $bridgeHelper.ParentProcessId -ne $bridgeApp.ProcessId -or $bridgeHelper.CreationDate -lt $bridgeApp.CreationDate){throw 'BRIDGE_HELPER_MISMATCH'}
  @{ok=$true;appPid=$bridgeApp.ProcessId;helperPid=$bridgeHelper.ProcessId;appStartedAt=$bridgeStarted} | ConvertTo-Json -Compress
} catch { @{ok=$false;code='BRIDGE_IDENTITY_UNCONFIRMED'} | ConvertTo-Json -Compress; exit 1 }
