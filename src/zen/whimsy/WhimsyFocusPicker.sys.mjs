/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W29 focus sessions: the length picker in the Focus session sheet.
//
// The sheet only knows this interface, so another picker can replace the
// dial without touching the session or the sheet:
//
//   const picker = WhimsyFocusPicker.create(doc, { value, onChange });
//   picker.element   // the node to put in the sheet (role="slider")
//   picker.value     // minutes, 1-120; setting it redraws without a bump
//   picker.focus()
//
// Every picker is a slider: arrows ±1, Shift+arrows ±5, PageUp/PageDown ±5,
// Home/End to the ends, and the scroll wheel. wireSlider() gives a picker
// all of that; the picker only draws.
//
// The one picker today is option A of the design, the dial
// (intake-w28/designs/focus-wellbeing.md §1): Time Timer's wedge in the
// space's accent. Drag the knob clockwise; ticks light up as minutes pass
// it; past 60 a second, deeper lap runs to 120. The number bumps on each
// minute (no bump with Reduce Motion).

const XHTML = "http://www.w3.org/1999/xhtml";
const SVG = "http://www.w3.org/2000/svg";

export const MIN_MINUTES = 1;
export const MAX_MINUTES = 120;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function reducedMotion(doc) {
  return !!doc.defaultView?.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * The slider behaviour every picker shares: the value, its ARIA state,
 * keys, the wheel, and the bump. `render(value)` draws; `bumpTarget` is the
 * node that bumps when the value changes.
 */
export function wireSlider(el, { value, onChange, render, bumpTarget = null }) {
  const doc = el.ownerDocument;
  let current = clamp(Math.round(value || 25), MIN_MINUTES, MAX_MINUTES);
  el.setAttribute("role", "slider");
  el.setAttribute("tabindex", "0");
  el.setAttribute("aria-valuemin", String(MIN_MINUTES));
  el.setAttribute("aria-valuemax", String(MAX_MINUTES));
  doc.l10n.setAttributes(el, "whimsy-focus-length");

  const set = (next, { quiet = false } = {}) => {
    next = clamp(Math.round(next), MIN_MINUTES, MAX_MINUTES);
    const changed = next != current;
    current = next;
    el.setAttribute("aria-valuenow", String(current));
    // Fluent would wipe the slider's children, so the spoken value is
    // formatted here, not bound with data-l10n-id.
    doc.l10n.formatValue("whimsy-focus-length-value", { minutes: current }).then(text => {
      if (current == next) {
        el.setAttribute("aria-valuetext", text);
      }
    });
    render(current);
    if (changed && !quiet && bumpTarget && !reducedMotion(doc)) {
      bumpTarget.classList.remove("is-bump");
      // Restart the animation on every minute.
      void bumpTarget.offsetWidth;
      bumpTarget.classList.add("is-bump");
    }
    if (changed) {
      onChange?.(current);
    }
  };

  el.addEventListener("keydown", event => {
    const step = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1, PageUp: 5, PageDown: -5 }[event.key];
    if (step) {
      event.preventDefault();
      event.stopPropagation();
      set(current + step * (event.shiftKey && Math.abs(step) == 1 ? 5 : 1));
    } else if (event.key == "Home" || event.key == "End") {
      event.preventDefault();
      event.stopPropagation();
      set(event.key == "Home" ? MIN_MINUTES : MAX_MINUTES);
    }
  });
  // A mouse wheel notch is one minute; a trackpad's small pixel deltas
  // add up to one.
  let wheel = 0;
  el.addEventListener(
    "wheel",
    event => {
      event.preventDefault();
      const line = event.deltaMode != event.DOM_DELTA_PIXEL;
      wheel += line ? Math.sign(event.deltaY) * 20 : event.deltaY;
      if (Math.abs(wheel) >= 20) {
        set(current - Math.sign(wheel));
        wheel = 0;
      }
    },
    { passive: false }
  );
  el.addEventListener("animationend", event => event.target.classList.remove("is-bump"));
  set(current, { quiet: true });
  return {
    get: () => current,
    set,
  };
}

// --- A · the dial -----------------------------------------------------------

const C = 100; // the centre, in the 200×200 viewBox
const WEDGE_R = 74;
const KNOB_R = 60;

const point = (angle, r) => [C + r * Math.sin(angle), C - r * Math.cos(angle)];

// The wedge for `m` minutes of one lap (a full disc at 60).
function arc(m) {
  if (m <= 0) {
    return "";
  }
  if (m >= 60) {
    return `M${C} ${C - WEDGE_R}A${WEDGE_R} ${WEDGE_R} 0 1 1 ${C - 0.01} ${C - WEDGE_R}Z`;
  }
  const [x, y] = point((m / 60) * 2 * Math.PI, WEDGE_R);
  return `M${C} ${C}L${C} ${C - WEDGE_R}A${WEDGE_R} ${WEDGE_R} 0 ${m > 30 ? 1 : 0} 1 ${x.toFixed(2)} ${y.toFixed(2)}Z`;
}

function svg(doc, name, attrs = {}) {
  const el = doc.createElementNS(SVG, name);
  for (const [k, v] of Object.entries(attrs)) {
    el.setAttribute(k, String(v));
  }
  return el;
}

