/*
 * KAPTURA · GIF encode worker
 * Keeps the heavy CPU work (quantization + LZW) off the UI thread. Frames are
 * transferred in as raw RGBA ArrayBuffers (zero-copy). Emits progress, then the
 * finished GIF bytes (also transferred out).
 */
/* global importScripts, self */
importScripts('gif-encoder.js');

self.onmessage = function (e) {
  const d = e.data;
  try {
    const enc = new self.KapturaGIF.GIFEncoder(d.width, d.height, {
      delay: d.delay, repeat: d.repeat, dither: d.dither, maxColors: d.maxColors,
      delta: d.delta !== false, subRect: d.subRect !== false, noiseGate: d.noiseGate || 8,
    });
    const delays = d.delays || null;
    for (let i = 0; i < d.frames.length; i++) {
      enc.addFrame(new Uint8ClampedArray(d.frames[i]), {
        delay: (delays && delays[i] != null) ? delays[i] : d.delay,
      });
      self.postMessage({ type: 'progress', value: (i + 1) / d.frames.length });
    }
    const bytes = enc.render();
    self.postMessage({ type: 'done', bytes: bytes.buffer }, [bytes.buffer]);
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err && err.message || err) });
  }
};
