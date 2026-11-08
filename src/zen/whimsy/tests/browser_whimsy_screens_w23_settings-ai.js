/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

requestLongerTimeout(5);

// W23 settings-ai: shots of Settings › AI for side-by-side checks against
// the mockups (07-settings set-x.y, followup/fu-settings). WHIMSY_SHOTS=<dir>
// writes w23-settings-ai-*.png.

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
  "whimsy.ai.claude.model",
  "whimsy.ai.claude.auth",
  "whimsy.ai.openai.auth",
  "whimsy.ai.ollama.model",
  "whimsy.ai.ollama.endpoint",
  "whimsy.feature.ai-claude-plan",
  "whimsy.feature.ai-openai-plan",
];
const saved = new Map(
  TOUCHED.map(name => {
    const type = Services.prefs.getPrefType(name);
    return [name, Services.prefs.prefHasUserValue(name) ? { type, value: whimsyReadPref(name, type) } : null];
  })
);
const savedEndpoints = { ...ENDPOINTS };
const real = {
  connection: WhimsyAIProviders.connection,
  keyHint: WhimsyAIProviders.keyHint,
  connectPlan: WhimsyAIProviders.connectPlan,
  authStatus: WhimsyAIClaudeCode._authStatus,
  install: WhimsyClaudeCodeInstall.install,
  byWhimsy: WhimsyClaudeCodeInstall.installedByWhimsy,
  claudePlan: WhimsyAIProviders._plans.claude,
};
let server = null;
let base = "";
let accept = true;
let claudeCode = { installed: true, loggedIn: true, email: "" };
let connections = {};
let held = null;

function restorePrefs() {
  for (const [name, was] of saved) {
    if (was) {
      whimsyWritePref(name, was.type, was.value);
    } else {
      Services.prefs.clearUserPref(name);
    }
  }
}

const FULL = {
  apple: { method: "local" },
  claude: { method: "plan", label: "Max" },
  openai: { method: "plan", label: "Plus" },
  gemini: { method: "key" },
  ollama: { method: "local" },
};

function setup({ on = true, order = "apple,claude,openai,gemini", off = "" } = {}) {
  restorePrefs();
  Services.prefs.setBoolPref("whimsy.feature.ai-claude-plan", true);
  Services.prefs.setBoolPref("whimsy.feature.ai-openai-plan", true);
  Services.prefs.setStringPref("whimsy.ai.order", order);
  Services.prefs.setBoolPref("whimsy.ai.enabled", on);
  if (off) {
    Services.prefs.setStringPref("whimsy.ai.off", off);
  }
  connections = Object.fromEntries(order.split(",").filter(Boolean).map(id => [id, FULL[id]]));
  claudeCode = { installed: true, loggedIn: true, email: "" };
}