function createDial(doc, { value, onChange }) {
  const el = doc.createElementNS(XHTML, "div");
  el.className = "whimsy-focus-picker whimsy-focus-dial";
  const face = svg(doc, "svg", { viewBox: "0 0 200 200", "aria-hidden": "true" });
  face.append(svg(doc, "circle", { class: "whimsy-focus-dial-face", cx: C, cy: C, r: 76 }));
  const ticks = [];
  for (let i = 0; i < 60; i++) {
    const a = (i / 60) * 2 * Math.PI;
    const major = i % 5 == 0;
    const [x1, y1] = point(a, major ? 80 : 84);
    const [x2, y2] = point(a, 90);
    const tick = svg(doc, "line", {
      class: "whimsy-focus-dial-tick" + (major ? " is-5" : ""),
      x1: x1.toFixed(2),
      y1: y1.toFixed(2),
      x2: x2.toFixed(2),
      y2: y2.toFixed(2),
    });
    ticks.push(tick);
    face.append(tick);
  }
  const wedge = svg(doc, "path", { class: "whimsy-focus-dial-wedge" });
  const wedge2 = svg(doc, "path", { class: "whimsy-focus-dial-wedge2" });
  const hub = svg(doc, "circle", { class: "whimsy-focus-dial-hub", cx: C, cy: C, r: 44 });
  const knob = svg(doc, "circle", { class: "whimsy-focus-dial-knob", r: 8, cx: C, cy: C - KNOB_R });
  face.append(wedge, wedge2, hub, knob);

  const center = doc.createElementNS(XHTML, "div");
  center.className = "whimsy-focus-dial-center";
  center.setAttribute("aria-hidden", "true");
  const big = doc.createElementNS(XHTML, "b");
  big.className = "whimsy-focus-dial-value";
  const unit = doc.createElementNS(XHTML, "span");
  doc.l10n.setAttributes(unit, "whimsy-focus-min");
  center.append(big, unit);
  el.append(face, center);

  const render = v => {
    wedge.setAttribute("d", arc(Math.min(v, 60)));
    wedge2.setAttribute("d", arc(Math.max(0, v - 60)));
    const [x, y] = point((((v % 60) || 60) / 60) * 2 * Math.PI, KNOB_R);
    knob.setAttribute("cx", x.toFixed(2));
    knob.setAttribute("cy", y.toFixed(2));
    ticks.forEach((t, i) => t.classList.toggle("on", v >= 60 || i < v));
    big.textContent = String(v);
  };
  const api = wireSlider(el, { value, onChange, render, bumpTarget: big });

  // Dragging: the angle gives the minute within a lap; crossing 12 o'clock
  // clockwise adds the second lap, anticlockwise takes it away.
  let lap = 0;
  let prev = 0;
  let dragging = false;
  const minuteAt = event => {
    const r = face.getBoundingClientRect();
    const dx = event.clientX - r.left - r.width / 2;
    const dy = event.clientY - r.top - r.height / 2;
    let a = Math.atan2(dx, -dy);
    if (a < 0) {
      a += 2 * Math.PI;
    }
    return (a / (2 * Math.PI)) * 60;
  };
  const move = event => {
    if (!dragging) {
      return;
    }
    const raw = minuteAt(event);
    if (prev > 45 && raw < 15) {
      lap++;
    } else if (prev < 15 && raw > 45) {
      lap--;
    }
    lap = clamp(lap, 0, 1);
    prev = raw;
    let v = lap * 60 + raw;
    if (lap == 0 && raw < 0.5 && api.get() > 30) {
      v = 60;
    }
    api.set(Math.max(MIN_MINUTES, v));
  };
  el.addEventListener("pointerdown", event => {
    if (event.button != 0) {
      return;
    }
    dragging = true;
    el.setPointerCapture(event.pointerId);
    el.focus({ focusVisible: false });
    lap = api.get() > 60 ? 1 : 0;
    prev = api.get() % 60;
    move(event);
  });
  el.addEventListener("pointermove", move);
  const stop = () => {
    dragging = false;
  };
  el.addEventListener("pointerup", stop);
  el.addEventListener("pointercancel", stop);

  return {
    element: el,
    get value() {
      return api.get();
    },
    set value(v) {
      api.set(v, { quiet: true });
    },
    focus() {
      el.focus();
    },
  };
}

// The pickers by name; the sheet uses DEFAULT. A new picker is a function
// (doc, { value, onChange }) → { element, value, focus } added here.
const PICKERS = {
  dial: createDial,
};
const DEFAULT = "dial";

export const WhimsyFocusPicker = {
  MIN_MINUTES,
  MAX_MINUTES,

  /**
   * @param {Document} doc
   * @param {object} options
   * @param {number} options.value - minutes
   * @param {Function} [options.onChange] - called with the new minutes
   * @param {string} [options.kind] - a picker name (default: the dial)
   * @returns {{element: Element, value: number, focus: Function}}
   */
  create(doc, { value, onChange = null, kind = DEFAULT } = {}) {
    return (PICKERS[kind] ?? PICKERS[DEFAULT])(doc, { value, onChange });
  },
};
