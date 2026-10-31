/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// home: about:whimsy. A trusted static page (no framework): tabs for Home,
// Changelog and (legacy) Privacy. The requested tab comes from the URL
// Whimsy's about: module preserves (?tab=changelog, ?tab=privacy), so
// "What's new", whimsy://changelog and the About dialog's Privacy Notice
// land straight on their tab. A build's anchor (#v1-24b-w2) opens the
// Changelog scrolled to that build.

"use strict";

const CHANGELOG_URL = "chrome://browser/content/whimsy/whimsy-changelog.json";
const HTML_NS = "http://www.w3.org/1999/xhtml";

const TABS = ["home", "changelog", "privacy"];
const KINDS = ["new", "improved", "fixed"];
const BUILD_ANCHOR = /^(v[\w-]+|unreleased)$/;
// wave7/small: dev build IDs (1.24b-w3-dev.7) mean something only to people
// on the Dev channel (Settings > About Whimsy > Channel); on Release a dev
// build's notes show by date and title, without the ID.
const DEV_VERSION = /-dev\.\d+$/;
const CHANNEL_PREF = "whimsy.update-channel";

function showsDevBuildIds() {
  try {
    return Services.prefs.getStringPref(CHANNEL_PREF, "release") == "dev";
  } catch {
    return false;
  }
}

function anchorFromLocation() {
  try {
    return decodeURIComponent(new URL(document.location.href).hash.slice(1));
  } catch {
    return "";
  }
}

function currentTabFromLocation() {
  try {
    // The fragment (set as tabs change) wins over ?tab= (the route).
    const url = new URL(document.location.href);
    const hash = anchorFromLocation();
    if (TABS.includes(hash)) {
      return hash;
    }
    if (BUILD_ANCHOR.test(hash)) {
      return "changelog";
    }
    const tab = url.searchParams.get("tab");
    return TABS.includes(tab) ? tab : "home";
  } catch {
    return "home";
  }
}

function selectTab(tab, { fromUser = false } = {}) {
  for (const name of TABS) {
    const button = document.getElementById(`whimsy-tab-${name}`);
    button.setAttribute("aria-selected", String(name == tab));
    button.tabIndex = name == tab ? 0 : -1;
    document.getElementById(`whimsy-panel-${name}`).hidden = name != tab;
  }
  try {
    // about: URLs may only change their fragment. Leave a URL that already
    // says this tab alone (the plain homepage stays about:whimsy).
    if (currentTabFromLocation() != tab) {
      window.history.replaceState(null, "", "#" + tab);
    }
  } catch {
    // Best-effort: not having the address bar track the tab isn't fatal.
  }
  if (fromUser && window.scrollY > 0) {
    window.scrollTo({ top: 0, behavior: "instant" });
  }
}

function initTabs() {
  for (const button of document.querySelectorAll(".whimsy-home-tab")) {
    button.addEventListener("click", () => selectTab(button.dataset.tab, { fromUser: true }));
    button.addEventListener("keydown", event => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
        return;
      }
      event.preventDefault();
      const index = TABS.indexOf(button.dataset.tab);
      const step = event.key == "ArrowLeft" ? -1 : 1;
      const tab = event.key == "Home" ? TABS[0]
        : event.key == "End" ? TABS[TABS.length - 1]
        : TABS[(index + step + TABS.length) % TABS.length];
      selectTab(tab, { fromUser: true });
      document.getElementById(`whimsy-tab-${tab}`).focus();
    });
  }
  const follow = () => {
    selectTab(currentTabFromLocation());
    revealAnchoredBuild();
  };
  window.addEventListener("popstate", follow);
  window.addEventListener("hashchange", follow);
  selectTab(currentTabFromLocation());
}

