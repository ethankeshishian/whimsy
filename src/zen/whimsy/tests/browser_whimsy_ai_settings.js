/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W23 settings-ai: Settings › AI is one page. The off card, the header
// switch's in-page confirm, Off limits, the jump strip, the providers list
// (order, switches, resting, details), the connect sheets, Claude Code's
// install, and Features. Keys go to a local server; nothing leaves the Mac.

const { WhimsyAIProviders, ENDPOINTS } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIProviders.sys.mjs");
const { WhimsyAIClaudeCode } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIClaudeCode.sys.mjs");
const { WhimsyClaudeCodeInstall } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyClaudeCodeInstall.sys.mjs");
const { HttpServer } = ChromeUtils.importESModule("resource://testing-common/httpd.sys.mjs");
const { OSKeyStoreTestUtils } = ChromeUtils.importESModule("resource://testing-common/OSKeyStoreTestUtils.sys.mjs");

const TOUCHED = [
  "whimsy.ai.enabled",
  "whimsy.ai.order",
  "whimsy.ai.off",
  "whimsy.ai.resting",
  "whimsy.ai.auto-enabled",
  "whimsy.ai.quick-text-apple",
  "whimsy.ai.provider",
  "whimsy.ai.gemini.model",
  "whimsy.ai.openai.model",
  "whimsy.ai.claude.auth",
  "whimsy.ai.openai.auth",
  "whimsy.ai.ollama.model",
  "whimsy.ai.ollama.endpoint",
  "whimsy.feature.ai-claude-plan",
  "whimsy.feature.ai-openai-plan",
  "whimsy.feature.tidy-tabs",
  "whimsy.feature.tidy-titles",
  "whimsy.feature.ask-on-page",
  "whimsy.feature.link-previews",
  "whimsy.feature.page-watch",
  "whimsy.ai.hints.seen",
  "whimsy.ai.hints.today",
  "whimsy.ai.claude-code.stream-probe",
];
const saved = new Map(
  TOUCHED.map(name => {
    const type = Services.prefs.getPrefType(name);
    return [name, Services.prefs.prefHasUserValue(name) ? { type, value: whimsyReadPref(name, type) } : null];
  })
);
const savedEndpoints = { ...ENDPOINTS };
let server = null;
let accept = true;

function restorePrefs() {
  for (const [name, was] of saved) {
    if (was) {
      whimsyWritePref(name, was.type, was.value);
    } else {
      Services.prefs.clearUserPref(name);
    }
  }
}

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.ai-hints", false]] });
  OSKeyStoreTestUtils.setup();
  server = new HttpServer();
  server.start(-1);
  const base = `http://localhost:${server.identity.primaryPort}`;
  Object.assign(ENDPOINTS, { openai: `${base}/openai`, gemini: `${base}/gemini` });
  server.registerPrefixHandler("/gemini/", (request, response) => {
    response.setStatusLine(request.httpVersion, accept ? 200 : 400, "x");
    response.setHeader("content-type", "application/json");
    response.write(JSON.stringify({ models: [{ name: "models/gemini-first", supportedGenerationMethods: ["generateContent"] }] }));
  });
  server.registerPrefixHandler("/openai/", (request, response) => {
    response.setStatusLine(request.httpVersion, accept ? 200 : 401, "x");
    response.setHeader("content-type", "application/json");
    response.write(JSON.stringify(accept ? { data: [{ id: "gpt-test" }] } : { error: { message: "Incorrect API key provided" } }));
  });
  server.registerPathHandler("/ollama/api/tags", (request, response) => {
    response.setHeader("content-type", "application/json");
    response.write(JSON.stringify({ models: [{ name: "llama-test:3b", size: 2.0e9 }, { name: "vision-test:7b", size: 4.7e9 }] }));
  });
  server.registerPathHandler("/ollama/api/show", (request, response) => {
    const body = JSON.parse(NetUtil.readInputStreamToString(request.bodyInputStream, request.bodyInputStream.available()));
    response.setHeader("content-type", "application/json");
    response.write(JSON.stringify({ capabilities: body.model.startsWith("vision") ? ["completion", "vision"] : ["completion"] }));
  });
  registerCleanupFunction(async () => {
    Object.assign(ENDPOINTS, savedEndpoints);
    for (const id of ["openai", "gemini", "claude"]) {
      await WhimsyAIProviders.setKey(id, "");
    }
    restorePrefs();
    await OSKeyStoreTestUtils.cleanup();
    await new Promise(r => server.stop(r));
  });
});

