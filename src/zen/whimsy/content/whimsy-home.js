/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// home: about:whimsy. A chrome-privileged static page (no framework): two
// tabs, Home and Changelog. The requested tab comes from the URL Whimsy's
// about: module preserves (?tab=changelog), so "What's new" and
// whimsy://changelog land straight on the Changelog tab.

"use strict";

const CHANGELOG_URL = "chrome://browser/content/whimsy/whimsy-changelog.json";

function currentTabFromLocation() {
  try {
    return new URL(document.location.href).searchParams.get("tab") == "changelog"
      ? "changelog"
      : "home";
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
    document.getElementById(id).setAttribute("aria-selected", String(name == tab));
  }
  document.getElementById("whimsy-panel-home").hidden = isChangelog;
  document.getElementById("whimsy-panel-changelog").hidden = !isChangelog;
  try {
    const url = "about:whimsy" + (isChangelog ? "?tab=changelog" : "");
    window.history.replaceState(null, "", url);
  } catch {
    // Best-effort: not having the address bar track the tab isn't fatal.
  }
}

function initTabs() {
  for (const button of document.querySelectorAll(".whimsy-home-tab")) {
    button.addEventListener("click", () => selectTab(button.dataset.tab));
  }
  selectTab(currentTabFromLocation());
}

function renderChangelog(groups) {
  const list = document.getElementById("whimsy-changelog-list");
  const empty = document.getElementById("whimsy-changelog-empty");
  const nonEmptyGroups = (groups || []).filter(g => g.entries && g.entries.length);
  if (!nonEmptyGroups.length) {
    empty.hidden = false;
    return;
  }
  for (const group of nonEmptyGroups) {
    const section = document.createElement("div");
    section.className = "whimsy-changelog-group";

    const version = document.createElement("p");
    version.className = "whimsy-changelog-version";
    version.textContent = group.version;
    section.appendChild(version);

    const entries = document.createElement("ul");
    entries.className = "whimsy-changelog-entries";
    for (const line of group.entries) {
      const item = document.createElement("li");
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
    document.getElementById("whimsy-changelog-empty").hidden = false;
  }
}

function initImportFromArc() {
  const button = document.getElementById("whimsy-home-link-import");
  button.addEventListener("click", async () => {
    try {
      const { MigrationUtils } = ChromeUtils.importESModule(
        "resource:///modules/MigrationUtils.sys.mjs"
      );
      const win = window.browsingContext.topChromeWindow;
      await MigrationUtils.showMigrationWizard(win, {
        migratorKey: "arc",
        entrypoint: MigrationUtils.MIGRATION_ENTRYPOINTS.UNKNOWN,
        skipSourceSelection: true,
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
