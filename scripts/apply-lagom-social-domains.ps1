#requires -Version 5.1
<#
.SYNOPSIS
Plans an additive social-domain merge for Lagom's existing EGOIST MIX hostlist.
.DESCRIPTION
The default operation is read-only. Apply requires an administrator shell and
replaces only the fixed list-general-user.txt file. Existing bytes, comments,
domain/IP exclusions and service/network settings are preserved.
#>
[CmdletBinding()]
param([switch]$Apply)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$runtimeRoot = 'C:\ProgramData\EgoistShield\Runtime\Zapret'
$listsRoot = Join-Path $runtimeRoot 'core\lists'
$targetPath = Join-Path $listsRoot 'list-general-user.txt'
$wrapperPath = Join-Path $runtimeRoot 'service-wrapper\egoistshield-zapret-service.exe'
$xmlPath = Join-Path $runtimeRoot 'service-wrapper\egoistshield-zapret-service.xml'
$profileName = 'general (EGOIST MIX)'
$maximumBytes = 1MB
$socialDomains = @(
    'telegram.org', 't.me', 'x.com', 'twitter.com', 'twimg.com',
    'instagram.com', 'cdninstagram.com', 'fbcdn.net', 'facebook.com', 'facebook.net'
)
$excludePaths = @(
    (Join-Path $listsRoot 'list-exclude.txt'),
    (Join-Path $listsRoot 'list-exclude-user.txt')
)
$temporaryPath = $null
$mayHaveApplied = $false
$exitCode = 0
$result = $null

function Get-AuditException {
    param([string]$Code, [string]$Message)
    $exception = [InvalidOperationException]::new($Message)
    $exception.Data['AuditCode'] = $Code
    return $exception
}

function Confirm-PlainPath {
    param([string]$Path)
    $current = [IO.Path]::GetFullPath($Path)
    while ($current) {
        $item = Get-Item -LiteralPath $current -Force -ErrorAction Stop
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw (Get-AuditException 'REPARSE_PATH' 'An owned Lagom path is a reparse point; no write is allowed.')
        }
        $current = [IO.Path]::GetDirectoryName($current)
    }
}

function Get-BytesHash {
    param([AllowEmptyCollection()][byte[]]$Bytes)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($algorithm.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant() }
    finally { $algorithm.Dispose() }
}

function Read-BoundedFile {
    param([string]$Path)
    Confirm-PlainPath $Path
    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
        if ($stream.Length -gt $maximumBytes) {
            throw (Get-AuditException 'FILE_TOO_LARGE' 'An owned Lagom file exceeds the one MiB read limit.')
        }
        $bytes = [byte[]]::new([int]$stream.Length)
        $offset = 0
        while ($offset -lt $bytes.Length) {
            $read = $stream.Read($bytes, $offset, $bytes.Length - $offset)
            if ($read -eq 0) { throw (Get-AuditException 'FILE_CHANGED' 'An owned Lagom file changed during the bounded read.') }
            $offset += $read
        }
        return [pscustomobject]@{ Path = $Path; Bytes = $bytes; Hash = (Get-BytesHash $bytes) }
    }
    finally { $stream.Dispose() }
}

function Confirm-FileSnapshot {
    param([object]$Snapshot)
    if ((Read-BoundedFile $Snapshot.Path).Hash -ne $Snapshot.Hash) {
        throw (Get-AuditException 'CONCURRENT_CHANGE' 'A checked hostlist changed after planning; no replacement was attempted.')
    }
}

