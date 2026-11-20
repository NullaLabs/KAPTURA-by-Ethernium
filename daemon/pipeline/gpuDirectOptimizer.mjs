/**
 * GPU DIRECT OPTIMIZER — Real FFmpeg Binary Discovery & Encoder Probing
 * Discovers system or existing local FFmpeg binaries once and probes NVIDIA NVENC / AMF / QSV / libx264.
 * Never claims hardware acceleration unless FFmpeg reports the encoder cleanly.
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

let cachedProbe = null;

/** Locate an existing ffmpeg executable without downloading external packages. */
export function resolveFfmpegExecutable() {
  if (process.env.ETHERNIUM_FFMPEG_PATH && fs.existsSync(process.env.ETHERNIUM_FFMPEG_PATH)) {
    return path.resolve(process.env.ETHERNIUM_FFMPEG_PATH);
  }

  const whichCmd = process.platform === "win32" ? "where" : "which";
  const whichRes = spawnSync(whichCmd, ["ffmpeg"], { encoding: "utf8", timeout: 2000, windowsHide: true });
  if (whichRes.status === 0 && whichRes.stdout.trim()) {
    const first = whichRes.stdout.trim().split(/\r?\n/)[0];
    if (fs.existsSync(first)) return first;
  }

  if (process.platform === "win32") {
    const pyBin = process.env.PYTHON || "python";
    const pyRes = spawnSync(pyBin, ["-c", "import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())"], {
      encoding: "utf8",
      timeout: 3000,
      windowsHide: true,
    });
    if (pyRes.status === 0) {
      const candidate = pyRes.stdout.trim().split(/\r?\n/)[0];
      if (candidate && fs.existsSync(candidate)) return candidate;
    }

    const capcutApps = path.join(process.env.LOCALAPPDATA || "", "CapCut", "Apps");
    if (fs.existsSync(capcutApps)) {
      try {
        for (const ver of fs.readdirSync(capcutApps).sort().reverse()) {
          const candidate = path.join(capcutApps, ver, "ffmpeg.exe");
          if (fs.existsSync(candidate)) return candidate;
        }
      } catch {
        // Non-fatal probe skip
      }
    }
  }

  return null;
}

/** Probe actual FFmpeg encoders available on this machine (cached after first lookup). */
export function detectVideoBackend(forceRefresh = false) {
  if (cachedProbe && !forceRefresh) return cachedProbe;

  const ffmpegPath = resolveFfmpegExecutable();
  if (!ffmpegPath) {
    cachedProbe = {
      available: false,
      ffmpegPath: null,
      encoders: { nvencH264: false, nvencHevc: false, nvencAv1: false, amfH264: false, qsvH264: false, libx264: false, vp9: false },
      filters: { cas: false, psnr: false, ssim: false, libvmaf: false, minterpolate: false },
      preferredCodec: null,
      hardwareAccelerated: false,
    };
    return cachedProbe;
  }

  let encoderText = "";
  let filterText = "";
  try {
    encoderText = execFileSync(ffmpegPath, ["-hide_banner", "-encoders"], {
      encoding: "utf8",
      timeout: 3000,
      windowsHide: true,
    });
  } catch {
    encoderText = "";
  }
  try {
    filterText = execFileSync(ffmpegPath, ["-hide_banner", "-filters"], {
      encoding: "utf8",
      timeout: 3000,
      windowsHide: true,
    });
  } catch {
    filterText = "";
  }

  const encoders = {
    nvencH264: encoderText.includes("h264_nvenc"),
    nvencHevc: encoderText.includes("hevc_nvenc"),
    nvencAv1: encoderText.includes("av1_nvenc"),
    amfH264: encoderText.includes("h264_amf"),
    qsvH264: encoderText.includes("h264_qsv"),
    libx264: encoderText.includes("libx264"),
    vp9: encoderText.includes("libvpx-vp9"),
  };

  const filters = {
    cas: /\bcas\b/.test(filterText),
    psnr: /\bpsnr\b/.test(filterText),
    ssim: /\bssim\b/.test(filterText),
    libvmaf: /\blibvmaf\b/.test(filterText),
    minterpolate: /\bminterpolate\b/.test(filterText),
  };

  let preferredCodec = "mpeg4";
  let hardwareAccelerated = false;
  if (encoders.nvencH264) {
    preferredCodec = "h264_nvenc";
    hardwareAccelerated = true;
  } else if (encoders.amfH264) {
    preferredCodec = "h264_amf";
    hardwareAccelerated = true;
  } else if (encoders.qsvH264) {
    preferredCodec = "h264_qsv";
    hardwareAccelerated = true;
  } else if (encoders.libx264) {
    preferredCodec = "libx264";
  }

  cachedProbe = {
    available: true,
    ffmpegPath,
    encoders,
    filters,
    preferredCodec,
    hardwareAccelerated,
  };
  return cachedProbe;
}

/** Build deterministic FFmpeg encoder flags for container & bitrate targets. */
export function getOptimalGpuEncoderParams({ container = "mp4", bitrateMbps = 0, quality = "high" } = {}) {
  const backend = detectVideoBackend();
  const isMaster = quality === "master" || quality === "max";
  const targetKbps = bitrateMbps > 0 ? Math.max(150, Math.round(bitrateMbps * 1000)) : 0;

  if (container === "webm" && backend.encoders.vp9) {
    const flags = ["-c:v", "libvpx-vp9", "-row-mt", "1", "-deadline", quality === "fast" ? "realtime" : "good"];
    if (targetKbps > 0) flags.push("-b:v", `${targetKbps}k`, "-maxrate", `${Math.round(targetKbps * 1.25)}k`, "-bufsize", `${targetKbps * 2}k`);
    else flags.push("-crf", isMaster ? "18" : "26", "-b:v", "0");
    return { codec: "libvpx-vp9", gpuFlags: flags, hardwareAccelerated: false, backend };
  }

  if (backend.encoders.nvencH264) {
    const preset = isMaster ? "p5" : quality === "fast" ? "p1" : "p3";
    const flags = ["-c:v", "h264_nvenc", "-preset", preset, "-tune", "hq", "-pix_fmt", "yuv420p"];
    if (targetKbps > 0) {
      flags.push("-rc", "vbr", "-b:v", `${targetKbps}k`, "-maxrate", `${Math.round(targetKbps * 1.2)}k`, "-bufsize", `${targetKbps * 2}k`);
    } else {
      flags.push("-rc", "vbr", "-cq", isMaster ? "18" : "23", "-b:v", "0");
    }
    return { codec: "h264_nvenc", gpuFlags: flags, hardwareAccelerated: true, backend };
  }

  const crf = isMaster ? "16" : quality === "fast" ? "26" : "20";
  const flags = ["-c:v", "libx264", "-preset", quality === "fast" ? "veryfast" : "medium", "-pix_fmt", "yuv420p"];
  if (targetKbps > 0) flags.push("-b:v", `${targetKbps}k`, "-maxrate", `${Math.round(targetKbps * 1.2)}k`, "-bufsize", `${targetKbps * 2}k`);
  else flags.push("-crf", crf);

  return { codec: "libx264", gpuFlags: flags, hardwareAccelerated: false, backend };
}
