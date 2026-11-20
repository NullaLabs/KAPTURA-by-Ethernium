from __future__ import annotations

import argparse
import hashlib
from pathlib import Path
import zipfile


ROOT = Path(__file__).resolve().parents[1]
PACKAGE_FILES = (
    "KAPTURA.cmd",
    "index.html",
    "package.json",
    "README.md",
    "BENCHMARK_PROOF.md",
    "LAUNCH_KIT.md",
    "UPSKALETOR-HANDOFF.md",
    "CHANGELOG.md",
    "LICENSE",
    "VERSION",
    "requirements.txt",
    "convert_to_mp4.bat",
    "convert_webm_to_mp4.py",
    "scripts/setup-neural-engines.ps1",
    "scripts/benchmark_upskaletor.mjs",
)
PACKAGE_DIRS = (
    "css",
    "fonts",
    "js",
    "daemon",
)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def build(output_dir: Path) -> tuple[Path, Path]:
    version = (ROOT / "VERSION").read_text(encoding="utf-8").strip()
    if not version:
        raise SystemExit("VERSION cannot be empty")

    missing = [name for name in PACKAGE_FILES if not (ROOT / name).is_file()]
    missing_dirs = [name for name in PACKAGE_DIRS if not (ROOT / name).is_dir()]
    if missing or missing_dirs:
        raise SystemExit(f"Missing release assets: files={missing} dirs={missing_dirs}")

    output_dir.mkdir(parents=True, exist_ok=True)
    archive = output_dir / f"KAPTURA-by-Ethernium-v{version}.zip"
    prefix = f"KAPTURA-by-Ethernium-v{version}"
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as bundle:
        for name in PACKAGE_FILES:
            source = ROOT / name
            bundle.write(source, f"{prefix}/{name}")
        for dirname in PACKAGE_DIRS:
            for file_path in sorted((ROOT / dirname).rglob("*")):
                if file_path.is_file() and "__pycache__" not in file_path.parts:
                    rel = file_path.relative_to(ROOT).as_posix()
                    bundle.write(file_path, f"{prefix}/{rel}")

    checksum = archive.with_suffix(f"{archive.suffix}.sha256")
    checksum.write_text(f"{sha256(archive)}  {archive.name}\n", encoding="ascii")
    return archive, checksum


def main() -> None:
    parser = argparse.ArgumentParser(description="Build the portable KAPTURA release.")
    parser.add_argument("--output", type=Path, default=ROOT / "dist")
    args = parser.parse_args()
    archive, checksum = build(args.output.resolve())
    print(archive)
    print(checksum)


if __name__ == "__main__":
    main()
