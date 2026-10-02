/*
 * ============================================================================
 * KAPTURA · UPSKALETOR bridge  (honest · real where possible · Image & Video)
 * ============================================================================
 * Two truthful modes, never a fake one:
 *
 *   'processed' : REAL in-browser upscale (Lanczos-3 GPU/CPU) for mathematical
 *                 profiles (1080p/4K Lanczos, 2x/4x Super-Resolution). Works for
 *                 BOTH images (PNG/JPG/WebP) and videos (MP4/WebM).
 *
 *   'handoff'   : Real-ESRGAN neural AI genuinely needs the external UPSKALETOR
 *                 engine, so we DON'T pretend. We hand the untouched master to
 *                 the operator with the exact signed-CLI command. No progress
 *                 theater, no "_4K_AI" suffix on an unmodified file.
 * ----------------------------------------------------------------------------
 */
(function (root) {
  'use strict';

  const Transcoder = root.KapturaTranscoder;
  const Scaler = root.KapturaScaler;

  const PROFILES = {
    '4k_ai':          { label: '4K UHD · Real-ESRGAN Neural', ai: true,  w: 3840, h: 2160 },
    '4k_lanczos':     { label: '4K UHD · Lanczos-3 (in-browser)', ai: false, w: 3840, h: 2160, bitrate: 40 },
    '1080p_lanczos':  { label: '1080p · Lanczos-3 (in-browser)', ai: false, w: 1920, h: 1080, bitrate: 16 },
    '2x_super':       { label: '2X Super-Resolution (Lanczos-3)', ai: false, scale: 2 },
    '4x_super':       { label: '4X Super-Resolution (Lanczos-3)', ai: false, scale: 4 },
    'twitter_4k':     { label: 'Twitter/X · 4K',              ai: false, w: 3840, h: 2160, bitrate: 25 },
    'twitter_1080p':  { label: 'Twitter/X · 1080p',           ai: false, w: 1920, h: 1080, bitrate: 15 },
    'youtube_4k':     { label: 'YouTube · 4K Master',         ai: false, w: 3840, h: 2160, bitrate: 45 },
    '720p':           { label: '720p HD Compact',             ai: false, w: 1280, h: 720,  bitrate: 8 },
  };

  function command(fileName, profile, engine) {
    const isImg = isImageFile(fileName);
    const outExt = isImg ? 'png' : 'mp4';
    return `.\\upskaletor.ps1 -InputFile ".\\${fileName}" -Profile "${profile}" -Engine "${engine}" -Out ".\\${baseName(fileName)}_UPSKALED.${outExt}"`;
  }

  function baseName(name) {
    const i = name.lastIndexOf('.');
    return i > 0 ? name.substring(0, i) : name;
  }

  function isImageFile(nameOrFile) {
    if (!nameOrFile) return false;
    if (typeof nameOrFile === 'object' && nameOrFile.type) {
      if (nameOrFile.type.startsWith('image/')) return true;
    }
    const name = (typeof nameOrFile === 'string' ? nameOrFile : nameOrFile.name) || '';
    return /\.(png|jpe?g|webp|bmp|gif|avif)$/i.test(name);
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

  /**
   * @returns {Promise<object>} one of:
   *   { mode:'processed', blob, ext, width, height, scaleMode, fellBack, isImage }
   *   { mode:'handoff', reason, command, fileName, isImage }
   */
  async function run(file, profileKey, engine, opts) {
    opts = opts || {};
    const profile = PROFILES[profileKey] || PROFILES['4k_lanczos'];
    const fileName = (file && file.name) || 'kaptura_master.mp4';
    const isImg = isImageFile(file);

    if (profile.ai) {
      // Honest: the browser cannot run Real-ESRGAN. Hand off, don't fake.
      return {
        mode: 'handoff',
        reason: 'El escalado neuronal Real-ESRGAN se ejecuta en el motor independiente UPSKALETOR (GPU local). KAPTURA entrega el master sin alterarlo.',
        command: command(fileName, profileKey, engine || 'ai'),
        fileName,
        isImage: isImg,
      };
    }

    if (isImg && typeof document !== 'undefined') {
      // Real mathematical image upscale in-browser with Lanczos-3
      const img = await loadImage(file);
      const sw = img.naturalWidth || img.width;
      const sh = img.naturalHeight || img.height;

      let dw, dh;
      if (profile.scale) {
        dw = sw * profile.scale;
        dh = sh * profile.scale;
      } else {
        const aspect = sw / sh;
        dw = profile.w || 3840;
        dh = Math.round(dw / aspect);
      }
      dw = dw & ~1; dh = dh & ~1;

      const scaler = Scaler.create({ quality: 'max', caps: opts.caps });
      const scaledCanvas = scaler.toCanvas(img, sw, sh, dw, dh);

      if (opts.onProgress) opts.onProgress(0.9);

      const blob = await new Promise((res) => scaledCanvas.toBlob(res, 'image/png'));
      scaler.dispose();

      if (opts.onProgress) opts.onProgress(1.0);

      return {
        mode: 'processed',
        blob,
        ext: 'png',
        width: dw,
        height: dh,
        scaleMode: scaler.mode || 'lanczos-gpu',
        isImage: true,
      };
    }

    // Video upscale with Lanczos-3
    const result = await Transcoder.transcode(file, {
      width: profile.w || 3840,
      height: profile.h || 2160,
      container: 'mp4',
      bitrateMbps: profile.bitrate || 25,
      fps: opts.fps || 30,
      quality: 'max',
      caps: opts.caps,
      onProgress: opts.onProgress,
    });

    return {
      mode: 'processed',
      blob: result.blob,
      ext: result.ext,
      width: result.width,
      height: result.height,
      scaleMode: result.scaleMode,
      fellBack: result.fellBack,
      isImage: false,
    };
  }

  const api = { run, PROFILES, command, isImageFile };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.KapturaUpskaletor = api;
})(typeof self !== 'undefined' ? self : this);