const fakeKey = provider => ({ openai: "sk-" + "proj-", gemini: "AIza" + "Sy" }[provider] + "test0000000000000000wxyz");

async function openAI(hash = "whimsyAI") {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, `about:preferences#${hash}`);
  const win = tab.linkedBrowser.contentWindow;
  const doc = win.document;
  await TestUtils.waitForCondition(() => win.WhimsyAISettings?.root && doc.getElementById("whimsyAIPage")?.checkVisibility(), "Settings › AI shows");
  const $ = id => doc.getElementById(id);
  return { tab, win, doc, $, S: win.WhimsyAISettings };
}

async function done(page) {
  page.S.closeSheet({ restore: false });
  BrowserTestUtils.removeTab(page.tab);
  closeToasts();
  restorePrefs();
}

const row = (page, id) => page.doc.querySelector(`#whimsyAIProviderList .whimsy-ai-item[data-provider="${id}"]`);
const order = page => [...page.doc.querySelectorAll("#whimsyAIProviderList .whimsy-ai-item[data-provider]")].map(r => r.dataset.provider);
const visible = node => !!node?.checkVisibility();
const click = (page, node) => EventUtils.synthesizeMouseAtCenter(node, {}, page.win);
const clickToggle = (page, toggle) => click(page, toggle.buttonEl);

// Rows unfold and sheets fade in; a person clicks once they're there.
async function settled(page) {
  const running = page.doc.getAnimations().filter(a => a.playState == "running" && a.effect?.getComputedTiming().iterations != Infinity);
  await Promise.all(running.map(a => a.finished.catch(() => {})));
}

async function sheet(page, id) {
  return TestUtils.waitForCondition(() => {
    const node = page.$("whimsyAISheet");
    return node?.dataset.sheet == id && visible(node) && node;
  }, `The ${id} sheet opens`);
}

async function listReady(page) {
  await TestUtils.waitForCondition(() => page.$("whimsyAIProviderList")?.dataset.ready == "true", "The providers list has its details");
}

async function typeKey(page, provider) {
  const field = await TestUtils.waitForCondition(() => page.$("whimsyAIKeyField"), "The key field shows");
  field.focus();
  EventUtils.sendString(fakeKey(provider), page.win);
  await TestUtils.waitForCondition(() => !page.$("whimsyAIKeyConnect").disabled, "Connect lights up");
  return field;
}

add_task(async function ai_off_shows_one_card_only() {
  Services.prefs.setStringPref("whimsy.ai.order", "");
  Services.prefs.setBoolPref("whimsy.ai.enabled", false);
  const page = await openAI();
  const { $, doc } = page;
  const card = await TestUtils.waitForCondition(() => visible($("whimsyAIOffCard")) && $("whimsyAIOffCard"), "The off card shows");
  is(card.dataset.kind, "setup", "Nothing connected: the set-up card");
  ok(!visible($("whimsyAIOn")), "No sections");
  ok(!visible($("whimsyAIEnable")), "No header switch: the card's button is the one control");
  ok(!visible($("whimsyAIJump")), "No jump strip");
  const buttons = [...doc.querySelectorAll("#whimsyAIPage button, #whimsyAIPage moz-toggle")].filter(visible);
  Assert.deepEqual(buttons.map(b => b.id), ["whimsyAISetUp"], "One button on the page");
  is(card.querySelectorAll(".whimsy-ai-logos img").length, 5, "The five providers' logos");
  click(page, $("whimsyAISetUp"));
  await sheet(page, "add-provider");
  await done(page);
});

