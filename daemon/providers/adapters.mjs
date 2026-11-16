/**
 * Local Sovereign Companion Adapters (UPSKALETOR, FONT FORGE 2, ETHERNIUM VOX)
 * Unified path discovery and read-only capability introspection with zero code duplication.
 */

import { existsSync, readdirSync } from "node:fs";
import os from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";

const appDataBase = process.env.LOCALAPPDATA || join(os.homedir(), ".local", "share");
const etherniumHome = join(appDataBase, "Ethernium");

const PROVIDER_DEFS = {
  upskalator: {
    envKey: "ETHERNIUM_UPSKALETOR_PATH",
    candidates: [join(etherniumHome, "UPSKALETOR"), join(os.homedir(), "UPSKALETOR")],
  },
  fontForge: {
    envKey: "ETHERNIUM_FONT_FORGE_PATH",
    candidates: [join(etherniumHome, "FontForge"), join(os.homedir(), "FontForge")],
  },
  etherniumVox: {
    envKey: "ETHERNIUM_VOX_PATH",
    candidates: [join(etherniumHome, "VOX"), join(os.homedir(), "VOX")],
  },
};

/** Resolve the first existing local directory for a companion engine. */
export function resolveCompanionPath(providerKey) {
  const def = PROVIDER_DEFS[providerKey];
  if (!def) return null;
  const envVal = process.env[def.envKey];
  if (envVal && existsSync(envVal)) return resolve(envVal);
  for (const candidate of def.candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Locate real-esrgan ncnn vulkan binary if installed via env, PATH, or companion dir. */
export function resolveRealEsrganExecutable() {
  const envPath = process.env.ETHERNIUM_REALESRGAN_PATH;
  if (envPath && existsSync(envPath)) return resolve(envPath);

  const upDir = resolveCompanionPath("upskalator");
  const exeNames = process.platform === "win32"
    ? ["realesrgan-ncnn-vulkan.exe", "realesrgan-ncnn-vulkan"]
    : ["realesrgan-ncnn-vulkan"];

  if (upDir) {
    for (const exe of exeNames) {
      const candidate = join(upDir, exe);
      if (existsSync(candidate)) return resolve(candidate);
    }
  }

  try {
    const cmd = process.platform === "win32" ? "where.exe" : "which";
    const probe = spawnSync(cmd, ["realesrgan-ncnn-vulkan"], { encoding: "utf8", windowsHide: true });
    if (probe.status === 0 && probe.stdout) {
      const firstLine = probe.stdout.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
      if (firstLine && existsSync(firstLine)) return resolve(firstLine);
    }
  } catch { /* ignore */ }

  return null;
}

export function getCompanionStatus() {
  const upskalatorPath = resolveCompanionPath("upskalator");
  const fontForgePath = resolveCompanionPath("fontForge");
  const voxPath = resolveCompanionPath("etherniumVox");
  const realEsrganPath = resolveRealEsrganExecutable();
  return {
    etherniumVox: Boolean(voxPath),
    fontForge: Boolean(fontForgePath),
    upskalator: Boolean(upskalatorPath),
    realEsrgan: Boolean(realEsrganPath),
    paths: {
      etherniumVox: voxPath,
      fontForge: fontForgePath,
      upskalator: upskalatorPath,
      realEsrgan: realEsrganPath,
    },
  };
}

/** Find a usable TTF font asset inside Font Forge 2 for optional FFmpeg drawtext overlays. */
export function resolveFontTtfPath() {
  const ffDir = resolveCompanionPath("fontForge");
  if (!ffDir) return null;
  const preferred = join(ffDir, "Ethernium_Sym.ttf");
  if (existsSync(preferred)) return preferred;
  try {
    const entry = readdirSync(ffDir).find((name) => name.toLowerCase().endsWith(".ttf"));
    return entry ? join(ffDir, entry) : null;
  } catch {
    return null;
  }
}

/** Invoke UPSKALETOR PowerShell launcher when an authorized local companion path exists. */
export async function runUpskaletor({ inputPath, scaleFactor = 2 }) {
  const upDir = resolveCompanionPath("upskalator");
  if (!upDir) {
    return { success: false, provider: "upskalator", reason: "UPSKALETOR not installed on host." };
  }
  const psScript = join(upDir, "kpr-upscale.ps1");
  if (!existsSync(psScript)) {
    return { success: false, provider: "upskalator", reason: `Entrypoint not found: ${psScript}` };
  }
  return new Promise((resolvePromise) => {
    const proc = spawn("powershell", ["-ExecutionPolicy", "Bypass", "-File", psScript, "-Input", inputPath, "-Scale", String(scaleFactor)], {
      cwd: upDir,
      windowsHide: true,
    });
    let stderr = "";
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("close", (code) => {
      resolvePromise(
        code === 0
          ? { success: true, provider: "UPSKALETOR_VULKAN", path: upDir }
          : { success: false, provider: "UPSKALETOR_VULKAN", reason: stderr.trim() || `Exit ${code}` }
      );
    });
  });
}
