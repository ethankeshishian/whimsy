/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W24 annotations: page highlights in four colors, passage notes, one
// editable note per page, revisit cue in the address bar, re-anchoring
// across reload and small DOM edits, Fire integration ("Notes and
// highlights"), and private browsing isolation.

const { WhimsyAnnotations, ANNOTATION_COLORS } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyAnnotations.sys.mjs"
);
const { WhimsyFireButton } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyFireButton.sys.mjs"
);
const { WhimsySurface } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsySurface.sys.mjs"
);
const { WhimsyVerbs } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyVerbs.sys.mjs"
);
const { gWhimsyNotesStore } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyNotesSection.sys.mjs"
);

const TEST_URL = "https://example.com/?w24-annotations";

const ARTICLE_HTML = `
  <!doctype html>
  <html>
    <head>
      <meta charset="utf-8">
      <title>Local-first software — Ink &amp; Switch</title>
      <style>
        body {
          font-family: -apple-system, sans-serif;
          max-width: 640px;
          margin: 32px auto;
          line-height: 1.6;
          padding: 0 20px;
        }
        p { margin: 14px 0; }
      </style>
    </head>
    <body>
      <article id="article">
        <p id="p1">In local-first software, the availability of another computer should never prevent you from working.</p>
        <p id="p2">You own your data, in perpetuity, on your own drive with fast local copies.</p>
        <p id="p3">Collaboration happens peer-to-peer with conflict-free replicated data types.</p>
        <p id="p4">Archives remain readable decades later without depending on a cloud server.</p>
      </article>
      <textarea id="editor">Editable field text</textarea>
    </body>
  </html>
`;

async function loadArticle(browser, html = ARTICLE_HTML) {
  await SpecialPowers.spawn(browser, [html], contentHtml => {
    // document.write() uses the caller's principal; the SpecialPowers
    // sandbox cannot open a web document's parser. Import a parsed fixture
    // into the existing document so its URL and actor remain unchanged.
    const doc = content.document;
    const parsed = new content.DOMParser().parseFromString(contentHtml, "text/html");
    doc.documentElement.replaceChildren(
      ...Array.from(parsed.documentElement.children, node => doc.importNode(node, true))
    );
  });
  await WhimsyAnnotations.restoreForBrowser(browser, {
    url: browser.currentURI.spec,
    title: "Local-first software — Ink & Switch",
  });
}

async function selectInElement(browser, selector, substring = null) {
  return SpecialPowers.spawn(
    browser,
    [selector, substring],
    (selStr, sub) => {
      const el = content.document.querySelector(selStr);
      const doc = content.document;
      const win = content;
      const selection = win.getSelection();
      selection.removeAllRanges();
      const range = doc.createRange();
      const textNode = el.firstChild;
      if (sub && textNode?.nodeType === 3) {
        const full = textNode.nodeValue;
        const idx = full.indexOf(sub);
        if (idx >= 0) {
          range.setStart(textNode, idx);
          range.setEnd(textNode, idx + sub.length);
          selection.addRange(range);
          return selection.toString();
        }
      }
      range.selectNodeContents(el);
      selection.addRange(range);
      return selection.toString();
    }
  );
}

async function getRenderedMarks(browser) {
  return SpecialPowers.spawn(browser, [], () => {
    return Array.from(
      content.document.querySelectorAll("mark.whimsy-annotation-mark")
    ).map(m => ({
      id: m.getAttribute("data-whimsy-highlight-id"),
      color: m.getAttribute("data-color"),
      hasNote: m.getAttribute("data-has-note") === "true",
      text: m.textContent,
    }));
  });
}

async function openContextMenuOn(browser, selector) {
  const menu = document.getElementById("contentAreaContextMenu");
  const shown = BrowserTestUtils.waitForEvent(menu, "popupshown");
  await BrowserTestUtils.synthesizeMouseAtCenter(
    selector,
    { type: "contextmenu", button: 2 },
    browser
  );
  await shown;
  return menu;
}

async function closeContextMenu(menu) {
  if (menu.state === "closed") {
    return;
  }
  const hidden = BrowserTestUtils.waitForEvent(menu, "popuphidden");
  menu.hidePopup();
  await hidden;
}

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["whimsy.feature.annotations", true],
      ["whimsy.feature.selection-verbs", true],
    ],
  });
  WhimsyAnnotations.init();
  WhimsyAnnotations.initWindow(window);
  await WhimsyAnnotations.resetForTests();

  registerCleanupFunction(async () => {
    await WhimsyAnnotations.resetForTests();
  });
});

