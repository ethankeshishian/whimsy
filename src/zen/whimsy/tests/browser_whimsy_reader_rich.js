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
      // Reader shows .moz-reader-content with display: initial (inline), so
      // setting its width has no effect. Resize its block containing element.
      const article = root.closest(".content");
      for (const width of [320, 520]) {
        article.style.width = `${width}px`;
        article.style.maxWidth = "100%";
        const articleRect = article.getBoundingClientRect();
        Assert.ok(Math.abs(articleRect.width - width) <= 1, `Article actually lays out at ${width}px (got ${articleRect.width})`);
        const pre = root.querySelector("pre");
        Assert.ok(pre, "Preformatted code survives extraction");
        Assert.equal(content.getComputedStyle(pre).overflowX, "auto", "Code has its own scroll box");
        const codeScroller = pre.querySelector("code");
        Assert.ok(pre.scrollWidth > pre.clientWidth || codeScroller.scrollWidth > codeScroller.clientWidth,
          "Long code remains preformatted and scrolls internally");
        const wideImage = root.querySelector("img[alt='Wide orbit diagram']");
        Assert.ok(wideImage, "Oversized media survives extraction");
        Assert.ok(wideImage.getBoundingClientRect().width <= width, "Oversized media scales to the article");
        // Upstream highlight/narration boxes bleed 10px into the page padding;
        // allow another pixel for layout rounding, as with the page check.
        for (const element of root.querySelectorAll("p, pre, figure, blockquote, ul, ol, li, math")) {
          const rect = element.getBoundingClientRect();
          Assert.ok(rect.left >= articleRect.left - 11 && rect.right <= articleRect.right + 11,
            `${element.localName} stays within the article’s 10px highlight bleed at ${width}px: left=${rect.left}, right=${rect.right}, article left=${articleRect.left}, right=${articleRect.right}`);
        }
        for (const table of root.querySelectorAll("table")) {
          const box = table.parentElement;
          const boxRect = box.getBoundingClientRect();
          Assert.equal(content.getComputedStyle(box).overflowX, "auto", "Every table has a scroll container");
          Assert.ok(boxRect.width <= width + 1, "Table viewport stays inside article");
          Assert.ok(boxRect.left >= articleRect.left - 1 && boxRect.right <= articleRect.right + 1, "Table viewport edges stay inside article");
        }
        const catalogue = [...root.querySelectorAll("table")].find(table => table.caption?.textContent == "Observation catalogue");
        Assert.ok(catalogue, "The catalogue table survives");
        const scroller = catalogue.parentElement;
        Assert.ok(scroller.scrollWidth > scroller.clientWidth, "Wide data scrolls inside its container");
        scroller.scrollLeft = 100;
        Assert.ok(scroller.scrollLeft > 0, "Offscreen columns can be reached");
        // Descendants inside intentional scroll boxes may extend beyond the
        // article, but only their clipped viewport contributes to its overflow.
        const widest = [...article.querySelectorAll("*")].map(element => {
          let right = element.getBoundingClientRect().right;
          // Unwrapped text can overflow a block whose own border box fits.
          if (content.getComputedStyle(element).overflowX == "visible") {
            for (const node of element.childNodes) {
              if (node.nodeType == content.Node.TEXT_NODE && node.textContent.trim()) {
                const range = doc.createRange();
                range.selectNodeContents(node);
                right = Math.max(right, range.getBoundingClientRect().right);
              }
            }
          }
          let visibleRight = right;
          let depth = 0;
          for (let parent = element.parentElement; parent && parent != article; parent = parent.parentElement) {
            depth++;
            if (content.getComputedStyle(parent).overflowX != "visible") {
              visibleRight = Math.min(visibleRight, parent.getBoundingClientRect().right);
            }
          }
          return { element, right, visibleRight, depth };
        }).sort((a, b) => b.visibleRight - a.visibleRight || b.depth - a.depth)[0];
        const offender = widest
          ? `${widest.element.localName} class="${widest.element.getAttribute("class") || ""}" right=${widest.right.toFixed(2)} (after scroll clipping=${widest.visibleRight.toFixed(2)})`
          : "no descendants";
        Assert.ok(!widest || widest.visibleRight <= articleRect.right + 11,
          `No descendant exceeds the article’s 10px highlight bleed at ${width}px: article right=${articleRect.right.toFixed(2)}; widest descendant: ${offender}`);
        const page = doc.scrollingElement;
        Assert.ok(page.scrollWidth <= page.clientWidth + 1,
          `Reader document never scrolls horizontally at ${width}px: scrollWidth=${page.scrollWidth}, clientWidth=${page.clientWidth}; widest descendant: ${offender}`);
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
