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

async function openPagePanelAndWait(anchor) {
  const panel = await WhimsyAnnotations.openPagePanel(window, anchor);
  if (panel.state !== "open") {
    await BrowserTestUtils.waitForPopupEvent(panel, "shown");
  }
  return panel;
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
    // W25 designfix: the cue is the approved pill, a page-action sibling
    // with the highlighter icon file, shown while the state is true (not
    // only on hover), and clicking it opens the page's note in Notes.
    const cueIcon = btn.querySelector(".urlbar-icon");
    ok(cueIcon && getComputedStyle(cueIcon).listStyleImage.includes("icons/highlighter.svg"), "The cue draws the highlighter icon file");
    ok(!btn.querySelector("svg"), "No inline SVG");
    is(getComputedStyle(btn).visibility, "visible", "The cue shows without hovering the toolbar");
    is(getComputedStyle(btn).opacity, "1", "...at full opacity");
    is(btn.querySelector(".whimsy-annotations-button-count").value, "1", "The pill shows the count");
    const { WhimsyNotes } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyNotesSection.sys.mjs");
    const realOpen = WhimsyNotes.openInLibrary;
    let openedNote;
    WhimsyNotes.openInLibrary = (w, noteId) => {
      openedNote = { w, noteId };
      return true;
    };
    try {
      EventUtils.synthesizeMouseAtCenter(btn, {});
      await TestUtils.waitForCondition(() => openedNote, "Clicking the cue opens Notes");
      is(openedNote.noteId, WhimsyAnnotations.getPageRecord(TEST_URL)?.noteId, "...at this page's note");
    } finally {
      WhimsyNotes.openInLibrary = realOpen;
    }

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
    const record = WhimsyAnnotations.getPageRecord(TEST_URL);
    const pageNotes = (await gWhimsyNotesStore.list(record.profileKey)).filter(
      n => n.pageAttached && WhimsyAnnotations.normalizeURL(n.url) === WhimsyAnnotations.normalizeURL(TEST_URL)
    );
    is(pageNotes.length, 1, "Editing the page note updates one attached note without duplicates");
    const syncedNote = pageNotes[0];
    ok(syncedNote, "Page note is synced into gWhimsyNotesStore as one page-attached note");
    is(syncedNote.id, record.noteId, "The annotation record links to the attached note");
    is(syncedNote.text, "Updated page note: share with the sync team.", "Synced note text matches");

    await gWhimsyNotesStore.update(syncedNote.id, { text: "Edited in the Notes library." });
    await loadArticle(browser);
    is(WhimsyAnnotations.getPageNote(TEST_URL), "Edited in the Notes library.", "Revisiting reads changes from the async Notes store");

    await WhimsyAnnotations.setPageNote(TEST_URL, "", { win: window, browser });
    ok(!(await gWhimsyNotesStore.list(record.profileKey)).some(n => n.id === syncedNote.id), "Clearing a page note removes its Notes entry");
    await WhimsyAnnotations.setPageNote(TEST_URL, "Updated page note: share with the sync team.", { win: window, browser });
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
    ok(!(await gWhimsyNotesStore.list()).some(
      n => n.pageAttached && WhimsyAnnotations.normalizeURL(n.url) === WhimsyAnnotations.normalizeURL(TEST_URL)
    ), "Fire also removes the page-attached Notes entry");
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

    // W29 pen: private window has no Draw on Page menu item and stores no drawings
    await selectInElement(browser, "#p1", "availability of another computer");
    const privMenu = privWin.document.getElementById("contentAreaContextMenu");
    const privShown = BrowserTestUtils.waitForPopupEvent(privMenu, "shown");
    await BrowserTestUtils.synthesizeMouseAtCenter(
      "#p1",
      { type: "contextmenu", button: 2 },
      browser
    );
    await privShown;
    const privDrawItem = privWin.document.getElementById("context-whimsy-draw");
    ok(!privDrawItem || privDrawItem.hidden, "Draw on Page is hidden in a private window");
    const privHidden = BrowserTestUtils.waitForPopupEvent(privMenu, "hidden");
    privMenu.hidePopup();
    await privHidden;

    const penBar = await WhimsyAnnotations.startPen(privWin);
    is(penBar, null, "startPen refuses to start in a private window");
    const savedStroke = await WhimsyAnnotations.addDrawingStroke(
      TEST_URL,
      {
        id: "priv-stroke",
        color: "blue",
        width: "thin",
        layoutWidth: 800,
        points: [[10, 10], [40, 40]],
      },
      { win: privWin, browser }
    );
    is(savedStroke, null, "addDrawingStroke refuses to store in a private window");
    is(WhimsyAnnotations.getDrawings(TEST_URL).length, 0, "No drawings stored from private window");
  } finally {
    await BrowserTestUtils.closeWindow(privWin);
  }
});

