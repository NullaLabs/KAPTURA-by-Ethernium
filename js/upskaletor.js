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
    '2k_cas':         { label: '2K QHD · Lanczos-3 + CAS Detail', media: 'both', ai: false, w: 2560, h: 1440, sharpen: 0.90, cfr: true, bitrate: 24 },
    '4k_cas':         { label: '4K UHD · Lanczos-3 + CAS Detail', media: 'both', ai: false, w: 3840, h: 2160, sharpen: 0.95, cfr: true, bitrate: 45 },
    '4k_ai':          { label: '4K UHD · Real-ESRGAN x4plus (Neural)', media: 'both', ai: true, pipeline: 'esrgan', w: 3840, h: 2160, model: 'realesrgan-x4plus', scale: 4 },
    'restore_ai':     { label: 'Restauración Neural · x4plus + Denoise', media: 'both', ai: true, pipeline: 'esrgan', w: 3840, h: 2160, model: 'realesrgan-x4plus', scale: 4, denoise: true },
    'anime_ai':       { label: 'Anime / Video Fast · Real-ESRGAN v3', media: 'both', ai: true, pipeline: 'esrgan', w: 3840, h: 2160, model: 'realesr-animevideov3', scale: 4 },
    'rife_2x':        { label: 'RIFE v4.6 · Interpolación Neural 2× FPS', media: 'video', ai: true, pipeline: 'rife', rifeMult: 2, w: 0, h: 0 },
    'hybrid_4k_rife': { label: 'HYBRID ULTRA · Real-ESRGAN 4K + RIFE 2× FPS', media: 'video', ai: true, pipeline: 'hybrid', model: 'realesrgan-x4plus', scale: 4, rifeMult: 2, w: 3840, h: 2160 },
    '4k_lanczos':     { label: '4K UHD · Lanczos-3 (in-browser)', media: 'both', ai: false, w: 3840, h: 2160, bitrate: 40 },
    '1080p_lanczos':  { label: '1080p · Lanczos-3 (in-browser)', media: 'both', ai: false, w: 1920, h: 1080, bitrate: 16 },
    '2x_super':       { label: '2X Super-Resolution (Lanczos-3 + CAS)', media: 'image', ai: false, scale: 2, sharpen: 0.70 },
    '4x_super':       { label: '4X Super-Resolution (Lanczos-3 + CAS)', media: 'image', ai: false, scale: 4, sharpen: 0.85 },
    'twitter_4k':     { label: 'Twitter/X · 4K',              media: 'video', ai: false, w: 3840, h: 2160, bitrate: 25 },
    'twitter_1080p':  { label: 'Twitter/X · 1080p',           media: 'video', ai: false, w: 1920, h: 1080, bitrate: 15 },
    'youtube_4k':     { label: 'YouTube · 4K Master',         media: 'video', ai: false, w: 3840, h: 2160, bitrate: 45 },
    '720p':           { label: '720p HD Compact',             media: 'both', ai: false, w: 1280, h: 720,  bitrate: 8 },
  };

  function isProfileCompatible(profileKey, mediaKind) {
    const p = PROFILES[profileKey];
    if (!p) return true;
    const rule = p.media || 'both';
    if (rule === 'both' || !mediaKind) return true;
    return rule === mediaKind;
  }

  function command(fileName, profileKey, engine) {
    const p = PROFILES[profileKey] || PROFILES['4k_cas'];
    const isImg = isImageFile(fileName);
    const outExt = isImg ? 'png' : 'mp4';
    const mode = p.ai || engine === 'ai' ? 'AI' : 'Lanczos';
    const w = p.w || (p.scale ? p.scale * 1920 : 3840);
    const h = p.h || (p.scale ? p.scale * 1080 : 2160);
    const encFlag = engine === 'cpu' ? 'libx264' : 'Auto';
    const modelArg = mode === 'AI' ? ` -Model "${p.model || 'realesrgan-x4plus'}"` : '';
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
    const hasSharpenOpt = opts.sharpen !== undefined && opts.sharpen !== null && !Number.isNaN(Number(opts.sharpen));
    const resolvedSharpen = hasSharpenOpt ? Math.max(0, Number(opts.sharpen)) : (profile.sharpen || 0);

    if (profile.ai) {
      const pipe = profile.pipeline || 'esrgan';
      const hasNeural = Boolean(root.KapturaDaemon && typeof root.KapturaDaemon.isNeuralAvailable === 'function' && root.KapturaDaemon.isNeuralAvailable());
      const hasRife = Boolean(root.KapturaDaemon && typeof root.KapturaDaemon.isRifeAvailable === 'function' && root.KapturaDaemon.isRifeAvailable());
      const canRun = !opts.forceHandoff && (
        (pipe === 'rife' && hasRife) ||
        (pipe === 'hybrid' && hasNeural && hasRife) ||
        (pipe === 'esrgan' && hasNeural)
      );
      if (canRun) {
        try {
          const aiRes = await root.KapturaDaemon.upscaleAiViaDaemon(file, {
            pipeline: pipe,
            model: profile.model || 'realesrgan-x4plus',
            scale: profile.scale || 4,
            rifeMult: profile.rifeMult || 2,
            width: profile.w || 0,
            height: profile.h || 0,
            denoise: Boolean(profile.denoise),
            sharpen: hasSharpenOpt ? resolvedSharpen : undefined,
            previewSec: Number(opts.previewSec) || 0,
            previewStartSec: Number(opts.previewStartSec) || 0,
            keepOnDisk: !isImg,
            quality: 'high',
            taskId: opts.taskId,
            signal: opts.signal,
            onProgress: opts.onProgress,
          });
          if (aiRes && (aiRes.blob || aiRes.remoteUrl)) {
            return {
              mode: 'processed',
              blob: aiRes.blob || null,
              remoteUrl: aiRes.remoteUrl || '',
              sizeBytes: aiRes.sizeBytes || (aiRes.blob ? aiRes.blob.size : 0),
              ext: aiRes.ext,
              pipeline: aiRes.pipeline || pipe,
              width: aiRes.width || profile.w || 0,
              height: aiRes.height || profile.h || 0,
              scaleMode: aiRes.scaleMode,
              integrity: aiRes.integrity || null,
              previewMode: Boolean(aiRes.previewMode),
              previewSourceUrl: aiRes.previewSourceUrl || '',
              fellBack: false,
              isImage: isImg,
              neural: true,
            };
          }
        } catch (err) {
          if (err && err.name === 'AbortError') throw err;
          // Fall through cleanly to honest handoff when neural daemon pass fails or binary missing
        }
      }
      // Honest: when Real-ESRGAN / RIFE Vulkan is unavailable locally, hand off cleanly without faking AI.
      return {
        mode: 'handoff',
        reason: pipe === 'rife'
          ? 'La interpolación neuronal RIFE v4.6 requiere rife-ncnn-vulkan (no detectado en el host/daemon :3370).'
          : 'El escalado neuronal Real-ESRGAN requiere realesrgan-ncnn-vulkan (no detectado en el host/daemon :3370). KAPTURA entrega el master sin alterarlo.',
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

      const scaler = Scaler.create({ quality: 'max', caps: opts.caps, sharpen: resolvedSharpen });
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
          sharpen: resolvedSharpen,
          cfr: Boolean(profile.cfr),
          previewSec: Number(opts.previewSec) || 0,
          previewStartSec: Number(opts.previewStartSec) || 0,
          keepOnDisk: true,
          taskId: opts.taskId,
          signal: opts.signal,
          onProgress: opts.onProgress,
        });
      } catch (err) {
        if (err && err.name === 'AbortError') throw err;
        result = null;
      }
    }
    if (!result) {
      const pSec = Number(opts.previewSec) || 0;
      const pStart = Math.max(0, Number(opts.previewStartSec) || 0);
      result = await Transcoder.transcode(file.remoteUrl || file, {
        width: targetW,
        height: targetH,
        container: 'mp4',
        bitrateMbps: profile.bitrate || 25,
        fps: opts.fps || 30,
        quality: 'max',
        sharpen: resolvedSharpen,
        cfr: Boolean(profile.cfr),
        ...(pSec > 0 ? { startSec: pStart, endSec: pStart + pSec } : {}),
        caps: opts.caps,
        onProgress: opts.onProgress,
      });
    }

    return {
      mode: 'processed',
      blob: result.blob || null,
      remoteUrl: result.remoteUrl || '',
      sizeBytes: result.sizeBytes || (result.blob ? result.blob.size : 0),
      ext: result.ext,
      width: result.width,
      height: result.height,
      scaleMode: result.scaleMode,
      integrity: result.integrity || null,
      previewMode: Boolean(result.previewMode || Number(opts.previewSec) > 0),
      previewSourceUrl: result.previewSourceUrl || '',
      fellBack: result.fellBack,
      isImage: false,
    };
  }

  const api = { run, PROFILES, command, isImageFile, isProfileCompatible };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.KapturaUpskaletor = api;
})(typeof self !== 'undefined' ? self : this);
