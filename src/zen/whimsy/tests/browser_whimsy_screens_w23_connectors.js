/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

requestLongerTimeout(5);

// W23 connectors: shots of Settings › AI › Connectors (07 set-5.x,
// fu-settings 5.6) and onboarding's AI steps (01 onb-x.y) for side-by-side
// checks. WHIMSY_SHOTS=<dir> writes w23-connectors-*.png.

const { WhimsyConnectors } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyConnectors.sys.mjs");
const { WhimsyAIOnboarding } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIOnboarding.sys.mjs");

const real = { check: WhimsyConnectors.check, appleAvailable: WhimsyAIOnboarding.appleAvailable, connectProvider: WhimsyAIOnboarding.connectProvider };

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["whimsy.feature.ai-hints", false],
      ["whimsy.ai.enabled", true],
      ["whimsy.connectors.google.client-id", "shots.apps"],
      ["whimsy.connectors.microsoft.client-id", "shots-app-id"],
      ["whimsy.ai.onboarding.celebrated", false],
    ],
  });
  await WhimsyConnectors._resetForTest();
  await WhimsyConnectors._update(file => {
    file.connectors.google = { account: "ethan@example.com", scopes: { gmail: true, calendar: true, drive: true }, status: "ok" };
    file.connectors.granola = { url: "https://mcp.granola.ai/mcp", tools: ["search_meetings"], status: "ok" };
    file.connectors.linear = { account: "", status: "expired" };
    file.connectors["mcp:mcp.notion.com"] = { url: "https://mcp.notion.com/mcp", name: "Notion", tools: Array.from({ length: 14 }, (_, i) => `tool_${i}`), status: "ok" };
  });
  WhimsyConnectors.check = async url => {
    if (url.includes("workspace")) {
      throw Object.assign(new Error("x"), { code: "not-mcp" });
    }
    return { url, name: "Notion", tools: [], signIn: true };
  };
  registerCleanupFunction(async () => {
    Object.assign(WhimsyConnectors, { check: real.check });
    Object.assign(WhimsyAIOnboarding, { appleAvailable: real.appleAvailable, connectProvider: real.connectProvider, instant: false });
    await WhimsyConnectors._resetForTest();
    document.getElementById("zen-welcome")?.remove();
  });
});

async function openConnectors() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:preferences#whimsyAI");
  const win = tab.linkedBrowser.contentWindow;
  const doc = win.document;
  await TestUtils.waitForCondition(() => doc.getElementById("whimsyConnectorsList")?.dataset.ready == "true", "Connectors shows");
  win.WhimsyAISettings.jumpTo("connectors");
  await new Promise(r => win.setTimeout(r, 400));
  return { tab, win, doc, S: win.WhimsyAISettings, row: id => doc.querySelector(`.whimsy-ai-item[data-connector="${id}"]`) };
}

add_task(async function settings_states() {
  for (const [state, prepare] of [
    ["set-5.1", () => {}],
    ["set-5.2", page => page.row("google").querySelector(".whimsy-ai-chev").click()],
    ["set-5.3", async page => {
      page.row("google").querySelector(".whimsy-ai-chev").click();
      (await TestUtils.waitForCondition(() => page.doc.querySelector('[data-action="disconnect"]'))).click();
    }],
    ["set-5.4", page => page.S.openSheet("connector-scopes", { connector: "microsoft" })],
    ["fu-settings-5.6", page => page.S.openSheet("connector-mcp")],
    ["set-5.8", async page => {
      page.S.openSheet("connector-mcp");
      page.doc.getElementById("whimsyConnectorsMcpUrl").value = "https://mcp.notion.com/mcp";
      page.doc.getElementById("whimsyConnectorsMcpUrl").dispatchEvent(new page.win.Event("input"));
      page.doc.getElementById("whimsyConnectorsMcpGo").click();
      await TestUtils.waitForCondition(() => page.doc.getElementById("whimsyConnectorsMcpFound"));
    }],
    ["set-5.9", async page => {
      page.S.openSheet("connector-mcp");
      page.doc.getElementById("whimsyConnectorsMcpUrl").value = "https://notion.so/my-workspace";
      page.doc.getElementById("whimsyConnectorsMcpUrl").dispatchEvent(new page.win.Event("input"));
      page.doc.getElementById("whimsyConnectorsMcpGo").click();
      await TestUtils.waitForCondition(() => page.doc.getElementById("whimsyConnectorsMcpError"));
    }],
  ]) {
    await whimsyBothSchemes(`w23-connectors-${state}`, async () => {
      const page = await openConnectors();
      await prepare(page);
      await whimsySettled(page.doc);
      ok(page.doc.getElementById("whimsyConnectorsList")?.dataset.ready == "true", `${state}: the connectors list is ready`);
      return () => {
        page.S.closeSheet({ restore: false });
        BrowserTestUtils.removeTab(page.tab);
      };
    });
  }
});

// set-5.4, about a third into its open animation (openSheet()'s 160ms
// opacity/scale spring).
add_task(async function settings_scopes_sheet_mid() {
  const page = await openConnectors();
  try {
    page.S.openSheet("connector-scopes", { connector: "microsoft" });
    await whimsyShotMid("w23-connectors-set-5.4-opening", () => page.S._sheet?.animation, 50);
    ok(true, "set-5.4-opening: shot captured");
  } finally {
    page.S.closeSheet({ restore: false });
    BrowserTestUtils.removeTab(page.tab);
  }
});

