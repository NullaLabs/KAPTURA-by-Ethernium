/*
 * ============================================================================
 * KAPTURA · App orchestrator  (UI wiring only — no engine logic lives here)
 * ============================================================================
 * Ties the independent modules together, owns the DOM, and guarantees the
 * honesty rules: real progress, real filenames, revoked object URLs, escaped
 * user text, and visible (non-blocking) error/notice toasts.
 * ----------------------------------------------------------------------------
 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const caps = window.KapturaCaps.detect();

  /* ---- toast notifications --------------------------------------------- */
  const toastStack = $('toastStack');
  function toast(message, kind = 'notice', ttl = 5000) {
    const el = document.createElement('div');
    el.className = 'toast ' + kind;
    el.textContent = message;
    toastStack.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, ttl);
  }

  /* ---- helpers ---------------------------------------------------------- */
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }
  function downloadBlob(blobOrUrl, filename) {
    if (!blobOrUrl) return;
    if (typeof blobOrUrl === 'string') {
      const a = document.createElement('a');
      a.style.display = 'none'; a.href = blobOrUrl; a.download = filename;
      document.body.appendChild(a); a.click();
      setTimeout(() => a.remove(), 200);
      return;
    }
    const url = URL.createObjectURL(blobOrUrl);
    const a = document.createElement('a');
    a.style.display = 'none'; a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 200);
  }
  function stamp() { return new Date().toISOString().replace(/[:.]/g, '-'); }
  function setProgress(bgId, fillId, ratio) {
    const bg = $(bgId), fill = $(fillId);
    if (bg) bg.style.display = 'block';
    if (fill) fill.style.width = Math.round(ratio * 100) + '%';
  }

  /* ---- adaptive media-type locks (image vs video) ----------------------- */
  function detectMediaKind(fileOrSrc) {
    if (!fileOrSrc) return 'video';
    if (typeof fileOrSrc === 'object') {
      const mime = String(fileOrSrc.type || fileOrSrc.mime || '');
      if (mime.startsWith('image/')) return 'image';
      if (mime.startsWith('video/')) return 'video';
    }
    if (window.KapturaUpskaletor && typeof window.KapturaUpskaletor.isImageFile === 'function') {
      return window.KapturaUpskaletor.isImageFile(fileOrSrc) ? 'image' : 'video';
    }
    if (window.KapturaSVGVector && typeof window.KapturaSVGVector.isImageFile === 'function') {
      return window.KapturaSVGVector.isImageFile(fileOrSrc) ? 'image' : 'video';
    }
    const name = (typeof fileOrSrc === 'string' ? fileOrSrc : fileOrSrc.name) || '';
    return /\.(png|jpe?g|webp|bmp|gif|avif)$/i.test(name) ? 'image' : 'video';
  }

  function syncSelectLocks(sel, ruleFn, fallbackValue) {
    if (!sel || !sel.options) return;
    let firstEnabled = '';
    Array.from(sel.options).forEach((opt) => {
      const res = ruleFn(opt);
      const locked = typeof res === 'object' ? Boolean(res && res.locked) : Boolean(res);
      const reason = typeof res === 'object' ? String((res && res.reason) || '') : (locked ? 'NO COMPATIBLE' : '');
      opt.disabled = locked;
      if (locked && reason) opt.dataset.lockReason = reason;
      else delete opt.dataset.lockReason;
      if (!locked && !firstEnabled) firstEnabled = opt.value;
    });
    const curOpt = sel.options[sel.selectedIndex];
    if (curOpt && curOpt.disabled) {
      const fbOpt = fallbackValue ? Array.from(sel.options).find((o) => o.value === fallbackValue && !o.disabled) : null;
      const nextVal = fbOpt ? fbOpt.value : firstEnabled;
      if (nextVal) {
        sel.value = nextVal;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
    if (window.KapturaStudioSelects && typeof window.KapturaStudioSelects.refreshSelect === 'function') {
      window.KapturaStudioSelects.refreshSelect(sel);
    }
  }

  function setCardMediaLock(sel, locked, reasonText) {
    if (!sel) return;
    sel.disabled = Boolean(locked);
    const card = sel.closest('.control-card');
    if (card) {
      card.classList.toggle('is-media-locked', Boolean(locked));
      let badge = card.querySelector('.media-lock-badge');
      if (locked) {
        if (!badge) {
          badge = document.createElement('div');
          badge.className = 'media-lock-badge';
          card.appendChild(badge);
        }
        badge.textContent = `🔒 ${reasonText || 'No aplica para este medio'}`;
      } else if (badge) {
        badge.remove();
      }
    }
    if (window.KapturaStudioSelects && typeof window.KapturaStudioSelects.refreshSelect === 'function') {
      window.KapturaStudioSelects.refreshSelect(sel);
    }
  }

  function setMediaModeBadge(badgeId, mediaKind, detailText) {
    const el = $(badgeId);
    if (!el) return;
    el.classList.remove('is-image', 'is-video');
    if (!mediaKind) {
      el.textContent = '';
      return;
    }
    el.classList.add(mediaKind === 'image' ? 'is-image' : 'is-video');
    el.textContent = mediaKind === 'image'
      ? `🖼️ MODO IMAGEN · ${detailText}`
      : `🎬 MODO VÍDEO · ${detailText}`;
  }

  function codecCapabilityLock(val) {
    const dh = window.KapturaDaemon && window.KapturaDaemon.getCachedHealth ? window.KapturaDaemon.getCachedHealth() : {};
    const enc = (dh && dh.encoders) || {};
    if (val === 'hevc') {
      if (!dh || !dh.online) return { locked: true, reason: 'DAEMON :3370' };
      if (!enc.nvencHevc && !enc.libx265) return { locked: true, reason: 'NO DISPONIBLE' };
    }
    if (val === 'av1_mp4') {
      if (!dh || !dh.online) return { locked: true, reason: 'DAEMON :3370' };
      if (!enc.nvencAv1) return { locked: true, reason: 'REQUIERE RTX 40xx+' };
    }
    return { locked: false };
  }

  function applyConverterCodecLocks() {
    syncSelectLocks($('convFormat'), (opt) => codecCapabilityLock(opt.value), 'mp4');
  }

  function daemonCodecParams(fmt) {
    if (fmt === 'hevc') return { container: 'mp4', codec: 'hevc' };
    if (fmt === 'av1_mp4') return { container: 'mp4', codec: 'av1' };
    if (fmt === 'webm' || fmt === 'vp9') return { container: 'webm', codec: 'vp9' };
    return { container: 'mp4', codec: 'h264' };
  }

  function applyCompressorMediaMode(kind) {
    const fmtSel = $('compressorFormat');
    syncSelectLocks(fmtSel, (opt) => {
      if (kind === 'image' && ['mp4', 'webm', 'hevc', 'av1_mp4'].includes(opt.value)) {
        return { locked: true, reason: 'SOLO VÍDEO' };
      }
      if (kind === 'video' && (opt.value === 'webp' || opt.value === 'jpeg')) {
        return { locked: true, reason: 'SOLO IMAGEN' };
      }
      if (kind !== 'image') return codecCapabilityLock(opt.value);
      return { locked: false };
    }, 'auto');
    setMediaModeBadge(
      'compressorMediaBadge',
      kind,
      kind === 'image'
        ? 'Formatos de imagen activos (WebP / JPEG); MP4, HEVC y WebM bloqueados'
        : 'Formatos de vídeo activos (MP4 / HEVC / WebM); WebP y JPEG bloqueados'
    );
  }

  function applySvgMediaMode(kind) {
    const srcMode = $('svgSource') ? $('svgSource').value : 'scene';
    const effectiveKind = srcMode === 'scene' ? 'video' : kind;
    const isImg = effectiveKind === 'image';
    setCardMediaLock($('svgVectorMode'), !isImg, 'SOLO IMAGEN');
    setCardMediaLock($('svgFps'), isImg, 'SOLO VÍDEO');
    setMediaModeBadge(
      'svgMediaBadge',
      effectiveKind,
      isImg
        ? 'Vectorización <path> activada · FPS de vídeo bloqueado'
        : (srcMode === 'scene' ? 'Escena Canvas → SVG animado (SMIL) · Cuantización estática bloqueada' : 'Vídeo → SVG animado (SMIL) · Cuantización estática bloqueada')
    );
  }

  function applyUpskaletorMediaMode(kind) {
    const profSel = $('upskaletorProfileSelect');
    const isImg = kind === 'image';
    const hasNeural = Boolean(window.KapturaDaemon && typeof window.KapturaDaemon.isNeuralAvailable === 'function' && window.KapturaDaemon.isNeuralAvailable());
    const fallbackProf = hasNeural ? '4k_ai' : '4k_cas';
    syncSelectLocks(profSel, (opt) => {
      const p = window.KapturaUpskaletor && window.KapturaUpskaletor.PROFILES && window.KapturaUpskaletor.PROFILES[opt.value];
      const rule = (p && p.media) || 'both';
      if (isImg && rule === 'video') return { locked: true, reason: 'SOLO VÍDEO' };
      if (!isImg && rule === 'image') return { locked: true, reason: 'SOLO IMAGEN' };
      return { locked: false };
    }, fallbackProf);
    if (typeof updateUpskaletorProfileHint === 'function') updateUpskaletorProfileHint();
    setMediaModeBadge(
      'upskaletorMediaBadge',
      kind,
      isImg
        ? 'Perfiles de imagen (2X/4X Super-Res + Real-ESRGAN) activos · RIFE/Social vídeo bloqueados'
        : 'Perfiles de vídeo (Lanczos CAS / Real-ESRGAN / RIFE 2× FPS) activos · 2X/4X Super-Res imagen bloqueados'
    );
  }

  function applyBgStudioMediaMode(kind) {
    const isImg = kind === 'image';
    const engSel = $('bgEngineSelect');
    const bdSel = $('bgBackdropSelect');
    if (window.KapturaBgRemover) {
      syncSelectLocks(engSel, (opt) => {
        if (!window.KapturaBgRemover.isEngineCompatible(opt.value, kind)) {
          return { locked: true, reason: isImg ? 'SOLO VÍDEO' : 'SOLO IMAGEN' };
        }
        return { locked: false };
      }, 'auto');
      syncSelectLocks(bdSel, (opt) => {
        if (!window.KapturaBgRemover.isBackdropCompatible(opt.value, kind)) {
          return { locked: true, reason: isImg ? 'SOLO VÍDEO' : 'SOLO IMAGEN' };
        }
        return { locked: false };
      }, 'transparent');
    }
    if ($('btnBgPreview2s')) {
      $('btnBgPreview2s').textContent = isImg ? '👁️ PREVIEW EN INSPECTOR' : '👁️ PREVIEW 2s EN INSPECTOR';
    }
    setMediaModeBadge(
      'bgMediaBadge',
      kind,
      isImg
        ? 'BiRefNet 1024px / Chroma-Key PNG Alpha activos · RVM CUDA, ProRes y GreenScreen vídeo bloqueados'
        : 'RVM RTX CUDA / ONNX / Chroma-Key + WebM VP9 & ProRes Alpha activos'
    );
  }

  function updateGpuThermalUi(gpu) {
    const el = $('statGpuThermal');
    if (!el) return;
    el.classList.remove('gpu-temp-cool', 'gpu-temp-warm', 'gpu-temp-hot');
    if (!gpu || !gpu.available || gpu.tempC === null || gpu.tempC === undefined) {
      el.style.color = 'var(--muted)';
      el.textContent = '—';
      return;
    }
    const shortName = String(gpu.name || 'GPU')
      .replace(/^NVIDIA\s+GeForce\s+/i, '')
      .replace(/\s+Laptop\s+GPU/i, '')
      .trim();
    const vramStr = gpu.vramUsedMB !== null && gpu.vramTotalMB
      ? ` · ${(gpu.vramUsedMB / 1024).toFixed(1)}/${(gpu.vramTotalMB / 1024).toFixed(0)}GB`
      : '';
    const fire = gpu.tempC >= 86 ? ' 🔥' : '';
    el.textContent = `${shortName} · ${gpu.tempC}°C${vramStr}${fire}`;
    el.classList.add(gpu.tempC >= 86 ? 'gpu-temp-hot' : (gpu.tempC >= 78 ? 'gpu-temp-warm' : 'gpu-temp-cool'));
  }

  /* ---- capability chips ------------------------------------------------- */
  (function renderCaps() {
    const row = $('capsRow');
    const chip = (label, on, idAttr = '') => `<span ${idAttr} class="cap-chip ${on ? 'on' : 'off'}">${on ? '● ' : '○ '}${label}</span>`;
    row.innerHTML =
      chip('WebGL Lanczos', caps.gpu.webgl) +
      chip('MP4 encode', caps.canMp4) +
      chip('WebM/VP9', caps.canWebmVp9) +
      chip('AV1', caps.canWebmAv1) +
      chip('Workers', caps.workers) +
      chip('WebCodecs', caps.webcodecs) +
      chip('GPU Daemon :3370', false, 'id="capDaemon3370"');

    if (window.KapturaDaemon && window.KapturaDaemon.probeHealth) {
      window.KapturaDaemon.probeHealth().then(async (dh) => {
        const el = $('capDaemon3370');
        const gpuBtn = $('btnGpuRender');
        const statD = $('statDaemon');
        if (typeof updateUpskaletorReadiness === 'function') updateUpskaletorReadiness(dh);
        if (typeof updateUpskaletorProfileHint === 'function') updateUpskaletorProfileHint();
        if (typeof updateBgReadiness === 'function') updateBgReadiness(dh);
        applyConverterCodecLocks();
        applyCompressorMediaMode(compFile ? detectMediaKind(compFile) : 'video');
        if (typeof refreshVault === 'function') refreshVault();
        if (!el || !dh || !dh.online) return;
        const label = dh.hardwareAccelerated ? `NVENC :3370 (${dh.preferredCodec})` : (dh.ffmpegAvailable ? 'Daemon :3370' : 'Daemon :3370 (UI)');
        el.className = 'cap-chip on';
        el.textContent = `● ${label}`;
        if (dh.neuralAvailable && !$('capEsrgan')) {
          row.insertAdjacentHTML('beforeend', chip('Real-ESRGAN Vulkan', true, 'id="capEsrgan"'));
        }
        if (dh.rifeAvailable && !$('capRife')) {
          row.insertAdjacentHTML('beforeend', chip('RIFE v4.6 2×FPS', true, 'id="capRife"'));
        }
        if (dh.bgRemoval && (dh.bgRemoval.birefnetHr || dh.bgRemoval.birefnet || dh.bgRemoval.rvmCuda || dh.bgRemoval.rvmOnnx) && !$('capBgMatte')) {
          const matteLabel = dh.bgRemoval.birefnetHr
            ? 'BG Matte (BiRefNet 2K+CUDA)'
            : (dh.bgRemoval.rvmCuda ? 'BG Matte (BiRefNet+CUDA)' : 'BG Matte (ONNX)');
          row.insertAdjacentHTML('beforeend', chip(matteLabel, true, 'id="capBgMatte"'));
        }
        if (gpuBtn && dh.ffmpegAvailable) gpuBtn.disabled = false;
        if ($('stageEncoderBadge')) {
          $('stageEncoderBadge').textContent = dh.hardwareAccelerated ? dh.preferredCodec.toUpperCase() : 'FFMPEG';
          $('stageEncoderBadge').classList.add('on');
        }
        if (statD) {
          const eb = window.KapturaDaemon.fetchEbwpTelemetry ? await window.KapturaDaemon.fetchEbwpTelemetry() : null;
          const ebSuffix = eb && eb.ok ? ` · EBWP ${eb.byteLength}B (${eb.magic})` : '';
          statD.style.color = 'var(--emerald)';
          statD.textContent = `${dh.hardwareAccelerated ? dh.preferredCodec.toUpperCase() : 'FFMPEG'} :3370${ebSuffix}`;
        }
        updateGpuThermalUi(dh.gpu);
        if (window.KapturaDaemon.fetchGpuTelemetry) {
          setInterval(async () => {
            if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
            const g = await window.KapturaDaemon.fetchGpuTelemetry();
            if (g && g.ok) updateGpuThermalUi(g);
          }, 5000);
        }
      });
    }
  })();

  /* ---- Vault (data layer in js/vault.js; URLs owned here) ---------------- */
  const Vault = window.KapturaVault;
  let vaultUrls = [];
  let vaultRefreshSeq = 0;
  function releaseVaultUrls() { vaultUrls.forEach(URL.revokeObjectURL); vaultUrls = []; }

  async function ensureRealFile(src) {
    if (!src) return null;
    if (src instanceof File) return src;
    if (src instanceof Blob) return new File([src], src.name || `kaptura_master_${stamp()}.mp4`, { type: src.type || 'video/mp4' });
    if (src.blob instanceof Blob) return new File([src.blob], src.name || `kaptura_master.${src.ext || 'mp4'}`, { type: src.mime || src.blob.type || 'video/mp4' });
    if (src.remoteUrl) {
      const resp = await fetch(src.remoteUrl);
      if (!resp.ok) throw new Error('No se pudo leer el archivo desde el daemon :3370.');
      const b = await resp.blob();
      return new File([b], src.name || 'kaptura_master.mp4', { type: src.mime || b.type || 'video/mp4' });
    }
    return null;
  }

  function mediaPreviewSrc(src) {
    if (!src) return { url: '', revoke: () => {} };
    if (typeof src === 'string') return { url: src, revoke: () => {} };
    if (src.remoteUrl) return { url: src.remoteUrl, revoke: () => {} };
    const b = src instanceof Blob ? src : src.blob;
    if (b instanceof Blob) {
      const u = URL.createObjectURL(b);
      return { url: u, revoke: () => URL.revokeObjectURL(u) };
    }
    return { url: '', revoke: () => {} };
  }

  async function refreshVault() {
    const seq = ++vaultRefreshSeq;
    let items = [];
    try { items = await Vault.getAll(); }
    catch (e) { toast(e.message, 'error'); }
    if (seq !== vaultRefreshSeq) return;
    $('vault-count').textContent = items.length;
    const grid = $('vaultGrid');
    releaseVaultUrls();
    const pruneBtn = $('btnPruneExpiredVault');
    if (!items.length) {
      if (pruneBtn) pruneBtn.style.display = 'none';
      grid.innerHTML = `<div style="grid-column:1/-1; text-align:center; padding:40px; color:var(--dim); font-family:'Fira Code', monospace">
        No recordings saved in vault yet. Record a video to store it automatically!</div>`;
      return;
    }

    const dh = window.KapturaDaemon && window.KapturaDaemon.getCachedHealth ? window.KapturaDaemon.getCachedHealth() : {};
    const daemonOnline = Boolean(dh && dh.online);
    const livenessMap = new Map();
    const daemonBase = (window.KapturaDaemon && window.KapturaDaemon.DAEMON_BASE) || 'http://127.0.0.1:3370';
    const isDaemonExportUrl = (u) => typeof u === 'string' && (u.startsWith(daemonBase) || u.includes('/exports/'));
    let batchAlive = null;
    if (daemonOnline && window.KapturaDaemon && typeof window.KapturaDaemon.checkUrlsAliveBatch === 'function') {
      const daemonUrls = items.filter((it) => it.remoteUrl && isDaemonExportUrl(it.remoteUrl)).map((it) => it.remoteUrl);
      if (daemonUrls.length) {
        batchAlive = await window.KapturaDaemon.checkUrlsAliveBatch(daemonUrls);
      }
    }
    await Promise.all(items.map(async (item) => {
      if (!item.remoteUrl) { livenessMap.set(item.id, 'blob'); return; }
      if (!daemonOnline && isDaemonExportUrl(item.remoteUrl)) { livenessMap.set(item.id, 'offline'); return; }
      if (batchAlive && Object.prototype.hasOwnProperty.call(batchAlive, item.remoteUrl)) {
        livenessMap.set(item.id, batchAlive[item.remoteUrl] ? 'alive' : 'expired');
        return;
      }
      if (window.KapturaDaemon && typeof window.KapturaDaemon.checkUrlAlive === 'function') {
        const alive = await window.KapturaDaemon.checkUrlAlive(item.remoteUrl);
        livenessMap.set(item.id, alive ? 'alive' : 'expired');
      } else {
        livenessMap.set(item.id, 'alive');
      }
    }));
    if (seq !== vaultRefreshSeq) return;

    const expiredIds = items.filter((it) => livenessMap.get(it.id) === 'expired').map((it) => it.id);
    if (pruneBtn) {
      pruneBtn.style.display = expiredIds.length ? 'inline-flex' : 'none';
      pruneBtn.textContent = `🧹 LIMPIAR EXPIRADOS (${expiredIds.length})`;
      pruneBtn.onclick = async () => {
        for (const id of expiredIds) {
          try { await Vault.remove(id); } catch {}
        }
        await refreshVault();
        toast(`Limpiados ${expiredIds.length} registros expirados del Vault.`, 'success');
      };
    }

    grid.innerHTML = items.map((item) => {
      const media = Vault.getRecordMediaSrc(item);
      if (item.blob instanceof Blob && media.src) vaultUrls.push(media.src);
      const isImg = item.type && item.type.startsWith('image/');
      const state = livenessMap.get(item.id) || (item.remoteUrl ? 'alive' : 'blob');
      const isPinned = Boolean(item.pinned || (item.remoteUrl && item.remoteUrl.includes('/exports/vault/')));

      let thumbHtml = '';
      if (state === 'expired') {
        thumbHtml = `<div class="vault-thumb-expired">
          <div style="font-size:20px">⏳</div>
          <div>Archivo temporal expirado en disco (GC 1h)</div>
          <div style="opacity:0.78; font-size:10px">Usa 📌 FIJAR en futuros renders para conservarlos</div>
        </div>`;
      } else if (state === 'offline') {
        thumbHtml = `<div class="vault-thumb-expired" style="border-color:rgba(0,240,255,0.3); color:var(--cyan)">
          <div style="font-size:20px">🔌</div>
          <div>Daemon :3370 desconectado</div>
          <div style="opacity:0.78; font-size:10px">Inicia el daemon local para reproducir este archivo de disco</div>
        </div>`;
      } else if (isImg) {
        thumbHtml = `<img class="vault-thumb" src="${media.src}" alt="${escapeHtml(item.name)}" style="object-fit:contain; background:#050811">`;
      } else {
        thumbHtml = `<video class="vault-thumb" src="${media.src}" controls preload="metadata"></video>`;
      }

      const tag = item.remoteUrl
        ? (isPinned ? `<span class="vault-pin-badge">📌 FIJADO EN DISCO</span>` : 'DISK :3370 (TEMP)')
        : 'INDEXEDDB';
      const cardCls = `vault-card${isPinned ? ' is-pinned' : ''}${state === 'expired' ? ' is-expired' : ''}`;
      const canStage = !isImg && (state === 'alive' || state === 'blob');
      const canPin = Boolean(item.remoteUrl && !isPinned && state === 'alive' && daemonOnline);
      return `
        <div class="${cardCls}">
          ${thumbHtml}
          <div class="vault-title">${escapeHtml(item.name)}</div>
          <div class="vault-info">📅 ${escapeHtml(item.timestamp)} · 💾 ${escapeHtml(item.size)} · ⏱️ ${escapeHtml(item.duration)} · ${tag}</div>
          <div class="vault-actions">
            ${canStage ? `<button class="vault-btn" data-stage="${item.id}">🎬 STAGE</button>` : ''}
            ${canPin ? `<button class="vault-btn pin" data-pin="${item.id}" title="Copiar a exports/vault/ (exento de limpieza automática)">📌 FIJAR</button>` : ''}
            ${state === 'alive' || state === 'blob' ? `<a class="vault-btn" href="${media.src}" download="${escapeHtml(item.name)}">💾 DOWNLOAD</a>` : ''}
            <button class="vault-btn del" data-del="${item.id}">🗑️ DELETE</button>
          </div>
        </div>`;
    }).join('');

    grid.querySelectorAll('[data-stage]').forEach((b) => {
      b.addEventListener('click', () => {
        const item = items.find((x) => Number(x.id) === Number(b.dataset.stage));
        if (!item) return;
        const ext = (item.name && item.name.includes('.')) ? item.name.split('.').pop().toLowerCase() : 'mp4';
        loadMasterOntoStage({
          blob: item.blob || null,
          remoteUrl: item.remoteUrl || null,
          name: item.name,
          mime: item.type || 'video/mp4',
          ext,
          sizeBytes: item.sizeBytes || (item.blob ? item.blob.size : 0),
          duration: parseFloat(item.duration) || 0,
        });
        activateTab('tab-recorder');
        toast('Cargado en Stage para reproducción / trim.', 'notice');
      });
    });

    grid.querySelectorAll('[data-pin]').forEach((b) => {
      b.addEventListener('click', async () => {
        const item = items.find((x) => Number(x.id) === Number(b.dataset.pin));
        if (!item || !item.remoteUrl || !window.KapturaDaemon || !window.KapturaDaemon.pinExportViaDaemon) return;
        b.disabled = true;
        try {
          const pinRes = await window.KapturaDaemon.pinExportViaDaemon(item.remoteUrl);
          if (typeof Vault.update === 'function') {
            await Vault.update(item.id, { remoteUrl: pinRes.remoteUrl, pinned: true });
          }
          await refreshVault();
          toast(`📌 "${item.name}" fijado permanentemente en exports/vault/.`, 'success');
        } catch (e) {
          toast(e.message || String(e), 'error');
        }
      });
    });

    grid.querySelectorAll('[data-del]').forEach((b) => {
      b.addEventListener('click', async () => {
        const id = Number(b.dataset.del);
        const item = items.find((x) => Number(x.id) === id);
        try {
          if (item && item.remoteUrl && item.remoteUrl.includes('/exports/vault/') && window.KapturaDaemon && window.KapturaDaemon.deletePinnedExportViaDaemon) {
            await window.KapturaDaemon.deletePinnedExportViaDaemon(item.remoteUrl);
          }
          await Vault.remove(id);
          await refreshVault();
        } catch (e) { toast(e.message, 'error'); }
      });
    });
  }

  async function saveToVault({ blob = null, remoteUrl = null, name, mime, durationSec, sizeBytes = 0 }) {
    try {
      const realBytes = Number(sizeBytes || (blob ? blob.size : 0)) || 0;
      const durLabel = typeof durationSec === 'number' ? `${Number(durationSec).toFixed(1)}s` : (durationSec || 'N/A');
      await Vault.add({
        timestamp: new Date().toLocaleString(),
        name,
        type: mime,
        size: (realBytes / (1024 * 1024)).toFixed(2) + ' MB',
        sizeBytes: realBytes,
        duration: durLabel,
        remoteUrl: remoteUrl || null,
        blob: remoteUrl ? null : blob,
      });
      await refreshVault();
    } catch (e) { toast(e.message, 'error'); }
  }

  $('btnClearVault').addEventListener('click', async () => {
    if (!confirm('Clear all recorded videos from the local vault?')) return;
    try {
      const items = await Vault.getAll();
      if (window.KapturaDaemon && window.KapturaDaemon.deletePinnedExportViaDaemon) {
        for (const it of items) {
          if (it && it.remoteUrl && it.remoteUrl.includes('/exports/vault/')) {
            await window.KapturaDaemon.deletePinnedExportViaDaemon(it.remoteUrl);
          }
        }
      }
      await Vault.clear();
      await refreshVault();
      toast('Vault cleared.', 'success');
    } catch (e) { toast(e.message, 'error'); }
  });

  function activateTab(tabId) {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tabId));
    document.querySelectorAll('.tab-content').forEach((c) => c.classList.toggle('active', c.id === tabId));
  }

  /* ---- Capture engine & Continuous Stage Flow --------------------------- */
  const canvas = $('renderCanvas');
  const previewVideo = $('previewVideo');
  let lastMaster = null;   // { blob, remoteUrl, ext, mime, name, sizeBytes, duration, trimStart, trimEnd }
  let stageObjectUrl = null;

  function updateTrimLabels() {
    const startEl = $('trimStartRange');
    const endEl = $('trimEndRange');
    const s = parseFloat(startEl.value) || 0;
    const e = parseFloat(endEl.value) || 0;
    const maxVal = Math.max(0.1, parseFloat(endEl.max) || 10);
    $('trimRangeLabel').textContent = `IN ${s.toFixed(1)}s → OUT ${e.toFixed(1)}s (dur ${(Math.max(0, e - s)).toFixed(1)}s)`;
    if ($('trimActiveBar')) {
      const leftPct = Math.max(0, Math.min(100, (s / maxVal) * 100));
      const rightPct = Math.max(leftPct, Math.min(100, (e / maxVal) * 100));
      $('trimActiveBar').style.left = leftPct.toFixed(2) + '%';
      $('trimActiveBar').style.width = Math.max(1, rightPct - leftPct).toFixed(2) + '%';
    }
    if (lastMaster) {
      lastMaster.trimStart = s;
      lastMaster.trimEnd = e;
    }
  }

  function loadMasterOntoStage(master) {
    if (stageObjectUrl) { URL.revokeObjectURL(stageObjectUrl); stageObjectUrl = null; }
    lastMaster = { ...master, trimStart: 0, trimEnd: Number(master.duration) || 0 };
    const mb = ((master.sizeBytes || (master.blob ? master.blob.size : 0)) / (1024 * 1024)).toFixed(2);
    $('statSize').textContent = mb + ' MB';
    $('trimMeta').textContent = `ACTIVE MASTER: ${master.name} · ${mb} MB${master.codec ? ' · ' + master.codec : ''}`;

    const src = master.remoteUrl || master.blob;
    capture.showPlayback(src);

    const dl = $('btnDownloadActive');
    const dlMaster = $('btnDownloadMaster');
    if (dlMaster) {
      dlMaster.disabled = false;
      dlMaster.textContent = `⬇ DESCARGAR (${mb} MB)`;
      dlMaster.onclick = () => {
        if (master.remoteUrl) {
          const a = document.createElement('a');
          a.href = master.remoteUrl;
          a.download = master.name;
          a.click();
        } else if (master.blob instanceof Blob) {
          downloadBlob(master.blob, master.name);
        }
      };
    }
    if (master.remoteUrl) {
      dl.href = master.remoteUrl;
      dl.download = master.name;
      dl.onclick = null;
    } else if (master.blob instanceof Blob) {
      stageObjectUrl = URL.createObjectURL(master.blob);
      dl.href = stageObjectUrl;
      dl.download = master.name;
      dl.onclick = null;
    }

    const initDur = Math.max(0.5, Number(master.duration) || 10);
    $('trimStartRange').max = initDur.toFixed(1);
    $('trimEndRange').max = initDur.toFixed(1);
    $('trimStartRange').value = '0';
    $('trimEndRange').value = initDur.toFixed(1);
    updateTrimLabels();

    previewVideo.onloadedmetadata = () => {
      const realDur = Number(previewVideo.duration);
      if (Number.isFinite(realDur) && realDur > 0.1) {
        lastMaster.duration = realDur;
        lastMaster.trimEnd = realDur;
        $('trimStartRange').max = realDur.toFixed(2);
        $('trimEndRange').max = realDur.toFixed(2);
        $('trimEndRange').value = realDur.toFixed(2);
        updateTrimLabels();
      }
    };
    $('stageTrimDock').classList.add('open');
  }

  if ($('trimStartRange')) {
    $('trimStartRange').addEventListener('input', () => {
      let s = parseFloat($('trimStartRange').value) || 0;
      const e = parseFloat($('trimEndRange').value) || 0;
      if (s >= e - 0.1) {
        s = Math.max(0, e - 0.1);
        $('trimStartRange').value = s.toFixed(2);
      }
      previewVideo.currentTime = s;
      updateTrimLabels();
    });
  }
  if ($('trimEndRange')) {
    $('trimEndRange').addEventListener('input', () => {
      const s = parseFloat($('trimStartRange').value) || 0;
      let e = parseFloat($('trimEndRange').value) || 0;
      if (e <= s + 0.1) {
        e = Math.min(parseFloat($('trimEndRange').max) || 10, s + 0.1);
        $('trimEndRange').value = e.toFixed(2);
      }
      previewVideo.currentTime = e;
      updateTrimLabels();
    });
  }

  let vuSysPeakVal = 0;
  let vuMicPeakVal = 0;

  const capture = window.KapturaCapture.create({
    canvas, video: previewVideo,
    callbacks: {
      onFps: (fps) => { $('fpsDisplay').textContent = fps + ' FPS'; },
      onTimer: ({ text, frames }) => { $('recTimer').textContent = text; $('statFrames').textContent = frames; },
      onSize: (mb) => { $('statSize').textContent = String(mb).includes('[') ? `${mb} MB` : `${mb} MB`; },
      onSourceMode: (t) => { $('statSourceMode').textContent = t; },
      onProgress: ({ value, meta }) => {
        if ($('recorderReadout')) {
          const pct = Math.round((value || 0) * 100);
          $('recorderReadout').textContent = meta && meta.speed
            ? `Streaming NVENC :3370 — ${pct}% · ${meta.speed}`
            : `Procesando :3370 — ${pct}%`;
        }
      },
      onAudioLevels: ({ sys, mic }) => {
        const sysPct = Math.min(100, Math.round((sys || 0) * 100));
        const micPct = Math.min(100, Math.round((mic || 0) * 100));
        vuSysPeakVal = sysPct >= vuSysPeakVal ? sysPct : Math.max(0, vuSysPeakVal - 2.2);
        vuMicPeakVal = micPct >= vuMicPeakVal ? micPct : Math.max(0, vuMicPeakVal - 2.2);
        if ($('vuSysFill')) $('vuSysFill').style.width = sysPct + '%';
        if ($('vuMicFill')) $('vuMicFill').style.width = micPct + '%';
        if ($('vuSysPeak')) {
          $('vuSysPeak').style.left = vuSysPeakVal.toFixed(1) + '%';
          $('vuSysPeak').style.opacity = vuSysPeakVal > 2 ? '1' : '0';
        }
        if ($('vuMicPeak')) {
          $('vuMicPeak').style.left = vuMicPeakVal.toFixed(1) + '%';
          $('vuMicPeak').style.opacity = vuMicPeakVal > 2 ? '1' : '0';
        }
      },
      onError: (msg) => toast(msg, 'error'),
      onNotice: (msg) => toast(msg, 'notice'),
      onRecordingState: (active) => {
        $('recIndicator').classList.toggle('active', active);
        $('btnStartRec').disabled = active;
        $('btnStopRec').disabled = !active;
        if (!active) {
          vuSysPeakVal = 0;
          vuMicPeakVal = 0;
          if ($('vuSysFill')) $('vuSysFill').style.width = '0%';
          if ($('vuMicFill')) $('vuMicFill').style.width = '0%';
          if ($('vuSysPeak')) $('vuSysPeak').style.opacity = '0';
          if ($('vuMicPeak')) $('vuMicPeak').style.opacity = '0';
          if ($('recorderReadout')) $('recorderReadout').textContent = '';
        }
      },
      onStop: async ({ blob, remoteUrl, mime, ext, duration, sizeBytes, codec, streamedToDisk }) => {
        const name = `Ethernium_Master_${stamp()}.${ext}`;
        const bytes = Number(sizeBytes || (blob ? blob.size : 0)) || 0;
        const master = { blob: blob || null, remoteUrl: remoteUrl || null, ext, mime, name, sizeBytes: bytes, duration, codec };
        loadMasterOntoStage(master);
        await saveToVault({ blob, remoteUrl, name, mime, durationSec: duration, sizeBytes: bytes });
        toast(
          streamedToDisk
            ? `Grabación en disco (${codec || 'NVENC'}, ${(bytes / 1024).toFixed(1)} KB) lista en Stage y Bóveda.`
            : 'Master cargado en Stage y guardado en la Bóveda.',
          'success'
        );
      },
    },
  });

  if ($('btnQuickScreen')) {
    $('btnQuickScreen').addEventListener('click', () => capture.selectSource(parseInt($('fpsSelect').value, 10)));
  }
  if ($('btnQuickOpenFile') && $('stageFileInput')) {
    $('btnQuickOpenFile').addEventListener('click', () => $('stageFileInput').click());
    $('stageFileInput').addEventListener('change', (e) => {
      const f = e.target.files[0];
      if (!f) return;
      const ext = (f.name && f.name.includes('.')) ? f.name.split('.').pop().toLowerCase() : 'mp4';
      loadMasterOntoStage({ blob: f, remoteUrl: null, ext, mime: f.type || 'video/mp4', name: f.name, sizeBytes: f.size, duration: 0 });
      toast(`Vídeo "${f.name}" listo en Stage para reproducir, recortar o enviar.`, 'success');
    });
  }
  if ($('btnBackToLive')) {
    $('btnBackToLive').addEventListener('click', () => {
      $('stageTrimDock').classList.remove('open');
      capture.setMode($('modeSelect').value === 'screen' && !capture.hasStream() ? 'dna' : $('modeSelect').value);
    });
  }

  // resolution selector resizes the canvas engine
  $('resSelect').addEventListener('change', (e) => {
    const [w, h] = e.target.value.split('x').map(Number);
    canvas.width = w; canvas.height = h;
  });

  $('modeSelect').addEventListener('change', (e) => {
    const mode = e.target.value;
    if (mode === 'screen') { if (!capture.hasStream()) capture.selectSource(parseInt($('fpsSelect').value, 10)); else capture.setMode('screen'); }
    else capture.setMode(mode);
  });
  $('btnSelectSource').addEventListener('click', () => capture.selectSource(parseInt($('fpsSelect').value, 10)));

  function containerFromCodec(v) { return v === 'mp4' ? 'mp4' : v === 'av1' ? 'av1' : 'webm'; }

  $('btnStartRec').addEventListener('click', () => {
    capture.startRecording({
      caps,
      fps: parseInt($('fpsSelect').value, 10),
      bitrateMbps: parseInt($('bitrateSelect').value, 10),
      container: containerFromCodec($('codecSelect').value),
      micEnabled: Boolean($('chkMicAudio') && $('chkMicAudio').checked),
      systemMuted: Boolean($('chkSysAudio') && !$('chkSysAudio').checked),
    });
    const sg = $('sysGainSlider') ? parseFloat($('sysGainSlider').value) : 1;
    const mg = $('micGainSlider') ? parseFloat($('micGainSlider').value) : 1;
    setTimeout(() => { if (capture.setAudioMixerGains) capture.setAudioMixerGains(sg, mg); }, 120);
  });
  $('btnStopRec').addEventListener('click', () => capture.stopRecording());

  function syncAudioFaders() {
    if (!capture.setAudioMixerGains) return;
    const sysOn = $('chkSysAudio') ? $('chkSysAudio').checked : true;
    const micOn = $('chkMicAudio') ? $('chkMicAudio').checked : false;
    const sg = sysOn && $('sysGainSlider') ? parseFloat($('sysGainSlider').value) : 0;
    const mg = micOn && $('micGainSlider') ? parseFloat($('micGainSlider').value) : 0;
    capture.setAudioMixerGains(sg, mg);
  }
  if ($('sysGainSlider')) $('sysGainSlider').addEventListener('input', syncAudioFaders);
  if ($('micGainSlider')) $('micGainSlider').addEventListener('input', syncAudioFaders);
  if ($('chkSysAudio')) $('chkSysAudio').addEventListener('change', syncAudioFaders);
  if ($('chkMicAudio')) $('chkMicAudio').addEventListener('change', syncAudioFaders);

  if ($('btnStageGuides') && $('stageGuidesOverlay')) {
    $('btnStageGuides').addEventListener('click', () => {
      const on = $('stageGuidesOverlay').classList.toggle('visible');
      $('btnStageGuides').classList.toggle('on', on);
    });
  }

  document.addEventListener('keydown', (e) => {
    const tag = e.target && e.target.tagName ? e.target.tagName.toUpperCase() : '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.ctrlKey || e.metaKey || e.altKey) return;
    if (!$('tab-recorder').classList.contains('active')) return;
    const k = e.key.toLowerCase();
    if (k === 'f' && $('btnSelectSource')) { $('btnSelectSource').click(); }
    else if (k === 'r' && $('btnStartRec') && !$('btnStartRec').disabled) { $('btnStartRec').click(); }
    else if (k === 's' && $('btnStopRec') && !$('btnStopRec').disabled) { $('btnStopRec').click(); }
    else if (k === 'g' && $('btnGpuRender') && !$('btnGpuRender').disabled) { $('btnGpuRender').click(); }
    else if (k === ' ' && capture.mode === 'playback') {
      e.preventDefault();
      if (previewVideo.paused) previewVideo.play().catch(() => {});
      else previewVideo.pause();
    }
  });

  if ($('btnGpuRender')) {
    $('btnGpuRender').addEventListener('click', async () => {
      if (!window.KapturaDaemon || !window.KapturaDaemon.isReadyForTranscode()) {
        toast('GPU Daemon :3370 con FFmpeg no está disponible.', 'error');
        return;
      }
      const btn = $('btnGpuRender');
      const readout = $('recorderReadout');
      const res = $('resSelect').value;
      const fps = Math.min(60, Math.max(15, parseInt($('fpsSelect').value, 10) || 30));
      const mode = $('modeSelect').value.toUpperCase();
      btn.disabled = true;
      readout.textContent = `Renderizando clip GPU (:3370 · ${res} @ ${fps}fps)…`;
      try {
        const r = await window.KapturaDaemon.renderViaDaemon({
          prompt: `ETHERNIUM STUDIO // ${mode}`,
          durationSec: 2,
          resolution: res,
          fps,
          quality: 'high',
          keepOnDisk: true,
          onProgress: (p, m) => {
            const extra = m && m.speed ? ` · ${m.speed}` : '';
            readout.textContent = `GPU Render :3370 — ${Math.round(p * 100)}%${extra}`;
          },
        });
        const name = `Ethernium_GPU_Render_${stamp()}.mp4`;
        const master = {
          blob: r.blob || null,
          remoteUrl: r.remoteUrl,
          ext: 'mp4',
          mime: 'video/mp4',
          name,
          sizeBytes: r.sizeBytes,
          duration: r.duration,
          codec: r.codec,
        };
        loadMasterOntoStage(master);
        $('statSourceMode').textContent = `GPU :3370 (${r.codec})`;
        await saveToVault({ remoteUrl: r.remoteUrl, blob: r.blob, name, mime: 'video/mp4', durationSec: r.duration, sizeBytes: r.sizeBytes });
        toast(`Clip GPU real (${r.codec}, ${(r.sizeBytes / 1024).toFixed(1)} KB) listo en Stage.`, 'success');
      } catch (e) {
        toast(e.message || String(e), 'error');
      } finally {
        btn.disabled = false;
        readout.textContent = '';
      }
    });
  }

  /* ---- Stage Trim & One-Click Tab Pipeline Handoff ---------------------- */
  if ($('btnTrimFast')) {
    $('btnTrimFast').addEventListener('click', async () => {
      if (!lastMaster) { toast('No hay vídeo cargado en Stage.', 'error'); return; }
      const startSec = parseFloat($('trimStartRange').value) || 0;
      const endSec = parseFloat($('trimEndRange').value) || 0;
      if (endSec <= startSec + 0.05) { toast('Selecciona un rango de recorte válido (OUT > IN).', 'error'); return; }
      const btn = $('btnTrimFast');
      const readout = $('recorderReadout');
      btn.disabled = true;
      readout.textContent = `Recortando [${startSec.toFixed(1)}s → ${endSec.toFixed(1)}s]…`;
      try {
        const useDaemon = window.KapturaDaemon && window.KapturaDaemon.isReadyForTranscode();
        if (useDaemon) {
          const srcArg = lastMaster.remoteUrl
            ? { remoteUrl: lastMaster.remoteUrl, name: lastMaster.name }
            : await ensureRealFile(lastMaster);
          const tr = await window.KapturaDaemon.trimViaDaemon(srcArg, {
            startSec,
            endSec,
            onProgress: (p) => { readout.textContent = `Trim :3370 — ${Math.round(p * 100)}%`; },
          });
          const outName = `${baseName(lastMaster.name)}_TRIM.${lastMaster.ext || 'mp4'}`;
          loadMasterOntoStage({
            blob: null,
            remoteUrl: tr.remoteUrl,
            ext: lastMaster.ext || 'mp4',
            mime: lastMaster.mime || 'video/mp4',
            name: outName,
            sizeBytes: tr.sizeBytes,
            duration: tr.duration || (endSec - startSec),
            codec: tr.codec,
          });
          await saveToVault({ remoteUrl: tr.remoteUrl, name: outName, mime: lastMaster.mime || 'video/mp4', durationSec: tr.duration, sizeBytes: tr.sizeBytes });
          toast(`Trim ${tr.losslessCopy ? 'sin pérdida (-c copy)' : 'NVENC'} completado.`, 'success');
        } else {
          const f = await ensureRealFile(lastMaster);
          const r = await window.KapturaTranscoder.transcode(f, {
            caps,
            container: 'webm',
            quality: 'fast',
            startSec,
            endSec,
            onProgress: (p) => { readout.textContent = `Trim local — ${Math.round(p * 100)}%`; },
          });
          const outName = `${baseName(lastMaster.name)}_TRIM.${r.ext}`;
          loadMasterOntoStage({
            blob: r.blob,
            remoteUrl: null,
            ext: r.ext,
            mime: r.mime,
            name: outName,
            sizeBytes: r.blob.size,
            duration: endSec - startSec,
            codec: r.scaleMode,
          });
          await saveToVault({ blob: r.blob, name: outName, mime: r.mime, durationSec: endSec - startSec, sizeBytes: r.blob.size });
          toast('Trim local completado y guardado en Bóveda.', 'success');
        }
      } catch (e) {
        toast(e.message || String(e), 'error');
      } finally {
        btn.disabled = false;
        readout.textContent = '';
      }
    });
  }

  async function runPreflightFor(fileOrSrc, stripId, profileKey, onMeta) {
    const el = $(stripId);
    if (!el || !window.KapturaPreflight || !fileOrSrc) return null;
    const dh = window.KapturaDaemon && window.KapturaDaemon.getCachedHealth ? window.KapturaDaemon.getCachedHealth() : {};
    const local = await window.KapturaPreflight.probeLocalFile(fileOrSrc);
    if (local) {
      window.KapturaPreflight.renderDiagnosticStrip(el, local, profileKey, dh);
      if (typeof onMeta === 'function') onMeta(local);
    }
    const full = await window.KapturaPreflight.probeMedia(fileOrSrc, dh);
    if (full) {
      window.KapturaPreflight.renderDiagnosticStrip(el, full, profileKey, dh);
      if (typeof onMeta === 'function') onMeta(full);
    }
    return full || local;
  }

  function handoffStageToTab(targetTab, setter) {
    if (!lastMaster) { toast('Graba o abre un vídeo en Stage primero.', 'error'); return; }
    setter({ ...lastMaster });
    activateTab(targetTab);
  }
  if ($('btnSendToCinema')) {
    $('btnSendToCinema').addEventListener('click', () => handoffStageToTab('tab-cinema', (m) => {
      cinemaFile = m;
      $('cinemaDzTitle').textContent = `STAGE MASTER: ${m.name}`;
      $('cinemaDzSub').textContent = `${(m.sizeBytes / (1024 * 1024)).toFixed(2)} MB · Range ${m.trimStart.toFixed(1)}s–${m.trimEnd.toFixed(1)}s`;
    }));
  }
  if ($('btnSendToCompressor')) {
    $('btnSendToCompressor').addEventListener('click', () => handoffStageToTab('tab-compressor', (m) => {
      compFile = m;
      $('compressorDzTitle').textContent = `STAGE MASTER: ${m.name}`;
      $('compressorDzSub').textContent = `${(m.sizeBytes / (1024 * 1024)).toFixed(2)} MB · Vídeo listo desde Stage`;
      applyCompressorMediaMode('video');
      refreshCompressorEstimate(m);
      runPreflightFor(m, 'compressorPreflight', '4k_cas');
    }));
  }
  if ($('btnSendToConverter')) {
    $('btnSendToConverter').addEventListener('click', () => handoffStageToTab('tab-converter', (m) => {
      convFile = m;
      $('dropzone').querySelector('.dz-title').textContent = `STAGE MASTER: ${m.name}`;
      $('dropzone').querySelector('.dz-sub').textContent = `${(m.sizeBytes / (1024 * 1024)).toFixed(2)} MB · Range ${m.trimStart.toFixed(1)}s–${m.trimEnd.toFixed(1)}s`;
      runPreflightFor(m, 'converterPreflight', '4k_cas');
    }));
  }
  if ($('btnSendToUpskaletor')) {
    $('btnSendToUpskaletor').addEventListener('click', () => handoffStageToTab('tab-upskaletor', (m) => {
      upFile = m;
      $('upskaletorDzTitle').textContent = `STAGE MASTER: ${m.name}`;
      $('upskaletorDzSub').textContent = `${(m.sizeBytes / (1024 * 1024)).toFixed(2)} MB · Listo desde Stage`;
      applyUpskaletorMediaMode('video');
      if ($('btnUpscalePreview2s')) $('btnUpscalePreview2s').textContent = '👁️ PREVIEW 2s EN INSPECTOR';
      runPreflightFor(m, 'upskaletorPreflight', $('upskaletorProfileSelect') ? $('upskaletorProfileSelect').value : '4k_ai', (meta) => { upMediaMeta = meta; });
    }));
  }
  if ($('btnSendToBgRemove')) {
    $('btnSendToBgRemove').addEventListener('click', () => handoffStageToTab('tab-bgremove', (m) => {
      bgFile = m;
      bgMediaMeta = null;
      $('bgDzTitle').textContent = `STAGE MASTER: ${m.name}`;
      $('bgDzSub').textContent = `${(m.sizeBytes / (1024 * 1024)).toFixed(2)} MB · Listo para quitar fondo`;
      applyBgStudioMediaMode('video');
      runPreflightFor(m, 'bgPreflight', 'bg_remove', (meta) => { bgMediaMeta = meta; });
    }));
  }

  /* ---- Export menu (real re-encode / real GIF) -------------------------- */
  $('btnExportMenu').addEventListener('click', () => $('exportMenu').classList.toggle('show'));
  $('exportMenu').querySelectorAll('[data-fmt]').forEach((item) => {
    item.addEventListener('click', () => { $('exportMenu').classList.remove('show'); exportAs(item.dataset.fmt); });
  });

  async function exportAs(fmt) {
    if (!lastMaster) { toast('No hay grabación en memoria. Graba o abre un vídeo primero.', 'error'); return; }
    const readout = $('recorderReadout');
    const trimOpts = (lastMaster.trimEnd > lastMaster.trimStart)
      ? { startSec: lastMaster.trimStart, endSec: lastMaster.trimEnd }
      : {};
    try {
      if (fmt === 'gif') {
        readout.textContent = 'Exportando GIF real (codificador nativo)…';
        const srcArg = lastMaster.remoteUrl || await ensureRealFile(lastMaster);
        const r = await window.KapturaTranscoder.toGIF(srcArg, {
          caps, fps: 12, quality: caps.gpu.webgl ? 'max' : 'fast',
          ...trimOpts,
          onProgress: (p) => { readout.textContent = `GIF: ${Math.round(p * 100)}% (${r0(p)})`; },
        });
        downloadBlob(r.blob, `Ethernium_${stamp()}.gif`);
        toast(`GIF real: ${r.width}×${r.height}, ${r.frames} frames.`, 'success');
      } else {
        const useDaemon = window.KapturaDaemon && window.KapturaDaemon.isReadyForTranscode();
        readout.textContent = useDaemon
          ? `Re-encode GPU :3370 a ${fmt.toUpperCase()}…`
          : `Re-encode real a ${fmt.toUpperCase()}…`;
        const cp = daemonCodecParams(fmt);
        let r;
        if (useDaemon) {
          try {
            const daemonSrc = lastMaster.remoteUrl
              ? { remoteUrl: lastMaster.remoteUrl, name: lastMaster.name }
              : await ensureRealFile(lastMaster);
            r = await window.KapturaDaemon.transcodeViaDaemon(daemonSrc, {
              container: cp.container, codec: cp.codec, quality: 'fast', ...trimOpts,
              onProgress: (p, m) => { readout.textContent = `GPU :3370 ${fmt.toUpperCase()}: ${Math.round(p * 100)}%${m && m.speed ? ' · ' + m.speed : ''}`; },
            });
          } catch {
            const f = await ensureRealFile(lastMaster);
            r = await window.KapturaTranscoder.transcode(f, {
              caps, container: cp.container, quality: 'fast', ...trimOpts,
              onProgress: (p) => { readout.textContent = `${fmt.toUpperCase()}: ${Math.round(p * 100)}%`; },
            });
          }
        } else {
          const f = await ensureRealFile(lastMaster);
          r = await window.KapturaTranscoder.transcode(f, {
            caps, container: cp.container, quality: 'fast', ...trimOpts,
            onProgress: (p) => { readout.textContent = `${fmt.toUpperCase()}: ${Math.round(p * 100)}%`; },
          });
        }
        if (r.fellBack) toast('MP4 no disponible; exportado en WebM real.', 'notice');
        downloadBlob(r.blob, `Ethernium_${stamp()}.${r.ext}`);
        toast(`Exportado ${r.ext.toUpperCase()} real (${r.scaleMode}).`, 'success');
      }
    } catch (e) { toast(e.message || String(e), 'error'); }
    finally { readout.textContent = ''; }
  }
  function r0(p) { return p < 0.6 ? 'extracción' : 'codificación'; }

  /* ---- V-Converter (real transcode) ------------------------------------- */
  let convFile = null;
  wireDropzone('dropzone', 'fileInput', (f, allFiles) => {
    if (detectMediaKind(f) === 'image') {
      toast('Esta pestaña solo procesa vídeos (.mp4 / .webm). Para imágenes usa Compresor, SVG Vector, BG Studio o UPSKALETOR.', 'error');
      return;
    }
    convFile = f;
    $('dropzone').querySelector('.dz-title').textContent = `SELECTED: ${f.name}`;
    $('dropzone').querySelector('.dz-sub').textContent = `${(f.size / (1024 * 1024)).toFixed(2)} MB · ${f.type || 'video'}`;
    runPreflightFor(f, 'converterPreflight', '4k_cas');
    if (allFiles && allFiles.length > 1) {
      enqueueBatchFiles('converter', allFiles.filter((x) => detectMediaKind(x) === 'video'));
    }
  });

  $('btnConvertNow').addEventListener('click', async () => {
    const activeSrc = convFile || lastMaster;
    if (!activeSrc) { toast('Selecciona, arrastra o graba un vídeo primero.', 'error'); return; }
    const fmt = $('convFormat').value;
    const res = $('convRes').value;
    const quality = $('convQuality').value;
    const status = $('converterStatus');
    const dims = res === 'source' ? {} : { width: Number(res.split('x')[0]), height: Number(res.split('x')[1]) };
    const trimOpts = (activeSrc.trimEnd > activeSrc.trimStart)
      ? { startSec: activeSrc.trimStart, endSec: activeSrc.trimEnd }
      : {};
    $('btnConvertNow').disabled = true;
    try {
      if (fmt === 'gif') {
        status.textContent = 'Codificando GIF real…';
        const srcUrlOrFile = activeSrc.remoteUrl || await ensureRealFile(activeSrc);
        const r = await window.KapturaTranscoder.toGIF(srcUrlOrFile, {
          caps, quality, ...dims, ...trimOpts,
          onProgress: (p) => { setProgress('progressBarBg', 'progressBarFill', p); status.textContent = `GIF ${Math.round(p * 100)}%`; },
        });
        downloadBlob(r.blob, `${baseName(activeSrc.name || 'kaptura')}_${r.width}x${r.height}.gif`);
        status.textContent = `✅ GIF real listo (${r.frames} frames).`;
      } else {
        const useDaemon = window.KapturaDaemon && window.KapturaDaemon.isReadyForTranscode();
        status.textContent = useDaemon
          ? `Transcodificando por GPU Daemon :3370 (${fmt.toUpperCase()})…`
          : `Transcodificando a ${fmt.toUpperCase()} (real)…`;
        const cp = daemonCodecParams(fmt);
        let r;
        if (useDaemon) {
          try {
            const daemonSrc = activeSrc.remoteUrl
              ? { remoteUrl: activeSrc.remoteUrl, name: activeSrc.name }
              : await ensureRealFile(activeSrc);
            r = await window.KapturaDaemon.transcodeViaDaemon(daemonSrc, {
              container: cp.container, codec: cp.codec, quality, ...dims, ...trimOpts,
              onProgress: (p, m) => { setProgress('progressBarBg', 'progressBarFill', p); status.textContent = `GPU :3370 ${fmt.toUpperCase()} ${Math.round(p * 100)}%${m && m.speed ? ' · ' + m.speed : ''}`; },
            });
          } catch {
            const f = await ensureRealFile(activeSrc);
            r = await window.KapturaTranscoder.transcode(f, {
              caps, container: cp.container, quality, ...dims, ...trimOpts,
              onProgress: (p) => { setProgress('progressBarBg', 'progressBarFill', p); status.textContent = `${fmt.toUpperCase()} ${Math.round(p * 100)}%`; },
            });
          }
        } else {
          const f = await ensureRealFile(activeSrc);
          r = await window.KapturaTranscoder.transcode(f, {
            caps, container: cp.container, quality, ...dims, ...trimOpts,
            onProgress: (p) => { setProgress('progressBarBg', 'progressBarFill', p); status.textContent = `${fmt.toUpperCase()} ${Math.round(p * 100)}%`; },
          });
        }
        if (r.fellBack) toast('MP4 no soportado aquí; exportado WebM real.', 'notice');
        const outW = r.width || dims.width || 'src';
        const outH = r.height || dims.height || 'src';
        downloadBlob(r.blob, `${baseName(activeSrc.name || 'kaptura')}_${outW}x${outH}.${r.ext}`);
        status.textContent = `✅ ${r.ext.toUpperCase()} real listo (${r.scaleMode}).`;
      }
      toast('Conversión real completada.', 'success');
    } catch (e) { status.textContent = ''; toast(e.message || String(e), 'error'); }
    finally { $('btnConvertNow').disabled = false; setTimeout(() => setProgress('progressBarBg', 'progressBarFill', 0), 800); }
  });

  /* ---- Smart Compressor (Image & Video + Live Estimator + Comparator) --- */
  let compFile = null, compResultBlob = null, compBeforeRevoke = null, compAfterRevoke = null;

  function refreshCompressorEstimate(src) {
    const estEl = $('compressorEstimate');
    if (!estEl || !window.KapturaCompressor || !window.KapturaCompressor.estimateBudget) return;
    const active = src || compFile || lastMaster;
    if (!active) { estEl.style.display = 'none'; return; }
    const origBytes = Number(active.sizeBytes || active.size || (active.blob && active.blob.size)) || 0;
    const targetMB = parseFloat($('compressorBudget').value) || 15;
    const dur = Number(active.duration) || 5;
    const est = window.KapturaCompressor.estimateBudget({ originalBytes: origBytes, durationSec: dur, targetMB });
    estEl.style.display = 'block';
    estEl.textContent = `ESTIMADO PREVIO: ~${est.estimatedMB} MB (-${est.savingsPct}%) · Bitrate objetivo ≈ ${est.bitrateMbps} Mbps · Escala máx ${est.targetResolution}`;
  }

  $('compressorBudget').addEventListener('change', () => refreshCompressorEstimate());
  $('compressorFormat').addEventListener('change', () => refreshCompressorEstimate());

  wireDropzone('compressorDropzone', 'compressorFileInput', (f, allFiles) => {
    compFile = f;
    const kind = detectMediaKind(f);
    $('compressorDzTitle').textContent = `SELECTED: ${f.name}`;
    $('compressorDzSub').textContent = `${(f.size / (1024 * 1024)).toFixed(2)} MB · ${kind === 'image' ? 'Imagen' : 'Vídeo'} original`;
    applyCompressorMediaMode(kind);
    refreshCompressorEstimate(f);
    runPreflightFor(f, 'compressorPreflight', '4k_cas');
    if (allFiles && allFiles.length > 1) {
      enqueueBatchFiles('compressor', allFiles);
    }
  });

  $('btnCompressNow').addEventListener('click', async () => {
    const activeSrc = compFile || lastMaster;
    if (!activeSrc) { toast('Arrastra una imagen o vídeo primero.', 'error'); return; }
    const targetMB = parseFloat($('compressorBudget').value) || 15;
    const fmt = $('compressorFormat').value;
    const quality = $('compressorQuality').value;
    const status = $('compressorStatus');
    const isImg = activeSrc.remoteUrl
      ? false
      : (window.KapturaSVGVector ? window.KapturaSVGVector.isImageFile(activeSrc) : String(activeSrc.type || activeSrc.mime || '').startsWith('image/'));
    const origSize = Number(activeSrc.sizeBytes || activeSrc.size || (activeSrc.blob && activeSrc.blob.size)) || 0;
    const srcName = activeSrc.name || 'kaptura_media';

    $('btnCompressNow').disabled = true;
    $('compressorResult').style.display = 'none';
    if (compBeforeRevoke) { compBeforeRevoke(); compBeforeRevoke = null; }
    if (compAfterRevoke) { compAfterRevoke(); compAfterRevoke = null; }

    try {
      let r;
      if (isImg) {
        const fileObj = await ensureRealFile(activeSrc);
        status.textContent = 'Comprimiendo imagen con optimización Lanczos-3…';
        r = await window.KapturaCompressor.compressImage(fileObj, {
          targetMB,
          format: fmt === 'auto' ? (fileObj.type.includes('png') ? 'webp' : 'jpeg') : fmt,
          quality,
          onProgress: (p) => { setProgress('compressorProgressBarBg', 'compressorProgressBarFill', p); status.textContent = `Comprimiendo ${Math.round(p * 100)}%…`; },
        });
      } else {
        const useDaemon = window.KapturaDaemon && window.KapturaDaemon.isReadyForTranscode();
        status.textContent = useDaemon
          ? 'Comprimiendo vídeo con GPU Daemon :3370 hacia target budget…'
          : 'Comprimiendo vídeo adaptativamente a target budget…';
        if (useDaemon) {
          try {
            const cp = daemonCodecParams(fmt === 'auto' ? 'mp4' : fmt);
            const daemonSrc = activeSrc.remoteUrl
              ? { remoteUrl: activeSrc.remoteUrl, name: srcName }
              : await ensureRealFile(activeSrc);
            const dr = await window.KapturaDaemon.transcodeViaDaemon(daemonSrc, {
              targetMB,
              container: cp.container,
              codec: cp.codec,
              quality,
              onProgress: (p, m) => { setProgress('compressorProgressBarBg', 'compressorProgressBarFill', p); status.textContent = `GPU :3370 ${Math.round(p * 100)}%${m && m.speed ? ' · ' + m.speed : ''}…`; },
            });
            r = {
              blob: dr.blob,
              ext: dr.ext,
              originalSize: origSize,
              compressedSize: dr.blob.size,
              savingsPct: Math.max(0, Math.round((1 - dr.blob.size / Math.max(1, origSize)) * 100)),
              width: dr.width || 'src',
              height: dr.height || 'src',
            };
          } catch {
            const fileObj = await ensureRealFile(activeSrc);
            r = await window.KapturaCompressor.compressVideo(fileObj, {
              targetMB,
              container: fmt === 'hevc' || fmt === 'av1_mp4' || fmt === 'auto' ? 'mp4' : fmt,
              quality,
              caps,
              onProgress: (p) => { setProgress('compressorProgressBarBg', 'compressorProgressBarFill', p); status.textContent = `Comprimiendo ${Math.round(p * 100)}%…`; },
            });
          }
        } else {
          const fileObj = await ensureRealFile(activeSrc);
          r = await window.KapturaCompressor.compressVideo(fileObj, {
            targetMB,
            container: fmt === 'hevc' || fmt === 'av1_mp4' || fmt === 'auto' ? 'mp4' : fmt,
            quality,
            caps,
            onProgress: (p) => { setProgress('compressorProgressBarBg', 'compressorProgressBarFill', p); status.textContent = `Comprimiendo ${Math.round(p * 100)}%…`; },
          });
        }
      }

      compResultBlob = r.blob;
      const origMB = (r.originalSize / (1024 * 1024)).toFixed(2);
      const compMB = (r.compressedSize / (1024 * 1024)).toFixed(2);
      const outName = `${baseName(srcName)}_COMPRESSED.${r.ext}`;

      const readout = $('compressorReadout');
      readout.textContent = `ORIGINAL: ${origMB} MB  →  COMPRIMIDO: ${compMB} MB  ·  AHORRO: -${r.savingsPct}%  (${r.width}×${r.height})`;
      const dlBtn = $('btnDownloadCompressed');
      dlBtn.download = outName;
      dlBtn.onclick = (e) => { e.preventDefault(); downloadBlob(compResultBlob, outName); };

      if (window.KapturaComparator && $('compressorCompareBox')) {
        const bSrc = mediaPreviewSrc(activeSrc);
        const aSrc = mediaPreviewSrc(r.blob);
        compBeforeRevoke = bSrc.revoke;
        compAfterRevoke = aSrc.revoke;
        window.KapturaComparator.render($('compressorCompareBox'), {
          beforeSrc: bSrc.url,
          afterSrc: aSrc.url,
          isVideo: !isImg,
          beforeLabel: `ORIGINAL (${origMB} MB)`,
          afterLabel: `COMPRIMIDO (${compMB} MB)`,
        });
      }

      $('compressorResult').style.display = 'block';
      downloadBlob(r.blob, outName);
      await saveToVault({ blob: r.blob, name: outName, mime: isImg ? 'image/' + r.ext : 'video/' + r.ext, durationSec: 'N/A', sizeBytes: r.blob.size });
      status.textContent = `✅ Compresión completada: ${compMB} MB (-${r.savingsPct}%). Guardado en Bóveda.`;
      toast(`Compresión completada: ahorraste ${r.savingsPct}%.`, 'success');
    } catch (e) { status.textContent = ''; toast(e.message || String(e), 'error'); }
    finally { $('btnCompressNow').disabled = false; setTimeout(() => setProgress('compressorProgressBarBg', 'compressorProgressBarFill', 0), 800); }
  });

  /* ---- UPSKALETOR (real Lanczos + A/B Comparator + honest AI handoff) ---- */
  let upFile = null, upMediaMeta = null, upBeforeRevoke = null, upAfterRevoke = null, upResultBlob = null;
  function setUpscaleDownloadReady(enabled, fileName, text, onClickFn) {
    [$('btnDownloadUpscaled'), $('btnDownloadUpscaledTab')].forEach((el) => {
      if (!el) return;
      el.classList.toggle('is-disabled', !enabled);
      el.setAttribute('aria-disabled', enabled ? 'false' : 'true');
      el.download = fileName || 'kaptura_upscaled';
      el.textContent = text || '⬇ DESCARGAR UPSKALED';
      el.onclick = onClickFn || null;
    });
  }

  let userPickedUpscaleProfile = false;

  function updateUpskaletorReadiness(dh) {
    const bar = $('upskaletorReadinessBar');
    if (bar) {
      const h = dh || (window.KapturaDaemon && window.KapturaDaemon.getCachedHealth ? window.KapturaDaemon.getCachedHealth() : {});
      const items = [
        { label: 'WebGL Lanczos+CAS', on: Boolean(caps && caps.gpu && caps.gpu.webgl) },
        { label: h && h.hardwareAccelerated ? `GPU Daemon :3370 (${h.preferredCodec})` : 'GPU Daemon :3370', on: Boolean(h && h.online && h.ffmpegAvailable) },
        { label: 'Real-ESRGAN Vulkan', on: Boolean(h && h.neuralAvailable) },
        { label: 'RIFE v4.6 2×FPS', on: Boolean(h && h.rifeAvailable) },
      ];
      bar.innerHTML = items.map((i) => `<span class="readiness-pill ${i.on ? 'on' : 'off'}">${i.on ? '●' : '○'} ${i.label}</span>`).join('');
    }
    const sel = $('upskaletorProfileSelect');
    if (sel && dh && dh.online && dh.neuralAvailable && !userPickedUpscaleProfile && sel.value === '2k_cas') {
      sel.value = '4k_ai';
      sel.dispatchEvent(new Event('change', { bubbles: false }));
    }
  }

  function updateUpskaletorProfileHint() {
    const sel = $('upskaletorProfileSelect');
    const hint = $('upskaletorProfileHint');
    if (!sel || !hint || !window.KapturaUpskaletor) return;
    const key = sel.value;
    const prof = (window.KapturaUpskaletor.PROFILES && window.KapturaUpskaletor.PROFILES[key]) || {};
    const h = window.KapturaDaemon && window.KapturaDaemon.getCachedHealth ? window.KapturaDaemon.getCachedHealth() : {};
    if (!prof.ai) {
      const dims = prof.w && prof.h ? `${prof.w}×${prof.h}` : `${prof.scale || 2}×`;
      hint.textContent = prof.sharpen
        ? `Tiempo real (${dims}) · Filtro AMD CAS + CFR sin pérdida en navegador o NVENC :3370.`
        : `Escalado matemático real (${dims}) en navegador o GPU Daemon :3370.`;
      return;
    }
    if (prof.pipeline === 'rife') {
      hint.textContent = h && h.rifeAvailable
        ? 'RIFE v4.6 Vulkan activo en :3370 — duplica FPS nativos (p.ej. 30→60 fps) preservando audio.'
        : 'Requiere rife-ncnn-vulkan (ejecuta `npm run setup:neural` o usa handoff CLI honesto).';
      return;
    }
    if (prof.pipeline === 'hybrid') {
      hint.textContent = h && h.neuralAvailable && h.rifeAvailable
        ? 'Pipeline dual activo (:3370): Real-ESRGAN 4K espacial + RIFE v4.6 2× FPS temporal.'
        : 'Requiere Real-ESRGAN + RIFE Vulkan (`npm run setup:neural`); sin binarios entrega comando CLI.';
      return;
    }
    hint.textContent = h && h.neuralAvailable
      ? `Real-ESRGAN activo vía :3370 (en vídeo 1080p+ usa 2× neural nativo directo a 4K; para clips largos 60fps instantáneos elige 4k_cas).`
      : 'Requiere realesrgan-ncnn-vulkan (`npm run setup:neural`); sin binario hace handoff honesto.';
  }

  function synthesizeForensicSampleFile() {
    const w = 480;
    const h = 270;
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d');
    g.fillStyle = '#050814';
    g.fillRect(0, 0, w, h);

    g.strokeStyle = 'rgba(0, 240, 255, 0.35)';
    g.lineWidth = 1;
    for (let x = 0; x < w; x += 24) { g.beginPath(); g.moveTo(x + 0.5, 0); g.lineTo(x + 0.5, h); g.stroke(); }
    for (let y = 0; y < h; y += 24) { g.beginPath(); g.moveTo(0, y + 0.5); g.lineTo(w, y + 0.5); g.stroke(); }

    // Checkerboard calibration corner (top-left)
    for (let cy = 0; cy < 48; cy += 6) {
      for (let cx = 0; cx < 96; cx += 6) {
        g.fillStyle = ((cx + cy) / 6) % 2 === 0 ? '#e2f8ff' : '#0b1224';
        g.fillRect(14 + cx, 14 + cy, 6, 6);
      }
    }

    // Crisp concentric rings + diagonal laser lines
    g.strokeStyle = '#00ff9d';
    g.lineWidth = 2;
    for (let r = 18; r <= 78; r += 15) {
      g.beginPath(); g.arc(365, 138, r, 0, Math.PI * 2); g.stroke();
    }
    g.strokeStyle = '#a855f7';
    g.lineWidth = 1.5;
    for (let i = -270; i < w; i += 32) {
      g.beginPath(); g.moveTo(i, 0); g.lineTo(i + 270, h); g.stroke();
    }

    // High-contrast crisp HUD text for Sobel sharpness test
    g.fillStyle = '#ffffff';
    g.font = 'bold 20px sans-serif';
    g.fillText('ETHERNIUM // KAPTURA 4K', 18, 128);
    g.fillStyle = '#00f0ff';
    g.font = 'bold 13px monospace';
    g.fillText('480x270 -> 3840x2160 (64x PIXELS)', 18, 152);
    g.fillStyle = '#fde68a';
    g.fillText('LANCZOS-3 + AMD CAS + SOBEL PROOF', 18, 174);

    return new Promise((resolve, reject) => {
      c.toBlob((blob) => {
        if (!blob) reject(new Error('No se pudo sintetizar la muestra forense.'));
        else resolve(new File([blob], 'kaptura_forensic_demo_480x270.png', { type: 'image/png' }));
      }, 'image/png');
    });
  }

  let skipNextAutoDownload = false;

  updateUpskaletorReadiness(null);
  updateUpskaletorProfileHint();
  if ($('upskaletorProfileSelect')) {
    $('upskaletorProfileSelect').addEventListener('change', (e) => {
      if (e && e.isTrusted) userPickedUpscaleProfile = true;
      updateUpskaletorProfileHint();
      if (upMediaMeta && window.KapturaPreflight && $('upskaletorPreflight')) {
        const dh = window.KapturaDaemon && window.KapturaDaemon.getCachedHealth ? window.KapturaDaemon.getCachedHealth() : {};
        window.KapturaPreflight.renderDiagnosticStrip($('upskaletorPreflight'), upMediaMeta, $('upskaletorProfileSelect').value, dh);
      }
    });
  }

  if ($('btnForensicDemo')) {
    $('btnForensicDemo').addEventListener('click', async () => {
      const btn = $('btnForensicDemo');
      btn.disabled = true;
      try {
        const sampleFile = await synthesizeForensicSampleFile();
        upFile = sampleFile;
        const neuralLive = Boolean(window.KapturaDaemon && typeof window.KapturaDaemon.isNeuralAvailable === 'function' && window.KapturaDaemon.isNeuralAvailable());
        const demoProfile = neuralLive ? '4k_ai' : '4k_cas';
        $('upskaletorDzTitle').textContent = `DEMO FORENSE: ${sampleFile.name}`;
        $('upskaletorDzSub').textContent = neuralLive
          ? '480×270 PNG patrón de alta frecuencia · Reconstruyendo a 3840×2160 (Real-ESRGAN x4plus Vulkan)…'
          : '480×270 PNG patrón de alta frecuencia · Escalando a 3840×2160 (4K Multi-Scale WebGL)…';
        const upTabBtn = document.querySelector('.tab-btn[data-tab="tab-upskaletor"]');
        if (upTabBtn) upTabBtn.click();
        applyUpskaletorMediaMode('image');
        if ($('upskaletorProfileSelect')) {
          $('upskaletorProfileSelect').value = demoProfile;
          $('upskaletorProfileSelect').dispatchEvent(new Event('change', { bubbles: true }));
        }
        skipNextAutoDownload = true;
        $('btnUpscaleNow').click();
      } catch (e) {
        toast(e.message || String(e), 'error');
      } finally {
        btn.disabled = false;
      }
    });
  }

  wireDropzone('upskaletorDropzone', 'upskaletorFileInput', (f, allFiles) => {
    upFile = f;
    upMediaMeta = null;
    const kind = detectMediaKind(f);
    $('upskaletorDzTitle').textContent = `SELECTED: ${f.name}`;
    $('upskaletorDzSub').textContent = `${(f.size / (1024 * 1024)).toFixed(2)} MB · ${kind === 'image' ? 'Imagen' : (f.type || 'video')}`;
    if ($('btnUpscalePreview2s')) {
      $('btnUpscalePreview2s').textContent = kind === 'image' ? '👁️ PREVIEW EN INSPECTOR' : '👁️ PREVIEW 2s EN INSPECTOR';
    }
    applyUpskaletorMediaMode(kind);
    runPreflightFor(f, 'upskaletorPreflight', $('upskaletorProfileSelect') ? $('upskaletorProfileSelect').value : '4k_ai', (meta) => { upMediaMeta = meta; });
    if (allFiles && allFiles.length > 1) {
      enqueueBatchFiles('upskaletor', allFiles);
    }
  });

  let activeUpscaleCtrl = null;
  let activeUpscaleTaskId = '';

  if ($('btnCancelUpscale')) {
    $('btnCancelUpscale').addEventListener('click', () => {
      if (activeUpscaleCtrl) {
        try { activeUpscaleCtrl.abort(); } catch {}
      }
      if (activeUpscaleTaskId && window.KapturaDaemon && window.KapturaDaemon.cancelTaskViaDaemon) {
        window.KapturaDaemon.cancelTaskViaDaemon(activeUpscaleTaskId);
      }
      $('upskaletorStatus').textContent = '✕ Cancelando proceso GPU…';
    });
  }

  async function executeUpskaletor({ previewOnly = false } = {}) {
    const activeSrc = upFile || lastMaster;
    if (!activeSrc) { toast('Arrastra un vídeo o imagen primero.', 'error'); return; }
    const profile = $('upskaletorProfileSelect').value;
    const engine = $('upskaletorEngineSelect').value;
    const status = $('upskaletorStatus');
    const cancelBtn = $('btnCancelUpscale');
    activeUpscaleTaskId = `up_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    activeUpscaleCtrl = typeof AbortController === 'function' ? new AbortController() : null;
    $('btnUpscaleNow').disabled = true;
    if ($('btnUpscalePreview2s')) $('btnUpscalePreview2s').disabled = true;
    if (cancelBtn) cancelBtn.style.display = 'inline-flex';
    setUpscaleDownloadReady(false, 'kaptura_upscaled', '⬇ DESCARGAR UPSKALED', null);
    if ($('upskaletorResult')) $('upskaletorResult').style.display = 'none';
    if (upBeforeRevoke) { upBeforeRevoke(); upBeforeRevoke = null; }
    if (upAfterRevoke) { upAfterRevoke(); upAfterRevoke = null; }
    if ($('upskaletorCompareBox')) $('upskaletorCompareBox').style.display = 'none';

    try {
      const profileObj = (window.KapturaUpskaletor.PROFILES && window.KapturaUpskaletor.PROFILES[profile]) || {};
      const pipe = profileObj.pipeline || (profileObj.ai ? 'esrgan' : 'lanczos');
      const hasNeural = Boolean(window.KapturaDaemon && typeof window.KapturaDaemon.isNeuralAvailable === 'function' && window.KapturaDaemon.isNeuralAvailable());
      const hasRife = Boolean(window.KapturaDaemon && typeof window.KapturaDaemon.isRifeAvailable === 'function' && window.KapturaDaemon.isRifeAvailable());
      const canAiDaemon = pipe === 'rife' ? hasRife : (pipe === 'hybrid' ? (hasNeural && hasRife) : hasNeural);
      const canPassRemote = Boolean(
        activeSrc.remoteUrl &&
        window.KapturaDaemon &&
        window.KapturaDaemon.isReadyForTranscode() &&
        (!profileObj.ai || canAiDaemon)
      );
      const fileObj = canPassRemote
        ? { name: activeSrc.name, type: activeSrc.mime || 'video/mp4', size: activeSrc.sizeBytes || 0, remoteUrl: activeSrc.remoteUrl }
        : await ensureRealFile(activeSrc);

      const isImgInput = detectMediaKind(fileObj) === 'image';
      const durHint = (upMediaMeta && upMediaMeta.duration) || activeSrc.duration || 0;
      const previewStartSec = previewOnly && !isImgInput && durHint > 6 ? Number((durHint * 0.15).toFixed(2)) : 0;

      const formatEta = (sec) => {
        if (sec === null || sec === undefined || !Number.isFinite(Number(sec))) return '';
        const s = Math.max(0, Math.round(Number(sec)));
        if (s >= 60) return ` · ETA ${Math.floor(s / 60)}m ${s % 60}s`;
        return ` · ETA ${s}s`;
      };
      const detailSelect = $('upskaletorDetailSelect');
      const sharpenVal = detailSelect ? Number(detailSelect.value) : undefined;
      const result = await window.KapturaUpskaletor.run(fileObj, profile, engine, {
        caps,
        sharpen: sharpenVal,
        previewSec: previewOnly && !isImgInput ? 2.0 : 0,
        previewStartSec,
        taskId: activeUpscaleTaskId,
        signal: activeUpscaleCtrl ? activeUpscaleCtrl.signal : undefined,
        onProgress: (p, m) => {
          setProgress('upskaletorProgressBarBg', 'upskaletorProgressBarFill', p);
          const stageTag = m && m.stage ? ` · ${m.stage}` : '';
          const modelTag = m && m.model ? ` (${m.model}${m.scale ? ' ' + m.scale + '×' : ''})` : '';
          const segTag = m && m.segment && m.totalSegments ? ` · Seg ${m.segment}/${m.totalSegments}` : '';
          const frameTag = m && m.frame ? ` · f${m.frame}${m.totalFrames ? '/' + m.totalFrames : ''}` : '';
          const spfTag = m && m.secPerFrame ? ` · ${m.secPerFrame}s/f` : '';
          const speedTag = m && m.speed ? ` · ${m.speed}` : '';
          const etaTag = m ? formatEta(m.etaSec) : '';
          const pPrefix = previewOnly ? 'Preview 2s ' : 'Procesando ';
          status.textContent = `${pPrefix}${Math.round(p * 100)}%${stageTag}${modelTag}${segTag}${frameTag}${spfTag}${speedTag}${etaTag}…`;
        },
      });
      if (result.mode === 'handoff') {
        upResultBlob = fileObj;
        try { await navigator.clipboard.writeText(result.command); } catch { /* clipboard optional */ }
        if (!previewOnly) downloadBlob(fileObj, fileObj.name);
        setUpscaleDownloadReady(
          true,
          fileObj.name,
          `⬇ DESCARGAR MASTER (${(fileObj.size / (1024 * 1024)).toFixed(2)} MB)`,
          (e) => { e.preventDefault(); downloadBlob(upResultBlob, fileObj.name); }
        );
        status.textContent = '↗ Handoff a UPSKALETOR: master entregado + comando copiado.';
        toast(result.reason, 'notice', 9000);
      } else {
        const resTag = result.width && result.height ? `${result.width}x${result.height}` : (result.pipeline === 'rife' ? 'RIFE_2xFPS' : 'HD');
        const labelTag = result.width && result.height ? `${result.width}×${result.height}` : (result.pipeline === 'rife' ? '2× FPS' : '');
        const suffixTag = previewOnly ? '_PREVIEW2S' : '_UPSKALED';
        const name = `${baseName(fileObj.name)}${suffixTag}_${resTag}.${result.ext}`;
        upResultBlob = result.blob || null;
        const outTarget = result.blob || result.remoteUrl;
        const outSizeBytes = (result.blob && result.blob.size) || result.sizeBytes || 0;
        const sizeMB = (outSizeBytes / (1024 * 1024)).toFixed(2);
        setUpscaleDownloadReady(
          true,
          name,
          `⬇ DESCARGAR ${labelTag} (${sizeMB} MB)`,
          (e) => { e.preventDefault(); downloadBlob(outTarget, name); }
        );
        const it = result.integrity;
        const itText = it && it.srcFps && it.outFps
          ? ` · FPS: ${it.srcFps}→${it.outFps} · Drift: ${it.durationDriftMs ?? 0}ms${it.audioPreserved ? ' · Audio OK' : ''}`
          : '';
        if ($('upskaletorReadout')) {
          const prefix = previewOnly ? '👁️ PREVIEW FORENSE 2s (muestra previa al render completo) · ' : '';
          $('upskaletorReadout').textContent = `${prefix}ARCHIVO LISTO: ${name} · ${sizeMB} MB · Motor: ${result.scaleMode}${itText}`;
        }
        if ($('upskaletorResult')) $('upskaletorResult').style.display = 'block';
        if (window.KapturaComparator && $('upskaletorCompareBox')) {
          const bSrc = result.previewSourceUrl ? { url: result.previewSourceUrl, revoke: () => {} } : mediaPreviewSrc(activeSrc);
          const aSrc = mediaPreviewSrc(result.blob || result);
          upBeforeRevoke = bSrc.revoke;
          upAfterRevoke = aSrc.revoke;
          window.KapturaComparator.render($('upskaletorCompareBox'), {
            beforeSrc: bSrc.url,
            afterSrc: aSrc.url,
            isVideo: !result.isImage,
            beforeLabel: previewOnly && !result.isImage ? 'ORIGINAL (2s)' : 'ORIGINAL',
            afterLabel: result.pipeline === 'rife' ? 'RIFE 2× FPS' : (previewOnly && !result.isImage ? 'PREVIEW 2s' : 'UPSKALED'),
            integrity: result.integrity || null,
            engineLabel: result.scaleMode || '',
            isRife: result.pipeline === 'rife' || result.pipeline === 'hybrid',
          });
        }
        const autoDl = !skipNextAutoDownload && !previewOnly;
        skipNextAutoDownload = false;
        if (autoDl) downloadBlob(outTarget, name);
        if (!previewOnly) {
          await saveToVault({ blob: result.blob || null, remoteUrl: result.remoteUrl || null, name, mime: (result.isImage ? 'image/' : 'video/') + result.ext, durationSec: 'N/A', sizeBytes: outSizeBytes });
        }
        if (result.fellBack) toast('MP4 no disponible; guardado WebM real.', 'notice');
        status.textContent = previewOnly
          ? `👁️ Preview forense listo (${labelTag || resTag}). Pulsa 🚀 START UPSKALETOR para exportar el archivo completo.`
          : `✅ Proceso real ${labelTag || resTag} (${result.scaleMode}).`;
        toast(
          previewOnly
            ? 'Preview forense abierto en Inspector A/B. Usa 4×/8× o Δ×8 Heatmap para auditar detalle.'
            : `Proceso real ${result.isImage ? 'de imagen' : 'de vídeo'} completado y guardado en la Bóveda.`,
          'success'
        );
      }
    } catch (e) {
      if (e && e.name === 'AbortError') {
        status.textContent = '✕ Proceso cancelado por el operador.';
        toast('Proceso GPU cancelado limpiamente.', 'notice');
      } else {
        status.textContent = '';
        toast(e.message || String(e), 'error');
      }
    }
    finally {
      activeUpscaleCtrl = null;
      activeUpscaleTaskId = '';
      $('btnUpscaleNow').disabled = false;
      if ($('btnUpscalePreview2s')) $('btnUpscalePreview2s').disabled = false;
      if ($('btnCancelUpscale')) $('btnCancelUpscale').style.display = 'none';
      setTimeout(() => setProgress('upskaletorProgressBarBg', 'upskaletorProgressBarFill', 0), 800);
    }
  }

  $('btnUpscaleNow').addEventListener('click', () => executeUpskaletor({ previewOnly: false }));
  if ($('btnUpscalePreview2s')) {
    $('btnUpscalePreview2s').addEventListener('click', () => executeUpskaletor({ previewOnly: true }));
  }

  $('btnCopyCmd').addEventListener('click', async () => {
    const file = upFile || (lastMaster && { name: lastMaster.name }) || { name: 'kaptura_master.mp4' };
    const cmd = window.KapturaUpskaletor.command(file.name, $('upskaletorProfileSelect').value, $('upskaletorEngineSelect').value);
    try { await navigator.clipboard.writeText(cmd); toast('Comando copiado al portapapeles.', 'success'); }
    catch { window.prompt('Copia el comando de UPSKALETOR:', cmd); }
  });

  /* ---- Cinema GIF (real native GIF89a) ---------------------------------- */
  let cinemaFile = null, cinemaPreviewUrl = null;
  wireDropzone('cinemaDropzone', 'cinemaFileInput', (f) => {
    if (detectMediaKind(f) === 'image') {
      toast('Esta pestaña solo procesa vídeos (.mp4 / .webm). Para imágenes usa Compresor, SVG Vector o UPSKALETOR.', 'error');
      return;
    }
    cinemaFile = f;
    $('cinemaDzTitle').textContent = `SELECTED: ${f.name}`;
    $('cinemaDzSub').textContent = `${(f.size / (1024 * 1024)).toFixed(2)} MB · ${f.type || 'video'}`;
  });
  $('btnCinemaExport').addEventListener('click', async () => {
    const activeSrc = cinemaFile || lastMaster;
    if (!activeSrc) { toast('Arrastra un vídeo o graba uno primero.', 'error'); return; }
    const status = $('cinemaStatus');
    const speedMode = $('cinemaSpeed') ? $('cinemaSpeed').value : 'normal';
    const trimOpts = (activeSrc.trimEnd > activeSrc.trimStart)
      ? { startSec: activeSrc.trimStart, endSec: activeSrc.trimEnd }
      : {};
    $('btnCinemaExport').disabled = true;
    try {
      status.textContent = 'Codificando Cinema GIF real…';
      const srcArg = activeSrc.remoteUrl || await ensureRealFile(activeSrc);
      const r = await window.KapturaTranscoder.toGIF(srcArg, {
        caps,
        fps: parseInt($('cinemaFps').value, 10),
        speedMode,
        width: parseInt($('cinemaWidth').value, 10),
        dither: $('cinemaDither').value === '1',
        quality: caps.gpu.webgl ? 'max' : 'fast',
        ...trimOpts,
        onProgress: (p) => { setProgress('cinemaProgressBarBg', 'cinemaProgressBarFill', p); status.textContent = `${Math.round(p * 100)}% (${p < 0.6 ? 'extracción' : 'codificación'})`; },
      });
      const name = `Ethernium_Cinema_${stamp()}.gif`;
      downloadBlob(r.blob, name);
      if (cinemaPreviewUrl) URL.revokeObjectURL(cinemaPreviewUrl);
      cinemaPreviewUrl = URL.createObjectURL(r.blob);
      const img = $('cinemaPreview'); img.src = cinemaPreviewUrl; img.style.display = 'inline-block';
      const durLabel = r.duration ? ` · ${r.duration.toFixed(1)}s` : '';
      status.textContent = `✅ Cinema GIF real: ${r.width}×${r.height}, ${r.frames} frames${durLabel} (${speedMode === 'normal' ? '1.0x Real-Time' : speedMode}).`;
      toast('Cinema GIF real generado a velocidad exacta.', 'success');
    } catch (e) { status.textContent = ''; toast(e.message || String(e), 'error'); }
    finally { $('btnCinemaExport').disabled = false; setTimeout(() => setProgress('cinemaProgressBarBg', 'cinemaProgressBarFill', 0), 800); }
  });

  /* ---- SVG Vector (real animated SVG & vector paths) ------------------- */
  let svgFile = null;
  wireDropzone('svgDropzone', 'svgFileInput', (f) => {
    svgFile = f;
    const kind = detectMediaKind(f);
    $('svgDzTitle').textContent = `SELECTED: ${f.name}`;
    $('svgDzSub').textContent = `${(f.size / (1024 * 1024)).toFixed(2)} MB · ${kind === 'image' ? 'Imagen para Vectorizar' : 'Vídeo para SVG animado'}`;
    if ($('svgSource')) {
      $('svgSource').value = 'file';
      $('svgSource').dispatchEvent(new Event('change', { bubbles: true }));
    }
    applySvgMediaMode(kind);
  });
  if ($('svgSource')) {
    $('svgSource').addEventListener('change', () => {
      applySvgMediaMode(svgFile ? detectMediaKind(svgFile) : 'video');
    });
  }
  $('btnSvgExport').addEventListener('click', async () => {
    const status = $('svgStatus');
    const source = $('svgSource').value;
    $('btnSvgExport').disabled = true;
    try {
      let r;
      const onProgress = (p) => { setProgress('svgProgressBarBg', 'svgProgressBarFill', p); status.textContent = `${Math.round(p * 100)}%`; };
      if (source === 'scene') {
        status.textContent = 'Capturando la escena del canvas en SVG animado…';
        r = await window.KapturaSVGVector.fromCanvas(canvas, {
          caps, fps: parseInt($('svgFps').value, 10), seconds: 3, onProgress,
        });
        downloadBlob(r.blob, `Ethernium_Vector_${stamp()}.svg`);
        status.textContent = `✅ SVG animado real: ${r.width}×${r.height}, ${r.frames} frames.`;
        toast('SVG Vector real exportado.', 'success');
      } else {
        const srcRaw = svgFile || lastMaster;
        if (!srcRaw) { toast('Arrastra un vídeo o imagen primero.', 'error'); $('btnSvgExport').disabled = false; return; }
        const src = await ensureRealFile(srcRaw);
        const isImg = window.KapturaSVGVector.isImageFile(src);

        if (isImg) {
          const modeVal = $('svgVectorMode') ? $('svgVectorMode').value : 'trace_8';
          const mode = modeVal === 'container' ? 'container' : 'trace';
          const colors = modeVal === 'trace_16' ? 16 : (modeVal === 'trace_4' ? 4 : 8);
          status.textContent = 'Vectorizando imagen a SVG real…';
          r = await window.KapturaSVGVector.fromImage(src, { caps, mode, colors, onProgress });
          downloadBlob(r.blob, `Ethernium_Vector_${baseName(src.name || 'image')}_${stamp()}.svg`);
          status.textContent = r.mode === 'trace' ? `✅ SVG Vectorial real: ${r.width}×${r.height}, ${r.layers} capas, ${r.totalPaths} trazados.` : `✅ SVG Escalable Master: ${r.width}×${r.height}.`;
          toast('SVG Vectorial real exportado.', 'success');
        } else {
          status.textContent = 'Exportando vídeo a SVG animado…';
          r = await window.KapturaSVGVector.fromVideo(src, { caps, fps: parseInt($('svgFps').value, 10), onProgress });
          downloadBlob(r.blob, `Ethernium_Vector_${stamp()}.svg`);
          status.textContent = `✅ SVG animado real: ${r.width}×${r.height}, ${r.frames} frames.`;
          toast('SVG animado exportado.', 'success');
        }
      }
    } catch (e) { status.textContent = ''; toast(e.message || String(e), 'error'); }
    finally { $('btnSvgExport').disabled = false; setTimeout(() => setProgress('svgProgressBarBg', 'svgProgressBarFill', 0), 800); }
  });

  /* ---- shared dropzone wiring ------------------------------------------- */
  function triggerDropSplash(x, y, zone, strength) {
    if (window.KapturaLiquidShader && typeof window.KapturaLiquidShader.triggerWaterDrop === 'function') {
      window.KapturaLiquidShader.triggerWaterDrop(x, y, strength, zone);
    }
  }
  function wireDropzone(zoneId, inputId, onFiles) {
    const zone = $(zoneId), input = $(inputId);
    let lastClick = null;
    zone.addEventListener('click', (e) => {
      if (e && e.target === input) return;
      if (e && e.isTrusted && (e.clientX > 0 || e.clientY > 0)) {
        lastClick = { x: e.clientX, y: e.clientY };
      }
      input.click();
    });
    input.addEventListener('change', (e) => {
      const files = e.target.files ? Array.from(e.target.files) : [];
      if (!files.length) return;
      const rect = zone.getBoundingClientRect();
      const x = lastClick ? lastClick.x : (rect.left + rect.width * 0.5);
      const y = lastClick ? lastClick.y : (rect.top + rect.height * 0.5);
      triggerDropSplash(x, y, zone, 0.92);
      onFiles(files[0], files);
      try { input.value = ''; } catch {}
    });
    zone.addEventListener('dragover', (e) => {
      e.preventDefault();
      zone.classList.add('dragover');
      if (window.KapturaLiquidShader && typeof window.KapturaLiquidShader.triggerHoverTouch === 'function') {
        window.KapturaLiquidShader.triggerHoverTouch(e.clientX, e.clientY, zone);
      }
    });
    zone.addEventListener('dragleave', (e) => {
      if (e.relatedTarget && zone.contains(e.relatedTarget)) return;
      zone.classList.remove('dragover');
    });
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      zone.classList.remove('dragover');
      const files = e.dataTransfer && e.dataTransfer.files ? Array.from(e.dataTransfer.files) : [];
      if (!files.length) return;
      const rect = zone.getBoundingClientRect();
      const dropX = Number.isFinite(e.clientX) && e.clientX > 0 ? e.clientX : (rect.left + rect.width * 0.5);
      const dropY = Number.isFinite(e.clientY) && e.clientY > 0 ? e.clientY : (rect.top + rect.height * 0.5);
      triggerDropSplash(dropX, dropY, zone, 1.0);
      onFiles(files[0], files);
    });
  }
  function baseName(n) { const i = n.lastIndexOf('.'); return i > 0 ? n.substring(0, i) : n; }

  /* ---- BG STUDIO PREMIUM (Images & Videos Matte / Chroma / Alpha) ------ */
  let bgFile = null, bgMediaMeta = null, bgCustomFile = null;
  let bgBeforeRevoke = null, bgAfterRevoke = null, activeBgCtrl = null, activeBgTaskId = '';

  function updateBgReadiness(dh) {
    const bar = $('bgReadinessBar');
    if (!bar) return;
    const h = dh || (window.KapturaDaemon && window.KapturaDaemon.getCachedHealth ? window.KapturaDaemon.getCachedHealth() : {});
    const bgr = (h && h.bgRemoval) || {};
    const items = [
      { label: 'BiRefNet 2K HR CUDA', on: Boolean(h && h.online && bgr.birefnetHr) },
      { label: 'BiRefNet 1024px ONNX', on: Boolean(h && h.online && bgr.birefnet) },
      { label: 'RVM ResNet50 RTX CUDA', on: Boolean(h && h.online && bgr.rvmCuda) },
      { label: 'RGB Guided + MLFE Anti-Halo', on: Boolean(h && h.online && (bgr.birefnetHr || bgr.birefnet || bgr.rvmCuda || bgr.rvmOnnx)) },
      { label: 'Chroma-Key + WebM/PNG Alpha', on: true },
    ];
    bar.innerHTML = items.map((i) => `<span class="readiness-pill ${i.on ? 'on' : 'off'}">${i.on ? '●' : '○'} ${i.label}</span>`).join('');
  }

  function syncBgContextualControls() {
    const bd = $('bgBackdropSelect') ? $('bgBackdropSelect').value : 'transparent';
    const eng = $('bgEngineSelect') ? $('bgEngineSelect').value : 'auto';
    const showSolid = bd === 'solid';
    const showBlur = bd === 'bokeh';
    const showImg = bd === 'custom_image';
    const showChroma = eng === 'chroma';
    if ($('bgSolidColorWrap')) $('bgSolidColorWrap').style.display = showSolid ? 'flex' : 'none';
    if ($('bgBlurWrap')) $('bgBlurWrap').style.display = showBlur ? 'flex' : 'none';
    if ($('bgCustomImgWrap')) $('bgCustomImgWrap').style.display = showImg ? 'flex' : 'none';
    if ($('bgChromaWrap')) $('bgChromaWrap').style.display = showChroma ? 'flex' : 'none';
    if ($('bgContextOptions')) {
      $('bgContextOptions').style.display = (showSolid || showBlur || showImg || showChroma) ? 'flex' : 'none';
    }
  }

  if ($('bgBackdropSelect')) $('bgBackdropSelect').addEventListener('change', syncBgContextualControls);
  if ($('bgEngineSelect')) $('bgEngineSelect').addEventListener('change', syncBgContextualControls);
  if ($('bgBlurRange') && $('bgBlurVal')) {
    $('bgBlurRange').addEventListener('input', () => { $('bgBlurVal').textContent = $('bgBlurRange').value; });
  }
  if ($('btnPickBgCustomImg') && $('bgCustomImgInput')) {
    $('btnPickBgCustomImg').addEventListener('click', () => $('bgCustomImgInput').click());
    $('bgCustomImgInput').addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      bgCustomFile = f;
      if ($('bgCustomImgName')) $('bgCustomImgName').textContent = f.name;
    });
  }

  if ($('bgDropzone') && $('bgFileInput')) {
    wireDropzone('bgDropzone', 'bgFileInput', (f, allFiles) => {
      bgFile = f;
      bgMediaMeta = null;
      const kind = detectMediaKind(f);
      $('bgDzTitle').textContent = `SELECTED: ${f.name}`;
      $('bgDzSub').textContent = `${(f.size / (1024 * 1024)).toFixed(2)} MB · ${kind === 'image' ? 'Imagen' : (f.type || 'video')}`;
      applyBgStudioMediaMode(kind);
      runPreflightFor(f, 'bgPreflight', 'bg_remove', (meta) => { bgMediaMeta = meta; });
      if (allFiles && allFiles.length > 1) {
        enqueueBatchFiles('bgremove', allFiles);
      }
    });
  }

  if ($('btnCancelBg')) {
    $('btnCancelBg').addEventListener('click', () => {
      if (activeBgCtrl) try { activeBgCtrl.abort(); } catch {}
      if (activeBgTaskId && window.KapturaDaemon && window.KapturaDaemon.cancelTaskViaDaemon) {
        window.KapturaDaemon.cancelTaskViaDaemon(activeBgTaskId);
      }
      if ($('bgStatus')) $('bgStatus').textContent = '✕ Cancelando BG Studio…';
    });
  }

  async function executeBgRemove({ previewOnly = false } = {}) {
    if (!window.KapturaBgRemover) return;
    const activeSrc = bgFile || lastMaster;
    if (!activeSrc) { toast('Arrastra una imagen o vídeo en BG Studio primero.', 'error'); return; }
    const engine = $('bgEngineSelect') ? $('bgEngineSelect').value : 'auto';
    const backdrop = $('bgBackdropSelect') ? $('bgBackdropSelect').value : 'transparent';
    const edgeRefine = $('bgEdgeSelect') ? Number($('bgEdgeSelect').value) : 0;
    const decontaminate = $('bgDecontaminateSelect') ? $('bgDecontaminateSelect').value !== '0' : true;
    const bgColor = $('bgSolidColor') ? $('bgSolidColor').value : '#050814';
    const blurStrength = $('bgBlurRange') ? Number($('bgBlurRange').value) : 23;
    const keyColor = $('bgChromaColor') ? $('bgChromaColor').value : '#00FF00';
    const similarity = $('bgChromaSim') ? Number($('bgChromaSim').value) : 0.20;
    const blend = $('bgChromaBlend') ? Number($('bgChromaBlend').value) : 0.08;

    if (backdrop === 'custom_image' && !bgCustomFile) {
      toast('Elige primero una imagen de fondo en 🖼️ ELEGIR IMAGEN DE FONDO.', 'error');
      return;
    }

    const status = $('bgStatus');
    const dlBtn = $('btnDownloadBgRemoved');
    activeBgTaskId = `bg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    activeBgCtrl = typeof AbortController === 'function' ? new AbortController() : null;
    if ($('btnBgRemoveNow')) $('btnBgRemoveNow').disabled = true;
    if ($('btnBgPreview2s')) $('btnBgPreview2s').disabled = true;
    if ($('btnCancelBg')) $('btnCancelBg').style.display = 'inline-flex';
    if (dlBtn) {
      dlBtn.classList.add('is-disabled');
      dlBtn.setAttribute('aria-disabled', 'true');
      dlBtn.onclick = null;
    }
    if ($('bgResult')) $('bgResult').style.display = 'none';
    if (bgBeforeRevoke) { bgBeforeRevoke(); bgBeforeRevoke = null; }
    if (bgAfterRevoke) { bgAfterRevoke(); bgAfterRevoke = null; }
    if ($('bgCompareBox')) $('bgCompareBox').style.display = 'none';

    try {
      const dh = window.KapturaDaemon && window.KapturaDaemon.getCachedHealth ? window.KapturaDaemon.getCachedHealth() : {};
      const bgCaps = (dh && dh.bgRemoval) || {};
      const hasAnyNeural = Boolean(bgCaps.birefnetHr || bgCaps.birefnet || bgCaps.rvmCuda || bgCaps.rvmOnnx);
      const canPassRemote = Boolean(
        activeSrc.remoteUrl &&
        window.KapturaDaemon &&
        window.KapturaDaemon.isReadyForTranscode() &&
        (engine === 'chroma' || hasAnyNeural)
      );
      const fileObj = canPassRemote
        ? { name: activeSrc.name, type: activeSrc.mime || 'video/mp4', size: activeSrc.sizeBytes || 0, remoteUrl: activeSrc.remoteUrl }
        : await ensureRealFile(activeSrc);

      const isImgInput = detectMediaKind(fileObj) === 'image';
      const durHint = (bgMediaMeta && bgMediaMeta.duration) || activeSrc.duration || 0;
      const previewStartSec = previewOnly && !isImgInput && durHint > 6 ? Number((durHint * 0.15).toFixed(2)) : 0;

      const result = await window.KapturaBgRemover.run(fileObj, {
        engine,
        backdrop,
        bgColor,
        blurStrength,
        customBgFile: bgCustomFile,
        edgeRefine,
        decontaminate,
        keyColor,
        similarity,
        blend,
        previewSec: previewOnly && !isImgInput ? 2.0 : 0,
        previewStartSec,
        taskId: activeBgTaskId,
        signal: activeBgCtrl ? activeBgCtrl.signal : undefined,
        onProgress: (p, m) => {
          setProgress('bgProgressBarBg', 'bgProgressBarFill', p);
          const stageTag = m && m.stage ? ` · ${m.stage}` : '';
          const frameTag = m && m.frame ? ` · f${m.frame}${m.totalFrames ? '/' + m.totalFrames : ''}` : '';
          const spfTag = m && m.secPerFrame ? ` · ${m.secPerFrame}s/f` : '';
          const etaTag = m && m.etaSec !== undefined ? ` · ETA ${m.etaSec}s` : '';
          status.textContent = `${previewOnly ? 'Preview 2s ' : 'BG Studio '}${Math.round(p * 100)}%${stageTag}${frameTag}${spfTag}${etaTag}…`;
        },
      });

      const outTarget = result.blob || result.remoteUrl;
      const outBytes = (result.blob && result.blob.size) || result.sizeBytes || 0;
      const sizeMB = (outBytes / (1024 * 1024)).toFixed(2);
      const outName = `${baseName(fileObj.name)}${previewOnly ? '_BG_PREVIEW' : '_NOBG'}_${backdrop}.${result.ext}`;
      if (dlBtn) {
        dlBtn.classList.remove('is-disabled');
        dlBtn.setAttribute('aria-disabled', 'false');
        dlBtn.download = outName;
        dlBtn.textContent = `⬇ DESCARGAR ${result.ext.toUpperCase()} (${sizeMB} MB)`;
        dlBtn.onclick = (e) => { e.preventDefault(); downloadBlob(outTarget, outName); };
      }
      if ($('bgReadout')) {
        $('bgReadout').textContent = `${previewOnly ? '👁️ PREVIEW 2s · ' : ''}LISTO: ${outName} · ${sizeMB} MB · Motor: ${result.scaleMode}`;
      }
      if ($('bgResult')) $('bgResult').style.display = 'block';
      if (window.KapturaComparator && $('bgCompareBox')) {
        const bSrc = result.previewSourceUrl ? { url: result.previewSourceUrl, revoke: () => {} } : mediaPreviewSrc(activeSrc);
        const aSrc = mediaPreviewSrc(result.blob || result);
        bgBeforeRevoke = bSrc.revoke;
        bgAfterRevoke = aSrc.revoke;
        window.KapturaComparator.render($('bgCompareBox'), {
          beforeSrc: bSrc.url,
          afterSrc: aSrc.url,
          isVideo: !result.isImage,
          beforeLabel: previewOnly && !result.isImage ? 'ORIGINAL (2s)' : 'ORIGINAL',
          afterLabel: backdrop === 'transparent' ? 'SIN FONDO (ALPHA)' : `FONDO ${backdrop.toUpperCase()}`,
          integrity: result.integrity || null,
          engineLabel: result.scaleMode || '',
          checkerboard: true,
        });
      }
      if (!previewOnly) {
        downloadBlob(outTarget, outName);
        const mimeMap = { png: 'image/png', webm: 'video/webm', mov: 'video/quicktime', mp4: 'video/mp4' };
        await saveToVault({ blob: result.blob || null, remoteUrl: result.remoteUrl || null, name: outName, mime: mimeMap[result.ext] || 'video/mp4', durationSec: 'N/A', sizeBytes: outBytes });
      }
      status.textContent = previewOnly
        ? '👁️ Preview de recorte listo sobre tablero de transparencia.'
        : `✅ Fondo eliminado (${result.scaleMode}). Guardado en Bóveda.`;
      toast(previewOnly ? 'Preview BG Studio abierto en Inspector.' : 'Eliminación de fondo completada.', 'success');
    } catch (e) {
      if (e && e.name === 'AbortError') {
        status.textContent = '✕ Proceso cancelado por el operador.';
        toast('BG Studio cancelado limpiamente.', 'notice');
      } else {
        status.textContent = '';
        toast(e.message || String(e), 'error');
      }
    } finally {
      activeBgCtrl = null;
      activeBgTaskId = '';
      if ($('btnBgRemoveNow')) $('btnBgRemoveNow').disabled = false;
      if ($('btnBgPreview2s')) $('btnBgPreview2s').disabled = false;
      if ($('btnCancelBg')) $('btnCancelBg').style.display = 'none';
      setTimeout(() => setProgress('bgProgressBarBg', 'bgProgressBarFill', 0), 800);
    }
  }

  if ($('btnBgRemoveNow')) $('btnBgRemoveNow').addEventListener('click', () => executeBgRemove({ previewOnly: false }));
  if ($('btnBgPreview2s')) $('btnBgPreview2s').addEventListener('click', () => executeBgRemove({ previewOnly: true }));

  /* ---- GPU Batch Queue UI Dock ----------------------------------------- */
  const batchQueue = window.KapturaBatchQueue ? window.KapturaBatchQueue.createQueue() : null;

  function renderBatchDock(snap) {
    const dock = $('batchQueueDock');
    if (!dock || !snap) return;
    if (!snap.items.length) {
      dock.style.display = 'none';
      return;
    }
    dock.style.display = 'block';
    if ($('batchQueueSummary')) {
      $('batchQueueSummary').textContent = `${snap.queuedCount} en cola · ${snap.completedCount} listos · ${snap.items.length} total`;
    }
    if ($('btnBatchStart')) $('btnBatchStart').disabled = snap.running || snap.queuedCount === 0;
    if ($('btnBatchCancel')) $('btnBatchCancel').style.display = snap.running ? 'inline-flex' : 'none';
    const list = $('batchQueueList');
    if (!list) return;
    list.innerHTML = snap.items.map((it) => {
      const mb = (it.sizeBytes / (1024 * 1024)).toFixed(2);
      const pct = Math.round((it.progress || 0) * 100);
      const cls = it.status === 'completed' ? 'done' : (it.status === 'failed' || it.status === 'cancelled' ? 'err' : '');
      const dlHtml = it.status === 'completed' && (it.outputUrl || it.outputBlob)
        ? `<button class="vault-btn" data-bq-dl="${it.id}" style="flex:0 0 auto; padding:4px 10px">⬇</button>`
        : '';
      return `<div class="batch-row">
        <div>
          <div class="batch-row-name">${escapeHtml(it.name)}</div>
          <div class="batch-row-meta">${escapeHtml(it.label)} · ${mb} MB${it.error ? ' · ' + escapeHtml(it.error) : ''}</div>
        </div>
        <div style="display:flex; align-items:center; gap:8px">
          <span class="batch-row-state ${cls}">${it.status.toUpperCase()} ${pct}% · ${escapeHtml(it.stage)}</span>
          ${dlHtml}
          <button class="vault-btn del" data-bq-rm="${it.id}" style="flex:0 0 auto; padding:4px 8px">✕</button>
        </div>
      </div>`;
    }).join('');

    list.querySelectorAll('[data-bq-rm]').forEach((b) => {
      b.addEventListener('click', () => batchQueue && batchQueue.removeItem(b.dataset.bqRm));
    });
    list.querySelectorAll('[data-bq-dl]').forEach((b) => {
      b.addEventListener('click', () => {
        const cur = snap.items.find((x) => x.id === b.dataset.bqDl);
        if (cur) downloadBlob(cur.outputBlob || cur.outputUrl, cur.outputName || cur.name);
      });
    });
  }

  function enqueueBatchFiles(tab, files) {
    if (!batchQueue || !files || !files.length) return;
    const labels = { upskaletor: 'UPSKALETOR', bgremove: 'BG STUDIO', compressor: 'COMPRESOR', converter: 'V-CONVERTER' };
    files.forEach((f) => batchQueue.enqueue({ file: f, tab, label: labels[tab] || tab }));
    toast(`📦 Lote de ${files.length} archivos añadido a la Cola GPU (ejecución secuencial segura).`, 'success');
  }

  async function runBatchItem(item, { onProgress, signal }) {
    const file = item.file;
    const isImg = detectMediaKind(file) === 'image';
    if (item.tab === 'upskaletor') {
      const profSel = $('upskaletorProfileSelect');
      let prof = profSel ? profSel.value : '4k_cas';
      if (window.KapturaUpskaletor && !window.KapturaUpskaletor.isProfileCompatible(prof, isImg ? 'image' : 'video')) {
        prof = '4k_cas';
      }
      const res = await window.KapturaUpskaletor.run(file, prof, $('upskaletorEngineSelect') ? $('upskaletorEngineSelect').value : 'auto', {
        caps,
        sharpen: $('upskaletorDetailSelect') ? Number($('upskaletorDetailSelect').value) : undefined,
        onProgress,
        signal,
      });
      if (res.mode === 'handoff') throw new Error(res.reason || 'Handoff requerido');
      const name = `${baseName(file.name)}_UPSKALED.${res.ext}`;
      await saveToVault({ blob: res.blob || null, remoteUrl: res.remoteUrl || null, name, mime: (res.isImage ? 'image/' : 'video/') + res.ext, durationSec: 'N/A', sizeBytes: res.sizeBytes || 0 });
      return { blob: res.blob, remoteUrl: res.remoteUrl, outputName: name };
    }
    if (item.tab === 'bgremove' && window.KapturaBgRemover) {
      let eng = $('bgEngineSelect') ? $('bgEngineSelect').value : 'auto';
      let bd = $('bgBackdropSelect') ? $('bgBackdropSelect').value : 'transparent';
      if (!window.KapturaBgRemover.isEngineCompatible(eng, isImg ? 'image' : 'video')) eng = 'auto';
      if (!window.KapturaBgRemover.isBackdropCompatible(bd, isImg ? 'image' : 'video')) bd = 'transparent';
      const res = await window.KapturaBgRemover.run(file, {
        engine: eng,
        backdrop: bd,
        bgColor: $('bgSolidColor') ? $('bgSolidColor').value : '#050814',
        blurStrength: $('bgBlurRange') ? Number($('bgBlurRange').value) : 23,
        customBgFile: bgCustomFile,
        edgeRefine: $('bgEdgeSelect') ? Number($('bgEdgeSelect').value) : 0,
        decontaminate: $('bgDecontaminateSelect') ? $('bgDecontaminateSelect').value !== '0' : true,
        onProgress,
        signal,
      });
      const name = `${baseName(file.name)}_NOBG_${bd}.${res.ext}`;
      await saveToVault({ blob: res.blob || null, remoteUrl: res.remoteUrl || null, name, mime: (isImg ? 'image/' : 'video/') + res.ext, durationSec: 'N/A', sizeBytes: res.sizeBytes || 0 });
      return { blob: res.blob, remoteUrl: res.remoteUrl, outputName: name };
    }
    if (item.tab === 'compressor') {
      const targetMB = parseFloat($('compressorBudget') ? $('compressorBudget').value : '15') || 15;
      const fmt = $('compressorFormat') ? $('compressorFormat').value : 'auto';
      const quality = $('compressorQuality') ? $('compressorQuality').value : 'max';
      if (isImg) {
        const r = await window.KapturaCompressor.compressImage(file, { targetMB, format: fmt === 'auto' ? 'webp' : fmt, quality, onProgress });
        const name = `${baseName(file.name)}_COMPRESSED.${r.ext}`;
        await saveToVault({ blob: r.blob, name, mime: 'image/' + r.ext, durationSec: 'N/A', sizeBytes: r.blob.size });
        return { blob: r.blob, outputName: name };
      }
      const useDaemon = window.KapturaDaemon && window.KapturaDaemon.isReadyForTranscode();
      const cp = daemonCodecParams(fmt === 'auto' ? 'mp4' : fmt);
      const r = useDaemon
        ? await window.KapturaDaemon.transcodeViaDaemon(file, { targetMB, container: cp.container, codec: cp.codec, quality, onProgress, signal })
        : await window.KapturaCompressor.compressVideo(file, { targetMB, container: cp.container, quality, caps, onProgress });
      const name = `${baseName(file.name)}_COMPRESSED.${r.ext}`;
      await saveToVault({ blob: r.blob || null, remoteUrl: r.remoteUrl || null, name, mime: 'video/' + r.ext, durationSec: 'N/A', sizeBytes: r.sizeBytes || (r.blob ? r.blob.size : 0) });
      return { blob: r.blob, remoteUrl: r.remoteUrl, outputName: name };
    }
    const fmt = $('convFormat') ? $('convFormat').value : 'mp4';
    const cp = daemonCodecParams(fmt);
    const useDaemon = window.KapturaDaemon && window.KapturaDaemon.isReadyForTranscode();
    const r = useDaemon
      ? await window.KapturaDaemon.transcodeViaDaemon(file, { container: cp.container, codec: cp.codec, quality: $('convQuality') ? $('convQuality').value : 'max', onProgress, signal })
      : await window.KapturaTranscoder.transcode(file, { caps, container: cp.container, quality: $('convQuality') ? $('convQuality').value : 'max', onProgress });
    const name = `${baseName(file.name)}_CONVERTED.${r.ext}`;
    return { blob: r.blob, remoteUrl: r.remoteUrl, outputName: name };
  }

  if (batchQueue) {
    batchQueue.subscribe(renderBatchDock);
    if ($('btnBatchStart')) $('btnBatchStart').addEventListener('click', () => batchQueue.runAll(runBatchItem));
    if ($('btnBatchCancel')) $('btnBatchCancel').addEventListener('click', () => batchQueue.cancelAll());
    if ($('btnBatchClear')) $('btnBatchClear').addEventListener('click', () => batchQueue.clearDone());
  }

  /* ---- tabs ------------------------------------------------------------- */
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach((c) => c.classList.remove('active'));
      btn.classList.add('active');
      $(btn.dataset.tab).classList.add('active');
    });
  });

  /* ---- boot ------------------------------------------------------------- */
  applySvgMediaMode('video');
  applyConverterCodecLocks();
  updateBgReadiness(null);
  syncBgContextualControls();
  refreshVault();
  if (typeof navigator !== 'undefined' && navigator.serviceWorker && typeof location !== 'undefined' && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
  if (!caps.canMp4) toast('Este navegador no puede codificar MP4; se usará WebM real donde aplique.', 'notice', 8000);
})();
