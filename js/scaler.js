/*
 * ============================================================================
 * KAPTURA · Hybrid Scaler  (chooses GPU / CPU / native · frugal)
 * ============================================================================
 * One tiny facade over three real resamplers so callers never branch:
 *   - 'max'  + WebGL  -> GPU Lanczos-3     (js/lanczos-gl.js)   [real-time]
 *   - 'max'  no WebGL -> CPU Lanczos-3     (js/lanczos.js)      [universal]
 *   - 'fast'          -> native drawImage  (imageSmoothingQuality:'high')
 *
 * The 'fast' path is GPU-accelerated by the browser itself, so even the cheap
 * option shares work with the GPU. Nothing here requires hardware to function.
 * ----------------------------------------------------------------------------
 */
(function (root) {
  'use strict';

  function create(opts) {
    opts = opts || {};
    const quality = opts.quality || 'fast';          // 'fast' | 'max'
    const defaultSharpen = Number(opts.sharpen) || 0;
    const caps = opts.caps || {};
    const scratch = document.createElement('canvas');
    const sctx = scratch.getContext('2d', { willReadFrequently: true });
    const out = document.createElement('canvas');
    const octx = out.getContext('2d');

    let gpu = null;
    let mode = 'fast';
    if (quality === 'max') {
      if (caps.gpu && caps.gpu.webgl && root.KapturaLanczosGL) {
        gpu = root.KapturaLanczosGL.create();
        mode = gpu ? (defaultSharpen > 0 ? 'lanczos-cas-gpu' : 'lanczos-gpu') : (root.KapturaLanczos ? 'lanczos-cpu' : 'fast');
      } else if (root.KapturaLanczos) {
        mode = 'lanczos-cpu';
      }
    }

    /** Resize any drawable source to dw x dh; returns a canvas (reused). */
    function toCanvas(source, sw, sh, dw, dh, sharpenOverride) {
      const sharp = sharpenOverride != null ? Number(sharpenOverride) : defaultSharpen;
      if (mode === 'lanczos-gpu' || mode === 'lanczos-cas-gpu') {
        try { return gpu.resize(source, sw, sh, dw, dh, { sharpen: sharp }); }
        catch { mode = root.KapturaLanczos ? 'lanczos-cpu' : 'fast'; } // degrade once, honestly
      }
      if (mode === 'lanczos-cpu') {
        scratch.width = sw; scratch.height = sh;
        sctx.drawImage(source, 0, 0, sw, sh);
        const srcData = sctx.getImageData(0, 0, sw, sh).data;
        const dst = root.KapturaLanczos.resample(srcData, sw, sh, dw, dh);
        out.width = dw; out.height = dh;
        octx.putImageData(new ImageData(dst, dw, dh), 0, 0);
        return out;
      }
      // fast native path (GPU-accelerated high-quality bilinear/bicubic)
      out.width = dw; out.height = dh;
      octx.imageSmoothingEnabled = true;
      octx.imageSmoothingQuality = 'high';
      octx.drawImage(source, 0, 0, dw, dh);
      return out;
    }

    function dispose() { if (gpu) gpu.dispose(); }

    return { toCanvas, dispose, get mode() { return mode; } };
  }

  const api = { create };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.KapturaScaler = api;
})(typeof self !== 'undefined' ? self : this);
