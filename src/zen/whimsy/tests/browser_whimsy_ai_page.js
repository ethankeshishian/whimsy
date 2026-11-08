/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Ask on Page (Arc Max): when Cmd+F finds nothing, an Ask button appears and
// Enter asks the AI about the page; the answer quotes the page and "Find on
// Page" jumps there. 5-second previews: Shift on a link shows a card with a
// summary of the page behind it, read with the tab's own session; never in
// private windows. A fake AI provider answers.

const { WhimsyAIProviders } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIProviders.sys.mjs");
const { WhimsyAIReader } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIReader.sys.mjs");
const { WhimsyAIPage } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIPage.sys.mjs");

const ROOT = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com");
const PAGE = ROOT + "whimsy_ai_page.html";
const LINKS = ROOT + "whimsy_ai_links.html";
const AT = { x: 10, y: 10, width: 10, height: 10 };

let requests = [];
function fakeProvider({ prompt, system }) {
  requests.push({ prompt, system });
  if (/Ask on Page/.test(system)) {
    return JSON.stringify({
      answer: "The offsite is in Lisbon on March 14.",
      quote: "The offsite is on March 14 in Lisbon.",
    });
  }
  if (/link preview/.test(system)) {
    return JSON.stringify({ title: "Planning notes", points: ["Offsite in Lisbon", "Espresso machine $129", "Budget: Priya"] });
  }
  return "";
}

add_setup(async () => {
  WhimsyAIProviders.setTestProvider(fakeProvider);
  registerCleanupFunction(() => {
    WhimsyAIProviders.setTestProvider(null);
    WhimsyAIReader.setTestReader(null);
    for (const pref of ["whimsy.ai.order", "whimsy.feature.ask-on-page", "whimsy.feature.link-previews", "whimsy.feature.link-cards"]) {
      Services.prefs.clearUserPref(pref);
    }
    Services.prefs.setBoolPref("whimsy.ai.enabled", true);
  });
});

async function openFind(text) {
  const findbar = await gBrowser.getFindBar();
  findbar.open();
  const field = findbar._findField;
  field.focus();
  field.select();
  EventUtils.sendString(text);
  return findbar;
}

function askButton(findbar) {
  return findbar.querySelector(".whimsy-ask-button");
}

add_task(async function test_ask_on_page() {
  ok(Services.prefs.getBoolPref("whimsy.feature.ask-on-page"), "The feature switch is on");
  await BrowserTestUtils.withNewTab(PAGE, async () => {
    // Something on the page: plain Find, no Ask.
    let findbar = await openFind("Lisbon");
    await TestUtils.waitForCondition(() => findbar._findField.getAttribute("status") != "pending", "Find ran");
    await new Promise(r => setTimeout(r, 300));
    ok(askButton(findbar)?.hidden, "Found text doesn't offer Ask");

    // Not on the page: Ask appears, and Enter asks.
    requests = [];
    findbar = await openFind("where is the offsite");
    await TestUtils.waitForCondition(() => !askButton(findbar).hidden, "The Ask button appears when nothing is found");
    EventUtils.synthesizeKey("KEY_Enter");
    const panel = await TestUtils.waitForCondition(() => {
      const p = document.getElementById("whimsy-ask-panel");
      return p?.state == "open" && p.querySelector(".whimsy-ask-answer") && p;
    }, "The answer shows");
    is(panel.querySelector(".whimsy-ask-answer").textContent, "The offsite is in Lisbon on March 14.", "The AI's answer");
    is(panel.querySelector(".whimsy-ask-question").textContent, "where is the offsite", "under the question");
    const req = requests.find(r => /Ask on Page/.test(r.system));
    ok(req && req.prompt.includes("espresso machine costs"), "The page's text went with the question");
    is(panel.querySelector(".whimsy-ask-quote")?.textContent, "The offsite is on March 14 in Lisbon.", "The supporting passage is quoted");

    // Find on Page jumps to the passage.
    panel.querySelector(".whimsy-ask-find").click();
    await TestUtils.waitForCondition(() => findbar._findField.value.startsWith("The offsite is on"), "Find on Page searches for the quote");
    await TestUtils.waitForCondition(() => panel.state == "closed", "and closes the answer");

    // A made-up quote isn't offered.
    WhimsyAIProviders.setTestProvider(() => JSON.stringify({ answer: "Yes.", quote: "Something the page never says at all." }));
    findbar = await openFind("is there a quote");
    await TestUtils.waitForCondition(() => !askButton(findbar).hidden, "Ask again");
    askButton(findbar).doCommand();
    await TestUtils.waitForCondition(() => panel.state == "open" && panel.querySelector(".whimsy-ask-answer"), "Answered");
    ok(!panel.querySelector(".whimsy-ask-quote"), "No quote that isn't on the page");
    WhimsyAIProviders.setTestProvider(fakeProvider);
    panel.hidePopup();

    // The kill switch hides Ask.
    Services.prefs.setBoolPref("whimsy.ai.enabled", false);
    findbar = await openFind("still not here");
    await new Promise(r => setTimeout(r, 300));
    ok(askButton(findbar).hidden, "No Ask with AI turned off");
    requests = [];
    EventUtils.synthesizeKey("KEY_Enter");
    await new Promise(r => setTimeout(r, 300));
    is(requests.length, 0, "Enter just finds again");
    Services.prefs.setBoolPref("whimsy.ai.enabled", true);
    findbar.close();
  });
});

