/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// wave5: Easel. The parts of the canvas that don't touch the page: colours,
// geometry, snapping, strokes, undo history and drawing an easel into a
// 2D canvas for PNG/PDF export and Copy as Image.

// Colour tokens, not hex values, are stored on items, so a drawing in "ink"
// stays legible in light and dark (and exports in either).
export const COLORS = {
  ink: ["#1f1c24", "#f3f0f7"],
  gray: ["#7c7787", "#a7a1b1"],
  red: ["#e0343b", "#ff6b6f"],
  orange: ["#ea6a12", "#ff9147"],
  yellow: ["#e8ad00", "#ffd34d"],
  green: ["#21995e", "#4ad99a"],
  blue: ["#1b6fe0", "#5cadff"],
  purple: ["#8a46c9", "#bc92f2"],
  pink: ["#d23c96", "#f383c6"],
};
export const COLOR_NAMES = Object.keys(COLORS);

export const BACKGROUND = ["#fbfaf8", "#18161c"];
export const CARD = ["#ffffff", "#24212a"];
export const CARD_TEXT_MUTED = ["#6c6676", "#a49eae"];

export const FONTS = {
  sans: 'system-ui, -apple-system, "Segoe UI", sans-serif',
  serif: 'ui-serif, "New York", Georgia, serif',
  mono: 'ui-monospace, "SF Mono", Menlo, monospace',
  rounded: 'ui-rounded, "SF Pro Rounded", system-ui, sans-serif',
};
export const FONT_NAMES = Object.keys(FONTS);

// Text sizes and stroke widths (px) for the three size steps.
export const TEXT_SIZES = [18, 28, 44];
export const STROKE_WIDTHS = [2, 4, 8];
export const HIGHLIGHTER_SCALE = 4;

export const LINK_SIZE = { w: 300, h: 72 };
export const MIN_SIZE = 8;

export function colorValue(name, dark) {
  return (COLORS[name] ?? COLORS.ink)[dark ? 1 : 0];
}

export function newItemId() {
  return Services.uuid.generateUUID().toString().slice(1, -1);
}

export function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

export function boundsOf(items) {
  if (!items?.length) {
    return null;
  }
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const item of items) {
    left = Math.min(left, item.x);
    top = Math.min(top, item.y);
    right = Math.max(right, item.x + item.w);
    bottom = Math.max(bottom, item.y + item.h);
  }
  return { x: left, y: top, w: right - left, h: bottom - top };
}

