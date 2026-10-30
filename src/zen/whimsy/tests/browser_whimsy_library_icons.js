/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// batch4: every rail tab needs a packaged icon, including optional sections
// only when registered. In particular, do not depend on Meetings surviving.
add_task(async function test_every_library_tab_has_an_icon() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["whimsy.feature.notes", true],
      ["whimsy.feature.finder-folders", true],
      ["whimsy.feature.screenshot-sidebar", true],
      ["whimsy.feature.archive-view", true],
      ["zen.library.hidden-tabs", ""],
    ],
  });
  const library = document.querySelector("zen-library");
  ok(library, "The Library exists");
  const wasOpen = library.constructor.isLibraryOpen;
  registerCleanupFunction(() => library.constructor.animateProgress(wasOpen ? 1 : 0));
  await TestUtils.waitForCondition(
    () => library.zenLibrarySections["whimsy-notes"] &&
      library.zenLibrarySections["whimsy-files"] &&
      library.zenLibrarySections["whimsy-finder-folders"] &&
      library.zenLibrarySections["whimsy-archive"],
    "Whimsy sections are registered"
  );
  await library.constructor.animateProgress(1);
  await library.updateComplete;
  const tabs = [...library.querySelectorAll(".zen-library-tab")];
  is(tabs.length, Object.keys(library.zenLibrarySections).length,
    "Every registered section has a rail tab");

  for (const tab of tabs) {
    const id = tab.dataset.section;
    const icon = tab.querySelector(".zen-library-tab-icon-image");
    ok(icon, `${id} has an icon element`);
    const image = getComputedStyle(icon).backgroundImage;
    const url = /^url\("(.*)"\)$/.exec(image)?.[1];
    ok(url, `${id} has a non-empty icon background`);
    if (!url) {
      continue;
    }
    const response = await fetch(url);
    ok(response.ok, `${id}'s icon is packaged`);
    const svg = await response.text();
    ok(svg.includes("<svg"), `${id}'s icon is SVG`);

    if (!id.startsWith("whimsy-")) {
      continue;
    }
    // fix7/tabs: Whimsy's icons are 36-frame sprites like Zen's, so they
    // play the same animation when chosen, and fill in only when active.
    ok(svg.includes('x="980"'), `${id} is a 36-frame sprite`);
    const wasActive = tab.hasAttribute("active");
    const animationValue = tab.getAttribute("animate");
    try {
      const frame = parseFloat(getComputedStyle(icon.parentElement).width);
      for (const active of [false, true]) {
        tab.toggleAttribute("active", active);
        tab.setAttribute("animate", "true");
        const style = getComputedStyle(icon);
        is(parseFloat(style.width), 36 * frame, `${id} is a strip of 36 frames (active=${active})`);
        is(style.animationName, "zen-library-sprite-play", `${id} plays Zen's sprite animation when chosen`);
        ok(!["transparent", "rgba(0, 0, 0, 0)"].includes(style.stroke),
          `${id}'s outline stays visible when active=${active}`);
        is(["transparent", "rgba(0, 0, 0, 0)"].includes(style.fill), !active,
          `${id}'s body is painted only when active (active=${active})`);
      }
      await SpecialPowers.pushPrefEnv({ set: [["ui.prefersReducedMotion", 1]] });
      await TestUtils.waitForCondition(() => getComputedStyle(icon).animationName == "none",
        `${id} doesn't play with reduced motion`);
      await SpecialPowers.popPrefEnv();
    } finally {
      tab.toggleAttribute("active", wasActive);
      if (animationValue === null) {
        tab.removeAttribute("animate");
      } else {
        tab.setAttribute("animate", animationValue);
      }
    }
  }
});

add_task(async function test_removed_section_leaves_no_icon_tab() {
  const library = document.querySelector("zen-library");
  await SpecialPowers.pushPrefEnv({
    set: [["whimsy.feature.screenshot-sidebar", false]],
  });
  await TestUtils.waitForCondition(
    () => !("whimsy-files" in library.zenLibrarySections),
    "Disabling Captures removes its section"
  );
  await library.updateComplete;
  ok(!library.querySelector('.zen-library-tab[data-section="whimsy-files"]'),
    "No orphaned tab remains when the section is disabled");
});
