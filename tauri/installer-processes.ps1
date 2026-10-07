param(
    [string]$InstallDirectory = $env:EGOIST_RELAY_INSTALL_DIRECTORY,
    [int]$InstallerProcessId = $env:EGOIST_RELAY_INSTALLER_PID,
    [switch]$RemoveLegacyNetworkRuntime,
    [string]$LegacyRuntimeManifestPath
)

$ErrorActionPreference = 'Stop'
$env:PSModulePath = [IO.Path]::Combine($PSHOME, 'Modules')

function Assert-RegularPathChain([string]$Path) {
    $currentPath = $Path
    while (-not [string]::IsNullOrWhiteSpace($currentPath)) {
        if (Test-Path -LiteralPath $currentPath) {
            $currentItem = Get-Item -LiteralPath $currentPath -Force -ErrorAction Stop
            if (($currentItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw 'RELAY_UNSAFE_INSTALLATION_PATH: Reparse points are not supported for legacy runtime cleanup.'
            }
        }
        $parentPath = [IO.Path]::GetDirectoryName($currentPath)
        if ($parentPath -eq $currentPath) { break }
        $currentPath = $parentPath
    }
}

function Remove-ReviewedLegacyRuntime([string]$InstallationPath, [string]$ManifestPath) {
    if ([string]::IsNullOrWhiteSpace($ManifestPath) -or -not [IO.Path]::IsPathRooted($ManifestPath)) {
        throw 'An absolute legacy runtime manifest path is required.'
    }
    Assert-RegularPathChain $InstallationPath
    Assert-RegularPathChain $ManifestPath
    $manifest = Get-Content -LiteralPath $ManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($manifest.schemaVersion -ne 1 -or -not $manifest.files -or $manifest.files.Count -gt 128) {
        throw 'Invalid legacy runtime manifest.'
    }
    $runtimeBoundary = [IO.Path]::Combine($InstallationPath, 'runtime').TrimEnd('\') + '\'
    $seenPaths = @{}
    $candidates = @()
    $preservedLongPaths = 0
    foreach ($entry in $manifest.files) {
        $relative = [string]$entry.path
        $allowedFile = $relative -cmatch '^runtime/(?:xray(?:\.exe|-provenance\.json)|ciadpi\.exe|egoist-tg-proxy\.exe|licenses/(?:(?:XRAY(?:-GO)?|BYEDPI|WS)-LICENSE\.txt|xray-dependencies/.+))$'
        if (-not $allowedFile -or $relative.Contains('\') -or $relative -match '(?:^|/)\.{1,2}(?:/|$)' -or
            $relative.Contains(':') -or $seenPaths.ContainsKey($relative) -or
            [string]$entry.sha256 -cnotmatch '^[a-f0-9]{64}$' -or [long]$entry.bytes -le 0) {
            throw 'Invalid legacy runtime entry.'
        }
        $seenPaths[$relative] = $true
        $candidatePath = [IO.Path]::GetFullPath([IO.Path]::Combine($InstallationPath, $relative.Replace('/', '\')))
        if (-not $candidatePath.StartsWith($runtimeBoundary, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Legacy runtime entry escapes the selected installation.'
        }
        if ($candidatePath.Length -ge 260) {
            $preservedLongPaths += 1
            continue
        }
        Assert-RegularPathChain $candidatePath
        if (Test-Path -LiteralPath $candidatePath) {
            $item = Get-Item -LiteralPath $candidatePath -Force -ErrorAction Stop
            if ($item.PSIsContainer) { throw 'Legacy runtime entry is not a regular file.' }
            $candidates += [PSCustomObject]@{ Path = $candidatePath; Bytes = [long]$entry.bytes; Sha256 = [string]$entry.sha256 }
        }
    }
    $removed = 0
    $preserved = 0
    foreach ($candidate in $candidates) {
        Assert-RegularPathChain $candidate.Path
        $item = Get-Item -LiteralPath $candidate.Path -Force -ErrorAction Stop
        if ($item.Length -ne $candidate.Bytes -or
            (Get-FileHash -LiteralPath $candidate.Path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $candidate.Sha256) {
            $preserved += 1
            continue
        }
        Remove-Item -LiteralPath $candidate.Path -Force -ErrorAction Stop
        $removed += 1
    }
    [Console]::WriteLine("RELAY_LEGACY_RUNTIME: removed=$removed preserved_modified=$preserved preserved_unreachable_paths=$preservedLongPaths")
}

try {
    if ([string]::IsNullOrWhiteSpace($InstallDirectory) -or -not [IO.Path]::IsPathRooted($InstallDirectory)) {
        throw 'An absolute installation directory is required.'
    }

    $installationPath = [IO.Path]::GetFullPath($InstallDirectory).TrimEnd('\')
    if ($installationPath -eq [IO.Path]::GetPathRoot($installationPath).TrimEnd('\')) {
        throw 'The drive root cannot be an installation directory.'
    }
    if ($RemoveLegacyNetworkRuntime) {
        Remove-ReviewedLegacyRuntime $installationPath $LegacyRuntimeManifestPath
        exit 0
    }

    $executablePaths = @(
        [IO.Path]::Combine($installationPath, 'Egoist Relay.exe'),
        [IO.Path]::Combine($installationPath, 'runtime', 'node.exe'),
        [IO.Path]::Combine($installationPath, 'runtime', 'yt-dlp.exe'),
        [IO.Path]::Combine($installationPath, 'runtime', 'media', 'ffmpeg.exe'),
        [IO.Path]::Combine($installationPath, 'runtime', 'media', 'ffprobe.exe'),
        [IO.Path]::Combine($installationPath, 'runtime', 'transcription', 'whisper-cli.exe')
    )

    $installationProcesses = @(Get-Process -ErrorAction Stop | Where-Object {
        $_.Id -ne $PID -and $_.Id -ne $InstallerProcessId -and
        $_.Path -and $executablePaths -contains $_.Path
    })
    $appExecutable = [IO.Path]::Combine($installationPath, 'Egoist Relay.exe')
    if ($installationProcesses | Where-Object { $_.Path -eq $appExecutable }) {
        [Console]::Error.WriteLine('RELAY_EXIT_REQUIRED: Exit Egoist Relay from its tray menu and retry. The active application was not stopped.')
        exit 2
    }

    foreach ($installationProcess in $installationProcesses) {
        if ($installationProcess.Id -eq $PID -or $installationProcess.Id -eq $InstallerProcessId) {
            continue
        }
        $executablePath = $installationProcess.Path
        if (-not $executablePath -or $executablePaths -notcontains $executablePath) {
            continue
        }
        $currentProcess = Get-Process -Id $installationProcess.Id -ErrorAction SilentlyContinue
        if (-not $currentProcess -or $currentProcess.StartTime -ne $installationProcess.StartTime -or
            $currentProcess.Path -ne $executablePath) {
            continue
        }
        Stop-Process -Id $installationProcess.Id -Force -ErrorAction Stop
        if (-not $installationProcess.WaitForExit(5000)) {
            throw "The installation process did not exit: $($installationProcess.Id)"
        }
    }
    exit 0
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
