/*
 * Unit tests for KAPTURA Smart Compressor & SVG Vector modules
 * Run: node tests/test_compressor_svg.js
 */
const path = require('path');
const p = (f) => path.join(__dirname, '..', 'js', f);

const Compressor = require(p('compressor.js'));
const SVGVector = require(p('svg-vector.js'));
const Upskaletor = require(p('upskaletor.js'));

let failures = 0;
const check = (n, c) => {
  console.log((c ? '  PASS  ' : '  FAIL  ') + n);
  if (!c) failures++;
};

console.log('--- SMART COMPRESSOR API ---');
check('Compressor exports compressImage', typeof Compressor.compressImage === 'function');
check('Compressor exports compressVideo', typeof Compressor.compressVideo === 'function');

console.log('\n--- SVG VECTOR STUDIO API & TRACING ---');
check('SVGVector exports fromCanvas', typeof SVGVector.fromCanvas === 'function');
check('SVGVector exports fromVideo', typeof SVGVector.fromVideo === 'function');
check('SVGVector exports fromImage', typeof SVGVector.fromImage === 'function');
check('SVGVector exports processFile', typeof SVGVector.processFile === 'function');
check('SVGVector exports isImageFile', typeof SVGVector.isImageFile === 'function');
check('SVGVector exports vectorTrace', typeof SVGVector.vectorTrace === 'function');

check('isImageFile identifies .png', SVGVector.isImageFile('photo.png') === true);
check('isImageFile identifies .jpg', SVGVector.isImageFile('photo.jpg') === true);
check('isImageFile identifies .webp', SVGVector.isImageFile('art.webp') === true);
check('isImageFile rejects .mp4', SVGVector.isImageFile('video.mp4') === false);
check('isImageFile rejects .webm', SVGVector.isImageFile('stream.webm') === false);

// Test real vector path tracing on 16x16 gradient buffer
const tw = 16, th = 16;
const tbuf = new Uint8Array(tw * th * 4);
for (let y = 0; y < th; y++) {
  for (let x = 0; x < tw; x++) {
    const idx = (y * tw + x) * 4;
    tbuf[idx] = (x < 8) ? 255 : 0;     // Red left half
    tbuf[idx + 1] = (y < 8) ? 255 : 0; // Green top half
    tbuf[idx + 2] = 0;
    tbuf[idx + 3] = 255;
  }
}

const trace = SVGVector.vectorTrace(tbuf, tw, th, { colors: 4 });
check('vectorTrace returns svg string', typeof trace.svg === 'string');
check('vectorTrace generates valid svg root', trace.svg.includes('<svg') && trace.svg.includes('</svg>'));
check('vectorTrace contains viewBox', trace.svg.includes(`viewBox="0 0 ${tw} ${th}"`));
check('vectorTrace generates <path fill= elements', trace.svg.includes('<path fill='));
check('vectorTrace generates non-empty path commands (d="M...)', trace.svg.includes('d="M'));
check('vectorTrace partitions into color layers', trace.layers >= 2);
check('vectorTrace total paths count is positive', trace.totalPaths > 0);

console.log('\n--- UPSKALETOR IMAGE & VIDEO SUPPORT ---');
check('Upskaletor supports image files', Upskaletor.isImageFile('render.png') === true);
check('Upskaletor has 2x_super profile', Boolean(Upskaletor.PROFILES['2x_super']));
check('Upskaletor has 4x_super profile', Boolean(Upskaletor.PROFILES['4x_super']));
const imgCmd = Upskaletor.command('art.png', '4k_ai', 'ai');
check('Upskaletor image handoff command targets .png', imgCmd.includes('.png') && imgCmd.includes('_UPSKALED.png'));
const vidCmd = Upskaletor.command('clip.mp4', '4k_ai', 'ai');
check('Upskaletor video handoff command targets .mp4', vidCmd.includes('.mp4') && vidCmd.includes('_UPSKALED.mp4'));

if (failures) {
  console.error(`\nTESTS FAILED (${failures})`);
  process.exit(1);
} else {
  console.log('\nALL SMART COMPRESSOR & SVG VECTOR TESTS PASSED (100%)\n');
}
