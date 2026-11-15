/*
 * ============================================================================
 * KAPTURA · Local GPU Daemon Bridge (:3370)  (optional dual-track offload)
 * ============================================================================
 * Probes http://127.0.0.1:3370/health non-blockingly so static browser builds
 * work offline, while local Studio instances unlock hardware NVENC/FFmpeg.
 * ----------------------------------------------------------------------------
 */
(function (root) {
  'use strict';

  const DAEMON_BASE = (function () {
    try {
      if (root.location && root.location.port === '3370' && root.location.protocol.startsWith('http')) {
        return root.location.origin;
      }
    } catch { /* ignore */ }
    return 'http://127.0.0.1:3370';
  })();

  let cachedHealth = null;

  async function probeHealth(timeoutMs = 500) {
    try {
      const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
      const res = await fetch(`${DAEMON_BASE}/health`, {
        method: 'GET',
        signal: ctrl ? ctrl.signal : undefined,
      });
      if (timer) clearTimeout(timer);
      if (!res.ok) {
        cachedHealth = { online: false };
        return cachedHealth;
      }
      const data = await res.json();
      cachedHealth = {
        online: Boolean(data && data.online),
        ffmpegAvailable: Boolean(data && data.capabilities && data.capabilities.ffmpegAvailable),
        preferredCodec: (data && data.capabilities && data.capabilities.preferredCodec) || null,
        hardwareAccelerated: Boolean(data && data.capabilities && data.capabilities.hardwareAccelerated),
        providers: (data && data.providers) || {},
      };
      return cachedHealth;
    } catch {
      cachedHealth = { online: false };
      return cachedHealth;
    }
  }

  function getCachedHealth() {
    return cachedHealth || { online: false };
  }

  function isReadyForTranscode() {
    return Boolean(cachedHealth && cachedHealth.online && cachedHealth.ffmpegAvailable);
  }

  function fileExt(name) {
    const idx = String(name || '').lastIndexOf('.');
    return idx >= 0 ? name.slice(idx).toLowerCase() : '.webm';
  }

  async function transcodeViaDaemon(file, opts) {
    opts = opts || {};
    const container = opts.container === 'vp9' || opts.container === 'webm' ? 'webm' : 'mp4';
    const headers = {
      'Accept': 'application/octet-stream',
      'X-Kaptura-Ext': fileExt(file.name),
      'X-Kaptura-Container': container,
      'X-Kaptura-Quality': opts.quality || 'high',
    };
    if (opts.width) headers['X-Kaptura-Width'] = String(opts.width);
    if (opts.height) headers['X-Kaptura-Height'] = String(opts.height);
    if (opts.fps) headers['X-Kaptura-Fps'] = String(opts.fps);
    if (opts.bitrateMbps) headers['X-Kaptura-Bitrate'] = String(opts.bitrateMbps);
    if (opts.targetMB) headers['X-Kaptura-Target-MB'] = String(opts.targetMB);

    if (typeof opts.onProgress === 'function') opts.onProgress(0.25);
    const res = await fetch(`${DAEMON_BASE}/transcode?download=1`, {
      method: 'POST',
      headers,
      body: file,
    });
    if (!res.ok) {
      const msg = await res.text().catch(() => `HTTP ${res.status}`);
      throw new Error(`Daemon :3370 transcode failed: ${msg}`);
    }
    const blob = await res.blob();
    if (typeof opts.onProgress === 'function') opts.onProgress(1);
    const codec = res.headers.get('X-Kaptura-Codec') || (container === 'webm' ? 'libvpx-vp9' : 'h264');
    const hw = res.headers.get('X-Kaptura-HW') === 'true';
    return {
      blob,
      ext: container,
      mime: container === 'webm' ? 'video/webm' : 'video/mp4',
      width: opts.width || 0,
      height: opts.height || 0,
      codec,
      hardwareAccelerated: hw,
      scaleMode: `${hw ? 'NVENC' : 'FFmpeg'} (${codec})`,
      fellBack: false,
      viaDaemon: true,
    };
  }

  const api = {
    DAEMON_BASE,
    probeHealth,
    getCachedHealth,
    isReadyForTranscode,
    transcodeViaDaemon,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.KapturaDaemon = api;
})(typeof self !== 'undefined' ? self : this);
