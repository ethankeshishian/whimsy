/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W23 agent-core: guardrail pauses. The agent acts freely but pauses with
// an exact preview before paying, sending, deleting, changing settings,
// submitting, typing your data on a new site, downloading, or signing in;
// security settings are handed over; unsure means pause; captchas wait for
// the page to move on; outside apps' held calls return before 120s.

const { WhimsyAI } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAI.sys.mjs");
const { WhimsyClaude } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyClaude.sys.mjs");
const { WhimsyAgentTasks } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAgentTasks.sys.mjs");
const { WhimsyAgentGuard } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAgentGuard.sys.mjs");

const ENABLED = "whimsy.ai.outside-agents";
const AI_ENABLED = "whimsy.ai.enabled";
const PORT = "whimsy.claude.port";
const ROOT = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com");
const CHECKOUT = ROOT + "whimsy_agent_checkout.html";
const SEND = ROOT + "whimsy_agent_send.html";
const SETTINGS = ROOT + "whimsy_agent_settings.html";
const CAPTCHA = ROOT + "whimsy_agent_captcha.html";

const aiHadUserValue = Services.prefs.prefHasUserValue(AI_ENABLED);
const aiValue = Services.prefs.getBoolPref(AI_ENABLED, false);

function textOf(result) {
  return result.content.filter(c => c.type == "text").map(c => c.text).join("\n");
}

function own(task, name, args = {}) {
  return WhimsyClaude.callTool(name, args, { taskId: task.id });
}

async function open(task, url) {
  const result = await own(task, "tabs_create", { url });
  ok(!result.isError, `Opened ${url}`);
  const { tabId } = JSON.parse(textOf(result));
  const tab = WhimsyClaude.tabById(tabId);
  const tree = textOf(await own(task, "read_page", { tabId }));
  return { tabId, tab, tree };
}

function refIn(tree, pattern) {
  const line = tree.split("\n").find(l => pattern.test(l));
  ok(line, `The outline has ${pattern}`);
  return line?.match(/\[(ref_\d+)\]/)?.[1];
}

function waitForPause(task, kind) {
  return TestUtils.waitForCondition(() => task.pause && !task.pause.choice && task.pause.kind == kind && task.pause,
    `The task pauses (${kind})`);
}

function resultOf(tab) {
  return SpecialPowers.spawn(tab.linkedBrowser, [], () => content.document.getElementById("result").textContent);
}

function fieldValue(preview, label) {
  return preview.fields.find(f => f.label == label)?.value;
}

add_setup(async function () {
  Services.prefs.setBoolPref(AI_ENABLED, true);
  WhimsyAgentGuard._setSiteKnownForTesting(() => true);
  registerCleanupFunction(async () => {
    WhimsyAgentGuard._setSiteKnownForTesting(null);
    WhimsyAgentTasks._resetForTesting();
    WhimsyClaude.timing.captchaPoll = 1000;
    Services.prefs.clearUserPref(ENABLED);
    Services.prefs.clearUserPref(PORT);
    WhimsyClaude.shutdown();
    if (aiHadUserValue) {
      Services.prefs.setBoolPref(AI_ENABLED, aiValue);
    } else {
      Services.prefs.clearUserPref(AI_ENABLED);
    }
    await WhimsyAI.pending;
  });
});

add_task(async function pay_button_pauses_with_amount() {
  const task = WhimsyAgentTasks.start({ mode: "drive" });
  const { tabId, tab, tree } = await open(task, CHECKOUT);
  const place = refIn(tree, /button "Place order"/);
  let pending = own(task, "click", { tabId, ref: place });
  const pause = await waitForPause(task, "pay");
  is(pause.preview.amount, "$38.40", "The preview has the exact amount");
  is(pause.preview.title, "Pay $38.40 on example.com?", "and says it in the title");
  is(fieldValue(pause.preview, "Total"), "$38.40", "Total row");
  const card = pause.preview.fields.find(f => f.sensitive == "card");
  ok(card?.hidden && !card.value, "The card shows only as filled for you, never its number");
  is(fieldValue(pause.preview, "Ship to"), "1200 Valencia St", "Filled fields are listed");
  is(pause.preview.press, "Place order", "and the button it will press");
  ok(!pause.allowForTask, "No don't-ask-again for paying");
  is(await resultOf(tab), "", "Nothing happens until the person chooses");
  WhimsyAgentTasks.decide(task.id, "skip");
  ok(textOf(await pending).includes("chose not to"), "Don't pay skips the step");
  is(await resultOf(tab), "", "and nothing was paid");

  pending = own(task, "click", { tabId, ref: place });
  await waitForPause(task, "pay");
  WhimsyAgentTasks.decide(task.id, "do");
  ok(!(await pending).isError, "Pay presses the button");
  is((await resultOf(tab)).trim(), "ordered", "once");
  await own(task, "tabs_close", { tabId });
  WhimsyAgentTasks.finish(task.id);
});

