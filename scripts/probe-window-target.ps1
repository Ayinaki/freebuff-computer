# Independent read-only UIA / Win32 measurement for the live driver mapping check.
$ErrorActionPreference='Stop'
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes,WindowsBase
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class TargetProbe {
  [StructLayout(LayoutKind.Sequential)] public struct R { public int left,top,right,bottom; }
  public delegate bool Callback(IntPtr window,IntPtr data);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] public static extern bool EnumWindows(Callback callback,IntPtr data);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window,out uint pid);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr window,StringBuilder title,int count);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window,out R rect);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
}
'@
[void][TargetProbe]::SetThreadDpiAwarenessContext([IntPtr](-4))
$request=$env:FBC_WINDOW_VERIFICATION | ConvertFrom-Json
$script:matches=@()
[void][TargetProbe]::EnumWindows({param($handle,$unused)
  if ($request.window.hwnd -and $handle.ToInt64().ToString() -ne [string]$request.window.hwnd) { return $true }
  [uint32]$owner=0
  [void][TargetProbe]::GetWindowThreadProcessId($handle,[ref]$owner)
  $title=New-Object System.Text.StringBuilder 4096
  [void][TargetProbe]::GetWindowText($handle,$title,$title.Capacity)
  if($owner -eq $request.window.pid -and $title.ToString() -ceq $request.window.title -and [TargetProbe]::IsWindowVisible($handle)) { $script:matches+= $handle }
  return $true
},[IntPtr]::Zero)
if($script:matches.Count -ne 1) { throw 'Expected one matching visible target window' }
$handle=$script:matches[0]
$bounds=New-Object TargetProbe+R
[void][TargetProbe]::GetWindowRect($handle,[ref]$bounds)
$root=[System.Windows.Automation.AutomationElement]::FromHandle($handle)
$condition=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty,[string]$request.elementName)
$elements=$root.FindAll([System.Windows.Automation.TreeScope]::Descendants,$condition)
if($elements.Count -ne 1) { throw 'Expected one independent UIA match for the target name' }
$rect=$elements[0].Current.BoundingRectangle
@{window=@{x=$bounds.left;y=$bounds.top;width=$bounds.right-$bounds.left;height=$bounds.bottom-$bounds.top};target=@{x=$rect.X;y=$rect.Y;width=$rect.Width;height=$rect.Height}} | ConvertTo-Json -Depth 4 -Compress
