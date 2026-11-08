/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W23 chat-answers: shots for side-by-side checks against 03-chat (chat-2.x
// to 10.x) and fu-chat (2.1, 2.2, 2.5, 3.6, 4.1, 4.6, 5.1, 6.3, 9.1, 10.4),
// light and dark, plus mid-animation frames. WHIMSY_SHOTS=<dir> writes
// w23-chat-answers-*.png.

const { WhimsyChatPanel } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyChatPanel.sys.mjs");
const { WhimsyChatContextUI } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyChatContextUI.sys.mjs");
const { WhimsyChatAnswer } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyChatAnswer.sys.mjs");
const { WhimsyAIProviders, WhimsyAIError } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIProviders.sys.mjs");
const { WhimsyAIStore } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIStore.sys.mjs");
const { WhimsyAIContext } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIContext.sys.mjs");
const { WhimsyAIUpdates } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIUpdates.sys.mjs");

const ROOT = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com");
const ARTICLE = ROOT + "whimsy_chat_article.html";
const MEDIA = ROOT + "whimsy_chat_media.html";
const OTHER = "https://example.org/?store";
const NAME = state => `w23-chat-answers-${state}`;
const ANSWER =
  "Cities are dropping the rule that new buildings must include parking, and it mostly lowers housing costs.\n\n" +
  "- More than 60 cities have done it, starting with Buffalo in 2017.\n" +
  "- A garage space can add $50,000 to a new apartment.";

const chat = () => WhimsyChatPanel.forWindow(window);
const el = () => document.getElementById("whimsy-chat");
const part = sel => el().querySelector(sel);
let script = null;
let tabs = [];

async function settle() {
  await TestUtils.waitForCondition(
    () => !el() || el().getAnimations({ subtree: true }).every(a => a.playState != "running" || a.effect?.getComputedTiming().iterations == Infinity),
    "The panel's motion has finished"
  );
}

async function closeChat() {
  if (chat().isOpen) {
    chat().close({ reason: "key" });
    await TestUtils.waitForCondition(() => el().hidden, "Chat closed");
  }
}

// A fresh store and tab, with chat open on it.
async function begin(url = ARTICLE) {
  await closeChat();
  await WhimsyAIStore._resetForTesting(PathUtils.join(PathUtils.tempDir, "whimsy-chat-answers-shots-" + Math.random().toString(16).slice(2)));
  script = null;
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, url);
  tabs.push(tab);
  EventUtils.synthesizeKey("e", { accelKey: true });
  await TestUtils.waitForCondition(() => chat().isOpen && chat().ready && part(".whimsy-chat-chip:not(.whimsy-chat-chip-add)"), "Chat is open with its chip");
  await settle();
  return tab;
}

async function end() {
  await closeChat();
  for (const tab of tabs) {
    if (tab.splitView) {
      gZenViewSplitter.unsplitCurrentView();
    }
  }
  for (const tab of tabs.splice(0)) {
    if (!tab.closing && tab.isConnected) {
      BrowserTestUtils.removeTab(tab);
    }
  }
  WhimsyChatContextUI.setLiveChip(window, null);
}

async function backgroundTab(url) {
  const tab = BrowserTestUtils.addTab(gBrowser, url);
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser);
  return tab;
}

async function ask(text) {
  chat().composer.focus();
  EventUtils.sendString(text);
  EventUtils.synthesizeKey("KEY_Enter");
}

const answered = () => TestUtils.waitForCondition(() => !part(".whimsy-chat-msg[data-role='ai'][busy]") && part(".whimsy-chat-msg[data-role='ai']"), "The answer is in");

function gate() {
  let open;
  const promise = new Promise(r => (open = r));
  return { promise, open };
}

// Each state in both schemes: `prepare` builds it after begin().
async function shoot(id, prepare, url) {
  await whimsyBothSchemes(NAME(id), async dark => {
    const tab = await begin(url);
    const cleanup = await prepare(tab, dark);
    await settle();
    return async () => {
      await cleanup?.();
      await end();
    };
  });
}

// Every running animation under `root`, held as one.
function allOf(root) {
  const list = () => root.getAnimations({ subtree: true }).filter(a => a.effect?.getComputedTiming().iterations != Infinity && a.playState == "running");
  return () => {
    const anims = list();
    if (!anims.length) {
      return null;
    }
    return {
      pause: () => anims.forEach(a => a.pause()),
      play: () => anims.forEach(a => a.play()),
      set currentTime(ms) {
        anims.forEach(a => (a.currentTime = ms));
      },
      get currentTime() {
        return anims[0].currentTime;
      },
    };
  };
}