function parseRgbColor(cssColor) {
  const m = String(cssColor || "").match(
    /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)/
  );
  if (!m) {
    return null;
  }
  return {
    r: Number(m[1]),
    g: Number(m[2]),
    b: Number(m[3]),
    a: m[4] === undefined ? 1 : Number(m[4]),
  };
}

function relativeLuminance({ r, g, b }) {
  const chan = v => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b);
}

function contrastRatio(fg, bg) {
  const l1 = relativeLuminance(fg);
  const l2 = relativeLuminance(bg);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

add_task(async function test_pen_context_menu_and_verb() {
  await WhimsyAnnotations.resetForTests();

  await BrowserTestUtils.withNewTab(TEST_URL, async browser => {
    await loadArticle(browser);

    // 1. Context menu item placement & visibility alongside Add Note
    await selectInElement(browser, "#p1", "availability of another computer");
    let menu = await openContextMenuOn(browser, "#p1");
    const addNoteItem = document.getElementById("context-whimsy-add-note");
    const drawItem = document.getElementById("context-whimsy-draw");
    ok(drawItem, "Draw on Page menuitem exists");
    is(
      drawItem.previousElementSibling,
      addNoteItem,
      "Draw on Page sits directly below Add Note"
    );
    ok(!addNoteItem.hidden && !drawItem.hidden, "Both Add Note and Draw on Page show on an annotatable page");
    await closeContextMenu(menu);

    // Hidden on editable fields where Add Note is hidden
    await SpecialPowers.spawn(browser, [], () => {
      content.getSelection().removeAllRanges();
    });
    menu = await openContextMenuOn(browser, "#editor");
    ok(addNoteItem.hidden, "Add Note is hidden on an editable field");
    ok(drawItem.hidden, "Draw on Page is hidden on an editable field where Add Note is hidden");
    await closeContextMenu(menu);

    // Hidden when feature pref is disabled
    await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.annotations", false]] });
    await selectInElement(browser, "#p1", "availability of another computer");
    menu = await openContextMenuOn(browser, "#p1");
    ok(addNoteItem.hidden && drawItem.hidden, "Both Add Note and Draw on Page hide when annotations feature is off");
    await closeContextMenu(menu);
    await SpecialPowers.popPrefEnv();

    // 2. ⌘K verb "Draw on This Page" registered in WhimsyVerbs
    const drawVerb = WhimsyVerbs.registered.find(v => v.id === "draw");
    ok(drawVerb, "Verb 'draw' (Draw on This Page) is registered");
    is(drawVerb.l10nId, "whimsy-verb-draw", "Verb uses whimsy-verb-draw");
    ok(drawVerb.when(window), "Verb is available on an annotatable page");

    const ran = await WhimsyVerbs.runVerb(window, "draw");
    ok(ran, "WhimsyVerbs.runVerb('draw') starts the pen");
    ok(WhimsyAnnotations.isPenActive(window), "Pen is active after running verb");
    const bar = document.getElementById("whimsy-annotations-pen-bar");
    ok(bar && !bar.hidden, "Floating pen bar is visible");

    await WhimsyAnnotations.stopPen(window, { immediate: true });
    ok(!WhimsyAnnotations.isPenActive(window), "Pen stopped");
  });

  // Hidden on about:blank
  await BrowserTestUtils.withNewTab("about:blank", async browser => {
    // about:blank's body has no height: a click at its centre lands on the
    // document itself, which the context menu never opens for.
    await SpecialPowers.spawn(browser, [], () => {
      content.document.body.style.minHeight = "100vh";
    });
    const menu = document.getElementById("contentAreaContextMenu");
    const shown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
    await BrowserTestUtils.synthesizeMouseAtCenter(
      "body",
      { type: "contextmenu", button: 2 },
      browser
    );
    await shown;
    const addNoteItem = document.getElementById("context-whimsy-add-note");
    const drawItem = document.getElementById("context-whimsy-draw");
    ok(addNoteItem.hidden && drawItem.hidden, "Draw on Page and Add Note are both hidden on about:blank");
    await closeContextMenu(menu);
  });
});

add_task(async function test_pen_drawing_coordinates_reload_and_width_rule() {
  await WhimsyAnnotations.resetForTests();

  await BrowserTestUtils.withNewTab(TEST_URL, async browser => {
    // Load a tall page with a link so we can scroll and test link clicks under strokes
    // document.write is refused from the test sandbox (SecurityError):
    // load the fixture the way loadArticle does, then add the tall part.
    await loadArticle(browser);
    await SpecialPowers.spawn(browser, [], () => {
      const tall = content.document.createElement("div");
      tall.style.cssText = "height: 1600px; padding-top: 40px;";
      tall.innerHTML = `<a id="under-link" href="#clicked-link" style="display: inline-block; padding: 20px; background: #eee;">Target Link</a>`;
      content.document.body.append(tall);
    });
    await WhimsyAnnotations.restoreForBrowser(browser);

    // Hint shows only the first two times ever
    is(Services.prefs.getIntPref("whimsy.annotations.pen-hint-shown", 0), 0, "Hint count starts at 0");
    await WhimsyAnnotations.startPen(window);
    const hint = document.getElementById("whimsy-annotations-pen-hint");
    ok(hint && !hint.hidden, "First-use hint is visible on 1st pen open");
    is(Services.prefs.getIntPref("whimsy.annotations.pen-hint-shown", 0), 1, "Hint count incremented to 1");
    await WhimsyAnnotations.stopPen(window, { immediate: true });

    await WhimsyAnnotations.startPen(window);
    ok(!hint.hidden, "First-use hint is visible on 2nd pen open");
    is(Services.prefs.getIntPref("whimsy.annotations.pen-hint-shown", 0), 2, "Hint count incremented to 2");
    await WhimsyAnnotations.stopPen(window, { immediate: true });

    await WhimsyAnnotations.startPen(window);
    ok(hint.hidden, "First-use hint does not show on 3rd pen open");

    // Check pen bar tooltips and controls
    const bar = document.getElementById("whimsy-annotations-pen-bar");
    for (const [sel, expectedTitle] of [
      ['.whimsy-pen-swatch[data-color="yellow"]', "Yellow"],
      ['.whimsy-pen-swatch[data-color="green"]', "Green"],
      ['.whimsy-pen-swatch[data-color="blue"]', "Blue"],
      ['.whimsy-pen-swatch[data-color="pink"]', "Pink"],
      ['.whimsy-pen-width-btn[data-width="thin"]', "Thin Line"],
      ['.whimsy-pen-width-btn[data-width="thick"]', "Thick Line"],
      [".whimsy-pen-eraser-btn", "Eraser"],
      [".whimsy-pen-undo-btn", "Undo (⌘Z)"],
      [".whimsy-pen-done", "Done (Esc)"],
    ]) {
      const el = bar.querySelector(sel);
      ok(el, `Control ${sel} exists in pen bar`);
      is(el.getAttribute("title"), expectedTitle, `${sel} has tooltip "${expectedTitle}"`);
    }

    // Choose Blue + Thick Line
    bar.querySelector('.whimsy-pen-swatch[data-color="blue"]').click();
    bar.querySelector('.whimsy-pen-width-btn[data-width="thick"]').click();
    await TestUtils.waitForCondition(
      () => WhimsyAnnotations.getPenSession(window)?.color === "blue" &&
            WhimsyAnnotations.getPenSession(window)?.width === "thick",
      "Pen state updated to blue + thick"
    );

    // Scroll the page first so document coords != viewport coords
    const scrollInfo = await SpecialPowers.spawn(browser, [], () => {
      content.scrollTo(0, 150);
      const linkRect = content.document.getElementById("under-link").getBoundingClientRect();
      return {
        scrollY: content.scrollY,
        layoutWidth: Math.round(content.document.documentElement.clientWidth),
        linkX: Math.round(linkRect.left + 15),
        linkY: Math.round(linkRect.top + 15),
      };
    });
    Assert.greater(scrollInfo.scrollY, 100, "Page is scrolled before drawing");

    // Synthesize a mouse drag across the link in content
    await SpecialPowers.spawn(
      browser,
      [{ x: scrollInfo.linkX, y: scrollInfo.linkY }],
      ({ x, y }) => {
        const cap =
          content.document.getElementById("whimsy-annotations-pen-capture") ||
          content.document.documentElement;
        const fire = (type, cx, cy) => {
          cap.dispatchEvent(
            new content.PointerEvent(type, {
              bubbles: true,
              cancelable: true,
              clientX: cx,
              clientY: cy,
              button: 0,
              buttons: type === "pointerup" ? 0 : 1,
            })
          );
        };
        fire("pointerdown", x, y);
        // Point < 1px away should be dropped by simplification
        fire("pointermove", x + 0.3, y + 0.2);
        fire("pointermove", x + 25.4, y + 10.6);
        fire("pointermove", x + 55.1, y + 20.2);
        fire("pointerup", x + 55.1, y + 20.2);
      }
    );

    await TestUtils.waitForCondition(
      () => WhimsyAnnotations.getDrawings(TEST_URL).length === 1,
      "Stroke saved to page record"
    );

    const [stroke] = WhimsyAnnotations.getDrawings(TEST_URL);
    is(stroke.color, "blue", "Saved stroke color is blue");
    is(stroke.width, "thick", "Saved stroke width is thick");
    is(stroke.layoutWidth, scrollInfo.layoutWidth, "Saved stroke records page layoutWidth");
    is(stroke.points.length, 3, "Sub-1px point was dropped by simplification");
    for (const [px, py] of stroke.points) {
      is(px * 2, Math.round(px * 2), `Point x (${px}) is rounded to 0.5px`);
      is(py * 2, Math.round(py * 2), `Point y (${py}) is rounded to 0.5px`);
    }
    Assert.greater(
      stroke.points[0][1],
      scrollInfo.scrollY,
      "Points are stored in document coordinates (clientY + scrollY)"
    );

    // While pen is active, clicking the link does NOT navigate
    await SpecialPowers.spawn(browser, [{ x: scrollInfo.linkX, y: scrollInfo.linkY }], ({ x, y }) => {
      const link = content.document.getElementById("under-link");
      link.dispatchEvent(
        new content.MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          clientX: x,
          clientY: y,
          button: 0,
        })
      );
    });
    const hashWhilePenOn = await SpecialPowers.spawn(browser, [], () => content.location.hash);
    is(hashWhilePenOn, "", "Link click did not fire while pen is active");

    // End pen via Esc
    EventUtils.synthesizeKey("KEY_Escape", {}, window);
    await TestUtils.waitForCondition(
      () => !WhimsyAnnotations.isPenActive(window) && bar.hidden,
      "Esc ends the pen and hides the floating bar"
    );

    // After Done/Esc, overlay has pointer-events: none and link under stroke is clickable
    const overlayCheck = await SpecialPowers.spawn(browser, [], () => {
      const svg = content.document.getElementById("whimsy-annotations-ink-overlay");
      const path = svg?.querySelector("path.whimsy-annotation-stroke");
      const cap = content.document.getElementById("whimsy-annotations-pen-capture");
      const cs = svg ? content.getComputedStyle(svg) : null;
      return {
        hasSvg: Boolean(svg),
        hasPath: Boolean(path),
        hasCap: Boolean(cap),
        pointerEvents: cs?.pointerEvents || "",
        position: cs?.position || "",
      };
    });
    ok(overlayCheck.hasSvg && overlayCheck.hasPath, "Stroke stays rendered in SVG overlay after Done");
    ok(!overlayCheck.hasCap, "Capture layer is removed after Done");
    is(overlayCheck.pointerEvents, "none", "SVG overlay has pointer-events: none");
    is(overlayCheck.position, "absolute", "SVG overlay is absolutely positioned at document origin");

    // Clicking the link under the stroke now navigates
    await BrowserTestUtils.synthesizeMouseAtCenter("#under-link", {}, browser);
    await TestUtils.waitForCondition(
      async () =>
        (await SpecialPowers.spawn(browser, [], () => content.location.hash)) ===
        "#clicked-link",
      "Link under stroke navigates normally after Done"
    );

    // Layout width rule: changing page layout width hides the stroke; restoring shows it again.
    // documentElement.clientWidth is the viewport, so narrow the browser itself.
    const strokeHidden = () =>
      SpecialPowers.spawn(browser, [], () => {
        const path = content.document.querySelector("path.whimsy-annotation-stroke");
        return Boolean(path?.hasAttribute("hidden") && content.getComputedStyle(path).display === "none");
      });
    browser.style.maxWidth = "420px";
    let hiddenAtDiffWidth = false;
    await TestUtils.waitForCondition(async () => (hiddenAtDiffWidth = await strokeHidden()), "Stroke hides at a narrower layout").catch(() => {});
    ok(hiddenAtDiffWidth, "Stroke is hidden when page layout width differs from when it was drawn");

    browser.style.maxWidth = "";
    let shownAtOrigWidth = false;
    await TestUtils.waitForCondition(async () => (shownAtOrigWidth = !(await strokeHidden())), "Stroke returns at the original layout").catch(() => {});
    ok(shownAtOrigWidth, "Stroke is shown again when page returns to its original layout width");

    // Reload persistence
    await BrowserTestUtils.reloadTab(gBrowser.selectedTab);
    await loadArticle(browser);
    const afterReloadCount = await SpecialPowers.spawn(browser, [], () => {
      return content.document.querySelectorAll("path.whimsy-annotation-stroke").length;
    });
    is(afterReloadCount, 1, "Stroke re-renders after reload");
  });
});

