/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* global gWhimsySettings, register_module, Preferences */

"use strict";

// W23 video: Settings › Media, a page of its own (registered like Links).
// It gathers the media rows that sat under Tabs, the default speed (a
// WhimsySurface menu; Other… takes any speed from 1/16× to 16×), and
// Summarize and picture-in-picture. about:preferences#whimsyMedia opens it.
// With its switch off, the rows go back under Tabs.

const WHIMSY_MEDIA_PANE = "paneWhimsyMedia";
const WHIMSY_DEFAULT_SPEED_PREF = "whimsy.video.default-speed";
const WHIMSY_SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];

Object.assign(gWhimsySettings, {
  registerMediaPane() {
    if (typeof register_module != "function" || document.getElementById("category-whimsy-media")) {
      return;
    }
    const { Whimsy } = this.lazy;
    if (!Whimsy.featureEnabled("media-settings")) {
      // The rows stay with Tabs.
      const template = document.getElementById("template-whimsyMedia");
      for (const group of template?.content.querySelectorAll("groupbox[data-category]") ?? []) {
        group.setAttribute("data-category", "paneZenTabManagement");
      }
      template?.content.getElementById("whimsyMediaCategory")?.remove();
      this.buildMediaPane();
      return;
    }
    const after = document.getElementById("category-whimsy-links") ?? document.getElementById("category-zen-tabs-management");
    if (!after) {
      return;
    }
    const button = document.createElementNS("http://www.w3.org/1999/xhtml", "moz-page-nav-button");
    button.id = "category-whimsy-media";
    button.setAttribute("view", WHIMSY_MEDIA_PANE);
    button.setAttribute("iconsrc", "chrome://browser/skin/zen-icons/media-play.svg");
    button.setAttribute("data-l10n-id", "whimsy-pane-media-title");
    after.after(button);
    register_module(WHIMSY_MEDIA_PANE, { init: () => this.buildMediaPane() });
  },

  buildMediaPane() {
    const template = document.getElementById("template-whimsyMedia");
    if (!template) {
      return;
    }
    const fragment = template.content;
    const { Whimsy } = this.lazy;
    for (const row of [...fragment.querySelectorAll("[data-whimsy-feature]")]) {
      if (!Whimsy.featureEnabled(row.dataset.whimsyFeature)) {
        row.remove();
      }
    }
    template.remove();
    Preferences.addAll(
      [...fragment.querySelectorAll("[preference]")]
        .filter(el => !Preferences.get(el.getAttribute("preference")))
        .map(el => ({
          id: el.getAttribute("preference"),
          type: el.dataset.prefType || (el.localName == "checkbox" ? "bool" : "int"),
        }))
    );
    const groups = [...fragment.children];
    document.getElementById("mainPrefPane").append(fragment);
    // A group left with no setting goes; the read-aloud group waits for its rows.
    for (const group of groups) {
      if (group.localName == "groupbox" && group.hasAttribute("data-category") && !group.querySelector("[preference], #whimsyMediaDefaultSpeed")) {
        group.remove();
      }
    }
    this.buildDictation();
    this.buildDefaultSpeed();
    this.buildSavedSites();
    Preferences.queueUpdateOfAllElements();
  },

  // The default speed: a menu of common speeds, and Other… for any.
  buildDefaultSpeed() {
    const holder = document.getElementById("whimsyMediaDefaultSpeed");
    if (!holder) {
      return;
    }
    const { WhimsySurface } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsySurface.sys.mjs");
    const current = () => {
      const value = Number(Services.prefs.getStringPref(WHIMSY_DEFAULT_SPEED_PREF, "1"));
      return Number.isFinite(value) && value > 0 ? value : 1;
    };
    const format = rate => `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(rate)}×`;
    const options = () => {
      const now = current();
      const list = WHIMSY_SPEEDS.includes(now) ? WHIMSY_SPEEDS : [...WHIMSY_SPEEDS, now].sort((a, b) => a - b);
      return [
        ...list.map(rate => ({ value: String(rate), text: format(rate), detailL10nId: rate == 1 ? "whimsy-media-default-speed-normal" : undefined })),
        { rule: true },
        { value: "other", l10nId: "whimsy-media-default-speed-other", detailL10nId: "whimsy-media-default-speed-other-detail" },
      ];
    };
    const build = () => {
      const dropdown = WhimsySurface.dropdown(document, {
        id: "whimsyMediaDefaultSpeedMenu",
        label: "whimsyMediaDefaultSpeedLabel",
        options: options(),
        value: String(current()),
        width: 180,
        onPick: value => {
          if (value == "other") {
            this.editDefaultSpeed(holder, build, format);
            return;
          }
          Services.prefs.setStringPref(WHIMSY_DEFAULT_SPEED_PREF, value);
        },
      });
      holder.replaceChildren(dropdown.button);
      return dropdown;
    };
    build();
  },

  // Sites with their own speed: the first few by name, and Forget all.
  async buildSavedSites() {
    const row = document.getElementById("whimsyMediaSitesRow");
    if (!row) {
      return;
    }
    const { WhimsyVideoSpeed } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyVideoSpeed.sys.mjs");
    const button = document.getElementById("whimsyMediaForgetAll");
    if (!button.whimsyWired) {
      button.whimsyWired = true;
      button.addEventListener("command", async () => {
        await WhimsyVideoSpeed.forgetAll();
        await this.buildSavedSites();
      });
    }
    const sites = await WhimsyVideoSpeed.savedSites();
    row.hidden = !sites.length;
    const list = document.getElementById("whimsyMediaSitesList");
    if (!sites.length) {
      return;
    }
    const format = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
    const names = sites.map(({ site, rate }) => `${site.replace(/^www\./, "")} ${format.format(rate)}×`);
    if (names.length <= 3) {
      list.removeAttribute("data-l10n-id");
      list.removeAttribute("data-l10n-args");
      list.textContent = new Intl.ListFormat(undefined, { type: "conjunction" }).format(names);
    } else {
      document.l10n.setAttributes(list, "whimsy-media-sites-more", { sites: names.slice(0, 2).join(", "), more: names.length - 2 });
    }
  },

  // W23 voice-image: dictation. Hold Fn, and a note when macOS also uses a
  // short press of Fn (its "Press 🌐 key to" isn't Do Nothing).
  buildDictation() {
    const holder = document.getElementById("whimsyMediaDictation");
    const { Whimsy } = this.lazy;
    if (!holder || holder.childElementCount || !Whimsy.featureEnabled("dictation")) {
      return;
    }
    const { WhimsyDictation } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyDictation.sys.mjs");
    if (!WhimsyDictation.speech()) {
      return;
    }
    const xul = tag => document.createXULElement(tag);
    if (!Preferences.get("whimsy.dictation.hold-fn")) {
      Preferences.add({ id: "whimsy.dictation.hold-fn", type: "bool" });
    }
    const box = holder.closest("groupbox");
    box?.setAttribute("data-category", "paneWhimsyMedia");
    const check = xul("checkbox");
    check.id = "whimsyDictationHoldFn";
    check.setAttribute("preference", "whimsy.dictation.hold-fn");
    document.l10n.setAttributes(check, "whimsy-media-dictation-hold-fn");
    const detail = xul("description");
    detail.className = "description-deemphasized indent";
    document.l10n.setAttributes(detail, "whimsy-media-dictation-detail");
    holder.append(check, detail);
    const usage = WhimsyDictation.fnKeyUsage();
    if (usage !== 0 && usage !== null) {
      const action = { 1: "input", 2: "emoji", 3: "dictation" }[usage] ?? "other";
      const row = xul("hbox");
      row.id = "whimsyDictationFnNote";
      row.className = "indent whimsy-media-row";
      row.setAttribute("align", "center");
      const note = xul("description");
      note.setAttribute("flex", "1");
      note.className = "description-deemphasized";
      document.l10n.setAttributes(note, "whimsy-media-dictation-fn-note", { action });
      const open = xul("button");
      open.id = "whimsyDictationOpenKeyboard";
      document.l10n.setAttributes(open, "whimsy-media-dictation-open-keyboard");
      open.addEventListener("command", () => WhimsyDictation.openKeyboardSettings());
      row.append(note, open);
      holder.append(row);
    }
  },

  // Other…: the field takes any speed; past 16× it's 16× with a note.
  editDefaultSpeed(holder, rebuild, format) {
    const input = document.createElementNS("http://www.w3.org/1999/xhtml", "input");
    input.id = "whimsyMediaDefaultSpeedInput";
    input.type = "text";
    input.inputMode = "decimal";
    input.className = "whimsy-media-speed-input";
    document.l10n.setAttributes(input, "whimsy-media-default-speed-input");
    const note = document.createElementNS("http://www.w3.org/1999/xhtml", "span");
    note.id = "whimsyMediaDefaultSpeedNote";
    note.className = "whimsy-media-speed-note";
    note.setAttribute("role", "status");
    input.value = Services.prefs.getStringPref(WHIMSY_DEFAULT_SPEED_PREF, "1");
    input.addEventListener("keydown", event => {
      if (event.key == "Escape") {
        event.preventDefault();
        rebuild();
      } else if (event.key == "Enter") {
        event.preventDefault();
        const typed = Number(String(input.value).trim().replace(",", ".").replace(/\s*[x×]$/i, ""));
        if (!Number.isFinite(typed) || typed <= 0) {
          return;
        }
        const rate = typed <= 1 / 16 ? 1 / 16 : Math.round(Math.min(16, typed) * 100) / 100;
        Services.prefs.setStringPref(WHIMSY_DEFAULT_SPEED_PREF, String(rate));
        rebuild();
        if (typed > 16) {
          const line = holder.ownerDocument.createElementNS("http://www.w3.org/1999/xhtml", "span");
          line.id = "whimsyMediaDefaultSpeedNote";
          line.className = "whimsy-media-speed-note";
          line.setAttribute("role", "status");
          document.l10n.setAttributes(line, "whimsy-video-speed-fastest", { rate: format(16) });
          holder.append(line);
        }
      }
    });
    holder.replaceChildren(input, note);
    input.focus();
    input.select();
  },
});

document.addEventListener("DOMContentLoaded", () => gWhimsySettings.registerMediaPane(), { once: true });
