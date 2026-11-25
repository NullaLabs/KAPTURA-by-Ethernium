/**
 * KAPTURA BG STUDIO PIPELINE (Image & Video Neural / Chroma Matting)
 * - Image: BiRefNet 1024px ONNX + Guided Filter + Color Decontamination (fallback RVM ONNX)
 * - Video: RVM ResNet50 CUDA FP16 (60 FPS 1080p) / RVM MobileNetV3 ONNX / FFmpeg Chroma-Key GPU
 * Outputs: PNG RGBA, WebM VP9 Alpha (yuva420p), ProRes 4444 Alpha (.mov), Greenscreen/Bokeh/Solid/Custom MP4.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { detectVideoBackend, getOptimalGpuEncoderParams } from "./gpuDirectOptimizer.mjs";
import { getCompanionStatus, resolveBgRuntimes } from "../providers/adapters.mjs";
import {
  registerTask,
  unregisterTask,
  isTaskAborted,
  pruneOldExports,
  runFfmpegArgs,
  runProcessArgs,
  probeMediaMeta,
  createPreviewClip,
  buildIntegrityReceipt,
  encodeWithSafeFallback,
  applyThermalPacing,
} from "./videoPipeline.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_SCRIPT = path.join(__dirname, "bgRemoveWorker.py");
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".bmp", ".avif"]);

function evenDim(n) {
  const v = Math.max(2, Math.round(Number(n) || 0));
  return v & ~1;
}

function normalizeHex(color, fallback = "050814") {
  const clean = String(color || "").trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{6}$/.test(clean)) return clean.toUpperCase();
  if (/^[0-9a-fA-F]{3}$/.test(clean)) return clean.split("").map((c) => c + c).join("").toUpperCase();
  return fallback;
}

function resolveBgSelection(requestedEngine, isImage, previewSec, bg) {
  const req = String(requestedEngine || "auto").toLowerCase();
  if (req === "chroma") return { engine: "chroma", pyBin: null, modelPath: null };

  if (isImage) {
    if (req === "rvm_cuda") {
      return { errorStatus: "invalid_mode_for_image", error: "RVM CUDA es un motor temporal exclusivo de vídeo." };
    }
    if ((req === "auto" || req === "birefnet") && bg.birefnet) {
      return { engine: "birefnet", pyBin: bg.onnxPython, modelPath: bg.birefnetModel };
    }
    if ((req === "auto" || req === "rvm_onnx") && bg.rvmOnnx) {
      return { engine: "rvm_onnx", pyBin: bg.onnxPython, modelPath: bg.rvmOnnxModel };
    }
    if (req === "birefnet" || req === "rvm_onnx" || req === "auto") {
      return {
        errorStatus: "bg_model_unavailable",
        error: "Modelos neuronales de BG Studio (BiRefNet / RVM ONNX) no instalados. Ejecuta `npm run setup:neural` o usa Chroma-Key.",
      };
    }
    return { errorStatus: "bg_model_unavailable", error: `Unsupported image engine: ${req}` };
  }

  // Video routing
  if (req === "auto") {
    if (Number(previewSec) > 0 && Number(previewSec) <= 2.5 && bg.rvmOnnx) {
      return { engine: "rvm_onnx", pyBin: bg.onnxPython, modelPath: bg.rvmOnnxModel };
    }
    if (bg.rvmCuda) return { engine: "rvm_cuda", pyBin: bg.cudaPython, modelPath: bg.rvmTorchModel };
    if (bg.rvmOnnx) return { engine: "rvm_onnx", pyBin: bg.onnxPython, modelPath: bg.rvmOnnxModel };
    if (bg.birefnet) return { engine: "birefnet", pyBin: bg.onnxPython, modelPath: bg.birefnetModel };
    return {
      errorStatus: "bg_model_unavailable",
      error: "Modelos neuronales de vídeo (RVM CUDA / ONNX) no detectados. Ejecuta `npm run setup:neural` o usa Chroma-Key.",
    };
  }
  if (req === "rvm_cuda") {
    return bg.rvmCuda
      ? { engine: "rvm_cuda", pyBin: bg.cudaPython, modelPath: bg.rvmTorchModel }
      : { errorStatus: "bg_model_unavailable", error: "RVM ResNet50 CUDA no disponible en este host." };
  }
  if (req === "rvm_onnx") {
    return bg.rvmOnnx
      ? { engine: "rvm_onnx", pyBin: bg.onnxPython, modelPath: bg.rvmOnnxModel }
      : { errorStatus: "bg_model_unavailable", error: "RVM MobileNetV3 ONNX no detectado en este host." };
  }
  if (req === "birefnet") {
    return bg.birefnet
      ? { engine: "birefnet", pyBin: bg.onnxPython, modelPath: bg.birefnetModel }
      : { errorStatus: "bg_model_unavailable", error: "BiRefNet ONNX no detectado en este host." };
  }
  return { errorStatus: "bg_model_unavailable", error: `Unknown BG engine: ${req}` };
}

function outputExtFor(isImage, backdrop) {
  if (isImage) return "png";
  if (backdrop === "transparent") return "webm";
  if (backdrop === "prores") return "mov";
  return "mp4";
}

async function runChromaKeyTask({
  ffmpegPath,
  backend,
  stagedInput,
  outputPath,
  isImage,
  srcMeta,
  backdrop,
  bgColor,
  bgImagePath,
  blurStrength,
  keyColor,
  similarity,
  blend,
  decontaminate,
  codec,
  taskId,
  onProgress,
}) {
  const kHex = normalizeHex(keyColor, "00FF00");
  const rK = parseInt(kHex.slice(0, 2), 16);
  const gK = parseInt(kHex.slice(2, 4), 16);
  const bK = parseInt(kHex.slice(4, 6), 16);
  const sim = Math.max(0.02, Math.min(0.65, Number(similarity) || 0.18)).toFixed(3);
  const bl = Math.max(0.0, Math.min(0.45, Number(blend) || 0.08)).toFixed(3);
  const spillType = gK >= bK && gK >= rK ? "green" : "blue";

  const w = evenDim(srcMeta.width || 1280);
  const h = evenDim(srcMeta.height || 720);
  const keyChain = `format=rgba,chromakey=color=0x${kHex}:similarity=${sim}:blend=${bl}${decontaminate ? `,despill=type=${spillType}` : ""}`;

  const args = ["-hide_banner", "-y", "-i", stagedInput];
  let filterComplex = "";
  let mapVideo = "[outv]";

  if (backdrop === "transparent" || backdrop === "prores") {
    filterComplex = `[0:v]${keyChain}[outv]`;
  } else if (backdrop === "custom_image" && bgImagePath && fs.existsSync(bgImagePath)) {
    args.push("-i", bgImagePath);
    filterComplex = `[0:v]${keyChain}[fg];[1:v]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},format=rgba[bg];[bg][fg]overlay=shortest=1:format=auto[outv]`;
  } else if (backdrop === "bokeh") {
    const rad = Math.max(4, Math.min(32, Math.round((Number(blurStrength) || 21) / 2)));
    filterComplex = `[0:v]split=2[src_fg][src_bg];[src_fg]${keyChain}[fg];[src_bg]boxblur=luma_radius=${rad}:luma_power=2,format=rgba[bg];[bg][fg]overlay=shortest=1:format=auto[outv]`;
  } else {
    const solidHex = backdrop === "greenscreen" ? "00FF00" : normalizeHex(bgColor, "050814");
    filterComplex = `[0:v]${keyChain}[fg];color=c=0x${solidHex}:s=${w}x${h}[bg];[bg][fg]overlay=shortest=1:format=auto[outv]`;
  }

  if (typeof onProgress === "function") onProgress({ taskId, stage: "CHROMA_GPU", progress: 25 });

  if (isImage) {
    const imgArgs = [...args, "-filter_complex", filterComplex, "-map", mapVideo, "-frames:v", "1", outputPath];
    const r = await runFfmpegArgs(ffmpegPath, imgArgs, { taskId });
    if (r.aborted || isTaskAborted(taskId)) return { ok: false, aborted: true, error: "Cancelled" };
    if (r.code !== 0 || !fs.existsSync(outputPath)) return { ok: false, error: (r.stderr || "Chroma key image failed").slice(-400) };
    return { ok: true, codec: "png", hardwareAccelerated: false };
  }

  if (backdrop === "transparent") {
    const vArgs = [
      ...args,
      "-filter_complex", filterComplex,
      "-map", mapVideo,
      ...(srcMeta.hasAudio ? ["-map", "0:a?", "-c:a", "libopus", "-b:a", "128k"] : []),
      "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-auto-alt-ref", "0", "-row-mt", "1", "-deadline", "good", "-crf", "24", "-b:v", "0",
      outputPath,
    ];
    const r = await runFfmpegArgs(ffmpegPath, vArgs, { taskId, totalDurationSec: srcMeta.duration, onProgressMeta: (m) => onProgress && onProgress({ taskId, stage: "CHROMA_WEBM_ALPHA", progress: m.progress, frame: m.frame }) });
    if (r.aborted || isTaskAborted(taskId)) return { ok: false, aborted: true, error: "Cancelled" };
    if (r.code !== 0 || !fs.existsSync(outputPath)) return { ok: false, error: (r.stderr || "Chroma WebM alpha failed").slice(-400) };
    return { ok: true, codec: "libvpx-vp9 (yuva420p)", hardwareAccelerated: false };
  }

  if (backdrop === "prores") {
    const vArgs = [
      ...args,
      "-filter_complex", filterComplex,
      "-map", mapVideo,
      ...(srcMeta.hasAudio ? ["-map", "0:a?", "-c:a", "aac", "-b:a", "192k"] : []),
      "-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuva444p10le",
      outputPath,
    ];
    const r = await runFfmpegArgs(ffmpegPath, vArgs, { taskId, totalDurationSec: srcMeta.duration });
    if (r.aborted || isTaskAborted(taskId)) return { ok: false, aborted: true, error: "Cancelled" };
    if (r.code !== 0 || !fs.existsSync(outputPath)) return { ok: false, error: (r.stderr || "Chroma ProRes alpha failed").slice(-400) };
    return { ok: true, codec: "prores_ks (4444 alpha)", hardwareAccelerated: false };
  }

  const preArgs = [
    ...args,
    "-filter_complex", filterComplex,
    "-map", mapVideo,
    ...(srcMeta.hasAudio ? ["-map", "0:a?", "-c:a", "aac", "-b:a", "160k"] : []),
    "-pix_fmt", "yuv420p",
  ];
  const encRes = await encodeWithSafeFallback({
    ffmpegPath,
    preArgs,
    container: "mp4",
    codec,
    bitrateMbps: 0,
    quality: "high",
    outputPath,
    totalDurationSec: srcMeta.duration || 0,
    onProgress,
    taskId,
  });
  return encRes;
}

/**
 * Remove image or video background cleanly via neural matting or GPU Chroma-Key.
 */
