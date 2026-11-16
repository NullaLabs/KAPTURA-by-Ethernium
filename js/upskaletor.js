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
    '2k_cas':         { label: '2K QHD · Lanczos-3 + CAS Detail', ai: false, w: 2560, h: 1440, sharpen: 0.65, cfr: true, bitrate: 24 },
    '4k_cas':         { label: '4K UHD · Lanczos-3 + CAS Detail', ai: false, w: 3840, h: 2160, sharpen: 0.72, cfr: true, bitrate: 45 },
    '4k_ai':          { label: '4K UHD · Real-ESRGAN General (Neural)', ai: true,  w: 3840, h: 2160, model: 'realesr-general-x4v3', scale: 4 },
    'restore_ai':     { label: 'Restauración Neural · General + Denoise', ai: true, w: 3840, h: 2160, model: 'realesr-general-x4v3', scale: 4, denoise: true },
    'anime_ai':       { label: 'Anime 4K · Real-ESRGAN x4plus-anime', ai: true, w: 3840, h: 2160, model: 'realesrgan-x4plus-anime', scale: 4 },
    '4k_lanczos':     { label: '4K UHD · Lanczos-3 (in-browser)', ai: false, w: 3840, h: 2160, bitrate: 40 },
    '1080p_lanczos':  { label: '1080p · Lanczos-3 (in-browser)', ai: false, w: 1920, h: 1080, bitrate: 16 },
    '2x_super':       { label: '2X Super-Resolution (Lanczos-3 + CAS)', ai: false, scale: 2, sharpen: 0.35 },
    '4x_super':       { label: '4X Super-Resolution (Lanczos-3 + CAS)', ai: false, scale: 4, sharpen: 0.45 },
    'twitter_4k':     { label: 'Twitter/X · 4K',              ai: false, w: 3840, h: 2160, bitrate: 25 },
    'twitter_1080p':  { label: 'Twitter/X · 1080p',           ai: false, w: 1920, h: 1080, bitrate: 15 },
    'youtube_4k':     { label: 'YouTube · 4K Master',         ai: false, w: 3840, h: 2160, bitrate: 45 },
    '720p':           { label: '720p HD Compact',             ai: false, w: 1280, h: 720,  bitrate: 8 },
  };

  function command(fileName, profileKey, engine) {
    const p = PROFILES[profileKey] || PROFILES['4k_cas'];
    const isImg = isImageFile(fileName);
    const outExt = isImg ? 'png' : 'mp4';
    const mode = p.ai || engine === 'ai' ? 'AI' : 'Lanczos';
    const w = p.w || (p.scale ? p.scale * 1920 : 3840);
    const h = p.h || (p.scale ? p.scale * 1080 : 2160);
    const encFlag = engine === 'cpu' ? 'libx264' : 'Auto';
    const modelArg = mode === 'AI' ? ` -Model "${p.model || 'realesr-general-x4v3'}"` : '';
    return `.\\kpr-upscale.ps1 -InputFile ".\\${fileName}" -Mode ${mode}${modelArg} -Width ${w} -Height ${h} -Encoder ${encFlag} -OutputFile ".\\${baseName(fileName)}_UPSKALED.${outExt}"`;
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
      if (!opts.forceHandoff && root.KapturaDaemon && typeof root.KapturaDaemon.isNeuralAvailable === 'function' && root.KapturaDaemon.isNeuralAvailable()) {
        try {
          const aiRes = await root.KapturaDaemon.upscaleAiViaDaemon(file, {
            model: profile.model || 'realesr-general-x4v3',
            scale: profile.scale || 4,
            width: profile.w || 0,
            height: profile.h || 0,
            denoise: Boolean(profile.denoise),
            quality: 'high',
            onProgress: opts.onProgress,
          });
          if (aiRes && aiRes.blob) {
            return {
              mode: 'processed',
              blob: aiRes.blob,
              ext: aiRes.ext,
              width: aiRes.width || profile.w || 3840,
              height: aiRes.height || profile.h || 2160,
              scaleMode: aiRes.scaleMode,
              fellBack: false,
              isImage: isImg,
              neural: true,
            };
          }
        } catch {
          // Fall through cleanly to honest handoff when neural daemon pass fails or binary missing
        }
      }
      // Honest: when Real-ESRGAN Vulkan is unavailable locally, hand off cleanly without faking AI.
      return {
        mode: 'handoff',
        reason: 'El escalado neuronal Real-ESRGAN requiere realesrgan-ncnn-vulkan (no detectado en el host/daemon :3370). KAPTURA entrega el master sin alterarlo.',
        command: command(fileName, profileKey, engine || 'ai'),
        fileName,
        isImage: isImg,
      };
    }

    if (isImg && typeof document !== 'undefined') {
      // Real mathematical image upscale in-browser with Lanczos-3 + optional CAS
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

      const scaler = Scaler.create({ quality: 'max', caps: opts.caps, sharpen: profile.sharpen || 0 });
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

    // Video upscale with Lanczos-3 (prefer unified GPU daemon :3370 when online, fallback cleanly to browser)
    const targetW = profile.w || 3840;
    const targetH = profile.h || 2160;
    let result = null;
    if (root.KapturaDaemon && root.KapturaDaemon.isReadyForTranscode()) {
      try {
        result = await root.KapturaDaemon.transcodeViaDaemon(file, {
          width: targetW,
          height: targetH,
          container: 'mp4',
          bitrateMbps: profile.bitrate || 25,
          fps: opts.fps || 30,
          quality: 'max',
          sharpen: profile.sharpen || 0,
          cfr: Boolean(profile.cfr),
          onProgress: opts.onProgress,
        });
      } catch {
        result = null;
      }
    }
    if (!result) {
      result = await Transcoder.transcode(file.remoteUrl || file, {
        width: targetW,
        height: targetH,
        container: 'mp4',
        bitrateMbps: profile.bitrate || 25,
        fps: opts.fps || 30,
        quality: 'max',
        sharpen: profile.sharpen || 0,
        cfr: Boolean(profile.cfr),
        caps: opts.caps,
        onProgress: opts.onProgress,
      });
    }

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
