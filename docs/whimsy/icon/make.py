# Whimsy icon: a bouncy hand-drawn "w" with a sparkle, on layered gradients.
# Writes one SVG per colorway, in desktop (macOS grid, 824px body in 1024)
# and mobile (full-bleed) layouts.
import sys

COLORWAYS = {
    # name: (base from, base to, glow top-left, glow bottom-right, glow mid)
    "candy":  ("#ff4fa3", "#7a5cff", "#ffc75f", "#38d6ff", "#ff7ad9"),
    "sunset": ("#ff6a3d", "#d6297a", "#ffd25f", "#8a3dff", "#ff9a3d"),
    "lagoon": ("#14c4b8", "#3d5cff", "#b6ff7a", "#a24dff", "#3dd9ff"),
    "berry":  ("#8a2be2", "#ff3d7f", "#ff9ee0", "#3d7bff", "#c54dff"),
    "citrus": ("#ffb21f", "#ff4f6d", "#fff36b", "#ff3dbb", "#ffd93d"),
    "night":  ("#1c1450", "#5a2fd6", "#ff5fa8", "#2fd3ff", "#6a3dff"),
}

# The "w": one stroke, two rounded bowls and a flick, in a 1024 box.
W = ("M 268 418 C 286 560 318 690 384 690 C 448 690 470 560 512 470 "
     "C 554 560 576 690 640 690 C 706 690 738 560 742 470 "
     "C 744 420 770 392 800 392")
# A four-point sparkle above the flick.
def sparkle(cx, cy, r):
    k = r * 0.22
    return (f"M {cx} {cy-r} C {cx+k} {cy-k} {cx+k} {cy-k} {cx+r} {cy} "
            f"C {cx+k} {cy+k} {cx+k} {cy+k} {cx} {cy+r} "
            f"C {cx-k} {cy+k} {cx-k} {cy+k} {cx-r} {cy} "
            f"C {cx-k} {cy-k} {cx-k} {cy-k} {cx} {cy-r} Z")

def svg(name, layout):
    a, b, tl, br, mid = COLORWAYS[name]
    if layout == "desktop":
        x, size, rx = 100, 824, 185
        inner = 'transform="translate(100 100) scale(0.8046875)"'
        shadow = ('<rect x="100" y="112" width="824" height="824" rx="185" '
                  'fill="#000" opacity=".28" filter="url(#drop)"/>')
    else:
        x, size, rx = 0, 1024, 0
        inner = ''
        shadow = ''
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
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
    </radialGradient>
    <linearGradient id="gloss" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fff" stop-opacity=".28"/><stop offset=".45" stop-color="#fff" stop-opacity="0"/>
    </linearGradient>
    <filter id="drop" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="18"/></filter>
    <filter id="markShadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="14" stdDeviation="16" flood-color="#000" flood-opacity=".22"/>
    </filter>
    <clipPath id="body"><rect x="{x}" y="{x}" width="{size}" height="{size}" rx="{rx}"/></clipPath>
  </defs>
  {shadow}
  <g clip-path="url(#body)">
    <rect width="1024" height="1024" fill="url(#base)"/>
    <rect width="1024" height="1024" fill="url(#g1)"/>
    <rect width="1024" height="1024" fill="url(#g2)"/>
    <rect width="1024" height="1024" fill="url(#g3)"/>
    <rect x="{x}" y="{x}" width="{size}" height="{size}" fill="url(#gloss)"/>
    <g {inner} filter="url(#markShadow)">
      <path d="{W}" fill="none" stroke="#fff" stroke-width="78" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="{sparkle(812, 262, 62)}" fill="#fff"/>
      <circle cx="716" cy="300" r="15" fill="#fff" opacity=".9"/>
    </g>
  </g>
  {'<rect x="100.5" y="100.5" width="823" height="823" rx="185" fill="none" stroke="#fff" stroke-opacity=".18" stroke-width="2"/>' if layout=="desktop" else ''}
</svg>
'''

for name in COLORWAYS:
    for layout in ("desktop", "mobile"):
        open(f"whimsy-{name}-{layout}.svg", "w").write(svg(name, layout))
print("ok")
