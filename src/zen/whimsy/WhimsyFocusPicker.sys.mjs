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
// The picker that ships is R, the Selector (intake-w29/designs/
// focus-clocks.md, round 3): a chicken-head rotary switch on a 270° scale.
// Dragging clunks it into each 5-minute stop on a stiff spring (900/22);
// keys and the wheel move it a minute at a time on the settle spring
// (400/40). The knob scales to 0.96 while held. Reduce Motion jumps.
//
// Option A of W28, the dial (intake-w28/designs/focus-wellbeing.md §1), is
// kept as a fallback kind: Time Timer's wedge in the space's accent.
//
// The countdown notch doesn't reuse a picker's drawing (owner, W29).

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
    const time = new Intl.DateTimeFormat(undefined, { timeStyle: "short" }).format(new Date(Date.now() + current * 60000));
    doc.l10n.formatValue("whimsy-focus-length-spoken", { minutes: current, time }).then(text => {
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

// --- R · the Selector ---------------------------------------------------------

const SEL_W = 240;
const SEL_H = 204;
const SEL_X = 120; // the hub, in the 240×204 viewBox
const SEL_Y = 100;
const SEL_SWEEP = 270;
const SEL_STOP = 5; // a drag lands on every fifth minute

const selAngle = v => -SEL_SWEEP / 2 + (v / MAX_MINUTES) * SEL_SWEEP;
const selPoint = (deg, r) => {
  const a = (deg * Math.PI) / 180;
  return [SEL_X + r * Math.sin(a), SEL_Y - r * Math.cos(a)];
};

/**
 * One spring (stiffness k, damping c; four substeps a frame). It asks for
 * frames only while it moves, so an idle picker costs nothing.
 */
class Spring {
  constructor(win, x, draw) {
    this.win = win;
    this.x = this.target = x;
    this.v = 0;
    this.k = 400;
    this.c = 40;
    this.draw = draw;
    this.frame = 0;
    draw(x);
  }
  get moving() {
    return !!this.frame;
  }
  to(target, { k, c }) {
    this.target = target;
    this.k = k;
    this.c = c;
    if (!this.frame) {
      this.last = this.win.performance.now();
      this.frame = this.win.requestAnimationFrame(this.step);
    }
  }
  jump(target) {
    if (this.frame) {
      this.win.cancelAnimationFrame(this.frame);
      this.frame = 0;
    }
    this.x = this.target = target;
    this.v = 0;
    this.draw(target);
  }
  step = now => {
    const dt = Math.min(0.034, Math.max(0, now - this.last) / 1000);
    this.last = now;
    for (let i = 0; i < 4; i++) {
      const a = -this.k * (this.x - this.target) - this.c * this.v;
      this.v += (a * dt) / 4;
      this.x += (this.v * dt) / 4;
    }
    if (Math.abs(this.v) < 0.02 && Math.abs(this.x - this.target) < 0.002) {
      this.frame = 0;
      this.jump(this.target);
      return;
    }
    this.draw(this.x);
    this.frame = this.win.requestAnimationFrame(this.step);
  };
}

function createSelector(doc, { value, onChange }) {
  const el = doc.createElementNS(XHTML, "div");
  el.className = "whimsy-focus-picker whimsy-focus-selector";
  const face = svg(doc, "svg", { viewBox: `0 0 ${SEL_W} ${SEL_H}`, "aria-hidden": "true" });
  for (let m = 0; m <= MAX_MINUTES; m += SEL_STOP) {
    const quarter = m % 15 == 0;
    const [x1, y1] = selPoint(selAngle(m), quarter ? 77 : 80);
    const [x2, y2] = selPoint(selAngle(m), quarter ? 88 : 86);
    face.append(
      svg(doc, "line", {
        class: "whimsy-focus-selector-tick" + (quarter ? " is-15" : ""),
        x1: x1.toFixed(2),
        y1: y1.toFixed(2),
        x2: x2.toFixed(2),
        y2: y2.toFixed(2),
      })
    );
    if (quarter && m) {
      const [x, y] = selPoint(selAngle(m), 100);
      const label = svg(doc, "text", { class: "whimsy-focus-selector-label", x: x.toFixed(2), y: y.toFixed(2) });
      label.textContent = String(m);
      face.append(label);
    }
  }
  const knob = svg(doc, "g", { class: "whimsy-focus-selector-knob" });
  const rot = svg(doc, "g", { class: "whimsy-focus-selector-rot" });
  rot.append(
    svg(doc, "circle", { class: "whimsy-focus-selector-base", cx: SEL_X, cy: SEL_Y, r: 50 }),
    svg(doc, "circle", { class: "whimsy-focus-selector-knurl", cx: SEL_X, cy: SEL_Y, r: 46 }),
    svg(doc, "path", {
      class: "whimsy-focus-selector-head",
      d: "M120 32C129 36 139 74 139 102C139 124 131 134 120 134C109 134 101 124 101 102C101 74 111 36 120 32Z",
    }),
    svg(doc, "line", { class: "whimsy-focus-selector-line", x1: SEL_X, y1: 40, x2: SEL_X, y2: 86 }),
    svg(doc, "circle", { class: "whimsy-focus-selector-cap", cx: SEL_X, cy: 108, r: 9 })
  );
  knob.append(rot);
  face.append(knob);

  const read = doc.createElementNS(XHTML, "div");
  read.className = "whimsy-focus-selector-read";
  read.setAttribute("aria-hidden", "true");
  const big = doc.createElementNS(XHTML, "b");
  big.className = "whimsy-focus-selector-value";
  const unit = doc.createElementNS(XHTML, "span");
  doc.l10n.setAttributes(unit, "whimsy-focus-min");
  read.append(big, unit);
  el.append(face, read);

  const spring = new Spring(doc.defaultView, selAngle(clamp(Math.round(value || 25), MIN_MINUTES, MAX_MINUTES)), a =>
    rot.setAttribute("transform", `rotate(${a.toFixed(2)} ${SEL_X} ${SEL_Y})`)
  );
  // How the next value arrives: "jump" (first draw, or set from outside),
  // "drag" (the stiff detent), or "settle" (keys and the wheel).
  let source = "jump";
  const render = v => {
    big.textContent = String(v);
    if (source == "jump" || reducedMotion(doc)) {
      spring.jump(selAngle(v));
    } else {
      spring.to(selAngle(v), source == "drag" ? { k: 900, c: 22 } : { k: 400, c: 40 });
    }
  };
  const api = wireSlider(el, { value, onChange, render, bumpTarget: big });
  source = "settle";

  // The pointer's angle around the hub, clamped to the scale, rounded to a
  // stop. The hub is found in the picker's own box, so zoom doesn't matter.
  const stopAt = event => {
    const r = face.getBoundingClientRect();
    const dx = event.clientX - (r.left + (r.width * SEL_X) / SEL_W);
    const dy = event.clientY - (r.top + (r.height * SEL_Y) / SEL_H);
    const deg = clamp((Math.atan2(dx, -dy) * 180) / Math.PI, -SEL_SWEEP / 2, SEL_SWEEP / 2);
    const v = Math.round((((deg + SEL_SWEEP / 2) / SEL_SWEEP) * MAX_MINUTES) / SEL_STOP) * SEL_STOP;
    return clamp(v, SEL_STOP, MAX_MINUTES);
  };
  const drag = (event, first) => {
    const v = stopAt(event);
    // Across the gap at the bottom the pointer flips between the ends;
    // the end stops hold it instead.
    if (!first && Math.abs(v - api.get()) > 60) {
      return;
    }
    source = "drag";
    api.set(v);
    source = "settle";
  };
  let dragging = false;
  el.addEventListener("pointerdown", event => {
    if (event.button != 0) {
      return;
    }
    dragging = true;
    el.classList.add("is-held");
    el.setPointerCapture(event.pointerId);
    el.focus({ focusVisible: false });
    drag(event, true);
  });
  el.addEventListener("pointermove", event => dragging && drag(event, false));
  const stop = () => {
    dragging = false;
    el.classList.remove("is-held");
  };
  el.addEventListener("pointerup", stop);
  el.addEventListener("pointercancel", stop);
  el.addEventListener("lostpointercapture", stop);

  return {
    element: el,
    get value() {
      return api.get();
    },
    set value(v) {
      source = "jump";
      api.set(v, { quiet: true });
      source = "settle";
    },
    /** True while the knob is still moving (frames are being asked for). */
    get moving() {
      return spring.moving;
    },
    focus() {
      el.focus();
    },
  };
}

// The pickers by name; the sheet uses DEFAULT. A new picker is a function
// (doc, { value, onChange }) → { element, value, focus } added here.
const PICKERS = {
  selector: createSelector,
  dial: createDial,
};
const DEFAULT = "selector";

export const WhimsyFocusPicker = {
  MIN_MINUTES,
  MAX_MINUTES,

  /**
   * @param {Document} doc
   * @param {object} options
   * @param {number} options.value - minutes
   * @param {Function} [options.onChange] - called with the new minutes
   * @param {string} [options.kind] - a picker name (default: the Selector)
   * @returns {{element: Element, value: number, focus: Function}}
   */
  create(doc, { value, onChange = null, kind = DEFAULT } = {}) {
    return (PICKERS[kind] ?? PICKERS[DEFAULT])(doc, { value, onChange });
  },
};
