/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Ask on Page (Arc Max): when Cmd+F finds nothing, an Ask button appears and
// Enter asks the AI about the page; the answer quotes the page and "Find on
// Page" jumps there. The background reader and the hover card's page
// description (browser_whimsy_hover_cards.js has the card itself). A fake AI
// provider answers.

const { WhimsyAIProviders } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIProviders.sys.mjs");
const { WhimsyAIReader } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIReader.sys.mjs");
const { WhimsyAIPage } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIPage.sys.mjs");

const ROOT = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com");
const PAGE = ROOT + "whimsy_ai_page.html";

let requests = [];
function fakeProvider({ prompt, system }) {
  requests.push({ prompt, system });
  if (/Ask on Page/.test(system)) {
    return JSON.stringify({
      answer: "The offsite is in Lisbon on March 14.",
      quote: "The offsite is on March 14 in Lisbon.",
    });
  }
  return "";
}

add_setup(async () => {
  WhimsyAIProviders.setTestProvider(fakeProvider);
  registerCleanupFunction(() => {
    WhimsyAIProviders.setTestProvider(null);
    WhimsyAIReader.setTestReader(null);
    for (const pref of ["whimsy.ai.order", "whimsy.feature.ask-on-page"]) {
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

// The floating find card keeps Ask laid out and marks it askable; the old bar hides it.
function askOffered(findbar) {
  const ask = askButton(findbar);
  return !!ask && !ask.hidden && (!findbar.hasAttribute("whimsy-find-card") || ask.hasAttribute("askable"));
}

add_task(async function test_ask_on_page() {
  ok(Services.prefs.getBoolPref("whimsy.feature.ask-on-page"), "The feature switch is on");
  await BrowserTestUtils.withNewTab(PAGE, async () => {
    // Something on the page: plain Find, no Ask.
    let findbar = await openFind("Lisbon");
    await TestUtils.waitForCondition(() => findbar._findField.getAttribute("status") != "pending", "Find ran");
    await new Promise(r => setTimeout(r, 300));
    ok(!askOffered(findbar), "Found text doesn't offer Ask");

    // Not on the page: Ask appears, and Enter asks.
    requests = [];
    findbar = await openFind("where is the offsite");
    await TestUtils.waitForCondition(() => askOffered(findbar), "The Ask button appears when nothing is found");
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
    await TestUtils.waitForCondition(() => askOffered(findbar), "Ask again");
    askButton(findbar).doCommand();
    await TestUtils.waitForCondition(() => panel.state == "open" && panel.querySelector(".whimsy-ask-answer"), "Answered");
    ok(!panel.querySelector(".whimsy-ask-quote"), "No quote that isn't on the page");
    WhimsyAIProviders.setTestProvider(fakeProvider);
    panel.hidePopup();

    // The kill switch hides Ask.
    Services.prefs.setBoolPref("whimsy.ai.enabled", false);
    findbar = await openFind("still not here");
    await new Promise(r => setTimeout(r, 300));
    ok(!askOffered(findbar), "No Ask with AI turned off");
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

// A hover reads public pages only, without the person's cookies
// (wave7/security M5): never this machine or the local network.
add_task(async function hover_reads_are_public_only() {
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
  await Assert.rejects(
    WhimsyAIReader.readUrl("http://192.168.1.1/apply.cgi", { anonymous: true }),
    /Only http/,
    "An anonymous read refuses a local page"
  );
});

// The Claude plan writes hover card descriptions too (no user-started gate).
add_task(async function plan_allowed_for_descriptions() {
  const plans = WhimsyAIProviders._plans;
  const real = plans.claude;
  const asked = [];
  plans.claude = {
    isReady: async () => true,
    complete: async request => {
      asked.push(request);
      return JSON.stringify({ title: "Plan", description: "Written on the plan." });
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
    ok(await WhimsyAIPage.canDescribe(), "Hover cards get a description on the plan");
    const found = await WhimsyAIPage.describe(PAGE + "?plan", { anonymous: true });
    is(found.description, "Written on the plan.", "The plan wrote it");
    is(asked.length, 1, "unattended");
  } finally {
    plans.claude = real;
    await SpecialPowers.popPrefEnv();
    WhimsyAIProviders.setTestProvider(testProvider);
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
    await TestUtils.waitForCondition(() => askOffered(findbar), "Nothing found: Ask is offered");
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
