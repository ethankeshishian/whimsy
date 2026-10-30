/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Year in tabs (whimsy://year): a private, on-device recap in the spirit of
// Spotify Wrapped - a handful of full-bleed cards (top sites, busiest
// day/hour, tabs opened, your most-used space, your longest-open tab, a
// "night owl" score), built entirely from this profile's own Places history
// and a small local counter (WhimsyStats.sys.mjs). Nothing here is sent
// anywhere; there's no network request on this page at all.
//
// Loaded with the system principal (about:whimsy, see WhimsyAboutPage.sys.mjs),
// so it can query Places and read Whimsy's own modules directly.

"use strict";

(async () => {
  const FEATURE_PREF = "whimsy.feature.year-in-tabs";
  const root = document.getElementById("whimsy-year-root");

  if (!Services.prefs.getBoolPref(FEATURE_PREF, true)) {
    root.textContent = "";
    const off = document.createElement("p");
    off.id = "whimsy-year-off";
    off.style.color = "#fff";
    off.style.margin = "auto";
    off.style.fontFamily = "system-ui, sans-serif";
    off.textContent = "Year in tabs is turned off (whimsy.feature.year-in-tabs).";
    root.append(off);
    return;
  }

  const { PlacesUtils } = ChromeUtils.importESModule("resource://gre/modules/PlacesUtils.sys.mjs");
  const { WhimsyStats } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyStats.sys.mjs");

  const deck = document.getElementById("whimsy-year-deck");
  const emptyEl = document.getElementById("whimsy-year-empty");
  const cardsEl = document.getElementById("whimsy-year-cards");
  const dotsEl = document.getElementById("whimsy-year-dots");
  const statusEl = document.getElementById("whimsy-year-status");
  const prevBtn = document.getElementById("whimsy-year-prev");
  const nextBtn = document.getElementById("whimsy-year-next");
  const copyBtn = document.getElementById("whimsy-year-copy");
  const doneBtn = document.getElementById("whimsy-year-done");

  const GRADIENTS = [
    ["#2b1055", "#7597de"],
    ["#1b1035", "#c86dd7"],
    ["#0f2027", "#2c5364"],
    ["#3a1c71", "#d76d77"],
    ["#0f0c29", "#302b63"],
    ["#4e0329", "#9b0e42"],
    ["#1a2980", "#26d0ce"],
  ];
  const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  function hourLabel(h) {
    const hour12 = h % 12 == 0 ? 12 : h % 12;
    return `${hour12}${h < 12 ? "am" : "pm"}`;
  }

  function humanizeMs(ms) {
    const minutes = Math.round(ms / 60000);
    if (minutes < 60) {
      return `${Math.max(1, minutes)}m`;
    }
    const hours = Math.round(minutes / 60);
    if (hours < 48) {
      return `${hours}h`;
    }
    return `${Math.round(hours / 24)}d`;
  }

  function hostFromUrl(url) {
    try {
      return new URL(url).host || url;
    } catch (e) {
      return url;
    }
  }

  // This calendar year's visits, straight from Places - nothing cached,
  // nothing sent anywhere.
  async function queryYearData() {
    const year = new Date().getFullYear();
    const yearStart = new Date(year, 0, 1).getTime() * 1000; // PRTime (us)
    const yearEnd = new Date(year + 1, 0, 1).getTime() * 1000;
    const db = await PlacesUtils.promiseDBConnection();
    const params = { yearStart, yearEnd };

    const topSitesRows = await db.executeCached(
      `SELECT p.url AS url, p.title AS title, COUNT(*) AS cnt
       FROM moz_historyvisits v JOIN moz_places p ON p.id = v.place_id
       WHERE v.visit_date >= :yearStart AND v.visit_date < :yearEnd AND p.hidden = 0
       GROUP BY v.place_id ORDER BY cnt DESC LIMIT 5`,
      params
    );
    const busiestRows = await db.executeCached(
      `SELECT CAST(strftime('%w', datetime(v.visit_date/1000000,'unixepoch','localtime')) AS INTEGER) AS dow,
              CAST(strftime('%H', datetime(v.visit_date/1000000,'unixepoch','localtime')) AS INTEGER) AS hr,
              COUNT(*) AS cnt
       FROM moz_historyvisits v
       WHERE v.visit_date >= :yearStart AND v.visit_date < :yearEnd
       GROUP BY dow, hr ORDER BY cnt DESC LIMIT 1`,
      params
    );
    const nightRows = await db.executeCached(
      `SELECT
         SUM(CASE WHEN CAST(strftime('%H', datetime(v.visit_date/1000000,'unixepoch','localtime')) AS INTEGER) >= 22
                   OR CAST(strftime('%H', datetime(v.visit_date/1000000,'unixepoch','localtime')) AS INTEGER) < 4
              THEN 1 ELSE 0 END) AS night,
         COUNT(*) AS total
       FROM moz_historyvisits v
       WHERE v.visit_date >= :yearStart AND v.visit_date < :yearEnd`,
      params
    );

    return {
      year,
      topSites: topSitesRows.map(r => ({
        url: r.getResultByName("url"),
        title: r.getResultByName("title"),
        count: r.getResultByName("cnt"),
      })),
      busiest: busiestRows.length
        ? { day: busiestRows[0].getResultByName("dow"), hour: busiestRows[0].getResultByName("hr") }
        : null,
      night: nightRows.length
        ? { night: nightRows[0].getResultByName("night") || 0, total: nightRows[0].getResultByName("total") || 0 }
        : { night: 0, total: 0 },
    };
  }

  function makeCard({ index, titleL10n, titleArgs, bodyL10n, bodyArgs, extraNodes }) {
    const card = document.createElement("section");
    card.className = "whimsy-year-card";
    card.dataset.card = String(index);
    card.style.setProperty("--whimsy-year-a", GRADIENTS[index % GRADIENTS.length][0]);
    card.style.setProperty("--whimsy-year-b", GRADIENTS[index % GRADIENTS.length][1]);

    const title = document.createElement("h2");
    title.className = "whimsy-year-card-title";
    document.l10n.setAttributes(title, titleL10n, titleArgs);
    card.append(title);

    if (bodyL10n) {
      const body = document.createElement("p");
      body.className = "whimsy-year-card-body";
      document.l10n.setAttributes(body, bodyL10n, bodyArgs);
      card.append(body);
    }
    for (const node of extraNodes ?? []) {
      card.append(node);
    }
    return card;
  }

  function l10nParagraph(id, args) {
    const p = document.createElement("p");
    p.className = "whimsy-year-card-body";
    document.l10n.setAttributes(p, id, args);
    return p;
  }

  function topSitesList(topSites) {
    const list = document.createElement("ul");
    list.className = "whimsy-year-card-list";
    for (const site of topSites) {
      const li = document.createElement("li");
      const name = document.createElement("span");
      name.textContent = site.title || hostFromUrl(site.url);
      const count = document.createElement("span");
      count.textContent = String(site.count);
      li.append(name, count);
      list.append(li);
    }
    return list;
  }

  function buildCards(data, counter, topSpace, longest) {
    const nightPercent = data.night.total ? Math.round((data.night.night / data.night.total) * 100) : 0;
    const nightVerdict =
      nightPercent >= 40 ? "whimsy-year-nightowl-high" : nightPercent >= 15 ? "whimsy-year-nightowl-mid" : "whimsy-year-nightowl-low";

    const specs = [
      {
        titleL10n: "whimsy-year-welcome-title",
        titleArgs: { year: data.year },
        bodyL10n: "whimsy-year-welcome-body",
      },
      {
        titleL10n: "whimsy-year-opened-title",
        bodyL10n: "whimsy-year-opened-body",
        bodyArgs: { count: counter.total || 0 },
        extraNodes: topSpace ? [l10nParagraph("whimsy-year-opened-space", { space: topSpace.name })] : [],
      },
    ];
    if (data.topSites.length) {
      specs.push({ titleL10n: "whimsy-year-topsites-title", extraNodes: [topSitesList(data.topSites)] });
    }
    if (data.busiest) {
      specs.push({
        titleL10n: "whimsy-year-busiest-title",
        bodyL10n: "whimsy-year-busiest-body",
        bodyArgs: { day: DAY_NAMES[data.busiest.day] ?? "", hour: hourLabel(data.busiest.hour) },
      });
    }
    if (topSpace) {
      specs.push({
        titleL10n: "whimsy-year-space-title",
        bodyL10n: "whimsy-year-space-body",
        bodyArgs: { space: topSpace.name, percent: topSpace.percent },
      });
    }
    if (longest) {
      specs.push({
        titleL10n: "whimsy-year-longest-title",
        bodyL10n: "whimsy-year-longest-body",
        bodyArgs: { title: longest.title || hostFromUrl(longest.url), duration: humanizeMs(longest.ms) },
      });
    }
    if (data.night.total) {
      specs.push({
        titleL10n: "whimsy-year-nightowl-title",
        bodyL10n: "whimsy-year-nightowl-body",
        bodyArgs: { percent: nightPercent },
        extraNodes: [l10nParagraph(nightVerdict)],
      });
    }
    return specs.map((spec, index) => makeCard({ ...spec, index }));
  }

  let currentIndex = 0;
  let cardEls = [];

  function renderNav() {
    for (const [i, el] of cardEls.entries()) {
      el.toggleAttribute("data-active", i == currentIndex);
    }
    for (const [i, dot] of Array.from(dotsEl.children).entries()) {
      dot.toggleAttribute("data-active", i == currentIndex);
    }
    cardsEl.dataset.card = String(currentIndex);
    prevBtn.disabled = currentIndex == 0;
    nextBtn.disabled = currentIndex == cardEls.length - 1;
    document.l10n.setAttributes(statusEl, "whimsy-year-progress", {
      current: currentIndex + 1,
      total: cardEls.length,
    });
  }

  function goTo(index) {
    currentIndex = Math.max(0, Math.min(cardEls.length - 1, index));
    renderNav();
  }

  async function copyCurrentCard() {
    try {
      const cardEl = cardEls[currentIndex];
      const rect = cardEl.getBoundingClientRect();
      const windowGlobal = window.browsingContext.currentWindowGlobal;
      const bitmap = await windowGlobal.drawSnapshot(
        new DOMRect(rect.x, rect.y, rect.width, rect.height),
        window.devicePixelRatio || 1,
        "white",
        { drawView: true }
      );
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext("bitmaprenderer").transferFromImageBitmap(bitmap);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
      const { ScreenshotsUtils } = ChromeUtils.importESModule(
        "moz-src:///browser/components/screenshots/ScreenshotsUtils.sys.mjs"
      );
      const browser = window.browsingContext.embedderElement;
      await ScreenshotsUtils.copyScreenshot(blob, browser, "WhimsyYearInTabs");
      browser?.documentGlobal?.gZenUIManager?.showToast?.("whimsy-year-copied-toast", {});
    } catch (e) {
      console.error("Whimsy: Year in tabs - copy card failed", e);
    }
  }

  prevBtn.addEventListener("click", () => goTo(currentIndex - 1));
  nextBtn.addEventListener("click", () => goTo(currentIndex + 1));
  copyBtn.addEventListener("click", copyCurrentCard);
  doneBtn.addEventListener("click", () => {
    const browser = window.browsingContext.embedderElement;
    const win = browser?.documentGlobal;
    const tab = win?.gBrowser?.getTabForBrowser?.(browser);
    if (tab) {
      win.gBrowser.removeTab(tab);
    }
  });
  window.addEventListener("keydown", event => {
    if (event.key == "ArrowRight") {
      goTo(currentIndex + 1);
    } else if (event.key == "ArrowLeft") {
      goTo(currentIndex - 1);
    } else if (event.key == "Escape") {
      doneBtn.click();
    }
  });

  const data = await queryYearData();
  const counter = WhimsyStats.getCounter();
  const win = Services.wm.getMostRecentBrowserWindow();
  const bySpace = Object.entries(counter.bySpace || {}).sort((a, b) => b[1] - a[1]);
  const topSpace = bySpace.length
    ? {
        name: win?.gZenWorkspaces?.getWorkspaceFromId?.(bySpace[0][0])?.name || bySpace[0][0],
        percent: counter.total ? Math.round((bySpace[0][1] / counter.total) * 100) : 0,
      }
    : null;
  const closedLongest = WhimsyStats.getLongestClosedTab();
  const liveLongest = WhimsyStats.getLiveLongestTab();
  const longest = !closedLongest || (liveLongest && liveLongest.ms > closedLongest.ms) ? liveLongest : closedLongest;

  const hasData = !!(data.topSites.length || data.busiest || data.night.total || counter.total || topSpace || longest);
  if (!hasData) {
    deck.hidden = true;
    emptyEl.hidden = false;
    window.__whimsyYear = { cardCount: 0 };
    return;
  }
  deck.hidden = false;
  emptyEl.hidden = true;

  cardEls = buildCards(data, counter, topSpace, longest);
  for (const card of cardEls) {
    cardsEl.append(card);
  }
  for (let i = 0; i < cardEls.length; i++) {
    dotsEl.append(document.createElement("span"));
  }
  goTo(0);

  window.__whimsyYear = {
    get cardIndex() {
      return currentIndex;
    },
    get cardCount() {
      return cardEls.length;
    },
    goTo,
  };
})();
