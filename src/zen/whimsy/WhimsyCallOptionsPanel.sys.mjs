/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W21: the Call Options panel — opened only by the small player's and the
// PiP window's "⋯" button (right-click on mic/camera does nothing, W14-7).
// A WhimsySurface listing all four mutes (the
// call's own mic/camera, Whimsy's device mic/camera block) as checkable
// rows, plus the "Click mutes" default switch (whimsy.call.buttons-default).
// Design: whimsy-handoff/wave13/design/call-controls-v2 (page v3, option E1).

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsySurface: "resource:///modules/whimsy/WhimsySurface.sys.mjs",
  WhimsyCallPip: "resource:///modules/whimsy/WhimsyCallPip.sys.mjs",
});

const PANEL_ID = "whimsy-call-options-panel";
const DEFAULT_PREF = "whimsy.call.buttons-default";
const KINDS = ["mic", "camera"];

const IN_CALL_LABEL = {
  mic: { on: "whimsy-call-options-mute-in-call", off: "whimsy-call-options-unmute-in-call" },
  camera: { on: "whimsy-call-options-camera-off-in-call", off: "whimsy-call-options-camera-on-in-call" },
};
const DEVICE_LABEL = {
  mic: { on: "whimsy-call-options-block-mic", off: "whimsy-call-options-unblock-mic" },
  camera: { on: "whimsy-call-options-block-camera", off: "whimsy-call-options-unblock-camera" },
};
const HEADING = { mic: "whimsy-call-options-mic-heading", camera: "whimsy-call-options-camera-heading" };
const SHORTCUT_KEY = { mic: "D", camera: "E" };

export const WhimsyCallOptionsPanel = {
  // Opened anchored to the ⋯ button (focus omitted), or to the mic/camera
  // button on right-click/Shift+F10 (focus: "mic"|"camera").
  open(win, browser, { anchor = null, focus = null } = {}) {
    const doc = win.document;
    const S = lazy.WhimsySurface;
    let view;
    const parts = S.create(win, {
      id: PANEL_ID,
      className: "whimsy-call-options-panel",
      width: 330,
      footer: true,
      initialFocus: () =>
        (focus && view.querySelector(`[data-focus-kind="${focus}"] .whimsy-surface-row`)) ??
        view.querySelector(".whimsy-surface-row"),
    });
    ({ view } = parts);
    this._rows = [];
    this._buildGroups(doc, view, browser);
    this._buildFooter(doc, parts);
    S.finish(parts);
    if (anchor) {
      S.open(win, parts.panel, { anchor, position: "before_start" });
    } else {
      S.open(win, parts.panel, { at: "page-top-end" });
    }
    return parts;
  },

  // One heading + its two rows (in-call, device) per kind, in the order
  // buttonsDefault says the default mute is tried first.
  _buildGroups(doc, view, browser) {
    for (const kind of KINDS) {
      const { caption } = lazy.WhimsySurface.caption(doc, { l10nId: HEADING[kind] });
      view.append(caption);
      const inCall = this._makeRow(doc, browser, kind, "in-call");
      const device = this._makeRow(doc, browser, kind, "device");
      const order = lazy.WhimsyCallPip.buttonsDefault == "call" ? [inCall, device] : [device, inCall];
      view.append(...order.map(r => r.el));
      this._rows.push(inCall, device);
    }
  },

  // A single checkable row: `which` is "in-call" (the call's own mute) or
  // "device" (Whimsy's hard device mute). `render()` re-reads state and
  // updates the row's label/checked mark in place, so toggling one mute
  // never has to rebuild or close the panel.
  _makeRow(doc, browser, kind, which) {
    const pip = lazy.WhimsyCallPip;
    const labels = which == "in-call" ? IN_CALL_LABEL[kind] : DEVICE_LABEL[kind];
    const el = doc.createXULElement("vbox");
    el.dataset.focusKind = kind;
    const check = doc.createXULElement("image");
    check.className = "whimsy-call-options-check";
    check.setAttribute("src", "chrome://global/skin/icons/check.svg");
    const shortcut = doc.createXULElement("span");
    shortcut.className = "whimsy-surface-row-detail whimsy-call-options-shortcut";
    shortcut.textContent = SHORTCUT_KEY[kind];
    const self = this;
    const entry = {
      el,
      kind,
      which,
      render() {
        const available = which != "in-call" || pip.displayState(browser, kind).inCallAvailable;
        const checked = which == "in-call" ? pip.shownState(browser, kind) == "off" : pip.stateFor(browser).blocked[kind];
        const { row } = lazy.WhimsySurface.row(doc, {
          l10nId: checked ? labels.off : labels.on,
          detailL10nId: which == "in-call" && !available ? "whimsy-call-options-in-call-unavailable" : null,
          trailing: [shortcut],
          onCommand: () => {
            if (which == "in-call") {
              pip.toggleInCall(browser, kind);
            } else {
              pip.toggleBlocked(browser, kind);
            }
            self._rows.forEach(r => r.render());
          },
          id: `whimsy-call-options-${kind}-${which}`,
        });
        row.dataset.row = `${kind}-${which}`;
        row.setAttribute("role", "menuitemcheckbox");
        row.setAttribute("aria-checked", checked ? "true" : "false");
        check.toggleAttribute("whimsy-call-options-checked", checked);
        row.prepend(check);
        if (which == "in-call" && !available) {
          row.classList.add("whimsy-surface-row-dim");
          row.setAttribute("aria-disabled", "true");
          row.removeAttribute("tabindex");
        }
        el.replaceChildren(row);
      },
    };
    entry.render();
    return entry;
  },

  _buildFooter(doc, parts) {
    const seg = lazy.WhimsySurface.seg(doc, {
      name: "call-buttons-default",
      label: "Click mutes",
      small: true,
      options: [
        { value: "call", l10nId: "whimsy-call-options-default-call" },
        { value: "device", l10nId: "whimsy-call-options-default-device" },
      ],
      onPick: value => {
        Services.prefs.setStringPref(DEFAULT_PREF, value);
        seg.select(value);
        // The default changed what a plain click does everywhere: redraw
        // this panel's rows and every open call surface.
        this._rows.forEach(r => r.render());
        for (const browser of lazy.WhimsyCallPip._calls) {
          lazy.WhimsyCallPip.render(browser);
        }
      },
    });
    seg.select(lazy.WhimsyCallPip.buttonsDefault);
    const { row } = lazy.WhimsySurface.row(doc, { l10nId: "whimsy-call-options-default-label", trailing: [seg.group] });
    parts.footer.append(row);
  },
};
