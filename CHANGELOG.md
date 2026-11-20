# Changelog

## 3.1.0

- introduces the asynchronous GPU job queue (`?async=1` -> `202 Accepted`, `GET /jobs/:taskId`, `streaming.jobsEndpoint: "/jobs"`), disables HTTP request/socket timeouts (`requestTimeout = 0`), streams uploads up to 2 GB directly to disk (`streamRequestToFile`), and keeps large video upscales disk-backed via `/exports/*`;
- achieves a measured 137x neural video speedup on `1080p -> 4K` (down to `0.39–0.72 s/frame` vs `98.96 s/frame`) by auto-selecting native `realesr-animevideov3 -s 2` (`>=1200px` video targeting `<=3840px`) with adaptive tiling, `-j 1:1:2`, a `90s` stall watchdog + conservative `-t 128 -j 1:1:1` retry, intra-frame progress, and live `Seg / fN/M / s/f / ETA` telemetry;
- adds mid-flight cancelable GPU tasks (`POST /cancel/:taskId` with Windows process-tree `taskkill /T /F` and clean cancellation on daemon `stop()`), granular SSE frame progress, and the `#btnCancelUpscale` control;
- adds multi-scale WebGL and video detail recovery (`#upskaletorDetailSelect`), automatic neural promotion when local Vulkan engines are online, and `4x` auto-zoom loupe snapping in the Forensic Optical Inspector (`js/comparator.js`);
- ships the verified visual showcase gallery (`docs/showcase/`), `RIFE v4.6` `2x` temporal interpolation demo, and EN/ES Launch Kit (`LAUNCH_KIT.md`).

## 3.0.0

- upgrades the UI to a Liquid Glass 3D Obsidian chassis with highlighted header Download Pro buttons, readiness indicators, profile intent hints, and a 1-click permissionless **Forensic Demo** (`480x270 -> 3840x2160`);
- upgrades `js/comparator.js` into the **Forensic Optical Inspector** (`SPLIT A/B`, `Delta x8` pixel-delta heatmap, `SIDE x SIDE`, auto `2x`–`8x` optical zoom, `-1f/+1f` frame-step, live Sobel + Laplacian sharpness & RGB delta telemetry, and `:3370` integrity headers);
- introduces 3-motor UPSKALETOR execution (`Lanczos-3 + AMD FidelityFX CAS + CFR`, `Real-ESRGAN Vulkan x4plus / animevideov3`, `RIFE v4.6 Vulkan 2x FPS`, and `HYBRID ULTRA 4K+60fps`) with automatic binary discovery (`npm run setup:neural`) and honest CLI handoff when local Vulkan engines are absent;
- adds `scripts/benchmark_upskaletor.mjs` (`npm run benchmark`) and `BENCHMARK_PROOF.md` measuring reproducible SSIM, PSNR, VMAF, FPS drift, audio preservation, and zero leaked scratch files against synthesized Ground Truth;
- adds disk-backed live streaming capture over zero-dependency WebSocket (`ws://127.0.0.1:3370/ws/capture`, `pipe-media` + `pipe-frames` MJPEG self-healing fallback);
- streams real-time FFmpeg `-progress pipe:1` events over SSE (`GET /events`), adds `HTTP Range` (`206 Partial Content`) on `/exports/*`, and adds lossless stream-copy trimming (`POST /trim`);
- introduces `js/audio-mixer.js` for mixed system + microphone capture with live VU telemetry;
- accelerates offline browser WebM transcoding via WebCodecs `VideoEncoder` + minimal EBML muxer (`js/transcoder.js`);
- upgrades Stage workflow with continuous playback, Start/End trim dock, 1-click tab handoff, live Compressor budget estimator, and A/B split-screen comparator (`js/comparator.js`);
- removes internal catalog slides and stale metadata archives from the public repository.

## 2.0.0

- unifies the browser CHRONO Studio with the local GPU/FFmpeg `:3370` daemon (`daemon/server.mjs`) supporting `h264_nvenc`, `libx264`, and `libvpx-vp9` hardware/software encoding;
- removes synthetic `testsrc` placeholders in favor of real FFmpeg transcoding, Lanczos scaling, target-MB bitrate sizing, and deterministic PPM frame generation;
- adds 32-byte EBWP binary telemetry verification and monotonic HLC synchronization (`daemon/synkronia/`);
- wires the browser HUD (`js/daemon-bridge.js`) to auto-detect `:3370` with transparent WebCodecs/MediaRecorder fallback;
- archives legacy marketing/stub artifacts to SCRIBA and updates CI + portable release packaging to ship the complete v2.0 bundle.

## 1.0.1

- removes obsolete public links to the former owner namespace;
- labels UPSKALETOR honestly as an optional private companion for authorized
  operators instead of presenting an inaccessible release as public;
- updates generated showcase branding to the current NullaLabs namespace;
- keeps KAPTURA's standalone Lanczos and browser-transcoding paths unchanged.

## 1.0.0

- preserves the advanced KAPTURA interface, V-CONVERTER and target selector;
- replaces simulated browser upscaling and extension-only exports with an honest
  operator-controlled handoff;
- fixes the bundled converter so CFR output preserves source timing and refuses
  to overwrite existing output by default;
- generates commands that match UPSKALETOR v0.6.0 parameters;
- adds a portable Windows launcher and reproducible ZIP release;
- validates the product boundary, tracked-file hygiene and release contents in CI.
