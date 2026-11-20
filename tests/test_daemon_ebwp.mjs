import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { createKapturaDaemon } from "../daemon/server.mjs";
import { ebwpProtocol, EBWP_OPCODES } from "../daemon/synkronia/ebwpProtocol.mjs";
import { hlcEngine } from "../daemon/synkronia/hlcClock.mjs";

function httpRequest(port, path, method = "GET", headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function run() {
  // 1. EBWP 32-byte encode/decode + tamper detection
  const t0 = hlcEngine.now();
  const frame = ebwpProtocol.encode(EBWP_OPCODES.TELEMETRY, "kaptura-video-3370", BigInt(t0.l), t0.c, 60.0, 1.5, 0.25);
  assert.equal(frame.byteLength, 32, "EBWP packet must be 32 bytes");
  const decoded = ebwpProtocol.decode(frame);
  assert.ok(decoded && decoded.valid && decoded.checksumValid, "EBWP frame must pass checksum");
  assert.equal(decoded.nodeId, "kaptura-video-3370");

  const corrupted = new Uint8Array(frame);
  corrupted[18] ^= 0xff;
  assert.equal(ebwpProtocol.decode(corrupted), null, "Corrupted EBWP packet must be rejected");
  console.log("  PASS  EBWP 32-byte roundtrip & checksum rejection");

  // 2. HLC monotonic order & drift guard
  const t1 = hlcEngine.now();
  assert.ok(BigInt(t1.l) > BigInt(t0.l) || (t1.l === t0.l && t1.c > t0.c), "HLC must advance monotonically");
  const farFuture = hlcEngine.receive({ l: (BigInt(t1.l) + 9_000_000_000n).toString(), c: 0, nodeId: "drift-test" });
  assert.equal(farFuture.rejected, true, "HLC must reject timestamps beyond 500ms drift ceiling");
  console.log("  PASS  HLC monotonicity & bounded drift guard");

  // 3. Unified HTTP daemon lifecycle, /health, /status, /telemetry/ebwp, static /, and real /render + /transcode
  const daemon = createKapturaDaemon({ port: 0, connectIpc: false });
  const { port } = await daemon.start();
  let createdArtifacts = [];

  try {
    const healthRes = await httpRequest(port, "/health");
    assert.equal(healthRes.status, 200);
    const health = JSON.parse(healthRes.body.toString("utf8"));
    assert.equal(health.online, true);
    assert.equal(health.port, port);
    assert.equal(health.version, fs.readFileSync(new URL("../VERSION", import.meta.url), "utf8").trim(), "Daemon /health version must match VERSION file");
    assert.equal(typeof health.capabilities.neuralAvailable, "boolean", "Daemon /health must report neuralAvailable capability");
    assert.equal(health.capabilities && typeof health.capabilities.rifeAvailable, "boolean", "Daemon /health must report rifeAvailable capability");
    assert.equal(health.streaming && health.streaming.cancelEndpoint, "/cancel", "Daemon /health must expose /cancel endpoint");
    assert.equal(health.streaming && health.streaming.jobsEndpoint, "/jobs", "Daemon /health must expose /jobs endpoint");
    const cancelMissRes = await httpRequest(port, "/cancel/nonexistent_task", "POST");
    assert.equal(cancelMissRes.status, 200);
    const cancelMissJson = JSON.parse(cancelMissRes.body.toString("utf8"));
    assert.equal(cancelMissJson.ok, true);
    assert.equal(cancelMissJson.cancelled, false);
    const jobMissRes = await httpRequest(port, "/jobs/nonexistent_job");
    assert.equal(jobMissRes.status, 404, "GET /jobs/:unknown must return 404");
    assert.equal(typeof health.providers.realEsrgan, "boolean", "Daemon /health must report realEsrgan provider availability");
    assert.equal(typeof health.providers.rife, "boolean", "Daemon /health must report rife provider availability");

    const statusRes = await httpRequest(port, "/status");
    assert.equal(statusRes.status, 200);
    const ebwpRes = await httpRequest(port, "/telemetry/ebwp");
    assert.equal(ebwpRes.status, 200);
    const ebwpJson = JSON.parse(ebwpRes.body.toString("utf8"));
    assert.equal(ebwpJson.byteLength, 32);
    assert.equal(ebwpJson.decoded.checksumValid, true);

    const htmlRes = await httpRequest(port, "/");
    assert.equal(htmlRes.status, 200);
    assert.ok(htmlRes.body.toString("utf8").includes("KAPTURA by Ethernium"), "Daemon must serve KAPTURA Studio UI");

    const traversalRes = await httpRequest(port, "/exports/%2e%2e/package.json");
    assert.equal(traversalRes.status, 404, "Encoded path traversal outside exports/ must be blocked");
    const rootPkgRes = await httpRequest(port, "/package.json");
    assert.equal(rootPkgRes.status, 404, "Non-public root package.json must not be exposed");
    const badJsonRes = await httpRequest(port, "/render", "POST", { "Content-Type": "application/json" }, "{bad-json");
    assert.equal(badJsonRes.status, 400, "Malformed JSON on /render must return 400 Bad Request");
    const emptyTxRes = await httpRequest(port, "/transcode?download=1", "POST", { "Accept": "application/octet-stream" }, Buffer.alloc(0));
    assert.equal(emptyTxRes.status, 400, "Empty body on /transcode must return 400 Bad Request");
    const emptyAiRes = await httpRequest(port, "/upscale-ai?download=1", "POST", { "Accept": "application/octet-stream" }, Buffer.alloc(0));
    assert.equal(emptyAiRes.status, 400, "Empty body on /upscale-ai must return 400 Bad Request");
    console.log("  PASS  Daemon /health, /status, /telemetry/ebwp, UI serve, validation & traversal guard");

    if (health.capabilities && health.capabilities.ffmpegAvailable) {
      const renderPayload = JSON.stringify({
        prompt: "KAPTURA_DAEMON_TEST",
        durationSec: 0.6,
        resolution: "320x180",
        fps: 15,
      });
      const renderRes = await httpRequest(port, "/render", "POST", { "Content-Type": "application/json" }, renderPayload);
      assert.equal(renderRes.status, 200);
      const renderJson = JSON.parse(renderRes.body.toString("utf8"));
      assert.equal(renderJson.success, true);
      assert.ok(renderJson.sizeBytes > 1000, "Rendered MP4 must contain real video frames");
      if (renderJson.videoPath) createdArtifacts.push(renderJson.videoPath);

      // Feed rendered MP4 into binary /transcode endpoint to test real re-encode pipeline
      const srcBuf = fs.readFileSync(renderJson.videoPath);

      // Test HTTP Range (206 Partial Content) for <video> seeking
      const rangeRes = await httpRequest(port, renderJson.downloadUrl, "GET", { Range: "bytes=0-63" });
      assert.equal(rangeRes.status, 206, "GET /exports/* with Range must return 206 Partial Content");
      assert.equal(rangeRes.body.length, 64, "206 Partial Content body must match exact requested byte range");

      // Test SSE /events stream
      const sseSeen = await new Promise((resolve, reject) => {
        const sseReq = http.request({ host: "127.0.0.1", port, path: "/events", method: "GET" }, (sseRes) => {
          assert.equal(sseRes.statusCode, 200);
          let acc = "";
          sseRes.on("data", (d) => {
            acc += d.toString("utf8");
            if (acc.includes("event: ready")) {
              sseReq.destroy();
              resolve(acc);
            }
          });
        });
        sseReq.on("error", reject);
        sseReq.end();
      });
      assert.ok(sseSeen.includes("event: ready"));

      // Test lossless /trim endpoint referencing disk artifact
      const trimRes = await httpRequest(
        port,
        "/trim",
        "POST",
        { "Content-Type": "application/json" },
        JSON.stringify({ sourceUrl: renderJson.downloadUrl, startSec: 0, endSec: 0.4 })
      );
      assert.equal(trimRes.status, 200, "POST /trim should succeed on MP4 export");
      const trimJson = JSON.parse(trimRes.body.toString("utf8"));
      assert.equal(trimJson.success, true);
      assert.ok(trimJson.sizeBytes > 500, "Trimmed MP4 must be non-empty");
      if (trimJson.videoPath) createdArtifacts.push(trimJson.videoPath);

      // Test /transcode binary download with CAS unsharp + CFR
      const txRes = await httpRequest(
        port,
        "/transcode?download=1",
        "POST",
        {
          "Accept": "application/octet-stream",
          "X-Kaptura-Ext": ".mp4",
          "X-Kaptura-Container": "mp4",
          "X-Kaptura-Width": "160",
          "X-Kaptura-Height": "90",
          "X-Kaptura-Quality": "fast",
          "X-Kaptura-Sharpen": "0.65",
          "X-Kaptura-Cfr": "1",
        },
        srcBuf
      );
      assert.equal(txRes.status, 200);
      assert.ok(txRes.body.length > 500, "Transcoded stream with sharpen+CFR must be non-empty MP4");
      assert.equal(txRes.headers["x-kaptura-out-res"], "160x90", "Transcode response must expose forensic X-Kaptura-Out-Res");
      assert.ok(txRes.headers["x-kaptura-elapsed-ms"] !== undefined, "Transcode response must expose X-Kaptura-Elapsed-Ms");

      if (!health.capabilities.neuralAvailable) {
        const aiGuardRes = await httpRequest(
          port,
          "/upscale-ai",
          "POST",
          { "X-Kaptura-Ext": ".mp4", "X-Kaptura-Ai-Model": "realesrgan-x4plus" },
          srcBuf
        );
        assert.equal(aiGuardRes.status, 422, "POST /upscale-ai must return 422 when realesrgan-ncnn-vulkan is absent");
        const aiGuardJson = JSON.parse(aiGuardRes.body.toString("utf8"));
        assert.equal(aiGuardJson.success, false);
        assert.equal(aiGuardJson.status, "realesrgan_unavailable");
      } else {
        // Test live Real-ESRGAN Vulkan image reconstruction using minimal valid 4x4 RGBA PNG
        const tinyPng = Buffer.from(
          "89504e470d0a1a0a0000000d4948445200000004000000040806000000a9f19e7e0000001849444154789c6360f8cf800f308164308c901188240300a7fd03fc21f13d8f0000000049454e44ae426082",
          "hex"
        );
        const aiOkRes = await httpRequest(
          port,
          "/upscale-ai?download=1",
          "POST",
          {
            "Accept": "application/octet-stream",
            "X-Kaptura-Ext": ".png",
            "X-Kaptura-Ai-Model": "realesr-animevideov3",
            "X-Kaptura-Scale": "4",
          },
          tinyPng
        );
        assert.equal(aiOkRes.status, 200, "POST /upscale-ai must succeed with real PNG output when neuralAvailable is true");
        assert.equal(aiOkRes.body.subarray(0, 4).toString("hex"), "89504e47", "Neural output must be a valid PNG");
        assert.ok(aiOkRes.body.length > tinyPng.length, "4x neural output PNG must be larger than 4x4 input PNG");

        // Test async ?async=1 job queue & polling
        const asyncRes = await httpRequest(
          port,
          "/upscale-ai?async=1",
          "POST",
          { "X-Kaptura-Ext": ".png", "X-Kaptura-Ai-Model": "realesr-animevideov3", "X-Kaptura-Scale": "4" },
          tinyPng
        );
        assert.equal(asyncRes.status, 202, "POST /upscale-ai?async=1 must return 202 Accepted");
        const asyncJson = JSON.parse(asyncRes.body.toString("utf8"));
        assert.ok(asyncJson.taskId && asyncJson.pollUrl);
        let polledJob = null;
        for (let attempt = 0; attempt < 300; attempt++) {
          const jr = await httpRequest(port, asyncJson.pollUrl);
          assert.equal(jr.status, 200);
          polledJob = JSON.parse(jr.body.toString("utf8"));
          if (polledJob.status === "completed" || polledJob.status === "failed" || polledJob.status === "cancelled") break;
          await new Promise((r) => setTimeout(r, 250));
        }
        assert.equal(polledJob && polledJob.status, "completed", `Async /upscale-ai job must complete cleanly: ${JSON.stringify(polledJob)}`);
        assert.ok(polledJob.downloadUrl, "Completed async job must provide downloadUrl");
        if (polledJob.videoPath) createdArtifacts.push(polledJob.videoPath);
      }

      if (!health.capabilities.rifeAvailable) {
        const rifeGuardRes = await httpRequest(
          port,
          "/upscale-ai",
          "POST",
          { "X-Kaptura-Ext": ".mp4", "X-Kaptura-Pipeline": "rife" },
          srcBuf
        );
        assert.equal(rifeGuardRes.status, 422, "POST /upscale-ai RIFE must return 422 when rife-ncnn-vulkan is absent");
        const rifeGuardJson = JSON.parse(rifeGuardRes.body.toString("utf8"));
        assert.equal(rifeGuardJson.status, "rife_unavailable");
      } else {
        const rifeOkRes = await httpRequest(
          port,
          "/upscale-ai?download=1",
          "POST",
          {
            "Accept": "application/octet-stream",
            "X-Kaptura-Ext": ".mp4",
            "X-Kaptura-Pipeline": "rife",
            "X-Kaptura-Rife-Mult": "2",
            "X-Kaptura-Quality": "fast",
          },
          srcBuf
        );
        assert.equal(rifeOkRes.status, 200, "POST /upscale-ai RIFE 2x must succeed when rifeAvailable is true");
        assert.ok(rifeOkRes.body.length > 500, "RIFE 2x MP4 must be non-empty");
        assert.equal(rifeOkRes.headers["x-kaptura-pipeline"], "rife");
        assert.ok(Number(rifeOkRes.headers["x-kaptura-out-fps"]) >= 25, "RIFE 2x output FPS must double from ~15fps");
      }

      // Test WebSocket /ws/capture streaming pipe-media mode
      if (typeof WebSocket === "function") {
        const wsResult = await new Promise((resolve, reject) => {
          const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/capture`);
          const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error("WS timeout")); }, 15000);
          ws.addEventListener("open", () => {
            ws.send(JSON.stringify({ type: "start", mode: "pipe-media", inputExt: ".mp4", container: "mp4", quality: "fast" }));
          });
          ws.addEventListener("message", (ev) => {
            const msg = JSON.parse(String(ev.data));
            if (msg.type === "started") {
              const mid = Math.floor(srcBuf.length / 2);
              ws.send(srcBuf.subarray(0, mid));
              ws.send(srcBuf.subarray(mid));
              ws.send(JSON.stringify({ type: "stop" }));
            } else if (msg.type === "completed") {
              clearTimeout(timer);
              ws.close();
              resolve(msg);
            } else if (msg.type === "error") {
              clearTimeout(timer);
              ws.close();
              reject(new Error(msg.error));
            }
          });
          ws.addEventListener("error", (err) => { clearTimeout(timer); reject(err); });
        });
        assert.equal(wsResult.success, true, "WebSocket /ws/capture pipe-media must produce valid MP4");
        assert.ok(wsResult.sizeBytes > 500);
        if (wsResult.videoPath) createdArtifacts.push(wsResult.videoPath);
      }

      console.log(`  PASS  Real /render, /transcode, Range 206, SSE /events, /trim & /ws/capture (${renderJson.codec}, HW=${renderJson.hardwareAccelerated})`);
    } else {
      console.log("  SKIP  FFmpeg binary absent on host; skipped live transcode encode assertion");
    }
  } finally {
    await daemon.stop();
    for (const p of createdArtifacts) {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
    // Remove test-created files in exports/ if any leftover transcode_* outputs remain from download=1 mode
    const exportsDir = new URL("../exports", import.meta.url);
    if (fs.existsSync(exportsDir)) {
      for (const f of fs.readdirSync(exportsDir)) {
        if (f.startsWith("transcode_") || f.startsWith("render_") || f.startsWith("trim_") || f.startsWith("capture_") || f.startsWith("up_") || f.startsWith("tx_") || f.startsWith(".tmp_up_") || f.startsWith(".tmp_upload_up_") || f.startsWith(".tmp_tx_") || f.startsWith(".tmp_upload_tx_")) {
          try { fs.rmSync(new URL(`../exports/${f}`, import.meta.url), { recursive: true, force: true }); } catch {}
        }
      }
    }
  }
  console.log("\nALL KAPTURA DAEMON & EBWP TESTS PASSED");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
