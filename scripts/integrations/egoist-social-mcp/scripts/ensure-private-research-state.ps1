param([Parameter(Mandatory)][string]$StateRoot)
$ErrorActionPreference = 'Stop'
$researchExpected = [IO.Path]::GetFullPath((Join-Path $env:USERPROFILE '.egoist-research'))
$researchActual = [IO.Path]::GetFullPath($StateRoot)
if ($researchActual -ine $researchExpected) { throw 'RESEARCH_STATE_SCOPE_INVALID' }
$researchCursor = $researchActual
while ($researchCursor) {
  if (Test-Path -LiteralPath $researchCursor) {
    $researchItem = Get-Item -LiteralPath $researchCursor -Force
    if ($researchItem.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'RESEARCH_STATE_REPARSE_DENIED' }
  }
  $researchParent = [IO.Directory]::GetParent($researchCursor)
  if (-not $researchParent) { break }
  $researchCursor = $researchParent.FullName
}
$researchIdentity = [Security.Principal.WindowsIdentity]::GetCurrent().User
$researchMutexHash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($researchActual.ToLowerInvariant()))).Substring(0,24)
$researchMutex = [Threading.Mutex]::new($false, "Local\EgoistResearchState-$researchMutexHash")
$researchHeld = $false
try {
  try { $researchHeld = $researchMutex.WaitOne(15000) }
  catch [Threading.AbandonedMutexException] { $researchHeld = $true }
  if (-not $researchHeld) { throw 'RESEARCH_STATE_INITIALIZATION_BUSY' }
$researchMarker = Join-Path $researchActual '.research-owned.json'
$researchNew = $false
if (Test-Path -LiteralPath $researchActual) {
  if (-not (Test-Path -LiteralPath $researchMarker -PathType Leaf)) { throw 'RESEARCH_STATE_UNOWNED' }
  $researchMarkerItem = Get-Item -LiteralPath $researchMarker -Force
  if ($researchMarkerItem.PSIsContainer -or $researchMarkerItem.LinkType -eq 'HardLink' -or ($researchMarkerItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $researchMarkerItem.Length -gt 16384) { throw 'RESEARCH_STATE_FILE_INVALID' }
  $researchMarkerAcl = Get-Acl -LiteralPath $researchMarker
  if ([Security.Principal.NTAccount]::new($researchMarkerAcl.Owner).Translate([Security.Principal.SecurityIdentifier]).Value -ne $researchIdentity.Value) { throw 'RESEARCH_STATE_OWNER_MISMATCH' }
  $researchStored = Get-Content -LiteralPath $researchMarker -Raw | ConvertFrom-Json
  $researchMarkerKeys = @($researchStored.PSObject.Properties.Name)
  if ($researchMarkerKeys.Count -ne 3 -or @($researchMarkerKeys | Where-Object { $_ -notin @('schema_version','owner_sid','purpose') }).Count -or $researchStored.schema_version -ne 1 -or $researchStored.owner_sid -ne $researchIdentity.Value -or $researchStored.purpose -ne 'EgoistResearchMCP private per-user state') { throw 'RESEARCH_STATE_OWNER_MISMATCH' }
} else {
  New-Item -ItemType Directory -Path $researchActual | Out-Null
  $researchNew = $true
}
$researchAcl = Get-Acl -LiteralPath $researchActual
$researchInheritance = [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
$researchPropagation = [Security.AccessControl.PropagationFlags]::None
$researchSystem = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$researchOwnerSid = [Security.Principal.NTAccount]::new($researchAcl.Owner).Translate([Security.Principal.SecurityIdentifier]).Value
if ($researchOwnerSid -ne $researchIdentity.Value) { throw 'RESEARCH_STATE_OWNER_MISMATCH' }
$researchUnexpected = @($researchAcl.Access | Where-Object { $_.AccessControlType -eq 'Allow' -and $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -notin @($researchIdentity.Value,'S-1-5-18') })
if ($researchNew -or -not $researchAcl.AreAccessRulesProtected -or $researchUnexpected.Count) {
  # Only this marker-owned directory's DACL changes; no audit/owner ACL is written.
  $researchDacl = [Security.AccessControl.DirectorySecurity]::new()
  $researchDacl.SetAccessRuleProtection($true, $false)
  $researchDacl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($researchIdentity, 'FullControl', $researchInheritance, $researchPropagation, 'Allow'))
  $researchDacl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($researchSystem, 'FullControl', $researchInheritance, $researchPropagation, 'Allow'))
  [IO.FileSystemAclExtensions]::SetAccessControl([IO.DirectoryInfo]::new($researchActual), $researchDacl)
}
if ($researchNew) {
  @{schema_version=1;owner_sid=$researchIdentity.Value;purpose='EgoistResearchMCP private per-user state'} | ConvertTo-Json -Compress | Set-Content -LiteralPath $researchMarker -Encoding utf8
}
$researchReadback = Get-Acl -LiteralPath $researchActual
if (-not $researchReadback.AreAccessRulesProtected) { throw 'RESEARCH_STATE_ACL_NOT_PRIVATE' }
$researchOwnerSid = [Security.Principal.NTAccount]::new($researchReadback.Owner).Translate([Security.Principal.SecurityIdentifier]).Value
if ($researchOwnerSid -ne $researchIdentity.Value) { throw 'RESEARCH_STATE_OWNER_MISMATCH' }
foreach ($researchRule in $researchReadback.Access) {
  if ($researchRule.AccessControlType -eq 'Allow' -and $researchRule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -notin @($researchIdentity.Value,'S-1-5-18')) { throw 'RESEARCH_STATE_ACL_UNEXPECTED' }
}
Write-Output 'RESEARCH_STATE_PRIVATE'
} finally {
  if ($researchHeld) { $researchMutex.ReleaseMutex() }
  $researchMutex.Dispose()
}
