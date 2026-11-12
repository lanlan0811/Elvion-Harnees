param([ValidateSet('x64','arm64')][string]$Architecture = 'x64')
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$output = Join-Path $root "packages/platform-win32-$Architecture/bin"
New-Item -ItemType Directory -Path $output -Force | Out-Null
$source = Join-Path $root 'native/windows-job.cpp'
$target = Join-Path $output 'elvion-job.exe'
if (Get-Command cl.exe -ErrorAction SilentlyContinue) {
  # CI may already have configured the native ARM64 or cross compiler.
  & cl.exe /nologo /std:c++17 /W4 /WX /O2 /MT /EHsc /DUNICODE /D_UNICODE $source "/Fe:$target" "/Fo:$output/launcher.obj" /link /DYNAMICBASE /NXCOMPAT /GUARD:CF
} else {
  $vswhere = "${env:ProgramFiles(x86)}/Microsoft Visual Studio/Installer/vswhere.exe"
  if (-not (Test-Path -LiteralPath $vswhere)) { throw '需要 Visual Studio C++ Build Tools（仅构建机需要）。' }
  $installation = & $vswhere -latest -products '*' -property installationPath
  if (-not $installation) { throw '找不到 Visual Studio C++ Build Tools。' }
  $vcvars = Join-Path $installation 'VC/Auxiliary/Build/vcvarsall.bat'
  $isArmHost = $env:PROCESSOR_ARCHITECTURE -eq 'ARM64'
  $vcarch = if ($Architecture -eq 'arm64') { if ($isArmHost) { 'arm64' } else { 'x64_arm64' } } else { if ($isArmHost) { 'arm64_x64' } else { 'x64' } }
  # cmd is build infrastructure only; agent commands always use Bash at runtime.
  & $env:ComSpec /d /s /c "`"`"$vcvars`" $vcarch >nul && cl /nologo /std:c++17 /W4 /WX /O2 /MT /EHsc /DUNICODE /D_UNICODE `"$source`" /Fe:`"$target`" /Fo:`"$output/launcher.obj`" /link /DYNAMICBASE /NXCOMPAT /GUARD:CF`""
}
if ($LASTEXITCODE -ne 0) { throw "启动器构建失败：$LASTEXITCODE" }
Remove-Item -LiteralPath (Join-Path $output 'launcher.obj') -ErrorAction SilentlyContinue
