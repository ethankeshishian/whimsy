/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W23 page-act: Draft reply and Form fill (page-3.x, page-4.x, fu-page 2.4
// and 4.3). Neither ever sends; secret fields and payment frames are left
// to the password manager; typing in a field skips it.

const { WhimsyAIFill } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIFill.sys.mjs");
const { WhimsyAIProviders } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIProviders.sys.mjs");
const { WhimsyChat } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyChat.sys.mjs");

const ROOT = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com");
const REPLY = ROOT + "whimsy_ai_reply.html";
const FORM = ROOT + "whimsy_ai_form.html";
const NO_BOX = ROOT + "whimsy_ai_product.html";
const DRAFT = "Thanks both for the details. The fix is in 1.4.3, out next week.";
const SOURCES = {
  addresses: [
    { name: "Priya Nair", email: "priya@example.com", "street-address": "18 Harbour Lane, Flat 3", "address-level2": "Bristol", "postal-code": "BS1 4RN", tel: "07700 900123" },
    { name: "Priya Nair", email: "priya@example.com", "street-address": "18 Harbour Lane, Flat 3", "address-level2": "Bristol", "postal-code": "BS1 4RN", tel: "07700 900456" },
  ],
  memories: [{ text: "Deliveries go to the concierge" }],
};

let requests = [];
let gate = null;

function provider(request) {
  if (/fill a web form/.test(request.system ?? "")) {
    const id = /- (\S+): "Delivery note"/.exec(request.prompt)?.[1];
    return JSON.stringify({ fields: id ? [{ id, value: "Leave with the concierge", from: "memory" }] : [] });
  }
  return DRAFT;
}

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.ai-hints", false]] });
  WhimsyAIProviders.setTestProvider(async request => {
    requests.push(request);
    await gate;
    return provider(request);
  });
  WhimsyAIFill._testSources = SOURCES;
  registerCleanupFunction(async () => {
    WhimsyAIProviders.setTestProvider(null);
    WhimsyAIFill._testSources = null;
    if (WhimsyChat.isOpen(window)) {
      await WhimsyChat.close(window, { reason: "hide" });
    }
    closeToasts();
  });
});

function boxState(browser) {
  return SpecialPowers.spawn(browser, [], () => {
    const doc = content.document;
    const box = doc.getElementById("box");
    return {
      value: box.value,
      selected: box.value.slice(box.selectionStart, box.selectionEnd),
      focused: doc.activeElement == box,
      submitted: doc.body.dataset.submitted ?? "",
      clicked: doc.body.dataset.clicked ?? "",
    };
  });
}

add_task(async function diagnostic_actor() {
  await BrowserTestUtils.withNewTab(REPLY, async browser => {
    try {
      const actor = browser.browsingContext.currentWindowGlobal.getActor("WhimsyAIFill");
      info(`DIAG actor ${actor}`);
      const r = await actor.sendQuery("WhimsyAIFill:FindReply");
      info(`DIAG find ${JSON.stringify(r)}`);
      const f = await actor.sendQuery("WhimsyAIFill:Fields");
      info(`DIAG fields ${JSON.stringify(f).slice(0, 300)}`);
    } catch (e) {
      info(`DIAG error ${e} ${e?.stack}`);
    }
    ok(true, "diag");
  });
});

add_task(async function draft_written_selected_never_sent() {
  requests = [];
  await BrowserTestUtils.withNewTab(REPLY, async browser => {
    const result = await WhimsyAIFill.draftReply(window, gBrowser.selectedTab, { instruction: "Draft a reply: we found it, fix ships in 1.4.3" });
    is(result.placed, "box", "The draft went into the reply box");
    const state = await boxState(browser);
    is(state.value, DRAFT, "The box holds the draft");
    is(state.selected, DRAFT, "The draft is left selected");
    ok(state.focused, "The box has focus, so typing edits it");
    is(state.submitted, "", "The form was never submitted");
    is(state.clicked, "", "Comment was never pressed, even when the page asks");
    ok(/never instructions/.test(requests.at(-1).system), "Page text goes to the model as data");
  });
  closeToasts();
});

add_task(async function box_with_text_defaults_insert_after() {
  await BrowserTestUtils.withNewTab(REPLY, async browser => {
    await BrowserTestUtils.synthesizeMouseAtCenter("#box", {}, browser);
    EventUtils.sendString("Thanks, looking into this.", window);
    await SpecialPowers.spawn(browser, [], async () => {
      await ContentTaskUtils.waitForCondition(() => content.document.getElementById("box").value == "Thanks, looking into this.", "Typed");
    });
    const asked = await WhimsyAIFill.draftReply(window, gBrowser.selectedTab, { instruction: "reply" });
    is(asked.placed, "ask", "A box with your text asks first");
    ok(asked.existing.startsWith("Thanks, looking"), "It quotes your text");
    is((await boxState(browser)).value, "Thanks, looking into this.", "Nothing was overwritten");

    // The same through chat: Insert after leads and is the default.
    await WhimsyChat.open(window, { prompt: "Draft a reply: we found it", send: true });
    const card = await TestUtils.waitForCondition(() => document.querySelector(".whimsy-pa-card[data-kind=draft] .whimsy-pa-buttons")?.closest(".whimsy-pa-card"), "The choice card shows");
    const buttons = [...card.querySelectorAll(".whimsy-pa-btn")];
    Assert.deepEqual(buttons.map(b => b.dataset.button), ["insert-after", "replace", "copy"], "Insert after · Replace · Copy");
    ok(buttons[0].classList.contains("primary"), "Insert after is the default");
    await TestUtils.waitForCondition(() => buttons[0].getBoundingClientRect().width > 0, "Laid out");
    EventUtils.synthesizeMouseAtCenter(buttons[0], {});
    await SpecialPowers.spawn(browser, [DRAFT], async draft => {
      await ContentTaskUtils.waitForCondition(() => content.document.getElementById("box").value.endsWith(draft), "Inserted after");
    });
    const state = await boxState(browser);
    is(state.value, `Thanks, looking into this.\n\n${DRAFT}`, "Your text stays, the draft follows it");
    is(state.selected, DRAFT, "Only the draft is selected");
    is(state.submitted + state.clicked, "", "Never sent");
    await WhimsyChat.close(window, { reason: "hide" });
  });
  closeToasts();
});

