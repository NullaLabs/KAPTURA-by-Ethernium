/*
 * ============================================================================
 * KAPTURA · Capture Engine  (canvas scenes + screen capture + recording)
 * ============================================================================
 * Honest telemetry: FPS is MEASURED, not asserted. The recorder reports the
 * codec the browser actually used. Source-selection errors surface to the UI
 * instead of dying in the console.
 * ----------------------------------------------------------------------------
 */
(function (root) {
  'use strict';

  const Caps = root.KapturaCaps;

  function create(cfg) {
    const canvas = cfg.canvas;
    const video = cfg.video;
    const ctx = canvas.getContext('2d', { alpha: false });
    const cb = cfg.callbacks || {};
    const emit = (name, v) => { if (typeof cb[name] === 'function') cb[name](v); };

    let sceneMode = 'dna';
    let mediaStream = null;
    let recorder = null;
    let chunks = [];
    let recStart = 0;
    let recTimer = null;
    let frameCount = 0;

    // --- real FPS meter (frames counted over a sliding 1s window) ---
    let fpsWindow = [];
    let measuredFps = 0;

    // scene state
    let helixAngle = 0;
    const matrixDrops = [];

    function drawScene(now) {
      // fps measurement
      fpsWindow.push(now);
      while (fpsWindow.length && now - fpsWindow[0] > 1000) fpsWindow.shift();
      measuredFps = fpsWindow.length;

      const W = canvas.width, H = canvas.height;
      const cx = W / 2, cy = H / 2;

      if (sceneMode === 'dna') {
        ctx.fillStyle = 'rgba(2, 3, 5, 0.25)'; ctx.fillRect(0, 0, W, H);
        helixAngle += 0.025;
        const numPairs = 45, radius = H * 0.21, length = W * 0.62;
        const nodeScale = Math.max(0.45, H / 1440);
        for (let i = 0; i < numPairs; i++) {
          const offset = (i / numPairs) * Math.PI * 6 + helixAngle;
          const x = cx - length / 2 + (i / numPairs) * length;
          const y1 = cy + Math.sin(offset) * radius;
          const y2 = cy + Math.sin(offset + Math.PI) * radius;
          const z1 = Math.cos(offset), z2 = Math.cos(offset + Math.PI);
          ctx.beginPath(); ctx.moveTo(x, y1); ctx.lineTo(x, y2);
          ctx.lineWidth = Math.max(1.5, (3 + z1 * 1.5) * nodeScale);
          ctx.strokeStyle = `rgba(0, 240, 255, ${0.42 + z1 * 0.3})`;
          ctx.stroke();

          const r1 = Math.max(3, (12 + z1 * 5) * nodeScale);
          ctx.beginPath(); ctx.arc(x, y1, r1, 0, Math.PI * 2);
          ctx.fillStyle = '#00FF9D'; ctx.fill();

          const r2 = Math.max(3, (12 + z2 * 5) * nodeScale);
          ctx.beginPath(); ctx.arc(x, y2, r2, 0, Math.PI * 2);
          ctx.fillStyle = '#8B5CF6'; ctx.fill();
        }
      } else if (sceneMode === 'binary') {
        ctx.fillStyle = 'rgba(1, 2, 4, 0.16)'; ctx.fillRect(0, 0, W, H);
        const fontPx = Math.max(16, Math.round(H * 0.026));
        const cols = Math.max(24, Math.floor(W / fontPx));
        if (matrixDrops.length !== cols) {
          matrixDrops.length = cols;
          for (let k = 0; k < cols; k++) if (matrixDrops[k] === undefined) matrixDrops[k] = Math.floor(Math.random() * 20);
        }
        ctx.font = `${fontPx}px "Fira Code", monospace`;
        ctx.fillStyle = '#00FF9D';
        for (let i = 0; i < cols; i++) {
          const char = String.fromCharCode(0x30 + Math.floor(Math.random() * 2));
          const x = i * (W / cols), y = matrixDrops[i] * (fontPx * 1.25);
          ctx.fillText(char, x, y);
          if (y > H && Math.random() > 0.965) matrixDrops[i] = 0;
          matrixDrops[i]++;
        }
      } else if (sceneMode === 'fibonacci') {
        ctx.fillStyle = 'rgba(1, 2, 4, 0.14)'; ctx.fillRect(0, 0, W, H);
        const a = Math.max(5, H * 0.009), b = 0.175, t = frameCount / 60;
        const dotScale = Math.max(0.45, H / 1440);
        for (let i = 0; i < 320; i++) {
          const theta = i * 0.11 + t * 0.55;
          const r = a * Math.exp(b * (i * 0.1));
          const x = cx + r * Math.cos(theta), y = cy + r * Math.sin(theta);
          ctx.beginPath(); ctx.arc(x, y, Math.max(2, (4 + i * 0.04) * dotScale), 0, Math.PI * 2);
          ctx.fillStyle = `hsl(${(i * 4 + t * 50) % 360}, 100%, 62%)`;
          ctx.fill();
        }
      }

      // HONEST overlay on opaque backdrop so trailing frames never smear the digits
      const osdFont = Math.max(16, Math.round(H * 0.024));
      const padX = Math.max(20, Math.round(W * 0.018));
      const padY = Math.max(36, Math.round(H * 0.05));
      const osdText = `ETHERNIUM // ${W}x${H} @ ${measuredFps} FPS (measured)`;
      ctx.font = `700 ${osdFont}px "Orbitron", monospace`;
      const tw = ctx.measureText(osdText).width;
      ctx.fillStyle = 'rgba(2, 4, 10, 0.92)';
      ctx.fillRect(padX - 10, padY - osdFont - 6, tw + 20, osdFont + 16);
      ctx.fillStyle = '#FFFFFF';
      ctx.fillText(osdText, padX, padY);

      frameCount++;
      emit('onFps', measuredFps);
      if (sceneMode !== 'screen') requestAnimationFrame(drawScene);
    }

    function setMode(mode) {
      const wasScene = sceneMode !== 'screen';
      sceneMode = mode;
      if (mode === 'screen') {
        canvas.style.display = 'none'; video.style.display = 'block';
        emit('onSourceMode', 'EXTERNAL SCREEN / TAB CAPTURE');
      } else {
        canvas.style.display = 'block'; video.style.display = 'none';
        emit('onSourceMode', 'CANVAS ENGINE: ' + mode.toUpperCase());
        if (wasScene) return; // loop already running for scene modes
        requestAnimationFrame(drawScene);
      }
    }

    async function selectSource(fps) {
      try {
        mediaStream = await navigator.mediaDevices.getDisplayMedia({
          video: { width: { ideal: 3840, max: 3840 }, height: { ideal: 2160, max: 2160 }, frameRate: { ideal: fps, max: fps } },
          audio: { echoCancellation: false, noiseSuppression: false },
        });
        video.srcObject = mediaStream;
        setMode('screen');
        mediaStream.getVideoTracks()[0].onended = () => { mediaStream = null; setMode('dna'); };
        emit('onSourceReady', true);
      } catch (err) {
        const msg = err && err.name === 'NotAllowedError'
          ? 'Captura de pantalla cancelada o denegada por el navegador.'
          : 'No se pudo iniciar la captura de pantalla: ' + (err && err.message || err);
        emit('onError', msg);
      }
    }

    function safeCanvasBitrateBps(requestedMbps, width) {
      const capMbps = width >= 3840 ? 45 : (width >= 1920 ? 25 : 14);
      return Math.max(1, Math.min(Number(requestedMbps) || 16, capMbps)) * 1e6;
    }

    function startRecording(opts) {
      opts = opts || {};
      const caps = opts.caps || Caps.detect();
      const fps = opts.fps || 60;
      const requestedMbps = opts.bitrateMbps || 50;
      const bitrate = sceneMode === 'screen' ? requestedMbps * 1e6 : safeCanvasBitrateBps(requestedMbps, canvas.width);
      const pick = Caps.pickMimeType(caps, opts.container || 'mp4');

      const streamToRecord = (sceneMode === 'screen' && mediaStream)
        ? mediaStream
        : canvas.captureStream(fps);

      try {
        recorder = new MediaRecorder(streamToRecord, { mimeType: pick.mime, videoBitsPerSecond: bitrate });
      } catch (e) {
        emit('onError', 'El navegador no soporta la grabación en el formato pedido: ' + pick.mime);
        return false;
      }

      chunks = [];
      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size) {
          chunks.push(e.data);
          const total = chunks.reduce((a, c) => a + c.size, 0);
          emit('onSize', (total / (1024 * 1024)).toFixed(1));
        }
      };
      recorder.onstop = () => finishRecording(pick);
      recorder.start(250);

      recStart = Date.now();
      const startFrame = frameCount;
      recTimer = setInterval(() => {
        const s = Math.floor((Date.now() - recStart) / 1000);
        emit('onTimer', {
          text: `REC ${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`,
          frames: frameCount - startFrame,
        });
      }, 100);

      emit('onRecordingState', true);
      if (pick.fellBack) emit('onNotice', 'MP4 no está disponible en este navegador; grabando en WebM (VP9) real.');
      return true;
    }

    function stopRecording() {
      if (!recorder || recorder.state === 'inactive') return;
      try { recorder.requestData(); } catch { /* optional */ }
      recorder.stop();
    }

    function finishRecording(pick) {
      clearInterval(recTimer);
      const mime = recorder.mimeType || pick.mime;
      const ext = mime.includes('mp4') ? 'mp4' : 'webm';
      const duration = Math.max(1, Math.floor((Date.now() - recStart) / 1000));
      const totalBytes = chunks.reduce((a, c) => a + (c ? c.size : 0), 0);
      emit('onRecordingState', false);
      if (totalBytes === 0) {
        emit('onError', 'El codificador MediaRecorder del navegador devolvió 0 bytes. Cambia a WebM (VP9) / menor FPS o usa RENDER GPU (:3370).');
        return;
      }
      const blob = new Blob(chunks, { type: mime });
      emit('onStop', { blob, mime, ext, duration });
    }

    function pad(n) { return String(n).padStart(2, '0'); }

    // boot the scene loop
    requestAnimationFrame(drawScene);

    return {
      setMode, selectSource, startRecording, stopRecording,
      get mode() { return sceneMode; },
      get fps() { return measuredFps; },
      hasStream: () => !!mediaStream,
    };
  }

  const api = { create };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.KapturaCapture = api;
})(typeof self !== 'undefined' ? self : this);
