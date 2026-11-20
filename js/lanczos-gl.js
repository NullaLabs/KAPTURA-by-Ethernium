/*
 * ============================================================================
 * KAPTURA · Lanczos-3 on the GPU  (WebGL · separable 2-pass · frugal)
 * ============================================================================
 * Real-time high-quality resampling on the GPU. Same kernel as the CPU module
 * (js/lanczos.js) but evaluated in a fragment shader. Separable: a horizontal
 * pass then a vertical pass, so cost is O(taps) per axis, not O(taps^2).
 *
 * Contract: create() returns null if WebGL is unavailable, so callers can fall
 * back to the CPU path without special-casing. No exceptions leak to the UI.
 * ----------------------------------------------------------------------------
 */
(function (root) {
  'use strict';

  const VERT = `
    attribute vec2 aPos;
    varying vec2 vUv;
    void main() {
      vUv = aPos * 0.5 + 0.5;
      gl_Position = vec4(aPos, 0.0, 1.0);
    }`;

  // One shader, run twice with a different axis. Constant-bound loop for WebGL1
  // portability; break/continue prune the real support window.
  const FRAG = `
    precision highp float;
    varying vec2 vUv;
    uniform sampler2D uTex;
    uniform float uSrcLen;    // source length (texels) along the pass axis
    uniform float uFilter;    // kernel widening factor (>=1 when downscaling)
    uniform vec2  uAxis;      // (1,0) horizontal | (0,1) vertical
    const float A = 3.0;
    float sinc(float x){ if (abs(x) < 1e-6) return 1.0; float p = 3.14159265 * x; return sin(p) / p; }
    float lz(float x){ if (abs(x) >= A) return 0.0; return sinc(x) * sinc(x / A); }
    void main() {
      float axisUv = dot(vUv, uAxis);
      float center = axisUv * uSrcLen - 0.5;
      float support = A * uFilter;
      float start = floor(center - support);
      float end   = ceil(center + support);
      vec4 acc = vec4(0.0);
      float wsum = 0.0;
      for (float k = 0.0; k <= 64.0; k += 1.0) {
        float sp = start + k;
        if (sp > end) break;
        if (sp < 0.0 || sp > uSrcLen - 1.0) continue;
        float w = lz((sp - center) / uFilter);
        vec2 coord = vUv + uAxis * ((sp + 0.5) / uSrcLen - axisUv);
        acc += texture2D(uTex, coord) * w;
        wsum += w;
      }
      gl_FragColor = wsum > 0.0 ? acc / wsum : texture2D(uTex, vUv);
    }`;

  // Dual-Scale Halo-Free Adaptive Detail Recovery (Coarse De-Blur + Fine CAS + Color Bounds)
  const CAS_FRAG = `
    precision highp float;
    varying vec2 vUv;
    uniform sampler2D uTex;
    uniform vec2 uTexel;
    uniform float uSharp;
    uniform float uScale;
    void main() {
      vec4 center = texture2D(uTex, vUv);
      vec3 c = center.rgb;

      // 1-px micro-edge ring (fine polish)
      vec3 n  = texture2D(uTex, vUv + vec2(0.0, -uTexel.y)).rgb;
      vec3 s  = texture2D(uTex, vUv + vec2(0.0,  uTexel.y)).rgb;
      vec3 e  = texture2D(uTex, vUv + vec2( uTexel.x, 0.0)).rgb;
      vec3 w  = texture2D(uTex, vUv + vec2(-uTexel.x, 0.0)).rgb;

      // Scale-matched coarse ring (~0.65x source texel) to reverse upscale blur slope
      vec2 stepC = uTexel * clamp(uScale * 0.65, 1.0, 2.75);
      vec3 nC  = texture2D(uTex, vUv + vec2(0.0, -stepC.y)).rgb;
      vec3 sC  = texture2D(uTex, vUv + vec2(0.0,  stepC.y)).rgb;
      vec3 eC  = texture2D(uTex, vUv + vec2( stepC.x, 0.0)).rgb;
      vec3 wC  = texture2D(uTex, vUv + vec2(-stepC.x, 0.0)).rgb;
      vec3 nwC = texture2D(uTex, vUv + vec2(-stepC.x, -stepC.y)).rgb;
      vec3 neC = texture2D(uTex, vUv + vec2( stepC.x, -stepC.y)).rgb;
      vec3 swC = texture2D(uTex, vUv + vec2(-stepC.x,  stepC.y)).rgb;
      vec3 seC = texture2D(uTex, vUv + vec2( stepC.x,  stepC.y)).rgb;

      vec3 avgFine = 0.25 * (n + s + e + w);
      vec3 avgCoarse = 0.125 * (nC + sC + eC + wC + nwC + neC + swC + seC);
      vec3 diffC = c - avgCoarse;
      vec3 diffF = c - avgFine;

      // Preserve response on dark scenes; suppress uniform flat-noise amplification
      float edgeMag = dot(abs(diffC) + abs(diffF), vec3(0.333333));
      float activity = smoothstep(0.008, 0.14, edgeMag);
      vec3 sharpened = c + (diffC * 0.85 + diffF * 0.45) * uSharp * activity;

      // Anti-halo color envelope clamp across fine & cardinal coarse neighbors
      vec3 minCol = min(c, min(min(min(n, s), min(e, w)), min(min(nC, sC), min(eC, wC))));
      vec3 maxCol = max(c, max(max(max(n, s), max(e, w)), max(max(nC, sC), max(eC, wC))));
      float overshoot = 0.08 * min(uSharp, 1.25);
      vec3 outCol = clamp(sharpened, max(vec3(0.0), minCol - overshoot), min(vec3(1.0), maxCol + overshoot));
      gl_FragColor = vec4(outCol, center.a);
    }`;

  function compile(gl, type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error('shader compile failed: ' + log);
    }
    return sh;
  }

  function makeTexture(gl) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    return tex;
  }

  /**
   * Create a reusable GPU resampler, or null if WebGL is unavailable.
   * @param {HTMLCanvasElement} [canvas] output canvas (created if omitted)
   */
  function create(canvas) {
    const out = canvas || document.createElement('canvas');
    let gl;
    try {
      gl = out.getContext('webgl', { premultipliedAlpha: false, preserveDrawingBuffer: true }) ||
           out.getContext('experimental-webgl', { premultipliedAlpha: false, preserveDrawingBuffer: true });
    } catch { gl = null; }
    if (!gl) return null;

    let program, casProgram, quad, srcTex, midTex, postTex, fbo, ready = false;
    try {
      const vs = compile(gl, gl.VERTEX_SHADER, VERT);
      const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
      const casFs = compile(gl, gl.FRAGMENT_SHADER, CAS_FRAG);
      program = gl.createProgram();
      gl.attachShader(program, vs); gl.attachShader(program, fs);
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));

      casProgram = gl.createProgram();
      gl.attachShader(casProgram, vs); gl.attachShader(casProgram, casFs);
      gl.linkProgram(casProgram);
      if (!gl.getProgramParameter(casProgram, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(casProgram));

      gl.deleteShader(vs); gl.deleteShader(fs); gl.deleteShader(casFs);

      quad = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, quad);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

      srcTex = makeTexture(gl);
      midTex = makeTexture(gl);
      postTex = makeTexture(gl);
      fbo = gl.createFramebuffer();
      ready = true;
    } catch (e) {
      return null; // hard fail -> caller uses CPU path
    }

    const uni = {
      tex: gl.getUniformLocation(program, 'uTex'),
      srcLen: gl.getUniformLocation(program, 'uSrcLen'),
      filter: gl.getUniformLocation(program, 'uFilter'),
      axis: gl.getUniformLocation(program, 'uAxis'),
    };
    const casUni = {
      tex: gl.getUniformLocation(casProgram, 'uTex'),
      texel: gl.getUniformLocation(casProgram, 'uTexel'),
      sharp: gl.getUniformLocation(casProgram, 'uSharp'),
      scale: gl.getUniformLocation(casProgram, 'uScale'),
    };
    const aPos = gl.getAttribLocation(program, 'aPos');
    const aCasPos = gl.getAttribLocation(casProgram, 'aPos');

    function drawPass(inputTex, targetTex, w, h, srcLen, filter, axis) {
      if (targetTex) {
        gl.bindTexture(gl.TEXTURE_2D, targetTex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, targetTex, 0);
      } else {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      }
      gl.viewport(0, 0, w, h);
      gl.useProgram(program);
      gl.bindBuffer(gl.ARRAY_BUFFER, quad);
      gl.enableVertexAttribArray(aPos);
      gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, inputTex);
      gl.uniform1i(uni.tex, 0);
      gl.uniform1f(uni.srcLen, srcLen);
      gl.uniform1f(uni.filter, filter);
      gl.uniform2f(uni.axis, axis[0], axis[1]);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    function drawCasPass(inputTex, w, h, sharpAmt, scaleFactor) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, w, h);
      gl.useProgram(casProgram);
      gl.bindBuffer(gl.ARRAY_BUFFER, quad);
      gl.enableVertexAttribArray(aCasPos);
      gl.vertexAttribPointer(aCasPos, 2, gl.FLOAT, false, 0, 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, inputTex);
      gl.uniform1i(casUni.tex, 0);
      gl.uniform2f(casUni.texel, 1 / Math.max(1, w), 1 / Math.max(1, h));
      gl.uniform1f(casUni.sharp, sharpAmt);
      gl.uniform1f(casUni.scale, Math.max(1, Number(scaleFactor) || 1));
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    /**
     * Resize `source` (video / canvas / ImageBitmap) to dw x dh on the GPU.
     * Optional `opts.sharpen` (0..1.5) runs a dual-scale detail recovery pass.
     */
    function resize(source, sw, sh, dw, dh, opts) {
      const sharp = opts && Number(opts.sharpen) > 0 ? Math.min(1.5, Number(opts.sharpen)) : 0;
      const scaleFactor = Math.max(dw / Math.max(1, sw), dh / Math.max(1, sh));
      out.width = dw; out.height = dh;
      gl.bindTexture(gl.TEXTURE_2D, srcTex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);

      const fx = dw < sw ? sw / dw : 1;
      const fy = dh < sh ? sh / dh : 1;

      drawPass(srcTex, midTex, dw, sh, sw, fx, [1, 0]);
      if (sharp > 0) {
        drawPass(midTex, postTex, dw, dh, sh, fy, [0, 1]);
        drawCasPass(postTex, dw, dh, sharp, scaleFactor);
      } else {
        drawPass(midTex, null, dw, dh, sh, fy, [0, 1]);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return out;
    }

    function dispose() {
      if (!ready) return;
      gl.deleteProgram(program);
      gl.deleteProgram(casProgram);
      gl.deleteBuffer(quad);
      gl.deleteTexture(srcTex);
      gl.deleteTexture(midTex);
      gl.deleteTexture(postTex);
      gl.deleteFramebuffer(fbo);
      ready = false;
    }

    return { canvas: out, gl, resize, dispose, renderer: 'webgl-cas' };
  }

  const api = { create };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.KapturaLanczosGL = api;
})(typeof self !== 'undefined' ? self : this);