export function intersects(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

// A rectangle from two corner points.
export function rectFromPoints(a, b) {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
}

// Resizes `rect` by dragging `handle` ("n", "se", ...) by (dx, dy) in canvas
// px. keepAspect locks the start ratio (images, captures, Shift). Dragging
// past the opposite edge flips, reported as flipX/flipY.
export function resizeRect(rect, handle, dx, dy, { keepAspect = false, min = MIN_SIZE } = {}) {
  let left = rect.x, top = rect.y, right = rect.x + rect.w, bottom = rect.y + rect.h;
  if (handle.includes("w")) left += dx;
  if (handle.includes("e")) right += dx;
  if (handle.includes("n")) top += dy;
  if (handle.includes("s")) bottom += dy;
  const flipX = right < left;
  const flipY = bottom < top;
  let x = Math.min(left, right), y = Math.min(top, bottom);
  let w = Math.max(min, Math.abs(right - left)), h = Math.max(min, Math.abs(bottom - top));
  if (keepAspect && rect.w > 0 && rect.h > 0) {
    const ratio = rect.w / rect.h;
    const horizontal = handle.includes("e") || handle.includes("w");
    const vertical = handle.includes("n") || handle.includes("s");
    if (horizontal && (!vertical || w / ratio >= h)) {
      h = w / ratio;
    } else {
      w = h * ratio;
    }
    // Keep the opposite edge anchored.
    if (handle.includes("w") && !flipX) x = rect.x + rect.w - w;
    if (handle.includes("n") && !flipY) y = rect.y + rect.h - h;
    if (!horizontal) x = rect.x + (rect.w - w) / 2;
    if (!vertical) y = rect.y + (rect.h - h) / 2;
  }
  return { x, y, w, h, flipX, flipY };
}

// Maps an item's rect from one group box to another (multi-select resize).
export function mapRect(item, from, to) {
  const sx = from.w ? to.w / from.w : 1;
  const sy = from.h ? to.h / from.h : 1;
  return {
    x: to.x + (item.x - from.x) * sx,
    y: to.y + (item.y - from.y) * sy,
    w: Math.max(1, item.w * sx),
    h: Math.max(1, item.h * sy),
  };
}

// Snaps a moving box to the edges and centres of other boxes. Returns the
// correction and the guide lines to draw (canvas px).
export function snapMove(box, others, threshold) {
  const xs = b => [b.x, b.x + b.w / 2, b.x + b.w];
  const ys = b => [b.y, b.y + b.h / 2, b.y + b.h];
  let best = { x: null, y: null };
  for (const other of others) {
    for (const [axis, mine, theirs] of [["x", xs(box), xs(other)], ["y", ys(box), ys(other)]]) {
      for (const m of mine) {
        for (const t of theirs) {
          const d = t - m;
          if (Math.abs(d) <= threshold && (best[axis] == null || Math.abs(d) < Math.abs(best[axis].d))) {
            best[axis] = { d, at: t, other };
          }
        }
      }
    }
  }
  const dx = best.x?.d ?? 0;
  const dy = best.y?.d ?? 0;
  const moved = { x: box.x + dx, y: box.y + dy, w: box.w, h: box.h };
  const guides = [];
  if (best.x) {
    const o = best.x.other;
    guides.push({ axis: "x", at: best.x.at, from: Math.min(moved.y, o.y), to: Math.max(moved.y + moved.h, o.y + o.h) });
  }
  if (best.y) {
    const o = best.y.other;
    guides.push({ axis: "y", at: best.y.at, from: Math.min(moved.x, o.x), to: Math.max(moved.x + moved.w, o.x + o.w) });
  }
  return { dx, dy, guides };
}

// wave7: snaps the edges a resize handle moves (and the box's centre on
// that axis) to the edges and centres of other boxes. `box` is the resized
// rect; returns the shift to apply to the handle's dx/dy, and guides.
export function snapResize(box, handle, others, threshold) {
  const moving = {
    x: [handle.includes("w") ? box.x : null, handle.includes("e") ? box.x + box.w : null].filter(v => v != null),
    y: [handle.includes("n") ? box.y : null, handle.includes("s") ? box.y + box.h : null].filter(v => v != null),
  };
  const xs = b => [b.x, b.x + b.w / 2, b.x + b.w];
  const ys = b => [b.y, b.y + b.h / 2, b.y + b.h];
  const best = { x: null, y: null };
  for (const other of others) {
    for (const [axis, theirs] of [["x", xs(other)], ["y", ys(other)]]) {
      for (const m of moving[axis]) {
        for (const t of theirs) {
          const d = t - m;
          if (Math.abs(d) <= threshold && (best[axis] == null || Math.abs(d) < Math.abs(best[axis].d))) {
            best[axis] = { d, at: t, other };
          }
        }
      }
    }
  }
  const guides = [];
  if (best.x) {
    const o = best.x.other;
    guides.push({ axis: "x", at: best.x.at, from: Math.min(box.y, o.y), to: Math.max(box.y + box.h, o.y + o.h) });
  }
  if (best.y) {
    const o = best.y.other;
    guides.push({ axis: "y", at: best.y.at, from: Math.min(box.x, o.x), to: Math.max(box.x + box.w, o.x + o.w) });
  }
  return { dx: best.x?.d ?? 0, dy: best.y?.d ?? 0, guides };
}

// A smooth SVG path through freehand points (quadratic curves through the
// midpoints), rounded to tenths to keep the store small.
export function smoothPath(points) {
  const r = n => Math.round(n * 10) / 10;
  if (!points.length) {
    return "";
  }
  if (points.length < 3) {
    const [a, b = a] = points;
    return `M${r(a[0])} ${r(a[1])}L${r(b[0] + 0.01)} ${r(b[1])}`;
  }
  let d = `M${r(points[0][0])} ${r(points[0][1])}`;
  for (let i = 1; i < points.length - 1; i++) {
    const [x, y] = points[i];
    const [nx, ny] = points[i + 1];
    d += `Q${r(x)} ${r(y)} ${r((x + nx) / 2)} ${r((y + ny) / 2)}`;
  }
  const last = points[points.length - 1];
  return `${d}L${r(last[0])} ${r(last[1])}`;
}

// Turns canvas-space points into a pen item's geometry: the bounding box
// (padded by half the stroke) and a path in that box's own coordinates.
export function strokeGeometry(points, width) {
  const pad = width / 2 + 1;
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const [x, y] of points) {
    left = Math.min(left, x);
    top = Math.min(top, y);
    right = Math.max(right, x);
    bottom = Math.max(bottom, y);
  }
  left -= pad;
  top -= pad;
  const w = Math.max(MIN_SIZE, right + pad - left);
  const h = Math.max(MIN_SIZE, bottom + pad - top);
  const d = smoothPath(points.map(([x, y]) => [x - left, y - top]));
  return { x: left, y: top, w, h, vw: w, vh: h, d };
}

