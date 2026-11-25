/*
 * ============================================================================
 * KAPTURA · Pre-Flight Media Diagnostic & Real ETA Estimator
 * ============================================================================
 * Probes dropped images/videos instantly in browser + enriches via :3370 /probe
 * when available so operators see resolution, FPS, codecs, 4K native bypass,
 * and realistic processing ETA before starting GPU work.
 * ----------------------------------------------------------------------------
 */
(function (root) {
  'use strict';

  function isImageLike(fileOrSrc) {
    if (!fileOrSrc) return false;
    if (typeof fileOrSrc === 'object') {
      const m = String(fileOrSrc.type || fileOrSrc.mime || '');
      if (m.startsWith('image/')) return true;
      if (m.startsWith('video/')) return false;
    }
    const name = typeof fileOrSrc === 'string' ? fileOrSrc : (fileOrSrc.name || '');
    return /\.(png|jpe?g|webp|bmp|avif)$/i.test(name);
  }

  function formatDuration(sec) {
    const s = Number(sec) || 0;
    if (s <= 0) return '0:00';
    if (s < 10) return `${s.toFixed(1)}s`;
    const mins = Math.floor(s / 60);
    const rem = Math.round(s % 60);
    return `${mins}:${String(rem).padStart(2, '0')}`;
  }

  function formatEta(sec) {
    if (sec === null || sec === undefined || !Number.isFinite(Number(sec))) return '--';
    const s = Math.max(1, Math.round(Number(sec)));
    if (s < 60) return `~${s}s`;
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `~${m}m ${r}s`;
  }

  function estimateEtaSec(meta, profileKey, daemonHealth) {
    if (!meta) return null;
    if (meta.estimates && Object.prototype.hasOwnProperty.call(meta.estimates, profileKey)) {
      return meta.estimates[profileKey];
    }
    const w = Number(meta.width) || 0;
    const h = Number(meta.height) || 0;
    const fps = Math.max(1, Number(meta.fps) || 30);
    const dur = Math.max(0, Number(meta.duration) || 0);
    const hSafe = daemonHealth || {};
    const isImg = Boolean(meta.isImage || meta.kind === 'image');

    if (isImg) {
      const mpx = Math.max(0.5, (w * h) / 1e6 || 1);
      if (profileKey === 'bg_remove') return hSafe.bgRemoval && hSafe.bgRemoval.birefnet ? 3 : 1;
      if (profileKey === '4k_ai' || profileKey === 'restore_ai' || profileKey === 'anime_ai') {
        return hSafe.neuralAvailable ? Math.max(1, Math.round(1.4 + mpx * 0.6)) : null;
      }
      return 1;
    }

    const effDur = dur > 0 ? dur : 5;
    const frames = Math.max(1, Math.round(effDur * fps));
    const already4k = w >= 3840;
    const key = String(profileKey || '4k_cas');

    if (key === 'bg_remove') {
      const hasCuda = Boolean(hSafe.bgRemoval && hSafe.bgRemoval.rvmCuda);
      const hasOnnx = Boolean(hSafe.bgRemoval && hSafe.bgRemoval.rvmOnnx);
      return Math.max(2, Math.round(frames * (hasCuda ? 0.05 : hasOnnx ? 0.35 : 0.03) + 2));
    }
    if (key === '2k_cas' || key === '4k_cas' || key === '4k_lanczos' || key === '1080p_lanczos' || key === 'twitter_4k' || key === 'twitter_1080p' || key === 'youtube_4k' || key === '720p') {
      const mult = hSafe.online && hSafe.ffmpegAvailable ? (already4k ? 0.025 : 0.015) : 0.28;
      return Math.max(1, Math.round(frames * mult + 1));
    }
    if (key === 'rife_2x') {
      if (!hSafe.rifeAvailable) return null;
      return Math.max(2, Math.round(frames * (w >= 2560 ? 0.45 : w >= 1280 ? 0.14 : 0.06) + 2));
    }
    if (key === '4k_ai' || key === 'restore_ai' || key === 'anime_ai' || key === 'hybrid_4k_rife') {
      if (!hSafe.neuralAvailable) return null;
      const perF = already4k ? 0.025 : (key === 'anime_ai' ? 0.38 : (key === 'restore_ai' ? 1.05 : (w >= 1200 ? 0.55 : 0.9)));
      const base = Math.max(2, Math.round(frames * perF + (already4k ? 1 : 2)));
      if (key === 'hybrid_4k_rife') {
        const r = Math.max(2, Math.round(frames * (w >= 2560 ? 0.45 : 0.14) + 2));
        return base + r;
      }
      return base;
    }
    return Math.max(1, Math.round(frames * 0.02 + 1));
  }

  function probeLocalFile(file) {
    if (!file) return Promise.resolve(null);
    const sizeBytes = Number(file.sizeBytes || file.size || 0) || 0;
    const isImg = isImageLike(file);
    const name = file.name || (isImg ? 'image.png' : 'video.mp4');

    if (typeof document === 'undefined' || (!(file instanceof Blob) && !file.remoteUrl)) {
      return Promise.resolve({
        kind: isImg ? 'image' : 'video',
        isImage: isImg,
        name,
        sizeBytes,
        width: Number(file.width) || 0,
        height: Number(file.height) || 0,
        duration: Number(file.duration) || 0,
        fps: Number(file.fps) || 0,
      });
    }

    const srcUrl = file instanceof Blob ? URL.createObjectURL(file) : file.remoteUrl;
    const revoke = () => { if (file instanceof Blob && srcUrl) try { URL.revokeObjectURL(srcUrl); } catch {} };

    if (isImg) {
      return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
          const w = img.naturalWidth || img.width || 0;
          const h = img.naturalHeight || img.height || 0;
          revoke();
          resolve({ kind: 'image', isImage: true, name, sizeBytes, width: w, height: h, duration: 0, fps: 0 });
        };
        img.onerror = () => {
          revoke();
          resolve({ kind: 'image', isImage: true, name, sizeBytes, width: 0, height: 0, duration: 0, fps: 0 });
        };
        img.src = srcUrl;
      });
    }

    return new Promise((resolve) => {
      const v = document.createElement('video');
      let settled = false;
      const done = (w, h, dur) => {
        if (settled) return;
        settled = true;
        v.removeAttribute('src');
        try { v.load(); } catch {}
        revoke();
        resolve({
          kind: 'video',
          isImage: false,
          name,
          sizeBytes,
          width: w || 0,
          height: h || 0,
          duration: Number.isFinite(dur) ? dur : 0,
          fps: Number(file.fps) || 0,
        });
      };
      const timer = setTimeout(() => done(0, 0, Number(file.duration) || 0), 2500);
      v.preload = 'metadata';
      v.muted = true;
      v.onloadedmetadata = () => {
        clearTimeout(timer);
        done(v.videoWidth, v.videoHeight, v.duration);
      };
      v.onerror = () => {
        clearTimeout(timer);
        done(0, 0, Number(file.duration) || 0);
      };
      v.src = srcUrl;
    });
  }

  async function probeMedia(file, daemonHealth) {
    const local = await probeLocalFile(file);
    if (!local) return null;
    const maxFastProbeBytes = 220 * 1024 * 1024;
    const canDaemonProbe = Boolean(
      !local.isImage &&
      root.KapturaDaemon &&
      typeof root.KapturaDaemon.probeViaDaemon === 'function' &&
      root.KapturaDaemon.isReadyForTranscode() &&
      (file.remoteUrl || (file instanceof Blob && file.size <= maxFastProbeBytes))
    );
    if (!canDaemonProbe) return local;

    try {
      const remote = await root.KapturaDaemon.probeViaDaemon(file);
      if (remote && remote.ok) {
        return {
          ...local,
          width: remote.width || local.width,
          height: remote.height || local.height,
          duration: remote.duration || local.duration,
          fps: remote.fps || local.fps,
          videoCodec: remote.videoCodec || null,
          bitrateKbps: remote.bitrateKbps || 0,
          hasAudio: remote.hasAudio,
          audioCodec: remote.audioCodec || null,
          already4k: Boolean(remote.already4k),
          estimates: remote.estimates || null,
          probedByDaemon: true,
        };
      }
    } catch { /* fall back to local metadata cleanly */ }
    return local;
  }

  function renderDiagnosticStrip(container, meta, profileKey, daemonHealth) {
    if (!container) return;
    if (!meta) {
      container.style.display = 'none';
      container.innerHTML = '';
      return;
    }
    container.style.display = 'flex';
    const pills = [];
    if (meta.width && meta.height) {
      const tag = meta.width >= 3840 ? '4K UHD' : (meta.width >= 2560 ? '2K QHD' : (meta.width >= 1920 ? '1080p' : (meta.width >= 1280 ? '720p' : 'SD')));
      pills.push({ text: `📐 ${meta.width}×${meta.height} (${tag})`, cls: meta.width >= 3840 ? 'accent' : '' });
    }
    if (!meta.isImage && meta.fps) pills.push({ text: `🎞️ ${meta.fps} fps`, cls: '' });
    if (!meta.isImage && meta.duration) pills.push({ text: `⏱️ ${formatDuration(meta.duration)}`, cls: '' });
    if (meta.videoCodec) {
      const aud = meta.hasAudio ? ` · ${(meta.audioCodec || 'AUDIO').toUpperCase()}` : ' · Mudo';
      pills.push({ text: `${meta.videoCodec.toUpperCase()}${aud}`, cls: '' });
    }
    if (meta.sizeBytes) pills.push({ text: `💾 ${(meta.sizeBytes / (1024 * 1024)).toFixed(2)} MB`, cls: '' });

    const eta = estimateEtaSec(meta, profileKey, daemonHealth);
    if (eta !== null) {
      pills.push({ text: `ETA ${formatEta(eta)}`, cls: 'eta' });
    }
    if (!meta.isImage && (meta.width || 0) >= 3840 && (profileKey === '4k_ai' || profileKey === 'restore_ai' || profileKey === 'anime_ai')) {
      pills.push({ text: '⚡ Origen ya 4K: usará GPU CAS directo (cero blowup 8K)', cls: 'emerald' });
    }

    container.innerHTML = '';
    pills.forEach((p) => {
      const span = document.createElement('span');
      span.className = `preflight-pill${p.cls ? ' is-' + p.cls : ''}`;
      span.textContent = p.text;
      container.appendChild(span);
    });
  }

  const api = {
    isImageLike,
    formatDuration,
    formatEta,
    estimateEtaSec,
    probeLocalFile,
    probeMedia,
    renderDiagnosticStrip,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.KapturaPreflight = api;
})(typeof self !== 'undefined' ? self : this);
