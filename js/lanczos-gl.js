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

    let program, quad, srcTex, midTex, fbo, ready = false;
    try {
      const vs = compile(gl, gl.VERTEX_SHADER, VERT);
      const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
      program = gl.createProgram();
      gl.attachShader(program, vs); gl.attachShader(program, fs);
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
      gl.deleteShader(vs); gl.deleteShader(fs);

      quad = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, quad);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

      srcTex = makeTexture(gl);
      midTex = makeTexture(gl);
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
    const aPos = gl.getAttribLocation(program, 'aPos');

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

    /**
     * Resize `source` (video / canvas / ImageBitmap) to dw x dh on the GPU.
     * Returns the output canvas (reused each call).
     */
    function resize(source, sw, sh, dw, dh) {
      out.width = dw; out.height = dh;
      // upload source (true = upright orientation matching 2D canvas)
      gl.bindTexture(gl.TEXTURE_2D, srcTex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);

      const fx = dw < sw ? sw / dw : 1;   // widen kernel when downscaling
      const fy = dh < sh ? sh / dh : 1;

      // pass 1: horizontal  src(sw x sh) -> mid(dw x sh)
      drawPass(srcTex, midTex, dw, sh, sw, fx, [1, 0]);
      // pass 2: vertical    mid(dw x sh) -> screen(dw x dh)
      drawPass(midTex, null, dw, dh, sh, fy, [0, 1]);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return out;
    }

    function dispose() {
      if (!ready) return;
      gl.deleteProgram(program);
      gl.deleteBuffer(quad);
      gl.deleteTexture(srcTex);
      gl.deleteTexture(midTex);
      gl.deleteFramebuffer(fbo);
      ready = false;
    }

    return { canvas: out, gl, resize, dispose, renderer: 'webgl' };
  }

  const api = { create };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.KapturaLanczosGL = api;
})(typeof self !== 'undefined' ? self : this);
