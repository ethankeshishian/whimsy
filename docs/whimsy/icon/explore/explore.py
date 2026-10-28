# Whimsy icon exploration: many "whimsical object" marks on the same
# macOS-grid body and layered gradients as ../make.py. One SVG per concept.
# Render: for f in *.svg; do rsvg-convert -w 512 "$f" -o "${f%.svg}.png"; done
import math

COLORWAYS = {
    "candy":  ("#ff4fa3", "#7a5cff", "#ffc75f", "#38d6ff", "#ff7ad9"),
    "sunset": ("#ff6a3d", "#d6297a", "#ffd25f", "#8a3dff", "#ff9a3d"),
    "lagoon": ("#14c4b8", "#3d5cff", "#b6ff7a", "#a24dff", "#3dd9ff"),
    "berry":  ("#8a2be2", "#ff3d7f", "#ff9ee0", "#3d7bff", "#c54dff"),
    "citrus": ("#ffb21f", "#ff4f6d", "#fff36b", "#ff3dbb", "#ffd93d"),
    "night":  ("#1c1450", "#5a2fd6", "#ff5fa8", "#2fd3ff", "#6a3dff"),
    "mint":   ("#2fe0a0", "#2f7bff", "#fff59e", "#ff7ad9", "#7affd6"),
    "cream":  ("#fff3e0", "#ffd9ec", "#ffffff", "#c9e8ff", "#fff0b3"),
}

W = "#fff"


def frame(colorway, mark, defs=""):
    a, b, tl, br, mid = COLORWAYS[colorway]
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
    <filter id="ms" x="-30%" y="-30%" width="160%" height="160%">
      <feDropShadow dx="0" dy="14" stdDeviation="16" flood-color="#000" flood-opacity=".22"/>
    </filter>
    <clipPath id="body"><rect x="100" y="100" width="824" height="824" rx="185"/></clipPath>
    {defs}
  </defs>
  <rect x="100" y="112" width="824" height="824" rx="185" fill="#000" opacity=".28" filter="url(#drop)"/>
  <g clip-path="url(#body)">
    <rect width="1024" height="1024" fill="url(#base)"/>
    <rect width="1024" height="1024" fill="url(#g1)"/>
    <rect width="1024" height="1024" fill="url(#g2)"/>
    <rect width="1024" height="1024" fill="url(#g3)"/>
    <rect x="100" y="100" width="824" height="824" fill="url(#gloss)"/>
    <g filter="url(#ms)">
{mark}
    </g>
  </g>
  <rect x="100.5" y="100.5" width="823" height="823" rx="185" fill="none" stroke="#fff" stroke-opacity=".18" stroke-width="2"/>
