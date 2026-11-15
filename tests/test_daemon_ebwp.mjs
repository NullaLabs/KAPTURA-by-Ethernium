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
        },
        srcBuf
      );
      assert.equal(txRes.status, 200);
      assert.ok(txRes.body.length > 500, "Transcoded stream must be non-empty MP4");
      console.log(`  PASS  Real /render & /transcode (${renderJson.codec}, HW=${renderJson.hardwareAccelerated})`);
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
        if (f.startsWith("transcode_") || f.startsWith("render_")) {
          try { fs.unlinkSync(new URL(`../exports/${f}`, import.meta.url)); } catch {}
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
