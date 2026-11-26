/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W23 settings-ai: what browser_whimsy_screens_w23_settings-ai*.js share.
// Shots of Settings › AI for side-by-side checks against the mockups
// (07-settings set-x.y, followup/fu-settings). WHIMSY_SHOTS=<dir> writes
// w23-settings-ai-*.png.

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
  // Discovery hints would land in the shots. head.js puts their counts back;
  // a pref env here would re-apply one a hint wrote just before it.
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.ai-hints", false]] });
  ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIHints.sys.mjs").WhimsyAIHints._settleForTesting();
  closeToasts();
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
