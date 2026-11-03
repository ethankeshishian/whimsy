/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W13-R3/W21: a call page's own microphone and camera toggles (Google Meet,
// Zoom, Teams, Webex, ...), the single source of truth for the in-call mute
// in the small player under the tab bar and in picture-in-picture. Content
// side only: WhimsyPageChild calls these on the page; WhimsyCallPip (chrome)
// never keeps a state of its own. Design: whimsy-handoff/wave13/r3-meetpip-
// design.md, extended by whimsy-handoff/wave13/design/call-controls-v2.
//
// The rule, general to any call page: a toolbar holding one mic and one
// camera toggle with a pressed or muted state (aria-pressed or
// data-is-muted). What Meet, Zoom's web client, Teams and Webex all expose
// (checked live only by hand, each needs a login):
// - one toggle per device, a button (or role=button) with
//   data-is-muted="true|false" ("true" = that device is off), or, failing
//   that, aria-pressed="true|false" (pressed = muted);
// - its aria-label / data-tooltip / title names the device ("Turn off
//   microphone (⌘ + d)", "mute my microphone", "Mute"); a shortcut hint
//   ("+ d)" / "+ e)") tells mic and camera apart in other languages, where
//   present;
// Not used: MediaStreamTrack.enabled (unreachable without hooking the
// page's getUserMedia, and a call page may mute by other means).

export const KINDS = ["mic", "camera"];

const MIC_WORDS = /micro|\bmic\b|mikro/i;
const CAMERA_WORDS = /camera|cam[ée]ra|c[áa]mara|kamera|\bvideo|vid[ée]o/i;
// A toggle labelled just "Mute"/"Unmute" (no device word): some call pages
// (Teams) only name the microphone this way, leaning on it being the only
// unnamed mute toggle in the bar. kindOf alone can't tell this from a
// camera's own toggle, so findControls resolves it by elimination below.
const MUTE_WORDS = /^(un)?mute$/i;
const MIC_HINT = /\+\s*d\s*\)/i;
const CAMERA_HINT = /\+\s*e\s*\)/i;

function isButton(el) {
  return el.localName == "button" || el.getAttribute("role") == "button";
}

function labelOf(el) {
  return [el.getAttribute("aria-label"), el.getAttribute("data-tooltip"), el.getAttribute("title")]
    .filter(Boolean)
    .join(" ");
}

// "mic", "camera" or null when the label doesn't say (never guessed).
export function kindOf(el) {
  const label = labelOf(el);
  const mic = MIC_WORDS.test(label);
  const camera = CAMERA_WORDS.test(label);
  if (mic != camera) {
    return mic ? "mic" : "camera";
  }
  const micHint = MIC_HINT.test(label);
  const cameraHint = CAMERA_HINT.test(label);
  if (micHint != cameraHint) {
    return micHint ? "mic" : "camera";
  }
  return null;
}

