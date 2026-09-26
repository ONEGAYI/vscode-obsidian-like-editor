"""Build the 15 light/dark quick-action icons from one raster contact sheet.

Run: python scripts/quick-action-icons.py
Requires Pillow and the VTracer CLI (`vtracer` on PATH). SVG paths are traced
from the cropped PNG cells; they are not the drawing instructions below.
"""

from __future__ import annotations

import re
import subprocess
import xml.etree.ElementTree as ET
from pathlib import Path

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "media" / "quick-actions"
KEYS = (
    "bold", "italic", "strikethrough", "inlineCode", "heading",
    "bulletList", "orderedList", "taskList", "quote", "codeBlock",
    "link", "clearInline", "table", "inlineMath", "blockMath",
)
COLORS = {"light": (54, 60, 70), "dark": (210, 218, 229)}
CELL = 96
SCALE = 16  # Draw a 24-unit icon at 384 px, then reduce to 96 px.
INK = 255
STROKE = 2.0
SVG_NS = "http://www.w3.org/2000/svg"
VTRACER_VERSION = "0.6.5"
ET.register_namespace("", SVG_NS)


class Pen:
    def __init__(self) -> None:
        self.image = Image.new("L", (CELL * 4, CELL * 4), 0)
        self.draw = ImageDraw.Draw(self.image)

    @staticmethod
    def point(p: tuple[float, float]) -> tuple[int, int]:
        return round(p[0] * SCALE), round(p[1] * SCALE)

    def line(self, points: list[tuple[float, float]], width: float = STROKE) -> None:
        pixels = [self.point(p) for p in points]
        radius = width * SCALE / 2
        self.draw.line(pixels, fill=INK, width=round(width * SCALE), joint="curve")
        for x, y in (pixels[0], pixels[-1]):
            self.draw.ellipse((round(x - radius), round(y - radius), round(x + radius), round(y + radius)), fill=INK)

    def curve(self, p0: tuple[float, float], p1: tuple[float, float], p2: tuple[float, float], p3: tuple[float, float], width: float = STROKE) -> None:
        points = []
        for step in range(25):
            t = step / 24
            u = 1 - t
            points.append((
                u**3 * p0[0] + 3*u*u*t*p1[0] + 3*u*t*t*p2[0] + t**3*p3[0],
                u**3 * p0[1] + 3*u*u*t*p1[1] + 3*u*t*t*p2[1] + t**3*p3[1],
            ))
        self.line(points, width)

    def circle(self, x: float, y: float, radius: float) -> None:
        self.draw.ellipse((round((x-radius)*SCALE), round((y-radius)*SCALE),
                           round((x+radius)*SCALE), round((y+radius)*SCALE)), fill=INK)

    def rect(self, x0: float, y0: float, x1: float, y1: float, width: float = STROKE) -> None:
        self.line([(x0, y0), (x1, y0), (x1, y1), (x0, y1), (x0, y0)], width)

    def raster(self, rgb: tuple[int, int, int]) -> Image.Image:
        resample = getattr(Image, "Resampling", Image).LANCZOS
        reduced = self.image.resize((CELL, CELL), resample)
        # One opaque color gives VTracer a single contour layer per shape.
        alpha = reduced.point(lambda value: 255 if value >= 128 else 0)
        result = Image.new("RGBA", (CELL, CELL), rgb + (0,))
        result.putalpha(alpha)
        return result


