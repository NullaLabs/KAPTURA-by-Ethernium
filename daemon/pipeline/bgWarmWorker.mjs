/**
 * KAPTURA BG STUDIO · Warm GPU Worker Pool
 * Keeps one resident Python matting process per interpreter (BiRefNet HR CUDA / ONNX sessions stay
 * loaded in VRAM/RAM) so repeated image cutouts skip the multi-second cold model load.
 * - JSON-line protocol over stdin/stdout (see bgRemoveWorker.py `serve()`).
 * - Serial job execution per worker (GPU queue upstream is already FIFO).
 * - Auto-release after idle timeout; hard kill on cancel/timeout (respawns on next job).
 */

import { spawn } from "node:child_process";
import path from "node:path";

const IDLE_RELEASE_MS = 180_000;
const READY_TIMEOUT_MS = 30_000;

const pool = new Map(); // pyBin -> worker record

function createWorker(pyBin, workerScript) {
  const rec = {
    pyBin,
    proc: null,
    ready: null,
    busy: false,
    alive: false,
    idleTimer: null,
    pending: null, // { jobId, onLine, resolve }
    stderrTail: "",
    startedAt: Date.now(),
    jobsServed: 0,
  };

  const proc = spawn(pyBin, [workerScript, "--serve"], {
    cwd: path.dirname(workerScript),
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  rec.proc = proc;
  rec.alive = true;

  let buf = "";
  let readyResolve;
  let readyReject;
  rec.ready = new Promise((res, rej) => { readyResolve = res; readyReject = rej; });
  const readyTimer = setTimeout(() => readyReject(new Error("Warm worker did not become ready in time")), READY_TIMEOUT_MS);

  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let msg = null;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.stage === "WORKER_READY") {
        clearTimeout(readyTimer);
        readyResolve(true);
        continue;
      }
      const p = rec.pending;
      if (!p || (msg.jobId && msg.jobId !== p.jobId)) continue;
      if (msg.stage === "JOB_DONE") {
        rec.pending = null;
        rec.busy = false;
        rec.jobsServed += 1;
        p.resolve({ ok: Boolean(msg.ok), error: msg.error || "", elapsedMs: msg.elapsedMs || 0 });
        armIdle(rec);
      } else if (typeof p.onLine === "function") {
        p.onLine(msg);
      }
    }
  });
  proc.stderr.setEncoding("utf8");
  proc.stderr.on("data", (chunk) => {
    rec.stderrTail = (rec.stderrTail + chunk).slice(-4000);
  });
  proc.on("exit", (code) => {
    clearTimeout(readyTimer);
    rec.alive = false;
    if (rec.idleTimer) clearTimeout(rec.idleTimer);
    readyReject(new Error(`Warm worker exited before ready (code ${code})`));
    const p = rec.pending;
    rec.pending = null;
    rec.busy = false;
    if (p) p.resolve({ ok: false, error: `Warm worker exited (code ${code}): ${rec.stderrTail.slice(-400)}`, exited: true });
    if (pool.get(pyBin) === rec) pool.delete(pyBin);
  });
  proc.on("error", (err) => {
    rec.stderrTail += `\n${err.message}`;
  });
  return rec;
}

function armIdle(rec) {
  if (rec.idleTimer) clearTimeout(rec.idleTimer);
  rec.idleTimer = setTimeout(() => shutdownWorker(rec), IDLE_RELEASE_MS);
  if (typeof rec.idleTimer.unref === "function") rec.idleTimer.unref();
}

function shutdownWorker(rec, hard = false) {
  if (!rec || !rec.alive) return;
  if (rec.idleTimer) clearTimeout(rec.idleTimer);
  try {
    if (!hard && rec.proc.stdin.writable) {
      rec.proc.stdin.write(`${JSON.stringify({ cmd: "exit" })}\n`);
      const t = setTimeout(() => { try { rec.proc.kill(); } catch {} }, 5000);
      if (typeof t.unref === "function") t.unref();
    } else {
      rec.proc.kill();
    }
  } catch {
    try { rec.proc.kill(); } catch {}
  }
  if (pool.get(rec.pyBin) === rec) pool.delete(rec.pyBin);
}

/**
 * Run one job on the warm worker for `pyBin`.
 * @returns {Promise<{ok:boolean,error?:string,aborted?:boolean,timedOut?:boolean,warm:boolean,elapsedMs?:number}>}
 */
export async function runWarmJob({ pyBin, workerScript, argv, jobId, onLine, isAborted, timeoutMs = 180_000 }) {
  let rec = pool.get(pyBin);
  const warm = Boolean(rec && rec.alive && rec.jobsServed > 0);
  if (!rec || !rec.alive) {
    rec = createWorker(pyBin, workerScript);
    pool.set(pyBin, rec);
  }
  try {
    await rec.ready;
  } catch (err) {
    shutdownWorker(rec, true);
    return { ok: false, error: err.message, warm: false };
  }
  if (rec.busy) {
    return { ok: false, error: "Warm worker busy", warm };
  }
  if (rec.idleTimer) clearTimeout(rec.idleTimer);
  rec.busy = true;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (res) => {
      if (settled) return;
      settled = true;
      clearInterval(abortPoll);
      clearTimeout(hardTimer);
      resolve({ warm, ...res });
    };
    rec.pending = { jobId, onLine, resolve: finish };
    const abortPoll = setInterval(() => {
      if (typeof isAborted === "function" && isAborted()) {
        rec.pending = null;
        shutdownWorker(rec, true);
        finish({ ok: false, aborted: true, error: "Task cancelled by operator." });
      }
    }, 300);
    const hardTimer = setTimeout(() => {
      rec.pending = null;
      shutdownWorker(rec, true);
      finish({ ok: false, timedOut: true, error: "Warm worker job timed out." });
    }, timeoutMs);
    try {
      rec.proc.stdin.write(`${JSON.stringify({ cmd: "run", id: jobId, argv })}\n`);
    } catch (err) {
      rec.pending = null;
      shutdownWorker(rec, true);
      finish({ ok: false, error: `Failed to dispatch job: ${err.message}` });
    }
  });
}

/** Free VRAM held by resident matting models (e.g. before heavy Real-ESRGAN / RIFE jobs). */
export function releaseWarmWorkers() {
  for (const rec of [...pool.values()]) shutdownWorker(rec);
}

export function getWarmWorkerStatus() {
  return [...pool.values()].map((rec) => ({
    alive: rec.alive,
    busy: rec.busy,
    jobsServed: rec.jobsServed,
    uptimeSec: Math.round((Date.now() - rec.startedAt) / 1000),
    idleReleaseSec: IDLE_RELEASE_MS / 1000,
  }));
}
