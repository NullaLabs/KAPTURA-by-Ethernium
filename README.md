# 📹 KAPTURA by Ethernium

> **CHRONO Capture Engine · Local-first browser studio con transcodificación REAL**

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
js/
  capabilities.js   detección de GPU/códecs/workers
  gif-encoder.js    codificador GIF89a puro (median-cut + LZW)
  lanczos.js        resampler Lanczos-3 en CPU
  lanczos-gl.js     resampler Lanczos-3 en GPU (WebGL, 2-pass)
  scaler.js         fachada híbrida GPU/CPU/nativo
  transcoder.js     re-encode real + toGIF (con worker)
  gif.worker.js     encode GIF fuera del hilo principal
  upskaletor.js     upscale Lanczos real / handoff honesto de IA
  vault.js          capa IndexedDB (con manejo de cuota)
  capture.js        escenas canvas + captura de pantalla + grabación
  app.js            orquestación de UI (toasts, progreso, sin lógica de motor)
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

1. Sirve la carpeta (por los módulos y el worker): `python -m http.server` y abre
   `http://localhost:8000/` en Chrome, Edge o Brave. *(Abrir el `index.html` con
   `file://` puede bloquear el Web Worker del GIF; en ese caso cae al hilo
   principal automáticamente.)*
2. **🌐 SELECT SOURCE** para elegir pantalla/pestaña, o usa un motor Canvas.
3. Ajusta resolución, FPS, bitrate y formato.
4. **🔴 START RECORDING** → **⏹️ STOP & SAVE MASTER** (se descarga y se guarda en la Bóveda).
5. **⚡ V-CONVERTER**: arrastra un vídeo y transcodifícalo de verdad (MP4/WebM/GIF).
6. **◆ UPSKALETOR**: perfiles Lanczos se procesan aquí; el perfil IA hace handoff.

## 🧪 Tests

```bash
node tests/test_gif_encoder.js     # valida el GIF89a generado
node tests/test_lanczos.js         # valida el resampler Lanczos
python tests/validate_kaptura.py   # contrato estático del producto
```

---
<sub>Built with sovereignty by Ethernium Sovereign Agent Architecture — Nulla-Labs // Nemeth Corp.</sub>
