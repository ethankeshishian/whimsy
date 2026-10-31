/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// wave8/snooze (W8-37): the Snooze picker, rebuilt. dev.580's sheet had
// three presets and nothing else: no way to say "Friday at 2", no evening
// or weekend, and nothing to show what was already snoozed.
//
// Modelled on Superhuman's and Gmail's snooze menus and macOS Reminders'
// date suggestions, keyboard first:
//
//   Snooze Tab                                   ✕
//   <tab title>
//   [🕘 Type a time: “fri 2pm”, “in 3 hours”…  ]  ← focused on open
//   ─────────────────────────────────────────────
//   🕘 Later Today                       5:30 PM
//   🌙 Tonight                           8:00 PM
//   ☀ Tomorrow                  Tomorrow, 9:00 AM
//   ✦ This Weekend              Saturday, 9:00 AM
//   → Next Week                   Monday, 9:00 AM
//   ─────────────────────────────────────────────
//   ⚙ Pick Date & Time…
//   [ Snoozed Tabs (3) ]                          ← only when there are some
//
// - Every preset shows where it lands. A preset that no longer makes sense
//   today (Tonight at 9 PM) stays in its place, greyed out with the reason,
//   so the rows never move and the eye finds them where it expects.
// - Typing reads the time as you go ("tom 3pm" → "Tomorrow, 3:00 PM · in 25
//   hours") and narrows the presets to the ones whose names match. Enter
//   takes the first row; Down/Up walk the rows; typing on a row goes back
//   to the field; Esc clears the field, then closes.
// - Pick Date & Time… opens a date and a time field under the list, with
//   the result spelled out live, and a Snooze button; a time in the past
//   says so instead of snoozing.
// - It hangs off the tab it acts on (beside the sidebar, on whichever side
//   the sidebar is) or, when the tab isn't on screen, sits over the page
//   near the top like the command bar.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyPanels: "resource:///modules/whimsy/WhimsyPanels.sys.mjs",
  WhimsySnoozeTime: "resource:///modules/whimsy/WhimsySnoozeTime.sys.mjs",
});

const HTML_NS = "http://www.w3.org/1999/xhtml";
export const PANEL_ID = "whimsySnoozePanel";

const ICONS = {
  field: "chrome://browser/skin/zen-icons/history.svg",
  "later-today": "chrome://browser/skin/zen-icons/history.svg",
  tonight: "chrome://browser/skin/zen-icons/moon-stars.svg",
  tomorrow: "chrome://browser/skin/zen-icons/face-sun.svg",
  weekend: "chrome://browser/skin/zen-icons/sparkles.svg",
  "next-week": "chrome://browser/skin/zen-icons/forward.svg",
  typed: "chrome://browser/skin/zen-icons/arrow-corner-down-right.svg",
  custom: "chrome://browser/skin/zen-icons/sliders.svg",
};

function pad(n) {
  return String(n).padStart(2, "0");
}

