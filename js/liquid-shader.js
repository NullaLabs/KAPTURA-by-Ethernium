/**
 * KAPTURA >AAA LIQUID OBSIDIAN 3D SHADER ENGINE
 * Real-time GPU GLSL domain-warped liquid metal/obsidian background +
 * 3D perspective pointer tilt & specular bevel lighting on glass capsules.
 * Honors INV-06 Dual Mode (throttles/pauses when tab is hidden).
 */
(function (root) {
  'use strict';

  function initBackgroundShader() {
    const canvas = document.getElementById('liquidBgShader');
    if (!canvas) return null;

    const gl = canvas.getContext('webgl', { alpha: false, antialias: false, powerPreference: 'low-power' })
      || canvas.getContext('experimental-webgl');
    if (!gl) {
      canvas.classList.add('fallback-css');
      return null;
    }

    const vsSource = [
      'attribute vec2 a_pos;',
      'void main() {',
      '  gl_Position = vec4(a_pos, 0.0, 1.0);',
      '}',
    ].join('\n');

    const fsSource = [
      'precision mediump float;',
      'uniform vec2 u_res;',
      'uniform float u_time;',
      'uniform vec2 u_mouse;',
      '',
      'float hash(vec2 p) {',
      '  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);',
      '}',
      '',
      'float noise(vec2 p) {',
      '  vec2 i = floor(p);',
      '  vec2 f = fract(p);',
      '  vec2 u = f * f * (3.0 - 2.0 * f);',
      '  return mix(',
      '    mix(hash(i + vec2(0.0, 0.0)), hash(i + vec2(1.0, 0.0)), u.x),',
      '    mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),',
      '    u.y',
      '  );',
      '}',
      '',
      'float fbm(vec2 p) {',
      '  float v = 0.0;',
      '  float a = 0.5;',
      '  mat2 rot = mat2(0.80, -0.60, 0.60, 0.80);',
      '  for (int i = 0; i < 4; i++) {',
      '    v += a * noise(p);',
      '    p = rot * p * 2.05;',
      '    a *= 0.5;',
      '  }',
      '  return v;',
      '}',
      '',
      'void main() {',
      '  vec2 uv = (gl_FragCoord.xy - 0.5 * u_res.xy) / min(u_res.x, u_res.y);',
      '  vec2 m = (u_mouse - 0.5) * 0.45;',
      '  float t = u_time * 0.16;',
      '',
      '  vec2 q = vec2(fbm(uv * 1.45 + vec2(t * 0.6, -t * 0.4) + m * 0.35),',
      '                fbm(uv * 1.45 + vec2(-t * 0.5, t * 0.5)));',
      '  vec2 r = vec2(fbm(uv * 1.85 + 2.2 * q + vec2(1.7, 9.2) + t * 0.35),',
      '                fbm(uv * 1.85 + 2.2 * q + vec2(8.3, 2.8) - t * 0.28));',
      '  float f = fbm(uv * 1.55 + 1.9 * r + m * 0.2);',
      '',
      '  // Deep Obsidian base gradient + liquid satin veins',
      '  vec3 obsidian = vec3(0.008, 0.011, 0.020);',
      '  vec3 graphite = vec3(0.032, 0.044, 0.075);',
      '  vec3 cyanVein = vec3(0.0, 0.72, 0.88);',
      '  vec3 emeraldVein = vec3(0.0, 0.75, 0.52);',
      '  vec3 violetVein = vec3(0.38, 0.22, 0.85);',
      '',
      '  vec3 col = mix(obsidian, graphite, smoothstep(0.18, 0.78, f));',
      '  float caustic = smoothstep(0.56, 0.86, length(r) * 0.72);',
      '  float sheen = smoothstep(0.52, 0.94, f * q.x * 1.85);',
      '',
      '  col += cyanVein * caustic * 0.22;',
      '  col += emeraldVein * smoothstep(0.58, 0.92, q.y) * 0.14;',
      '  col += violetVein * sheen * 0.18;',
      '',
      '  // Mouse specular crystal glow + subtle vignette',
      '  float md = length(uv - m * 1.8);',
      '  col += vec3(0.06, 0.14, 0.22) * exp(-md * 2.8) * 0.65;',
      '  float vig = 1.0 - smoothstep(0.55, 1.55, length(uv));',
      '  col *= mix(0.45, 1.0, vig);',
      '',
      '  gl_FragColor = vec4(col, 1.0);',
      '}',
    ].join('\n');

    function compileShader(type, src) {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        gl.deleteShader(sh);
        return null;
      }
      return sh;
    }

    const vs = compileShader(gl.VERTEX_SHADER, vsSource);
    const fs = compileShader(gl.FRAGMENT_SHADER, fsSource);
    if (!vs || !fs) return null;

    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

    const aPos = gl.getAttribLocation(prog, 'a_pos');
    const uRes = gl.getUniformLocation(prog, 'u_res');
    const uTime = gl.getUniformLocation(prog, 'u_time');
    const uMouse = gl.getUniformLocation(prog, 'u_mouse');

    let mouseX = 0.5;
    let mouseY = 0.35;
    let targetMouseX = 0.5;
    let targetMouseY = 0.35;
    let rafId = 0;
    const startTs = performance.now();
    const reduceMotion = root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches;

    function resize() {
      const dpr = Math.min(1.5, root.devicePixelRatio || 1);
      const w = Math.max(320, Math.floor(root.innerWidth * dpr * 0.65));
      const h = Math.max(200, Math.floor(root.innerHeight * dpr * 0.65));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        gl.viewport(0, 0, w, h);
      }
    }

    root.addEventListener('resize', resize, { passive: true });
    root.addEventListener('pointermove', (e) => {
      targetMouseX = e.clientX / Math.max(1, root.innerWidth);
      targetMouseY = 1.0 - (e.clientY / Math.max(1, root.innerHeight));
    }, { passive: true });

    function drawFrame(now) {
      if (document.hidden) {
        rafId = 0;
        return;
      }
      mouseX += (targetMouseX - mouseX) * 0.06;
      mouseY += (targetMouseY - mouseY) * 0.06;

      resize();
      gl.useProgram(prog);
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.enableVertexAttribArray(aPos);
      gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
      gl.uniform2f(uRes, canvas.width, canvas.height);
      gl.uniform1f(uTime, reduceMotion ? 0.5 : (now - startTs) * 0.001);
      gl.uniform2f(uMouse, mouseX, mouseY);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      if (!reduceMotion) {
        rafId = requestAnimationFrame(drawFrame);
      }
    }

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && !rafId && !reduceMotion) {
        rafId = requestAnimationFrame(drawFrame);
      }
    });

    rafId = requestAnimationFrame(drawFrame);
    return { stop: () => { if (rafId) cancelAnimationFrame(rafId); } };
  }

  function initInteractive3DBevels() {
    const selector = '.btn, .tab-btn, .vault-btn, .control-card, .vault-card, .quick-hero-bar';
    document.addEventListener('pointermove', (e) => {
      const target = e.target && e.target.closest ? e.target.closest(selector) : null;
      if (!target) return;
      const rect = target.getBoundingClientRect();
      if (rect.width < 8 || rect.height < 8) return;
      const nx = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const ny = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
      const isRecessed = target.classList.contains('quick-hero-bar');
      const isCard = target.classList.contains('control-card') || target.classList.contains('vault-card');
      const maxDeg = isRecessed ? 0 : (isCard ? 2.0 : 4.6);
      const rx = ((0.5 - ny) * maxDeg).toFixed(2) + 'deg';
      const ry = ((nx - 0.5) * maxDeg).toFixed(2) + 'deg';
      target.style.setProperty('--mx', (nx * 100).toFixed(1) + '%');
      target.style.setProperty('--my', (ny * 100).toFixed(1) + '%');
      target.style.setProperty('--rx', rx);
      target.style.setProperty('--ry', ry);
    }, { passive: true });

    document.addEventListener('pointerout', (e) => {
      const target = e.target && e.target.closest ? e.target.closest(selector) : null;
      if (!target) return;
      if (e.relatedTarget && target.contains(e.relatedTarget)) return;
      target.style.setProperty('--rx', '0deg');
      target.style.setProperty('--ry', '0deg');
      target.style.setProperty('--mx', '50%');
      target.style.setProperty('--my', '18%');
    }, { passive: true });
  }

  if (typeof document !== 'undefined') {
    const boot = () => {
      initBackgroundShader();
      initInteractive3DBevels();
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
  }

  const api = { initBackgroundShader, initInteractive3DBevels };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.KapturaLiquidShader = api;
})(typeof self !== 'undefined' ? self : this);