function shell() {
  document.getElementById("zen-welcome")?.remove();
  const el = (tag, id, parent, cls) => {
    const node = document.createElementNS("http://www.w3.org/1999/xhtml", tag);
    if (id) {
      node.id = id;
    }
    if (cls) {
      node.className = cls;
    }
    parent?.append(node);
    return node;
  };
  const root = el("div", "zen-welcome");
  root.style.cssText = "position:fixed;inset:0;z-index:1000;display:grid;place-items:center;background:light-dark(#e8e8f0,#1c1c22)";
  const pages = el("div", "zen-welcome-pages", root);
  pages.style.cssText = "display:flex;opacity:1;width:86%;height:82%;border-radius:1.4rem;overflow:hidden;background:light-dark(#fff,#1c1c1e)";
  const side = el("div", "zen-welcome-page-sidebar", pages);
  side.style.cssText = "width:38%;padding:4rem;box-sizing:border-box;display:flex;flex-direction:column;justify-content:flex-end";
  el("button", null, el("div", "zen-welcome-page-sidebar-buttons", side), "zen-big-accent-button");
  const content = el("div", "zen-welcome-page-content", pages);
  content.style.cssText = "flex:1;display:flex;background:light-dark(#f4f4f6,#232327)";
  // Zen's intro animation is what reveals the pages and each page; without
  // it they stay at opacity 0, which paints nothing and takes no clicks.
  // Zen's own #zen-welcome is a child of #browser (ZenWelcome.mjs); a copy
  // appended straight to <window> falls outside that box's layout and never
  // paints, leaving the shot blank.
  document.getElementById("browser").append(root);
  return content;
}

async function renderPage(page) {
  const host = shell();
  const content = document.createElementNS("http://www.w3.org/1999/xhtml", "div");
  content.className = "zen-welcome-page";
  content.setAttribute("page", page.id);
  content.style.opacity = "1";
  host.append(content);
  await page.render(content, { next() {} });
  return content;
}

add_task(async function onboarding_states() {
  WhimsyAIOnboarding.appleAvailable = async () => true;
  WhimsyAIOnboarding.connectProvider = () => new Promise(() => {});
  for (const [state, prepare] of [
    ["onb-1.1", async () => renderPage(WhimsyAIOnboarding.pages(window)[0])],
    ["onb-1.8", async () => {
      const content = await renderPage(WhimsyAIOnboarding.pages(window)[0]);
      EventUtils.synthesizeMouseAtCenter(content.querySelector('[data-id="claude"] [data-action="connect"]'), {}, window);
    }],
    ["onb-2.1", async () => {
      const [, connect] = WhimsyAIOnboarding.pages(window);
      WhimsyAIOnboarding.session.providers.add("claude");
      await renderPage(connect);
    }],
    ["onb-2.2", async () => {
      const [, connect] = WhimsyAIOnboarding.pages(window);
      WhimsyAIOnboarding.session.providers.add("claude");
      const content = await renderPage(connect);
      EventUtils.synthesizeMouseAtCenter(content.querySelector('[data-id="microsoft"] [data-action="connect"]'), {}, window);
    }],
    ["onb-5.1", async () => {
      WhimsyAIOnboarding.pages(window);
      WhimsyAIOnboarding.session.providers.add("claude");
      WhimsyAIOnboarding.session.providers.add("openai");
      WhimsyAIOnboarding.session.services.add("google");
      WhimsyAIOnboarding.session.services.add("linear");
      shell();
      WhimsyAIOnboarding.celebrate(window, () => {});
    }],
  ]) {
    await whimsyBothSchemes(`w23-connectors-${state}`, async () => {
      await prepare();
      ok(document.getElementById("browser")?.contains(document.getElementById("zen-welcome")), `${state}: the welcome shell is inside #browser, not blank`);
      return () => {
        WhimsyAIOnboarding.cancelBusy();
        WhimsyAIOnboarding.celebration?.overlay.remove();
        document.getElementById("zen-welcome")?.remove();
      };
    });
  }
  // onb-5.2: the celebration about 400ms in.
  WhimsyAIOnboarding.pages(window);
  WhimsyAIOnboarding.session.providers.add("claude");
  WhimsyAIOnboarding.session.services.add("google");
  shell();
  WhimsyAIOnboarding.celebrate(window, () => {});
  await whimsyShotMid("w23-connectors-onb-5.2", () => WhimsyAIOnboarding.celebration?.animations[2], 400);
  ok(true, "onb-5.2: shot captured");
  WhimsyAIOnboarding.celebration?.overlay.remove();
  document.getElementById("zen-welcome")?.remove();
});

// A card's failure note, about halfway through its 300ms unfold
// (`ui.unfold` in WhimsyAIOnboarding._card.set()).
add_task(async function onb_card_failure_unfold_mid() {
  WhimsyAIOnboarding.appleAvailable = async () => true;
  const prevConnect = WhimsyAIOnboarding.connectProvider;
  WhimsyAIOnboarding.connectProvider = () => Promise.reject(Object.assign(new Error("x"), { code: "sign-in-failed" }));
  try {
    const content = await renderPage(WhimsyAIOnboarding.pages(window)[0]);
    EventUtils.synthesizeMouseAtCenter(content.querySelector('[data-id="openai"] [data-action="connect"]'), {}, window);
    await whimsyShotMid("w23-connectors-onb-card-fail", () => content.querySelector('[data-id="openai"] .whimsy-onb-note')?.getAnimations()[0], 150);
    ok(content.querySelector('[data-id="openai"]').dataset.state == "failed", "onb-card-fail: the card reached the failed state");
  } finally {
    WhimsyAIOnboarding.connectProvider = prevConnect;
    WhimsyAIOnboarding.cancelBusy();
    document.getElementById("zen-welcome")?.remove();
  }
});
