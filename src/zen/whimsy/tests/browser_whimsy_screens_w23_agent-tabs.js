/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W23 agent-tabs screenshots (light and dark, plus mid-motion frames):
// agent-2.1/2.5 (Drive look), fu-agent 3.1 (folder folded/open), 3.3
// (needs you, amber), 4.1 (a collision), agent-3.5 (kept tabs, moved toast),
// and Zap's dissolve on the folder at several frames.

const { WhimsyAgentPointer } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAgentPointer.sys.mjs");
const { WhimsyTaskFolder } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyTaskFolder.sys.mjs");
const { WhimsyAgentTasks } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAgentTasks.sys.mjs");
const { WhimsyClaude } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyClaude.sys.mjs");
const { WhimsyChatPanel } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyChatPanel.sys.mjs");
const { WhimsyAIStore } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIStore.sys.mjs");

const ROOT = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com");
const PAGE = ROOT + "whimsy_claude.html";
const CHECKOUT = ROOT + "whimsy_agent_checkout.html";
const chat = () => WhimsyChatPanel.forWindow(window);
const frames = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

async function fresh() {
  await WhimsyAIStore._resetForTesting(PathUtils.join(PathUtils.tempDir, "whimsy-agent-tabs-shots-" + Math.random().toString(16).slice(2)));
  WhimsyAgentTasks._resetForTesting();
}

async function closeAll(...tabs) {
  WhimsyTaskFolder._setDissolveClockForTesting(null);
  for (const task of WhimsyAgentTasks.list()) {
    WhimsyAgentTasks.stop(task.id);
  }
  await TestUtils.waitForCondition(() => !document.querySelector(".whimsy-task-folder"), "No folders left", 100, 100);
  WhimsyAgentTasks._resetForTesting();
  if (chat().isOpen) {
    chat().close({ reason: "key" });
    await TestUtils.waitForCondition(() => document.getElementById("whimsy-chat").hidden, "Chat closed");
  }
  for (const tab of tabs.flat()) {
    if (tab.isConnected && !tab.closing) {
      BrowserTestUtils.removeTab(tab);
    }
  }
  closeToasts();
}

async function folderTask(n = 3) {
  const task = WhimsyAgentTasks.start({ client: "outside", clientName: "Claude", mode: "background",
    title: "Lisbon hotels", spaceId: gZenWorkspaces.activeWorkspace });
  await TestUtils.waitForCondition(() => task.threadId, "Its thread is made");
  const tabs = [];
  for (let i = 0; i < n; i++) {
    tabs.push(await WhimsyClaude.openTab(`${PAGE}?${i}`, task));
  }
  const [folder] = WhimsyTaskFolder.foldersFor(task);
  return { task, tabs, folder };
}

add_setup(async function () {
  await gZenWorkspaces.promiseInitialized;
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.ai-hints", false]] });
  registerCleanupFunction(() => WhimsyAgentTasks._resetForTesting());
});

add_task(async function shots_drive_look() {
  await fresh();
  const task = WhimsyAgentTasks.start({ client: "whimsy", clientName: "Claude", mode: "drive", title: "Coffee reorder" });
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, CHECKOUT);
  WhimsyAgentTasks.addTab(task, tab);
  const total = await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
    const r = content.document.getElementById("place").getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  await whimsyBothSchemes("w23-agent-tabs-drive", async () => {
    WhimsyClaude.markActive(tab, task);
    WhimsyAgentPointer.target(tab.linkedBrowser, total, "Place order");
    await WhimsyAgentPointer.moveTo(tab.linkedBrowser, { x: total.x + total.width / 2, y: total.y + total.height / 2 });
    await document.l10n.translateRoots();
  });
  // The pointer gliding to its target (240ms), held at 150ms.
  const browser = tab.linkedBrowser;
  await WhimsyAgentPointer.moveTo(browser, { x: 40, y: 40 });
  // Let the scheme switch finish fading the sidebar back first.
  await whimsySettled();
  const pointer = WhimsyAgentPointer.layer(browser).querySelector(".whimsy-agent-pointer");
  const travel = WhimsyAgentPointer.moveTo(browser, { x: total.x + total.width / 2, y: total.y + total.height / 2 });
  await whimsyShotMid("w23-agent-tabs-pointer", () => pointer.getAnimations()[0], 150);
  await travel;
  ok(WhimsyAgentPointer.layer(browser, false)?.hasAttribute("glow"), "The Drive look shows");
  await closeAll(tab);
});

