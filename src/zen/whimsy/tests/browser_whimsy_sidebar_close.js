/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// PROBE (temporary): trace every frame of a ⌘S hide, pointer off and on the bar.

const root = document.documentElement;
const sidebar = () => gZenCompactModeManager.sidebar;
const ATTRS = ["animate", "zen-has-hover", "zen-has-implicit-hover", "flash-popup", "has-popup-menu", "zen-compact-mode-active", "zen-user-show", "zen-has-empty-tab"];

function pressCmdS() {
  const key = document.getElementById("zen-compact-mode-toggle");
  EventUtils.synthesizeKey(key.getAttribute("key").toLowerCase(), { accelKey: true });
}

function snapshot(frame) {
  const el = sidebar();
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  const attrs = ATTRS.filter(a => el.hasAttribute(a)).join(",");
  return `f${frame} L${Math.round(r.left)} R${Math.round(r.right)} pos=${cs.position} tr=${cs.translate} ml=${cs.marginLeft} anim=${el.getAnimations().length} hover=${el.matches(":hover")} root=${root.hasAttribute("zen-compact-animating") ? "A" : ""}${root.getAttribute("zen-compact-mode")} ign=${!!gZenCompactModeManager._ignoreNextHover} [${attrs}]`;
}

async function trace(label, frames = 60) {
  const log = [];
  let frame = 0;
  const mo = new MutationObserver(records => {
    for (const rec of records) {
      log.push(`  mut@f${frame} ${rec.target.id || "root"}.${rec.attributeName}=${rec.target.getAttribute(rec.attributeName)}`);
    }
  });
  mo.observe(sidebar(), { attributes: true, attributeFilter: [...ATTRS, "style"] });
  mo.observe(root, { attributes: true, attributeFilter: ["zen-compact-animating", "zen-compact-mode"] });
  log.push(snapshot("pre"));
  pressCmdS();
  log.push(snapshot("key"));
  while (frame < frames) {
    await new Promise(r => requestAnimationFrame(r));
    frame++;
    log.push(snapshot(frame));
  }
  mo.disconnect();
  const out = log.join("\n");
  for (let i = 0; i < log.length; i += 15) {
    ok(false, `TRACE ${label} ${i}:\n${log.slice(i, i + 15).join("\n")}`);
  }
  return out;
}

async function showSidebar() {
  if (gZenCompactModeManager.preference) {
    gZenCompactModeManager.preference = false;
  }
  await TestUtils.waitForCondition(() => !gZenCompactModeManager.preference && !root.hasAttribute("zen-compact-animating"), "Sidebar shown");
  await new Promise(r => setTimeout(r, 600));
}

add_task(async function probe() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["zen.view.compact.animate-sidebar", true],
      ["zen.view.compact.hide-tabbar", true],
      ["zen.view.compact.enable-at-startup", false],
    ],
  });
  const page = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/");
  delete gZenCompactModeManager._wasInCompactMode;
  await showSidebar();

  // Pointer over the page.
  EventUtils.synthesizeMouseAtCenter(gBrowser.selectedBrowser, { type: "mousemove" });
  await trace("off-bar");

  await showSidebar();
  // Pointer over the bar.
  EventUtils.synthesizeMouseAtCenter(gBrowser.selectedTab, { type: "mousemove" });
  await TestUtils.waitForCondition(() => sidebar().hasAttribute("zen-has-hover"), "hovered");
  await trace("on-bar");

  await showSidebar();
  BrowserTestUtils.removeTab(page);
  await SpecialPowers.popPrefEnv();
});
