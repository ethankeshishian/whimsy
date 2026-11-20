/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W29 (owner: "auto dark mode makes google grey when google is dark mode
// sometimes ... also, emoji text is inverted strangely"). A dark page stays
// in its own theme when a light popup floats over it or when only its
// color-scheme makes it dark, and emoji images keep their colours.

Services.scriptloader.loadSubScript(getRootDirectory(gTestPath) + "head_whimsy_dark_pages.js", this);

const page = html => "https://example.com/document-builder.sjs?html=" + encodeURIComponent(`<!doctype html><meta charset="utf-8">${html}`);

function paintedAt(browser, selector) {
  return SpecialPowers.spawn(browser, [selector], sel => {
    const canvas = content.document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
    canvas.width = content.innerWidth;
    canvas.height = content.innerHeight;
    const ctx = canvas.getContext("2d");
    ctx.drawWindow(content, 0, 0, canvas.width, canvas.height, "white");
    const rect = content.document.querySelector(sel).getBoundingClientRect();
    return [...ctx.getImageData(Math.round(rect.x + rect.width / 2), Math.round(rect.y + rect.height / 2), 1, 1).data].slice(0, 3);
  });
}

async function stillAfterAFrame(browser, expected) {
  await SpecialPowers.spawn(browser, [], () => new Promise(r => content.requestAnimationFrame(() => content.requestAnimationFrame(r))));
  await darkState(browser, expected);
}

add_task(async function light_popup_over_a_dark_page() {
  const url = page(`<style>:root { color-scheme: light dark; }
    @media (prefers-color-scheme: dark) { html { background: #1f1f1f; color: #e8eaed; } }
    body { margin: 0; font: 16px system-ui; } main { height: 3000px; padding: 40px; }
    #popup { position: fixed; inset: 10% 15%; background: #fff; color: #222; padding: 20px; display: none; }</style>
    <main id="results">Results</main><div id="popup">Sign in</div>`);
  await BrowserTestUtils.withNewTab(url, async browser => {
    await darkState(browser, "native");
    await SpecialPowers.spawn(browser, [], () => { content.document.getElementById("popup").style.display = "block"; });
    await stillAfterAFrame(browser, "native");
    ok(Math.max(...await paintedAt(browser, "#results")) < 60, "The page keeps its own dark background");
    Assert.deepEqual(await paintedAt(browser, "#popup"), [255, 255, 255], "The popup keeps its own colours");
  });
});

// W29 (owner: "clicking on the color of the popup in figjam, and ...
// expanding the results in google, changes"). Once the page has settled,
// content opening over it never flips it; its own theme change still does.
add_task(async function settled_page_keeps_its_mode() {
  const url = page(`<style>body { margin: 0; font: 16px system-ui; } main { height: 3000px; }
    #panel { position: absolute; inset: 0 0 auto 0; height: 2000px; background: #111; color: #eee; display: none; }
    html.night { background: #181a20; color: #ddd; }</style>
    <main>Results</main><div id="panel">Expanded</div>`);
  await BrowserTestUtils.withNewTab(url, async browser => {
    await darkState(browser, "generated");
    // Past the settling time.
    await SpecialPowers.spawn(browser, [], () => new Promise(r => content.setTimeout(r, 3500)));
    await SpecialPowers.spawn(browser, [], () => { content.document.getElementById("panel").style.display = "block"; });
    await stillAfterAFrame(browser, "generated");
    await SpecialPowers.spawn(browser, [], () => { content.document.getElementById("panel").style.display = "none"; });
    await stillAfterAFrame(browser, "generated");
    // The page's own theme switch still counts.
    await SpecialPowers.spawn(browser, [], () => { content.document.documentElement.className = "night"; });
    await darkState(browser, "native");
  });
});

add_task(async function dark_only_through_color_scheme() {
  for (const html of [`<meta name="color-scheme" content="dark light"><p id="p">Hello</p>`,
                      `<style>:root { color-scheme: dark; }</style><p id="p">Hello</p>`]) {
    await BrowserTestUtils.withNewTab(page(html), async browser => {
      await darkState(browser, "native");
      ok(Math.max(...await paintedAt(browser, "body")) < 60, "The page's dark canvas isn't inverted");
    });
  }
  await BrowserTestUtils.withNewTab(page(`<p id="p">Hello</p>`), async browser => {
    await darkState(browser, "generated");
  });
});

add_task(async function emoji_images_keep_their_colours() {
  const svg = fill => "data:image/svg+xml," + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="${fill}"/></svg>`);
  const url = page(`<style>img { width: 40px; height: 40px; display: block; }</style>
    <img id="emoji" alt="&#x1F600;" src="${svg("#ffcc4d")}">
    <img id="family" alt="&#x1F468;&#x200D;&#x1F469;&#x200D;&#x1F467;" src="${svg("#ffcc4d")}">
    <img id="heart" alt="&#x2764;&#xFE0F;" src="${svg("#ffcc4d")}">
    <img id="icon" alt="Search" src="${svg("#202124")}">
    <img id="digit" alt="1" src="${svg("#202124")}">`);
  await BrowserTestUtils.withNewTab(url, async browser => {
    await darkState(browser, "generated");
    for (const id of ["#emoji", "#family", "#heart"]) {
      Assert.deepEqual(await paintedAt(browser, id), [255, 204, 77], `${id}: an emoji image keeps its colours`);
    }
    for (const id of ["#icon", "#digit"]) {
      ok(Math.min(...await paintedAt(browser, id)) > 150, `${id}: a dark icon is still lightened`);
    }
  });
});
