/**
 * Local Sovereign Companion Adapters (UPSKALETOR, FONT FORGE 2, ETHERNIUM VOX)
 * Unified path discovery and read-only capability introspection with zero code duplication.
 */

import { existsSync, readdirSync } from "node:fs";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

const __adaptersDir = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__adaptersDir, "..", "..");
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

/** Shared binary locator checking explicit env override, UPSKALETOR companion dir, then system PATH. */
function resolveBinaryExecutable(envKey, exeStem) {
  const envPath = process.env[envKey];
  if (envPath && existsSync(envPath)) return resolve(envPath);

  const upDir = resolveCompanionPath("upskalator");
  const exeNames = process.platform === "win32" ? [`${exeStem}.exe`, exeStem] : [exeStem];

  if (upDir) {
    for (const exe of exeNames) {
      const candidate = join(upDir, exe);
      if (existsSync(candidate)) return resolve(candidate);
    }
  }

  try {
    const cmd = process.platform === "win32" ? "where.exe" : "which";
    const probe = spawnSync(cmd, [exeStem], { encoding: "utf8", windowsHide: true });
    if (probe.status === 0 && probe.stdout) {
      const firstLine = probe.stdout.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
      if (firstLine && existsSync(firstLine)) return resolve(firstLine);
    }
  } catch { /* ignore */ }

  return null;
}

/** Locate real-esrgan ncnn vulkan binary if installed via env, PATH, or companion dir. */
export function resolveRealEsrganExecutable() {
  return resolveBinaryExecutable("ETHERNIUM_REALESRGAN_PATH", "realesrgan-ncnn-vulkan");
}

/** Locate rife-ncnn-vulkan binary if installed via env, PATH, or companion dir. */
export function resolveRifeExecutable() {
  return resolveBinaryExecutable("ETHERNIUM_RIFE_PATH", "rife-ncnn-vulkan");
}

/** Locate directory containing downloaded neural matting models (BiRefNet / RVM). */
export function resolveMattingModelsDir() {
  const candidates = [
    process.env.ETHERNIUM_MATTING_MODELS_DIR,
    process.platform === "win32" ? "E:\\UPSKALETOR\\models\\matting" : null,
    join(REPO_ROOT, ".models", "matting"),
    resolveCompanionPath("upskalator") ? join(resolveCompanionPath("upskalator"), "models", "matting") : null,
    join(etherniumHome, "UPSKALETOR", "models", "matting"),
  ].filter(Boolean);

  for (const dir of candidates) {
    const abs = resolve(dir);
    if (!existsSync(abs)) continue;
    try {
      const files = readdirSync(abs);
      if (files.some((f) => f.endsWith(".onnx") || f.endsWith(".torchscript"))) {
        return abs;
      }
    } catch { /* ignore */ }
  }
  return null;
}

let cachedBgRuntimes = null;

function probePythonCapabilities(pyBin, checkCuda = true) {
  try {
    const code = "import importlib.util, json; "
      + "has_np=bool(importlib.util.find_spec('numpy')); "
      + "has_cv=bool(importlib.util.find_spec('cv2')); "
      + "has_ort=bool(importlib.util.find_spec('onnxruntime')); "
      + "cuda=False\n"
      + (checkCuda
        ? "if importlib.util.find_spec('torch'):\n import torch\n cuda=bool(torch.cuda.is_available())\n"
        : "")
      + "print(json.dumps({'np':has_np,'cv':has_cv,'ort':has_ort,'cuda':cuda}))";
    const res = spawnSync(pyBin, ["-c", code], { encoding: "utf8", timeout: 25000, windowsHide: true });
    if (res.status === 0 && res.stdout) {
      return JSON.parse(res.stdout.trim().split(/\r?\n/).pop());
    }
  } catch { /* ignore */ }
  return null;
}

/** Discover installed BiRefNet / RVM models and Python ONNX / CUDA runtimes (cached). */
export function resolveBgRuntimes(forceRefresh = false) {
  if (cachedBgRuntimes && !forceRefresh) return cachedBgRuntimes;
  const modelsDir = resolveMattingModelsDir();
  const pickFile = (name) => {
    if (!modelsDir) return null;
    const p = join(modelsDir, name);
    return existsSync(p) ? p : null;
  };
  const birefnetModel = pickFile("BiRefNet-general-bb_swin_v1_tiny-epoch_232.onnx");
  const rvmTorchModel = pickFile("rvm_resnet50_fp16.torchscript");
  const rvmOnnxModel = pickFile("rvm_mobilenetv3_fp32.onnx");

  let onnxPython = null;
  let cudaPython = null;
  if (birefnetModel || rvmTorchModel || rvmOnnxModel) {
    const pyCandidates = [
      process.env.ETHERNIUM_CUDA_PYTHON,
      process.env.ETHERNIUM_ONNX_PYTHON,
      process.env.PYTHON,
      "D:\\Experimentos\\ethernium\\yggdrasil\\02_DATA\\PANTEON_COGNITIVO\\06_PUERTOS_DE_ASIMILACION\\ETHERNIA\\Lum\\ComfyUI\\venv\\Scripts\\python.exe",
      "python",
      "python3",
    ].filter((v, i, arr) => Boolean(v) && arr.indexOf(v) === i);

    for (const candidate of pyCandidates) {
      if ((candidate.includes("\\") || candidate.includes("/")) && !existsSync(candidate)) continue;
      const caps = probePythonCapabilities(candidate, !cudaPython);
      if (!caps || !caps.np || !caps.cv) continue;
      if (!onnxPython && caps.ort) onnxPython = candidate;
      if (!cudaPython && caps.cuda) cudaPython = candidate;
      if (onnxPython && cudaPython) break;
    }
  }

  cachedBgRuntimes = {
    modelsDir,
    onnxPython,
    cudaPython,
    birefnetModel,
    rvmTorchModel,
    rvmOnnxModel,
    birefnet: Boolean(birefnetModel && onnxPython),
    rvmCuda: Boolean(rvmTorchModel && cudaPython),
    rvmOnnx: Boolean(rvmOnnxModel && onnxPython),
  };
  return cachedBgRuntimes;
}

export function getCompanionStatus() {
  const upskalatorPath = resolveCompanionPath("upskalator");
  const fontForgePath = resolveCompanionPath("fontForge");
  const voxPath = resolveCompanionPath("etherniumVox");
  const realEsrganPath = resolveRealEsrganExecutable();
  const rifePath = resolveRifeExecutable();
  const bg = resolveBgRuntimes();
  return {
    etherniumVox: Boolean(voxPath),
    fontForge: Boolean(fontForgePath),
    upskalator: Boolean(upskalatorPath),
    realEsrgan: Boolean(realEsrganPath),
    rife: Boolean(rifePath),
    bgRemoval: {
      birefnet: bg.birefnet,
      rvmCuda: bg.rvmCuda,
      rvmOnnx: bg.rvmOnnx,
      chromaGpu: true,
    },
    paths: {
      etherniumVox: voxPath,
      fontForge: fontForgePath,
      upskalator: upskalatorPath,
      realEsrgan: realEsrganPath,
      rife: rifePath,
      mattingModels: bg.modelsDir,
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
