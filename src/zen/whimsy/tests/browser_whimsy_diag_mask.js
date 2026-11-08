"use strict";

const { WhimsyAIContext } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIContext.sys.mjs");
const ROOT = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com");
const SENSITIVE = ROOT + "whimsy_ai_sensitive.html";

async function sample(tab) {
  const r = await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
    const b = content.document.getElementById("cc").getBoundingClientRect();
    return { x: b.right - 12, y: b.top + b.height / 2, w: content.innerWidth, h: content.innerHeight };
  });
  const bitmap = await tab.linkedBrowser.browsingContext.currentWindowGlobal.drawSnapshot(null, 1, "white");
  const canvas = document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext("2d").drawImage(bitmap, 0, 0);
  const s = bitmap.width / r.w;
  const d = canvas.getContext("2d").getImageData(Math.round(r.x * s), Math.round(r.y * s), 1, 1).data;
  bitmap.close();
  return `${d[0]},${d[1]},${d[2]} (bitmap ${canvas.width}x${canvas.height}, view ${r.w}x${r.h})`;
}

function state(tab) {
  const b = tab.linkedBrowser;
  return `selected=${tab.selected} active=${b.docShellIsActive} renderLayers=${b.renderLayers} hasLayers=${b.hasLayers}`;
}

add_task(async function diag() {
  const fg = await BrowserTestUtils.openNewForegroundTab(gBrowser, SENSITIVE);
  const bgTab = BrowserTestUtils.addTab(gBrowser, SENSITIVE);
  await BrowserTestUtils.browserLoaded(bgTab.linkedBrowser);
  for (const [name, tab] of [["fg", fg], ["bg", bgTab]]) {
    info(`DIAGM ${name} ${state(tab)} plain=${await sample(tab)}`);
    await WhimsyAIContext.withMask(tab.linkedBrowser, async () => {
      info(`DIAGM ${name} masked=${await sample(tab)}`);
      const anon = await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
        const doc = content.document;
        return `vis=${doc.visibilityState} hidden=${doc.hidden}`;
      });
      info(`DIAGM ${name} ${anon}`);
      await SpecialPowers.spawn(tab.linkedBrowser, [], () => content.document.documentElement.getBoundingClientRect());
      info(`DIAGM ${name} masked-after-flush=${await sample(tab)}`);
    });
    info(`DIAGM ${name} after=${await sample(tab)}`);
    info(`DIAGM ${name} after2=${await sample(tab)}`);
  }
  // A normal DOM box in the background tab, for comparison.
  await SpecialPowers.spawn(bgTab.linkedBrowser, [], () => {
    const doc = content.document;
    const r = doc.getElementById("cc").getBoundingClientRect();
    const box = doc.createElement("div");
    box.id = "diagbox";
    box.style.cssText = `position:fixed;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;background:rgb(118,118,128)`;
    doc.body.appendChild(box);
  });
  info(`DIAGM bg dom-box=${await sample(bgTab)}`);
  await SpecialPowers.spawn(bgTab.linkedBrowser, [], () => content.document.getElementById("diagbox").remove());
  info(`DIAGM bg dom-box-removed=${await sample(bgTab)}`);
  // Anonymous content inserted directly in the child, no actor.
  await SpecialPowers.spawn(bgTab.linkedBrowser, [], () => {
    const doc = content.document;
    const r = doc.getElementById("cc").getBoundingClientRect();
    const a = doc.insertAnonymousContent();
    const box = doc.createElement("div");
    box.style.cssText = `position:fixed;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;background:rgb(118,118,128)`;
    a.root.appendChild(box);
    content.wrappedJSObject.__diagAnon = a;
  });
  info(`DIAGM bg anon-direct=${await sample(bgTab)}`);
  info(`DIAGM bg anon-direct2=${await sample(bgTab)}`);
  await BrowserTestUtils.switchTab(gBrowser, bgTab);
  info(`DIAGM bg-now-fg ${state(bgTab)} anon=${await sample(bgTab)}`);
  BrowserTestUtils.removeTab(bgTab);
  BrowserTestUtils.removeTab(fg);
  ok(true, "diag");
});