add_task(async function send_pauses() {
  const task = WhimsyAgentTasks.start({ mode: "drive" });
  const { tabId, tab, tree } = await open(task, SEND);
  const pending = own(task, "click", { tabId, ref: refIn(tree, /button "Send"/) });
  const pause = await waitForPause(task, "send");
  is(fieldValue(pause.preview, "To"), "Maya Chen <maya@example.org>", "Every recipient");
  is(fieldValue(pause.preview, "Message"), "Dec 12 to 15 works for me.", "and the full text, under its label alone");
  WhimsyAgentTasks.decide(task.id, "self");
  is(task.pause.yours, true, "I'll edit it: the step is the person's");
  let settled = false;
  pending.then(() => (settled = true));
  await new Promise(r => setTimeout(r, 200));
  ok(!settled, "and the agent waits for Continue");
  WhimsyAgentTasks.resume(task.id);
  ok(textOf(await pending).includes("did this step themselves"), "Continue: the agent reads on");
  is(await resultOf(tab), "", "The agent never pressed Send itself");

  const deleting = own(task, "click", { tabId, ref: refIn(tree, /button "Delete draft"/) });
  is((await waitForPause(task, "delete")).preview.press, "Delete draft", "Deleting pauses with what it deletes");
  WhimsyAgentTasks.decide(task.id, "skip");
  await deleting;
  await own(task, "tabs_close", { tabId });
  WhimsyAgentTasks.finish(task.id);
});

add_task(async function security_settings_hand_over() {
  const task = WhimsyAgentTasks.start({ mode: "drive" });
  const { tabId, tab, tree } = await open(task, SETTINGS);
  for (const name of ["Turn off two-factor authentication", "Change password"]) {
    const pending = own(task, "click", { tabId, ref: refIn(tree, new RegExp(`button "${name}"`)) });
    const pause = await waitForPause(task, "security");
    ok(pause.handOver, `${name}: handed over`);
    Assert.deepEqual(pause.choices, ["self", "skip"], "never done by the agent");
    ok(!WhimsyAgentTasks.decide(task.id, "do"), "even when told to");
    WhimsyAgentTasks.decide(task.id, "skip");
    await pending;
  }
  is(await resultOf(tab), "", "Nothing was pressed");

  const saving = own(task, "click", { tabId, ref: refIn(tree, /button "Save changes"/) });
  is((await waitForPause(task, "account")).kind, "account", "Other settings pause as a setting change");
  WhimsyAgentTasks.decide(task.id, "skip");
  await saving;
  const signing = own(task, "click", { tabId, ref: refIn(tree, /button "Sign in"/) });
  const signIn = await waitForPause(task, "sign-in");
  ok(signIn.preview.fields.some(f => f.sensitive == "password" && !f.value), "Sign in: the password is never shown");
  ok(signIn.preview.fields.some(f => /you type it/.test(f.value)), "and codes are the person's to type");
  WhimsyAgentTasks.decide(task.id, "skip");
  await signing;
  await own(task, "tabs_close", { tabId });
  WhimsyAgentTasks.finish(task.id);
});

add_task(async function unsure_control_pauses() {
  const task = WhimsyAgentTasks.start({ mode: "drive" });
  const { tabId, tab, tree } = await open(task, CHECKOUT);
  const pending = own(task, "click", { tabId, ref: refIn(tree, /button "Confirm"/) });
  const pause = await waitForPause(task, "unsure");
  is(pause.preview.title, "I’m not sure what “Confirm” does here", "It says it can't tell");
  is(pause.preview.amount, "€492", "and what it might cost");
  WhimsyAgentTasks.decide(task.id, "skip");
  await pending;
  is(await resultOf(tab), "", "It never guesses its way past");
  await own(task, "tabs_close", { tabId });
  WhimsyAgentTasks.finish(task.id);
});