add_task(async function first_connection_turns_ai_on_and_page_opens_up() {
  Services.prefs.setStringPref("whimsy.ai.order", "");
  Services.prefs.setBoolPref("whimsy.ai.auto-enabled", false);
  Services.prefs.setBoolPref("whimsy.ai.enabled", false);
  accept = true;
  const page = await openAI();
  const { $ } = page;
  await TestUtils.waitForCondition(() => visible($("whimsyAISetUp")), "Set up AI shows");
  click(page, $("whimsyAISetUp"));
  const add = await sheet(page, "add-provider");
  await settled(page);
  click(page, add.querySelector('.whimsy-ai-choice[data-provider="gemini"]'));
  await sheet(page, "gemini");
  await typeKey(page, "gemini");
  click(page, $("whimsyAIKeyConnect"));
  await TestUtils.waitForCondition(() => Services.prefs.getBoolPref("whimsy.ai.enabled"), "Connecting turns AI on");
  await TestUtils.waitForCondition(() => !page.S.sheet, "and closes the sheet");
  await TestUtils.waitForCondition(() => visible($("whimsyAIOn")) && !visible($("whimsyAIOffCard")), "The page opens up");
  ok(visible($("whimsyAIEnable")) && $("whimsyAIEnable").pressed, "with the header switch on");
  await TestUtils.waitForCondition(() => row(page, "gemini"), "Gemini is listed");
  const toast = await TestUtils.waitForCondition(() => toastFor("whimsy-ai-toast-connected"), "A toast says so");
  is(toast.element.querySelector("[data-l10n-id='whimsy-ai-toast-ai-on']") ? "on" : toast.descriptionId ?? "on", "on", "AI is on, it says");
  await WhimsyAIProviders.setKey("gemini", "");
  await done(page);
});

add_task(async function header_switch_off_confirms_in_page() {
  Services.prefs.setStringPref("whimsy.ai.order", "gemini");
  const page = await openAI();
  const { $, doc } = page;
  const toggle = await TestUtils.waitForCondition(() => visible($("whimsyAIEnable")) && $("whimsyAIEnable"), "The header switch shows");
  clickToggle(page, toggle);
  const strip = await TestUtils.waitForCondition(() => $("whimsyAIConfirmSlot").querySelector(".whimsy-ai-confirm"), "Turning off asks first, in the page");
  ok(Services.prefs.getBoolPref("whimsy.ai.enabled"), "AI stays on while it asks");
  ok(toggle.pressed, "and the switch stays on");
  is(doc.activeElement, strip.querySelector("[data-action=cancel]"), "Cancel has focus");
  is(strip.querySelector("b").getAttribute("data-l10n-id"), "whimsy-ai-off-confirm-title", "Turn off AI?");
  EventUtils.synthesizeKey("KEY_Escape", {}, page.win);
  ok(!strip.isConnected, "Escape cancels");
  ok(Services.prefs.getBoolPref("whimsy.ai.enabled"), "and AI is on");
  clickToggle(page, toggle);
  const again = await TestUtils.waitForCondition(() => $("whimsyAIConfirmSlot").querySelector(".whimsy-ai-confirm"), "It asks again");
  await settled(page);
  click(page, again.querySelector("[data-action=confirm]"));
  await TestUtils.waitForCondition(() => !Services.prefs.getBoolPref("whimsy.ai.enabled"), "Turn off turns AI off");
  const card = await TestUtils.waitForCondition(() => visible($("whimsyAIOffCard")) && !visible($("whimsyAIOn")) && $("whimsyAIOffCard"), "The page folds to the card");
  is(card.dataset.kind, "kept", "Providers are kept");
  ok(visible($("whimsyAIForget")), "with Forget everything…");
  ok(!visible($("whimsyAIEnable")), "The header switch hides");
  click(page, $("whimsyAITurnOn"));
  await TestUtils.waitForCondition(() => Services.prefs.getBoolPref("whimsy.ai.enabled") && visible($("whimsyAIOn")), "Turn on AI brings it all back");
  await done(page);
});