function Get-HostlistText {
    param([AllowEmptyCollection()][byte[]]$Bytes)
    if ($Bytes.Length -ge 2 -and
        (($Bytes[0] -eq 255 -and $Bytes[1] -eq 254) -or ($Bytes[0] -eq 254 -and $Bytes[1] -eq 255))) {
        throw (Get-AuditException 'UNSUPPORTED_ENCODING' 'UTF-16/32 is not a byte-oriented Zapret hostlist; the original file is preserved.')
    }
    if ($Bytes.Length -ge 4 -and $Bytes[0] -eq 0 -and $Bytes[1] -eq 0 -and $Bytes[2] -eq 254 -and $Bytes[3] -eq 255) {
        throw (Get-AuditException 'UNSUPPORTED_ENCODING' 'UTF-16/32 is not a byte-oriented Zapret hostlist; the original file is preserved.')
    }
    $offset = 0
    $encodingName = 'UTF-8'
    if ($Bytes.Length -ge 3 -and $Bytes[0] -eq 239 -and $Bytes[1] -eq 187 -and $Bytes[2] -eq 191) {
        $offset = 3
        $encodingName = 'UTF-8 with BOM'
    }
    try {
        $text = [Text.UTF8Encoding]::new($false, $true).GetString($Bytes, $offset, $Bytes.Length - $offset)
    }
    catch [Text.DecoderFallbackException] {
        if ($offset -ne 0) { throw (Get-AuditException 'UNSUPPORTED_ENCODING' 'The UTF-8 hostlist has invalid bytes; the original file is preserved.') }
        $text = [Text.Encoding]::GetEncoding(28591).GetString($Bytes)
        $encodingName = '8-bit; original bytes preserved'
    }
    if ($text.IndexOf([char]0) -ge 0) {
        throw (Get-AuditException 'UNSUPPORTED_ENCODING' 'The hostlist contains NUL bytes; the original file is preserved.')
    }
    return [pscustomobject]@{ Text = $text; Name = $encodingName }
}

function Get-DomainRule {
    param([AllowEmptyString()][string]$Text)
    foreach ($line in [regex]::Split($Text, '\r\n|\n|\r')) {
        $entry = $line.ToLowerInvariant()
        if (-not $entry -or $entry.StartsWith('#') -or $entry.StartsWith(';') -or $entry.StartsWith('/')) { continue }
        $strict = $entry.StartsWith('^')
        if ($strict) { $entry = $entry.Substring(1) }
        if ($entry.Length -gt 253 -or $entry -notmatch '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$') { continue }
        [pscustomobject]@{ Domain = $entry; Strict = $strict }
    }
}

function Test-FamilyCoverage {
    param([string]$Domain, [AllowEmptyCollection()][object[]]$Rules)
    foreach ($rule in $Rules) {
        if (-not $rule.Strict -and ($Domain -eq $rule.Domain -or $Domain.EndsWith('.' + $rule.Domain))) { return $true }
    }
    return $false
}