add_task(async function dont_ask_again_only_for_submit_newsite_download() {
  const at = (kind, extra = {}) => WhimsyAgentGuard.classify("click", { host: "example.com", url: "https://example.com/", ...extra })?.kind ?? null;
  is(at("click", { role: "button", text: "Pay $12.00" }), "pay", "Pay");
  is(at("click", { role: "link", text: "Go to checkout", href: "https://example.com/checkout" }), null, "Going to the checkout is free");
  is(at("click", { role: "button", text: "Search", submits: true, form: { role: "search", fields: [{ type: "search", name: "q" }] } }), null, "Searching is free");
  is(at("click", { role: "link", text: "Get it", href: "https://example.com/a.dmg" }), "download", "A file link downloads");
  is(WhimsyAgentGuard.classify("type", { host: "new.example", role: "textbox", label: "Email", autocomplete: "email", value: "a@b.co", newSite: true })?.kind,
    "new-site-data", "Your email on a site you haven't used");
  is(WhimsyAgentGuard.classify("type", { host: "new.example", role: "textbox", label: "Email", value: "a@b.co", newSite: false }), null, "but not on one you have");

  const task = WhimsyAgentTasks.start({ mode: "drive" });
  const { tabId, tab, tree } = await open(task, SEND);
  const book = refIn(tree, /button "Request booking"/);
  let pending = own(task, "click", { tabId, ref: book });
  const submit = await waitForPause(task, "submit");
  ok(submit.allowForTask, "Submit offers don't ask again on this site for this task");
  WhimsyAgentTasks.decide(task.id, "do", { allowForTask: true });
  await pending;
  pending = own(task, "click", { tabId, ref: book });
  ok(!(await pending).isError, "The next submit on the site goes ahead");
  ok(!task.pause, "without a pause");
  is((await resultOf(tab)).trim(), "booking booking", "both went through");

  pending = own(task, "click", { tabId, ref: refIn(tree, /link "Download for macOS"/) });
  const download = await waitForPause(task, "download");
  ok(download.allowForTask, "Downloads offer it too");
  is(download.preview.fields[0].value, "Figma-Desktop.dmg", "with the file name");
  WhimsyAgentTasks.decide(task.id, "skip");
  await pending;

  const send = own(task, "click", { tabId, ref: refIn(tree, /button "Send"/) });
  const sendPause = await waitForPause(task, "send");
  ok(!sendPause.allowForTask, "Sending never does");
  WhimsyAgentTasks.decide(task.id, "do", { allowForTask: true });
  await send;
  ok(!task.allowed.has("send|example.com"), "and nothing is remembered for it");

  // A new task uses its own tab (H2: a task never acts in another task's tab).
  const other = WhimsyAgentTasks.start({ mode: "drive" });
  const refused = await own(other, "click", { tabId, ref: book });
  ok(refused.isError && /not this task's/.test(textOf(refused)), "The first task's tab is refused to it");
  const second = await open(other, SEND);
  const again = own(other, "click", { tabId: second.tabId, ref: refIn(second.tree, /button "Request booking"/) });
  await waitForPause(other, "submit");
  ok(true, "A new task asks again: nothing outlives the task");
  WhimsyAgentTasks.decide(other.id, "skip");
  await again;
  is(await resultOf(second.tab), "", "and nothing was submitted there");
  await own(other, "tabs_close", { tabId: second.tabId });
  await own(task, "tabs_close", { tabId });
  WhimsyAgentTasks.finish(task.id);
  WhimsyAgentTasks.finish(other.id);
});

add_task(async function mcp_hold_returns_waiting_before_120s() {
  Services.prefs.setBoolPref(ENABLED, true);
  await WhimsyClaude.start();
  const session = "hold-session";
  const call = (name, args) => WhimsyClaude.callTool(name, args, { session, clientName: "Claude Code" });
  const { tabId } = JSON.parse(textOf(await call("tabs_create", { url: CHECKOUT })));
  const tab = WhimsyClaude.tabById(tabId);
  const place = textOf(await call("read_page", { tabId })).split("\n").find(l => /button "Place order"/.test(l)).match(/\[(ref_\d+)\]/)[1];
  const holds = [];
  // A fake clock: the hold's timer fires at once, recording how long it was.
  const restore = WhimsyAgentTasks._setTimerForTesting((ms, fn) => {
    if (ms == WhimsyAgentTasks.approvalTimeoutMs) {
      return () => {};
    }
    holds.push(ms);
    Promise.resolve().then(fn);
    return () => {};
  });
  const task = WhimsyAgentTasks.forSession(session);
  try {
    let result = await call("click", { tabId, ref: place });
    is(textOf(result), "Waiting for the person to approve; call again to keep waiting", "The held call returns the waiting text");
    ok(!result.isError, "not as an error");
    ok(holds[0] > 0 && holds[0] < 110000, `before the bridge's 120s limit (${holds[0]}ms)`);
    is(task.pause?.kind, "pay", "and the pause stays");
    result = await call("click", { tabId, ref: place });
    is(textOf(result), WhimsyAgentGuard.WAITING_TEXT, "Calling again keeps waiting");
    is(holds.length, 2, "one hold per call");
    is(await resultOf(tab), "", "Nothing was pressed");
  } finally {
    restore();
  }
  WhimsyAgentTasks.decide(task.id, "do");
  const done = await call("click", { tabId, ref: place });
  ok(!done.isError, "After Pay, the next call acts");
  is((await resultOf(tab)).trim(), "ordered", "and the order goes through once");
  await call("tabs_close", { tabId });
});

add_task(async function captcha_waits_no_click() {
  WhimsyClaude.timing.captchaPoll = 100;
  const task = WhimsyAgentTasks.start({ mode: "drive" });
  const { tabId, tab, tree } = await open(task, CAPTCHA);
  const pending = own(task, "click", { tabId, ref: refIn(tree, /checkbox "I'm not a robot"/) });
  const pause = await waitForPause(task, "captcha");
  Assert.deepEqual(pause.choices, ["self", "skip"], "Show the tab or Skip this site; the agent never answers it");
  await new Promise(r => setTimeout(r, 300));
  is(await resultOf(tab), "", "The check wasn't clicked");
  const loaded = BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, CAPTCHA + "?passed");
  BrowserTestUtils.startLoadingURIString(tab.linkedBrowser, CAPTCHA + "?passed");
  await loaded;
  const result = await pending;
  ok(textOf(result).includes("moved on"), "Once the page moves on, the task carries on");
  await own(task, "tabs_close", { tabId });
  WhimsyAgentTasks.finish(task.id);
});
