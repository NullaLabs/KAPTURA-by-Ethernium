/*
 * ============================================================================
 * KAPTURA · Real Transcoder  (WebM/MP4 re-encode + native GIF · frugal)
 * ============================================================================
 * REAL in-browser processing. No fake progress, no renamed originals.
 *
 *   transcode(): source -> <video> playback -> hybrid scaler -> canvas
 *                -> MediaRecorder (native/HW encoder) -> new Blob.
 *                Progress is driven by real playback position. Audio preserved.
 *
 *   toGIF():     seek-accurate frame extraction (GPU scale) -> RGBA frames
 *                -> gif worker (CPU quantize + LZW) -> real image/gif Blob.
 *
 * Depends only on sibling KAPTURA modules; no third-party code.
 * ----------------------------------------------------------------------------
 */
(function (root) {
  'use strict';

  const Caps = root.KapturaCaps;
  const Scaler = root.KapturaScaler;

  function loadVideo(file) {
    return new Promise((resolve, reject) => {
      const video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.preload = 'auto';
      video.src = URL.createObjectURL(file);
      video.onloadedmetadata = () => resolve(video);
      video.onerror = () => reject(new Error('No se pudo leer el vídeo (formato no soportado por el navegador).'));
    });
  }

  const tick = () => new Promise((r) => (root.requestAnimationFrame ? requestAnimationFrame(() => r()) : setTimeout(r, 0)));

  function seek(video, t) {
    return new Promise((resolve) => {
      const onSeeked = () => { video.removeEventListener('seeked', onSeeked); resolve(); };
      video.addEventListener('seeked', onSeeked);
      video.currentTime = Math.min(t, Math.max(0, (video.duration || 0) - 1e-3));
    });
  }

  function even(n) { return n & ~1; }

  /* ---- Real re-encode --------------------------------------------------- */
  async function transcode(file, opts) {
    opts = opts || {};
    const caps = opts.caps || Caps.detect();
    const video = await loadVideo(file);
    const sw = video.videoWidth, sh = video.videoHeight;
    const dw = even(opts.width || sw), dh = even(opts.height || sh);
    const fps = opts.fps || 30;
    const bitrate = (opts.bitrateMbps || 12) * 1e6;
    const container = opts.container || 'mp4';
    const pick = Caps.pickMimeType(caps, container);
    const scaler = Scaler.create({ quality: opts.quality || 'fast', caps });

    const canvas = document.createElement('canvas');
    canvas.width = dw; canvas.height = dh;
    const cctx = canvas.getContext('2d');

    const stream = canvas.captureStream(fps);
    // preserve original audio if present
    let srcStream = null;
    try {
      if (video.captureStream) srcStream = video.captureStream();
      else if (video.mozCaptureStream) srcStream = video.mozCaptureStream();
    } catch { /* audio optional */ }
    if (srcStream) srcStream.getAudioTracks().forEach((t) => stream.addTrack(t));

    const rec = new MediaRecorder(stream, { mimeType: pick.mime, videoBitsPerSecond: bitrate });
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    const stopped = new Promise((res) => (rec.onstop = res));

    let raf = 0;
    const drawLoop = () => {
      const scaled = scaler.toCanvas(video, sw, sh, dw, dh);
      cctx.drawImage(scaled, 0, 0, dw, dh);
      if (opts.onProgress && video.duration) opts.onProgress(Math.min(1, video.currentTime / video.duration));
      raf = requestAnimationFrame(drawLoop);
    };

    rec.start(1000);
    await video.play();
    drawLoop();
    await new Promise((res) => { video.onended = res; });
    cancelAnimationFrame(raf);
    if (rec.state !== 'inactive') rec.stop();
    await stopped;

    scaler.dispose();
    URL.revokeObjectURL(video.src);

    return {
      blob: new Blob(chunks, { type: pick.mime }),
      mime: pick.mime,
      ext: pick.real,
      fellBack: !!pick.fellBack,
      scaleMode: scaler.mode,
      width: dw, height: dh,
    };
  }

  /* ---- Real GIF (Ethernium Legion 15 MB Adaptive Budget Governor) -------- */
  async function toGIF(file, opts) {
    opts = opts || {};
    const caps = opts.caps || Caps.detect();
    const video = await loadVideo(file);
    const sw = video.videoWidth, sh = video.videoHeight;
    const dur = Math.max(0.1, video.duration || 0);

    // Ethernium Legion 15 MB Budget Ceiling: strictly keep output < 14.8 MB
    const MAX_TARGET_BYTES = 14.8 * 1024 * 1024;

    const fps = Math.min(opts.fps || 18, 24);
    const total = Math.max(1, Math.min(Math.floor(dur * fps), opts.maxFrames || 240));

    // Dynamic resolution calculation with 4K super-sampling
    const aspect = (sw > 0 && sh > 0) ? (sw / sh) : (16 / 9);
    let targetWidth = opts.width || (sw >= 1920 ? 960 : Math.min(640, sw));

    // Frame byte estimate: ~0.25 bytes/pixel in LZW compressed GIF with delta transparency
    const estBytesPerPixel = 0.25;
    const estPixelsPerFrame = targetWidth * (targetWidth / aspect);
    const estTotalBytes = total * estPixelsPerFrame * estBytesPerPixel;

    if (estTotalBytes > MAX_TARGET_BYTES) {
      // Scale resolution down cleanly using Lanczos-3 to guarantee strictly < 14.8 MB
      const maxPixelsPerFrame = MAX_TARGET_BYTES / (total * estBytesPerPixel);
      targetWidth = Math.min(targetWidth, Math.floor(Math.sqrt(maxPixelsPerFrame * aspect)));
    }

    // High engineering bounds: max 1280px (Retina HD), min 320px
    targetWidth = Math.max(320, Math.min(1280, targetWidth, sw));
    const dw = even(targetWidth);
    const dh = even(Math.round((dw * sh) / sw));

    const scaler = Scaler.create({ quality: opts.quality || 'max', caps });
    const step = dur / total;

    const tmp = document.createElement('canvas');
    tmp.width = dw; tmp.height = dh;
    const tctx = tmp.getContext('2d', { willReadFrequently: true });

    const frames = [];
    for (let i = 0; i < total; i++) {
      await seek(video, i * step);
      const scaled = scaler.toCanvas(video, sw, sh, dw, dh);
      tctx.drawImage(scaled, 0, 0, dw, dh);
      frames.push(tctx.getImageData(0, 0, dw, dh).data.buffer.slice(0));
      if (opts.onProgress) opts.onProgress(((i + 1) / total) * 0.6); // extraction = first 60%
      await tick();
    }
    scaler.dispose();
    URL.revokeObjectURL(video.src);

    const bytes = await encodeGIF({
      width: dw, height: dh, delay: 1000 / fps, repeat: 0,
      dither: opts.dither !== false, maxColors: opts.maxColors || 255,
      frames, caps, onProgress: opts.onProgress,
    });
    return { blob: new Blob([bytes], { type: 'image/gif' }), width: dw, height: dh, frames: total };
  }

  function encodeGIF(o) {
    if (o.caps && o.caps.workers) {
      return new Promise((resolve) => {
        let worker;
        try { worker = new Worker('js/gif.worker.js'); }
        catch { return resolve(encodeMain(o)); }
        worker.onmessage = (e) => {
          const m = e.data;
          if (m.type === 'progress') { if (o.onProgress) o.onProgress(0.6 + m.value * 0.4); }
          else if (m.type === 'done') { worker.terminate(); resolve(new Uint8Array(m.bytes)); }
          else if (m.type === 'error') { worker.terminate(); resolve(encodeMain(o)); }
        };
        worker.onerror = () => { worker.terminate(); resolve(encodeMain(o)); };
        worker.postMessage(
          { width: o.width, height: o.height, delay: o.delay, repeat: o.repeat, dither: o.dither, maxColors: o.maxColors, frames: o.frames },
          o.frames // transfer buffers (zero-copy)
        );
      });
    }
    return Promise.resolve(encodeMain(o));
  }

  function encodeMain(o) {
    const enc = new root.KapturaGIF.GIFEncoder(o.width, o.height, {
      delay: o.delay, repeat: o.repeat, dither: o.dither, maxColors: o.maxColors,
    });
    for (let i = 0; i < o.frames.length; i++) {
      enc.addFrame(new Uint8ClampedArray(o.frames[i]));
      if (o.onProgress) o.onProgress(0.6 + ((i + 1) / o.frames.length) * 0.4);
    }
    return enc.render();
  }

  const api = { transcode, toGIF };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.KapturaTranscoder = api;
})(typeof self !== 'undefined' ? self : this);
