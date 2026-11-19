[CmdletBinding()]
param(
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA "Ethernium\UPSKALETOR"),
    [switch]$SkipEsrgan,
    [switch]$SkipRife,
    [switch]$Force,
    [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$target = [IO.Path]::GetFullPath($InstallRoot)
$esrganUrl = "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesrgan-ncnn-vulkan-20220424-windows.zip"
$rifeUrl = "https://github.com/nihui/rife-ncnn-vulkan/releases/download/20221029/rife-ncnn-vulkan-20221029-windows.zip"

$esrganExe = Join-Path $target "realesrgan-ncnn-vulkan.exe"
$esrganModelCheck = Join-Path $target "models\realesrgan-x4plus.bin"
$rifeExe = Join-Path $target "rife-ncnn-vulkan.exe"
$rifeModelCheck = Join-Path $target "rife-v4.6\flownet.bin"

$hasEsrgan = (Test-Path $esrganExe) -and (Test-Path $esrganModelCheck)
$hasRife = (Test-Path $rifeExe) -and (Test-Path $rifeModelCheck)

Write-Host "KAPTURA Neural Engines Bootstrapper -> $target"
Write-Host ("  Real-ESRGAN Vulkan : " + $(if ($hasEsrgan) { "INSTALLED" } else { "MISSING" }))
Write-Host ("  RIFE v4.6 Vulkan   : " + $(if ($hasRife) { "INSTALLED" } else { "MISSING" }))

if ($DryRun) {
    Write-Host "[DryRun] Planned install root: $target"
    if (-not $SkipEsrgan -and (-not $hasEsrgan -or $Force)) { Write-Host "[DryRun] Would download: $esrganUrl" }
    if (-not $SkipRife -and (-not $hasRife -or $Force)) { Write-Host "[DryRun] Would download: $rifeUrl" }
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

Write-Host "`nInstalled binary SHA-256 receipts:"
foreach ($exe in @($esrganExe, $rifeExe)) {
    if (Test-Path $exe) {
        $h = (Get-FileHash -Algorithm SHA256 -LiteralPath $exe).Hash
        Write-Host ("  " + (Split-Path $exe -Leaf) + " -> " + $h)
    }
}
Write-Host "`nReady. Start Studio + GPU Daemon with: npm run daemon"