add_setup(async function () {
  OSKeyStoreTestUtils.setup();
  server = new HttpServer();
  server.start(-1);
  base = `http://localhost:${server.identity.primaryPort}`;
  Object.assign(ENDPOINTS, { openai: `${base}/openai`, gemini: `${base}/gemini` });
  server.registerPrefixHandler("/openai/", (request, response) => {
    response.setStatusLine(request.httpVersion, accept ? 200 : 401, "x");
    response.setHeader("content-type", "application/json");
    response.write(JSON.stringify(accept ? { data: [{ id: "gpt-test" }] } : { error: { message: "Incorrect API key provided" } }));
  });
  server.registerPathHandler("/ollama/api/tags", (request, response) => {
    response.setHeader("content-type", "application/json");
    response.write(JSON.stringify({ models: [{ name: "llama3.2:3b", size: 2.0e9 }, { name: "qwen2.5vl:7b", size: 6.0e9 }, { name: "deepseek-r1:8b", size: 4.9e9 }] }));
  });
  server.registerPathHandler("/ollama/api/show", (request, response) => {
    const body = JSON.parse(NetUtil.readInputStreamToString(request.bodyInputStream, request.bodyInputStream.available()));
    const caps = { "llama3.2:3b": ["completion", "tools"], "qwen2.5vl:7b": ["completion", "vision"], "deepseek-r1:8b": ["completion", "thinking"] }[body.model];
    response.setHeader("content-type", "application/json");
    response.write(JSON.stringify({ capabilities: caps }));
  });
  WhimsyAIProviders.connection = async id => {
    if (held) {
      await held.promise;
    }
    return connections[id] ?? null;
  };
  WhimsyAIProviders.keyHint = async id => (id == "gemini" ? "4f2a" : "");
  WhimsyAIClaudeCode._authStatus = async () => ({ ...claudeCode });
  WhimsyClaudeCodeInstall.installedByWhimsy = async () => true;
  const outer = { width: window.outerWidth, height: window.outerHeight };
  await resizeTo(1280, 800);
  registerCleanupFunction(async () => {
    held?.resolve();
    WhimsyAIProviders.connection = real.connection;
    WhimsyAIProviders.keyHint = real.keyHint;
    WhimsyAIProviders.connectPlan = real.connectPlan;
    WhimsyAIClaudeCode._authStatus = real.authStatus;
    WhimsyAIClaudeCode._status = null;
    WhimsyClaudeCodeInstall.install = real.install;
    WhimsyClaudeCodeInstall.installedByWhimsy = real.byWhimsy;
    WhimsyAIProviders.registerPlan("claude", real.claudePlan);
    Object.assign(ENDPOINTS, savedEndpoints);
    for (const id of ["openai", "gemini", "claude"]) {
      await WhimsyAIProviders.setKey(id, "");
    }
    for (const id of ["apple", "claude", "openai", "gemini", "ollama"]) {
      WhimsyAIProviders.clearResting(id);
    }
    restorePrefs();
    await resizeTo(outer.width, outer.height);
    await OSKeyStoreTestUtils.cleanup();
    await new Promise(r => server.stop(r));
  });
});

async function resizeTo(width, height) {
  window.resizeTo(width, height);
  await TestUtils.waitForCondition(() => window.outerWidth == width && window.outerHeight == height, `The window is ${width}×${height}`).catch(() =>
    info(`The window stayed ${window.outerWidth}×${window.outerHeight}`)
  );
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
}

async function openAI() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:preferences#whimsyAI");
  const win = tab.linkedBrowser.contentWindow;
  const doc = win.document;
  await TestUtils.waitForCondition(() => win.WhimsyAISettings?.root && doc.getElementById("whimsyAIPage")?.checkVisibility(), "Settings › AI shows");
  const $ = id => doc.getElementById(id);
  const page = { tab, win, doc, $, S: win.WhimsyAISettings, unfolds: [] };
  const unfold = page.S.unfold;
  page.S.unfold = node => {
    const animation = unfold.call(page.S, node);
    page.unfolds.push(animation);
    return animation;
  };
  return page;
}

async function done(page) {
  page.S.closeSheet({ restore: false });
  BrowserTestUtils.removeTab(page.tab);
  closeToasts();
}

const visible = node => !!node?.checkVisibility();
const row = (page, id) => page.doc.querySelector(`#whimsyAIProviderList .whimsy-ai-item[data-provider="${id}"]`);
const click = (page, node) => EventUtils.synthesizeMouseAtCenter(node, {}, page.win);

async function settled(page) {
  for (let i = 0; i < 3; i++) {
    const running = page.doc.getAnimations().filter(a => a.playState == "running" && a.effect?.getComputedTiming().iterations != Infinity);
    await Promise.all(running.map(a => a.finished.catch(() => {})));
    await page.doc.l10n.translateFragment(page.doc.documentElement);
    await new Promise(r => page.win.requestAnimationFrame(() => page.win.requestAnimationFrame(r)));
  }
}

async function atProviders(page) {
  const section = await TestUtils.waitForCondition(() => visible(page.$("whimsyAISection-providers")) && page.$("whimsyAISection-providers"), "Providers shows");
  section.scrollIntoView({ block: "start", behavior: "instant" });
  await new Promise(r => page.win.requestAnimationFrame(() => page.win.requestAnimationFrame(r)));
}

async function listReady(page) {
  await TestUtils.waitForCondition(() => page.$("whimsyAIProviderList")?.dataset.ready == "true", "The providers list has its details");
}