add_task(async function test_reader_uses_the_session() {
  WhimsyAIReader.setTestReader(null);
  const page = await WhimsyAIReader.readUrl(PAGE);
  ok(page.text.includes("Lisbon"), "A page is read in the background");
  ok(page.title.includes("Quarterly"), "with its title");
  const inContainer = await WhimsyAIReader.readUrl(PAGE, { userContextId: 1 });
  ok(inContainer.text.includes("Lisbon"), "also inside a container");
  const controller = new AbortController();
  const aborted = WhimsyAIReader.readUrl(PAGE, { signal: controller.signal });
  controller.abort();
  await Assert.rejects(aborted, /./, "Reading can be cancelled");
});

async function hoverLink(browser, shiftKey) {
  await BrowserTestUtils.synthesizeMouseAtCenter("#away", { type: "mousemove" }, browser);
  await BrowserTestUtils.synthesizeMouseAtCenter("#link", { type: "mousemove", shiftKey }, browser);
}

add_task(async function test_preview() {
  ok(Services.prefs.getBoolPref("whimsy.feature.link-previews"), "The feature switch is on");
  const read = [];
  WhimsyAIReader.setTestReader((url, options) => {
    read.push({ url, options });
    return "The offsite is on March 14 in Lisbon. The espresso machine costs $129.";
  });
  await BrowserTestUtils.withNewTab(LINKS, async browser => {
    // Plain hover on an ordinary site: nothing.
    await hoverLink(browser, false);
    await new Promise(r => setTimeout(r, 800));
    ok(document.getElementById("whimsy-link-hover")?.state != "open", "No card without Shift here");
    is(read.length, 0, "and nothing is fetched");

    await hoverLink(browser, true);
    // wave7/ux: the summary is the AI card of the link hover host, under
    // the link card.
    const card = await TestUtils.waitForCondition(() => {
      const c = document.getElementById("whimsy-link-hover");
      return c?.state == "open" && c.querySelector('[data-card="ai"] .whimsy-preview-points') && c;
    }, "Shift on a link shows the summary card");
    ok(card.querySelector('[data-card="link"]'), "...beneath the link card");
    Assert.deepEqual(
      [...card.querySelectorAll(".whimsy-preview-points li")].map(li => li.textContent),
      ["Offsite in Lisbon", "Espresso machine $129", "Budget: Priya"],
      "with the AI's points"
    );
    is(card.querySelector(".whimsy-preview-title").textContent, "Planning notes", "and title");
    is(read[0].url, PAGE, "The linked page was read");
    ok(read[0].options.removeBoilerplate, "as an article");

    // Moving away closes it.
    await BrowserTestUtils.synthesizeMouseAtCenter("#away", { type: "mousemove" }, browser);
    await TestUtils.waitForCondition(() => card.state == "closed", "Leaving the link closes the card");

    // Again: from the cache, no second read.
    await hoverLink(browser, true);
    await TestUtils.waitForCondition(() => card.state == "open" && card.querySelector(".whimsy-preview-points"), "Shown again");
    is(read.length, 1, "from the cache");
    WhimsyAIPage.hidePreview(window);

    // Off: no summary (the link card alone, or nothing once it's off too).
    Services.prefs.setBoolPref("whimsy.feature.link-previews", false);
    await hoverLink(browser, true);
    await TestUtils.waitForCondition(() => card.state == "open", "The link card still shows");
    ok(!card.querySelector('[data-card="ai"]'), "No summary with the switch off");
    WhimsyAIPage.hidePreview(window);
    await TestUtils.waitForCondition(() => card.state == "closed", "Hidden");
    Services.prefs.setBoolPref("whimsy.feature.link-cards", false);
    await hoverLink(browser, true);
    await new Promise(r => setTimeout(r, 600));
    ok(card.state == "closed", "No card with both switches off");
    Services.prefs.clearUserPref("whimsy.feature.link-cards");
    Services.prefs.clearUserPref("whimsy.feature.link-previews");

    // A provider that isn't set up: the card says so instead of guessing.
    WhimsyAIProviders.setTestProvider(null);
    Services.prefs.setStringPref("whimsy.ai.order", "claude");
    await hoverLink(browser, true);
    await TestUtils.waitForCondition(() => card.state == "open" && card.querySelector('[data-card="ai"] .whimsy-preview-error'), "Not set up: a message");
    WhimsyAIPage.hidePreview(window);
    Services.prefs.clearUserPref("whimsy.ai.order");
    WhimsyAIProviders.setTestProvider(fakeProvider);
  });
});