add_task(async function test_pen_eraser_undo_panel_and_reduced_motion() {
  await WhimsyAnnotations.resetForTests();

  await BrowserTestUtils.withNewTab(TEST_URL, async browser => {
    await loadArticle(browser);

    // Reduced motion: bar appears without animation
    await SpecialPowers.pushPrefEnv({ set: [["ui.prefersReducedMotion", 1]] });
    const bar = await WhimsyAnnotations.startPen(window);
    ok(bar && !bar.hidden, "Pen bar opens under reduced motion");
    is(bar.getAnimations().length, 0, "No entry animation under prefers-reduced-motion");

    // Draw stroke 1
    await SpecialPowers.spawn(browser, [], () => {
      const cap = content.document.getElementById("whimsy-annotations-pen-capture");
      const fire = (type, cx, cy) => {
        cap.dispatchEvent(
          new content.PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            clientX: cx,
            clientY: cy,
            button: 0,
            buttons: type === "pointerup" ? 0 : 1,
          })
        );
      };
      fire("pointerdown", 80, 100);
      fire("pointermove", 140, 100);
      fire("pointerup", 180, 100);
    });
    await TestUtils.waitForCondition(
      () => WhimsyAnnotations.getDrawings(TEST_URL).length === 1,
      "Stroke 1 drawn"
    );

    // Switch to Eraser and touch the stroke to erase it
    bar.querySelector(".whimsy-pen-eraser-btn").click();
    await TestUtils.waitForCondition(
      () => WhimsyAnnotations.getPenSession(window)?.tool === "eraser",
      "Eraser tool active"
    );
    await SpecialPowers.spawn(browser, [], () => {
      const cap = content.document.getElementById("whimsy-annotations-pen-capture");
      cap.dispatchEvent(
        new content.PointerEvent("pointerdown", {
          bubbles: true,
          cancelable: true,
          clientX: 120,
          clientY: 100,
          button: 0,
          buttons: 1,
        })
      );
      cap.dispatchEvent(
        new content.PointerEvent("pointerup", {
          bubbles: true,
          cancelable: true,
          clientX: 120,
          clientY: 100,
          button: 0,
          buttons: 0,
        })
      );
    });
    await TestUtils.waitForCondition(
      () => WhimsyAnnotations.getDrawings(TEST_URL).length === 0,
      "Eraser removes the whole stroke on touch"
    );

    // ⌘Z undoes the erase (restoring stroke 1)
    EventUtils.synthesizeKey("z", { accelKey: true }, window);
    await TestUtils.waitForCondition(
      () => WhimsyAnnotations.getDrawings(TEST_URL).length === 1,
      "⌘Z undoes the erase and restores the stroke"
    );

    // Another ⌘Z undoes drawing stroke 1
    EventUtils.synthesizeKey("z", { accelKey: true }, window);
    await TestUtils.waitForCondition(
      () => WhimsyAnnotations.getDrawings(TEST_URL).length === 0,
      "Second ⌘Z undoes the drawn stroke"
    );

    // Draw stroke again and finish with Done
    bar.querySelector('.whimsy-pen-swatch[data-color="pink"]').click();
    await TestUtils.waitForCondition(
      () => WhimsyAnnotations.getPenSession(window)?.tool === "pen",
      "Clicking swatch returns to pen tool"
    );
    await SpecialPowers.spawn(browser, [], () => {
      const cap = content.document.getElementById("whimsy-annotations-pen-capture");
      for (const [type, cx, cy] of [
        ["pointerdown", 90, 120],
        ["pointermove", 150, 140],
        ["pointerup", 200, 150],
      ]) {
        cap.dispatchEvent(
          new content.PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            clientX: cx,
            clientY: cy,
            button: 0,
            buttons: type === "pointerup" ? 0 : 1,
          })
        );
      }
    });
    await TestUtils.waitForCondition(
      () => WhimsyAnnotations.getDrawings(TEST_URL).length === 1,
      "Pink stroke saved"
    );

    // Contrast assertion & light/dark screenshots of P.2 (pen bar)
    await whimsyBothSchemes("w29-pen-p2-bar", async scheme => {
      const doneBtn = bar.querySelector(".whimsy-pen-done");
      const cs = window.getComputedStyle(doneBtn);
      const fg = parseRgbColor(cs.color);
      const bg = parseRgbColor(cs.backgroundColor);
      ok(fg && bg, `Parsed Done button colors in ${scheme} scheme`);
      const ratio = contrastRatio(fg, bg);
      Assert.greaterOrEqual(
        ratio,
        4.5,
        `Done button text on filled primary surface meets WCAG AA (4.5:1) in ${scheme}: ${ratio.toFixed(2)}`
      );
    });

    bar.querySelector(".whimsy-pen-done").click();
    await TestUtils.waitForCondition(
      () => !WhimsyAnnotations.isPenActive(window) && bar.hidden,
      "Done button ends the pen under reduced motion"
    );
    is(bar.getAnimations().length, 0, "No exit animation under prefers-reduced-motion");
    await SpecialPowers.popPrefEnv();

    // URL-bar badge count includes drawings
    const urlbarBtn = document.getElementById("whimsy-annotations-button");
    ok(urlbarBtn && !urlbarBtn.hidden, "URL-bar badge is visible when page has drawings");
    const countLabel = urlbarBtn.querySelector(".whimsy-annotations-button-count");
    is(countLabel.getAttribute("value"), "1", "URL-bar badge count includes the drawing");

    // Open page panel (P.3): check Drawings · 1 row, preview SVG, Edit, Remove + Undo
    const panel = await openPagePanelAndWait(urlbarBtn);
    const drwSection = panel.querySelector(".whimsy-annotations-drawings-section");
    ok(drwSection, "Drawings section is rendered in the page panel");
    const drwLabel = drwSection.querySelector(".whimsy-annotations-drawings-label");
    ok(
      drwLabel.textContent.includes("1"),
      `Drawings label shows the count ("${drwLabel.textContent}")`
    );
    const thumb = drwSection.querySelector(".whimsy-annotations-drawing-thumb");
    ok(thumb && thumb.querySelector("svg path"), "Drawing preview renders a scaled SVG path");

    // Light and dark screenshots of P.3 (panel row)
    await whimsyBothSchemes("w29-pen-p3-panel", async () => {});

    // Clicking Edit reopens the pen
    const editBtn = drwSection.querySelector(".whimsy-annotations-drawings-edit");
    editBtn.click();
    await TestUtils.waitForCondition(
      () => WhimsyAnnotations.isPenActive(window),
      "Clicking Edit in the panel reopens the pen"
    );
    await WhimsyAnnotations.stopPen(window, { immediate: true });

    // Reopen panel and click Remove -> deletes all drawings with Undo toast
    const panel2 = await openPagePanelAndWait(urlbarBtn);
    const removeBtn = panel2.querySelector(".whimsy-annotations-drawings-remove");
    ok(removeBtn, "Remove button exists on Drawings row");
    removeBtn.click();
    await TestUtils.waitForCondition(
      () => WhimsyAnnotations.getDrawings(TEST_URL).length === 0,
      "Clicking Remove deletes all drawings on the page"
    );
    ok(urlbarBtn.hidden, "Badge hides when drawings are removed and page has no other annotations");

    // Undo restores the removed drawings
    const { WhimsyUndo } = ChromeUtils.importESModule(
      "resource:///modules/whimsy/WhimsyUndo.sys.mjs"
    );
    await WhimsyUndo.undo(window);
    await TestUtils.waitForCondition(
      () => WhimsyAnnotations.getDrawings(TEST_URL).length === 1,
      "Undo restores the removed drawings"
    );
    is(countLabel.getAttribute("value"), "1", "Badge count returns to 1 after Undo");

    // Clear Page clears drawings
    await WhimsyAnnotations.clearPage(TEST_URL, { win: window, browser });
    is(WhimsyAnnotations.getDrawings(TEST_URL).length, 0, "clearPage clears all drawings");
    ok(urlbarBtn.hidden, "Badge hides after clearPage");
  });
});

