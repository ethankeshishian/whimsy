/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

// batch hover: Arc-style hover cards. Tabs: Firefox's own tab preview, on
// by default. History: the shared card, from the row's own visit.

const { WhimsyHoverCard } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyHoverCard.sys.mjs"
);

const wait = ms => new Promise(resolve => setTimeout(resolve, ms)); // eslint-disable-line mozilla/no-arbitrary-setTimeout

add_task(async function tab_hover_preview_on_by_default() {
  ok(
    Services.prefs.getDefaultBranch("").getBoolPref("browser.tabs.hoverPreview.enabled"),
    "Firefox's tab hover card is on by default (Arc parity)"
  );
});

add_task(async function card_delay_cancel_and_text_only() {
  await SimpleTest.promiseFocus(window); // Panels open only in a focused window.
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.history-preview", true]] });
  const anchor = gBrowser.selectedTab;
  const card = WhimsyHoverCard.forWindow(window);
  let loads = 0;
  const load = async () => {
    ++loads;
    return {
      title: "<b>History title</b>",
      url: "https://example.com/",
      image: null,
      emptyImageL10nId: "whimsy-hover-no-preview",
    };
  };
  try {
    card.schedule(anchor, load, "whimsy.feature.history-preview");
    card.leave(anchor);
    await wait(WhimsyHoverCard.ENTER_DELAY_MS + 150);
    is(loads, 0, "A brief hover never loads anything");

    card.schedule(anchor, load, "whimsy.feature.history-preview");
    await TestUtils.waitForCondition(() => card.panel?.state == "open", "Card opens after the delay");
    is(
      card.panel.querySelector(".whimsy-hover-title").textContent,
      "<b>History title</b>",
      "Titles are text, never markup"
    );
    ok(!card.panel.querySelector("img"), "No saved thumbnail: no broken image");
    ok(
      card.panel.querySelector("[data-l10n-id='whimsy-hover-no-preview']"),
      "No saved thumbnail: an honest empty state"
    );
    card.hide();
    await TestUtils.waitForCondition(() => card.panel.state == "closed");

    Services.prefs.setBoolPref("whimsy.feature.history-preview", false);
    card.schedule(anchor, load, "whimsy.feature.history-preview");
    await wait(WhimsyHoverCard.ENTER_DELAY_MS + 150);
    is(card.panel.state, "closed", "Feature off: no card");
    is(
      await WhimsyHoverCard.cachedThumbnail("https://example.com/whimsy-never-captured"),
      null,
      "An uncached page has no thumbnail (nothing is loaded or captured)"
    );
  } finally {
    card.hide();
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function history_row_uses_its_own_visit() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.history-preview", true]] });
  const card = WhimsyHoverCard.forWindow(window);
  const section = document.createXULElement("vbox");
  section.dataset.section = "history";
  const rows = ["one", "two"].map(name => {
    const row = document.createXULElement("hbox");
    row.className = "zen-library-row";
    row.whimsyVisit = { url: `https://example.com/${name}`, title: `Visit ${name}` };
    section.append(row);
    return row;
  });
  // A row without a visit (or a non-web visit) never opens a card.
  const plain = document.createXULElement("hbox");
  plain.className = "zen-library-row";
  plain.whimsyVisit = { url: "about:config", title: "Config" };
  section.append(plain);
  document.getElementById("mainPopupSet").before(section);
  try {
    rows[1].dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    await TestUtils.waitForCondition(() => card.panel?.state == "open");
    is(card.panel.querySelector(".whimsy-hover-title").textContent, "Visit two", "Second row, second visit");
    rows[1].dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
    await TestUtils.waitForCondition(() => card.panel.state == "closed", "Leaving the row closes the card");

    plain.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    await wait(WhimsyHoverCard.ENTER_DELAY_MS + 150);
    is(card.panel.state, "closed", "Non-web history entries get no card");
  } finally {
    card.hide();
    section.remove();
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function firefox_owns_the_only_tab_preview_setting() {
  await BrowserTestUtils.withNewTab("about:preferences#zenTabManagement", async browser => {
    const doc = browser.contentDocument;
    await TestUtils.waitForCondition(() => doc.getElementById("whimsyHoverGroup"));
    ok(!doc.getElementById("whimsyHoverTabs"), "No duplicate Whimsy tab-preview checkbox");
    is(doc.getElementById("whimsyHoverGroup").querySelectorAll('[preference="browser.tabs.hoverPreview.enabled"]').length, 0,
      "Whimsy leaves tab previews to Firefox’s existing setting");
    ok(doc.getElementById("whimsyHoverHistory"), "Whimsy-only History option remains");
    ok(doc.getElementById("whimsyHoverPeople"), "Whimsy-only People option remains");
  });
});