add_task(async function test_no_preview_in_private_windows() {
  const read = [];
  WhimsyAIReader.setTestReader(url => {
    read.push(url);
    return "text";
  });
  const win = await BrowserTestUtils.openNewBrowserWindow({ private: true });
  const tab = await BrowserTestUtils.openNewForegroundTab(win.gBrowser, LINKS);
  await hoverLink(tab.linkedBrowser, true);
  await new Promise(r => setTimeout(r, 800));
  ok(win.document.getElementById("whimsy-link-hover")?.state != "open", "No preview card in a private window");
  is(read.length, 0, "and nothing is fetched behind the scenes");
  await BrowserTestUtils.closeWindow(win);
});

add_task(async function preview_cache_separates_accounts() {
  const reads = [];
  WhimsyAIReader.setTestReader((_url, { userContextId }) => {
    reads.push(userContextId);
    return `Account ${userContextId} private dashboard`;
  });
  WhimsyAIProviders.setTestProvider(({ prompt }) => JSON.stringify({
    title: prompt.includes("Account 1 private") ? "Account one" : "Account two",
    points: ["Account-specific content"],
  }));
  try {
    const url = PAGE + "?cache-isolation";
    const first = await WhimsyAIPage.summarize(url, { userContextId: 1 });
    const second = await WhimsyAIPage.summarize(url, { userContextId: 2 });
    is(first.title, "Account one", "First account's summary");
    is(second.title, "Account two", "Second account never sees first account's cached text");
    await WhimsyAIPage.summarize(url, { userContextId: 1 });
    Assert.deepEqual(reads, [1, 2], "Caches are independent within each container");
  } finally {
    WhimsyAIReader.setTestReader(null);
    WhimsyAIProviders.setTestProvider(fakeProvider);
  }
});

add_task(async function hidden_reader_blocks_active_capabilities() {
  const { Downloads } = ChromeUtils.importESModule("resource://gre/modules/Downloads.sys.mjs");
  const list = await Downloads.getList(Downloads.ALL);
  const before = new Set(await list.getAll());
  WhimsyAIReader.setTestReader(null);
  const result = await WhimsyAIReader.readUrl(ROOT + "whimsy_ai_sandbox.html");
  ok(result.text.includes("FORM_BLOCKED"), "Hidden page cannot submit a form");
  ok(result.text.includes("POPUP_BLOCKED"), "Hidden page cannot open a popup");
  ok(result.text.includes("SCRIPT_RAN"), "Rendering scripts still run");
  Assert.deepEqual((await list.getAll()).filter(item => !before.has(item)), [], "Hidden page cannot download");
});