function Get-LagomBinding {
    Confirm-PlainPath $wrapperPath
    $serviceKey = Get-Item -LiteralPath 'Registry::HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Services\EgoistShieldZapret'
    $registeredWrapper = ([string]$serviceKey.GetValue('ImagePath')).Trim().Trim('"')
    if (-not [string]::Equals($registeredWrapper, $wrapperPath, [StringComparison]::OrdinalIgnoreCase) -or
        [string]$serviceKey.GetValue('EgoistShieldProfile') -ine $profileName -or
        [int]$serviceKey.GetValue('Type') -ne 16 -or
        [string]$serviceKey.GetValue('ObjectName') -notin @('LocalSystem', 'NT AUTHORITY\SYSTEM')) {
        throw (Get-AuditException 'OWNERSHIP_MISMATCH' 'The fixed Zapret service does not own the expected EGOIST MIX runtime.')
    }
    $definition = Read-BoundedFile $xmlPath
    $settings = [Xml.XmlReaderSettings]::new()
    $settings.DtdProcessing = [Xml.DtdProcessing]::Prohibit
    $settings.XmlResolver = $null
    $memory = [IO.MemoryStream]::new($definition.Bytes, $false)
    $reader = [Xml.XmlReader]::Create($memory, $settings)
    try {
        $document = [Xml.XmlDocument]::new()
        $document.XmlResolver = $null
        $document.Load($reader)
    }
    finally { $reader.Dispose(); $memory.Dispose() }
    $identifier = $document.SelectSingleNode('/service/id')
    $argumentNode = $document.SelectSingleNode('/service/arguments')
    if (-not $identifier -or $identifier.InnerText -ne 'EgoistShieldZapret' -or -not $argumentNode) {
        throw (Get-AuditException 'PROFILE_MISMATCH' 'The Zapret wrapper definition is not the owned EGOIST MIX definition.')
    }
    $generalBlocks = @([regex]::Split($argumentNode.InnerText, '\s+--new(?:\s+|$)') | Where-Object {
        $_ -match '--filter-(?:tcp=80,443|udp=443)(?:\s|$)' -and
        $_ -match ('--hostlist="?' + [regex]::Escape($targetPath) + '"?(?:\s|$)')
    })
    if ($generalBlocks.Count -ne 2 -or
        -not ($generalBlocks | Where-Object { $_ -match '--filter-tcp=80,443(?:\s|$)' }) -or
        -not ($generalBlocks | Where-Object { $_ -match '--filter-udp=443(?:\s|$)' })) {
        throw (Get-AuditException 'PROFILE_MISMATCH' 'The current profile must reference this user list for both TCP 80/443 and UDP 443.')
    }
    foreach ($block in $generalBlocks) {
        foreach ($excludePath in $excludePaths) {
            if ($block -notmatch ('--hostlist-exclude="?' + [regex]::Escape($excludePath) + '"?(?:\s|$)')) {
                throw (Get-AuditException 'EXCLUSION_MISMATCH' 'The current profile must retain both existing domain exclusion lists.')
            }
        }
    }
    return [pscustomobject]@{
        Hash = $definition.Hash
        ServiceRunning = (Get-Service -Name 'EgoistShieldZapret').Status -eq 'Running'
    }
}

