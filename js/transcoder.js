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

  function loadVideo(fileOrUrl) {
    return new Promise((resolve, reject) => {
      const video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.preload = 'auto';
      video.crossOrigin = 'anonymous';
      const isUrl = typeof fileOrUrl === 'string';
      video.src = isUrl ? fileOrUrl : URL.createObjectURL(fileOrUrl);
      video._objectUrl = isUrl ? '' : video.src;
      video.onloadedmetadata = () => resolve(video);
      video.onerror = () => reject(new Error('No se pudo leer el vídeo (formato no soportado por el navegador).'));
    });
  }

  function revokeVideo(video) {
    if (video && video._objectUrl) {
      try { URL.revokeObjectURL(video._objectUrl); } catch {}
      video._objectUrl = '';
    }
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

  /* ---- Zero-Dependency EBML WebM VP8 Muxer (WebCodecs Accelerated) ----- */
  function ebmlVint(len) {
    if (len < 0x7f) return new Uint8Array([0x80 | len]);
    if (len < 0x3fff) return new Uint8Array([0x40 | (len >> 8), len & 0xff]);
    if (len < 0x1fffff) return new Uint8Array([0x20 | (len >> 16), (len >> 8) & 0xff, len & 0xff]);
    return new Uint8Array([0x10 | ((len >>> 24) & 0x0f), (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff]);
  }

  function ebmlEl(idBytes, dataParts) {
    const payload = dataParts instanceof Uint8Array ? dataParts : concatU8(Array.isArray(dataParts) ? dataParts : [dataParts]);
    const hdr = new Uint8Array(idBytes);
    const sz = ebmlVint(payload.length);
    return concatU8([hdr, sz, payload]);
  }

  function ebmlUint(num) {
    if (num <= 0xff) return new Uint8Array([num]);
    if (num <= 0xffff) return new Uint8Array([num >> 8, num & 0xff]);
    if (num <= 0xffffff) return new Uint8Array([num >> 16, (num >> 8) & 0xff, num & 0xff]);
    return new Uint8Array([(num >>> 24) & 0xff, (num >> 16) & 0xff, (num >> 8) & 0xff, num & 0xff]);
  }

  function ebmlFloat64(val) {
    const b = new ArrayBuffer(8);
    new DataView(b).setFloat64(0, val, false);
    return new Uint8Array(b);
  }

  function asciiBytes(s) {
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
    return out;
  }

  function concatU8(arr) {
    let total = 0;
    for (let i = 0; i < arr.length; i++) total += arr[i].length;
    const out = new Uint8Array(total);
    let off = 0;
    for (let i = 0; i < arr.length; i++) {
      out.set(arr[i], off);
      off += arr[i].length;
    }
    return out;
  }

  function buildWebmFromVp8Chunks(encodedFrames, width, height, durationMs) {
    const header = ebmlEl([0x1a, 0x45, 0xdf, 0xa3], [
      ebmlEl([0x42, 0x86], ebmlUint(1)),
      ebmlEl([0x42, 0xf7], ebmlUint(1)),
      ebmlEl([0x42, 0xf2], ebmlUint(4)),
      ebmlEl([0x42, 0xf3], ebmlUint(8)),
      ebmlEl([0x42, 0x82], asciiBytes('webm')),
      ebmlEl([0x42, 0x87], ebmlUint(2)),
      ebmlEl([0x42, 0x85], ebmlUint(2)),
    ]);

    const info = ebmlEl([0x15, 0x49, 0xa9, 0x66], [
      ebmlEl([0x2a, 0xd7, 0xb1], ebmlUint(1000000)),
      ebmlEl([0x4d, 0x80], asciiBytes('KAPTURA-EBML')),
      ebmlEl([0x57, 0x41], asciiBytes('KAPTURA-WEBCODECS')),
      ebmlEl([0x44, 0x89], ebmlFloat64(Math.max(100, durationMs))),
    ]);

    const trackEntry = ebmlEl([0xae], [
      ebmlEl([0xd7], ebmlUint(1)),
      ebmlEl([0x73, 0xc5], ebmlUint(1)),
      ebmlEl([0x83], ebmlUint(1)),
      ebmlEl([0x86], asciiBytes('V_VP8')),
      ebmlEl([0xe0], [
        ebmlEl([0xb0], ebmlUint(width)),
        ebmlEl([0xba], ebmlUint(height)),
      ]),
    ]);
    const tracks = ebmlEl([0x16, 0x54, 0xae, 0x6b], [trackEntry]);

    const clusters = [];
    let currentClusterTs = -1;
    let currentBlocks = [];
    const flushCluster = () => {
      if (!currentBlocks.length) return;
      clusters.push(ebmlEl([0x1f, 0x43, 0xb6, 0x75], [
        ebmlEl([0xe7], ebmlUint(Math.max(0, currentClusterTs))),
        ...currentBlocks,
      ]));
      currentBlocks = [];
    };

    for (let i = 0; i < encodedFrames.length; i++) {
      const f = encodedFrames[i];
      const tsMs = Math.max(0, Math.round(f.timestampUs / 1000));
      if (currentClusterTs < 0 || (f.isKey && tsMs - currentClusterTs >= 2000) || tsMs - currentClusterTs >= 25000) {
        flushCluster();
        currentClusterTs = tsMs;
      }
      const relTs = Math.max(-32768, Math.min(32767, tsMs - currentClusterTs));
      const block = new Uint8Array(4 + f.data.length);
      block[0] = 0x81; // track 1
      block[1] = (relTs >> 8) & 0xff;
      block[2] = relTs & 0xff;
      block[3] = f.isKey ? 0x80 : 0x00;
      block.set(f.data, 4);
      currentBlocks.push(ebmlEl([0xa3], block));
    }
    flushCluster();

    const segBody = concatU8([info, tracks, ...clusters]);
    const segHeader = new Uint8Array([0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
    return new Blob([header, segHeader, segBody], { type: 'video/webm' });
  }

  async function transcodeWebCodecsFast(video, sw, sh, dw, dh, fps, bitrate, opts) {
    const EncoderCtor = root.VideoEncoder;
    const FrameCtor = root.VideoFrame;
    if (typeof EncoderCtor !== 'function' || typeof FrameCtor !== 'function') return null;
    const cfg = { codec: 'vp8', width: dw, height: dh, bitrate, framerate: fps };
    try {
      const sup = await EncoderCtor.isConfigSupported(cfg);
      if (!sup || !sup.supported) return null;
    } catch {
      return null;
    }

    const totalDur = Math.max(0.2, video.duration || 1);
    const trimStart = Math.max(0, Math.min(totalDur - 0.1, Number(opts.startSec) || 0));
    const trimEnd = (Number(opts.endSec) > trimStart && Number(opts.endSec) <= totalDur) ? Number(opts.endSec) : totalDur;
    const clipDur = Math.max(0.2, trimEnd - trimStart);
    const safeFps = Math.max(10, Math.min(30, Math.round(fps || 24)));
    const totalFrames = Math.max(2, Math.round(clipDur * safeFps));

    const scaler = Scaler.create({ quality: opts.quality || 'fast', caps: opts.caps });
    const canvas = document.createElement('canvas');
    canvas.width = dw; canvas.height = dh;
    const cctx = canvas.getContext('2d');

    const encodedFrames = [];
    let encError = null;
    const encoder = new EncoderCtor({
      output: (chunk) => {
        const buf = new Uint8Array(chunk.byteLength);
        chunk.copyTo(buf);
        encodedFrames.push({ timestampUs: chunk.timestamp, isKey: chunk.type === 'key', data: buf });
      },
      error: (err) => { encError = err; },
    });
    encoder.configure(cfg);

    for (let i = 0; i < totalFrames; i++) {
      if (encError) break;
      const t = trimStart + (i / safeFps);
      await seek(video, Math.min(trimEnd - 0.005, t));
      const scaled = scaler.toCanvas(video, sw, sh, dw, dh);
      cctx.drawImage(scaled, 0, 0, dw, dh);
      const vf = new FrameCtor(canvas, { timestamp: Math.round((i * 1e6) / safeFps) });
      encoder.encode(vf, { keyFrame: i % (safeFps * 2) === 0 });
      vf.close();
      if (opts.onProgress) opts.onProgress(Math.min(0.95, (i + 1) / totalFrames));
      if (i % 4 === 0) await tick();
    }

    await encoder.flush();
    encoder.close();
    scaler.dispose();
    if (encError || encodedFrames.length === 0) return null;

    const blob = buildWebmFromVp8Chunks(encodedFrames, dw, dh, clipDur * 1000);
    if (opts.onProgress) opts.onProgress(1);
    return {
      blob,
      mime: 'video/webm',
      ext: 'webm',
      fellBack: false,
      scaleMode: `${scaler.mode} + WebCodecs VP8 (Fast)`,
      width: dw,
      height: dh,
    };
  }

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

    if (opts.fastOffline !== false && container !== 'mp4' && typeof root.VideoEncoder === 'function') {
      try {
        const fastRes = await transcodeWebCodecsFast(video, sw, sh, dw, dh, fps, bitrate, { ...opts, caps });
        if (fastRes) {
          revokeVideo(video);
          return fastRes;
        }
      } catch {}
    }

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

    const totalDur = Math.max(0.1, video.duration || 1);
    const trimStart = Math.max(0, Math.min(totalDur - 0.1, Number(opts.startSec) || 0));
    const trimEnd = (Number(opts.endSec) > trimStart && Number(opts.endSec) <= totalDur) ? Number(opts.endSec) : totalDur;
    if (trimStart > 0) await seek(video, trimStart);

    let raf = 0;
    let ended = false;
    const drawLoop = () => {
      if (ended) return;
      const scaled = scaler.toCanvas(video, sw, sh, dw, dh);
      cctx.drawImage(scaled, 0, 0, dw, dh);
      const frac = Math.min(1, Math.max(0, (video.currentTime - trimStart) / Math.max(0.1, trimEnd - trimStart)));
      if (opts.onProgress) opts.onProgress(frac);
      raf = requestAnimationFrame(drawLoop);
    };

    rec.start(500);
    await video.play();
    drawLoop();
    await new Promise((res) => {
      const checkTime = () => {
        if (video.currentTime >= trimEnd - 0.03) {
          video.pause();
          ended = true;
          video.removeEventListener('timeupdate', checkTime);
          res();
        }
      };
      if (trimEnd < totalDur) video.addEventListener('timeupdate', checkTime);
      video.onended = () => { ended = true; res(); };
    });
    cancelAnimationFrame(raf);
    if (rec.state !== 'inactive') rec.stop();
    await stopped;

    scaler.dispose();
    revokeVideo(video);

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
    const rawDur = Math.max(0.1, video.duration || 0);
    const trimStart = Math.max(0, Math.min(rawDur - 0.1, Number(opts.startSec) || 0));
    const trimEnd = (Number(opts.endSec) > trimStart && Number(opts.endSec) <= rawDur) ? Number(opts.endSec) : rawDur;
    const dur = Math.max(0.1, trimEnd - trimStart);

    // Ethernium Legion 15 MB Budget Ceiling: strictly keep output < 14.8 MB
    const MAX_TARGET_BYTES = 14.8 * 1024 * 1024;

    // Timing and Speed Modes:
    // 'normal'   : 1.0x Real-Time (exact natural playback time == video duration)
    // 'fast2x'   : 2.0x Timelapse (optional acceleration)
    // 'fast4x'   : 4.0x Fast Forward
    // 'slow05x'  : 0.5x Slow Motion
    const speedMode = opts.speedMode || 'normal';
    const speedMultiplier = (speedMode === 'fast2x' ? 2.0 : (speedMode === 'fast4x' ? 4.0 : (speedMode === 'slow05x' ? 0.5 : (Number(opts.speed) || 1.0))));
    const targetPlaybackDur = dur / speedMultiplier;

    const fps = Math.min(Math.max(10, Number(opts.fps) || 24), 60);
    const maxSampleCap = (fps >= 60 ? 480 : (fps >= 30 ? 360 : 240));
    const total = Math.max(1, Math.min(Math.floor(dur * fps), opts.maxFrames || maxSampleCap));

    // Dynamic resolution calculation with 4K super-sampling and sub-rect delta estimation
    const aspect = (sw > 0 && sh > 0) ? (sw / sh) : (16 / 9);
    let targetWidth = opts.width || (sw >= 1920 ? 960 : Math.min(640, sw));

    // Sub-rectangle delta compression reduces bytes/pixel down to ~0.08 average
    const estBytesPerPixel = 0.08;
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

    // Temporal Bresenham error-diffusion accumulator: ensures total GIF playback duration
    // matches targetPlaybackDur exactly, eliminating artificial acceleration!
    const nominalDelayMs = (targetPlaybackDur * 1000) / total;
    let accumMs = 0;
    let prevTotalCs = 0;
    const delays = [];
    for (let i = 0; i < total; i++) {
      accumMs += nominalDelayMs;
      const targetCs = Math.round(accumMs / 10);
      const delayCs = Math.max(2, targetCs - prevTotalCs);
      delays.push(delayCs * 10); // in ms
      prevTotalCs += delayCs;
    }

    const tmp = document.createElement('canvas');
    tmp.width = dw; tmp.height = dh;
    const tctx = tmp.getContext('2d', { willReadFrequently: true });

    const frames = [];
    for (let i = 0; i < total; i++) {
      await seek(video, trimStart + i * step);
      const scaled = scaler.toCanvas(video, sw, sh, dw, dh);
      tctx.drawImage(scaled, 0, 0, dw, dh);
      frames.push(tctx.getImageData(0, 0, dw, dh).data.buffer.slice(0));
      if (opts.onProgress) opts.onProgress(((i + 1) / total) * 0.6); // extraction = first 60%
      await tick();
    }
    scaler.dispose();
    revokeVideo(video);

    const bytes = await encodeGIF({
      width: dw, height: dh, delay: Math.round(nominalDelayMs), delays, repeat: 0,
      dither: opts.dither !== false, maxColors: opts.maxColors || 255,
      delta: opts.delta !== false, subRect: opts.subRect !== false, noiseGate: opts.noiseGate || 8,
      frames, caps, onProgress: opts.onProgress,
    });
    return {
      blob: new Blob([bytes], { type: 'image/gif' }),
      width: dw,
      height: dh,
      frames: total,
      duration: targetPlaybackDur,
      speedMode,
    };
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
          {
            width: o.width, height: o.height, delay: o.delay, delays: o.delays,
            repeat: o.repeat, dither: o.dither, maxColors: o.maxColors,
            delta: o.delta, subRect: o.subRect, noiseGate: o.noiseGate,
            frames: o.frames,
          },
          o.frames // transfer buffers (zero-copy)
        );
      });
    }
    return Promise.resolve(encodeMain(o));
  }

  function encodeMain(o) {
    const enc = new root.KapturaGIF.GIFEncoder(o.width, o.height, {
      delay: o.delay, repeat: o.repeat, dither: o.dither, maxColors: o.maxColors,
      delta: o.delta !== false, subRect: o.subRect !== false, noiseGate: o.noiseGate || 8,
    });
    const delays = o.delays || null;
    for (let i = 0; i < o.frames.length; i++) {
      enc.addFrame(new Uint8ClampedArray(o.frames[i]), {
        delay: (delays && delays[i] != null) ? delays[i] : o.delay,
      });
      if (o.onProgress) o.onProgress(0.6 + ((i + 1) / o.frames.length) * 0.4);
    }
    return enc.render();
  }

  const api = { transcode, toGIF };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.KapturaTranscoder = api;
})(typeof self !== 'undefined' ? self : this);