def draw_icon(key: str, rgb: tuple[int, int, int]) -> Image.Image:
    p = Pen()
    if key == "bold":
        p.line([(7, 5), (7, 19)], 2.35)
        p.curve((7, 5), (17, 4), (18, 9), (12, 12), 2.35)
        p.line([(7, 12), (12, 12)], 2.35)
        p.curve((12, 12), (19, 11.5), (19, 20), (7, 19), 2.35)
    elif key == "italic":
        p.line([(9, 5), (19, 5)])
        p.line([(15.5, 5), (9, 19)], 2.2)
        p.line([(5, 19), (15, 19)])
    elif key == "strikethrough":
        p.curve((17, 6.5), (12, 3), (6.5, 5.5), (7, 9.2), 1.9)
        p.curve((7, 9.2), (7.5, 11.3), (16.5, 12), (17, 15), 1.9)
        p.curve((17, 15), (17.4, 19), (10.2, 21), (6.5, 17.5), 1.9)
        p.line([(4.5, 12), (19.5, 12)], 1.9)
    elif key == "inlineCode":
        p.line([(9.2, 7), (4.5, 12), (9.2, 17)])
        p.line([(14.2, 5.5), (10.5, 18.5)], 1.9)
        p.line([(15, 7), (19.5, 12), (15, 17)])
    elif key == "heading":
        p.line([(6, 5), (6, 19)], 2.2)
        p.line([(17, 5), (17, 19)], 2.2)
        p.line([(6, 12), (17, 12)], 2.2)
    elif key == "bulletList":
        for y in (6.5, 12, 17.5):
            p.circle(5.3, y, 1.25)
            p.line([(10, y), (20, y)], 1.9)
    elif key == "orderedList":
        p.line([(5.2, 5.4), (6.5, 4.9), (6.5, 8.4)], 1.45)
        p.curve((4.7, 11.2), (8.5, 9.2), (8.5, 12.6), (4.7, 14), 1.3)
        p.line([(4.7, 14), (8, 14)], 1.3)
        p.curve((4.7, 16.5), (8.4, 14.8), (8.8, 17.4), (6.2, 17.7), 1.25)
        p.curve((6.2, 17.7), (9.4, 17.7), (8.2, 20.1), (4.7, 19.2), 1.25)
        for y in (6.7, 12.3, 18):
            p.line([(11.5, y), (20, y)], 1.9)
    elif key == "taskList":
        p.rect(4.5, 5, 11.5, 12, 1.6)
        p.line([(6.2, 8.6), (8, 10.1), (10.7, 6.9)], 1.6)
        p.rect(4.5, 14, 11.5, 21, 1.6)
        p.line([(14.5, 8.5), (20, 8.5)], 1.9)
        p.line([(14.5, 17.5), (20, 17.5)], 1.9)
    elif key == "quote":
        for x in (8.1, 15.5):
            p.circle(x, 8.7, 2.5)
            p.curve((x+1.8, 10.4), (x+1, 14), (x-1.5, 15.2), (x-2.8, 15.2), 1.9)
    elif key == "codeBlock":
        p.curve((10, 4.8), (6.4, 4.8), (6.8, 7.7), (6.8, 9.7), 1.8)
        p.curve((6.8, 9.7), (6.8, 11.8), (5.7, 12), (4.7, 12), 1.8)
        p.curve((4.7, 12), (5.7, 12), (6.8, 12.2), (6.8, 14.3), 1.8)
        p.curve((6.8, 14.3), (6.8, 16.3), (6.4, 19.2), (10, 19.2), 1.8)
        p.curve((14, 4.8), (17.6, 4.8), (17.2, 7.7), (17.2, 9.7), 1.8)
        p.curve((17.2, 9.7), (17.2, 11.8), (18.3, 12), (19.3, 12), 1.8)
        p.curve((19.3, 12), (18.3, 12), (17.2, 12.2), (17.2, 14.3), 1.8)
        p.curve((17.2, 14.3), (17.2, 16.3), (17.6, 19.2), (14, 19.2), 1.8)
    elif key == "link":
        # Two slanted loops share the visual center at (12, 12).
        p.curve((10, 9), (12.5, 6.5), (16, 4), (19, 7), 2)
        p.curve((19, 7), (22, 10), (18, 13.5), (15.5, 15), 2)
        p.curve((14, 15), (11.5, 17.5), (8, 20), (5, 17), 2)
        p.curve((5, 17), (2, 14), (6, 10.5), (8.5, 9), 2)
        p.line([(9.3, 14.7), (14.7, 9.3)], 2.15)
    elif key == "clearInline":
        p.line([(4.5, 5.8), (15, 5.8)], 1.9)
        p.line([(9.75, 5.8), (9.75, 17.5)], 1.9)
        p.line([(14, 12), (19.5, 18)], 1.7)
        p.line([(19.5, 12), (14, 18)], 1.7)
        p.line([(4, 20), (20, 4)], 1.7)
    elif key == "table":
        p.rect(4, 5, 20, 19, 1.55)
        for x in (9.3, 14.7):
            p.line([(x, 5), (x, 19)], 1.45)
        for y in (9.7, 14.3):
            p.line([(4, y), (20, y)], 1.45)
    elif key == "inlineMath":
        p.line([(5.5, 10), (13, 18)], 2)
        p.line([(13, 10), (5.5, 18)], 2)
        p.curve((15, 6.5), (20.5, 4.2), (20, 8.3), (15.2, 10.8), 1.5)
        p.line([(15.2, 10.8), (20.4, 10.8)], 1.5)
    elif key == "blockMath":
        p.line([(18, 5), (6, 5), (12.5, 12), (6, 19), (18, 19)], 2)
    else:
        raise ValueError(f"Unknown icon: {key}")
    return p.raster(rgb)


