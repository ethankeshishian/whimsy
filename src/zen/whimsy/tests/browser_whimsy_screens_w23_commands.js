/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

requestLongerTimeout(4);

// W23 commands: shots of Settings › AI › Commands and the command sheet for
// side-by-side checks against 07-settings set-6.x and fu-settings 6.1, 6.2,
// and 6.7. WHIMSY_SHOTS=<dir> writes w23-commands-*.png.

const { WhimsyAICommands } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAICommands.sys.mjs");
const { WhimsyAIProviders } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIProviders.sys.mjs");

const TOUCHED = ["whimsy.ai.enabled", "whimsy.ai.order", "whimsy.ai.off", "whimsy.ai.quick-text-apple", "whimsy.verbs.skills"];
const saved = new Map(
  TOUCHED.map(name => {
    const type = Services.prefs.getPrefType(name);
    return [name, Services.prefs.prefHasUserValue(name) ? { type, value: whimsyReadPref(name, type) } : null];
  })
);
const realConnection = WhimsyAIProviders.connection;

function restorePrefs() {
  for (const [name, was] of saved) {
    if (was) {
      whimsyWritePref(name, was.type, was.value);
    } else {
      Services.prefs.clearUserPref(name);
    }
  }
}

const YOURS = [
  { name: "Make it a post", result: "copy", model: "claude", prompt: "Rewrite {selection} as one post for X, under 280 characters. Keep my voice; no hashtags." },
  { name: "Explain for a PM", result: "insert-after", model: "auto", prompt: "Plain-English version of anything technical: {selection}" },
  { name: "Wikipedia", result: "link", url: "https://en.wikipedia.org/w/index.php?search=%s" },
  { name: "Search Linear", result: "link", url: "https://linear.app/unicorner/search?q=%s" },
];

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.ai-hints", false]] });
  ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIHints.sys.mjs").WhimsyAIHints._settleForTesting();
  closeToasts();
  const connections = { apple: { method: "local" }, claude: { method: "plan", label: "Max" }, openai: { method: "plan", label: "Plus" } };
  WhimsyAIProviders.connection = async id => connections[id] ?? null;
  const outer = { width: window.outerWidth, height: window.outerHeight };
  await resizeTo(1280, 800);
  registerCleanupFunction(async () => {
    WhimsyAIProviders.connection = realConnection;
    await WhimsyAICommands._resetForTesting();
    restorePrefs();
    await WhimsyAICommands.init();
    await resizeTo(outer.width, outer.height);
    closeToasts();
  });
});

async function resizeTo(width, height) {
  window.resizeTo(width, height);
  await TestUtils.waitForCondition(() => window.outerWidth == width && window.outerHeight == height, `The window is ${width}×${height}`).catch(() =>
    info(`The window stayed ${window.outerWidth}×${window.outerHeight}`)
  );
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
}

async function seed(yours = YOURS) {
  restorePrefs();
  Services.prefs.setStringPref("whimsy.ai.order", "apple,claude,openai");
  Services.prefs.setBoolPref("whimsy.ai.quick-text-apple", true);
  Services.prefs.setBoolPref("whimsy.ai.enabled", true);
  await WhimsyAICommands._resetForTesting();
  await WhimsyAICommands.init();
  for (const cmd of yours) {
    await WhimsyAICommands.save(cmd);
  }
}

const visible = node => !!node?.checkVisibility();
const click = (page, node) => EventUtils.synthesizeMouseAtCenter(node, {}, page.win);

async function frames(win) {
  await new Promise(r => win.requestAnimationFrame(() => win.requestAnimationFrame(r)));
}

async function settled(page) {
  for (let i = 0; i < 3; i++) {
    const running = page.doc.getAnimations().filter(a => a.playState == "running" && a.effect?.getComputedTiming().iterations != Infinity);
    await Promise.all(running.map(a => a.finished.catch(() => {})));
    await page.doc.l10n.translateFragment(page.doc.documentElement);
    await frames(page.win);
  }
}

async function openCommands() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:preferences#whimsyAI");
  const win = tab.linkedBrowser.contentWindow;
  const doc = win.document;
  await TestUtils.waitForCondition(() => win.WhimsyAISettings?.root && doc.getElementById("whimsyAIPage")?.checkVisibility(), "Settings › AI shows");
  const $ = id => doc.getElementById(id);
  await TestUtils.waitForCondition(() => $("whimsyCommandsList")?.dataset.ready == "true", "Commands are listed");
  const page = { tab, win, doc, $, S: win.WhimsyAISettings };
  await settled(page);
  $("whimsyAISection-commands").scrollIntoView({ block: "start", behavior: "instant" });
  await frames(win);
  return page;
}

