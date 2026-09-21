import argparse
import os
import subprocess
import tempfile
import time

import imageio_ffmpeg
from PIL import Image, ImageDraw


def create_fast_broadcast_masters(input_path, output_dir=None, logo_path=None):
    root = os.path.dirname(os.path.abspath(__file__))
    output_dir = os.path.abspath(output_dir or os.path.join(root, "dist", "broadcast"))
    os.makedirs(output_dir, exist_ok=True)
    input_path = os.path.abspath(input_path)
    if not os.path.isfile(input_path):
        raise FileNotFoundError(f"Source video not found: {input_path}")

    workspace = tempfile.TemporaryDirectory(prefix="kaptura-broadcast-")
    scratch = workspace.name
    ffmpeg_exe = imageio_ffmpeg.get_ffmpeg_exe()

    black_img_path = os.path.join(scratch, 'black_asset.png')
    intro_img_path = os.path.join(scratch, 'intro_logo_asset.png')
    outro_img_path = os.path.join(scratch, 'outro_logo_asset.png')
    
    logo_path = os.path.abspath(logo_path or os.path.join(root, "master_vector_crisp_logo.png"))

    logo_img = None
    if os.path.exists(logo_path):
        logo_img = Image.open(logo_path).convert('RGBA')

    width, height = 1920, 1080

    Image.new('RGB', (width, height), (0, 0, 0)).save(black_img_path)

    img_intro = Image.new('RGB', (width, height), (4, 6, 12))
    draw_intro = ImageDraw.Draw(img_intro)
    for x in range(35, 1920, 70):
        for y in range(35, 1080, 70):
            draw_intro.rectangle([x-1, y-1, x+1, y+1], fill=(40, 55, 80))

    cx, cy = width // 2, height // 2 - 40
    r = 110
    draw_intro.ellipse([cx-r, cy-r, cx+r, cy+r], fill=(12, 18, 32), outline=(0, 240, 255), width=3)
    if logo_img:
        l_size = 180
        resized = logo_img.resize((l_size, l_size), Image.Resampling.LANCZOS)
        img_intro.paste(resized, (cx - l_size//2, cy - l_size//2), resized)
    draw_intro.text((cx - 40, cy + 140), "ETHERNIUM", fill=(255, 255, 255))
    draw_intro.text((cx - 110, cy + 170), "SOVEREIGN AGENT ARCHITECTURE", fill=(0, 240, 255))
    img_intro.save(intro_img_path)

    img_outro = Image.new('RGB', (width, height), (4, 6, 12))
    draw_outro = ImageDraw.Draw(img_outro)
    for x in range(35, 1920, 70):
        for y in range(35, 1080, 70):
            draw_outro.rectangle([x-1, y-1, x+1, y+1], fill=(40, 55, 80))

    cx, cy = width // 2, height // 2 - 40
    r = 125
    draw_outro.ellipse([cx-r, cy-r, cx+r, cy+r], fill=(12, 18, 32), outline=(255, 255, 255), width=4)
    if logo_img:
        l_size = 200
        resized = logo_img.resize((l_size, l_size), Image.Resampling.LANCZOS)
        img_outro.paste(resized, (cx - l_size//2, cy - l_size//2), resized)
    draw_outro.text((cx - 40, cy + 150), "ETHERNIUM", fill=(255, 255, 255))
    draw_outro.text((cx - 130, cy + 180), "BUILT WITH SOVEREIGNTY // NULLA-LABS", fill=(0, 240, 255))
    draw_outro.text((cx - 100, cy + 210), "github.com/NullaLabs", fill=(255, 215, 0))
    img_outro.save(outro_img_path)

    vsrc = input_path

    print('[1/5] Rendering Clip 1 (Black Pre 2.0s)...', flush=True)
    clip_black_pre = os.path.join(scratch, 'c1_black_pre.mp4')
    subprocess.run([ffmpeg_exe, '-y', '-loop', '1', '-t', '2.0', '-i', black_img_path, '-vf', 'format=yuv420p', '-r', '60', '-c:v', 'libx264', '-preset', 'ultrafast', clip_black_pre], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    print('[2/5] Rendering Clip 2 (Intro Logo 4.0s)...', flush=True)
    clip_intro = os.path.join(scratch, 'c2_intro.mp4')
    subprocess.run([ffmpeg_exe, '-y', '-loop', '1', '-t', '4.0', '-i', intro_img_path, '-vf', 'format=yuv420p', '-r', '60', '-c:v', 'libx264', '-preset', 'ultrafast', clip_intro], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    print('[3/5] Rendering Clip 3 (Body 26.0s)...', flush=True)
    clip_body = os.path.join(scratch, 'c3_body.mp4')
    subprocess.run([ffmpeg_exe, '-y', '-stream_loop', '-1', '-i', vsrc, '-t', '26.0', '-vf', 'scale=1920:1080,format=yuv420p', '-r', '60', '-c:v', 'libx264', '-preset', 'ultrafast', clip_body], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    print('[4/5] Rendering Clip 4 (Outro Logo 6.0s)...', flush=True)
    clip_outro = os.path.join(scratch, 'c4_outro.mp4')
    subprocess.run([ffmpeg_exe, '-y', '-loop', '1', '-t', '6.0', '-i', outro_img_path, '-vf', 'format=yuv420p', '-r', '60', '-c:v', 'libx264', '-preset', 'ultrafast', clip_outro], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    print('[5/5] Rendering Clip 5 (Black Post 2.0s)...', flush=True)
    clip_black_post = os.path.join(scratch, 'c5_black_post.mp4')
    subprocess.run([ffmpeg_exe, '-y', '-loop', '1', '-t', '2.0', '-i', black_img_path, '-vf', 'format=yuv420p', '-r', '60', '-c:v', 'libx264', '-preset', 'ultrafast', clip_black_post], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    concat_list = os.path.join(scratch, 'concat_list.txt')
    with open(concat_list, 'w', encoding='utf-8') as f:
        for p in [clip_black_pre, clip_intro, clip_body, clip_outro, clip_black_post]:
            clean_p = p.replace('\\', '/')
            f.write(f"file '{clean_p}'\n")

    out_1080p = os.path.join(output_dir, 'Ethernium-Master-1080p-BROADCAST-40s-SILENT.mp4')
    out_4k = os.path.join(output_dir, 'Ethernium-Master-4K-BROADCAST-40s-SILENT.mp4')

    print('--- CONCATENATING 1080p BROADCAST MASTER (40.00s) ---', flush=True)
    t0 = time.time()
    subprocess.run([
        ffmpeg_exe, '-y', '-f', 'concat', '-safe', '0', '-i', concat_list,
        '-an', '-c:v', 'libx264', '-profile:v', 'high', '-level', '4.2',
        '-preset', 'ultrafast', '-crf', '16', '-movflags', '+faststart',
        out_1080p
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    print(f'[SUCCESS 1080p BROADCAST 40s]: {out_1080p} ({os.path.getsize(out_1080p)/(1024*1024):.2f} MB in {time.time()-t0:.2f}s)', flush=True)

    print('--- SCALING TO 4K BROADCAST MASTER (3840x2160) ---', flush=True)
    t0 = time.time()
    subprocess.run([
        ffmpeg_exe, '-y', '-i', out_1080p, '-t', '40.00',
        '-vf', 'scale=3840:2160:force_original_aspect_ratio=decrease,pad=3840:2160:(ow-iw)/2:(oh-ih)/2,fps=60,format=yuv420p',
        '-an', '-c:v', 'libx264', '-profile:v', 'high', '-level', '5.1',
        '-preset', 'ultrafast', '-crf', '16', '-movflags', '+faststart',
        out_4k
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    print(f'[SUCCESS 4K BROADCAST 40s]: {out_4k} ({os.path.getsize(out_4k)/(1024*1024):.2f} MB in {time.time()-t0:.2f}s)', flush=True)
    workspace.cleanup()

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description="Compose KAPTURA broadcast masters from a source video.")
    parser.add_argument("input")
    parser.add_argument("--output-dir")
    parser.add_argument("--logo")
    args = parser.parse_args()
    create_fast_broadcast_masters(args.input, args.output_dir, args.logo)
