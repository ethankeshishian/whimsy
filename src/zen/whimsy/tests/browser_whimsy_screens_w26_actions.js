/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W26 actions: ⌘K (the real key) in every context, light and dark:
// w26-actions-<context>[-<typed>]-<scheme>. Each context also logs an
// AUDIT line with the bar's mode and rows (intake-w26/audit-actions.md).
// WHIMSY_SHOTS=<dir> writes the PNGs; without it the walk still runs.
// The owner chose option 1 (lane/w26-actions2): ⌘K opens the normal bar
// everywhere, with no automatic Actions mode or pill, and "/" enters
// Actions. On a loaded page ⌘K is still the page's commands.

requestLongerTimeout(4);

Services.scriptloader.loadSubScript(getRootDirectory(gTestPath) + "head_cmdbar_ai.js", this);

const { WhimsyVerbs } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyVerbs.sys.mjs");
const { WhimsyCommandBarAgent } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCommandBarAgent.sys.mjs");
const { UrlbarShared } = ChromeUtils.importESModule("chrome://browser/content/urlbar/UrlbarShared.mjs");

const NAME = id => `w26-actions-${id}`;
const TABS_REQUEST = "close all my youtube tabs";
const TASK_REQUEST = "go to wikipedia.org find the eiffel tower article, and summarize its history in three bullets";
const YOUTUBE = n => `data:text/html,<title>YouTube - video ${n}</title><p>video ${n}`;
const PDF = "https://example.com/browser/zen/whimsy/tests/whimsy_ai_lease.pdf";
const SLOW = "http://mochi.test:8888/browser/zen/whimsy/tests/whimsy_slow_load.sjs?delay=20000";
const ERROR_PAGE = "http://does-not-exist.invalid/";

const PLAN = {
  act: true,
  can: true,
  web: true,
  title: "Summarize the Eiffel Tower’s history",
  line: "I’ll open Wikipedia, find the article, and sum up its history.",
  steps: [{ text: "Go to wikipedia.org" }, { text: "Find the Eiffel Tower article" }, { text: "Summarize its history in three bullets" }],
};

add_setup(async function () {
  await setupAI();
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.ai-agent", true], ["whimsy.feature.ai-tab-requests", true], ["whimsy.ai.agent.mode", "drive"]] });
  script = async function* (provider, request) {
    if (request.system.includes("You plan tasks")) {
      yield { type: "text", delta: JSON.stringify(PLAN) };
    } else {
      yield { type: "text", delta: "An answer." };
    }
  };
  closeToasts();
  const outer = { width: window.outerWidth, height: window.outerHeight };
  window.resizeTo(1280, 800);
  await TestUtils.waitForCondition(() => window.outerWidth == 1280, "Resized");
  registerCleanupFunction(async () => {
    WhimsyCommandBarAgent._resetForTesting?.();
    await leaveBar();
    window.resizeTo(outer.width, outer.height);
    closeToasts();
  });
});

/** The real ⌘K; resolves once the bar has focus and its first query is in. */
async function cmdK(win = window) {
  win.gBrowser.selectedBrowser.focus();
  EventUtils.synthesizeKey("k", { accelKey: true }, win);
  await TestUtils.waitForCondition(() => win.gURLBar.focused, "⌘K focused the bar");
  await win.gURLBar.lastQueryContextPromise;
}

async function typeIn(text, win = window) {
  for (let i = 0; i < 3 && win.gURLBar.value != text; i++) {
    win.gURLBar.select();
    const done = UrlbarTestUtils.promiseSearchComplete(win);
    EventUtils.sendString(text, win);
    await done;
  }
  await TestUtils.waitForCondition(() => win.gURLBar.value == text, `typed "${text}"`);
  await win.gURLBar.lastQueryContextPromise;
}

async function leaveBar(win = window) {
  WhimsyCommandBarAgent.leave?.(win);
  if (win.gURLBar.view.isOpen) {
    win.gURLBar.view.close();
  }
  win.gURLBar.searchMode = null;
  win.gURLBar.value = "";
  WhimsyVerbs.sessions.delete(win);
  win.gBrowser.selectedBrowser.focus();
}

