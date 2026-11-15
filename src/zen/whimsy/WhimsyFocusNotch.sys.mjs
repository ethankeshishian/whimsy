/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W29 focus sessions: the countdown notch (focus-wellbeing.md §3–4).
//
// A notch carved into the page's top-right corner, filled with the window
// background, with concave fillets at the page's corner radius: a 12px pie
// emptying like the dial's wedge, and m:ss in tabular figures. Each digit
// that changes slides down and fades (in place with Reduce Motion); under a
// minute the digits take the accent. Click (or Enter) opens a small panel:
// when it ends, what the session turned on, and End session.
//
// The finish: "Done" with a check, confetti over the page (not with Reduce
// Motion or in fullscreen video), then the notch slides up into the frame.
//
// One notch per window; the session (WhimsyFocusSession) attaches and
// detaches them. role="timer" with an aria-label updated each minute, so
// screen readers aren't flooded.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsySurface: "resource:///modules/whimsy/WhimsySurface.sys.mjs",
});

const XHTML = "http://www.w3.org/1999/xhtml";
export const NOTCH_ID = "whimsy-focus-notch";
const PANEL_ID = "whimsy-focus-notch-panel";
const SLIDE_MS = 320;
const DIGIT_MS = 280;

// The confetti: the space colour plus six bright neighbours.
const COLORS = ["#0a84ff", "#5e5ce6", "#bf5af2", "#ff375f", "#ff9f0a", "#ffd60a", "#30d158"];
const CONFETTI_MS = 1900;

// Per window: { notch, timer, session, lastMinute }.
const state = new WeakMap();

