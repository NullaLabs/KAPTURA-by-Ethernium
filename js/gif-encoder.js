/*
 * ============================================================================
 * KAPTURA · Native GIF89a Encoder  (pure JavaScript · zero dependencies)
 * ============================================================================
 * Real, from-scratch GIF encoding. No library, no WASM. Pure math + bits:
 *   1. Median-cut color quantization        -> palette of <= 256 colors
 *   2. Floyd-Steinberg error diffusion       -> perceptual dithering
 *   3. LZW variable-width compression         -> the GIF spec's own codec
 *   4. GIF89a container assembly              -> byte-exact binary writer
 *
 * Works in the browser AND in Node (for the unit test in tests/).
 * ----------------------------------------------------------------------------
 */
(function (root) {
  'use strict';

  /* ---- tiny growable byte buffer ---------------------------------------- */
  class ByteWriter {
    constructor() { this.buf = new Uint8Array(1024); this.len = 0; }
    _ensure(n) {
      if (this.len + n <= this.buf.length) return;
      let cap = this.buf.length;
      while (cap < this.len + n) cap *= 2;
      const next = new Uint8Array(cap);
      next.set(this.buf.subarray(0, this.len));
      this.buf = next;
    }
    byte(b) { this._ensure(1); this.buf[this.len++] = b & 0xff; }
    bytes(arr) { this._ensure(arr.length); this.buf.set(arr, this.len); this.len += arr.length; }
    u16(v) { this.byte(v & 0xff); this.byte((v >> 8) & 0xff); } // little-endian
    str(s) { for (let i = 0; i < s.length; i++) this.byte(s.charCodeAt(i)); }
    result() { return this.buf.subarray(0, this.len); }
  }

  /* ---- Median-cut quantization ------------------------------------------ *
   * Builds a palette of at most `maxColors` by recursively splitting the RGB
   * color box along its longest axis at the median. Classic, deterministic,
   * and hardware-independent.                                               */
  function medianCut(pixels, maxColors) {
    // pixels: flat Uint8ClampedArray [r,g,b,a, r,g,b,a, ...]
    const boxes = [buildBox(pixels, collectIndices(pixels))];
    while (boxes.length < maxColors) {
      // pick the box with the largest volume that still has > 1 color
      let target = -1, bestVol = -1;
      for (let i = 0; i < boxes.length; i++) {
        const b = boxes[i];
        if (b.indices.length < 2) continue;
        const vol = (b.rMax - b.rMin) * (b.gMax - b.gMin) * (b.bMax - b.bMin);
        if (vol > bestVol) { bestVol = vol; target = i; }
      }
      if (target === -1) break;
      const [a, c] = splitBox(pixels, boxes[target]);
      boxes.splice(target, 1, a, c);
    }
    return boxes.map((b) => averageColor(pixels, b.indices));
  }

  function collectIndices(pixels) {
    const n = pixels.length / 4;
    const idx = new Array(n);
    for (let i = 0; i < n; i++) idx[i] = i;
    return idx;
  }

  function buildBox(pixels, indices) {
    let rMin = 255, gMin = 255, bMin = 255, rMax = 0, gMax = 0, bMax = 0;
    for (let k = 0; k < indices.length; k++) {
      const p = indices[k] * 4;
      const r = pixels[p], g = pixels[p + 1], b = pixels[p + 2];
      if (r < rMin) rMin = r; if (r > rMax) rMax = r;
      if (g < gMin) gMin = g; if (g > gMax) gMax = g;
      if (b < bMin) bMin = b; if (b > bMax) bMax = b;
    }
    return { indices, rMin, gMin, bMin, rMax, gMax, bMax };
  }

  function splitBox(pixels, box) {
    const rRange = box.rMax - box.rMin;
    const gRange = box.gMax - box.gMin;
    const bRange = box.bMax - box.bMin;
    const channel = rRange >= gRange && rRange >= bRange ? 0 : gRange >= bRange ? 1 : 2;
    const sorted = box.indices.slice().sort((x, y) => pixels[x * 4 + channel] - pixels[y * 4 + channel]);
    const mid = sorted.length >> 1;
    return [buildBox(pixels, sorted.slice(0, mid)), buildBox(pixels, sorted.slice(mid))];
  }

  function averageColor(pixels, indices) {
    let r = 0, g = 0, b = 0;
    for (let k = 0; k < indices.length; k++) {
      const p = indices[k] * 4;
      r += pixels[p]; g += pixels[p + 1]; b += pixels[p + 2];
    }
    const n = Math.max(indices.length, 1);
    return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
  }

  function nearestColor(palette, r, g, b) {
    let best = 0, bestDist = Infinity;
    for (let i = 0; i < palette.length; i++) {
      const dr = r - palette[i][0], dg = g - palette[i][1], db = b - palette[i][2];
      const d = dr * dr + dg * dg + db * db;
      if (d < bestDist) { bestDist = d; best = i; if (d === 0) break; }
    }
    return best;
  }

  /* ---- Map RGBA image -> palette indices, with delta transparency & smart dither -------- */
  function mapToIndices(pixels, w, h, palette, dither, prevPixels, transIndex) {
    const out = new Uint8Array(w * h);
    if (!dither) {
      for (let i = 0, p = 0; i < out.length; i++, p += 4) {
        if (prevPixels && transIndex != null) {
          const dr = Math.abs(pixels[p] - prevPixels[p]);
          const dg = Math.abs(pixels[p + 1] - prevPixels[p + 1]);
          const db = Math.abs(pixels[p + 2] - prevPixels[p + 2]);
          if (dr + dg + db <= 6) { out[i] = transIndex; continue; }
        }
        out[i] = nearestColor(palette, pixels[p], pixels[p + 1], pixels[p + 2]);
      }
      return out;
    }
    // Floyd-Steinberg on a working float copy of RGB
    const work = new Float32Array(w * h * 3);
    for (let i = 0, p = 0, q = 0; i < w * h; i++, p += 4, q += 3) {
      work[q] = pixels[p]; work[q + 1] = pixels[p + 1]; work[q + 2] = pixels[p + 2];
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = y * w + x;
        const p = idx * 4;
        const q = idx * 3;

        // Frugal delta comparison against previous frame
        if (prevPixels && transIndex != null) {
          const dr = Math.abs(pixels[p] - prevPixels[p]);
          const dg = Math.abs(pixels[p + 1] - prevPixels[p + 1]);
          const db = Math.abs(pixels[p + 2] - prevPixels[p + 2]);
          if (dr + dg + db <= 6) {
            out[idx] = transIndex;
            continue;
          }
        }

        const r = clamp255(work[q]), g = clamp255(work[q + 1]), b = clamp255(work[q + 2]);
        const colorIdx = nearestColor(palette, r, g, b);
        out[idx] = colorIdx;
        const er = r - palette[colorIdx][0], eg = g - palette[colorIdx][1], eb = b - palette[colorIdx][2];
        // Noise gate: only diffuse noticeable error to preserve flat background compressibility
        if (Math.abs(er) + Math.abs(eg) + Math.abs(eb) > 10) {
          spread(work, w, h, x + 1, y, er, eg, eb, 7 / 16);
          spread(work, w, h, x - 1, y + 1, er, eg, eb, 3 / 16);
          spread(work, w, h, x, y + 1, er, eg, eb, 5 / 16);
          spread(work, w, h, x + 1, y + 1, er, eg, eb, 1 / 16);
        }
      }
    }
    return out;
  }
  function clamp255(v) { return v < 0 ? 0 : v > 255 ? 255 : v; }
  function spread(work, w, h, x, y, er, eg, eb, f) {
    if (x < 0 || x >= w || y < 0 || y >= h) return;
    const q = (y * w + x) * 3;
    work[q] += er * f; work[q + 1] += eg * f; work[q + 2] += eb * f;
  }

  /* ---- LZW compression (GIF variant) ------------------------------------ */
  function lzwEncode(indices, minCodeSize) {
    const clearCode = 1 << minCodeSize;
    const eoiCode = clearCode + 1;
    let codeSize = minCodeSize + 1;
    let dict = new Map();
    const resetDict = () => {
      dict = new Map();
      for (let i = 0; i < clearCode; i++) dict.set(String.fromCharCode(i), i);
    };
    let next = eoiCode + 1;
    resetDict();

    const out = [];
    let cur = 0, curBits = 0;
    const emit = (code) => {
      cur |= code << curBits;
      curBits += codeSize;
      while (curBits >= 8) { out.push(cur & 0xff); cur >>= 8; curBits -= 8; }
    };

    emit(clearCode);
    let prefix = String.fromCharCode(indices[0]);
    for (let i = 1; i < indices.length; i++) {
      const k = String.fromCharCode(indices[i]);
      const combined = prefix + k;
      if (dict.has(combined)) {
        prefix = combined;
      } else {
        emit(dict.get(prefix));
        dict.set(combined, next++);
        if (next > (1 << codeSize) && codeSize < 12) codeSize++;
        if (next > 4095) { emit(clearCode); resetDict(); next = eoiCode + 1; codeSize = minCodeSize + 1; }
        prefix = k;
      }
    }
    emit(dict.get(prefix));
    emit(eoiCode);
    if (curBits > 0) out.push(cur & 0xff);
    return out;
  }

  /* ---- The encoder ------------------------------------------------------- */
  class GIFEncoder {
    /**
     * @param {number} width
     * @param {number} height
     * @param {object} [opts]  { delay=100 ms, repeat=0 (loop forever), dither=true, maxColors=255, delta=true, sampleStep=1 }
     */
    constructor(width, height, opts = {}) {
      this.w = width; this.h = height;
      this.delay = opts.delay != null ? opts.delay : 100;   // ms between frames
      this.repeat = opts.repeat != null ? opts.repeat : 0;  // 0 = infinite
      this.dither = opts.dither !== false;
      this.delta = opts.delta !== false;                    // Frugal delta transparency
      this.maxColors = Math.min(opts.maxColors || 255, 255);// reserve 1 for transparency
      this.sampleStep = Math.max(1, opts.sampleStep || 1);  // subsample for palette speed
      this.frames = [];                                     // {indices, palette, transIndex}
      this.prevRgba = null;
    }

    /** Add one RGBA frame (Uint8ClampedArray length w*h*4). */
    addFrame(rgba) {
      // Build a per-frame palette (good quality for moving content).
      const sample = this.sampleStep > 1 ? subsample(rgba, this.sampleStep) : rgba;
      const palette = medianCut(sample, this.maxColors);
      while (palette.length < 2) palette.push([0, 0, 0]);

      const isFirst = (this.frames.length === 0);
      const transIndex = (!isFirst && this.delta) ? 255 : null;

      const indices = mapToIndices(
        rgba, this.w, this.h, palette, this.dither,
        (!isFirst && this.delta) ? this.prevRgba : null, transIndex
      );

      this.frames.push({ indices, palette, transIndex });
      this.prevRgba = new Uint8ClampedArray(rgba);
    }

    /** Produce the final GIF bytes (Uint8Array). */
    render() {
      const bw = new ByteWriter();
      // Header
      bw.str('GIF89a');
      // Logical Screen Descriptor (no global color table)
      bw.u16(this.w); bw.u16(this.h);
      bw.byte(0x00); // packed: no GCT
      bw.byte(0);    // bg color index
      bw.byte(0);    // pixel aspect ratio

      // Netscape 2.0 looping extension
      bw.byte(0x21); bw.byte(0xff); bw.byte(0x0b);
      bw.str('NETSCAPE2.0');
      bw.byte(0x03); bw.byte(0x01);
      bw.u16(this.repeat); // loop count (0 = forever)
      bw.byte(0x00);

      const delayCs = Math.max(2, Math.round(this.delay / 10)); // GIF delay is in 1/100 s

      for (const frame of this.frames) {
        const { colorBits, table } = buildLocalColorTable(frame.palette, frame.transIndex);
        // Graphic Control Extension (per-frame delay)
        bw.byte(0x21); bw.byte(0xf9); bw.byte(0x04);
        if (frame.transIndex != null) {
          bw.byte(0x05);            // disposal=1 (leave graphic in place), transparent=1
          bw.u16(delayCs);
          bw.byte(frame.transIndex);
        } else {
          bw.byte(0x04);            // disposal=1 (leave in place), no transparency
          bw.u16(delayCs);
          bw.byte(0x00);
        }
        bw.byte(0x00);
        // Image Descriptor
        bw.byte(0x2c);
        bw.u16(0); bw.u16(0); bw.u16(this.w); bw.u16(this.h);
        bw.byte(0x80 | (colorBits - 1)); // local color table, size
        bw.bytes(table);
        // Image data (LZW)
        const minCodeSize = Math.max(2, colorBits);
        bw.byte(minCodeSize);
        const lzw = lzwEncode(frame.indices, minCodeSize);
        // Sub-block packaging (max 255 bytes each)
        for (let off = 0; off < lzw.length; off += 255) {
          const chunk = lzw.slice(off, off + 255);
          bw.byte(chunk.length);
          bw.bytes(chunk);
        }
        bw.byte(0x00); // block terminator
      }
      bw.byte(0x3b); // trailer
      return bw.result();
    }
  }

  function subsample(rgba, step) {
    const n = rgba.length / 4;
    const kept = [];
    for (let i = 0; i < n; i += step) {
      const p = i * 4;
      kept.push(rgba[p], rgba[p + 1], rgba[p + 2], rgba[p + 3]);
    }
    return new Uint8ClampedArray(kept);
  }

  function buildLocalColorTable(palette, transIndex) {
    // GIF color tables must be a power-of-two size (2..256).
    let bits = 1;
    const count = Math.max(palette.length, transIndex != null ? transIndex + 1 : 0);
    while ((1 << bits) < count) bits++;
    const size = 1 << bits;
    const table = new Uint8Array(size * 3);
    for (let i = 0; i < size; i++) {
      const c = palette[i] || [0, 0, 0];
      table[i * 3] = c[0]; table[i * 3 + 1] = c[1]; table[i * 3 + 2] = c[2];
    }
    return { colorBits: bits, table };
  }

  const api = { GIFEncoder, _internals: { medianCut, lzwEncode, mapToIndices } };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.KapturaGIF = api;
})(typeof self !== 'undefined' ? self : this);