// B14: what's never yours. A call page also draws other people's
// microphones and cameras with the same state attribute and a device name:
// the People panel's rows, host controls ("Ask everyone to turn on their
// microphone", "for all participants"), requests to unmute, and labels
// naming someone ("Alex's microphone"). dev.1100 pressed those. A candidate
// inside one of these places, or with one of these words, is skipped.
const NOT_YOURS = "[role=dialog], [role=list], [role=listitem], aside, [data-participant-id], [data-requested-participant-id]";
const NOT_YOURS_WORDS = /\b(everyone|all|ask|request|participants?)\b|\w['’]s\b/i;

function isYours(el) {
  if (el.closest(NOT_YOURS)) {
    return false;
  }
  return !NOT_YOURS_WORDS.test(labelOf(el));
}

// The nearest element containing both.
function commonAncestor(a, b) {
  for (let node = a.parentElement; node; node = node.parentElement) {
    if (node.contains(b)) {
      return node;
    }
  }
  return null;
}

// A toggle candidate: data-is-muted, or (failing that) aria-pressed, which
// a mute toggle uses with the conventional polarity "pressed = muted".
const CANDIDATE_SELECTOR = "[data-is-muted], [aria-pressed]";

// { mic, camera }: your own toggle for each device, or null. Among several
// (a join screen and the call bar during it): one with a shortcut hint
// ("+ d)" / "+ e)") first, then one with a layout box, then the last in the
// document. The two must sit in one call bar: a nearest common ancestor
// that's the page itself, or that holds other device toggles, means
// they're not one bar, and neither is used.
export function findControls(doc) {
  const found = { mic: null, camera: null };
  if (!doc) {
    return found;
  }
  const rank = (el, kind) =>
    ((kind == "mic" ? MIC_HINT : CAMERA_HINT).test(labelOf(el)) ? 2 : 0) + (el.getClientRects().length > 0 ? 1 : 0);
  for (const el of doc.querySelectorAll(CANDIDATE_SELECTOR)) {
    if (!isButton(el) || !isYours(el)) {
      continue;
    }
    const kind = kindOf(el);
    if (!kind) {
      continue;
    }
    const current = found[kind];
    if (!current || rank(el, kind) >= rank(current, kind)) {
      found[kind] = el;
    }
  }
  // By elimination: the only other candidate in the known one's bar, with a
  // bare "Mute"/"Unmute" label (no device word of its own), is the mic.
  if (found.camera && !found.mic) {
    const bar = found.camera.parentElement;
    const rest = bar
      ? [...bar.querySelectorAll(CANDIDATE_SELECTOR)].filter(el => el != found.camera && isButton(el) && isYours(el) && !kindOf(el))
      : [];
    if (rest.length == 1 && MUTE_WORDS.test(labelOf(rest[0]))) {
      found.mic = rest[0];
    }
  }
  if (found.mic && found.camera) {
    const bar = commonAncestor(found.mic, found.camera);
    const others = bar
      ? [...bar.querySelectorAll(CANDIDATE_SELECTOR)].filter(el => el != found.mic && el != found.camera && isButton(el) && kindOf(el))
      : [];
    if (!bar || bar == doc.body || bar == doc.documentElement || others.length) {
      return { mic: null, camera: null };
    }
  }
  return found;
}

function stateOf(el) {
  if (!el) {
    return null;
  }
  const muted = el.getAttribute("data-is-muted");
  if (muted == "true") {
    return "off";
  }
  if (muted == "false") {
    return "on";
  }
  const pressed = el.getAttribute("aria-pressed");
  if (pressed == "true") {
    return "off";
  }
  if (pressed == "false") {
    return "on";
  }
  return null;
}

// { mic, camera }: "on", "off" or null (unknown).
export function readState(doc) {
  const controls = findControls(doc);
  return { mic: stateOf(controls.mic), camera: stateOf(controls.camera) };
}

// Whether a batch of mutations can have changed readState(): a toggle's
// state attribute changed, or one was added or removed. (A call page
// re-renders its speaking rings and tiles all the time; those are skipped.)
export function isRelevant(records) {
  const touches = node =>
    node?.nodeType == 1 &&
    (node.hasAttribute("data-is-muted") || node.hasAttribute("aria-pressed") ||
      !!node.querySelector?.(CANDIDATE_SELECTOR));
  for (const record of records) {
    if (record.type == "attributes") {
      if (
        record.attributeName == "data-is-muted" ||
        record.attributeName == "aria-pressed" ||
        record.target.hasAttribute?.("data-is-muted") ||
        record.target.hasAttribute?.("aria-pressed")
      ) {
        return true;
      }
    } else if ([...record.addedNodes].some(touches) || [...record.removedNodes].some(touches)) {
      return true;
    }
  }
  return false;
}

// Presses the page's toggle. Called from this (system) actor, click() is a
// trusted click (nsGenericHTMLElement::Click marks it trusted for system
// callers, "positionless"): it needs no layout, so it works the same for a
// call in a background tab, which a synthesized mouse press at the button's
// centre didn't (a hidden tab's input arrived late or not at all, and the
// fallback click then made it toggle twice). Returns "trusted".
export function press(win, el) {
  el.click();
  return "trusted";
}

// The module's API as one object (the name WhimsyPageChild's lazy getter
// imports).
export const WhimsyCallControls = { KINDS, kindOf, findControls, readState, isRelevant, press };