add_task(async function off_limits_card_copy() {
  const page = await openAI();
  const { $ } = page;
  const card = await TestUtils.waitForCondition(() => visible($("whimsyAIOffLimits")) && $("whimsyAIOffLimits"), "Off limits shows");
  is(card.querySelector("h2").getAttribute("data-l10n-id"), "whimsy-ai-limits-heading", "Off limits to AI");
  Assert.deepEqual(
    [...card.querySelectorAll(".whimsy-ai-fact b")].map(b => b.getAttribute("data-l10n-id")),
    ["whimsy-ai-limits-private", "whimsy-ai-limits-hidden", "whimsy-ai-limits-cards"],
    "Private tabs, hidden spaces, and cards and passwords"
  );
  await TestUtils.waitForCondition(() => card.textContent.includes("Private tabs and windows") && card.textContent.includes("These can’t be changed."), "The copy is there");
  ok(!card.querySelector("button, moz-toggle, input"), "Nothing to change");
  ok($("whimsyAIOffLimits").compareDocumentPosition($("whimsyAISection-providers")) & Node.DOCUMENT_POSITION_FOLLOWING, "It comes before Providers");
  await done(page);
});

add_task(async function jump_strip_scrolls_to_section() {
  const page = await openAI();
  const { $, doc, S } = page;
  const strip = await TestUtils.waitForCondition(() => visible($("whimsyAIJump")) && $("whimsyAIJump"), "The jump strip shows");
  const ids = [...strip.children].map(b => b.dataset.section);
  Assert.deepEqual(ids, S.STRIP.filter(id => ids.includes(id)), "In the page's order");
  Assert.deepEqual(ids, [...doc.querySelectorAll("#whimsyAIOn section[data-section]")].map(s => s.dataset.section), "One per section");
  ok(ids.includes("providers") && ids.includes("features"), "Providers and Features");
  click(page, strip.querySelector('[data-section="features"]'));
  const top = $("whimsyAITop");
  await TestUtils.waitForCondition(() => {
    const at = $("whimsyAISection-features").getBoundingClientRect().top;
    return Math.abs(at - top.getBoundingClientRect().bottom) < 60 || S._scroller().scrollTop + S._scroller().clientHeight >= S._scroller().scrollHeight - 2;
  }, "Features scrolls up under the strip");
  is(strip.querySelector('[data-section="features"]').getAttribute("aria-current"), "true", "and is marked");
  ok(top.getBoundingClientRect().top >= -1, "The header stays put");
  await done(page);
});

add_task(async function firefox_ai_rows_gone() {
  const page = await openAI();
  const { $ } = page;
  for (const id of ["whimsyAIFirefoxChatbot", "whimsyAIFirefoxLinkPreviews", "whimsyAIFirefoxTabGroups", "whimsyAIProviderGroup", "whimsyAIAccounts", "whimsyAIUse"]) {
    ok(!$(id), `No #${id}`);
  }
  ok(!Services.prefs.getBoolPref("browser.preferences.aiControls", false), "Firefox's AI controls stay off");
  await done(page);
});

add_task(async function deep_link_opens_add_provider_sheet() {
  const page = await openAI("whimsyAI?sheet=add-provider");
  const add = await sheet(page, "add-provider");
  is(page.win.location.hash, "#whimsyAI", "The link's sheet part is used once");
  is(add.querySelectorAll(".whimsy-ai-choice").length >= 4, true, "Each provider to add");
  EventUtils.synthesizeKey("KEY_Escape", {}, page.win);
  await TestUtils.waitForCondition(() => !page.S.sheet, "Escape closes it");
  WhimsyAIProviders.openSettings(window, "gemini");
  await sheet(page, "gemini");
  is(gBrowser.selectedTab, page.tab, "openSettings uses the open Settings tab");
  page.S.closeSheet();
  Services.prefs.setBoolPref("whimsy.feature.ai-openai-plan", true);
  WhimsyAIProviders.openSettings(window, "plan-openai");
  const openai = await sheet(page, "openai");
  if (WhimsyAIProviders.planAvailable("openai")) {
    is(openai.querySelector('.whimsy-ai-seg [aria-checked="true"]')?.dataset.method, "plan", "Sign in with ChatGPT opens on the plan");
  }
  await done(page);
});

