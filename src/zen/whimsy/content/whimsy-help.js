/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W29/help: whimsy://help, Whimsy's offline built-in manual. Loaded with
// the system principal (about:whimsy?help), so it can import the real
// modules directly: WhimsyCommands for live shortcuts, Services.prefs for
// on/off state. Content is baked at overlay.py apply time into
// whimsy-help.json (one entry per FEATURES feature; the build fails if
// any feature has no sentence), so this page works with no network.

"use strict";

(async () => {
  const { WhimsyCommands } = ChromeUtils.importESModule(
    "resource:///modules/whimsy/WhimsyCommands.sys.mjs"
  );
  const { keyCaps } = ChromeUtils.importESModule(
    "resource:///modules/whimsy/WhimsyCheatSheet.sys.mjs"
  );
  const { BrowserWindowTracker } = ChromeUtils.importESModule(
    "resource:///modules/BrowserWindowTracker.sys.mjs"
  );

  const DATA_URL = "chrome://browser/content/whimsy/whimsy-help.json";
  const CHANGELOG_URL = "chrome://browser/content/whimsy/whimsy-changelog.json";
  const CHANGELOG_LIMIT = 12;
  const ALL = "all";
  const WHATS_NEW = "whats-new";

  const $ = id => document.getElementById(id);
  const list = $("whimsy-help-list");
  const changelogList = $("whimsy-help-changelog");
  const rail = $("whimsy-help-rail");
  const empty = $("whimsy-help-empty");
  const search = $("whimsy-help-search");

  let features = [];
  let sections = [];
  let changelog = [];
  let selected = ALL;

  function mainWindow() {
    return BrowserWindowTracker.getTopWindow();
  }

  // The live binding for a feature's command: a rebound key shows the
  // person's own key, not the shipped default (the <key> element's
  // attributes are what CustomKeys actually rewrites).
  function liveCaps(commandId) {
    const entry = commandId && WhimsyCommands.get(commandId);
    if (!entry) {
      return [];
    }
    const win = mainWindow();
    const keyEl = entry.keyId && win?.document.getElementById(entry.keyId);
    if (keyEl) {
      return keyCaps({
        modifiers: keyEl.getAttribute("modifiers") || "",
        key: keyEl.getAttribute("key") || "",
        keycode: keyEl.getAttribute("keycode") || "",
      });
    }
    return keyCaps(entry.defaultKey || {});
  }

  function isOn(feature) {
    try {
      return Services.prefs.getBoolPref(feature.pref, true);
    } catch (e) {
      return true;
    }
  }

  function openPane(paneId) {
    const win = mainWindow();
    if (win && paneId) {
      win.openPreferences(paneId);
    }
  }

  function highlighted(text, query) {
    const span = document.createElement("span");
    if (!query) {
      span.textContent = text;
      return span;
    }
    const lower = text.toLocaleLowerCase();
    const needle = query.toLocaleLowerCase();
    let i = 0;
    let at = lower.indexOf(needle);
    if (at < 0) {
      span.textContent = text;
      return span;
    }
    while (at >= 0) {
      span.append(text.slice(i, at));
      const mark = document.createElement("mark");
      mark.className = "whimsy-help-match";
      mark.textContent = text.slice(at, at + needle.length);
      span.append(mark);
      i = at + needle.length;
      at = lower.indexOf(needle, i);
    }
    span.append(text.slice(i));
    return span;
  }

  function rowMatches(feature, query) {
    if (!query) {
      return true;
    }
    const hay = [feature.name, feature.text, feature.pane, commandTitle(feature)]
      .filter(Boolean)
      .join(" ")
      .toLocaleLowerCase();
    return hay.includes(query.toLocaleLowerCase());
  }

  function commandTitle(feature) {
    const entry = feature.command && WhimsyCommands.get(feature.command);
    return entry ? WhimsyCommands.title(entry) : "";
  }

  function renderRow(feature, query) {
    const li = document.createElement("li");
    li.className = "whimsy-help-row";
    const on = isOn(feature);
    li.classList.toggle("is-off", !on);

    const main = document.createElement("div");
    main.className = "whimsy-help-row-main";

    const name = document.createElement("span");
    name.className = "whimsy-help-row-name";
    name.append(highlighted(feature.name, query));
    main.append(name);

    const text = document.createElement("span");
    text.className = "whimsy-help-row-text";
    text.append(highlighted(feature.text, query));
    main.append(text);

    if (feature.paneId) {
      const link = document.createElement("button");
      link.type = "button";
      link.className = "whimsy-help-row-setting";
      if (on) {
        document.l10n.setAttributes(link, "whimsy-help-setting-link", { pane: feature.pane });
      } else {
        document.l10n.setAttributes(link, "whimsy-help-setting-off", { pane: feature.pane });
      }
      link.addEventListener("click", () => openPane(feature.paneId));
      main.append(link);
    } else if (!on) {
      const off = document.createElement("span");
      off.className = "whimsy-help-row-setting";
      document.l10n.setAttributes(off, "whimsy-help-off-no-pane");
      main.append(off);
    }

    li.append(main);

    const caps = liveCaps(feature.command);
    if (caps.length) {
      const keys = document.createElement("span");
      keys.className = "whimsy-help-row-keys";
      for (const cap of caps) {
        const kbd = document.createElement("kbd");
        kbd.textContent = cap;
        keys.append(kbd);
      }
      li.append(keys);
    }

    return li;
  }

  function renderChangelog() {
    changelogList.replaceChildren(
      ...changelog.map(entry => {
        const li = document.createElement("li");
        li.className = "whimsy-help-changelog-entry";
        const kind = document.createElement("span");
        kind.className = "whimsy-help-changelog-kind";
        // Reuses the same three labels as the home page's "What's new".
        document.l10n.setAttributes(kind, `whimsy-changelog-${entry.kind}`);
        const text = document.createElement("span");
        text.className = "whimsy-help-changelog-text";
        text.textContent = entry.text;
        li.append(kind, text);
        return li;
      })
    );
  }

  function render() {
    const query = search.value.trim();
    const searching = !!query;
    const bySection = searching
      ? features
      : selected == ALL
        ? features
        : features.filter(f => f.section == selected);

    const showingChangelog = !searching && selected == WHATS_NEW;
    changelogList.hidden = !showingChangelog;
    list.hidden = showingChangelog;

    if (showingChangelog) {
      empty.hidden = true;
      return;
    }

    const rows = bySection.filter(f => rowMatches(f, query));
    list.replaceChildren(...rows.map(f => renderRow(f, query)));
    if (!rows.length) {
      document.l10n.setAttributes(empty, "whimsy-help-empty-search", { query });
      empty.hidden = false;
    } else {
      empty.hidden = true;
    }
  }

  function renderRail() {
    const counts = new Map();
    for (const f of features) {
      counts.set(f.section, (counts.get(f.section) || 0) + 1);
    }
    const items = [{ id: ALL, l10nId: "whimsy-help-rail-all", count: features.length }];
    for (const section of sections) {
      items.push({ id: section, label: section, count: counts.get(section) || 0 });
    }
    items.push({ id: WHATS_NEW, l10nId: "whimsy-help-rail-whats-new", count: null });

    // Built as a flat array of nodes (not items.map(...), which returned
    // one node per item and so dropped any node a callback appended on the
    // side: replaceChildren() replaces the whole list with its arguments,
    // discarding anything appended to `rail` earlier in the same tick).
    const nodes = [];
    items.forEach((item, index) => {
      if (index == items.length - 1) {
        const sep = document.createElement("div");
        sep.className = "whimsy-help-rail-sep";
        nodes.push(sep);
      }
      const button = document.createElement("button");
      button.type = "button";
      button.className = "whimsy-help-rail-item";
      button.classList.toggle("is-selected", item.id == selected);
      const name = document.createElement("span");
      name.className = "whimsy-help-rail-name";
      if (item.l10nId) {
        document.l10n.setAttributes(name, item.l10nId);
      } else {
        name.textContent = item.label;
      }
      button.append(name);
      if (item.count != null) {
        const count = document.createElement("span");
        count.className = "whimsy-help-rail-count";
        count.textContent = item.count;
        button.append(count);
      }
      button.addEventListener("click", () => {
        selected = item.id;
        search.value = "";
        renderRail();
        render();
      });
      nodes.push(button);
    });
    rail.replaceChildren(...nodes);
  }

  function flattenChangelog(data) {
    const out = [];
    for (const group of data.groups || []) {
      for (const kind of ["new", "improved", "fixed"]) {
        for (const text of group[kind] || []) {
          out.push({ kind, text });
          if (out.length >= CHANGELOG_LIMIT) {
            return out;
          }
        }
      }
    }
    return out;
  }

  try {
    const [dataRes, changelogRes] = await Promise.all([fetch(DATA_URL), fetch(CHANGELOG_URL)]);
    const data = await dataRes.json();
    features = data.features || [];
    sections = data.sections || [];
    try {
      changelog = flattenChangelog(await changelogRes.json());
    } catch (e) {
      changelog = [];
    }
  } catch (e) {
    console.error("Whimsy: couldn't load help content", e);
  }

  renderRail();
  renderChangelog();
  render();
  search.addEventListener("input", render);
  search.focus();
})();
