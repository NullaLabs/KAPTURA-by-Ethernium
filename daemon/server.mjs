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
import { renderVideoTask, transcodeMediaTask } from "./pipeline/videoPipeline.mjs";
import { detectVideoBackend } from "./pipeline/gpuDirectOptimizer.mjs";
import { getCompanionStatus } from "./providers/adapters.mjs";
import { ebwpProtocol, EBWP_OPCODES } from "./synkronia/ebwpProtocol.mjs";
import { hlcEngine } from "./synkronia/hlcClock.mjs";
import { createIpcClient } from "./synkronia/ipcClient.mjs";

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

  const buildHealthPayload = () => {
    const backend = detectVideoBackend();
    const providers = getCompanionStatus();
    return {
      ok: true,
      online: true,
      status: "online",
      engine: "KAPTURA SOVEREIGN STUDIO + GPU DAEMON",
      version: "2.0.0",
      port: activePort,
      capabilities: {
        ffmpegAvailable: backend.available,
        preferredCodec: backend.preferredCodec,
        hardwareAccelerated: backend.hardwareAccelerated,
        encoders: backend.encoders,
      },
      providers: {
        etherniumVox: providers.etherniumVox,
        fontForge: providers.fontForge,
        upskalator: providers.upskalator,
      },
      hlc: hlcEngine.now(),
    };
  };

  const server = http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, X-Kaptura-Ext, X-Kaptura-Container, X-Kaptura-Width, X-Kaptura-Height, X-Kaptura-Fps, X-Kaptura-Bitrate, X-Kaptura-Target-MB, X-Kaptura-Quality"
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

    if (req.method === "GET" && pathname.startsWith("/exports/")) {
      const rel = decodeURIComponent(pathname.slice("/exports/".length));
      const exportFile = safeStaticFile(exportsDir, rel);
      if (!exportFile) return sendJson(res, 404, { error: "Export artifact not found" });
      const ext = path.extname(exportFile).toLowerCase();
      res.writeHead(200, { "Content-Type": MIME_MAP[ext] || "application/octet-stream" });
      return fs.createReadStream(exportFile).pipe(res);
    }

    if (req.method === "POST" && pathname === "/transcode") {
      try {
        const raw = await readRequestBody(req);
        const h = req.headers;
        const container = String(h["x-kaptura-container"] || url.searchParams.get("container") || "mp4");
        const inputExt = String(h["x-kaptura-ext"] || url.searchParams.get("ext") || ".webm");
        const width = Number(h["x-kaptura-width"] || url.searchParams.get("width") || 0);
        const height = Number(h["x-kaptura-height"] || url.searchParams.get("height") || 0);
        const fps = Number(h["x-kaptura-fps"] || url.searchParams.get("fps") || 0);
        const bitrateMbps = Number(h["x-kaptura-bitrate"] || url.searchParams.get("bitrate") || 0);
        const targetMB = Number(h["x-kaptura-target-mb"] || url.searchParams.get("targetMB") || 0);
        const quality = String(h["x-kaptura-quality"] || url.searchParams.get("quality") || "high");

        const result = await transcodeMediaTask({
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
        });

        if (!result.success) return sendJson(res, 422, result);
        if (url.searchParams.get("download") === "1" || h["accept"] === "application/octet-stream") {
          const ext = path.extname(result.outputFile).toLowerCase();
          res.writeHead(200, {
            "Content-Type": MIME_MAP[ext] || "video/mp4",
            "Content-Disposition": `attachment; filename="${result.outputFile}"`,
            "X-Kaptura-Codec": result.codec || "",
            "X-Kaptura-HW": String(Boolean(result.hardwareAccelerated)),
          });
          return fs.createReadStream(result.videoPath).pipe(res);
        }
        return sendJson(res, 200, { ...result, downloadUrl: `/exports/${result.outputFile}` });
      } catch (err) {
        return sendJson(res, 500, { success: false, error: err instanceof Error ? err.message : String(err) });
      }
    }

    if (req.method === "POST" && pathname === "/render") {
      try {
        const raw = await readRequestBody(req, 64 * 1024 * 1024);
        const body = raw.length ? JSON.parse(raw.toString("utf8")) : {};
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
