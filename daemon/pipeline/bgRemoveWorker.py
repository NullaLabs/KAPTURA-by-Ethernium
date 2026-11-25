#!/usr/bin/env python3
"""
KAPTURA BG STUDIO WORKER (Zero-Cloud Local Matting Engine)
Supports:
  - Images: BiRefNet 1024px ONNX, RVM MobileNetV3 ONNX
  - Videos: RVM ResNet50 CUDA FP16 (TorchScript, temporal recurrence), RVM MobileNetV3 ONNX, BiRefNet
Backdrops: transparent (PNG RGBA / WebM VP9 yuva420p), prores (ProRes 4444 alpha),
           greenscreen (#00FF00), bokeh (DSLR blur), solid (#RRGGBB), custom_image
"""
import argparse
import json
import os
import subprocess
import sys
import time
import cv2
import numpy as np


def emit(payload):
    print(json.dumps(payload, ensure_ascii=True), flush=True)


def parse_hex_rgb(hex_color):
    s = (hex_color or "#050814").strip().lstrip("#")
    if len(s) == 3:
        s = "".join(c * 2 for c in s)
    if len(s) != 6:
        return (5, 8, 20)
    try:
        return (int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16))
    except ValueError:
        return (5, 8, 20)


def cover_resize_rgb(img_rgb, w, h):
    bh, bw = img_rgb.shape[:2]
    if bw <= 0 or bh <= 0:
        return np.zeros((h, w, 3), dtype=np.uint8)
    scale = max(w / bw, h / bh)
    nw = max(w, int(round(bw * scale)))
    nh = max(h, int(round(bh * scale)))
    interp = cv2.INTER_AREA if scale < 1.0 else cv2.INTER_CUBIC
    resized = cv2.resize(img_rgb, (nw, nh), interpolation=interp)
    x0 = max(0, (nw - w) // 2)
    y0 = max(0, (nh - h) // 2)
    return np.ascontiguousarray(resized[y0:y0 + h, x0:x0 + w])


def fast_guided_filter(guide_gray_f32, src_f32, radius=6, eps=1e-3):
    ksize = (radius * 2 + 1, radius * 2 + 1)
    mean_i = cv2.boxFilter(guide_gray_f32, cv2.CV_32F, ksize)
    mean_p = cv2.boxFilter(src_f32, cv2.CV_32F, ksize)
    corr_i = cv2.boxFilter(guide_gray_f32 * guide_gray_f32, cv2.CV_32F, ksize)
    corr_ip = cv2.boxFilter(guide_gray_f32 * src_f32, cv2.CV_32F, ksize)
    var_i = np.maximum(0.0, corr_i - mean_i * mean_i)
    cov_ip = corr_ip - mean_i * mean_p
    a = cov_ip / (var_i + eps)
    b = mean_p - a * mean_i
    mean_a = cv2.boxFilter(a, cv2.CV_32F, ksize)
    mean_b = cv2.boxFilter(b, cv2.CV_32F, ksize)
    return np.clip(mean_a * guide_gray_f32 + mean_b, 0.0, 1.0)


def refine_alpha(alpha_f32, guide_rgb_u8, edge_refine=0, guided=True):
    a = np.clip(alpha_f32, 0.0, 1.0).astype(np.float32)
    if guided:
        gray = (
            0.299 * guide_rgb_u8[:, :, 0]
            + 0.587 * guide_rgb_u8[:, :, 1]
            + 0.114 * guide_rgb_u8[:, :, 2]
        ).astype(np.float32) / 255.0
        g_out = fast_guided_filter(gray, a, radius=4, eps=5e-4)
        # Preserve interior opacity while aligning semi-transparent boundaries to edges
        edge_band = ((a > 0.03) & (a < 0.97)).astype(np.float32)
        edge_band = cv2.GaussianBlur(edge_band, (5, 5), 0)
        a = a * (1.0 - edge_band * 0.65) + g_out * (edge_band * 0.65)

    er = int(round(edge_refine))
    if er != 0:
        ks = abs(er) * 2 + 1
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (ks, ks))
        a_u8 = np.clip(a * 255.0, 0, 255).astype(np.uint8)
        a_u8 = cv2.dilate(a_u8, kernel) if er > 0 else cv2.erode(a_u8, kernel)
        a = cv2.GaussianBlur(a_u8.astype(np.float32) / 255.0, (3, 3), 0)
    return np.clip(a, 0.0, 1.0)


def decontaminate_foreground(rgb_u8, alpha_f32, fgr_u8=None):
    if fgr_u8 is not None:
        return fgr_u8
    band = (alpha_f32 > 0.02) & (alpha_f32 < 0.94)
    if not np.any(band):
        return rgb_u8
    solid = (alpha_f32 >= 0.94).astype(np.float32)
    rgb_f = rgb_u8.astype(np.float32)
    num = cv2.GaussianBlur(rgb_f * solid[..., None], (15, 15), 0)
    den = cv2.GaussianBlur(solid, (15, 15), 0)[..., None]
    pure_fg = np.where(den > 1e-4, num / np.maximum(den, 1e-4), rgb_f)
    out = np.where(band[..., None], pure_fg, rgb_f)
    return np.clip(out, 0, 255).astype(np.uint8)


def compose_output_frame(rgb_u8, alpha_f32, backdrop, bg_color_rgb, blur_strength, custom_bg_rgb=None, fgr_u8=None, decontaminate=True):
    fg = decontaminate_foreground(rgb_u8, alpha_f32, fgr_u8) if decontaminate else rgb_u8
    if backdrop in ("transparent", "prores"):
        a_u8 = np.clip(alpha_f32 * 255.0, 0, 255).astype(np.uint8)
        return np.dstack((fg, a_u8))

    if backdrop == "greenscreen":
        bg = np.empty_like(fg)
        bg[:, :] = (0, 255, 0)
    elif backdrop == "solid":
        bg = np.empty_like(fg)
        bg[:, :] = bg_color_rgb
    elif backdrop == "custom_image" and custom_bg_rgb is not None:
        bg = custom_bg_rgb
    else:
        # Bokeh DSLR depth-of-field blur of original scene
        k = max(5, int(blur_strength) | 1)
        bg = cv2.GaussianBlur(rgb_u8, (k, k), 0)

    a = alpha_f32[..., None]
    comp = fg.astype(np.float32) * a + bg.astype(np.float32) * (1.0 - a)
    return np.clip(comp, 0, 255).astype(np.uint8)


def create_ort_session(model_path):
    import onnxruntime as ort
    opts = ort.SessionOptions()
    opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_BASIC
    threads = min(8, os.cpu_count() or 4)
    opts.intra_op_num_threads = threads
    opts.inter_op_num_threads = 2
    return ort.InferenceSession(model_path, sess_options=opts, providers=["CPUExecutionProvider"])


def run_birefnet_frame(sess, inp_name, rgb_u8):
    h, w = rgb_u8.shape[:2]
    resized = cv2.resize(rgb_u8, (1024, 1024), interpolation=cv2.INTER_CUBIC).astype(np.float32) / 255.0
    mean = np.array([0.485, 0.456, 0.406], dtype=np.float32)
    std = np.array([0.229, 0.224, 0.225], dtype=np.float32)
    ten = ((resized - mean) / std).transpose(2, 0, 1)[None, ...].astype(np.float32)
    out = sess.run(None, {inp_name: ten})[-1]
    pred = np.squeeze(out).astype(np.float32)
    if pred.max() > 1.0 or pred.min() < 0.0:
        pred = 1.0 / (1.0 + np.exp(-np.clip(pred, -25.0, 25.0)))
    return cv2.resize(pred, (w, h), interpolation=cv2.INTER_CUBIC)


def compute_downsample_ratio(w, h):
    max_dim = max(w, h)
    if max_dim >= 3200:
        return 0.16
    if max_dim >= 1800:
        return 0.25
    if max_dim >= 1100:
        return 0.375
    if max_dim >= 600:
        return 0.5
    return 1.0


def run_image(args):
    emit({"stage": "BG_MODEL_LOAD", "progress": 12, "engine": args.engine})
    bgr = cv2.imread(args.input, cv2.IMREAD_UNCHANGED)
    if bgr is None:
        raise RuntimeError(f"Could not decode image: {args.input}")
    if bgr.ndim == 2:
        bgr = cv2.cvtColor(bgr, cv2.COLOR_GRAY2BGR)
    elif bgr.shape[2] == 4:
        bgr = bgr[:, :, :3]
    rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
    h, w = rgb.shape[:2]

    custom_bg = None
    if args.backdrop == "custom_image" and args.bg_image and os.path.isfile(args.bg_image):
        cbgr = cv2.imread(args.bg_image, cv2.IMREAD_COLOR)
        if cbgr is not None:
            custom_bg = cover_resize_rgb(cv2.cvtColor(cbgr, cv2.COLOR_BGR2RGB), w, h)

    sess = create_ort_session(args.model)
    emit({"stage": "BG_INFER", "progress": 38, "engine": args.engine})

    fgr_u8 = None
    if args.engine == "birefnet":
        inp_name = sess.get_inputs()[0].name
        raw_alpha = run_birefnet_frame(sess, inp_name, rgb)
    else:
        src = (rgb.astype(np.float32) / 255.0).transpose(2, 0, 1)[None, ...]
        rec = [np.zeros([1, 1, 1, 1], dtype=np.float32)] * 4
        ds = np.array([compute_downsample_ratio(w, h)], dtype=np.float32)
        fgr, pha, *_ = sess.run(None, {"src": src, "r1i": rec[0], "r2i": rec[1], "r3i": rec[2], "r4i": rec[3], "downsample_ratio": ds})
        raw_alpha = np.squeeze(pha).astype(np.float32)
        fgr_u8 = np.clip(np.squeeze(fgr).transpose(1, 2, 0) * 255.0, 0, 255).astype(np.uint8)

    emit({"stage": "BG_COMPOSITE", "progress": 82, "engine": args.engine})
    alpha = refine_alpha(raw_alpha, rgb, edge_refine=args.edge_refine, guided=True)
    comp = compose_output_frame(
        rgb,
        alpha,
        args.backdrop,
        parse_hex_rgb(args.bg_color),
        args.blur_strength,
        custom_bg_rgb=custom_bg,
        fgr_u8=fgr_u8,
        decontaminate=bool(args.decontaminate),
    )
    if comp.shape[2] == 4:
        out_cv = cv2.cvtColor(comp, cv2.COLOR_RGBA2BGRA)
    else:
        out_cv = cv2.cvtColor(comp, cv2.COLOR_RGB2BGR)
    if not cv2.imwrite(args.output, out_cv):
        raise RuntimeError(f"Failed writing output PNG: {args.output}")
    emit({"stage": "COMPLETE", "progress": 100, "width": w, "height": h, "hasAlpha": comp.shape[2] == 4})


def build_video_encode_cmd(args, out_has_alpha):
    ff = args.ffmpeg
    w, h = args.width, args.height
    fps_str = str(args.fps if args.fps > 0 else 30)
    in_pix = "rgba" if out_has_alpha else "rgb24"
    cmd = [
        ff, "-hide_banner", "-nostats", "-y",
        "-f", "rawvideo", "-pix_fmt", in_pix, "-s", f"{w}x{h}", "-r", fps_str, "-i", "pipe:0",
    ]
    if args.has_audio:
        cmd.extend(["-i", args.input, "-map", "0:v:0", "-map", "1:a?"])
    else:
        cmd.extend(["-map", "0:v:0"])

    if args.backdrop == "prores":
        cmd.extend(["-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuva444p10le"])
        if args.has_audio:
            cmd.extend(["-c:a", "aac", "-b:a", "192k", "-shortest"])
    elif args.backdrop == "transparent":
        cmd.extend(["-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-auto-alt-ref", "0", "-row-mt", "1", "-deadline", "good", "-crf", "24", "-b:v", "0"])
        if args.has_audio:
            cmd.extend(["-c:a", "libopus", "-b:a", "128k", "-shortest"])
    else:
        codec = args.codec or "h264_nvenc"
        if codec == "hevc_nvenc":
            cmd.extend(["-c:v", "hevc_nvenc", "-preset", "p3", "-tune", "hq", "-tag:v", "hvc1", "-rc", "vbr", "-cq", "22", "-b:v", "0", "-pix_fmt", "yuv420p"])
        elif codec == "libx265":
            cmd.extend(["-c:v", "libx265", "-preset", "medium", "-tag:v", "hvc1", "-crf", "22", "-pix_fmt", "yuv420p"])
        elif codec == "h264_nvenc":
            cmd.extend(["-c:v", "h264_nvenc", "-preset", "p3", "-tune", "hq", "-rc", "vbr", "-cq", "20", "-b:v", "0", "-pix_fmt", "yuv420p"])
        else:
            cmd.extend(["-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p"])
        if args.has_audio:
            cmd.extend(["-c:a", "aac", "-b:a", "160k", "-shortest"])
        cmd.extend(["-movflags", "+faststart"])

    cmd.append(args.output)
    return cmd


def run_video(args):
    emit({"stage": "BG_MODEL_LOAD", "progress": 10, "engine": args.engine})
    w, h = args.width, args.height
    frame_bytes = w * h * 3
    out_has_alpha = args.backdrop in ("transparent", "prores")
    bg_color = parse_hex_rgb(args.bg_color)
    custom_bg = None
    if args.backdrop == "custom_image" and args.bg_image and os.path.isfile(args.bg_image):
        cbgr = cv2.imread(args.bg_image, cv2.IMREAD_COLOR)
        if cbgr is not None:
            custom_bg = cover_resize_rgb(cv2.cvtColor(cbgr, cv2.COLOR_BGR2RGB), w, h)

    use_cuda = args.engine == "rvm_cuda"
    use_birefnet = args.engine == "birefnet"
    ds_val = compute_downsample_ratio(w, h)

    torch_mod = None
    torch_model = None
    cuda_rec = [None] * 4
    ort_sess = None
    ort_inp_name = None
    onnx_rec = None
    onnx_ds = None

    if use_cuda:
        import torch
        torch_mod = torch
        device = torch.device("cuda")
        torch_model = torch.jit.load(args.model, map_location=device).eval()
    else:
        ort_sess = create_ort_session(args.model)
        if use_birefnet:
            ort_inp_name = ort_sess.get_inputs()[0].name
        else:
            onnx_rec = [np.zeros([1, 1, 1, 1], dtype=np.float32)] * 4
            onnx_ds = np.array([ds_val], dtype=np.float32)

    dec_cmd = [
        args.ffmpeg, "-hide_banner", "-loglevel", "error", "-i", args.input,
        "-f", "rawvideo", "-pix_fmt", "rgb24", "-vsync", "passthrough", "pipe:1",
    ]
    enc_cmd = build_video_encode_cmd(args, out_has_alpha)

    dec_proc = subprocess.Popen(dec_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    enc_proc = subprocess.Popen(enc_cmd, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)

    est_total = max(1, int(args.total_frames or 1))
    frame_idx = 0
    t_start = time.time()
    last_emit = 0.0

    try:
        while True:
            raw = dec_proc.stdout.read(frame_bytes)
            if not raw or len(raw) < frame_bytes:
                break
            rgb = np.frombuffer(raw, dtype=np.uint8).reshape(h, w, 3)

            fgr_u8 = None
            if use_cuda:
                with torch_mod.no_grad():
                    src_t = (
                        torch_mod.from_numpy(rgb.copy())
                        .to(device="cuda", dtype=torch_mod.float16)
                        .permute(2, 0, 1)
                        .unsqueeze(0)
                        / 255.0
                    )
                    fgr_t, pha_t, *cuda_rec = torch_model(src_t, *cuda_rec, downsample_ratio=ds_val)
                    alpha_raw = pha_t[0, 0].float().cpu().numpy()
                    fgr_u8 = (
                        fgr_t[0]
                        .clamp(0.0, 1.0)
                        .mul(255.0)
                        .permute(1, 2, 0)
                        .byte()
                        .cpu()
                        .numpy()
                    )
            elif use_birefnet:
                alpha_raw = run_birefnet_frame(ort_sess, ort_inp_name, rgb)
            else:
                src = (rgb.astype(np.float32) / 255.0).transpose(2, 0, 1)[None, ...]
                fgr, pha, *onnx_rec = ort_sess.run(
                    None,
                    {"src": src, "r1i": onnx_rec[0], "r2i": onnx_rec[1], "r3i": onnx_rec[2], "r4i": onnx_rec[3], "downsample_ratio": onnx_ds},
                )
                alpha_raw = np.squeeze(pha).astype(np.float32)
                fgr_u8 = np.clip(np.squeeze(fgr).transpose(1, 2, 0) * 255.0, 0, 255).astype(np.uint8)

            alpha = refine_alpha(alpha_raw, rgb, edge_refine=args.edge_refine, guided=(not use_cuda))
            out_frame = compose_output_frame(
                rgb,
                alpha,
                args.backdrop,
                bg_color,
                args.blur_strength,
                custom_bg_rgb=custom_bg,
                fgr_u8=fgr_u8,
                decontaminate=bool(args.decontaminate),
            )
            enc_proc.stdin.write(out_frame.tobytes())
            frame_idx += 1

            now = time.time()
            if frame_idx == 1 or now - last_emit >= 0.45:
                last_emit = now
                elapsed = max(0.05, now - t_start)
                fps_rate = frame_idx / elapsed
                pct = min(94, 12 + int((frame_idx / max(est_total, frame_idx)) * 82))
                eta = max(0, int((max(est_total, frame_idx) - frame_idx) / max(0.2, fps_rate)))
                emit({
                    "stage": "BG_MATTE",
                    "frame": frame_idx,
                    "totalFrames": max(est_total, frame_idx),
                    "progress": pct,
                    "secPerFrame": round(elapsed / frame_idx, 2),
                    "etaSec": eta,
                    "engine": args.engine,
                })
    finally:
        try:
            dec_proc.stdout.close()
        except Exception:
            pass
        try:
            enc_proc.stdin.close()
        except Exception:
            pass
        dec_ret = dec_proc.wait(timeout=30)
        enc_ret = enc_proc.wait(timeout=120)
        if use_cuda and torch_mod is not None:
            try:
                del torch_model, cuda_rec
                torch_mod.cuda.empty_cache()
            except Exception:
                pass

    if enc_ret != 0 or not os.path.isfile(args.output) or os.path.getsize(args.output) == 0:
        err_tail = enc_proc.stderr.read().decode(errors="ignore")[-500:]
        raise RuntimeError(f"FFmpeg encode failed ({enc_ret}): {err_tail}")
    if dec_ret != 0 and frame_idx == 0:
        err_tail = dec_proc.stderr.read().decode(errors="ignore")[-400:]
        raise RuntimeError(f"FFmpeg decode failed ({dec_ret}): {err_tail}")
    emit({"stage": "COMPLETE", "frame": frame_idx, "totalFrames": frame_idx, "progress": 100})


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--mode", required=True, choices=["image", "video"])
    p.add_argument("--engine", required=True, choices=["birefnet", "rvm_cuda", "rvm_onnx"])
    p.add_argument("--input", required=True)
    p.add_argument("--output", required=True)
    p.add_argument("--model", required=True)
    p.add_argument("--backdrop", default="transparent")
    p.add_argument("--bg-color", default="#050814")
    p.add_argument("--bg-image", default="")
    p.add_argument("--blur-strength", type=int, default=23)
    p.add_argument("--edge-refine", type=float, default=0.0)
    p.add_argument("--decontaminate", type=int, default=1)
    p.add_argument("--ffmpeg", default="ffmpeg")
    p.add_argument("--codec", default="h264_nvenc")
    p.add_argument("--fps", type=float, default=30.0)
    p.add_argument("--width", type=int, default=0)
    p.add_argument("--height", type=int, default=0)
    p.add_argument("--total-frames", type=int, default=0)
    p.add_argument("--has-audio", type=int, default=0)
    args = p.parse_args()

    if args.mode == "image":
        run_image(args)
    else:
        run_video(args)


if __name__ == "__main__":
    main()
