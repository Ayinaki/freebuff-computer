param([string]$OutputPath = '.fbc/overlay-preview.png')
$ErrorActionPreference = 'Stop'
$nativeSource = Join-Path $PSScriptRoot '../native/Overlay.cs'
Add-Type -Path $nativeSource -ReferencedAssemblies System.Drawing,System.Windows.Forms,System.Web.Extensions
$previewPath = [IO.Path]::GetFullPath($OutputPath)
[void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($previewPath))
[FreebuffComputer.Overlay]::SavePreview($previewPath)
Write-Output $previewPath
