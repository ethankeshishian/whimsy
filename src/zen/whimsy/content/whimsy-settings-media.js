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
    this.buildDefaultSpeed();
    this.buildSavedSites();
    this.buildReadAloud();
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

// W23 voice-image: read aloud's voice and speed (fu-media 4.5: saved, for every site).
Object.assign(gWhimsySettings, {
  buildReadAloud() {
    const mount = document.getElementById("whimsyMediaReadAloud");
    const { Whimsy } = this.lazy;
    if (!mount || !Whimsy.featureEnabled("read-aloud")) {
      return;
    }
    document.getElementById("whimsyMediaVoiceGroup")?.setAttribute("data-category", WHIMSY_MEDIA_PANE);
    const { WhimsyReadAloud } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyReadAloud.sys.mjs");
    const { WhimsySurface } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsySurface.sys.mjs");
    const row = (id, labelL10n, detailL10n) => {
      const hbox = document.createXULElement("hbox");
      hbox.setAttribute("align", "center");
      hbox.className = "whimsy-media-row";
      const text = document.createXULElement("vbox");
      text.setAttribute("flex", "1");
      const label = document.createXULElement("label");
      label.id = `${id}Label`;
      document.l10n.setAttributes(label, labelL10n);
      const detail = document.createXULElement("description");
      detail.className = "description-deemphasized";
      document.l10n.setAttributes(detail, detailL10n);
      text.append(label, detail);
      const holder = document.createElementNS("http://www.w3.org/1999/xhtml", "div");
      holder.id = id;
      hbox.append(text, holder);
      mount.append(hbox);
      return holder;
    };
    const voiceHolder = row("whimsyReadAloudVoice", "whimsy-read-aloud-settings-voice", "whimsy-read-aloud-settings-voice-detail");
    const speedHolder = row("whimsyReadAloudSpeed", "whimsy-read-aloud-settings-speed", "whimsy-read-aloud-settings-speed-detail");
    const format = rate => `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(rate)}×`;
    const buildVoice = () => {
      const voices = WhimsyReadAloud.voiceOptions(window);
      const current = WhimsyReadAloud.voice(window);
      const dropdown = WhimsySurface.dropdown(document, {
        id: "whimsyReadAloudVoiceMenu",
        label: "whimsyReadAloudVoiceLabel",
        options: voices.length ? voices.map(v => ({ value: v.voiceURI, text: v.name })) : [{ value: "", text: "" }],
        value: current?.voiceURI ?? "",
        width: 220,
        onPick: value => WhimsyReadAloud.setVoice(value),
      });
      voiceHolder.replaceChildren(dropdown.button);
    };
    const speeds = [0.75, 1, 1.25, 1.5, 2];
    const speed = WhimsySurface.dropdown(document, {
      id: "whimsyReadAloudSpeedMenu",
      label: "whimsyReadAloudSpeedLabel",
      options: (speeds.includes(WhimsyReadAloud.rate) ? speeds : [...speeds, WhimsyReadAloud.rate].sort((a, b) => a - b)).map(rate => ({
        value: String(rate),
        text: format(rate),
        detailL10nId: rate == 1 ? "whimsy-read-aloud-speed-normal" : undefined,
      })),
      value: String(WhimsyReadAloud.rate),
      width: 180,
      onPick: value => WhimsyReadAloud.setRate(Number(value)),
    });
    speedHolder.replaceChildren(speed.button);
    buildVoice();
    // macOS lists its voices a moment after the first ask.
    if (!WhimsyReadAloud.testSynth && window.speechSynthesis) {
      window.speechSynthesis.addEventListener("voiceschanged", buildVoice);
    }
  },
});

document.addEventListener("DOMContentLoaded", () => gWhimsySettings.registerMediaPane(), { once: true });
