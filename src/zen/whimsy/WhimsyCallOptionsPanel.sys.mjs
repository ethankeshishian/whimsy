/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W21/W14-6: the Call Options panel, opened only by the small player's and
// the PiP window's "⋯" button (right-click on mic/camera does nothing,
// W14-7). A WhimsySurface: "Buttons mute: <app> | This Device" on top
// (whimsy.call.buttons-default), then Microphone and Camera, each with a
// switch per mute (the call's own, this device's block) showing the real
// state under a fixed label, and a "Mic button"/"Camera button" hint on the
// one a plain click of that button does. Built once per opening and updated
// in place by WhimsyCallPip.render, so changes from the page, the small
// player, PiP or a shortcut show while it's open.
// Design: whimsy-handoff/wave13/design/call-options (option A).

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsySurface: "resource:///modules/whimsy/WhimsySurface.sys.mjs",
  WhimsyCallPip: "resource:///modules/whimsy/WhimsyCallPip.sys.mjs",
});

const PANEL_ID = "whimsy-call-options-panel";
const DEFAULT_PREF = "whimsy.call.buttons-default";
const KINDS = ["mic", "camera"];
const ICON = { mic: "chrome://browser/skin/zen-icons/microphone-fill.svg", camera: "chrome://browser/skin/zen-icons/video-fill.svg" };
const HEADING = { mic: "whimsy-call-options-mic-heading", camera: "whimsy-call-options-camera-heading" };
const LABEL = {
  mic: { call: "whimsy-call-options-mic-in-call", device: "whimsy-call-options-mic-device" },
  camera: { call: "whimsy-call-options-camera-in-call", device: "whimsy-call-options-camera-device" },
};
const HINT = { mic: "whimsy-call-options-mic-hint", camera: "whimsy-call-options-camera-hint" };
const MISSING = { mic: "whimsy-call-options-mic-missing", camera: "whimsy-call-options-camera-missing" };

// Open panels: panel -> { browser, update }.
const open = new Map();

function appArgs(browser) {
  const app = lazy.WhimsyCallPip.appName(browser);
  return { app: app ?? "", known: app ? "yes" : "no" };
}

function setL10n(doc, el, id, args = null) {
  const now = doc.l10n.getAttributes(el);
  if (now.id != id || JSON.stringify(now.args ?? null) != JSON.stringify(args)) {
    doc.l10n.setAttributes(el, id, args);
  }
}

const THEME_ROOT_VARS = [
  "--zen-primary-color",
  "--arrowpanel-background",
  "--arrowpanel-color",
  "--focus-outline-color",
  "--panel-separator-color",
  "color-scheme",
];
const THEME_PANEL_VARS = ["--panel-border-radius"];

