/**
 * KAPTURA REAL VIDEO PIPELINE v2.0
 * Real FFmpeg NVENC/AMF/libx264 transcoding, Lanczos scaling, FontForge overlays,
 * and deterministic procedural PPM composition (zero lavfi testsrc).
 */

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { detectVideoBackend, getOptimalGpuEncoderParams } from "./gpuDirectOptimizer.mjs";
import { getCompanionStatus, resolveFontTtfPath, runUpskaletor } from "../providers/adapters.mjs";

const ALLOWED_INPUT_EXTS = new Set([".webm", ".mp4", ".mov", ".mkv", ".avi", ".gif", ".png", ".jpg", ".jpeg", ".webp"]);

function evenDim(n) {
  const v = Math.max(2, Math.round(Number(n) || 0));
  return v & ~1;
}

function pruneOldExports(outputDir, maxAgeMs = 15 * 60 * 1000, maxFiles = 20) {
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

function runFfmpegArgs(ffmpegPath, args, options = {}) {
  const opts = typeof options === "function" ? { onStderrLine: options } : (options || {});
  const { onStderrLine, onProgressMeta, totalDurationSec = 0 } = opts;

  return new Promise((resolve) => {
    const proc = spawn(ffmpegPath, args, { windowsHide: true });
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
    proc.on("error", (err) => resolve({ code: -1, stderr: String(err) }));
    proc.on("close", (code) => resolve({ code: code ?? 1, stderr }));
  });
}

/** Probe media duration in seconds using FFmpeg banner stderr (requires no separate ffprobe). */
async function probeDurationSec(ffmpegPath, inputPath) {
  const res = await runFfmpegArgs(ffmpegPath, ["-hide_banner", "-i", inputPath]);
  const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(res.stderr);
  if (!m) return 0;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

function escapeDrawtext(text) {
  return String(text || "")
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'")
    .slice(0, 96);
}

/** Encode with NVENC/AMF and fallback once cleanly to libx264 only on hardware init error. */
async function encodeWithSafeFallback({
  ffmpegPath,
  preArgs,
  container,
  bitrateMbps,
  quality,
  outputPath,
  totalDurationSec = 0,
  onProgress,
  taskId = "",
}) {
  const primary = getOptimalGpuEncoderParams({ container, bitrateMbps, quality });
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
  });
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

/**
 * Transcode an actual input file or buffer cleanly into exports/ with Lanczos scaling & budget control.
 */
export async function transcodeMediaTask({
  inputPath = "",
  inputBuffer = null,
  inputExt = ".webm",
  outputDir = path.resolve(process.cwd(), "exports"),
  container = "mp4",
  width = 0,
  height = 0,
  fps = 0,
  bitrateMbps = 0,
  targetMB = 0,
  quality = "high",
  textOverlay = "",
  startSec = 0,
  endSec = 0,
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

    if (typeof onProgress === "function") onProgress({ taskId, stage: "PROBING", progress: 5 });

    const trimStart = Math.max(0, Number(startSec) || 0);
    const trimEnd = Number(endSec) > trimStart ? Number(endSec) : 0;
    const probedDur = await probeDurationSec(backend.ffmpegPath, stagedInput);
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
    if (width > 0 && height > 0) {
      filters.push(`scale=${evenDim(width)}:${evenDim(height)}:flags=lanczos`);
    } else if (width > 0) {
      filters.push(`scale=${evenDim(width)}:-2:flags=lanczos`);
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
    if (filters.length > 0) preArgs.push("-vf", filters.join(","));
    if (outExt === "mp4") preArgs.push("-c:a", "aac", "-b:a", "128k");

    if (typeof onProgress === "function") onProgress({ taskId, stage: "ENCODING", progress: 12 });
    const encRes = await encodeWithSafeFallback({
      ffmpegPath: backend.ffmpegPath,
      preArgs,
      container: outExt,
      bitrateMbps: computedBitrateMbps,
      quality,
      outputPath,
      totalDurationSec: probedDur > 0 ? effectiveDur : 0,
      onProgress,
      taskId,
    });

    if (!encRes.ok) {
      return { success: false, status: "encode_failed", error: encRes.error };
    }

    const stat = fs.statSync(outputPath);
    const outDuration = await probeDurationSec(backend.ffmpegPath, outputPath);
    if (typeof onProgress === "function") onProgress({ taskId, stage: "COMPLETE", progress: 100 });
    return {
      success: true,
      status: "completed",
      taskId,
      outputFile,
      videoPath: outputPath,
      sizeBytes: stat.size,
      duration: outDuration || effectiveDur,
      codec: encRes.codec,
      hardwareAccelerated: encRes.hardwareAccelerated,
      fallbackCpu: encRes.fallbackCpu,
      providers: getCompanionStatus(),
    };
  } finally {
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
