# The Whimsy app icon set: the glossy balloon (default) and friends.
# Writes one 1024px SVG per icon (macOS grid: 824px body in 1024).
# Render with build.sh, which also installs the PNGs into the app.
import math
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "explore"))
from explore import COLORWAYS  # noqa: E402

# id: (display name, background, mark)
ICONS = {}

BODY = ("M 512 214 C 664 214 736 326 726 430 C 714 562 604 644 512 654 "
        "C 420 644 310 562 298 430 C 288 326 360 214 512 214 Z")


def background(kind):
    """Body fill layers. kind is a colorway name, 'light' or 'dark'."""
    if kind == "light":
        return '''
    <linearGradient id="base" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#e9e9f0"/>
    </linearGradient>''', ['url(#base)']
    if kind == "dark":
        return '''
    <linearGradient id="base" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#3a3a3f"/><stop offset="1" stop-color="#121214"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.42" r="0.45">
      <stop offset="0" stop-color="#ff4fa3" stop-opacity=".35"/><stop offset="1" stop-color="#ff4fa3" stop-opacity="0"/>
    </radialGradient>''', ['url(#base)', 'url(#glow)']
    a, b, tl, br, mid = COLORWAYS[kind]
    return f'''
    <linearGradient id="base" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="{a}"/><stop offset="1" stop-color="{b}"/>
    </linearGradient>
    <radialGradient id="g1" cx="0.18" cy="0.12" r="0.62">
      <stop offset="0" stop-color="{tl}" stop-opacity=".95"/><stop offset="1" stop-color="{tl}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="g2" cx="0.9" cy="0.92" r="0.66">
      <stop offset="0" stop-color="{br}" stop-opacity=".95"/><stop offset="1" stop-color="{br}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="g3" cx="0.78" cy="0.22" r="0.42">
      <stop offset="0" stop-color="{mid}" stop-opacity=".7"/><stop offset="1" stop-color="{mid}" stop-opacity="0"/>
    </radialGradient>''', ['url(#base)', 'url(#g1)', 'url(#g2)', 'url(#g3)']


def frame(kind, mark, defs=""):
    bg_defs, fills = background(kind)
    gloss = ".10" if kind == "dark" else ".28"
    rim = ".10" if kind in ("light", "dark") else ".18"
    rim_color = "#000" if kind == "light" else "#fff"
    layers = "\n    ".join(f'<rect width="1024" height="1024" fill="{f}"/>' for f in fills)
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>{bg_defs}
    <linearGradient id="gloss" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fff" stop-opacity="{gloss}"/><stop offset=".45" stop-color="#fff" stop-opacity="0"/>
    </linearGradient>
    <filter id="drop" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="18"/></filter>
    <filter id="soft" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="22"/></filter>
    <filter id="blur6" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="6"/></filter>
    <clipPath id="body"><rect x="100" y="100" width="824" height="824" rx="185"/></clipPath>
    {defs}
  </defs>
  <rect x="100" y="112" width="824" height="824" rx="185" fill="#000" opacity=".28" filter="url(#drop)"/>
  <g clip-path="url(#body)">
    {layers}
    <rect x="100" y="100" width="824" height="824" fill="url(#gloss)"/>
{mark}
  </g>
  <rect x="100.5" y="100.5" width="823" height="823" rx="185" fill="none" stroke="{rim_color}" stroke-opacity="{rim}" stroke-width="2"/>
