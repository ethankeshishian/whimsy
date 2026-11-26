/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Settings › AI shots, part 1: the off cards, the header, and the
// providers list. Each shot opens Settings in a tab of its own, in both
// schemes: 50s on its own. The shots were one file until W31, when it ran
// 4 times slower late in the full run and timed out (428s, past 8 × 45s).
requestLongerTimeout(6);

Services.scriptloader.loadSubScript(getRootDirectory(gTestPath) + "head_settings_ai.js", this);

add_task(async function shots_off() {
  await shoot("set-1.1", async page => {
    await TestUtils.waitForCondition(() => page.$("whimsyAIOffCard").dataset.kind == "setup" && visible(page.$("whimsyAIOffCard")), "The set-up card");
  }, { opts: { on: false, order: "" } });
  await shoot("set-1.3", async page => {
    await listReady(page);
    page.S.toast("whimsy-ai-toast-connected", { args: { provider: "Gemini" }, descriptionId: "whimsy-ai-toast-ai-on" });
    await toastShown("whimsy-ai-toast-connected");
  }, { opts: { order: "gemini", top: true } });
  await shoot("set-1.4", async page => {
    await TestUtils.waitForCondition(() => page.$("whimsyAIOffCard").dataset.kind == "kept" && visible(page.$("whimsyAIOffCard")), "The kept card");
  }, { opts: { on: false, order: "claude,gemini" } });
});

add_task(async function shots_header_and_features() {
  await shoot("fu-10.1", async page => {
    await listReady(page);
    page.S.jumpTo("features");
    await TestUtils.waitForCondition(() => page.$("whimsyAIJump").querySelector('[aria-current="true"]')?.dataset.section == "features", "Features is marked");
    await new Promise(r => setTimeout(r, 800));
  });
  await shoot("fu-10.2", async page => {
    await listReady(page);
    click(page, page.$("whimsyAIEnable").buttonEl);
    await TestUtils.waitForCondition(() => page.$("whimsyAIConfirmSlot").querySelector(".whimsy-ai-confirm"), "Turn off AI? asks");
  }, { opts: { top: true } });
  await shoot("dec-15", listReady, { opts: { top: true, order: "apple,openai" } });
  // dec-9: Firefox's chatbot, link previews, and Suggest tab groups are gone;
  // Features holds Whimsy's own link previews and Tidy Tabs.
  await shoot("dec-9", async page => {
    await listReady(page);
    page.S.jumpTo("features");
    await TestUtils.waitForCondition(() => page.$("whimsyAIJump").querySelector('[aria-current="true"]')?.dataset.section == "features", "Features is marked");
    await new Promise(r => setTimeout(r, 800));
    const doc = page.$("whimsyAIPage").ownerDocument;
    const firefox = [...doc.querySelectorAll('[data-category="paneWhimsyAI"] [preference], #whimsyAIPage [preference]')]
      .map(node => node.getAttribute("preference"))
      .filter(pref => /^browser\.(ml\.|tabs\.groups\.smart)/.test(pref));
    Assert.deepEqual(firefox, [], "No Firefox chatbot, link preview, or tab group suggestion controls");
    ok(visible(page.$("whimsyAITidyTabs")), "Whimsy's own versions show");
  });
});