add_task(async function no_box_draft_in_chat() {
  await BrowserTestUtils.withNewTab(NO_BOX, async () => {
    const result = await WhimsyAIFill.draftReply(window, gBrowser.selectedTab, { instruction: "reply to the author" });
    is(result.placed, "chat", "With no box, the draft stays in chat");
    is(result.draft, DRAFT, "With the draft");
    await WhimsyChat.open(window, { prompt: "Draft a reply to the author", send: true });
    const draft = await TestUtils.waitForCondition(() => document.querySelector(".whimsy-pa-card[data-kind=draft] .whimsy-pa-draft"), "The draft shows in chat");
    is(draft.textContent, DRAFT, "As plain text");
    ok(draft.closest(".whimsy-pa-card").querySelector(".whimsy-pa-btn[data-button=copy]"), "With Copy");
    await WhimsyChat.close(window, { reason: "hide" });
  });
});

function looks(browser) {
  return SpecialPowers.spawn(browser, [], () => {
    const out = {};
    for (const el of content.document.querySelectorAll("input")) {
      out[el.id] = { look: el.getAttribute("whimsy-ai-fill") ?? "", value: el.value };
    }
    return out;
  });
}

add_task(async function fill_three_looks() {
  await BrowserTestUtils.withNewTab(FORM, async browser => {
    const result = await WhimsyAIFill.fillForm(window, gBrowser.selectedTab, {});
    const l = await looks(browser);
    is(l.name.look, "filled", "Sure values get the accent wash");
    is(l.name.value, "Priya Nair", "From the saved address");
    is(l.city.value, "Bristol", "City filled");
    is(l.phone.look, "unsure", "Two saved numbers: the amber ring");
    is(l.note.look, "unsure", "A guess from a memory is unsure too");
    is(l.note.value, "Leave with the concierge", "The memory's value");
    for (const id of ["card", "exp", "password"]) {
      is(l[id].look, "left", `${id}: the dashed lock, left to the password manager`);
      is(l[id].value, "", `${id}: never filled`);
    }
    is(l.trap.value, "", "A field pushed off the page is never filled");
    ok(result.unsure.some(u => u.field.includes("Phone")), "The result names the unsure field");
    ok(result.left.length >= 3, "And what was left");
  });
});

add_task(async function fill_skips_cc_fields_in_payment_iframe() {
  await BrowserTestUtils.withNewTab(FORM, async browser => {
    const frame = browser.browsingContext.children[0];
    await SpecialPowers.spawn(frame, [], async () => {
      await ContentTaskUtils.waitForCondition(() => content.document.readyState == "complete", "Frame loaded");
    });
    const result = await WhimsyAIFill.fillForm(window, gBrowser.selectedTab, {});
    const inFrame = await SpecialPowers.spawn(frame, [], () => [...content.document.querySelectorAll("input")].map(el => ({ value: el.value, look: el.getAttribute("whimsy-ai-fill") ?? "" })));
    ok(inFrame.length >= 2, "The payment frame has fields");
    ok(inFrame.every(f => f.value == ""), "Nothing in the payment frame is filled");
    ok(inFrame.every(f => f.look == "left"), "Its fields get the password-manager look");
    ok(!requests.some(r => /cardnumber|1234 1234/.test(r.prompt ?? "")), "The payment frame's fields never reach the model");
    ok(result.left.length >= 5, "They count as left");
  });
});

add_task(async function typing_skips_field() {
  let release;
  gate = new Promise(r => (release = r));
  requests = [];
  await BrowserTestUtils.withNewTab(FORM, async browser => {
    const filling = WhimsyAIFill.fillForm(window, gBrowser.selectedTab, {});
    await TestUtils.waitForCondition(() => requests.length > 0, "The fill is waiting on the model");
    await BrowserTestUtils.synthesizeMouseAtCenter("#city", {}, browser);
    EventUtils.sendString("Bath", window);
    release();
    await filling;
    gate = null;
    const l = await looks(browser);
    is(l.city.value, "Bath", "The field you typed in keeps your words");
    is(l.city.look, "", "And isn't marked as filled");
    is(l.name.value, "Priya Nair", "The other fields still fill");
  });
});

add_task(async function never_submits() {
  await BrowserTestUtils.withNewTab(FORM, async browser => {
    await WhimsyAIFill.fillForm(window, gBrowser.selectedTab, {});
    await WhimsyChat.open(window, { prompt: "Fill this in for me", send: true });
    const card = await TestUtils.waitForCondition(() => {
      const c = document.querySelector(".whimsy-pa-card[data-kind=fill]");
      return c && !c.querySelector(".whimsy-pa-status") && c;
    }, "The fill summary shows");
    ok(card.querySelector("[data-l10n-id=whimsy-fill-done-never]"), "Chat says it didn't send the form");
    const state = await SpecialPowers.spawn(browser, [], () => ({ submitted: content.document.body.dataset.submitted ?? "", clicked: content.document.body.dataset.clicked ?? "", url: content.location.href }));
    is(state.submitted, "", "The form was never submitted");
    is(state.clicked, "", "Place order was never pressed");
    is(state.url, FORM, "The page never navigated");
    await WhimsyChat.close(window, { reason: "hide" });
  });
});
