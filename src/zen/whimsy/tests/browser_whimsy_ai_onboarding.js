/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W23 connectors: onboarding's AI steps. The pages render into a stand-in
// for Zen's welcome sidebar and content (same ids), with sign-ins replaced.

const { WhimsyAIOnboarding } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIOnboarding.sys.mjs");
const { WhimsyWelcome } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyWelcome.sys.mjs");

const real = { appleAvailable: WhimsyAIOnboarding.appleAvailable, connectProvider: WhimsyAIOnboarding.connectProvider, connectConnector: WhimsyAIOnboarding.connectConnector };
let apple = true;
let held = new Map();

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.ai.onboarding.celebrated", false], ["whimsy.feature.ai-connectors", true]] });
  WhimsyAIOnboarding.instant = true;
  WhimsyAIOnboarding.appleAvailable = async () => apple;
  // Each sign-in waits until the test settles it.
  const hold = id => new Promise((resolve, reject) => held.set(id, { resolve, reject }));
  WhimsyAIOnboarding.connectProvider = async (win, id, pending) => {
    const promise = hold(id);
    pending.cancel = () => held.get(id)?.reject(Object.assign(new Error("x"), { code: "cancelled" }));
    return promise;
  };
  WhimsyAIOnboarding.connectConnector = (win, id) => hold(id);
  registerCleanupFunction(() => {
    Object.assign(WhimsyAIOnboarding, real, { instant: false });
    stage?.remove();
  });
});

let stage = null;

// Zen's welcome shell: sidebar buttons and the content column.
function shell() {
  stage?.remove();
  const doc = document;
  const el = (tag, id, parent) => {
    const node = doc.createElementNS("http://www.w3.org/1999/xhtml", tag);
    if (id) {
      node.id = id;
    }
    parent?.append(node);
    return node;
  };
  stage = el("div", "zen-welcome");
  const pages = el("div", "zen-welcome-pages", stage);
  const side = el("div", "zen-welcome-page-sidebar", pages);
  const buttons = el("div", "zen-welcome-page-sidebar-buttons", side);
  el("button", null, buttons).className = "zen-big-accent-button";
  el("div", "zen-welcome-page-content", pages);
  doc.documentElement.append(stage);
  return stage;
}

async function render(page) {
  shell();
  const content = document.createElementNS("http://www.w3.org/1999/xhtml", "div");
  content.className = "zen-welcome-page";
  content.setAttribute("page", page.id);
  document.getElementById("zen-welcome-page-content").append(content);
  const button = document.querySelector("#zen-welcome-page-sidebar-buttons > button");
  const pages = { nexts: 0, next() { this.nexts++; } };
  button.addEventListener("click", () => page.buttons[0].onclick(pages) !== false && pages.next());
  await page.render(content, pages);
  return { content, button, pages, card: id => content.querySelector(`.whimsy-onb-card[data-id="${id}"]`) };
}

const bottomId = () => document.querySelector("#zen-welcome-page-sidebar-buttons > button").getAttribute("data-l10n-id");

add_task(async function hook_splices_after_block_ads() {
  const pages = WhimsyWelcome.extendPages(window, [{ id: "search" }, { id: "block-ads" }, { id: "essentials" }, { id: "finish" }], {});
  const ids = pages.map(p => p.id);
  is(ids.indexOf("whimsy-ai-providers"), ids.indexOf("block-ads") + 1, "Screen 1 comes right after Block ads");
  is(ids.indexOf("whimsy-ai-connect"), ids.indexOf("whimsy-ai-providers") + 1, "then screen 2, before Essentials");
});

add_task(async function apple_card_only_when_available() {
  apple = false;
  let [providers] = WhimsyAIOnboarding.pages(window);
  let view = await render(providers);
  ok(!view.card("apple"), "No Apple Intelligence on this Mac: no card, not a greyed one");
  ok(view.card("claude") && view.card("openai"), "Claude and ChatGPT show");
  apple = true;
  [providers] = WhimsyAIOnboarding.pages(window);
  view = await render(providers);
  is(view.content.querySelector(".whimsy-onb-card").dataset.id, "apple", "With it, Apple Intelligence leads");
});

add_task(async function skip_for_now_becomes_continue() {
  const [providers] = WhimsyAIOnboarding.pages(window);
  const view = await render(providers);
  is(bottomId(), "whimsy-onb-skip", "Skip for now until something connects");
  EventUtils.synthesizeMouseAtCenter(view.card("openai").querySelector('[data-action="connect"]'), {}, window);
  held.get("openai").resolve();
  await TestUtils.waitForCondition(() => view.card("openai").dataset.state == "done", "ChatGPT connects");
  is(bottomId(), "whimsy-onb-continue", "then Continue");
  ok(document.getElementById("whimsy-onb-status")?.textContent || document.getElementById("whimsy-onb-status")?.children.length, "The line above it says what's ready");
});

add_task(async function one_sign_in_at_a_time() {
  const [providers] = WhimsyAIOnboarding.pages(window);
  const view = await render(providers);
  view.card("claude").querySelector('[data-action="connect"]').click();
  await TestUtils.waitForCondition(() => view.card("claude").dataset.state == "busy", "Claude signs in");
  ok(view.card("openai").querySelector('[data-action="connect"]').disabled, "The other cards wait");
  const cancel = view.card("claude").querySelector('[data-action="cancel"]');
  ok(cancel, "Cancel is on the busy card");
  cancel.click();
  await TestUtils.waitForCondition(() => view.card("claude").dataset.state == "idle", "Cancel stops it");
  ok(!view.card("openai").querySelector('[data-action="connect"]').disabled, "and the others are back");
});

add_task(async function failure_one_line_try_again() {
  const [providers] = WhimsyAIOnboarding.pages(window);
  const view = await render(providers);
  view.card("openai").querySelector('[data-action="connect"]').click();
  held.get("openai").reject(Object.assign(new Error("closed"), { code: "sign-in-cancelled-by-page" }));
  await TestUtils.waitForCondition(() => view.card("openai").dataset.state == "failed", "The sign-in failed");
  const note = view.card("openai").querySelector(".whimsy-onb-note");
  is(note.querySelectorAll("button").length, 1, "One line with Try again");
  is(view.card("claude").dataset.state, "idle", "Other cards are unaffected");
});

add_task(async function screen_two_skipped_without_provider() {
  const [, connect] = WhimsyAIOnboarding.pages(window);
  ok(connect.skip(), "Nothing connected on screen 1: screen 2 is skipped");
  WhimsyAIOnboarding.session.providers.add("claude");
  ok(!connect.skip(), "With a provider it shows");
});

add_task(async function celebration_once_and_waits() {
  const [providers, connect] = WhimsyAIOnboarding.pages(window);
  WhimsyAIOnboarding.session.providers.add("claude");
  await render(providers);
  const view = await render(connect);
  view.card("linear").querySelector('[data-action="connect"]').click();
  held.get("linear").resolve();
  await TestUtils.waitForCondition(() => view.card("linear").dataset.state == "done", "Linear connects");
  view.button.click();
  const overlay = await TestUtils.waitForCondition(() => document.getElementById("whimsy-onb-done"), "You're all set plays");
  is(view.pages.nexts, 0, "It waits");
  EventUtils.synthesizeKey("KEY_Enter");
  await TestUtils.waitForCondition(() => !overlay.isConnected, "Return moves on");
  is(view.pages.nexts, 1, "to the next page");
  ok(Services.prefs.getBoolPref("whimsy.ai.onboarding.celebrated"), "It played once");
  view.button.click();
  ok(!document.getElementById("whimsy-onb-done"), "Never twice");
});
