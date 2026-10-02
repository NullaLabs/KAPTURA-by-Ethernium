/*
 * Validates the Lanczos-3 resampler: correct output dimensions and that a
 * flat-color image keeps its color (weights are normalized -> no brightness
 * drift). Run: node tests/test_lanczos.js
 */
const path = require('path');
const { resample } = require(path.join(__dirname, '..', 'js', 'lanczos.js'));

let failures = 0;
const check = (n, c) => { console.log((c ? '  PASS  ' : '  FAIL  ') + n); if (!c) failures++; };

// Flat mid-gray 32x32 -> upscale 100x100 must stay ~ (128,64,200)
const sw = 32, sh = 32;
const src = new Uint8ClampedArray(sw * sh * 4);
for (let i = 0; i < sw * sh; i++) { const p = i * 4; src[p] = 128; src[p + 1] = 64; src[p + 2] = 200; src[p + 3] = 255; }

const dw = 100, dh = 100;
const out = resample(src, sw, sh, dw, dh);
check('output length matches dw*dh*4', out.length === dw * dh * 4);

// sample a center pixel
const c = ((dh >> 1) * dw + (dw >> 1)) * 4;
check('flat color preserved R', Math.abs(out[c] - 128) <= 1);
check('flat color preserved G', Math.abs(out[c + 1] - 64) <= 1);
check('flat color preserved B', Math.abs(out[c + 2] - 200) <= 1);
check('alpha preserved', Math.abs(out[c + 3] - 255) <= 1);

// downscale path
const down = resample(src, sw, sh, 8, 8);
check('downscale length', down.length === 8 * 8 * 4);
check('downscale color preserved', Math.abs(down[0] - 128) <= 2);

// Vertical orientation invariant: top half red, bottom half blue
const vSrc = new Uint8ClampedArray(sw * sh * 4);
for (let y = 0; y < sh; y++) {
  for (let x = 0; x < sw; x++) {
    const p = (y * sw + x) * 4;
    if (y < (sh >> 1)) { vSrc[p] = 255; vSrc[p + 1] = 0; vSrc[p + 2] = 0; vSrc[p + 3] = 255; }
    else { vSrc[p] = 0; vSrc[p + 1] = 0; vSrc[p + 2] = 255; vSrc[p + 3] = 255; }
  }
}
const vOut = resample(vSrc, sw, sh, 16, 16);
const topRed = vOut[0] > 200 && vOut[2] < 50;
const botBlue = vOut[(15 * 16 + 0) * 4 + 2] > 200 && vOut[(15 * 16 + 0) * 4 + 0] < 50;
check('vertical orientation preserved: top is red', topRed);
check('vertical orientation preserved: bottom is blue', botBlue);

if (failures) { console.error('\nLANCZOS TEST FAILED (' + failures + ')'); process.exit(1); }
console.log('\nLANCZOS TEST PASSED');
