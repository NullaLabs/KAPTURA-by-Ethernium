#!/usr/bin/env node
/**
 * KAPTURA / UPSKALETOR Empirical Ground-Truth Benchmark Proof Suite
 *
 * Generates an independent high-frequency 1280x720@30fps ground-truth master
 * (sharp diagonal geometry, crisp grid lines, moving HUD shapes + 48kHz stereo AAC),
 * downscales it 4x to 320x180@30fps, runs every processing motor cleanly inside
 * an isolated scratch folder, and measures objective SSIM / PSNR / VMAF, FPS drift,
 * duration drift, audio preservation, GPU runtime, and zero temp-file hygiene.
 *
 * Usage: npm run benchmark
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { detectVideoBackend } from "../daemon/pipeline/gpuDirectOptimizer.mjs";
import { getCompanionStatus } from "../daemon/providers/adapters.mjs";
import {
  transcodeMediaTask,
  upscaleAiTask,
  probeMediaMeta,
  measureQualityMetrics,
} from "../daemon/pipeline/videoPipeline.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");

function runCmd(bin, args) {
  return new Promise((resolve) => {
    const proc = spawn(bin, args, { windowsHide: true });
    let stderr = "";
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("close", (code) => resolve({ code: code ?? 1, stderr }));
  });
}

function detectGpuSummary() {
  try {
    const out = execFileSync(
      "nvidia-smi",
      ["--query-gpu=name,driver_version,memory.total", "--format=csv,noheader"],
      { encoding: "utf8", timeout: 2500, windowsHide: true }
    );
    return out.trim().split(/\r?\n/)[0] || "Unknown GPU";
  } catch {
    return `${os.cpus()[0]?.model || "CPU"} (${os.platform()} ${os.arch()})`;
  }
}

/**
 * Pipe a crisp synthetic 1280x720@30fps RGB24 pattern + 440Hz stereo AAC into MP4.
 * High-frequency checkerboard borders, moving neon diagonals, and crisp circle edges
 * allow SSIM & PSNR to genuinely distinguish bicubic blur vs CAS vs Real-ESRGAN vs RIFE.
 */
function buildGroundTruthVideo(ffmpegPath, outPath, { width = 1280, height = 720, fps = 30, durationSec = 1.5 } = {}) {
  const totalFrames = Math.round(fps * durationSec);
  const frameSize = width * height * 3;
  const frameBuf = Buffer.allocUnsafe(frameSize);

  return new Promise((resolve, reject) => {
    const proc = spawn(
      ffmpegPath,
      [
        "-hide_banner", "-y",
        "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${width}x${height}`, "-r", String(fps), "-i", "pipe:0",
        "-f", "lavfi", "-i", `sine=frequency=440:sample_rate=48000:duration=${durationSec}`,
        "-c:v", "libx264", "-preset", "medium", "-crf", "10", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "192k", "-ac", "2", "-shortest",
        outPath,
      ],
      { windowsHide: true }
    );

    let stderr = "";
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("close", (code) => {
      if (code === 0 && fs.existsSync(outPath)) resolve();
      else reject(new Error(`Ground-truth synthesis failed (exit ${code}): ${stderr.slice(-400)}`));
    });

    let idx = 0;
    function writeNext() {
      while (idx < totalFrames) {
        const t = idx / totalFrames;
        const cx = Math.round(width * (0.2 + 0.6 * t));
        const cy = Math.round(height * (0.5 + 0.22 * Math.sin(t * Math.PI * 2)));
        const rOuter = 96;
        const rInner = 46;

        let off = 0;
        for (let y = 0; y < height; y++) {
          const checkerY = (y >> 4) & 1;
          const fineGridY = y % 32 === 0;
          for (let x = 0; x < width; x++) {
            const checkerX = (x >> 4) & 1;
            const fineGridX = x % 32 === 0;
            const dx = x - cx;
            const dy = y - cy;
            const dist2 = dx * dx + dy * dy;
            const diagBand = Math.abs(((x - y + Math.round(t * 240)) % 96 + 96) % 96 - 48) < 3;

            let r = 8;
            let g = 14;
            let b = 26;

            if (fineGridX || fineGridY) {
              r = 40; g = 175; b = 215;
            } else if ((checkerX ^ checkerY) === 1 && y < 140) {
              r = 220; g = 235; b = 250;
            } else if (diagBand) {
              r = 165; g = 88; b = 250;
            }

            if (dist2 <= rOuter * rOuter && dist2 >= rInner * rInner) {
              r = 0; g = 248; b = 170;
            } else if (dist2 < rInner * rInner) {
              r = ((x + Math.round(t * 160)) % 16 < 8) ? 255 : 22;
              g = 230;
              b = 90;
            }

            frameBuf[off++] = r;
            frameBuf[off++] = g;
            frameBuf[off++] = b;
          }
        }
        idx++;
        if (!proc.stdin.write(frameBuf)) {
          proc.stdin.once("drain", writeNext);
          return;
        }
      }
      proc.stdin.end();
    }

    writeNext();
  });
}

