"""
KAPTURA static product contract.

Guards the HONEST post-refactor promise: KAPTURA now performs REAL in-browser
transcoding, so the contract asserts that truth, forbids the old fake-progress
theater, enforces the modular architecture, and keeps the app local-first (no
external font CDN).

Run:  python tests/validate_kaptura.py
"""
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HTML = (ROOT / "index.html").read_text(encoding="utf-8")
README = (ROOT / "README.md").read_text(encoding="utf-8")


class ContractParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.ids: list[str] = []
        self.links: list[str] = []
        self.scripts: list[str] = []

    def handle_starttag(self, tag, attrs):
        values = dict(attrs)
        if values.get("id"):
            self.ids.append(values["id"])
        if tag == "a" and values.get("href"):
            self.links.append(values["href"])
        if tag == "script" and values.get("src"):
            self.scripts.append(values["src"])


def fail(msg: str):
    raise SystemExit("CONTRACT FAILED: " + msg)


parser = ContractParser()
parser.feed(HTML)

# --- unique ids -------------------------------------------------------------
dupes = sorted({i for i in parser.ids if parser.ids.count(i) > 1})
if dupes:
    fail(f"Duplicate HTML ids: {dupes}")

# --- required product tabs --------------------------------------------------
required_ids = {"tab-recorder", "tab-cinema", "tab-svg", "tab-vault", "tab-converter", "tab-upskaletor"}
missing = sorted(required_ids.difference(parser.ids))
if missing:
    fail(f"Missing product tabs: {missing}")

# --- UPSKALETOR public/private boundary -------------------------------------
if any("UPSKALETOR-by-Ethernium" in link for link in parser.links):
    fail("Public KAPTURA must not advertise a private UPSKALETOR URL")
if "optional private companion" not in " ".join(HTML.split()).lower():
    fail("UPSKALETOR private-companion boundary is required")

# --- honest product-boundary statements (the new truth) ---------------------
normalized = " ".join(HTML.split()).lower()
required_contract = [
    "kaptura is the visual capture studio",
    "upskaletor is the optional private processing engine",
    "real in-browser transcoding",
    "gif export uses a native javascript encoder",
]
for statement in required_contract:
    if statement not in normalized:
        fail(f"Missing product-boundary statement: {statement!r}")

# --- forbid the old fake-progress theater -----------------------------------
forbidden = [
    "Analizando flujo de fotogramas",          # old faked AI "analysis"
    "Preservando FPS nativos y empaquetando",  # old faked packaging step
    "120.0 FPS HARDWARE",                       # old hardcoded telemetry lie
    "Conversion Complete! Exporting video",     # old fake conversion claim
]
for bad in forbidden:
    if bad in HTML:
        fail(f"Reintroduced misleading/fake claim: {bad!r}")

# --- modular architecture (no monolith) -------------------------------------
required_modules = [
    "js/capabilities.js", "js/gif-encoder.js", "js/lanczos.js", "js/lanczos-gl.js",
    "js/scaler.js", "js/transcoder.js", "js/svg-vector.js", "js/upskaletor.js",
    "js/vault.js", "js/capture.js", "js/app.js",
]
for mod in required_modules:
    if not (ROOT / mod).exists():
        fail(f"Missing required module file: {mod}")
    if mod not in parser.scripts:
        fail(f"index.html does not load module: {mod}")

# index.html must NOT carry a big inline <script> (stay modular)
if "drawVisualGenetics" in HTML or HTML.count("function ") > 3:
    fail("index.html appears to contain inline logic; keep code in js/ modules")

# --- local-first: no external font/CDN dependency ---------------------------
if "fonts.googleapis.com" in HTML or "fonts.gstatic.com" in HTML:
    fail("External font CDN referenced; fonts must be self-hosted (local-first)")
if not (ROOT / "css" / "fonts.css").exists():
    fail("Missing self-hosted css/fonts.css")

# --- README documents the independent engine + real transcoding -------------
if "UPSKALETOR-by-Ethernium" not in README:
    fail("README must document the independent UPSKALETOR engine")
low = README.lower()
if "real" not in low or "transcod" not in low:
    fail("README must describe the real in-browser transcoding")

print("KAPTURA static product contract passed (honest real-transcode edition).")
