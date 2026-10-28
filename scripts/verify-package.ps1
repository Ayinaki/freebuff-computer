# Run after npm run build. This checks an actual tarball, never publishes it.
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
Push-Location $repo
$originalPath = $env:Path
try {
    $packed = npm pack --ignore-scripts --json
    if ($LASTEXITCODE -ne 0) { throw "npm pack exited $LASTEXITCODE" }
    $package = $packed | ConvertFrom-Json
    $archive = Join-Path $repo $package[0].filename
    $installDir = Join-Path ([IO.Path]::GetTempPath()) ('fbc-package-' + [Guid]::NewGuid().ToString('N'))
    # Package users must not need the compiler used by source builds.
    $env:Path = (($originalPath -split ';') | Where-Object {
        $_ -and !(Test-Path -LiteralPath (Join-Path $_ 'go.exe'))
    }) -join ';'
    if (Get-Command go -ErrorAction SilentlyContinue) { throw 'Go is still available; no-Go installation check is invalid' }
    # Not --offline: npm does not cache registry metadata, so an offline install
    # cannot resolve a dependency range even on a warm cache. What this check
    # actually proves is that the tarball already contains everything it needs
    # (dist, native sources, both drivers) and that no consumer needs Go or a
    # build step. --ignore-scripts enforces that: nothing may be compiled at
    # install time.
    npm install --prefix $installDir $archive --ignore-scripts --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw "npm install exited $LASTEXITCODE" }
    $installed = Join-Path $installDir 'node_modules/freebuff-computer'
    foreach ($relative in @('native/Overlay.cs','native/overlay.ps1','dist/server.js','dist/overlay.js','dist/native/win32-x64/open-computer-use.exe','dist/native/win32-arm64/open-computer-use.exe')) {
        $sourceHash = (Get-FileHash -LiteralPath (Join-Path $repo $relative) -Algorithm SHA256).Hash
        $installedHash = (Get-FileHash -LiteralPath (Join-Path $installed $relative) -Algorithm SHA256).Hash
        if ($sourceHash -ne $installedHash) { throw "Packaged asset differs: $relative" }
    }
    node scripts/verify-installed.mjs $installed
    if ($LASTEXITCODE -ne 0) { throw "Installed MCP verification exited $LASTEXITCODE" }
    Write-Output "PASS: tarball install without Go or install-time build; packaged assets match; installed MCP verification passed"
    Write-Output "Archive: $archive"
    Write-Output "Installed: $installed"
} finally {
    $env:Path = $originalPath
    Pop-Location
}
