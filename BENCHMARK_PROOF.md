# KAPTURA / UPSKALETOR — Empirical Ground-Truth Benchmark Proof

- **Date (UTC):** 2026-11-20T00:32:07.205Z
- **Hardware:** NVIDIA GeForce RTX 3070 Laptop GPU, 595.97, 8192 MiB
- **FFmpeg Codec:** `h264_nvenc` (HW Accelerated: `true`)
- **FFmpeg Filters Probed:** CAS=`true`, SSIM=`true`, PSNR=`true`, VMAF=`true`
- **Neural Engines Active:** Real-ESRGAN=`true`, RIFE v4.6=`true`
- **Ground Truth Clip:** `1280x720 @ 30fps`, 1.500s, Audio=`aac`
- **Degraded 4× Input:** `320x180 @ 30fps`, 1.510s, Audio=`aac`
- **Temp File Hygiene:** `0` leaked files/directories after run (`0` expected)

## Reproducible Results Matrix

| Engine / Pipeline | Output Stream | SSIM ↑ | PSNR (dB) ↑ | VMAF ↑ | FPS Drift ↓ | Duration Drift | Audio AAC | GPU Time |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| Baseline Bicubic (FFmpeg) | `1280x720 @ 30fps` | 0.5830 | 21.05 | 51.66 | 0% | 0 ms | PRESERVED | 0.34s |
| Motor 1: Lanczos-3 + CAS (h264_nvenc) | `1280x720 @ 30fps` | 0.5867 | 21.37 | 62.39 | 0% | 0 ms | PRESERVED | 0.64s |
| Motor 2: Real-ESRGAN x4plus (Vulkan) | `1280x720 @ 30fps` | 0.7356 | 20.75 | 36.66 | 0% | 10 ms | PRESERVED | 18.68s |
| Motor 2 Fast: Real-ESRGAN v3 (Vulkan) | `1280x720 @ 30fps` | 0.6141 | 19.76 | 23.39 | 0% | 10 ms | PRESERVED | 8.15s |
| Motor 3: RIFE v4.6 2× FPS (Vulkan) | `320x180 @ 60fps` | 0.5780 | 21.03 | 50.00 | 0% | 10 ms | PRESERVED | 6.09s |
| HYBRID ULTRA: Real-ESRGAN v3 + RIFE v4.6 | `1280x720 @ 60fps` | 0.6145 | 19.76 | 23.37 | 0% | 10 ms | PRESERVED | 20.52s |

## Reproduce Locally

```bash
npm run benchmark
```

Every run synthesizes an independent lossless Ground-Truth reference + stereo AAC audio track on the host machine, downscales 4×, executes each active pipeline end-to-end, computes FFmpeg SSIM/PSNR/VMAF, verifies FPS lock & audio preservation, and asserts zero leaked scratch artifacts.
