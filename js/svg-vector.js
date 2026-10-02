/*
 * ============================================================================
 * KAPTURA · SVG Vector Studio  (real animated-SVG exporter · self-contained)
 * ============================================================================
 * Exports a REAL animated SVG (SMIL flip-book) from any source (canvas scene
 * or recorded master). Frames are captured, optionally Lanczos-scaled, embedded
 * as <image> nodes and sequenced with a single SMIL <animate> on opacity — so
 * the result plays live in any browser with zero JavaScript.
 *
 * Honesty note surfaced to the UI: GitHub's markdown pipeline sanitizes SMIL on
 * <img>-embedded SVG, so for GitHub embeds the Cinema GIF is the reliable path;
 * the animated SVG plays in browsers and standalone. No false "120 FPS on
 * GitHub" claim.
 * ----------------------------------------------------------------------------
 */
(function (root) {
  'use strict';

  const Scaler = (root && root.KapturaScaler) || (typeof require !== 'undefined' ? (function () { try { return require('./scaler.js'); } catch (e) { return null; } })() : null);

  const tick = () => new Promise((r) => (root.requestAnimationFrame ? requestAnimationFrame(() => r()) : setTimeout(r, 0)));
  function seek(video, t) {
    return new Promise((resolve) => {
      const on = () => { video.removeEventListener('seeked', on); resolve(); };
      video.addEventListener('seeked', on);
      video.currentTime = Math.min(t, Math.max(0, (video.duration || 0) - 1e-3));
    });
  }
  function even(n) { return n & ~1; }

  function loadVideo(file) {
    return new Promise((resolve, reject) => {
      const v = document.createElement('video');
      v.muted = true; v.playsInline = true; v.preload = 'auto';
      v.src = URL.createObjectURL(file);
      v.onloadedmetadata = () => resolve(v);
      v.onerror = () => reject(new Error('No se pudo leer el vídeo para exportar SVG.'));
    });
  }

  /** Assemble the SMIL flip-book SVG from an array of PNG data URIs. */
  function buildSVG(dataUris, w, h, fps) {
    const n = dataUris.length;
    const dur = (n / fps).toFixed(3);
    // keyTimes across the whole loop; each frame is opaque only in its slot.
    const keyTimes = [];
    for (let i = 0; i <= n; i++) keyTimes.push((i / n).toFixed(4));
    const layers = dataUris.map((uri, i) => {
      // opacity: 0 everywhere except 1 during slot i (step hold)
      const vals = [];
      for (let k = 0; k <= n; k++) vals.push(k === i ? '1' : (k === i + 1 ? '1' : '0'));
      // simpler robust hold: 1 at frame i and until i+1, else 0
      const values = keyTimes.map((_, k) => (k === i ? '1' : '0')).join(';');
      return `  <image x="0" y="0" width="${w}" height="${h}" opacity="${i === 0 ? 1 : 0}" href="${uri}" preserveAspectRatio="xMidYMid slice">
    <animate attributeName="opacity" values="${values}" keyTimes="${keyTimes.join(';')}" dur="${dur}s" calcMode="discrete" repeatCount="indefinite"/>
  </image>`;
    }).join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">
  <title>KAPTURA · animated SVG (${n} frames @ ${fps}fps)</title>
  <rect width="100%" height="100%" fill="#010204"/>
${layers}
</svg>`;
  }

  /** Export a live canvas element (the scene engine) as animated SVG. */
  async function fromCanvas(canvas, opts) {
    opts = opts || {};
    const fps = Math.min(opts.fps || 12, 30);
    const seconds = Math.min(opts.seconds || 3, 12);
    const total = Math.max(2, Math.round(fps * seconds));
    const dw = even(opts.width || Math.min(720, canvas.width));
    const dh = even(opts.height || Math.round((dw * canvas.height) / canvas.width));
    const scaler = Scaler.create({ quality: opts.quality || 'fast', caps: opts.caps });
    const grab = document.createElement('canvas'); grab.width = dw; grab.height = dh;
    const gctx = grab.getContext('2d');
    const uris = [];
    for (let i = 0; i < total; i++) {
      const scaled = scaler.toCanvas(canvas, canvas.width, canvas.height, dw, dh);
      gctx.drawImage(scaled, 0, 0, dw, dh);
      uris.push(grab.toDataURL('image/png'));
      if (opts.onProgress) opts.onProgress((i + 1) / total);
      // wait roughly one frame interval so the live scene advances between grabs
      await new Promise((r) => setTimeout(r, 1000 / fps));
    }
    scaler.dispose();
    const svg = buildSVG(uris, dw, dh, fps);
    return { blob: new Blob([svg], { type: 'image/svg+xml' }), frames: total, width: dw, height: dh };
  }

  /** Export a recorded/loaded video file as animated SVG. */
  async function fromVideo(file, opts) {
    opts = opts || {};
    const fps = Math.min(opts.fps || 10, 24);
    const video = await loadVideo(file);
    const sw = video.videoWidth, sh = video.videoHeight;
    const dw = even(opts.width || Math.min(640, sw));
    const dh = even(opts.height || Math.round((dw * sh) / sw));
    const dur = video.duration || 0;
    const total = Math.max(2, Math.min(Math.floor(dur * fps), opts.maxFrames || 120));
    const step = dur / total;
    const scaler = Scaler.create({ quality: opts.quality || 'max', caps: opts.caps });
    const grab = document.createElement('canvas'); grab.width = dw; grab.height = dh;
    const gctx = grab.getContext('2d');
    const uris = [];
    for (let i = 0; i < total; i++) {
      await seek(video, i * step);
      const scaled = scaler.toCanvas(video, sw, sh, dw, dh);
      gctx.drawImage(scaled, 0, 0, dw, dh);
      uris.push(grab.toDataURL('image/png'));
      if (opts.onProgress) opts.onProgress((i + 1) / total);
      await tick();
    }
    scaler.dispose();
    URL.revokeObjectURL(video.src);
    const svg = buildSVG(uris, dw, dh, fps);
    return { blob: new Blob([svg], { type: 'image/svg+xml' }), frames: total, width: dw, height: dh };
  }

  function rgbToHex(r, g, b) {
    return '#' + [r, g, b].map((x) => {
      const hex = Math.max(0, Math.min(255, Math.round(x))).toString(16);
      return hex.length === 1 ? '0' + hex : hex;
    }).join('');
  }

  function quantizePixel(r, g, b, levels) {
    const step = 256 / levels;
    const qr = Math.min(255, Math.floor(r / step) * step + step / 2);
    const qg = Math.min(255, Math.floor(g / step) * step + step / 2);
    const qb = Math.min(255, Math.floor(b / step) * step + step / 2);
    return [Math.round(qr), Math.round(qg), Math.round(qb)];
  }

  function vectorTrace(rgba, w, h, opts) {
    opts = opts || {};
    const colors = opts.colors || 8;
    const colorMap = new Map();

    for (let y = 0; y < h; y++) {
      let currentKey = null;
      let startX = 0;
      for (let x = 0; x < w; x++) {
        const idx = (y * w + x) * 4;
        const a = rgba[idx + 3];
        let key;
        if (a < 128) {
          key = 'transparent';
        } else {
          const [qr, qg, qb] = quantizePixel(rgba[idx], rgba[idx + 1], rgba[idx + 2], colors);
          key = rgbToHex(qr, qg, qb);
        }

        if (key !== currentKey) {
          if (currentKey && currentKey !== 'transparent') {
            if (!colorMap.has(currentKey)) colorMap.set(currentKey, []);
            colorMap.get(currentKey).push({ y, x: startX, w: x - startX, h: 1 });
          }
          currentKey = key;
          startX = x;
        }
      }
      if (currentKey && currentKey !== 'transparent') {
        if (!colorMap.has(currentKey)) colorMap.set(currentKey, []);
        colorMap.get(currentKey).push({ y, x: startX, w: w - startX, h: 1 });
      }
    }

    const pathGroups = [];
    for (const [hex, spans] of colorMap.entries()) {
      const merged = [];
      const openSpans = new Map();

      for (const span of spans) {
        const colKey = `${span.x}_${span.w}`;
        const existing = openSpans.get(colKey);
        if (existing && existing.y + existing.h === span.y) {
          existing.h += 1;
        } else {
          if (existing) merged.push(existing);
          openSpans.set(colKey, { x: span.x, y: span.y, w: span.w, h: span.h });
        }
      }
      for (const rect of openSpans.values()) {
        merged.push(rect);
      }

      let pathD = '';
      for (const r of merged) {
        pathD += `M${r.x} ${r.y}h${r.w}v${r.h}h-${r.w}Z `;
      }

      pathGroups.push({ color: hex, pathCount: merged.length, d: pathD.trim() });
    }

    let svg = `<?xml version="1.0" encoding="UTF-8"?>\n`;
    svg += `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" shape-rendering="crispEdges">\n`;
    svg += `  <title>KAPTURA Vector Master (${pathGroups.length} color layers)</title>\n`;
    for (const g of pathGroups) {
      svg += `  <path fill="${g.color}" d="${g.d}"/>\n`;
    }
    svg += `</svg>`;

    return {
      svg,
      layers: pathGroups.length,
      totalPaths: pathGroups.reduce((a, b) => a + b.pathCount, 0),
    };
  }

  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('No se pudo decodificar la imagen.')); };
      img.src = url;
    });
  }

  function isImageFile(nameOrFile) {
    if (!nameOrFile) return false;
    if (typeof nameOrFile === 'object' && nameOrFile.type) {
      if (nameOrFile.type.startsWith('image/')) return true;
    }
    const name = (typeof nameOrFile === 'string' ? nameOrFile : nameOrFile.name) || '';
    return /\.(png|jpe?g|webp|bmp|gif|avif|tiff?)$/i.test(name);
  }

  /** Export an image as real vector paths or high-fidelity scalable SVG master. */
  async function fromImage(file, opts) {
    opts = opts || {};
    const img = await loadImage(file);
    const sw = img.naturalWidth || img.width;
    const sh = img.naturalHeight || img.height;
    const mode = opts.mode || 'trace'; // 'trace' (real paths) or 'container' (lanczos super-sample)

    if (mode === 'trace') {
      const maxDim = Math.min(opts.maxDim || 640, 1280);
      let dw = sw, dh = sh;
      if (dw > maxDim || dh > maxDim) {
        if (dw >= dh) {
          dh = Math.round((dh * maxDim) / dw);
          dw = maxDim;
        } else {
          dw = Math.round((dw * maxDim) / dh);
          dh = maxDim;
        }
      }
      dw = even(dw); dh = even(dh);

      const canvas = document.createElement('canvas');
      canvas.width = dw; canvas.height = dh;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, dw, dh);
      const imgData = ctx.getImageData(0, 0, dw, dh);

      if (opts.onProgress) opts.onProgress(0.5);

      const traceRes = vectorTrace(imgData.data, dw, dh, { colors: opts.colors || 8 });

      if (opts.onProgress) opts.onProgress(1.0);

      const blob = new Blob([traceRes.svg], { type: 'image/svg+xml' });
      return {
        blob,
        svg: traceRes.svg,
        width: dw,
        height: dh,
        layers: traceRes.layers,
        totalPaths: traceRes.totalPaths,
        mode: 'trace',
      };
    }

    // High-fidelity scalable container with Lanczos-3 supersampling
    const scaler = Scaler ? Scaler.create({ quality: 'max', caps: opts.caps }) : null;
    const dw = even(opts.width || Math.min(3840, sw * 2));
    const dh = even(opts.height || Math.round((dw * sh) / sw));
    let dataUri;

    if (scaler) {
      const scaledCanvas = scaler.toCanvas(img, sw, sh, dw, dh);
      dataUri = scaledCanvas.toDataURL('image/png');
      scaler.dispose();
    } else {
      const c = document.createElement('canvas');
      c.width = dw; c.height = dh;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0, dw, dh);
      dataUri = c.toDataURL('image/png');
    }

    if (opts.onProgress) opts.onProgress(0.9);

    const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dw} ${dh}" width="${dw}" height="${dh}">
  <title>KAPTURA Scalable Master (${dw}x${dh})</title>
  <image x="0" y="0" width="${dw}" height="${dh}" href="${dataUri}" preserveAspectRatio="xMidYMid slice" image-rendering="crisp-edges"/>
</svg>`;

    if (opts.onProgress) opts.onProgress(1.0);

    return {
      blob: new Blob([svg], { type: 'image/svg+xml' }),
      svg,
      width: dw,
      height: dh,
      mode: 'container',
    };
  }

  /** Unified processor: auto-detects image vs video */
  async function processFile(file, opts) {
    if (isImageFile(file)) {
      return fromImage(file, opts);
    }
    return fromVideo(file, opts);
  }

  const api = { fromCanvas, fromVideo, fromImage, processFile, isImageFile, vectorTrace };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.KapturaSVGVector = api;
})(typeof self !== 'undefined' ? self : this);
