param([string]$Python = "python", [string]$Destination = "", [string]$PublicConfig = "", [switch]$EvaluationLocked)
$ErrorActionPreference = "Stop"
$ToolRoot = $PSScriptRoot
$Repository = Split-Path $ToolRoot
$Artifacts = [IO.Path]::GetFullPath((Join-Path $Repository "artifacts"))
if (!$Destination) { $Destination = Join-Path $Artifacts ("monthly-licensing-" + [guid]::NewGuid().ToString('N')) }
$Destination = [IO.Path]::GetFullPath($Destination)
if (!$Destination.StartsWith($Artifacts + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw "Build destination must be inside this worktree's artifacts directory" }
if (Test-Path -LiteralPath $Destination) { throw "Build destination must be new; existing packages are never overwritten" }
$BuildRoot = Join-Path $Artifacts ("monthly-build-" + [guid]::NewGuid().ToString('N'))
$Stage = Join-Path $BuildRoot "customer"
$PrepareArgs = @("$ToolRoot\customer_build.py", "--stage", $Stage)
if ($EvaluationLocked) { $PrepareArgs += "--evaluation-locked" }
if ($PublicConfig) { $PrepareArgs += @("--public-config", $PublicConfig) }
& $Python @PrepareArgs
if ($LASTEXITCODE -ne 0) { throw "Customer build preflight failed" }
$StagedTool = Join-Path $Stage "tool"
& $Python -m PyInstaller --noconfirm --onedir --name DoubaoImageTool --distpath $Destination --workpath (Join-Path $BuildRoot "frozen") --specpath $BuildRoot --paths $StagedTool --add-data "$StagedTool\web;web" --hidden-import cryptography.hazmat.primitives.asymmetric.ed25519 --collect-all requests --collect-all alibabacloud_oss_v2 --collect-all Crypto --collect-all crcmod --collect-all playwright --collect-all alibabacloud_alimt20181012 --collect-all alibabacloud_tea_openapi --collect-all alibabacloud_tea_util --collect-all alibabacloud_credentials "$StagedTool\run.py"
if ($LASTEXITCODE -ne 0) { throw "PyInstaller failed" }
$Package = Join-Path $Destination "DoubaoImageTool"
Copy-Item -LiteralPath "$StagedTool\README.md", "$StagedTool\THIRD_PARTY_NOTICES.md", "$StagedTool\启动豆包图片转换.cmd" -Destination $Package
Copy-Item -LiteralPath "$StagedTool\docs" -Destination (Join-Path $Package "docs") -Recurse
& $Python "$ToolRoot\collect_licenses.py" "$Package\licenses"
if ($LASTEXITCODE -ne 0) { throw "License collection failed" }
Copy-Item -LiteralPath $StagedTool -Destination (Join-Path $Package "source") -Recurse
Copy-Item -LiteralPath "$Stage\extension" -Destination (Join-Path $Destination "商品采集插件") -Recurse
Copy-Item -LiteralPath "$Stage\导入产品模板.xls", "$Stage\BUILD-INFO.json" -Destination $Destination
if ($EvaluationLocked) { Copy-Item -LiteralPath "$Stage\EVALUATION-LOCKED.txt" -Destination $Destination }
& $Python "$ToolRoot\customer_build.py" --scan $Destination
if ($LASTEXITCODE -ne 0) { throw "Customer package secret scan failed" }
Write-Output $Destination
