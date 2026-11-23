/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W29 context groups: a page and every tab opened from it, as one row in
// chat's Add menu and one chip. One task per journey in
// intake-w28/designs/x-tabs-context-groups-journeys.md, with the owner's
// defaults: the group outlives its first page and a tab moved to another
// space, it's named after the page that started it, and openers (with
// tree tabs' nesting) come back after a restart.

const { WhimsyChatPanel } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyChatPanel.sys.mjs");
const { WhimsyAIProviders } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIProviders.sys.mjs");
const { WhimsyAIStore } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIStore.sys.mjs");
const { WhimsyTreeTabs } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyTreeTabs.sys.mjs");
const { SessionStore } = ChromeUtils.importESModule("moz-src:///browser/components/sessionstore/SessionStore.sys.mjs");
const { TabStateFlusher } = ChromeUtils.importESModule("moz-src:///browser/components/sessionstore/TabStateFlusher.sys.mjs");

const PAGE = "https://example.com/browser/zen/whimsy/tests/whimsy_chat_article.html";
const chat = () => WhimsyChatPanel.forWindow(window);
const el = () => document.getElementById("whimsy-chat");
const part = sel => el().querySelector(sel);
const parts = sel => [...el().querySelectorAll(sel)];
const startTabs = new Set(gBrowser.tabs);
let calls = [];

async function titled(tab, title) {
  await SpecialPowers.spawn(tab.linkedBrowser, [title], t => {
    content.document.title = t;
  });
  await TestUtils.waitForCondition(() => tab.label == title, `The tab reads ${title}`);
  return tab;
}

async function openRoot(name) {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, `${PAGE}?${encodeURIComponent(name)}`);
  return titled(tab, name);
}

async function openFrom(opener, name) {
  const tab = BrowserTestUtils.addTab(gBrowser, `${PAGE}?${encodeURIComponent(name)}`, { openerBrowser: opener.linkedBrowser });
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser);
  return titled(tab, name);
}

async function openChatOn(tab) {
  gBrowser.selectedTab = tab;
  await WhimsyAIStore._resetForTesting(PathUtils.join(PathUtils.tempDir, "whimsy-ctx-groups-" + Math.random().toString(16).slice(2)));
  calls = [];
  if (!chat().isOpen) {
    EventUtils.synthesizeKey("e", { accelKey: true });
  }
  const opened = await TestUtils.waitForCondition(() => chat().isOpen && chat().ready && part(".whimsy-chat-chip[data-kind='tab']"), "Chat is open with its chip").then(() => true, () => false);
  ok(opened, `Chat is open with its chip (open ${chat().isOpen}, ready ${chat().ready}, chips ${parts(".whimsy-chat-chip").map(c => c.dataset.kind).join(",")}, uri ${tab.linkedBrowser.currentURI.spec}, focused ${Services.focus.activeWindow == window})`);
  if (!opened) {
    throw new Error("Chat didn't open on the tab");
  }
  await TestUtils.waitForCondition(() => el().getAnimations({ subtree: true }).every(a => a.playState != "running"), "Chat settled");
}

async function openAddMenu() {
  part(".whimsy-chat-add-menu")?.remove();
  EventUtils.synthesizeMouseAtCenter(part(".whimsy-chat-chip-add"), {});
  const menu = await TestUtils.waitForCondition(() => part(".whimsy-chat-add-menu"), "The Add menu opens");
  await TestUtils.waitForCondition(() => [...menu.querySelectorAll(".whimsy-chat-option-label")].every(l => l.textContent), "Its rows have words");
  return menu;
}

function closeAddMenu() {
  EventUtils.synthesizeKey("KEY_Escape");
  return TestUtils.waitForCondition(() => !part(".whimsy-chat-add-menu"), "The Add menu closes");
}

function type(text) {
  chat().composer.focus();
  EventUtils.sendString(text);
  EventUtils.synthesizeKey("KEY_Enter");
}

async function ask(text) {
  const before = parts(".whimsy-chat-msg[data-role='ai']").length;
  type(text);
  await TestUtils.waitForCondition(() => !part(".whimsy-chat-msg[data-role='ai'][busy]") && parts(".whimsy-chat-msg[data-role='ai']").length > before, "The answer is in");
  return calls.at(-1).request.system;
}

const groupChip = () => part(".whimsy-chat-chip[data-kind='group']");
const lastUsed = () => parts(".whimsy-chat-used").at(-1);