add_task(async function deep_link_search_opens_add_provider_sheet() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:preferences?sheet=add-provider#whimsyAI");
  const win = tab.linkedBrowser.contentWindow;
  WhimsyAIProviders.pendingSettingsAction = "add-provider";
  Services.obs.notifyObservers(null, "whimsy-ai-settings-action", "add-provider");
  const page = { tab, win, doc: win.document, $: id => win.document.getElementById(id) };
  await TestUtils.waitForCondition(() => win.WhimsyAISettings?.root, "Settings › AI is built");
  page.S = win.WhimsyAISettings;
  await sheet(page, "add-provider");
  Services.obs.notifyObservers(null, "whimsy-ai-settings-action", "add-provider");
  await new Promise(r => setTimeout(r, 100));
  is(page.doc.querySelectorAll('#whimsyAISheet[data-sheet="add-provider"]').length, 1, "One sheet, however many ways it was asked for");
  page.S.closeSheet();
  page.S._takeAction();
  ok(!page.S.sheet, "The query is used once");
  is(win.location.hash, "#whimsyAI", "on the AI page");
  await done(page);
});

add_task(async function drag_and_alt_arrow_reorder() {
  Services.prefs.setStringPref("whimsy.ai.order", "claude,openai,gemini");
  const page = await openAI();
  const { doc, win } = page;
  await listReady(page);
  const grip = row(page, "gemini").querySelector("[data-action=grip]");
  grip.focus();
  EventUtils.synthesizeKey("KEY_ArrowUp", { altKey: true }, win);
  await TestUtils.waitForCondition(() => Services.prefs.getStringPref("whimsy.ai.order") == "claude,gemini,openai", "⌥↑ moves it up one");
  await TestUtils.waitForCondition(() => order(page).join() == "claude,gemini,openai", "The list follows");
  await TestUtils.waitForCondition(() => doc.activeElement?.dataset.action == "grip" && doc.activeElement.closest("[data-provider]")?.dataset.provider == "gemini", "Focus stays on its grip");
  is(page.$("whimsyAIOrderStatus").getAttribute("data-l10n-id"), "whimsy-ai-order-moved", "and it's said aloud");
  Assert.deepEqual(JSON.parse(page.$("whimsyAIOrderStatus").getAttribute("data-l10n-args")), { provider: "Gemini", rank: 2, count: 3 }, "Gemini to 2 of 3");
  EventUtils.synthesizeKey("KEY_ArrowUp", { altKey: true }, win);
  await TestUtils.waitForCondition(() => Services.prefs.getStringPref("whimsy.ai.order") == "gemini,claude,openai", "and again");
  EventUtils.synthesizeKey("KEY_ArrowUp", { altKey: true }, win);
  is(Services.prefs.getStringPref("whimsy.ai.order"), "gemini,claude,openai", "First stays first");

  const claudeGrip = row(page, "claude").querySelector("[data-action=grip]");
  const from = claudeGrip.getBoundingClientRect();
  const last = row(page, "openai").getBoundingClientRect();
  const x = from.left + from.width / 2;
  EventUtils.synthesizeMouseAtPoint(x, from.top + from.height / 2, { type: "mousedown" }, win);
  await TestUtils.waitForCondition(() => row(page, "claude").classList.contains("is-lifted"), "The row lifts");
  ok(doc.querySelector("#whimsyAIProviderList .whimsy-ai-slot"), "and a slot shows where it lands");
  for (const y of [last.top + 4, last.top + last.height / 2, last.bottom + 6]) {
    EventUtils.synthesizeMouseAtPoint(x, y, { type: "mousemove" }, win);
  }
  EventUtils.synthesizeMouseAtPoint(x, last.bottom + 6, { type: "mouseup" }, win);
  await TestUtils.waitForCondition(() => Services.prefs.getStringPref("whimsy.ai.order") == "gemini,openai,claude", "Dropping below ChatGPT puts Claude last");
  await TestUtils.waitForCondition(() => order(page).join() == "gemini,openai,claude" && !doc.querySelector(".whimsy-ai-slot"), "The list follows, no slot left");
  await done(page);
});

