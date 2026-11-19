# 📹 KAPTURA by Ethernium

> **CHRONO Capture Studio · Real In-Browser Transcoding, GPU Daemon (`:3370`), 3-Motor AI Pipeline & Forensic Optical Inspector**

[![Live Demo](https://img.shields.io/badge/Demo%20en%20Vivo-Abrir%20Studio-00f0ff?style=for-the-badge&logo=googlechrome&logoColor=white)](https://nullalabs.github.io/KAPTURA-by-Ethernium/)
[![Zero-Cost](https://img.shields.io/badge/Privacy-100%25%20Local--First-green?style=for-the-badge)](https://nullalabs.github.io/KAPTURA-by-Ethernium/)
[![Benchmark Proof](https://img.shields.io/badge/Verified-Ground--Truth%20Benchmark-00ff9d?style=for-the-badge)](BENCHMARK_PROOF.md)

KAPTURA captura pantalla o pestañas (hasta 4K/120 FPS solicitados con `MediaRecorder`) y combina un estudio **Zero-Install en el navegador** con un **GPU Daemon local opcional (`127.0.0.1:3370`)**. Todo ocurre de forma local, sin nubes ni telemetría externa, verificando cada píxel, FPS, deriva temporal y pista de audio en tiempo real.

La resolución, frecuencia y códec efectivos dependen del navegador, el sistema y la fuente. Cuando una capacidad o binario local no existe (p. ej. `realesrgan-ncnn-vulkan` o `rife-ncnn-vulkan`), KAPTURA lo reporta con transparencia: usa su motor matemático en navegador o entrega el master intacto junto al comando firmado.

---

## 🔍 Por qué trasciende: Inspección Forense + Pipeline Unificado

Mientras herramientas convencionales se limitan a grabar, recodificar o escalar a ciegas, KAPTURA une captura, conversión, compresión, vectorización, reescalado espacial, interpolación temporal y **prueba óptica en pantalla**:

| Capacidad Verificada | OBS Studio | Screenity | Video2X | KAPTURA + UPSKALETOR |
| :--- | :---: | :---: | :---: | :---: |
| **Zero-Install en navegador (GitHub Pages)** | ❌ | ⚠️ Extensión | ❌ | ✅ Studio completo |
| **Captura GPU directa a disco sin límite RAM** | ✅ | ⚠️ RAM navegador | ❌ | ✅ WebSocket `:3370` + NVENC |
| **GIF89a propio (Median-Cut + Floyd-Steinberg + LZW)** | ❌ | ⚠️ Básico | ❌ | ✅ Sub-rect delta `< 14.8 MB` |
| **Compresor por presupuesto MB + Vectorizador SVG** | ❌ | ❌ | ❌ | ✅ Nativo (`<path>` / SMIL) |
| **Escalado 2K/4K Lanczos-3 + AMD FidelityFX `cas` + CFR** | ⚠️ Reescalado simple | ❌ | ❌ | ✅ WebGL + FFmpeg GPU |
| **Real-ESRGAN Vulkan + RIFE v4.6 (`30→60 fps`)** | ❌ | ❌ | ✅ | ✅ Vulkan RTX/GPU (`esrgan` / `rife` / `hybrid`) |
| **Inspector Óptico Forense integrado (`Δ ×8`, `1×–8×`, Sobel)** | ❌ | ❌ | ❌ | ✅ En vivo sobre el resultado |
| **Benchmark Ground-Truth SSIM / PSNR / VMAF reproducible** | ❌ | ❌ | ❌ | ✅ `npm run benchmark` ([BENCHMARK_PROOF.md](BENCHMARK_PROOF.md)) |

---

## ⚡ Los 3 Motores de UPSKALETOR + Inspector Óptico Forense

### 🔬 Forensic Optical Inspector (`js/comparator.js`)
Comparar vídeos `1280×720` y `3840×2160` encogidos en una caja estática los hace parecer iguales. Nuestro inspector renderiza ambas fuentes desde su resolución nativa en canvas Hi-DPI:
* **Modos de inspección:** `SPLIT A/B` (cortina interactiva con paneo libre), **`Δ ×8 HEATMAP`** (mapa térmico cian/violeta/dorado amplificado ×8 con la diferencia real píxel a píxel) y **`SIDE×SIDE`**.
* **Lupa óptica con auto-enganche (`1×` / `2×` / `4×` / `8×`):** activa automáticamente `2×` cuando `outWidth > srcWidth` para exponer nitidez de bordes sin engañar con miniaturas.
* **Transporte exacto frame a frame:** botones `◀ -1f`, `⏸ PAUSA`, `+1f ▶` bloqueados por timestamp.
* **Telemetría matemática y recibo notarial `:3370`:** calcula en vivo **energía de bordes Sobel + Laplaciano (`%`)** y **`Δ PIXEL / 255`**, junto a las cabeceras del daemon (`X-Kaptura-Src-Res`, `X-Kaptura-Out-Res`, `X-Kaptura-Src-Fps`, `X-Kaptura-Out-Fps`, `X-Kaptura-Duration-Drift-Ms`, `X-Kaptura-Audio-Preserved`, `X-Kaptura-Elapsed-Ms`). Si el origen ya es ≥ destino, lo avisa explícitamente.

### ⚙️ Tres motores reales (`esrgan`, `rife`, `hybrid`, `lanczos+cas`)
1. **Motor 1 — Máxima Resolución 2K / 4K Tiempo Real + AMD FidelityFX `cas` (`2k_cas`, `4k_cas`):** Lanczos-3 separable + 2º pase CAS shader en WebGL (`js/lanczos-gl.js`) y filtro nativo FFmpeg `cas=strength=...` con `-fps_mode cfr` en `:3370`.
2. **Motor 2 — Reconstrucción Neural Espacial (`4k_ai`, `restore_ai`, `anime_ai`):** ejecución Vulkan directa de `realesrgan-ncnn-vulkan` (`realesrgan-x4plus` / `realesr-animevideov3`) por segmentos acotados de 4 s preservando el FPS origen y pista de audio AAC sin explosión de PNGs temporales en disco.
3. **Motor 3 — Interpolación Temporal + Híbrido 4K/60FPS (`rife_2x`, `hybrid_4k_rife`):** interpolación neuronal con **`rife-ncnn-vulkan` (`rife-v4.6`)** duplicando cuadros reales (`30 → 60 fps`) y pipeline híbrido encadenado Real-ESRGAN 4× + RIFE 2× FPS.

### 🧠 Frontera honesta (sin simulación)
* **Transcodificación real en navegador:** `V-CONVERTER` y `SMART COMPRESSOR` recodifican en navegador vía WebCodecs / MediaRecorder y estimación de bitrate.
* **GIF real:** codificador **GIF89a puro en JavaScript** (`js/gif-encoder.js`), cuantización median-cut + dithering Floyd–Steinberg + compresión **LZW** + hold temporal en Web Worker.
* **Handoff honesto de IA:** si `realesrgan-ncnn-vulkan` o `rife-ncnn-vulkan` no están instalados en el host del operador, **`UPSKALETOR-by-Ethernium`** y KAPTURA no fingen resultados: entregan el master intacto y el comando exacto para `.\kpr-upscale.ps1`.
* **Local-first real:** fuentes tipográficas auto-alojadas (`css/fonts.css`) y Bóveda en IndexedDB + discos locales.

---

## 📊 Prueba Empírica Reproducible (`BENCHMARK_PROOF.md`)

Resultados reales ejecutados con [`npm run benchmark`](scripts/benchmark_upskaletor.mjs) sobre **NVIDIA GeForce RTX 3070 Laptop GPU** (`h264_nvenc`, FFmpeg v7.1 con `cas`, `ssim`, `psnr`, `libvmaf`) frente a un maestro sintético Ground-Truth `1280×720 @ 30fps` + audio estéreo 48 kHz AAC degradado 4× a `320×180 @ 30fps`:

| Motor / Pipeline | Salida | SSIM ↑ | PSNR (dB) ↑ | VMAF ↑ | FPS Drift ↓ | Duration Drift | Audio AAC | Tiempo GPU |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| Baseline Bicubic (FFmpeg) | `1280x720 @ 30fps` | 0.5830 | 21.05 | 51.66 | 0% | 0 ms | PRESERVED | 0.44s |
| **Motor 1: Lanczos-3 + CAS (`h264_nvenc`)** | `1280x720 @ 30fps` | **0.5869** | **21.21** | **56.91** | **0%** | **0 ms** | **PRESERVED** | **0.81s** |
| **Motor 2: Real-ESRGAN `x4plus` (Vulkan)** | `1280x720 @ 30fps` | **0.7290** | 20.83 | 35.41 | 0% | 10 ms | PRESERVED | 62.68s |
| **Motor 2 Fast: Real-ESRGAN `v3` (Vulkan)** | `1280x720 @ 30fps` | 0.6165 | 19.81 | 22.70 | 0% | 10 ms | PRESERVED | 6.59s |
| **Motor 3: RIFE v4.6 2× FPS (Vulkan)** | `320x180 @ 60fps` | 0.5780 | 21.03 | 50.00 | **0%** | 10 ms | PRESERVED | 3.68s |
| **HYBRID ULTRA: ESRGAN `v3` + RIFE v4.6** | `1280x720 @ 60fps` | 0.6166 | 19.81 | 22.68 | **0%** | 10 ms | PRESERVED | 16.01s |

* **Higiene verificada de disco:** `0` archivos/directorios filtrados tras completar los 6 pipelines. Consulta el informe completo en [BENCHMARK_PROOF.md](BENCHMARK_PROOF.md).

---

## 🏗️ Arquitectura modular

```text
daemon/
  server.mjs                        estudio + microservicio :3370 (HTTP, CORS, SSE /events, WS /ws/capture, Range 206, /upscale-ai)
  providers/adapters.mjs            detección automática de UPSKALETOR, realesrgan-ncnn-vulkan y rife-ncnn-vulkan
  pipeline/gpuDirectOptimizer.mjs   detección FFmpeg, encoders HW (NVENC/AMF/QSV/x264) y filtros (cas/ssim/psnr/libvmaf)
  pipeline/videoPipeline.mjs        transcode Lanczos+CAS+CFR, /trim, segmentación neural Real-ESRGAN/RIFE/Hybrid y métricas
  synkronia/wsServer.mjs            servidor WebSocket RFC 6455 sin dependencias externas
js/
  audio-mixer.js    mezclador Web Audio (sistema + micrófono + vúmetros RMS)
  capabilities.js   detección de GPU/códecs/workers/WebCodecs
  comparator.js     Forensic Optical Inspector (SPLIT A/B, Δ ×8 Heatmap, Side×Side, zoom 1×–8×, Sobel + Δ pixel)
  gif-encoder.js    codificador GIF89a puro (median-cut + LZW + delta frugal)
  lanczos.js        resampler Lanczos-3 en CPU
  lanczos-gl.js     resampler Lanczos-3 en GPU + 2º pase CAS shader (WebGL)
  scaler.js         fachada híbrida GPU/CPU/CAS
  transcoder.js     re-encode real (WebCodecs VP8 rápido / MediaRecorder) + toGIF con recorte
  compressor.js     compresor inteligente con estimador de presupuesto (< 15MB, < 8MB, < 2MB)
  svg-vector.js     vectorizador de imagen a <path> SVG real y SMIL flip-book para vídeo/canvas
  gif.worker.js     encode GIF fuera del hilo principal
  upskaletor.js     perfiles 2K/4K CAS, Real-ESRGAN, RIFE v4.6, Hybrid 4K+60fps y handoff honesto CLI
  vault.js          capa IndexedDB local-first y referencias ligeras a disco
  capture.js        captura de pantalla + escenas benchmark + streaming WebSocket
  daemon-bridge.js  puente cliente a daemon :3370 (SSE, Trim, /upscale-ai, cabeceras forenses)
  app.js            orquestación de Stage, Trim Dock, Download Pro Header y flujo en 1 clic
scripts/
  benchmark_upskaletor.mjs   suite empírica Ground-Truth PSNR/SSIM/VMAF + higiene de temporales
  build_release.py           empaquetado portátil limpio en dist/
css/  hud.css · fonts.css
fonts/ orbitron.woff2 · firacode.woff2 · inter.woff2  (subset latin, ~96 KB)
```

---

## 🚀 Uso rápido y verificación

1. **Con GPU Daemon local (recomendado):** ejecuta `npm run daemon` (o `KAPTURA.cmd` en Windows) y abre `http://127.0.0.1:3370/`.
2. **Solo navegador estático:** `python -m http.server` (o `npm run serve`) y abre `http://localhost:8000/`.
3. Captura con **🖥️ Grabar Pantalla / Ventana**, renderiza con GPU o abre cualquier vídeo local; recórtalo en **✂️ TRIM FAST** y envíalo en 1 clic a **Cinema GIF**, **Compresor**, **SVG Vector**, **V-Converter** o **Upskaletor AI**.

```bash
npm run daemon                     # inicia Studio + GPU Daemon en http://127.0.0.1:3370
npm test                           # suite completa (GIF, Lanczos, SVG, Inspector Sobel, Timing, Daemon/WS/RIFE)
npm run benchmark                  # reproduce el benchmark Ground-Truth PSNR/SSIM/VMAF y actualiza BENCHMARK_PROOF.md
python tests/validate_kaptura.py   # contrato estático del producto
python scripts/build_release.py    # genera paquete portátil limpio en dist/
```

---
<sub>KAPTURA by Ethernium — Local-First Capture, GPU Processing & Forensic Media Studio.</sub>