add_task(async function shots_list() {
  await shoot("set-2.0", async page => {
    await TestUtils.waitForCondition(() => row(page, "gemini"), "Rows show");
  }, { opts: { hold: true } });
  await shoot("set-2.1", listReady);
  await shoot("set-2.2", async page => {
    await listReady(page);
    await settled(page);
    const grip = row(page, "claude").querySelector("[data-action=grip]");
    const from = grip.getBoundingClientRect();
    const top = row(page, "apple").getBoundingClientRect();
    const x = from.left + from.width / 2;
    EventUtils.synthesizeMouseAtPoint(x, from.top + from.height / 2, { type: "mousedown" }, page.win);
    await TestUtils.waitForCondition(() => row(page, "claude").classList.contains("is-lifted"), "The row lifts");
    for (const y of [from.top, top.bottom, top.top + top.height / 2 - 6]) {
      EventUtils.synthesizeMouseAtPoint(x, y, { type: "mousemove" }, page.win);
    }
    await TestUtils.waitForCondition(() => page.doc.querySelector(".whimsy-ai-slot")?.nextElementSibling == row(page, "apple"), "The slot is at the top");
    return () => EventUtils.synthesizeMouseAtPoint(x, from.top + from.height / 2, { type: "mouseup" }, page.win);
  });
  await shoot("set-2.3", async page => {
    await listReady(page);
    row(page, "claude").querySelector("[data-action=grip]").focus();
    EventUtils.synthesizeKey("KEY_ArrowUp", { altKey: true }, page.win);
    await TestUtils.waitForCondition(() => row(page, "claude") == page.doc.querySelector("#whimsyAIProviderList .whimsy-ai-item[data-provider]"), "Claude is first");
    await listReady(page);
    await TestUtils.waitForCondition(() => page.doc.activeElement?.dataset.action == "grip", "Its grip keeps focus");
  });
  await shoot("set-2.4", async page => {
    WhimsyAIProviders.setResting("claude", { until: new Date().setHours(16, 0, 0, 0) + 86400e3, message: "Your limit will reset at 4 PM" });
    await listReady(page);
    await TestUtils.waitForCondition(() => row(page, "claude").querySelector(".whimsy-ai-pill"), "Resting");
    return () => WhimsyAIProviders.clearResting("claude");
  });
  await shoot("set-2.5", async page => {
    await listReady(page);
    click(page, row(page, "claude").querySelector("[data-action=details]"));
    await TestUtils.waitForCondition(() => row(page, "claude").nextElementSibling?.classList.contains("whimsy-ai-body"), "Details open");
  });
  const realModels = WhimsyAIProviders.models;
  await shoot("set-2.6", async page => {
    WhimsyAIProviders.models = async () => ["claude-opus-4-1", "claude-sonnet-4-5", "claude-haiku-4-5"];
    await listReady(page);
    click(page, row(page, "claude").querySelector("[data-action=details]"));
    const body = await TestUtils.waitForCondition(() => row(page, "claude").nextElementSibling?.classList.contains("whimsy-ai-body") && row(page, "claude").nextElementSibling, "Details open");
    await settled(page);
    click(page, body.querySelector("[data-action=model]"));
    const menu = await TestUtils.waitForCondition(() => page.$("whimsyAIModelMenu"), "The model menu opens");
    const under = body.querySelector("[data-action=model]").getBoundingClientRect();
    const box = menu.getBoundingClientRect();
    ok(Math.abs(box.top - under.bottom - 4) < 2 && Math.abs(box.left - under.left) < 2, "It opens under its button");
    Assert.less(box.width, page.win.innerWidth / 2, "as a menu, not a full-width list");
    return () => (WhimsyAIProviders.models = realModels);
  });
  await shoot("set-2.7", async page => {
    await listReady(page);
    click(page, row(page, "openai").querySelector("[data-action=details]"));
    const body = await TestUtils.waitForCondition(() => row(page, "openai").nextElementSibling?.classList.contains("whimsy-ai-body") && row(page, "openai").nextElementSibling, "Details open");
    await settled(page);
    body.querySelector("[data-action=disconnect]").scrollIntoView({ block: "nearest", behavior: "instant" });
    click(page, body.querySelector("[data-action=disconnect]"));
    await TestUtils.waitForCondition(() => page.doc.querySelector("#whimsyAIProviderList .whimsy-ai-confirm"), "Disconnect asks");
  });
  await shoot("set-3.19", async page => {
    await listReady(page);
    await settled(page);
    connections.ollama = FULL.ollama;
    Services.prefs.setStringPref("whimsy.ai.ollama.model", "llama3.2:3b");
    Services.prefs.setStringPref("whimsy.ai.order", "apple,claude,openai,gemini,ollama");
    Services.obs.notifyObservers(null, "whimsy-ai-providers-changed", "connected");
    page.S.toast("whimsy-ai-toast-connected", { args: { provider: "Ollama" }, descriptionId: "whimsy-ai-toast-at-end" });
    await TestUtils.waitForCondition(() => row(page, "ollama"), "Ollama lands at the end");
    await toastShown("whimsy-ai-toast-connected");
  });
  await shoot("set-4.1", async page => {
    await listReady(page);
    click(page, page.$("whimsyAIHowButton"));
    await TestUtils.waitForCondition(() => visible(page.$("whimsyAIHowPicks")), "How Whimsy picks unfolds");
    ok(visible(page.$("whimsyAIHowPicks").querySelector(".whimsy-ai-how-excerpt")), "with what it looks like in chat");
  });
  await shoot("set-4.2", listReady, { opts: { off: "gemini" } });
});