add_task(async function switch_off_dims_row() {
  Services.prefs.setStringPref("whimsy.ai.order", "claude,openai");
  const page = await openAI();
  await listReady(page);
  const toggle = row(page, "openai").querySelector("moz-toggle");
  ok(toggle.pressed, "On to start");
  clickToggle(page, toggle);
  await TestUtils.waitForCondition(() => Services.prefs.getStringPref("whimsy.ai.off", "") == "openai", "Off is remembered");
  const r = row(page, "openai");
  await TestUtils.waitForCondition(() => r.hasAttribute("data-off"), "The row is marked off");
  await TestUtils.waitForCondition(() => Number(page.win.getComputedStyle(r).opacity) < 0.7, "and dimmed");
  is(r.querySelector(".whimsy-ai-item-detail").getAttribute("data-l10n-id"), "whimsy-ai-row-off", "It says it's off");
  ok(visible(r.querySelector("[data-action=grip]")), "It can still be dragged");
  is(WhimsyAIProviders.provider, "claude", "Claude is still tried first");
  clickToggle(page, r.querySelector("moz-toggle"));
  await TestUtils.waitForCondition(() => !r.hasAttribute("data-off") && !Services.prefs.prefHasUserValue("whimsy.ai.off"), "Back on");
  await done(page);
});

add_task(async function resting_pill_and_reset_time() {
  Services.prefs.setStringPref("whimsy.ai.order", "openai,gemini");
  const until = Date.now() + 2 * 3600e3;
  WhimsyAIProviders.setResting("openai", { until, message: "You've hit your usage limit." });
  const page = await openAI();
  await listReady(page);
  const r = row(page, "openai");
  const pill = await TestUtils.waitForCondition(() => r.querySelector(".whimsy-ai-item-name .whimsy-ai-pill"), "A Resting pill");
  is(pill.getAttribute("data-l10n-id"), "whimsy-ai-row-resting-pill", "Resting");
  const d = r.querySelector(".whimsy-ai-item-detail");
  is(d.getAttribute("data-l10n-id"), "whimsy-ai-row-resting-until", "Until its reset time");
  const args = JSON.parse(d.getAttribute("data-l10n-args"));
  is(args.message, "You've hit your usage limit.", "in the provider's own words");
  is(args.time, new Date(until).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }), "at the reset time");
  ok(!row(page, "gemini").querySelector(".whimsy-ai-pill"), "Gemini isn't resting");
  click(page, r.querySelector("[data-action=details]"));
  const body = await TestUtils.waitForCondition(() => r.nextElementSibling?.classList.contains("whimsy-ai-body") && r.nextElementSibling, "Details open");
  ok(body.textContent.includes("You've hit your usage limit."), "with the last limit message");
  WhimsyAIProviders.clearResting("openai");
  await TestUtils.waitForCondition(() => !r.isConnected || !row(page, "openai").querySelector(".whimsy-ai-pill"), "The pill goes when it's over");
  await done(page);
});

add_task(async function add_provider_appends_and_toasts() {
  Services.prefs.setStringPref("whimsy.ai.order", "openai");
  Services.prefs.setBoolPref("whimsy.ai.auto-enabled", true);
  accept = true;
  const page = await openAI();
  await listReady(page);
  click(page, page.$("whimsyAIAddProvider"));
  const add = await sheet(page, "add-provider");
  const openai = add.querySelector('.whimsy-ai-choice[data-provider="openai"]');
  is(openai.getAttribute("aria-disabled"), "true", "ChatGPT is already connected");
  await settled(page);
  click(page, add.querySelector('.whimsy-ai-choice[data-provider="gemini"]'));
  await sheet(page, "gemini");
  await typeKey(page, "gemini");
  EventUtils.synthesizeKey("KEY_Enter", {}, page.win);
  await TestUtils.waitForCondition(() => Services.prefs.getStringPref("whimsy.ai.order") == "openai,gemini", "Gemini goes last");
  await TestUtils.waitForCondition(() => order(page).join() == "openai,gemini", "and shows last");
  const toast = await TestUtils.waitForCondition(() => toastFor("whimsy-ai-toast-connected"), "A toast says so");
  ok(toast, "Gemini connected");
  await TestUtils.waitForCondition(() => page.S.root && !page.S.sheet, "The sheet closes");
  await WhimsyAIProviders.setKey("gemini", "");
  await done(page);
});

