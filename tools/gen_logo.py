#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""The Lowtide logo: four small waves in the four track colours (blue, green, yellow, red),
tight together and low on black, with a small white sailboat outline facing left above them,
and a lowercase "lowtide" wordmark in the same geometric monoline style as the SLOOP wordmark.

  tools/gen_logo.py OUT.h          firmware boot splash (RLE, 16-colour palette, RGB565)
  tools/gen_logo.py --assets DIR   lowtide-logo.svg, lowtide-logo.png, lowtide-icon.svg/png, lowtide-splash.png

The mark is drawn in a 1600 x 1600 frame, measured off the approved reference
(black-4waves-boat-aligned.png): the waves run x 413..1187, a sine of amplitude 30 and
wavelength 315, centres 105 apart; the boat's left edge lines up with the waves' left edge
(x 413), its hull floats one wave-spacing above the top (blue) wave.
The banner (logo.png/svg) is the mark content on the left and the "lowtide" wordmark on
the right, the same lockup as the old SLOOP logo (icon left, wordmark right).
"""
import math
import sys
from pathlib import Path

from PIL import Image, ImageDraw

BLUE, GREEN, YELLOW, RED = (40, 124, 255), (30, 204, 112), (255, 198, 24), (255, 98, 26)
WHITE, BLACK = (242, 242, 242), (0, 0, 0)
HEX = lambda c: "#%02X%02X%02X" % c
WAVES = [BLUE, GREEN, YELLOW, RED]

# ---- the mark (units: the 1600 x 1600 reference frame) ---------------------------------------
MARK = 1600
WAVE_X0, WAVE_X1 = 413, 1187
WAVE_Y0, WAVE_DY = 1110, 105          # blue wave centre, spacing between wave centres
WAVE_AMP, WAVE_LAM, WAVE_PH = 30, 315, 414   # sine: crest at x 650 and x 965
WAVE_W = 50
BOAT_W = 20
# the sail, measured off the approved reference (boat bbox x 379..851, y 636..1036): the
# masthead (apex) at (615, 636), the jib foot at (492, 900) and the mainsail foot at
# (851, 930); the mast stands at x 617. The left edge bows in toward the mast and the
# right edge bows out, so the boat faces left (bow at x 413).
SAIL_APEX = (615, 636)
SAIL_L_EDGE = [(595, 700), (562, 800), (492, 900)]       # apex -> jib foot (left edge)
SAIL_R_FOOT = (851, 930)                                 # mainsail foot (right)
SAIL_R_EDGE = [(774, 900), (749, 800), (678, 700), (623, 640)]  # foot -> apex (right edge)
MAST_BOT = (617, 935)
HULL_BOW, HULL_STERN = (413, 955), (851, 930)
HULL_DEPTH = 85                       # how far the hull bottom dips below the deck


def wave_points(i, step=8):
    pts = []
    for x in range(WAVE_X0, WAVE_X1 + 1, step):
        y = WAVE_Y0 + i * WAVE_DY + WAVE_AMP * math.sin(2 * math.pi * (x - WAVE_PH) / WAVE_LAM)
        pts.append((x, y))
    return pts


def hull_points(n=28):
    """the hull bottom, stern -> bow: a smooth dip below the (slanted) deck line"""
    pts = []
    for j in range(n + 1):
        t = j / n
        x = HULL_STERN[0] - (HULL_STERN[0] - HULL_BOW[0]) * t
        deck = HULL_STERN[1] + (HULL_BOW[1] - HULL_STERN[1]) * t
        pts.append((x, deck + HULL_DEPTH * math.sin(math.pi * t)))
    return pts


def sail_outline():
    """the sail's outer boundary, apex -> left edge -> jib foot -> mainsail foot ->
    right edge -> apex (a closed outline, drawn as a stroke)"""
    return [SAIL_APEX] + SAIL_L_EDGE + [SAIL_R_FOOT] + SAIL_R_EDGE


def _scale(pts, ox, oy, k):
    return [(ox + x * k, oy + y * k) for x, y in pts]


def draw_mark(d, ox, oy, k):
    """the mark: four coloured waves + white boat outline. (ox, oy) is the top-left of the
    1600-frame, k its scale."""
    for i, c in enumerate(WAVES):
        d.line(_scale(wave_points(i), ox, oy, k), fill=c, width=max(1, round(WAVE_W * k)),
               joint="curve")
    bw = max(1, round(BOAT_W * k))
    sail = _scale(sail_outline() + [SAIL_APEX], ox, oy, k)
    d.line(sail, fill=WHITE, width=bw, joint="curve")
    d.line(_scale([SAIL_APEX, MAST_BOT], ox, oy, k), fill=WHITE, width=bw)
    hull = _scale([HULL_BOW, HULL_STERN] + hull_points(), ox, oy, k)
    d.line(hull, fill=WHITE, width=bw, joint="curve")


def render_mark(W, H, ss=4):
    im = Image.new("RGB", (W * ss, H * ss), BLACK)
    d = ImageDraw.Draw(im)
    draw_mark(d, 0, 0, (W / MARK) * ss)
    return im.resize((W, H), Image.LANCZOS)


# the mark's content (boat + waves) in the 1600-frame, for fitting the splash
CONTENT = (413, 636, 1187, 1475)      # x0, y0, x1, y1


def render_splash(W, H, ss=4):
    x0, y0, x1, y1 = CONTENT
    cw, ch = x1 - x0, y1 - y0
    s = min(W / cw, H / ch)
    ox = (W - cw * s) / 2 - x0 * s
    oy = (H - ch * s) / 2 - y0 * s
    im = Image.new("RGB", (W * ss, H * ss), BLACK)
    d = ImageDraw.Draw(im)
    draw_mark(d, ox * ss, oy * ss, s * ss)
    return im.resize((W, H), Image.LANCZOS)


# ---- the "lowtide" wordmark (geometric monoline, same style as the SLOOP wordmark) ---------
# Local coordinates: baseline y=0, x-height y=-72..0, ascender top y=-104, stroke 12.
# Each letter: (cell advance, [strokes]); a stroke is ("line", [(x,y),...]) a polyline,
# ("circle", (cx,cy,r)) a stroked ring, or ("dot", (cx,cy,r)) a filled disc.
WORD = [
    (40, [("line", [(20, -104), (20, 0)])]),                                     # l
    (90, [("circle", (45, -36, 30))]),                                            # o
    (110, [("line", [(10, -72), (32, 0), (55, -72), (78, 0), (100, -72)])]),     # w
    (70, [("line", [(35, -104), (35, 0)]), ("line", [(10, -58), (60, -58)])]),   # t
    (40, [("line", [(20, -72), (20, 0)]), ("dot", (20, -88, 6))]),               # i
    (100, [("circle", (40, -36, 30)), ("line", [(70, -104), (70, 0)])]),         # d
    (90, [("circle", (45, -36, 30)), ("line", [(15, -36), (75, -36)])]),         # e
]
WORD_ADVANCE = sum(a for a, _ in WORD)   # 540
WORD_STROKE = 12


def _wm_map(stroke, x0, y0, k):
    """map a wordmark stroke from local units into the target frame: (x0, y0) is the
    start of the baseline, k the scale."""
    kind, data = stroke
    if kind == "line":
        return ("line", [(x0 + x * k, y0 + y * k) for x, y in data])
    if kind in ("circle", "dot"):
        cx, cy, r = data
        return (kind, (x0 + cx * k, y0 + cy * k, r * k))
    raise ValueError(kind)


def draw_wordmark(d, x0, y0, k):
    """draw "lowtide" with (x0, y0) at the start of the baseline, k the scale from local
    units. Round caps: a filled disc at each open polyline end."""
    w = max(1, round(WORD_STROKE * k))
    x = x0
    for advance, strokes in WORD:
        for stroke in strokes:
            kind, data = _wm_map(stroke, x, y0, k)
            if kind == "line":
                d.line(data, fill=WHITE, width=w, joint="curve")
                for px, py in (data[0], data[-1]):
                    d.ellipse([px - w / 2, py - w / 2, px + w / 2, py + w / 2], fill=WHITE)
            elif kind == "circle":
                cx, cy, r = data
                d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=WHITE, width=w)
            elif kind == "dot":
                cx, cy, r = data
                d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=WHITE)
        x += advance * k


def svg_wordmark_elements(x0, y0, k):
    """the wordmark as SVG elements, same geometry as draw_wordmark"""
    w = WORD_STROKE * k
    els = []
    x = x0
    for advance, strokes in WORD:
        for stroke in strokes:
            kind, data = _wm_map(stroke, x, y0, k)
            if kind == "line":
                pts = " ".join(f"{px:.1f},{py:.1f}" for px, py in data)
                els.append(f'<polyline points="{pts}" fill="none" stroke="{HEX(WHITE)}" '
                           f'stroke-width="{w:.1f}" stroke-linecap="round" stroke-linejoin="round"/>')
            elif kind == "circle":
                cx, cy, r = data
                els.append(f'<circle cx="{cx:.1f}" cy="{cy:.1f}" r="{r:.1f}" fill="none" '
                           f'stroke="{HEX(WHITE)}" stroke-width="{w:.1f}"/>')
            elif kind == "dot":
                cx, cy, r = data
                els.append(f'<circle cx="{cx:.1f}" cy="{cy:.1f}" r="{r:.1f}" fill="{HEX(WHITE)}"/>')
        x += advance * k
    return els


# ---- the banner (mark + wordmark) ------------------------------------------------------------
# The mark's strokes extend past its content box by half a stroke (25 for the waves),
# so the banner has a uniform margin around the spec layout (mark content 774x839,
# gap 120, wordmark 540 local units at x-height 240) to keep nothing clipped.
BANNER_MARGIN = 30
BANNER_W, BANNER_H = 2700 + 2 * BANNER_MARGIN, 839 + 2 * BANNER_MARGIN   # 2760 x 899
BANNER_MARK_W = CONTENT[2] - CONTENT[0]      # 774, the mark content width
BANNER_GAP = 120
BANNER_WORD_X = BANNER_MARGIN + BANNER_MARK_W + BANNER_GAP   # 924, wordmark start
BANNER_WORD_BASE = BANNER_MARGIN + 1200 - CONTENT[1]         # 594, wordmark baseline
BANNER_WORD_K = 240 / 72                     # 10/3, wordmark scale (x-height 240)


def draw_banner(d, ox, oy, s):
    """the banner: mark content at (ox+margin, oy+margin), wordmark to its right.
    s = banner units scale."""
    draw_mark(d, ox + (BANNER_MARGIN - CONTENT[0]) * s, oy + (BANNER_MARGIN - CONTENT[1]) * s, s)
    draw_wordmark(d, ox + BANNER_WORD_X * s, oy + BANNER_WORD_BASE * s, BANNER_WORD_K * s)


def render_banner(W, H, ss=4):
    im = Image.new("RGB", (W * ss, H * ss), BLACK)
    d = ImageDraw.Draw(im)
    draw_banner(d, 0, 0, (W / BANNER_W) * ss)
    return im.resize((W, H), Image.LANCZOS)


# ---- SVG (stroke centred on the path) ---------------------------------------------------------
def _pts(pts):
    return " ".join(f"{x:.1f},{y:.1f}" for x, y in pts)


def svg_mark_elements():
    """the mark as SVG elements, in the 1600-frame"""
    els = []
    for i, c in enumerate(WAVES):
        pts = wave_points(i)
        d = "M" + " L".join(f"{x:.1f} {y:.1f}" for x, y in pts)
        els.append(f'<path d="{d}" fill="none" stroke="{HEX(c)}" stroke-width="{WAVE_W}" '
                   f'stroke-linecap="round" stroke-linejoin="round"/>')
    pts = sail_outline()
    d = "M" + " L".join(f"{x:.1f} {y:.1f}" for x, y in pts) + " Z"
    els.append(f'<path d="{d}" fill="none" stroke="{HEX(WHITE)}" '
               f'stroke-width="{BOAT_W}" stroke-linejoin="round"/>')
    els.append(f'<line x1="{SAIL_APEX[0]}" y1="{SAIL_APEX[1]}" x2="{MAST_BOT[0]}" y2="{MAST_BOT[1]}" '
               f'stroke="{HEX(WHITE)}" stroke-width="{BOAT_W}" stroke-linecap="round"/>')
    hull = [HULL_BOW, HULL_STERN] + hull_points()
    d = "M" + " L".join(f"{x:.1f} {y:.1f}" for x, y in hull) + " Z"
    els.append(f'<path d="{d}" fill="none" stroke="{HEX(WHITE)}" stroke-width="{BOAT_W}" '
               f'stroke-linejoin="round"/>')
    return els


def svg_mark():
    body = [f'<rect width="{MARK}" height="{MARK}" fill="#000"/>'] + svg_mark_elements()
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {MARK} {MARK}" '
            f'width="{MARK}" height="{MARK}" role="img" aria-label="Lowtide">\n' +
            "\n".join(body) + "\n</svg>\n")


def svg_banner(bg=True):
    """the banner: mark content on the left, "lowtide" wordmark on the right.
    bg=False leaves the background transparent (for inlining on a dark page)."""
    body = []
    if bg:
        body.append(f'<rect width="{BANNER_W}" height="{BANNER_H}" fill="#000"/>')
    body.append(f'<g transform="translate({BANNER_MARGIN - CONTENT[0]} {BANNER_MARGIN - CONTENT[1]})">')
    body.extend(svg_mark_elements())
    body.append('</g>')
    body.extend(svg_wordmark_elements(BANNER_WORD_X, BANNER_WORD_BASE, BANNER_WORD_K))
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {BANNER_W} {BANNER_H}" '
            f'width="{BANNER_W}" height="{BANNER_H}" role="img" aria-label="Lowtide">\n' +
            "\n".join(body) + "\n</svg>\n")


# ---- firmware splash ---------------------------------------------------------------------------
SPLASH_W, SPLASH_H = 240, 188


def rgb565(c):
    r, g, b = c
    return ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3)


def splash_header(path):
    im = render_splash(SPLASH_W, SPLASH_H)
    # a fixed palette: black, and each logo colour at 1/3, 2/3 and full (the anti-aliased edges)
    cols = [BLACK]
    for c in (WHITE, BLUE, GREEN, YELLOW, RED):
        cols += [tuple(round(v * f) for v in c) for f in (1 / 3, 2 / 3, 1.0)]
    src = im.tobytes()
    px = []
    cache = {}
    for i in range(0, len(src), 3):
        p = (src[i], src[i + 1], src[i + 2])
        if p not in cache:
            cache[p] = min(range(16), key=lambda k: sum((p[j] - cols[k][j]) ** 2 for j in range(3)))
        px.append(cache[p])
    rle = bytearray()                                 # (run - 1) << 4 | index, runs of 1..16
    i = 0
    while i < len(px):
        j = i
        while j < len(px) and px[j] == px[i] and j - i < 16:
            j += 1
        rle.append(((j - i - 1) << 4) | px[i])
        i = j
    L = ["/* generated by tools/gen_logo.py: the Lowtide boot splash */", "#pragma once", "#include <stdint.h>",
         f"#define SLOOP_SPLASH_W {SPLASH_W}", f"#define SLOOP_SPLASH_H {SPLASH_H}",
         "static const uint16_t SLOOP_SPLASH_PAL[16] = {" + ", ".join(f"0x{rgb565(c):04X}" for c in cols) + "};",
         f"static const uint8_t SLOOP_SPLASH_RLE[{len(rle)}] = {{"]
    for k in range(0, len(rle), 24):
        L.append("    " + ", ".join(str(b) for b in rle[k:k + 24]) + ",")
    L.append("};")
    Path(path).write_text("\n".join(L) + "\n")
    print(f"logo: splash {SPLASH_W}x{SPLASH_H}, {len(rle)} B RLE -> {path}")


def assets(out):
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    (out / "lowtide-logo.svg").write_text(svg_banner())
    (out / "lowtide-icon.svg").write_text(svg_mark())
    render_banner(BANNER_W, BANNER_H).save(out / "lowtide-logo.png")
    render_mark(512, 512).save(out / "lowtide-icon.png")
    render_splash(SPLASH_W, SPLASH_H).resize((SPLASH_W * 2, SPLASH_H * 2), Image.NEAREST).save(out / "lowtide-splash.png")
    print(f"logo: assets in {out}")


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--assets":
        assets(sys.argv[2])
    elif len(sys.argv) == 2:
        splash_header(sys.argv[1])
    else:
        sys.exit(__doc__)
