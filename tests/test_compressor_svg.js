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
check('Upskaletor has 2k_cas profile', Boolean(Upskaletor.PROFILES['2k_cas']) && Upskaletor.PROFILES['2k_cas'].sharpen > 0 && Upskaletor.PROFILES['2k_cas'].cfr === true);
check('Upskaletor has 4k_cas profile', Boolean(Upskaletor.PROFILES['4k_cas']) && Upskaletor.PROFILES['4k_cas'].w === 3840);
check('Upskaletor has restore_ai profile', Boolean(Upskaletor.PROFILES['restore_ai']) && Upskaletor.PROFILES['restore_ai'].denoise === true);
check('Upskaletor has anime_ai profile', Boolean(Upskaletor.PROFILES['anime_ai']) && Upskaletor.PROFILES['anime_ai'].model === 'realesr-animevideov3');
check('Upskaletor has 2x_super profile', Boolean(Upskaletor.PROFILES['2x_super']));
check('Upskaletor has 4x_super profile', Boolean(Upskaletor.PROFILES['4x_super']));
const imgCmd = Upskaletor.command('art.png', '4k_ai', 'ai');
check('Upskaletor image handoff command targets .png', imgCmd.includes('.png') && imgCmd.includes('_UPSKALED.png'));
check('Upskaletor command aligns with kpr-upscale.ps1 flags', imgCmd.includes('kpr-upscale.ps1') && imgCmd.includes('-Mode AI') && imgCmd.includes('-Model "realesrgan-x4plus"') && imgCmd.includes('-OutputFile'));
const vidCmd = Upskaletor.command('clip.mp4', '4k_ai', 'ai');
check('Upskaletor video handoff command targets .mp4', vidCmd.includes('.mp4') && vidCmd.includes('_UPSKALED.mp4'));
const casCmd = Upskaletor.command('clip.mp4', '2k_cas', 'auto');
check('Upskaletor 2k_cas command emits Lanczos 2560x1440', casCmd.includes('-Mode Lanczos') && casCmd.includes('-Width 2560') && casCmd.includes('-Height 1440'));
check('Upskaletor has rife_2x profile', Boolean(Upskaletor.PROFILES['rife_2x']) && Upskaletor.PROFILES['rife_2x'].pipeline === 'rife');
check('Upskaletor has hybrid_4k_rife profile', Boolean(Upskaletor.PROFILES['hybrid_4k_rife']) && Upskaletor.PROFILES['hybrid_4k_rife'].pipeline === 'hybrid');

const Comparator = require(p('comparator.js'));
console.log('\n--- FORENSIC OPTICAL INSPECTOR (SOBEL + DELTA) ---');
check('Comparator exports computeSobelAndDelta', typeof Comparator.computeSobelAndDelta === 'function');
const cw = 8, ch = 8;
const flatBuf = new Uint8Array(cw * ch * 4).fill(128);
const sharpBuf = new Uint8Array(cw * ch * 4);
for (let y = 0; y < ch; y++) {
  for (let x = 0; x < cw; x++) {
    const i = y * cw + x;
    const v = (x < 4) ? 16 : 240;
    sharpBuf[i * 4] = v; sharpBuf[i * 4 + 1] = v; sharpBuf[i * 4 + 2] = v; sharpBuf[i * 4 + 3] = 255;
  }
}
const mRes = Comparator.computeSobelAndDelta(flatBuf, sharpBuf, cw, ch, null);
check('Sobel edge energy detects high-frequency sharpening gain', mRes.avgEdgeAfter > mRes.avgEdgeBefore);
check('Mean RGB delta is non-zero between blurred and sharp images', mRes.meanDelta > 10);

if (failures) {
  console.error(`\nTESTS FAILED (${failures})`);
  process.exit(1);
} else {
  console.log('\nALL SMART COMPRESSOR & SVG VECTOR TESTS PASSED (100%)\n');
}