// A chat that asked once and got `msg` (an error) back.
async function errorState(msg) {
  const tab = gBrowser.selectedTab;
  const thread = await WhimsyAIStore.createThread({ kind: "tab", tabKey: WhimsyAIContext.tabKey(tab), title: tab.label, url: tab.linkedBrowser.currentURI.spec, firstAsk: "Sum up this article" });
  await WhimsyAIStore.append(thread.id, { role: "user", text: "Sum up this article" });
  await WhimsyAIStore.append(thread.id, { role: "error", ...msg });
  await chat().showThread(thread.id);
  await TestUtils.waitForCondition(() => part(".whimsy-chat-error"), "The error block shows");
  return thread;
}

requestLongerTimeout(10);

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["whimsy.ai.enabled", true],
      ["whimsy.feature.ai-hints", false],
      ["whimsy.ai.order", "claude,openai,gemini"],
      ["whimsy.ai.off", ""],
      ["whimsy.ai.openai.model", "gpt-5"],
    ],
  });
  WhimsyAIProviders.setTestProvider(async function* (provider, request) {
    if (script) {
      yield* script(provider, request);
      return;
    }
    yield { type: "text", delta: ANSWER };
  });
  const { outerWidth, outerHeight } = window;
  window.resizeTo(1280, 800);
  await TestUtils.waitForCondition(() => window.innerWidth >= 1200, "Mockup-sized window");
  registerCleanupFunction(async () => {
    await end();
    WhimsyAIProviders.setTestProvider(null);
    WhimsyAIProviders.clearResting("claude");
    Services.prefs.clearUserPref("whimsy.ai.hints.seen");
    window.resizeTo(outerWidth, outerHeight);
    await WhimsyAIStore._resetForTesting(null);
  });
});

