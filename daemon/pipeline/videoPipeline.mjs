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

function runFfmpegArgs(ffmpegPath, args, onStderrLine) {
  return new Promise((resolve) => {
    const proc = spawn(ffmpegPath, args, { windowsHide: true });
    let stderr = "";
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
async function encodeWithSafeFallback({ ffmpegPath, preArgs, container, bitrateMbps, quality, outputPath }) {
  const primary = getOptimalGpuEncoderParams({ container, bitrateMbps, quality });
  const primaryArgs = [...preArgs, ...primary.gpuFlags, "-movflags", "+faststart", outputPath];
  const res = await runFfmpegArgs(ffmpegPath, primaryArgs);
  if (res.code === 0 && fs.existsSync(outputPath)) {
    return { ok: true, codec: primary.codec, hardwareAccelerated: primary.hardwareAccelerated, fallbackCpu: false };
  }

  if (primary.hardwareAccelerated && primary.backend.encoders.libx264) {
    const cpuArgs = [
      ...preArgs,
      "-c:v", "libx264",
      "-preset", quality === "fast" ? "veryfast" : "medium",
      "-pix_fmt", "yuv420p",
      ...(bitrateMbps > 0 ? ["-b:v", `${Math.max(150, Math.round(bitrateMbps * 1000))}k`] : ["-crf", "20"]),
      "-movflags", "+faststart",
      outputPath,
    ];
    const cpuRes = await runFfmpegArgs(ffmpegPath, cpuArgs);
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
  inputPath,
  inputBuffer,
  inputExt = ".webm",
  outputDir,
  container = "mp4",
  width = 0,
  height = 0,
  fps = 0,
  bitrateMbps = 0,
  targetMB = 0,
  quality = "high",
  textOverlay = "",
  onProgress,
}) {
  const backend = detectVideoBackend();
  if (!backend.available || !backend.ffmpegPath) {
    return { success: false, status: "ffmpeg_unavailable", error: "FFmpeg binary not detected on host." };
  }

  fs.mkdirSync(outputDir, { recursive: true });
  const taskId = `transcode_${Date.now()}`;
  const cleanExt = ALLOWED_INPUT_EXTS.has(inputExt.toLowerCase()) ? inputExt.toLowerCase() : ".webm";
  let stagedInput = inputPath ? path.resolve(inputPath) : "";
  let createdTemp = false;

  try {
    if (!stagedInput && inputBuffer) {
      stagedInput = path.join(outputDir, `${taskId}_in${cleanExt}`);
      fs.writeFileSync(stagedInput, inputBuffer);
      createdTemp = true;
    }
    if (!stagedInput || !fs.existsSync(stagedInput)) {
      return { success: false, status: "missing_input", error: "Input media path or buffer is required." };
    }

    if (typeof onProgress === "function") onProgress({ taskId, stage: "PROBING", progress: 15 });

    let computedBitrateMbps = Number(bitrateMbps) || 0;
    if (!computedBitrateMbps && targetMB > 0) {
      const dur = await probeDurationSec(backend.ffmpegPath, stagedInput);
      const effectiveDur = dur > 0.2 ? dur : 5;
      computedBitrateMbps = Math.max(0.25, ((targetMB * 8 * 1024 * 1024 * 0.88) / effectiveDur) / 1e6);
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

    const preArgs = ["-hide_banner", "-y", "-i", stagedInput];
    if (fps > 0) preArgs.push("-r", String(Math.round(fps)));
    if (filters.length > 0) preArgs.push("-vf", filters.join(","));
    if (outExt === "mp4") preArgs.push("-c:a", "aac", "-b:a", "128k");

    if (typeof onProgress === "function") onProgress({ taskId, stage: "ENCODING", progress: 60 });
    const encRes = await encodeWithSafeFallback({
      ffmpegPath: backend.ffmpegPath,
      preArgs,
      container: outExt,
      bitrateMbps: computedBitrateMbps,
      quality,
      outputPath,
    });

    if (!encRes.ok) {
      return { success: false, status: "encode_failed", error: encRes.error };
    }

    const stat = fs.statSync(outputPath);
    if (typeof onProgress === "function") onProgress({ taskId, stage: "COMPLETE", progress: 100 });
    return {
      success: true,
      status: "completed",
      taskId,
      outputFile,
      videoPath: outputPath,
      sizeBytes: stat.size,
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

    if (typeof onProgress === "function") onProgress({ taskId, stage: "ENCODING_NVENC", progress: 70 });
    const encRes = await encodeWithSafeFallback({
      ffmpegPath: backend.ffmpegPath,
      preArgs,
      container: "mp4",
      bitrateMbps,
      quality,
      outputPath,
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