// Undo history of item lists (JSON snapshots).
export class History {
  #undo = [];
  #redo = [];
  #limit;

  constructor(limit = 200) {
    this.#limit = limit;
  }

  get canUndo() {
    return this.#undo.length > 0;
  }

  get canRedo() {
    return this.#redo.length > 0;
  }

  // Records the state before a change.
  push(snapshot) {
    const json = JSON.stringify(snapshot);
    if (this.#undo.at(-1) == json) {
      return;
    }
    this.#undo.push(json);
    if (this.#undo.length > this.#limit) {
      this.#undo.shift();
    }
    this.#redo = [];
  }

  // Drops the last checkpoint when the change it guarded didn't happen.
  discard(snapshot) {
    if (this.#undo.at(-1) == JSON.stringify(snapshot)) {
      this.#undo.pop();
    }
  }

  undo(current) {
    if (!this.#undo.length) {
      return null;
    }
    this.#redo.push(JSON.stringify(current));
    return JSON.parse(this.#undo.pop());
  }

  redo(current) {
    if (!this.#redo.length) {
      return null;
    }
    this.#undo.push(JSON.stringify(current));
    return JSON.parse(this.#redo.pop());
  }
}

// Endpoints of a line or arrow inside its box.
export function lineEnds(item) {
  const x1 = item.flipX ? item.w : 0;
  const y1 = item.flipY ? item.h : 0;
  return [x1, y1, item.w - x1, item.h - y1];
}

// The arrowhead's two wing points for a line ending at (x2, y2).
export function arrowHead(x1, y1, x2, y2, width) {
  const size = Math.max(10, width * 3.2);
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const spread = Math.PI / 7;
  return [
    [x2 - size * Math.cos(angle - spread), y2 - size * Math.sin(angle - spread)],
    [x2 - size * Math.cos(angle + spread), y2 - size * Math.sin(angle + spread)],
  ];
}

export function textFont(item) {
  return `${item.bold ? 600 : 450} ${item.size}px ${FONTS[item.font] ?? FONTS.sans}`;
}

export const TEXT_LINE_HEIGHT = 1.3;

// Wraps text to a width the way the page lays it out (pre-wrap).
export function wrapText(ctx, text, width) {
  const lines = [];
  for (const paragraph of String(text ?? "").split("\n")) {
    let line = "";
    for (const word of paragraph.split(/(\s+)/)) {
      const next = line + word;
      if (line && ctx.measureText(next.trimEnd()).width > width) {
        lines.push(line.trimEnd());
        line = word.trimStart();
      } else {
        line = next;
      }
    }
    lines.push(line);
  }
  return lines;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, Math.min(r, w / 2, h / 2));
}

// Draws items onto a 2D context already transformed to canvas px.
// images: Map of file name -> decoded image.
export function drawItems(ctx, items, { dark = false, images = new Map() } = {}) {
  for (const item of items) {
    ctx.save();
    const color = colorValue(item.color, dark);
    switch (item.type) {
      case "text": {
        ctx.font = textFont(item);
        ctx.fillStyle = color;
        ctx.textBaseline = "top";
        const lineHeight = item.size * TEXT_LINE_HEIGHT;
        const lines = wrapText(ctx, item.text, item.w);
        lines.forEach((line, i) => {
          ctx.fillText(line, item.x, item.y + i * lineHeight + (lineHeight - item.size) / 2);
        });
        break;
      }
      case "pen": {
        const path = new Path2D();
        path.addPath(new Path2D(item.d), new DOMMatrix().translate(item.x, item.y).scale(item.w / item.vw, item.h / item.vh));
        ctx.lineCap = ctx.lineJoin = "round";
        ctx.strokeStyle = color;
        ctx.lineWidth = item.width;
        if (item.highlighter) {
          ctx.globalAlpha = 0.4;
          ctx.globalCompositeOperation = dark ? "screen" : "multiply";
        }
        ctx.stroke(path);
        break;
      }
      case "shape": {
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        ctx.lineWidth = item.width;
        ctx.lineCap = ctx.lineJoin = "round";
        const inset = item.width / 2;
        if (item.shape == "line" || item.shape == "arrow") {
          const [x1, y1, x2, y2] = lineEnds(item);
          ctx.translate(item.x, item.y);
          ctx.beginPath();
          ctx.moveTo(x1, y1);
          ctx.lineTo(x2, y2);
          ctx.stroke();
          if (item.shape == "arrow") {
            const [a, b] = arrowHead(x1, y1, x2, y2, item.width);
            ctx.beginPath();
            ctx.moveTo(...a);
            ctx.lineTo(x2, y2);
            ctx.lineTo(...b);
            ctx.stroke();
          }
          break;
        }
        if (item.shape == "ellipse") {
          ctx.beginPath();
          ctx.ellipse(item.x + item.w / 2, item.y + item.h / 2, Math.max(0, item.w / 2 - inset), Math.max(0, item.h / 2 - inset), 0, 0, Math.PI * 2);
        } else {
          roundRect(ctx, item.x + inset, item.y + inset, item.w - item.width, item.h - item.width, 8);
        }
        if (item.fill == "solid" || item.fill == "tint") {
          ctx.globalAlpha = item.fill == "tint" ? 0.18 : 1;
          ctx.fill();
          ctx.globalAlpha = 1;
        }
        ctx.stroke();
        break;
      }
      case "image":
      case "capture": {
        const img = images.get(item.type == "image" ? item.src : item.image);
        roundRect(ctx, item.x, item.y, item.w, item.h, item.type == "capture" ? 10 : 6);
        ctx.clip();
        if (img) {
          ctx.drawImage(img, item.x, item.y, item.w, item.h);
        } else {
          ctx.fillStyle = CARD[dark ? 1 : 0];
          ctx.fill();
        }
        break;
      }
      case "link": {
        roundRect(ctx, item.x, item.y, item.w, item.h, 12);
        ctx.fillStyle = CARD[dark ? 1 : 0];
        ctx.fill();
        ctx.strokeStyle = dark ? "rgb(255 255 255 / 0.12)" : "rgb(0 0 0 / 0.1)";
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.clip();
        ctx.textBaseline = "top";
        ctx.fillStyle = colorValue("ink", dark);
        ctx.font = `600 15px ${FONTS.sans}`;
        ctx.fillText(item.title || item.url, item.x + 16, item.y + 17, item.w - 32);
        ctx.fillStyle = CARD_TEXT_MUTED[dark ? 1 : 0];
        ctx.font = `450 13px ${FONTS.sans}`;
        let host = item.url;
        try {
          host = new URL(item.url).host;
        } catch {}
        ctx.fillText(host, item.x + 16, item.y + 41, item.w - 32);
        break;
      }
    }
    ctx.restore();
  }
}

export const EXPORT_PADDING = 48;
export const EXPORT_MAX = 8192;

// The export canvas size and scale for a set of items.
export function exportGeometry(items, scale = 2) {
  const bounds = boundsOf(items) ?? { x: 0, y: 0, w: 320, h: 200 };
  const box = {
    x: bounds.x - EXPORT_PADDING,
    y: bounds.y - EXPORT_PADDING,
    w: bounds.w + EXPORT_PADDING * 2,
    h: bounds.h + EXPORT_PADDING * 2,
  };
  const s = Math.min(scale, EXPORT_MAX / box.w, EXPORT_MAX / box.h);
  return { box, scale: s, width: Math.max(1, Math.round(box.w * s)), height: Math.max(1, Math.round(box.h * s)) };
}