// F28: a page that sends Cross-Origin-Opener-Policy can't load sandboxed
// (NS_ERROR_DOM_COOP_FAILED), so the reader loads it again without the
// sandbox flags, and still blocks what the sandbox did.
add_task(async function hidden_reader_reads_coop_pages_still_blocked() {
  const { Downloads } = ChromeUtils.importESModule("resource://gre/modules/Downloads.sys.mjs");
  const list = await Downloads.getList(Downloads.ALL);
  const before = new Set(await list.getAll());
  WhimsyAIReader.setTestReader(null);
  const result = await WhimsyAIReader.readUrl(ROOT + "whimsy_ai_sandbox_coop.html");
  ok(result.text.includes("SCRIPT_RAN"), `The COOP page was read (${result.text.slice(0, 80)})`);
  ok(result.text.includes("POPUP_BLOCKED"), "Hidden page cannot open a popup");
  await new Promise(resolve => setTimeout(resolve, 500));
  Assert.deepEqual((await list.getAll()).filter(item => !before.has(item)), [], "Hidden page cannot download");
});

// Resting on a link (nobody asked) reads public pages only, without the
// person's cookies (wave7/security M5).
add_task(async function resting_is_public_only_anonymous() {
  ok(WhimsyAIReader.isPublicUrl("https://example.com/a"), "A public page");
  for (const url of [
    "http://localhost:3000/admin/reset",
    "http://127.0.0.1/",
    "http://2130706433/",
    "http://192.168.1.1/apply.cgi",
    "http://10.0.0.8/",
    "http://172.20.1.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://[::1]/",
    "http://[fd00::1]/",
    "http://printer.local/",
    "http://router/",
  ]) {
    ok(!WhimsyAIReader.isPublicUrl(url), `Not public: ${url}`);
  }

  const reads = [];
  WhimsyAIReader.setTestReader((url, options) => {
    reads.push({ url, ...options });
    return "The offsite is on March 14 in Lisbon.";
  });
  try {
    await BrowserTestUtils.withNewTab(LINKS, async browser => {
      await WhimsyAIPage.showPreview(window, browser, { url: "http://192.168.1.1/apply.cgi?reset=1", how: "hover", ...AT });
      await new Promise(r => setTimeout(r, 700));
      is(reads.length, 0, "Resting on a local-network link reads nothing");
      WhimsyAIPage.hidePreview(window);

      await WhimsyAIPage.showPreview(window, browser, { url: PAGE + "?hover-anonymous", how: "hover", ...AT });
      await TestUtils.waitForCondition(() => reads.length == 1, "A public link is read");
      ok(reads[0].anonymous, "anonymously");
      isnot(reads[0].userContextId, browser.getAttribute("usercontextid") | 0, "outside the tab's cookie jar");
      is(reads[0].userContextId, WhimsyAIReader.anonymousContextId(), "in Firefox's internal background container");
      WhimsyAIPage.hidePreview(window);
    });
  } finally {
    WhimsyAIReader.setTestReader(null);
  }
});

// Shift on any link (a local one too) reads with the tab's own session.
add_task(async function shift_uses_signins() {
  const reads = [];
  WhimsyAIReader.setTestReader((url, options) => {
    reads.push({ url, ...options });
    return "Signed-in dashboard text.";
  });
  try {
    await BrowserTestUtils.withNewTab(LINKS, async browser => {
      is(await WhimsyAIPage.previewMode(browser, "http://192.168.1.1/admin", "shift"), "ready", "Shift reads a non-public page");
      await WhimsyAIPage.showPreview(window, browser, { url: PAGE + "?shift", how: "shift", ...AT });
      await TestUtils.waitForCondition(() => reads.length == 1, "Shift reads the link");
      ok(!reads[0].anonymous, "with the tab's session");
      is(reads[0].userContextId, browser.getAttribute("usercontextid") | 0, "in the tab's own container");
      WhimsyAIPage.hidePreview(window);
    });
  } finally {
    WhimsyAIReader.setTestReader(null);
  }
});

