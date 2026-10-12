$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing,System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class OverlayProbe {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int x,y; }
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT point);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr window,int index);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr window,int message,IntPtr wp,IntPtr lp);
  [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr window);
  [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr window,IntPtr dc);
  [DllImport("gdi32.dll")] public static extern uint GetPixel(IntPtr dc,int x,int y);
}
'@
[void][OverlayProbe]::SetThreadDpiAwarenessContext([IntPtr](-4))
$request = $env:FBC_OVERLAY_VERIFICATION | ConvertFrom-Json
if ($request.rebuildWindow) {
  # Notify only our renderer. This does not alter the user's display configuration.
  if (-not [OverlayProbe]::PostMessage([IntPtr]([long]$request.rebuildWindow),0x7E,[IntPtr]::Zero,[IntPtr]::Zero)) {
    throw 'Could not post the display-change notification to the test overlay'
  }
}
$screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$rect = if ($request.rect) { $request.rect } else { @{x=$screen.X+200;y=$screen.Y+200;width=420;height=140} }
$dc = [OverlayProbe]::GetDC([IntPtr]::Zero)
function Is-Accent([int]$x,[int]$y) {
  $c = [OverlayProbe]::GetPixel($dc,$x,$y)
  $r = $c -band 255; $g = ($c -shr 8) -band 255; $b = ($c -shr 16) -band 255
  return ([Math]::Abs($r-59) -lt 35 -and [Math]::Abs($g-130) -lt 35 -and [Math]::Abs($b-246) -lt 35)
}
function Cursor-Pixel([int]$x,[int]$y) {
  $c = [OverlayProbe]::GetPixel($dc,$x,$y)
  $r = $c -band 255; $g = ($c -shr 8) -band 255; $b = ($c -shr 16) -band 255
  if ([Math]::Abs($r-26) -le 3 -and [Math]::Abs($g-29) -le 3 -and [Math]::Abs($b-34) -le 3) { return 'dark' }
  if ($r -ge 240 -and $g -ge 240 -and $b -ge 240) { return 'white' }
  return 'other'
}
try {
  $edge = 0; $cursor = 0; $white = 0; $interior = 0
  foreach ($dx in 40,100,160,280,340,380) {
    foreach ($dy in -3,-2,-1,0,1,2,3) { if (Is-Accent ($rect.x+$dx) ($rect.y+$dy)) { $edge++ } }
  }
  for ($dx=0;$dx -lt 28;$dx++) {
    for ($dy=0;$dy -lt 35;$dy++) {
      $pixel=Cursor-Pixel ($rect.x+$rect.width/2+$dx) ($rect.y+$rect.height/2+$dy)
      if ($pixel -eq 'dark') { $cursor++ }
      if ($pixel -eq 'white') { $white++ }
    }
  }
  foreach ($dx in 60,120,340) {
    foreach ($dy in 30,65,110) { if (Is-Accent ($rect.x+$dx) ($rect.y+$dy)) { $interior++ } }
  }
  $windows = @()
  foreach ($window in $request.windows) {
    $handle = [IntPtr]([long]$window.hwnd)
    $border = 0
    for ($dy=0;$dy -le 6;$dy++) { if (Is-Accent ($window.x+$window.width/2) ($window.y+$dy)) { $border++ } }
    $windows += @{ hwnd=$window.hwnd;exists=[OverlayProbe]::IsWindow($handle);visible=[OverlayProbe]::IsWindowVisible($handle);style=[OverlayProbe]::GetWindowLong($handle,-20);borderHits=$border }
  }
  $position = New-Object OverlayProbe+POINT
  [void][OverlayProbe]::GetCursorPos([ref]$position)
  @{foreground=[OverlayProbe]::GetForegroundWindow().ToInt64().ToString();cursor=@{x=$position.x;y=$position.y};rect=$rect;edgeHits=$edge;cursorHits=$cursor;whiteHits=$white;interiorHits=$interior;windows=$windows} | ConvertTo-Json -Depth 5 -Compress
} finally { [void][OverlayProbe]::ReleaseDC([IntPtr]::Zero,$dc) }
