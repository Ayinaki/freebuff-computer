param([Parameter(Mandatory=$true)][int]$Port, [Parameter(Mandatory=$true)][string]$Token)
$ErrorActionPreference = 'Stop'
# PowerShell is only the launcher/compiler. Rendering uses native Win32 layered
# windows, not a WPF window with virtualized coordinates.
Add-Type -Path (Join-Path $PSScriptRoot 'Overlay.cs') -ReferencedAssemblies System.Drawing,System.Windows.Forms,System.Web.Extensions
[FreebuffComputer.Overlay]::Run($Port, $Token)