// fu-page 7.1: the AI card opens on the same frame as the link card,
// loading, then fills in place.
add_task(async function ai_card_opens_with_link_card() {
  let release;
  const gate = new Promise(r => (release = r));
  WhimsyAIReader.setTestReader(async () => {
    await gate;
    return "The offsite is on March 14 in Lisbon.";
  });
  try {
    await BrowserTestUtils.withNewTab(LINKS, async browser => {
      await WhimsyAIPage.showPreview(window, browser, { url: PAGE + "?together", how: "hover", ...AT });
      const panel = await TestUtils.waitForCondition(() => {
        const p = document.getElementById("whimsy-link-hover");
        return p?.state == "open" && p;
      }, "The cards open after the hover delay");
      Assert.deepEqual([...panel.querySelectorAll(".whimsy-link-hover-card")].map(c => c.dataset.card), ["link", "ai"], "Both cards, together");
      ok(panel.querySelector('[data-card="ai"] .whimsy-ai-shimmer'), "The summary is loading");
      release();
      await TestUtils.waitForCondition(() => panel.querySelector('[data-card="ai"] .whimsy-preview-points'), "then fills in place");
      ok(!panel.querySelector('[data-card="ai"] .whimsy-ai-shimmer'), "The loading lines are gone");
      WhimsyAIPage.hidePreview(window);
    });
  } finally {
    WhimsyAIReader.setTestReader(null);
  }
});

// Three bullets, never more, through the router's "preview" task.
add_task(async function three_bullets() {
  const tasks = [];
  WhimsyAIReader.setTestReader(() => "A long page about trains.");
  WhimsyAIProviders.setTestProvider(request => {
    tasks.push(request.task);
    return JSON.stringify({ title: "Trains", points: ["One", "Two", "Three", "Four", "Five"] });
  });
  try {
    const summary = await WhimsyAIPage.summarize(PAGE + "?three", {});
    Assert.deepEqual(summary.points, ["One", "Two", "Three"], "Three bullets");
    Assert.deepEqual(tasks, ["preview"], "asked as a preview task");
  } finally {
    WhimsyAIReader.setTestReader(null);
    WhimsyAIProviders.setTestProvider(fakeProvider);
  }
});

// With AI off, the link card shows alone, and nothing is read.
add_task(async function ai_off_link_card_only() {
  const reads = [];
  WhimsyAIReader.setTestReader(url => {
    reads.push(url);
    return "text";
  });
  Services.prefs.setBoolPref("whimsy.ai.enabled", false);
  try {
    await BrowserTestUtils.withNewTab(LINKS, async browser => {
      is(await WhimsyAIPage.previewMode(browser, PAGE, "shift"), null, "No AI card, even on Shift");
      await hoverLink(browser, true);
      const panel = await TestUtils.waitForCondition(() => {
        const p = document.getElementById("whimsy-link-hover");
        return p?.state == "open" && p;
      }, "The link card opens");
      Assert.deepEqual([...panel.querySelectorAll(".whimsy-link-hover-card")].map(c => c.dataset.card), ["link"], "The link card alone");
      is(reads.length, 0, "Nothing is read");
      WhimsyAIPage.hidePreview(window);
    });
  } finally {
    Services.prefs.setBoolPref("whimsy.ai.enabled", true);
    WhimsyAIReader.setTestReader(null);
  }
});

