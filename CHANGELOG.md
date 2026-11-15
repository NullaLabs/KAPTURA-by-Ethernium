# Changelog

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
