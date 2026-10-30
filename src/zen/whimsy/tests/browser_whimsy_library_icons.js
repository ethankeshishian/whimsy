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
      library.zenLibrarySections["whimsy-finder-folders"],
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
    ok((await response.text()).includes("<svg"), `${id}'s icon is SVG`);

    if (!id.startsWith("whimsy-")) {
      continue;
    }
    const wasActive = tab.hasAttribute("active");
    const animationValue = tab.getAttribute("animate");
    try {
      for (const active of [false, true]) {
        tab.toggleAttribute("active", active);
        tab.setAttribute("animate", "true");
        const style = getComputedStyle(icon);
        is(style.width, getComputedStyle(icon.parentElement).width,
          `${id} occupies one frame (active=${active})`);
        is(style.animationName, "none", `${id} never plays a sprite animation`);
        is(style.transform, "none", `${id} stays inside its clipped frame`);
        ok(!["transparent", "rgba(0, 0, 0, 0)"].includes(style.fill),
          `${id} stays visible when active=${active}`);
      }
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