add_task(async function test_highlight_context_menu_and_cmdk_four_colors() {
  await WhimsyAnnotations.resetForTests();
  const btn = document.getElementById("whimsy-annotations-button");
  ok(btn, "The address-bar annotations button exists");

  await BrowserTestUtils.withNewTab(TEST_URL, async browser => {
    await loadArticle(browser);
    ok(btn.hidden, "The address-bar icon is hidden when the page has no highlights or note");

    // 1. Highlight via context menu (default yellow)
    await selectInElement(browser, "#p1", "availability of another computer");
    const menu = await openContextMenuOn(browser, "#p1");
    const hlItem = document.getElementById("context-whimsy-highlight");
    const addNoteItem = document.getElementById("context-whimsy-add-note");
    ok(hlItem && !hlItem.hidden, "Highlight row is visible in the selection context menu");
    ok(addNoteItem && !addNoteItem.hidden, "Add Note… row is visible in the selection context menu");
    await closeContextMenu(menu);

    // Trigger context menu command for Highlight (yellow)
    hlItem.doCommand();
    await TestUtils.waitForCondition(
      async () => (await getRenderedMarks(browser)).length === 1,
      "First highlight rendered on page in yellow"
    );
    let marks = await getRenderedMarks(browser);
    is(marks[0].color, "yellow", "Default highlight color is yellow");
    is(marks[0].text, "availability of another computer", "Highlighted the selected quote");
    ok(!btn.hidden, "Address-bar icon becomes visible once a highlight exists");

    // 2. Highlight via ⌘K selection verbs in green, blue, and pink
    await selectInElement(browser, "#p2", "You own your data");
    const greenSubject = await WhimsyVerbs.subjectFor(window);
    is(greenSubject.kind, "selection", "⌘K captures the green passage as a selection");
    ok(await WhimsyVerbs.runVerb(window, "highlight-green", greenSubject),
      "⌘K executes the green highlight verb");
    await TestUtils.waitForCondition(
      async () => (await getRenderedMarks(browser)).length === 2,
      "Green highlight added via ⌘K"
    );

    await selectInElement(browser, "#p3", "peer-to-peer");
    const blueSubject = await WhimsyVerbs.subjectFor(window);
    is(blueSubject.kind, "selection", "⌘K captures the blue passage as a selection");
    ok(await WhimsyVerbs.runVerb(window, "highlight-blue", blueSubject),
      "⌘K executes the blue highlight verb");
    await TestUtils.waitForCondition(
      async () => (await getRenderedMarks(browser)).length === 3,
      "Blue highlight added via ⌘K"
    );

    await selectInElement(browser, "#p4", "readable decades later");
    WhimsyAnnotations.lastColor = "pink";
    const pinkSubject = await WhimsyVerbs.subjectFor(window);
    is(pinkSubject.kind, "selection", "⌘K captures the pink passage as a selection");
    ok(await WhimsyVerbs.runVerb(window, "highlight", pinkSubject),
      "⌘K executes the default highlight verb");
    await TestUtils.waitForCondition(
      async () => (await getRenderedMarks(browser)).length === 4,
      "Pink highlight added via ⌘K default verb"
    );

    marks = await getRenderedMarks(browser);
    Assert.deepEqual(
      marks.map(m => m.color),
      ["yellow", "green", "blue", "pink"],
      "All four highlight colors (yellow, green, blue, pink) render on the page"
    );
    Assert.deepEqual(ANNOTATION_COLORS, ["yellow", "green", "blue", "pink"], "Four colors registered");

    // 3. Recolor and add a passage note from the highlight's WhimsySurface popover
    const firstId = marks[0].id;
    const popover = await WhimsyAnnotations.openHighlightPopover(window, {
      browser,
      highlightId: firstId,
    });
    await BrowserTestUtils.waitForPopupEvent(popover, "shown");
    ok(popover.classList.contains("whimsy-surface"), "Highlight popover is a WhimsySurface");

    const greenSwatch = popover.querySelector('.whimsy-annotation-swatch[data-color="green"]');
    greenSwatch.click();
    await TestUtils.waitForCondition(
      async () => (await getRenderedMarks(browser))[0]?.color === "green",
      "Clicking swatch in popover recolors the highlight"
    );

    const noteInput = popover.querySelector(".whimsy-annotation-note-input");
    noteInput.value = "Key principle of local-first.";
    const saveBtn = popover.querySelector(".whimsy-annotation-save");
    const hidden = BrowserTestUtils.waitForPopupEvent(popover, "hidden");
    saveBtn.click();
    await hidden;

    marks = await getRenderedMarks(browser);
    ok(marks[0].hasNote, "Saved passage note marks the highlight with data-has-note");
  });
});

