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
import { renderVideoTask, transcodeMediaTask, trimMediaTask, upscaleAiTask, createLiveCaptureSession } from "./pipeline/videoPipeline.mjs";
import { detectVideoBackend } from "./pipeline/gpuDirectOptimizer.mjs";
import { getCompanionStatus } from "./providers/adapters.mjs";
import { ebwpProtocol, EBWP_OPCODES } from "./synkronia/ebwpProtocol.mjs";
import { hlcEngine } from "./synkronia/hlcClock.mjs";
import { createIpcClient } from "./synkronia/ipcClient.mjs";
import { attachWebSocketServer } from "./synkronia/wsServer.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(__dirname, "..");

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
  fs.mkdirSync(exportsDir, { recursive: true });
  let activePort = port;
  let ipcHandle = null;
  const sseClients = new Set();

  const emitProgressEvent = (evt) => {
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
      version: "3.0.0",
      port: activePort,
      capabilities: {
        ffmpegAvailable: backend.available,
        preferredCodec: backend.preferredCodec,
        hardwareAccelerated: backend.hardwareAccelerated,
        neuralAvailable: Boolean(providers.realEsrgan),
        encoders: backend.encoders,
      },
      streaming: {
        wsCapture: "/ws/capture",
        sseEvents: "/events",
        rangeSupported: true,
        trimEndpoint: "/trim",
        upscaleAiEndpoint: "/upscale-ai",
      },
      providers: {
        etherniumVox: providers.etherniumVox,
        fontForge: providers.fontForge,
        upskalator: providers.upskalator,
        realEsrgan: Boolean(providers.realEsrgan),
      },
      hlc: hlcEngine.now(),
    };
  };

  const server = http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Range, X-Kaptura-Ext, X-Kaptura-Container, X-Kaptura-Width, X-Kaptura-Height, X-Kaptura-Fps, X-Kaptura-Bitrate, X-Kaptura-Target-MB, X-Kaptura-Quality, X-Kaptura-Start-Sec, X-Kaptura-End-Sec, X-Kaptura-Task-Id, X-Kaptura-Source-Export, X-Kaptura-Reencode"
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

    if (req.method === "POST" && pathname === "/transcode") {
      try {
        const h = req.headers;
        const sourceExport = String(h["x-kaptura-source-export"] || url.searchParams.get("sourceExport") || "");
        let inputPath = "";
        let raw = null;
        if (sourceExport) {
          const resolved = resolveExportRef(sourceExport);
          if (!resolved) {
            return sendJson(res, 404, { success: false, status: "missing_input", error: "Referenced export artifact not found." });
          }
          inputPath = resolved;
        } else {
          raw = await readRequestBody(req);
          if (!raw.length) {
            return sendJson(res, 400, { success: false, status: "empty_input", error: "Empty media payload (0 bytes)." });
          }
        }
        const container = String(h["x-kaptura-container"] || url.searchParams.get("container") || "mp4");
        const inputExt = inputPath
          ? (path.extname(inputPath).toLowerCase() || ".mp4")
          : String(h["x-kaptura-ext"] || url.searchParams.get("ext") || ".webm");
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
        const taskId = String(h["x-kaptura-task-id"] || url.searchParams.get("taskId") || "");

        const result = await transcodeMediaTask({
          inputPath,
          inputBuffer: raw,
          inputExt,
          outputDir: exportsDir,
          container,
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
          taskId,
          onProgress: emitProgressEvent,
        });

        if (!result.success) {
          const code = result.status === "empty_input" || result.status === "missing_input" ? 400 : 422;
          return sendJson(res, code, result);
        }
        if (url.searchParams.get("download") === "1" || h["accept"] === "application/octet-stream") {
          const ext = path.extname(result.outputFile).toLowerCase();
          res.writeHead(200, {
            "Content-Type": MIME_MAP[ext] || "video/mp4",
            "Content-Disposition": `attachment; filename="${result.outputFile}"`,
            "X-Kaptura-Codec": result.codec || "",
            "X-Kaptura-HW": String(Boolean(result.hardwareAccelerated)),
          });
          const fileStream = fs.createReadStream(result.videoPath);
          fileStream.once("close", () => {
            try { if (fs.existsSync(result.videoPath)) fs.unlinkSync(result.videoPath); } catch {}
          });
          return fileStream.pipe(res);
        }
        return sendJson(res, 200, { ...result, downloadUrl: `/exports/${result.outputFile}` });
      } catch (err) {
        return sendJson(res, 500, { success: false, error: err instanceof Error ? err.message : String(err) });
      }
    }

    if (req.method === "POST" && pathname === "/upscale-ai") {
      try {
        const h = req.headers;
        const sourceExport = String(h["x-kaptura-source-export"] || url.searchParams.get("sourceExport") || "");
        let inputPath = "";
        let raw = null;
        if (sourceExport) {
          const resolved = resolveExportRef(sourceExport);
          if (!resolved) {
            return sendJson(res, 404, { success: false, status: "missing_input", error: "Referenced export artifact not found." });
          }
          inputPath = resolved;
        } else {
          raw = await readRequestBody(req);
          if (!raw.length) {
            return sendJson(res, 400, { success: false, status: "empty_input", error: "Empty media payload (0 bytes)." });
          }
        }
        const inputExt = inputPath
          ? (path.extname(inputPath).toLowerCase() || ".mp4")
          : String(h["x-kaptura-ext"] || url.searchParams.get("ext") || ".mp4");
        const model = String(h["x-kaptura-ai-model"] || url.searchParams.get("model") || "realesr-general-x4v3");
        const scale = Number(h["x-kaptura-scale"] || url.searchParams.get("scale") || 4);
        const width = Number(h["x-kaptura-width"] || url.searchParams.get("width") || 0);
        const height = Number(h["x-kaptura-height"] || url.searchParams.get("height") || 0);
        const denoise = String(h["x-kaptura-denoise"] || url.searchParams.get("denoise") || "").toLowerCase() === "true";
        const quality = String(h["x-kaptura-quality"] || url.searchParams.get("quality") || "high");
        const taskId = String(h["x-kaptura-task-id"] || url.searchParams.get("taskId") || "");

        const result = await upscaleAiTask({
          inputPath,
          inputBuffer: raw,
          inputExt,
          outputDir: exportsDir,
          model,
          scale,
          width,
          height,
          denoise,
          quality,
          taskId,
          onProgress: emitProgressEvent,
        });

        if (!result.success) {
          const code = result.status === "empty_input" || result.status === "missing_input" ? 400 : 422;
          return sendJson(res, code, result);
        }
        if (url.searchParams.get("download") === "1" || h["accept"] === "application/octet-stream") {
          const ext = path.extname(result.outputFile).toLowerCase();
          res.writeHead(200, {
            "Content-Type": MIME_MAP[ext] || "video/mp4",
            "Content-Disposition": `attachment; filename="${result.outputFile}"`,
            "X-Kaptura-Model": result.model || model,
          });
          const fileStream = fs.createReadStream(result.videoPath);
          fileStream.once("close", () => {
            try { if (fs.existsSync(result.videoPath)) fs.unlinkSync(result.videoPath); } catch {}
          });
          return fileStream.pipe(res);
        }
        return sendJson(res, 200, { ...result, downloadUrl: `/exports/${result.outputFile}` });
      } catch (err) {
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
        targetRel.startsWith("css/") ||
        targetRel.startsWith("js/") ||
        targetRel.startsWith("fonts/");
      const ext = path.extname(targetRel).toLowerCase();
      if (isPublicStatic && [".html", ".js", ".css", ".woff2", ".svg", ".png"].includes(ext)) {
        const filePath = safeStaticFile(rootDir, targetRel);
        if (filePath) {
          res.writeHead(200, { "Content-Type": MIME_MAP[ext] || "application/octet-stream" });
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
        for (const client of sseClients) {
          try { client.end(); } catch {}
        }
        sseClients.clear();
        wsHub.closeAll();
        if (ipcHandle) {
          ipcHandle.close();
          ipcHandle = null;
        }
        server.close(() => resolve());
      }),
  };
}

const isEntrypoint = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isEntrypoint) {
  const daemon = createKapturaDaemon({ connectIpc: true });
  daemon.start().then(({ host, port }) => {
    console.log(`[KAPTURA DAEMON v2.0] Studio + GPU Pipeline listening on http://${host}:${port}`);
  });
}
