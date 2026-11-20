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
      'uniform float u_rawTime;',
      'uniform vec2 u_mouse;',
      'uniform vec4 u_ripples[4];',
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
      '  float minRes = min(u_res.x, u_res.y);',
      '  vec2 uv = (gl_FragCoord.xy - 0.5 * u_res.xy) / minRes;',
      '  vec2 m = (u_mouse - 0.5) * 0.45;',
      '  float t = u_time * 0.16;',
      '',
      '  vec2 rippleOffset = vec2(0.0);',
      '  float rippleCrest = 0.0;',
      '  for (int i = 0; i < 4; i++) {',
      '    vec4 rp = u_ripples[i];',
      '    float age = u_rawTime - rp.z;',
      '    if (rp.w > 0.01 && age >= 0.0 && age < 2.2) {',
      '      vec2 rPos = (rp.xy * u_res.xy - 0.5 * u_res.xy) / minRes;',
      '      vec2 diff = uv - rPos;',
      '      float d = length(diff);',
      '      vec2 dir = d > 0.0001 ? diff / d : vec2(0.0);',
      '      float radius = age * 0.72;',
      '      float packet = exp(-pow((d - radius) * 9.5, 2.0));',
      '      float train = sin((d - radius) * 42.0) * exp(-abs(d - radius) * 14.0);',
      '      float decay = exp(-age * 1.55) * rp.w;',
      '      rippleOffset += dir * train * decay * 0.048;',
      '      rippleCrest += max(0.0, train) * packet * decay;',
      '      float echoRadius = max(0.0, age - 0.14) * 0.50;',
      '      float echoRing = exp(-pow((d - echoRadius) * 14.0, 2.0)) * decay * 0.65;',
      '      float splashCore = exp(-d * d * 95.0) * exp(-age * 9.0) * rp.w;',
      '      rippleCrest += echoRing + splashCore * 1.15;',
      '    }',
      '  }',
      '',
      '  vec2 sampleUv = uv + rippleOffset;',
      '  vec2 q = vec2(fbm(sampleUv * 1.45 + vec2(t * 0.6, -t * 0.4) + m * 0.35),',
      '                fbm(sampleUv * 1.45 + vec2(-t * 0.5, t * 0.5)));',
      '  vec2 r = vec2(fbm(sampleUv * 1.85 + 2.2 * q + vec2(1.7, 9.2) + t * 0.35),',
      '                fbm(sampleUv * 1.85 + 2.2 * q + vec2(8.3, 2.8) - t * 0.28));',
      '  float f = fbm(sampleUv * 1.55 + 1.9 * r + m * 0.2);',
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
      '  col += vec3(0.18, 0.92, 1.0) * rippleCrest * 0.42;',
      '  col += vec3(0.0, 0.95, 0.65) * rippleCrest * 0.16;',
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
    const uRawTime = gl.getUniformLocation(prog, 'u_rawTime');
    const uMouse = gl.getUniformLocation(prog, 'u_mouse');
    const uRipples = [
      gl.getUniformLocation(prog, 'u_ripples[0]'),
      gl.getUniformLocation(prog, 'u_ripples[1]'),
      gl.getUniformLocation(prog, 'u_ripples[2]'),
      gl.getUniformLocation(prog, 'u_ripples[3]'),
    ];

    const bgRipples = [
      { x: -10, y: -10, t: -99, amp: 0 },
      { x: -10, y: -10, t: -99, amp: 0 },
      { x: -10, y: -10, t: -99, amp: 0 },
      { x: -10, y: -10, t: -99, amp: 0 },
    ];
    let bgRippleCursor = 0;

    let mouseX = 0.5;
    let mouseY = 0.35;
    let targetMouseX = 0.5;
    let targetMouseY = 0.35;
    let rafId = 0;
    const startTs = performance.now();
    const reduceMotion = root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches;

    function pushBgRipple(clientX, clientY, strength) {
      const w = Math.max(1, root.innerWidth || 1280);
      const h = Math.max(1, root.innerHeight || 720);
      const nx = Number.isFinite(clientX) ? Math.max(0, Math.min(1, clientX / w)) : 0.5;
      const ny = Number.isFinite(clientY) ? Math.max(0, Math.min(1, 1.0 - clientY / h)) : 0.5;
      bgRipples[bgRippleCursor] = {
        x: nx,
        y: ny,
        t: -1,
        amp: Math.max(0.15, Math.min(1.4, Number(strength) || 1.0)),
      };
      bgRippleCursor = (bgRippleCursor + 1) % 4;
      if (!rafId && !document.hidden) {
        rafId = requestAnimationFrame(drawFrame);
      }
    }

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
      const rawSec = (now - startTs) * 0.001;
      gl.uniform2f(uRes, canvas.width, canvas.height);
      gl.uniform1f(uTime, reduceMotion ? 0.5 : rawSec);
      if (uRawTime) gl.uniform1f(uRawTime, rawSec);
      gl.uniform2f(uMouse, mouseX, mouseY);
      for (let i = 0; i < 4; i++) {
        const rp = bgRipples[i];
        if (rp.amp > 0.01 && rp.t < 0) rp.t = rawSec;
        if (uRipples[i]) {
          gl.uniform4f(uRipples[i], rp.x, rp.y, rp.t, rp.amp);
        }
      }
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      const hasLiveRipple = bgRipples.some((rp) => rp.amp > 0.01 && (rp.t < 0 || (rawSec - rp.t) < 2.2));
      if (!reduceMotion || hasLiveRipple) {
        rafId = requestAnimationFrame(drawFrame);
      } else {
        rafId = 0;
      }
    }

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && !rafId && !reduceMotion) {
        rafId = requestAnimationFrame(drawFrame);
      }
    });

    rafId = requestAnimationFrame(drawFrame);
    return {
      pushRipple: pushBgRipple,
      stop: () => { if (rafId) cancelAnimationFrame(rafId); },
    };
  }

  let bgShaderHandle = null;
  const zoneWaterState = typeof WeakMap === 'function' ? new WeakMap() : null;
  let lastHoverTouchAt = 0;

  function spawnZoneWaterRipple(zoneEl, clientX, clientY, strength) {
    if (!zoneEl || typeof document === 'undefined') return;
    const rect = zoneEl.getBoundingClientRect();
    if (!rect || rect.width < 12 || rect.height < 12) return;

    const lx = Number.isFinite(clientX) ? Math.max(0, Math.min(rect.width, clientX - rect.left)) : rect.width * 0.5;
    const ly = Number.isFinite(clientY) ? Math.max(0, Math.min(rect.height, clientY - rect.top)) : rect.height * 0.5;
    const maxR = Math.hypot(Math.max(lx, rect.width - lx), Math.max(ly, rect.height - ly)) * 1.15;
    const durMs = strength >= 0.7 ? 1750 : 820;

    if (strength >= 0.7) {
      zoneEl.classList.remove('dz-absorbing');
      void zoneEl.offsetWidth;
      zoneEl.classList.add('dz-absorbing');
      clearTimeout(zoneEl._dzAbsorbTimer);
      zoneEl._dzAbsorbTimer = setTimeout(() => zoneEl.classList.remove('dz-absorbing'), 680);
    }

    let st = zoneWaterState ? zoneWaterState.get(zoneEl) : zoneEl._waterState;
    if (!st) {
      const cvs = document.createElement('canvas');
      cvs.className = 'dz-water-canvas';
      zoneEl.appendChild(cvs);
      st = { canvas: cvs, drops: [], rafId: 0 };
      if (zoneWaterState) zoneWaterState.set(zoneEl, st);
      else zoneEl._waterState = st;
    }

    const droplets = [];
    if (strength >= 0.7) {
      for (let k = 0; k < 12; k++) {
        const ang = (Math.PI * 2 * k) / 12 + (Math.random() - 0.5) * 0.32;
        droplets.push({
          ang,
          dist: 18 + Math.random() * 30,
          size: 1.6 + Math.random() * 2.1,
        });
      }
    }

    st.drops.push({
      x: lx,
      y: ly,
      t0: null,
      strength: Math.max(0.2, Math.min(1.2, Number(strength) || 1.0)),
      maxR,
      durMs,
      droplets,
    });
    if (st.drops.length > 6) st.drops.shift();

    const drawStep = (now) => {
      const rNow = zoneEl.getBoundingClientRect();
      const cssW = Math.max(10, Math.round(rNow.width || rect.width));
      const cssH = Math.max(10, Math.round(rNow.height || rect.height));
      const dpr = Math.min(2, root.devicePixelRatio || 1);
      const pxW = Math.round(cssW * dpr);
      const pxH = Math.round(cssH * dpr);
      if (st.canvas.width !== pxW || st.canvas.height !== pxH) {
        st.canvas.width = pxW;
        st.canvas.height = pxH;
      }
      const ctx = st.canvas.getContext('2d');
      if (!ctx) { st.rafId = 0; return; }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssW, cssH);

      const alive = [];
      for (let i = 0; i < st.drops.length; i++) {
        const d = st.drops[i];
        if (d.t0 === null) d.t0 = now;
        const elapsed = Math.max(0, now - d.t0);
        if (elapsed >= d.durMs) continue;
        alive.push(d);

        // 1. Stone entry absorption dimple + cyan plunge flash (0..320ms)
        if (elapsed < 320 && d.strength >= 0.7) {
          const coreP = elapsed / 320;
          const coreAlpha = (1 - coreP) * 0.65 * d.strength;
          const coreR = 8 + (1 - coreP) * 28;
          const grad = ctx.createRadialGradient(d.x, d.y, 0, d.x, d.y, coreR);
          grad.addColorStop(0, `rgba(2, 10, 22, ${(coreAlpha * 0.85).toFixed(3)})`);
          grad.addColorStop(0.35, `rgba(220, 255, 255, ${coreAlpha.toFixed(3)})`);
          grad.addColorStop(0.65, `rgba(0, 240, 255, ${(coreAlpha * 0.72).toFixed(3)})`);
          grad.addColorStop(1, 'rgba(0, 255, 157, 0)');
          ctx.fillStyle = grad;
          ctx.beginPath();
          ctx.arc(d.x, d.y, coreR, 0, Math.PI * 2);
          ctx.fill();
        }

        // 2. Crown micro-droplets radiating on plunge (0..500ms)
        if (elapsed < 500 && d.droplets.length) {
          const dp = elapsed / 500;
          const dEase = 1 - Math.pow(1 - dp, 2.4);
          const dAlpha = (1 - dp) * 0.9 * d.strength;
          ctx.fillStyle = `rgba(195, 253, 255, ${dAlpha.toFixed(3)})`;
          for (let k = 0; k < d.droplets.length; k++) {
            const p = d.droplets[k];
            const rx = d.x + Math.cos(p.ang) * p.dist * dEase;
            const ry = d.y + Math.sin(p.ang) * p.dist * dEase - Math.sin(dp * Math.PI) * 7;
            ctx.beginPath();
            ctx.arc(rx, ry, p.size * (1 - dp * 0.45), 0, Math.PI * 2);
            ctx.fill();
          }
        }

        // 3. Concentric capillary-gravity water ripples
        const ringCount = d.strength >= 0.7 ? 5 : 2;
        for (let k = 0; k < ringCount; k++) {
          const ringAge = elapsed - k * 85;
          if (ringAge < 0) continue;
          const ringSpan = d.durMs - k * 85;
          if (ringAge >= ringSpan || ringSpan <= 0) continue;
          const p = ringAge / ringSpan;
          const easeOut = Math.pow(p, 0.76);
          const r = 6 + d.maxR * easeOut;
          const env = Math.pow(1 - p, 1.3) * d.strength * (k === 0 ? 0.92 : Math.max(0.28, 0.74 - k * 0.1));
          if (env <= 0.01) continue;

          // Refraction dark trough ahead/inside the water crest
          ctx.strokeStyle = `rgba(2, 10, 24, ${(env * 0.62).toFixed(3)})`;
          ctx.lineWidth = Math.max(1.8, (6.0 - k * 0.75) * (1 - p * 0.4));
          ctx.beginPath();
          ctx.arc(d.x, d.y, Math.max(2, r - 2.5), 0, Math.PI * 2);
          ctx.stroke();

          // Luminous cyan/emerald/violet water crest
          ctx.save();
          if (k === 0) {
            ctx.shadowColor = 'rgba(0, 240, 255, 0.55)';
            ctx.shadowBlur = 8;
          }
          ctx.strokeStyle = k === 0
            ? `rgba(140, 250, 255, ${env.toFixed(3)})`
            : (k === 1
              ? `rgba(0, 240, 255, ${(env * 0.92).toFixed(3)})`
              : (k === 2
                ? `rgba(0, 255, 157, ${(env * 0.88).toFixed(3)})`
                : `rgba(168, 85, 247, ${(env * 0.78).toFixed(3)})`));
          ctx.lineWidth = Math.max(1.2, (4.2 - k * 0.55) * (1 - p * 0.55));
          ctx.beginPath();
          ctx.arc(d.x, d.y, r, 0, Math.PI * 2);
          ctx.stroke();
          ctx.restore();

          // Crisp outer specular meniscus highlight on primary crest
          if (k === 0 && p < 0.78) {
            ctx.strokeStyle = `rgba(245, 255, 255, ${(env * 0.65).toFixed(3)})`;
            ctx.lineWidth = 1.25;
            ctx.beginPath();
            ctx.arc(d.x, d.y, Math.max(2, r + 1.6), 0, Math.PI * 2);
            ctx.stroke();
          }
        }
      }

      st.drops = alive;
      if (alive.length > 0 && !document.hidden) {
        st.rafId = requestAnimationFrame(drawStep);
      } else {
        st.rafId = 0;
        ctx.clearRect(0, 0, cssW, cssH);
      }
    };

    if (!st.rafId) {
      st.rafId = requestAnimationFrame(drawStep);
    }
  }

  function triggerWaterDrop(clientX, clientY, strength = 1.0, zoneEl = null) {
    if (bgShaderHandle && typeof bgShaderHandle.pushRipple === 'function') {
      bgShaderHandle.pushRipple(clientX, clientY, strength);
    }
    if (zoneEl) {
      spawnZoneWaterRipple(zoneEl, clientX, clientY, strength);
    }
  }

  function triggerHoverTouch(clientX, clientY, zoneEl = null) {
    const now = performance.now();
    if (now - lastHoverTouchAt < 180) return;
    lastHoverTouchAt = now;
    triggerWaterDrop(clientX, clientY, 0.28, zoneEl);
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

  function buildChamferPath(W, H, R, cut, s) {
    const r = Math.min(R, Math.floor(W * 0.12), Math.floor(H * 0.25));
    const c = Math.min(cut, Math.floor(W * 0.16), Math.floor(H * 0.35));
    const f = Math.min(s, Math.floor(c * 0.34));
    const dx = Number((f * 0.7071).toFixed(2));
    return [
      `M ${r},0`,
      `L ${W - c - f},0`,
      `Q ${W - c},0 ${Number((W - c + dx).toFixed(2))},${dx}`,
      `L ${Number((W - dx).toFixed(2))},${Number((c - dx).toFixed(2))}`,
      `Q ${W},${c} ${W},${c + f}`,
      `L ${W},${H - r}`,
      `Q ${W},${H} ${W - r},${H}`,
      `L ${r},${H}`,
      `Q 0,${H} 0,${H - r}`,
      `L 0,${r}`,
      `Q 0,0 ${r},0`,
      'Z',
    ].join(' ');
  }

  function initStageChamferBevel() {
    const frame = document.getElementById('stageFrame');
    const svg = document.getElementById('stageChamferSvg');
    const clipPath = document.getElementById('stageChamferClipPath');
    const deepPath = document.getElementById('stageDeepShadowPath');
    const midPath = document.getElementById('stageMidBevelPath');
    const rimPath = document.getElementById('stageSpecularRimPath');
    if (!frame || !svg || !clipPath || !deepPath || !midPath || !rimPath) return;

    const sync = () => {
      const W = Math.max(120, Math.round(frame.clientWidth || frame.getBoundingClientRect().width));
      const H = Math.max(80, Math.round(frame.clientHeight || frame.getBoundingClientRect().height));
      svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
      svg.setAttribute('width', String(W));
      svg.setAttribute('height', String(H));
      const d = buildChamferPath(W, H, 20, 82, 18);
      clipPath.setAttribute('d', d);
      deepPath.setAttribute('d', d);
      midPath.setAttribute('d', d);
      rimPath.setAttribute('d', d);
    };

    sync();
    requestAnimationFrame(sync);
    root.addEventListener('load', sync, { passive: true });
    if (typeof ResizeObserver === 'function') {
      new ResizeObserver(sync).observe(frame);
    }
    root.addEventListener('resize', sync, { passive: true });
  }

  if (typeof document !== 'undefined') {
    const boot = () => {
      bgShaderHandle = initBackgroundShader();
      initInteractive3DBevels();
      initStageChamferBevel();
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
  }

  const api = {
    initBackgroundShader,
    initInteractive3DBevels,
    initStageChamferBevel,
    triggerWaterDrop,
    triggerHoverTouch,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.KapturaLiquidShader = api;
})(typeof self !== 'undefined' ? self : this);
