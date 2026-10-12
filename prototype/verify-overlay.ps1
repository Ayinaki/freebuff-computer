# Prove the overlay really works, rather than assuming it does.
#
# Three claims to check:
#   1. It renders -- accent-coloured pixels appear along the target rectangle's edge.
#   2. It is transparent -- pixels inside the box, away from the edge, are NOT
#      accent-coloured, so the app underneath is still visible.
#   3. It is click-through -- WS_EX_TRANSPARENT is actually set on the window.
#
# Usage: powershell -STA -NoProfile -File verify-overlay.ps1
#        powershell -STA -NoProfile -File verify-overlay.ps1 -App Vivaldi -Element 13
#
# With -App/-Element the target is a real element of a live app, taken from the
# same snapshot the agent would act on, instead of a synthetic test rectangle.

param(
  [string]$App = '',
  [int]$Element = -1
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing

if (-not ('FbcVerify' -as [type])) {
  Add-Type -Namespace '' -Name 'FbcVerify' -MemberDefinition @'
[DllImport("user32.dll", SetLastError=true)] public static extern int GetWindowLong(System.IntPtr hWnd, int nIndex);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(System.IntPtr hWnd);
[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();
'@
}

$dir = Join-Path $env:TEMP ("fbc-overlay-verify-" + [Guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $dir | Out-Null
$watch = Join-Path $dir 'target.json'
$hwndFile = "$watch.hwnd"
$logPath = Join-Path $dir 'overlay.log'
$overlayScript = Join-Path $PSScriptRoot 'overlay.ps1'

$vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
if ($App) {
  # Ask the same parser the demo uses, so the rect under test is the real one.
  $json = & node (Join-Path $PSScriptRoot 'frames.mjs') $App --element $Element --json 2>$null
  $obj = ($json | Out-String).Trim() | ConvertFrom-Json
  if ($obj -is [array]) { $obj = $obj[0] }
  if (-not $obj) { Write-Host "FAIL  could not resolve $App element $Element"; exit 1 }
  $tx = [int]$obj.x; $ty = [int]$obj.y; $tw = [int]$obj.w; $th = [int]$obj.h
  Write-Host "target      real element from $App`: [$($obj.index)] $($obj.role) `"$($obj.name)`""
} else {
  # A deliberately out-of-the-way target so the check does not depend on what is
  # currently on screen: a box on the empty lower-right area of the desktop.
  $tx = [int]($vs.Width * 0.62)
  $ty = [int]($vs.Height * 0.66)
  $tw = 420
  $th = 130
}
$accent = [System.Drawing.Color]::FromArgb(59, 130, 246)   # #3B82F6

Set-Content -LiteralPath $watch -Value (@{ x = $tx; y = $ty; w = $tw; h = $th; label = 'verify: click element' } | ConvertTo-Json -Compress)

Write-Host "overlay     launching (target $tx,$ty ${tw}x${th} on a $($vs.Width)x$($vs.Height) virtual screen)"
$fgBefore = [FbcVerify]::GetForegroundWindow()
$proc = Start-Process -FilePath 'powershell' -ArgumentList @(
  '-STA', '-NoProfile', '-File', "`"$overlayScript`"",
  '-WatchFile', "`"$watch`"",
  '-DurationSec', '12'
) -PassThru -WindowStyle Hidden `
  -RedirectStandardOutput $logPath -RedirectStandardError "$logPath.err"

# Wait for the handle file to appear (the window is up once it is written).
$hwnd = $null
for ($i = 0; $i -lt 100; $i++) {
  Start-Sleep -Milliseconds 100
  if (Test-Path -LiteralPath $hwndFile) {
    $candidate = (Get-Content -LiteralPath $hwndFile -Raw).Trim()
    if ($candidate) { $hwnd = [int64]$candidate; break }
  }
  if ($proc.HasExited) { break }
}
# Let the cursor animation settle before sampling.
Start-Sleep -Milliseconds 900

$failures = @()
$results = @()

# ---- 3. click-through style bits -------------------------------------------
if (-not $hwnd) {
  $failures += 'overlay never published a window handle (it failed to start)'
} else {
  $GWLEXSTYLE = -20
  $ex = [FbcVerify]::GetWindowLong([IntPtr]$hwnd, $GWLEXSTYLE)
  $visible = [FbcVerify]::IsWindowVisible([IntPtr]$hwnd)
  $isTransparent = ($ex -band 0x20) -ne 0     # WS_EX_TRANSPARENT -> click-through
  $isLayered = ($ex -band 0x80000) -ne 0      # WS_EX_LAYERED -> per-pixel alpha
  $isTool = ($ex -band 0x80) -ne 0            # WS_EX_TOOLWINDOW -> not in alt-tab
  $isNoActivate = ($ex -band 0x08000000) -ne 0 # WS_EX_NOACTIVATE -> never takes focus
  $results += "window      hwnd=$hwnd visible=$visible exstyle=0x$('{0:X}' -f $ex)"
  $results += "            click-through(WS_EX_TRANSPARENT)=$isTransparent layered=$isLayered toolwindow=$isTool noactivate=$isNoActivate"
  if (-not $visible) { $failures += 'overlay window is not visible' }
  if (-not $isTransparent) { $failures += 'WS_EX_TRANSPARENT is not set, so the overlay would swallow clicks' }
  if (-not $isLayered) { $failures += 'WS_EX_LAYERED is not set, so transparency would not work' }
  if (-not $isNoActivate) { $failures += 'WS_EX_NOACTIVATE is not set, so showing the overlay can steal focus' }

  # The claim that matters most: the user can keep working. Measured, not assumed.
  $fgAfter = [FbcVerify]::GetForegroundWindow()
  $kept = ($fgAfter -eq $fgBefore)
  $results += "focus       foreground before=$fgBefore after=$fgAfter  unchanged=$kept"
  if (-not $kept) { $failures += "showing the overlay changed the foreground window ($fgBefore -> $fgAfter)" }
}

# ---- 1 & 2. render + transparency, by sampling the actual screen ------------
function Near($c, $t, $tol) {
  ([Math]::Abs($c.R - $t.R) -le $tol) -and ([Math]::Abs($c.G - $t.G) -le $tol) -and ([Math]::Abs($c.B - $t.B) -le $tol)
}

# Cursor: the dot+ring is drawn at the centre of the target once the travel
# animation settles, and nothing else on screen should be accent-coloured there.
$curCentre = @{ x = $tx + [int]($tw / 2); y = $ty + [int]($th / 2) }

$bmp = New-Object System.Drawing.Bitmap($vs.Width, $vs.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($vs.Left, $vs.Top, 0, 0, $bmp.Size)

# Top edge of the box: sample a band around it and look for the accent colour.
$edgeHits = 0
foreach ($dx in 40, 120, 210, 300, 380, [int]($tw - 40)) {
  foreach ($dy in -3, -2, -1, 0, 1, 2, 3) {
    $px = $tx + $dx - $vs.Left
    $py = $ty + $dy - $vs.Top
    if ($px -lt 0 -or $py -lt 0 -or $px -ge $vs.Width -or $py -ge $vs.Height) { continue }
    if (Near $bmp.GetPixel($px, $py) $accent 40) { $edgeHits++ }
  }
}

# Deep inside the box: the fill is only ~16% opaque, so it must NOT read as accent.
$insideHits = 0
$insideSamples = 0
foreach ($dx in 60, 200, 340) {
  foreach ($dy in 30, 65, 100) {
    $px = $tx + $dx - $vs.Left
    $py = $ty + $dy - $vs.Top
    if ($px -lt 0 -or $py -lt 0 -or $px -ge $vs.Width -or $py -ge $vs.Height) { continue }
    $insideSamples++
    if (Near $bmp.GetPixel($px, $py) $accent 25) { $insideHits++ }
  }
}

$cursorHits = 0
for ($dx = -14; $dx -le 14; $dx++) {
  for ($dy = -14; $dy -le 14; $dy++) {
    if (($dx * $dx + $dy * $dy) -gt 196) { continue }
    $px = $curCentre.x + $dx - $vs.Left; $py = $curCentre.y + $dy - $vs.Top
    if ($px -lt 0 -or $py -lt 0 -or $px -ge $vs.Width -or $py -ge $vs.Height) { continue }
    if (Near $bmp.GetPixel($px, $py) $accent 40) { $cursorHits++ }
  }
}

$bmp.Dispose(); $g.Dispose()
$results += "render      accent pixels found in a 7px band on the top edge: $edgeHits"
$results += "cursor      accent pixels within 14px of the target centre: $cursorHits"
if ($cursorHits -lt 4) { $failures += "synthetic cursor did not render at the target centre ($cursorHits accent pixels)" }
$results += "transparent $insideHits of $insideSamples interior samples read as solid accent (want 0)"
if ($edgeHits -lt 3) {
  $failures += "overlay did not render: only $edgeHits accent pixels on the target's top edge"
}
if ($insideHits -gt 0) {
  $failures += "box interior is opaque: $insideHits interior samples read as solid accent"
}

# ---- report ----------------------------------------------------------------
$results | ForEach-Object { Write-Host $_ }
if (Test-Path -LiteralPath $logPath) {
  $err = Get-Content -LiteralPath $logPath -Raw -ErrorAction SilentlyContinue
  if ($err -and $err.Trim()) { Write-Host "overlay-stdout`n$err" }
}
if (Test-Path -LiteralPath "$logPath.err") {
  $err = Get-Content -LiteralPath "$logPath.err" -Raw -ErrorAction SilentlyContinue
  if ($err -and $err.Trim()) { Write-Host "overlay-stderr`n$err" }
}

try { if ($proc -and -not $proc.HasExited) { $proc.Kill() } } catch { }
Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue

if ($failures.Count -gt 0) {
  Write-Host ''
  foreach ($f in $failures) { Write-Host "FAIL  $f" }
  exit 1
}
Write-Host ''
Write-Host 'PASS  overlay renders, stays transparent, and is click-through'
exit 0
