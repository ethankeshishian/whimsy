/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Edit Text on Page: transactional edits and one tab-owned floating bar.

const PAGE = "https://example.com/document-builder.sjs?html=" + encodeURIComponent("<p id=p>Hello</p>");
const { WhimsyPage } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPage.sys.mjs");

const designMode = browser => SpecialPowers.spawn(browser, [], () => content.document.designMode);
const bar = () => document.getElementById("whimsy-edit-page-bar");
const readyBar = async () => {
  await TestUtils.waitForCondition(
    () => bar() && !bar().hidden && !bar().hasAttribute("entering") && !bar().hasAttribute("exiting"),
    "The bar has finished entering before interacting"
  );
  await document.l10n.translateFragment(bar());
  return bar();
};
const ended = async browser => {
  await TestUtils.waitForCondition(async () => (await designMode(browser)) == "off", "Editing ended");
  await TestUtils.waitForCondition(() => !browser.whimsyEditing && (!bar() || bar().hidden), "The bar is hidden");
};

add_task(async function test_menu_type_escape() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  const browser = tab.linkedBrowser;
  const menu = document.getElementById("contentAreaContextMenu");
  const shown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
  await BrowserTestUtils.synthesizeMouseAtCenter("#p", { type: "contextmenu", button: 2 }, browser);
  await shown;
  const item = document.getElementById("context-whimsy-edit-page");
  ok(item && !item.hidden, "The page menu offers Edit Text on Page");
  const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  menu.activateItem(item);
  await hidden;
  await TestUtils.waitForCondition(async () => (await designMode(browser)) == "on", "The page is editable");
  await readyBar();
  ok(!document.getElementById("whimsy-editing-pill"), "No address bar pill");
  ok(!document.getElementById("zen-toast-container")?.textContent.includes("Click any text to edit it"), "No editing toast");

  // Type into the paragraph.
  await SpecialPowers.spawn(browser, [], () => {
    const p = content.document.getElementById("p");
    const range = content.document.createRange();
    range.selectNodeContents(p);
    range.collapse(false);
    content.getSelection().removeAllRanges();
    content.getSelection().addRange(range);
  });
  browser.focus();
  EventUtils.sendString(" world");
  await TestUtils.waitForCondition(
    () => SpecialPowers.spawn(browser, [], () => content.document.getElementById("p").textContent == "Hello world"),
    "Typing edits the text"
  );

  EventUtils.synthesizeKey("KEY_Escape");
  await TestUtils.waitForCondition(async () => (await designMode(browser)) == "off", "Esc finishes editing");
  await ended(browser);
  is(await SpecialPowers.spawn(browser, [], () => content.document.getElementById("p").textContent), "Hello", "Esc restores typed text");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_bar_navigation_and_switch() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  const browser = tab.linkedBrowser;
  ok(await WhimsyPage.toggleEditing(window), "The command turns editing on");
  await readyBar();
  EventUtils.synthesizeMouseAtCenter(bar().querySelector(".whimsy-edit-page-save"), {});
  await TestUtils.waitForCondition(async () => (await designMode(browser)) == "off", "Clicking Save finishes");

  await ended(browser);
  await WhimsyPage.toggleEditing(window, true);
  await readyBar();
  const other = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/");
  ok(bar().hidden, "Another tab has no edit bar");
  gBrowser.selectedTab = tab;
  await readyBar();
  ok(bar().parentNode == browser.closest(".browserStack"), "The bar belongs to this content stack");
  const navigated = BrowserTestUtils.browserLoaded(browser);
  BrowserTestUtils.startLoadingURIString(browser, "https://example.com/?next");
  await navigated;
  await ended(browser);
  BrowserTestUtils.removeTab(other);

  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.edit-page", false]] });
  ok(!(await WhimsyPage.toggleEditing(window, true)), "The switch turns it off");
  is(await designMode(browser), "off", "page untouched");
  await SpecialPowers.popPrefEnv();
  BrowserTestUtils.removeTab(tab);
});


