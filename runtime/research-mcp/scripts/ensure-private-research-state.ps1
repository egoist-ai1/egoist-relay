param(
  [Parameter(Mandatory = $true)][string]$StateRoot,
  [switch]$IsolatedTest,
  [switch]$ValidateOnly
)
$ErrorActionPreference = 'Stop'
$researchStatePath = [IO.Path]::GetFullPath($StateRoot).TrimEnd('\')
$researchExpectedPath = [IO.Path]::GetFullPath((Join-Path $env:USERPROFILE '.egoist-research')).TrimEnd('\')
if ($IsolatedTest) {
  if ($env:EGOIST_RELAY_SMOKE_TEST -ne '1' -or -not $env:EGOIST_RELAY_TEST_PROFILE) { throw 'RESEARCH_TEST_SCOPE_INVALID' }
  $researchExpectedPath = [IO.Path]::GetFullPath((Join-Path $env:EGOIST_RELAY_TEST_PROFILE 'research')).TrimEnd('\')
}
if ($researchStatePath -ine $researchExpectedPath) { throw 'RESEARCH_STATE_SCOPE_INVALID' }
$researchCursor = $researchStatePath
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
$researchSystem = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$researchHasher = [Security.Cryptography.SHA256]::Create()
try { $researchHash = [BitConverter]::ToString($researchHasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($researchStatePath.ToLowerInvariant()))).Replace('-', '').Substring(0,24) }
finally { $researchHasher.Dispose() }
$researchMutex = [Threading.Mutex]::new($false, "Local\EgoistResearchState-$researchHash")
$researchHeld = $false

function Test-ResearchFile([string]$FilePath, [bool]$CheckAccess = $true) {
  if (-not (Test-Path -LiteralPath $FilePath)) { return }
  $researchFile = Get-Item -LiteralPath $FilePath -Force
  if ($researchFile.PSIsContainer -or $researchFile.LinkType -eq 'HardLink' -or ($researchFile.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'RESEARCH_STATE_FILE_INVALID' }
  if ($researchFile.Length -gt 16384) { throw 'RESEARCH_STATE_FILE_OVERSIZED' }
  $researchFileAcl = [Security.AccessControl.FileSecurity]::new($FilePath, [Security.AccessControl.AccessControlSections]'Access,Owner')
  if ($researchFileAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $researchIdentity.Value) { throw 'RESEARCH_STATE_OWNER_MISMATCH' }
  if ($CheckAccess) {
    foreach ($researchRule in $researchFileAcl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
      if ($researchRule.AccessControlType -ne 'Allow' -or $researchRule.IdentityReference.Value -notin @($researchIdentity.Value, $researchSystem.Value)) { throw 'RESEARCH_STATE_ACL_UNEXPECTED' }
    }
  }
}

try {
  try { $researchHeld = $researchMutex.WaitOne(15000) }
  catch [Threading.AbandonedMutexException] { $researchHeld = $true }
  if (-not $researchHeld) { throw 'RESEARCH_STATE_INITIALIZATION_BUSY' }
  $researchMarkerPath = Join-Path $researchStatePath '.research-owned.json'
  $researchCreated = $false
  if (Test-Path -LiteralPath $researchStatePath) {
    if (-not (Test-Path -LiteralPath $researchStatePath -PathType Container) -or -not (Test-Path -LiteralPath $researchMarkerPath -PathType Leaf)) { throw 'RESEARCH_STATE_UNOWNED' }
    $researchExistingAcl = [Security.AccessControl.DirectorySecurity]::new($researchStatePath,[Security.AccessControl.AccessControlSections]'Access,Owner')
    if ($researchExistingAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $researchIdentity.Value) { throw 'RESEARCH_STATE_OWNER_MISMATCH' }
    Test-ResearchFile $researchMarkerPath ([bool]$ValidateOnly)
    $researchMarker = Get-Content -LiteralPath $researchMarkerPath -Raw | ConvertFrom-Json
    if ($researchMarker.schema_version -ne 1 -or $researchMarker.owner_sid -ne $researchIdentity.Value) { throw 'RESEARCH_STATE_OWNER_MISMATCH' }
    $researchMarkerNames = @($researchMarker.PSObject.Properties.Name | Sort-Object)
    if ($researchMarker.purpose -ne 'EgoistResearchMCP private per-user state' -or ($researchMarkerNames -join ',') -ne 'owner_sid,purpose,schema_version') { throw 'RESEARCH_STATE_MARKER_INVALID' }
    foreach ($researchOwnedFile in @('.research-owned.json','relay-bridge.json','relay-bridge-token')) {
      Test-ResearchFile (Join-Path $researchStatePath $researchOwnedFile) ([bool]$ValidateOnly)
    }
  } else {
    if ($ValidateOnly) { throw 'RESEARCH_STATE_MISSING' }
    [IO.Directory]::CreateDirectory($researchStatePath) | Out-Null
    $researchCreated = $true
  }

  if (-not $ValidateOnly) {
    $researchAcl = [Security.AccessControl.DirectorySecurity]::new()
    $researchAcl.SetOwner($researchIdentity)
    $researchAcl.SetAccessRuleProtection($true,$false)
    $researchInheritance = [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
    $researchPropagation = [Security.AccessControl.PropagationFlags]::None
    foreach ($researchAllowedIdentity in @($researchIdentity,$researchSystem)) {
      $researchAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($researchAllowedIdentity,'FullControl',$researchInheritance,$researchPropagation,'Allow'))
    }
    # Construct only owner/access sections. Never retrieve or write an Audit/SACL section.
    [IO.Directory]::SetAccessControl($researchStatePath,$researchAcl)
    if ($researchCreated) {
      $researchMarkerText = @{schema_version=1;owner_sid=$researchIdentity.Value;purpose='EgoistResearchMCP private per-user state'} | ConvertTo-Json -Compress
      [IO.File]::WriteAllText($researchMarkerPath,$researchMarkerText,[Text.UTF8Encoding]::new($false))
    }
    foreach ($researchOwnedFile in @('.research-owned.json','relay-bridge.json','relay-bridge-token')) {
      $researchPrivateFile = Join-Path $researchStatePath $researchOwnedFile
      if (-not (Test-Path -LiteralPath $researchPrivateFile)) { continue }
      $researchPrivateAcl = [Security.AccessControl.FileSecurity]::new()
      $researchPrivateAcl.SetOwner($researchIdentity)
      $researchPrivateAcl.SetAccessRuleProtection($true,$false)
      foreach ($researchAllowedIdentity in @($researchIdentity,$researchSystem)) {
        $researchPrivateAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($researchAllowedIdentity,'FullControl','Allow'))
      }
      [IO.File]::SetAccessControl($researchPrivateFile,$researchPrivateAcl)
    }
  }
  $researchReadback = [Security.AccessControl.DirectorySecurity]::new($researchStatePath,[Security.AccessControl.AccessControlSections]'Access,Owner')
  if (-not $researchReadback.AreAccessRulesProtected) { throw 'RESEARCH_STATE_ACL_NOT_PRIVATE' }
  if ($researchReadback.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $researchIdentity.Value) { throw 'RESEARCH_STATE_OWNER_MISMATCH' }
  $researchAllowedSids = @{}
  foreach ($researchRule in $researchReadback.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
    if ($researchRule.AccessControlType -ne 'Allow' -or $researchRule.IdentityReference.Value -notin @($researchIdentity.Value,$researchSystem.Value)) { throw 'RESEARCH_STATE_ACL_UNEXPECTED' }
    $researchAllowedSids[$researchRule.IdentityReference.Value] = $true
  }
  if (-not $researchAllowedSids.ContainsKey($researchIdentity.Value) -or -not $researchAllowedSids.ContainsKey($researchSystem.Value)) { throw 'RESEARCH_STATE_ACL_INCOMPLETE' }
  foreach ($researchOwnedFile in @('.research-owned.json','relay-bridge.json','relay-bridge-token')) { Test-ResearchFile (Join-Path $researchStatePath $researchOwnedFile) }
  Write-Output 'RESEARCH_STATE_PRIVATE'
} finally {
  if ($researchHeld) { $researchMutex.ReleaseMutex() }
  $researchMutex.Dispose()
}
