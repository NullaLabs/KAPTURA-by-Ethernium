/**
 * KAPTURA REAL VIDEO PIPELINE v2.0
 * Real FFmpeg NVENC/AMF/libx264 transcoding, Lanczos scaling, FontForge overlays,
 * and deterministic procedural PPM composition (zero lavfi testsrc).
 */

import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { detectVideoBackend, getOptimalGpuEncoderParams, probeGpuTelemetry } from "./gpuDirectOptimizer.mjs";
import { getCompanionStatus, resolveFontTtfPath, resolveRealEsrganExecutable, resolveRifeExecutable, runUpskaletor } from "../providers/adapters.mjs";

const ALLOWED_INPUT_EXTS = new Set([".webm", ".mp4", ".mov", ".mkv", ".avi", ".gif", ".png", ".jpg", ".jpeg", ".webp"]);
const IMAGE_AI_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".bmp", ".avif"]);

const activeTasks = new Map();

function killProcTree(proc) {
  if (!proc) return;
  if (process.platform === "win32" && proc.pid) {
    try {
      spawnSync("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { windowsHide: true, timeout: 4000 });
      return;
    } catch {}
  }
  try { proc.kill("SIGKILL"); } catch { try { proc.kill(); } catch {} }
}

export function registerTask(taskId) {
  if (!taskId) return null;
  let rec = activeTasks.get(taskId);
  if (!rec) {
    rec = { aborted: false, procs: new Set() };
    activeTasks.set(taskId, rec);
  }
  return rec;
}

export function unregisterTask(taskId) {
  if (taskId) activeTasks.delete(taskId);
}

export function isTaskAborted(taskId) {
  const rec = taskId ? activeTasks.get(taskId) : null;
  return Boolean(rec && rec.aborted);
}

export function trackChildProc(taskId, proc) {
  const rec = taskId ? activeTasks.get(taskId) : null;
  if (!rec || !proc) return () => {};
  rec.procs.add(proc);
  return () => { rec.procs.delete(proc); };
}

/** Soft thermal guard pausing cancelably if GPU reaches >= 86C between heavy segments. */
export async function applyThermalPacing({ taskId = "", onProgress = null, thresholdC = 86, pauseMs = 1800 } = {}) {
  if (isTaskAborted(taskId)) return false;
  const gpu = probeGpuTelemetry();
  if (!gpu || !gpu.available || gpu.tempC === null || gpu.tempC < thresholdC) return false;
  if (typeof onProgress === "function") {
    onProgress({ taskId, stage: "THERMAL_COOLING", gpuTempC: gpu.tempC });
  }
  const stepMs = 200;
  let waited = 0;
  while (waited < pauseMs) {
    if (isTaskAborted(taskId)) return false;
    await new Promise((r) => setTimeout(r, stepMs));
    waited += stepMs;
  }
  return true;
}

/** Cancel an active GPU transcode/neural task and terminate its child process tree cleanly. */
export function cancelTask(taskId) {
  if (!taskId) return { cancelled: false };
  const rec = activeTasks.get(taskId);
  if (!rec) return { cancelled: false };
  rec.aborted = true;
  for (const proc of rec.procs) {
    killProcTree(proc);
  }
  rec.procs.clear();
  return { cancelled: true };
}

function evenDim(n) {
  const v = Math.max(2, Math.round(Number(n) || 0));
  return v & ~1;
}

export function pruneOldExports(outputDir, maxAgeMs = 60 * 60 * 1000, maxFiles = 20) {
  try {
    if (!fs.existsSync(outputDir)) return;
    const now = Date.now();
    const files = fs.readdirSync(outputDir)
      .filter((name) => !name.startsWith("."))
      .map((name) => {
        const full = path.join(outputDir, name);
        try {
          const st = fs.statSync(full);
          return st.isFile() ? { full, mtimeMs: st.mtimeMs } : null;
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtimeMs - a.mtimeMs);

    files.forEach((entry, idx) => {
      if (idx >= maxFiles || now - entry.mtimeMs > maxAgeMs) {
        try { fs.unlinkSync(entry.full); } catch {}
      }
    });
  } catch {}
}

export function runFfmpegArgs(ffmpegPath, args, options = {}) {
  const opts = typeof options === "function" ? { onStderrLine: options } : (options || {});
  const { onStderrLine, onProgressMeta, totalDurationSec = 0, taskId = "" } = opts;

  if (isTaskAborted(taskId)) {
    return Promise.resolve({ code: -2, aborted: true, stderr: "Cancelled" });
  }

  return new Promise((resolve) => {
    const proc = spawn(ffmpegPath, args, { windowsHide: true });
    const untrack = trackChildProc(taskId, proc);
    let stderr = "";
    let stdoutBuf = "";
    let progressState = {};

    if (typeof onProgressMeta === "function") {
      proc.stdout.on("data", (chunk) => {
        stdoutBuf += chunk.toString();
        let nlIdx;
        while ((nlIdx = stdoutBuf.indexOf("\n")) !== -1) {
          const line = stdoutBuf.slice(0, nlIdx).trim();
          stdoutBuf = stdoutBuf.slice(nlIdx + 1);
          const eqIdx = line.indexOf("=");
          if (eqIdx === -1) continue;
          const k = line.slice(0, eqIdx).trim();
          const v = line.slice(eqIdx + 1).trim();
          progressState[k] = v;
          if (k === "progress") {
            const outUs = Number(progressState.out_time_us || 0);
            const outTimeSec = Number.isFinite(outUs) && outUs > 0 ? outUs / 1e6 : 0;
            const frame = Number(progressState.frame || 0) || 0;
            const speed = progressState.speed || "";
            const computedPct = totalDurationSec > 0
              ? Math.max(1, Math.min(99, Math.round((outTimeSec / totalDurationSec) * 100)))
              : Math.min(95, Math.max(10, Math.round(frame / 4)));
            onProgressMeta({
              frame,
              outTimeSec,
              speed,
              progress: v === "end" ? 100 : computedPct,
              done: v === "end",
            });
            progressState = {};
          }
        }
      });
    }

    proc.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      if (stderr.length > 16384) stderr = stderr.slice(-16384);
      if (typeof onStderrLine === "function") onStderrLine(text);
    });
    proc.on("error", (err) => { untrack(); resolve({ code: -1, stderr: String(err) }); });
    proc.on("close", (code) => { untrack(); resolve({ code: code ?? 1, aborted: isTaskAborted(taskId), stderr }); });
  });
}

/** Probe media duration (sec) and frame rate using FFmpeg banner stderr. */
async function probeDurationSec(ffmpegPath, inputPath) {
  const res = await runFfmpegArgs(ffmpegPath, ["-hide_banner", "-i", inputPath]);
  const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(res.stderr);
  if (!m) return 0;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

export async function probeMediaMeta(ffmpegPath, inputPath) {
  const res = await runFfmpegArgs(ffmpegPath, ["-hide_banner", "-i", inputPath]);
  const durM = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(res.stderr);
  const fpsM = /,\s*(\d+(?:\.\d+)?)\s*(?:fps|tbr)\b/.exec(res.stderr);
  const dimM = /Stream #[^\n]*?Video:[^\n]*?,\s*(\d{2,5})x(\d{2,5})\b/.exec(res.stderr);
  const vcodecM = /Stream #[^\n]*?Video:\s*([a-zA-Z0-9_]+)/.exec(res.stderr);
  const audM = /Stream #[^\n]*?Audio:\s*([a-zA-Z0-9_]+)/.exec(res.stderr);
  const brM = /bitrate:\s*(\d+)\s*kb\/s/i.exec(res.stderr);
  const duration = durM ? (Number(durM[1]) * 3600 + Number(durM[2]) * 60 + Number(durM[3])) : 0;
  const rawFps = fpsM ? Number(fpsM[1]) : 30;
  const fps = Number.isFinite(rawFps) && rawFps >= 5 && rawFps <= 240 ? rawFps : 30;
  const width = dimM ? Number(dimM[1]) : 0;
  const height = dimM ? Number(dimM[2]) : 0;
  const ext = path.extname(inputPath || "").toLowerCase();
  const isImage = IMAGE_AI_EXTS.has(ext) || (ext === ".gif" && duration <= 0.25);
  let sizeBytes = 0;
  try {
    if (inputPath && fs.existsSync(inputPath)) sizeBytes = fs.statSync(inputPath).size;
  } catch {}
  return {
    duration,
    fps,
    width,
    height,
    videoCodec: vcodecM ? vcodecM[1].toLowerCase() : null,
    bitrateKbps: brM ? Number(brM[1]) : 0,
    sizeBytes,
    isImage,
    hasAudio: Boolean(audM),
    audioCodec: audM ? audM[1] : null,
  };
}

export function estimateProfileEtas(meta = {}, providers = {}) {
  const w = Number(meta.width) || 0;
  const h = Number(meta.height) || 0;
  const fps = Math.max(1, Number(meta.fps) || 30);
  const dur = Math.max(0, Number(meta.duration) || 0);
  const isImg = Boolean(meta.isImage);
  if (isImg) {
    const mpx = Math.max(0.5, (w * h) / 1e6 || 1);
    return {
      isImage: true,
      frames: 1,
      "2k_cas": 1,
      "4k_cas": 1,
      "4k_ai": providers.realEsrgan ? Math.max(1, Math.round(1.4 + mpx * 0.6)) : null,
      restore_ai: providers.realEsrgan ? Math.max(1, Math.round(1.8 + mpx * 0.8)) : null,
      anime_ai: providers.realEsrgan ? Math.max(1, Math.round(0.8 + mpx * 0.4)) : null,
      "2x_super": 1,
      "4x_super": 1,
      bg_remove: providers.bgRemoval && providers.bgRemoval.birefnet ? 3 : 1,
    };
  }
  const effDur = dur > 0 ? dur : 5;
  const frames = Math.max(1, Math.round(effDur * fps));
  const already4k = w >= 3840;
  const already2k = w >= 2560;
  const cas2k = Math.max(1, Math.round(frames * (already2k ? 0.02 : 0.012) + 1));
  const cas4k = Math.max(1, Math.round(frames * (already4k ? 0.025 : 0.016) + 1));
  const esrganPerFrame = already4k ? 0.025 : (w >= 1200 ? 0.55 : (w >= 900 ? 0.9 : 0.45));
  const ai4k = providers.realEsrgan ? Math.max(2, Math.round(frames * esrganPerFrame + (already4k ? 1 : 2))) : null;
  const aiRestore = providers.realEsrgan ? Math.max(2, Math.round(frames * (already4k ? 0.028 : 1.05) + 2)) : null;
  const aiAnime = providers.realEsrgan ? Math.max(2, Math.round(frames * (already4k ? 0.025 : 0.38) + 2)) : null;
  const rifePerFrame = w >= 2560 ? 0.45 : (w >= 1280 ? 0.14 : 0.06);
  const rife2x = providers.rife ? Math.max(2, Math.round(frames * rifePerFrame + 2)) : null;
  const hybrid = providers.realEsrgan && providers.rife && ai4k !== null && rife2x !== null ? (ai4k + rife2x) : null;
  const hasCudaRvm = Boolean(providers.bgRemoval && providers.bgRemoval.rvmCuda);
  const bgPerFrame = hasCudaRvm ? 0.05 : (providers.bgRemoval && providers.bgRemoval.rvmOnnx ? 0.35 : 0.03);
  const bgRemove = Math.max(2, Math.round(frames * bgPerFrame + 2));
  return {
    isImage: false,
    frames,
    already4k,
    "2k_cas": cas2k,
    "4k_cas": cas4k,
    "4k_ai": ai4k,
    restore_ai: aiRestore,
    anime_ai: aiAnime,
    rife_2x: rife2x,
    hybrid_4k_rife: hybrid,
    bg_remove: bgRemove,
  };
}

export function buildIntegrityReceipt(srcMeta, outMeta, elapsedMs, expectedFpsRatio = 1) {
  const targetFps = (srcMeta.fps || 30) * expectedFpsRatio;
  const fpsDriftPct = targetFps > 0 && outMeta.fps > 0
    ? Number((((Math.abs(outMeta.fps - targetFps)) / targetFps) * 100).toFixed(2))
    : 0;
  const durationDriftMs = srcMeta.duration > 0 && outMeta.duration > 0
    ? Math.round(Math.abs(outMeta.duration - srcMeta.duration) * 1000)
    : 0;
  const pixelMultiplier = srcMeta.width > 0 && outMeta.width > 0
    ? Number(((outMeta.width * outMeta.height) / (srcMeta.width * srcMeta.height)).toFixed(2))
    : 1;
  return {
    srcWidth: srcMeta.width || 0,
    srcHeight: srcMeta.height || 0,
    outWidth: outMeta.width || 0,
    outHeight: outMeta.height || 0,
    srcFps: srcMeta.fps || 0,
    outFps: outMeta.fps || 0,
    fpsDriftPct,
    durationDriftMs,
    hasSrcAudio: Boolean(srcMeta.hasAudio),
    audioPreserved: srcMeta.hasAudio ? Boolean(outMeta.hasAudio) : null,
    audioCodec: outMeta.audioCodec || null,
    pixelMultiplier,
    elapsedMs: Math.round(elapsedMs || 0),
  };
}

function escapeDrawtext(text) {
  return String(text || "")
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'")
    .slice(0, 96);
}

/** Encode with NVENC/AMF and fallback once cleanly to libx264 only on hardware init error. */
export async function encodeWithSafeFallback({
  ffmpegPath,
  preArgs,
  container,
  codec = "auto",
  bitrateMbps,
  quality,
  outputPath,
  totalDurationSec = 0,
  onProgress,
  taskId = "",
}) {
  const primary = getOptimalGpuEncoderParams({ container, codec, bitrateMbps, quality });
  const progressFlags = typeof onProgress === "function" ? ["-progress", "pipe:1", "-nostats"] : [];
  const emitMeta = typeof onProgress === "function"
    ? (meta) => onProgress({
        taskId,
        stage: "ENCODING",
        progress: meta.progress,
        frame: meta.frame,
        outTimeSec: meta.outTimeSec,
        speed: meta.speed,
        codec: primary.codec,
      })
    : undefined;

  const primaryArgs = [...progressFlags, ...preArgs, ...primary.gpuFlags, "-movflags", "+faststart", outputPath];
  const res = await runFfmpegArgs(ffmpegPath, primaryArgs, {
    onProgressMeta: emitMeta,
    totalDurationSec,
    taskId,
  });
  if (res.aborted || isTaskAborted(taskId)) {
    return { ok: false, aborted: true, error: "Cancelled" };
  }
  if (res.code === 0 && fs.existsSync(outputPath)) {
    return { ok: true, codec: primary.codec, hardwareAccelerated: primary.hardwareAccelerated, fallbackCpu: false };
  }

  if (primary.hardwareAccelerated && primary.backend.encoders.libx264) {
    const emitCpuMeta = typeof onProgress === "function"
      ? (meta) => onProgress({
          taskId,
          stage: "ENCODING_CPU",
          progress: meta.progress,
          frame: meta.frame,
          outTimeSec: meta.outTimeSec,
          speed: meta.speed,
          codec: "libx264",
        })
      : undefined;
    const cpuArgs = [
      ...progressFlags,
      ...preArgs,
      "-c:v", "libx264",
      "-preset", quality === "fast" ? "veryfast" : "medium",
      "-pix_fmt", "yuv420p",
      ...(bitrateMbps > 0 ? ["-b:v", `${Math.max(150, Math.round(bitrateMbps * 1000))}k`] : ["-crf", "20"]),
      "-movflags", "+faststart",
      outputPath,
    ];
    const cpuRes = await runFfmpegArgs(ffmpegPath, cpuArgs, {
      onProgressMeta: emitCpuMeta,
      totalDurationSec,
      taskId,
    });
    if (cpuRes.code === 0 && fs.existsSync(outputPath)) {
      return { ok: true, codec: "libx264", hardwareAccelerated: false, fallbackCpu: true };
    }
    return { ok: false, error: cpuRes.stderr.slice(-500) };
  }

  return { ok: false, error: res.stderr.slice(-500) };
}

/** Generate real deterministic cybernetic PPM frame sequence (zero synthetic lavfi testsrc). */
function writeProceduralWaveFrames(framesDir, { width, height, fps, durationSec }) {
  const totalFrames = Math.max(2, Math.min(240, Math.round(fps * durationSec)));
  const header = Buffer.from(`P6\n${width} ${height}\n255\n`, "ascii");
  const frameBuf = Buffer.allocUnsafe(header.length + width * height * 3);
  header.copy(frameBuf, 0);

  for (let f = 0; f < totalFrames; f++) {
    const phase = (f / totalFrames) * Math.PI * 2;
    let offset = header.length;
    for (let y = 0; y < height; y++) {
      const ny = y / height;
      const band = Math.sin(ny * 10 + phase) * 0.5 + 0.5;
      for (let x = 0; x < width; x++) {
        const nx = x / width;
        const pulse = Math.sin(nx * 12 - phase * 2) * 0.5 + 0.5;
        frameBuf[offset++] = Math.round(6 + 24 * pulse * (1 - ny));
        frameBuf[offset++] = Math.round(28 + 185 * band * pulse);
        frameBuf[offset++] = Math.round(64 + 190 * (0.4 + 0.6 * band));
      }
    }
    fs.writeFileSync(path.join(framesDir, `frame_${String(f).padStart(4, "0")}.ppm`), frameBuf);
  }
  return totalFrames;
}

export async function createPreviewClip(ffmpegPath, inputPath, destPath, { previewSec = 2, previewStartSec = 0, taskId = "" } = {}) {
  const safeDur = Math.max(0.3, Math.min(5.0, Number(previewSec) || 2.0));
  const safeStart = Math.max(0, Number(previewStartSec) || 0);
  const args = [
    "-hide_banner", "-y",
    ...(safeStart > 0 ? ["-ss", safeStart.toFixed(3)] : []),
    "-i", inputPath,
    "-t", safeDur.toFixed(3),
    "-map", "0:v:0", "-map", "0:a?",
    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "12", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "192k",
    destPath,
  ];
  const res = await runFfmpegArgs(ffmpegPath, args, { taskId });
  if (res.aborted || isTaskAborted(taskId)) return { ok: false, aborted: true, error: "Cancelled" };
  if (res.code !== 0 || !fs.existsSync(destPath) || fs.statSync(destPath).size === 0) {
    return { ok: false, aborted: false, error: (res.stderr || "Preview slice failed").slice(-400) };
  }
  return { ok: true, duration: safeDur, startSec: safeStart };
}

/**
 * Transcode an actual input file or buffer cleanly into exports/ with Lanczos scaling & budget control.
 */
export async function transcodeMediaTask({
  inputPath = "",
  inputBuffer = null,
  inputExt = ".webm",
  outputDir = path.resolve(process.cwd(), "exports"),
  container = "mp4",
  codec = "auto",
  width = 0,
  height = 0,
  fps = 0,
  bitrateMbps = 0,
  targetMB = 0,
  quality = "high",
  sharpen = 0,
  cfr = false,
  textOverlay = "",
  startSec = 0,
  endSec = 0,
  previewSec = 0,
  previewStartSec = 0,
  taskId: providedTaskId = "",
  onProgress,
}) {
  if (!inputPath) {
    if (!inputBuffer) {
      return { success: false, status: "missing_input", error: "Input media path or buffer is required." };
    }
    if (inputBuffer.length === 0) {
      return { success: false, status: "empty_input", error: "Empty media buffer (0 bytes)." };
    }
  }
  const backend = detectVideoBackend();
  if (!backend.available || !backend.ffmpegPath) {
    return { success: false, status: "ffmpeg_unavailable", error: "FFmpeg binary not detected on host." };
  }

  fs.mkdirSync(outputDir, { recursive: true });
  pruneOldExports(outputDir);
  const taskId = providedTaskId || `transcode_${Date.now()}`;
  const cleanExt = ALLOWED_INPUT_EXTS.has(inputExt.toLowerCase()) ? inputExt.toLowerCase() : ".webm";
  let stagedInput = inputPath ? path.resolve(inputPath) : "";
  let createdTemp = false;
  registerTask(taskId);

  try {
    if (!stagedInput && inputBuffer) {
      if (inputBuffer.length === 0) {
        return { success: false, status: "empty_input", error: "Empty media buffer (0 bytes)." };
      }
      stagedInput = path.join(outputDir, `${taskId}_in${cleanExt}`);
      fs.writeFileSync(stagedInput, inputBuffer);
      createdTemp = true;
    }
    if (!stagedInput || !fs.existsSync(stagedInput)) {
      return { success: false, status: "missing_input", error: "Input media path or buffer is required." };
    }
    const inputStat = fs.statSync(stagedInput);
    if (inputStat.size === 0) {
      return { success: false, status: "empty_input", error: "Input media file is empty (0 bytes)." };
    }

    if (isTaskAborted(taskId)) {
      return { success: false, status: "cancelled", error: "Task cancelled by operator." };
    }

    const t0 = Date.now();
    if (typeof onProgress === "function") onProgress({ taskId, stage: "PROBING", progress: 5 });

    let trimStart = Math.max(0, Number(startSec) || 0);
    let trimEnd = Number(endSec) > trimStart ? Number(endSec) : 0;
    let srcMeta = await probeMediaMeta(backend.ffmpegPath, stagedInput);
    let previewApplied = false;
    let previewSourceFile = "";
    const reqPreviewSec = Number(previewSec) || 0;
    if (reqPreviewSec > 0 && !srcMeta.isImage) {
      if (typeof onProgress === "function") onProgress({ taskId, stage: "PREVIEW_SLICE", progress: 8 });
      const pDur = Math.max(0.3, Math.min(5.0, reqPreviewSec));
      const pStart = trimStart > 0
        ? trimStart
        : Math.max(0, Math.min(Math.max(0, (srcMeta.duration || 0) - pDur), Number(previewStartSec) || 0));
      const previewClip = path.join(outputDir, `.tmp_prevclip_${taskId}.mp4`);
      const sliceRes = await createPreviewClip(backend.ffmpegPath, stagedInput, previewClip, {
        previewSec: pDur,
        previewStartSec: pStart,
        taskId,
      });
      if (sliceRes.aborted || isTaskAborted(taskId)) {
        try { if (fs.existsSync(previewClip)) fs.unlinkSync(previewClip); } catch {}
        return { success: false, status: "cancelled", error: "Task cancelled by operator." };
      }
      if (sliceRes.ok) {
        if (createdTemp && stagedInput && fs.existsSync(stagedInput)) {
          try { fs.unlinkSync(stagedInput); } catch {}
        }
        stagedInput = previewClip;
        createdTemp = true;
        previewApplied = true;
        previewSourceFile = `preview_src_${taskId}.mp4`;
        try { fs.copyFileSync(previewClip, path.join(outputDir, previewSourceFile)); } catch { previewSourceFile = ""; }
        trimStart = 0;
        trimEnd = 0;
        srcMeta = await probeMediaMeta(backend.ffmpegPath, stagedInput);
      }
    }
    const probedDur = srcMeta.duration;
    const effectiveDur = trimEnd > 0
      ? Math.max(0.2, trimEnd - trimStart)
      : Math.max(0.2, probedDur > 0 ? Math.max(0.2, probedDur - trimStart) : 5);

    let computedBitrateMbps = Number(bitrateMbps) || 0;
    if (!computedBitrateMbps && targetMB > 0) {
      const budgetMbps = ((targetMB * 8 * 1024 * 1024 * 0.88) / effectiveDur) / 1e6;
      const sourceBitrateMbps = ((inputStat.size * 8) / (probedDur > 0.2 ? probedDur : effectiveDur)) / 1e6;
      const cappedMbps = inputStat.size <= targetMB * 1024 * 1024
        ? Math.min(budgetMbps, sourceBitrateMbps * 0.85)
        : budgetMbps;
      computedBitrateMbps = Math.max(0.25, cappedMbps);
    }

    const outExt = container === "webm" ? "webm" : "mp4";
    const outputFile = `${taskId}.${outExt}`;
    const outputPath = path.join(outputDir, outputFile);

    const filters = [];
    const outW = width > 0 ? evenDim(width) : 0;
    const scaleRatio = (srcMeta.width > 0 && outW > 0) ? (outW / srcMeta.width) : 1;
    if (outW > 0 && height > 0) {
      filters.push(`scale=${outW}:${evenDim(height)}:flags=lanczos`);
    } else if (outW > 0) {
      filters.push(`scale=${outW}:-2:flags=lanczos`);
    }
    const sharpNum = Number(sharpen) || 0;
    if (sharpNum > 0) {
      if (scaleRatio > 1.15) {
        const msize = scaleRatio >= 2.5 ? 7 : 5;
        const lumaAmt = Math.min(1.65, Math.max(0.35, sharpNum * 1.45)).toFixed(2);
        filters.push(`unsharp=${msize}:${msize}:${lumaAmt}:5:5:0.0`);
      }
      if (backend.filters && backend.filters.cas) {
        const casStr = Math.min(1.0, Math.max(0.20, sharpNum * 0.90)).toFixed(2);
        filters.push(`cas=strength=${casStr}`);
      } else if (scaleRatio <= 1.15) {
        const amt = Math.min(1.5, Math.max(0.25, sharpNum * 1.4)).toFixed(2);
        filters.push(`unsharp=5:5:${amt}:5:5:0.0`);
      }
    }
    if (textOverlay) {
      const ttf = resolveFontTtfPath();
      const fontArg = ttf ? `fontfile='${ttf.replace(/\\/g, "/").replace(/:/g, "\\:")}':` : "";
      filters.push(`drawtext=${fontArg}text='${escapeDrawtext(textOverlay)}':x=24:y=24:fontsize=20:fontcolor=0x00F0FF`);
    }

    const preArgs = ["-hide_banner", "-y"];
    if (trimStart > 0) preArgs.push("-ss", trimStart.toFixed(3));
    preArgs.push("-i", stagedInput);
    if (trimEnd > 0) preArgs.push("-t", (trimEnd - trimStart).toFixed(3));
    if (fps > 0) preArgs.push("-r", String(Math.round(fps)));
    if (cfr) preArgs.push("-fps_mode", "cfr");
    if (filters.length > 0) preArgs.push("-vf", filters.join(","));
    if (outExt === "mp4") preArgs.push("-c:a", "aac", "-b:a", "128k");

    if (typeof onProgress === "function") onProgress({ taskId, stage: "ENCODING", progress: 12 });
    const encRes = await encodeWithSafeFallback({
      ffmpegPath: backend.ffmpegPath,
      preArgs,
      container: outExt,
      codec,
      bitrateMbps: computedBitrateMbps,
      quality,
      outputPath,
      totalDurationSec: probedDur > 0 ? effectiveDur : 0,
      onProgress,
      taskId,
    });

    if (encRes.aborted || isTaskAborted(taskId)) {
      try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch {}
      return { success: false, status: "cancelled", error: "Task cancelled by operator." };
    }
    if (!encRes.ok) {
      return { success: false, status: "encode_failed", error: encRes.error };
    }

    const stat = fs.statSync(outputPath);
    const outMeta = await probeMediaMeta(backend.ffmpegPath, outputPath);
    const elapsedMs = Date.now() - t0;
    const integrity = buildIntegrityReceipt(
      trimEnd > 0 ? { ...srcMeta, duration: effectiveDur } : srcMeta,
      outMeta,
      elapsedMs,
      1
    );
    if (typeof onProgress === "function") onProgress({ taskId, stage: "COMPLETE", progress: 100 });
    return {
      success: true,
      status: "completed",
      taskId,
      outputFile,
      videoPath: outputPath,
      sizeBytes: stat.size,
      duration: outMeta.duration || effectiveDur,
      width: outMeta.width || (width ? evenDim(width) : srcMeta.width),
      height: outMeta.height || (height ? evenDim(height) : srcMeta.height),
      fps: outMeta.fps || srcMeta.fps,
      codec: encRes.codec,
      sharpenFilter: sharpNum > 0 ? (backend.filters && backend.filters.cas ? "cas" : "unsharp") : null,
      hardwareAccelerated: encRes.hardwareAccelerated,
      fallbackCpu: encRes.fallbackCpu,
      previewMode: previewApplied,
      previewSourceFile: previewSourceFile || undefined,
      previewSourceDownloadUrl: previewSourceFile ? `/exports/${previewSourceFile}` : undefined,
      integrity,
      providers: getCompanionStatus(),
    };
  } finally {
    unregisterTask(taskId);
    if (createdTemp && stagedInput && fs.existsSync(stagedInput)) {
      try { fs.unlinkSync(stagedInput); } catch {}
    }
  }
}

/**
 * Fast lossless stream-copy trim (-ss/-to -c copy) with automatic NVENC/x264 fallback when re-encoding is needed.
 */
export async function trimMediaTask({
  inputPath = "",
  inputBuffer = null,
  inputExt = ".mp4",
  outputDir = path.resolve(process.cwd(), "exports"),
  startSec = 0,
  endSec = 0,
  reencode = false,
  taskId: providedTaskId = "",
  onProgress,
}) {
  if (!inputPath && (!inputBuffer || inputBuffer.length === 0)) {
    return { success: false, status: "missing_input", error: "Input media path or buffer is required." };
  }
  const backend = detectVideoBackend();
  if (!backend.available || !backend.ffmpegPath) {
    return { success: false, status: "ffmpeg_unavailable", error: "FFmpeg binary not detected on host." };
  }

  fs.mkdirSync(outputDir, { recursive: true });
  pruneOldExports(outputDir);
  const taskId = providedTaskId || `trim_${Date.now()}`;
  const cleanExt = ALLOWED_INPUT_EXTS.has(inputExt.toLowerCase()) ? inputExt.toLowerCase() : ".mp4";
  let stagedInput = inputPath ? path.resolve(inputPath) : "";
  let createdTemp = false;

  try {
    if (!stagedInput && inputBuffer) {
      stagedInput = path.join(outputDir, `${taskId}_in${cleanExt}`);
      fs.writeFileSync(stagedInput, inputBuffer);
      createdTemp = true;
    }
    if (!stagedInput || !fs.existsSync(stagedInput)) {
      return { success: false, status: "missing_input", error: "Input media path does not exist." };
    }
    const trimStart = Math.max(0, Number(startSec) || 0);
    const trimEnd = Number(endSec) > trimStart ? Number(endSec) : 0;

    if (!reencode && (cleanExt === ".mp4" || cleanExt === ".mov" || cleanExt === ".webm")) {
      const outExt = cleanExt === ".webm" ? "webm" : "mp4";
      const outputFile = `${taskId}.${outExt}`;
      const outputPath = path.join(outputDir, outputFile);
      if (typeof onProgress === "function") onProgress({ taskId, stage: "TRIM_COPY", progress: 40 });
      const copyArgs = ["-hide_banner", "-y"];
      if (trimStart > 0) copyArgs.push("-ss", trimStart.toFixed(3));
      copyArgs.push("-i", stagedInput);
      if (trimEnd > 0) copyArgs.push("-t", (trimEnd - trimStart).toFixed(3));
      copyArgs.push("-c", "copy", "-avoid_negative_ts", "make_zero");
      if (outExt === "mp4") copyArgs.push("-movflags", "+faststart");
      copyArgs.push(outputPath);

      const copyRes = await runFfmpegArgs(backend.ffmpegPath, copyArgs);
      if (copyRes.code === 0 && fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
        const outDur = await probeDurationSec(backend.ffmpegPath, outputPath);
        if (typeof onProgress === "function") onProgress({ taskId, stage: "COMPLETE", progress: 100 });
        return {
          success: true,
          status: "completed",
          taskId,
          outputFile,
          videoPath: outputPath,
          sizeBytes: fs.statSync(outputPath).size,
          duration: outDur,
          codec: "copy",
          losslessCopy: true,
          hardwareAccelerated: false,
        };
      }
      try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch {}
    }

    return transcodeMediaTask({
      inputPath: stagedInput,
      inputExt: cleanExt,
      outputDir,
      container: cleanExt === ".webm" ? "webm" : "mp4",
      startSec: trimStart,
      endSec: trimEnd,
      quality: "high",
      taskId,
      onProgress,
    });
  } finally {
    if (createdTemp && stagedInput && fs.existsSync(stagedInput)) {
      try { fs.unlinkSync(stagedInput); } catch {}
    }
  }
}

/**
 * Disk-backed live streaming capture session for WebSocket /ws/capture.
 * - "pipe-media": writes MediaRecorder binary slices straight to disk (.part) and finalizes to NVENC MP4.
 * - "pipe-frames": pipes live MJPEG canvas frames directly into FFmpeg image2pipe -> NVENC MP4.
 */
export function createLiveCaptureSession({
  outputDir = path.resolve(process.cwd(), "exports"),
  mode = "pipe-media",
  inputExt = ".webm",
  fps = 30,
  container = "mp4",
  bitrateMbps = 0,
  quality = "high",
  onProgress,
} = {}) {
  const backend = detectVideoBackend();
  const taskId = `capture_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const workDir = path.join(outputDir, `.work_${taskId}`);
  fs.mkdirSync(outputDir, { recursive: true });
  fs.mkdirSync(workDir, { recursive: true });
  pruneOldExports(outputDir);

  const safeExt = ALLOWED_INPUT_EXTS.has(String(inputExt).toLowerCase()) ? String(inputExt).toLowerCase() : ".webm";
  const outExt = container === "webm" ? "webm" : "mp4";
  const outputFile = `${taskId}.${outExt}`;
  const outputPath = path.join(outputDir, outputFile);
  let bytesReceived = 0;
  let chunksReceived = 0;
  let closed = false;

  if (mode === "pipe-frames") {
    if (!backend.available || !backend.ffmpegPath) {
      throw new Error("FFmpeg binary not detected on host.");
    }
    const safeFps = Math.max(5, Math.min(60, Number(fps) || 30));
    const gpu = getOptimalGpuEncoderParams({ container: outExt, bitrateMbps, quality });
    const ffArgs = [
      "-hide_banner", "-y",
      "-f", "image2pipe",
      "-vcodec", "mjpeg",
      "-framerate", String(safeFps),
      "-i", "pipe:0",
      "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
      ...gpu.gpuFlags,
      "-movflags", "+faststart",
      outputPath,
    ];
    const proc = spawn(backend.ffmpegPath, ffArgs, { windowsHide: true });
    let stderr = "";
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
      if (stderr.length > 8192) stderr = stderr.slice(-8192);
    });
    const exitPromise = new Promise((resolve) => {
      proc.on("error", (err) => resolve({ code: -1, stderr: String(err) }));
      proc.on("close", (code) => resolve({ code: code ?? 1, stderr }));
    });

    return {
      taskId,
      mode,
      get stats() { return { bytesReceived, chunksReceived }; },
      writeChunk(buf) {
        if (closed || !buf || !buf.length || !proc.stdin.writable) return false;
        bytesReceived += buf.length;
        chunksReceived += 1;
        proc.stdin.write(buf);
        return true;
      },
      async finalize() {
        if (closed) return { success: false, error: "Session already closed" };
        closed = true;
        try { proc.stdin.end(); } catch {}
        const res = await exitPromise;
        try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
        if (chunksReceived === 0 || bytesReceived === 0) {
          return { success: false, status: "empty_input", error: "No frames streamed to capture socket." };
        }
        if (res.code !== 0 || !fs.existsSync(outputPath)) {
          return { success: false, status: "encode_failed", error: res.stderr.slice(-500) };
        }
        const duration = await probeDurationSec(backend.ffmpegPath, outputPath);
        if (typeof onProgress === "function") onProgress({ taskId, stage: "COMPLETE", progress: 100 });
        return {
          success: true,
          status: "completed",
          taskId,
          mode,
          outputFile,
          videoPath: outputPath,
          downloadUrl: `/exports/${outputFile}`,
          sizeBytes: fs.statSync(outputPath).size,
          duration,
          framesCount: chunksReceived,
          codec: gpu.codec,
          hardwareAccelerated: gpu.hardwareAccelerated,
        };
      },
      abort() {
        if (closed) return;
        closed = true;
        try { proc.kill("SIGKILL"); } catch {}
        try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
      },
    };
  }

  const partPath = path.join(workDir, `stream${safeExt}`);
  const writeStream = fs.createWriteStream(partPath);
  return {
    taskId,
    mode: "pipe-media",
    get stats() { return { bytesReceived, chunksReceived }; },
    writeChunk(buf) {
      if (closed || !buf || !buf.length) return false;
      bytesReceived += buf.length;
      chunksReceived += 1;
      writeStream.write(buf);
      return true;
    },
    async finalize() {
      if (closed) return { success: false, error: "Session already closed" };
      closed = true;
      await new Promise((resolve) => writeStream.end(resolve));
      try {
        if (bytesReceived === 0 || !fs.existsSync(partPath) || fs.statSync(partPath).size === 0) {
          return { success: false, status: "empty_input", error: "Live capture stream received 0 bytes." };
        }
        const res = await transcodeMediaTask({
          inputPath: partPath,
          inputExt: safeExt,
          outputDir,
          container: outExt,
          fps: Number(fps) || 0,
          bitrateMbps,
          quality,
          taskId,
          onProgress,
        });
        return {
          ...res,
          mode: "pipe-media",
          downloadUrl: res.outputFile ? `/exports/${res.outputFile}` : null,
        };
      } finally {
        try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
      }
    },
    abort() {
      if (closed) return;
      closed = true;
      try { writeStream.destroy(); } catch {}
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
    },
  };
}

/**
 * Sovereign render entrypoint supporting both real media inputs and procedural telemetry clips.
 */
export async function renderVideoTask({
  prompt = "Ethernium Sovereign Composition",
  durationSec = 2,
  resolution = "1280x720",
  fps = 30,
  inputPath = "",
  inputBase64 = "",
  inputExt = ".webm",
  container = "mp4",
  bitrateMbps = 0,
  targetMB = 0,
  quality = "high",
  upscale = false,
  outputDir = path.resolve(process.cwd(), "exports"),
  onProgress,
}) {
  if (inputPath || inputBase64) {
    const inputBuffer = inputBase64 ? Buffer.from(inputBase64, "base64") : null;
    const [rw, rh] = String(resolution).split("x").map(Number);
    return transcodeMediaTask({
      inputPath,
      inputBuffer,
      inputExt,
      outputDir,
      container,
      width: rw > 0 ? rw : 0,
      height: rh > 0 ? rh : 0,
      fps,
      bitrateMbps,
      targetMB,
      quality,
      textOverlay: prompt,
      onProgress,
    });
  }

  const backend = detectVideoBackend();
  if (!backend.available || !backend.ffmpegPath) {
    return {
      success: false,
      status: "ffmpeg_unavailable",
      prompt,
      duration: durationSec,
      resolution,
      error: "FFmpeg binary not detected on host.",
    };
  }

  const taskId = `render_${Date.now()}`;
  const workDir = path.join(outputDir, `.work_${taskId}`);
  const framesDir = path.join(workDir, "frames");
  fs.mkdirSync(framesDir, { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });
  pruneOldExports(outputDir);

  try {
    const [rawW, rawH] = String(resolution).split("x").map(Number);
    const width = evenDim(Math.min(1920, rawW || 640));
    const height = evenDim(Math.min(1080, rawH || 360));
    const safeFps = Math.max(10, Math.min(60, Number(fps) || 24));
    const safeDur = Math.max(0.5, Math.min(10, Number(durationSec) || 2));

    if (typeof onProgress === "function") onProgress({ taskId, stage: "SYNTHESIZING_FRAMES", progress: 25 });
    const frameCount = writeProceduralWaveFrames(framesDir, { width, height, fps: safeFps, durationSec: safeDur });

    const outputFile = `${taskId}.mp4`;
    const outputPath = path.join(outputDir, outputFile);
    const preArgs = [
      "-hide_banner", "-y",
      "-framerate", String(safeFps),
      "-i", path.join(framesDir, "frame_%04d.ppm"),
    ];
    const ttf = resolveFontTtfPath();
    if (ttf && prompt) {
      const fontArg = `fontfile='${ttf.replace(/\\/g, "/").replace(/:/g, "\\:")}':`;
      preArgs.push("-vf", `drawtext=${fontArg}text='${escapeDrawtext(prompt)}':x=(w-text_w)/2:y=(h-text_h)/2:fontsize=24:fontcolor=0x00F0FF`);
    }

    if (typeof onProgress === "function") onProgress({ taskId, stage: "ENCODING_NVENC", progress: 40 });
    const encRes = await encodeWithSafeFallback({
      ffmpegPath: backend.ffmpegPath,
      preArgs,
      container: "mp4",
      bitrateMbps,
      quality,
      outputPath,
      totalDurationSec: safeDur,
      onProgress,
      taskId,
    });

    if (!encRes.ok) {
      return { success: false, status: "encode_failed", prompt, duration: durationSec, resolution, error: encRes.error };
    }

    let upscaleInfo = null;
    if (upscale) {
      upscaleInfo = await runUpskaletor({ inputPath: outputPath, scaleFactor: 2 });
    }

    const stat = fs.statSync(outputPath);
    if (typeof onProgress === "function") onProgress({ taskId, stage: "COMPLETE", progress: 100 });
    return {
      success: true,
      status: "completed",
      taskId,
      prompt,
      duration: safeDur,
      resolution: `${width}x${height}`,
      frameCount,
      outputFile,
      videoPath: outputPath,
      sizeBytes: stat.size,
      codec: encRes.codec,
      hardwareAccelerated: encRes.hardwareAccelerated,
      fallbackCpu: encRes.fallbackCpu,
      upscale: upscaleInfo,
      providers: getCompanionStatus(),
    };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

export function runProcessArgs(binPath, args, cwd, opts = {}) {
  const { taskId = "", onOutputLine = null, stallTimeoutMs = 90_000 } = opts || {};
  if (isTaskAborted(taskId)) {
    return Promise.resolve({ code: -2, aborted: true, stalled: false, stdout: "", stderr: "Cancelled" });
  }
  return new Promise((resolve) => {
    const proc = spawn(binPath, args, { cwd: cwd || undefined, windowsHide: true });
    const untrack = trackChildProc(taskId, proc);
    let stdout = "";
    let stderr = "";
    let lineBuf = "";
    let lastActivityAt = Date.now();
    let stalled = false;
    let settled = false;

    const watchdog = stallTimeoutMs > 0
      ? setInterval(() => {
          if (!settled && Date.now() - lastActivityAt > stallTimeoutMs) {
            stalled = true;
            killProcTree(proc);
          }
        }, 3000)
      : null;
    if (watchdog && typeof watchdog.unref === "function") watchdog.unref();

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (watchdog) clearInterval(watchdog);
      untrack();
      resolve(result);
    };

    const pushChunk = (chunk, isErr) => {
      lastActivityAt = Date.now();
      const s = chunk.toString();
      if (isErr) {
        stderr += s;
        if (stderr.length > 16384) stderr = stderr.slice(-16384);
      } else {
        stdout += s;
        if (stdout.length > 16384) stdout = stdout.slice(-16384);
      }
      if (typeof onOutputLine === "function") {
        lineBuf += s;
        const parts = lineBuf.split(/[\r\n]+/);
        lineBuf = parts.pop() || "";
        for (const p of parts) {
          const trimmed = p.trim();
          if (trimmed) onOutputLine(trimmed);
        }
      }
    };
    proc.stdout.on("data", (d) => pushChunk(d, false));
    proc.stderr.on("data", (d) => pushChunk(d, true));
    proc.on("error", (err) => finish({ code: 1, aborted: false, stalled, stdout, stderr: err.message }));
    proc.on("close", (code) => finish({
      code: stalled ? -3 : (code ?? 1),
      aborted: isTaskAborted(taskId),
      stalled,
      stdout,
      stderr: stalled ? `${stderr}\nGPU process stalled (no frame progress for ${Math.round(stallTimeoutMs / 1000)}s)`.trim() : stderr,
    }));
  });
}

function resolveNeuralModelName(requestedModel, modelsDir, scale) {
  const safeScale = scale === 2 || scale === 3 ? scale : 4;
  const candidate = String(requestedModel || "realesrgan-x4plus").trim();
  const hasModel = (name) =>
    fs.existsSync(path.join(modelsDir, `${name}.param`)) ||
    fs.existsSync(path.join(modelsDir, `${name}-x${safeScale}.param`));

  if (hasModel(candidate)) return candidate;
  if (candidate === "realesr-general-x4v3" && hasModel("realesrgan-x4plus")) return "realesrgan-x4plus";
  if (hasModel("realesrgan-x4plus")) return "realesrgan-x4plus";
  if (hasModel("realesr-animevideov3")) return "realesr-animevideov3";
  return candidate;
}

/**
 * Neural super-resolution (Real-ESRGAN) & motion interpolation (RIFE v4.6) via NCNN Vulkan.
 */
export async function upscaleAiTask({
  inputPath = "",
  inputBuffer = null,
  inputExt = ".mp4",
  outputDir = path.resolve(process.cwd(), "exports"),
  pipeline = "esrgan",
  model = "realesrgan-x4plus",
  scale = 4,
  rifeMult = 2,
  rifeModel = "rife-v4.6",
  width = 0,
  height = 0,
  denoise = false,
  sharpen = null,
  quality = "high",
  codec = "auto",
  previewSec = 0,
  previewStartSec = 0,
  taskId: providedTaskId = "",
  onProgress,
}) {
  if (!inputPath && !inputBuffer) {
    return { success: false, status: "missing_input", error: "Input media path or buffer is required." };
  }
  if (!inputPath && inputBuffer && inputBuffer.length === 0) {
    return { success: false, status: "empty_input", error: "Empty media buffer (0 bytes)." };
  }

  const mode = ["esrgan", "rife", "hybrid"].includes(String(pipeline).toLowerCase())
    ? String(pipeline).toLowerCase()
    : "esrgan";
  const needsEsrgan = mode === "esrgan" || mode === "hybrid";
  const needsRife = mode === "rife" || mode === "hybrid";

  const realEsrganPath = resolveRealEsrganExecutable();
  const rifePath = resolveRifeExecutable();

  if (needsEsrgan && !realEsrganPath) {
    return {
      success: false,
      status: "realesrgan_unavailable",
      error: "realesrgan-ncnn-vulkan binary not detected on host (PATH / ETHERNIUM_REALESRGAN_PATH / UPSKALETOR).",
      providers: getCompanionStatus(),
    };
  }
  if (needsRife && !rifePath) {
    return {
      success: false,
      status: "rife_unavailable",
      error: "rife-ncnn-vulkan binary not detected on host (PATH / ETHERNIUM_RIFE_PATH / UPSKALETOR).",
      providers: getCompanionStatus(),
    };
  }

  const t0 = Date.now();
  fs.mkdirSync(outputDir, { recursive: true });
  pruneOldExports(outputDir);
  const taskId = providedTaskId || `${mode}_${Date.now()}`;
  const cleanExt = ALLOWED_INPUT_EXTS.has(inputExt.toLowerCase()) ? inputExt.toLowerCase() : ".mp4";
  const isImage = IMAGE_AI_EXTS.has(cleanExt);
  const workDir = path.join(outputDir, `.tmp_${taskId}`);
  fs.mkdirSync(workDir, { recursive: true });
  registerTask(taskId);

  try {
    let stagedInput = inputPath ? path.resolve(inputPath) : "";
    if (!stagedInput && inputBuffer) {
      stagedInput = path.join(workDir, `input${cleanExt}`);
      fs.writeFileSync(stagedInput, inputBuffer);
    }
    if (!stagedInput || !fs.existsSync(stagedInput)) {
      return { success: false, status: "missing_input", error: "Input media path or buffer is required." };
    }
    if (fs.statSync(stagedInput).size === 0) {
      return { success: false, status: "empty_input", error: "Input media file is empty (0 bytes)." };
    }

    const backend = detectVideoBackend();
    const safeScale = scale === 2 || scale === 3 ? scale : 4;
    const safeMult = Math.max(2, Math.min(4, Math.round(Number(rifeMult) || 2)));
    const hasExplicitSharp = sharpen !== null && sharpen !== undefined && Number.isFinite(Number(sharpen));
    const effectiveSharp = hasExplicitSharp ? Math.max(0, Number(sharpen)) : (needsEsrgan ? 0.35 : 0);
    const casPostStrength = effectiveSharp > 0 && backend.filters && backend.filters.cas
      ? Math.min(0.60, Math.max(0.15, hasExplicitSharp ? effectiveSharp * 0.45 : effectiveSharp))
      : 0;

    if (isImage) {
      if (!realEsrganPath) {
        return { success: false, status: "invalid_mode_for_image", error: "RIFE frame interpolation only applies to video." };
      }
      const binDir = path.dirname(realEsrganPath);
      const modelsDir = path.join(binDir, "models");
      const activeModel = resolveNeuralModelName(model, modelsDir, safeScale);
      if (typeof onProgress === "function") onProgress({ taskId, stage: "NEURAL_INFER", progress: 20 });
      const rawOut = path.join(workDir, "neural_out.png");
      const finalOut = `${taskId}.png`;
      const finalPath = path.join(outputDir, finalOut);
      const buildImgArgs = (tileVal, threadsVal) => [
        "-i", stagedInput, "-o", rawOut, "-m", modelsDir, "-n", activeModel,
        "-s", String(safeScale), "-j", threadsVal,
        ...(tileVal > 0 ? ["-t", String(tileVal)] : []),
        "-f", "png", "-v",
      ];
      const runImgAttempt = (tileVal, threadsVal) => runProcessArgs(realEsrganPath, buildImgArgs(tileVal, threadsVal), binDir, {
        taskId,
        onOutputLine: (line) => {
          const m = /(\d+)[.,]\d+%/.exec(line);
          if (m && typeof onProgress === "function") {
            const pct = Math.max(20, Math.min(92, 20 + Math.round(Number(m[1]) * 0.72)));
            onProgress({ taskId, stage: "NEURAL_INFER", progress: pct });
          }
        },
      });
      let res = await runImgAttempt(256, "1:1:2");
      if (res.stalled && !res.aborted && !isTaskAborted(taskId)) {
        try { if (fs.existsSync(rawOut)) fs.unlinkSync(rawOut); } catch {}
        res = await runImgAttempt(128, "1:1:1");
      }
      if (res.aborted || isTaskAborted(taskId)) {
        return { success: false, status: "cancelled", error: "Task cancelled by operator." };
      }
      if (res.stalled) {
        return { success: false, status: "gpu_stalled", error: res.stderr || "Real-ESRGAN image inference stalled." };
      }
      if (res.code !== 0 || !fs.existsSync(rawOut)) {
        return { success: false, status: "ai_failed", error: (res.stderr || "Real-ESRGAN image inference failed").slice(-500) };
      }

      if ((width > 0 || denoise || casPostStrength > 0) && backend.available && backend.ffmpegPath) {
        const filters = [];
        if (denoise) filters.push("hqdn3d=1.2:1.2:4:4");
        if (width > 0) filters.push(height > 0 ? `scale=${evenDim(width)}:${evenDim(height)}:flags=lanczos` : `scale=${evenDim(width)}:-2:flags=lanczos`);
        if (casPostStrength > 0) filters.push(`cas=strength=${casPostStrength.toFixed(2)}`);
        await runFfmpegArgs(backend.ffmpegPath, ["-hide_banner", "-y", "-i", rawOut, "-vf", filters.join(","), finalPath], { taskId });
        if (isTaskAborted(taskId)) return { success: false, status: "cancelled", error: "Task cancelled by operator." };
      } else {
        fs.copyFileSync(rawOut, finalPath);
      }

      const stat = fs.statSync(finalPath);
      const outMeta = backend.available && backend.ffmpegPath ? await probeMediaMeta(backend.ffmpegPath, finalPath) : { width, height, fps: 0, duration: 0 };
      const elapsedMs = Date.now() - t0;
      if (typeof onProgress === "function") onProgress({ taskId, stage: "COMPLETE", progress: 100 });
      return {
        success: true,
        status: "completed",
        taskId,
        pipeline: mode,
        outputFile: finalOut,
        videoPath: finalPath,
        sizeBytes: stat.size,
        width: outMeta.width || width,
        height: outMeta.height || height,
        model: activeModel,
        neural: true,
        hardwareAccelerated: true,
        integrity: { elapsedMs },
        providers: getCompanionStatus(),
      };
    }

    if (!backend.available || !backend.ffmpegPath) {
      return { success: false, status: "ffmpeg_unavailable", error: "FFmpeg binary required for video neural reconstruction." };
    }

    if (typeof onProgress === "function") onProgress({ taskId, stage: "SEGMENT_PREP", progress: 8 });
    let srcMeta = await probeMediaMeta(backend.ffmpegPath, stagedInput);
    let previewApplied = false;
    let previewSourceFile = "";
    const reqPreviewSec = Number(previewSec) || 0;
    if (reqPreviewSec > 0) {
      const pDur = Math.max(0.3, Math.min(5.0, reqPreviewSec));
      const pStart = Math.max(0, Math.min(Math.max(0, (srcMeta.duration || 0) - pDur), Number(previewStartSec) || 0));
      const previewClipPath = path.join(workDir, "preview_clip.mp4");
      if (typeof onProgress === "function") onProgress({ taskId, stage: "PREVIEW_SLICE", progress: 9 });
      const sliceRes = await createPreviewClip(backend.ffmpegPath, stagedInput, previewClipPath, {
        previewSec: pDur,
        previewStartSec: pStart,
        taskId,
      });
      if (sliceRes.aborted || isTaskAborted(taskId)) {
        return { success: false, status: "cancelled", error: "Task cancelled by operator." };
      }
      if (sliceRes.ok) {
        stagedInput = previewClipPath;
        previewApplied = true;
        previewSourceFile = `preview_src_${taskId}.mp4`;
        try { fs.copyFileSync(previewClipPath, path.join(outputDir, previewSourceFile)); } catch { previewSourceFile = ""; }
        srcMeta = await probeMediaMeta(backend.ffmpegPath, stagedInput);
      }
    }
    const probedDur = Math.max(0.2, srcMeta.duration);
    const sourceFps = srcMeta.fps || 30;
    const expectedFpsRatio = needsRife ? safeMult : 1;
    const targetFps = Math.round(sourceFps * expectedFpsRatio * 1000) / 1000;

    if (mode === "esrgan" && width > 0 && srcMeta.width >= width) {
      const outW = evenDim(srcMeta.width);
      const outH = evenDim(srcMeta.height);
      const vf = [];
      if (denoise) vf.push("hqdn3d=1.1:1.1:3.5:3.5");
      if (effectiveSharp > 0) {
        const lumaAmt = Math.min(1.55, Math.max(0.30, effectiveSharp * 1.15)).toFixed(2);
        vf.push(`unsharp=5:5:${lumaAmt}:5:5:0.0`);
        if (casPostStrength > 0) vf.push(`cas=strength=${casPostStrength.toFixed(2)}`);
      }
      const outputFile = `${taskId}.mp4`;
      const outputPath = path.join(outputDir, outputFile);
      const preArgs = ["-hide_banner", "-y", "-i", stagedInput, "-fps_mode", "cfr", "-map", "0:v:0", "-map", "0:a?", "-c:a", "copy"];
      if (vf.length > 0) preArgs.push("-vf", vf.join(","));
      if (typeof onProgress === "function") {
        onProgress({ taskId, stage: "GPU_ENHANCE_4K", model: "gpu-native-cas", scale: 1, progress: 14 });
      }
      const encRes = await encodeWithSafeFallback({
        ffmpegPath: backend.ffmpegPath,
        preArgs,
        container: "mp4",
        codec,
        bitrateMbps: 42,
        quality,
        outputPath,
        totalDurationSec: srcMeta.duration || probedDur,
        onProgress: typeof onProgress === "function"
          ? (ev) => onProgress({ ...ev, stage: "GPU_ENHANCE_4K", model: "gpu-native-cas", scale: 1 })
          : undefined,
        taskId,
      });
      if (encRes.aborted || isTaskAborted(taskId)) {
        try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch {}
        return { success: false, status: "cancelled", error: "Task cancelled by operator." };
      }
      if (!encRes.ok || !fs.existsSync(outputPath)) {
        return { success: false, status: "encode_failed", error: encRes.error || "Native 4K GPU enhancement failed" };
      }
      const stat = fs.statSync(outputPath);
      const outMeta = await probeMediaMeta(backend.ffmpegPath, outputPath);
      const elapsedMs = Date.now() - t0;
      const integrity = buildIntegrityReceipt(srcMeta, outMeta, elapsedMs, 1);
      if (typeof onProgress === "function") onProgress({ taskId, stage: "COMPLETE", progress: 100 });
      return {
        success: true,
        status: "completed",
        taskId,
        pipeline: mode,
        outputFile,
        videoPath: outputPath,
        sizeBytes: stat.size,
        duration: outMeta.duration || probedDur,
        width: outMeta.width || outW,
        height: outMeta.height || outH,
        fps: outMeta.fps || sourceFps,
        model: "gpu-native-cas (source already >= target)",
        sourceAlreadyTarget: true,
        scale: 1,
        neural: false,
        hardwareAccelerated: encRes.hardwareAccelerated,
        previewMode: previewApplied,
        previewSourceFile: previewSourceFile || undefined,
        previewSourceDownloadUrl: previewSourceFile ? `/exports/${previewSourceFile}` : undefined,
        integrity,
        providers: getCompanionStatus(),
      };
    }

    const esrganBinDir = realEsrganPath ? path.dirname(realEsrganPath) : "";
    const esrganModelsDir = esrganBinDir ? path.join(esrganBinDir, "models") : "";
    let effectiveModel = needsEsrgan ? resolveNeuralModelName(model, esrganModelsDir, safeScale) : rifeModel;
    const neededScale = (width > 0 && srcMeta.width > 0) ? Math.ceil(width / srcMeta.width) : safeScale;
    let effectiveScale = safeScale;
    if (needsEsrgan) {
      if (
        srcMeta.width >= 1200 &&
        width > 0 &&
        width <= 3840 &&
        neededScale <= 2 &&
        effectiveModel === "realesrgan-x4plus" &&
        fs.existsSync(path.join(esrganModelsDir, "realesr-animevideov3-x2.param"))
      ) {
        effectiveModel = "realesr-animevideov3";
        effectiveScale = 2;
      } else if (effectiveModel === "realesr-animevideov3") {
        effectiveScale = neededScale <= 2 ? 2 : (neededScale === 3 ? 3 : safeScale);
      }
    }

    const rifeBinDir = rifePath ? path.dirname(rifePath) : "";
    let resolvedRifeModelDir = rifeModel;
    if (needsRife && rifeBinDir) {
      const candidateDir = path.join(rifeBinDir, rifeModel);
      if (fs.existsSync(candidateDir)) resolvedRifeModelDir = candidateDir;
    }

    const segDir = path.join(workDir, "segments");
    const outSegDir = path.join(workDir, "out_segments");
    fs.mkdirSync(segDir, { recursive: true });
    fs.mkdirSync(outSegDir, { recursive: true });

    const targetFramesPerSeg = srcMeta.width >= 1600 ? 60 : 90;
    const segSeconds = Math.max(1.0, Math.min(4, Math.round((targetFramesPerSeg / Math.max(15, sourceFps)) * 10) / 10));
    const segRes = await runFfmpegArgs(backend.ffmpegPath, [
      "-hide_banner", "-y", "-i", stagedInput,
      "-c:v", "copy", "-an", "-f", "segment", "-segment_time", String(segSeconds), "-reset_timestamps", "1",
      path.join(segDir, "seg_%04d.mp4"),
    ], { taskId });
    if (segRes.aborted || isTaskAborted(taskId)) {
      return { success: false, status: "cancelled", error: "Task cancelled by operator." };
    }
    if (segRes.code !== 0) {
      fs.copyFileSync(stagedInput, path.join(segDir, "seg_0000.mp4"));
    }
    const segFiles = fs.readdirSync(segDir).filter((f) => f.endsWith(".mp4")).sort();
    if (segFiles.length === 0) {
      return { success: false, status: "segment_failed", error: "No video segments produced for neural pass." };
    }

    const primaryTile = srcMeta.width >= 2000 ? 160 : (srcMeta.width >= 1600 ? 200 : (srcMeta.width >= 960 ? 256 : 0));
    const estTotalFrames = Math.max(1, Math.round(probedDur * sourceFps));
    let globalFramesDone = 0;
    const inferStartMs = Date.now();
    const concatList = [];
    for (let i = 0; i < segFiles.length; i++) {
      if (isTaskAborted(taskId)) return { success: false, status: "cancelled", error: "Task cancelled by operator." };
      const segBase = 10 + (i / segFiles.length) * 82;
      const segSpan = 82 / segFiles.length;
      const segIn = path.join(segDir, segFiles[i]);
      const framesIn = path.join(workDir, `f_in_${i}`);
      fs.mkdirSync(framesIn, { recursive: true });
      if (typeof onProgress === "function") {
        onProgress({
          taskId,
          stage: "EXTRACT_SEG",
          segment: i + 1,
          totalSegments: segFiles.length,
          model: effectiveModel,
          scale: effectiveScale,
          progress: Math.min(90, Math.round(segBase)),
        });
      }

      const exRes = await runFfmpegArgs(backend.ffmpegPath, [
        "-hide_banner", "-y", "-i", segIn, path.join(framesIn, "f_%06d.png"),
      ], { taskId });
      if (exRes.aborted || isTaskAborted(taskId)) {
        return { success: false, status: "cancelled", error: "Task cancelled by operator." };
      }
      if (exRes.code !== 0) {
        return { success: false, status: "extract_failed", error: exRes.stderr.slice(-500) };
      }

      const rawCount = Math.max(1, fs.readdirSync(framesIn).filter((f) => f.endsWith(".png")).length);
      let currentFramesDir = framesIn;
      let inputPattern = "f_%06d.png";
      let startNumber = 1;

      if (needsEsrgan) {
        const framesSr = path.join(workDir, `f_sr_${i}`);
        fs.mkdirSync(framesSr, { recursive: true });
        const buildEsrganArgs = (tileVal, threadsVal) => [
          "-i", currentFramesDir, "-o", framesSr,
          "-m", esrganModelsDir, "-n", effectiveModel,
          "-s", String(effectiveScale),
          "-j", threadsVal,
          ...(tileVal > 0 ? ["-t", String(tileVal)] : []),
          "-f", "png", "-v",
        ];
        const runEsrganAttempt = async (tileVal, threadsVal) => {
          let doneFrames = 0;
          let lastEmitAt = 0;
          const srBase = segBase;
          const srSpan = needsRife ? segSpan * 0.5 : segSpan * 0.85;
          const emitEsrganProgress = (subFrac = 0, forceEmit = false) => {
            if (typeof onProgress !== "function") return;
            const now = Date.now();
            if (!forceEmit && now - lastEmitAt < 450) return;
            lastEmitAt = now;
            const localFrac = Math.min(1, (doneFrames + subFrac) / rawCount);
            const completedTotal = globalFramesDone + doneFrames + subFrac;
            const elapsedSec = Math.max(0.1, (now - inferStartMs) / 1000);
            const secPerFrame = completedTotal >= 0.5 ? elapsedSec / completedTotal : null;
            const etaSec = secPerFrame ? Math.round(Math.max(0, estTotalFrames - completedTotal) * secPerFrame) : null;
            onProgress({
              taskId,
              stage: "ESRGAN",
              frame: doneFrames,
              totalFrames: rawCount,
              segment: i + 1,
              totalSegments: segFiles.length,
              secPerFrame: secPerFrame ? Number(secPerFrame.toFixed(2)) : null,
              etaSec,
              model: effectiveModel,
              scale: effectiveScale,
              progress: Math.min(91, Math.round(srBase + localFrac * srSpan)),
            });
          };
          emitEsrganProgress(0, true);
          return runProcessArgs(realEsrganPath, buildEsrganArgs(tileVal, threadsVal), esrganBinDir, {
            taskId,
            stallTimeoutMs: 90_000,
            onOutputLine: (line) => {
              if (line.includes("->") && line.includes("done")) {
                doneFrames++;
                emitEsrganProgress(0, true);
                return;
              }
              const pctM = /(\d+)[.,](\d+)%/.exec(line);
              if (pctM) {
                const sub = Math.min(0.98, (Number(pctM[1]) + Number(pctM[2]) / 100) / 100);
                emitEsrganProgress(sub, false);
              }
            },
          });
        };

        let aiRes = await runEsrganAttempt(primaryTile, "1:1:2");
        if (aiRes.stalled && !aiRes.aborted && !isTaskAborted(taskId)) {
          fs.rmSync(framesSr, { recursive: true, force: true });
          fs.mkdirSync(framesSr, { recursive: true });
          aiRes = await runEsrganAttempt(128, "1:1:1");
        }
        if (aiRes.aborted || isTaskAborted(taskId)) {
          return { success: false, status: "cancelled", error: "Task cancelled by operator." };
        }
        if (aiRes.stalled) {
          return { success: false, status: "gpu_stalled", error: aiRes.stderr || "Real-ESRGAN stalled without frame progress." };
        }
        if (aiRes.code !== 0) {
          return { success: false, status: "ai_failed", error: (aiRes.stderr || "Real-ESRGAN batch failed").slice(-500) };
        }
        globalFramesDone += rawCount;
        fs.rmSync(currentFramesDir, { recursive: true, force: true });
        currentFramesDir = framesSr;
      }

      if (needsRife) {
        if (isTaskAborted(taskId)) return { success: false, status: "cancelled", error: "Task cancelled by operator." };
        const framesRife = path.join(workDir, `f_rife_${i}`);
        fs.mkdirSync(framesRife, { recursive: true });
        const inPngs = fs.readdirSync(currentFramesDir).filter((f) => f.endsWith(".png")).sort();
        if (inPngs.length >= 2) {
          const targetCount = inPngs.length * safeMult;
          const runRifeAttempt = async (threadsVal) => {
            let rifeFrames = 0;
            const rifeBase = needsEsrgan ? (segBase + segSpan * 0.5) : segBase;
            const rifeSpan = needsEsrgan ? (segSpan * 0.35) : (segSpan * 0.85);
            return runProcessArgs(rifePath, [
              "-i", currentFramesDir, "-o", framesRife, "-m", resolvedRifeModelDir, "-n", String(targetCount), "-j", threadsVal, "-f", "%08d.png", "-v",
            ], rifeBinDir, {
              taskId,
              stallTimeoutMs: 90_000,
              onOutputLine: (line) => {
                if (line.includes("->") && line.includes("done") && typeof onProgress === "function") {
                  rifeFrames++;
                  const frac = Math.min(1, rifeFrames / targetCount);
                  onProgress({
                    taskId,
                    stage: "RIFE",
                    frame: rifeFrames,
                    totalFrames: targetCount,
                    segment: i + 1,
                    totalSegments: segFiles.length,
                    model: rifeModel,
                    scale: safeMult,
                    progress: Math.min(91, Math.round(rifeBase + frac * rifeSpan)),
                  });
                }
              },
            });
          };
          let rRes = await runRifeAttempt("1:1:2");
          if (rRes.stalled && !rRes.aborted && !isTaskAborted(taskId)) {
            fs.rmSync(framesRife, { recursive: true, force: true });
            fs.mkdirSync(framesRife, { recursive: true });
            rRes = await runRifeAttempt("1:1:1");
          }
          if (rRes.aborted || isTaskAborted(taskId)) {
            return { success: false, status: "cancelled", error: "Task cancelled by operator." };
          }
          if (rRes.stalled) {
            return { success: false, status: "gpu_stalled", error: rRes.stderr || "RIFE stalled without frame progress." };
          }
          if (rRes.code !== 0) {
            return { success: false, status: "rife_failed", error: (rRes.stderr || "RIFE Vulkan interpolation failed").slice(-500) };
          }
          inputPattern = "%08d.png";
          startNumber = 1;
        } else if (inPngs.length === 1) {
          fs.copyFileSync(path.join(currentFramesDir, inPngs[0]), path.join(framesRife, "00000001.png"));
          fs.copyFileSync(path.join(currentFramesDir, inPngs[0]), path.join(framesRife, "00000002.png"));
          inputPattern = "%08d.png";
          startNumber = 1;
        }
        fs.rmSync(currentFramesDir, { recursive: true, force: true });
        currentFramesDir = framesRife;
      }

      if (isTaskAborted(taskId)) return { success: false, status: "cancelled", error: "Task cancelled by operator." };
      if (typeof onProgress === "function") {
        onProgress({
          taskId,
          stage: "ENCODE_SEG",
          segment: i + 1,
          totalSegments: segFiles.length,
          model: effectiveModel,
          scale: effectiveScale,
          progress: Math.min(91, Math.round(segBase + segSpan * 0.9)),
        });
      }
      const segOut = path.join(outSegDir, `out_${i}.mp4`);
      const vfList = [];
      if (denoise) vfList.push("hqdn3d=1.1:1.1:3.5:3.5");
      if (width > 0) {
        vfList.push(height > 0 ? `scale=${evenDim(width)}:${evenDim(height)}:flags=lanczos` : `scale=${evenDim(width)}:-2:flags=lanczos`);
      }
      if (casPostStrength > 0) {
        vfList.push(`cas=strength=${casPostStrength.toFixed(2)}`);
      }
      const segEncArgs = [
        "-hide_banner", "-y", "-start_number", String(startNumber), "-framerate", String(targetFps),
        "-i", path.join(currentFramesDir, inputPattern), "-fps_mode", "cfr",
      ];
      if (vfList.length > 0) segEncArgs.push("-vf", vfList.join(","));
      const segEnc = await encodeWithSafeFallback({
        ffmpegPath: backend.ffmpegPath,
        preArgs: segEncArgs,
        container: "mp4",
        codec,
        bitrateMbps: needsRife ? 42 : 35,
        quality,
        outputPath: segOut,
        taskId,
      });
      if (segEnc.aborted || isTaskAborted(taskId)) {
        return { success: false, status: "cancelled", error: "Task cancelled by operator." };
      }
      if (!segEnc.ok) {
        return { success: false, status: "encode_failed", error: segEnc.error };
      }
      concatList.push(`file '${segOut.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`);
      fs.rmSync(currentFramesDir, { recursive: true, force: true });

      if (typeof onProgress === "function") {
        onProgress({
          taskId,
          stage: `${mode.toUpperCase()}_SEGMENT`,
          segment: i + 1,
          totalSegments: segFiles.length,
          model: effectiveModel,
          scale: effectiveScale,
          progress: Math.min(92, Math.round(10 + ((i + 1) / segFiles.length) * 82)),
        });
      }
      if (i + 1 < segFiles.length) {
        await applyThermalPacing({ taskId, onProgress });
      }
    }

    if (isTaskAborted(taskId)) return { success: false, status: "cancelled", error: "Task cancelled by operator." };
    const listPath = path.join(workDir, "concat.txt");
    fs.writeFileSync(listPath, concatList.join("\n"));
    const outputFile = `${taskId}.mp4`;
    const outputPath = path.join(outputDir, outputFile);
    const muxRes = await runFfmpegArgs(backend.ffmpegPath, [
      "-hide_banner", "-y", "-f", "concat", "-safe", "0", "-i", listPath,
      "-i", stagedInput, "-map", "0:v:0", "-map", "1:a?", "-c:v", "copy", "-c:a", "aac", "-shortest", "-movflags", "+faststart",
      outputPath,
    ], { taskId });
    if (muxRes.aborted || isTaskAborted(taskId)) {
      try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch {}
      return { success: false, status: "cancelled", error: "Task cancelled by operator." };
    }
    if (muxRes.code !== 0 || !fs.existsSync(outputPath)) {
      return { success: false, status: "mux_failed", error: muxRes.stderr.slice(-500) };
    }

    const stat = fs.statSync(outputPath);
    const outMeta = await probeMediaMeta(backend.ffmpegPath, outputPath);
    const elapsedMs = Date.now() - t0;
    const integrity = buildIntegrityReceipt(srcMeta, outMeta, elapsedMs, expectedFpsRatio);
    if (typeof onProgress === "function") onProgress({ taskId, stage: "COMPLETE", progress: 100 });
    return {
      success: true,
      status: "completed",
      taskId,
      pipeline: mode,
      outputFile,
      videoPath: outputPath,
      sizeBytes: stat.size,
      duration: outMeta.duration || probedDur,
      width: outMeta.width || width,
      height: outMeta.height || height,
      fps: outMeta.fps || targetFps,
      model: mode === "hybrid" ? `${effectiveModel}+${rifeModel}` : effectiveModel,
      scale: effectiveScale,
      neural: true,
      hardwareAccelerated: true,
      previewMode: previewApplied,
      previewSourceFile: previewSourceFile || undefined,
      previewSourceDownloadUrl: previewSourceFile ? `/exports/${previewSourceFile}` : undefined,
      integrity,
      providers: getCompanionStatus(),
    };
  } finally {
    unregisterTask(taskId);
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

/**
 * Compute objective FFmpeg quality metrics (PSNR dB, SSIM, optional VMAF) against a Ground-Truth reference.
 */
export async function measureQualityMetrics(ffmpegPath, refPath, distPath, { useVmaf = false } = {}) {
  const refMeta = await probeMediaMeta(ffmpegPath, refPath);
  const w = evenDim(refMeta.width || 1280);
  const h = evenDim(refMeta.height || 720);
  const fps = Math.max(5, refMeta.fps || 30);

  const ssimArgs = [
    "-hide_banner", "-i", distPath, "-i", refPath,
    "-lavfi", `[0:v]fps=${fps},scale=${w}:${h}:flags=bicubic,setpts=PTS-STARTPTS[dist];[1:v]fps=${fps},setpts=PTS-STARTPTS[ref];[dist][ref]ssim=stats_file=-`,
    "-f", "null", "-",
  ];
  const psnrArgs = [
    "-hide_banner", "-i", distPath, "-i", refPath,
    "-lavfi", `[0:v]fps=${fps},scale=${w}:${h}:flags=bicubic,setpts=PTS-STARTPTS[dist];[1:v]fps=${fps},setpts=PTS-STARTPTS[ref];[dist][ref]psnr=stats_file=-`,
    "-f", "null", "-",
  ];

  const [ssimRes, psnrRes] = await Promise.all([
    runFfmpegArgs(ffmpegPath, ssimArgs),
    runFfmpegArgs(ffmpegPath, psnrArgs),
  ]);

  const ssimM = /SSIM[^\n]*All:(\d+(?:\.\d+)?)/.exec(ssimRes.stderr);
  const psnrM = /PSNR[^\n]*average:(\d+(?:\.\d+)?)/.exec(psnrRes.stderr);
  let vmaf = null;

  if (useVmaf) {
    const vmafRes = await runFfmpegArgs(ffmpegPath, [
      "-hide_banner", "-i", distPath, "-i", refPath,
      "-lavfi", `[0:v]fps=${fps},scale=${w}:${h}:flags=bicubic,setpts=PTS-STARTPTS[dist];[1:v]fps=${fps},setpts=PTS-STARTPTS[ref];[dist][ref]libvmaf`,
      "-f", "null", "-",
    ]);
    const vmafM = /VMAF score:\s*(\d+(?:\.\d+)?)/.exec(vmafRes.stderr);
    if (vmafM) vmaf = Number(vmafM[1]);
  }

  return {
    psnrDb: psnrM ? Number(psnrM[1]) : null,
    ssim: ssimM ? Number(ssimM[1]) : null,
    vmaf,
  };
}
