param([Parameter(Mandatory=$true)][int]$Port, [Parameter(Mandatory=$true)][string]$Token, [int]$ParentPid = 0)
$ErrorActionPreference = 'Stop'
# One helper per desktop session. A second one exits with code 3 so the server
# can report "another session owns the overlay" instead of drawing a second
# border on top of the first. The mutex is released by the OS when this process
# dies, so a crashed helper cannot block the next one.
# FBC_OVERLAY_MUTEX exists so an automated check can run beside a live session;
# two production servers must always share the default name.
$mutexName = if ([string]::IsNullOrWhiteSpace($env:FBC_OVERLAY_MUTEX)) { 'Local\FreebuffComputerOverlay' } else { $env:FBC_OVERLAY_MUTEX }
$mutex = New-Object System.Threading.Mutex($false, $mutexName)
$owned = $false
try { $owned = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $owned = $true }
if (-not $owned) {
    [Console]::Error.WriteLine('Another Freebuff Computer overlay is already running.')
    exit 3
}
# PowerShell is only the launcher/compiler. Rendering uses native Win32 layered
# windows, not a WPF window with virtualized coordinates.
Add-Type -Path (Join-Path $PSScriptRoot 'Overlay.cs') -ReferencedAssemblies System.Drawing,System.Windows.Forms,System.Web.Extensions
[FreebuffComputer.Overlay]::Run($Port, $Token, $ParentPid)