def trace(png: Path, svg: Path) -> None:
    command = [
        "vtracer", "--input", str(png), "--output", str(svg),
        "--colormode", "color", "--mode", "spline",
        "--hierarchical", "cutout", "--filter_speckle", "1",
        "--color_precision", "8", "--path_precision", "3",
        "--segment_length", "4", "--corner_threshold", "60",
    ]
    subprocess.run(command, check=True, capture_output=True, text=True)
    tree = ET.parse(svg)
    root = tree.getroot()
    root.set("viewBox", f"0 0 {CELL} {CELL}")
    tree.write(svg, encoding="utf-8", xml_declaration=True)


def validate(png: Path, svg: Path, rgb: tuple[int, int, int]) -> None:
    with Image.open(png) as image:
        image.load()
        if image.size != (CELL, CELL) or image.mode != "RGBA":
            raise ValueError(f"Wrong PNG geometry or mode: {png}")
        alpha = image.getchannel("A")
        if alpha.getextrema() != (0, 255):
            raise ValueError(f"Missing transparency/ink: {png}")
        bounds = alpha.getbbox()
        if bounds is None or bounds[0] < 7 or bounds[1] < 7 or bounds[2] > 89 or bounds[3] > 89:
            raise ValueError(f"Icon exceeds common safe area: {png}: {bounds}")
        if any(pixel[:3] != rgb for pixel in image.getdata() if pixel[3]):
            raise ValueError(f"Unexpected PNG color: {png}")
    xml = ET.parse(svg).getroot()
    if xml.tag != f"{{{SVG_NS}}}svg" or xml.get("viewBox") != "0 0 96 96":
        raise ValueError(f"Wrong SVG viewport: {svg}")
    paths = xml.findall(f".//{{{SVG_NS}}}path")
    if not paths or any(not path.get("d") for path in paths):
        raise ValueError(f"SVG contains no trace paths: {svg}")
    if xml.findall(f".//{{{SVG_NS}}}image") or re.search(r"(?:data:image|base64|<image\b)", svg.read_text(encoding="utf-8"), re.I):
        raise ValueError(f"SVG embeds a bitmap: {svg}")


def build() -> None:
    version = subprocess.run(["vtracer", "--version"], check=True, capture_output=True, text=True).stdout
    if VTRACER_VERSION not in version:
        raise RuntimeError(f"Expected VTracer {VTRACER_VERSION}, got: {version.strip()}")
    ASSETS.mkdir(parents=True, exist_ok=True)
    sheet = Image.new("RGBA", (CELL * len(KEYS), CELL * len(COLORS)), (0, 0, 0, 0))
    for row, (theme, rgb) in enumerate(COLORS.items()):
        for col, key in enumerate(KEYS):
            sheet.paste(draw_icon(key, rgb), (col * CELL, row * CELL))
    sheet_path = ASSETS / "contact-sheet.png"
    sheet.save(sheet_path, optimize=True)

    # Reload the one saved master before cropping; output PNGs are literal cells.
    with Image.open(sheet_path) as master:
        for row, (theme, rgb) in enumerate(COLORS.items()):
            theme_dir = ASSETS / theme
            theme_dir.mkdir(exist_ok=True)
            for col, key in enumerate(KEYS):
                stem = f"{theme}-{key}"
                png = theme_dir / f"{stem}.png"
                svg = theme_dir / f"{stem}.svg"
                master.crop((col * CELL, row * CELL, (col + 1) * CELL, (row + 1) * CELL)).save(png, optimize=True)
                trace(png, svg)
                validate(png, svg, rgb)

    expected = {f"{theme}-{key}.{ext}" for theme in COLORS for key in KEYS for ext in ("png", "svg")}
    actual = {path.name for theme in COLORS for path in (ASSETS / theme).iterdir() if path.is_file()}
    if actual != expected:
        raise ValueError(f"Icon count/name mismatch. Missing={expected-actual}; extra={actual-expected}")
    print(f"Built {len(KEYS)} icons × {len(COLORS)} themes: {len(expected)//2} PNG + {len(expected)//2} SVG")
    print(f"Master: {sheet_path} ({sheet.width}x{sheet.height})")


if __name__ == "__main__":
    build()
