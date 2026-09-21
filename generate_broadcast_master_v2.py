import argparse
import os
import subprocess
from PIL import Image, ImageDraw


def render_broadcast_master_v2(output_dir=None, logo_path=None):
    root = os.path.dirname(os.path.abspath(__file__))
    output_dir = os.path.abspath(output_dir or os.path.join(root, "dist", "broadcast"))
    os.makedirs(output_dir, exist_ok=True)
    logo_path = os.path.abspath(logo_path or os.path.join(root, "master_vector_crisp_logo.png"))

    logo_img = None
    if os.path.exists(logo_path):
        try:
            logo_img = Image.open(logo_path).convert('RGBA')
        except Exception as e:
            print('Could not load logo img:', e, flush=True)

    width, height = 1920, 1080
    fps = 60
    total_duration = 40.0 # 40.0s total
    total_frames = int(fps * total_duration) # 2400 frames

    import imageio_ffmpeg
    ffmpeg_exe = imageio_ffmpeg.get_ffmpeg_exe()

    out_1080p = os.path.join(output_dir, 'Ethernium-Master-1080p-BROADCAST-40s-SILENT.mp4')
    out_4k = os.path.join(output_dir, 'Ethernium-Master-4K-BROADCAST-40s-SILENT.mp4')

    print(f'[1/2] Rendering {total_frames} Frame-Accurate Broadcast RGB24 Frames @ {fps} FPS CFR...', flush=True)
    
    cmd_1080p = [
        ffmpeg_exe, '-y',
        '-f', 'rawvideo',
        '-vcodec', 'rawvideo',
        '-s', f'{width}x{height}',
        '-pix_fmt', 'rgb24',
        '-r', str(fps),
        '-i', '-',
        '-t', str(total_duration),
        '-vf', 'scale=1920:1080,format=yuv420p',
        '-fps_mode', 'cfr',
        '-an',
        '-c:v', 'libx264', '-profile:v', 'high', '-level', '4.2',
        '-preset', 'ultrafast', '-crf', '16', '-movflags', '+faststart',
        out_1080p
    ]

    p1080 = subprocess.Popen(cmd_1080p, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    bg_black = Image.new('RGB', (width, height), (0, 0, 0))
    bg_deep = Image.new('RGB', (width, height), (4, 6, 12))

    for frame_idx in range(total_frames):
        t = frame_idx / float(fps)

        if t < 2.0:
            # === 0.0s to 2.0s: PRE-ROLL BLACK SCREEN (2 FULL SECONDS BEFORE INITIAL LOGO) ===
            frame = bg_black.copy()

        elif t < 6.0:
            # === 2.0s to 6.0s: INITIAL LOGO INTRO (4 FULL SECONDS STATIC DISPLAY) ===
            frame = bg_deep.copy()
            draw = ImageDraw.Draw(frame)
            
            # Grid dots
            for x in range(35, 1920, 70):
                for y in range(35, 1080, 70):
                    draw.rectangle([x-1, y-1, x+1, y+1], fill=(40, 55, 80))

            cx, cy = width // 2, height // 2 - 40
            r = 110
            draw.ellipse([cx-r, cy-r, cx+r, cy+r], fill=(12, 18, 32), outline=(0, 240, 255), width=3)
            
            if logo_img:
                l_size = 180
                resized_logo = logo_img.resize((l_size, l_size), Image.Resampling.LANCZOS)
                frame.paste(resized_logo, (cx - l_size//2, cy - l_size//2), resized_logo)
            
            draw.text((cx - 40, cy + 140), "ETHERNIUM", fill=(255, 255, 255))
            draw.text((cx - 110, cy + 170), "SOVEREIGN AGENT ARCHITECTURE", fill=(0, 240, 255))

        elif t < 32.0:
            # === 6.0s to 32.0s: MAIN PRESENTATION BODY (26 FULL SECONDS) ===
            frame = bg_deep.copy()
            draw = ImageDraw.Draw(frame)

            for x in range(35, 1920, 70):
                for y in range(35, 1080, 70):
                    draw.rectangle([x-1, y-1, x+1, y+1], fill=(40, 55, 80))

            body_t = t - 6.0
            cx, cy = width // 2, height // 2
            
            if body_t < 5.0:
                draw.text((cx - 100, cy - 80), "SENESCHAL AGENT ENGINE", fill=(0, 255, 157))
                draw.text((cx - 160, cy - 30), "Autonomous Task Orchestration & Self-Correction", fill=(255, 255, 255))
            elif body_t < 10.0:
                draw.text((cx - 90, cy - 80), "CONEKTA TELEMETRY", fill=(0, 240, 255))
                draw.text((cx - 150, cy - 30), "Binary Protocol & Real-time Neural Stream", fill=(255, 255, 255))
            elif body_t < 15.0:
                draw.text((cx - 95, cy - 80), "CHRONOLITH STORAGE", fill=(255, 215, 0))
                draw.text((cx - 155, cy - 30), "IndexedDB Vault & Zero-Loss Master Capture", fill=(255, 255, 255))
            elif body_t < 20.0:
                draw.text((cx - 110, cy - 80), "OBSIDIAN & FONTS FORGE", fill=(139, 92, 246))
                draw.text((cx - 165, cy - 30), "Cyberpunk Design System & Type Foundry", fill=(255, 255, 255))
            else:
                draw.text((cx - 100, cy - 80), "ICHIRO GAMING ENGINE", fill=(255, 51, 85))
                draw.text((cx - 170, cy - 30), "WebGPU Shader Pipeline & High-FPS Canvas", fill=(255, 255, 255))

        elif t < 38.0:
            # === 32.0s to 38.0s: FINAL LOGO OUTRO (6 FULL SECONDS STATIC DISPLAY) ===
            frame = bg_deep.copy()
            draw = ImageDraw.Draw(frame)

            for x in range(35, 1920, 70):
                for y in range(35, 1080, 70):
                    draw.rectangle([x-1, y-1, x+1, y+1], fill=(40, 55, 80))

            cx, cy = width // 2, height // 2 - 40
            r = 125
            draw.ellipse([cx-r, cy-r, cx+r, cy+r], fill=(12, 18, 32), outline=(255, 255, 255), width=4)
            
            if logo_img:
                l_size = 200
                resized_logo = logo_img.resize((l_size, l_size), Image.Resampling.LANCZOS)
                frame.paste(resized_logo, (cx - l_size//2, cy - l_size//2), resized_logo)
            
            draw.text((cx - 40, cy + 150), "ETHERNIUM", fill=(255, 255, 255))
            draw.text((cx - 130, cy + 180), "BUILT WITH SOVEREIGNTY // NULLA-LABS", fill=(0, 240, 255))
            draw.text((cx - 100, cy + 210), "github.com/NullaLabs", fill=(255, 215, 0))

        else:
            # === 38.0s to 40.0s: POST-ROLL BLACK SCREEN (2 FULL SECONDS POST-ROLL) ===
            frame = bg_black.copy()

        p1080.stdin.write(frame.tobytes())

        if frame_idx % 400 == 0:
            print(f'Piped frame {frame_idx}/{total_frames} ({(t):.1f}s)', flush=True)

    p1080.stdin.close()
    p1080.wait()
    print('[SUCCESS 1080p 40s BROADCAST MASTER]:', out_1080p, f'Size: {os.path.getsize(out_1080p)/(1024*1024):.2f} MB', flush=True)

    # 2. Scale to 4K UHD Master
    print('[2/2] Rendering 4K UHD 40s Broadcast Silent Master (3840x2160)...', flush=True)
    cmd_4k = [
        ffmpeg_exe, '-y',
        '-i', out_1080p,
        '-t', str(total_duration),
        '-vf', 'scale=3840:2160:force_original_aspect_ratio=decrease,pad=3840:2160:(ow-iw)/2:(oh-ih)/2,fps=60,format=yuv420p',
        '-fps_mode', 'cfr',
        '-an',
        '-c:v', 'libx264', '-profile:v', 'high', '-level', '5.1',
        '-preset', 'ultrafast', '-crf', '16', '-movflags', '+faststart',
        out_4k
    ]
    subprocess.run(cmd_4k, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    print('[SUCCESS 4K 40s BROADCAST MASTER]:', out_4k, f'Size: {os.path.getsize(out_4k)/(1024*1024):.2f} MB', flush=True)

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description="Render deterministic KAPTURA broadcast masters.")
    parser.add_argument("--output-dir")
    parser.add_argument("--logo")
    args = parser.parse_args()
    render_broadcast_master_v2(args.output_dir, args.logo)