add_task(async function test_persist_across_reload_and_reanchor_after_dom_change() {
  await BrowserTestUtils.withNewTab(TEST_URL, async browser => {
    // 1. Reload / revisit with identical DOM restores all 4 highlights
    await loadArticle(browser);
    await TestUtils.waitForCondition(
      async () => (await getRenderedMarks(browser)).length === 4,
      "All 4 highlights persist across reload"
    );
    let marks = await getRenderedMarks(browser);
    is(marks[0].text, "availability of another computer", "First quote restored");
    ok(marks[0].hasNote, "Passage note persisted across reload");

    // 2. Small DOM change (extra banner paragraph inserted at top, #p4 removed)
    const modifiedHtml = `
      <!doctype html>
      <html>
        <head><meta charset="utf-8"><title>Local-first software — Ink &amp; Switch</title></head>
        <body>
          <div class="banner">Updated banner inserted above the article shifting offsets by 75 chars!</div>
          <article id="article">
            <p id="p1">In local-first software, the availability of another computer should never prevent you from working.</p>
            <p id="p2">You own your data, in perpetuity, on your own drive with fast local copies.</p>
            <p id="p3">Collaboration happens peer-to-peer with conflict-free replicated data types.</p>
          </article>
        </body>
      </html>
    `;
    await loadArticle(browser, modifiedHtml);
    marks = await getRenderedMarks(browser);
    is(
      marks.length,
      3,
      "Three highlights re-anchor after DOM shift; the fourth whose text was removed drops silently"
    );
    Assert.deepEqual(
      marks.map(m => m.text),
      [
        "availability of another computer",
        "You own your data",
        "peer-to-peer",
      ],
      "Surviving passages re-anchored accurately by quote + prefix/suffix context"
    );
  });
});

add_task(async function test_page_note_and_revisit_cue_and_screenshots() {
  await WhimsyAnnotations.resetForTests();
  const btn = document.getElementById("whimsy-annotations-button");

  await BrowserTestUtils.withNewTab(TEST_URL, async browser => {
    await loadArticle(browser);
    ok(btn.hidden, "Icon starts hidden on clean page");

    // Set the page note (one editable note per page)
    await WhimsyAnnotations.setPageNote(
      TEST_URL,
      "Read sections 2 and 3 before Friday's architecture review.",
      {
        win: window,
        browser,
        title: "Local-first software — Ink & Switch",
      }
    );
    ok(!btn.hidden, "Icon appears when a page note is saved even before any highlights");

    // Add a highlight with a note for rich popover & panel state
    await selectInElement(browser, "#p1", "availability of another computer");
    const hl = await WhimsyAnnotations.highlightSelection(window, {
      color: "yellow",
      note: "Core thesis of the essay.",
      showToast: false,
    });
    ok(hl, "Created highlight on #p1");

    // Screenshot 1: Highlight popover open over the passage
    const popover = await WhimsyAnnotations.openHighlightPopover(window, {
      browser,
      highlightId: hl.id,
    });
    await BrowserTestUtils.waitForPopupEvent(popover, "shown");
    await whimsyBothSchemes("w24-annotations-popover", async () => {
      is(popover.state, "open", "Highlight popover is open for the screenshot");
      return whimsyStandInPopups();
    });
    const popHidden = BrowserTestUtils.waitForPopupEvent(popover, "hidden");
    WhimsySurface.close(popover);
    await popHidden;

    // Open the address-bar revisit panel and edit the page note
    const panel = await WhimsyAnnotations.openPagePanel(window, btn);
    await BrowserTestUtils.waitForPopupEvent(panel, "shown");
    const pageNoteInput = panel.querySelector(".whimsy-annotations-page-note");
    ok(pageNoteInput, "Page panel has the editable page note textarea");
    is(
      pageNoteInput.value,
      "Read sections 2 and 3 before Friday's architecture review.",
      "Page note loaded into the panel"
    );

    // Screenshot 2: Address-bar page panel showing the note and highlights list
    await whimsyBothSchemes("w24-annotations-page-panel", async () => {
      is(panel.state, "open", "Page panel is open for the screenshot");
      return whimsyStandInPopups();
    });

    pageNoteInput.value = "Updated page note: share with the sync team.";
    pageNoteInput.dispatchEvent(new Event("input", { bubbles: true }));

    const doneBtn = panel.querySelector(".whimsy-annotations-done");
    const panelHidden = BrowserTestUtils.waitForPopupEvent(panel, "hidden");
    doneBtn.click();
    await panelHidden;

    // Reload and verify the updated page note and highlight come back
    await loadArticle(browser);
    is(
      WhimsyAnnotations.getPageNote(TEST_URL),
      "Updated page note: share with the sync team.",
      "Updated page note persisted and came back on reload"
    );
    await gWhimsyNotesStore.ensureLoaded();
    const syncedNote = gWhimsyNotesStore
      .list()
      .find(n => n.pageAttached && WhimsyAnnotations.normalizeURL(n.url) === WhimsyAnnotations.normalizeURL(TEST_URL));
    ok(syncedNote, "Page note is synced into gWhimsyNotesStore as one page-attached note");
    is(syncedNote.text, "Updated page note: share with the sync team.", "Synced note text matches");
  });
});

