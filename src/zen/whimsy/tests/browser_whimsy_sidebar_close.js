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


// Logs a frame only when its state changes. `jitter` moves the pointer by a
// pixel each frame, as a resting hand does; `repeatAt` sends a second key
// press (auto-repeat) at that frame.
async function trace(label, { frames = 50, jitter = null, repeatAt = 0 } = {}) {
  const log = [];
  let frame = 0;
  let last = "";
  const mo = new MutationObserver(records => {
    for (const rec of records) {
      log.push(`  mut@f${frame} ${rec.target.id || "root"}.${rec.attributeName}=${rec.target.getAttribute(rec.attributeName)}`);
    }
  });
  mo.observe(sidebar(), { attributes: true, attributeFilter: ATTRS });
  mo.observe(root, { attributes: true, attributeFilter: ["zen-compact-animating", "zen-compact-mode"] });
  let toggles = 0;
  const realToggle = gZenCompactModeManager.toggle;
  gZenCompactModeManager.toggle = function (...args) {
    toggles++;
    log.push(`  toggle(${args}) @f${frame} pref=${this.preference}`);
    return realToggle.apply(this, args);
  };
  log.push(snapshot("pre"));
  pressCmdS();
  while (frame < frames) {
    await new Promise(r => requestAnimationFrame(r));
    frame++;
    if (jitter) {
      EventUtils.synthesizeMouse(root, jitter.x + (frame % 2), jitter.y, { type: "mousemove" });
    }
    if (repeatAt && frame == repeatAt) {
      pressCmdS();
    }
    const snap = snapshot(frame);
    const key = snap.replace(/^f\d+ /, "");
    if (key != last) {
      log.push(snap);
      last = key;
    }
  }
  gZenCompactModeManager.toggle = realToggle;
  mo.disconnect();
  log.push(`toggles=${toggles}`);
  for (let i = 0; i < log.length; i += 20) {
    ok(false, `TRACE ${label} ${i}:\n${log.slice(i, i + 20).join("\n")}`);
  }
}

async function showSidebar() {
  EventUtils.synthesizeMouseAtCenter(gBrowser.selectedBrowser, { type: "mousemove" });
  if (gZenCompactModeManager.preference) {
    gZenCompactModeManager.preference = false;
  }
  await TestUtils.waitForCondition(() => !gZenCompactModeManager.preference && !root.hasAttribute("zen-compact-animating"), "Sidebar shown");
  await new Promise(r => setTimeout(r, 600));
}

function pointAt(x) {
  const r = sidebar().getBoundingClientRect();
  return { x: r.left + x, y: r.top + r.height / 2 };
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
  for (const x of [3, 30, 115, 200]) {
    for (const jit of [false, true]) {
      await showSidebar();
      const p = pointAt(x);
      EventUtils.synthesizeMouse(root, p.x, p.y, { type: "mousemove" });
      await TestUtils.waitForCondition(() => sidebar().hasAttribute("zen-has-hover"), "hovered");
      await trace(`x${x}${jit ? "-jitter" : ""}`, { jitter: jit ? p : null });
    }
  }
  await showSidebar();
  await trace("repeat-f4", { repeatAt: 4 });
  await showSidebar();
  await trace("repeat-f30", { repeatAt: 30 });
  await showSidebar();
  BrowserTestUtils.removeTab(page);
  await SpecialPowers.popPrefEnv();
});
