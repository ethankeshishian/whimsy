/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W23 agent-tabs: SPIKE (temporary). Native tab-group among unpinned tabs vs
// a Whimsy header row, plus Zap's dissolve in the chrome document.

add_task(async function spike_native_group_among_unpinned() {
  const a = BrowserTestUtils.addTab(gBrowser, "about:blank", { skipAnimation: true });
  const b = BrowserTestUtils.addTab(gBrowser, "about:blank", { skipAnimation: true });
  const c = BrowserTestUtils.addTab(gBrowser, "about:blank", { skipAnimation: true });
  let group = null;
  let err = "";
  try {
    group = gBrowser.addTabGroup([b, c], { insertBefore: b, color: "orange", label: "Spike" });
  } catch (e) {
    err = String(e);
  }
  info(`SPIKE addTabGroup error=${err} group=${!!group} local=${group?.localName} isZenFolder=${!!group?.isZenFolder}`);
  if (group) {
    const label = group.querySelector(".tab-group-label-container");
    const lr = label?.getBoundingClientRect();
    const br = b.getBoundingClientRect();
    info(`SPIKE parent=${group.parentElement?.className} labelRect=${lr?.width}x${lr?.height}@${lr?.top} tabB=${br.width}x${br.height}@${br.left} tabA=${a.getBoundingClientRect().left}`);
    info(`SPIKE display=${getComputedStyle(group).display} labelDisplay=${label && getComputedStyle(label).display} pinned=${group.pinned} tabsLen=${group.tabs.length} tabGroupMenu=${!!gBrowser.tabGroupMenu}`);
    group.collapsed = true;
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    info(`SPIKE collapsed: bVisible=${b.getBoundingClientRect().height} cVisible=${c.getBoundingClientRect().height} bHidden=${b.hidden}`);
    const d = BrowserTestUtils.addTab(gBrowser, "about:blank", { skipAnimation: true });
    info(`SPIKE newTab after group? ${d.previousElementSibling == group} dGroup=${!!d.group}`);
    try {
      const state = JSON.parse(SessionStore.getWindowState(window));
      info(`SPIKE session groups=${JSON.stringify(state.windows[0].groups?.map(g => g.name))}`);
    } catch (e) {
      info(`SPIKE session err ${e}`);
    }
    if (WHIMSY_SHOTS_DIR) {
      group.collapsed = false;
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      await whimsyShot("w23-agent-tabs-spike-native");
    }
    gBrowser.removeTab(d);
    gBrowser.ungroupTabs?.(group);
  }
  for (const t of [a, b, c]) {
    if (t.isConnected) {
      gBrowser.removeTab(t);
    }
  }
  ok(true, "spike ran");
});

add_task(async function spike_header_row_and_dissolve() {
  const a = BrowserTestUtils.addTab(gBrowser, "about:blank", { skipAnimation: true });
  const b = BrowserTestUtils.addTab(gBrowser, "about:blank", { skipAnimation: true });
  const row = document.createXULElement("hbox");
  row.className = "whimsy-spike-row";
  row.style.cssText = "height:44px;background:rgb(217,119,87);border-radius:8px;margin:2px 0;";
  b.before(row);
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  const rr = row.getBoundingClientRect();
  info(`SPIKE row=${rr.width}x${rr.height}@${rr.left},${rr.top} b=${b.getBoundingClientRect().top} allTabs=${gBrowser.tabs.length}`);
  const { ZapDissolve } = ChromeUtils.importESModule("resource:///modules/zen/boosts/ZenZapDissolve.sys.mjs");
  const fx = new ZapDissolve(document);
  let initErr = "";
  try {
    await fx.initialize();
  } catch (e) {
    initErr = String(e);
  }
  info(`SPIKE dissolve init err=${initErr}`);
  let done = false;
  const started = Date.now();
  fx.dissolve(row, () => (done = true));
  row.style.visibility = "hidden";
  await new Promise(r => setTimeout(r, 300));
  await whimsyShot("w23-agent-tabs-spike-dissolve-300");
  await TestUtils.waitForCondition(() => done, "dissolve completed", 100, 50).catch(() => {});
  info(`SPIKE dissolve done=${done} after ${Date.now() - started}ms`);
  fx.tearDown();
  row.remove();
  gBrowser.removeTab(a);
  gBrowser.removeTab(b);
  ok(true, "spike ran");
});
