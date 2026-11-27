#!/usr/bin/env node
/**
 * KAPTURA SOVEREIGN STUDIO + GPU DAEMON (:3370)
 * Unified dual-mode HTTP server:
 * 1) Serves the offline-first KAPTURA Studio web workspace (index.html, css/, js/, fonts/)
 * 2) Exposes /health, /status, /capabilities, /telemetry/ebwp, /render, /transcode, and /exports/*
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderVideoTask, transcodeMediaTask, trimMediaTask, upscaleAiTask, probeMediaMeta, estimateProfileEtas, cancelTask, createLiveCaptureSession } from "./pipeline/videoPipeline.mjs";
import { removeBgTask } from "./pipeline/bgRemovePipeline.mjs";
import { releaseWarmWorkers, getWarmWorkerStatus } from "./pipeline/bgWarmWorker.mjs";
import { detectVideoBackend, probeGpuTelemetry } from "./pipeline/gpuDirectOptimizer.mjs";
import { getCompanionStatus } from "./providers/adapters.mjs";
import { ebwpProtocol, EBWP_OPCODES } from "./synkronia/ebwpProtocol.mjs";
import { hlcEngine } from "./synkronia/hlcClock.mjs";
import { createIpcClient } from "./synkronia/ipcClient.mjs";
import { attachWebSocketServer } from "./synkronia/wsServer.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(__dirname, "..");
const DAEMON_VERSION = (() => {
  try {
    return fs.readFileSync(path.join(DEFAULT_ROOT, "VERSION"), "utf8").trim() || "3.1.0";
  } catch {
    return "3.1.0";
  }
})();

const MIME_MAP = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json; charset=utf-8",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".gif": "image/gif",
};

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function readRequestBody(req, maxBytes = 250 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error(`Payload exceeds max limit (${maxBytes} bytes)`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function normalizeUploadExt(raw, fallback = ".webm") {
  const s = String(raw || "").trim().toLowerCase();
  const base = s.includes("/") || s.includes("\\") ? path.basename(s) : s;
  const candidate = base.startsWith(".") ? base : (base.includes(".") ? path.extname(base) : `.${base}`);
  return /^\.[a-z0-9]{2,6}$/.test(candidate) ? candidate : fallback;
}

function streamRequestToFile(req, destPath, maxBytes = 2 * 1024 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(destPath);
    let total = 0;
    let settled = false;
    const cleanup = (err) => {
      if (settled) return;
      settled = true;
      try { ws.destroy(); } catch {}
      try { if (fs.existsSync(destPath)) fs.unlinkSync(destPath); } catch {}
      reject(err);
    };
    req.on("data", (chunk) => {
      if (settled) return;
      total += chunk.length;
      if (total > maxBytes) {
        req.destroy();
        cleanup(new Error(`Payload exceeds max limit (${maxBytes} bytes)`));
        return;
      }
      if (!ws.write(chunk)) req.pause();
    });
    ws.on("drain", () => { if (!settled) req.resume(); });
    req.on("end", () => {
      if (!settled) ws.end();
    });
    ws.on("close", () => {
      if (!settled) {
        settled = true;
        resolve(total);
      }
    });
    req.on("error", cleanup);
    req.on("aborted", () => cleanup(new Error("Upload stream aborted")));
    ws.on("error", cleanup);
  });
}

function safeStaticFile(baseDir, relPath) {
  const base = path.resolve(baseDir);
  const candidate = path.resolve(base, relPath.replace(/^\/+/, ""));
  if (candidate !== base && !candidate.startsWith(base + path.sep)) return null;
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) return null;
  return candidate;
}

export function createKapturaDaemon({
  port = Number(process.env.ETHERNIUM_KAPTURA_PORT || 3370),
  host = "127.0.0.1",
  rootDir = DEFAULT_ROOT,
  connectIpc = false,
} = {}) {
  const exportsDir = path.join(rootDir, "exports");
  const vaultExportsDir = path.join(exportsDir, "vault");
  const jobsRegistryPath = path.join(exportsDir, ".jobs_registry.json");
  fs.mkdirSync(exportsDir, { recursive: true });
  fs.mkdirSync(vaultExportsDir, { recursive: true });
  let activePort = port;
  let ipcHandle = null;
  const sseClients = new Set();
  const jobs = new Map();
  const gpuQueue = [];
  let gpuRunning = false;

  const saveJobsRegistry = () => {
    try {
      const list = Array.from(jobs.values()).slice(-64);
      const tmp = `${jobsRegistryPath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(list), "utf8");
      fs.renameSync(tmp, jobsRegistryPath);
    } catch { /* non-fatal registry persistence */ }
  };

  const loadJobsRegistry = () => {
    try {
      if (!fs.existsSync(jobsRegistryPath)) return;
      const parsed = JSON.parse(fs.readFileSync(jobsRegistryPath, "utf8"));
      if (!Array.isArray(parsed)) return;
      let changed = false;
      for (const rec of parsed.slice(-64)) {
        if (!rec || !rec.taskId) continue;
        if (rec.status === "running" || rec.status === "queued") {
          rec.status = "interrupted";
          rec.stage = "INTERRUPTED";
          rec.queuePosition = 0;
          rec.error = "Interrumpido por reinicio del daemon :3370.";
          rec.updatedAt = Date.now();
          changed = true;
        }
        jobs.set(rec.taskId, rec);
      }
      if (changed) saveJobsRegistry();
    } catch { /* ignore malformed registry */ }
  };
  loadJobsRegistry();

  const pruneJobsMap = () => {
    while (jobs.size >= 64) {
      const oldestKey = jobs.keys().next().value;
      if (!oldestKey) break;
      jobs.delete(oldestKey);
    }
  };

  const syncQueuePositions = () => {
    let pos = 1;
    for (const entry of gpuQueue) {
      if (!entry.cancelled && entry.jobRec && entry.jobRec.status === "queued") {
        entry.jobRec.queuePosition = pos++;
      }
    }
  };

  const drainGpuQueue = () => {
    if (gpuRunning) return;
    while (gpuQueue.length > 0) {
      const next = gpuQueue.shift();
      syncQueuePositions();
      if (!next || next.cancelled || (next.jobRec && next.jobRec.status === "cancelled")) {
        saveJobsRegistry();
        continue;
      }
      gpuRunning = true;
      next.jobRec.status = "running";
      next.jobRec.queuePosition = 0;
      next.jobRec.stage = "GPU_START";
      next.jobRec.updatedAt = Date.now();
      emitProgressEvent({ taskId: next.taskId, stage: "GPU_START", progress: next.jobRec.progress || 5 });
      Promise.resolve()
        .then(() => next.runner())
        .catch(() => {})
        .finally(() => {
          gpuRunning = false;
          saveJobsRegistry();
          setImmediate(drainGpuQueue);
        });
      break;
    }
  };

  const enqueueGpuJob = (taskId, jobRec, runner) => {
    pruneJobsMap();
    const shouldQueue = gpuRunning || gpuQueue.length > 0;
    jobRec.status = shouldQueue ? "queued" : "running";
    jobRec.stage = shouldQueue ? "QUEUED" : "STARTING";
    jobRec.queuePosition = shouldQueue ? (gpuQueue.length + 1) : 0;
    jobs.set(taskId, jobRec);
    saveJobsRegistry();
    gpuQueue.push({ taskId, jobRec, runner, cancelled: false });
    drainGpuQueue();
  };

  const emitProgressEvent = (evt) => {
    if (evt && evt.taskId && jobs.has(evt.taskId)) {
      const cur = jobs.get(evt.taskId);
      if (cur && cur.status === "running") {
        Object.assign(cur, {
          progress: evt.progress ?? cur.progress,
          stage: evt.stage || cur.stage,
          frame: evt.frame ?? cur.frame,
          totalFrames: evt.totalFrames ?? cur.totalFrames,
          segment: evt.segment ?? cur.segment,
          totalSegments: evt.totalSegments ?? cur.totalSegments,
          secPerFrame: evt.secPerFrame ?? cur.secPerFrame,
          etaSec: evt.etaSec ?? cur.etaSec,
          model: evt.model ?? cur.model,
          scale: evt.scale ?? cur.scale,
          updatedAt: Date.now(),
        });
      }
    }
    const payload = `event: progress\ndata: ${JSON.stringify(evt)}\n\n`;
    for (const client of sseClients) {
      try { client.write(payload); } catch { sseClients.delete(client); }
    }
  };

  const sseKeepAlive = setInterval(() => {
    for (const client of sseClients) {
      try { client.write(`: ping\n\n`); } catch { sseClients.delete(client); }
    }
  }, 20000);
  sseKeepAlive.unref();

  const resolveExportRef = (ref) => {
    if (!ref) return null;
    const cleanPath = String(ref).split("?")[0].replace(/^https?:\/\/[^/]+/i, "").replace(/^\/?exports\//i, "");
    try {
      return safeStaticFile(exportsDir, decodeURIComponent(cleanPath));
    } catch {
      return null;
    }
  };

  const buildHealthPayload = () => {
    const backend = detectVideoBackend();
    const providers = getCompanionStatus();
    return {
      ok: true,
      online: true,
      status: "online",
      engine: "KAPTURA SOVEREIGN STUDIO + GPU DAEMON",
      version: DAEMON_VERSION,
      port: activePort,
      capabilities: {
        ffmpegAvailable: backend.available,
        preferredCodec: backend.preferredCodec,
        hardwareAccelerated: backend.hardwareAccelerated,
        neuralAvailable: Boolean(providers.realEsrgan),
        rifeAvailable: Boolean(providers.rife),
        bgRemoval: providers.bgRemoval,
        casFilter: Boolean(backend.filters && backend.filters.cas),
        encoders: backend.encoders,
      },
      gpu: probeGpuTelemetry(),
      warmWorkers: getWarmWorkerStatus(),
      streaming: {
        wsCapture: "/ws/capture",
        sseEvents: "/events",
        rangeSupported: true,
        probeEndpoint: "/probe",
        trimEndpoint: "/trim",
        upscaleAiEndpoint: "/upscale-ai",
        removeBgEndpoint: "/remove-bg",
        gpuTelemetryEndpoint: "/telemetry/gpu",
        vaultPinEndpoint: "/vault/pin",
        cancelEndpoint: "/cancel",
        jobsEndpoint: "/jobs",
      },
      providers: {
        etherniumVox: providers.etherniumVox,
        fontForge: providers.fontForge,
        upskalator: providers.upskalator,
        realEsrgan: Boolean(providers.realEsrgan),
        rife: Boolean(providers.rife),
        bgRemoval: providers.bgRemoval,
      },
      hlc: hlcEngine.now(),
    };
  };

  function applyForensicHeaders(hdrs, result) {
    const it = result && result.integrity ? result.integrity : null;
    if (!it) return hdrs;
    if (it.srcWidth && it.srcHeight) hdrs["X-Kaptura-Src-Res"] = `${it.srcWidth}x${it.srcHeight}`;
    if (it.outWidth && it.outHeight) hdrs["X-Kaptura-Out-Res"] = `${it.outWidth}x${it.outHeight}`;
    if (it.srcFps) hdrs["X-Kaptura-Src-Fps"] = String(it.srcFps);
    if (it.outFps) hdrs["X-Kaptura-Out-Fps"] = String(it.outFps);
    if (it.fpsDriftPct !== undefined) hdrs["X-Kaptura-Fps-Drift-Pct"] = String(it.fpsDriftPct);
    if (it.durationDriftMs !== undefined) hdrs["X-Kaptura-Duration-Drift-Ms"] = String(it.durationDriftMs);
    if (it.audioPreserved !== null && it.audioPreserved !== undefined) {
      hdrs["X-Kaptura-Audio-Preserved"] = String(Boolean(it.audioPreserved));
    }
    if (it.audioCodec) hdrs["X-Kaptura-Audio-Codec"] = String(it.audioCodec);
    if (it.elapsedMs !== undefined) hdrs["X-Kaptura-Elapsed-Ms"] = String(it.elapsedMs);
    return hdrs;
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, POST, DELETE, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Range, Accept, X-Kaptura-Ext, X-Kaptura-Container, X-Kaptura-Codec, X-Kaptura-Width, X-Kaptura-Height, X-Kaptura-Fps, X-Kaptura-Bitrate, X-Kaptura-Target-MB, X-Kaptura-Quality, X-Kaptura-Sharpen, X-Kaptura-Cfr, X-Kaptura-Ai-Model, X-Kaptura-Scale, X-Kaptura-Denoise, X-Kaptura-Pipeline, X-Kaptura-Rife-Mult, X-Kaptura-Start-Sec, X-Kaptura-End-Sec, X-Kaptura-Preview-Sec, X-Kaptura-Preview-Start, X-Kaptura-Task-Id, X-Kaptura-Source-Export, X-Kaptura-Reencode, X-Kaptura-Async, X-Kaptura-Bg-Engine, X-Kaptura-Bg-Backdrop, X-Kaptura-Bg-Color, X-Kaptura-Bg-Blur, X-Kaptura-Bg-Edge, X-Kaptura-Bg-Decontaminate, X-Kaptura-Bg-Key-Color, X-Kaptura-Bg-Similarity, X-Kaptura-Bg-Blend, X-Kaptura-Bg-Image-Ref, X-Kaptura-Bg-Precision, X-Kaptura-Bg-Light-Wrap, X-Kaptura-Bg-Harmonize"
    );
    res.setHeader(
      "Access-Control-Expose-Headers",
      "X-Kaptura-Codec, X-Kaptura-HW, X-Kaptura-Model, X-Kaptura-Pipeline, X-Kaptura-Src-Res, X-Kaptura-Out-Res, X-Kaptura-Src-Fps, X-Kaptura-Out-Fps, X-Kaptura-Fps-Drift-Pct, X-Kaptura-Duration-Drift-Ms, X-Kaptura-Audio-Preserved, X-Kaptura-Audio-Codec, X-Kaptura-Elapsed-Ms"
    );

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || "/", `http://${req.headers.host || `${host}:${activePort}`}`);
    const pathname = url.pathname;

    if (req.method === "GET" && (pathname === "/health" || pathname === "/status" || pathname === "/capabilities")) {
      return sendJson(res, 200, buildHealthPayload());
    }

    if (req.method === "GET" && pathname === "/telemetry/gpu") {
      return sendJson(res, 200, { ok: true, ...probeGpuTelemetry() });
    }

    if (req.method === "GET" && pathname === "/telemetry/ebwp") {
      const hlc = hlcEngine.now();
      const backend = detectVideoBackend();
      const frame = ebwpProtocol.encode(
        EBWP_OPCODES.TELEMETRY,
        "kaptura-video-3370",
        BigInt(hlc.l),
        hlc.c,
        backend.hardwareAccelerated ? 1.0 : 0.0,
        Number(ebwpProtocol.packetsEncoded),
        0.0
      );
      const decoded = ebwpProtocol.decode(frame);
      return sendJson(res, 200, {
        ok: true,
        byteLength: frame.byteLength,
        magic: "0x3669",
        hex: Buffer.from(frame).toString("hex"),
        decoded,
      });
    }

    if (req.method === "GET" && pathname === "/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      });
      res.write(`event: ready\ndata: ${JSON.stringify({ ok: true })}\n\n`);
      sseClients.add(res);
      req.on("close", () => sseClients.delete(res));
      return;
    }

    if ((req.method === "GET" || req.method === "HEAD") && pathname.startsWith("/exports/")) {
      const rel = decodeURIComponent(pathname.slice("/exports/".length));
      const exportFile = safeStaticFile(exportsDir, rel);
      if (!exportFile) return sendJson(res, 404, { error: "Export artifact not found" });
      const ext = path.extname(exportFile).toLowerCase();
      const totalSize = fs.statSync(exportFile).size;
      const mimeType = MIME_MAP[ext] || "application/octet-stream";
      const rangeHeader = req.headers.range;

      if (rangeHeader && totalSize > 0) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(String(rangeHeader).trim());
        if (!match) {
          res.writeHead(416, { "Content-Range": `bytes */${totalSize}` });
          return res.end();
        }
        let start = match[1] ? parseInt(match[1], 10) : 0;
        let end = match[2] ? parseInt(match[2], 10) : totalSize - 1;
        if (!match[1] && match[2]) {
          const suffixLen = parseInt(match[2], 10);
          start = Math.max(0, totalSize - suffixLen);
          end = totalSize - 1;
        }
        if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= totalSize) {
          res.writeHead(416, { "Content-Range": `bytes */${totalSize}` });
          return res.end();
        }
        end = Math.min(end, totalSize - 1);
        res.writeHead(206, {
          "Content-Range": `bytes ${start}-${end}/${totalSize}`,
          "Accept-Ranges": "bytes",
          "Content-Length": end - start + 1,
          "Content-Type": mimeType,
        });
        if (req.method === "HEAD") return res.end();
        return fs.createReadStream(exportFile, { start, end }).pipe(res);
      }

      res.writeHead(200, {
        "Content-Type": mimeType,
        "Content-Length": totalSize,
        "Accept-Ranges": "bytes",
      });
      if (req.method === "HEAD") return res.end();
      return fs.createReadStream(exportFile).pipe(res);
    }

    if (req.method === "DELETE" && pathname.startsWith("/exports/vault/")) {
      const rawRel = decodeURIComponent(pathname.slice("/exports/vault/".length)).replace(/^\/+/, "");
      const pinnedFile = rawRel && !rawRel.includes("/") && !rawRel.includes("\\") ? safeStaticFile(vaultExportsDir, rawRel) : null;
      if (!pinnedFile) return sendJson(res, 404, { ok: false, error: "Pinned vault artifact not found" });
      try {
        fs.unlinkSync(pinnedFile);
        return sendJson(res, 200, { ok: true, deleted: true, fileName: path.basename(pinnedFile) });
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    }

    if (req.method === "POST" && pathname === "/vault/pin") {
      try {
        const rawJson = await readRequestBody(req, 1024 * 1024);
        let body;
        try {
          body = JSON.parse(rawJson.toString("utf8") || "{}");
        } catch {
          return sendJson(res, 400, { ok: false, error: "Invalid JSON payload" });
        }
        const resolved = resolveExportRef(body.sourceUrl || body.exportFile);
        if (!resolved) {
          return sendJson(res, 404, { ok: false, error: "Referenced export artifact not found on disk." });
        }
        const fileName = path.basename(resolved);
        const destPath = path.join(vaultExportsDir, fileName);
        if (path.resolve(resolved) !== path.resolve(destPath)) {
          fs.copyFileSync(resolved, destPath);
        }
        const st = fs.statSync(destPath);
        return sendJson(res, 200, {
          ok: true,
          pinned: true,
          fileName,
          sizeBytes: st.size,
          downloadUrl: `/exports/vault/${encodeURIComponent(fileName)}`,
        });
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    }

    if (req.method === "POST" && pathname === "/vault/check") {
      try {
        const rawJson = await readRequestBody(req, 1024 * 1024);
        const body = JSON.parse(rawJson.toString("utf8") || "{}");
        const urls = Array.isArray(body.urls) ? body.urls.slice(0, 500) : [];
        const alive = {};
        for (const u of urls) {
          if (typeof u !== "string" || !u) continue;
          alive[u] = Boolean(resolveExportRef(u));
        }
        return sendJson(res, 200, { ok: true, alive });
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    }

    if (req.method === "POST" && pathname === "/probe") {
      let probeTmp = "";
      try {
        const backend = detectVideoBackend();
        if (!backend.available || !backend.ffmpegPath) {
          return sendJson(res, 422, { ok: false, error: "FFmpeg binary not detected on host." });
        }
        const h = req.headers;
        const sourceExport = String(h["x-kaptura-source-export"] || url.searchParams.get("sourceExport") || "");
        let targetPath = "";
        if (sourceExport) {
          const resolved = resolveExportRef(sourceExport);
          if (!resolved) return sendJson(res, 404, { ok: false, error: "Referenced export artifact not found." });
          targetPath = resolved;
        } else {
          const rawExt = normalizeUploadExt(h["x-kaptura-ext"] || url.searchParams.get("ext"), ".mp4");
          probeTmp = path.join(exportsDir, `.tmp_probe_${Date.now()}_${Math.random().toString(36).slice(2, 6)}${rawExt}`);
          const bytes = await streamRequestToFile(req, probeTmp, 512 * 1024 * 1024);
          if (!bytes) {
            try { if (fs.existsSync(probeTmp)) fs.unlinkSync(probeTmp); } catch {}
            return sendJson(res, 400, { ok: false, status: "empty_input", error: "Empty media payload (0 bytes)." });
          }
          targetPath = probeTmp;
        }
        const meta = await probeMediaMeta(backend.ffmpegPath, targetPath);
        const providers = getCompanionStatus();
        const estimates = estimateProfileEtas(meta, providers);
        return sendJson(res, 200, {
          ok: true,
          ...meta,
          already4k: (meta.width || 0) >= 3840,
          estimates,
        });
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
      } finally {
        if (probeTmp) try { if (fs.existsSync(probeTmp)) fs.unlinkSync(probeTmp); } catch {}
      }
    }

    if (req.method === "POST" && pathname === "/trim") {
      try {
        const h = req.headers;
        const ctype = String(h["content-type"] || "").toLowerCase();
        let inputPath = "";
        let inputBuffer = null;
        let inputExt = String(h["x-kaptura-ext"] || url.searchParams.get("ext") || ".mp4");
        let startSec = Number(h["x-kaptura-start-sec"] || url.searchParams.get("startSec") || 0);
        let endSec = Number(h["x-kaptura-end-sec"] || url.searchParams.get("endSec") || 0);
        let reencode = String(h["x-kaptura-reencode"] || url.searchParams.get("reencode") || "") === "true";
        let taskId = String(h["x-kaptura-task-id"] || url.searchParams.get("taskId") || "");

        if (ctype.includes("application/json")) {
          const rawJson = await readRequestBody(req, 1024 * 1024);
          let body;
          try {
            body = JSON.parse(rawJson.toString("utf8") || "{}");
          } catch {
            return sendJson(res, 400, { success: false, error: "Invalid JSON payload" });
          }
          const resolved = resolveExportRef(body.sourceUrl || body.exportFile);
          if (!resolved) {
            return sendJson(res, 400, { success: false, status: "missing_input", error: "Valid sourceUrl or exportFile in /exports/ is required." });
          }
          inputPath = resolved;
          inputExt = path.extname(resolved).toLowerCase() || ".mp4";
          startSec = Number(body.startSec ?? startSec) || 0;
          endSec = Number(body.endSec ?? endSec) || 0;
          reencode = Boolean(body.reencode ?? reencode);
          taskId = String(body.taskId || taskId || "");
        } else {
          const sourceExport = String(h["x-kaptura-source-export"] || url.searchParams.get("sourceExport") || "");
          if (sourceExport) {
            const resolved = resolveExportRef(sourceExport);
            if (!resolved) return sendJson(res, 404, { success: false, status: "missing_input", error: "Referenced export file not found." });
            inputPath = resolved;
            inputExt = path.extname(resolved).toLowerCase() || ".mp4";
          } else {
            const raw = await readRequestBody(req);
            if (!raw.length) {
              return sendJson(res, 400, { success: false, status: "empty_input", error: "Empty media payload (0 bytes)." });
            }
            inputBuffer = raw;
          }
        }

        const result = await trimMediaTask({
          inputPath,
          inputBuffer,
          inputExt,
          outputDir: exportsDir,
          startSec,
          endSec,
          reencode,
          taskId,
          onProgress: emitProgressEvent,
        });
        if (!result.success) {
          return sendJson(res, result.status === "missing_input" || result.status === "empty_input" ? 400 : 422, result);
        }
        return sendJson(res, 200, { ...result, downloadUrl: `/exports/${result.outputFile}` });
      } catch (err) {
        return sendJson(res, 500, { success: false, error: err instanceof Error ? err.message : String(err) });
      }
    }

    if (req.method === "GET" && pathname === "/jobs") {
      const list = Array.from(jobs.values()).slice(-32).reverse();
      return sendJson(res, 200, {
        ok: true,
        activeCount: gpuRunning ? 1 : 0,
        queuedCount: gpuQueue.filter((e) => !e.cancelled).length,
        jobs: list,
      });
    }

    if (req.method === "GET" && pathname.startsWith("/jobs/")) {
      const targetJobId = decodeURIComponent(pathname.slice("/jobs/".length)).trim();
      const job = targetJobId ? jobs.get(targetJobId) : null;
      if (!job) return sendJson(res, 404, { ok: false, error: "Job not found" });
      return sendJson(res, 200, job);
    }

    if (req.method === "POST" && pathname === "/transcode") {
      let uploadTmpPath = "";
      try {
        const h = req.headers;
        const isAsync = url.searchParams.get("async") === "1" || String(h["x-kaptura-async"] || "") === "1";
        const sourceExport = String(h["x-kaptura-source-export"] || url.searchParams.get("sourceExport") || "");
        const container = String(h["x-kaptura-container"] || url.searchParams.get("container") || "mp4");
        const codec = String(h["x-kaptura-codec"] || url.searchParams.get("codec") || "auto");
        const taskId = String(h["x-kaptura-task-id"] || url.searchParams.get("taskId") || `tx_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);
        let inputPath = "";
        if (sourceExport) {
          const resolved = resolveExportRef(sourceExport);
          if (!resolved) {
            return sendJson(res, 404, { success: false, status: "missing_input", error: "Referenced export artifact not found." });
          }
          inputPath = resolved;
        } else {
          const rawExt = normalizeUploadExt(h["x-kaptura-ext"] || url.searchParams.get("ext"), ".webm");
          uploadTmpPath = path.join(exportsDir, `.tmp_upload_${taskId}${rawExt}`);
          const bytes = await streamRequestToFile(req, uploadTmpPath);
          if (!bytes) {
            try { if (fs.existsSync(uploadTmpPath)) fs.unlinkSync(uploadTmpPath); } catch {}
            return sendJson(res, 400, { success: false, status: "empty_input", error: "Empty media payload (0 bytes)." });
          }
          inputPath = uploadTmpPath;
        }
        const inputExt = path.extname(inputPath).toLowerCase() || ".webm";
        const width = Number(h["x-kaptura-width"] || url.searchParams.get("width") || 0);
        const height = Number(h["x-kaptura-height"] || url.searchParams.get("height") || 0);
        const fps = Number(h["x-kaptura-fps"] || url.searchParams.get("fps") || 0);
        const bitrateMbps = Number(h["x-kaptura-bitrate"] || url.searchParams.get("bitrate") || 0);
        const targetMB = Number(h["x-kaptura-target-mb"] || url.searchParams.get("targetMB") || 0);
        const quality = String(h["x-kaptura-quality"] || url.searchParams.get("quality") || "high");
        const sharpen = Number(h["x-kaptura-sharpen"] || url.searchParams.get("sharpen") || 0);
        const cfrHeader = String(h["x-kaptura-cfr"] || url.searchParams.get("cfr") || "").toLowerCase();
        const cfr = cfrHeader === "1" || cfrHeader === "true";
        const startSec = Number(h["x-kaptura-start-sec"] || url.searchParams.get("startSec") || 0);
        const endSec = Number(h["x-kaptura-end-sec"] || url.searchParams.get("endSec") || 0);
        const previewSec = Number(h["x-kaptura-preview-sec"] || url.searchParams.get("previewSec") || 0);
        const previewStartSec = Number(h["x-kaptura-preview-start"] || url.searchParams.get("previewStart") || 0);

        const taskParams = {
          inputPath,
          inputBuffer: null,
          inputExt,
          outputDir: exportsDir,
          container,
          codec,
          width,
          height,
          fps,
          bitrateMbps,
          targetMB,
          quality,
          sharpen,
          cfr,
          startSec,
          endSec,
          previewSec,
          previewStartSec,
          taskId,
          onProgress: emitProgressEvent,
        };

        if (isAsync) {
          const jobRec = {
            ok: true,
            taskId,
            kind: "transcode",
            status: "running",
            progress: 5,
            stage: "QUEUED",
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };
          const tmpToClean = uploadTmpPath;
          enqueueGpuJob(taskId, jobRec, async () => {
            try {
              const result = await transcodeMediaTask(taskParams);
              if (!result.success) {
                Object.assign(jobRec, {
                  status: result.status === "cancelled" ? "cancelled" : "failed",
                  error: result.error || result.status || "Transcode failed",
                  stage: result.status === "cancelled" ? "CANCELLED" : "FAILED",
                  updatedAt: Date.now(),
                });
              } else {
                Object.assign(jobRec, {
                  ...result,
                  status: "completed",
                  progress: 100,
                  stage: "COMPLETE",
                  downloadUrl: `/exports/${result.outputFile}`,
                  updatedAt: Date.now(),
                });
              }
            } catch (err) {
              Object.assign(jobRec, { status: "failed", stage: "FAILED", error: err instanceof Error ? err.message : String(err), updatedAt: Date.now() });
            } finally {
              if (tmpToClean) try { if (fs.existsSync(tmpToClean)) fs.unlinkSync(tmpToClean); } catch {}
              saveJobsRegistry();
            }
          });
          return sendJson(res, 202, {
            ok: true,
            taskId,
            status: jobRec.status,
            queuePosition: jobRec.queuePosition || 0,
            pollUrl: `/jobs/${encodeURIComponent(taskId)}`,
          });
        }

        let result;
        try {
          result = await transcodeMediaTask(taskParams);
        } finally {
          if (uploadTmpPath) try { if (fs.existsSync(uploadTmpPath)) fs.unlinkSync(uploadTmpPath); } catch {}
        }

        if (!result.success) {
          const code = result.status === "cancelled" ? 409 : (result.status === "empty_input" || result.status === "missing_input" ? 400 : 422);
          return sendJson(res, code, result);
        }
        if (url.searchParams.get("download") === "1" || h["accept"] === "application/octet-stream") {
          const ext = path.extname(result.outputFile).toLowerCase();
          const hdrs = applyForensicHeaders({
            "Content-Type": MIME_MAP[ext] || "video/mp4",
            "Content-Disposition": `attachment; filename="${result.outputFile}"`,
            "X-Kaptura-Codec": result.codec || "",
            "X-Kaptura-HW": String(Boolean(result.hardwareAccelerated)),
          }, result);
          res.writeHead(200, hdrs);
          const fileStream = fs.createReadStream(result.videoPath);
          fileStream.once("close", () => {
            try { if (fs.existsSync(result.videoPath)) fs.unlinkSync(result.videoPath); } catch {}
          });
          return fileStream.pipe(res);
        }
        return sendJson(res, 200, { ...result, downloadUrl: `/exports/${result.outputFile}` });
      } catch (err) {
        if (uploadTmpPath) try { if (fs.existsSync(uploadTmpPath)) fs.unlinkSync(uploadTmpPath); } catch {}
        return sendJson(res, 500, { success: false, error: err instanceof Error ? err.message : String(err) });
      }
    }

    if (req.method === "POST" && pathname.startsWith("/cancel/")) {
      const targetTaskId = decodeURIComponent(pathname.slice("/cancel/".length)).trim();
      if (!targetTaskId) {
        return sendJson(res, 400, { ok: false, error: "Task ID is required." });
      }
      let cancelledQueued = false;
      for (const entry of gpuQueue) {
        if (entry.taskId === targetTaskId && !entry.cancelled) {
          entry.cancelled = true;
          cancelledQueued = true;
        }
      }
      const resCancel = cancelTask(targetTaskId);
      const job = jobs.get(targetTaskId);
      if (job && (job.status === "running" || job.status === "queued")) {
        job.status = "cancelled";
        job.stage = "CANCELLED";
        job.queuePosition = 0;
        job.updatedAt = Date.now();
        syncQueuePositions();
        saveJobsRegistry();
      }
      const cancelled = Boolean(resCancel.cancelled || cancelledQueued);
      if (cancelled) {
        emitProgressEvent({ taskId: targetTaskId, stage: "CANCELLED", progress: 0 });
      }
      return sendJson(res, 200, { ok: true, taskId: targetTaskId, cancelled });
    }

    if (req.method === "POST" && pathname === "/remove-bg/backdrop") {
      try {
        const rawExt = normalizeUploadExt(req.headers["x-kaptura-ext"] || url.searchParams.get("ext"), ".png");
        const refName = `.tmp_bg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}${rawExt}`;
        const destPath = path.join(exportsDir, refName);
        const bytes = await streamRequestToFile(req, destPath, 40 * 1024 * 1024);
        if (!bytes) {
          try { if (fs.existsSync(destPath)) fs.unlinkSync(destPath); } catch {}
          return sendJson(res, 400, { ok: false, error: "Empty backdrop image (0 bytes)." });
        }
        return sendJson(res, 200, { ok: true, backdropRef: refName, sizeBytes: bytes });
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    }

    if (req.method === "POST" && pathname === "/remove-bg") {
      let uploadTmpPath = "";
      let bgImageTmpPath = "";
      try {
        const h = req.headers;
        const isAsync = url.searchParams.get("async") === "1" || String(h["x-kaptura-async"] || "") === "1";
        const sourceExport = String(h["x-kaptura-source-export"] || url.searchParams.get("sourceExport") || "");
        const taskId = String(h["x-kaptura-task-id"] || url.searchParams.get("taskId") || `bg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);
        let inputPath = "";
        if (sourceExport) {
          const resolved = resolveExportRef(sourceExport);
          if (!resolved) {
            return sendJson(res, 404, { success: false, status: "missing_input", error: "Referenced export artifact not found." });
          }
          inputPath = resolved;
        } else {
          const rawExt = normalizeUploadExt(h["x-kaptura-ext"] || url.searchParams.get("ext"), ".png");
          uploadTmpPath = path.join(exportsDir, `.tmp_upload_${taskId}${rawExt}`);
          const bytes = await streamRequestToFile(req, uploadTmpPath);
          if (!bytes) {
            try { if (fs.existsSync(uploadTmpPath)) fs.unlinkSync(uploadTmpPath); } catch {}
            return sendJson(res, 400, { success: false, status: "empty_input", error: "Empty media payload (0 bytes)." });
          }
          inputPath = uploadTmpPath;
        }

        const bgRef = String(h["x-kaptura-bg-image-ref"] || url.searchParams.get("bgRef") || "").trim();
        if (bgRef && !bgRef.includes("/") && !bgRef.includes("\\") && bgRef.startsWith(".tmp_bg_")) {
          const candidateBg = path.join(exportsDir, bgRef);
          if (fs.existsSync(candidateBg) && fs.statSync(candidateBg).isFile()) {
            bgImageTmpPath = candidateBg;
          }
        }

        const taskParams = {
          inputPath,
          inputBuffer: null,
          inputExt: path.extname(inputPath).toLowerCase() || ".png",
          outputDir: exportsDir,
          engine: String(h["x-kaptura-bg-engine"] || url.searchParams.get("engine") || "auto"),
          backdrop: String(h["x-kaptura-bg-backdrop"] || url.searchParams.get("backdrop") || "transparent"),
          bgColor: String(h["x-kaptura-bg-color"] || url.searchParams.get("bgColor") || "#050814"),
          bgImagePath: bgImageTmpPath,
          blurStrength: Number(h["x-kaptura-bg-blur"] || url.searchParams.get("blurStrength") || 23),
          edgeRefine: Number(h["x-kaptura-bg-edge"] || url.searchParams.get("edgeRefine") || 0),
          decontaminate: String(h["x-kaptura-bg-decontaminate"] ?? url.searchParams.get("decontaminate") ?? "1") !== "0",
          keyColor: String(h["x-kaptura-bg-key-color"] || url.searchParams.get("keyColor") || "#00FF00"),
          similarity: Number(h["x-kaptura-bg-similarity"] || url.searchParams.get("similarity") || 0.18),
          blend: Number(h["x-kaptura-bg-blend"] || url.searchParams.get("blend") || 0.08),
          codec: String(h["x-kaptura-codec"] || url.searchParams.get("codec") || "auto"),
          previewSec: Number(h["x-kaptura-preview-sec"] || url.searchParams.get("previewSec") || 0),
          previewStartSec: Number(h["x-kaptura-preview-start"] || url.searchParams.get("previewStart") || 0),
          precision: String(h["x-kaptura-bg-precision"] || url.searchParams.get("precision") || "max"),
          lightWrap: Number(h["x-kaptura-bg-light-wrap"] || url.searchParams.get("lightWrap") || 0),
          harmonize: Number(h["x-kaptura-bg-harmonize"] || url.searchParams.get("harmonize") || 0),
          taskId,
          onProgress: emitProgressEvent,
        };

        if (isAsync) {
          const jobRec = {
            ok: true,
            taskId,
            kind: "bgremove",
            status: "running",
            progress: 5,
            stage: "QUEUED",
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };
          const tmpToClean = uploadTmpPath;
          const bgToClean = bgImageTmpPath;
          enqueueGpuJob(taskId, jobRec, async () => {
            try {
              const result = await removeBgTask(taskParams);
              if (!result.success) {
                Object.assign(jobRec, {
                  status: result.status === "cancelled" ? "cancelled" : "failed",
                  error: result.error || result.status || "BG Studio failed",
                  stage: result.status === "cancelled" ? "CANCELLED" : "FAILED",
                  updatedAt: Date.now(),
                });
              } else {
                Object.assign(jobRec, {
                  ...result,
                  status: "completed",
                  progress: 100,
                  stage: "COMPLETE",
                  downloadUrl: `/exports/${result.outputFile}`,
                  updatedAt: Date.now(),
                });
              }
            } catch (err) {
              Object.assign(jobRec, { status: "failed", stage: "FAILED", error: err instanceof Error ? err.message : String(err), updatedAt: Date.now() });
            } finally {
              if (tmpToClean) try { if (fs.existsSync(tmpToClean)) fs.unlinkSync(tmpToClean); } catch {}
              if (bgToClean) try { if (fs.existsSync(bgToClean)) fs.unlinkSync(bgToClean); } catch {}
              saveJobsRegistry();
            }
          });
          return sendJson(res, 202, {
            ok: true,
            taskId,
            status: jobRec.status,
            queuePosition: jobRec.queuePosition || 0,
            pollUrl: `/jobs/${encodeURIComponent(taskId)}`,
          });
        }

        let result;
        try {
          result = await removeBgTask(taskParams);
        } finally {
          if (uploadTmpPath) try { if (fs.existsSync(uploadTmpPath)) fs.unlinkSync(uploadTmpPath); } catch {}
          if (bgImageTmpPath) try { if (fs.existsSync(bgImageTmpPath)) fs.unlinkSync(bgImageTmpPath); } catch {}
        }

        if (!result.success) {
          const code = result.status === "cancelled" ? 409 : (result.status === "empty_input" || result.status === "missing_input" ? 400 : 422);
          return sendJson(res, code, result);
        }
        if (url.searchParams.get("download") === "1" || h["accept"] === "application/octet-stream") {
          const ext = path.extname(result.outputFile).toLowerCase();
          const mime = ext === ".png" ? "image/png" : (ext === ".webm" ? "video/webm" : (ext === ".mov" ? "video/quicktime" : "video/mp4"));
          const hdrs = applyForensicHeaders({
            "Content-Type": mime,
            "Content-Disposition": `attachment; filename="${result.outputFile}"`,
            "X-Kaptura-Codec": result.codec || "",
            "X-Kaptura-Model": result.model || "",
          }, result);
          res.writeHead(200, hdrs);
          const fileStream = fs.createReadStream(result.videoPath);
          fileStream.once("close", () => {
            try { if (fs.existsSync(result.videoPath)) fs.unlinkSync(result.videoPath); } catch {}
          });
          return fileStream.pipe(res);
        }
        return sendJson(res, 200, { ...result, downloadUrl: `/exports/${result.outputFile}` });
      } catch (err) {
        if (uploadTmpPath) try { if (fs.existsSync(uploadTmpPath)) fs.unlinkSync(uploadTmpPath); } catch {}
        if (bgImageTmpPath) try { if (fs.existsSync(bgImageTmpPath)) fs.unlinkSync(bgImageTmpPath); } catch {}
        return sendJson(res, 500, { success: false, error: err instanceof Error ? err.message : String(err) });
      }
    }

    if (req.method === "POST" && pathname === "/upscale-ai") {
      let uploadTmpPath = "";
      try {
        const h = req.headers;
        const isAsync = url.searchParams.get("async") === "1" || String(h["x-kaptura-async"] || "") === "1";
        const sourceExport = String(h["x-kaptura-source-export"] || url.searchParams.get("sourceExport") || "");
        const taskId = String(h["x-kaptura-task-id"] || url.searchParams.get("taskId") || `up_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);
        let inputPath = "";
        if (sourceExport) {
          const resolved = resolveExportRef(sourceExport);
          if (!resolved) {
            return sendJson(res, 404, { success: false, status: "missing_input", error: "Referenced export artifact not found." });
          }
          inputPath = resolved;
        } else {
          const rawExt = normalizeUploadExt(h["x-kaptura-ext"] || url.searchParams.get("ext"), ".mp4");
          uploadTmpPath = path.join(exportsDir, `.tmp_upload_${taskId}${rawExt}`);
          const bytes = await streamRequestToFile(req, uploadTmpPath);
          if (!bytes) {
            try { if (fs.existsSync(uploadTmpPath)) fs.unlinkSync(uploadTmpPath); } catch {}
            return sendJson(res, 400, { success: false, status: "empty_input", error: "Empty media payload (0 bytes)." });
          }
          inputPath = uploadTmpPath;
        }
        const inputExt = path.extname(inputPath).toLowerCase() || ".mp4";
        const pipeline = String(h["x-kaptura-pipeline"] || url.searchParams.get("pipeline") || "esrgan");
        const model = String(h["x-kaptura-ai-model"] || url.searchParams.get("model") || "realesrgan-x4plus");
        const scale = Number(h["x-kaptura-scale"] || url.searchParams.get("scale") || 4);
        const rifeMult = Number(h["x-kaptura-rife-mult"] || url.searchParams.get("rifeMult") || 2);
        const width = Number(h["x-kaptura-width"] || url.searchParams.get("width") || 0);
        const height = Number(h["x-kaptura-height"] || url.searchParams.get("height") || 0);
        const denoise = String(h["x-kaptura-denoise"] || url.searchParams.get("denoise") || "").toLowerCase() === "true";
        const rawSharpen = h["x-kaptura-sharpen"] ?? url.searchParams.get("sharpen");
        const sharpen = rawSharpen !== undefined && rawSharpen !== "" ? Number(rawSharpen) : null;
        const quality = String(h["x-kaptura-quality"] || url.searchParams.get("quality") || "high");
        const codec = String(h["x-kaptura-codec"] || url.searchParams.get("codec") || "auto");
        const previewSec = Number(h["x-kaptura-preview-sec"] || url.searchParams.get("previewSec") || 0);
        const previewStartSec = Number(h["x-kaptura-preview-start"] || url.searchParams.get("previewStart") || 0);

        const taskParams = {
          inputPath,
          inputBuffer: null,
          inputExt,
          outputDir: exportsDir,
          pipeline,
          model,
          scale,
          rifeMult,
          width,
          height,
          denoise,
          sharpen,
          quality,
          codec,
          previewSec,
          previewStartSec,
          taskId,
          onProgress: emitProgressEvent,
        };

        if (isAsync) {
          const jobRec = {
            ok: true,
            taskId,
            kind: "upscale-ai",
            status: "running",
            progress: 5,
            stage: "QUEUED",
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };
          const tmpToClean = uploadTmpPath;
          enqueueGpuJob(taskId, jobRec, async () => {
            try {
              releaseWarmWorkers();
              const result = await upscaleAiTask(taskParams);
              if (!result.success) {
                Object.assign(jobRec, {
                  status: result.status === "cancelled" ? "cancelled" : "failed",
                  error: result.error || result.status || "Upscale AI failed",
                  stage: result.status === "cancelled" ? "CANCELLED" : "FAILED",
                  updatedAt: Date.now(),
                });
              } else {
                Object.assign(jobRec, {
                  ...result,
                  status: "completed",
                  progress: 100,
                  stage: "COMPLETE",
                  downloadUrl: `/exports/${result.outputFile}`,
                  updatedAt: Date.now(),
                });
              }
            } catch (err) {
              Object.assign(jobRec, { status: "failed", stage: "FAILED", error: err instanceof Error ? err.message : String(err), updatedAt: Date.now() });
            } finally {
              if (tmpToClean) try { if (fs.existsSync(tmpToClean)) fs.unlinkSync(tmpToClean); } catch {}
              saveJobsRegistry();
            }
          });
          return sendJson(res, 202, {
            ok: true,
            taskId,
            status: jobRec.status,
            queuePosition: jobRec.queuePosition || 0,
            pollUrl: `/jobs/${encodeURIComponent(taskId)}`,
          });
        }

        let result;
        try {
          releaseWarmWorkers();
          result = await upscaleAiTask(taskParams);
        } finally {
          if (uploadTmpPath) try { if (fs.existsSync(uploadTmpPath)) fs.unlinkSync(uploadTmpPath); } catch {}
        }

        if (!result.success) {
          const code = result.status === "cancelled" ? 409 : (result.status === "empty_input" || result.status === "missing_input" ? 400 : 422);
          return sendJson(res, code, result);
        }
        if (url.searchParams.get("download") === "1" || h["accept"] === "application/octet-stream") {
          const ext = path.extname(result.outputFile).toLowerCase();
          const hdrs = applyForensicHeaders({
            "Content-Type": MIME_MAP[ext] || "video/mp4",
            "Content-Disposition": `attachment; filename="${result.outputFile}"`,
            "X-Kaptura-Model": result.model || model,
            "X-Kaptura-Pipeline": result.pipeline || pipeline,
          }, result);
          res.writeHead(200, hdrs);
          const fileStream = fs.createReadStream(result.videoPath);
          fileStream.once("close", () => {
            try { if (fs.existsSync(result.videoPath)) fs.unlinkSync(result.videoPath); } catch {}
          });
          return fileStream.pipe(res);
        }
        return sendJson(res, 200, { ...result, downloadUrl: `/exports/${result.outputFile}` });
      } catch (err) {
        if (uploadTmpPath) try { if (fs.existsSync(uploadTmpPath)) fs.unlinkSync(uploadTmpPath); } catch {}
        return sendJson(res, 500, { success: false, error: err instanceof Error ? err.message : String(err) });
      }
    }

    if (req.method === "POST" && pathname === "/render") {
      try {
        const raw = await readRequestBody(req, 64 * 1024 * 1024);
        let body = {};
        if (raw.length) {
          try {
            body = JSON.parse(raw.toString("utf8"));
          } catch {
            return sendJson(res, 400, { success: false, error: "Invalid JSON payload" });
          }
        }
        const result = await renderVideoTask({
          prompt: body.prompt || "Ethernium Sovereign Composition",
          durationSec: body.durationSec ?? body.duration ?? 2,
          resolution: body.resolution || "1280x720",
          fps: body.fps || 30,
          inputPath: body.inputPath || "",
          inputBase64: body.inputBase64 || "",
          inputExt: body.inputExt || ".webm",
          container: body.container || "mp4",
          bitrateMbps: body.bitrateMbps || 0,
          targetMB: body.targetMB || 0,
          quality: body.quality || "high",
          upscale: Boolean(body.upscale),
          outputDir: exportsDir,
          onProgress: emitProgressEvent,
        });
        return sendJson(res, result.success ? 200 : 422, {
          ...result,
          downloadUrl: result.outputFile ? `/exports/${result.outputFile}` : null,
        });
      } catch (err) {
        return sendJson(res, 500, { success: false, error: err instanceof Error ? err.message : String(err) });
      }
    }

    if (req.method === "GET") {
      const targetRel = pathname === "/" || pathname === "/index.html" ? "index.html" : pathname.slice(1);
      const isPublicStatic =
        targetRel === "index.html" ||
        targetRel === "manifest.json" ||
        targetRel === "sw.js" ||
        targetRel.startsWith("icons/") ||
        targetRel.startsWith("css/") ||
        targetRel.startsWith("js/") ||
        targetRel.startsWith("fonts/");
      const ext = path.extname(targetRel).toLowerCase();
      const allowedExt = [".html", ".js", ".mjs", ".css", ".woff2", ".svg", ".png"].includes(ext) || targetRel === "manifest.json";
      if (isPublicStatic && allowedExt) {
        const filePath = safeStaticFile(rootDir, targetRel);
        if (filePath) {
          const isMutableCode = [".html", ".js", ".mjs", ".css", ".json"].includes(ext);
          res.writeHead(200, {
            "Content-Type": MIME_MAP[ext] || "application/octet-stream",
            "Cache-Control": isMutableCode ? "no-store, must-revalidate" : "public, max-age=3600",
          });
          return fs.createReadStream(filePath).pipe(res);
        }
      }
    }

    return sendJson(res, 404, { error: "Endpoint or static asset not found" });
  });

  const wsHub = attachWebSocketServer(server, (peer) => {
    if (peer.pathname !== "/ws/capture") {
      peer.close(1008, "Unsupported WebSocket endpoint");
      return;
    }

    let session = null;
    peer.onText = async (rawText) => {
      let msg;
      try {
        msg = JSON.parse(rawText);
      } catch {
        peer.sendJson({ type: "error", error: "Invalid JSON control frame" });
        return;
      }

      if (msg.type === "ping") {
        peer.sendJson({ type: "pong" });
        return;
      }

      if (msg.type === "start") {
        if (session) session.abort();
        try {
          session = createLiveCaptureSession({
            outputDir: exportsDir,
            mode: msg.mode === "pipe-frames" ? "pipe-frames" : "pipe-media",
            inputExt: msg.inputExt || ".webm",
            fps: msg.fps || 30,
            container: msg.container || "mp4",
            bitrateMbps: msg.bitrateMbps || 0,
            quality: msg.quality || "high",
            onProgress: emitProgressEvent,
          });
          peer.sendJson({ type: "started", taskId: session.taskId, mode: session.mode });
        } catch (err) {
          peer.sendJson({ type: "error", error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }

      if (msg.type === "stop") {
        if (!session) {
          peer.sendJson({ type: "error", error: "No active capture session" });
          return;
        }
        const activeSession = session;
        session = null;
        try {
          const result = await activeSession.finalize();
          peer.sendJson({ type: "completed", ...result });
        } catch (err) {
          peer.sendJson({ type: "error", error: err instanceof Error ? err.message : String(err) });
        }
      }
    };

    peer.onBinary = (buf) => {
      if (!session) {
        peer.sendJson({ type: "error", error: "Send start control frame before binary chunks" });
        return;
      }
      session.writeChunk(buf);
      const { chunksReceived, bytesReceived } = session.stats;
      if (chunksReceived === 1 || chunksReceived % 4 === 0) {
        peer.sendJson({ type: "ack", taskId: session.taskId, chunksReceived, bytesReceived });
      }
    };

    peer.onClose = () => {
      if (session) {
        session.abort();
        session = null;
      }
    };
  });

  server.requestTimeout = 0;
  server.timeout = 0;
  server.headersTimeout = 120_000;

  return {
    server,
    start: () =>
      new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          const addr = server.address();
          activePort = typeof addr === "object" && addr ? addr.port : port;
          if (connectIpc) {
            ipcHandle = createIpcClient({ hlcEngine, hubUrl: "ws://127.0.0.1:8765", nodeId: "kaptura-video-3370" });
          }
          resolve({ port: activePort, host });
        });
      }),
    stop: () =>
      new Promise((resolve) => {
        clearInterval(sseKeepAlive);
        for (const [id, rec] of jobs.entries()) {
          if (rec && (rec.status === "running" || rec.status === "queued")) {
            rec.status = "interrupted";
            rec.stage = "INTERRUPTED";
            rec.queuePosition = 0;
            try { cancelTask(id); } catch {}
          }
        }
        saveJobsRegistry();
        releaseWarmWorkers();
        for (const client of sseClients) {
          try { client.end(); } catch {}
        }
        sseClients.clear();
        wsHub.closeAll();
        if (ipcHandle) {
          ipcHandle.close();
          ipcHandle = null;
        }
        if (typeof server.closeAllConnections === "function") server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

const isEntrypoint = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isEntrypoint) {
  const daemon = createKapturaDaemon({ connectIpc: true });
  daemon.start().then(({ host, port }) => {
    console.log(`[KAPTURA DAEMON v${DAEMON_VERSION}] Studio + GPU Pipeline listening on http://${host}:${port}`);
  });
}