// The Claude plan serves previews too (its user-started gate is gone).
add_task(async function plan_now_allowed_for_previews() {
  const plans = WhimsyAIProviders._plans;
  const real = plans.claude;
  const asked = [];
  plans.claude = {
    isReady: async () => true,
    complete: async request => {
      asked.push(request);
      return JSON.stringify({ title: "Plan", points: ["A", "B", "C"] });
    },
  };
  const testProvider = WhimsyAIProviders._testProvider;
  WhimsyAIProviders.setTestProvider(null);
  await SpecialPowers.pushPrefEnv({
    set: [
      ["whimsy.feature.ai-claude-plan", true],
      ["whimsy.ai.claude.auth", "plan"],
      ["whimsy.ai.order", "claude"],
    ],
  });
  WhimsyAIReader.setTestReader(() => "Public page text.");
  try {
    ok(WhimsyAIProviders._usesPlan("claude"), "Claude is connected through the plan");
    await BrowserTestUtils.withNewTab(LINKS, async browser => {
      is(await WhimsyAIPage.previewMode(browser, PAGE + "?plan", "hover"), "ready", "Resting on a link gets a summary on the plan");
    });
    const summary = await WhimsyAIPage.summarize(PAGE + "?plan", { anonymous: true });
    Assert.deepEqual(summary.points, ["A", "B", "C"], "The plan wrote it");
    is(asked.length, 1, "unattended");
  } finally {
    plans.claude = real;
    await SpecialPowers.popPrefEnv();
    WhimsyAIProviders.setTestProvider(testProvider);
    WhimsyAIReader.setTestReader(null);
  }
});

// Private is a wall per tab: a private tab inside a normal window gets no
// preview and nothing is read.
add_task(async function private_tab_no_preview() {
  const { WhimsyPrivate } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPrivate.sys.mjs");
  const reads = [];
  WhimsyAIReader.setTestReader(url => {
    reads.push(url);
    return "text";
  });
  const tab = WhimsyPrivate.openPrivateTab(window, { url: LINKS, force: true });
  try {
    await BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, LINKS);
    gBrowser.selectedTab = tab;
    is(await WhimsyAIPage.previewMode(tab.linkedBrowser, PAGE, "shift"), null, "No AI card in a private tab");
    await WhimsyAIPage.showPreview(window, tab.linkedBrowser, { url: PAGE, how: "shift", ...AT });
    await new Promise(r => setTimeout(r, 700));
    ok(document.getElementById("whimsy-link-hover")?.state != "open", "No card at all");
    is(reads.length, 0, "and nothing is read");
  } finally {
    BrowserTestUtils.removeTab(tab);
    WhimsyAIReader.setTestReader(null);
  }
});

// wave7/security L7: the hidden reader can't launch external apps
// (SANDBOXED_TOPLEVEL_NAVIGATION_CUSTOM_PROTOCOLS).
add_task(async function hidden_reader_blocks_custom_protocols() {
  WhimsyAIReader.setTestReader(null);
  const flags = await WhimsyAIReader.withHiddenPage(PAGE, {}, async browser => browser.browsingContext.sandboxFlags);
  ok(flags & 0x40000, "No navigation to custom protocols");
});

// wave9/secfix (security-full-2 L2): with a cloud provider, a bare Return
// in a private tab's find bar doesn't send the page to the cloud; the Ask
// button still asks.
add_task(async function test_private_return_doesnt_ask_the_cloud() {
  const { WhimsyPrivate } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPrivate.sys.mjs");
  // The other tasks use the stand-in provider; this one needs the cloud one.
  const testProvider = WhimsyAIProviders._testProvider;
  WhimsyAIProviders._testProvider = null;
  Services.prefs.setStringPref("whimsy.ai.order", "claude");
  ok(WhimsyAIProviders.isCloud, "A cloud provider");
  const tab = WhimsyPrivate.openPrivateTab(window, { url: PAGE, force: true });
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, PAGE);
  gBrowser.selectedTab = tab;
  const realAsk = WhimsyAIPage.askOnPage;
  let asked = 0;
  WhimsyAIPage.askOnPage = async () => {
    asked++;
    return null;
  };
  try {
    const findbar = await openFind("where is the offsite");
    await TestUtils.waitForCondition(() => !askButton(findbar).hidden, "Nothing found: Ask is offered");
    EventUtils.synthesizeKey("KEY_Enter", {}, window);
    await new Promise(r => setTimeout(r, 300));
    is(asked, 0, "Return in a private tab doesn't ask the cloud");
    askButton(findbar).doCommand();
    is(asked, 1, "The Ask button still does");
    findbar.close();
  } finally {
    WhimsyAIPage.askOnPage = realAsk;
    WhimsyAIProviders._testProvider = testProvider;
    Services.prefs.clearUserPref("whimsy.ai.order");
    BrowserTestUtils.removeTab(tab);
  }
});
