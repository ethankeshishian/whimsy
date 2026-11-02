/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W13-R3: a call page's own microphone and camera toggles (Google Meet), the
// single source of truth for the call controls in the small player under the
// tab bar and in picture-in-picture. Content side only: WhimsyPageChild calls
// these on the page; WhimsyCallPip (chrome) never keeps a state of its own.
// Design: whimsy-handoff/wave13/r3-meetpip-design.md.
//
// What Meet exposes (also what third-party Meet tools rely on; checked live
// only by hand, Meet needs a login):
// - one toggle per device, a button (or role=button) with
//   data-is-muted="true|false" ("true" = that device is off);
// - its aria-label / data-tooltip names the device ("Turn off microphone
//   (⌘ + d)", "Turn off camera (⌘ + e)"); the shortcut letter tells them apart
//   in other languages;
// - ⌘D / ⌘E (Ctrl elsewhere) are handled by the page and change the same
//   attribute.
// Not used: MediaStreamTrack.enabled (unreachable without hooking the page's
// getUserMedia, and Meet may mute by other means) and aria-pressed (its
// polarity isn't stable for a mute toggle).

export const KINDS = ["mic", "camera"];

const MIC_WORDS = /micro|\bmic\b|mikro/i;
const CAMERA_WORDS = /camera|cam[ée]ra|c[áa]mara|kamera|\bvideo|vid[ée]o/i;
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

// B14: what's never yours. Meet also draws other people's microphones and
// cameras with data-is-muted and a device name: the People panel's rows,
// host controls ("Ask everyone to turn on their microphone", "for all
// participants"), requests to unmute, and labels naming someone ("Alex's
// microphone"). dev.1100 pressed those. A candidate inside one of these
// places, or with one of these words, is skipped.
const NOT_YOURS = "[role=dialog], [role=list], [role=listitem], aside, [data-participant-id], [data-requested-participant-id]";
const NOT_YOURS_WORDS = /\b(everyone|all|ask|request|participants?)\b|\w['\u2019]s\b/i;

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

// { mic, camera }: your own toggle for each device, or null. Among several
// (Meet's green room and its call bar during the join): one with Meet's
// shortcut hint ("+ d)" / "+ e)") first, then one with a layout box, then
// the last in the document. The two must sit in one call bar: a nearest
// common ancestor that's the page itself, or that holds other device
// toggles, means they're not one bar, and neither is used.
export function findControls(doc) {
  const found = { mic: null, camera: null };
  if (!doc) {
    return found;
  }
  const rank = (el, kind) =>
    ((kind == "mic" ? MIC_HINT : CAMERA_HINT).test(labelOf(el)) ? 2 : 0) + (el.getClientRects().length > 0 ? 1 : 0);
  for (const el of doc.querySelectorAll("[data-is-muted]")) {
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
  if (found.mic && found.camera) {
    const bar = commonAncestor(found.mic, found.camera);
    const others = bar
      ? [...bar.querySelectorAll("[data-is-muted]")].filter(el => el != found.mic && el != found.camera && isButton(el) && kindOf(el))
      : [];
    if (!bar || bar == doc.body || bar == doc.documentElement || others.length) {
      return { mic: null, camera: null };
    }
  }
  return found;
}

function stateOf(el) {
  const value = el?.getAttribute("data-is-muted");
  if (value == "true") {
    return "off";
  }
  if (value == "false") {
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
// attribute changed, or one was added or removed. (Meet re-renders its
// speaking rings and tiles all the time; those are skipped.)
export function isRelevant(records) {
  const touches = node =>
    node?.nodeType == 1 && (node.hasAttribute("data-is-muted") || !!node.querySelector?.("[data-is-muted]"));
  for (const record of records) {
    if (record.type == "attributes") {
      if (record.attributeName == "data-is-muted" || record.target.hasAttribute?.("data-is-muted")) {
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
export const WhimsyMeetControls = { KINDS, kindOf, findControls, readState, isRelevant, press };
