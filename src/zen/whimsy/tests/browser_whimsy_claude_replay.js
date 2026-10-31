/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Agent replay: each Claude run is kept as a timeline of steps (tool,
// target, URL, thumbnail) in the profile, bounded and pruned; Stop starts a
// new run; private tabs are never captured; Clear history clears it; and
// whimsy://replay lists runs, scrubs steps, opens a step's page and copies
// the log.

const { WhimsyClaude } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyClaude.sys.mjs");
const { WhimsyClaudeReplay } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyClaudeReplay.sys.mjs");
const { WhimsyProtocol } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyProtocol.sys.mjs");

const ENABLED = "whimsy.claude.enabled";
const KEEP = "whimsy.claude.replay";
const SPACE = "whimsy.claude.space-id";
const PAGE =
  getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com") + "whimsy_claude.html";
const FILE = PathUtils.join(PathUtils.profileDir, "whimsy-claude", "runs.json");

const realConfirm = WhimsyClaude.confirmSite;

function textOf(result) {
  return result.content
    .filter(c => c.type == "text")
    .map(c => c.text)
    .join("\n");
}

async function okCall(name, args) {
  const result = await WhimsyClaude.callTool(name, args);
  ok(!result.isError, `${name} succeeds: ${textOf(result).slice(0, 120)}`);
  return result;
}

async function turnOn() {
  Services.prefs.setBoolPref(ENABLED, true);
  await WhimsyClaude.start();
  ok(WhimsyClaude.running, "Claude is on");
}

// A short run: open the test page, read it, find and click Go.
async function aRun() {
  await turnOn();
  await WhimsyClaude.handleRpc({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", clientInfo: { name: "claude-code" } },
  });
  const { tabId } = JSON.parse(textOf(await okCall("tabs_create", { url: PAGE })));
  const tree = textOf(await okCall("read_page", { tabId }));
  await okCall("find", { tabId, query: "go button" });
  const go = tree
    .split("\n")
    .find(l => l.includes('button "Go"'))
    ?.match(/\[(ref_\d+)\]/)?.[1];
  await okCall("click", { tabId, ref: go });
  await WhimsyClaudeReplay.flush();
  return { tabId, tab: WhimsyClaude.tabById(tabId) };
}

add_setup(async function () {
  await gZenWorkspaces.promiseInitialized;
  WhimsyClaude.confirmSite = async () => "once";
  await WhimsyClaudeReplay.clear();
  registerCleanupFunction(async () => {
    WhimsyClaude.confirmSite = realConfirm;
    WhimsyClaude.forgetSitePermissions();
    const spaceId = Services.prefs.getStringPref(SPACE, "");
    for (const pref of [ENABLED, KEEP, SPACE]) {
      Services.prefs.clearUserPref(pref);
    }
    WhimsyClaude.shutdown();
    await WhimsyClaudeReplay.clear();
    if (spaceId && gZenWorkspaces.getWorkspaces().some(w => w.uuid == spaceId)) {
      await gZenWorkspaces.removeWorkspace(spaceId);
    }
  });
});

add_task(async function test_records_a_run() {
  const { tab } = await aRun();
  const runs = await WhimsyClaudeReplay.runs();
  is(runs.length, 1, "One run");
  const [run] = runs;
  is(run.client, "claude-code", "named after the client that connected");
  Assert.deepEqual(
    run.steps.map(s => s.tool),
    ["tabs_create", "read_page", "find", "click"],
    "Each call is a step, in order"
  );
  is(run.steps[1].url, PAGE, "A step has the page's URL");
  is(run.steps[1].title, "Claude test page", "and title");
  ok(run.steps[1].thumb?.startsWith("data:image/jpeg"), "and a thumbnail");
  ok(run.steps.every(s => s.ok), "All succeeded");
  ok(run.steps[2].target.includes("go button"), "find's target is its query");
  ok(await IOUtils.exists(FILE), "Saved in the profile");
  const saved = await IOUtils.readJSON(FILE);
  is(saved.runs[0].steps.length, 4, "with every step");

  WhimsyClaude.stop(window);
  await turnOn();
  await okCall("tabs_list");
  const failed = await WhimsyClaude.callTool("read_page", { tabId: 99999 });
  ok(failed.isError, "A failing call");
  await WhimsyClaudeReplay.flush();
  const after = await WhimsyClaudeReplay.runs();
  is(after.length, 2, "Stop starts a new run");
  Assert.deepEqual(after[0].steps.map(s => s.tool), ["tabs_list", "read_page"], "The newest run comes first");
  ok(!after[0].steps[1].ok && after[0].steps[1].error, "Failures are recorded with why");
  ok(WhimsyClaudeReplay.logText(after[1]).includes(`click ref_`), "The log reads as text");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_private_never_captured() {
  await WhimsyClaudeReplay.clear();
  await turnOn();
  const win = await BrowserTestUtils.openNewBrowserWindow({ private: true });
  const tab = win.gBrowser.selectedTab;
  BrowserTestUtils.startLoadingURIString(tab.linkedBrowser, PAGE);
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser);
  ok(!WhimsyClaudeReplay.capturable(tab), "A private window's tab is never capturable");
  const tabId = WhimsyClaude.tabId(tab);
  ok((await WhimsyClaude.callTool("read_page", { tabId })).isError, "Claude can't use it");
  await WhimsyClaudeReplay.record({ tool: "read_page", args: {}, generation: 0 }, tab);
  await WhimsyClaudeReplay.flush();
  is((await WhimsyClaudeReplay.runs()).length, 0, "and nothing about it is recorded");
  await BrowserTestUtils.closeWindow(win);

  Services.prefs.setBoolPref(KEEP, false);
  await okCall("tabs_list");
  await WhimsyClaudeReplay.flush();
  is((await WhimsyClaudeReplay.runs()).length, 0, "Recording off in Settings records nothing");
  Services.prefs.clearUserPref(KEEP);
});

add_task(async function test_clear_history_clears_it() {
  const { tab } = await aRun();
  await WhimsyClaude.audit("test audit line");
  ok((await WhimsyClaudeReplay.runs()).length, "There's a run");

  const runs = await WhimsyClaudeReplay.runs();
  const middle = runs[0].steps[2].t;
  await WhimsyClaudeReplay.clear(middle);
  const kept = (await WhimsyClaudeReplay.runs())[0].steps;
  ok(kept.length >= 1 && kept.every(s => s.t < middle), "Clearing a time range drops only its steps");

  Services.obs.notifyObservers(null, "browser:purge-session-history");
  await TestUtils.waitForCondition(async () => !(await WhimsyClaudeReplay.runs()).length, "Clear history empties it");
  await TestUtils.waitForCondition(async () => !(await IOUtils.exists(FILE)), "and removes the file");
  is((await WhimsyClaude.readAudit()).length, 0, "and the shield's audit log");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_bounded() {
  const { LIMITS } = WhimsyClaudeReplay;
  const now = Date.now();
  const step = (t, thumb = "") => ({ t, tool: "read_page", target: "", url: PAGE, title: "", ok: true, thumb });
  const make = (i, end, steps = 1) => ({
    id: `r${i}`,
    start: end,
    end,
    steps: Array.from({ length: steps }, (_, j) => step(end - j)),
  });

  let runs = Array.from({ length: LIMITS.runs + 10 }, (_, i) => make(i, now - i * 1000));
  runs.push(make("old", now - LIMITS.ageMs - 1000));
  runs = WhimsyClaudeReplay.prune(runs, now);
  is(runs.length, LIMITS.runs, "Only the newest runs are kept");
  ok(!runs.some(r => r.id == "rold"), "and old runs are dropped");

  const long = WhimsyClaudeReplay.prune([make("long", now, LIMITS.steps + 20)], now)[0];
  is(long.steps.length, LIMITS.steps, "A run keeps a bounded number of steps");
  ok(long.trimmed, "and says so");

  const bytes = LIMITS.bytes;
  LIMITS.bytes = 4000;
  try {
    const big = "data:image/jpeg;base64," + "A".repeat(2500);
    const heavy = [0, 1, 2].map(i => ({ id: `h${i}`, start: now - i, end: now - i, steps: [step(now - i, big), step(now - i, big)] }));
    const pruned = WhimsyClaudeReplay.prune(heavy, now);
    is(pruned.length, 1, "Over the byte cap, older runs go first");
    ok(JSON.stringify({ runs: pruned }).length <= LIMITS.bytes, "then thumbnails, until it fits");
    is(pruned[0].steps.length, 2, "Steps themselves stay");
  } finally {
    LIMITS.bytes = bytes;
  }
});

add_task(async function test_replay_page() {
  is(WhimsyProtocol.route("whimsy://replay").url, "about:whimsy?replay", "whimsy://replay opens the runs page");
  await WhimsyClaudeReplay.clear();
  const { tab } = await aRun();
  const [run] = await WhimsyClaudeReplay.runs();

  await BrowserTestUtils.withNewTab("about:whimsy?replay", async browser => {
    const doc = browser.contentDocument;
    await TestUtils.waitForCondition(() => doc.documentElement.hasAttribute("data-ready"), "The page loads its runs");
    const $ = id => doc.getElementById(id);
    ok($("whimsy-replay-empty").hidden, "No empty state");
    is($("whimsy-replay-runs").querySelectorAll("button").length, 1, "The run is listed");
    const strip = $("whimsy-replay-strip").querySelectorAll("button");
    is(strip.length, run.steps.length, "with a card per step");
    is(strip[0].getAttribute("aria-current"), "true", "The first step shows first");

    const scrub = $("whimsy-replay-scrub");
    scrub.value = "2";
    scrub.dispatchEvent(new browser.contentWindow.Event("input"));
    is(strip[2].getAttribute("aria-current"), "true", "Scrubbing moves to a step");
    is(doc.l10n.getAttributes($("whimsy-replay-tool")).args.tool, "find", "and shows its action");
    ok($("whimsy-replay-target").textContent.includes("go button"), "its target");
    ok($("whimsy-replay-url").textContent.includes(PAGE), "and its URL");
    ok(!$("whimsy-replay-thumb").hidden, "and thumbnail");

    doc.dispatchEvent(new browser.contentWindow.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    is(strip[1].getAttribute("aria-current"), "true", "The arrow keys scrub too");
    strip[3].click();
    is(scrub.value, "3", "and so does the filmstrip");

    const opened = BrowserTestUtils.waitForNewTab(gBrowser, PAGE, true);
    $("whimsy-replay-open").click();
    BrowserTestUtils.removeTab(await opened);
    ok(true, "Open Page opens the step's page");

    await SimpleTest.promiseClipboardChange(
      text => text.startsWith("Claude run") && text.includes("tabs_create") && text.includes(PAGE),
      () => $("whimsy-replay-copy").click()
    );
    ok(true, "Copy Log copies the run");

    $("whimsy-replay-delete").click();
    await TestUtils.waitForCondition(() => !$("whimsy-replay-empty").hidden, "Deleting the last run shows the empty state");
    ok($("whimsy-replay-layout").hidden, "and hides the timeline");
  });
  BrowserTestUtils.removeTab(tab);
});

// wave7/security L5: replay keeps no magic-link tokens (query strings) and
// no one-time codes Claude typed or filled.
add_task(async function test_no_tokens_or_codes_on_disk() {
  await turnOn();
  const url = PAGE + "?token=SECRET-TOKEN-123#frag";
  const { tabId } = JSON.parse(textOf(await okCall("tabs_create", { url })));
  const tab = WhimsyClaude.tabById(tabId);
  await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
    content.document.getElementById("q").setAttribute("autocomplete", "one-time-code");
  });
  const tree = textOf(await okCall("read_page", { tabId }));
  const ref = tree
    .split("\n")
    .find(l => l.includes("Type a sandwich"))
    ?.match(/\[(ref_\d+)\]/)?.[1];
  ok(ref, "The code field has a ref");
  await okCall("type", { tabId, ref, text: "482913" });
  await okCall("form_input", { tabId, ref, value: "771204" });
  await okCall("navigate", { tabId, url: PAGE + "?magic=SECRET-MAGIC-456" });
  await WhimsyClaudeReplay.flush();
  const saved = await IOUtils.readUTF8(FILE);
  ok(!saved.includes("SECRET-TOKEN-123") && !saved.includes("SECRET-MAGIC-456"), "No query strings on disk");
  ok(!saved.includes("482913") && !saved.includes("771204"), "No one-time codes on disk");
  const [run] = await WhimsyClaudeReplay.runs();
  ok(run.steps.some(s => s.tool == "type") && run.steps.some(s => s.tool == "form_input"), "The steps themselves are kept");
  ok(run.steps.some(s => s.url == PAGE), "with the page's address");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_view_claude_replays_command() {
  const { WhimsyCommands } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCommands.sys.mjs");
  const entry = WhimsyCommands.get("cmd_whimsyViewClaudeReplays");
  ok(entry, "View Claude in Whimsy Replays command is registered");
  is(WhimsyCommands.title(entry), "View Claude in Whimsy Replays", "Title matches");
  const commandEl = document.getElementById("cmd_whimsyViewClaudeReplays");
  ok(commandEl, "Command element exists in window");
});
