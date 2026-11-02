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

// { mic, camera }: the page's toggle for each device, or null. With several
// (Meet's green room and its call bar during the join), one with a layout box
// wins, then the last in the document.
export function findControls(doc) {
  const found = { mic: null, camera: null };
  if (!doc) {
    return found;
  }
  for (const el of doc.querySelectorAll("[data-is-muted]")) {
    if (!isButton(el)) {
      continue;
    }
    const kind = kindOf(el);
    if (!kind) {
      continue;
    }
    const current = found[kind];
    if (!current || el.getClientRects().length > 0 || current.getClientRects().length == 0) {
      found[kind] = el;
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

// Presses the page's toggle the way the person would: a real (trusted)
// mouse press at its centre when nothing covers it. If no click reached it
// (a hidden tab that drops input, a covered button), the element's own
// click() instead. Exactly one click either way. Returns "trusted" or
// "element".
export function press(win, el) {
  const doc = win.document;
  const rect = el.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  let hit = null;
  if (rect.width > 0 && rect.height > 0 && x >= 0 && y >= 0 && x < win.innerWidth && y < win.innerHeight) {
    hit = doc.elementFromPoint(x, y);
  }
  if (hit && (hit == el || el.contains(hit))) {
    let clicked = false;
    const onClick = event => {
      if (event.isTrusted && (event.target == el || el.contains(event.target))) {
        clicked = true;
      }
    };
    win.addEventListener("click", onClick, { capture: true, mozSystemGroup: true });
    try {
      for (const type of ["mousedown", "mouseup"]) {
        win.synthesizeMouseEvent(type, x, y, { button: 0, clickCount: 1 });
      }
    } catch (e) {
      // Not dispatched: fall back below.
    } finally {
      win.removeEventListener("click", onClick, { capture: true, mozSystemGroup: true });
    }
    if (clicked) {
      return "trusted";
    }
  }
  el.click();
  return "element";
}