async function sheet(page, id) {
  return TestUtils.waitForCondition(() => {
    const node = page.$("whimsyAISheet");
    return node?.dataset.sheet == id && visible(node) && node;
  }, `The ${id} sheet opens`);
}

async function toastShown(id) {
  const toast = await TestUtils.waitForCondition(() => toastFor(id), `${id} shows`);
  await toast.shown;
  await document.l10n.translateFragment(toast.element);
}

function shoot(state, prepare, { opts = {} } = {}) {
  return whimsyBothSchemes(`w23-settings-ai-${state}`, async dark => {
    setup(opts);
    if (opts.hold) {
      held = Promise.withResolvers();
    }
    const page = await openAI();
    let extra = null;
    try {
      if (opts.on !== false && !opts.top) {
        await atProviders(page);
      }
      extra = await prepare(page, dark);
      await settled(page);
      ok(visible(page.$("whimsyAIPage")), `${state} (${dark ? "dark" : "light"}) is ready`);
    } catch (e) {
      await done(page);
      throw e;
    }
    return async () => {
      if (typeof extra == "function") {
        await extra();
      }
      held?.resolve();
      held = null;
      await done(page);
    };
  });
}

async function mid(state, ms, start, getAnimation) {
  setup();
  const page = await openAI();
  await atProviders(page);
  await listReady(page);
  await settled(page);
  page.unfolds = [];
  await start(page);
  await whimsyShotMid(`w23-settings-ai-${state}`, () => getAnimation(page), ms);
  ok(true, `${state} at ${ms}ms`);
  await settled(page);
  await done(page);
}

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
    await TestUtils.waitForCondition(() => page.$("whimsyAIModelMenu"), "The model menu opens");
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
  });
  await shoot("set-4.2", listReady, { opts: { off: "gemini" } });
});

add_task(async function shots_sheets() {
  const open = (id, opts) => async page => {
    await listReady(page);
    page.S.openSheet(id, opts);
    return sheet(page, id);
  };
  await shoot("set-3.1", async page => {
    await open("add-provider")(page);
    await TestUtils.waitForCondition(() => page.doc.querySelectorAll("#whimsyAISheet .whimsy-ai-choice").length >= 4, "The choices show");
  });
  await shoot("set-3.2", async page => {
    await open("claude")(page);
    await TestUtils.waitForCondition(() => page.$("whimsyAIClaudeSignIn"), "Connect shows");
  });
  await shoot("set-3.5", async page => {
    claudeCode = { installed: true, loggedIn: false, email: "" };
    await open("claude")(page);
    await TestUtils.waitForCondition(() => page.$("whimsyAIClaudeSignIn"), "Sign in shows");
  });
  await shoot("fu-3.4-consent", async page => {
    claudeCode = { installed: false, loggedIn: false, email: "" };
    await open("claude")(page);
    await TestUtils.waitForCondition(() => page.$("whimsyAIClaudeInstall"), "Install shows");
  });
  await shoot("set-3.6", open("claude", { method: "key" }));
  await shoot("set-3.13", open("gemini"));
  await shoot("set-3.12", async page => {
    accept = false;
    await open("openai", { method: "key" })(page);
    const field = page.$("whimsyAIKeyField");
    field.focus();
    EventUtils.sendString("sk-" + "proj-" + "test0000000000000000wxyz", page.win);
    click(page, page.$("whimsyAIKeyConnect"));
    await TestUtils.waitForCondition(() => visible(page.$("whimsyAIKeyError")), "Rejected");
    return () => (accept = true);
  });
  await shoot("set-3.10", async page => {
    WhimsyAIProviders.connectPlan = async () => ({ welcome: true });
    await open("openai")(page);
    click(page, page.$("whimsyAIOpenAIContinue"));
    await TestUtils.waitForCondition(() => page.$("whimsyAIOpenAIDone"), "Welcome");
    closeToasts();
    return () => (WhimsyAIProviders.connectPlan = real.connectPlan);
  });
  await shoot("set-3.11", async page => {
    WhimsyAIProviders.connectPlan = async () => {
      throw Object.assign(new Error("ineligible"), { code: "plan-ineligible" });
    };
    await open("openai")(page);
    click(page, page.$("whimsyAIOpenAIContinue"));
    await TestUtils.waitForCondition(() => page.doc.querySelector("#whimsyAISheet .whimsy-ai-note[data-tone=fail]"), "Can't be used");
    return () => (WhimsyAIProviders.connectPlan = real.connectPlan);
  });
  const realDetails = WhimsyAIProviders.ollamaModelDetails;
  await shoot("set-3.14", async page => {
    const wait = Promise.withResolvers();
    WhimsyAIProviders.ollamaModelDetails = () => wait.promise;
    await open("ollama")(page);
    return () => {
      WhimsyAIProviders.ollamaModelDetails = realDetails;
      wait.resolve([]);
    };
  });
  await shoot("set-3.15", async page => {
    Services.prefs.setStringPref("whimsy.ai.ollama.endpoint", `${base}/ollama`);
    await open("ollama")(page);
    await TestUtils.waitForCondition(() => page.$("whimsyAIOllamaDone"), "Models found");
  });
  await shoot("set-3.16", async page => {
    Services.prefs.setStringPref("whimsy.ai.ollama.endpoint", "http://127.0.0.1:1");
    await open("ollama")(page);
    await TestUtils.waitForCondition(() => page.doc.querySelector("#whimsyAISheet .whimsy-ai-note[data-tone=fail]"), "Not running");
  });
});

