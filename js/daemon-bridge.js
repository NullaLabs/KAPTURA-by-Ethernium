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
        neuralAvailable: Boolean((data && data.capabilities && data.capabilities.neuralAvailable) || (data && data.providers && data.providers.realEsrgan)),
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

  function isNeuralAvailable() {
    return Boolean(cachedHealth && cachedHealth.online && cachedHealth.neuralAvailable);
  }

  function fileExt(name) {
    const clean = String(name || '').split('?')[0];
    const idx = clean.lastIndexOf('.');
    return idx >= 0 ? clean.slice(idx).toLowerCase() : '.webm';
  }

  function nextTaskId(prefix) {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  }

  function subscribeTaskProgress(taskId, onProgress) {
    if (typeof EventSource !== 'function' || typeof onProgress !== 'function') return () => {};
    let es = null;
    try {
      es = new EventSource(`${DAEMON_BASE}/events`);
      es.addEventListener('progress', (ev) => {
        try {
          const data = JSON.parse(ev.data || '{}');
          if (!taskId || data.taskId === taskId) {
            const frac = Math.min(0.99, Math.max(0.02, (Number(data.progress) || 0) / 100));
            onProgress(frac, data);
          }
        } catch {}
      });
    } catch {}
    return () => {
      if (es) { try { es.close(); } catch {} es = null; }
    };
  }

  async function transcodeViaDaemon(file, opts) {
    opts = opts || {};
    const taskId = opts.taskId || nextTaskId('tx');
    const container = opts.container === 'vp9' || opts.container === 'webm' ? 'webm' : 'mp4';
    const sourceExport = opts.sourceExport || (file && file.remoteUrl) || '';
    const headers = {
      'X-Kaptura-Ext': fileExt((file && file.name) || sourceExport),
      'X-Kaptura-Container': container,
      'X-Kaptura-Quality': opts.quality || 'high',
      'X-Kaptura-Task-Id': taskId,
    };
    if (sourceExport) headers['X-Kaptura-Source-Export'] = String(sourceExport);
    if (opts.width) headers['X-Kaptura-Width'] = String(opts.width);
    if (opts.height) headers['X-Kaptura-Height'] = String(opts.height);
    if (opts.fps) headers['X-Kaptura-Fps'] = String(opts.fps);
    if (opts.bitrateMbps) headers['X-Kaptura-Bitrate'] = String(opts.bitrateMbps);
    if (opts.targetMB) headers['X-Kaptura-Target-MB'] = String(opts.targetMB);
    if (Number(opts.sharpen) > 0) headers['X-Kaptura-Sharpen'] = String(opts.sharpen);
    if (opts.cfr) headers['X-Kaptura-Cfr'] = '1';
    if (Number(opts.startSec) > 0) headers['X-Kaptura-Start-Sec'] = String(opts.startSec);
    if (Number(opts.endSec) > 0) headers['X-Kaptura-End-Sec'] = String(opts.endSec);

    const keepOnDisk = Boolean(opts.keepOnDisk);
    if (!keepOnDisk) headers['Accept'] = 'application/octet-stream';

    if (typeof opts.onProgress === 'function') opts.onProgress(0.05, { taskId, stage: 'UPLOADING' });
    const stopSse = subscribeTaskProgress(taskId, opts.onProgress);

    try {
      const endpoint = keepOnDisk ? `${DAEMON_BASE}/transcode` : `${DAEMON_BASE}/transcode?download=1`;
      const res = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: sourceExport ? new Uint8Array(0) : file,
      });
      if (!res.ok) {
        const msg = await res.text().catch(() => `HTTP ${res.status}`);
        throw new Error(`Daemon :3370 transcode failed: ${msg}`);
      }

      if (keepOnDisk) {
        const data = await res.json();
        if (typeof opts.onProgress === 'function') opts.onProgress(1, { taskId, stage: 'COMPLETE' });
        const remoteUrl = data.downloadUrl ? `${DAEMON_BASE}${data.downloadUrl}` : '';
        return {
          blob: null,
          remoteUrl,
          downloadUrl: data.downloadUrl || '',
          outputFile: data.outputFile || '',
          sizeBytes: data.sizeBytes || 0,
          duration: data.duration || 0,
          ext: container,
          mime: container === 'webm' ? 'video/webm' : 'video/mp4',
          width: opts.width || 0,
          height: opts.height || 0,
          codec: data.codec || (container === 'webm' ? 'libvpx-vp9' : 'h264'),
          hardwareAccelerated: Boolean(data.hardwareAccelerated),
          scaleMode: `${data.hardwareAccelerated ? 'NVENC' : 'FFmpeg'} (${data.codec || 'h264'})`,
          fellBack: false,
          viaDaemon: true,
        };
      }

      const blob = await res.blob();
      if (typeof opts.onProgress === 'function') opts.onProgress(1, { taskId, stage: 'COMPLETE' });
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
    } finally {
      stopSse();
    }
  }

  async function trimViaDaemon(fileOrSource, opts) {
    opts = opts || {};
    const taskId = opts.taskId || nextTaskId('trim');
    const sourceUrl = (fileOrSource && fileOrSource.remoteUrl) || opts.sourceExport || '';
    const startSec = Math.max(0, Number(opts.startSec) || 0);
    const endSec = Math.max(0, Number(opts.endSec) || 0);
    const reencode = Boolean(opts.reencode);

    if (typeof opts.onProgress === 'function') opts.onProgress(0.1, { taskId, stage: 'TRIMMING' });
    const stopSse = subscribeTaskProgress(taskId, opts.onProgress);
    try {
      let res;
      if (sourceUrl) {
        res = await fetch(`${DAEMON_BASE}/trim`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sourceUrl, startSec, endSec, reencode, taskId }),
        });
      } else {
        res = await fetch(`${DAEMON_BASE}/trim`, {
          method: 'POST',
          headers: {
            'X-Kaptura-Ext': fileExt(fileOrSource && fileOrSource.name),
            'X-Kaptura-Start-Sec': String(startSec),
            'X-Kaptura-End-Sec': String(endSec),
            'X-Kaptura-Reencode': String(reencode),
            'X-Kaptura-Task-Id': taskId,
          },
          body: fileOrSource,
        });
      }
      const data = await res.json().catch(() => null);
      if (!res.ok || !data || !data.success || !data.downloadUrl) {
        throw new Error((data && data.error) || `Daemon :3370 trim failed (HTTP ${res.status})`);
      }
      if (typeof opts.onProgress === 'function') opts.onProgress(1, { taskId, stage: 'COMPLETE' });
      return {
        ...data,
        remoteUrl: `${DAEMON_BASE}${data.downloadUrl}`,
        viaDaemon: true,
      };
    } finally {
      stopSse();
    }
  }

  function openCaptureSocket(opts) {
    opts = opts || {};
    if (typeof WebSocket !== 'function') {
      return Promise.reject(new Error('WebSocket API unavailable'));
    }
    const wsUrl = `${DAEMON_BASE.replace(/^http/i, 'ws')}/ws/capture`;
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';
      let settled = false;
      let stopResolver = null;
      let stopRejecter = null;
      let sendQueue = Promise.resolve();
      let stopSse = () => {};

      const failOpen = (err) => {
        if (!settled) {
          settled = true;
          reject(err);
        } else if (stopRejecter) {
          stopRejecter(err);
          stopResolver = null;
          stopRejecter = null;
        }
      };

      ws.onopen = () => {
        ws.send(JSON.stringify({
          type: 'start',
          mode: opts.mode || 'pipe-media',
          inputExt: opts.inputExt || '.webm',
          fps: opts.fps || 30,
          container: opts.container || 'mp4',
          bitrateMbps: opts.bitrateMbps || 0,
          quality: opts.quality || 'high',
        }));
      };

      ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(String(ev.data)); } catch { return; }
        if (msg.type === 'started' && !settled) {
          settled = true;
          stopSse = subscribeTaskProgress(msg.taskId, opts.onProgress);
          resolve({
            taskId: msg.taskId,
            mode: msg.mode,
            sendChunk: (chunkOrBlob) => {
              sendQueue = sendQueue.then(async () => {
                if (ws.readyState !== 1) return;
                const buf = chunkOrBlob instanceof Blob
                  ? await chunkOrBlob.arrayBuffer()
                  : chunkOrBlob;
                if (buf && buf.byteLength > 0 && ws.readyState === 1) {
                  ws.send(buf);
                }
              }).catch(() => {});
              return sendQueue;
            },
            stop: () => new Promise((resStop, rejStop) => {
              stopResolver = resStop;
              stopRejecter = rejStop;
              sendQueue.then(() => {
                if (ws.readyState === 1) {
                  ws.send(JSON.stringify({ type: 'stop' }));
                } else {
                  rejStop(new Error('Capture socket closed before stop'));
                }
              }).catch(rejStop);
            }),
            abort: () => {
              stopSse();
              try { ws.close(); } catch {}
            },
          });
        } else if (msg.type === 'ack') {
          if (typeof opts.onAck === 'function') opts.onAck(msg);
        } else if (msg.type === 'completed') {
          stopSse();
          try { ws.close(); } catch {}
          if (stopResolver) {
            const out = {
              ...msg,
              remoteUrl: msg.downloadUrl ? `${DAEMON_BASE}${msg.downloadUrl}` : '',
              viaDaemon: true,
            };
            stopResolver(out);
            stopResolver = null;
            stopRejecter = null;
          }
        } else if (msg.type === 'error') {
          const err = new Error(msg.error || 'WebSocket capture error');
          if (typeof opts.onError === 'function') opts.onError(err);
          failOpen(err);
        }
      };

      ws.onerror = () => failOpen(new Error('WebSocket connection to :3370 failed'));
      ws.onclose = () => {
        stopSse();
        if (!settled) failOpen(new Error('WebSocket closed before capture started'));
      };
    });
  }

  async function renderViaDaemon(opts) {
    opts = opts || {};
    if (typeof opts.onProgress === 'function') opts.onProgress(0.15);
    const res = await fetch(`${DAEMON_BASE}/render`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: opts.prompt || 'ETHERNIUM SOVEREIGN STUDIO',
        durationSec: opts.durationSec || 2,
        resolution: opts.resolution || '1280x720',
        fps: opts.fps || 30,
        quality: opts.quality || 'high',
      }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || !data.success || !data.downloadUrl) {
      throw new Error((data && data.error) || `Daemon :3370 render failed (HTTP ${res.status})`);
    }
    const remoteUrl = `${DAEMON_BASE}${data.downloadUrl}`;
    let blob = null;
    if (!opts.keepOnDisk) {
      if (typeof opts.onProgress === 'function') opts.onProgress(0.75);
      const binRes = await fetch(remoteUrl);
      if (!binRes.ok) throw new Error(`Failed downloading rendered clip (HTTP ${binRes.status})`);
      blob = await binRes.blob();
    }
    if (typeof opts.onProgress === 'function') opts.onProgress(1);
    const [rw, rh] = String(data.resolution || opts.resolution || '1280x720').split('x').map(Number);
    return {
      blob,
      remoteUrl,
      downloadUrl: data.downloadUrl,
      outputFile: data.outputFile,
      sizeBytes: data.sizeBytes || (blob ? blob.size : 0),
      ext: 'mp4',
      mime: 'video/mp4',
      width: rw || 1280,
      height: rh || 720,
      duration: data.duration || opts.durationSec || 2,
      codec: data.codec || 'h264',
      hardwareAccelerated: Boolean(data.hardwareAccelerated),
      viaDaemon: true,
    };
  }

  async function fetchEbwpTelemetry(timeoutMs = 800) {
    try {
      const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
      const res = await fetch(`${DAEMON_BASE}/telemetry/ebwp`, {
        method: 'GET',
        signal: ctrl ? ctrl.signal : undefined,
      });
      if (timer) clearTimeout(timer);
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  async function upscaleAiViaDaemon(file, opts) {
    opts = opts || {};
    const taskId = opts.taskId || nextTaskId('ai');
    const sourceExport = opts.sourceExport || (file && file.remoteUrl) || '';
    const isImg = /\.(png|jpe?g|webp|bmp|gif|avif)$/i.test((file && file.name) || sourceExport) || (file && file.type && file.type.startsWith('image/'));
    const headers = {
      'X-Kaptura-Ext': fileExt((file && file.name) || sourceExport),
      'X-Kaptura-Ai-Model': opts.model || 'realesr-general-x4v3',
      'X-Kaptura-Scale': String(opts.scale || 4),
      'X-Kaptura-Quality': opts.quality || 'high',
      'X-Kaptura-Task-Id': taskId,
      'Accept': 'application/octet-stream',
    };
    if (sourceExport) headers['X-Kaptura-Source-Export'] = String(sourceExport);
    if (opts.width) headers['X-Kaptura-Width'] = String(opts.width);
    if (opts.height) headers['X-Kaptura-Height'] = String(opts.height);
    if (opts.denoise) headers['X-Kaptura-Denoise'] = 'true';

    if (typeof opts.onProgress === 'function') opts.onProgress(0.05, { taskId, stage: 'UPLOADING' });
    const stopSse = subscribeTaskProgress(taskId, opts.onProgress);

    try {
      const res = await fetch(`${DAEMON_BASE}/upscale-ai?download=1`, {
        method: 'POST',
        headers,
        body: sourceExport ? new Uint8Array(0) : file,
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => `HTTP ${res.status}`);
        throw new Error(`Daemon :3370 neural upscale failed: ${errText}`);
      }
      const blob = await res.blob();
      if (typeof opts.onProgress === 'function') opts.onProgress(1, { taskId, stage: 'COMPLETE' });
      const ext = isImg ? 'png' : 'mp4';
      return {
        blob,
        mime: isImg ? 'image/png' : 'video/mp4',
        ext,
        width: opts.width || 0,
        height: opts.height || 0,
        model: res.headers.get('X-Kaptura-Model') || opts.model || 'realesr-general-x4v3',
        scaleMode: `Real-ESRGAN (${opts.model || 'realesr-general-x4v3'})`,
        neural: true,
        fellBack: false,
        viaDaemon: true,
      };
    } finally {
      stopSse();
    }
  }

  const api = {
    DAEMON_BASE,
    probeHealth,
    getCachedHealth,
    isReadyForTranscode,
    isNeuralAvailable,
    subscribeTaskProgress,
    transcodeViaDaemon,
    upscaleAiViaDaemon,
    trimViaDaemon,
    openCaptureSocket,
    renderViaDaemon,
    fetchEbwpTelemetry,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.KapturaDaemon = api;
})(typeof self !== 'undefined' ? self : this);
