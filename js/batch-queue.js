/*
 * ============================================================================
 * KAPTURA · Sequential GPU Batch Queue Manager
 * ============================================================================
 * Queues multiple image/video files across Upskaletor, BG Studio, Compressor,
 * and V-Converter so the 8 GB RTX 3070 executes jobs one at a time without VRAM
 * contention, while keeping the studio UI completely responsive.
 * ----------------------------------------------------------------------------
 */
(function (root) {
  'use strict';

  function createQueue() {
    let seq = 0;
    const items = [];
    const listeners = new Set();
    let running = false;
    let stopAllRequested = false;
    let activeCtrl = null;
    let activeItemId = null;

    function notify() {
      const snap = getSnapshot();
      listeners.forEach((fn) => {
        try { fn(snap); } catch {}
      });
    }

    function getSnapshot() {
      return {
        running,
        activeItemId,
        items: items.map((it) => ({ ...it })),
        queuedCount: items.filter((it) => it.status === 'queued').length,
        completedCount: items.filter((it) => it.status === 'completed').length,
        failedCount: items.filter((it) => it.status === 'failed' || it.status === 'cancelled').length,
      };
    }

    function enqueue({ file, tab, label, options = {} }) {
      seq += 1;
      const item = {
        id: `bq_${Date.now()}_${seq}`,
        seq,
        file,
        name: (file && file.name) || `media_${seq}`,
        sizeBytes: Number((file && (file.size || file.sizeBytes)) || 0) || 0,
        tab: tab || 'upskaletor',
        label: label || tab || 'JOB',
        options: { ...options },
        status: 'queued',
        progress: 0,
        stage: 'EN COLA',
        etaSec: null,
        outputUrl: '',
        outputBlob: null,
        outputName: '',
        error: '',
        addedAt: Date.now(),
      };
      items.push(item);
      notify();
      return { ...item };
    }

    function removeItem(id) {
      const idx = items.findIndex((it) => it.id === id);
      if (idx === -1) return false;
      const target = items[idx];
      if (target.status === 'running' && activeCtrl) {
        try { activeCtrl.abort(); } catch {}
        return true;
      }
      items.splice(idx, 1);
      notify();
      return true;
    }

    function clearDone() {
      for (let i = items.length - 1; i >= 0; i--) {
        if (items[i].status === 'completed' || items[i].status === 'failed' || items[i].status === 'cancelled') {
          items.splice(i, 1);
        }
      }
      notify();
    }

    function cancelAll() {
      stopAllRequested = true;
      items.forEach((it) => {
        if (it.status === 'queued') {
          it.status = 'cancelled';
          it.stage = 'CANCELADO';
        }
      });
      if (activeCtrl) {
        try { activeCtrl.abort(); } catch {}
      }
      notify();
    }

    async function runAll(executorFn) {
      if (running || typeof executorFn !== 'function') return getSnapshot();
      running = true;
      stopAllRequested = false;
      notify();

      try {
        while (!stopAllRequested) {
          const next = items.find((it) => it.status === 'queued');
          if (!next) break;
          activeItemId = next.id;
          activeCtrl = typeof AbortController === 'function' ? new AbortController() : null;
          next.status = 'running';
          next.stage = 'INICIANDO';
          next.progress = 0.02;
          notify();

          try {
            const res = await executorFn(next, {
              signal: activeCtrl ? activeCtrl.signal : undefined,
              onProgress: (p, meta) => {
                next.progress = Math.max(0, Math.min(1, Number(p) || 0));
                if (meta && meta.stage) next.stage = meta.stage;
                if (meta && meta.etaSec !== undefined) next.etaSec = meta.etaSec;
                notify();
              },
            });
            next.status = 'completed';
            next.progress = 1;
            next.stage = 'COMPLETADO';
            next.etaSec = 0;
            if (res) {
              next.outputUrl = res.remoteUrl || '';
              next.outputBlob = res.blob || null;
              next.outputName = res.outputName || next.name;
            }
          } catch (err) {
            if (err && err.name === 'AbortError') {
              next.status = 'cancelled';
              next.stage = 'CANCELADO';
              next.error = 'Cancelado por el operador';
            } else {
              next.status = 'failed';
              next.stage = 'ERROR';
              next.error = err && err.message ? err.message : String(err);
            }
          } finally {
            activeCtrl = null;
            activeItemId = null;
            notify();
          }
        }
      } finally {
        running = false;
        activeCtrl = null;
        activeItemId = null;
        notify();
      }
      return getSnapshot();
    }

    function subscribe(fn) {
      if (typeof fn !== 'function') return () => {};
      listeners.add(fn);
      return () => listeners.delete(fn);
    }

    return { enqueue, removeItem, clearDone, cancelAll, runAll, getSnapshot, subscribe };
  }

  const api = { createQueue };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.KapturaBatchQueue = api;
})(typeof self !== 'undefined' ? self : this);