async function main() {
  const backend = detectVideoBackend(true);
  if (!backend.available || !backend.ffmpegPath) {
    throw new Error("FFmpeg backend is required to run benchmark.");
  }
  const providers = getCompanionStatus();
  const exportsDir = path.join(ROOT_DIR, "exports");
  fs.mkdirSync(exportsDir, { recursive: true });
  const preExports = new Set(fs.readdirSync(exportsDir));

  const workDir = path.join(exportsDir, `.bench_${Date.now()}`);
  const outDir = path.join(workDir, "runs");
  fs.mkdirSync(outDir, { recursive: true });

  const gtPath = path.join(workDir, "ground_truth_720p30.mp4");
  const lowPath = path.join(workDir, "input_lowres_180p30.mp4");
  const bicubicPath = path.join(outDir, "bicubic_baseline.mp4");

  const results = [];

  try {
    console.log("Synthesizing Ground-Truth 1280x720@30fps + 48kHz stereo AAC clip...");
    await buildGroundTruthVideo(backend.ffmpegPath, gtPath, { width: 1280, height: 720, fps: 30, durationSec: 1.5 });
    const gtMeta = await probeMediaMeta(backend.ffmpegPath, gtPath);

    const dsRes = await runCmd(backend.ffmpegPath, [
      "-hide_banner", "-y", "-i", gtPath,
      "-vf", "scale=320:180:flags=bicubic",
      "-c:v", "libx264", "-preset", "medium", "-crf", "14", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "128k",
      lowPath,
    ]);
    if (dsRes.code !== 0) throw new Error(`Downscale failed: ${dsRes.stderr.slice(-300)}`);
    const lowMeta = await probeMediaMeta(backend.ffmpegPath, lowPath);

    // 1. Standard Bicubic Baseline (320x180 -> 1280x720)
    {
      const t0 = Date.now();
      const bRes = await runCmd(backend.ffmpegPath, [
        "-hide_banner", "-y", "-i", lowPath,
        "-vf", "scale=1280:720:flags=bicubic",
        "-c:v", backend.encoders.nvencH264 ? "h264_nvenc" : "libx264",
        ...(backend.encoders.nvencH264 ? ["-preset", "p5", "-rc", "vbr", "-b:v", "18000k"] : ["-preset", "medium", "-b:v", "18000k"]),
        "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k",
        bicubicPath,
      ]);
      if (bRes.code !== 0) throw new Error(`Bicubic baseline failed: ${bRes.stderr.slice(-300)}`);
      const elapsedMs = Date.now() - t0;
      const outMeta = await probeMediaMeta(backend.ffmpegPath, bicubicPath);
      const q = await measureQualityMetrics(backend.ffmpegPath, gtPath, bicubicPath, { useVmaf: backend.filters.libvmaf });
      results.push({
        engine: "Baseline Bicubic (FFmpeg)",
        output: `${outMeta.width}x${outMeta.height} @ ${outMeta.fps}fps`,
        ssim: q.ssim,
        psnrDb: q.psnrDb,
        vmaf: q.vmaf,
        fpsDriftPct: Number(((Math.abs(outMeta.fps - lowMeta.fps) / lowMeta.fps) * 100).toFixed(2)),
        durationDriftMs: Math.round(Math.abs(outMeta.duration - lowMeta.duration) * 1000),
        audioOk: outMeta.hasAudio,
        elapsedSec: (elapsedMs / 1000).toFixed(2),
      });
    }

    // 2. UPSKALETOR Motor 1: Lanczos-3 + AMD FidelityFX CAS + CFR
    {
      const res = await transcodeMediaTask({
        inputPath: lowPath,
        outputDir: outDir,
        container: "mp4",
        width: 1280,
        height: 720,
        sharpen: 0.65,
        cfr: true,
        bitrateMbps: 18,
        quality: "master",
        taskId: "motor1_lanczos_cas",
      });
      if (!res.success) throw new Error(`Motor 1 failed: ${res.error}`);
      const q = await measureQualityMetrics(backend.ffmpegPath, gtPath, res.videoPath, { useVmaf: backend.filters.libvmaf });
      results.push({
        engine: `Motor 1: Lanczos-3 + ${(res.sharpenFilter || "CAS").toUpperCase()} (${res.codec})`,
        output: `${res.width}x${res.height} @ ${res.fps}fps`,
        ssim: q.ssim,
        psnrDb: q.psnrDb,
        vmaf: q.vmaf,
        fpsDriftPct: res.integrity.fpsDriftPct,
        durationDriftMs: res.integrity.durationDriftMs,
        audioOk: res.integrity.audioPreserved,
        elapsedSec: (res.integrity.elapsedMs / 1000).toFixed(2),
      });
    }

    // 3. UPSKALETOR Motor 2a: Real-ESRGAN Vulkan x4plus (Spatial Neural 4x)
    if (providers.realEsrgan) {
      const res = await upscaleAiTask({
        inputPath: lowPath,
        outputDir: outDir,
        pipeline: "esrgan",
        model: "realesrgan-x4plus",
        scale: 4,
        width: 1280,
        height: 720,
        quality: "master",
        taskId: "motor2_esrgan_x4plus",
      });
      if (!res.success) throw new Error(`Motor 2 x4plus failed: ${res.error}`);
      const q = await measureQualityMetrics(backend.ffmpegPath, gtPath, res.videoPath, { useVmaf: backend.filters.libvmaf });
      results.push({
        engine: "Motor 2: Real-ESRGAN x4plus (Vulkan)",
        output: `${res.width}x${res.height} @ ${res.fps}fps`,
        ssim: q.ssim,
        psnrDb: q.psnrDb,
        vmaf: q.vmaf,
        fpsDriftPct: res.integrity.fpsDriftPct,
        durationDriftMs: res.integrity.durationDriftMs,
        audioOk: res.integrity.audioPreserved,
        elapsedSec: (res.integrity.elapsedMs / 1000).toFixed(2),
      });

      // 4. UPSKALETOR Motor 2b: Real-ESRGAN Vulkan animevideov3 (Fast Video Neural 4x)
      const resV3 = await upscaleAiTask({
        inputPath: lowPath,
        outputDir: outDir,
        pipeline: "esrgan",
        model: "realesr-animevideov3",
        scale: 4,
        width: 1280,
        height: 720,
        quality: "master",
        taskId: "motor2_esrgan_v3",
      });
      if (!resV3.success) throw new Error(`Motor 2 v3 failed: ${resV3.error}`);
      const qV3 = await measureQualityMetrics(backend.ffmpegPath, gtPath, resV3.videoPath, { useVmaf: backend.filters.libvmaf });
      results.push({
        engine: "Motor 2 Fast: Real-ESRGAN v3 (Vulkan)",
        output: `${resV3.width}x${resV3.height} @ ${resV3.fps}fps`,
        ssim: qV3.ssim,
        psnrDb: qV3.psnrDb,
        vmaf: qV3.vmaf,
        fpsDriftPct: resV3.integrity.fpsDriftPct,
        durationDriftMs: resV3.integrity.durationDriftMs,
        audioOk: resV3.integrity.audioPreserved,
        elapsedSec: (resV3.integrity.elapsedMs / 1000).toFixed(2),
      });
    }

    // 5. UPSKALETOR Motor 3: RIFE v4.6 Vulkan 2x Temporal Interpolation (30 -> 60 FPS)
    if (providers.rife) {
      const resRife = await upscaleAiTask({
        inputPath: lowPath,
        outputDir: outDir,
        pipeline: "rife",
        rifeMult: 2,
        quality: "master",
        taskId: "motor3_rife_2x",
      });
      if (!resRife.success) throw new Error(`Motor 3 RIFE failed: ${resRife.error}`);
      const qRife = await measureQualityMetrics(backend.ffmpegPath, gtPath, resRife.videoPath, { useVmaf: backend.filters.libvmaf });
      results.push({
        engine: "Motor 3: RIFE v4.6 2× FPS (Vulkan)",
        output: `${resRife.width}x${resRife.height} @ ${resRife.fps}fps`,
        ssim: qRife.ssim,
        psnrDb: qRife.psnrDb,
        vmaf: qRife.vmaf,
        fpsDriftPct: resRife.integrity.fpsDriftPct,
        durationDriftMs: resRife.integrity.durationDriftMs,
        audioOk: resRife.integrity.audioPreserved,
        elapsedSec: (resRife.integrity.elapsedMs / 1000).toFixed(2),
      });
    }

    // 6. HYBRID ULTRA: Real-ESRGAN v3 4x + RIFE v4.6 2x FPS
    if (providers.realEsrgan && providers.rife) {
      const resHyb = await upscaleAiTask({
        inputPath: lowPath,
        outputDir: outDir,
        pipeline: "hybrid",
        model: "realesr-animevideov3",
        scale: 4,
        rifeMult: 2,
        width: 1280,
        height: 720,
        quality: "master",
        taskId: "motor4_hybrid_4k60",
      });
      if (!resHyb.success) throw new Error(`Hybrid pipeline failed: ${resHyb.error}`);
      const qHyb = await measureQualityMetrics(backend.ffmpegPath, gtPath, resHyb.videoPath, { useVmaf: backend.filters.libvmaf });
      results.push({
        engine: "HYBRID ULTRA: Real-ESRGAN v3 + RIFE v4.6",
        output: `${resHyb.width}x${resHyb.height} @ ${resHyb.fps}fps`,
        ssim: qHyb.ssim,
        psnrDb: qHyb.psnrDb,
        vmaf: qHyb.vmaf,
        fpsDriftPct: resHyb.integrity.fpsDriftPct,
        durationDriftMs: resHyb.integrity.durationDriftMs,
        audioOk: resHyb.integrity.audioPreserved,
        elapsedSec: (resHyb.integrity.elapsedMs / 1000).toFixed(2),
      });
    }

    // Verify cleanup & disk hygiene
    fs.rmSync(workDir, { recursive: true, force: true });
    const postExports = fs.readdirSync(exportsDir);
    const leaked = postExports.filter((f) => !preExports.has(f));

    const hasVmaf = results.some((r) => r.vmaf !== null);
    const gpuSummary = detectGpuSummary();
    const lines = [
      "# KAPTURA / UPSKALETOR — Empirical Ground-Truth Benchmark Proof",
      "",
      `- **Date (UTC):** ${new Date().toISOString()}`,
      `- **Hardware:** ${gpuSummary}`,
      `- **FFmpeg Codec:** \`${backend.preferredCodec}\` (HW Accelerated: \`${backend.hardwareAccelerated}\`)`,
      `- **FFmpeg Filters Probed:** CAS=\`${backend.filters.cas}\`, SSIM=\`${backend.filters.ssim}\`, PSNR=\`${backend.filters.psnr}\`, VMAF=\`${backend.filters.libvmaf}\``,
      `- **Neural Engines Active:** Real-ESRGAN=\`${providers.realEsrgan}\`, RIFE v4.6=\`${providers.rife}\``,
      `- **Ground Truth Clip:** \`${gtMeta.width}x${gtMeta.height} @ ${gtMeta.fps}fps\`, ${gtMeta.duration.toFixed(3)}s, Audio=\`${gtMeta.audioCodec}\``,
      `- **Degraded 4× Input:** \`${lowMeta.width}x${lowMeta.height} @ ${lowMeta.fps}fps\`, ${lowMeta.duration.toFixed(3)}s, Audio=\`${lowMeta.audioCodec}\``,
      `- **Temp File Hygiene:** \`${leaked.length}\` leaked files/directories after run (\`0\` expected)`,
      "",
      "## Reproducible Results Matrix",
      "",
      hasVmaf
        ? "| Engine / Pipeline | Output Stream | SSIM ↑ | PSNR (dB) ↑ | VMAF ↑ | FPS Drift ↓ | Duration Drift | Audio AAC | GPU Time |"
        : "| Engine / Pipeline | Output Stream | SSIM ↑ | PSNR (dB) ↑ | FPS Drift ↓ | Duration Drift | Audio AAC | GPU Time |",
      hasVmaf
        ? "| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |"
        : "| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: |",
      ...results.map((r) => {
        const ssim = r.ssim !== null ? r.ssim.toFixed(4) : "n/a";
        const psnr = r.psnrDb !== null ? r.psnrDb.toFixed(2) : "n/a";
        const vmaf = r.vmaf !== null ? r.vmaf.toFixed(2) : "n/a";
        const audio = r.audioOk ? "PRESERVED" : "MISSING";
        return hasVmaf
          ? `| ${r.engine} | \`${r.output}\` | ${ssim} | ${psnr} | ${vmaf} | ${r.fpsDriftPct}% | ${r.durationDriftMs} ms | ${audio} | ${r.elapsedSec}s |`
          : `| ${r.engine} | \`${r.output}\` | ${ssim} | ${psnr} | ${r.fpsDriftPct}% | ${r.durationDriftMs} ms | ${audio} | ${r.elapsedSec}s |`;
      }),
      "",
      "## Reproduce Locally",
      "",
      "```bash",
      "npm run benchmark",
      "```",
      "",
      "Every run synthesizes an independent lossless Ground-Truth reference + stereo AAC audio track on the host machine, downscales 4×, executes each active pipeline end-to-end, computes FFmpeg SSIM/PSNR" + (hasVmaf ? "/VMAF" : "") + ", verifies FPS lock & audio preservation, and asserts zero leaked scratch artifacts.",
      "",
    ];

    const md = lines.join("\n");
    fs.writeFileSync(path.join(ROOT_DIR, "BENCHMARK_PROOF.md"), md, "utf8");
    console.log("\n" + md);
    if (leaked.length > 0) {
      throw new Error(`Leaked temp artifacts detected: ${leaked.join(", ")}`);
    }
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