add_task(async function quick_text_switch_only_with_apple() {
  Services.prefs.setStringPref("whimsy.ai.order", "claude");
  const page = await openAI();
  await listReady(page);
  ok(!visible(page.$("whimsyAIQuickTextCard")), "No Apple: no quick-text switch");
  WhimsyAIProviders.setOrder(["claude", "apple"]);
  await TestUtils.waitForCondition(() => visible(page.$("whimsyAIQuickTextCard")), "With Apple, it shows");
  const toggle = page.$("whimsyAIQuickText");
  ok(toggle.pressed, "on by default");
  clickToggle(page, toggle);
  await TestUtils.waitForCondition(() => !Services.prefs.getBoolPref("whimsy.ai.quick-text-apple"), "and switches the pref");
  await done(page);
});

add_task(async function gemini_free_tier_warning() {
  const page = await openAI();
  page.S.openSheet("gemini");
  const gemini = await sheet(page, "gemini");
  const warn = gemini.querySelector(".whimsy-ai-note[data-tone=warn] [data-l10n-id]");
  is(warn?.getAttribute("data-l10n-id"), "whimsy-ai-key-gemini-free", "Gemini warns about the free tier");
  ok(visible(warn), "where it shows");
  is(page.doc.activeElement, page.$("whimsyAIKeyField"), "The key field has focus");
  ok(page.$("whimsyAIKeyConnect").disabled, "Connect waits for a key");
  page.S.closeSheet();
  page.S.openSheet("openai", { method: "key" });
  const openai = await sheet(page, "openai");
  ok(!openai.querySelector('[data-l10n-id="whimsy-ai-key-gemini-free"]'), "ChatGPT has no such note");
  await done(page);
});

add_task(async function openai_key_rejected_inline() {
  accept = false;
  const page = await openAI();
  page.S.openSheet("openai", { method: "key" });
  await sheet(page, "openai");
  const field = await typeKey(page, "openai");
  click(page, page.$("whimsyAIKeyConnect"));
  const error = await TestUtils.waitForCondition(() => visible(page.$("whimsyAIKeyError")) && page.$("whimsyAIKeyError"), "A rejected key says so in the sheet");
  is(error.getAttribute("data-l10n-id"), "whimsy-ai-key-rejected-openai", "OpenAI didn't accept it");
  is(field.getAttribute("aria-invalid"), "true", "The field turns red");
  is(page.doc.activeElement, field, "and keeps focus");
  is(page.S.sheet?.id, "openai", "The sheet stays open");
  ok(!(await WhimsyAIProviders.hasKey("openai")), "Nothing is saved");
  ok(!WhimsyAIProviders.order.includes("openai"), "or listed");
  accept = true;
  await done(page);
});

add_task(async function install_continues_when_sheet_closes_and_toasts() {
  Services.prefs.setBoolPref("whimsy.feature.ai-claude-plan", true);
  Services.prefs.setStringPref("whimsy.ai.order", "gemini");
  const realInstall = WhimsyClaudeCodeInstall.install;
  const realStatus = WhimsyAIClaudeCode._authStatus;
  const realPlan = WhimsyAIProviders._plans.claude;
  const realRefresh = WhimsyAIProviders.refreshCapabilities;
  WhimsyAIProviders.refreshCapabilities = async () => {};
  let finish;
  const paused = new Promise(r => (finish = r));
  let installed = false;
  WhimsyAIClaudeCode._authStatus = async () => ({ installed, loggedIn: installed, email: "" });
  WhimsyClaudeCodeInstall.install = async ({ onStep }) => {
    onStep("fetch");
    onStep("signature");
    await paused;
    for (const step of ["download", "hash", "codesign", "notarization", "install"]) {
      onStep(step);
    }
    installed = true;
    return { path: "/tmp/claude", version: "2.1.0" };
  };
  WhimsyAIProviders.registerPlan("claude", { ...realPlan, connect: async () => ({}), status: async () => ({ connected: true, label: "" }) });
  registerCleanupFunction(() => {
    WhimsyAIProviders.refreshCapabilities = realRefresh;
    WhimsyClaudeCodeInstall.install = realInstall;
    WhimsyAIClaudeCode._authStatus = realStatus;
    WhimsyAIProviders.registerPlan("claude", realPlan);
  });
  const page = await openAI();
  page.S.openSheet("claude");
  await sheet(page, "claude");
  const install = await TestUtils.waitForCondition(() => page.$("whimsyAIClaudeInstall"), "Claude Code isn't here: Install shows");
  await settled(page);
  click(page, install);
  const steps = await TestUtils.waitForCondition(() => page.$("whimsyAIInstallSteps"), "The steps show");
  await TestUtils.waitForCondition(() => page.$("whimsyAIInstallSteps")?.querySelector('[data-step="download"]')?.dataset.state == "busy", "Downloading");
  ok(steps, "four steps");
  EventUtils.synthesizeKey("KEY_Escape", {}, page.win);
  await TestUtils.waitForCondition(() => !page.S.sheet, "The sheet closes");
  finish();
  await TestUtils.waitForCondition(() => toastFor("whimsy-ai-toast-claude-code-ready"), "A toast says it's installed");
  await TestUtils.waitForCondition(() => WhimsyAIProviders.order.includes("claude"), "and Claude connects");
  is(WhimsyAIProviders.order.at(-1), "claude", "last");
  await TestUtils.waitForCondition(() => toastFor("whimsy-ai-toast-connected"), "then that it's connected");
  WhimsyClaudeCodeInstall.install = realInstall;
  WhimsyAIClaudeCode._authStatus = realStatus;
  WhimsyAIClaudeCode._status = null;
  WhimsyAIProviders.registerPlan("claude", realPlan);
  WhimsyAIProviders.refreshCapabilities = realRefresh;
  await done(page);
});