function reducedMotion(win) {
  return !!win.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function shortTime(ms) {
  return new Intl.DateTimeFormat(undefined, { timeStyle: "short" }).format(new Date(ms));
}

function el(doc, tag, className) {
  const node = doc.createElementNS(XHTML, tag);
  if (className) {
    node.className = className;
  }
  return node;
}

export const WhimsyFocusNotch = {
  NOTCH_ID,
  PANEL_ID,

  get(win) {
    return state.get(win)?.notch ?? null;
  },

  /** Shows the countdown in `win` (once). */
  attach(win, session) {
    const doc = win.document;
    const tabbox = doc.getElementById("tabbrowser-tabbox");
    if (!tabbox) {
      return null;
    }
    this.detach(win, { instant: true });
    const notch = el(doc, "div", "whimsy-focus-notch");
    notch.id = NOTCH_ID;
    notch.setAttribute("role", "timer");
    notch.setAttribute("tabindex", "0");
    const pie = el(doc, "span", "whimsy-focus-pie");
    pie.setAttribute("aria-hidden", "true");
    const time = el(doc, "span", "whimsy-focus-time");
    time.setAttribute("aria-hidden", "true");
    const done = el(doc, "span", "whimsy-focus-done");
    const check = el(doc, "img", "whimsy-focus-done-icon");
    check.setAttribute("src", "chrome://global/skin/icons/check.svg");
    check.setAttribute("alt", "");
    const doneText = el(doc, "span");
    doc.l10n.setAttributes(doneText, "whimsy-focus-done");
    done.append(check, doneText);
    notch.append(pie, time, done);
    notch.addEventListener("click", () => this.openPanel(win));
    notch.addEventListener("keydown", event => {
      if (event.key == "Enter" || event.key == " ") {
        event.preventDefault();
        this.openPanel(win);
      }
    });
    tabbox.append(notch);
    doc.documentElement.setAttribute("whimsy-focus", "true");

    const entry = { notch, timer: null, session, lastMinute: null };
    state.set(win, entry);
    this.tick(win);
    win.addEventListener("unload", () => this.stop(win), { once: true });
    return notch;
  },

  stop(win) {
    const entry = state.get(win);
    if (entry?.timer) {
      win.clearTimeout(entry.timer);
      entry.timer = null;
    }
  },

  /** Takes the countdown away (ended early, or after the finish). */
  detach(win, { instant = false } = {}) {
    const entry = state.get(win);
    if (!entry) {
      return;
    }
    this.stop(win);
    state.delete(win);
    const doc = win.document;
    lazy.WhimsySurface.close(doc.getElementById(PANEL_ID));
    doc.documentElement.removeAttribute("whimsy-focus");
    doc.documentElement.style.removeProperty("--whimsy-focus-notch-bottom");
    const notch = entry.notch;
    if (instant || reducedMotion(win)) {
      notch.remove();
      return;
    }
    notch.classList.add("is-gone");
    win.setTimeout(() => notch.remove(), SLIDE_MS);
  },

  /** The time is up: Done, confetti (in one window), then away. */
  celebrate(win, { confetti = false, holdMs = 1500 } = {}) {
    const entry = state.get(win);
    if (!entry) {
      return;
    }
    this.stop(win);
    lazy.WhimsySurface.close(win.document.getElementById(PANEL_ID));
    entry.notch.classList.remove("is-last");
    entry.notch.classList.add("is-done");
    entry.notch.removeAttribute("aria-label");
    entry.notch.removeAttribute("data-l10n-id");
    entry.notch.removeAttribute("data-l10n-args");
    entry.notch.setAttribute("role", "status");
    if (confetti) {
      this.confetti(win, entry.notch);
    }
    win.setTimeout(() => this.detach(win), holdMs);
  },

  // --- the countdown -------------------------------------------------------

  tick(win) {
    const entry = state.get(win);
    if (!entry || win.closed) {
      return;
    }
    const { notch, session } = entry;
    const endsAt = session.endsAt;
    const left = Math.max(0, endsAt - Date.now());
    const secs = Math.ceil(left / 1000);
    this.render(win, notch, secs, left / Math.max(1, session.totalMs));
    const minutes = Math.ceil(secs / 60);
    if (minutes != entry.lastMinute) {
      entry.lastMinute = minutes;
      win.document.l10n.setAttributes(notch, "whimsy-focus-notch", { time: shortTime(endsAt), minutes });
    }
    // Toasts start below the notch while it's there.
    const bottom = notch.getBoundingClientRect().bottom;
    win.document.documentElement.style.setProperty("--whimsy-focus-notch-bottom", `${Math.round(bottom)}px`);
    if (left > 0) {
      // On the next second boundary of the time left.
      entry.timer = win.setTimeout(() => this.tick(win), (left % 1000) || 1000);
    }
  },

  render(win, notch, secs, fraction) {
    const doc = win.document;
    const text = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
    notch.querySelector(".whimsy-focus-pie").style.setProperty("--p", String(Math.max(0, Math.min(1, fraction))));
    notch.classList.toggle("is-last", secs < 60);
    const box = notch.querySelector(".whimsy-focus-time");
    while (box.children.length < text.length) {
      const ch = el(doc, "span", "whimsy-focus-ch");
      ch.append(el(doc, "i"));
      box.prepend(ch);
    }
    while (box.children.length > text.length) {
      box.firstElementChild.remove();
    }
    const still = reducedMotion(win);
    [...box.children].forEach((ch, i) => {
      const next = text[i];
      ch.classList.toggle("is-colon", next == ":");
      const cur = ch.querySelector("i:not(.is-out)");
      if (cur.textContent == next) {
        return;
      }
      if (still || cur.textContent == "") {
        cur.textContent = next;
        return;
      }
      const incoming = el(doc, "i", "is-in");
      incoming.textContent = next;
      ch.append(incoming);
      cur.classList.add("is-out");
      win.requestAnimationFrame(() => win.requestAnimationFrame(() => incoming.classList.remove("is-in")));
      win.setTimeout(() => cur.remove(), DIGIT_MS + 20);
    });
  },

  // --- the panel -------------------------------------------------------------

  async openPanel(win) {
    const entry = state.get(win);
    if (!entry || entry.notch.classList.contains("is-done")) {
      return null;
    }
    const S = lazy.WhimsySurface;
    const doc = win.document;
    if (S.isOpen(win, PANEL_ID)) {
      S.close(doc.getElementById(PANEL_ID));
      return null;
    }
    const session = entry.session;
    const parts = S.create(win, {
      id: PANEL_ID,
      width: 240,
      titleL10nId: "whimsy-focus-sheet-title",
      footer: true,
    });
    const text = el(doc, "p", "whimsy-focus-panel-text");
    text.id = `${PANEL_ID}-text`;
    parts.panel.setAttribute("aria-describedby", text.id);
    const time = shortTime(session.endsAt);
    const list = await this.ticksList(doc, session);
    if (list) {
      doc.l10n.setAttributes(text, "whimsy-focus-panel-text", { time, list });
    } else {
      doc.l10n.setAttributes(text, "whimsy-focus-panel-ends", { time });
    }
    parts.view.append(text);
    parts.footer.append(
      S.footerButton(doc, {
        l10nId: "whimsy-focus-end-session",
        primary: true,
        id: `${PANEL_ID}-end`,
        onCommand: () => {
          S.close(parts.panel);
          session.end();
        },
      })
    );
    S.finish(parts);
    S.open(win, parts.panel, { anchor: entry.notch, position: "after_end" });
    return parts;
  },

  /** "Do Not Disturb is on, and 28 sites are paused" (only what's ticked). */
  async ticksList(doc, session) {
    const ticks = session.ticks;
    const ids = [];
    if (ticks.dnd) {
      ids.push({ id: "whimsy-focus-panel-dnd" });
    }
    if (ticks.pauseSites) {
      ids.push({ id: "whimsy-focus-panel-sites", args: { count: session.pausedSites.length } });
    }
    if (ticks.muteBackground) {
      ids.push({ id: "whimsy-focus-panel-mute" });
    }
    if (ticks.breakReminder) {
      ids.push({ id: "whimsy-focus-panel-break", args: { minutes: session.BREAK_MINUTES } });
    }
    if (!ids.length) {
      return "";
    }
    const parts = await doc.l10n.formatValues(ids);
    let list;
    if (parts.length == 1) {
      list = parts[0];
    } else if (parts.length == 2) {
      list = await doc.l10n.formatValue("whimsy-focus-panel-pair", { first: parts[0], second: parts[1] });
    } else {
      list = new Intl.ListFormat(undefined, { type: "conjunction" }).format(parts);
    }
    return list.charAt(0).toUpperCase() + list.slice(1);
  },

  // --- confetti ----------------------------------------------------------------

  /** ~90 pieces burst from the notch and fall over the page. */
  confetti(win, notch) {
    const doc = win.document;
    if (reducedMotion(win) || doc.documentElement.hasAttribute("inDOMFullscreen")) {
      return null;
    }
    const tabbox = doc.getElementById("tabbrowser-tabbox");
    const canvas = el(doc, "canvas", "whimsy-focus-confetti");
    canvas.setAttribute("aria-hidden", "true");
    tabbox.append(canvas);
    const r = tabbox.getBoundingClientRect();
    const c = notch.getBoundingClientRect();
    const dpr = win.devicePixelRatio || 1;
    canvas.width = r.width * dpr;
    canvas.height = r.height * dpr;
    const g = canvas.getContext("2d");
    g.scale(dpr, dpr);
    const accent = win.getComputedStyle(doc.documentElement).getPropertyValue("--zen-primary-color").trim();
    const colors = accent ? [accent, ...COLORS] : COLORS;
    const ox = c.left - r.left + c.width / 2;
    const oy = c.bottom - r.top - 4;
    const pieces = Array.from({ length: 90 }, () => {
      const a = Math.PI * (0.55 + Math.random() * 0.75);
      const s = 3 + Math.random() * 5.5;
      return {
        x: ox,
        y: oy,
        vx: Math.cos(a) * s,
        vy: Math.sin(a) * s * 0.9 + 1,
        w: 4 + Math.random() * 4,
        h: 6 + Math.random() * 5,
        rot: Math.random() * 6,
        vr: (Math.random() - 0.5) * 0.4,
        color: colors[Math.floor(Math.random() * colors.length)],
      };
    });
    const t0 = win.performance.now();
    const frame = now => {
      const t = now - t0;
      g.clearRect(0, 0, r.width, r.height);
      for (const p of pieces) {
        p.vy += 0.16;
        p.vx *= 0.985;
        p.vy *= 0.985;
        p.x += p.vx;
        p.y += p.vy;
        p.rot += p.vr;
        g.save();
        g.globalAlpha = Math.max(0, 1 - t / CONFETTI_MS);
        g.translate(p.x, p.y);
        g.rotate(p.rot);
        g.fillStyle = p.color;
        g.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(p.rot * 1.7)));
        g.restore();
      }
      if (t < CONFETTI_MS && !win.closed) {
        win.requestAnimationFrame(frame);
      } else {
        canvas.remove();
      }
    };
    win.requestAnimationFrame(frame);
    return canvas;
  },
};
