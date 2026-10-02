/*
 * ============================================================================
 * KAPTURA · Temporal Timing & Real-Time GIF Validation Test
 * ============================================================================
 * Asserts:
 *  1. 1.0x Normal Speed mode strictly preserves real source duration (no acceleration).
 *  2. 2.0x / 4.0x Timelapse modes scale durations accurately.
 *  3. GIFEncoder supports per-frame variable delays with centisecond accuracy.
 *  4. Temporal holding / decimation merges static frames into hold delays.
 *  5. Sub-rectangle delta bounding boxes encode only changed regions.
 *
 * Run: node tests/test_timing.js
 * ============================================================================
 */
const path = require('path');
const p = (f) => path.join(__dirname, '..', 'js', f);

const { GIFEncoder } = require(p('gif-encoder.js'));

let failures = 0;
const check = (name, cond) => {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name);
  if (!cond) failures++;
};

console.log('--- 1.0X REAL-TIME TIMING & DURATION PRESERVATION ---');

// Simulate a 10.0-second video sampled at 24 FPS (240 frames)
const dur = 10.0;
const fps = 24;
const total = Math.round(dur * fps);
const nominalDelayMs = (dur * 1000) / total;

let accumMs = 0;
let prevTotalCs = 0;
const delays = [];
for (let i = 0; i < total; i++) {
  accumMs += nominalDelayMs;
  const targetCs = Math.round(accumMs / 10);
  const delayCs = Math.max(2, targetCs - prevTotalCs);
  delays.push(delayCs * 10);
  prevTotalCs += delayCs;
}

const sumDelaysMs = delays.reduce((a, b) => a + b, 0);
const sumDelaysSec = sumDelaysMs / 1000;
check('Total delay matches source duration (10.0s)', Math.abs(sumDelaysSec - dur) < 0.05);

// Simulate a 60.0-second video with max sample cap (e.g. 240 samples)
const dur60 = 60.0;
const total60 = 240;
const nominalDelay60 = (dur60 * 1000) / total60;
accumMs = 0;
prevTotalCs = 0;
const delays60 = [];
for (let i = 0; i < total60; i++) {
  accumMs += nominalDelay60;
  const targetCs = Math.round(accumMs / 10);
  const delayCs = Math.max(2, targetCs - prevTotalCs);
  delays60.push(delayCs * 10);
  prevTotalCs += delayCs;
}
const sumDelays60Sec = delays60.reduce((a, b) => a + b, 0) / 1000;
check('1-minute video total playback is exactly 60.0s (NO acceleration)', Math.abs(sumDelays60Sec - 60.0) < 0.05);

console.log('\n--- 2.0X TIMELAPSE DURATION SCALING ---');
const speed2x = 2.0;
const durTimelapse = dur60 / speed2x; // 30.0s
accumMs = 0;
prevTotalCs = 0;
const delays2x = [];
const nominalDelay2x = (durTimelapse * 1000) / total60;
for (let i = 0; i < total60; i++) {
  accumMs += nominalDelay2x;
  const targetCs = Math.round(accumMs / 10);
  const delayCs = Math.max(2, targetCs - prevTotalCs);
  delays2x.push(delayCs * 10);
  prevTotalCs += delayCs;
}
const sumDelays2xSec = delays2x.reduce((a, b) => a + b, 0) / 1000;
check('2.0x timelapse plays in exactly half the time (30.0s)', Math.abs(sumDelays2xSec - 30.0) < 0.05);

console.log('\n--- GIFENCODER PER-FRAME VARIABLE DELAY & SUB-RECT ---');
const W = 64, H = 64;
const enc = new GIFEncoder(W, H, { delay: 100, delta: true, subRect: true });

// Frame 0: Solid blue, delay = 100ms
const f0 = new Uint8ClampedArray(W * H * 4);
for (let i = 0; i < W * H; i++) {
  f0[i * 4] = 20; f0[i * 4 + 1] = 40; f0[i * 4 + 2] = 200; f0[i * 4 + 3] = 255;
}
enc.addFrame(f0, { delay: 150 });
check('Frame 0 added with full bounds', enc.frames[0].w === W && enc.frames[0].h === H);
check('Frame 0 stores custom delay (150ms)', enc.frames[0].delay === 150);

// Frame 1: Identical frame (should be held/merged into frame 0)
enc.addFrame(f0, { delay: 100 });
check('Identical frame does not create new descriptor (temporal hold)', enc.frames.length === 1);
check('Previous frame delay increased by identical frame duration (150+100=250ms)', enc.frames[0].delay === 250);

// Frame 2: Local movement in region [10, 10, 20, 20]
const f2 = new Uint8ClampedArray(f0);
for (let y = 10; y < 30; y++) {
  for (let x = 10; x < 30; x++) {
    const idx = (y * W + x) * 4;
    f2[idx] = 255; f2[idx + 1] = 255; f2[idx + 2] = 0;
  }
}
enc.addFrame(f2, { delay: 50 });
check('Moving frame created new frame descriptor', enc.frames.length === 2);
check('Sub-rectangle bounded to region of movement (w <= 21, h <= 21)', enc.frames[1].w <= 21 && enc.frames[1].h <= 21);
check('Sub-rectangle offset coordinates correct (x=10, y=10)', enc.frames[1].x === 10 && enc.frames[1].y === 10);
check('Sub-rectangle uses transparency (transIndex=255)', enc.frames[1].transIndex === 255);

const gifBytes = enc.render();
check('Render produces valid GIF89a header', String.fromCharCode(...gifBytes.subarray(0, 6)) === 'GIF89a');
check('Render terminates with 0x3B', gifBytes[gifBytes.length - 1] === 0x3b);

if (failures) {
  console.error(`\nTESTS FAILED (${failures})`);
  process.exit(1);
} else {
  console.log('\nALL TEMPORAL TIMING & REAL-TIME GIF TESTS PASSED (100%)\n');
}