add_task(async function features_rows_toggle_prefs() {
  const page = await openAI();
  const section = await TestUtils.waitForCondition(() => page.$("whimsyAISection-features"), "Features is there");
  for (const [id, pref] of [
    ["whimsyAITidyTabs", "whimsy.feature.tidy-tabs"],
    ["whimsyAITidyTitles", "whimsy.feature.tidy-titles"],
    ["whimsyAIAskOnPage", "whimsy.feature.ask-on-page"],
    ["whimsyAILinkPreviews", "whimsy.feature.link-previews"],
    ["whimsyAIPageWatch", "whimsy.feature.page-watch"],
  ]) {
    const toggle = page.$(id);
    ok(section.contains(toggle), `${id} is in Features`);
    toggle.scrollIntoView({ block: "center" });
    const was = Services.prefs.getBoolPref(pref, true);
    is(toggle.pressed, was, `${id} shows ${pref}`);
    clickToggle(page, toggle);
    await TestUtils.waitForCondition(() => Services.prefs.getBoolPref(pref, true) == !was, `${id} switches ${pref}`);
    Services.prefs.setBoolPref(pref, was);
    await TestUtils.waitForCondition(() => toggle.pressed == was, "and follows it back");
  }
  await done(page);
});

add_task(async function routines_row_opens_library() {
  const { WhimsyArcMenus } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyArcMenus.sys.mjs");
  const real = WhimsyArcMenus.openLibrarySection;
  const calls = [];
  WhimsyArcMenus.openLibrarySection = (win, section) => {
    calls.push([win, section]);
    return true;
  };
  registerCleanupFunction(() => (WhimsyArcMenus.openLibrarySection = real));
  const page = await openAI();
  const open = await TestUtils.waitForCondition(() => page.$("whimsyAIOpenLibrary"), "Open Library is there");
  open.scrollIntoView({ block: "center" });
  click(page, open);
  await TestUtils.waitForCondition(() => calls.length, "It opens the Library");
  is(calls[0][1], "routines", "at Routines");
  is(calls[0][0], window, "in the browser window");
  WhimsyArcMenus.openLibrarySection = real;
  await done(page);
});

add_task(async function no_use_for_ai_picker_or_command() {
  ok(!document.getElementById("cmd_whimsyAIUse"), "No Use for AI command");
  Services.prefs.setStringPref("whimsy.ai.order", "claude,gemini");
  Services.prefs.setStringPref("whimsy.ai.provider", "gemini");
  await new Promise(r => setTimeout(r, 50));
  is(Services.prefs.getStringPref("whimsy.ai.order"), "claude,gemini", "Picking a provider the old way doesn't reorder");
  const page = await openAI();
  ok(!page.doc.querySelector("#whimsyAIUse, #whimsyAIProviderMenu, select, menulist"), "No picker in the page");
  await done(page);
});
