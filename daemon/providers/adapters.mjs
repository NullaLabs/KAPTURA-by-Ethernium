/**
 * Local Sovereign Companion Adapters (UPSKALETOR, FONT FORGE 2, ETHERNIUM VOX)
 * Unified path discovery and read-only capability introspection with zero code duplication.
 */

import { existsSync, readdirSync } from "node:fs";
import os from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

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

export function getCompanionStatus() {
  const upskalatorPath = resolveCompanionPath("upskalator");
  const fontForgePath = resolveCompanionPath("fontForge");
  const voxPath = resolveCompanionPath("etherniumVox");
  return {
    etherniumVox: Boolean(voxPath),
    fontForge: Boolean(fontForgePath),
    upskalator: Boolean(upskalatorPath),
    paths: {
      etherniumVox: voxPath,
      fontForge: fontForgePath,
      upskalator: upskalatorPath,
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
