/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Opt in with head = "head.js head-leakcheck.js" in the Whimsy manifest.
// Cleanup is per test FILE, after the file's own cleanup functions.
add_setup(function whimsyLeakcheck() {
  const windows = () => Array.from(Services.wm.getEnumerator(null));
  const label = item => item.id || item.document?.documentURI || item.localName;
  const panels = win => Array.from(win.document.querySelectorAll("panel, menupopup, [popover]"))
    .filter(item => ["open", "showing", "hiding"].includes(item.state) ||
      (item.hasAttribute("popover") && item.matches(":popover-open")));
  const zoom = browser => [browser.fullZoom, browser.textZoom];
  const initialWindows = windows();
  const initialTabs = Array.from(gBrowser.tabs);
  const initialPanels = new Map(initialWindows.map(win => [win, new Set(panels(win))]));
  const initialURIs = new Map(initialTabs.map(tab => [tab, tab.linkedBrowser.currentURI.spec]));
  const initialZoom = new Map(initialTabs.map(tab => [tab, zoom(tab.linkedBrowser)]));
  const initialUIZoom = Services.prefs.getIntPref("whimsy.ui-zoom", 100);
  info(`WHIMSY-LEAKCHECK start ${JSON.stringify({ windows: initialWindows.length, tabs: initialTabs.length })}`);

  registerCleanupFunction(() => registerCleanupFunction(function whimsyAssertNoLeaks() {
    const finalWindows = windows();
    const finalTabs = Array.from(gBrowser.tabs);
    const check = (condition, item) => ok(condition,
      `WHIMSY-LEAKCHECK ${condition ? "restored" : "leaked"} ${item}`);
    check(finalWindows.length == initialWindows.length,
      `window count: start=${initialWindows.length}, end=${finalWindows.length}`);
    for (const win of finalWindows) {
      check(initialWindows.includes(win), `window ${label(win)}`);
      for (const panel of panels(win)) {
        check(initialPanels.get(win)?.has(panel), `panel/popup ${label(panel)} in ${label(win)}`);
      }
    }
    for (const win of initialWindows) {
      check(finalWindows.includes(win), `removed starting window ${label(win)}`);
      for (const panel of initialPanels.get(win)) {
        check(!win.closed && panels(win).includes(panel), `changed starting panel/popup ${label(panel)}`);
      }
    }
    check(finalTabs.length == initialTabs.length,
      `tab count: start=${initialTabs.length}, end=${finalTabs.length}`);
    for (const tab of finalTabs) {
      check(initialTabs.includes(tab), `tab ${tab.label} (${tab.linkedBrowser.currentURI.spec})`);
    }
    for (const tab of initialTabs) {
      check(finalTabs.includes(tab), `removed starting tab ${tab.label}`);
      if (finalTabs.includes(tab)) {
        check(tab.linkedBrowser.currentURI.spec == initialURIs.get(tab),
          `URL for starting tab: start=${initialURIs.get(tab)}, end=${tab.linkedBrowser.currentURI.spec}`);
        check(JSON.stringify(zoom(tab.linkedBrowser)) == JSON.stringify(initialZoom.get(tab)),
          `zoom for ${tab.label}: start=${initialZoom.get(tab)}, end=${zoom(tab.linkedBrowser)}`);
      }
    }
    check(Services.prefs.getIntPref("whimsy.ui-zoom", 100) == initialUIZoom,
      `UI zoom: start=${initialUIZoom}, end=${Services.prefs.getIntPref("whimsy.ui-zoom", 100)}`);
  }));
});
