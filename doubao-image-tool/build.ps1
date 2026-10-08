param([string]$Python = "python", [string]$Destination = "")
$ErrorActionPreference = "Stop"
$ToolRoot = $PSScriptRoot
if (!$Destination) { $Destination = Join-Path (Split-Path $ToolRoot) "artifacts\doubao-portable" }
$Destination = [IO.Path]::GetFullPath($Destination)
$BuildRoot = Join-Path (Split-Path $ToolRoot) "artifacts\doubao-build"
New-Item -ItemType Directory -Force $Destination, $BuildRoot | Out-Null
& $Python -m PyInstaller --noconfirm --onedir --name DoubaoImageTool --distpath $Destination --workpath $BuildRoot --specpath $BuildRoot --add-data "$ToolRoot\web;web" --collect-all playwright --collect-all alibabacloud_alimt20181012 --collect-all alibabacloud_tea_openapi --collect-all alibabacloud_tea_util --collect-all alibabacloud_credentials "$ToolRoot\run.py"
if ($LASTEXITCODE -ne 0) { throw "PyInstaller failed" }
$Package = Join-Path $Destination "DoubaoImageTool"
Copy-Item -LiteralPath "$ToolRoot\README.md", "$ToolRoot\THIRD_PARTY_NOTICES.md", "$ToolRoot\启动豆包图片转换.cmd" -Destination $Package
& $Python "$ToolRoot\collect_licenses.py" "$Package\licenses"
if ($LASTEXITCODE -ne 0) { throw "License collection failed" }
$Source = Join-Path $Package "source"
New-Item -ItemType Directory -Force $Source | Out-Null
Get-ChildItem -LiteralPath $ToolRoot -File | Where-Object { $_.Extension -in '.py','.md','.txt','.ps1','.cmd' } | Copy-Item -Destination $Source
Copy-Item -LiteralPath "$ToolRoot\web" -Destination $Source -Recurse -Force
Write-Output $Package