add_task(async function shots_task_folder() {
  await fresh();
  const notes = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE + "?notes");
  const diag = [];
  const origRelease = WhimsyAgentTasks.release;
  WhimsyAgentTasks.release = function (...args) {
    diag.push(new Error().stack.split("\n").slice(0, 12).join(" | "));
    return origRelease.apply(this, args);
  };
  const origFolderRelease = WhimsyTaskFolder.release;
  WhimsyTaskFolder.release = function (...args) {
    diag.push("folder " + new Error().stack.split("\n").slice(0, 12).join(" | "));
    return origFolderRelease.apply(this, args);
  };
  const proto = customElements.get("tabbrowser-tab").prototype;
  const origRemove = Object.getOwnPropertyDescriptor(proto, "removeAttribute");
  proto.removeAttribute = function (name) {
    if (name == "whimsy-agent-task" || name == "whimsy-task-tab") {
      diag.push(`remove ${name} ` + new Error().stack.split("\n").slice(0, 10).join(" | "));
    }
    return Element.prototype.removeAttribute.call(this, name);
  };
  const origAddTab = WhimsyAgentTasks.addTab;
  WhimsyAgentTasks.addTab = function (t, tab) {
    diag.push(`addTab ${t.id == undefined ? "?" : t.id.slice(0, 8)} ${tab.linkedBrowser?.currentURI?.spec}`);
    return origAddTab.apply(this, [t, tab]);
  };
  const { task, tabs, folder } = await folderTask(3);
  diag.push(`after folderTask: task ${task.id.slice(0, 8)} size ${task.tabs.size}`);
  await new Promise(r => setTimeout(r, 500));
  WhimsyAgentTasks.addTab = origAddTab;
  if (origRemove) {
    Object.defineProperty(proto, "removeAttribute", origRemove);
  } else {
    delete proto.removeAttribute;
  }
  WhimsyAgentTasks.release = origRelease;
  WhimsyTaskFolder.release = origFolderRelease;
  info(`DIAG releases: ${diag.join(" ### ")}`);
  await whimsyBothSchemes("w23-agent-tabs-folder-folded", async () => {
    WhimsyTaskFolder.setCollapsed(folder, true);
    await document.l10n.translateRoots();
  });
  await whimsyBothSchemes("w23-agent-tabs-folder-open", async () => {
    WhimsyTaskFolder.setCollapsed(folder, false);
    WhimsyClaude.markActive(tabs[0], task);
    await document.l10n.translateRoots();
    return () => WhimsyTaskFolder.setCollapsed(folder, true);
  });
  // Needs you with chat hidden: amber line, the toast with ⌘E (fu-agent 3.3).
  WhimsyAgentTasks.pause(task.id, { kind: "send", host: "example.com", preview: { title: "Send a reply to Maya?", fields: [] } });
  await TestUtils.waitForCondition(() => toastFor("whimsy-agent-chat-needs-you"), "The toast");
  await whimsyBothSchemes("w23-agent-tabs-needs-you", async () => {
    await document.l10n.translateRoots();
  });
  is(folder.getAttribute("whimsy-agent-working"), "wait", "The line is amber");
  closeToasts();
  await closeAll(notes, tabs);
});

add_task(async function shots_folder_slide_in() {
  await fresh();
  const task = WhimsyAgentTasks.start({ client: "whimsy", clientName: "Claude", mode: "background", title: "Lisbon hotels",
    spaceId: gZenWorkspaces.activeWorkspace });
  const tab = await WhimsyClaude.openTab(PAGE, task);
  const [folder] = WhimsyTaskFolder.foldersFor(task);
  const slide = folder.getAnimations()[0];
  if (slide) {
    await whimsyShotMid("w23-agent-tabs-folder-in", () => slide, 120);
  }
  ok(folder.isConnected, "The folder is in");
  await closeAll(tab);
});

add_task(async function shots_collision() {
  await fresh();
  const { task, tabs } = await folderTask(3);
  gBrowser.selectedTab = tabs[0];
  WhimsyClaude.markActive(tabs[0], task);
  WhimsyTaskFolder.setCollapsed(WhimsyTaskFolder.foldersFor(task)[0], false);
  WhimsyTaskFolder.collide(window, task, tabs[0]);
  await TestUtils.waitForCondition(() => chat().isOpen && document.querySelector(`#whimsy-chat [data-pause-id='${task.pause.id}']`), "Chat opens on the pause");
  await whimsyBothSchemes("w23-agent-tabs-collision", async () => {
    await document.l10n.translateRoots();
  });
  is(WhimsyAgentPointer.layer(tabs[0].linkedBrowser, false)?.getAttribute("tone"), "wait", "The page's glow turns amber");
  await closeAll(tabs);
});

