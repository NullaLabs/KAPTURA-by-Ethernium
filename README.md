# 📹 KAPTURA by Ethernium

> **CHRONO Capture Engine · Local-first browser studio con transcodificación REAL**

[![Live Demo](https://img.shields.io/badge/Demo%20en%20Vivo-Abrir%20Studio-00f0ff?style=for-the-badge&logo=googlechrome&logoColor=white)](https://nullalabs.github.io/KAPTURA-by-Ethernium/)
[![Zero-Cost](https://img.shields.io/badge/Privacy-100%25%20Local--First-green?style=for-the-badge)](https://nullalabs.github.io/KAPTURA-by-Ethernium/)

KAPTURA captura pantalla o pestañas (hasta 4K/120 FPS solicitados con
`MediaRecorder`) y ahora **procesa el vídeo de verdad dentro del navegador**:
reescalado Lanczos-3, re-encode nativo a MP4/WebM y un codificador GIF89a
propio escrito en JavaScript puro. Todo local, sin OBS, sin plugins y sin subir
nada a ningún servidor.

La resolución, frecuencia y códec efectivos dependen del navegador, el sistema
y la fuente. Cuando una capacidad no existe (p. ej. MP4), la app lo dice y usa
una alternativa real, nunca una simulación.

---

## ⚡ Qué es real (y qué no fingimos)

* **Transcodificación real en el navegador** — `V-CONVERTER` reproduce el vídeo,
  lo reescala con Lanczos-3 (GPU o CPU) y lo vuelve a codificar con el encoder
  nativo del navegador. El progreso refleja el trabajo real, no un `setTimeout`.
* **GIF real** — codificador **GIF89a propio** (`js/gif-encoder.js`): cuantización
  median-cut + dithering Floyd–Steinberg + compresión **LZW**. Cero librerías.
* **Escalado matemático real** — **Lanczos-3** en CPU (`js/lanczos.js`) y en GPU
  vía shader WebGL separable (`js/lanczos-gl.js`).
* **Handoff honesto de IA** — el escalado neuronal Real-ESRGAN se ejecuta en el
  motor independiente **UPSKALETOR**; KAPTURA entrega el master **sin alterarlo**
  y te da el comando firmado. No renombramos un archivo intacto como si fuera 4K.
* **Telemetría honesta** — el FPS mostrado es **medido**, no un número quemado.
* **Local-first de verdad** — fuentes **auto-alojadas** (`css/fonts.css`), sin
  depender de Google Fonts; la Bóveda usa IndexedDB local.

## 🧠 Reparto de trabajo CPU/GPU (frugal)

Híbrido con degradación elegante: se usa la GPU cuando está disponible, pero la
app **funciona igual sin ella**.

| Tarea | Ruta preferente | Fallback universal |
| --- | --- | --- |
| Reescalado de vídeo | GPU (`drawImage` / WebGL Lanczos) | CPU Lanczos-3 |
| Codificación de vídeo | Encoder HW del navegador (NVENC/AMF/QSV) | Encoder software |
| Cuantización + LZW del GIF | Web Worker (CPU, sin bloquear la UI) | Hilo principal |

## 🏗️ Arquitectura modular

Sin monolitos. Cada módulo tiene una única responsabilidad y funciona en
navegador (y varios también en Node para los tests):

```
daemon/
  server.mjs                   estudio + microservicio local :3370 (HTTP, SSE /events, WS /ws/capture, Range 206)
  pipeline/videoPipeline.mjs   FFmpeg NVENC/AMF/x264 transcode, trim sin pérdida, streaming a disco y render
  synkronia/wsServer.mjs       servidor WebSocket RFC 6455 sin dependencias externas
js/
  audio-mixer.js    mezclador Web Audio (sistema + micrófono + vúmetros RMS)
  capabilities.js   detección de GPU/códecs/workers/WebCodecs
  comparator.js     comparador visual dividido Antes/Después para vídeo e imagen
  gif-encoder.js    codificador GIF89a puro (median-cut + LZW + delta frugal)
  lanczos.js        resampler Lanczos-3 en CPU
  lanczos-gl.js     resampler Lanczos-3 en GPU (WebGL, 2-pass)
  scaler.js         fachada híbrida GPU/CPU/nativo
  transcoder.js     re-encode real (WebCodecs VP8 rápido / MediaRecorder) + toGIF con recorte
  compressor.js     compresor inteligente con estimador de presupuesto (< 15MB, < 8MB, < 2MB)
  svg-vector.js     vectorizador de imagen a <path> SVG real y SMIL flip-book para vídeo/canvas
  gif.worker.js     encode GIF fuera del hilo principal
  upskaletor.js     upscale Lanczos real (imagen y vídeo) / handoff honesto de IA
  vault.js          capa IndexedDB local-first y referencias ligeras a disco
  capture.js        captura de pantalla + escenas benchmark + streaming WebSocket
  daemon-bridge.js  puente cliente a daemon :3370 (SSE, Trim, WebSocket)
  app.js            orquestación de Stage, Trim Dock y flujo en 1 clic
css/  hud.css · fonts.css
fonts/ orbitron.woff2 · firacode.woff2 · inter.woff2  (subset latin, ~96 KB)
```

## Motores independientes

- **KAPTURA / CHRONO** captura, transcodifica y conserva el master localmente.
- **UPSKALETOR-by-Ethernium** es un compañero privado opcional que ejecuta el
  escalado neuronal (Real-ESRGAN) en su propio repositorio, instalador, CI y
  releases firmadas. La pestaña UPSKALETOR hace un traspaso explícito para
  operadores autorizados; KAPTURA público funciona sin ese repositorio mediante
  sus perfiles matemáticos Lanczos y su transcodificación nativa.

---

## 🚀 Uso rápido

1. **Con GPU Daemon local (recomendado):** ejecuta `npm run daemon` (o `KAPTURA.cmd` en Windows) y abre `http://127.0.0.1:3370/`.
2. **Solo navegador estático:** `python -m http.server` (o `npm run serve`) y abre `http://localhost:8000/`. *(Abrir `index.html` vía `file://` puede limitar Web Workers.)*
3. Usa **🖥️ Grabar Pantalla / Ventana** o **📂 Abrir Vídeo en Stage**, ajusta audio del sistema/micrófono y graba.
4. Al detener o abrir un vídeo, reprodúcelo y recórtalo en el propio Stage (**✂️ TRIM FAST**) o envíalo en 1 clic a **Cinema GIF**, **Compresor**, **V-Converter** o **Upskaletor**.

## ⚡ Modo Dual Híbrido v3.0 (Browser + GPU Daemon `:3370`)

KAPTURA v3.0 unifica el estudio estático de navegador con el microservicio local **`daemon/server.mjs` (`127.0.0.1:3370`)**:
- **Sin servidor (GitHub Pages / estático):** 100% en navegador (`MediaRecorder`, `WebCodecs` VP8 acelerado para WebM, Lanczos CPU/WebGL, GIF89a, SVG Vector, Bóveda IndexedDB y comparador A/B).
- **Con daemon local (`npm run daemon` o `KAPTURA.cmd`):** descubre `ffmpeg` y códecs por hardware (`h264_nvenc` / `h264_amf` / `h264_qsv` / fallback `libx264`), captura directa a disco por WebSocket (`/ws/capture`) sin límite de RAM, recorte rápido (`/trim`), progreso frame a frame vía SSE (`/events`), `HTTP Range 206` en `/exports/*` y telemetría **EBWP 32-byte + HLC** (`/health`, `/status`, `/telemetry/ebwp`). Si `ffmpeg` no está presente, la interfaz lo reporta sin simular resultados.

## 🧪 Tests

```bash
npm run daemon                     # inicia Studio + GPU Daemon en http://127.0.0.1:3370
npm test                           # suite completa de tests (incluye daemon, WS, SSE, Range y EBWP)
python tests/validate_kaptura.py   # contrato estático del producto
python scripts/build_release.py    # genera paquete portátil limpio en dist/
```

---
<sub>KAPTURA by Ethernium — Local-First Capture & Transcoding Studio.</sub>