function dateValue(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function timeValue(d) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export const WhimsySnoozePicker = {
  PANEL_ID,

  /**
   * Opens the picker for `tab`.
   *
   * @param {Window} win
   * @param {Element} tab
   * @param {object} o
   * @param {Function} o.onPick - onPick(tab, wakeAt) once a time is chosen
   * @param {number} [o.snoozedCount] - tabs already snoozed (footer link)
   * @param {Function} [o.onViewSnoozed]
   * @returns {Element} the panel
   */
  open(win, tab, { onPick, snoozedCount = 0, onViewSnoozed = null }) {
    const { document: doc } = win;
    const T = lazy.WhimsySnoozeTime;
    const locales = Services.locale.appLocalesAsBCP47;
    let customBox = null;
    let customButton = null;

    const { panel, body, search, footer } = lazy.WhimsyPanels.create(win, {
      id: PANEL_ID,
      titleL10nId: "whimsy-snooze-title",
      subtitle: tab?.label || "",
      size: "medium",
      search: { l10nId: "whimsy-snooze-field", onInput: () => render() },
      footer: true,
      onHidden: () => win.removeEventListener("keydown", onWindowKey, true),
    });
    panel.classList.add("whimsy-snooze");
    panel.whimsyTab = tab;
    panel.querySelector(".whimsy-sheet-search-icon")?.setAttribute("src", ICONS.field);
    search.classList.add("whimsy-snooze-field");
    search.setAttribute("autocomplete", "off");
    search.setAttribute("spellcheck", "false");

    const pick = wakeAt => {
      const target = panel.whimsyTab;
      lazy.WhimsyPanels.close(panel);
      if (wakeAt && target?.isConnected && !target.closing) {
        onPick(target, wakeAt);
      }
    };

    const detailLabel = (l10nId, args) => {
      const label = doc.createXULElement("label");
      label.className = "whimsy-sheet-item-detail";
      doc.l10n.setAttributes(label, l10nId, args);
      return label;
    };

    const presetRow = preset => {
      const row = lazy.WhimsyPanels.item(doc, {
        l10nId: `whimsy-snooze-${preset.key}`,
        l10nArgs: preset.key == "weekend" ? { next: preset.nextWeekend ? "true" : "false" } : undefined,
        icon: ICONS[preset.key],
        // The time is read again on Enter: the sheet may have sat open.
        onCommand: () => {
          const now = T.resolvePreset(preset.key, new Date());
          pick(now.available ? now.at.getTime() : null);
        },
      });
      row.setAttribute("data-preset", preset.key);
      row.append(
        preset.available
          ? detailLabel("whimsy-snooze-when", T.whenArgs(preset.at, new Date(), locales))
          : detailLabel("whimsy-snooze-unavailable")
      );
      if (!preset.available) {
        row.setAttribute("disabled", "true");
      }
      return row;
    };

    const typedRow = (parsed, text) => {
      const row = lazy.WhimsyPanels.item(doc, {
        l10nId: parsed.past ? "whimsy-snooze-past" : "whimsy-snooze-when",
        l10nArgs: parsed.past ? undefined : T.whenArgs(parsed.at, new Date(), locales),
        icon: ICONS.typed,
        onCommand: () => {
          const again = T.parse(text, new Date());
          pick(again && !again.past ? again.at.getTime() : null);
        },
      });
      row.classList.add("whimsy-snooze-typed");
      if (parsed.past) {
        row.setAttribute("disabled", "true");
      } else {
        const detail = doc.createXULElement("label");
        detail.className = "whimsy-sheet-item-detail";
        detail.setAttribute("value", T.relative(parsed.at, new Date(), locales));
        row.append(detail);
      }
      return row;
    };

    const render = () => {
      const text = search.value.trim();
      const now = new Date();
      const rows = [];
      const parsed = text ? T.parse(text, now) : null;
      if (parsed) {
        rows.push(typedRow(parsed, text));
      }
      for (const preset of T.resolvePresets(now)) {
        if (!text) {
          rows.push(presetRow(preset));
          continue;
        }
        // Narrowed by name; the typed row already covers the same time.
        if (T.presetMatches(preset.key, text) && preset.at.getTime() != parsed?.at.getTime()) {
          rows.push(presetRow(preset));
        }
      }
      body.replaceChildren();
      if (!rows.length) {
        body.append(lazy.WhimsyPanels.empty(doc, { l10nId: "whimsy-snooze-no-match", icon: ICONS.field }));
      } else {
        body.append(...rows);
      }
      if (!text) {
        body.append(doc.createXULElement("toolbarseparator"));
        const custom = lazy.WhimsyPanels.item(doc, {
          l10nId: "whimsy-snooze-pick",
          icon: ICONS.custom,
          onCommand: () => showCustom(),
        });
        custom.classList.add("whimsy-snooze-pick");
        custom.setAttribute("aria-expanded", customBox ? "true" : "false");
        body.append(custom);
        if (customBox) {
          body.append(customBox);
        }
      } else if (customBox) {
        hideCustom();
      }
    };

    // The date and time fields, under the list.
    const showCustom = () => {
      if (customBox) {
        customBox.querySelector("input")?.focus();
        return;
      }
      const typed = T.parse(search.value, new Date());
      const start = typed && !typed.past ? typed.at : T.resolvePreset("tomorrow").at;
      customBox = doc.createXULElement("vbox");
      customBox.className = "whimsy-snooze-custom";
      const fields = doc.createXULElement("hbox");
      fields.className = "whimsy-snooze-custom-fields";
      fields.setAttribute("align", "center");
      const date = doc.createElementNS(HTML_NS, "input");
      date.type = "date";
      date.className = "whimsy-snooze-date";
      date.value = dateValue(start);
      date.min = dateValue(new Date());
      doc.l10n.setAttributes(date, "whimsy-snooze-date");
      const time = doc.createElementNS(HTML_NS, "input");
      time.type = "time";
      time.className = "whimsy-snooze-time";
      time.value = timeValue(start);
      doc.l10n.setAttributes(time, "whimsy-snooze-time");
      fields.append(date, time);
      const status = doc.createXULElement("description");
      status.className = "whimsy-snooze-custom-status";
      status.setAttribute("aria-live", "polite");
      customBox.append(fields, status);

      const chosen = () => {
        if (!date.value || !time.value) {
          return null;
        }
        const [y, mo, d] = date.value.split("-").map(Number);
        const [h, mi] = time.value.split(":").map(Number);
        const when = new Date(y, mo - 1, d, h, mi, 0, 0);
        return Number.isNaN(when.getTime()) ? null : when;
      };
      const update = () => {
        const when = chosen();
        const ok = !!when && when.getTime() > Date.now();
        status.toggleAttribute("invalid", !ok);
        if (ok) {
          doc.l10n.setAttributes(status, "whimsy-snooze-custom-summary", T.whenArgs(when, new Date(), locales));
        } else {
          doc.l10n.setAttributes(status, when ? "whimsy-snooze-past" : "whimsy-snooze-custom-incomplete");
        }
        customButton?.toggleAttribute("disabled", !ok);
        return ok ? when : null;
      };
      const submit = () => {
        const when = update();
        if (when) {
          pick(when.getTime());
        }
      };
      date.addEventListener("input", update);
      time.addEventListener("input", update);
      // Arrow keys step the date and time; Enter snoozes. The sheet's own
      // row navigation must not take them.
      customBox.addEventListener("keydown", event => {
        if (["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
          event.stopPropagation();
        } else if (event.key == "Enter") {
          event.preventDefault();
          event.stopPropagation();
          submit();
        }
      });

      footer.replaceChildren();
      customButton = lazy.WhimsyPanels.footerButton(doc, {
        l10nId: "whimsy-snooze-custom-button",
        primary: true,
        onCommand: submit,
      });
      customButton.classList.add("whimsy-snooze-custom-button");
      footer.append(customButton);
      footer.hidden = false;
      render();
      update();
      date.focus();
    };

    const hideCustom = () => {
      customBox?.remove();
      customBox = null;
      customButton = null;
      fillFooter();
    };

    const fillFooter = () => {
      footer.replaceChildren();
      if (snoozedCount > 0 && onViewSnoozed) {
        const view = lazy.WhimsyPanels.footerButton(doc, {
          l10nId: "whimsy-snooze-view-snoozed",
          l10nArgs: { count: snoozedCount },
          onCommand: () => {
            lazy.WhimsyPanels.close(panel);
            onViewSnoozed();
          },
        });
        view.classList.add("whimsy-snooze-view-snoozed");
        footer.append(view);
      }
      footer.hidden = !footer.children.length;
    };

    // Esc steps back before it closes: the date fields, then the typed
    // text, then the sheet. Registered before the sheet's own window
    // listener (added on popupshown), so it runs first.
    const onWindowKey = event => {
      if (event.key != "Escape" || panel.state != "open" || event.defaultPrevented) {
        return;
      }
      if (customBox) {
        event.preventDefault();
        event.stopPropagation();
        hideCustom();
        render();
        body.querySelector(".whimsy-snooze-pick")?.focus();
      } else if (search.value) {
        event.preventDefault();
        event.stopPropagation();
        search.value = "";
        render();
        search.focus();
      }
    };
    win.addEventListener("keydown", onWindowKey, true);

    // Typing on a row goes back to the field, as in a menu with type-ahead.
    body.addEventListener("keydown", event => {
      if (
        event.key.length == 1 &&
        event.key != " " &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        event.target.classList?.contains("whimsy-sheet-item")
      ) {
        search.focus();
      }
    });

    render();
    fillFooter();

    const rightSide = doc.documentElement.getAttribute("zen-right-side") == "true";
    const anchor = tab ? lazy.WhimsyPanels.visibleAnchor(win, [tab]) : null;
    lazy.WhimsyPanels.open(win, panel, { anchor, position: rightSide ? "start_before" : "end_before" });
    return panel;
  },
};