function visibleRows(win = window) {
  return [...win.gURLBar.view.panel.querySelectorAll(".urlbarView-row")].filter(r => !r.hidden && r.getBoundingClientRect().height > 0);
}

// One line per context for the audit: the bar's mode, the view, and each
// row as "type|label|title|key|selected|clipped".
function audit(context, win = window) {
  const urlbar = win.gURLBar;
  const mode = urlbar.searchMode?.source == UrlbarShared.RESULT_SOURCE.ZEN_ACTIONS ? "actions" : urlbar.searchMode?.source ?? "none";
  const rows = visibleRows(win).map(row => {
    const title = row.querySelector(".urlbarView-title")?.textContent.trim() ?? "";
    const key = row.querySelector(".whimsy-cmdk-row-key, .whimsy-cmdbar-key, .whimsy-cmdk-tag")?.textContent.trim() ?? "";
    const clipped = [...row.querySelectorAll(".whimsy-cmdk-row-key, .whimsy-cmdbar-key, .whimsy-cmdk-tag, .urlbarView-title")]
      .some(el => el.scrollWidth > el.clientWidth + 1);
    return [row.getAttribute("dynamicType") ?? row.getAttribute("type") ?? "?", row.getAttribute("label") ?? "", title, key, row.hasAttribute("selected") ? "sel" : "", clipped ? "CLIPPED" : ""].join("|");
  });
  ok(urlbar.view.isOpen, `${context}: the bar is open`);
  info(`AUDIT ${context} mode=${mode} open=${urlbar.view.isOpen} session=${!!WhimsyVerbs.sessions.get(win)} agent=${WhimsyCommandBarAgent.state?.(win)?.phase ?? "-"} rows=${JSON.stringify(rows)}`);
}

async function shoot(id, prepare, win = window) {
  await whimsyBothSchemes(NAME(id), async dark => {
    await prepare();
    await whimsySettled(win.document);
    audit(`${id} ${dark ? "dark" : "light"}`, win);
    return () => leaveBar(win);
  });
}

async function selectHeading(browser) {
  await SpecialPowers.spawn(browser, [], () => {
    const el = content.document.querySelector("h1");
    const range = content.document.createRange();
    range.selectNodeContents(el);
    content.getSelection().removeAllRanges();
    content.getSelection().addRange(range);
  });
}

async function withYoutubeTabs(fn) {
  const current = gBrowser.selectedTab;
  const tabs = [];
  for (const n of [1, 2]) {
    tabs.push(await BrowserTestUtils.openNewForegroundTab(gBrowser, YOUTUBE(n)));
  }
  await BrowserTestUtils.switchTab(gBrowser, current);
  try {
    await fn(tabs);
  } finally {
    for (const t of tabs) {
      if (t.isConnected) {
        BrowserTestUtils.removeTab(t);
      }
    }
  }
}

add_task(async function page_and_selection() {
  await BrowserTestUtils.withNewTab(ARTICLE, async browser => {
    await withYoutubeTabs(async () => {
      await shoot("page", () => cmdK());
      await shoot("page-tabs", async () => {
        await cmdK();
        await typeIn(TABS_REQUEST);
      });
      await shoot("page-request", async () => {
        await cmdK();
        await typeIn(TASK_REQUEST);
      });
      await shoot("page-question", async () => {
        await cmdK();
        await typeIn("what is this page about?");
      });
      await shoot("page-nomatch", async () => {
        await cmdK();
        await typeIn("zzqx");
      });
      await shoot("selection", async () => {
        await selectHeading(browser);
        await cmdK();
      });
      await shoot("selection-tabs", async () => {
        await selectHeading(browser);
        await cmdK();
        await typeIn(TABS_REQUEST);
      });
      await shoot("selection-request", async () => {
        await selectHeading(browser);
        await cmdK();
        await typeIn(TASK_REQUEST);
      });
    });
  });
});