</svg>
'''


def balloon(light, mid, deep, knot, string, glow=None):
    """A glossy latex balloon. light/mid/deep: body gradient stops."""
    glow_el = (f'<path d="{BODY}" fill="{glow}" opacity=".55" filter="url(#soft)" transform="translate(0 10)"/>'
               if glow else "")
    defs = f'''
    <radialGradient id="bal" cx=".36" cy=".30" r=".78">
      <stop offset="0" stop-color="{light}"/><stop offset=".5" stop-color="{mid}"/><stop offset="1" stop-color="{deep}"/>
    </radialGradient>
    <radialGradient id="rimShade" cx=".45" cy=".40" r=".62">
      <stop offset=".7" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".22"/>
    </radialGradient>
    <linearGradient id="spec" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fff" stop-opacity=".95"/><stop offset="1" stop-color="#fff" stop-opacity=".15"/>
    </linearGradient>
    <clipPath id="balClip"><path d="{BODY}"/></clipPath>'''
    mark = f'''
    {glow_el}
    <path d="{BODY}" fill="#000" opacity=".22" filter="url(#soft)" transform="translate(14 30)"/>
    <path d="M 512 690 C 474 730 552 760 518 800 C 484 840 536 868 510 900" fill="none" stroke="#000" stroke-opacity=".12" stroke-width="12" stroke-linecap="round" transform="translate(6 8)"/>
    <path d="M 512 690 C 474 730 552 760 518 800 C 484 840 536 868 510 900" fill="none" stroke="{string}" stroke-width="12" stroke-linecap="round"/>
    <path d="M 512 650 C 500 668 486 682 484 690 C 498 696 526 696 540 690 C 538 682 524 668 512 650 Z" fill="{knot}"/>
    <path d="{BODY}" fill="url(#bal)"/>
    <g clip-path="url(#balClip)">
      <rect x="280" y="200" width="470" height="470" fill="url(#rimShade)"/>
      <path d="M 640 600 C 700 540 724 470 716 420" fill="none" stroke="#fff" stroke-opacity=".35" stroke-width="18" stroke-linecap="round" filter="url(#blur6)"/>
    </g>
    <ellipse cx="410" cy="338" rx="44" ry="86" transform="rotate(28 410 338)" fill="url(#spec)" filter="url(#blur6)"/>
    <ellipse cx="406" cy="322" rx="20" ry="40" transform="rotate(28 406 322)" fill="#fff" opacity=".9"/>
    <circle cx="452" cy="440" r="10" fill="#fff" opacity=".55"/>'''
    return defs, mark


def add(id_, name, kind, parts):
    defs, mark = parts
    ICONS[id_] = (name, frame(kind, mark, defs))


# The default: a pink glossy balloon on cream.
add("daydream", "Daydream", "cream",
    balloon("#ffc2e2", "#ff4fa3", "#7a5cff", "#c03d9e", "#c03d9e"))

# Day & Night: Apple-style light and dark pair (the app swaps them with the system).
add("day-and-night-light", "Day & Night (light)", "light",
    balloon("#ffc2e2", "#ff4fa3", "#7a5cff", "#c03d9e", "#b9b9c4"))
add("day-and-night-dark", "Day & Night (dark)", "dark",
    balloon("#ffd1ea", "#ff5fb0", "#8a6cff", "#d04fae", "#5a5a66", glow="#ff4fa3"))

# Pearl balloons on each gradient.
PEARL = {
    "cotton-candy": ("Cotton Candy", "candy", "#ffd6ee", "#a58bff"),
    "golden-hour": ("Golden Hour", "sunset", "#ffdcc4", "#ff7a9a"),
    "lagoon": ("Lagoon", "lagoon", "#d2fff3", "#7fa4ff"),
    "berry-jam": ("Berry Jam", "berry", "#efd6ff", "#ff7fb0"),
    "lemonade": ("Lemonade", "citrus", "#fff3c2", "#ff8f9a"),
    "stargazer": ("Stargazer", "night", "#e0deff", "#78c4ff"),
    "spearmint": ("Spearmint", "mint", "#d4ffee", "#86a8ff"),
}
for id_, (name, cw, mid, deep) in PEARL.items():
    add(id_, name, cw, balloon("#ffffff", mid, deep, "#ffffff", "#ffffff"))


# Sugar Rush: a polished swirl lollipop.
def lollipop():
    cx, cy, R = 512, 430, 222
    k = 15.0
    bands = ["#ff4fa3", "#ffd93d", "#38d6ff"]
    paths = []
    for j, color in enumerate(bands):
        pts = []
        off = j * 2 * math.pi / 3
        for i in range(0, 1200):
            t = i / 1200 * 16.5
            r = k * t
            pts.append(f"{cx + r*math.cos(t + off):.1f} {cy + r*math.sin(t + off):.1f}")
        paths.append(f'<path d="M {" L ".join(pts)}" fill="none" stroke="{color}" stroke-width="{2*math.pi*k/3 + 1:.1f}"/>')
    defs = f'''
    <clipPath id="disc"><circle cx="{cx}" cy="{cy}" r="{R}"/></clipPath>
    <radialGradient id="sphere" cx=".38" cy=".32" r=".75">
      <stop offset="0" stop-color="#fff" stop-opacity=".35"/><stop offset=".55" stop-color="#fff" stop-opacity="0"/>
      <stop offset="1" stop-color="#3a0a4a" stop-opacity=".35"/>
    </radialGradient>
    <linearGradient id="stick" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#ffffff"/><stop offset=".6" stop-color="#f1eef6"/><stop offset="1" stop-color="#cfc8db"/>
    </linearGradient>'''
    mark = f'''
    <rect x="490" y="560" width="44" height="330" rx="22" fill="#000" opacity=".18" filter="url(#blur6)" transform="translate(8 10)"/>
    <rect x="490" y="560" width="44" height="330" rx="22" fill="url(#stick)"/>
    <circle cx="{cx}" cy="{cy}" r="{R}" fill="#000" opacity=".25" filter="url(#soft)" transform="translate(14 30)"/>
    <circle cx="{cx}" cy="{cy}" r="{R}" fill="#fff"/>
    <g clip-path="url(#disc)">{"".join(paths)}<circle cx="{cx}" cy="{cy}" r="34" fill="#fff"/></g>
    <circle cx="{cx}" cy="{cy}" r="{R}" fill="url(#sphere)"/>
    <circle cx="{cx}" cy="{cy}" r="{R - 6}" fill="none" stroke="#fff" stroke-opacity=".7" stroke-width="12"/>
    <path d="M 360 330 A 180 180 0 0 1 470 250" fill="none" stroke="#fff" stroke-width="30" stroke-linecap="round" opacity=".85" filter="url(#blur6)"/>
    <circle cx="372" cy="380" r="13" fill="#fff" opacity=".8"/>'''
    return defs, mark


add("sugar-rush", "Sugar Rush", "lagoon", lollipop())


# Party Popper: a polished party hat with a pom-pom and confetti.
def party_hat():
    cone = "M 512 250 L 700 760 C 610 800 414 800 324 760 Z"
    stripes = "".join(
        f'<path d="M {200 + i*120} 900 L {420 + i*120} 200 L {470 + i*120} 200 L {250 + i*120} 900 Z" fill="{c}"/>'
        for i, c in enumerate(["#ffd93d", "#ffffff", "#ffd93d", "#ffffff", "#ffd93d"]))
    conf = ""
    pieces = [(270, 300, "#ffd93d", 30), (760, 280, "#38d6ff", -20), (300, 520, "#2fe0a0", 50),
              (770, 480, "#ff9a3d", 15), (690, 180, "#ff7ad9", 70), (240, 680, "#38d6ff", -40),
              (800, 660, "#ffd93d", 35)]
    for x, y, c, rot in pieces:
        conf += (f'<g transform="rotate({rot} {x} {y})"><rect x="{x-22}" y="{y-9}" width="44" height="18" rx="9" '
                 f'fill="#000" opacity=".18" transform="translate(4 6)"/>'
                 f'<rect x="{x-22}" y="{y-9}" width="44" height="18" rx="9" fill="{c}"/></g>')
    for x, y, c in [(380, 200, "#fff"), (650, 330, "#ffd93d"), (230, 420, "#ff7ad9"), (820, 380, "#fff")]:
        conf += f'<circle cx="{x}" cy="{y}" r="12" fill="{c}"/>'
    conf += '<path d="M 600 140 C 620 160 600 180 620 200 C 640 220 620 240 640 260" fill="none" stroke="#2fe0a0" stroke-width="12" stroke-linecap="round"/>'
    pom = "".join(
        f'<circle cx="{512 + 30*math.cos(a):.0f}" cy="{236 + 30*math.sin(a):.0f}" r="34" fill="url(#pom)"/>'
        for a in [i * math.pi / 3 for i in range(6)])
    defs = f'''
    <clipPath id="cone"><path d="{cone}"/></clipPath>
    <linearGradient id="coneFill" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#ff4fa3"/><stop offset="1" stop-color="#7a5cff"/>
    </linearGradient>
    <linearGradient id="coneShade" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#fff" stop-opacity=".25"/><stop offset=".45" stop-color="#fff" stop-opacity="0"/>
      <stop offset="1" stop-color="#1c0a3a" stop-opacity=".4"/>
    </linearGradient>
    <radialGradient id="pom" cx=".4" cy=".35" r=".7">
      <stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#ffe0f0"/>
    </radialGradient>'''
    mark = f'''
    {conf}
    <path d="{cone}" fill="#000" opacity=".28" filter="url(#soft)" transform="translate(14 30)"/>
    <path d="{cone}" fill="url(#coneFill)"/>
    <g clip-path="url(#cone)" opacity=".9">{stripes}</g>
    <path d="{cone}" fill="url(#coneShade)"/>
    <path d="M 324 760 C 414 800 610 800 700 760" fill="none" stroke="#fff" stroke-width="28" stroke-linecap="round"/>
    <circle cx="512" cy="236" r="62" fill="#000" opacity=".2" filter="url(#blur6)" transform="translate(6 10)"/>
    {pom}<circle cx="512" cy="236" r="40" fill="url(#pom)"/>'''
    return defs, mark


add("party-popper", "Party Popper", "night", party_hat())

if __name__ == "__main__":
    out = os.path.dirname(os.path.abspath(__file__))
    for id_, (name, svg) in ICONS.items():
        open(os.path.join(out, f"{id_}.svg"), "w").write(svg)
    print(len(ICONS), "icons")