export const WhimsyCallOptionsPanel = {
  open(win, browser, { anchor = null } = {}) {
    const doc = win.document;
    const S = lazy.WhimsySurface;
    const parts = S.create(win, {
      id: PANEL_ID,
      className: "whimsy-call-options-panel",
      width: 330,
      onHidden: () => open.delete(parts.panel),
    });
    if (browser.documentGlobal && browser.documentGlobal != win) {
      this._copyTheme(parts.panel, browser.documentGlobal);
    }
    const update = this._build(doc, parts.view, browser);
    open.set(parts.panel, { browser, update });
    S.finish(parts);
    if (anchor) {
      S.open(win, parts.panel, { anchor, position: "before_start" });
    } else {
      S.open(win, parts.panel, { at: "page-top-end" });
    }
    return parts;
  },

  // The PiP window has none of Zen's window sheets: give its panel the
  // call window's theme values, read afresh on each opening.
  _copyTheme(panel, source) {
    const copy = (element, names) => {
      if (!element) {
        return;
      }
      const computed = source.getComputedStyle(element);
      for (const name of names) {
        const value = computed.getPropertyValue(name);
        if (value) {
          panel.style.setProperty(name, value);
        }
      }
    };
    copy(source.document.documentElement, THEME_ROOT_VARS);
    copy(source.document.getElementById("zen-unified-site-data-panel"), THEME_PANEL_VARS);
  },

  // WhimsyCallPip.render: every open panel for this call shows its state.
  refresh(browser) {
    for (const [panel, entry] of open) {
      if (!panel.isConnected) {
        open.delete(panel);
      } else if (entry.browser == browser) {
        entry.update();
      }
    }
  },

  // The panel's parts, and update(), which re-reads every state.
  _build(doc, view, browser) {
    const S = lazy.WhimsySurface;
    const pip = lazy.WhimsyCallPip;

    const { caption } = S.caption(doc, { l10nId: "whimsy-call-options-buttons-heading", id: "whimsy-call-options-buttons-heading" });
    const seg = S.seg(doc, {
      name: "call-buttons-default",
      options: [
        { value: "call", l10nId: "whimsy-call-options-default-call", l10nArgs: appArgs(browser) },
        { value: "device", l10nId: "whimsy-call-options-default-device" },
      ],
      onPick: value => {
        Services.prefs.setStringPref(DEFAULT_PREF, value);
        // What a plain click does changed everywhere: redraw every call.
        for (const call of pip._calls) {
          pip.render(call);
        }
        update();
      },
    });
    seg.group.setAttribute("aria-labelledby", "whimsy-call-options-buttons-heading");
    seg.group.classList.add("whimsy-call-options-default");
    const warn = doc.createXULElement("hbox");
    warn.className = "whimsy-call-options-fallback";
    warn.setAttribute("align", "start");
    const warnIcon = doc.createXULElement("image");
    warnIcon.setAttribute("src", "chrome://global/skin/icons/warning.svg");
    const warnText = doc.createElementNS("http://www.w3.org/1999/xhtml", "span");
    warnText.id = "whimsy-call-options-fallback-text";
    warn.append(warnIcon, warnText);
    view.append(caption, seg.group, warn);

    const rows = [];
    for (const kind of KINDS) {
      const heading = S.caption(doc, { l10nId: HEADING[kind] });
      const group = S.group(doc);
      group.dataset.focusKind = kind;
      for (const which of ["call", "device"]) {
        const labelId = `whimsy-call-options-${kind}-${which}-label`;
        const toggle = S.switch(doc, {
          labelledBy: labelId,
          id: `whimsy-call-options-${kind}-${which}`,
          onChange: () => {
            if (which == "call") {
              pip.toggleInCall(browser, kind);
            } else {
              pip.toggleBlocked(browser, kind);
            }
            // The switch shows the real state, which the toggle's own
            // render brings; until then it stays where it was.
            update();
          },
        });
        const { row, label } = S.row(doc, { l10nId: LABEL[kind][which], detail: "", trailing: [toggle] });
        label.id = labelId;
        row.dataset.row = `${kind}-${which == "call" ? "in-call" : "device"}`;
        const icon = doc.createXULElement("image");
        icon.className = "whimsy-call-options-icon";
        icon.setAttribute("src", ICON[kind]);
        row.prepend(icon);
        const detail = row.querySelector(".whimsy-surface-row-detail");
        detail.id = `${labelId}-detail`;
        toggle.setAttribute("aria-describedby", detail.id);
        group.append(row);
        rows.push({ kind, which, row, toggle, detail });
      }
      view.append(heading.caption, group);
    }

    const update = () => {
      const args = appArgs(browser);
      seg.select(pip.buttonsDefault);
      setL10n(doc, seg.buttons[0], "whimsy-call-options-default-call", args);
      const missing = KINDS.filter(kind => !pip.displayState(browser, kind).inCallAvailable);
      const fallback = pip.buttonsDefault == "call" && missing.length > 0;
      warn.hidden = !fallback;
      if (fallback) {
        setL10n(doc, warnText, "whimsy-call-options-fallback", args);
      }
      for (const { kind, which, row, toggle, detail } of rows) {
        const d = pip.displayState(browser, kind);
        const available = which == "device" || d.inCallAvailable;
        // While the page answers a press, the knob stays where it was moved.
        if (which == "device" || !d.busy) {
          toggle.checked = which == "call" ? pip.shownState(browser, kind) == "off" : !!pip.stateFor(browser).blocked[kind];
        }
        toggle.disabled = !available;
        row.classList.toggle("whimsy-call-options-dim", !available);
        const hinted = pip.pressDoes(browser, kind) == which;
        row.toggleAttribute("whimsy-call-options-hinted", hinted && available);
        if (!available) {
          setL10n(doc, detail, MISSING[kind], args);
          detail.hidden = false;
        } else if (hinted) {
          setL10n(doc, detail, HINT[kind]);
          detail.hidden = false;
        } else {
          detail.hidden = true;
        }
      }
    };
    update();
    return update;
  },
};