try {
    if ($Apply) {
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
        try { $isAdministrator = [Security.Principal.WindowsPrincipal]::new($identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) }
        finally { $identity.Dispose() }
        if (-not $isAdministrator) { throw (Get-AuditException 'ADMIN_REQUIRED' 'Apply requires an administrator shell. No elevation or network change was attempted.') }
    }
    $binding = Get-LagomBinding
    $original = Read-BoundedFile $targetPath
    $security = Get-Acl -LiteralPath $targetPath
    $ownerSid = $security.GetOwner([Security.Principal.SecurityIdentifier]).Value
    if ($ownerSid -notin @('S-1-5-18', 'S-1-5-32-544')) {
        throw (Get-AuditException 'OWNERSHIP_MISMATCH' 'The fixed hostlist must be owned by SYSTEM or Administrators.')
    }
    $originalSddl = $security.Sddl
    $decoded = Get-HostlistText $original.Bytes
    $existingRules = @(Get-DomainRule $decoded.Text)
    $exclusions = @($excludePaths | ForEach-Object { Read-BoundedFile $_ })
    $excludedRules = @($exclusions | ForEach-Object { Get-DomainRule (Get-HostlistText $_.Bytes).Text })
    $excludedFamilies = @($socialDomains | Where-Object { Test-FamilyCoverage $_ $excludedRules })
    $partialExclusions = @($socialDomains | Where-Object {
        $family = $_
        -not (Test-FamilyCoverage $family $excludedRules) -and @($excludedRules | Where-Object {
            $_.Domain -eq $family -or $_.Domain.EndsWith('.' + $family)
        }).Count -gt 0
    })
    $additions = @($socialDomains | Where-Object {
        -not (Test-FamilyCoverage $_ $existingRules) -and -not (Test-FamilyCoverage $_ $excludedRules)
    })
    $newlineMatch = [regex]::Match($decoded.Text, '\r\n|\n|\r')
    $newline = if ($newlineMatch.Success) { $newlineMatch.Value } else { "`r`n" }
    $tail = ''
    if ($additions.Count -gt 0) {
        if ($decoded.Text.Length -gt 0 -and -not $decoded.Text.EndsWith("`r") -and -not $decoded.Text.EndsWith("`n")) { $tail = $newline }
        $tail += ($additions -join $newline) + $newline
    }
    $tailBytes = [Text.Encoding]::ASCII.GetBytes($tail)
    if ($original.Bytes.Length + $tailBytes.Length -gt $maximumBytes) {
        throw (Get-AuditException 'FILE_TOO_LARGE' 'The merged hostlist would exceed the one MiB limit.')
    }
    $mergedBytes = [byte[]]::new($original.Bytes.Length + $tailBytes.Length)
    [Array]::Copy($original.Bytes, 0, $mergedBytes, 0, $original.Bytes.Length)
    [Array]::Copy($tailBytes, 0, $mergedBytes, $original.Bytes.Length, $tailBytes.Length)
    $expectedHash = Get-BytesHash $mergedBytes
    $result = [ordered]@{
        schemaVersion = 1
        status = 'plan'
        target = $targetPath
        profile = $profileName
        serviceRunning = $binding.ServiceRunning
        encoding = $decoded.Name
        originalBytes = $original.Bytes.Length
        plannedBytes = $mergedBytes.Length
        domainsToAdd = $additions
        excludedFamilies = $excludedFamilies
        partiallyExcludedFamilies = $partialExclusions
        sha256Before = $original.Hash
        sha256Expected = $expectedHash
        restartRequired = $false
        activation = 'Zapret checks hostlist mtime/size on subsequent hostlist decisions; verify new connections.'
        mayHaveApplied = $false
    }
    if ($Apply -and $additions.Count -gt 0) {
        $temporaryPath = Join-Path $listsRoot ('list-general-user.txt.relay-social-' + [Guid]::NewGuid().ToString('N') + '.tmp')
        Confirm-PlainPath $listsRoot
        $stream = [IO.File]::Open($temporaryPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try { $stream.Write($mergedBytes, 0, $mergedBytes.Length); $stream.Flush($true) }
        finally { $stream.Dispose() }
        $currentBinding = Get-LagomBinding
        if ($currentBinding.Hash -ne $binding.Hash) { throw (Get-AuditException 'CONCURRENT_CHANGE' 'The active profile changed after planning; no replacement was attempted.') }
        foreach ($exclusion in $exclusions) {
            Confirm-FileSnapshot $exclusion
        }
        if ((Get-Acl -LiteralPath $targetPath).Sddl -ne $originalSddl) {
            throw (Get-AuditException 'CONCURRENT_CHANGE' 'The hostlist or its security changed after planning; no replacement was attempted.')
        }
        Confirm-FileSnapshot $original
        Confirm-PlainPath $temporaryPath
        $mayHaveApplied = $true
        [IO.File]::Replace($temporaryPath, $targetPath, [NullString]::Value, $false)
        $readback = Read-BoundedFile $targetPath
        if ($readback.Hash -ne $expectedHash -or (Get-Acl -LiteralPath $targetPath).Sddl -ne $originalSddl) {
            throw (Get-AuditException 'READBACK_FAILED' 'Replacement completed but content/security readback differs; inspect before any retry.')
        }
        $result.status = 'applied'
        $result.mayHaveApplied = $true
    }
    elseif ($Apply) { $result.status = 'unchanged' }
}
catch {
    $exitCode = 1
    $code = $_.Exception.Data['AuditCode']
    $message = if ($code) { $_.Exception.Message } else { 'The bounded file operation failed. No service, DNS, proxy, VPN or ACL mutation was requested.' }
    $result = [ordered]@{
        schemaVersion = 1; status = 'error'; code = $(if ($code) { [string]$code } else { 'OPERATION_FAILED' })
        message = $message; target = $targetPath; mayHaveApplied = $mayHaveApplied
    }
}
finally {
    if ($temporaryPath -and [IO.File]::Exists($temporaryPath)) {
        try { Confirm-PlainPath $temporaryPath; [IO.File]::Delete($temporaryPath) }
        catch {
            $exitCode = 1
            $result['cleanupPending'] = $true
        }
    }
}
$result | ConvertTo-Json -Depth 4 -Compress
exit $exitCode
