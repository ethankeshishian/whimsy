/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W23 secfix2 P2-M5: classifyField knows split one-digit code boxes and
// the card names real checkouts use (cvv2, cvc2, csc, security code, card
// verification), so they stay out of chat context, screenshots, and the
// agent's typing.

const { WhimsyAI } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAI.sys.mjs");
const { WhimsyClaude } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyClaude.sys.mjs");
const { WhimsyAgentTasks } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAgentTasks.sys.mjs");

const ROOT = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com");
const PAGE = ROOT + "whimsy_secfix2_codes.html";
const textOf = result => result.content.filter(c => c.type == "text").map(c => c.text).join("\n");
const own = (task, name, args = {}) => WhimsyClaude.callTool(name, args, { taskId: task.id });

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.ai.enabled", true], ["whimsy.feature.ai-hints", false]] });
  registerCleanupFunction(async () => {
    WhimsyAgentTasks._resetForTesting();
    WhimsyClaude.shutdown();
    await WhimsyAI.pending;
  });
});

add_task(async function real_world_code_and_card_fields() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  const rows = await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
    const { classifyField } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAISensitive.sys.mjs");
    return [...content.document.querySelectorAll("input[data-expect]")].map(el => ({
      where: `${el.closest("[id]").id} ${el.name || el.id || el.getAttribute("aria-label") || el.outerHTML.slice(0, 60)}`,
      expect: el.dataset.expect || null,
      got: classifyField(el),
    }));
  });
  ok(rows.length > 20, "The fixture's fields are all checked");
  for (const { where, expect, got } of rows) {
    is(got, expect, `${where}: ${expect ?? "not a secret"}`);
  }
  BrowserTestUtils.removeTab(tab);
});

add_task(async function split_code_stays_out_of_agent_reads_and_typing() {
  const task = WhimsyAgentTasks.start({ client: "whimsy", mode: "background", sites: ["example.com"] });
  const { tabId } = JSON.parse(textOf(await own(task, "tabs_create", { url: PAGE })));
  const tab = WhimsyClaude.tabById(tabId);
  await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
    const boxes = content.document.querySelectorAll("#split-siblings input");
    [..."739218"].forEach((digit, i) => (boxes[i].value = digit));
    content.document.querySelector("[name=cvv2]").value = "913";
  });
  const tree = textOf(await own(task, "read_page", { tabId }));
  const boxes = tree.split("\n").filter(l => /Digit \d/.test(l));
  is(boxes.length, 6, "The six boxes are in the outline");
  ok(boxes.every(l => /otp \(hidden\)/.test(l) && !/value=/.test(l)), "each as a hidden code, with no digit");
  ok(!tree.includes("913"), "The CVV2 value isn't either");
  const line = tree.split("\n").find(l => /Digit 2/.test(l));
  const ref = line?.match(/\[(ref_\d+)\]/)?.[1];
  ok(ref, "Box 2 is in the outline");
  const pending = own(task, "type", { tabId, ref, text: "4" });
  const pause = await TestUtils.waitForCondition(() => task.pause && !task.pause.choice && task.pause, "Typing into box 2 pauses");
  ok(pause.handOver, "and hands it to the person: codes are always theirs to type");
  WhimsyAgentTasks.decide(task.id, "skip");
  await pending;
  is(await SpecialPowers.spawn(tab.linkedBrowser, [], () => content.document.querySelectorAll("#split-siblings input")[1].value), "3", "Box 2 is untouched");
  WhimsyAgentTasks.finish(task.id);
  BrowserTestUtils.removeTab(tab);
});
