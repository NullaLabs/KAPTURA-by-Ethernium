/*
 * ============================================================================
 * KAPTURA · Matte Brush (Surgical alpha retouch for BG STUDIO)
 * ============================================================================
 * Pixel-exact restore / erase brush over the real cutout PNG:
 *  - "+ RESTAURAR" brings back original pixels (RGB + alpha) under the brush.
 *  - "- BORRAR" removes alpha under the brush.
 *  - "BORDE INTELIGENTE" modulates the brush by colour similarity to the brush
 *    centre, so strokes hug real edges (hair, fur, product contours).
 *  - Views: checkerboard composite, pure alpha mask, over black, over white.
 *  - 400% magnifier loupe, undo / redo, [ ] brush size, X toggles mode.
 * Pure canvas 2D, dirty-rect rendering, zero dependencies, zero network.
 * ----------------------------------------------------------------------------
 */
(function (root) {
  'use strict';

  const LOUPE_SIZE = 168;
  const LOUPE_ZOOM = 4;

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('No se pudo cargar la imagen para el retoque.'));
      img.src = src;
    });
  }

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  /** Radial brush falloff: 1 inside hardness core, smoothstep to 0 at the radius. */
  function brushFalloff(dist, radius, hardness) {
    if (dist >= radius) return 0;
    const core = radius * clamp(hardness, 0, 0.98);
    if (dist <= core) return 1;
    const t = (dist - core) / Math.max(1e-6, radius - core);
    return 1 - t * t * (3 - 2 * t);
  }

  /** Colour-similarity factor (0..1) used by the edge-aware brush. */
  function edgeFactor(r, g, b, cr, cg, cb) {
    const d = Math.sqrt((r - cr) * (r - cr) + (g - cg) * (g - cg) + (b - cb) * (b - cb)) / 441.67;
    return clamp(1 - (d - 0.08) / 0.22, 0, 1);
  }

  /**
   * Apply one brush stamp in-place.
   * @param {Uint8ClampedArray} work  RGBA of the cutout being edited
   * @param {Uint8ClampedArray} orig  RGBA of the original (unmatted) image
   */
  function stamp(work, orig, w, h, cx, cy, opts) {
    const radius = Math.max(1, opts.radius);
    const x0 = Math.max(0, Math.floor(cx - radius));
    const y0 = Math.max(0, Math.floor(cy - radius));
    const x1 = Math.min(w - 1, Math.ceil(cx + radius));
    const y1 = Math.min(h - 1, Math.ceil(cy + radius));
    const flow = clamp(opts.flow == null ? 0.85 : opts.flow, 0.05, 1);
    const ci = (clamp(Math.round(cy), 0, h - 1) * w + clamp(Math.round(cx), 0, w - 1)) * 4;
    const cr = orig[ci], cg = orig[ci + 1], cb = orig[ci + 2];
    for (let y = y0; y <= y1; y++) {
      const dy = y + 0.5 - cy;
      for (let x = x0; x <= x1; x++) {
        const dx = x + 0.5 - cx;
        let f = brushFalloff(Math.sqrt(dx * dx + dy * dy), radius, opts.hardness) * flow;
        if (f <= 0) continue;
        const i = (y * w + x) * 4;
        if (opts.edgeAware) f *= edgeFactor(orig[i], orig[i + 1], orig[i + 2], cr, cg, cb);
        if (f <= 0) continue;
        if (opts.mode === 'restore') {
          const a = work[i + 3] / 255;
          const target = Math.max(a, f);
          if (target > a) {
            const mix = f;
            work[i] = work[i] + (orig[i] - work[i]) * mix;
            work[i + 1] = work[i + 1] + (orig[i + 1] - work[i + 1]) * mix;
            work[i + 2] = work[i + 2] + (orig[i + 2] - work[i + 2]) * mix;
            work[i + 3] = Math.round(target * 255);
          }
        } else {
          work[i + 3] = Math.round(work[i + 3] * (1 - f));
        }
      }
    }
    return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  }

  function unionRect(a, b) {
    if (!a) return b;
    if (!b) return a;
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
  }

  async function open(panel, opts) {
    if (!panel) throw new Error('Panel de retoque no encontrado.');
    opts = opts || {};
    const [origImg, resImg] = await Promise.all([loadImage(opts.originalSrc), loadImage(opts.resultSrc)]);
    const w = resImg.naturalWidth;
    const h = resImg.naturalHeight;

    const scratch = document.createElement('canvas');
    scratch.width = w;
    scratch.height = h;
    const sctx = scratch.getContext('2d', { willReadFrequently: true });
    sctx.drawImage(origImg, 0, 0, w, h);
    const orig = sctx.getImageData(0, 0, w, h).data;
    sctx.clearRect(0, 0, w, h);
    sctx.drawImage(resImg, 0, 0, w, h);
    const work = sctx.getImageData(0, 0, w, h);
    const alphaView = new ImageData(w, h);

    const bytes = w * h * 4;
    const maxUndo = Math.max(3, Math.min(20, Math.floor((220 * 1024 * 1024) / Math.max(1, bytes))));
    const undoStack = [];
    const redoStack = [];
    let strokes = 0;

    panel.innerHTML = `
      <div class="retouch-toolbar">
        <div class="retouch-group">
          <button type="button" class="retouch-btn is-active" data-mode="restore" title="Restaurar píxeles originales (X alterna)">＋ RESTAURAR</button>
          <button type="button" class="retouch-btn" data-mode="erase" title="Borrar alfa (X alterna)">− BORRAR</button>
        </div>
        <label class="retouch-field">TAMAÑO <span data-out="size">36</span>px
          <input type="range" data-in="size" min="2" max="240" value="36"></label>
        <label class="retouch-field">DUREZA <span data-out="hard">55</span>%
          <input type="range" data-in="hard" min="0" max="95" value="55"></label>
        <label class="retouch-field retouch-check"><input type="checkbox" data-in="edge" checked> 🧲 BORDE INTELIGENTE</label>
        <label class="retouch-field">VISTA
          <select data-in="view">
            <option value="checker" selected>🏁 Tablero</option>
            <option value="alpha">◐ Alfa pura</option>
            <option value="black">⬛ Sobre negro</option>
            <option value="white">⬜ Sobre blanco</option>
          </select></label>
        <div class="retouch-group">
          <button type="button" class="retouch-btn" data-act="undo" title="Ctrl+Z">↶</button>
          <button type="button" class="retouch-btn" data-act="redo" title="Ctrl+Y">↷</button>
          <button type="button" class="retouch-btn retouch-save" data-act="save">💾 GUARDAR RETOQUE</button>
          <button type="button" class="retouch-btn" data-act="close">✕</button>
        </div>
      </div>
      <div class="retouch-stage">
        <canvas class="retouch-canvas is-checker"></canvas>
        <canvas class="retouch-loupe" width="${LOUPE_SIZE}" height="${LOUPE_SIZE}"></canvas>
      </div>
      <div class="retouch-status">${w}×${h}px · Trazos: <span data-out="strokes">0</span> · Lupa 400% sigue al cursor · [ ] tamaño · X modo · Ctrl+Z deshacer</div>`;
    panel.style.display = 'block';

    const canvas = panel.querySelector('.retouch-canvas');
    const loupe = panel.querySelector('.retouch-loupe');
    const lctx = loupe.getContext('2d');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    const q = (sel) => panel.querySelector(sel);
    const state = { mode: 'restore', size: 36, hard: 0.55, edge: true, view: 'checker' };
    let dirty = null;
    let rafId = 0;
    let painting = false;
    let last = null;
    let cursor = null;

    function syncAlpha(rect) {
      const src = work.data;
      const dst = alphaView.data;
      for (let y = rect.y; y < rect.y + rect.h; y++) {
        let i = (y * w + rect.x) * 4;
        for (let x = 0; x < rect.w; x++, i += 4) {
          const a = src[i + 3];
          dst[i] = a; dst[i + 1] = a; dst[i + 2] = a; dst[i + 3] = 255;
        }
      }
    }

    function render(rect) {
      const r = rect || { x: 0, y: 0, w, h };
      if (state.view === 'alpha') {
        syncAlpha(r);
        ctx.putImageData(alphaView, 0, 0, r.x, r.y, r.w, r.h);
      } else {
        ctx.putImageData(work, 0, 0, r.x, r.y, r.w, r.h);
      }
      drawLoupe();
    }

    function schedule(rect) {
      dirty = unionRect(dirty, rect);
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        const r = dirty;
        dirty = null;
        if (r) render(r);
      });
    }

    function drawLoupe() {
      if (!cursor) { loupe.style.display = 'none'; return; }
      const span = LOUPE_SIZE / LOUPE_ZOOM;
      const sx = clamp(Math.round(cursor.x - span / 2), 0, Math.max(0, w - span));
      const sy = clamp(Math.round(cursor.y - span / 2), 0, Math.max(0, h - span));
      lctx.imageSmoothingEnabled = false;
      lctx.fillStyle = state.view === 'white' ? '#ffffff' : (state.view === 'black' || state.view === 'alpha' ? '#000000' : '#1b2233');
      lctx.fillRect(0, 0, LOUPE_SIZE, LOUPE_SIZE);
      if (state.view === 'checker') {
        const cs = 8;
        lctx.fillStyle = '#2a3247';
        for (let yy = 0; yy < LOUPE_SIZE; yy += cs) {
          for (let xx = (yy / cs) % 2 ? cs : 0; xx < LOUPE_SIZE; xx += cs * 2) lctx.fillRect(xx, yy, cs, cs);
        }
      }
      lctx.drawImage(canvas, sx, sy, span, span, 0, 0, LOUPE_SIZE, LOUPE_SIZE);
      const rr = (state.size / 2) * LOUPE_ZOOM;
      const lx = (cursor.x - sx) * LOUPE_ZOOM;
      const ly = (cursor.y - sy) * LOUPE_ZOOM;
      lctx.strokeStyle = state.mode === 'restore' ? 'rgba(0,255,157,0.95)' : 'rgba(255,64,110,0.95)';
      lctx.lineWidth = 1.5;
      lctx.beginPath();
      lctx.arc(lx, ly, Math.min(rr, LOUPE_SIZE), 0, Math.PI * 2);
      lctx.stroke();
      lctx.beginPath();
      lctx.moveTo(lx - 6, ly); lctx.lineTo(lx + 6, ly);
      lctx.moveTo(lx, ly - 6); lctx.lineTo(lx, ly + 6);
      lctx.stroke();
      loupe.style.display = 'block';
    }

    function toImageCoords(ev) {
      const rect = canvas.getBoundingClientRect();
      return {
        x: (ev.clientX - rect.left) * (w / rect.width),
        y: (ev.clientY - rect.top) * (h / rect.height),
        px: ev.clientX - rect.left,
        py: ev.clientY - rect.top,
        cw: rect.width,
      };
    }

    function pushUndo() {
      undoStack.push(new Uint8ClampedArray(work.data));
      if (undoStack.length > maxUndo) undoStack.shift();
      redoStack.length = 0;
    }

    function paintSegment(a, b) {
      const radius = state.size / 2;
      const dist = Math.hypot(b.x - a.x, b.y - a.y);
      const step = Math.max(1, radius * 0.3);
      const n = Math.max(1, Math.ceil(dist / step));
      let rect = null;
      for (let k = 1; k <= n; k++) {
        const t = k / n;
        rect = unionRect(rect, stamp(work.data, orig, w, h, a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, {
          mode: state.mode, radius, hardness: state.hard, edgeAware: state.edge, flow: 0.85,
        }));
      }
      if (rect) schedule(rect);
    }

    canvas.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      canvas.setPointerCapture(ev.pointerId);
      pushUndo();
      painting = true;
      const p = toImageCoords(ev);
      last = p;
      cursor = p;
      const rect = stamp(work.data, orig, w, h, p.x, p.y, {
        mode: state.mode, radius: state.size / 2, hardness: state.hard, edgeAware: state.edge, flow: 0.85,
      });
      schedule(rect);
    });
    canvas.addEventListener('pointermove', (ev) => {
      const p = toImageCoords(ev);
      cursor = p;
      const lpx = p.px + 18 + LOUPE_SIZE > p.cw ? p.px - LOUPE_SIZE - 18 : p.px + 18;
      loupe.style.left = `${Math.max(0, lpx)}px`;
      loupe.style.top = `${Math.max(0, p.py - LOUPE_SIZE / 2)}px`;
      if (painting && last) {
        paintSegment(last, p);
        last = p;
      } else {
        drawLoupe();
      }
    });
    const endStroke = () => {
      if (painting) {
        strokes += 1;
        q('[data-out="strokes"]').textContent = String(strokes);
      }
      painting = false;
      last = null;
    };
    canvas.addEventListener('pointerup', endStroke);
    canvas.addEventListener('pointercancel', endStroke);
    canvas.addEventListener('pointerleave', () => { cursor = null; drawLoupe(); });

    panel.querySelectorAll('[data-mode]').forEach((btn) => {
      btn.addEventListener('click', () => setMode(btn.dataset.mode));
    });
    function setMode(mode) {
      state.mode = mode;
      panel.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('is-active', b.dataset.mode === mode));
      drawLoupe();
    }
    q('[data-in="size"]').addEventListener('input', (e) => { state.size = Number(e.target.value); q('[data-out="size"]').textContent = e.target.value; });
    q('[data-in="hard"]').addEventListener('input', (e) => { state.hard = Number(e.target.value) / 100; q('[data-out="hard"]').textContent = e.target.value; });
    q('[data-in="edge"]').addEventListener('change', (e) => { state.edge = e.target.checked; });
    q('[data-in="view"]').addEventListener('change', (e) => {
      state.view = e.target.value;
      canvas.classList.toggle('is-checker', state.view === 'checker');
      canvas.style.background = state.view === 'white' ? '#ffffff' : (state.view === 'black' ? '#000000' : '');
      render();
    });

    function undo() {
      if (!undoStack.length) return;
      redoStack.push(new Uint8ClampedArray(work.data));
      work.data.set(undoStack.pop());
      render();
    }
    function redo() {
      if (!redoStack.length) return;
      undoStack.push(new Uint8ClampedArray(work.data));
      work.data.set(redoStack.pop());
      render();
    }

    function close() {
      document.removeEventListener('keydown', onKey);
      panel.style.display = 'none';
      panel.innerHTML = '';
      if (typeof opts.onClose === 'function') opts.onClose();
    }

    async function save() {
      const out = document.createElement('canvas');
      out.width = w;
      out.height = h;
      out.getContext('2d').putImageData(work, 0, 0);
      const blob = await new Promise((res) => out.toBlob(res, 'image/png'));
      if (!blob) throw new Error('No se pudo codificar el PNG retocado.');
      if (typeof opts.onSave === 'function') await opts.onSave(blob, { strokes, width: w, height: h });
    }

    q('[data-act="undo"]').addEventListener('click', undo);
    q('[data-act="redo"]').addEventListener('click', redo);
    q('[data-act="close"]').addEventListener('click', close);
    q('[data-act="save"]').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try { await save(); } finally { btn.disabled = false; }
    });

    function onKey(ev) {
      if (panel.style.display === 'none') return;
      const tag = (ev.target && ev.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'z') { ev.preventDefault(); undo(); return; }
      if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'y') { ev.preventDefault(); redo(); return; }
      if (ev.key === '[' || ev.key === ']') {
        const inp = q('[data-in="size"]');
        state.size = clamp(state.size + (ev.key === ']' ? 4 : -4), 2, 240);
        inp.value = String(state.size);
        q('[data-out="size"]').textContent = String(state.size);
        drawLoupe();
      } else if (ev.key.toLowerCase() === 'x') {
        setMode(state.mode === 'restore' ? 'erase' : 'restore');
      }
    }
    document.addEventListener('keydown', onKey);

    render();
    return { close, save, getImageData: () => work, stats: () => ({ strokes, undo: undoStack.length }) };
  }

  const api = { open, stamp, brushFalloff, edgeFactor };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.KapturaMatteBrush = api;
})(typeof self !== 'undefined' ? self : this);