async function closeChat() {
  part(".whimsy-chat-add-menu")?.remove();
  if (chat().isOpen) {
    chat().close({ reason: "key" });
    await TestUtils.waitForCondition(() => el().hidden, "Chat closed");
  }
}

function removeTabs(tabs) {
  for (const tab of tabs) {
    if (tab.isConnected && !tab.closing) {
      BrowserTestUtils.removeTab(tab);
    }
  }
}

// Contrast helpers as in browser_whimsy_ai_style.js:110-139.
function resolvedRGB(value) {
  const canvas = document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, 1, 1);
  ctx.fillStyle = value;
  ctx.fillRect(0, 0, 1, 1);
  return [...ctx.getImageData(0, 0, 1, 1).data.slice(0, 3)];
}
function luminance([r, g, b]) {
  const lin = c => (c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
function backgroundOf(node) {
  for (let n = node; n && n.nodeType == 1; n = n.parentElement) {
    const color = getComputedStyle(n).backgroundColor;
    if (!/rgba\(\s*0,\s*0,\s*0,\s*0\s*\)|transparent/.test(color)) {
      return color;
    }
  }
  return getComputedStyle(document.documentElement).backgroundColor;
}
function contrastOf(node) {
  const [hi, lo] = [luminance(resolvedRGB(backgroundOf(node))), luminance(resolvedRGB(getComputedStyle(node).color))].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
function fits(node) {
  return node.scrollWidth <= node.clientWidth;
}

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.ai.enabled", true], ["whimsy.feature.ai-hints", false], ["whimsy.ai.order", "claude"], ["whimsy.ai.off", ""], ["whimsy.feature.tree-tabs", false]] });
  WhimsyAIProviders.setTestProvider(async function* (provider, request) {
    calls.push({ provider, request });
    yield { type: "text", delta: "Answer to " + request.lastUserText };
  });
  registerCleanupFunction(async () => {
    await closeChat();
    removeTabs(gBrowser.tabs.filter(t => !startTabs.has(t)));
    WhimsyAIProviders.setTestProvider(null);
    Services.prefs.clearUserPref("whimsy.ai.hints.seen");
  });
});

// Journey 1: comparing a trip.
add_task(async function journey1_trip_group_row_chip_used_line_and_leave_out() {
  const root = await openRoot("Flights to Lisbon");
  const tap = await openFrom(root, "TAP Air Portugal");
  const united = await openFrom(root, "United");
  const airbnb = await openFrom(root, "Alfama apartments");
  const maps = await openFrom(airbnb, "Lisbon to Sintra");
  const hn = await openRoot("Hacker News");
  const wiki = await openRoot("Wikipedia");
  const all = [root, tap, united, airbnb, maps, hn, wiki];
  try {
    is(WhimsyTreeTabs.groupOf(maps)?.tabs.length, 5, "A grandchild belongs to the group too");
    ok(!WhimsyTreeTabs.groupOf(hn), "A tab opened on its own is in no group");

    await openChatOn(tap);
    let menu = await openAddMenu();
    const rows = [...menu.querySelectorAll("[data-group]")];
    is(rows.length, 1, "The Add menu has one group row");
    const row = rows[0];
    is(row.querySelector(".whimsy-chat-option-label").textContent, "Flights to Lisbon", "named after the page that started it");
    await TestUtils.waitForCondition(() => row.querySelector(".whimsy-chat-option-detail").textContent == "5 tabs", "with a muted count");
    is(row.querySelector("img.whimsy-chat-brand")?.localName, "img", "led by the first page's favicon");
    const options = [...menu.querySelectorAll(".whimsy-chat-option")];
    const allTabs = options.find(o => o.querySelector("[data-l10n-id='whimsy-chat-add-all-tabs']"));
    // W30 scoped chats: the space and folder rows come between it and All
    // my tabs (browser_whimsy_chat_context_spaces.js checks their order).
    const scopes = options.filter(o => o.hasAttribute("data-space") || o.hasAttribute("data-folder"));
    is(options.indexOf(row) + 1, options.indexOf(scopes[0] ?? allTabs), "It sits just before the space and folder rows");
    is(options.indexOf(row) + 1 + scopes.length, options.indexOf(allTabs), "and those sit just before All my tabs");
    ok(row.previousElementSibling?.classList.contains("whimsy-chat-menu-rule"), "after the single tabs and their rule");
    ok(fits(row.querySelector(".whimsy-chat-option-label")), "The row's name isn't clipped");
    await whimsyBothSchemes("w29-ctxgroups-add-menu", async dark => {
      const shown = (await openAddMenu()).querySelector("[data-group]");
      for (const node of [shown.querySelector(".whimsy-chat-option-label"), shown.querySelector(".whimsy-chat-option-detail")]) {
        Assert.greaterOrEqual(contrastOf(node), 4.5, `${node.className} meets AA on the menu (${dark ? "dark" : "light"})`);
      }
      ok(fits(shown.querySelector(".whimsy-chat-option-label")), "The row's name isn't clipped");
    });
    await TestUtils.waitForCondition(() => part(".whimsy-chat-add-menu [data-group]"), "Menu open for the click");
    // The light scheme comes back as the shots end: click once the row is
    // what the pointer would hit at its center, not mid-restyle.
    await TestUtils.waitForCondition(() => {
      const target = part(".whimsy-chat-add-menu [data-group]");
      const box = target?.getBoundingClientRect();
      return box?.width && target.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2));
    }, "The group row takes the click");
    const target = part(".whimsy-chat-add-menu [data-group]");
    let clicked = false;
    target.addEventListener("click", () => (clicked = true), { once: true });
    EventUtils.synthesizeMouseAtCenter(target, {});
    const token = chat()._chipToken;
    const chip = await TestUtils.waitForCondition(() => groupChip(), "A group chip joins the composer").catch(e => {
      const { WhimsyChatContextUI } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyChatContextUI.sys.mjs");
      const added = WhimsyChatContextUI.stateOf(chat().thread).added.map(d => d.id).join(",");
      ok(false, `No group chip (clicked ${clicked}, added [${added}], chip renders ${token} → ${chat()._chipToken}, chips ${parts(".whimsy-chat-chip").map(c => c.dataset.kind).join(",")})`);
      throw e;
    });
    ok(!part(".whimsy-chat-add-menu"), "The menu closed");
    is(chip.querySelector(".whimsy-chat-chip-label").textContent, "Flights to Lisbon", "The chip names the first page");
    await TestUtils.waitForCondition(() => chip.querySelector(".whimsy-chat-chip-count[data-kind='tabs']")?.textContent == "5 tabs", "and says 5 tabs");
    const body = chip.querySelector(".whimsy-chat-chip-body");
    await TestUtils.waitForCondition(() => body.getAttribute("title") == "Flights to Lisbon and the tabs opened from it · 5 tabs. Show what AI sees", "Its tooltip says what it holds");
    is(chip.querySelector(".whimsy-chat-chip-mark").localName, "img", "led by the favicon");
    ok(part(".whimsy-chat-chip[data-kind='tab']"), "This tab stays too");
    ok(fits(chip.querySelector(".whimsy-chat-chip-label")), "The chip's name isn't clipped");
    await whimsyBothSchemes("w29-ctxgroups-chip", async dark => {
      for (const node of [groupChip().querySelector(".whimsy-chat-chip-label"), groupChip().querySelector(".whimsy-chat-chip-count")]) {
        Assert.greaterOrEqual(contrastOf(node), 4.5, `${node.className} meets AA on the chip (${dark ? "dark" : "light"})`);
      }
    });

    menu = await openAddMenu();
    ok(!menu.querySelector("[data-group]"), "Once added, the row is gone");
    await closeAddMenu();

    // What AI sees lists the five pages and nothing else.
    EventUtils.synthesizeMouseAtCenter(chip.querySelector(".whimsy-chat-chip-body"), {});
    const pagesRow = await TestUtils.waitForCondition(() => part(".whimsy-chat-sheet .whimsy-chat-sees-row[data-kind='pages']"), "What AI sees opens on the group");
    EventUtils.synthesizeMouseAtCenter(pagesRow, {});
    const listed = await TestUtils.waitForCondition(() => {
      const titles = parts(".whimsy-chat-sheet-view[data-view='pages'] .whimsy-chat-sees-title").map(t => t.textContent);
      return titles.length ? titles : null;
    }, "It lists the pages");
    Assert.deepEqual(listed.sort(), ["Alfama apartments", "Flights to Lisbon", "Lisbon to Sintra", "TAP Air Portugal", "United"], "the five pages, not Hacker News or Wikipedia");
    EventUtils.synthesizeKey("KEY_Escape");
    await TestUtils.waitForCondition(() => part(".whimsy-chat-sheet-view[data-view='list']") && !part(".whimsy-chat-sheet-view[data-view='pages']"), "Esc goes back to the list");
    EventUtils.synthesizeKey("KEY_Escape");
    await TestUtils.waitForCondition(() => !part(".whimsy-chat-sheet"), "The sheet closes");

    let system = await ask("Which option gets me to Sintra cheapest on Saturday?");
    ok(system.includes("?United") && system.includes("?Lisbon%20to%20Sintra"), "The group's pages are sent");
    ok(!system.includes("?Hacker%20News") && !system.includes("?Wikipedia"), "The unrelated tabs aren't");
    is(system.split("?TAP%20Air%20Portugal").length - 1, 1, "This tab is read once");
    await TestUtils.waitForCondition(() => lastUsed()?.textContent == "Used Flights to Lisbon · 5 tabs", "The used line names the group and its count");

    // A tab opened from the group after adding it is read too.
    const ryanair = await openFrom(root, "Ryanair");
    all.push(ryanair);
    is(gBrowser.selectedTab, tap, "Still on TAP");
    system = await ask("and with Ryanair?");
    ok(system.includes("?Ryanair"), "The new tab is read when the message is sent");
    await TestUtils.waitForCondition(() => lastUsed()?.textContent == "Used Flights to Lisbon · 6 tabs", "The used line says 6 tabs");
    await TestUtils.waitForCondition(() => groupChip()?.querySelector(".whimsy-chat-chip-count")?.textContent == "6 tabs", "The chip says 6 tabs");

    // × leaves it out, with the existing note and Undo.
    EventUtils.synthesizeMouseAtCenter(groupChip().querySelector(".whimsy-chat-chip-x"), {});
    await TestUtils.waitForCondition(() => !groupChip(), "× leaves the group out");
    const note = await TestUtils.waitForCondition(() => part(".whimsy-chat-note[data-kind='chip-removed']"), "A note says so");
    await TestUtils.waitForCondition(() => note.textContent.includes("Flights to Lisbon is left out of this chat."), "naming the group");
    const usedBefore = parts(".whimsy-chat-used").length;
    system = await ask("Anything else?");
    ok(!system.includes("?Ryanair"), "The group isn't sent once left out");
    is(parts(".whimsy-chat-used").length, usedBefore, "and no used line names it");
    EventUtils.synthesizeMouseAtCenter(part(".whimsy-chat-note[data-kind='chip-removed']").querySelector(".whimsy-chat-link"), {});
    await TestUtils.waitForCondition(() => groupChip(), "Undo brings the group back");
  } finally {
    await closeChat();
    removeTabs(all);
  }
});

