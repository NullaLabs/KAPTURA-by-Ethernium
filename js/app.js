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
      });
    }
  })();

  /* ---- Vault (data layer in js/vault.js; URLs owned here) ---------------- */
  const Vault = window.KapturaVault;
  let vaultUrls = [];
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
    let items = [];
    try { items = await Vault.getAll(); }
    catch (e) { toast(e.message, 'error'); }
    $('vault-count').textContent = items.length;
    const grid = $('vaultGrid');
    releaseVaultUrls();
    if (!items.length) {
      grid.innerHTML = `<div style="grid-column:1/-1; text-align:center; padding:40px; color:var(--dim); font-family:'Fira Code', monospace">
        No recordings saved in vault yet. Record a video to store it automatically!</div>`;
      return;
    }
    grid.innerHTML = items.map((item) => {
      const media = Vault.getRecordMediaSrc(item);
      if (item.blob instanceof Blob && media.src) vaultUrls.push(media.src);
      const isImg = item.type && item.type.startsWith('image/');
      const thumbHtml = isImg
        ? `<img class="vault-thumb" src="${media.src}" alt="${escapeHtml(item.name)}" style="object-fit:contain; background:#050811">`
        : `<video class="vault-thumb" src="${media.src}" controls preload="metadata"></video>`;
      const tag = item.remoteUrl ? 'DISK :3370' : 'INDEXEDDB';
      return `
        <div class="vault-card">
          ${thumbHtml}
          <div class="vault-title">${escapeHtml(item.name)}</div>
          <div class="vault-info">📅 ${escapeHtml(item.timestamp)} · 💾 ${escapeHtml(item.size)} · ⏱️ ${escapeHtml(item.duration)} · ${tag}</div>
          <div class="vault-actions">
            ${!isImg ? `<button class="vault-btn" data-stage="${item.id}">🎬 STAGE</button>` : ''}
            <a class="vault-btn" href="${media.src}" download="${escapeHtml(item.name)}">💾 DOWNLOAD</a>
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
    grid.querySelectorAll('[data-del]').forEach((b) => {
      b.addEventListener('click', async () => {
        try { await Vault.remove(Number(b.dataset.del)); await refreshVault(); }
        catch (e) { toast(e.message, 'error'); }
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
    try { await Vault.clear(); await refreshVault(); toast('Vault cleared.', 'success'); }
    catch (e) { toast(e.message, 'error'); }
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
      refreshCompressorEstimate(m);
    }));
  }
  if ($('btnSendToConverter')) {
    $('btnSendToConverter').addEventListener('click', () => handoffStageToTab('tab-converter', (m) => {
      convFile = m;
      $('dropzone').querySelector('.dz-title').textContent = `STAGE MASTER: ${m.name}`;
      $('dropzone').querySelector('.dz-sub').textContent = `${(m.sizeBytes / (1024 * 1024)).toFixed(2)} MB · Range ${m.trimStart.toFixed(1)}s–${m.trimEnd.toFixed(1)}s`;
    }));
  }
  if ($('btnSendToUpskaletor')) {
    $('btnSendToUpskaletor').addEventListener('click', () => handoffStageToTab('tab-upskaletor', (m) => {
      upFile = m;
      $('upskaletorDzTitle').textContent = `STAGE MASTER: ${m.name}`;
      $('upskaletorDzSub').textContent = `${(m.sizeBytes / (1024 * 1024)).toFixed(2)} MB · Listo desde Stage`;
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
        let r;
        if (useDaemon) {
          try {
            const daemonSrc = lastMaster.remoteUrl
              ? { remoteUrl: lastMaster.remoteUrl, name: lastMaster.name }
              : await ensureRealFile(lastMaster);
            r = await window.KapturaDaemon.transcodeViaDaemon(daemonSrc, {
              container: fmt, quality: 'fast', ...trimOpts,
              onProgress: (p, m) => { readout.textContent = `GPU :3370 ${fmt.toUpperCase()}: ${Math.round(p * 100)}%${m && m.speed ? ' · ' + m.speed : ''}`; },
            });
          } catch {
            const f = await ensureRealFile(lastMaster);
            r = await window.KapturaTranscoder.transcode(f, {
              caps, container: fmt, quality: 'fast', ...trimOpts,
              onProgress: (p) => { readout.textContent = `${fmt.toUpperCase()}: ${Math.round(p * 100)}%`; },
            });
          }
        } else {
          const f = await ensureRealFile(lastMaster);
          r = await window.KapturaTranscoder.transcode(f, {
            caps, container: fmt, quality: 'fast', ...trimOpts,
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
  wireDropzone('dropzone', 'fileInput', (f) => {
    convFile = f;
    $('dropzone').querySelector('.dz-title').textContent = `SELECTED: ${f.name}`;
    $('dropzone').querySelector('.dz-sub').textContent = `${(f.size / (1024 * 1024)).toFixed(2)} MB · ${f.type || 'video'}`;
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
        let r;
        if (useDaemon) {
          try {
            const daemonSrc = activeSrc.remoteUrl
              ? { remoteUrl: activeSrc.remoteUrl, name: activeSrc.name }
              : await ensureRealFile(activeSrc);
            r = await window.KapturaDaemon.transcodeViaDaemon(daemonSrc, {
              container: fmt, quality, ...dims, ...trimOpts,
              onProgress: (p, m) => { setProgress('progressBarBg', 'progressBarFill', p); status.textContent = `GPU :3370 ${Math.round(p * 100)}%${m && m.speed ? ' · ' + m.speed : ''}`; },
            });
          } catch {
            const f = await ensureRealFile(activeSrc);
            r = await window.KapturaTranscoder.transcode(f, {
              caps, container: fmt, quality, ...dims, ...trimOpts,
              onProgress: (p) => { setProgress('progressBarBg', 'progressBarFill', p); status.textContent = `${fmt.toUpperCase()} ${Math.round(p * 100)}%`; },
            });
          }
        } else {
          const f = await ensureRealFile(activeSrc);
          r = await window.KapturaTranscoder.transcode(f, {
            caps, container: fmt, quality, ...dims, ...trimOpts,
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

  wireDropzone('compressorDropzone', 'compressorFileInput', (f) => {
    compFile = f;
    const isImg = window.KapturaSVGVector ? window.KapturaSVGVector.isImageFile(f) : f.type.startsWith('image/');
    $('compressorDzTitle').textContent = `SELECTED: ${f.name}`;
    $('compressorDzSub').textContent = `${(f.size / (1024 * 1024)).toFixed(2)} MB · ${isImg ? 'Imagen' : 'Vídeo'} original`;
    refreshCompressorEstimate(f);
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
            const daemonSrc = activeSrc.remoteUrl
              ? { remoteUrl: activeSrc.remoteUrl, name: srcName }
              : await ensureRealFile(activeSrc);
            const dr = await window.KapturaDaemon.transcodeViaDaemon(daemonSrc, {
              targetMB,
              container: fmt === 'auto' ? 'mp4' : fmt,
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
              container: fmt === 'auto' ? 'mp4' : fmt,
              quality,
              caps,
              onProgress: (p) => { setProgress('compressorProgressBarBg', 'compressorProgressBarFill', p); status.textContent = `Comprimiendo ${Math.round(p * 100)}%…`; },
            });
          }
        } else {
          const fileObj = await ensureRealFile(activeSrc);
          r = await window.KapturaCompressor.compressVideo(fileObj, {
            targetMB,
            container: fmt === 'auto' ? 'mp4' : fmt,
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
  let upFile = null, upBeforeRevoke = null, upAfterRevoke = null, upResultBlob = null;
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

  wireDropzone('upskaletorDropzone', 'upskaletorFileInput', (f) => {
    upFile = f;
    const isImg = window.KapturaUpskaletor.isImageFile(f);
    $('upskaletorDzTitle').textContent = `SELECTED: ${f.name}`;
    $('upskaletorDzSub').textContent = `${(f.size / (1024 * 1024)).toFixed(2)} MB · ${isImg ? 'Imagen' : (f.type || 'video')}`;
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

  $('btnUpscaleNow').addEventListener('click', async () => {
    const activeSrc = upFile || lastMaster;
    if (!activeSrc) { toast('Arrastra un vídeo o imagen primero.', 'error'); return; }
    const profile = $('upskaletorProfileSelect').value;
    const engine = $('upskaletorEngineSelect').value;
    const status = $('upskaletorStatus');
    const cancelBtn = $('btnCancelUpscale');
    activeUpscaleTaskId = `up_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    activeUpscaleCtrl = typeof AbortController === 'function' ? new AbortController() : null;
    $('btnUpscaleNow').disabled = true;
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
          status.textContent = `Procesando ${Math.round(p * 100)}%${stageTag}${modelTag}${segTag}${frameTag}${spfTag}${speedTag}${etaTag}…`;
        },
      });
      if (result.mode === 'handoff') {
        // Honest: do NOT fake AI. Hand off the untouched master + real command.
        upResultBlob = fileObj;
        try { await navigator.clipboard.writeText(result.command); } catch { /* clipboard optional */ }
        downloadBlob(fileObj, fileObj.name);
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
        const name = `${baseName(fileObj.name)}_UPSKALED_${resTag}.${result.ext}`;
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
          $('upskaletorReadout').textContent = `ARCHIVO LISTO: ${name} · ${sizeMB} MB · Motor: ${result.scaleMode}${itText}`;
        }
        if ($('upskaletorResult')) $('upskaletorResult').style.display = 'block';
        if (window.KapturaComparator && $('upskaletorCompareBox')) {
          const bSrc = mediaPreviewSrc(activeSrc);
          const aSrc = mediaPreviewSrc(result.blob || result);
          upBeforeRevoke = bSrc.revoke;
          upAfterRevoke = aSrc.revoke;
          window.KapturaComparator.render($('upskaletorCompareBox'), {
            beforeSrc: bSrc.url,
            afterSrc: aSrc.url,
            isVideo: !result.isImage,
            beforeLabel: 'ORIGINAL',
            afterLabel: result.pipeline === 'rife' ? 'RIFE 2× FPS' : 'UPSKALED',
            integrity: result.integrity || null,
            engineLabel: result.scaleMode || '',
            isRife: result.pipeline === 'rife' || result.pipeline === 'hybrid',
          });
        }
        const autoDl = !skipNextAutoDownload;
        skipNextAutoDownload = false;
        if (autoDl) downloadBlob(outTarget, name);
        await saveToVault({ blob: result.blob || null, remoteUrl: result.remoteUrl || null, name, mime: (result.isImage ? 'image/' : 'video/') + result.ext, durationSec: 'N/A', sizeBytes: outSizeBytes });
        if (result.fellBack) toast('MP4 no disponible; guardado WebM real.', 'notice');
        status.textContent = `✅ Proceso real ${labelTag || resTag} (${result.scaleMode}).`;
        toast(`Proceso real ${result.isImage ? 'de imagen' : 'de vídeo'} completado y guardado en la Bóveda.`, 'success');
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
      if ($('btnCancelUpscale')) $('btnCancelUpscale').style.display = 'none';
      setTimeout(() => setProgress('upskaletorProgressBarBg', 'upskaletorProgressBarFill', 0), 800);
    }
  });

  $('btnCopyCmd').addEventListener('click', async () => {
    const file = upFile || (lastMaster && { name: lastMaster.name }) || { name: 'kaptura_master.mp4' };
    const cmd = window.KapturaUpskaletor.command(file.name, $('upskaletorProfileSelect').value, $('upskaletorEngineSelect').value);
    try { await navigator.clipboard.writeText(cmd); toast('Comando copiado al portapapeles.', 'success'); }
    catch { window.prompt('Copia el comando de UPSKALETOR:', cmd); }
  });

  /* ---- Cinema GIF (real native GIF89a) ---------------------------------- */
  let cinemaFile = null, cinemaPreviewUrl = null;
  wireDropzone('cinemaDropzone', 'cinemaFileInput', (f) => {
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
    svgFile = f; $('svgSource').value = 'file';
    const isImg = window.KapturaSVGVector ? window.KapturaSVGVector.isImageFile(f) : false;
    $('svgDzTitle').textContent = `SELECTED: ${f.name}`;
    $('svgDzSub').textContent = `${(f.size / (1024 * 1024)).toFixed(2)} MB · ${isImg ? 'Imagen para Vectorizar' : 'Vídeo para SVG animado'}`;
  });
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
  function wireDropzone(zoneId, inputId, onFile) {
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
      const f = e.target.files[0];
      if (!f) return;
      const rect = zone.getBoundingClientRect();
      const x = lastClick ? lastClick.x : (rect.left + rect.width * 0.5);
      const y = lastClick ? lastClick.y : (rect.top + rect.height * 0.5);
      triggerDropSplash(x, y, zone, 0.92);
      onFile(f);
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
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (!f) return;
      const rect = zone.getBoundingClientRect();
      const dropX = Number.isFinite(e.clientX) && e.clientX > 0 ? e.clientX : (rect.left + rect.width * 0.5);
      const dropY = Number.isFinite(e.clientY) && e.clientY > 0 ? e.clientY : (rect.top + rect.height * 0.5);
      triggerDropSplash(dropX, dropY, zone, 1.0);
      onFile(f);
    });
  }
  function baseName(n) { const i = n.lastIndexOf('.'); return i > 0 ? n.substring(0, i) : n; }

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
  refreshVault();
  if (!caps.canMp4) toast('Este navegador no puede codificar MP4; se usará WebM real donde aplique.', 'notice', 8000);
})();