</svg>
'''


def sparkle(cx, cy, r, fill=W, op=1):
    k = r * 0.22
    return (f'<path fill="{fill}" opacity="{op}" d="M {cx} {cy-r} C {cx+k} {cy-k} {cx+k} {cy-k} {cx+r} {cy} '
            f"C {cx+k} {cy+k} {cx+k} {cy+k} {cx} {cy+r} "
            f"C {cx-k} {cy+k} {cx-k} {cy+k} {cx-r} {cy} "
            f'C {cx-k} {cy-k} {cx-k} {cy-k} {cx} {cy-r} Z"/>')


def star_pts(cx, cy, r, inner=0.48, n=5, rot=-90):
    pts = []
    for i in range(n * 2):
        rr = r if i % 2 == 0 else r * inner
        a = math.radians(rot + i * 180 / n)
        pts.append(f"{cx + rr*math.cos(a):.1f},{cy + rr*math.sin(a):.1f}")
    return " ".join(pts)


def soft_star(cx, cy, r, fill=W, inner=0.5, round_=34, rot=-90):
    # Rounded corners via a same-color round-joined stroke.
    return (f'<polygon points="{star_pts(cx, cy, r, inner, rot=rot)}" fill="{fill}" '
            f'stroke="{fill}" stroke-width="{round_}" stroke-linejoin="round"/>')


def poly_path(pts):
    return "M " + " L ".join(f"{x:.1f} {y:.1f}" for x, y in pts)


C = {}

# 1. Pinwheel: four curled blades, alternating fold shading, on a stick.
blade = "M 512 430 L 512 196 C 600 210 660 280 676 340 Z"
C["pinwheel"] = ("citrus", f'''
  <rect x="494" y="430" width="36" height="430" rx="18" fill="{W}" opacity=".9"/>
  {''.join(f'<path d="{blade}" fill="{W}" transform="rotate({i*90} 512 430)"/><path d="M 512 430 L 676 340 L 600 430 Z" fill="#ffb21f" opacity=".45" transform="rotate({i*90} 512 430)"/>' for i in range(4))}
  <circle cx="512" cy="430" r="30" fill="#ff7a3d"/>
  <circle cx="512" cy="430" r="12" fill="{W}"/>''')

# 2. Party balloon with a curly string.
C["balloon"] = ("candy", f'''
  <path d="M 512 220 C 660 220 730 330 720 430 C 708 560 600 640 512 650 C 424 640 316 560 304 430 C 294 330 364 220 512 220 Z" fill="{W}"/>
  <path d="M 492 650 L 532 650 L 546 684 L 478 684 Z" fill="{W}"/>
  <path d="M 512 684 C 470 730 560 760 520 800 C 480 840 540 870 512 900" fill="none" stroke="{W}" stroke-width="16" stroke-linecap="round"/>
  <ellipse cx="420" cy="350" rx="38" ry="70" transform="rotate(25 420 350)" fill="#ff7ad9" opacity=".35"/>''')

# 3. Hot-air balloon with gores and a tiny basket.
env = ("M 512 200 C 690 200 760 340 718 470 C 690 556 600 600 572 650 L 452 650 "
       "C 424 600 334 556 306 470 C 264 340 334 200 512 200 Z")
C["hot-air"] = ("sunset", f'''
  <clipPath id="env"><path d="{env}"/></clipPath>
  <path d="{env}" fill="{W}"/>
  <g clip-path="url(#env)" fill="#ff6a3d" opacity=".9">
    <path d="M 512 190 C 440 260 430 520 482 660 L 542 660 C 594 520 584 260 512 190 Z"/>
  </g>
  <g stroke="{W}" stroke-width="10" stroke-linecap="round"><line x1="462" y1="650" x2="476" y2="716"/><line x1="562" y1="650" x2="548" y2="716"/></g>
  <rect x="462" y="712" width="100" height="78" rx="18" fill="{W}"/>''')

# 4. Dandelion clock with seeds drifting away.
spokes = []
for i in range(20):
    a = math.radians(i * 18)
    x1, y1 = 470 + 40*math.cos(a), 450 + 40*math.sin(a)
    x2, y2 = 470 + 165*math.cos(a), 450 + 165*math.sin(a)
    spokes.append(f'<line x1="{x1:.0f}" y1="{y1:.0f}" x2="{x2:.0f}" y2="{y2:.0f}"/><circle cx="{x2:.0f}" cy="{y2:.0f}" r="17"/>')
C["dandelion"] = ("lagoon", f'''
  <path d="M 470 480 C 480 620 520 720 600 860" fill="none" stroke="{W}" stroke-width="22" stroke-linecap="round"/>
  <g stroke="{W}" stroke-width="10" stroke-linecap="round" fill="{W}">{''.join(spokes)}</g>
  <circle cx="470" cy="450" r="44" fill="{W}"/>
  <g stroke="{W}" stroke-width="9" stroke-linecap="round" fill="{W}" opacity=".85">
    <line x1="700" y1="300" x2="740" y2="268"/><circle cx="744" cy="264" r="15"/>
    <line x1="760" y1="400" x2="806" y2="384"/><circle cx="811" cy="382" r="13"/>
  </g>''')

# 5. Soap bubbles.
def bubble(cx, cy, r):
    sw = max(10, r * 0.13)
    return (f'<circle cx="{cx}" cy="{cy}" r="{r}" fill="{W}" fill-opacity=".14" stroke="{W}" stroke-width="{sw:.0f}"/>'
            f'<path d="M {cx - r*0.62:.0f} {cy - r*0.18:.0f} A {r*0.66:.0f} {r*0.66:.0f} 0 0 1 {cx - r*0.1:.0f} {cy - r*0.66:.0f}" '
            f'fill="none" stroke="{W}" stroke-width="{sw*0.9:.0f}" stroke-linecap="round"/>')
C["bubbles"] = ("night", bubble(450, 560, 225) + bubble(730, 310, 92) + bubble(760, 505, 42))

# 6. Shooting star with a loop-de-loop trail.
C["shooting-star"] = ("berry", f'''
  <path d="M 220 820 C 360 800 470 720 450 620 C 430 520 320 560 360 640 C 410 740 600 560 650 420" fill="none" stroke="{W}" stroke-width="44" stroke-linecap="round" opacity=".75"/>
  {soft_star(690, 350, 140, rot=-80)}''')

# 7. Paper plane with a dashed looping flight path.
C["paper-plane"] = ("mint", f'''
  <path d="M 210 800 C 330 820 430 760 400 670 C 370 590 280 640 330 700 C 400 780 560 580 560 470" fill="none" stroke="{W}" stroke-width="22" stroke-linecap="round" stroke-dasharray="2 46"/>
  <path d="M 820 220 L 440 400 L 590 450 Z" fill="{W}"/>
  <path d="M 820 220 L 590 450 L 640 580 Z" fill="{W}" opacity=".78"/>
  <path d="M 590 450 L 600 560 L 640 580 Z" fill="{W}" opacity=".6"/>''')

# 8. Kite with bow-tie tail.
def bow(x, y, s=26, rot=0):
    return (f'<g transform="rotate({rot} {x} {y})"><path d="M {x} {y} L {x-s} {y-s*0.7} L {x-s} {y+s*0.7} Z M {x} {y} L {x+s} {y-s*0.7} L {x+s} {y+s*0.7} Z" fill="{W}"/></g>')
C["kite"] = ("lagoon", f'''
  <path d="M 540 620 C 480 700 380 640 340 720 C 300 800 390 830 330 880" fill="none" stroke="{W}" stroke-width="10" stroke-linecap="round"/>
  {bow(430, 664, rot=-20)}{bow(345, 760, rot=30)}
  <g transform="rotate(-18 580 400)">
    <path d="M 580 180 L 740 380 L 580 640 L 420 380 Z" fill="{W}"/>
    <path d="M 580 180 L 740 380 L 580 380 Z M 420 380 L 580 380 L 580 640 Z" fill="#3d5cff" opacity=".22"/>
  </g>''')

# 9. Crescent moon with sparkles.
C["moon"] = ("night", f'''
  <mask id="cres"><rect width="1024" height="1024" fill="#fff"/><circle cx="600" cy="420" r="200" fill="#000"/></mask>
  <circle cx="470" cy="540" r="250" fill="{W}" mask="url(#cres)"/>
  {sparkle(760, 560, 56)}{sparkle(720, 260, 40)}<circle cx="640" cy="760" r="16" fill="{W}" opacity=".8"/>''')

# 10. Rainbow tucked behind a cloud (an Arc nod).
C["rainbow"] = ("candy", f'''
  <g fill="none" stroke-linecap="round" stroke-width="58">
    <path d="M 220 640 A 292 292 0 0 1 804 640" stroke="{W}"/>
    <path d="M 300 640 A 212 212 0 0 1 724 640" stroke="{W}" opacity=".72"/>
    <path d="M 380 640 A 132 132 0 0 1 644 640" stroke="{W}" opacity=".5"/>
  </g>
  <path d="M 600 760 C 560 760 550 700 600 690 C 600 630 690 610 720 660 C 760 620 840 650 830 710 C 870 720 870 760 830 760 Z" fill="{W}"/>
  <path d="M 160 760 C 130 760 120 710 165 700 C 170 650 240 640 260 680 C 300 660 340 700 320 760 Z" fill="{W}"/>''')

# 11. Lollipop swirl.
pts = []
for i in range(0, 700):
    t = i / 700 * 4.2 * math.pi
    r = 8 + t * 15
    pts.append((512 + r*math.cos(t), 420 + r*math.sin(t)))
C["lollipop"] = ("berry", f'''
  <rect x="494" y="560" width="36" height="320" rx="18" fill="{W}" opacity=".9"/>
  <circle cx="512" cy="420" r="230" fill="{W}"/>
  <path d="{poly_path(pts)}" fill="none" stroke="#ff3d7f" stroke-width="42" stroke-linecap="round" opacity=".85"/>''')

# 12. Toadstool.
C["toadstool"] = ("sunset", f'''
  <path d="M 430 560 C 420 680 400 780 420 820 L 604 820 C 624 780 604 680 594 560 Z" fill="{W}" opacity=".88"/>
  <path d="M 230 560 C 230 330 400 230 512 230 C 624 230 794 330 794 560 C 794 600 230 600 230 560 Z" fill="{W}"/>
  <g fill="#ff6a3d" opacity=".75"><circle cx="420" cy="390" r="48"/><circle cx="610" cy="340" r="38"/><circle cx="660" cy="480" r="30"/><circle cx="330" cy="500" r="24"/><circle cx="520" cy="500" r="26"/></g>''')

# 13. Boing: a spring coil bouncing a ball.
pts = []
for i in range(0, 900):
    t = i / 900 * 3.5 * 2 * math.pi
    x = 300 + t * 16 + 90 * math.cos(t + math.pi)
    y = 790 - t * 14 + 90 * math.sin(t + math.pi) * 0.55
    pts.append((x, y))
ex, ey = pts[-1]
C["spring"] = ("mint", f'''
  <path d="{poly_path(pts)}" fill="none" stroke="{W}" stroke-width="44" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="{ex+60:.0f}" cy="{ey-120:.0f}" r="78" fill="{W}"/>
  <g stroke="{W}" stroke-width="14" stroke-linecap="round" opacity=".7"><line x1="{ex-20:.0f}" y1="{ey-150:.0f}" x2="{ex-60:.0f}" y2="{ey-180:.0f}"/><line x1="{ex+150:.0f}" y1="{ey-90:.0f}" x2="{ex+190:.0f}" y2="{ey-80:.0f}"/></g>''')

# 14. Butterfly.
def wing(path, op):
    return f'<path d="{path}" fill="{W}" opacity="{op}"/><path d="{path}" fill="{W}" opacity="{op}" transform="translate(1024 0) scale(-1 1)"/>'
C["butterfly"] = ("citrus", f'''
  {wing("M 500 470 C 420 300 250 230 230 330 C 210 430 330 500 500 500 Z", 1)}
  {wing("M 500 510 C 380 520 290 590 330 680 C 370 760 470 680 500 540 Z", .8)}
  <rect x="490" y="420" width="44" height="260" rx="22" fill="{W}"/>
  <path d="M 500 430 C 480 360 440 330 420 300 M 524 430 C 544 360 584 330 604 300" fill="none" stroke="{W}" stroke-width="14" stroke-linecap="round"/>
  <circle cx="416" cy="294" r="18" fill="{W}"/><circle cx="608" cy="294" r="18" fill="{W}"/>''')

# 15. Paper boat on a wave.
C["paper-boat"] = ("lagoon", f'''
  <path d="M 512 250 L 400 560 L 624 560 Z" fill="{W}" opacity=".82"/>
  <path d="M 260 560 L 764 560 L 680 690 L 344 690 Z" fill="{W}"/>
  <path d="M 512 250 L 512 560 L 624 560 Z" fill="{W}"/>
  <path d="M 190 780 C 260 730 330 730 400 780 C 470 830 540 830 610 780 C 680 730 750 730 830 780" fill="none" stroke="{W}" stroke-width="36" stroke-linecap="round" opacity=".85"/>''')

# 16. Blob buddy: a squishy mascot.
C["blob-buddy"] = ("candy", f'''
  <path d="M 512 250 C 690 240 790 370 770 530 C 750 700 640 790 500 780 C 340 770 240 680 250 520 C 260 360 350 258 512 250 Z" fill="{W}"/>
  <ellipse cx="440" cy="500" rx="30" ry="44" fill="#2a1a4a"/><ellipse cx="590" cy="500" rx="30" ry="44" fill="#2a1a4a"/>
  <circle cx="450" cy="484" r="10" fill="{W}"/><circle cx="600" cy="484" r="10" fill="{W}"/>
  <path d="M 480 590 C 500 615 540 615 560 590" fill="none" stroke="#2a1a4a" stroke-width="16" stroke-linecap="round"/>
  <ellipse cx="380" cy="580" rx="40" ry="22" fill="#ff7ad9" opacity=".55"/><ellipse cx="650" cy="580" rx="40" ry="22" fill="#ff7ad9" opacity=".55"/>
  {sparkle(760, 260, 46)}''')

# 17. Magic wand.
C["wand"] = ("berry", f'''
  <path d="M 290 790 L 560 500" stroke="{W}" stroke-width="46" stroke-linecap="round"/>
  {soft_star(620, 420, 150, rot=-75)}
  {sparkle(330, 360, 48, op=.9)}{sparkle(800, 640, 40, op=.9)}<circle cx="430" cy="270" r="14" fill="{W}" opacity=".8"/><circle cx="760" cy="760" r="12" fill="{W}" opacity=".8"/>''')

# 18. Ribbon loop: one bouncy stroke with a twist.
C["ribbon"] = ("sunset", f'''
  <path d="M 230 720 C 420 760 720 660 690 450 C 664 270 430 300 460 480 C 490 650 740 700 810 540" fill="none" stroke="{W}" stroke-width="86" stroke-linecap="round" opacity=".7"/>
  <path d="M 230 720 C 420 760 720 660 690 450 C 664 270 430 300 460 480" fill="none" stroke="{W}" stroke-width="86" stroke-linecap="round"/>''')

# 19. Feather.
C["feather"] = ("mint", f'''
  <mask id="notch"><rect width="1024" height="1024" fill="#fff"/>
    <g stroke="#000" stroke-width="14" stroke-linecap="round"><line x1="430" y1="520" x2="370" y2="540"/><line x1="560" y1="420" x2="620" y2="440"/><line x1="610" y1="330" x2="560" y2="330"/></g></mask>
  <path d="M 300 800 C 360 560 540 290 760 220 C 760 440 580 700 300 800 Z" fill="{W}" mask="url(#notch)"/>
  <path d="M 250 850 C 380 640 560 420 740 250" fill="none" stroke="#2f7bff" stroke-width="14" stroke-linecap="round" opacity=".5"/>''')

# 20. Ringed planet.
C["planet"] = ("night", f'''
  <clipPath id="front"><rect x="0" y="512" width="1024" height="512"/></clipPath>
  <g transform="rotate(-20 512 512)">
    <ellipse cx="512" cy="512" rx="330" ry="86" fill="none" stroke="{W}" stroke-width="34" opacity=".75"/>
    <circle cx="512" cy="512" r="200" fill="{W}"/>
    <ellipse cx="512" cy="512" rx="330" ry="86" fill="none" stroke="{W}" stroke-width="34" clip-path="url(#front)"/>
    <circle cx="452" cy="452" r="36" fill="#6a3dff" opacity=".18"/><circle cx="580" cy="560" r="22" fill="#6a3dff" opacity=".18"/>
  </g>
  {sparkle(780, 270, 40)}<circle cx="260" cy="760" r="14" fill="{W}" opacity=".8"/>''')

# 21. Glossy 3D bubble on cream (a colored-object direction).
C["glossy-balloon"] = ("cream", f'''
  <radialGradient id="bal" cx=".35" cy=".3" r=".8"><stop offset="0" stop-color="#ffb3d9"/><stop offset=".55" stop-color="#ff4fa3"/><stop offset="1" stop-color="#7a5cff"/></radialGradient>
  <path d="M 512 210 C 660 210 730 320 720 420 C 708 550 600 630 512 640 C 424 630 316 550 304 420 C 294 320 364 210 512 210 Z" fill="url(#bal)"/>
  <ellipse cx="420" cy="340" rx="40" ry="76" transform="rotate(25 420 340)" fill="{W}" opacity=".7"/>
  <path d="M 492 640 L 532 640 L 546 674 L 478 674 Z" fill="#c03d9e"/>
  <path d="M 512 674 C 470 720 560 750 520 790 C 480 830 540 860 512 890" fill="none" stroke="#c03d9e" stroke-width="14" stroke-linecap="round"/>''')

# 22. Comet-tailed "w" orbit: the old idea reborn as a looping orbit dot.
C["orbit"] = ("lagoon", f'''
  <g fill="none" stroke="{W}" stroke-linecap="round">
    <ellipse cx="512" cy="512" rx="300" ry="130" stroke-width="30" transform="rotate(-30 512 512)" opacity=".85"/>
    <ellipse cx="512" cy="512" rx="300" ry="130" stroke-width="30" transform="rotate(30 512 512)" opacity=".6"/>
  </g>
  <circle cx="512" cy="512" r="92" fill="{W}"/>
  <circle cx="770" cy="362" r="40" fill="{W}"/>''')

# ---- Round 2: bolder, more character, more dimensional ----

# 23. Snail with a swirl shell: slow, curious browsing.
pts = []
for i in range(0, 600):
    t = i / 600 * 3.3 * math.pi
    r = 175 - t * 15
    pts.append((560 + r*math.cos(t + math.pi/2), 470 + r*math.sin(t + math.pi/2)))
C["snail"] = ("mint", f'''
  <path d="M 230 700 C 230 640 300 610 380 620 L 700 640 C 780 646 800 700 760 710 L 280 720 C 250 720 230 712 230 700 Z" fill="{W}" opacity=".9"/>
  <path d="M 300 640 C 280 560 270 520 250 480 M 340 630 C 340 560 350 520 350 470" fill="none" stroke="{W}" stroke-width="16" stroke-linecap="round"/>
  <circle cx="248" cy="474" r="20" fill="{W}"/><circle cx="350" cy="462" r="20" fill="{W}"/>
  <circle cx="560" cy="470" r="200" fill="{W}"/>
  <path d="{poly_path(pts)}" fill="none" stroke="#2f7bff" stroke-width="30" stroke-linecap="round" opacity=".45"/>''')

# 24. Jellyfish drifting, with curly tentacles.
C["jellyfish"] = ("night", f'''
  <path d="M 290 480 C 290 300 410 220 512 220 C 614 220 734 300 734 480 C 690 510 650 470 610 500 C 570 530 540 490 512 510 C 484 490 454 530 414 500 C 374 470 334 510 290 480 Z" fill="{W}"/>
  <g fill="none" stroke="{W}" stroke-width="20" stroke-linecap="round" opacity=".85">
    <path d="M 380 520 C 350 600 410 640 380 720 C 360 770 390 800 370 840"/>
    <path d="M 470 530 C 450 620 510 660 480 760"/>
    <path d="M 560 530 C 590 620 530 670 570 760 C 590 800 560 830 580 860"/>
    <path d="M 650 520 C 680 600 620 640 650 720"/>
  </g>
  <ellipse cx="440" cy="330" rx="34" ry="54" transform="rotate(30 440 330)" fill="#6a3dff" opacity=".2"/>''')

# 25. Teacup with curly steam (a mad-tea-party nod).
C["teacup"] = ("berry", f'''
  <path d="M 680 520 C 780 520 790 640 680 650" fill="none" stroke="{W}" stroke-width="40" stroke-linecap="round"/>
  <path d="M 290 480 L 710 480 C 710 640 640 730 500 730 C 360 730 290 640 290 480 Z" fill="{W}"/>
  <ellipse cx="500" cy="780" rx="260" ry="40" fill="{W}" opacity=".85"/>
  <g fill="none" stroke="{W}" stroke-width="26" stroke-linecap="round" opacity=".8">
    <path d="M 420 420 C 380 370 460 330 420 270"/><path d="M 540 420 C 500 360 600 320 560 230"/>
  </g>
  <circle cx="420" cy="590" r="26" fill="#ff3d7f" opacity=".5"/><circle cx="500" cy="620" r="26" fill="#ff3d7f" opacity=".5"/><circle cx="580" cy="590" r="26" fill="#ff3d7f" opacity=".5"/>''')

# 26. Magician's top hat with a sparkle escaping.
C["top-hat"] = ("sunset", f'''
  <ellipse cx="512" cy="720" rx="300" ry="70" fill="{W}"/>
  <path d="M 340 720 L 370 380 C 372 350 400 340 512 340 C 624 340 652 350 654 380 L 684 720 Z" fill="{W}"/>
  <path d="M 356 600 L 668 600 L 674 660 L 350 660 Z" fill="#d6297a" opacity=".6"/>
  {sparkle(640, 230, 70)}{sparkle(470, 220, 36, op=.9)}<circle cx="560" cy="280" r="14" fill="{W}"/>''')

# 27. Bouncy ball mid-squash, with a dotted bounce path.
C["bounce"] = ("citrus", f'''
  <path d="M 200 470 C 260 300 360 300 410 560" fill="none" stroke="{W}" stroke-width="24" stroke-linecap="round" stroke-dasharray="1 46" opacity=".9"/>
  <ellipse cx="510" cy="460" rx="160" ry="160" fill="{W}"/>
  <path d="M 380 420 C 450 470 570 470 640 420" fill="none" stroke="#ff4f6d" stroke-width="34" stroke-linecap="round" opacity=".6"/>
  <ellipse cx="510" cy="760" rx="210" ry="40" fill="{W}" opacity=".85"/>
  <g stroke="{W}" stroke-width="16" stroke-linecap="round" opacity=".8"><line x1="270" y1="740" x2="230" y2="720"/><line x1="750" y1="740" x2="790" y2="720"/></g>''')

# 28. Crystal ball holding a tiny galaxy.
C["crystal-ball"] = ("night", f'''
  <radialGradient id="orb" cx=".4" cy=".35" r=".75"><stop offset="0" stop-color="#fff" stop-opacity=".95"/><stop offset=".7" stop-color="#ff9ee0" stop-opacity=".55"/><stop offset="1" stop-color="#7a5cff" stop-opacity=".6"/></radialGradient>
  <path d="M 360 780 L 664 780 L 620 690 L 404 690 Z" fill="{W}"/>
  <circle cx="512" cy="470" r="250" fill="url(#orb)"/>
  <circle cx="512" cy="470" r="250" fill="none" stroke="{W}" stroke-width="18"/>
  <path d="M 380 360 A 170 170 0 0 1 480 290" fill="none" stroke="{W}" stroke-width="26" stroke-linecap="round"/>
  {sparkle(540, 480, 84, fill="#5a2fd6")}{sparkle(630, 400, 34, fill="#5a2fd6", op=.8)}''')

# 29. Rainbow ribbon: an Arc-ish swoop made of colored bands, on cream.
bands = ["#ff4fa3", "#ff9a3d", "#ffd93d", "#2fe0a0", "#38d6ff", "#7a5cff"]
ribbon = "M 210 700 C 330 360 520 320 560 470 C 600 620 760 600 820 330"
C["rainbow-ribbon"] = ("cream", "".join(
    f'<path d="{ribbon}" fill="none" stroke="{c}" stroke-width="{150 - i*24}" stroke-linecap="round"/>'
    for i, c in enumerate(bands)))

# 30. Sprout: two leaves and a curl, for growing ideas.
C["sprout"] = ("lagoon", f'''
  <path d="M 512 820 C 512 700 500 600 512 480" fill="none" stroke="{W}" stroke-width="34" stroke-linecap="round"/>
  <path d="M 512 540 C 420 560 300 520 270 380 C 400 340 500 420 512 540 Z" fill="{W}"/>
  <path d="M 512 500 C 560 380 700 300 780 330 C 780 460 650 520 512 500 Z" fill="{W}" opacity=".85"/>
  <path d="M 512 480 C 500 400 560 360 590 390 C 610 410 590 440 565 430" fill="none" stroke="{W}" stroke-width="20" stroke-linecap="round"/>
  <ellipse cx="512" cy="830" rx="170" ry="34" fill="{W}" opacity=".7"/>''')

# 31. Party hat bursting with confetti.
conf = ""
for (x, y, r, c) in [(300, 300, 20, "#ffd93d"), (700, 260, 18, "#38d6ff"), (380, 210, 14, "#2fe0a0"),
                     (760, 420, 16, "#ffd93d"), (260, 470, 14, "#38d6ff"), (620, 190, 12, "#fff")]:
    conf += f'<rect x="{x-r}" y="{y-r/2}" width="{2*r}" height="{r}" rx="{r/2}" fill="{c}" transform="rotate({x%90} {x} {y})"/>'
C["party-hat"] = ("candy", f'''
  {conf}
  <path d="M 512 270 L 690 760 C 600 800 424 800 334 760 Z" fill="{W}"/>
  <clipPath id="hat"><path d="M 512 270 L 690 760 C 600 800 424 800 334 760 Z"/></clipPath>
  <g clip-path="url(#hat)" stroke="#ff4fa3" stroke-width="40" opacity=".55"><line x1="300" y1="600" x2="700" y2="440"/><line x1="300" y1="760" x2="740" y2="580"/></g>
  <circle cx="512" cy="260" r="46" fill="{W}"/>''')

# 32. Gummy arch: a chunky glossy candy "arc" with depth — the closest Arc homage.
C["gummy-arch"] = ("cream", f'''
  <linearGradient id="gum" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff7ad9"/><stop offset=".5" stop-color="#ff4fa3"/><stop offset="1" stop-color="#7a5cff"/></linearGradient>
  <path d="M 250 740 L 250 500 C 250 340 370 250 512 250 C 654 250 774 340 774 500 L 774 740 C 774 790 650 790 650 740 L 650 510 C 650 420 590 380 512 380 C 434 380 374 420 374 510 L 374 740 C 374 790 250 790 250 740 Z" fill="url(#gum)"/>
  <path d="M 300 560 C 300 400 390 310 500 300" fill="none" stroke="#fff" stroke-width="30" stroke-linecap="round" opacity=".6"/>
  {sparkle(800, 250, 46, fill="#ff4fa3")}''')

if __name__ == "__main__":
    for name, (cw, mark) in C.items():
        # Mark-local defs (clipPaths, masks, gradients) are fine inline in SVG.
        open(f"{name}.svg", "w").write(frame(cw, mark))
    print(len(C), "concepts")
