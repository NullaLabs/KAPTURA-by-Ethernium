/*
 * ============================================================================
 * KAPTURA · BG STUDIO Engine (BiRefNet / RVM CUDA / Chroma-Key / Browser Matte)
 * ============================================================================
 * Routes premium background removal to :3370 (BiRefNet 1024px / RVM ResNet50
 * CUDA FP16 / FFmpeg Chromakey+Despill) when online, and falls back honestly to
 * real in-browser YCbCr Chroma-Key & Border-Connected Soft Matte offline.
 * ----------------------------------------------------------------------------
 */
(function (root) {
  'use strict';

  const ENGINES = {
    auto:        { label: '⚡ Auto Studio (BiRefNet 2K CUDA Img / RVM RTX Vid)', media: 'both' },
    birefnet_hr: { label: '💎 BiRefNet HR-Matting 2K (RTX CUDA · Máxima Precisión)', media: 'both' },
    birefnet:    { label: '🔹 BiRefNet 1024px ONNX (CPU/Portátil)', media: 'both' },
    rvm_cuda:    { label: '🎬 RVM ResNet-50 RTX CUDA (60 FPS · Sin parpadeo)', media: 'video' },
    rvm_onnx:    { label: '🧠 RVM Fast Neural (Retratos / Preview 2s)', media: 'both' },
    chroma:      { label: '🟩 Chroma-Key + Despill (Verde/Azul/Color)', media: 'both' },
  };

  const BACKDROPS = {
    transparent:  { label: '🏁 Fondo Transparente Alpha (PNG / WebM VP9)', media: 'both' },
    prores:       { label: '🎞️ Apple ProRes 4444 Alpha (.mov Edición NLE)', media: 'video' },
    greenscreen:  { label: '🟩 Green Screen Studio #00FF00 (MP4 NLE)', media: 'video' },
    bokeh:        { label: '📷 Bokeh Retrato DSLR (Fondo Desenfocado)', media: 'both' },
    solid:        { label: '🎨 Color Sólido Personalizado', media: 'both' },
    custom_image: { label: '🖼️ Imagen de Fondo Personalizada', media: 'both' },
  };

  function isEngineCompatible(key, mediaKind) {
    const def = ENGINES[key];
    if (!def || !mediaKind) return true;
    return def.media === 'both' || def.media === mediaKind;
  }

  function isBackdropCompatible(key, mediaKind) {
    const def = BACKDROPS[key];
    if (!def || !mediaKind) return true;
    return def.media === 'both' || def.media === mediaKind;
  }

  function isImageFile(fileOrSrc) {
    if (!fileOrSrc) return false;
    if (typeof fileOrSrc === 'object') {
      const m = String(fileOrSrc.type || fileOrSrc.mime || '');
      if (m.startsWith('image/')) return true;
      if (m.startsWith('video/')) return false;
    }
    const name = typeof fileOrSrc === 'string' ? fileOrSrc : (fileOrSrc.name || '');
    return /\.(png|jpe?g|webp|bmp|avif)$/i.test(name);
  }

  function hexToRgb(hex) {
    const clean = String(hex || '#00FF00').trim().replace(/^#/, '');
    const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
    if (!/^[0-9a-fA-F]{6}$/.test(full)) return [0, 255, 0];
    return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)];
  }

  function rgbToCbCr(r, g, b) {
    return [
      128 - 0.168736 * r - 0.331264 * g + 0.5 * b,
      128 + 0.5 * r - 0.418688 * g - 0.081312 * b,
    ];
  }

  /** Apply Chroma-Key (YCbCr distance + despill) OR Border-Connected Smart Matte to RGBA ImageData. */
  function applyMatteToImageData(imgData, w, h, opts) {
    opts = opts || {};
    const d = imgData.data;
    const isChroma = opts.engine === 'chroma';
    const similarity = Math.max(0.03, Math.min(0.65, Number(opts.similarity) || 0.22));
    const blend = Math.max(0.02, Math.min(0.45, Number(opts.blend) || 0.08));
    const decontaminate = opts.decontaminate !== false;

    if (isChroma) {
      const [kr, kg, kb] = hexToRgb(opts.keyColor || '#00FF00');
      const [kCb, kCr] = rgbToCbCr(kr, kg, kb);
      const thr1 = similarity * 165;
      const thr2 = (similarity + blend) * 165;
      const greenSpill = kg >= kb && kg >= kr;
      for (let p = 0; p < d.length; p += 4) {
        const r = d[p], g = d[p + 1], b = d[p + 2];
        const [cb, cr] = rgbToCbCr(r, g, b);
        const dist = Math.hypot(cb - kCb, cr - kCr);
        let alpha = 1;
        if (dist <= thr1) alpha = 0;
        else if (dist < thr2) alpha = (dist - thr1) / Math.max(1, thr2 - thr1);
        if (decontaminate && alpha > 0 && alpha < 0.98) {
          if (greenSpill && g > (r + b) * 0.55) d[p + 1] = Math.round((r + b) * 0.55);
          else if (!greenSpill && b > (r + g) * 0.55) d[p + 2] = Math.round((r + g) * 0.55);
        }
        d[p + 3] = Math.round(alpha * 255);
      }
      return imgData;
    }

    // Offline auto matte: sample perimeter colors and run border-connected region growing
    const borderSamples = [];
    const stepX = Math.max(1, Math.floor(w / 16));
    const stepY = Math.max(1, Math.floor(h / 12));
    for (let x = 0; x < w; x += stepX) {
      for (const y of [0, h - 1]) {
        const p = (y * w + x) * 4;
        borderSamples.push([d[p], d[p + 1], d[p + 2]]);
      }
    }
    for (let y = 0; y < h; y += stepY) {
      for (const x of [0, w - 1]) {
        const p = (y * w + x) * 4;
        borderSamples.push([d[p], d[p + 1], d[p + 2]]);
      }
    }
    const tol = 42 + similarity * 95;
    const totalPx = w * h;
    const bgMask = new Uint8Array(totalPx);
    const queue = new Int32Array(totalPx);
    let qHead = 0, qTail = 0;

    const minDistToBorder = (idx) => {
      const p = idx * 4;
      const r = d[p], g = d[p + 1], b = d[p + 2];
      let best = 9999;
      for (let i = 0; i < borderSamples.length; i++) {
        const s = borderSamples[i];
        const dist = Math.abs(r - s[0]) * 0.3 + Math.abs(g - s[1]) * 0.59 + Math.abs(b - s[2]) * 0.11;
        if (dist < best) best = dist;
      }
      return best;
    };

    const tryPush = (idx) => {
      if (bgMask[idx]) return;
      if (minDistToBorder(idx) <= tol) {
        bgMask[idx] = 1;
        queue[qTail++] = idx;
      }
    };

    for (let x = 0; x < w; x++) { tryPush(x); tryPush((h - 1) * w + x); }
    for (let y = 1; y < h - 1; y++) { tryPush(y * w); tryPush(y * w + (w - 1)); }

    while (qHead < qTail) {
      const idx = queue[qHead++];
      const x = idx % w;
      const y = (idx - x) / w;
      if (x > 0) tryPush(idx - 1);
      if (x + 1 < w) tryPush(idx + 1);
      if (y > 0) tryPush(idx - w);
      if (y + 1 < h) tryPush(idx + w);
    }

    for (let i = 0; i < totalPx; i++) {
      if (bgMask[i]) {
        d[i * 4 + 3] = 0;
      } else {
        // Soft edge anti-aliasing next to removed background
        const x = i % w;
        const y = (i - x) / w;
        let bgNeighbors = 0;
        if (x > 0 && bgMask[i - 1]) bgNeighbors++;
        if (x + 1 < w && bgMask[i + 1]) bgNeighbors++;
        if (y > 0 && bgMask[i - w]) bgNeighbors++;
        if (y + 1 < h && bgMask[i + w]) bgNeighbors++;
        if (bgNeighbors > 0) {
          d[i * 4 + 3] = Math.round((1 - bgNeighbors * 0.18) * 255);
        }
      }
    }
    return imgData;
  }

  function loadImageFromFile(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('No se pudo decodificar la imagen.')); };
      img.src = url;
    });
  }

  async function processImageInBrowser(file, opts) {
    opts = opts || {};
    const img = await loadImageFromFile(file);
    const maxDim = 2560;
    const rawW = img.naturalWidth || img.width;
    const rawH = img.naturalHeight || img.height;
    const scale = Math.min(1, maxDim / Math.max(rawW, rawH));
    const w = Math.max(2, Math.round(rawW * scale));
    const h = Math.max(2, Math.round(rawH * scale));

    const fgCan = document.createElement('canvas');
    fgCan.width = w; fgCan.height = h;
    const fgCtx = fgCan.getContext('2d', { willReadFrequently: true });
    fgCtx.drawImage(img, 0, 0, w, h);
    if (typeof opts.onProgress === 'function') opts.onProgress(0.35, { stage: 'BROWSER_MATTE' });

    const imgData = fgCtx.getImageData(0, 0, w, h);
    applyMatteToImageData(imgData, w, h, opts);
    fgCtx.putImageData(imgData, 0, 0);

    const outCan = document.createElement('canvas');
    outCan.width = w; outCan.height = h;
    const outCtx = outCan.getContext('2d');
    const backdrop = opts.backdrop || 'transparent';

    if (backdrop === 'solid') {
      outCtx.fillStyle = opts.bgColor || '#050814';
      outCtx.fillRect(0, 0, w, h);
    } else if (backdrop === 'bokeh') {
      const blurPx = Math.max(4, Math.min(36, Math.round((Number(opts.blurStrength) || 23) * 0.6)));
      outCtx.save();
      outCtx.filter = `blur(${blurPx}px)`;
      outCtx.drawImage(img, -blurPx, -blurPx, w + blurPx * 2, h + blurPx * 2);
      outCtx.restore();
    } else if (backdrop === 'custom_image' && opts.customBgFile) {
      const bgImg = await loadImageFromFile(opts.customBgFile);
      const bw = bgImg.naturalWidth || bgImg.width || w;
      const bh = bgImg.naturalHeight || bgImg.height || h;
      const sc = Math.max(w / bw, h / bh);
      const dw = bw * sc, dh = bh * sc;
      outCtx.drawImage(bgImg, (w - dw) / 2, (h - dh) / 2, dw, dh);
    }
    outCtx.drawImage(fgCan, 0, 0);
    if (typeof opts.onProgress === 'function') opts.onProgress(0.92, { stage: 'ENCODING_PNG' });

    const blob = await new Promise((res) => outCan.toBlob(res, 'image/png'));
    if (typeof opts.onProgress === 'function') opts.onProgress(1, { stage: 'COMPLETE' });
    const label = opts.engine === 'chroma'
      ? 'Browser YCbCr Chroma + Despill'
      : 'Browser Smart Border Matte (inicia :3370 para BiRefNet 1024px)';
    return {
      mode: 'processed',
      blob,
      ext: 'png',
      mime: 'image/png',
      width: w,
      height: h,
      hasAlpha: backdrop === 'transparent',
      scaleMode: label,
      isImage: true,
      neural: false,
      fellBack: opts.engine !== 'chroma',
    };
  }

  async function processVideoInBrowser(file, opts) {
    opts = opts || {};
    if (typeof document === 'undefined' || typeof MediaRecorder === 'undefined') {
      throw new Error('Este entorno no soporta procesamiento de vídeo en navegador.');
    }
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    const url = URL.createObjectURL(file);
    video.src = url;
    await new Promise((res, rej) => {
      video.onloadedmetadata = res;
      video.onerror = () => rej(new Error('No se pudo cargar el vídeo.'));
    });

    const w = Math.max(2, (video.videoWidth || 640) & ~1);
    const h = Math.max(2, (video.videoHeight || 360) & ~1);
    const pSec = Number(opts.previewSec) || 0;
    const startSec = Math.max(0, Number(opts.previewStartSec) || 0);
    const maxDur = pSec > 0 ? Math.min(pSec, Math.max(0.4, (video.duration || pSec) - startSec)) : (video.duration || 5);
    const endSec = Math.min(video.duration || (startSec + maxDur), startSec + maxDur);

    const scratch = document.createElement('canvas');
    scratch.width = w; scratch.height = h;
    const sCtx = scratch.getContext('2d', { willReadFrequently: true });

    const outCan = document.createElement('canvas');
    outCan.width = w; outCan.height = h;
    const oCtx = outCan.getContext('2d');

    let bgImg = null;
    if (opts.backdrop === 'custom_image' && opts.customBgFile) {
      bgImg = await loadImageFromFile(opts.customBgFile);
    }

    const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm';
    const stream = outCan.captureStream(24);
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 6_000_000 });
    const chunks = [];
    rec.ondataavailable = (ev) => { if (ev.data && ev.data.size > 0) chunks.push(ev.data); };

    video.currentTime = startSec;
    await new Promise((r) => { video.onseeked = r; });

    const stopped = new Promise((res) => { rec.onstop = res; });
    rec.start(100);
    video.play().catch(() => {});

    const drawStep = () => {
      if (opts.signal && opts.signal.aborted) {
        try { video.pause(); rec.stop(); } catch {}
        return;
      }
      if (video.ended || video.currentTime >= endSec) {
        video.pause();
        try { rec.stop(); } catch {}
        return;
      }
      sCtx.drawImage(video, 0, 0, w, h);
      const frame = sCtx.getImageData(0, 0, w, h);
      applyMatteToImageData(frame, w, h, { ...opts, engine: opts.engine === 'chroma' ? 'chroma' : 'auto' });
      sCtx.putImageData(frame, 0, 0);

      const bd = opts.backdrop || 'transparent';
      if (bd === 'greenscreen') {
        oCtx.fillStyle = '#00FF00';
        oCtx.fillRect(0, 0, w, h);
      } else if (bd === 'bokeh') {
        const blurPx = Math.max(4, Math.min(28, Math.round((Number(opts.blurStrength) || 23) * 0.5)));
        oCtx.save();
        oCtx.filter = `blur(${blurPx}px)`;
        oCtx.drawImage(video, -blurPx, -blurPx, w + blurPx * 2, h + blurPx * 2);
        oCtx.restore();
      } else if (bd === 'custom_image' && bgImg) {
        const bw = bgImg.naturalWidth || w, bh = bgImg.naturalHeight || h;
        const sc = Math.max(w / bw, h / bh);
        oCtx.drawImage(bgImg, (w - bw * sc) / 2, (h - bh * sc) / 2, bw * sc, bh * sc);
      } else {
        oCtx.fillStyle = bd === 'solid' ? (opts.bgColor || '#050814') : '#030508';
        oCtx.fillRect(0, 0, w, h);
      }
      oCtx.drawImage(scratch, 0, 0);
      if (typeof opts.onProgress === 'function') {
        const frac = Math.max(0.05, Math.min(0.95, (video.currentTime - startSec) / Math.max(0.2, endSec - startSec)));
        opts.onProgress(frac, { stage: 'BROWSER_MATTE' });
      }
      requestAnimationFrame(drawStep);
    };
    requestAnimationFrame(drawStep);

    await stopped;
    URL.revokeObjectURL(url);
    if (opts.signal && opts.signal.aborted) {
      const ab = new Error('Cancelled by operator');
      ab.name = 'AbortError';
      throw ab;
    }
    const blob = new Blob(chunks, { type: 'video/webm' });
    if (typeof opts.onProgress === 'function') opts.onProgress(1, { stage: 'COMPLETE' });
    return {
      mode: 'processed',
      blob,
      ext: 'webm',
      mime: 'video/webm',
      width: w,
      height: h,
      hasAlpha: false,
      scaleMode: 'Browser Chroma WebM (inicia :3370 para RVM RTX CUDA / VP9 Alpha)',
      isImage: false,
      neural: false,
      fellBack: true,
    };
  }

  async function run(file, opts) {
    opts = opts || {};
    const isImg = isImageFile(file);
    const engine = opts.engine || 'auto';
    const dh = root.KapturaDaemon && root.KapturaDaemon.getCachedHealth ? root.KapturaDaemon.getCachedHealth() : {};
    const bgCaps = (dh && dh.bgRemoval) || {};
    const hasAnyNeural = isImg
      ? Boolean(bgCaps.birefnetHr || bgCaps.birefnet || bgCaps.rvmOnnx)
      : Boolean(bgCaps.rvmCuda || bgCaps.birefnetHr || bgCaps.rvmOnnx || bgCaps.birefnet);
    const daemonOnline = Boolean(root.KapturaDaemon && root.KapturaDaemon.isReadyForTranscode && root.KapturaDaemon.isReadyForTranscode());

    const canUseDaemon = daemonOnline && (engine === 'chroma' || hasAnyNeural);
    if (canUseDaemon && typeof root.KapturaDaemon.removeBgViaDaemon === 'function') {
      let bgImageRef = '';
      if (opts.backdrop === 'custom_image' && opts.customBgFile && typeof root.KapturaDaemon.uploadBgBackdropViaDaemon === 'function') {
        const up = await root.KapturaDaemon.uploadBgBackdropViaDaemon(opts.customBgFile);
        bgImageRef = (up && up.backdropRef) || '';
      }
      const res = await root.KapturaDaemon.removeBgViaDaemon(file, {
        ...opts,
        bgImageRef,
        isImage: isImg,
        keepOnDisk: !isImg,
      });
      return {
        mode: 'processed',
        blob: res.blob || null,
        remoteUrl: res.remoteUrl || '',
        sizeBytes: res.sizeBytes || (res.blob ? res.blob.size : 0),
        ext: res.ext || (isImg ? 'png' : 'mp4'),
        width: res.width || 0,
        height: res.height || 0,
        hasAlpha: Boolean(res.hasAlpha),
        engine: res.engine || engine,
        model: res.model || '',
        scaleMode: res.scaleMode,
        integrity: res.integrity || null,
        previewMode: Boolean(res.previewMode),
        previewSourceUrl: res.previewSourceUrl || '',
        isImage: isImg,
        neural: res.engine !== 'chroma',
        fellBack: false,
      };
    }

    if (isImg) return processImageInBrowser(file, opts);
    return processVideoInBrowser(file, opts);
  }

  const api = {
    ENGINES,
    BACKDROPS,
    isEngineCompatible,
    isBackdropCompatible,
    isImageFile,
    applyMatteToImageData,
    run,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.KapturaBgRemover = api;
})(typeof self !== 'undefined' ? self : this);