add_task(async function shots_install_steps() {
  let finish;
  const paused = new Promise(r => (finish = r));
  WhimsyClaudeCodeInstall.install = async ({ onStep }) => {
    for (const step of ["fetch", "signature", "download", "hash"]) {
      onStep(step);
    }
    await paused;
    throw Object.assign(new Error("stopped"), { code: "test" });
  };
  setup();
  claudeCode = { installed: false, loggedIn: false, email: "" };
  const page = await openAI();
  page.S.openSheet("claude");
  await sheet(page, "claude");
  const install = await TestUtils.waitForCondition(() => page.$("whimsyAIClaudeInstall"), "Install shows");
  await settled(page);
  click(page, install);
  await TestUtils.waitForCondition(() => page.$("whimsyAIInstallSteps")?.querySelector('[data-step="check"]')?.dataset.state == "busy", "Checking");
  await whimsyBothSchemes("w23-settings-ai-fu-3.4-steps", async () => {
    page.S.closeSheet({ restore: false });
    page.S.openSheet("claude");
    await sheet(page, "claude");
    await TestUtils.waitForCondition(() => page.$("whimsyAIInstallSteps"), "The steps show");
    await settled(page);
    return () => page.S.closeSheet({ restore: false });
  });
  await TestUtils.waitForCondition(() => !page.S.sheet, "The sheet is closed");
  finish();
  await TestUtils.waitForCondition(() => toastFor("whimsy-ai-toast-claude-code-failed"), "The stopped install says so");
  WhimsyClaudeCodeInstall.install = real.install;
  await done(page);
  restorePrefs();
});

add_task(async function shots_narrow() {
  await resizeTo(860, 800);
  try {
    await shoot("set-N.1", listReady);
  } finally {
    await resizeTo(1280, 800);
  }
});

add_task(async function shots_mid_animation() {
  await mid("sheet-open", 80, page => page.S.openSheet("add-provider"), page => page.S.sheet?.animation);
  await mid("confirm-unfold", 150, page => click(page, page.$("whimsyAIEnable").buttonEl), page => page.unfolds.at(-1));
  await mid("row-expand", 150, page => click(page, row(page, "claude").querySelector("[data-action=details]")), page => page.unfolds.at(-1));
  await mid("ai-off-fade", 90, async page => {
    page.S.fading = null;
    click(page, page.$("whimsyAIEnable").buttonEl);
    const strip = await TestUtils.waitForCondition(() => page.$("whimsyAIConfirmSlot").querySelector(".whimsy-ai-confirm"), "Turn off AI? asks");
    await settled(page);
    click(page, strip.querySelector("[data-action=confirm]"));
  }, page => page.S.fading);
  restorePrefs();
});
