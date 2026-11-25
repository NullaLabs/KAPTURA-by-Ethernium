/**
 * GPU DIRECT OPTIMIZER — Real FFmpeg Binary Discovery & Encoder Probing
 * Discovers system or existing local FFmpeg binaries once and probes NVIDIA NVENC / AMF / QSV / libx264.
 * Never claims hardware acceleration unless FFmpeg reports the encoder cleanly.
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

let cachedProbe = null;
let cachedGpuTelemetry = { at: 0, data: null };

function probeHardwareEncoder(ffmpegPath, encoderName) {
  try {
    const res = spawnSync(
      ffmpegPath,
      ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=black:s=256x256:d=0.05", "-frames:v", "1", "-c:v", encoderName, "-f", "null", "-"],
      { encoding: "utf8", timeout: 2500, windowsHide: true }
    );
    return res.status === 0;
  } catch {
    return false;
  }
}

/** Query live NVIDIA GPU temperature, utilization, and VRAM via nvidia-smi (cached 3s). */
export function probeGpuTelemetry(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedGpuTelemetry.data && now - cachedGpuTelemetry.at < 3000) {
    return cachedGpuTelemetry.data;
  }
  let data = { available: false, name: null, tempC: null, utilPct: null, vramUsedMB: null, vramTotalMB: null, thermalState: "unknown" };
  try {
    const res = spawnSync(
      "nvidia-smi",
      ["--query-gpu=name,temperature.gpu,utilization.gpu,memory.used,memory.total", "--format=csv,noheader,nounits"],
      { encoding: "utf8", timeout: 1500, windowsHide: true }
    );
    if (res.status === 0 && res.stdout) {
      const line = res.stdout.trim().split(/\r?\n/)[0] || "";
      const parts = line.split(",").map((s) => s.trim());
      if (parts.length >= 5) {
        const tempC = Number(parts[1]);
        const utilPct = Number(parts[2]);
        const vramUsedMB = Number(parts[3]);
        const vramTotalMB = Number(parts[4]);
        const thermalState = Number.isFinite(tempC)
          ? (tempC >= 86 ? "hot" : tempC >= 78 ? "warm" : "cool")
          : "unknown";
        data = {
          available: true,
          name: parts[0],
          tempC: Number.isFinite(tempC) ? tempC : null,
          utilPct: Number.isFinite(utilPct) ? utilPct : null,
          vramUsedMB: Number.isFinite(vramUsedMB) ? vramUsedMB : null,
          vramTotalMB: Number.isFinite(vramTotalMB) ? vramTotalMB : null,
          thermalState,
        };
      }
    }
  } catch { /* host has no nvidia-smi */ }
  cachedGpuTelemetry = { at: now, data };
  return data;
}

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
      encoders: { nvencH264: false, nvencHevc: false, nvencAv1: false, amfH264: false, qsvH264: false, libx264: false, libx265: false, vp9: false, prores: false },
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

  const hasNvencH264Sym = encoderText.includes("h264_nvenc");
  const hasNvencHevcSym = encoderText.includes("hevc_nvenc");
  const hasNvencAv1Sym = encoderText.includes("av1_nvenc");

  const encoders = {
    nvencH264: hasNvencH264Sym ? probeHardwareEncoder(ffmpegPath, "h264_nvenc") : false,
    nvencHevc: hasNvencHevcSym ? probeHardwareEncoder(ffmpegPath, "hevc_nvenc") : false,
    nvencAv1: hasNvencAv1Sym ? probeHardwareEncoder(ffmpegPath, "av1_nvenc") : false,
    amfH264: encoderText.includes("h264_amf"),
    qsvH264: encoderText.includes("h264_qsv"),
    libx264: encoderText.includes("libx264"),
    libx265: encoderText.includes("libx265"),
    vp9: encoderText.includes("libvpx-vp9"),
    prores: encoderText.includes("prores_ks"),
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

/** Build deterministic FFmpeg encoder flags for container, codec & bitrate targets. */
export function getOptimalGpuEncoderParams({ container = "mp4", codec = "auto", bitrateMbps = 0, quality = "high" } = {}) {
  const backend = detectVideoBackend();
  const isMaster = quality === "master" || quality === "max";
  const targetKbps = bitrateMbps > 0 ? Math.max(150, Math.round(bitrateMbps * 1000)) : 0;
  const reqCodec = String(codec || "auto").toLowerCase();

  if ((container === "webm" || reqCodec === "vp9") && backend.encoders.vp9) {
    const flags = ["-c:v", "libvpx-vp9", "-row-mt", "1", "-deadline", quality === "fast" ? "realtime" : "good"];
    if (targetKbps > 0) flags.push("-b:v", `${targetKbps}k`, "-maxrate", `${Math.round(targetKbps * 1.25)}k`, "-bufsize", `${targetKbps * 2}k`);
    else flags.push("-crf", isMaster ? "18" : "26", "-b:v", "0");
    return { codec: "libvpx-vp9", gpuFlags: flags, hardwareAccelerated: false, backend };
  }

  if (reqCodec === "av1" || reqCodec === "av1_mp4") {
    if (backend.encoders.nvencAv1) {
      const preset = isMaster ? "p5" : quality === "fast" ? "p1" : "p3";
      const flags = ["-c:v", "av1_nvenc", "-preset", preset, "-pix_fmt", "yuv420p"];
      if (targetKbps > 0) flags.push("-rc", "vbr", "-b:v", `${targetKbps}k`, "-maxrate", `${Math.round(targetKbps * 1.2)}k`, "-bufsize", `${targetKbps * 2}k`);
      else flags.push("-rc", "vbr", "-cq", isMaster ? "22" : "27", "-b:v", "0");
      return { codec: "av1_nvenc", gpuFlags: flags, hardwareAccelerated: true, backend };
    }
  }

  if (reqCodec === "hevc" || reqCodec === "h265" || ((reqCodec === "av1" || reqCodec === "av1_mp4") && backend.encoders.nvencHevc)) {
    if (backend.encoders.nvencHevc) {
      const preset = isMaster ? "p5" : quality === "fast" ? "p1" : "p3";
      const flags = ["-c:v", "hevc_nvenc", "-preset", preset, "-tune", "hq", "-tag:v", "hvc1", "-pix_fmt", "yuv420p"];
      if (targetKbps > 0) flags.push("-rc", "vbr", "-b:v", `${targetKbps}k`, "-maxrate", `${Math.round(targetKbps * 1.2)}k`, "-bufsize", `${targetKbps * 2}k`);
      else flags.push("-rc", "vbr", "-cq", isMaster ? "20" : "24", "-b:v", "0");
      return {
        codec: "hevc_nvenc",
        gpuFlags: flags,
        hardwareAccelerated: true,
        fallbackCodec: (reqCodec === "av1" || reqCodec === "av1_mp4") ? "hevc_nvenc" : undefined,
        backend,
      };
    }
    if (backend.encoders.libx265) {
      const crf = isMaster ? "19" : quality === "fast" ? "26" : "22";
      const flags = ["-c:v", "libx265", "-preset", quality === "fast" ? "veryfast" : "medium", "-tag:v", "hvc1", "-pix_fmt", "yuv420p"];
      if (targetKbps > 0) flags.push("-b:v", `${targetKbps}k`, "-maxrate", `${Math.round(targetKbps * 1.2)}k`, "-bufsize", `${targetKbps * 2}k`);
      else flags.push("-crf", crf);
      return {
        codec: "libx265",
        gpuFlags: flags,
        hardwareAccelerated: false,
        fallbackCodec: (reqCodec === "av1" || reqCodec === "av1_mp4") ? "libx265" : undefined,
        backend,
      };
    }
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
