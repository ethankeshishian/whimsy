/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// home: about:whimsy. A trusted static page (no framework): two
// tabs, Home and Changelog. The requested tab comes from the URL Whimsy's
// about: module preserves (?tab=changelog), so "What's new" and
// whimsy://changelog land straight on the Changelog tab.

"use strict";

const CHANGELOG_URL = "chrome://browser/content/whimsy/whimsy-changelog.json";

function currentTabFromLocation() {
  try {
    // The fragment (set as tabs change) wins over ?tab= (the route).
    const url = new URL(document.location.href);
    const tab = url.hash.slice(1) || url.searchParams.get("tab");
    return tab == "changelog" ? "changelog" : "home";
  } catch {
    return "home";
  }
}

function selectTab(tab) {
  const isChangelog = tab == "changelog";
  for (const [id, name] of [
    ["whimsy-tab-home", "home"],
    ["whimsy-tab-changelog", "changelog"],
  ]) {
    const button = document.getElementById(id);
    button.setAttribute("aria-selected", String(name == tab));
    button.tabIndex = name == tab ? 0 : -1;
  }
  document.getElementById("whimsy-panel-home").hidden = isChangelog;
  document.getElementById("whimsy-panel-changelog").hidden = !isChangelog;
  try {
    // about: URLs may only change their fragment. Leave a URL that already
    // says this tab alone (the plain homepage stays about:whimsy).
    if (currentTabFromLocation() != tab) {
      window.history.replaceState(null, "", "#" + tab);
    }
  } catch {
    // Best-effort: not having the address bar track the tab isn't fatal.
  }
}

function initTabs() {
  for (const button of document.querySelectorAll(".whimsy-home-tab")) {
    button.addEventListener("click", () => selectTab(button.dataset.tab));
    button.addEventListener("keydown", event => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
        return;
      }
      event.preventDefault();
      const tab = event.key == "Home" ? "home" : event.key == "End" ? "changelog"
        : button.dataset.tab == "home" ? "changelog" : "home";
      selectTab(tab);
      document.getElementById(`whimsy-tab-${tab}`).focus();
    });
  }
  window.addEventListener("popstate", () => selectTab(currentTabFromLocation()));
  selectTab(currentTabFromLocation());
}

function renderChangelog(groups) {
  const list = document.getElementById("whimsy-changelog-list");
  const empty = document.getElementById("whimsy-changelog-empty");
  list.replaceChildren();
  const nonEmptyGroups = Array.isArray(groups) ? groups.filter(g =>
    g && typeof g.version == "string" && Array.isArray(g.entries) &&
    g.entries.some(line => typeof line == "string" && line.trim())
  ) : [];
  empty.hidden = !!nonEmptyGroups.length;
  if (!nonEmptyGroups.length) {
    empty.hidden = false;
    return;
  }
  for (const group of nonEmptyGroups) {
    const section = document.createElementNS("http://www.w3.org/1999/xhtml", "div");
    section.className = "whimsy-changelog-group";

    const version = document.createElementNS("http://www.w3.org/1999/xhtml", "h2");
    version.className = "whimsy-changelog-version";
    if (group.version == "Unreleased") {
      document.l10n.setAttributes(version, "whimsy-changelog-unreleased");
    } else {
      version.textContent = group.version;
    }
    section.appendChild(version);

    const entries = document.createElementNS("http://www.w3.org/1999/xhtml", "ul");
    entries.className = "whimsy-changelog-entries";
    for (const line of group.entries.filter(line => typeof line == "string" && line.trim())) {
      const item = document.createElementNS("http://www.w3.org/1999/xhtml", "li");
      item.textContent = line;
      entries.appendChild(item);
    }
    section.appendChild(entries);
    list.appendChild(section);
  }
}

async function loadChangelog() {
  try {
    const response = await fetch(CHANGELOG_URL);
    const data = await response.json();
    renderChangelog(data.groups);
  } catch (e) {
    console.error("Whimsy: couldn't load the changelog", e);
    renderChangelog([]);
  }
}

function initImportFromArc() {
  const button = document.getElementById("whimsy-home-link-import");
  button.addEventListener("click", () => {
    try {
      const { MigrationUtils } = ChromeUtils.importESModule(
        "moz-src:///browser/components/migration/MigrationUtils.sys.mjs"
      );
      const win = window.browsingContext.topChromeWindow;
      MigrationUtils.showMigrationWizard(win, {
        migratorKey: "arc",
        entrypoint: MigrationUtils.MIGRATION_ENTRYPOINTS.UNKNOWN,
        skipSourceSelection: false,
      });
    } catch (e) {
      console.error("Whimsy: couldn't open the Arc importer", e);
    }
  });
}

document.addEventListener("DOMContentLoaded", () => {
  initTabs();
  initImportFromArc();
  loadChangelog();
});