// Settings and no tabs: ⌘K is the normal bar (mode=none in the AUDIT line),
// with tabs, Ask AI, and the agent's rows as anywhere else.
add_task(async function settings_and_no_tabs() {
  await BrowserTestUtils.withNewTab("about:preferences", async () => {
    await withYoutubeTabs(async () => {
      await shoot("settings", () => cmdK());
      await shoot("settings-tabs", async () => {
        await cmdK();
        await typeIn(TABS_REQUEST);
      });
      await shoot("settings-nomatch", async () => {
        await cmdK();
        await typeIn("zzqx");
      });
    });
  });
  // No tabs: the space's empty tab only.
  const keep = [...gBrowser.tabs].filter(t => t.hasAttribute("zen-empty-tab") || t.hasAttribute("zen-essential"));
  const had = [...gBrowser.tabs].filter(t => !keep.includes(t)).map(t => t.linkedBrowser.currentURI.spec);
  for (const t of [...gBrowser.tabs]) {
    if (!keep.includes(t)) {
      BrowserTestUtils.removeTab(t);
    }
  }
  await TestUtils.waitForCondition(() => gBrowser.selectedTab.hasAttribute("zen-empty-tab"), "The empty tab is selected");
  await shoot("notabs", () => cmdK());
  await shoot("notabs-typed", async () => {
    await cmdK();
    await typeIn("new");
  });
  for (const url of had.length ? had : ["about:blank"]) {
    await BrowserTestUtils.openNewForegroundTab(gBrowser, url);
  }
});

add_task(async function pdf_reader_split_loading_error() {
  await BrowserTestUtils.withNewTab(PDF, async () => {
    await shoot("pdf", () => cmdK());
  });
  await BrowserTestUtils.withNewTab(`about:reader?url=${encodeURIComponent(ARTICLE)}`, async () => {
    await shoot("reader", () => cmdK());
  });
  const a = await BrowserTestUtils.openNewForegroundTab(gBrowser, ARTICLE);
  const b = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.org/browser/zen/whimsy/tests/whimsy_chat_article.html");
  gZenViewSplitter.splitTabs([a, b], "vsep");
  await TestUtils.waitForCondition(() => gZenViewSplitter._data.find(g => g.tabs.includes(a))?.tabs.length == 2, "Split");
  await shoot("split", () => cmdK());
  gZenViewSplitter.unsplitCurrentView();
  BrowserTestUtils.removeTab(a);
  BrowserTestUtils.removeTab(b);

  const loading = BrowserTestUtils.addTab(gBrowser, SLOW);
  gBrowser.selectedTab = loading;
  await TestUtils.waitForCondition(() => loading.hasAttribute("busy"), "The page is loading");
  await shoot("loading", () => cmdK());
  BrowserTestUtils.removeTab(loading);

  const error = BrowserTestUtils.addTab(gBrowser, ERROR_PAGE);
  gBrowser.selectedTab = error;
  await BrowserTestUtils.browserLoaded(error.linkedBrowser, false, null, true);
  await shoot("error", () => cmdK());
  BrowserTestUtils.removeTab(error);
});

add_task(async function private_window() {
  const win = await BrowserTestUtils.openNewBrowserWindow({ private: true });
  try {
    await BrowserTestUtils.withNewTab({ gBrowser: win.gBrowser, url: ARTICLE }, async () => {
      for (const dark of [false, true]) {
        await whimsySetScheme(dark);
        try {
          await cmdK(win);
          await whimsySettled(win.document);
          audit(`private ${dark ? "dark" : "light"}`, win);
          await whimsyShot(`${NAME("private")}-${dark ? "dark" : "light"}`, win.browsingContext.currentWindowGlobal);
        } finally {
          await leaveBar(win);
          await SpecialPowers.popPrefEnv();
        }
      }
    });
  } finally {
    await BrowserTestUtils.closeWindow(win);
  }
});
