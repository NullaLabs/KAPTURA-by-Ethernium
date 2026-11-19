/**
 * KAPTURA FORENSIC OPTICAL INSPECTOR (Interactive A/B Comparator v2.0)
 * True-resolution synchronized inspection for Images & Videos:
 *   - Modes: SPLIT A/B | Δ×8 HEATMAP | SIDE×SIDE
 *   - Optical Loupe Zoom: 1× / 2× / 4× / 8× (auto-engages 2× on spatial upscales)
 *   - Focal Pan + Video Frame-Step (-1f / +1f) + Live Sobel Edge Sharpness & Delta Metrics
 *   - Daemon :3370 Forensic Integrity Receipt (FPS drift, duration drift, audio preservation)
 */
(function (root) {
  'use strict';

  function clamp(v, lo, hi) {
    return v < lo ? lo : (v > hi ? hi : v);
  }

  function mediaDims(el, isVideo) {
    if (!el) return { w: 0, h: 0 };
    return isVideo
      ? { w: el.videoWidth || 0, h: el.videoHeight || 0 }
      : { w: el.naturalWidth || el.width || 0, h: el.naturalHeight || el.height || 0 };
  }

  function heatColor(val) {
    // 0..255 -> cybernetic obsidian -> electric cyan -> violet -> bright gold
    if (val < 64) {
      const t = val / 64;
      return [Math.round(6 * t), Math.round(28 + 140 * t), Math.round(48 + 190 * t)];
    }
    if (val < 160) {
      const t = (val - 64) / 96;
      return [Math.round(6 + 170 * t), Math.round(168 - 70 * t), Math.round(238 + 17 * t)];
    }
    const t = (val - 160) / 95;
    return [Math.round(176 + 79 * t), Math.round(98 + 135 * t), Math.round(255 - 175 * t)];
  }

  function computeSobelAndDelta(dataA, dataB, w, h, outHeatmapData) {
    let sumDiff = 0;
    let sobelA = 0;
    let sobelB = 0;
    const count = w * h;
    const lumA = new Float32Array(count);
    const lumB = new Float32Array(count);

    for (let i = 0, p = 0; i < count; i++, p += 4) {
      const rA = dataA[p], gA = dataA[p + 1], bA = dataA[p + 2];
      const rB = dataB[p], gB = dataB[p + 1], bB = dataB[p + 2];
      lumA[i] = 0.299 * rA + 0.587 * gA + 0.114 * bA;
      lumB[i] = 0.299 * rB + 0.587 * gB + 0.114 * bB;

      const d = (Math.abs(rA - rB) + Math.abs(gA - gB) + Math.abs(bA - bB)) / 3;
      sumDiff += d;
      if (outHeatmapData) {
        const boosted = clamp(Math.round(d * 8), 0, 255);
        const rgb = heatColor(boosted);
        outHeatmapData[p] = rgb[0];
        outHeatmapData[p + 1] = rgb[1];
        outHeatmapData[p + 2] = rgb[2];
        outHeatmapData[p + 3] = 255;
      }
    }

    let edgeSamples = 0;
    for (let y = 1; y < h - 1; y++) {
      const row = y * w;
      for (let x = 1; x < w - 1; x++) {
        const idx = row + x;
        const gxA = -lumA[idx - w - 1] + lumA[idx - w + 1] - 2 * lumA[idx - 1] + 2 * lumA[idx + 1] - lumA[idx + w - 1] + lumA[idx + w + 1];
        const gyA = -lumA[idx - w - 1] - 2 * lumA[idx - w] - lumA[idx - w + 1] + lumA[idx + w - 1] + 2 * lumA[idx + w] + lumA[idx + w + 1];
        const lapA = Math.abs(4 * lumA[idx] - lumA[idx - 1] - lumA[idx + 1] - lumA[idx - w] - lumA[idx + w]);
        const gxB = -lumB[idx - w - 1] + lumB[idx - w + 1] - 2 * lumB[idx - 1] + 2 * lumB[idx + 1] - lumB[idx + w - 1] + lumB[idx + w + 1];
        const gyB = -lumB[idx - w - 1] - 2 * lumB[idx - w] - lumB[idx - w + 1] + lumB[idx + w - 1] + 2 * lumB[idx + w] + lumB[idx + w + 1];
        const lapB = Math.abs(4 * lumB[idx] - lumB[idx - 1] - lumB[idx + 1] - lumB[idx - w] - lumB[idx + w]);
        sobelA += Math.sqrt(gxA * gxA + gyA * gyA) + lapA * 0.5;
        sobelB += Math.sqrt(gxB * gxB + gyB * gyB) + lapB * 0.5;
        edgeSamples++;
      }
    }

    const avgEdgeBefore = edgeSamples ? sobelA / edgeSamples : 0;
    const avgEdgeAfter = edgeSamples ? sobelB / edgeSamples : 0;
    const sharpnessGainPct = avgEdgeBefore > 0.5
      ? ((avgEdgeAfter - avgEdgeBefore) / avgEdgeBefore) * 100
      : 0;

    return {
      meanDelta: count ? sumDiff / count : 0,
      avgEdgeBefore,
      avgEdgeAfter,
      sharpnessGainPct,
    };
  }

  function render(container, opts) {
    if (!container) return;
    if (typeof container._kapturaDispose === 'function') {
      container._kapturaDispose();
      container._kapturaDispose = null;
    }

    opts = opts || {};
    const {
      beforeSrc,
      afterSrc,
      isVideo = false,
      beforeLabel = 'ORIGINAL',
      afterLabel = 'PROCESSED',
      integrity = null,
      engineLabel = '',
      isRife = false,
    } = opts;

    if (!beforeSrc || !afterSrc) {
      container.innerHTML = '';
      container.style.display = 'none';
      return;
    }

    container.style.display = 'block';
    container.innerHTML = '';

    const state = {
      mode: 'split',      // 'split' | 'heatmap' | 'side'
      zoom: 1,            // 1 | 2 | 4 | 8
      autoZoomApplied: false,
      splitRatio: 0.5,
      focalX: 0.5,
      focalY: 0.5,
      rafId: 0,
      destroyed: false,
      lastMetricAt: 0,
      dragging: null,     // 'split' | 'pan' | null
      dragStartX: 0,
      dragStartY: 0,
      dragStartFx: 0.5,
      dragStartFy: 0.5,
    };

    const shell = document.createElement('div');
    shell.className = 'inspector-shell';

    // ---- Top Toolbar -------------------------------------------------------
    const toolbar = document.createElement('div');
    toolbar.className = 'inspector-toolbar';

    const modeGroup = document.createElement('div');
    modeGroup.className = 'inspector-pill-group';
    const modes = [
      { id: 'split', label: 'SPLIT A/B' },
      { id: 'heatmap', label: 'Δ ×8 HEATMAP' },
      { id: 'side', label: 'SIDE×SIDE' },
    ];
    const modeBtns = {};
    modes.forEach((m) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `inspector-pill${m.id === state.mode ? ' active' : ''}`;
      b.textContent = m.label;
      b.addEventListener('click', () => {
        state.mode = m.id;
        Object.entries(modeBtns).forEach(([k, btn]) => btn.classList.toggle('active', k === state.mode));
        divider.style.display = state.mode === 'split' ? 'block' : 'none';
        drawFrame(true);
      });
      modeBtns[m.id] = b;
      modeGroup.appendChild(b);
    });

    const zoomGroup = document.createElement('div');
    zoomGroup.className = 'inspector-pill-group';
    const zoomBtns = {};
    [1, 2, 4, 8].forEach((z) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `inspector-pill${z === state.zoom ? ' active' : ''}`;
      b.textContent = `${z}×`;
      b.title = `Zoom óptico ${z}× en región focal`;
      b.addEventListener('click', () => setZoom(z));
      zoomBtns[z] = b;
      zoomGroup.appendChild(b);
    });

    toolbar.appendChild(modeGroup);
    toolbar.appendChild(zoomGroup);

    let playBtn = null;
    if (isVideo) {
      const transport = document.createElement('div');
      transport.className = 'inspector-pill-group';

      playBtn = document.createElement('button');
      playBtn.type = 'button';
      playBtn.className = 'inspector-pill';
      playBtn.textContent = '⏸ PAUSA';

      const stepBack = document.createElement('button');
      stepBack.type = 'button';
      stepBack.className = 'inspector-pill';
      stepBack.textContent = '◀ -1f';

      const stepFwd = document.createElement('button');
      stepFwd.type = 'button';
      stepFwd.className = 'inspector-pill';
      stepFwd.textContent = '+1f ▶';

      transport.appendChild(stepBack);
      transport.appendChild(playBtn);
      transport.appendChild(stepFwd);
      toolbar.appendChild(transport);

      playBtn.addEventListener('click', () => {
        if (beforeEl.paused) {
          beforeEl.play().catch(() => {});
          afterEl.currentTime = beforeEl.currentTime;
          afterEl.play().catch(() => {});
          playBtn.textContent = '⏸ PAUSA';
          scheduleLoop();
        } else {
          beforeEl.pause();
          afterEl.pause();
          playBtn.textContent = '▶ PLAY';
          stopLoop();
          drawFrame(true);
        }
      });

      const stepVideo = (deltaFrames) => {
        beforeEl.pause();
        afterEl.pause();
        if (playBtn) playBtn.textContent = '▶ PLAY';
        stopLoop();
        const fpsHint = (integrity && integrity.srcFps) || 30;
        const targetTime = clamp((beforeEl.currentTime || 0) + deltaFrames / fpsHint, 0, Math.max(0, (beforeEl.duration || 10) - 0.01));
        beforeEl.currentTime = targetTime;
        afterEl.currentTime = targetTime;
      };
      stepBack.addEventListener('click', () => stepVideo(-1));
      stepFwd.addEventListener('click', () => stepVideo(1));
    }

    // ---- Viewport Canvas ---------------------------------------------------
    const wrap = document.createElement('div');
    wrap.className = 'compare-wrap';

    const canvas = document.createElement('canvas');
    canvas.className = 'compare-canvas';
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    const tagLeft = document.createElement('div');
    tagLeft.className = 'compare-tag left';
    tagLeft.textContent = beforeLabel;

    const tagRight = document.createElement('div');
    tagRight.className = 'compare-tag right';
    tagRight.textContent = afterLabel;

    const divider = document.createElement('div');
    divider.className = 'compare-divider';
    divider.innerHTML = '<span class="compare-knob">↔</span>';

    // Accessible range slider synced with splitRatio (supports keyboard & assistive tech)
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0';
    slider.max = '100';
    slider.value = '50';
    slider.id = 'upskaletorCompareSlider';
    slider.className = 'compare-slider-bar';
    slider.setAttribute('aria-label', 'Deslizador A/B Antes y Después');

    // Offscreen scratch buffers
    const offB = document.createElement('canvas');
    const offA = document.createElement('canvas');
    const ctxB = offB.getContext('2d', { willReadFrequently: true });
    const ctxA = offA.getContext('2d', { willReadFrequently: true });
    const metricB = document.createElement('canvas');
    const metricA = document.createElement('canvas');
    const heatCanvas = document.createElement('canvas');
    const mCtxB = metricB.getContext('2d', { willReadFrequently: true });
    const mCtxA = metricA.getContext('2d', { willReadFrequently: true });
    const hCtx = heatCanvas.getContext('2d');

    wrap.appendChild(canvas);
    wrap.appendChild(divider);
    wrap.appendChild(tagLeft);
    wrap.appendChild(tagRight);

    // ---- Forensic Proof Footer Strip --------------------------------------
    const proofBar = document.createElement('div');
    proofBar.className = 'inspector-proof-bar';
    const badgeRes = document.createElement('span');
    badgeRes.className = 'proof-pill';
    badgeRes.textContent = 'CARGANDO DIMENSIONES…';
    const badgeSharp = document.createElement('span');
    badgeSharp.className = 'proof-pill';
    badgeSharp.textContent = 'SOBEL NITIDEZ: --';
    const badgeDelta = document.createElement('span');
    badgeDelta.className = 'proof-pill';
    badgeDelta.textContent = 'Δ PIXEL: --';
    proofBar.appendChild(badgeRes);
    proofBar.appendChild(badgeSharp);
    proofBar.appendChild(badgeDelta);

    const extraPills = [];
    if (engineLabel) extraPills.push(`MOTOR: ${engineLabel}`);
    if (integrity) {
      if (integrity.srcFps && integrity.outFps) {
        extraPills.push(`FPS: ${integrity.srcFps} → ${integrity.outFps} (${integrity.fpsDriftPct}% drift)`);
      }
      if (integrity.durationDriftMs !== undefined) {
        extraPills.push(`DRIFT: ${integrity.durationDriftMs} ms`);
      }
      if (integrity.audioPreserved !== null && integrity.audioPreserved !== undefined) {
        extraPills.push(integrity.audioPreserved ? `AUDIO: ${(integrity.audioCodec || 'AAC').toUpperCase()} OK` : 'AUDIO: SIN PISTA');
      }
      if (integrity.elapsedMs) {
        extraPills.push(`GPU: ${(integrity.elapsedMs / 1000).toFixed(2)}s`);
      }
    }
    extraPills.forEach((txt) => {
      const p = document.createElement('span');
      p.className = 'proof-pill proof-pill-accent';
      p.textContent = txt;
      proofBar.appendChild(p);
    });

    const noticeBanner = document.createElement('div');
    noticeBanner.className = 'inspector-notice';
    noticeBanner.style.display = 'none';

    shell.appendChild(toolbar);
    shell.appendChild(wrap);
    shell.appendChild(slider);
    shell.appendChild(proofBar);
    shell.appendChild(noticeBanner);
    container.appendChild(shell);

    // ---- Media Elements ----------------------------------------------------
    let beforeEl, afterEl;
    if (isVideo) {
      beforeEl = document.createElement('video');
      afterEl = document.createElement('video');
      [beforeEl, afterEl].forEach((v) => {
        v.muted = true;
        v.loop = true;
        v.playsInline = true;
        v.autoplay = true;
        v.crossOrigin = 'anonymous';
        v.preload = 'auto';
      });
    } else {
      beforeEl = document.createElement('img');
      afterEl = document.createElement('img');
      beforeEl.crossOrigin = 'anonymous';
      afterEl.crossOrigin = 'anonymous';
    }

    function setZoom(z) {
      state.zoom = clamp(Number(z) || 1, 1, 8);
      Object.entries(zoomBtns).forEach(([k, btn]) => btn.classList.toggle('active', Number(k) === state.zoom));
      const halfSpan = 0.5 / state.zoom;
      state.focalX = clamp(state.focalX, halfSpan, 1 - halfSpan);
      state.focalY = clamp(state.focalY, halfSpan, 1 - halfSpan);
      wrap.classList.toggle('can-pan', state.zoom > 1);
      drawFrame(true);
    }

    function updateLabelsWithDims(dB, dA) {
      if (dB.w && dA.w) {
        wrap.style.aspectRatio = `${dB.w} / ${dB.h}`;
        tagLeft.textContent = beforeLabel.includes(String(dB.w)) ? beforeLabel : `${beforeLabel} · ${dB.w}×${dB.h}`;
        tagRight.textContent = afterLabel.includes(String(dA.w)) ? afterLabel : `${afterLabel} · ${dA.w}×${dA.h}`;
        const pxMult = ((dA.w * dA.h) / Math.max(1, dB.w * dB.h)).toFixed(2);
        badgeRes.textContent = `${dB.w}×${dB.h} → ${dA.w}×${dA.h} (${pxMult}× px)`;

        if (!state.autoZoomApplied) {
          state.autoZoomApplied = true;
          if (dA.w > dB.w) {
            setZoom(2);
          } else if (dB.w >= dA.w && !isRife) {
            noticeBanner.style.display = 'block';
            noticeBanner.textContent = `ℹ El origen ya es ${dB.w}×${dB.h} (≥ destino ${dA.w}×${dA.h}). Usa zoom 4×/8× o Δ×8 HEATMAP para inspeccionar filtrado CAS/detalles; para máxima ganancia espacial, prueba un vídeo 720p/360p → 4K.`;
          }
        }
      }
    }

    function drawCrop(targetCtx, el, dims, W, H) {
      const mw = dims.w;
      const mh = dims.h;
      if (!mw || !mh) return;
      const z = state.zoom;
      const sw = mw / z;
      const sh = mh / z;
      const sx = clamp(state.focalX * mw - sw / 2, 0, Math.max(0, mw - sw));
      const sy = clamp(state.focalY * mh - sh / 2, 0, Math.max(0, mh - sh));
      targetCtx.clearRect(0, 0, W, H);
      targetCtx.imageSmoothingEnabled = true;
      targetCtx.imageSmoothingQuality = 'high';
      targetCtx.drawImage(el, sx, sy, sw, sh, 0, 0, W, H);
    }

    function ensureCanvasDims() {
      const rect = wrap.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const cssW = Math.max(320, Math.round(rect.width || 720));
      const cssH = Math.max(180, Math.round((cssW * 9) / 16));
      const W = Math.round(cssW * dpr);
      const H = Math.round(cssH * dpr);
      if (canvas.width !== W || canvas.height !== H) {
        canvas.width = W;
        canvas.height = H;
        offB.width = W;
        offB.height = H;
        offA.width = W;
        offA.height = H;
      }
      return { W, H };
    }

    function drawFrame(forceMetrics) {
      if (state.destroyed) return;
      const dB = mediaDims(beforeEl, isVideo);
      const dA = mediaDims(afterEl, isVideo);
      if (!dB.w || !dA.w) return;
      if (isVideo && (beforeEl.readyState < 2 || afterEl.readyState < 2)) return;

      updateLabelsWithDims(dB, dA);
      const { W, H } = ensureCanvasDims();

      drawCrop(ctxB, beforeEl, dB, W, H);
      drawCrop(ctxA, afterEl, dA, W, H);

      const now = performance.now();
      const needMetrics = forceMetrics || state.mode === 'heatmap' || (now - state.lastMetricAt > 280);

      let heatmapReady = false;
      if (needMetrics) {
        state.lastMetricAt = now;
        const mw = Math.min(320, W);
        const mh = Math.max(2, Math.round((mw * H) / W));
        if (metricB.width !== mw || metricB.height !== mh) {
          metricB.width = mw; metricB.height = mh;
          metricA.width = mw; metricA.height = mh;
          heatCanvas.width = mw; heatCanvas.height = mh;
        }
        mCtxB.drawImage(offB, 0, 0, mw, mh);
        mCtxA.drawImage(offA, 0, 0, mw, mh);
        try {
          const imgB = mCtxB.getImageData(0, 0, mw, mh);
          const imgA = mCtxA.getImageData(0, 0, mw, mh);
          const heatOut = state.mode === 'heatmap' ? hCtx.createImageData(mw, mh) : null;
          const m = computeSobelAndDelta(imgB.data, imgA.data, mw, mh, heatOut ? heatOut.data : null);
          if (heatOut) {
            hCtx.putImageData(heatOut, 0, 0);
            heatmapReady = true;
          }
          const sign = m.sharpnessGainPct >= 0 ? '+' : '';
          badgeSharp.textContent = `SOBEL NITIDEZ: ${sign}${m.sharpnessGainPct.toFixed(1)}%`;
          badgeSharp.classList.toggle('is-gain', m.sharpnessGainPct > 1.5);
          badgeDelta.textContent = `Δ PIXEL: ${m.meanDelta.toFixed(2)}/255`;
        } catch {
          badgeSharp.textContent = 'SOBEL: CORS RESTRICTED';
          badgeDelta.textContent = 'Δ PIXEL: CORS';
        }
      }

      ctx.clearRect(0, 0, W, H);
      if (state.mode === 'heatmap' && heatmapReady) {
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(heatCanvas, 0, 0, W, H);
      } else if (state.mode === 'side') {
        const halfW = Math.floor(W / 2);
        const sx = Math.floor(W * 0.25);
        ctx.drawImage(offB, sx, 0, halfW, H, 0, 0, halfW, H);
        ctx.drawImage(offA, sx, 0, halfW, H, halfW, 0, W - halfW, H);
        ctx.fillStyle = 'rgba(0, 240, 255, 0.85)';
        ctx.fillRect(halfW - 1, 0, 2, H);
      } else {
        const splitX = Math.round(W * state.splitRatio);
        if (splitX > 0) ctx.drawImage(offB, 0, 0, splitX, H, 0, 0, splitX, H);
        if (W - splitX > 0) ctx.drawImage(offA, splitX, 0, W - splitX, H, splitX, 0, W - splitX, H);
        divider.style.left = `${(state.splitRatio * 100).toFixed(2)}%`;
      }
    }

    function scheduleLoop() {
      if (state.destroyed || state.rafId) return;
      const tick = () => {
        state.rafId = 0;
        if (state.destroyed) return;
        if (isVideo && !beforeEl.paused) {
          if (Math.abs(beforeEl.currentTime - afterEl.currentTime) > 0.045) {
            try { afterEl.currentTime = beforeEl.currentTime; } catch {}
          }
          drawFrame(false);
          state.rafId = requestAnimationFrame(tick);
        } else {
          drawFrame(true);
        }
      };
      state.rafId = requestAnimationFrame(tick);
    }

    function stopLoop() {
      if (state.rafId) {
        cancelAnimationFrame(state.rafId);
        state.rafId = 0;
      }
    }

    // ---- Pointer & Slider Interactions -------------------------------------
    function updateSplit(ratio) {
      state.splitRatio = clamp(ratio, 0.02, 0.98);
      slider.value = String(Math.round(state.splitRatio * 100));
      divider.style.left = `${(state.splitRatio * 100).toFixed(2)}%`;
      drawFrame(false);
    }

    slider.addEventListener('input', (e) => {
      updateSplit(Number(e.target.value) / 100);
    });

    wrap.addEventListener('pointerdown', (e) => {
      const rect = wrap.getBoundingClientRect();
      const relX = (e.clientX - rect.left) / Math.max(1, rect.width);
      const nearSplit = state.mode === 'split' && Math.abs(e.clientX - (rect.left + rect.width * state.splitRatio)) <= 18;
      if (nearSplit || state.zoom === 1) {
        state.dragging = state.mode === 'split' ? 'split' : null;
        if (state.dragging === 'split') updateSplit(relX);
      } else {
        state.dragging = 'pan';
        state.dragStartX = e.clientX;
        state.dragStartY = e.clientY;
        state.dragStartFx = state.focalX;
        state.dragStartFy = state.focalY;
        wrap.classList.add('is-grabbing');
      }
      try { wrap.setPointerCapture(e.pointerId); } catch {}
    });

    wrap.addEventListener('pointermove', (e) => {
      const rect = wrap.getBoundingClientRect();
      if (!state.dragging) {
        const nearSplit = state.mode === 'split' && Math.abs(e.clientX - (rect.left + rect.width * state.splitRatio)) <= 16;
        wrap.style.cursor = nearSplit ? 'ew-resize' : (state.zoom > 1 ? 'grab' : 'ew-resize');
        return;
      }
      if (state.dragging === 'split') {
        updateSplit((e.clientX - rect.left) / Math.max(1, rect.width));
      } else if (state.dragging === 'pan') {
        const dx = (e.clientX - state.dragStartX) / Math.max(1, rect.width * state.zoom);
        const dy = (e.clientY - state.dragStartY) / Math.max(1, rect.height * state.zoom);
        const halfSpan = 0.5 / state.zoom;
        state.focalX = clamp(state.dragStartFx - dx, halfSpan, 1 - halfSpan);
        state.focalY = clamp(state.dragStartFy - dy, halfSpan, 1 - halfSpan);
        drawFrame(true);
      }
    });

    const endDrag = (e) => {
      state.dragging = null;
      wrap.classList.remove('is-grabbing');
      try { wrap.releasePointerCapture(e.pointerId); } catch {}
    };
    wrap.addEventListener('pointerup', endDrag);
    wrap.addEventListener('pointercancel', endDrag);

    // ---- Load Media & Attach Sync Events -----------------------------------
    if (isVideo) {
      const tryStart = () => {
        if (state.destroyed) return;
        drawFrame(true);
        if (beforeEl.readyState >= 2 && afterEl.readyState >= 2) {
          beforeEl.play().catch(() => {});
          afterEl.play().catch(() => {});
          scheduleLoop();
        }
      };
      beforeEl.addEventListener('loadeddata', tryStart);
      afterEl.addEventListener('loadeddata', tryStart);
      beforeEl.addEventListener('seeked', () => drawFrame(true));
      afterEl.addEventListener('seeked', () => drawFrame(true));
      beforeEl.src = beforeSrc;
      afterEl.src = afterSrc;
    } else {
      const onImgReady = () => {
        if (beforeEl.complete && afterEl.complete) drawFrame(true);
      };
      beforeEl.addEventListener('load', onImgReady);
      afterEl.addEventListener('load', onImgReady);
      beforeEl.src = beforeSrc;
      afterEl.src = afterSrc;
    }

    const onResize = () => drawFrame(true);
    window.addEventListener('resize', onResize);

    container._kapturaDispose = () => {
      state.destroyed = true;
      stopLoop();
      window.removeEventListener('resize', onResize);
      if (isVideo) {
        try { beforeEl.pause(); afterEl.pause(); } catch {}
      }
      beforeEl.src = '';
      afterEl.src = '';
    };
  }

  const api = { render, computeSobelAndDelta };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.KapturaComparator = api;
})(typeof self !== 'undefined' ? self : this);