// Journey 2: asking from a page opened from the search, then closing the search.
add_task(async function journey2_named_after_search_and_survives_closing_it() {
  const search = await openRoot("best headphones - Google Search");
  const rtings = await openFrom(search, "RTINGS review");
  const wire = await openFrom(search, "Wirecutter review");
  const verge = await openFrom(search, "Verge review");
  const all = [search, rtings, wire, verge];
  try {
    await openChatOn(rtings);
    let menu = await openAddMenu();
    const row = menu.querySelector("[data-group]");
    is(row?.querySelector(".whimsy-chat-option-label").textContent, "best headphones - Google Search", "The row is named after the search, not the review");
    await TestUtils.waitForCondition(() => row.querySelector(".whimsy-chat-option-detail").textContent == "4 tabs", "4 tabs");
    EventUtils.synthesizeMouseAtCenter(row, {});
    await TestUtils.waitForCondition(() => groupChip(), "Added");
    await ask("Which has the best call quality?");
    await TestUtils.waitForCondition(() => lastUsed()?.textContent == "Used best headphones - Google Search · 4 tabs", "Used 4 tabs");

    // Closing the search keeps the reviews together, under its name.
    BrowserTestUtils.removeTab(search);
    is(gBrowser.selectedTab, rtings, "Still on RTINGS");
    await TestUtils.waitForCondition(() => chat().ready && groupChip(), "The chip stays");
    const system = await ask("And battery life?");
    ok(!system.includes("Google%20Search"), "The closed search isn't read");
    ok(system.includes("?Verge%20review") && system.includes("?Wirecutter%20review"), "The other reviews still are");
    await TestUtils.waitForCondition(() => lastUsed()?.textContent == "Used best headphones - Google Search · 3 tabs", "The chip reads what's left, still named after the search");

    const left = WhimsyTreeTabs.groupOf(wire);
    is(left?.title, "best headphones - Google Search", "Another review still offers the group, named after the closed search");
    is(left?.tabs.length, 3, "with 3 tabs");
  } finally {
    await closeChat();
    removeTabs(all);
  }
});