export async function removeBgTask({
  inputPath = "",
  inputBuffer = null,
  inputExt = ".png",
  outputDir = path.resolve(process.cwd(), "exports"),
  engine = "auto",
  backdrop = "transparent",
  bgColor = "#050814",
  bgImagePath = "",
  blurStrength = 23,
  edgeRefine = 0,
  decontaminate = true,
  keyColor = "#00FF00",
  similarity = 0.18,
  blend = 0.08,
  codec = "auto",
  previewSec = 0,
  previewStartSec = 0,
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

  const cleanExt = inputExt ? (inputExt.startsWith(".") ? inputExt.toLowerCase() : `.${inputExt.toLowerCase()}`) : ".mp4";
  const isImage = IMAGE_EXTS.has(cleanExt);
  if (isImage && (backdrop === "prores" || backdrop === "greenscreen")) {
    return { success: false, status: "invalid_mode_for_image", error: `Backdrop "${backdrop}" only applies to video.` };
  }

  const bg = resolveBgRuntimes();
  const sel = resolveBgSelection(engine, isImage, previewSec, bg);
  if (sel.errorStatus) {
    return { success: false, status: sel.errorStatus, error: sel.error, providers: getCompanionStatus() };
  }

  const t0 = Date.now();
  fs.mkdirSync(outputDir, { recursive: true });
  pruneOldExports(outputDir);
  const taskId = providedTaskId || `bg_${Date.now()}`;
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
      return { success: false, status: "missing_input", error: "Input media path does not exist." };
    }
    if (fs.statSync(stagedInput).size === 0) {
      return { success: false, status: "empty_input", error: "Input media is empty (0 bytes)." };
    }

    if (typeof onProgress === "function") onProgress({ taskId, stage: "PROBING", progress: 6 });
    let srcMeta = await probeMediaMeta(backend.ffmpegPath, stagedInput);
    let previewApplied = false;
    let previewSourceFile = "";

    const reqPreviewSec = Number(previewSec) || 0;
    if (!isImage && reqPreviewSec > 0) {
      if (typeof onProgress === "function") onProgress({ taskId, stage: "PREVIEW_SLICE", progress: 8 });
      const pDur = Math.max(0.3, Math.min(5.0, reqPreviewSec));
      const pStart = Math.max(0, Math.min(Math.max(0, (srcMeta.duration || 0) - pDur), Number(previewStartSec) || 0));
      const previewClip = path.join(workDir, "preview_clip.mp4");
      const sliceRes = await createPreviewClip(backend.ffmpegPath, stagedInput, previewClip, {
        previewSec: pDur,
        previewStartSec: pStart,
        taskId,
      });
      if (sliceRes.aborted || isTaskAborted(taskId)) {
        return { success: false, status: "cancelled", error: "Task cancelled by operator." };
      }
      if (sliceRes.ok) {
        stagedInput = previewClip;
        previewApplied = true;
        previewSourceFile = `preview_src_${taskId}.mp4`;
        try { fs.copyFileSync(previewClip, path.join(outputDir, previewSourceFile)); } catch { previewSourceFile = ""; }
        srcMeta = await probeMediaMeta(backend.ffmpegPath, stagedInput);
      }
    }

    const outExt = outputExtFor(isImage, backdrop);
    const outputFile = `${taskId}.${outExt}`;
    const outputPath = path.join(outputDir, outputFile);

    if (sel.engine === "chroma") {
      const chRes = await runChromaKeyTask({
        ffmpegPath: backend.ffmpegPath,
        backend,
        stagedInput,
        outputPath,
        isImage,
        srcMeta,
        backdrop,
        bgColor,
        bgImagePath,
        blurStrength,
        keyColor,
        similarity,
        blend,
        decontaminate: Boolean(decontaminate),
        codec,
        taskId,
        onProgress,
      });
      if (chRes.aborted || isTaskAborted(taskId)) {
        try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch {}
        return { success: false, status: "cancelled", error: "Task cancelled by operator." };
      }
      if (!chRes.ok || !fs.existsSync(outputPath)) {
        return { success: false, status: "bg_failed", error: chRes.error || "Chroma key processing failed." };
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
        engine: "chroma",
        model: "ffmpeg-chromakey-despill",
        backdrop,
        isImage,
        hasAlpha: backdrop === "transparent" || backdrop === "prores",
        outputFile,
        videoPath: outputPath,
        sizeBytes: stat.size,
        duration: outMeta.duration || srcMeta.duration || 0,
        width: outMeta.width || srcMeta.width || 0,
        height: outMeta.height || srcMeta.height || 0,
        fps: outMeta.fps || srcMeta.fps || 0,
        codec: chRes.codec,
        hardwareAccelerated: Boolean(chRes.hardwareAccelerated),
        previewMode: previewApplied,
        previewSourceFile: previewSourceFile || undefined,
        previewSourceDownloadUrl: previewSourceFile ? `/exports/${previewSourceFile}` : undefined,
        integrity,
        providers: getCompanionStatus(),
      };
    }

    await applyThermalPacing({ taskId, onProgress });
    if (isTaskAborted(taskId)) {
      return { success: false, status: "cancelled", error: "Task cancelled by operator." };
    }

    const encChoice = getOptimalGpuEncoderParams({ container: "mp4", codec, quality: "high" });
    const w = evenDim(srcMeta.width || 1280);
    const h = evenDim(srcMeta.height || 720);
    const fps = srcMeta.fps || 30;
    const estFrames = isImage ? 1 : Math.max(1, Math.round((srcMeta.duration || 2) * fps));

    const pyArgs = [
      WORKER_SCRIPT,
      "--mode", isImage ? "image" : "video",
      "--engine", sel.engine,
      "--input", stagedInput,
      "--output", outputPath,
      "--model", sel.modelPath,
      "--backdrop", backdrop,
      "--bg-color", bgColor || "#050814",
      "--blur-strength", String(Math.round(Number(blurStrength) || 23)),
      "--edge-refine", String(Number(edgeRefine) || 0),
      "--decontaminate", decontaminate ? "1" : "0",
      "--ffmpeg", backend.ffmpegPath,
      "--codec", encChoice.codec,
      "--fps", String(fps),
      "--width", String(w),
      "--height", String(h),
      "--total-frames", String(estFrames),
      "--has-audio", srcMeta.hasAudio ? "1" : "0",
    ];
    if (bgImagePath && fs.existsSync(bgImagePath)) {
      pyArgs.push("--bg-image", bgImagePath);
    }

    const workerRes = await runProcessArgs(sel.pyBin, pyArgs, path.dirname(WORKER_SCRIPT), {
      taskId,
      stallTimeoutMs: 120_000,
      onOutputLine: (line) => {
        if (typeof onProgress !== "function") return;
        try {
          const parsed = JSON.parse(line);
          if (parsed && typeof parsed === "object") {
            onProgress({ taskId, ...parsed });
          }
        } catch { /* ignore non-JSON stderr info */ }
      },
    });

    if (workerRes.aborted || isTaskAborted(taskId)) {
      try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch {}
      return { success: false, status: "cancelled", error: "Task cancelled by operator." };
    }
    if (workerRes.code !== 0 || !fs.existsSync(outputPath) || fs.statSync(outputPath).size === 0) {
      return {
        success: false,
        status: workerRes.stalled ? "gpu_stalled" : "bg_failed",
        error: (workerRes.stderr || workerRes.stdout || "Background removal worker failed").slice(-500),
      };
    }

    const stat = fs.statSync(outputPath);
    const outMeta = await probeMediaMeta(backend.ffmpegPath, outputPath);
    const elapsedMs = Date.now() - t0;
    const integrity = isImage
      ? { elapsedMs, srcWidth: srcMeta.width, srcHeight: srcMeta.height, outWidth: outMeta.width, outHeight: outMeta.height }
      : buildIntegrityReceipt(srcMeta, outMeta, elapsedMs, 1);

    if (typeof onProgress === "function") onProgress({ taskId, stage: "COMPLETE", progress: 100 });
    return {
      success: true,
      status: "completed",
      taskId,
      engine: sel.engine,
      model: path.basename(sel.modelPath),
      backdrop,
      isImage,
      hasAlpha: backdrop === "transparent" || backdrop === "prores",
      outputFile,
      videoPath: outputPath,
      sizeBytes: stat.size,
      duration: outMeta.duration || srcMeta.duration || 0,
      width: outMeta.width || w,
      height: outMeta.height || h,
      fps: isImage ? 0 : (outMeta.fps || fps),
      codec: isImage ? "png" : (backdrop === "transparent" ? "libvpx-vp9 (yuva420p)" : (backdrop === "prores" ? "prores_ks (4444 alpha)" : encChoice.codec)),
      hardwareAccelerated: sel.engine === "rvm_cuda" || (backdrop !== "transparent" && backdrop !== "prores" && encChoice.hardwareAccelerated),
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
