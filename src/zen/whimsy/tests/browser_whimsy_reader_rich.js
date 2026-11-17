/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// A local encyclopedia-shaped article; no live site or remote assets.
const ARTICLE = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com") + "whimsy_reader_rich.html";

add_task(async function rich_article_content_and_layout() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.reader.bionic", false]] });
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:reader?url=" + encodeURIComponent(ARTICLE));
  try {
    await SpecialPowers.spawn(tab.linkedBrowser, [], async () => {
      const doc = content.document;
      await ContentTaskUtils.waitForCondition(() => doc.body.classList.contains("loaded"), "Reader article loaded");
      const root = doc.querySelector(".moz-reader-content");
      Assert.ok(root.textContent.includes("Observatory facts"), "Infobox survives unlikely-candidate cleanup");
      Assert.ok(root.querySelector("table th"), "Data headers remain semantic table headers");
      Assert.ok(root.querySelector("figure img"), "Figure image survives");
      Assert.equal(root.querySelector("figcaption")?.textContent, "Measured orbital paths.", "Caption stays with figure");
      const math = root.querySelector("math");
      Assert.ok(math, "Native MathML survives extraction");
      Assert.ok(math?.getBoundingClientRect().width > 0, "MathML is rendered");
      Assert.equal(root.querySelectorAll("img[alt='E=mc²']").length, 0, "Native math has no duplicate fallback");
      const fallback = root.querySelector("img[alt='a²+b²=c²']");
      Assert.ok(fallback, "Image-only formula remains");
      Assert.ok(!fallback?.hasAttribute("aria-hidden"), "Image-only formula is accessible");
      Assert.ok(root.querySelector("#cite_ref-1 a"), "Footnote marker remains");
      Assert.ok(root.querySelector("#cite_note-1 cite"), "Reference list remains");
      const ref = root.querySelector("#cite_ref-1 a");
      Assert.equal(new content.URL(ref.href).protocol, "about:", "Footnotes stay inside Reader View");
      Assert.equal(new content.URL(ref.href).hash, "#cite_note-1", "Footnote still targets reference");
      for (const clutter of ["For other uses", "Edit section", "Edit article", "Related navigation catalogue"]) {
        Assert.ok(!root.textContent.includes(clutter), `${clutter} is removed`);
      }
      // Narrow the article independently of the browser window, then change it
      // again: overflow containment must survive layout/font/width changes.
      for (const width of [320, 520]) {
        root.style.width = `${width}px`;
        root.style.maxWidth = "100%";
        for (const table of root.querySelectorAll("table")) {
          const box = table.parentElement;
          Assert.equal(content.getComputedStyle(box).overflowX, "auto", "Every table has a scroll container");
          Assert.ok(box.getBoundingClientRect().width <= width + 1, "Table viewport stays inside article");
        }
        const catalogue = [...root.querySelectorAll("table")].find(table => table.caption?.textContent == "Observation catalogue");
        Assert.ok(catalogue, "The catalogue table survives");
        const scroller = catalogue.parentElement;
        Assert.ok(scroller.scrollWidth > scroller.clientWidth, "Wide data scrolls inside its container");
        scroller.scrollLeft = 100;
        Assert.ok(scroller.scrollLeft > 0, "Offscreen columns can be reached");
        Assert.ok(doc.documentElement.scrollWidth <= doc.documentElement.clientWidth + 1, "Wide table never scrolls the page");
      }
    });
  } finally {
    BrowserTestUtils.removeTab(tab);
  }
});

add_task(async function guided_reading_preserves_mathml() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.bionic-reading", true], ["whimsy.reader.bionic", true]] });
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:reader?url=" + encodeURIComponent(ARTICLE));
  try {
    await SpecialPowers.spawn(tab.linkedBrowser, [], async () => {
      const doc = content.document;
      await ContentTaskUtils.waitForCondition(() => doc.querySelector(".whimsy-bionic-word"), "Guided reading applied");
      const math = doc.querySelector(".moz-reader-content math");
      Assert.ok(math, "Formula remains with guided reading enabled");
      Assert.equal(math?.querySelectorAll(".whimsy-bionic-word").length, 0, "Guided reading never inserts HTML into MathML");
      Assert.equal(math?.querySelector("mi")?.textContent, "E", "Math identifier stays intact");
    });
  } finally {
    BrowserTestUtils.removeTab(tab);
  }
});

add_task(async function reader_rich_screenshots() {
  if (!WHIMSY_SHOTS_DIR) {
    return;
  }
  for (const scheme of ["light", "dark"]) {
    await SpecialPowers.pushPrefEnv({ set: [["reader.color_scheme", scheme], ["whimsy.reader.bionic", false]] });
    const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:reader?url=" + encodeURIComponent(ARTICLE));
    try {
      await SpecialPowers.spawn(tab.linkedBrowser, [scheme], async wanted => {
        const doc = content.document;
        await ContentTaskUtils.waitForCondition(() => doc.body.classList.contains("loaded") && doc.body.classList.contains(wanted), "Reader is ready in the requested theme");
        await Promise.all([...doc.images].map(img => img.decode().catch(() => {})));
      });
      await whimsyShot(`reader-rich-${scheme}`, tab.linkedBrowser.browsingContext.currentWindowGlobal);
    } finally {
      BrowserTestUtils.removeTab(tab);
      await SpecialPowers.popPrefEnv();
    }
  }
});