// Journey 3: a deep thread, and a tab moved to another space.
add_task(async function journey3_deep_thread_and_tab_moved_to_another_space() {
  const work = await gZenWorkspaces.createAndSaveWorkspace("Work", undefined, true);
  const thread = await openRoot("Show HN: A tiny SQLite GUI");
  const github = await openFrom(thread, "GitHub project");
  const docs = await openFrom(github, "Project docs");
  const c1 = await openFrom(thread, "Comment link one");
  const c2 = await openFrom(thread, "Comment link two");
  const all = [thread, github, docs, c1, c2];
  try {
    await openChatOn(docs);
    let menu = await openAddMenu();
    let row = menu.querySelector("[data-group]");
    is(row?.querySelector(".whimsy-chat-option-label").textContent, "Show HN: A tiny SQLite GUI", "A grandchild's row names the thread");
    await TestUtils.waitForCondition(() => row.querySelector(".whimsy-chat-option-detail").textContent == "5 tabs", "and counts every depth");
    await closeAddMenu();

    gZenWorkspaces.moveTabToWorkspace(github, work.uuid);
    is(github.getAttribute("zen-workspace-id"), work.uuid, "GitHub is in Work");
    ok(!WhimsyTreeTabs.groupOf(github), "In Work, GitHub stands alone");
    is(gBrowser.selectedTab, docs, "Still on the docs");
    menu = await openAddMenu();
    row = menu.querySelector("[data-group]");
    ok(row, "The docs tab stays in the group after its opener moved away");
    is(row.querySelector(".whimsy-chat-option-label").textContent, "Show HN: A tiny SQLite GUI", "still named after the thread");
    await TestUtils.waitForCondition(() => row.querySelector(".whimsy-chat-option-detail").textContent == "4 tabs", "4 tabs: GitHub left with its move");
    EventUtils.synthesizeMouseAtCenter(row, {});
    await TestUtils.waitForCondition(() => groupChip(), "Added");
    const system = await ask("Summarise the thread");
    ok(!system.includes("?GitHub%20project"), "The moved tab isn't read");
    ok(system.includes("?Comment%20link%20two"), "The rest are");
    ok(!part(".whimsy-chat-note[data-kind='left-out']"), "No Left out note for a group");
  } finally {
    await closeChat();
    removeTabs(all);
    await gZenWorkspaces.removeWorkspace(work.uuid);
  }
});