add_task(async function test_cancel_preserves_nodes_scripts_and_exact_structure() {
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    await SpecialPowers.spawn(browser, [], () => {
      const doc = content.document;
      const state = content.wrappedJSObject;
      state.original = doc.getElementById("p");
      state.text = state.original.firstChild;
      state.original.setAttribute("data-original", "before");
      state.clicks = 0;
      state.original.addEventListener("click", () => state.clicks++);
      state.before = doc.documentElement.outerHTML;
    });
    await WhimsyPage.toggleEditing(window, true);
    await readyBar();
    await SpecialPowers.spawn(browser, [], () => {
      const doc = content.document;
      const p = doc.getElementById("p");
      // Multiple changes to the same text and attributes, replacement,
      // insertion, removal, and moving original nodes must all unwind.
      p.firstChild.data = "first";
      p.firstChild.data = "second";
      p.setAttribute("data-original", "changed");
      p.removeAttribute("data-original");
      p.setAttribute("data-added", "yes");
      const sibling = doc.createElement("div");
      p.after(sibling);
      sibling.append(p.firstChild);
      p.replaceChildren(doc.createTextNode("replacement"));
      p.remove();
      sibling.append(p);
    });
    EventUtils.synthesizeMouseAtCenter(bar().querySelector(".whimsy-edit-page-cancel"), {});
    await ended(browser);
    await SpecialPowers.spawn(browser, [], () => {
      const state = content.wrappedJSObject;
      const doc = content.document;
      is(doc.documentElement.outerHTML, state.before, "Cancel restores the exact DOM");
      ok(doc.getElementById("p") == state.original, "Original element identity survives");
      ok(state.original.firstChild == state.text, "Original text node survives");
      state.original.click();
      is(state.clicks, 1, "The original event listener still works without reload");
    });
  });
});

add_task(async function test_save_shortcut_and_fresh_session() {
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    for (const method of ["button", "content key", "chrome key"]) {
      const viaKey = method != "button";
      await WhimsyPage.toggleEditing(window, true);
      await readyBar();
      await SpecialPowers.spawn(browser, [viaKey], key => {
        content.document.getElementById("p").textContent = key ? "Keyboard saved" : "Button saved";
      });
      if (viaKey) {
        if (method == "chrome key") {
          bar().querySelector("button").focus();
        } else {
          browser.focus();
        }
        EventUtils.synthesizeKey("KEY_Enter", { metaKey: true });
      } else {
        EventUtils.synthesizeMouseAtCenter(bar().querySelector(".whimsy-edit-page-save"), {});
      }
      await ended(browser);
      const saved = viaKey ? "Keyboard saved" : "Button saved";
      is(await SpecialPowers.spawn(browser, [], () => content.document.getElementById("p").textContent), saved, "Save keeps edits");
      await WhimsyPage.toggleEditing(window, true);
      await readyBar();
      await SpecialPowers.spawn(browser, [], () => {
        content.document.getElementById("p").firstChild.data = "Discard this session";
      });
      // Esc also works with keyboard focus in the chrome bar.
      bar().querySelector("button").focus();
      EventUtils.synthesizeKey("KEY_Escape");
      await ended(browser);
      is(await SpecialPowers.spawn(browser, [], () => content.document.getElementById("p").textContent), saved, "Cancel restores the saved session baseline");
    }
    const loaded = BrowserTestUtils.browserLoaded(browser);
    browser.reload();
    await loaded;
    is(await SpecialPowers.spawn(browser, [], () => content.document.getElementById("p").textContent), "Hello", "Saved edits last only until reload");
  });
});

