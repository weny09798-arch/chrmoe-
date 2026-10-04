param([string]$Python = 'python')
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path $PSScriptRoot -Parent
$buildRoot = Join-Path $taskRoot 'artifacts/image-tool-build'
& $Python -m PyInstaller --noconfirm --clean --onedir --name TraditionalImageTool --distpath (Join-Path $buildRoot 'dist') --workpath (Join-Path $buildRoot 'work') --specpath $buildRoot --collect-all rapidocr_onnxruntime --collect-all opencc --copy-metadata rapidocr-onnxruntime --copy-metadata opencc-python-reimplemented --add-data "$PSScriptRoot/web;web" (Join-Path $PSScriptRoot 'run.py')
if ($LASTEXITCODE -ne 0) { throw 'Build failed' }
$toolFolder = Join-Path $buildRoot 'dist/TraditionalImageTool'
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'README.md') -Destination (Join-Path $toolFolder '使用说明.md')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'THIRD_PARTY_NOTICES.md') -Destination $toolFolder
Copy-Item -LiteralPath (Join-Path $PSScriptRoot '启动图片繁体转换.cmd') -Destination $toolFolder
& $Python (Join-Path $PSScriptRoot 'collect_licenses.py') (Join-Path $toolFolder 'licenses')
if ($LASTEXITCODE -ne 0) { throw 'License collection failed' }
Write-Output $toolFolder
