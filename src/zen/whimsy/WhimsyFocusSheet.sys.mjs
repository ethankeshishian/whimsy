/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W29 focus sessions: the Focus session sheet (focus-wellbeing.md §1–2).
//
//   Focus session                                  ×
//            [ the length picker ]
//              Ends at 3:40 PM
//   During the session                 (Just a timer)
//   ☑ Do Not Disturb
//   ☑ Pause distracting sites
//     Social media, video, and 2 more sites · Edit
//   ☐ Mute background tabs
//   ☑ Break reminder
//                                     Cancel  Start
//
// A WhimsySurface at page-top-center, like openRoutineSheet
// (whimsy-routine-form.mjs:984). The picker comes from WhimsyFocusPicker, so
// another one can replace the dial without touching this file's logic.
// Nothing happens until Start; the session writes the ticks to prefs.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  clearInterval: "resource://gre/modules/Timer.sys.mjs",
  setInterval: "resource://gre/modules/Timer.sys.mjs",
  WhimsyFocusPicker: "resource:///modules/whimsy/WhimsyFocusPicker.sys.mjs",
  WhimsyFocusSession: "resource:///modules/whimsy/WhimsyFocusSession.sys.mjs",
  WhimsySurface: "resource:///modules/whimsy/WhimsySurface.sys.mjs",
});

const XHTML = "http://www.w3.org/1999/xhtml";
export const SHEET_ID = "whimsy-focus-sheet";

/** "3:40 PM", in the user's locale. */
export function shortTime(ms) {
  return new Intl.DateTimeFormat(undefined, { timeStyle: "short" }).format(new Date(ms));
}

const ROWS = [
  { name: "dnd", l10nId: "whimsy-focus-dnd", detailL10nId: "whimsy-focus-dnd-detail" },
  { name: "pauseSites", l10nId: "whimsy-focus-pause" },
  // W29 Stay on this tab (intake-w29/designs/focus-this-tab.md).
  { name: "stayOnTab", l10nId: "whimsy-focus-stay", detailL10nId: "whimsy-focus-stay-detail" },
  { name: "muteBackground", l10nId: "whimsy-focus-mute", detailL10nId: "whimsy-focus-mute-detail" },
  { name: "breakReminder", l10nId: "whimsy-focus-break", detailL10nId: "whimsy-focus-break-detail" },
];

export const WhimsyFocusSheet = {
  /**
   * Opens the sheet.
   *
   * @param {Window} win
   * @param {object} options - { minutes, ticks, onStart(options) }
   * @returns {object} the surface parts, plus `picker` and `boxes`
   */
  open(win, { minutes, ticks, onStart }) {
    const S = lazy.WhimsySurface;
    const doc = win.document;
    if (S.isOpen(win, SHEET_ID)) {
      return null;
    }
    let refresh = null;
    let picker = null;
    const parts = S.create(win, {
      id: SHEET_ID,
      width: 340,
      titleL10nId: "whimsy-focus-sheet-title",
      close: true,
      footer: true,
      className: "whimsy-focus-sheet",
      initialFocus: () => picker.element,
      onHidden: () => lazy.clearInterval(refresh),
    });

    // The picker and "Ends at".
    const wrap = doc.createElementNS(XHTML, "div");
    wrap.className = "whimsy-focus-picker-wrap";
    const ends = doc.createElementNS(XHTML, "p");
    ends.className = "whimsy-focus-ends";
    const showEnds = () => {
      doc.l10n.setAttributes(ends, "whimsy-focus-ends", { time: shortTime(Date.now() + picker.value * 60000) });
    };
    picker = lazy.WhimsyFocusPicker.create(doc, { value: minutes, onChange: showEnds });
    wrap.append(picker.element, ends);
    showEnds();
    refresh = lazy.setInterval(showEnds, 15000);

    // What the session turns on.
    const { caption, label: captionLabel, detail: justTimer } = S.caption(doc, {
      l10nId: "whimsy-focus-during",
      detailL10nId: "whimsy-focus-just-timer",
      id: `${SHEET_ID}-during`,
    });
    const group = S.group(doc, { label: captionLabel.id });
    group.classList.add("whimsy-focus-checklist");
    const boxes = {};
    const showJustTimer = () => {
      justTimer.hidden = Object.values(boxes).some(box => box.checked);
    };
    for (const spec of ROWS) {
      const { row, label } = S.row(doc, {
        l10nId: spec.l10nId,
        detailL10nId: spec.detailL10nId,
        detailArgs: spec.name == "breakReminder" ? { minutes: lazy.WhimsyFocusSession.BREAK_MINUTES } : null,
        id: `${SHEET_ID}-${spec.name}`,
      });
      label.id = `${SHEET_ID}-${spec.name}-label`;
      if (spec.name == "pauseSites") {
        row.querySelector(".whimsy-surface-row-text").append(this.sitesDetail(win, doc));
      }
      const box = doc.createElementNS(XHTML, "input");
      box.type = "checkbox";
      box.className = "whimsy-surface-check";
      box.checked = !!ticks[spec.name];
      box.setAttribute("aria-labelledby", label.id);
      const detail = row.querySelector(".whimsy-surface-row-detail");
      if (detail) {
        detail.id = `${SHEET_ID}-${spec.name}-detail`;
        box.setAttribute("aria-describedby", detail.id);
      }
      box.addEventListener("change", showJustTimer);
      // The whole row ticks the box (but not the Edit link).
      row.addEventListener("click", event => {
        if (event.target == box || event.target.closest?.("button")) {
          return;
        }
        box.checked = !box.checked;
        box.dispatchEvent(new win.Event("change", { bubbles: true }));
      });
      row.classList.add("whimsy-focus-check-row");
      row.prepend(box);
      boxes[spec.name] = box;
      group.append(row);
    }
    showJustTimer();

    parts.view.append(wrap, caption, group);
    parts.footer.append(
      S.footerButton(doc, { l10nId: "whimsy-focus-cancel", onCommand: () => S.close(parts.panel) }),
      S.footerButton(doc, {
        l10nId: "whimsy-focus-start",
        primary: true,
        id: `${SHEET_ID}-start`,
        onCommand: () => {
          const options = { minutes: picker.value };
          for (const [name, box] of Object.entries(boxes)) {
            options[name] = box.checked;
          }
          S.close(parts.panel);
          onStart(options);
        },
      })
    );
    S.finish(parts);
    S.open(win, parts.panel, { at: "page-top-center" });
    return { ...parts, picker, boxes, justTimer, ends };
  },

  // "Social media, video, and 2 more sites · Edit"; Edit opens Settings ›
  // General › Focus Sessions.
  sitesDetail(win, doc) {
    const detail = doc.createElementNS(XHTML, "span");
    detail.className = "whimsy-surface-row-detail whimsy-focus-sites-detail";
    const summary = doc.createElementNS(XHTML, "span");
    const { l10nId, args } = lazy.WhimsyFocusSession.summary();
    doc.l10n.setAttributes(summary, l10nId, args);
    const edit = doc.createElementNS(XHTML, "button");
    edit.type = "button";
    edit.className = "whimsy-focus-edit";
    doc.l10n.setAttributes(edit, "whimsy-focus-edit");
    edit.addEventListener("click", event => {
      event.stopPropagation();
      lazy.WhimsySurface.close(doc.getElementById(SHEET_ID));
      win.openPreferences("general-whimsyFocus");
    });
    detail.append(summary, " · ", edit);
    return detail;
  },
};