// A lone tab offers no group row.
add_task(async function lone_tab_has_no_row() {
  const lone = await openRoot("On its own");
  try {
    await openChatOn(lone);
    const menu = await openAddMenu();
    ok(!menu.querySelector("[data-group]"), "No group row for a tab that opened nothing and that nothing opened");
    await closeAddMenu();
  } finally {
    await closeChat();
    removeTabs([lone]);
  }
});

// Journey 4: after quitting and reopening. Each tab goes through a
// SessionStore state round-trip, children before the page that opened them.
add_task(async function journey4_group_and_tree_nesting_survive_a_restart() {
  const root = await openRoot("Flights to Lisbon");
  const tap = await openFrom(root, "TAP Air Portugal");
  const airbnb = await openFrom(root, "Alfama apartments");
  const maps = await openFrom(airbnb, "Lisbon to Sintra");
  const before = [root, tap, airbnb, maps];
  const restored = [];
  await SpecialPowers.pushPrefEnv({ set: [["browser.sessionstore.restore_on_demand", true]] });
  try {
    const rootKey = WhimsyTreeTabs.groupKeyOf(root);
    ok(rootKey, "The root has a key");
    await Promise.all(before.map(t => TabStateFlusher.flush(t.linkedBrowser)));
    const keys = before.map(t => t.getAttribute("whimsy-ai-key"));
    const states = before.map(t => {
      const state = SessionStore.getTabState(t);
      const saved = JSON.parse(state);
      is(saved.entries[saved.index - 1]?.url, t.linkedBrowser.currentURI.spec, "The saved history contains the page's URL");
      return state;
    });
    ok(JSON.parse(states[3]).extData?.["whimsy-opener"], "The opener is saved with the tab");
    removeTabs(before);
    await TestUtils.waitForCondition(() => before.every(t => !t.isConnected), "The tabs are gone, as after quitting");

    for (const state of [...states].reverse()) {
      const tab = BrowserTestUtils.addTab(gBrowser, "about:blank", { skipAnimation: true, createLazyBrowser: true });
      const ready = BrowserTestUtils.waitForEvent(tab, "SSTabRestoring");
      SessionStore.setTabState(tab, state);
      ok(!tab.linkedPanel && tab.hasAttribute("pending"), "The restored tab starts lazy and pending");
      // Insert only after supplying the saved state. This restores history
      // without starting a competing blank browser before setTabState.
      gBrowser.insertBrowser(tab);
      await ready;
      restored.unshift(tab);
    }
    const [r, t, a, m] = restored;
    restored.forEach((tab, i) => {
      is(tab.getAttribute("whimsy-ai-key"), keys[i], `Restored tab ${i} keeps its key`);
      is(WhimsyTreeTabs.recordOf(tab)?.opener ?? null, i == 0 ? null : i == 3 ? keys[2] : keys[0], `Restored tab ${i} keeps its opener record (${JSON.stringify(WhimsyTreeTabs.recordOf(tab))})`);
    });
    const openers = () => restored.map(x => (x.openerTab ? restored.indexOf(x.openerTab) : "none")).join(",");
    await TestUtils.waitForCondition(() => t.openerTab == r && a.openerTab == r && m.openerTab == a, "Restoring relinks the openers");
    is(openers(), "none,0,0,2", "Each tab is linked back to the tab that opened it");
    is(WhimsyTreeTabs.groupKeyOf(m), rootKey, "The grandchild keeps its group");

    // A duplicate carries its original's saved key; it gets its own.
    const copy = SessionStore.duplicateTab(window, t);
    await TestUtils.waitForCondition(() => {
      const saved = SessionStore.getCustomTabValue(copy, "whimsy-ai-key");
      return saved && saved != keys[1] && copy.getAttribute("whimsy-ai-key") == saved;
    }, "A duplicated tab gets a key of its own");
    is(t.getAttribute("whimsy-ai-key"), keys[1], "and the original keeps its key");
    BrowserTestUtils.removeTab(copy);

    // A restored tab loads when it's selected, as after a real restart.
    // SSTabRestored can also follow an interrupted restore; wait for the
    // actual saved document, with the listener installed before selection.
    const url = `${PAGE}?${encodeURIComponent("TAP Air Portugal")}`;
    const loaded = BrowserTestUtils.browserLoaded(t.linkedBrowser, false, url);
    const tabRestored = BrowserTestUtils.waitForEvent(t, "SSTabRestored");
    await BrowserTestUtils.switchTab(gBrowser, t);
    await tabRestored;
    await loaded;
    ok(!t.hasAttribute("pending"), "The restored tab is no longer pending");
    is(t.linkedBrowser.currentURI.spec, url, "The restored tab loads its saved URL");
    ok(await SpecialPowers.spawn(t.linkedBrowser, [], () => content.document.readyState == "complete" && content.location.search.includes("TAP")), "The restored document is loaded");
    await openChatOn(t);
    const menu = await openAddMenu();
    const row = menu.querySelector("[data-group]");
    ok(row, "The group row is back after the restart");
    await TestUtils.waitForCondition(() => row.querySelector(".whimsy-chat-option-label").textContent == "Flights to Lisbon", "with its name");
    await TestUtils.waitForCondition(() => row.querySelector(".whimsy-chat-option-detail").textContent == "4 tabs", "and every tab");
    await closeAddMenu();
    await closeChat();

    // Tree tabs (when on) nest them again.
    await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.tree-tabs", true]] });
    WhimsyTreeTabs.render(window);
    is(WhimsyTreeTabs.depthOf(m), 2, "Tree tabs nests the grandchild two deep again");
    is(WhimsyTreeTabs.depthOf(t), 1, "and the child one deep");
    await SpecialPowers.popPrefEnv();
    WhimsyTreeTabs.render(window);
  } finally {
    await closeChat();
    removeTabs(restored);
    await SpecialPowers.popPrefEnv();
  }
});