add_task(async function shots_dissolve() {
  await fresh();
  const notes = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE + "?notes");
  const diag = [];
  const origRelease = WhimsyAgentTasks.release;
  WhimsyAgentTasks.release = function (...args) {
    diag.push(new Error().stack.split("\n").slice(0, 12).join(" | "));
    return origRelease.apply(this, args);
  };
  const origFolderRelease = WhimsyTaskFolder.release;
  WhimsyTaskFolder.release = function (...args) {
    diag.push("folder " + new Error().stack.split("\n").slice(0, 12).join(" | "));
    return origFolderRelease.apply(this, args);
  };
  const proto = customElements.get("tabbrowser-tab").prototype;
  const origRemove = Object.getOwnPropertyDescriptor(proto, "removeAttribute");
  proto.removeAttribute = function (name) {
    if (name == "whimsy-agent-task" || name == "whimsy-task-tab") {
      diag.push(`remove ${name} ` + new Error().stack.split("\n").slice(0, 10).join(" | "));
    }
    return Element.prototype.removeAttribute.call(this, name);
  };
  const origAddTab = WhimsyAgentTasks.addTab;
  WhimsyAgentTasks.addTab = function (t, tab) {
    diag.push(`addTab ${t.id == undefined ? "?" : t.id.slice(0, 8)} ${tab.linkedBrowser?.currentURI?.spec}`);
    return origAddTab.apply(this, [t, tab]);
  };
  const { task, tabs, folder } = await folderTask(3);
  diag.push(`after folderTask: task ${task.id.slice(0, 8)} size ${task.tabs.size}`);
  await new Promise(r => setTimeout(r, 500));
  WhimsyAgentTasks.addTab = origAddTab;
  if (origRemove) {
    Object.defineProperty(proto, "removeAttribute", origRemove);
  } else {
    delete proto.removeAttribute;
  }
  WhimsyAgentTasks.release = origRelease;
  WhimsyTaskFolder.release = origFolderRelease;
  info(`DIAG releases: ${diag.join(" ### ")}`);
  try {
    await document.l10n.translateRoots();
    await whimsySettled();
    const rect = folder.getBoundingClientRect();
    info(`DIAG task ${task.state} tabs ${task.tabs.size}; members ${[...folder._tabs].length}; ` +
      tabs.map(t => `[conn ${t.isConnected} closing ${!!t.closing} member ${t.hasAttribute("whimsy-task-tab")} task ${t.getAttribute("whimsy-agent-task")} ws ${t.getAttribute("zen-workspace-id")}]`).join(" ") +
      ` active ${gZenWorkspaces.activeWorkspace} folderParent ${folder.parentNode?.className} ${folder.parentNode?.id}`);
    info(`Folder before: connected ${folder.isConnected}, hidden ${folder.hidden}, ${rect.width}x${rect.height}, ` +
      `dissolving ${!!folder._dissolving}, reduced ${matchMedia("(prefers-reduced-motion: reduce)").matches}`);
    let elapsed = 0;
    WhimsyTaskFolder._setDissolveClockForTesting(() => elapsed);
    const end = WhimsyTaskFolder.dissolve(folder, { keep: tabs.slice(0, 2) });
    await TestUtils.waitForCondition(() => !folder.isConnected || folder.hasAttribute("dissolving"), "The dissolve started");
    // Zap's particles, not the no-WebGL fade: these frames are the point.
    is(folder.getAttribute("dissolving"), "zap", "The folder dissolves with Zap's particles");
    for (const ms of [100, 250, 500, 800, 1100]) {
      elapsed = ms;
      await frames();
      await frames();
      await whimsyShot(`w23-agent-tabs-dissolve-mid-${ms}`);
    }
    elapsed = 5000;
    await end;
    ok(!folder.isConnected, "The folder dissolved");
    // Kept tabs, marked, with the moved toast (agent-3.5).
    await whimsyBothSchemes("w23-agent-tabs-kept", async () => {
      await document.l10n.translateRoots();
    });
    ok(tabs.slice(0, 2).every(t => t.hasAttribute("whimsy-agent-opened")), "Kept tabs carry the mark");
  } finally {
    WhimsyAgentTasks.finish(task.id);
    await closeAll(notes, tabs);
  }
});