add_task(async function test_fire_clears_when_ticked_keeps_when_unticked() {
  await BrowserTestUtils.withNewTab(TEST_URL, async browser => {
    await loadArticle(browser);
    ok(
      WhimsyAnnotations.getHighlights(TEST_URL).length > 0 &&
        Boolean(WhimsyAnnotations.getPageNote(TEST_URL)),
      "Annotations and page note exist before Fire"
    );

    // 1. Fire with "notes" unticked keeps highlights and page note
    await WhimsyFireButton.burn(window, {
      range: "all",
      allSpaces: true,
      spaceIds: null,
      items: {
        tabs: false,
        history: false,
        cookies: false,
        cache: false,
        form: false,
        closed: false,
        notes: false,
        downloads: false,
        aiChats: false,
        agentActivity: false,
        index: false,
        memory: false,
        routineResults: false,
      },
    });
    ok(
      WhimsyAnnotations.getHighlights(TEST_URL).length > 0,
      "Fire with Notes and highlights unticked keeps highlights"
    );
    is(
      WhimsyAnnotations.getPageNote(TEST_URL),
      "Updated page note: share with the sync team.",
      "Fire with Notes and highlights unticked keeps page note"
    );

    // 2. Fire with "notes" ticked clears highlights and page note
    await WhimsyFireButton.burn(window, {
      range: "all",
      allSpaces: true,
      spaceIds: null,
      items: {
        tabs: false,
        history: false,
        cookies: false,
        cache: false,
        form: false,
        closed: false,
        notes: true,
        downloads: false,
        aiChats: false,
        agentActivity: false,
        index: false,
        memory: false,
        routineResults: false,
      },
    });
    is(
      WhimsyAnnotations.getHighlights(TEST_URL).length,
      0,
      "Fire with Notes and highlights ticked clears highlights"
    );
    is(
      WhimsyAnnotations.getPageNote(TEST_URL),
      "",
      "Fire with Notes and highlights ticked clears page note"
    );
    const btn = document.getElementById("whimsy-annotations-button");
    ok(btn.hidden, "Address-bar icon hides once Fire clears the page's annotations");
  });
});

add_task(async function test_private_window_stores_nothing() {
  await WhimsyAnnotations.resetForTests();
  const privWin = await BrowserTestUtils.openNewBrowserWindow({ private: true });
  try {
    WhimsyAnnotations.initWindow(privWin);
    const tab = await BrowserTestUtils.openNewForegroundTab(
      privWin.gBrowser,
      TEST_URL
    );
    const browser = tab.linkedBrowser;
    await loadArticle(browser);

    await selectInElement(browser, "#p1", "availability of another computer");
    const hl = await WhimsyAnnotations.highlightSelection(privWin, {
      color: "yellow",
      showToast: false,
    });
    is(hl, null, "highlightSelection refuses to store in a private window");

    await WhimsyAnnotations.setPageNote(TEST_URL, "Secret private note", {
      win: privWin,
      browser,
    });
    is(
      WhimsyAnnotations.getHighlights(TEST_URL).length,
      0,
      "Nothing stored in highlights for private window"
    );
    is(
      WhimsyAnnotations.getPageNote(TEST_URL),
      "",
      "Nothing stored in page note for private window"
    );

    const privBtn = privWin.document.getElementById("whimsy-annotations-button");
    ok(!privBtn || privBtn.hidden, "Address-bar annotations icon stays hidden in private window");
  } finally {
    await BrowserTestUtils.closeWindow(privWin);
  }
});