// "1.24b-w2-dev.74" -> "v1-24b-w2-dev-74"; "Unreleased" -> "unreleased".
function buildAnchor(version) {
  if (version == "Unreleased") {
    return "unreleased";
  }
  return "v" + version.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function formatDate(date) {
  if (typeof date != "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return "";
  }
  try {
    return new Intl.DateTimeFormat(document.documentElement.lang || undefined, {
      dateStyle: "long",
      timeZone: "UTC",
    }).format(new Date(date + "T00:00:00Z"));
  } catch {
    return date;
  }
}

function cleanLines(value) {
  return Array.isArray(value)
    ? value.filter(line => typeof line == "string" && line.trim())
    : [];
}

// A build's notes by kind. Older data had one flat `entries` list; it reads
// as "New".
function buildSections(group) {
  const sections = {};
  for (const kind of KINDS) {
    const lines = cleanLines(group[kind]);
    if (kind == "new") {
      lines.push(...cleanLines(group.entries));
    }
    if (lines.length) {
      sections[kind] = lines;
    }
  }
  return sections;
}

function el(tag, className, text) {
  const node = document.createElementNS(HTML_NS, tag);
  if (className) {
    node.className = className;
  }
  if (text != null) {
    node.textContent = text;
  }
  return node;
}

function renderBuild(group, sections, isLatest, showDevIds = showsDevBuildIds()) {
  const unreleased = group.version == "Unreleased";
  const anchor = buildAnchor(group.version);
  const hideId = !showDevIds && DEV_VERSION.test(group.version);

  const article = el("article", "whimsy-changelog-group");
  article.id = anchor;
  if (isLatest) {
    article.classList.add("is-latest");
  }

  const meta = el("div", "wh-build-meta");
  const when = el("p", "wh-build-date");
  if (unreleased) {
    document.l10n.setAttributes(when, "whimsy-changelog-unreleased");
  } else {
    const formatted = formatDate(group.date);
    if (formatted) {
      const time = el("time", null, formatted);
      time.setAttribute("datetime", group.date);
      when.appendChild(time);
    }
  }
  meta.appendChild(when);
  const chips = el("p", "wh-build-chips");
  if (!unreleased && !hideId) {
    chips.appendChild(el("span", "whimsy-changelog-version", group.version));
  }
  if (isLatest) {
    const latest = el("span", "wh-latest");
    document.l10n.setAttributes(latest, "whimsy-changelog-latest");
    chips.appendChild(latest);
  }
  meta.appendChild(chips);
  article.appendChild(meta);

  const card = el("div", "wh-build-card");
  const heading = el("h3", "wh-build-title");
  const title = typeof group.title == "string" && group.title.trim() ? group.title : null;
  const titleText = el("span");
  if (title) {
    titleText.textContent = title;
  } else if (unreleased) {
    document.l10n.setAttributes(titleText, "whimsy-changelog-unreleased");
  } else if (hideId) {
    document.l10n.setAttributes(titleText, "whimsy-changelog-dev-build");
  } else {
    titleText.textContent = group.version;
  }
  heading.appendChild(titleText);
  const link = el("a", "wh-anchor");
  link.href = "#" + anchor;
  const linkName = hideId ? title || formatDate(group.date) || "" : group.version;
  document.l10n.setAttributes(link, "whimsy-changelog-anchor", { version: linkName });
  heading.appendChild(link);
  card.appendChild(heading);

  for (const kind of KINDS) {
    if (!sections[kind]) {
      continue;
    }
    const section = el("section", `wh-kind wh-kind-${kind}`);
    const label = el("h4", "wh-kind-label");
    document.l10n.setAttributes(label, `whimsy-changelog-${kind}`);
    section.appendChild(label);
    const entries = el("ul", "whimsy-changelog-entries");
    for (const line of sections[kind]) {
      entries.appendChild(el("li", null, line));
    }
    section.appendChild(entries);
    card.appendChild(section);
  }
  article.appendChild(card);
  return article;
}

function renderChangelog(groups) {
  const list = document.getElementById("whimsy-changelog-list");
  const empty = document.getElementById("whimsy-changelog-empty");
  list.replaceChildren();
  const builds = (Array.isArray(groups) ? groups : [])
    .filter(g => g && typeof g.version == "string" && g.version.trim())
    .map(g => [g, buildSections(g)])
    .filter(([, sections]) => Object.keys(sections).length);
  empty.hidden = !!builds.length;
  const showDevIds = showsDevBuildIds();
  builds.forEach(([group, sections], i) => {
    list.appendChild(renderBuild(group, sections, i == 0, showDevIds));
  });
}

// The changelog arrives after the first layout, so the browser's own jump
// to the fragment has nothing to land on yet.
function revealAnchoredBuild() {
  const anchor = anchorFromLocation();
  if (!BUILD_ANCHOR.test(anchor)) {
    return;
  }
  const target = document.getElementById(anchor);
  if (target && target.closest("#whimsy-changelog-list")) {
    target.scrollIntoView({ block: "start" });
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
  revealAnchoredBuild();
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

// The mascot bobs on its own; a poke makes it squash and spring back up.
function initBalloon() {
  const balloon = document.getElementById("whimsy-home-balloon");
  balloon.addEventListener("click", () => {
    balloon.classList.remove("is-poked");
    // Restart the animation when poked again mid-bounce.
    void balloon.offsetWidth;
    balloon.classList.add("is-poked");
  });
  balloon.addEventListener("animationend", event => {
    if (event.animationName == "wh-poke") {
      balloon.classList.remove("is-poked");
    }
  });
}

// The balloon dresses for the season (whimsy-home.css shows the costume).
// Rechecked whenever the page is shown, so a tab kept open across a season
// boundary or the seasonal switch catches up without a timer.
function applySeason() {
  let season = null;
  try {
    const { WhimsySeasons } = ChromeUtils.importESModule(
      "resource:///modules/whimsy/WhimsySeasons.sys.mjs"
    );
    season = WhimsySeasons.current()?.id ?? null;
  } catch {
    // No calendar: the balloon simply stays undressed.
  }
  if (season) {
    document.documentElement.setAttribute("whimsy-season", season);
  } else {
    document.documentElement.removeAttribute("whimsy-season");
  }
}

document.addEventListener("DOMContentLoaded", () => {
  applySeason();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState == "visible") {
      applySeason();
    }
  });
  initTabs();
  initImportFromArc();
  initBalloon();
  loadChangelog();
});