add_task(async function test_motion_layout_and_contrast() {
  await SpecialPowers.pushPrefEnv({ set: [["ui.prefersReducedMotion", 0]] });
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    await TestUtils.waitForCondition(() => !matchMedia("(prefers-reduced-motion: reduce)").matches, "Motion preference applied");
    await WhimsyPage.toggleEditing(window, true);
    ok(bar().hasAttribute("entering"), "Entrance is marked synchronously");
    is(getComputedStyle(bar()).pointerEvents, "none", "Entrance cannot intercept clicks");
    await readyBar();
    is(getComputedStyle(bar()).pointerEvents, "auto", "Settled bar accepts clicks");
    for (const dark of [0, 1]) {
      await SpecialPowers.pushPrefEnv({ set: [["ui.systemUsesDarkTheme", dark]] });
      const panel = bar().getBoundingClientRect();
      const stack = browser.closest(".browserStack").getBoundingClientRect();
      ok(Math.abs((panel.left + panel.right) / 2 - (stack.left + stack.right) / 2) < 2, "Panel is centred in the content area");
      ok(panel.bottom <= stack.bottom && panel.top >= stack.top, "Panel stays inside the content area");
      is(getComputedStyle(bar()).backgroundColor, "rgb(29, 27, 27)", "Zap surface in either theme");
      is(bar().querySelector("span").textContent, "Click any text to edit it", "Exact helper copy");
      is(bar().querySelectorAll("button").length, 2, "Only Cancel and Save");
      is(bar().querySelector("kbd").textContent, "esc", "Cancel key hint");
      is(bar().querySelectorAll("kbd")[1].textContent, "⌘↩", "Save key hint");
      for (const node of bar().querySelectorAll("span, button, kbd")) {
        ok(node.scrollWidth <= node.clientWidth, "Labels and keys are not clipped");
      }
      const luminance = rgb => {
        const channels = rgb.map(v => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
        return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
      };
      const ratio = (a, b) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);
      const rgb = node => getComputedStyle(node).color.match(/\d+/g).slice(0, 3).map(Number);
      ok(ratio(rgb(bar()), [29, 27, 27]) >= 4.5, "Helper meets AA");
      ok(ratio(rgb(bar().querySelector(".whimsy-edit-page-cancel")), [29, 27, 27]) >= 4.5, "Cancel meets AA");
      // The darkest gradient stop, dimmed by the strongest active filter.
      ok(ratio(rgb(bar().querySelector(".whimsy-edit-page-save")), [140, 140, 140]) >= 4.5, "Save meets AA even while active");
      await SpecialPowers.popPrefEnv();
    }
    await WhimsyPage.toggleEditing(window, false);
    await ended(browser);
    await SpecialPowers.pushPrefEnv({ set: [["ui.prefersReducedMotion", 1]] });
    await TestUtils.waitForCondition(() => matchMedia("(prefers-reduced-motion: reduce)").matches, "Reduced motion applied");
    await WhimsyPage.toggleEditing(window, true);
    ok(!bar().hasAttribute("entering") && !bar().getAnimations().length, "Reduced motion skips entrance");
    await WhimsyPage.toggleEditing(window, false);
    ok(bar().hidden && !bar().getAnimations().length, "Reduced motion skips exit");
    await SpecialPowers.popPrefEnv();
  });
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_close_edited_tab() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  const browser = tab.linkedBrowser;
  await WhimsyPage.toggleEditing(window, true);
  await readyBar();
  BrowserTestUtils.removeTab(tab);
  await TestUtils.waitForCondition(() => !browser.whimsyEditing, "Closing clears the session");
  ok(!bar() || bar().hidden, "Closing leaves no visible bar");
});


add_task(async function test_same_turn_cancel_and_history() {
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    await WhimsyPage.toggleEditing(window, true);
    await readyBar();
    await SpecialPowers.spawn(browser, [], () => {
      const p = content.document.getElementById("p");
      p.firstChild.data = "Pending observer delivery";
      // Cancel before MutationObserver's microtask can deliver the record.
      content.windowGlobalChild.getActor("WhimsyPage").setEditable(false);
      is(p.textContent, "Hello", "Cancel drains pending mutation records");
      content.windowGlobalChild.getActor("WhimsyPage").sendAsyncMessage("Whimsy:EditingEnded");
    });
    await ended(browser);
    await WhimsyPage.toggleEditing(window, true);
    await readyBar();
    await SpecialPowers.spawn(browser, [], () => { content.location.hash = "editing"; });
    await TestUtils.waitForCondition(() => browser.currentURI.spec.endsWith("#editing"), "Same-document navigation arrived");
    is(await designMode(browser), "on", "Same-document navigation keeps the session");
    const loaded = BrowserTestUtils.browserLoaded(browser);
    BrowserTestUtils.startLoadingURIString(browser, "https://example.com/?after-edit");
    await loaded;
    await ended(browser);
    const back = BrowserTestUtils.waitForContentEvent(browser, "pageshow");
    browser.goBack();
    await back;
    is(await designMode(browser), "off", "History restoration does not revive editing");
    ok(!browser.whimsyEditing && (!bar() || bar().hidden), "History restoration does not revive the bar");
  });
});
