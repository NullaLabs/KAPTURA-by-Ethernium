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
        rifeAvailable: Boolean((data && data.capabilities && data.capabilities.rifeAvailable) || (data && data.providers && data.providers.rife)),
        casFilter: Boolean(data && data.capabilities && data.capabilities.casFilter),
        bgRemoval: (data && data.capabilities && data.capabilities.bgRemoval) || (data && data.providers && data.providers.bgRemoval) || {},
        encoders: (data && data.capabilities && data.capabilities.encoders) || {},
        gpu: (data && data.gpu) || { available: false },
        jobsEndpoint: (data && data.streaming && data.streaming.jobsEndpoint) || null,
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

  function isRifeAvailable() {
    return Boolean(cachedHealth && cachedHealth.online && cachedHealth.rifeAvailable);
  }

  function parseIntegrityHeaders(res) {
    if (!res || !res.headers) return null;
    const srcRes = res.headers.get('X-Kaptura-Src-Res') || '';
    const outRes = res.headers.get('X-Kaptura-Out-Res') || '';
    const srcFps = Number(res.headers.get('X-Kaptura-Src-Fps') || 0);
    const outFps = Number(res.headers.get('X-Kaptura-Out-Fps') || 0);
    const fpsDriftRaw = res.headers.get('X-Kaptura-Fps-Drift-Pct');
    const driftRaw = res.headers.get('X-Kaptura-Duration-Drift-Ms');
    const audioRaw = res.headers.get('X-Kaptura-Audio-Preserved');
    const audioCodec = res.headers.get('X-Kaptura-Audio-Codec') || '';
    const elapsedRaw = res.headers.get('X-Kaptura-Elapsed-Ms');
    if (!srcRes && !outRes && !srcFps && !outFps && !elapsedRaw) return null;
    const [srcW, srcH] = srcRes.split('x').map((n) => Number(n) || 0);
    const [outW, outH] = outRes.split('x').map((n) => Number(n) || 0);
    const fpsDriftPct = fpsDriftRaw !== null
      ? Number(fpsDriftRaw)
      : (srcFps > 0 && outFps > 0 ? Number(((Math.abs(outFps - srcFps) / srcFps) * 100).toFixed(2)) : 0);
    return {
      srcWidth: srcW || 0,
      srcHeight: srcH || 0,
      outWidth: outW || 0,
      outHeight: outH || 0,
      srcFps,
      outFps,
      fpsDriftPct,
      durationDriftMs: driftRaw !== null ? Number(driftRaw) : undefined,
      audioPreserved: audioRaw === null ? null : audioRaw === 'true',
      audioCodec,
      elapsedMs: elapsedRaw !== null ? Number(elapsedRaw) : undefined,
    };
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

  function waitForAsyncJob(taskId, opts) {
    opts = opts || {};
    return new Promise((resolve, reject) => {
      let settled = false;
      let pollTimer = null;
      let stopSse = () => {};

      const cleanup = () => {
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
        if (opts.signal && onAbort) opts.signal.removeEventListener('abort', onAbort);
        stopSse();
      };

      const finishOk = (job) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(job);
      };

      const finishErr = (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      };

      const onAbort = () => {
        cancelTaskViaDaemon(taskId);
        const ab = new Error('Cancelled by operator');
        ab.name = 'AbortError';
        finishErr(ab);
      };

      if (opts.signal) {
        if (opts.signal.aborted) { onAbort(); return; }
        opts.signal.addEventListener('abort', onAbort, { once: true });
      }

      const emitJobProgress = (data) => {
        if (!data || typeof opts.onProgress !== 'function') return;
        const frac = Math.min(0.99, Math.max(0.02, (Number(data.progress) || 0) / 100));
        opts.onProgress(frac, data);
      };

      let consecutive404 = 0;
      let consecutiveNetErr = 0;

      const checkJobStatus = async () => {
        if (settled) return;
        try {
          const r = await fetch(`${DAEMON_BASE}/jobs/${encodeURIComponent(taskId)}`, { cache: 'no-store' });
          if (r.status === 404) {
            consecutive404++;
            if (consecutive404 >= 2) {
              finishErr(new Error('El trabajo en :3370 fue interrumpido (el daemon se reinició o el ID expiró). Vuelve a iniciar el proceso.'));
            }
            return;
          }
          if (!r.ok) {
            consecutiveNetErr++;
            if (consecutiveNetErr >= 4) {
              finishErr(new Error(`Error HTTP ${r.status} consultando el trabajo en :3370.`));
            }
            return;
          }
          consecutive404 = 0;
          consecutiveNetErr = 0;
          const job = await r.json();
          if (!job || settled) return;
          if (job.status === 'completed') {
            if (typeof opts.onProgress === 'function') opts.onProgress(1, { ...job, stage: 'COMPLETE', progress: 100 });
            finishOk(job);
          } else if (job.status === 'cancelled') {
            const ab = new Error('Cancelled by operator');
            ab.name = 'AbortError';
            finishErr(ab);
          } else if (job.status === 'failed') {
            finishErr(new Error(job.error || 'Daemon :3370 GPU task failed'));
          } else {
            emitJobProgress(job);
          }
        } catch {
          consecutiveNetErr++;
          if (consecutiveNetErr >= 5) {
            finishErr(new Error('Conexión perdida con el daemon :3370 durante el procesamiento.'));
          }
        }
      };

      stopSse = subscribeTaskProgress(taskId, (frac, evt) => {
        if (settled) return;
        if (evt && evt.stage === 'CANCELLED') {
          const ab = new Error('Cancelled by operator');
          ab.name = 'AbortError';
          finishErr(ab);
          return;
        }
        if (typeof opts.onProgress === 'function') opts.onProgress(frac, evt);
        if (evt && evt.stage === 'COMPLETE') {
          checkJobStatus();
        }
      });

      pollTimer = setInterval(checkJobStatus, 1500);
      setTimeout(checkJobStatus, 300);
    });
  }

  async function transcodeViaDaemon(file, opts) {
    opts = opts || {};
    const taskId = opts.taskId || nextTaskId('tx');
    const container = opts.container === 'vp9' || opts.container === 'webm' ? 'webm' : 'mp4';
    const sourceExport = opts.sourceExport || (file && file.remoteUrl) || '';
    const useAsync = Boolean(cachedHealth && cachedHealth.jobsEndpoint && !opts.forceSync);
    const headers = {
      'X-Kaptura-Ext': fileExt((file && file.name) || sourceExport),
      'X-Kaptura-Container': container,
      'X-Kaptura-Quality': opts.quality || 'high',
      'X-Kaptura-Task-Id': taskId,
    };
    if (opts.codec) headers['X-Kaptura-Codec'] = String(opts.codec);
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
    if (Number(opts.previewSec) > 0) headers['X-Kaptura-Preview-Sec'] = String(opts.previewSec);
    if (Number(opts.previewStartSec) > 0) headers['X-Kaptura-Preview-Start'] = String(opts.previewStartSec);

    const keepOnDisk = Boolean(opts.keepOnDisk);
    if (!keepOnDisk && !useAsync) headers['Accept'] = 'application/octet-stream';

    if (typeof opts.onProgress === 'function') opts.onProgress(0.05, { taskId, stage: 'UPLOADING' });
    const stopSse = useAsync ? () => {} : subscribeTaskProgress(taskId, opts.onProgress);

    try {
      const endpoint = useAsync
        ? `${DAEMON_BASE}/transcode?async=1`
        : (keepOnDisk ? `${DAEMON_BASE}/transcode` : `${DAEMON_BASE}/transcode?download=1`);
      const res = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: sourceExport ? new Uint8Array(0) : file,
        signal: opts.signal,
      });
      if (!res.ok) {
        const msg = await res.text().catch(() => `HTTP ${res.status}`);
        throw new Error(`Daemon :3370 transcode failed: ${msg}`);
      }

      if (useAsync) {
        const accepted = await res.json();
        const activeTaskId = (accepted && accepted.taskId) || taskId;
        if (typeof opts.onProgress === 'function') opts.onProgress(0.06, { taskId: activeTaskId, stage: 'QUEUED' });
        const job = await waitForAsyncJob(activeTaskId, opts);
        const remoteUrl = job.downloadUrl ? `${DAEMON_BASE}${job.downloadUrl}` : '';
        let outBlob = null;
        if (!keepOnDisk && remoteUrl) {
          const dl = await fetch(remoteUrl, { signal: opts.signal });
          if (!dl.ok) throw new Error(`Failed to fetch transcoded file (HTTP ${dl.status})`);
          outBlob = await dl.blob();
        }
        return {
          blob: outBlob,
          remoteUrl: keepOnDisk ? remoteUrl : '',
          downloadUrl: job.downloadUrl || '',
          outputFile: job.outputFile || '',
          sizeBytes: job.sizeBytes || (outBlob ? outBlob.size : 0),
          duration: job.duration || 0,
          ext: container,
          mime: container === 'webm' ? 'video/webm' : 'video/mp4',
          width: job.width || opts.width || 0,
          height: job.height || opts.height || 0,
          codec: job.codec || (container === 'webm' ? 'libvpx-vp9' : 'h264'),
          hardwareAccelerated: Boolean(job.hardwareAccelerated),
          scaleMode: `${job.hardwareAccelerated ? 'NVENC' : 'FFmpeg'} (${job.codec || 'h264'})`,
          integrity: job.integrity || null,
          previewMode: Boolean(job.previewMode),
          previewSourceUrl: job.previewSourceDownloadUrl ? `${DAEMON_BASE}${job.previewSourceDownloadUrl}` : '',
          fellBack: false,
          viaDaemon: true,
        };
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
          width: data.width || opts.width || 0,
          height: data.height || opts.height || 0,
          codec: data.codec || (container === 'webm' ? 'libvpx-vp9' : 'h264'),
          hardwareAccelerated: Boolean(data.hardwareAccelerated),
          scaleMode: `${data.hardwareAccelerated ? 'NVENC' : 'FFmpeg'} (${data.codec || 'h264'})`,
          integrity: data.integrity || null,
          previewMode: Boolean(data.previewMode),
          previewSourceUrl: data.previewSourceDownloadUrl ? `${DAEMON_BASE}${data.previewSourceDownloadUrl}` : '',
          fellBack: false,
          viaDaemon: true,
        };
      }

      const blob = await res.blob();
      if (typeof opts.onProgress === 'function') opts.onProgress(1, { taskId, stage: 'COMPLETE' });
      const codec = res.headers.get('X-Kaptura-Codec') || (container === 'webm' ? 'libvpx-vp9' : 'h264');
      const hw = res.headers.get('X-Kaptura-HW') === 'true';
      const integrity = parseIntegrityHeaders(res);
      return {
        blob,
        ext: container,
        mime: container === 'webm' ? 'video/webm' : 'video/mp4',
        width: (integrity && integrity.outWidth) || opts.width || 0,
        height: (integrity && integrity.outHeight) || opts.height || 0,
        codec,
        hardwareAccelerated: hw,
        scaleMode: `${hw ? 'NVENC' : 'FFmpeg'} (${codec})`,
        integrity,
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
    const pipeline = opts.pipeline || 'esrgan';
    const keepOnDisk = Boolean(opts.keepOnDisk && !isImg);
    const useAsync = Boolean(cachedHealth && cachedHealth.jobsEndpoint && !opts.forceSync);
    const headers = {
      'X-Kaptura-Ext': fileExt((file && file.name) || sourceExport),
      'X-Kaptura-Pipeline': pipeline,
      'X-Kaptura-Ai-Model': opts.model || 'realesrgan-x4plus',
      'X-Kaptura-Scale': String(opts.scale || 4),
      'X-Kaptura-Rife-Mult': String(opts.rifeMult || 2),
      'X-Kaptura-Quality': opts.quality || 'high',
      'X-Kaptura-Task-Id': taskId,
    };
    if (!useAsync && !keepOnDisk) headers['Accept'] = 'application/octet-stream';
    if (sourceExport) headers['X-Kaptura-Source-Export'] = String(sourceExport);
    if (opts.width) headers['X-Kaptura-Width'] = String(opts.width);
    if (opts.height) headers['X-Kaptura-Height'] = String(opts.height);
    if (opts.codec) headers['X-Kaptura-Codec'] = String(opts.codec);
    if (opts.denoise) headers['X-Kaptura-Denoise'] = 'true';
    if (opts.sharpen !== undefined && opts.sharpen !== null && Number.isFinite(Number(opts.sharpen))) {
      headers['X-Kaptura-Sharpen'] = String(opts.sharpen);
    }
    if (Number(opts.previewSec) > 0) headers['X-Kaptura-Preview-Sec'] = String(opts.previewSec);
    if (Number(opts.previewStartSec) > 0) headers['X-Kaptura-Preview-Start'] = String(opts.previewStartSec);

    if (typeof opts.onProgress === 'function') opts.onProgress(0.05, { taskId, stage: 'UPLOADING' });
    const stopSse = useAsync ? () => {} : subscribeTaskProgress(taskId, opts.onProgress);

    try {
      const endpoint = useAsync
        ? `${DAEMON_BASE}/upscale-ai?async=1`
        : `${DAEMON_BASE}/upscale-ai?download=1`;
      const res = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: sourceExport ? new Uint8Array(0) : file,
        signal: opts.signal,
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => `HTTP ${res.status}`);
        throw new Error(`Daemon :3370 neural upscale failed: ${errText}`);
      }

      if (useAsync) {
        const accepted = await res.json();
        const activeTaskId = (accepted && accepted.taskId) || taskId;
        if (typeof opts.onProgress === 'function') opts.onProgress(0.06, { taskId: activeTaskId, stage: 'QUEUED' });
        const job = await waitForAsyncJob(activeTaskId, opts);
        const remoteUrl = job.downloadUrl ? `${DAEMON_BASE}${job.downloadUrl}` : '';
        let outBlob = null;
        if (!keepOnDisk && remoteUrl) {
          const dl = await fetch(remoteUrl, { signal: opts.signal });
          if (!dl.ok) throw new Error(`Failed to fetch neural artifact (HTTP ${dl.status})`);
          outBlob = await dl.blob();
        }
        const ext = isImg ? 'png' : 'mp4';
        const modelUsed = job.model || opts.model || 'realesrgan-x4plus';
        const pipeUsed = job.pipeline || pipeline;
        const isNativeCas = Boolean(job.sourceAlreadyTarget || String(modelUsed).startsWith('gpu-native-cas'));
        const modeTag = isNativeCas
          ? 'GPU CAS Native (4K source preserved)'
          : (pipeUsed === 'rife'
            ? `RIFE v4.6 (${opts.rifeMult || 2}× FPS)`
            : (pipeUsed === 'hybrid' ? `Real-ESRGAN (${modelUsed}) + RIFE v4.6` : `Real-ESRGAN (${modelUsed})`));
        return {
          blob: outBlob,
          remoteUrl: remoteUrl || '',
          downloadUrl: job.downloadUrl || '',
          outputFile: job.outputFile || '',
          sizeBytes: job.sizeBytes || (outBlob ? outBlob.size : 0),
          mime: isImg ? 'image/png' : 'video/mp4',
          ext,
          pipeline: pipeUsed,
          width: job.width || opts.width || 0,
          height: job.height || opts.height || 0,
          model: modelUsed,
          scaleMode: modeTag,
          integrity: job.integrity || null,
          previewMode: Boolean(job.previewMode),
          previewSourceUrl: job.previewSourceDownloadUrl ? `${DAEMON_BASE}${job.previewSourceDownloadUrl}` : '',
          neural: !isNativeCas && job.neural !== false,
          fellBack: false,
          viaDaemon: true,
        };
      }

      const blob = await res.blob();
      if (typeof opts.onProgress === 'function') opts.onProgress(1, { taskId, stage: 'COMPLETE' });
      const ext = isImg ? 'png' : 'mp4';
      const integrity = parseIntegrityHeaders(res);
      const modelUsed = res.headers.get('X-Kaptura-Model') || opts.model || 'realesrgan-x4plus';
      const pipeUsed = res.headers.get('X-Kaptura-Pipeline') || pipeline;
      const modeTag = pipeUsed === 'rife'
        ? `RIFE v4.6 (${opts.rifeMult || 2}× FPS)`
        : (pipeUsed === 'hybrid' ? `Real-ESRGAN (${modelUsed}) + RIFE v4.6` : `Real-ESRGAN (${modelUsed})`);
      return {
        blob,
        mime: isImg ? 'image/png' : 'video/mp4',
        ext,
        pipeline: pipeUsed,
        width: (integrity && integrity.outWidth) || opts.width || 0,
        height: (integrity && integrity.outHeight) || opts.height || 0,
        model: modelUsed,
        scaleMode: modeTag,
        integrity,
        neural: true,
        fellBack: false,
        viaDaemon: true,
      };
    } finally {
      stopSse();
    }
  }

  async function probeViaDaemon(fileOrSource, timeoutMs = 6000) {
    const sourceExport = (fileOrSource && fileOrSource.remoteUrl) || '';
    const headers = { 'X-Kaptura-Ext': fileExt((fileOrSource && fileOrSource.name) || sourceExport) };
    if (sourceExport) headers['X-Kaptura-Source-Export'] = String(sourceExport);
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
    try {
      const res = await fetch(`${DAEMON_BASE}/probe`, {
        method: 'POST',
        headers,
        body: sourceExport ? new Uint8Array(0) : fileOrSource,
        signal: ctrl ? ctrl.signal : undefined,
      });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function checkUrlAlive(url, timeoutMs = 1200) {
    if (!url) return false;
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
    try {
      const res = await fetch(url, { method: 'HEAD', cache: 'no-store', signal: ctrl ? ctrl.signal : undefined });
      return res.ok;
    } catch {
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function checkUrlsAliveBatch(urls, timeoutMs = 2000) {
    if (!Array.isArray(urls) || !urls.length) return {};
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
    try {
      const res = await fetch(`${DAEMON_BASE}/vault/check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls }),
        cache: 'no-store',
        signal: ctrl ? ctrl.signal : undefined,
      });
      if (!res.ok) return null;
      const data = await res.json().catch(() => null);
      return (data && data.ok && data.alive && typeof data.alive === 'object') ? data.alive : null;
    } catch {
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function pinExportViaDaemon(sourceUrl) {
    if (!sourceUrl) throw new Error('URL del artefacto requerida para fijar en disco.');
    const res = await fetch(`${DAEMON_BASE}/vault/pin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceUrl }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || !data.ok) {
      throw new Error((data && data.error) || `No se pudo fijar el artefacto (HTTP ${res.status})`);
    }
    return {
      ...data,
      remoteUrl: data.downloadUrl ? `${DAEMON_BASE}${data.downloadUrl}` : '',
    };
  }

  async function deletePinnedExportViaDaemon(remoteUrl) {
    if (!remoteUrl || !String(remoteUrl).includes('/exports/vault/')) return { ok: false };
    try {
      const target = String(remoteUrl).startsWith('http') ? remoteUrl : `${DAEMON_BASE}${remoteUrl}`;
      const res = await fetch(target, { method: 'DELETE' });
      return { ok: res.ok };
    } catch {
      return { ok: false };
    }
  }

  async function uploadBgBackdropViaDaemon(file) {
    if (!file) return null;
    const res = await fetch(`${DAEMON_BASE}/remove-bg/backdrop`, {
      method: 'POST',
      headers: { 'X-Kaptura-Ext': fileExt(file.name || 'bg.png') },
      body: file,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || !data.ok) {
      throw new Error((data && data.error) || `Backdrop upload failed (HTTP ${res.status})`);
    }
    return data;
  }

  async function removeBgViaDaemon(file, opts) {
    opts = opts || {};
    const taskId = opts.taskId || nextTaskId('bg');
    const sourceExport = opts.sourceExport || (file && file.remoteUrl) || '';
    const isImg = Boolean(opts.isImage || /\.(png|jpe?g|webp|bmp|avif)$/i.test((file && file.name) || sourceExport));
    const keepOnDisk = Boolean(opts.keepOnDisk && !isImg);
    const useAsync = Boolean(cachedHealth && cachedHealth.jobsEndpoint && !opts.forceSync);
    const backdrop = opts.backdrop || 'transparent';
    const expectedExt = isImg ? 'png' : (backdrop === 'transparent' ? 'webm' : (backdrop === 'prores' ? 'mov' : 'mp4'));

    const headers = {
      'X-Kaptura-Ext': fileExt((file && file.name) || sourceExport),
      'X-Kaptura-Bg-Engine': opts.engine || 'auto',
      'X-Kaptura-Bg-Backdrop': backdrop,
      'X-Kaptura-Bg-Color': opts.bgColor || '#050814',
      'X-Kaptura-Bg-Blur': String(opts.blurStrength ?? 23),
      'X-Kaptura-Bg-Edge': String(opts.edgeRefine ?? 0),
      'X-Kaptura-Bg-Decontaminate': opts.decontaminate === false ? '0' : '1',
      'X-Kaptura-Bg-Key-Color': opts.keyColor || '#00FF00',
      'X-Kaptura-Bg-Similarity': String(opts.similarity ?? 0.18),
      'X-Kaptura-Bg-Blend': String(opts.blend ?? 0.08),
      'X-Kaptura-Task-Id': taskId,
    };
    if (opts.codec) headers['X-Kaptura-Codec'] = String(opts.codec);
    if (opts.bgImageRef) headers['X-Kaptura-Bg-Image-Ref'] = String(opts.bgImageRef);
    if (sourceExport) headers['X-Kaptura-Source-Export'] = String(sourceExport);
    if (Number(opts.previewSec) > 0) headers['X-Kaptura-Preview-Sec'] = String(opts.previewSec);
    if (Number(opts.previewStartSec) > 0) headers['X-Kaptura-Preview-Start'] = String(opts.previewStartSec);
    if (!useAsync && !keepOnDisk) headers['Accept'] = 'application/octet-stream';

    if (typeof opts.onProgress === 'function') opts.onProgress(0.05, { taskId, stage: 'UPLOADING' });
    const stopSse = useAsync ? () => {} : subscribeTaskProgress(taskId, opts.onProgress);

    try {
      const endpoint = useAsync
        ? `${DAEMON_BASE}/remove-bg?async=1`
        : (keepOnDisk ? `${DAEMON_BASE}/remove-bg` : `${DAEMON_BASE}/remove-bg?download=1`);
      const res = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: sourceExport ? new Uint8Array(0) : file,
        signal: opts.signal,
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => `HTTP ${res.status}`);
        throw new Error(`Daemon :3370 BG Studio failed: ${errText}`);
      }

      if (useAsync) {
        const accepted = await res.json();
        const activeTaskId = (accepted && accepted.taskId) || taskId;
        if (typeof opts.onProgress === 'function') opts.onProgress(0.06, { taskId: activeTaskId, stage: accepted.status === 'queued' ? 'QUEUED' : 'PROCESSING', queuePosition: accepted.queuePosition });
        const job = await waitForAsyncJob(activeTaskId, opts);
        const remoteUrl = job.downloadUrl ? `${DAEMON_BASE}${job.downloadUrl}` : '';
        let outBlob = null;
        if (!keepOnDisk && remoteUrl) {
          const dl = await fetch(remoteUrl, { signal: opts.signal });
          if (!dl.ok) throw new Error(`Failed to fetch BG result (HTTP ${dl.status})`);
          outBlob = await dl.blob();
        }
        const outExt = job.outputFile && job.outputFile.includes('.') ? job.outputFile.split('.').pop().toLowerCase() : expectedExt;
        return {
          blob: outBlob,
          remoteUrl: remoteUrl || '',
          downloadUrl: job.downloadUrl || '',
          outputFile: job.outputFile || '',
          sizeBytes: job.sizeBytes || (outBlob ? outBlob.size : 0),
          ext: outExt,
          width: job.width || 0,
          height: job.height || 0,
          hasAlpha: Boolean(job.hasAlpha),
          engine: job.engine || (opts.engine || 'auto'),
          model: job.model || '',
          scaleMode: `${job.engine === 'birefnet_hr' ? 'BiRefNet HR-Matting 2K CUDA FP16 + RGB GF + MLFE' : (job.engine === 'rvm_cuda' ? 'RVM ResNet50 CUDA FP16 + RGB GF' : (job.engine === 'birefnet' ? 'BiRefNet 1024px ONNX + RGB GF + MLFE' : (job.engine === 'rvm_onnx' ? 'RVM MobileNetV3 ONNX' : 'FFmpeg Chromakey+Despill GPU')))}`,
          integrity: job.integrity || null,
          previewMode: Boolean(job.previewMode),
          previewSourceUrl: job.previewSourceDownloadUrl ? `${DAEMON_BASE}${job.previewSourceDownloadUrl}` : '',
          viaDaemon: true,
        };
      }

      if (keepOnDisk) {
        const data = await res.json();
        const remoteUrl = data.downloadUrl ? `${DAEMON_BASE}${data.downloadUrl}` : '';
        return {
          blob: null,
          remoteUrl,
          downloadUrl: data.downloadUrl || '',
          outputFile: data.outputFile || '',
          sizeBytes: data.sizeBytes || 0,
          ext: expectedExt,
          width: data.width || 0,
          height: data.height || 0,
          hasAlpha: Boolean(data.hasAlpha),
          engine: data.engine || 'auto',
          model: data.model || '',
          scaleMode: `BG Studio :3370 (${data.engine || 'auto'})`,
          integrity: data.integrity || null,
          previewMode: Boolean(data.previewMode),
          previewSourceUrl: data.previewSourceDownloadUrl ? `${DAEMON_BASE}${data.previewSourceDownloadUrl}` : '',
          viaDaemon: true,
        };
      }

      const blob = await res.blob();
      if (typeof opts.onProgress === 'function') opts.onProgress(1, { taskId, stage: 'COMPLETE' });
      const integrity = parseIntegrityHeaders(res);
      return {
        blob,
        ext: expectedExt,
        width: (integrity && integrity.outWidth) || 0,
        height: (integrity && integrity.outHeight) || 0,
        hasAlpha: backdrop === 'transparent' || backdrop === 'prores',
        engine: opts.engine || 'auto',
        model: res.headers.get('X-Kaptura-Model') || '',
        scaleMode: `BG Studio :3370 (${res.headers.get('X-Kaptura-Model') || opts.engine || 'auto'})`,
        integrity,
        viaDaemon: true,
      };
    } finally {
      stopSse();
    }
  }

  async function fetchGpuTelemetry(timeoutMs = 1500) {
    try {
      const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
      const res = await fetch(`${DAEMON_BASE}/telemetry/gpu`, { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined });
      if (timer) clearTimeout(timer);
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  async function fetchJobsList(timeoutMs = 1500) {
    try {
      const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
      const res = await fetch(`${DAEMON_BASE}/jobs`, { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined });
      if (timer) clearTimeout(timer);
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  async function cancelTaskViaDaemon(taskId) {
    if (!taskId) return { ok: false, cancelled: false };
    try {
      const res = await fetch(`${DAEMON_BASE}/cancel/${encodeURIComponent(taskId)}`, { method: 'POST' });
      if (!res.ok) return { ok: false, cancelled: false };
      return await res.json();
    } catch {
      return { ok: false, cancelled: false };
    }
  }

  const api = {
    DAEMON_BASE,
    probeHealth,
    probeViaDaemon,
    getCachedHealth,
    isReadyForTranscode,
    isNeuralAvailable,
    isRifeAvailable,
    subscribeTaskProgress,
    transcodeViaDaemon,
    upscaleAiViaDaemon,
    uploadBgBackdropViaDaemon,
    removeBgViaDaemon,
    cancelTaskViaDaemon,
    checkUrlAlive,
    checkUrlsAliveBatch,
    pinExportViaDaemon,
    deletePinnedExportViaDaemon,
    trimViaDaemon,
    openCaptureSocket,
    renderViaDaemon,
    fetchEbwpTelemetry,
    fetchGpuTelemetry,
    fetchJobsList,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.KapturaDaemon = api;
})(typeof self !== 'undefined' ? self : this);
