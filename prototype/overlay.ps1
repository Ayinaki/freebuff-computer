# Freebuff Computer -- visibility overlay prototype.
#
# A transparent, click-through, always-on-top window spanning the whole virtual
# desktop. It watches a small JSON file describing the current target and draws a
# highlight rectangle plus an animated synthetic cursor at that target.
#
# Why the file watch: this prototype exists to answer one question -- does a
# click-through overlay actually render correctly on this machine, over real app
# windows? Polling a file keeps the drawing code free of IPC and threading
# complexity so a failure here is a rendering failure, not a plumbing one. A real
# implementation replaces the file with a push channel (named pipe or loopback
# socket) fed by the MCP server.
#
# Usage:
#   powershell -STA -NoProfile -File overlay.ps1 -WatchFile <path> [-DurationSec 20]
#
# The watch file is JSON: { "x": 100, "y": 200, "w": 300, "h": 40, "label": "click" }

param(
  [Parameter(Mandatory = $true)][string]$WatchFile,
  [int]$DurationSec = 30,
  [int]$CursorTravelMs = 380,
  [string]$Accent = '#3B82F6'
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase
Add-Type -AssemblyName System.Windows.Forms, System.Drawing

# Win32 helpers: make the window click-through and out of the alt-tab list.
if (-not ('FbcWin32' -as [type])) {
  Add-Type -Namespace '' -Name 'FbcWin32' -MemberDefinition @'
[DllImport("user32.dll", SetLastError=true)] public static extern int GetWindowLong(System.IntPtr hWnd, int nIndex);
[DllImport("user32.dll", SetLastError=true)] public static extern int SetWindowLong(System.IntPtr hWnd, int nIndex, int dwNewLong);
[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
'@
}

# Physical pixels please: the driver reports element frames in physical screen
# coordinates, so the overlay must not be rescaled by the OS.
[void][FbcWin32]::SetProcessDPIAware()

# ---- window ----------------------------------------------------------------
$vs = [System.Windows.Forms.SystemInformation]::VirtualScreen

$window = New-Object System.Windows.Window
$window.WindowStyle      = 'None'
$window.AllowsTransparency = $true
$window.Background       = [System.Windows.Media.Brushes]::Transparent
$window.Topmost          = $true
$window.ShowInTaskbar    = $false
$window.ResizeMode       = 'NoResize'
$window.IsHitTestVisible = $false
# Never take activation: the whole point is that the user keeps working.
$window.ShowActivated    = $false
$window.Left   = $vs.Left
$window.Top    = $vs.Top
$window.Width  = $vs.Width
$window.Height = $vs.Height

$root = New-Object System.Windows.Controls.Canvas
$root.Background = [System.Windows.Media.Brushes]::Transparent
$window.Content = $root

$brush = New-Object System.Windows.Media.SolidColorBrush(
  [System.Windows.Media.ColorConverter]::ConvertFromString($Accent))
$brush.Opacity = 0.9
$fillBrush = New-Object System.Windows.Media.SolidColorBrush(
  [System.Windows.Media.ColorConverter]::ConvertFromString($Accent))
$fillBrush.Opacity = 0.16

# Highlight rectangle
$rect = New-Object System.Windows.Shapes.Rectangle
$rect.Stroke = $brush
$rect.StrokeThickness = 3
$rect.Fill = $fillBrush
$rect.RadiusX = 4; $rect.RadiusY = 4
$rect.Visibility = 'Collapsed'
$root.Children.Add($rect) | Out-Null

# Synthetic cursor: a filled dot with a ring, drawn at the pointer we are NOT moving.
$ring = New-Object System.Windows.Shapes.Ellipse
$ring.Width = 26; $ring.Height = 26
$ring.Stroke = $brush; $ring.StrokeThickness = 2
$ring.Fill = [System.Windows.Media.Brushes]::Transparent
$ring.Visibility = 'Collapsed'
$root.Children.Add($ring) | Out-Null

$dot = New-Object System.Windows.Shapes.Ellipse
$dot.Width = 9; $dot.Height = 9
$dot.Fill = $brush
$dot.Visibility = 'Collapsed'
$root.Children.Add($dot) | Out-Null

# Label chip
$border = New-Object System.Windows.Controls.Border
$border.Background = New-Object System.Windows.Media.SolidColorBrush(
  [System.Windows.Media.Color]::FromArgb(235, 17, 24, 39))
$border.BorderBrush = $brush
$border.BorderThickness = New-Object System.Windows.Thickness(1)
$border.CornerRadius = New-Object System.Windows.CornerRadius(6)
$border.Padding = New-Object System.Windows.Thickness(8, 3, 8, 3)
$border.Visibility = 'Collapsed'
$label = New-Object System.Windows.Controls.TextBlock
$label.Foreground = [System.Windows.Media.Brushes]::White
$label.FontFamily = New-Object System.Windows.Media.FontFamily('Segoe UI')
$label.FontSize = 12
$border.Child = $label
$root.Children.Add($border) | Out-Null

# ---- state machine ---------------------------------------------------------
# Canvas coordinates are window-relative; the window covers the virtual screen,
# so subtract its origin.
$originX = $vs.Left
$originY = $vs.Top

$script:curX = $vs.Width / 2
$script:curY = $vs.Height / 2
$script:target = $null
$script:anim = $null
$script:won = $false
$script:started = Get-Date
$script:lastStamp = ''

function Set-Position([double]$x, [double]$y) {
  $cx = $x - $originX; $cy = $y - $originY
  [System.Windows.Controls.Canvas]::SetLeft($ring, $cx - 13)
  [System.Windows.Controls.Canvas]::SetTop($ring, $cy - 13)
  [System.Windows.Controls.Canvas]::SetLeft($dot, $cx - 4.5)
  [System.Windows.Controls.Canvas]::SetTop($dot, $cy - 4.5)
}

# Apply a new target: draw the box immediately and animate the cursor to its centre.
function Apply-Target($t) {
  $w = [double]$t.w; $h = [double]$t.h
  if ($w -le 0 -or $h -le 0) { return }
  [System.Windows.Controls.Canvas]::SetLeft($rect, ([double]$t.x - $originX))
  [System.Windows.Controls.Canvas]::SetTop($rect, ([double]$t.y - $originY))
  $rect.Width = $w; $rect.Height = $h
  $rect.Visibility = 'Visible'

  if ($t.label) {
    $label.Text = [string]$t.label
    $border.Visibility = 'Visible'
    $border.Measure((New-Object System.Windows.Size([double]::PositiveInfinity, [double]::PositiveInfinity)))
    $bw = $border.DesiredSize.Width
    $bh = $border.DesiredSize.Height
    $bx = [double]$t.x - $originX
    $by = [double]$t.y - $originY - $bh - 8
    if ($by -lt 0) { $by = [double]$t.y - $originY + $h + 8 }
    [System.Windows.Controls.Canvas]::SetLeft($border, $bx)
    [System.Windows.Controls.Canvas]::SetTop($border, $by)
  }

  $ring.Visibility = 'Visible'
  $dot.Visibility = 'Visible'

  $fromX = $script:curX; $fromY = $script:curY
  $toX = [double]$t.x + $w / 2; $toY = [double]$t.y + $h / 2
  $script:anim = @{ fromX = $fromX; fromY = $fromY; toX = $toX; toY = $toY; t0 = (Get-Date) }
}

# ~60 Hz tick: advance the cursor animation, poll the watch file, and stop on timeout.
$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds(16)
$timer.Add_Tick({
  if ($script:anim) {
    $elapsed = ((Get-Date) - $script:anim.t0).TotalMilliseconds
    $p = [Math]::Min(1.0, $elapsed / $CursorTravelMs)
    $e = 1 - [Math]::Pow(1 - $p, 3)   # ease-out cubic
    $x = $script:anim.fromX + ($script:anim.toX - $script:anim.fromX) * $e
    $y = $script:anim.fromY + ($script:anim.toY - $script:anim.fromY) * $e
    $script:curX = $x; $script:curY = $y
    Set-Position $x $y
    if ($p -ge 1.0) { $script:anim = $null }
  }

  try {
    if (Test-Path -LiteralPath $WatchFile) {
      $raw = Get-Content -LiteralPath $WatchFile -Raw -ErrorAction SilentlyContinue
      if ($raw -and $raw.Trim()) {
        $t = $raw | ConvertFrom-Json
        $stamp = "$($t.x)|$($t.y)|$($t.w)|$($t.h)|$($t.label)|$($t.seq)"
        if ($stamp -ne $script:lastStamp) {
          $script:lastStamp = $stamp
          if ($t.clear) {
            $rect.Visibility = 'Collapsed'; $ring.Visibility = 'Collapsed'
            $dot.Visibility = 'Collapsed'; $border.Visibility = 'Collapsed'
          } else {
            Apply-Target $t
          }
        }
      }
    }
  } catch { }

  if (((Get-Date) - $script:started).TotalSeconds -ge $DurationSec) {
    $timer.Stop(); $window.Close()
  }
})

$window.Add_Loaded({
  $hwnd = (New-Object System.Windows.Interop.WindowInteropHelper($window)).Handle
  # WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW
  # LAYERED gives per-pixel alpha; TRANSPARENT is what makes it click-through, so
  # the user can keep working in the app underneath.
  # WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE
  $GWLEXSTYLE = -20
  $ex = [FbcWin32]::GetWindowLong($hwnd, $GWLEXSTYLE)
  [void][FbcWin32]::SetWindowLong($hwnd, $GWLEXSTYLE, $ex -bor 0x80000 -bor 0x20 -bor 0x80 -bor 0x08000000)
  # Publish the handle so a verifier can confirm the click-through bit really is set.
  try { Set-Content -LiteralPath "$WatchFile.hwnd" -Value $hwnd -NoNewline } catch { }
  $timer.Start()
})

Set-Position $script:curX $script:curY
[void]$window.ShowDialog()
