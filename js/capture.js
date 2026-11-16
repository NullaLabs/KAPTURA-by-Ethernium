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
    let audioMixer = root.KapturaAudioMixer ? root.KapturaAudioMixer.createMixer() : null;
    let activeWsSession = null;
    let framePipeTimer = null;
    let watchdogTimer = null;
    let previewObjectUrl = null;

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
        const numPairs = 72;
        const radius = H * 0.195;
        const length = W * 1.05;
        const startX = -W * 0.025;
        const nodeScale = Math.max(0.75, H / 1080);

        // Dual continuous translucent DNA backbone ribbons edge-to-edge
        for (let strand = 0; strand < 2; strand++) {
          ctx.beginPath();
          const phaseOffset = strand === 0 ? 0 : Math.PI;
          for (let s = 0; s <= 120; s++) {
            const frac = s / 120;
            const x = startX + frac * length;
            const y = cy + Math.sin(frac * Math.PI * 6.5 + helixAngle + phaseOffset) * radius;
            if (s === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          }
          ctx.lineWidth = Math.max(2, 4.2 * nodeScale);
          ctx.strokeStyle = strand === 0 ? 'rgba(0, 255, 157, 0.34)' : 'rgba(139, 92, 246, 0.36)';
          ctx.stroke();
        }

        for (let i = 0; i <= numPairs; i++) {
          const frac = i / numPairs;
          const offset = frac * Math.PI * 6.5 + helixAngle;
          const x = startX + frac * length;
          const y1 = cy + Math.sin(offset) * radius;
          const y2 = cy + Math.sin(offset + Math.PI) * radius;
          const z1 = Math.cos(offset), z2 = Math.cos(offset + Math.PI);
          ctx.beginPath(); ctx.moveTo(x, y1); ctx.lineTo(x, y2);
          ctx.lineWidth = Math.max(2, (4.2 + z1 * 2.2) * nodeScale);
          ctx.strokeStyle = `rgba(0, 240, 255, ${0.42 + z1 * 0.34})`;
          ctx.stroke();

          const r1 = Math.max(4, (14 + z1 * 6) * nodeScale);
          if (z1 > 0.25) {
            ctx.beginPath(); ctx.arc(x, y1, r1 * 1.75, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(0, 255, 157, 0.16)'; ctx.fill();
          }
          ctx.beginPath(); ctx.arc(x, y1, r1, 0, Math.PI * 2);
          ctx.fillStyle = '#00FF9D'; ctx.fill();

          const r2 = Math.max(4, (14 + z2 * 6) * nodeScale);
          if (z2 > 0.25) {
            ctx.beginPath(); ctx.arc(x, y2, r2 * 1.75, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(139, 92, 246, 0.18)'; ctx.fill();
          }
          ctx.beginPath(); ctx.arc(x, y2, r2, 0, Math.PI * 2);
          ctx.fillStyle = '#9D6CFF'; ctx.fill();
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
      if (sceneMode !== 'screen' && sceneMode !== 'playback') requestAnimationFrame(drawScene);
    }

    function setMode(mode) {
      const wasScene = sceneMode !== 'screen' && sceneMode !== 'playback';
      sceneMode = mode;
      if (mode === 'screen') {
        if (previewObjectUrl) { URL.revokeObjectURL(previewObjectUrl); previewObjectUrl = null; }
        video.controls = false;
        video.muted = true;
        video.removeAttribute('src');
        video.srcObject = mediaStream;
        video.play().catch(() => {});
        canvas.style.display = 'none'; video.style.display = 'block';
        emit('onSourceMode', 'EXTERNAL SCREEN / TAB CAPTURE');
      } else if (mode === 'playback') {
        canvas.style.display = 'none'; video.style.display = 'block';
        emit('onSourceMode', 'STAGE PLAYBACK / TRIM');
      } else {
        if (previewObjectUrl) { URL.revokeObjectURL(previewObjectUrl); previewObjectUrl = null; }
        video.pause();
        video.srcObject = null;
        video.removeAttribute('src');
        canvas.style.display = 'block'; video.style.display = 'none';
        emit('onSourceMode', 'TEST SIGNAL: ' + mode.toUpperCase());
        if (wasScene) return; // loop already running for scene modes
        requestAnimationFrame(drawScene);
      }
    }

    function showPlayback(source) {
      if (previewObjectUrl) { URL.revokeObjectURL(previewObjectUrl); previewObjectUrl = null; }
      video.srcObject = null;
      if (typeof source === 'string') {
        video.src = source;
      } else if (source instanceof Blob) {
        previewObjectUrl = URL.createObjectURL(source);
        video.src = previewObjectUrl;
      }
      video.muted = false;
      video.controls = true;
      setMode('playback');
      video.play().catch(() => {});
    }

    async function selectSource(fps) {
      try {
        mediaStream = await navigator.mediaDevices.getDisplayMedia({
          video: { width: { ideal: 3840, max: 3840 }, height: { ideal: 2160, max: 2160 }, frameRate: { ideal: fps, max: fps } },
          audio: { echoCancellation: false, noiseSuppression: false },
        });
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

    function clearRecordingTimers() {
      if (recTimer) { clearInterval(recTimer); recTimer = null; }
      if (framePipeTimer) { clearInterval(framePipeTimer); framePipeTimer = null; }
      if (watchdogTimer) { clearTimeout(watchdogTimer); watchdogTimer = null; }
    }

    async function startRecording(opts) {
      opts = opts || {};
      const caps = opts.caps || Caps.detect();
      const fps = opts.fps || 60;
      const requestedMbps = opts.bitrateMbps || 50;
      const targetContainer = opts.container || 'mp4';
      const bitrate = sceneMode === 'screen' ? requestedMbps * 1e6 : safeCanvasBitrateBps(requestedMbps, canvas.width);
      const pick = Caps.pickMimeType(caps, targetContainer);

      const baseVideoStream = (sceneMode === 'screen' && mediaStream)
        ? mediaStream
        : canvas.captureStream(fps);
      const composedStream = new MediaStream(baseVideoStream.getVideoTracks());

      if (audioMixer) {
        try {
          await audioMixer.attach({
            displayStream: sceneMode === 'screen' ? mediaStream : null,
            micEnabled: Boolean(opts.micEnabled),
            systemMuted: Boolean(opts.systemMuted),
          });
          audioMixer.getOutputTracks().forEach((t) => composedStream.addTrack(t));
        } catch {}
      } else if (sceneMode === 'screen' && mediaStream && !opts.systemMuted) {
        mediaStream.getAudioTracks().forEach((t) => composedStream.addTrack(t));
      }

      const Daemon = root.KapturaDaemon;
      const canStreamDaemon = Boolean(
        opts.streamToDaemon !== false && Daemon && Daemon.isReadyForTranscode() && typeof Daemon.openCaptureSocket === 'function'
      );

      let wsSession = null;
      let streamedBytes = 0;
      let usingFramePipe = false;

      if (canStreamDaemon) {
        try {
          wsSession = await Daemon.openCaptureSocket({
            mode: 'pipe-media',
            inputExt: pick.real === 'mp4' ? '.mp4' : '.webm',
            fps,
            container: targetContainer === 'webm' ? 'webm' : 'mp4',
            bitrateMbps: Math.round(bitrate / 1e6),
            quality: 'high',
            onAck: (ack) => {
              emit('onSize', `${(ack.bytesReceived / (1024 * 1024)).toFixed(1)} [DISK]`);
            },
            onProgress: (frac, meta) => emit('onProgress', { value: frac, meta }),
          });
          activeWsSession = wsSession;
        } catch {
          wsSession = null;
          activeWsSession = null;
        }
      }

      const startUiTelemetryTimer = () => {
        if (recTimer) clearInterval(recTimer);
        const startFrame = frameCount;
        recTimer = setInterval(() => {
          const s = Math.floor((Date.now() - recStart) / 1000);
          emit('onTimer', {
            text: `REC ${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`,
            frames: frameCount - startFrame,
          });
          if (audioMixer) emit('onAudioLevels', audioMixer.getLevels());
        }, 100);
      };

      const startFramePipeFallback = async () => {
        if (!canStreamDaemon || usingFramePipe) return false;
        usingFramePipe = true;
        clearRecordingTimers();
        if (recorder && recorder.state !== 'inactive') {
          try { recorder.onstop = null; recorder.ondataavailable = null; recorder.stop(); } catch {}
        }
        if (wsSession) { try { wsSession.abort(); } catch {} wsSession = null; }

        try {
          wsSession = await Daemon.openCaptureSocket({
            mode: 'pipe-frames',
            fps: Math.min(30, fps),
            container: targetContainer === 'webm' ? 'webm' : 'mp4',
            bitrateMbps: Math.round(bitrate / 1e6),
            quality: 'high',
            onAck: (ack) => {
              emit('onSize', `${(ack.bytesReceived / (1024 * 1024)).toFixed(1)} [NVENC]`);
            },
            onProgress: (frac, meta) => emit('onProgress', { value: frac, meta }),
          });
          activeWsSession = wsSession;
        } catch (err) {
          emit('onError', 'Fallback frame pipe :3370 falló: ' + (err && err.message || err));
          return false;
        }

        const safePipeFps = Math.min(30, fps);
        let busyFrame = false;
        framePipeTimer = setInterval(() => {
          if (busyFrame || !activeWsSession) return;
          busyFrame = true;
          canvas.toBlob((blob) => {
            busyFrame = false;
            if (blob && activeWsSession) {
              streamedBytes += blob.size;
              activeWsSession.sendChunk(blob);
            }
          }, 'image/jpeg', 0.88);
        }, Math.max(28, Math.round(1000 / safePipeFps)));

        startUiTelemetryTimer();
        emit('onNotice', 'Conmutado automáticamente a Pipe Directo MJPEG -> NVENC (:3370).');
        return true;
      };

      try {
        recorder = new MediaRecorder(composedStream, { mimeType: pick.mime, videoBitsPerSecond: bitrate });
      } catch (e) {
        if (wsSession) { wsSession.abort(); activeWsSession = null; }
        if (audioMixer) audioMixer.destroy();
        emit('onError', 'El navegador no soporta la grabación en el formato pedido: ' + pick.mime);
        return false;
      }

      chunks = [];
      let mediaBytesSeen = 0;
      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size) {
          mediaBytesSeen += e.data.size;
          if (activeWsSession && !usingFramePipe) {
            streamedBytes += e.data.size;
            activeWsSession.sendChunk(e.data);
            emit('onSize', `${(streamedBytes / (1024 * 1024)).toFixed(1)} [STREAM]`);
          } else {
            chunks.push(e.data);
            const total = chunks.reduce((a, c) => a + c.size, 0);
            emit('onSize', (total / (1024 * 1024)).toFixed(1));
          }
        }
      };

      recorder.onstop = () => finishRecording(pick);
      recStart = Date.now();
      recorder.start(250);
      startUiTelemetryTimer();

      if (canStreamDaemon && sceneMode !== 'screen' && sceneMode !== 'playback') {
        watchdogTimer = setTimeout(() => {
          if (mediaBytesSeen === 0 && activeWsSession && !usingFramePipe) {
            startFramePipeFallback();
          }
        }, 900);
      }

      emit('onRecordingState', true);
      if (wsSession) {
        emit('onNotice', 'Streaming directo a disco (:3370 NVENC) activo — cero límite de RAM.');
      } else if (pick.fellBack) {
        emit('onNotice', 'MP4 no está disponible en este navegador; grabando en WebM (VP9) real.');
      }
      return true;
    }

    async function stopRecording() {
      clearRecordingTimers();
      if (activeWsSession && framePipeTimer === null && recorder && recorder.state !== 'inactive') {
        try { recorder.requestData(); } catch {}
        recorder.stop();
        return;
      }
      if (activeWsSession) {
        await finalizeWsOnlyStop();
        return;
      }
      if (!recorder || recorder.state === 'inactive') return;
      try { recorder.requestData(); } catch { /* optional */ }
      recorder.stop();
    }

    async function finalizeWsOnlyStop() {
      const ws = activeWsSession;
      activeWsSession = null;
      if (audioMixer) audioMixer.destroy();
      emit('onRecordingState', false);
      if (!ws) return;
      emit('onNotice', 'Finalizando MP4 en GPU (:3370)...');
      try {
        const res = await ws.stop();
        if (!res || !res.success || !res.remoteUrl) {
          emit('onError', (res && res.error) || 'No se pudo finalizar el stream de captura.');
          return;
        }
        emit('onStop', {
          blob: null,
          remoteUrl: res.remoteUrl,
          outputFile: res.outputFile,
          sizeBytes: res.sizeBytes,
          mime: res.outputFile && res.outputFile.endsWith('.webm') ? 'video/webm' : 'video/mp4',
          ext: res.outputFile && res.outputFile.endsWith('.webm') ? 'webm' : 'mp4',
          duration: res.duration || Math.max(1, Math.floor((Date.now() - recStart) / 1000)),
          codec: res.codec || 'h264_nvenc',
          hardwareAccelerated: Boolean(res.hardwareAccelerated),
          streamedToDisk: true,
        });
      } catch (err) {
        emit('onError', err && err.message || String(err));
      }
    }

    async function finishRecording(pick) {
      clearRecordingTimers();
      if (audioMixer) audioMixer.destroy();

      if (activeWsSession) {
        await finalizeWsOnlyStop();
        return;
      }

      const mime = recorder.mimeType || pick.mime;
      const ext = mime.includes('mp4') ? 'mp4' : 'webm';
      const duration = Math.max(1, Math.floor((Date.now() - recStart) / 1000));
      const totalBytes = chunks.reduce((a, c) => a + (c ? c.size : 0), 0);
      emit('onRecordingState', false);
      if (totalBytes === 0) {
        emit('onError', 'El codificador MediaRecorder del navegador devolvió 0 bytes. Activa Daemon :3370 o cambia a WebM (VP9).');
        return;
      }
      const blob = new Blob(chunks, { type: mime });
      chunks = [];
      emit('onStop', { blob, mime, ext, duration });
    }

    function pad(n) { return String(n).padStart(2, '0'); }

    // boot the scene loop
    requestAnimationFrame(drawScene);

    return {
      setMode, selectSource, showPlayback, startRecording, stopRecording,
      setAudioMixerGains: (sys, mic) => {
        if (audioMixer) {
          audioMixer.setSystemGain(sys);
          audioMixer.setMicGain(mic);
        }
      },
      get mode() { return sceneMode; },
      get fps() { return measuredFps; },
      hasStream: () => !!mediaStream,
    };
  }

  const api = { create };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.KapturaCapture = api;
})(typeof self !== 'undefined' ? self : this);
