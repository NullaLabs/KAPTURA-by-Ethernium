[CmdletBinding()]
param(
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA "Ethernium\UPSKALETOR"),
    [string]$MattingDir = "",
    [switch]$SkipEsrgan,
    [switch]$SkipRife,
    [switch]$SkipMatting,
    [switch]$Force,
    [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Download-Artifact {
    param([string]$Uri, [string]$OutFile)
    $curl = Get-Command "curl.exe" -ErrorAction SilentlyContinue
    if ($curl) {
        & $curl.Source -fL --retry 3 --connect-timeout 20 -sS -o $OutFile $Uri
        if ($LASTEXITCODE -eq 0 -and (Test-Path $OutFile) -and (Get-Item $OutFile).Length -gt 1024) { return }
    }
    Invoke-WebRequest -Uri $Uri -OutFile $OutFile -UseBasicParsing
}

function Resolve-MattingDir {
    param([string]$Requested, [string]$PrimaryRoot)
    if ($Requested) { return [IO.Path]::GetFullPath($Requested) }
    $qualifier = Split-Path -Qualifier $PrimaryRoot
    if ($qualifier) {
        try {
            $freeBytes = [System.IO.DriveInfo]::new($qualifier).AvailableFreeSpace
            if ($freeBytes -lt 1.5GB) {
                if (Test-Path "E:\UPSKALETOR") { return "E:\UPSKALETOR\models\matting" }
                $repoRoot = Split-Path -Parent $PSScriptRoot
                return (Join-Path $repoRoot ".models\matting")
            }
        } catch {}
    }
    return (Join-Path $PrimaryRoot "models\matting")
}

$target = [IO.Path]::GetFullPath($InstallRoot)
$esrganUrl = "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesrgan-ncnn-vulkan-20220424-windows.zip"
$rifeUrl = "https://github.com/nihui/rife-ncnn-vulkan/releases/download/20221029/rife-ncnn-vulkan-20221029-windows.zip"
$mattingDir = Resolve-MattingDir -Requested $MattingDir -PrimaryRoot $target
$mattingModels = @(
    @{ Name = "BiRefNet-general-bb_swin_v1_tiny-epoch_232.onnx"; Url = "https://github.com/danielgatis/rembg/releases/download/v0.0.0/BiRefNet-general-bb_swin_v1_tiny-epoch_232.onnx" },
    @{ Name = "rvm_resnet50_fp16.torchscript"; Url = "https://github.com/PeterL1n/RobustVideoMatting/releases/download/v1.0.0/rvm_resnet50_fp16.torchscript" },
    @{ Name = "rvm_mobilenetv3_fp32.onnx"; Url = "https://github.com/PeterL1n/RobustVideoMatting/releases/download/v1.0.0/rvm_mobilenetv3_fp32.onnx" }
)

$esrganExe = Join-Path $target "realesrgan-ncnn-vulkan.exe"
$esrganModelCheck = Join-Path $target "models\realesrgan-x4plus.bin"
$rifeExe = Join-Path $target "rife-ncnn-vulkan.exe"
$rifeModelCheck = Join-Path $target "rife-v4.6\flownet.bin"

$hasEsrgan = (Test-Path $esrganExe) -and (Test-Path $esrganModelCheck)
$hasRife = (Test-Path $rifeExe) -and (Test-Path $rifeModelCheck)
$hasMattingAll = ($mattingModels | Where-Object { -not (Test-Path (Join-Path $mattingDir $_.Name)) } | Measure-Object).Count -eq 0

Write-Host "KAPTURA Neural Engines Bootstrapper -> $target"
Write-Host ("  Real-ESRGAN Vulkan : " + $(if ($hasEsrgan) { "INSTALLED" } else { "MISSING" }))
Write-Host ("  RIFE v4.6 Vulkan   : " + $(if ($hasRife) { "INSTALLED" } else { "MISSING" }))
Write-Host ("  BG Matting Models  : " + $(if ($hasMattingAll) { "INSTALLED" } else { "PARTIAL/MISSING" }))

if ($DryRun) {
    Write-Host "[DryRun] Planned install root: $target"
    if (-not $SkipEsrgan -and (-not $hasEsrgan -or $Force)) { Write-Host "[DryRun] Would download: $esrganUrl" }
    if (-not $SkipRife -and (-not $hasRife -or $Force)) { Write-Host "[DryRun] Would download: $rifeUrl" }
    if (-not $SkipMatting) {
        foreach ($m in $mattingModels) {
            if ($Force -or -not (Test-Path (Join-Path $mattingDir $m.Name))) {
                Write-Host "[DryRun] Would download: $($m.Url)"
            }
        }
    }
    exit 0
}

New-Item -ItemType Directory -Force -Path $target | Out-Null

if (-not $SkipEsrgan -and (-not $hasEsrgan -or $Force)) {
    $zip = Join-Path $env:TEMP ("kaptura_esrgan_" + [guid]::NewGuid().ToString("N") + ".zip")
    $stage = Join-Path $env:TEMP ("kaptura_esrgan_" + [guid]::NewGuid().ToString("N"))
    try {
        Write-Host "Downloading official Real-ESRGAN NCNN Vulkan v0.2.5.0..."
        Invoke-WebRequest -Uri $esrganUrl -OutFile $zip -UseBasicParsing
        Expand-Archive -Path $zip -DestinationPath $stage -Force
        $bin = Get-ChildItem -Path $stage -Filter "realesrgan-ncnn-vulkan.exe" -Recurse | Select-Object -First 1
        if (-not $bin) { throw "realesrgan-ncnn-vulkan.exe missing in archive" }
        $srcDir = $bin.Directory.FullName
        Copy-Item -LiteralPath $bin.FullName -Destination $esrganExe -Force
        foreach ($dll in @("vcomp140.dll", "vcomp140d.dll")) {
            $dSrc = Join-Path $srcDir $dll
            if (Test-Path $dSrc) { Copy-Item -LiteralPath $dSrc -Destination (Join-Path $target $dll) -Force }
        }
        $modelsSrc = Join-Path $srcDir "models"
        $modelsDst = Join-Path $target "models"
        New-Item -ItemType Directory -Force -Path $modelsDst | Out-Null
        Copy-Item -Path (Join-Path $modelsSrc "*") -Destination $modelsDst -Recurse -Force
    } finally {
        Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
    }
}

if (-not $SkipRife -and (-not $hasRife -or $Force)) {
    $zip = Join-Path $env:TEMP ("kaptura_rife_" + [guid]::NewGuid().ToString("N") + ".zip")
    $stage = Join-Path $env:TEMP ("kaptura_rife_" + [guid]::NewGuid().ToString("N"))
    try {
        Write-Host "Downloading official RIFE NCNN Vulkan v20221029 (rife-v4.6)..."
        Invoke-WebRequest -Uri $rifeUrl -OutFile $zip -UseBasicParsing
        Expand-Archive -Path $zip -DestinationPath $stage -Force
        $bin = Get-ChildItem -Path $stage -Filter "rife-ncnn-vulkan.exe" -Recurse | Select-Object -First 1
        if (-not $bin) { throw "rife-ncnn-vulkan.exe missing in archive" }
        $srcDir = $bin.Directory.FullName
        Copy-Item -LiteralPath $bin.FullName -Destination $rifeExe -Force
        $vcomp = Join-Path $srcDir "vcomp140.dll"
        if ((Test-Path $vcomp) -and -not (Test-Path (Join-Path $target "vcomp140.dll"))) {
            Copy-Item -LiteralPath $vcomp -Destination (Join-Path $target "vcomp140.dll") -Force
        }
        $rSrc = Join-Path $srcDir "rife-v4.6"
        $rDst = Join-Path $target "rife-v4.6"
        if (Test-Path $rDst) { Remove-Item -LiteralPath $rDst -Recurse -Force }
        Copy-Item -LiteralPath $rSrc -Destination $rDst -Recurse -Force
    } finally {
        Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
    }
}

if (-not $SkipMatting) {
    New-Item -ItemType Directory -Force -Path $mattingDir | Out-Null
    foreach ($m in $mattingModels) {
        $dst = Join-Path $mattingDir $m.Name
        if ($Force -or -not (Test-Path $dst) -or ((Get-Item $dst).Length -lt 1024)) {
            $tmpFile = "$dst.part"
            Write-Host "Downloading $($m.Name)..."
            try {
                Download-Artifact -Uri $m.Url -OutFile $tmpFile
                Move-Item -LiteralPath $tmpFile -Destination $dst -Force
            } catch {
                Remove-Item -LiteralPath $tmpFile -Force -ErrorAction SilentlyContinue
                throw
            }
        }
    }
    $hrDir = Join-Path $mattingDir "BiRefNet_HR-matting"
    New-Item -ItemType Directory -Force -Path $hrDir | Out-Null
    $hrBase = "https://huggingface.co/ZhengPeng7/BiRefNet_HR-matting/resolve/main"
    foreach ($hfFile in @("BiRefNet_config.py", "birefnet.py", "config.json", "model.safetensors")) {
        $dst = Join-Path $hrDir $hfFile
        if ($Force -or -not (Test-Path $dst) -or ((Get-Item $dst).Length -lt 100)) {
            $tmpFile = "$dst.part"
            Write-Host "Downloading BiRefNet_HR-matting/$hfFile..."
            try {
                Download-Artifact -Uri "$hrBase/$hfFile" -OutFile $tmpFile
                Move-Item -LiteralPath $tmpFile -Destination $dst -Force
            } catch {
                Remove-Item -LiteralPath $tmpFile -Force -ErrorAction SilentlyContinue
                throw
            }
        }
    }
}

Write-Host "`nInstalled binary & model SHA-256 receipts:"
$receiptTargets = @($esrganExe, $rifeExe) + ($mattingModels | ForEach-Object { Join-Path $mattingDir $_.Name })
foreach ($itemPath in $receiptTargets) {
    if (Test-Path $itemPath) {
        $h = (Get-FileHash -Algorithm SHA256 -LiteralPath $itemPath).Hash
        Write-Host ("  " + (Split-Path $itemPath -Leaf) + " -> " + $h)
    }
}
Write-Host "`nReady. Start Studio + GPU Daemon with: npm run daemon"