async function done(page) {
  page.S.closeSheet({ restore: false });
  BrowserTestUtils.removeTab(page.tab);
  closeToasts();
}

async function editSheet(page, name) {
  const row = [...page.doc.querySelectorAll("#whimsyCommandsYours .whimsy-commands-row")].find(r => r.querySelector(".whimsy-ai-item-name").textContent == name);
  click(page, row.querySelector(".whimsy-commands-iconbtn"));
  await TestUtils.waitForCondition(() => page.$("whimsyAISheet")?.dataset.sheet == "command" && visible(page.$("whimsyAISheet")), "The command sheet opens");
}

function shoot(state, prepare, { yours = YOURS } = {}) {
  return whimsyBothSchemes(`w23-commands-${state}`, async dark => {
    await seed(yours);
    const page = await openCommands();
    try {
      await prepare(page, dark);
      await settled(page);
      ok(visible(page.$("whimsyAISection-commands")), `${state} (${dark ? "dark" : "light"}) is ready`);
    } catch (e) {
      await done(page);
      throw e;
    }
    return () => done(page);
  });
}

add_task(async function shots_list() {
  // set-6.1 and fu-settings 6.1: built in (switches) and yours (edit buttons).
  await shoot("set-6.1", async () => {});
});

add_task(async function shots_sheet() {
  // set-6.2 and fu-settings 6.2: a prompt command, the prompt focused, no Show in.
  await shoot("set-6.2", async page => {
    await editSheet(page, "Make it a post");
    const prompt = page.$("whimsyCommandPrompt");
    prompt.focus();
    page.win.getSelection().collapse(prompt, prompt.childNodes.length);
  });
  // set-6.3: a Link command.
  await shoot("set-6.3", async page => {
    await editSheet(page, "Wikipedia");
  });
  // set-6.4: Save with the prompt left empty.
  await shoot("set-6.4", async page => {
    await editSheet(page, "Make it a post");
    page.$("whimsyCommandPrompt").replaceChildren();
    click(page, page.$("whimsyCommandSave"));
    await TestUtils.waitForCondition(() => visible(page.$("whimsyCommandPromptError")), "The prompt's error shows");
  });
  // set-6.5: a Link command missing %s.
  await shoot("set-6.5", async page => {
    await editSheet(page, "Wikipedia");
    const address = page.$("whimsyCommandAddress");
    address.value = "https://en.wikipedia.org/wiki/Special:Search";
    click(page, page.$("whimsyCommandSave"));
    await TestUtils.waitForCondition(() => visible(page.$("whimsyCommandAddressError")), "The address's error shows");
  });
  // set-6.6: the result segment focused from the keyboard.
  await shoot("set-6.6", async page => {
    await editSheet(page, "Make it a post");
    page.$("whimsyCommandName").focus();
    EventUtils.synthesizeKey("KEY_Tab", {}, page.win);
  });
  // The token picker after typing "{".
  await shoot("tokens", async page => {
    await editSheet(page, "Explain for a PM");
    const prompt = page.$("whimsyCommandPrompt");
    prompt.focus();
    page.win.getSelection().collapse(prompt, prompt.childNodes.length);
    EventUtils.sendString(" from {", page.win);
    await TestUtils.waitForCondition(() => page.$("whimsyCommandsTokens"), "The token picker opens");
  });
});

add_task(async function shots_empty_and_deleted() {
  // set-6.7 and fu-settings 6.7: nothing of your own, and the Undo toast.
  await shoot(
    "set-6.7",
    async page => {
      await editSheet(page, "Make it a post");
      click(page, page.$("whimsyCommandDelete"));
      const toast = await TestUtils.waitForCondition(() => toastFor("whimsy-commands-deleted-toast"), "The Undo toast shows");
      await toast.shown;
      await document.l10n.translateFragment(toast.element);
      await TestUtils.waitForCondition(() => visible(page.$("whimsyCommandsEmpty")), "Yours is empty");
    },
    { yours: [YOURS[0]] }
  );
});

add_task(async function shots_mid_animation() {
  // The sheet fades and scales in over 160ms and its scrim over 150ms; both held at 80ms.
  await seed();
  const page = await openCommands();
  click(page, page.$("whimsyCommandsNew"));
  const both = () => {
    const { animation: a, scrimAnimation: s } = page.S.sheet ?? {};
    return a && s && {
      pause: () => (a.pause(), s.pause()),
      set currentTime(ms) {
        a.currentTime = s.currentTime = ms;
      },
      get currentTime() {
        return a.currentTime;
      },
      play: () => (a.play(), s.play()),
    };
  };
  await whimsyShotMid("w23-commands-sheet-open", both, 80);
  await settled(page);
  ok(visible(page.$("whimsyAISheet")), "The sheet finished opening");
  await done(page);
});
