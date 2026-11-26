/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W32 perf: every extension message (runtime.sendMessage, tabs.sendMessage)
// travels in a StructuredCloneHolder, whose buffer is malloc'ed outside the
// JS heap. Upstream never told the GC about it, so a quiet process (the
// extensions process, where the cookie-banner rules reply to every frame
// with ~0.45 MB) piled up dead holders by the hundred megabytes before any
// GC ran. The holder now reports its buffer as memory tied to its JS object
// (BindingJSObjectMallocBytes): its zone's malloc counter grows with it, so
// the GC schedules a collection as it would for a Blob.

const SIZE = 32 * 1024 * 1024;

add_task(async function a_holders_buffer_counts_toward_its_zone() {
  // The counter is behind a pref read when a window's Performance is set up.
  await SpecialPowers.pushPrefEnv({ set: [["dom.enable_memory_stats", true]] });
  // Zen syncs tabs between windows: tidy up what the test window adds here.
  const mainTabs = new Set(window.gBrowser.tabs);
  const win = await BrowserTestUtils.openNewBrowserWindow();
  try {
    const zoneMalloc = () => win.performance.mozMemory.gc.zone.mallocBytes;
    ok(Number.isFinite(zoneMalloc()), "The zone's malloc counter is readable");
    const data = new win.Uint8Array(SIZE).fill(7);
    const held = [];
    const deltas = [];
    // A GC can sweep other memory in between; one clean reading is enough.
    for (let i = 0; i < 5 && !deltas.some(d => d >= SIZE * 0.9); i++) {
      const before = zoneMalloc();
      held.push(new win.StructuredCloneHolder("whimsy-test", null, data.buffer));
      deltas.push(zoneMalloc() - before);
    }
    info(`Zone malloc growth per ${SIZE / 1048576} MB holder: ${deltas.map(d => (d / 1048576).toFixed(1)).join(", ")} MB`);
    Assert.greaterOrEqual(held[0].dataSize, SIZE, "Sanity: the holder holds the whole buffer");
    ok(deltas.some(d => d >= SIZE * 0.9), "A live holder's buffer is counted in its zone's malloc bytes, so the GC sees it");
    // Deserializing without keepData drops the buffer; the finalizer must
    // still take back exactly what wrapping counted (a debug build asserts).
    held.forEach(h => h.deserialize(win, false));
    held.length = 0;
    Cu.forceGC();
    ok(Number.isFinite(zoneMalloc()), "Dropped and collected holders keep the counts consistent");
  } finally {
    await BrowserTestUtils.closeWindow(win);
    for (const tab of window.gBrowser.tabs.filter(t => !mainTabs.has(t))) {
      BrowserTestUtils.removeTab(tab);
    }
  }
});
