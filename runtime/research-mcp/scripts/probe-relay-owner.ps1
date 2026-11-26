param([Parameter(Mandatory=$true)][string]$Executable)
$ErrorActionPreference='Stop'
$researchExe=[IO.Path]::GetFullPath($Executable)
$researchOwners=@(Get-CimInstance Win32_Process -Filter "Name='Egoist Relay.exe'" | Where-Object { $_.ExecutablePath -and [IO.Path]::GetFullPath($_.ExecutablePath) -ieq $researchExe })
[pscustomobject]@{count=$researchOwners.Count;owners=@($researchOwners | ForEach-Object {
  [pscustomobject]@{pid=$_.ProcessId;startedAt=([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds()}
})} | ConvertTo-Json -Depth 4 -Compress
