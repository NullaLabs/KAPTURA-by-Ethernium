/**
 * KAPTURA DUAL AUDIO MIXER
 * Combines System/Tab audio with Microphone capture via Web Audio API,
 * exposing live RMS VU meter telemetry and mixed MediaStreamAudioTrack output.
 */
(function (root) {
  'use strict';

  function createMixer() {
    let ctx = null;
    let dest = null;
    let micStream = null;
    let sysSource = null;
    let micSource = null;
    let sysGain = null;
    let micGain = null;
    let sysAnalyser = null;
    let micAnalyser = null;
    let sysBuf = null;
    let micBuf = null;

    function ensureContext() {
      const AC = root.AudioContext || root.webkitAudioContext;
      if (!AC) return false;
      if (!ctx) {
        ctx = new AC();
        dest = ctx.createMediaStreamDestination();
      }
      if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
        ctx.resume().catch(() => {});
      }
      return true;
    }

    function computeRms(analyser, buf) {
      if (!analyser || !buf) return 0;
      analyser.getByteTimeDomainData(buf);
      let sumSq = 0;
      for (let i = 0; i < buf.length; i++) {
        const n = (buf[i] - 128) / 128;
        sumSq += n * n;
      }
      return Math.min(1, Math.sqrt(sumSq / buf.length) * 2.4);
    }

    async function attach({ displayStream = null, micEnabled = false, systemMuted = false } = {}) {
      destroy();
      const sysTracks = displayStream ? displayStream.getAudioTracks() : [];
      const wantsSys = sysTracks.length > 0 && !systemMuted;
      if (!wantsSys && !micEnabled) return { active: false, hasSystem: false, hasMic: false };

      if (!ensureContext()) return { active: false, hasSystem: false, hasMic: false };

      let hasSystem = false;
      let hasMic = false;

      if (wantsSys) {
        const sysStream = new MediaStream(sysTracks);
        sysSource = ctx.createMediaStreamSource(sysStream);
        sysGain = ctx.createGain();
        sysGain.gain.value = systemMuted ? 0 : 1;
        sysAnalyser = ctx.createAnalyser();
        sysAnalyser.fftSize = 256;
        sysBuf = new Uint8Array(sysAnalyser.frequencyBinCount);
        sysSource.connect(sysGain);
        sysGain.connect(sysAnalyser);
        sysGain.connect(dest);
        hasSystem = true;
      }

      if (micEnabled && root.navigator && root.navigator.mediaDevices && root.navigator.mediaDevices.getUserMedia) {
        try {
          micStream = await root.navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
            video: false,
          });
          micSource = ctx.createMediaStreamSource(micStream);
          micGain = ctx.createGain();
          micGain.gain.value = 1;
          micAnalyser = ctx.createAnalyser();
          micAnalyser.fftSize = 256;
          micBuf = new Uint8Array(micAnalyser.frequencyBinCount);
          micSource.connect(micGain);
          micGain.connect(micAnalyser);
          micGain.connect(dest);
          hasMic = true;
        } catch {
          micStream = null;
          hasMic = false;
        }
      }

      return { active: hasSystem || hasMic, hasSystem, hasMic };
    }

    function setSystemGain(val) {
      if (sysGain) sysGain.gain.value = Math.max(0, Math.min(2, Number(val) || 0));
    }

    function setMicGain(val) {
      if (micGain) micGain.gain.value = Math.max(0, Math.min(2, Number(val) || 0));
    }

    function getLevels() {
      return {
        sys: sysGain && sysGain.gain.value === 0 ? 0 : computeRms(sysAnalyser, sysBuf),
        mic: micGain && micGain.gain.value === 0 ? 0 : computeRms(micAnalyser, micBuf),
      };
    }

    function getOutputTracks() {
      return dest && dest.stream ? dest.stream.getAudioTracks() : [];
    }

    function destroy() {
      try { if (sysSource) sysSource.disconnect(); } catch {}
      try { if (micSource) micSource.disconnect(); } catch {}
      if (micStream) {
        micStream.getTracks().forEach((t) => { try { t.stop(); } catch {} });
      }
      if (ctx && typeof ctx.close === 'function') {
        try { ctx.close(); } catch {}
      }
      ctx = null;
      dest = null;
      micStream = null;
      sysSource = null;
      micSource = null;
      sysGain = null;
      micGain = null;
      sysAnalyser = null;
      micAnalyser = null;
      sysBuf = null;
      micBuf = null;
    }

    return { attach, setSystemGain, setMicGain, getLevels, getOutputTracks, destroy };
  }

  const api = { createMixer };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.KapturaAudioMixer = api;
})(typeof self !== 'undefined' ? self : this);