add_task(async function shots_chips() {
  for (const id of ["chat-2.1", "fu-2.1"]) {
    await shoot(id, async () => {}, MEDIA);
  }
  for (const id of ["chat-2.2", "fu-2.2"]) {
    await shoot(id, async () => {
      tabs.push(await backgroundTab(OTHER));
      await ask("Which of all my tabs mention parking?");
      await answered();
      await TestUtils.waitForCondition(() => part(".whimsy-chat-chip[data-kind='tabs']"), "Widened");
    });
  }
  await shoot("chat-2.3", async () => {
    const path = PathUtils.join(PathUtils.tempDir, "Lease agreement.pdf");
    await IOUtils.writeUTF8(path, "%PDF-1.4");
    await WhimsyChatContextUI.addChip(window, { id: "file:lease", kind: "file", path, label: "Lease agreement.pdf" });
    return () => IOUtils.remove(path);
  });
  await shoot("chat-2.4", async () => {
    WhimsyChatContextUI.setLiveChip(window, { id: "drive:plan", kind: "drive", label: "Q3 plan", icon: "chrome://browser/content/whimsy/icons/google-drive.svg", counts: { text: 1 }, parts: [] });
    await TestUtils.waitForCondition(() => part(".whimsy-chat-chip[data-chip='drive:plan']"), "Drive chip");
  });
  for (const id of ["chat-2.5", "fu-2.5"]) {
    await shoot(id, async () => {
      WhimsyChatContextUI.setLiveChip(window, { id: "granola", kind: "granola", label: "Granola", icon: "chrome://browser/content/whimsy/icons/granola.svg", counts: { text: 1 }, parts: [] });
      await TestUtils.waitForCondition(() => part(".whimsy-chat-chip[data-chip='granola']"), "Granola chip");
    });
  }
  await shoot("chat-2.6", async () => {
    await WhimsyChatContextUI.removeChip(window, part(".whimsy-chat-chip[data-kind='tab']").dataset.chip);
    await TestUtils.waitForCondition(() => part(".whimsy-chat-note[data-kind='chip-removed'] .whimsy-chat-link"), "Undo line");
  });
  await shoot("chat-2.7", async () => {
    tabs.push(await backgroundTab(OTHER));
    EventUtils.synthesizeMouseAtCenter(part(".whimsy-chat-chip-add"), {});
    await TestUtils.waitForCondition(() => part(".whimsy-chat-add-menu"), "Add menu");
  });
  // Mid-frames: a chip leaving, and the Undo line arriving.
  for (const dark of [false, true]) {
    await whimsySetScheme(dark);
    await begin();
    const chip = part(".whimsy-chat-chip[data-kind='tab']");
    const removing = WhimsyChatContextUI.removeChip(window, chip.dataset.chip);
    await whimsyShotMid(`${NAME("chat-2.6")}-${dark ? "dark" : "light"}-chip`, () => chip.getAnimations()[0], 75);
    await removing;
    await end();
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function shots_what_ai_sees() {
  for (const [id, row, url] of [["chat-3.1", "text", ARTICLE], ["chat-3.2", "images", MEDIA], ["chat-3.3", "videos", MEDIA], ["fu-3.6", null, MEDIA]]) {
    await shoot(id, async () => {
      await WhimsyChatContextUI.openSheet(chat(), part(".whimsy-chat-chip[data-kind='tab']").dataset.chip);
      await TestUtils.waitForCondition(() => part(".whimsy-chat-sheet .whimsy-chat-sees-row"), "What AI sees");
      await settle();
      const r = row && part(`.whimsy-chat-sees-row[data-kind='${row}']`);
      if (r) {
        EventUtils.synthesizeMouseAtCenter(r, {});
        await TestUtils.waitForCondition(() => part(".whimsy-chat-sheet-view:not([data-view='list'])"), "Drilled in");
      }
    }, url);
  }
  await shoot("chat-3.4", async () => {
    Services.prefs.setStringPref("whimsy.ai.order", "apple,claude");
    await WhimsyChatContextUI.openSheet(chat(), part(".whimsy-chat-chip[data-kind='tab']").dataset.chip);
    await TestUtils.waitForCondition(() => part(".whimsy-chat-sheet .whimsy-chat-sees-row"), "What AI sees");
    return () => Services.prefs.setStringPref("whimsy.ai.order", "claude,openai,gemini");
  }, MEDIA);
  await shoot("chat-3.5", async () => {
    tabs.push(await backgroundTab(OTHER));
    await ask("Which of all my tabs mention parking?");
    await answered();
    const chip = await TestUtils.waitForCondition(() => part(".whimsy-chat-chip[data-kind='tabs']"), "Widened");
    await WhimsyChatContextUI.openSheet(chat(), chip.dataset.chip);
    await TestUtils.waitForCondition(() => part(".whimsy-chat-sheet .whimsy-chat-sees-row"), "What AI sees");
  });
  // Mid-frame: the sheet sliding in.
  for (const dark of [false, true]) {
    await whimsySetScheme(dark);
    await begin();
    const opening = WhimsyChatContextUI.openSheet(chat(), part(".whimsy-chat-chip[data-kind='tab']").dataset.chip);
    await whimsyShotMid(`${NAME("chat-3.1")}-${dark ? "dark" : "light"}-sheet`, () => part(".whimsy-chat-sheet")?.getAnimations()[0], 90);
    await opening;
    await end();
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function shots_answers() {
  let g;
  for (const id of ["chat-4.1", "fu-4.1"]) {
    await shoot(id, async () => {
      g = gate();
      script = async function* () {
        yield { type: "thinking", text: "The article is about national trends. Oakland's own rules are different, so check the city's plan before saying yes." };
        await g.promise;
        yield { type: "text", delta: "Likely yes." };
      };
      await ask("Is this a good idea for Oakland?");
      await TestUtils.waitForCondition(() => part(".whimsy-chat-thinking[live]"), "Thinking");
      return async () => {
        g.open();
        await answered();
      };
    });
  }
  await shoot("chat-4.2", async () => {
    g = gate();
    script = async function* () {
      yield { type: "text", delta: "More than 60 cities have dropped the rule, starting with Buffalo" };
      yield { type: "citation", n: 1, source: { quote: "Buffalo was first in 2017" } };
      yield { type: "text", delta: " in 2017. Builders there added 21% fewer spaces" };
      yield { type: "citation", n: 2, source: { quote: "Builders there added 21% fewer spaces" } };
      await g.promise;
    };
    await ask("Sum up this article");
    await TestUtils.waitForCondition(() => part(".whimsy-chat-msg[busy] .whimsy-chat-cite"), "Streaming with a pill");
    return async () => {
      g.open();
      await answered();
    };
  });
  await shoot("chat-4.3", async tab => {
    script = async function* () {
      yield { type: "text", delta: "Buffalo went first" };
      yield { type: "citation", n: 1, source: { quote: "Buffalo was first in 2017" } };
      yield { type: "text", delta: ", in 2017." };
    };
    await ask("When did it start?");
    await answered();
    EventUtils.synthesizeMouseAtCenter(part(".whimsy-chat-cite"), {});
    await TestUtils.waitForCondition(async () => (await SpecialPowers.spawn(tab.linkedBrowser, [], () => content.getSelection().toString())).includes("Buffalo"), "Highlighted");
  });
  await shoot("chat-4.4", async () => {
    await ask("Sum up this article");
    await answered();
    const thread = chat().thread;
    const user = (await WhimsyAIStore.messages(thread.id)).find(m => m.role == "user");
    await WhimsyAIStore.updateMessage(thread.id, user.id, { used: [{ kind: "memories", count: 2, label: "" }] });
    await chat().showThread(thread.id);
    await TestUtils.waitForCondition(() => part(".whimsy-chat-used"), "Used line");
  });
  // fu 4.6: a plan answer arrives whole and fades in; shot mid-fade too.
  const usesPlan = WhimsyAIProviders._usesPlan;
  WhimsyAIProviders._usesPlan = id => id == "claude";
  await shoot("fu-4.6", async () => {
    g = gate();
    script = async function* () {
      yield { type: "text", delta: ANSWER };
      await g.promise;
    };
    await ask("Sum up this article");
    await TestUtils.waitForCondition(() => part(".whimsy-chat-msg[busy] .whimsy-chat-status"), "Status row");
    return async () => {
      g.open();
      await answered();
    };
  });
  for (const dark of [false, true]) {
    await whimsySetScheme(dark);
    await begin();
    await ask("Sum up this article");
    await whimsyShotMid(`${NAME("fu-4.6")}-${dark ? "dark" : "light"}-fade`, () => part(".whimsy-chat-msg[data-role='ai']:not([busy])")?.getAnimations()[0], 120);
    await end();
    await SpecialPowers.popPrefEnv();
  }
  WhimsyAIProviders._usesPlan = usesPlan;
});

add_task(async function shots_models_and_handoffs() {
  for (const id of ["chat-5.1", "fu-5.1"]) {
    await shoot(id, async () => {
      EventUtils.synthesizeMouseAtCenter(part(".whimsy-chat-model-button"), {});
      await TestUtils.waitForCondition(() => part(".whimsy-chat-model-menu"), "Model menu");
    });
  }
  await shoot("chat-5.2", async () => {
    script = async function* (provider) {
      if (provider == "claude") {
        throw Object.assign(new WhimsyAIError("rate-limited"), { provider });
      }
      yield { type: "text", delta: ANSWER };
    };
    await ask("Sum up this article");
    await answered();
    await TestUtils.waitForCondition(() => part(".whimsy-chat-note[data-kind='handoff']"), "Handoff line");
    return () => WhimsyAIProviders.clearResting("claude");
  });
  await shoot("chat-5.3", async () => {
    script = async function* (provider) {
      yield { type: "text", delta: "Cities are dropping the rule that new buildings must include parking, and" };
      throw Object.assign(new WhimsyAIError("plan-limit"), { provider });
    };
    await ask("Sum up this article");
    await answered();
    await TestUtils.waitForCondition(() => part(".whimsy-chat-error[tone='amber']"), "Quota block");
    return () => WhimsyAIProviders.clearResting("claude");
  });
});

add_task(async function shots_pass_through() {
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  await shoot("chat-6.1", async () => {
    script = async function* () {
      yield { type: "text", delta: "Here it is." };
      yield { type: "artifact", artifact: { kind: "image", mime: "image/png", data: png, width: 1024, height: 1024 } };
    };
    await ask("Make an illustration of a street without parking");
    await answered();
  });
  let g;
  await shoot("chat-6.2", async () => {
    g = gate();
    script = async function* () {
      yield { type: "artifact", artifact: { kind: "progress", title: "Deep research", lines: ["Found 14 city studies", "Reading Buffalo's zoning report", "Comparing rents before and after"], sources: 9 } };
      await g.promise;
    };
    await ask("Do deep research on parking reform and rents");
    await TestUtils.waitForCondition(() => part(".whimsy-chat-research[live]"), "Progress card");
    return () => g.open();
  });
  for (const id of ["chat-6.3", "fu-6.3"]) {
    await shoot(id, async () => {
      WhimsyAIUpdates._resetForTesting();
      script = async function* () {
        yield { type: "text", delta: "In short: rents ran 8 to 15% lower where the rule went." };
        yield { type: "artifact", artifact: { kind: "report", title: "Parking reform and rents", markdown: "# Parking reform and rents\n\nRents ran 8 to 15% lower.", sources: 23 } };
      };
      await ask("Do deep research on parking reform and rents");
      await answered();
      await TestUtils.waitForCondition(() => part(".whimsy-chat-report"), "Report card");
      return async () => {
        for (const t of gBrowser.tabs.filter(t => t.linkedBrowser.currentURI.spec.endsWith(".md"))) {
          BrowserTestUtils.removeTab(t);
        }
        await WhimsyAIStore.clear({ kinds: ["reports"] });
      };
    });
  }
  await shoot("chat-6.4", async () => {
    script = async function* () {
      yield { type: "text", delta: "Here's the average:" };
      yield { type: "artifact", artifact: { kind: "code", language: "python", code: "rents = [1850, 1720, 1690]\nprint(sum(rents) / len(rents))", output: "1753.33" } };
    };
    await ask("Average these rents");
    await answered();
  });
});

add_task(async function shots_pages() {
  await shoot("chat-7.1", async () => {
    script = async function* () {
      yield { type: "text", delta: "The video makes three points:\n\n- 0:42 Parking minimums raise rents\n- 3:15 Buffalo's results\n- 7:02 What other cities copied" };
    };
    await ask("Sum up this video");
    await answered();
  });
  await shoot("chat-7.2", async () => {
    script = async function* () {
      yield { type: "text", delta: "| | Store A | Store B |\n|---|---|---|\n| Price | $129 | $119 |\n| Shipping | Free | $9 |\n| Returns | 30 days | 14 days |" };
    };
    await ask("Compare these");
    await answered();
  });
  await shoot("chat-7.3", async () => {
    await errorState({ code: "too-long", provider: "claude", needs: { chars: 900000 } });
  });
  await shoot("chat-7.4", async tab => {
    await SpecialPowers.spawn(tab.linkedBrowser, [], () => (content.document.documentElement.lang = "ja"));
    await ask("What is this about?");
    await answered();
    await TestUtils.waitForCondition(() => part(".whimsy-chat-note[data-kind='language'] .whimsy-chat-link"), "Language line");
  });
  for (const id of ["chat-9.1", "fu-9.1"]) {
    await shoot(id, async tab => {
      const other = await BrowserTestUtils.openNewForegroundTab(gBrowser, OTHER);
      tabs.push(other);
      gZenViewSplitter.splitTabs([tab, other], "vsep");
      await TestUtils.waitForCondition(() => parts(".whimsy-chat-chip[data-kind='pane']").length == 2, "A chip per pane");
    });
  }
});

function parts(sel) {
  return [...el().querySelectorAll(sel)];
}

add_task(async function shots_errors() {
  const cases = [
    ["chat-10.1", { code: "all-failed", provider: "claude", tried: ["claude", "openai"] }],
    ["chat-10.2", { code: "plan-limit", provider: "claude", until: Date.now() + 3 * 3600e3 }],
    ["chat-10.3", { code: "too-long", provider: "claude", needs: { chars: 900000 } }],
    ["chat-10.4", { code: "none-capable", provider: "claude", needs: { images: true } }],
    ["fu-10.4", { code: "none-capable", provider: "claude", needs: { images: true }, tried: ["claude", "openai"] }],
    ["chat-10.5", { code: "connector-signed-out", provider: "claude", connector: "Google Drive" }],
    ["chat-10.6", { code: "offline", provider: "claude" }],
    ["chat-10.7", { code: "none-capable", provider: "claude", needs: { research: true } }],
  ];
  for (const [id, msg] of cases) {
    await shoot(id, async () => {
      await errorState(msg);
    });
  }
  await shoot("chat-10.8", async () => {
    const { id } = await errorState({ code: "all-failed", provider: "claude", tried: ["claude"] });
    await WhimsyAIStore.append(id, { role: "error", code: "plan-limit", provider: "claude" });
    await WhimsyAIStore.append(id, { role: "error", code: "none-capable", provider: "claude", needs: { research: true } });
    await chat().showThread(id);
    await TestUtils.waitForCondition(() => parts(".whimsy-chat-error").length == 3, "Three tones");
  });
});
